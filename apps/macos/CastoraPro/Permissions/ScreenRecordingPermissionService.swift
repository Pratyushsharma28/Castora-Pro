import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Abstraction over macOS Screen Recording authorization verification so unit tests can
/// test preflight discrepancies, ScreenCaptureKit denials, and diagnostic errors deterministically.
public protocol ScreenRecordingPermissionChecking: Sendable {
    func checkPreflight() -> Bool
    func verifyAccess() async -> PermissionCheckOutcome
    @discardableResult
    func requestPermissionPrompt() async -> PermissionCheckOutcome
    func openScreenRecordingSettings() -> Bool
}

public struct SystemScreenRecordingPermissionService: ScreenRecordingPermissionChecking {
    private let preflightCheck: @Sendable () -> Bool
    private let requestPrompt: @Sendable () -> Bool
    private let shareableContentProbe: @Sendable () async throws -> Int
    private let openSettings: @Sendable () -> Bool

    public init(
        preflightCheck: @escaping @Sendable () -> Bool = {
            CGPreflightScreenCaptureAccess()
        },
        requestPrompt: @escaping @Sendable () -> Bool = {
            CGRequestScreenCaptureAccess()
        },
        shareableContentProbe: @escaping @Sendable () async throws -> Int = {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
            return content.displays.count
        },
        openSettings: @escaping @Sendable () -> Bool = {
            guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") else {
                return false
            }
            return NSWorkspace.shared.open(url)
        }
    ) {
        self.preflightCheck = preflightCheck
        self.requestPrompt = requestPrompt
        self.shareableContentProbe = shareableContentProbe
        self.openSettings = openSettings
    }

    public func checkPreflight() -> Bool {
        preflightCheck()
    }

    public func verifyAccess() async -> PermissionCheckOutcome {
        let preflight = preflightCheck()

        do {
            let displayCount = try await shareableContentProbe()
            let message: String
            if preflight {
                message = "ScreenCaptureKit probe succeeded (\(displayCount) display(s)); CoreGraphics preflight also returned true."
            } else {
                message = "ScreenCaptureKit probe succeeded (\(displayCount) display(s)), confirming authorization even though CGPreflightScreenCaptureAccess() returned false."
            }

            return PermissionCheckOutcome(
                status: .granted,
                preflightGranted: preflight,
                shareableContentAuthorized: true,
                diagnosticMessage: message
            )
        } catch {
            let nsError = error as NSError
            let domain = nsError.domain
            let code = nsError.code
            let description = nsError.localizedDescription

            if domain == SCStreamErrorDomain && code == SCStreamError.userDeclined.rawValue {
                return PermissionCheckOutcome(
                    status: .deniedOrNotGranted,
                    preflightGranted: preflight,
                    shareableContentAuthorized: false,
                    diagnosticMessage: "ScreenCaptureKit denied access [\(domain) (\(code))]: \(description)",
                    errorDomain: domain,
                    errorCode: code,
                    errorDescription: description
                )
            }

            return PermissionCheckOutcome(
                status: .diagnosticError("\(domain) (\(code)): \(description)"),
                preflightGranted: preflight,
                shareableContentAuthorized: false,
                diagnosticMessage: "ScreenCaptureKit verification error [\(domain) (\(code))]: \(description)",
                errorDomain: domain,
                errorCode: code,
                errorDescription: description
            )
        }
    }

    @discardableResult
    public func requestPermissionPrompt() async -> PermissionCheckOutcome {
        _ = requestPrompt()
        return await verifyAccess()
    }

    public func openScreenRecordingSettings() -> Bool {
        openSettings()
    }
}
