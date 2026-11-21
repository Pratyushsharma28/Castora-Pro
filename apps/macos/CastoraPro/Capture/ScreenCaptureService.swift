import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

/// Probes real macOS VideoToolbox hardware encoder availability without running any fake encoding.
public struct VideoToolboxCapabilityProbe: Sendable {
    public init() {}

    public func inspectHardwareEncoders() -> VideoToolboxEncoderCapability {
        var encoderListRef: CFArray?
        let status = VTCopyVideoEncoderList(nil, &encoderListRef)

        guard status == noErr, let entries = encoderListRef as? [[String: Any]] else {
            return VideoToolboxEncoderCapability(
                h264HardwareSupported: false,
                hevcHardwareSupported: false,
                summary: "Unable to query VideoToolbox encoder list (OSStatus \(status))."
            )
        }

        let codecTypeKey = kVTVideoEncoderList_CodecType as String
        let hwKey = kVTVideoEncoderList_IsHardwareAccelerated as String

        var h264HW = false
        var hevcHW = false

        for entry in entries {
            let codecType = (entry[codecTypeKey] as? NSNumber)?.uint32Value
            let isHardware = (entry[hwKey] as? NSNumber)?.boolValue ?? false
            guard isHardware else { continue }

            if codecType == kCMVideoCodecType_H264 {
                h264HW = true
            } else if codecType == kCMVideoCodecType_HEVC {
                hevcHW = true
            }
        }

        var parts: [String] = []
        parts.append(h264HW ? "H.264 Hardware Ready" : "H.264 Software Only")
        parts.append(hevcHW ? "HEVC Hardware Ready" : "HEVC Unavailable/Software")

        return VideoToolboxEncoderCapability(
            h264HardwareSupported: h264HW,
            hevcHardwareSupported: hevcHW,
            summary: parts.joined(separator: " · ")
        )
    }
}

private final class CaptureStreamDelegate: NSObject, SCStreamDelegate, SCStreamOutput {
    private let onCompleteFrame: @Sendable () -> Void
    private let onStreamError: @Sendable (Error) -> Void

    init(
        onCompleteFrame: @escaping @Sendable () -> Void,
        onStreamError: @escaping @Sendable (Error) -> Void
    ) {
        self.onCompleteFrame = onCompleteFrame
        self.onStreamError = onStreamError
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen, sampleBuffer.isValid else { return }

        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let firstAttachment = attachments.first,
            let statusRawValue = firstAttachment[.status] as? Int,
            let frameStatus = SCFrameStatus(rawValue: statusRawValue),
            frameStatus == .complete
        else {
            return
        }

        onCompleteFrame()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStreamError(error)
    }
}

@MainActor
public final class ScreenCaptureService {
    private let permissionChecker: ScreenRecordingPermissionChecking
    private let captureQueue = DispatchQueue(label: "com.castorapro.macos.screencapture", qos: .userInteractive)

    private var cachedDisplays: [CGDirectDisplayID: SCDisplay] = [:]
    private var activeStream: SCStream?
    private var streamDelegate: CaptureStreamDelegate?

    public init(permissionChecker: ScreenRecordingPermissionChecking = SystemScreenRecordingPermissionService()) {
        self.permissionChecker = permissionChecker
    }

    public func enumerateDisplays() async throws -> [DisplayDescriptor] {
        guard permissionChecker.checkStatus() == .granted else {
            throw CaptureServiceError.permissionDenied
        }

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )

            var displayMap: [CGDirectDisplayID: SCDisplay] = [:]
            let mainID = CGMainDisplayID()

            let descriptors = content.displays.enumerated().map { index, scDisplay in
                displayMap[scDisplay.displayID] = scDisplay
                let isMain = scDisplay.displayID == mainID
                let label = isMain ? "Main Display (\(index + 1))" : "External Display \(index + 1)"
                return DisplayDescriptor(
                    id: scDisplay.displayID,
                    name: label,
                    width: scDisplay.width,
                    height: scDisplay.height,
                    isMainDisplay: isMain
                )
            }

            guard !descriptors.isEmpty else {
                throw CaptureServiceError.noDisplaysFound
            }

            cachedDisplays = displayMap
            return descriptors
        } catch let error as CaptureServiceError {
            throw error
        } catch {
            let nsError = error as NSError
            if nsError.domain == SCStreamErrorDomain {
                if nsError.code == SCStreamError.userDeclined.rawValue {
                    throw CaptureServiceError.permissionDenied
                }
            }
            throw CaptureServiceError.captureStartFailed(error.localizedDescription)
        }
    }

    public func buildStreamConfiguration(
        for descriptor: DisplayDescriptor,
        configuration: CaptureConfiguration
    ) -> SCStreamConfiguration {
        let targetSize = configuration.resolutionPreset.targetSize(for: descriptor)
        let streamConfig = SCStreamConfiguration()
        streamConfig.width = targetSize.width
        streamConfig.height = targetSize.height
        streamConfig.minimumFrameInterval = CMTime(
            value: 1,
            timescale: CMTimeScale(configuration.frameRatePreset.rawValue)
        )
        streamConfig.pixelFormat = kCVPixelFormatType_32BGRA
        streamConfig.showsCursor = configuration.showsCursor
        streamConfig.queueDepth = 5
        return streamConfig
    }

    public func startLocalCapture(
        display descriptor: DisplayDescriptor,
        configuration: CaptureConfiguration,
        onCompleteFrame: @escaping @MainActor () -> Void,
        onUnexpectedStop: @escaping @MainActor (String) -> Void
    ) async throws -> (width: Int, height: Int) {
        guard permissionChecker.checkStatus() == .granted else {
            throw CaptureServiceError.permissionDenied
        }

        guard activeStream == nil else {
            throw CaptureServiceError.alreadyCapturing
        }

        if cachedDisplays[descriptor.id] == nil {
            _ = try await enumerateDisplays()
        }

        guard let scDisplay = cachedDisplays[descriptor.id] else {
            throw CaptureServiceError.selectedDisplayUnavailable
        }

        let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
        let streamConfig = buildStreamConfiguration(for: descriptor, configuration: configuration)

        let delegate = CaptureStreamDelegate(
            onCompleteFrame: {
                Task { @MainActor in
                    onCompleteFrame()
                }
            },
            onStreamError: { error in
                Task { @MainActor in
                    onUnexpectedStop(error.localizedDescription)
                }
            }
        )

        let stream = SCStream(filter: filter, configuration: streamConfig, delegate: delegate)

        do {
            try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: captureQueue)
            try await stream.startCapture()
            self.streamDelegate = delegate
            self.activeStream = stream
            return (streamConfig.width, streamConfig.height)
        } catch {
            self.streamDelegate = nil
            self.activeStream = nil
            throw CaptureServiceError.captureStartFailed(error.localizedDescription)
        }
    }

    public func stopLocalCapture() async {
        guard let stream = activeStream else {
            return
        }
        activeStream = nil
        streamDelegate = nil
        try? await stream.stopCapture()
    }
}
