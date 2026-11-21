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

    public init(
        permissionService: ScreenRecordingPermissionChecking = SystemScreenRecordingPermissionService(),
        identityService: DeviceIdentityService = DeviceIdentityService(),
        encoderProbe: VideoToolboxCapabilityProbe = VideoToolboxCapabilityProbe()
    ) {
        self.permissionService = permissionService
        self.captureService = ScreenCaptureService(permissionChecker: permissionService)
        self.identityService = identityService
        self.encoderProbe = encoderProbe

        let initialStatus = permissionService.checkStatus()
        self.permissionState = PermissionDiagnosticState(screenRecording: initialStatus)
        self.deviceDisplayName = identityService.loadDeviceName()
        self.localDeviceId = identityService.loadOrCreateDeviceId()
        self.encoderCapability = encoderProbe.inspectHardwareEncoders()
    }

    public func refreshPermissionStatus() {
        let status = permissionService.checkStatus()
        let message: String = status.isGranted
            ? "Screen Recording permission verified."
            : "Screen Recording permission is still not granted."
        permissionState = PermissionDiagnosticState(
            screenRecording: status,
            lastCheckedAt: Date(),
            lastActionMessage: message
        )
    }

    public func requestScreenRecordingPermission() {
        let resultingStatus = permissionService.requestPermissionPrompt()
        let message: String
        if resultingStatus.isGranted {
            message = "Screen Recording permission granted."
        } else {
            message = "Permission not granted yet. Enable Castora Pro in System Settings → Privacy & Security → Screen Recording, then click Refresh Status."
        }
        permissionState = PermissionDiagnosticState(
            screenRecording: resultingStatus,
            lastCheckedAt: Date(),
            lastActionMessage: message
        )
    }

    public func openPrivacySettings() {
        let opened = permissionService.openScreenRecordingSettings()
        let note = opened
            ? "Opened System Settings → Privacy & Security → Screen Recording."
            : "Unable to open System Settings automatically. Open Privacy & Security → Screen Recording manually."
        permissionState = PermissionDiagnosticState(
            screenRecording: permissionService.checkStatus(),
            lastCheckedAt: Date(),
            lastActionMessage: note
        )
    }

    public func refreshDisplays() async {
        refreshPermissionStatus()
        guard permissionState.screenRecording.isGranted else {
            displays = []
            selectedDisplayID = nil
            lastCaptureError = CaptureServiceError.permissionDenied.localizedDescription
            return
        }

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
        } catch {
            displays = []
            selectedDisplayID = nil
            lastCaptureError = error.localizedDescription
            if !captureState.isCapturing {
                captureState = .failed(error.localizedDescription)
            }
        }
    }

    public var selectedDisplay: DisplayDescriptor? {
        guard let id = selectedDisplayID else { return displays.first }
        return displays.first(where: { $0.id == id })
    }

    public func startLocalCaptureTest() async {
        refreshPermissionStatus()
        guard permissionState.screenRecording.isGranted else {
            lastCaptureError = CaptureServiceError.permissionDenied.localizedDescription
            captureState = .failed(CaptureServiceError.permissionDenied.localizedDescription)
            return
        }

        if displays.isEmpty {
            await refreshDisplays()
        }

        guard let targetDisplay = selectedDisplay else {
            let msg = CaptureServiceError.noDisplaysFound.localizedDescription
            lastCaptureError = msg
            captureState = .failed(msg)
            return
        }

        captureState = .starting
        lastCaptureError = nil
        deliveredFrameCount = 0

        do {
            let resolvedSize = try await captureService.startLocalCapture(
                display: targetDisplay,
                configuration: captureConfiguration,
                onCompleteFrame: { [weak self] in
                    self?.deliveredFrameCount += 1
                },
                onUnexpectedStop: { [weak self] reason in
                    guard let self else { return }
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
        } catch {
            captureState = .failed(error.localizedDescription)
            lastCaptureError = error.localizedDescription
        }
    }

    public func stopLocalCaptureTest() async {
        captureState = .stopping
        await captureService.stopLocalCapture()
        captureState = .idle
    }

    public func saveDeviceDisplayName() {
        identityService.saveDeviceName(deviceDisplayName)
        deviceDisplayName = identityService.loadDeviceName()
    }
}
