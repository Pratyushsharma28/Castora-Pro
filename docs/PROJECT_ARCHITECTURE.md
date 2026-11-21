# Castora Pro — Project Architecture

**Phase:** 1 (Architecture & Design)  
**Status Ledger:**
- **Implemented:** Architecture documentation and draft signaling schema (`castora.v1`).
- **Planned:** Native macOS app, native Android/Android TV app, WebRTC media engine, pairing UI, multi-stream grid.
- **Tested:** None yet (no executable native code exists in Phase 1).

---

## 1. Overall Castora Pro Architecture

Castora Pro is designed as a **local-network-first peer-to-peer screen-casting system**. When your Mac, Android phone, and Android TV are on the same Wi-Fi or Ethernet network, they discover each other directly and stream video directly between devices—**no central cloud server is required**.

Castora Pro separates work into three clean layers (planes):

1. **Discovery Plane (mDNS / DNS-SD):**  
   Devices find each other automatically on the local network using Apple **Bonjour** on macOS and **NSD (`NsdManager`)** on Android.
2. **Signaling & Control Plane (Local WebSocket):**  
   Devices exchange lightweight JSON messages (`castora.v1`) over a local WebSocket connection to request pairing, ask the Receiver user for approval, and swap WebRTC connection details.
3. **Media Plane (WebRTC DTLS-SRTP):**  
   Once approved, **WebRTC** sends hardware-encoded screen video directly from Sender to Receiver over encrypted **DTLS-SRTP** channels.

```text
+-----------------------+                        +-------------------------+
|     Sender Device     |                        |     Receiver Device     |
|  (macOS / Android)    |                        | (macOS / Android / TV)  |
+-----------------------+                        +-------------------------+
            |                                                 |
            |-- 1. mDNS Browse (_castora._tcp.local.) ------->|  (Discovery)
            |<- 2. Resolve LAN IP, Port, Name, Platform ------|
            |                                                 |
            |== 3. Open Local WebSocket (ws://ip:port/castora) =>|  (Signaling)
            |-- 4. pair_request (roomId + ephemeralNonce) ---->|
            |<- 5. pair_response (sessionId) ------------------|
            |-- 6. connection_request ------------------------>|
            |                                  [User Approves] |
            |<- 7. connection_accepted (streamId) -------------|
            |-- 8. session_offer / session_answer / ice <----->|
            |                                                  |
            |== 9. WebRTC DTLS-SRTP Video (up to 1080p60) ====>|  (Media Plane)
```

### Why Separate Native Apps Instead of One Shared UI Wrapper?
Screen capture, hardware video encoding, local discovery, and TV remote navigation depend directly on low-level OS frameworks (`ScreenCaptureKit` on macOS, `MediaProjection` on Android). Building native Swift/SwiftUI and Kotlin/Compose apps gives full access to official Apple and Google APIs without wrapper bottlenecks, while sharing one JSON signaling contract (`castora.v1`) keeps both platforms interoperable.

---

## 2. macOS Application Architecture

- **Language & UI:** Swift + SwiftUI (targeting modern macOS supporting `ScreenCaptureKit`, macOS 13+ / 14+ recommended).
- **Modular Structure (Planned `macos/`):**
  - `Discovery/` — Bonjour advertising & browsing using Apple's `Network.framework` (`NWListener` with `NWListener.Service(type: "_castora._tcp")` and `NWBrowser`).
  - `Signaling/` — Local WebSocket server (`NWListener` + `NWProtocolWebSocket`) for Receiver mode and `URLSessionWebSocketTask` (or `NWConnection`) for Sender mode.
  - `Capture/` — `ScreenCaptureKit` (`SCShareableContent` to list displays/windows, `SCContentFilter` to pick what to share, and `SCStream` to receive `CMSampleBuffer` video frames at up to 60 FPS).
  - `Codec & Media/` — `VideoToolbox` hardware H.264 / HEVC compression integrated with `WebRTC.xcframework` (`RTCVideoSource`, `RTCVideoCapturer`, `RTCPeerConnectionFactory`).
  - `Pairing/` — `CoreImage` (`CIQRCodeGenerator`) to display QR codes when acting as Receiver, plus `AVFoundation` camera or screen QR parsing / manual Room Code entry when acting as Sender.
  - `UI/` — SwiftUI Sender control window, Receiver grid/fullscreen stage (`MTLVideoView` / `RTCMTLNSVideoView`), approval sheet, and real-time stats drawer.
