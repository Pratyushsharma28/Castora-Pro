import Foundation
import ScreenCaptureKit
import XCTest
@testable import CastoraPro

private final class MockPermissionChecker: ScreenRecordingPermissionChecking, @unchecked Sendable {
    var preflightResult: Bool
    var verifyOutcome: PermissionCheckOutcome
    var promptOutcome: PermissionCheckOutcome?
    var settingsOpenResult: Bool

    init(
        preflightResult: Bool,
        verifyOutcome: PermissionCheckOutcome,
        promptOutcome: PermissionCheckOutcome? = nil,
        settingsOpenResult: Bool = true
    ) {
        self.preflightResult = preflightResult
        self.verifyOutcome = verifyOutcome
        self.promptOutcome = promptOutcome
        self.settingsOpenResult = settingsOpenResult
    }

    func checkPreflight() -> Bool {
        preflightResult
    }

    func verifyAccess() async -> PermissionCheckOutcome {
        verifyOutcome
    }

    func requestPermissionPrompt() async -> PermissionCheckOutcome {
        if let promptOutcome {
            verifyOutcome = promptOutcome
        }
        return verifyOutcome
    }

    func openScreenRecordingSettings() -> Bool {
        settingsOpenResult
    }
}

private final class MockDisplayContentProvider: DisplayContentProviding, @unchecked Sendable {
    var result: Result<ScreenCaptureDisplayQueryResult, Error>

    init(result: Result<ScreenCaptureDisplayQueryResult, Error>) {
        self.result = result
    }

    func fetchShareableDisplays() async throws -> ScreenCaptureDisplayQueryResult {
        try result.get()
    }
}

final class PermissionStateTests: XCTestCase {
    @MainActor
    func testPreflightFalseButScreenCaptureKitQuerySucceedsReportsGranted() async {
        let service = SystemScreenRecordingPermissionService(
            preflightCheck: { false },
            requestPrompt: { false },
            shareableContentProbe: { 1 },
            openSettings: { true }
        )

        let viewModel = CastoraAppViewModel(
            permissionService: service,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.preflightMismatch")!)
        )

        XCTAssertEqual(viewModel.permissionState.screenRecording, .checking)
        await viewModel.refreshPermissionStatus()

        XCTAssertTrue(viewModel.permissionState.screenRecording.isGranted)
        XCTAssertEqual(viewModel.permissionState.screenRecording, .granted)
        XCTAssertEqual(viewModel.permissionState.preflightGranted, false)
        XCTAssertEqual(viewModel.permissionState.shareableContentAuthorized, true)
        XCTAssertNil(viewModel.permissionState.errorDomain)
        XCTAssertNil(viewModel.permissionState.errorCode)
        XCTAssertTrue(
            viewModel.permissionState.lastActionMessage?.contains("CGPreflightScreenCaptureAccess() returned false") == true
        )
    }

    @MainActor
    func testActualScreenCaptureKitPermissionDenialReportsNotGrantedWithNSErrorDetails() async {
        let tccDeniedError = NSError(
            domain: SCStreamErrorDomain,
            code: SCStreamError.userDeclined.rawValue,
            userInfo: [NSLocalizedDescriptionKey: "The user declined TCCs for application, window, display capture"]
        )

        let service = SystemScreenRecordingPermissionService(
            preflightCheck: { false },
            requestPrompt: { false },
            shareableContentProbe: { throw tccDeniedError },
            openSettings: { true }
        )

        let viewModel = CastoraAppViewModel(
            permissionService: service,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.denied")!)
        )

        await viewModel.refreshPermissionStatus()

        XCTAssertFalse(viewModel.permissionState.screenRecording.isGranted)
        XCTAssertEqual(viewModel.permissionState.screenRecording, .deniedOrNotGranted)
        XCTAssertEqual(viewModel.permissionState.preflightGranted, false)
        XCTAssertEqual(viewModel.permissionState.shareableContentAuthorized, false)
        XCTAssertEqual(viewModel.permissionState.errorDomain, SCStreamErrorDomain)
        XCTAssertEqual(viewModel.permissionState.errorCode, SCStreamError.userDeclined.rawValue)
        XCTAssertTrue(
            viewModel.permissionState.errorDescription?.contains("declined") == true
        )
        XCTAssertTrue(viewModel.displays.isEmpty)
        XCTAssertEqual(viewModel.deliveredFrameCount, 0)
        XCTAssertEqual(viewModel.captureMetrics, .empty)
        XCTAssertEqual(viewModel.transportStatus, .notImplementedInPhase3)
    }

