import Foundation

public enum ScreenRecordingPermissionStatus: Sendable, Equatable {
    case checking
    case granted
    case deniedOrNotGranted
    case diagnosticError(String)

    public var title: String {
        switch self {
        case .checking:
            return "Checking..."
        case .granted:
            return "Granted"
        case .deniedOrNotGranted:
            return "Not Granted"
        case .diagnosticError:
            return "Unable to Determine"
        }
    }

    public var isGranted: Bool {
        if case .granted = self {
            return true
        }
        return false
    }

    public var isChecking: Bool {
        if case .checking = self {
            return true
        }
        return false
    }

    public var explanation: String {
        switch self {
        case .checking:
            return "Verifying actual display enumeration access via ScreenCaptureKit..."
        case .granted:
            return "ScreenCaptureKit shareable-content access is authorized. Castora Pro can list displays and capture frames."
        case .deniedOrNotGranted:
            return "macOS denied ScreenCaptureKit access. Enable Castora Pro in System Settings → Privacy & Security → Screen Recording, then click Refresh Status."
        case .diagnosticError(let detail):
            return "Unable to determine Screen Recording access via ScreenCaptureKit: \(detail)"
        }
    }
}

public struct PermissionCheckOutcome: Sendable, Equatable {
    public let status: ScreenRecordingPermissionStatus
    public let preflightGranted: Bool
    public let shareableContentAuthorized: Bool
    public let diagnosticMessage: String
    public let errorDomain: String?
    public let errorCode: Int?
    public let errorDescription: String?

    public init(
        status: ScreenRecordingPermissionStatus,
        preflightGranted: Bool,
        shareableContentAuthorized: Bool,
        diagnosticMessage: String,
        errorDomain: String? = nil,
        errorCode: Int? = nil,
        errorDescription: String? = nil
    ) {
        self.status = status
        self.preflightGranted = preflightGranted
        self.shareableContentAuthorized = shareableContentAuthorized
        self.diagnosticMessage = diagnosticMessage
        self.errorDomain = errorDomain
        self.errorCode = errorCode
        self.errorDescription = errorDescription
    }
}

public struct PermissionDiagnosticState: Sendable, Equatable {
    public let screenRecording: ScreenRecordingPermissionStatus
    public let preflightGranted: Bool?
    public let shareableContentAuthorized: Bool?
    public let errorDomain: String?
    public let errorCode: Int?
    public let errorDescription: String?
    public let lastCheckedAt: Date
    public let lastActionMessage: String?

    public init(
        screenRecording: ScreenRecordingPermissionStatus,
        preflightGranted: Bool? = nil,
        shareableContentAuthorized: Bool? = nil,
        errorDomain: String? = nil,
        errorCode: Int? = nil,
        errorDescription: String? = nil,
        lastCheckedAt: Date = Date(),
        lastActionMessage: String? = nil
    ) {
        self.screenRecording = screenRecording
        self.preflightGranted = preflightGranted
        self.shareableContentAuthorized = shareableContentAuthorized
        self.errorDomain = errorDomain
        self.errorCode = errorCode
        self.errorDescription = errorDescription
        self.lastCheckedAt = lastCheckedAt
        self.lastActionMessage = lastActionMessage
    }
}
