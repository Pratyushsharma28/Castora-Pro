# Castora Pro — Native macOS App (`apps/macos/`)

This folder contains the Phase 3 native macOS application foundation for **Castora Pro**, built with **Swift**, **SwiftUI**, **ScreenCaptureKit**, and **VideoToolbox**.

> **Honest Status:** All Phase 3 Swift source files, resources, and `XCTest` unit tests are implemented, but **have not yet been compiled or run on macOS** because the workspace container runs Linux without Xcode. Follow the steps below on your Mac to build, test, and verify Screen Recording permission + `ScreenCaptureKit`.

---

## Requirements

- **macOS 13.0 (Ventura) or newer** (required by `ScreenCaptureKit`)
- **Xcode 15.0 or newer** (includes Swift 5.9+ and macOS SDK)
- Physical Mac or macOS desktop session (Screen Recording TCC grants and `SCShareableContent` require an active WindowServer session)

---

## Folder Structure

```text
apps/macos/
├── Package.swift                                      # SwiftPM manifest (macOS 13+, executable + tests)
├── README.md                                          # This macOS setup & verification guide
├── CastoraPro/
│   ├── App/CastoraProApp.swift                        # @main SwiftUI window entry point
│   ├── Models/
│   │   ├── SignalingProtocol.swift                    # Exact castora.v1 Codable models (16 message types)
│   │   ├── PermissionModels.swift                     # Real Screen Recording status & diagnostics
│   │   ├── CaptureModels.swift                        # Display descriptors, presets, SC states & errors
│   │   └── NavigationModels.swift                     # Sidebar sections & Phase 3 transport status
│   ├── Permissions/
│   │   └── ScreenRecordingPermissionService.swift     # CGPreflight/CGRequest + System Settings deep link
│   ├── Services/
│   │   ├── ProtocolCodecService.swift                 # ISO-8601 + version/type-safe castora.v1 JSON codec
│   │   └── DeviceIdentityService.swift                # Ephemeral device ID + friendly device name
│   ├── Capture/
│   │   └── ScreenCaptureService.swift                 # ScreenCaptureKit enumeration/capture + VideoToolbox probe
│   ├── Networking/
│   │   └── SignalingTransport.swift                   # Phase 5/6 Bonjour (_castora._tcp) & WebSocket contracts
│   ├── ViewModels/
│   │   └── CastoraAppViewModel.swift                  # @MainActor state coordinator (zero fake metrics)
│   ├── Views/
│   │   ├── RootNavigationView.swift                   # Resizable SplitView dark shell
│   │   ├── DashboardView.swift                        # Readiness overview & honest phase status
│   │   ├── CastScreenView.swift                       # Display picker, presets & local SCStream test
│   │   ├── ReceiveScreenView.swift                    # Phase 7/10/14 receiver stage & multi-grid placeholder
│   │   ├── NearbyDevicesView.swift                    # Phase 5 Bonjour discovery placeholder (no fake peers)
│   │   ├── ConnectionStatusView.swift                 # Protocol/transport readiness (no fake sessions)
│   │   ├── SettingsView.swift                         # Device name, defaults, VideoToolbox capability check
│   │   └── Components/Theme.swift                     # Dark theme tokens, cards, and permission banner
│   └── Resources/
│       ├── Info.plist                                 # NSLocalNetworkUsageDescription & _castora._tcp Bonjour
│       ├── CastoraPro.entitlements                    # App sandbox, network client/server, local capture entitlements
│       └── Assets.xcassets/                           # Accent color & AppIcon asset catalog
└── Tests/
    └── CastoraProTests/
        ├── ProtocolModelTests.swift                   # Verifies all 16 castora.v1 fixtures & null preservation
        └── PermissionStateTests.swift                 # Verifies permission denial & even-dimension presets
```

---

## Option A: Build & Run Unit Tests via Terminal (SwiftPM)

From the repository root on your Mac:

```bash
cd apps/macos
swift test
```

