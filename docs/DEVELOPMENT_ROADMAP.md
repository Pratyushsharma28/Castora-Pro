# Castora Pro — 15-Phase Development Roadmap

This roadmap breaks Castora Pro into **15 small, testable phases**. We do not skip ahead until the current phase builds and passes its verification checks.

---

## Status Legend
- **Implemented:** Phase 1 core documentation and Phase 2 `castora.v1` signaling protocol, Draft 2020-12 JSON Schema, 37 fixtures, and automated `npm run test:protocol` validator.
- **Planned:** Phases 3 through 15 (native macOS, Android, Android TV apps, and WebRTC streaming).
- **Tested:** Protocol schema validation (`npm run test:protocol`) passes; native builds and streaming remain **Not Yet Tested**.

---

## Dependency Overview

```text
Phase 1 (Docs & Architecture)
  ├──► Phase 2 (Protocol Spec & JSON Test Fixtures)
  │       ├──► Phase 5 (Bonjour + Android NSD Discovery) ◄── Phases 3 & 4
  │       │       └──► Phase 6 (WebSocket Signaling Interop)
  │       │               └──► Phase 7 (QR / Room-Code Pairing & Approval)
  ├──► Phase 3 (macOS Bootstrap)
  │       └──► Phase 8 (macOS ScreenCaptureKit + VideoToolbox)
  └──► Phase 4 (Android & TV Bootstrap)
          └──► Phase 9 (Android MediaProjection + MediaCodec)

Phases 7 + 8 + 9 ──► Phase 10 (WebRTC 1:1 Media + DTLS-SRTP + Adaptive Bitrate)
                        └──► Phase 11 (Real RTCStatsReport Telemetry)
                                └──► Phase 12 (Cross-Platform 1:1 Matrix Verification)
                                        ├──► Phase 13 (1:N Multi-Receiver Broadcast)
                                        └──► Phase 14 (N:1 Multi-Sender Grid & Fullscreen)
                                                └──► Phase 15 (Resilience, Hardening & Release)
```

---

## All 15 Development Phases

### Phase 1: Repository Inspection & Core Documentation *(Completed — Implemented)*
- **Depends on:** None
- **Goal:** Inspect the empty repository, define the system architecture, 15-phase roadmap, testing strategy, and `.gitignore`.
- **Deliverables:** `README.md`, `.gitignore`, `docs/PROJECT_ARCHITECTURE.md`, `docs/DEVELOPMENT_ROADMAP.md`, `docs/TESTING_STRATEGY.md`.
- **Exit Gate:** All Phase 1 files reviewed, valid, and committed to GitHub.

### Phase 2: Shared Signaling Protocol (`castora.v1`) & Test Fixtures *(Current — Implemented & Validated)*
- **Depends on:** Phase 1
- **Goal:** Finalize the 16-message `castora.v1` JSON signaling contract, strict Draft 2020-12 JSON Schema (`protocol/castora-protocol.schema.json`), shared valid/invalid fixtures (`protocol/fixtures/`), automated `npm run test:protocol` validator (`scripts/validate-protocol.mjs`), and Swift/Kotlin guide (`docs/PROTOCOL_IMPLEMENTATION.md`).
- **Exit Gate:** `npm run test:protocol` passes all 16 valid fixtures and rejects all 21 invalid fixtures for their intended reasons.

### Phase 3: Native macOS Project Bootstrap & Permissions Shell *(Planned)*
- **Depends on:** Phase 1
- **Goal:** Create the Xcode SwiftUI project (`macos/`), configure `Info.plist` (`NSLocalNetworkUsageDescription`, `NSBonjourServices`), entitlements, and Screen Recording permission preflight UI.
- **Exit Gate:** macOS app compiles in Xcode, launches cleanly, and accurately detects Screen Recording permission status.

### Phase 4: Native Android & Android TV Project Bootstrap & Permissions Shell *(Planned)*
- **Depends on:** Phase 1
- **Goal:** Create the Kotlin / Jetpack Compose project (`android/`) supporting both Phone touch layouts and Android TV Leanback/D-Pad focus navigation, with runtime permission prompts.
- **Exit Gate:** App compiles in Android Studio and runs cleanly on both an Android phone emulator/device and an Android TV emulator/device.

### Phase 5: Local Network Discovery — Bonjour (macOS) & NSD (Android) *(Planned)*
- **Depends on:** Phases 2, 3, 4
- **Goal:** Implement `_castora._tcp.` mDNS service advertising and browsing via `Network.framework` (`NWListener` / `NWBrowser`) on macOS and `NsdManager` (with safe resolve queueing and `MulticastLock`) on Android.
- **Exit Gate:** A macOS app and an Android/Android TV app on the same Wi-Fi discover each other's name, platform, and port in real time.

