import Foundation
import CoreGraphics

public struct DisplayDescriptor: Identifiable, Hashable, Sendable {
    public let id: CGDirectDisplayID
    public let name: String
    public let width: Int
    public let height: Int
    public let isMainDisplay: Bool

    public var resolutionText: String {
        "\(width) × \(height)"
    }

    public init(
        id: CGDirectDisplayID,
        name: String,
        width: Int,
        height: Int,
        isMainDisplay: Bool
    ) {
        self.id = id
        self.name = name
        self.width = width
        self.height = height
        self.isMainDisplay = isMainDisplay
    }
}

public enum CaptureResolutionPreset: String, CaseIterable, Identifiable, Sendable {
    case hd720 = "720p"
    case fullHD1080 = "1080p"
    case nativeDisplay = "Native"

    public var id: String { rawValue }

    public func targetSize(for display: DisplayDescriptor) -> (width: Int, height: Int) {
        let rawWidth: Int
        let rawHeight: Int

        switch self {
        case .hd720:
            rawWidth = 1280
            rawHeight = max(2, Int((Double(display.height) / Double(max(display.width, 1))) * 1280.0))
        case .fullHD1080:
            rawWidth = min(1920, display.width)
            rawHeight = max(2, Int((Double(display.height) / Double(max(display.width, 1))) * Double(rawWidth)))
        case .nativeDisplay:
            rawWidth = display.width
            rawHeight = display.height
        }

        // Hardware encoders (VideoToolbox H.264/HEVC) expect even pixel dimensions.
        return (width: rawWidth - (rawWidth % 2), height: rawHeight - (rawHeight % 2))
    }
}

public enum CaptureFrameRatePreset: Int, CaseIterable, Identifiable, Sendable {
    case fps30 = 30
    case fps60 = 60

    public var id: Int { rawValue }
    public var label: String { "\(rawValue) FPS" }
}

public struct CaptureConfiguration: Equatable, Sendable {
    public var resolutionPreset: CaptureResolutionPreset
    public var frameRatePreset: CaptureFrameRatePreset
    public var showsCursor: Bool
    public var preferredCodec: CastoraVideoCodec

    public init(
        resolutionPreset: CaptureResolutionPreset = .fullHD1080,
        frameRatePreset: CaptureFrameRatePreset = .fps60,
        showsCursor: Bool = true,
        preferredCodec: CastoraVideoCodec = .h264
    ) {
        self.resolutionPreset = resolutionPreset
        self.frameRatePreset = frameRatePreset
        self.showsCursor = showsCursor
        self.preferredCodec = preferredCodec
    }
}

public enum ScreenCaptureState: Equatable, Sendable {
    case idle
    case enumerating
    case starting
    case capturing(displayName: String, width: Int, height: Int, targetFps: Int)
    case stopping
    case failed(String)

    public var isCapturing: Bool {
        if case .capturing = self { return true }
        return false
    }

    public var isBusy: Bool {
        switch self {
        case .enumerating, .starting, .stopping:
            return true
        case .idle, .capturing, .failed:
            return false
        }
    }

    public var statusLabel: String {
        switch self {
        case .idle:
            return "Idle"
        case .enumerating:
            return "Checking Displays"
        case .starting:
            return "Starting Local Capture"
        case .capturing(let displayName, let width, let height, let targetFps):
            return "Capturing \(displayName) (\(width)×\(height) @ \(targetFps) FPS target)"
        case .stopping:
            return "Stopping Capture"
        case .failed(let message):
            return "Capture Error: \(message)"
        }
    }
}

public enum CaptureServiceError: LocalizedError, Equatable, Sendable {
    case permissionDenied(domain: String, code: Int, detail: String)
    case enumerationFailed(domain: String, code: Int, detail: String)
    case noDisplaysFound
    case selectedDisplayUnavailable
    case alreadyCapturing
    case captureStartFailed(domain: String, code: Int, detail: String)