What this verifies:
- `ProtocolModelTests`: Decodes and round-trips all 16 `castora.v1` message types, checks all 16 JSON files in `protocol/fixtures/valid/` when present on disk, verifies explicit `null` encoding (`receiverDeviceId`, `roomId`, `sdpMid`), and verifies rejection of unsupported protocol versions or unknown message types.
- `PermissionStateTests`: Verifies `CastoraAppViewModel` never pretends Screen Recording permission is granted when denied, handles Privacy Settings navigation, fails gracefully when capture is attempted without permission, and rounds VideoToolbox target dimensions to even integers.

You can also build and sign `apps/macos/.build/CastoraPro.app` with embedded entitlements (`CastoraPro.entitlements`) and bundle ID `com.pratyushsharma.castorapro` using the repeatable packaging script:

```bash
./scripts/build-macos-app.sh
open "apps/macos/.build/CastoraPro.app"
```

By default, `scripts/build-macos-app.sh` uses local ad-hoc signing (`-`). For stable TCC Screen Recording identity across rebuilds or distribution, pass an Apple Development certificate:

```bash
CODESIGN_IDENTITY="Apple Development: Your Name (TEAMID)" ./scripts/build-macos-app.sh
```

> **Note on TCC & `CGPreflightScreenCaptureAccess()`:** On macOS with ad-hoc builds, `CGPreflightScreenCaptureAccess()` can return `false` even when ScreenCaptureKit access is authorized. Castora Pro keeps `CGPreflightScreenCaptureAccess()` purely as diagnostic info and verifies real access directly through `SCShareableContent`.

---

## Option B: Open & Run as a Proper `.app` Bundle in Xcode (Recommended)

1. Open **Xcode → File → New → Project → macOS → App**:
   - Product Name: `CastoraPro`
   - Interface: `SwiftUI`
   - Language: `Swift`
   - Minimum Deployment: `macOS 13.0`
2. Add or reference the Swift source folders (`App`, `Models`, `Permissions`, `Services`, `Capture`, `Networking`, `ViewModels`, `Views`) and `Resources/` (`Info.plist`, `CastoraPro.entitlements`, `Assets.xcassets`) from `apps/macos/CastoraPro/`.
3. In the target's **Build Settings**:
   - Set **Info.plist File** (`INFOPLIST_FILE`) to `CastoraPro/Resources/Info.plist`.
   - Set **Code Signing Entitlements** (`CODE_SIGN_ENTITLEMENTS`) to `CastoraPro/Resources/CastoraPro.entitlements`.
4. In **Signing & Capabilities**:
   - Select your Apple Development team so TCC remembers your app's code signature across rebuilds.
5. In **Frameworks, Libraries, and Embedded Content**, ensure these Apple system frameworks are linked:
   - `ScreenCaptureKit.framework`
   - `VideoToolbox.framework`
   - `CoreMedia.framework`
   - `CoreVideo.framework`
6. Press **⌘R** to build and run the app, or **⌘U** to run `CastoraProTests`.

---

## Manual Verification Checklist on Your Mac

1. **Initial Denied Permission State:**
   - Launch `CastoraPro` before granting Screen Recording permission.
   - Confirm the status badge shows **Not Granted**, explains why Screen Recording access is needed, and does **not** list fake displays or fake FPS.
2. **Privacy Settings & Prompt Flow:**
   - Click **Request Permission** or **Open System Settings**.
   - Confirm macOS opens **System Settings → Privacy & Security → Screen Recording**.
   - Toggle **Castora Pro** ON, return to the app, and click **Refresh Status**.
   - Confirm status updates to **Granted** (macOS may prompt you to quit and reopen the app on first grant).
3. **ScreenCaptureKit Local Capture Test:**
   - Open **Cast Screen**, click **Refresh Displays**, and confirm your real Mac display(s) and resolution appear.
   - Click **Start Local Capture Test** and watch **Delivered Frames** increment from real `SCStreamOutput` `.complete` frame callbacks.
   - Click **Stop Capture** and verify the state cleanly returns to **Idle**.
4. **Permission Revocation Test:**
   - Disable Screen Recording for Castora Pro in System Settings while stopped (or mid-session) and verify the app handles denial gracefully without crashing.