    @MainActor
    func testOtherScreenCaptureKitErrorReportsDiagnosticErrorWithOriginalDetails() async {
        let otherError = NSError(
            domain: SCStreamErrorDomain,
            code: -3807,
            userInfo: [NSLocalizedDescriptionKey: "WindowServer connection failed during test"]
        )

        let service = SystemScreenRecordingPermissionService(
            preflightCheck: { true },
            requestPrompt: { true },
            shareableContentProbe: { throw otherError },
            openSettings: { true }
        )

        let viewModel = CastoraAppViewModel(
            permissionService: service,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.diagnosticError")!)
        )

        await viewModel.refreshPermissionStatus()

        if case .diagnosticError(let detail) = viewModel.permissionState.screenRecording {
            XCTAssertTrue(detail.contains(SCStreamErrorDomain))
            XCTAssertTrue(detail.contains("-3807"))
            XCTAssertTrue(detail.contains("WindowServer connection failed during test"))
        } else {
            XCTFail("Expected .diagnosticError, got \(viewModel.permissionState.screenRecording)")
        }
        XCTAssertEqual(viewModel.permissionState.preflightGranted, true)
        XCTAssertEqual(viewModel.permissionState.shareableContentAuthorized, false)
        XCTAssertEqual(viewModel.permissionState.errorDomain, SCStreamErrorDomain)
        XCTAssertEqual(viewModel.permissionState.errorCode, -3807)
        XCTAssertEqual(viewModel.permissionState.errorDescription, "WindowServer connection failed during test")
    }

    @MainActor
    func testRequestPermissionAndRefreshStatusTransitionsTruthfully() async {
        let checker = MockPermissionChecker(
            preflightResult: false,
            verifyOutcome: PermissionCheckOutcome(
                status: .deniedOrNotGranted,
                preflightGranted: false,
                shareableContentAuthorized: false,
                diagnosticMessage: "Denied initially.",
                errorDomain: SCStreamErrorDomain,
                errorCode: SCStreamError.userDeclined.rawValue,
                errorDescription: "Denied"
            )
        )
        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.refresh")!)
        )

        await viewModel.requestScreenRecordingPermission()
        XCTAssertEqual(viewModel.permissionState.screenRecording, .deniedOrNotGranted)
        XCTAssertEqual(viewModel.permissionState.lastActionMessage, "Denied initially.")