    public var errorDescription: String? {
        switch self {
        case .permissionDenied(let domain, let code, let detail):
            return "Screen Recording permission denied by ScreenCaptureKit [\(domain) (\(code))]: \(detail)"
        case .enumerationFailed(let domain, let code, let detail):
            return "ScreenCaptureKit display enumeration failed [\(domain) (\(code))]: \(detail)"
        case .noDisplaysFound:
            return "ScreenCaptureKit found no shareable displays."
        case .selectedDisplayUnavailable:
            return "The selected display is no longer available."
        case .alreadyCapturing:
            return "A local ScreenCaptureKit session is already running."
        case .captureStartFailed(let domain, let code, let detail):
            return "ScreenCaptureKit failed to start [\(domain) (\(code))]: \(detail)"
        }
    }
}

public struct VideoToolboxEncoderCapability: Equatable, Sendable {
    public let h264HardwareSupported: Bool
    public let hevcHardwareSupported: Bool
    public let summary: String

    public init(h264HardwareSupported: Bool, hevcHardwareSupported: Bool, summary: String) {
        self.h264HardwareSupported = h264HardwareSupported
        self.hevcHardwareSupported = hevcHardwareSupported
        self.summary = summary
    }
}

public enum CaptureFrameOutcome: Sendable, Equatable {
    case complete
    case idle
    case dropped
    case lifecycle
}

public struct CaptureMetricsSnapshot: Equatable, Sendable {
    public let receivedCallbacks: Int
    public let completeFrames: Int
    public let idleFrames: Int
    public let droppedFrames: Int
    public let lifecycleCallbacks: Int
    public let rollingCompleteFps: Double
    public let rollingCallbackRate: Double
    public let sessionAverageCompleteFps: Double
    public let elapsedSeconds: TimeInterval
    public let lastCallbackTimestamp: TimeInterval?
    public let lastCompleteFrameTimestamp: TimeInterval?
    public let lastPresentationTimestampSeconds: Double?
    public let lastInterFrameIntervalMs: Double?

    public static let empty = CaptureMetricsSnapshot(
        receivedCallbacks: 0,
        completeFrames: 0,
        idleFrames: 0,
        droppedFrames: 0,
        lifecycleCallbacks: 0,
        rollingCompleteFps: 0,
        rollingCallbackRate: 0,
        sessionAverageCompleteFps: 0,
        elapsedSeconds: 0,
        lastCallbackTimestamp: nil,
        lastCompleteFrameTimestamp: nil,
        lastPresentationTimestampSeconds: nil,
        lastInterFrameIntervalMs: nil
    )

    public init(
        receivedCallbacks: Int,
        completeFrames: Int,
        idleFrames: Int,
        droppedFrames: Int,
        lifecycleCallbacks: Int,
        rollingCompleteFps: Double,
        rollingCallbackRate: Double,
        sessionAverageCompleteFps: Double,
        elapsedSeconds: TimeInterval,
        lastCallbackTimestamp: TimeInterval?,
        lastCompleteFrameTimestamp: TimeInterval?,
        lastPresentationTimestampSeconds: Double?,
        lastInterFrameIntervalMs: Double?
    ) {
        self.receivedCallbacks = receivedCallbacks
        self.completeFrames = completeFrames
        self.idleFrames = idleFrames
        self.droppedFrames = droppedFrames
        self.lifecycleCallbacks = lifecycleCallbacks
        self.rollingCompleteFps = rollingCompleteFps
        self.rollingCallbackRate = rollingCallbackRate
        self.sessionAverageCompleteFps = sessionAverageCompleteFps
        self.elapsedSeconds = elapsedSeconds
        self.lastCallbackTimestamp = lastCallbackTimestamp
        self.lastCompleteFrameTimestamp = lastCompleteFrameTimestamp
        self.lastPresentationTimestampSeconds = lastPresentationTimestampSeconds
        self.lastInterFrameIntervalMs = lastInterFrameIntervalMs
    }
}