### Phase 6: Local WebSocket Signaling & Handshake Interop *(Planned)*
- **Depends on:** Phases 2, 5
- **Goal:** Implement local WebSocket servers and clients on both platforms using `castora.v1` JSON models (`Codable` in Swift, `kotlinx.serialization` in Kotlin), including `ping`/`pong` heartbeats and structured `error` responses.
- **Exit Gate:** macOS and Android exchange valid `castora.v1` JSON envelopes over LAN WebSockets with zero decoding mismatches.

### Phase 7: QR-Code & Room-Code Pairing + Receiver Approval *(Planned)*
- **Depends on:** Phase 6
- **Goal:** Implement temporary 6-character room codes, 128-bit session tokens, `castora://pair` QR generation/scanning, manual IP fallback, and mandatory Receiver approval/rejection UI (mouse on macOS, D-Pad on Android TV).
- **Exit Gate:** Unauthorized tokens are rejected; valid pairing pauses for user approval and proceeds only when approved; disconnect revokes session credentials.

### Phase 8: macOS Screen Capture (`ScreenCaptureKit`) & Hardware Pipeline (`VideoToolbox`) *(Planned)*
- **Depends on:** Phase 3
- **Goal:** Capture display or window frames with `ScreenCaptureKit` (`SCStream`) up to 1080p60 and verify hardware-accelerated frame delivery into a local preview/encoder pipeline (`VideoToolbox`).
- **Exit Gate:** macOS captures a selected screen/window cleanly, handles permission denial without crashing, and releases `SCStream` on stop.

### Phase 9: Android & Android TV Screen Capture (`MediaProjection`) & Hardware Pipeline (`MediaCodec`) *(Planned)*
- **Depends on:** Phase 4
- **Goal:** Implement `MediaProjectionManager` consent flow, Android 14+ `mediaProjection` Foreground Service, `VirtualDisplay`, and `MediaCodec` hardware capability detection.
- **Exit Gate:** Android phone (and capable Android TV) starts and stops screen capture cleanly with proper foreground notification lifecycle.

### Phase 10: WebRTC 1:1 Media Transport, DTLS-SRTP & Adaptive Bitrate *(Planned)*
- **Depends on:** Phases 7, 8, 9
- **Goal:** Integrate `WebRTC.xcframework` (macOS) and `org.webrtc` (Android), wire SDP offer/answer + LAN host ICE trickle over Phase 6 signaling, verify DTLS-SRTP encryption, and configure GCC adaptive bitrate/resolution targeting up to 1080p60.
- **Exit Gate:** A real 1:1 WebRTC video stream connects over LAN, renders smoothly on the Receiver, and stops cleanly from either side.

### Phase 11: Real Telemetry & Performance Measurement (`RTCStatsReport`) *(Planned)*
- **Depends on:** Phase 10
- **Goal:** Query real WebRTC `RTCStatsReport` snapshots once per second on Sender and Receiver to display true FPS, bitrate, RTT, dropped frames, packet loss, and decode/jitter latency.
- **Exit Gate:** All stats update live from real `RTCStatsReport` counters and drop to zero / disconnect state when streaming stops (zero fake numbers).

### Phase 12: Cross-Platform 1:1 Matrix Verification *(Planned)*
- **Depends on:** Phases 10, 11
- **Goal:** Verify and tune all four required 1:1 platform pairs on real hardware:
  1. macOS → macOS
  2. macOS → Android TV
  3. Android phone → macOS
  4. Android TV → macOS
- **Exit Gate:** All 4 pairs pair via QR/Room Code, get Receiver approval, stream cleanly with real telemetry, and disconnect cleanly.

### Phase 13: Multi-Receiver Broadcasting (1 Sender → Multiple Receivers) *(Planned)*
- **Depends on:** Phase 12
- **Goal:** Refactor Sender media pipeline to share a single `ScreenCaptureKit` / `MediaProjection` `VideoTrack` across multiple independent `RTCPeerConnection`s (`1:N`), with per-receiver approval and independent bitrate adaptation.
- **Exit Gate:** One Mac or Android Sender streams simultaneously to 2+ Receivers (e.g., macOS + Android TV) without duplicating screen capture.

### Phase 14: Multi-Sender Grid View & Fullscreen Switching (Multiple Senders → 1 Receiver) *(Planned)*
- **Depends on:** Phase 12
- **Goal:** Enable Receivers (macOS and Android TV) to accept multiple approved Senders concurrently (`N:1`), render them in an adaptive multi-screen grid, and toggle fullscreen per stream (`stream_control`) with D-Pad and desktop controls.
- **Exit Gate:** 2+ Senders appear simultaneously in the Receiver grid; selecting any tile switches to fullscreen and returns to grid cleanly.

### Phase 15: Network Resilience, Edge-Case Hardening & Release Readiness *(Planned)*
- **Depends on:** Phases 13, 14
- **Goal:** Handle mid-stream Wi-Fi drops, sleep/wake transitions, permission revocations, decoder limits, memory leak checks, and complete final release verification across all devices.
- **Exit Gate:** Full `docs/TESTING_STRATEGY.md` release checklist passes on real hardware with reproducible build instructions.
