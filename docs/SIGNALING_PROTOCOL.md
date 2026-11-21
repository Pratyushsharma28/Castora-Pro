# Castora Pro — Shared Signaling & Pairing Protocol (`castora.v1`)

> **Status:** **Implemented (Specification, JSON Schema & Automated Fixtures — Phase 2).**  
> Native Swift and Kotlin networking implementations are **Planned** (Phases 5–7).

This specification defines the **interoperable JSON contract** shared by the macOS (Swift), Android (Kotlin), and Android TV (Kotlin) Castora Pro applications. Every message conforms strictly to `protocol/castora-protocol.schema.json` (JSON Schema Draft 2020-12).

---

## 1. Protocol Review Summary (Phase 1 → Phase 2 Improvements)

During Phase 2 review of the Phase 1 draft, the following improvements were made:
1. **Unified 16-Message Catalog:** Replaced the 10-message draft with all 16 explicit lifecycle categories (`device_announce`, `device_discover`, `pair_request`, `pair_response`, `connection_request`, `connection_accepted`, `connection_rejected`, `session_offer`, `session_answer`, `ice_candidate`, `stream_start`, `stream_stop`, `stream_status`, `disconnect`, `error`, `heartbeat`).
2. **Consistent Envelope Naming:** Standardized every envelope field to `protocolVersion` (`"castora.v1"`), `messageType`, `messageId`, `senderDeviceId`, `receiverDeviceId`, `roomId`, `timestamp` (ISO-8601 UTC), and `payload`.
3. **Strict Schema Enforcement:** Added `$defs` reusable types and `additionalProperties: false` across the envelope and all 16 payloads.
4. **Security Hardening:** Separated temporary pairing (`ephemeralNonce`) from explicit Receiver approval (`connection_request` → `connection_accepted` / `connection_rejected`) and removed credential fields from `iceConfig` so permanent secrets are never transmitted in signaling.

---

## 2. Transport, Discovery & QR Pairing URI

- **mDNS / Bonjour Service Type:** `_castora._tcp.`
- **WebSocket Endpoint:** `ws://<receiver-ip>:<port>/castora` (local LAN only)
- **QR Code Pairing URI:**
  ```text
  castora://pair?v=1&ip=192.168.1.42&port=49152&room=K7M9P2&nonce=ephemeral_demo_nonce_0001&name=Living%20Room%20TV
  ```
  *(The `nonce` in QR codes is an ephemeral single-session challenge, rotated whenever the Receiver resets or closes its room.)*

---

## 3. Common Message Envelope

Every signaling frame is a single UTF-8 JSON object:

```json
{
  "protocolVersion": "castora.v1",
  "messageType": "pair_request",
  "messageId": "msg-0003-pair-req",
  "senderDeviceId": "dev-mac-pro-01",
  "receiverDeviceId": "dev-tv-livingroom",
  "roomId": "K7M9P2",
  "timestamp": "2026-11-21T12:20:02.000Z",
  "payload": {}
}
```

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `protocolVersion` | `string` | Yes | Must equal `"castora.v1"`. |
| `messageType` | `enum` | Yes | One of the 16 defined message categories. |
| `messageId` | `string` | Yes | Unique correlation ID (`8–64` chars, `[A-Za-z0-9_-]`). |
| `senderDeviceId` | `string` | Yes | Ephemeral/install-scoped sender ID (`3–64` chars). |
| `receiverDeviceId` | `string \| null` | Yes | `null` for broadcast discovery; non-null `deviceId` for directed messages. |
| `roomId` | `string \| null` | Yes | `null` for broadcast discovery; 6 uppercase alphanumeric chars (`^[A-Z0-9]{6}$`) for room messages. |
| `timestamp` | `string` | Yes | ISO-8601 UTC date-time string (e.g. `2026-11-21T12:20:02.000Z`). |
| `payload` | `object` | Yes | Strictly typed payload matching `messageType`. |

---

## 4. All 16 Signaling Message Categories

### 4.1 Discovery Messages
1. **`device_announce`** *(Sender/Receiver → LAN / Signaling Bus)*  
   Broadcasts device availability (`deviceName`, `platform`, `role`, `wsPort`, `capabilities`). `receiverDeviceId` and `roomId` may be `null`.