- **macOS Permissions:**
  - **Screen Recording:** Checked/requested via macOS TCC (`CGPreflightScreenCaptureAccess()` / `SCShareableContent.excludingDesktopWindows(...)`). If denied, Castora Pro guides the user to *System Settings → Privacy & Security → Screen & System Audio Recording*.
  - **Local Network:** Declared in `Info.plist` (`NSLocalNetworkUsageDescription` and `NSBonjourServices` containing `_castora._tcp`) as required by modern macOS privacy rules.

---

## 3. Android Application Architecture

- **Language & UI:** Kotlin + Jetpack Compose with unidirectional state flow (`ViewModel` + `StateFlow`).
- **Modular Structure (Planned `android/`):**
  - `discovery/` — `NsdManager` registration and service discovery for `_castora._tcp.`.
  - `signaling/` — Lightweight local WebSocket server & client (e.g., Ktor CIO WebSocket server / OkHttp client) implementing `castora.v1`.
  - `capture/` — `MediaProjectionManager` (`createScreenCaptureIntent()`) + `VirtualDisplay` + **Foreground Service** (`ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION`) required by Android 10–15+.
  - `media/` — Official WebRTC Android SDK (`org.webrtc` / Stream WebRTC Android build) configured with `HardwareVideoEncoderFactory` and `HardwareVideoDecoderFactory` backed by Android `MediaCodec`.
  - `pairing/` — QR code generation (ZXing) + CameraX + ML Kit / ZXing QR scanner on phones, plus 6-character Room Code input.
- **Android Permissions & Lifecycle Rules:**
  - `MediaProjection` permission token is granted per session by the user and **cannot be silently reused** across Android 14+ restarts—each new casting session must handle fresh user consent cleanly.
  - `POST_NOTIFICATIONS` (Android 13+) so the active screen-cast foreground notification is visible while casting.
  - `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, and `NEARBY_WIFI_DEVICES` (Android 13+) for local network discovery.

---

## 4. Android TV Support

Android TV runs Android under the hood, but has very different input and viewing ergonomics:

- **10-Foot UI & D-Pad Navigation:**
  - Uses Jetpack Compose for TV (`androidx.tv.material3`) with explicit focus rings, predictable D-Pad directional focus traversal, and `Select` / `Back` remote key handling.
  - Declares `android.intent.category.LEANBACK_LAUNCHER` and `android.hardware.touchscreen` (`required="false"`) in `AndroidManifest.xml` so it installs and appears properly on Android TV / Google TV home screens.
- **Receiver-First Experience on TV:**
  - Because TVs rarely have built-in cameras, an Android TV Receiver displays a **large scannable QR code** and a **high-contrast 6-character Room Code** so a Mac or Android phone can pair in seconds.
  - Incoming `pair_request` prompts render as a D-Pad-friendly modal (`Approve` / `Decline`, defaulting safely so accidental button mashing doesn't auto-accept unknown devices).
- **Android TV as a Sender:**
  - Supported where the TV OS provides `MediaProjection` consent dialogs (some locked-down TV builds restrict `MediaProjection` or lack hardware H.264 encoders—Castora Pro detects capability at runtime and shows a clear error rather than crashing).

---

## 5. WebRTC Media Architecture

- **Encryption:** Every WebRTC stream uses mandatory **DTLS-SRTP** (Datagram Transport Layer Security for key exchange + Secure Real-time Transport Protocol for encrypted media packets).
- **Direct Local Media (ICE Host Candidates):**  
  Because devices sit on the same LAN, WebRTC ICE gathers local **host candidates** (e.g., `192.168.1.x`). `iceServers` defaults to empty (`[]`) on LAN so media never leaves the local network.
- **Resolution & Frame Rate Target:**
  - Target profile: **1920×1080 @ 60 FPS** when hardware encoders/decoders and Wi-Fi bandwidth support it.
  - Hardware encoders (`VideoToolbox` on macOS, `MediaCodec` on Android) keep CPU load and battery drain low.
- **Adaptive Bitrate & Resolution:**
  - WebRTC's built-in **Google Congestion Control (GCC)** monitors packet arrival times and receiver REMB/TWCC feedback.
  - When Wi-Fi degrades, WebRTC dynamically lowers bitrate and scales down resolution or frame rate (`DegradationPreference`), then recovers back toward 1080p60 when the network clears.

---

## 6. Cross-Platform Signaling Protocol (`castora.v1`)

Both platforms exchange UTF-8 JSON frames over a local WebSocket (`ws://<receiver-ip>:<port>/castora`). Every message uses a shared envelope (`protocolVersion`, `messageType`, `messageId`, `senderDeviceId`, `receiverDeviceId`, `roomId`, `timestamp`, `payload`):

