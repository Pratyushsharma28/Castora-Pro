import Foundation
import XCTest
@testable import CastoraPro

private final class MockPermissionChecker: ScreenRecordingPermissionChecking, @unchecked Sendable {
    var currentStatus: ScreenRecordingPermissionStatus
    var promptResult: ScreenRecordingPermissionStatus
    var settingsOpenResult: Bool

    init(
        currentStatus: ScreenRecordingPermissionStatus,
        promptResult: ScreenRecordingPermissionStatus? = nil,
        settingsOpenResult: Bool = true
    ) {
        self.currentStatus = currentStatus
        self.promptResult = promptResult ?? currentStatus
        self.settingsOpenResult = settingsOpenResult
    }

    func checkStatus() -> ScreenRecordingPermissionStatus {
        currentStatus
    }

    func requestPermissionPrompt() -> ScreenRecordingPermissionStatus {
        currentStatus = promptResult
        return promptResult
    }

    func openScreenRecordingSettings() -> Bool {
        settingsOpenResult
    }
}

final class PermissionStateTests: XCTestCase {
    @MainActor
    func testInitialStateRespectsDeniedPermissionWithoutFakingGrant() {
        let checker = MockPermissionChecker(currentStatus: .deniedOrNotGranted)
        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.denied")!)
        )

        XCTAssertFalse(viewModel.permissionState.screenRecording.isGranted)
        XCTAssertEqual(viewModel.permissionState.screenRecording, .deniedOrNotGranted)
        XCTAssertTrue(viewModel.displays.isEmpty)
        XCTAssertEqual(viewModel.deliveredFrameCount, 0)
        XCTAssertEqual(viewModel.captureMetrics, .empty)
        XCTAssertEqual(viewModel.transportStatus, .notImplementedInPhase3)
    }

    @MainActor
    func testRequestPermissionAndRefreshStatusUpdatesStateTruthfully() {
        let checker = MockPermissionChecker(
            currentStatus: .deniedOrNotGranted,
            promptResult: .deniedOrNotGranted
        )
        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.refresh")!)
        )

        viewModel.requestScreenRecordingPermission()
        XCTAssertFalse(viewModel.permissionState.screenRecording.isGranted)
        XCTAssertNotNil(viewModel.permissionState.lastActionMessage)

        // Simulate user toggling the permission in macOS System Settings and clicking Refresh Status.
        checker.currentStatus = .granted
        viewModel.refreshPermissionStatus()
        XCTAssertTrue(viewModel.permissionState.screenRecording.isGranted)
    }

    @MainActor
    func testOpenPrivacySettingsReportsSuccessAndFailure() {
        let checker = MockPermissionChecker(currentStatus: .deniedOrNotGranted, settingsOpenResult: false)
        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.settings")!)
        )

        viewModel.openPrivacySettings()
        XCTAssertEqual(
            viewModel.permissionState.lastActionMessage,
            "Unable to open System Settings automatically. Open Privacy & Security → Screen Recording manually."
        )

        checker.settingsOpenResult = true
        viewModel.openPrivacySettings()
        XCTAssertEqual(
            viewModel.permissionState.lastActionMessage,
            "Opened System Settings → Privacy & Security → Screen Recording."
        )
    }

    @MainActor
    func testCaptureAndDisplayRefreshFailGracefullyWhenPermissionDenied() async {
        let checker = MockPermissionChecker(currentStatus: .deniedOrNotGranted)
        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.captureDenied")!)
        )

        await viewModel.refreshDisplays()
        XCTAssertTrue(viewModel.displays.isEmpty)
        XCTAssertEqual(viewModel.lastCaptureError, CaptureServiceError.permissionDenied.localizedDescription)

        await viewModel.startLocalCaptureTest()
        XCTAssertEqual(viewModel.captureState, .failed(CaptureServiceError.permissionDenied.localizedDescription))
        XCTAssertFalse(viewModel.captureState.isCapturing)
    }

    func testCaptureResolutionPresetsProduceEvenDimensions() {
        let oddDisplay = DisplayDescriptor(
            id: 1,
            name: "Odd Resolution Test Display",
            width: 3025,
            height: 1965,
            isMainDisplay: true
        )

        for preset in CaptureResolutionPreset.allCases {
            let size = preset.targetSize(for: oddDisplay)
            XCTAssertGreaterThan(size.width, 0)
            XCTAssertGreaterThan(size.height, 0)
            XCTAssertEqual(size.width % 2, 0, "Width must be even for VideoToolbox")
            XCTAssertEqual(size.height % 2, 0, "Height must be even for VideoToolbox")
        }
    }
}
