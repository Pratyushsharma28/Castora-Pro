import AppKit
import CoreGraphics
import Foundation

/// Abstraction over macOS Screen Recording permission checks so unit tests can verify state handling deterministically.
public protocol ScreenRecordingPermissionChecking: Sendable {
    func checkStatus() -> ScreenRecordingPermissionStatus
    @discardableResult
    func requestPermissionPrompt() -> ScreenRecordingPermissionStatus
    func openScreenRecordingSettings() -> Bool
}

public struct SystemScreenRecordingPermissionService: ScreenRecordingPermissionChecking {
    public init() {}

    public func checkStatus() -> ScreenRecordingPermissionStatus {
        CGPreflightScreenCaptureAccess() ? .granted : .deniedOrNotGranted
    }

    @discardableResult
    public func requestPermissionPrompt() -> ScreenRecordingPermissionStatus {
        let granted = CGRequestScreenCaptureAccess()
        return granted ? .granted : checkStatus()
    }

    public func openScreenRecordingSettings() -> Bool {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") else {
            return false
        }
        return NSWorkspace.shared.open(url)
    }
}
