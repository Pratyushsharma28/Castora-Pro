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

private final class CaptureStreamDelegate: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    private let metricsTracker: CaptureMetricsTracker
    private let onStreamError: @Sendable (Error) -> Void

    init(
        metricsTracker: CaptureMetricsTracker,
        onStreamError: @escaping @Sendable (Error) -> Void
    ) {
        self.metricsTracker = metricsTracker
        self.onStreamError = onStreamError
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen else { return }
        let receiptTimestamp = ProcessInfo.processInfo.systemUptime

        guard sampleBuffer.isValid else {
            metricsTracker.recordCallback(outcome: .dropped, at: receiptTimestamp)
            return
        }

        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let firstAttachment = attachments.first,
            let statusRawValue = firstAttachment[.status] as? Int,
            let frameStatus = SCFrameStatus(rawValue: statusRawValue)
        else {
            metricsTracker.recordCallback(outcome: .dropped, at: receiptTimestamp)
            return
        }

        let outcome: CaptureFrameOutcome
        var presentationSeconds: Double?

        switch frameStatus {
        case .complete:
            if CMSampleBufferGetImageBuffer(sampleBuffer) != nil {
                outcome = .complete
                let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                if pts.isValid && pts.isNumeric {
                    presentationSeconds = pts.seconds
                }
            } else {
                outcome = .dropped
            }
        case .idle:
            outcome = .idle
        case .blank, .suspended:
            outcome = .dropped
        case .started:
            outcome = .lifecycle
        @unknown default:
            // Raw value 5 corresponds to SCFrameStatus.stopped introduced in macOS 14.
            outcome = frameStatus.rawValue == 5 ? .lifecycle : .dropped
        }

        metricsTracker.recordCallback(
            outcome: outcome,
            presentationTimestampSeconds: presentationSeconds,
            at: receiptTimestamp
        )
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStreamError(error)
    }
}

public struct ScreenCaptureDisplayQueryResult: @unchecked Sendable {
    public let descriptors: [DisplayDescriptor]
    public let scDisplays: [CGDirectDisplayID: SCDisplay]

    public init(
        descriptors: [DisplayDescriptor],
        scDisplays: [CGDirectDisplayID: SCDisplay] = [:]
    ) {
        self.descriptors = descriptors
        self.scDisplays = scDisplays
    }
}

public protocol DisplayContentProviding: Sendable {
    func fetchShareableDisplays() async throws -> ScreenCaptureDisplayQueryResult
}

public struct SystemDisplayContentProvider: DisplayContentProviding {
    public init() {}

    public func fetchShareableDisplays() async throws -> ScreenCaptureDisplayQueryResult {
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

        return ScreenCaptureDisplayQueryResult(descriptors: descriptors, scDisplays: displayMap)
    }
}

@MainActor
public final class ScreenCaptureService {
    private let contentProvider: DisplayContentProviding
    private let captureQueue = DispatchQueue(label: "com.castorapro.macos.screencapture", qos: .userInteractive)
    private let metricsTracker = CaptureMetricsTracker(rollingWindowSeconds: 2.0)

    private var cachedDisplays: [CGDirectDisplayID: SCDisplay] = [:]
    private var activeStream: SCStream?
    private var streamDelegate: CaptureStreamDelegate?

    public init(contentProvider: DisplayContentProviding = SystemDisplayContentProvider()) {
        self.contentProvider = contentProvider
    }

    public func currentCaptureMetrics() -> CaptureMetricsSnapshot {
        metricsTracker.snapshot()
    }

    public func enumerateDisplays() async throws -> [DisplayDescriptor] {
        do {
            let result = try await contentProvider.fetchShareableDisplays()
            guard !result.descriptors.isEmpty else {
                throw CaptureServiceError.noDisplaysFound
            }

            cachedDisplays = result.scDisplays
            return result.descriptors
        } catch let error as CaptureServiceError {
            throw error
        } catch {
            let nsError = error as NSError
            if nsError.domain == SCStreamErrorDomain && nsError.code == SCStreamError.userDeclined.rawValue {
                throw CaptureServiceError.permissionDenied(
                    domain: nsError.domain,
                    code: nsError.code,
                    detail: nsError.localizedDescription
                )
            }
            throw CaptureServiceError.enumerationFailed(
                domain: nsError.domain,
                code: nsError.code,
                detail: nsError.localizedDescription
            )
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
        streamConfig.queueDepth = 8
        return streamConfig
    }

    public func startLocalCapture(
        display descriptor: DisplayDescriptor,
        configuration: CaptureConfiguration,
        onUnexpectedStop: @escaping @MainActor (String) -> Void
    ) async throws -> (width: Int, height: Int) {
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
        metricsTracker.reset()

        let delegate = CaptureStreamDelegate(
            metricsTracker: metricsTracker,
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
            let nsError = error as NSError
            if nsError.domain == SCStreamErrorDomain && nsError.code == SCStreamError.userDeclined.rawValue {
                throw CaptureServiceError.permissionDenied(
                    domain: nsError.domain,
                    code: nsError.code,
                    detail: nsError.localizedDescription
                )
            }
            throw CaptureServiceError.captureStartFailed(
                domain: nsError.domain,
                code: nsError.code,
                detail: nsError.localizedDescription
            )
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