| Message Category | Direction | Purpose |
| :--- | :--- | :--- |
| `device_announce` / `device_discover` | LAN / Discovery | Announces device capabilities/port or queries peers by role. |
| `pair_request` / `pair_response` | Sender ↔ Receiver | Exchanges `roomId` and temporary `ephemeralNonce` (`qr`, `room_code`, or `manual_ip`) and assigns `sessionId`. |
| `connection_request` / `connection_accepted` / `connection_rejected` | Sender ↔ Receiver | Triggers explicit Receiver user approval before WebRTC negotiation begins. |
| `session_offer` / `session_answer` / `ice_candidate` | Bidirectional | Exchanges WebRTC SDP and local network ICE candidates. |
| `stream_start` / `stream_stop` / `stream_status` | Bidirectional | Announces stream start/stop and reports layout (`grid`/`fullscreen`) and real `RTCStatsReport` stats. |
| `heartbeat` / `disconnect` / `error` | Bidirectional | Keeps sockets monitored, terminates cleanly, or reports structured errors. |

*(See `docs/SIGNALING_PROTOCOL.md`, `docs/PROTOCOL_IMPLEMENTATION.md`, and `protocol/castora-protocol.schema.json` for exact schemas.)*

---

## 7. Bonjour and Android NSD Discovery

- **Service Type:** `_castora._tcp.` (standardized DNS-SD service name across both Apple Bonjour and Android `NsdManager`).
- **TXT Record Metadata (Non-Sensitive Only):**
  - `v=1` (protocol version)
  - `name=<Display Name>`
  - `platform=macos|android|android-tv`
  - `port=<WebSocket Port>`
  - *(Secrets like `sessionToken` are **never** broadcast over mDNS TXT records.)*
- **Important Android NSD Detail:** Older Android `NsdManager.resolveService()` queues callbacks sequentially (only one resolve at a time) and requires a `WifiManager.MulticastLock` on some devices to receive mDNS multicast packets reliably. Castora Pro serializes NSD resolve calls safely on Android and manages `MulticastLock` only while actively scanning.

---

## 8. QR and Room-Code Pairing

Pairing bridges discovery to authenticated signaling without requiring accounts or cloud logins:

- **QR Code URI Format:**
  ```text
  castora://pair?v=1&ip=192.168.1.42&port=49152&room=K7M9P2&nonce=ephemeral_demo_nonce_0001&name=Living%20Room%20TV
  ```
  Scanning the QR code gives the Sender the Receiver's exact IP, port, room code, and one-time pairing token—working **even if mDNS/Bonjour multicast is blocked** on a restrictive router!
- **Room-Code Pairing:**
  - The Receiver generates a readable **6-character alphanumeric code** (excluding confusing `0/O/1/I`).
  - When a Sender discovers a Receiver via Bonjour/NSD and enters the Room Code (or scans QR), it connects over WebSocket and submits `pair_request`.
  - If mDNS is blocked and the user has no camera, a manual `IP:Port + Room Code` fallback allows direct connection.

---

## 9. Security and Receiver Approval

1. **Temporary Credentials Only:**  
   Each Receiver session generates a fresh 6-character Room Code and a cryptographically random 128-bit `sessionToken` (`SecRandomCopyBytes` on macOS, `SecureRandom` on Android). Credentials expire when the session ends or when the user clicks **Rotate Code**.