2. **`device_discover`** *(Requester → LAN / Discovery Peer)*  
   Requests active devices matching `requestedRole` (`"sender" | "receiver" | "any"`), `requesterPlatform`, and optional `filterPlatform`.

### 4.2 Pairing Messages
3. **`pair_request`** *(Sender → Receiver)*  
   Submits `pairingMethod` (`"qr" | "room_code" | "manual_ip"`), temporary `ephemeralNonce` (min 16 chars, no permanent secrets), `deviceName`, `platform`, and `capabilities`.
4. **`pair_response`** *(Receiver → Sender)*  
   Confirms whether temporary pairing credentials matched (`paired`, `reason`, `receiverName`, `receiverPlatform`, and newly assigned `sessionId` or `null`).

### 4.3 Receiver Approval Messages
5. **`connection_request`** *(Sender → Receiver)*  
   Requests user approval on the Receiver to cast `streamId` within `sessionId`, specifying `senderName`, `senderPlatform`, and `requestedQuality` (`targetWidth`, `targetHeight`, `targetFps`, `preferredCodec`).
6. **`connection_accepted`** *(Receiver → Sender)*  
   Sent only after explicit Receiver user approval. Returns `sessionId`, `streamId`, `assignedSlotIndex` (for multi-stream grid), and `iceConfig` (`iceServers`, normally `[]` on LAN).
7. **`connection_rejected`** *(Receiver → Sender)*  
   Sent if the user declines or capacity is full (`sessionId`, `reasonCode`: `"USER_DECLINED" | "SESSION_FULL" | "CAPABILITY_MISMATCH" | "TIMEOUT"`, `message`).

### 4.4 WebRTC Negotiation Messages (Extensible SDP & ICE)
8. **`session_offer`** *(Sender → Receiver)*  
   Carries WebRTC SDP offer (`sessionId`, `streamId`, `sdpType: "offer"`, `sdp`, plus optional extensible `mediaInfo`: `hasVideo`, `hasAudio`, `codecHint`).
9. **`session_answer`** *(Receiver → Sender)*  
   Carries WebRTC SDP answer (`sessionId`, `streamId`, `sdpType: "answer"`, `sdp`).
10. **`ice_candidate`** *(Bidirectional)*  
    Trickles local network ICE candidates (`sessionId`, `streamId`, `sdpMid`, `sdpMLineIndex`, `candidate`).

### 4.5 Stream Lifecycle & Telemetry Status Messages
11. **`stream_start`** *(Sender → Receiver)*  
    Notifies Receiver that media capture/encoding started (`sessionId`, `streamId`, `width`, `height`, `fps`, `codec`).
12. **`stream_stop`** *(Bidirectional)*  
    Stops a single stream cleanly (`sessionId`, `streamId`, `reason`: `"user_stopped" | "receiver_closed" | "capture_revoked" | "network_lost"`).
13. **`stream_status`** *(Bidirectional)*  
    Reports real stream state (`state`: `"starting" | "active" | "paused" | "degraded"`, `layoutMode`: `"grid" | "fullscreen"`, plus optional `measuredStats` populated strictly from real `RTCStatsReport` counters).

### 4.6 Session Control, Heartbeat & Error Messages
14. **`disconnect`** *(Bidirectional)*  
    Graceful session teardown (`sessionId`, `streamId`, `reason`).
15. **`error`** *(Bidirectional)*  
    Structured failure reporting (`code`, `message`, `recoverable`, `relatedMessageId`).  
    Standard codes: `UNSUPPORTED_VERSION`, `INVALID_MESSAGE`, `INVALID_NONCE`, `INVALID_ROOM_ID`, `APPROVAL_DECLINED`, `SESSION_FULL`, `CAPTURE_PERMISSION_DENIED`, `WEBRTC_NEGOTIATION_FAILED`, `INTERNAL_ERROR`.
16. **`heartbeat`** *(Bidirectional)*  
    Periodic keepalive (`sequence` integer >= 0, `role`: `"sender" | "receiver"`) to detect dropped Wi-Fi sockets promptly.
