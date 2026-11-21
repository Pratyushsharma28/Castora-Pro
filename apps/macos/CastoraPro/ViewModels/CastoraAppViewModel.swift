import Foundation
import SwiftUI

@MainActor
public final class CastoraAppViewModel: ObservableObject {
    @Published public var selectedSection: AppNavigationSection = .dashboard
    @Published public private(set) var permissionState: PermissionDiagnosticState
    @Published public private(set) var displays: [DisplayDescriptor] = []
    @Published public var selectedDisplayID: CGDirectDisplayID?
    @Published public var captureConfiguration = CaptureConfiguration()
    @Published public private(set) var captureState: ScreenCaptureState = .idle
    @Published public private(set) var captureMetrics: CaptureMetricsSnapshot = .empty
    @Published public private(set) var deliveredFrameCount: Int = 0
    @Published public private(set) var lastCaptureError: String?
    @Published public private(set) var encoderCapability: VideoToolboxEncoderCapability
    @Published public var deviceDisplayName: String
    @Published public private(set) var localDeviceId: String

    public let networkingConfig = Phase3NetworkingConfiguration()
    public let transportStatus: TransportPipelineStatus = .notImplementedInPhase3

    private let permissionService: ScreenRecordingPermissionChecking
    private let captureService: ScreenCaptureService
    private let identityService: DeviceIdentityService
    private let encoderProbe: VideoToolboxCapabilityProbe
    private var metricsPollingTask: Task<Void, Never>?

    public init(
        permissionService: ScreenRecordingPermissionChecking = SystemScreenRecordingPermissionService(),
        contentProvider: DisplayContentProviding = SystemDisplayContentProvider(),
        identityService: DeviceIdentityService = DeviceIdentityService(),
        encoderProbe: VideoToolboxCapabilityProbe = VideoToolboxCapabilityProbe()
    ) {
        self.permissionService = permissionService
        self.captureService = ScreenCaptureService(contentProvider: contentProvider)
        self.identityService = identityService
        self.encoderProbe = encoderProbe

        let preflight = permissionService.checkPreflight()
        self.permissionState = PermissionDiagnosticState(
            screenRecording: .checking,
            preflightGranted: preflight,
            shareableContentAuthorized: nil,
            lastCheckedAt: Date(),
            lastActionMessage: "Verifying ScreenCaptureKit authorization..."
        )
        self.deviceDisplayName = identityService.loadDeviceName()
        self.localDeviceId = identityService.loadOrCreateDeviceId()
        self.encoderCapability = encoderProbe.inspectHardwareEncoders()
    }

    public func refreshPermissionStatus() async {
        let preflight = permissionService.checkPreflight()
        permissionState = PermissionDiagnosticState(
            screenRecording: .checking,
            preflightGranted: preflight,
            shareableContentAuthorized: nil,
            lastCheckedAt: Date(),
            lastActionMessage: "Querying ScreenCaptureKit shareable content..."
        )

        let outcome = await permissionService.verifyAccess()
        applyPermissionOutcome(outcome)
    }

    public func requestScreenRecordingPermission() async {
        let preflight = permissionService.checkPreflight()
        permissionState = PermissionDiagnosticState(
            screenRecording: .checking,
            preflightGranted: preflight,
            shareableContentAuthorized: nil,
            lastCheckedAt: Date(),
            lastActionMessage: "Requesting Screen Recording permission and verifying via ScreenCaptureKit..."
        )

        let outcome = await permissionService.requestPermissionPrompt()
        applyPermissionOutcome(outcome)
    }

    public func openPrivacySettings() {
        let opened = permissionService.openScreenRecordingSettings()
        let note = opened
            ? "Opened System Settings → Privacy & Security → Screen Recording. After toggling access, click Refresh Status."
            : "Unable to open System Settings automatically. Open Privacy & Security → Screen Recording manually, then click Refresh Status."
        permissionState = PermissionDiagnosticState(
            screenRecording: permissionState.screenRecording,
            preflightGranted: permissionService.checkPreflight(),
            shareableContentAuthorized: permissionState.shareableContentAuthorized,
            errorDomain: permissionState.errorDomain,
            errorCode: permissionState.errorCode,
            errorDescription: permissionState.errorDescription,
            lastCheckedAt: Date(),
            lastActionMessage: note
        )
    }

    public func refreshDisplays() async {
        if !captureState.isCapturing {
            captureState = .enumerating
        }
        lastCaptureError = nil

        do {
            let found = try await captureService.enumerateDisplays()
            displays = found
            if let currentID = selectedDisplayID, found.contains(where: { $0.id == currentID }) {
                selectedDisplayID = currentID
            } else {
                selectedDisplayID = found.first(where: { $0.isMainDisplay })?.id ?? found.first?.id
            }
            if !captureState.isCapturing {
                captureState = .idle
            }

            let preflight = permissionService.checkPreflight()
            let diagnostic = preflight
                ? "ScreenCaptureKit enumerated \(found.count) display(s); CoreGraphics preflight also returned true."
                : "ScreenCaptureKit enumerated \(found.count) display(s), confirming authorization even though CGPreflightScreenCaptureAccess() returned false."
            permissionState = PermissionDiagnosticState(
                screenRecording: .granted,
                preflightGranted: preflight,
                shareableContentAuthorized: true,
                errorDomain: nil,
                errorCode: nil,
                errorDescription: nil,
                lastCheckedAt: Date(),
                lastActionMessage: diagnostic
            )
        } catch let error as CaptureServiceError {
            displays = []
            selectedDisplayID = nil
            lastCaptureError = error.localizedDescription
            if !captureState.isCapturing {
                captureState = .failed(error.localizedDescription)
            }
            updatePermissionStateFromCaptureError(error)
        } catch {
            displays = []
            selectedDisplayID = nil
            let nsError = error as NSError
            lastCaptureError = error.localizedDescription
            if !captureState.isCapturing {
                captureState = .failed(error.localizedDescription)
            }
            permissionState = PermissionDiagnosticState(
                screenRecording: .diagnosticError("\(nsError.domain) (\(nsError.code)): \(nsError.localizedDescription)"),
                preflightGranted: permissionService.checkPreflight(),
                shareableContentAuthorized: false,
                errorDomain: nsError.domain,
                errorCode: nsError.code,
                errorDescription: nsError.localizedDescription,
                lastCheckedAt: Date(),
                lastActionMessage: "Display enumeration error [\(nsError.domain) (\(nsError.code))]: \(nsError.localizedDescription)"
            )
        }
    }