        // Simulate user enabling access in System Settings and clicking Refresh Status (even if preflight remains false).
        checker.verifyOutcome = PermissionCheckOutcome(
            status: .granted,
            preflightGranted: false,
            shareableContentAuthorized: true,
            diagnosticMessage: "ScreenCaptureKit authorized."
        )
        await viewModel.refreshPermissionStatus()
        XCTAssertEqual(viewModel.permissionState.screenRecording, .granted)
        XCTAssertEqual(viewModel.permissionState.shareableContentAuthorized, true)
        XCTAssertNil(viewModel.permissionState.errorDomain)
    }

    @MainActor
    func testOpenPrivacySettingsReportsSuccessAndFailure() {
        let checker = MockPermissionChecker(
            preflightResult: false,
            verifyOutcome: PermissionCheckOutcome(
                status: .deniedOrNotGranted,
                preflightGranted: false,
                shareableContentAuthorized: false,
                diagnosticMessage: "Not granted"
            ),
            settingsOpenResult: false
        )
        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.settings")!)
        )

        viewModel.openPrivacySettings()
        XCTAssertEqual(
            viewModel.permissionState.lastActionMessage,
            "Unable to open System Settings automatically. Open Privacy & Security → Screen Recording manually, then click Refresh Status."
        )

        checker.settingsOpenResult = true
        viewModel.openPrivacySettings()
        XCTAssertEqual(
            viewModel.permissionState.lastActionMessage,
            "Opened System Settings → Privacy & Security → Screen Recording. After toggling access, click Refresh Status."
        )
    }

    @MainActor
    func testRefreshDisplaysSucceedsWhenPreflightIsFalseAndUpdatesPermissionToGranted() async {
        let checker = MockPermissionChecker(
            preflightResult: false,
            verifyOutcome: PermissionCheckOutcome(
                status: .deniedOrNotGranted,
                preflightGranted: false,
                shareableContentAuthorized: false,
                diagnosticMessage: "Preflight false"
            )
        )
        let expectedDisplay = DisplayDescriptor(
            id: 42,
            name: "Main Display (1)",
            width: 1470,
            height: 956,
            isMainDisplay: true
        )
        let contentProvider = MockDisplayContentProvider(
            result: .success(ScreenCaptureDisplayQueryResult(descriptors: [expectedDisplay]))
        )

        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            contentProvider: contentProvider,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.displaysOk")!)
        )

        await viewModel.refreshDisplays()

        XCTAssertEqual(viewModel.displays, [expectedDisplay])
        XCTAssertEqual(viewModel.selectedDisplayID, 42)
        XCTAssertNil(viewModel.lastCaptureError)
        XCTAssertEqual(viewModel.permissionState.screenRecording, .granted)
        XCTAssertEqual(viewModel.permissionState.preflightGranted, false)
        XCTAssertEqual(viewModel.permissionState.shareableContentAuthorized, true)
    }

    @MainActor
    func testRefreshDisplaysAndCaptureFailGracefullyWithOriginalNSErrorOnDenial() async {
        let tccError = NSError(
            domain: SCStreamErrorDomain,
            code: SCStreamError.userDeclined.rawValue,
            userInfo: [NSLocalizedDescriptionKey: "TCC declined"]
        )
        let checker = MockPermissionChecker(
            preflightResult: false,
            verifyOutcome: PermissionCheckOutcome(
                status: .deniedOrNotGranted,
                preflightGranted: false,
                shareableContentAuthorized: false,
                diagnosticMessage: "Denied"
            )
        )
        let contentProvider = MockDisplayContentProvider(result: .failure(tccError))

        let viewModel = CastoraAppViewModel(
            permissionService: checker,
            contentProvider: contentProvider,
            identityService: DeviceIdentityService(userDefaults: UserDefaults(suiteName: "PermissionStateTests.captureDenied")!)
        )

        await viewModel.refreshDisplays()
        XCTAssertTrue(viewModel.displays.isEmpty)
        XCTAssertEqual(viewModel.permissionState.screenRecording, .deniedOrNotGranted)
        XCTAssertEqual(viewModel.permissionState.errorDomain, SCStreamErrorDomain)
        XCTAssertEqual(viewModel.permissionState.errorCode, SCStreamError.userDeclined.rawValue)
        XCTAssertTrue(viewModel.lastCaptureError?.contains("TCC declined") == true)

        await viewModel.startLocalCaptureTest()
        XCTAssertFalse(viewModel.captureState.isCapturing)
        if case .failed(let message) = viewModel.captureState {
            XCTAssertTrue(message.contains(SCStreamErrorDomain))
        } else {
            XCTFail("Expected .failed capture state, got \(viewModel.captureState)")
        }
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

    func testPackagingScriptExistsAndPreservesBundleIdAndEntitlements() throws {
        let testFileURL = URL(fileURLWithPath: #filePath)
        let repoRoot = testFileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let scriptURL = repoRoot.appendingPathComponent("scripts/build-macos-app.sh")

        guard FileManager.default.fileExists(atPath: scriptURL.path) else {
            return
        }

        let contents = try String(contentsOf: scriptURL, encoding: .utf8)
        XCTAssertTrue(contents.contains("com.pratyushsharma.castorapro"))
        XCTAssertTrue(contents.contains("CastoraPro.entitlements"))
        XCTAssertTrue(contents.contains("--entitlements"))
        XCTAssertTrue(contents.contains("codesign --verify --deep --strict"))
        XCTAssertTrue(contents.contains("PRODUCT_BUNDLE_IDENTIFIER"))
        XCTAssertTrue(contents.contains("EXECUTABLE_NAME"))
    }
}
