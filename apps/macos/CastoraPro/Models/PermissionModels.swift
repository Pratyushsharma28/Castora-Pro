import Foundation

public enum ScreenRecordingPermissionStatus: String, Sendable, Equatable {
    case granted
    case deniedOrNotGranted

    public var title: String {
        switch self {
        case .granted:
            return "Granted"
        case .deniedOrNotGranted:
            return "Not Granted"
        }
    }

    public var isGranted: Bool {
        self == .granted
    }

    public var explanation: String {
        switch self {
        case .granted:
            return "macOS Screen Recording access is authorized. Castora Pro can list displays via ScreenCaptureKit."
        case .deniedOrNotGranted:
            return "Castora Pro requires macOS Screen Recording permission to list displays and capture frames using ScreenCaptureKit. Without this permission, displays cannot be captured."
        }
    }
}

public struct PermissionDiagnosticState: Sendable, Equatable {
    public let screenRecording: ScreenRecordingPermissionStatus
    public let lastCheckedAt: Date
    public let lastActionMessage: String?

    public init(
        screenRecording: ScreenRecordingPermissionStatus,
        lastCheckedAt: Date = Date(),
        lastActionMessage: String? = nil
    ) {
        self.screenRecording = screenRecording
        self.lastCheckedAt = lastCheckedAt
        self.lastActionMessage = lastActionMessage
    }
}
