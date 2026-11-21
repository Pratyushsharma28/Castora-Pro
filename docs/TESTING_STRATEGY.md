# Castora — Testing Strategy

> **Current Testing Status:** **Not Yet Tested.**  
> Castora is in Phase 1 (documentation only). No unit tests, integration tests, or device tests have been executed yet, and no test results are claimed below.

This document defines how every layer of Castora will be tested as Phases 2–15 are implemented.

---

## 1. Unit Tests
Run locally on every commit without requiring two physical devices.
- **macOS (`XCTest`):**
  - JSON encoding/decoding of all `castora.v1` signaling envelopes (`pair_request`, `pair_approval`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `stream_control`, `disconnect`, `error`).
  - `castora://pair` URI parsing and validation (reject missing `token`, invalid port, malformed room code).
  - Room code & 128-bit `sessionToken` generator entropy/format checks and expiry logic.
  - `RTCStatsReport` delta calculator (bytes → kbps/Mbps, RTT conversion) tested against captured sample snapshots.
- **Android (`JUnit 5` / `kotlinx.coroutines.test`):**
  - Identical `castora.v1` JSON contract tests using the shared fixtures from Phase 2 (`protocol/`).
  - ViewModel state machine transitions (`Idle → Discovering → AwaitingApproval → Streaming → Disconnected`).
  - Concurrent NSD resolve queue behavior under mocked `NsdManager` callbacks.

---

## 2. Integration Tests
Test real subsystem boundaries before full UI/media integration.
- **Signaling Contract Loopback:** Connect a real Swift WebSocket client to a real Kotlin WebSocket server (and vice versa) on the same LAN to verify serialization parity.
- **mDNS Discovery Verification:** Confirm `_castora._tcp.` registered by `NWListener` is resolved by `NsdManager` (and vice versa) with matching IP, port, and TXT metadata.
- **WebRTC Loopback PeerConnection:** Establish two local `RTCPeerConnection` instances exchanging SDP and host ICE candidates and verify `RTCIceConnectionState == connected` and DTLS handshake completion.

---

## 3. macOS Testing
- **Target Matrix:** Apple Silicon and Intel Macs (where available) running supported macOS versions.
- **Checks:**
  - Fresh install Screen Recording permission prompt (`CGPreflightScreenCaptureAccess`) and graceful guidance if denied or revoked mid-session.
  - Local Network permission dialog (`NSLocalNetworkUsageDescription`) and Bonjour browsing behavior.
  - Capturing full display vs single application window via `ScreenCaptureKit`, including HiDPI Retina scaling down to 1080p60 output.
  - Multi-monitor switching and clean `SCStream` teardown (verifying macOS menu bar screen-recording indicator disappears immediately on disconnect).

---

## 4. Android Phone Testing
- **Target Matrix:** Physical Android phones across Android 12–15+ (to catch Android 14/15 `ForegroundService` & `MediaProjection` rules).
- **Checks:**
  - `MediaProjection` consent dialog accept/cancel handling and single-use token behavior when restarting a cast.
  - Foreground service persistent notification visibility and clean stop action from the notification shade.
  - CameraX QR scanner accuracy under low/bright room lighting and screen glare (scanning a TV QR code).
  - Orientation rotation (portrait ↔ landscape) while streaming to macOS or Android TV.

---

## 5. Android TV Testing
- **Target Matrix:** Physical Android TV / Google TV device (plus Android TV emulator for layout checks).
- **Checks:**
  - Leanback launcher icon visibility and cold-start launch time.
  - 100% D-Pad remote navigation (`Up/Down/Left/Right/Select/Back`) with zero unreachable buttons or trapped focus.
  - 10-foot legibility of the QR code, 6-character Room Code, and incoming approval dialog from across a room.
  - Fullscreen toggle and multi-stream grid focus switching using only the TV remote.
  - Hardware `MediaCodec` capability checks (ensuring graceful error handling if a TV device restricts `MediaProjection` when acting as Sender, or reaches max concurrent hardware decoders in `N:1` grid mode).

---

## 6. Cross-Platform Testing Matrix
All 4 core device combinations must pass end-to-end on real Wi-Fi/Ethernet:

| Pair | Pairing Method Tested | Approval & Disconnect | Grid / Fullscreen |
| :--- | :--- | :--- | :--- |
| **macOS → macOS** | Bonjour + Room Code & QR | Approve, Decline, Stop from either side | Single + Multi-sender grid |
| **macOS → Android TV** | Bonjour + TV QR / Room Code | TV D-Pad Approve/Decline, Stop from either side | Grid + Fullscreen via remote |
| **Android Phone → macOS** | NSD + Phone Camera QR Scan & Room Code | Mac Approve/Decline, Phone notification Stop | Portrait/Landscape in Mac grid |
| **Android TV → macOS** | NSD + Room Code (or manual IP) | Mac Approve/Decline, TV remote Stop | Fullscreen on Mac Receiver |

*(Plus `1:N` Mac/Phone → Mac + Android TV simultaneously, and `N:1` Mac + Phone → Mac/TV grid simultaneously.)*

---

## 7. Network Interruption Testing
- **Sender or Receiver Wi-Fi Toggle:** Turn Wi-Fi off for 3 seconds and back on, or turn off completely; verify `ping`/`pong` and ICE state transitions detect the loss and clean up without frozen frames or ghost sessions.
- **mDNS / Bonjour Blocked Network:** Simulate a router blocking multicast by testing direct `castora://pair` QR scan and manual `IP:Port` connection.
- **Packet Loss & Bandwidth Cap:** Use macOS **Network Link Conditioner** (e.g., 2% packet loss, 5 Mbps cap) to verify WebRTC GCC lowers bitrate/FPS smoothly rather than stalling, and recovers when normal Wi-Fi returns.
- **Receiver Sleep / App Backgrounding:** Put Android phone to sleep or sleep Mac mid-cast and confirm clean teardown.

---

## 8. Performance Testing
All measurements must come exclusively from live `RTCStatsReport` logs and platform profilers (Xcode Instruments / Android Studio Profiler):
- **Targets Tested:** `720p30`, `1080p30`, and `1080p60` under normal LAN conditions (5 GHz Wi-Fi / Ethernet).
- **Metrics Recorded (Real Values Only):**
  - Sustained Send & Receive FPS (`framesPerSecond`)
  - Bitrate stability (Mbps)
  - Round-Trip Time (`currentRoundTripTime` in ms)
  - Dropped frames (`framesDropped`) and packet loss (`packetsLost`)
  - Glass-to-glass latency test (pointing a physical phone camera at a stopwatch running on the Sender screen next to the Receiver screen)
  - CPU, memory, and thermal trend over a 15-minute continuous session (plus `1:N` with 2–3 receivers and `N:1` with 2–4 senders).

---

## 9. Final Release Testing (Phase 15 Gate)
Before tagging a release:
1. Clean install on freshly wiped/unpaired macOS, Android phone, and Android TV builds (no cached permissions).
2. Verify all 4 cross-platform pairs + `1:N` + `N:1` + fullscreen + QR/Room Code + receiver approval + disconnect.
3. Verify `.gitignore` excludes all build artifacts, local properties, and signing secrets.
4. Audit UI & logs to confirm **zero fake devices, zero fake connections, and zero synthetic FPS/latency metrics**.
5. Run final release builds (`xcodebuild` Release archive / `./gradlew assembleRelease` or bundle) and record actual test results with device models, OS versions, and commit hash.