2. **Mandatory Receiver Approval:**  
   Even if a Sender supplies the correct Room Code and token, the Receiver always displays an on-screen prompt showing the Sender's `deviceName` and `platform` and waits for the user to click **Approve**.
3. **Encrypted Media:**  
   All video/audio packets are encrypted via **DTLS-SRTP**.
4. **Secure Disconnection:**  
   Either Sender or Receiver can press **Disconnect** at any time. Castora Pro sends `disconnect`, closes the `RTCPeerConnection`, immediately stops `ScreenCaptureKit` / `MediaProjection` (removing the OS screen-recording indicator), and invalidates the peer session.

---

## 10. Multiple Simultaneous Streams

- **One Sender → Multiple Receivers (`1:N`):**  
  The Sender captures the screen **once** into a single WebRTC `VideoSource`/`VideoTrack`, then attaches that track to `N` independent `RTCPeerConnection` objects—one per approved Receiver. Each Receiver adapts bitrate independently based on its own network link without multiplying capture overhead.
- **Multiple Senders → One Receiver (`N:1` Grid & Fullscreen):**  
  The Receiver hosts a single WebSocket signaling server, assigns each approved Sender a unique `peerId` and `streamId` (`stream_01`, `stream_02`, ...), and maintains separate `RTCPeerConnection` pipelines.
  - **Grid View:** Renders active incoming video tracks in an adaptive grid (`1×1`, `2×1`, `2×2`, etc.).
  - **Fullscreen View:** Selecting any tile expands it to fullscreen (`stream_control: focus_fullscreen`) while keeping other streams connected (or signaling background tiles to reduce FPS/resolution to save hardware decoder bandwidth).

---

## 11. Performance Measurement (Real Telemetry Only)

Castora Pro **never** fabricates or estimates FPS, latency, or bitrate. Every number displayed in the stats overlay comes directly from WebRTC's official `RTCStatsReport` API (polled once per second):

- **FPS (Frames Per Second):** `framesPerSecond` from `outbound-rtp` (Sender) / `inbound-rtp` (Receiver).
- **Bitrate (Mbps / kbps):** Calculated from the delta of `bytesSent` or `bytesReceived` divided by the elapsed `timestamp` between two real `RTCStatsReport` snapshots.
- **Round-Trip Time (RTT):** `currentRoundTripTime * 1000` (ms) from the active `candidate-pair` (`nominated == true`).
- **Dropped Frames & Packet Loss:** `framesDropped` + `packetsLost` from `inbound-rtp` / `remote-inbound-rtp`, plus `qualityLimitationReason` (`cpu`, `bandwidth`, `none`).
- **Decode / Jitter Latency:** `jitterBufferDelay / jitterBufferEmittedCount` and `totalDecodeTime / framesDecoded`.

---

## 12. Technical Risks & Platform Limitations

| Risk / Limitation | Impact | Planned Mitigation |
| :--- | :--- | :--- |
| **Wi-Fi AP / Client Isolation** | Guest or campus Wi-Fi routers often block device-to-device mDNS and direct UDP packets. | Document LAN requirements clearly; support manual IP fallback for signaling and detect ICE failure with actionable diagnostics. |
| **macOS Screen Recording Permission UX** | macOS requires restarting or re-authorizing capture after granting Screen Recording in System Settings. | Pre-check `CGPreflightScreenCaptureAccess()` and guide users cleanly before starting a session. |
| **Android 14+ `MediaProjection` Restrictions** | Consent tokens are single-use; starting capture without an active `mediaProjection` Foreground Service throws `SecurityException`. | Start the Foreground Service before creating `VirtualDisplay`, and request fresh consent per session. |
| **Budget Android TV Hardware Decoder Limits** | Many Android TV sticks only support 1–2 simultaneous 1080p60 hardware H.264 decode streams. | Cap concurrent `N:1` streams gracefully based on `MediaCodecList` / user settings and pause/downscale non-focused tiles during fullscreen. |
| **Thermal Throttling at 1080p60** | Prolonged software/hardware encoding on phones can warm the device and reduce clock speeds. | Prefer hardware `MediaCodec` / `VideoToolbox` zero-copy buffers (`Surface` / `CVPixelBuffer`) and let WebRTC adapt bitrate/FPS smoothly. |