    public var selectedDisplay: DisplayDescriptor? {
        guard let id = selectedDisplayID else { return displays.first }
        return displays.first(where: { $0.id == id })
    }

    public func startLocalCaptureTest() async {
        if displays.isEmpty {
            await refreshDisplays()
        }

        guard let targetDisplay = selectedDisplay else {
            let msg = lastCaptureError ?? CaptureServiceError.noDisplaysFound.localizedDescription
            lastCaptureError = msg
            captureState = .failed(msg)
            return
        }

        captureState = .starting
        lastCaptureError = nil
        captureMetrics = .empty
        deliveredFrameCount = 0
        stopMetricsPolling()

        do {
            let resolvedSize = try await captureService.startLocalCapture(
                display: targetDisplay,
                configuration: captureConfiguration,
                onUnexpectedStop: { [weak self] reason in
                    guard let self else { return }
                    self.stopMetricsPolling()
                    self.syncCaptureMetrics()
                    self.captureState = .failed(reason)
                    self.lastCaptureError = reason
                }
            )
            captureState = .capturing(
                displayName: targetDisplay.name,
                width: resolvedSize.width,
                height: resolvedSize.height,
                targetFps: captureConfiguration.frameRatePreset.rawValue
            )
            startMetricsPolling()
        } catch let error as CaptureServiceError {
            stopMetricsPolling()
            captureState = .failed(error.localizedDescription)
            lastCaptureError = error.localizedDescription
            updatePermissionStateFromCaptureError(error)
        } catch {
            stopMetricsPolling()
            captureState = .failed(error.localizedDescription)
            lastCaptureError = error.localizedDescription
        }
    }

    public func stopLocalCaptureTest() async {
        captureState = .stopping
        stopMetricsPolling()
        await captureService.stopLocalCapture()
        syncCaptureMetrics()
        captureState = .idle
    }

    private func applyPermissionOutcome(_ outcome: PermissionCheckOutcome) {
        permissionState = PermissionDiagnosticState(
            screenRecording: outcome.status,
            preflightGranted: outcome.preflightGranted,
            shareableContentAuthorized: outcome.shareableContentAuthorized,
            errorDomain: outcome.errorDomain,
            errorCode: outcome.errorCode,
            errorDescription: outcome.errorDescription,
            lastCheckedAt: Date(),
            lastActionMessage: outcome.diagnosticMessage
        )
    }

    private func updatePermissionStateFromCaptureError(_ error: CaptureServiceError) {
        let preflight = permissionService.checkPreflight()
        switch error {
        case .permissionDenied(let domain, let code, let detail):
            permissionState = PermissionDiagnosticState(
                screenRecording: .deniedOrNotGranted,
                preflightGranted: preflight,
                shareableContentAuthorized: false,
                errorDomain: domain,
                errorCode: code,
                errorDescription: detail,
                lastCheckedAt: Date(),
                lastActionMessage: error.localizedDescription
            )
        case .enumerationFailed(let domain, let code, let detail):
            permissionState = PermissionDiagnosticState(
                screenRecording: .diagnosticError("\(domain) (\(code)): \(detail)"),
                preflightGranted: preflight,
                shareableContentAuthorized: false,
                errorDomain: domain,
                errorCode: code,
                errorDescription: detail,
                lastCheckedAt: Date(),
                lastActionMessage: error.localizedDescription
            )
        case .captureStartFailed(let domain, let code, let detail):
            permissionState = PermissionDiagnosticState(
                screenRecording: permissionState.screenRecording,
                preflightGranted: preflight,
                shareableContentAuthorized: permissionState.shareableContentAuthorized,
                errorDomain: domain,
                errorCode: code,
                errorDescription: detail,
                lastCheckedAt: Date(),
                lastActionMessage: error.localizedDescription
            )
        case .noDisplaysFound:
            permissionState = PermissionDiagnosticState(
                screenRecording: .granted,
                preflightGranted: preflight,
                shareableContentAuthorized: true,
                errorDomain: nil,
                errorCode: nil,
                errorDescription: nil,
                lastCheckedAt: Date(),
                lastActionMessage: "ScreenCaptureKit authorized, but returned 0 shareable displays."
            )
        case .selectedDisplayUnavailable, .alreadyCapturing:
            break
        }
    }

    private func startMetricsPolling() {
        stopMetricsPolling()
        metricsPollingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled, let self else { break }
                self.syncCaptureMetrics()
            }
        }
    }

    private func stopMetricsPolling() {
        metricsPollingTask?.cancel()
        metricsPollingTask = nil
    }

    private func syncCaptureMetrics() {
        let snapshot = captureService.currentCaptureMetrics()
        captureMetrics = snapshot
        deliveredFrameCount = snapshot.completeFrames
    }

    public func saveDeviceDisplayName() {
        identityService.saveDeviceName(deviceDisplayName)
        deviceDisplayName = identityService.loadDeviceName()
    }
}
