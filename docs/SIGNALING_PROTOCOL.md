# Castora — Shared Signaling & Pairing Protocol (`castora.v1`)

This specification defines the **interoperable JSON protocol** used by both **macOS (Swift)** and **Android / Android TV (Kotlin)** over a local WebSocket connection.

Every message conforms to the machine-readable schema in `protocol/castora-protocol.schema.json`.

---

## 1. Transport & Discovery

- **mDNS / Bonjour Service Type:** `_castora._tcp.`
- **TXT Record Keys:**
  - `v`: `"1"` (protocol version)
  - `name`: Human-readable receiver name (UTF-8, max 48 chars)
  - `platform`: `"macos"` | `"android"` | `"android-tv"`
  - `port`: WebSocket port (e.g., `"8443"` or ephemeral available port)
  - `room`: Current active 6-character room code (optional if receiver hides room code until QR/screen view)
- **WebSocket Endpoint:** `ws://<receiver-ip>:<port>/castora` (local LAN only)

---

## 2. QR Code URI Format

When a Receiver displays a QR code for pairing, it encodes the following URI:

```text
castora://pair?v=1&ip=192.168.1.42&port=49152&room=K7M9P2&token=x9F3aL8qR2mV7nP4&name=Living%20Room%20TV
```

| Parameter | Required | Description |
| :--- | :--- | :--- |
| `v` | Yes | Protocol version (`1`). |
| `ip` | Yes | Receiver's reachable LAN IPv4 address. |
| `port` | Yes | Receiver's local WebSocket listening port. |
| `room` | Yes | 6-character temporary room code. |
| `token` | Yes | Temporary base64url session token (minimum 16 chars). |
| `name` | No | URL-encoded friendly name of the Receiver. |

---

## 3. Envelope Format

Every WebSocket text frame is a single JSON object with a consistent top-level envelope:

```json
{
  "version": "1.0",
  "type": "pair_request",
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "timestampMs": 1795176000000,
  "sessionId": "sess_k7m9p2",
  "senderPeerId": "peer_mac_01",
  "targetPeerId": "peer_tv_01",
  "payload": {}
}
```

### Envelope Fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `version` | `string` | Yes | Must be `"1.0"`. |
| `type` | `enum` | Yes | One of: `pair_request`, `pair_approval`, `sdp_offer`, `sdp_answer`, `ice_candidate`, `stream_control`, `ping`, `pong`, `disconnect`, `error`. |
| `messageId` | `string` | Yes | Unique UUID v4 per message for correlation & logging. |
| `timestampMs` | `integer` | Yes | Unix epoch milliseconds from sender clock. |
| `sessionId` | `string` | No | Active Castora session identifier assigned by Receiver upon approval. |
| `senderPeerId` | `string` | Yes | Stable ephemeral peer ID for the current app run. |
| `targetPeerId` | `string` | No | Intended recipient peer ID (required once paired in 1:N / N:1 sessions). |
| `payload` | `object` | Yes | Type-specific payload object. |

---

## 4. Message Types & Payloads

### 4.1 `pair_request` (Sender → Receiver)
Sent immediately after the WebSocket opens to present temporary pairing credentials and device identity.

```json
{
  "version": "1.0",
  "type": "pair_request",
  "messageId": "a1b2c3d4-0001-4000-8000-000000000001",
  "timestampMs": 1795176000100,
  "senderPeerId": "peer_mac_01",
  "payload": {
    "roomCode": "K7M9P2",
    "sessionToken": "x9F3aL8qR2mV7nP4",
    "deviceName": "Pratyush's MacBook Pro",
    "platform": "macos",
    "role": "sender",
    "capabilities": {
      "maxWidth": 1920,
      "maxHeight": 1080,
      "maxFps": 60,
      "codecs": ["H264", "HEVC"],
      "supportsAudio": true
    }
  }
}
```

### 4.2 `pair_approval` (Receiver → Sender)
Sent after validating `roomCode` + `sessionToken` and receiving explicit user approval on the Receiver UI.

```json
{
  "version": "1.0",
  "type": "pair_approval",
  "messageId": "a1b2c3d4-0002-4000-8000-000000000002",
  "timestampMs": 1795176002400,
  "sessionId": "sess_k7m9p2",
  "senderPeerId": "peer_tv_01",
  "targetPeerId": "peer_mac_01",
  "payload": {
    "approved": true,
    "reason": null,
    "receiverName": "Living Room Android TV",
    "receiverPlatform": "android-tv",
    "assignedStreamId": "stream_01",
    "iceConfig": {
      "iceServers": []
    }
  }
}
```

*If rejected (`"approved": false`), `reason` explains why (e.g., `"user_declined"`, `"invalid_credentials"`, `"max_senders_reached"`), and the Receiver closes the WebSocket cleanly.*

### 4.3 `sdp_offer` & `sdp_answer` (Bidirectional)
Exchanges WebRTC Session Description Protocol strings for negotiating DTLS-SRTP fingerprints and codecs.

```json
{
  "version": "1.0",
  "type": "sdp_offer",
  "messageId": "a1b2c3d4-0003-4000-8000-000000000003",
  "timestampMs": 1795176002600,
  "sessionId": "sess_k7m9p2",
  "senderPeerId": "peer_mac_01",
  "targetPeerId": "peer_tv_01",
  "payload": {
    "streamId": "stream_01",
    "sdp": "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n..."
  }
}
```

`sdp_answer` uses the identical payload shape (`streamId`, `sdp`).

### 4.4 `ice_candidate` (Bidirectional)
Trickle ICE candidates discovered on local network interfaces.

```json
{
  "version": "1.0",
  "type": "ice_candidate",
  "messageId": "a1b2c3d4-0004-4000-8000-000000000004",
  "timestampMs": 1795176002700,
  "sessionId": "sess_k7m9p2",
  "senderPeerId": "peer_mac_01",
  "targetPeerId": "peer_tv_01",
  "payload": {
    "streamId": "stream_01",
    "sdpMid": "0",
    "sdpMLineIndex": 0,
    "candidate": "candidate:842163049 1 udp 1677729535 192.168.1.25 54321 typ host"
  }
}
```

### 4.5 `stream_control` (Bidirectional)
Signals non-SDP session state changes (e.g., receiver enters fullscreen on `stream_01` or requests bitrate/resolution hint for background grid tiles).

```json
{
  "version": "1.0",
  "type": "stream_control",
  "messageId": "a1b2c3d4-0005-4000-8000-000000000005",
  "timestampMs": 1795176010000,
  "sessionId": "sess_k7m9p2",
  "senderPeerId": "peer_tv_01",
  "targetPeerId": "peer_mac_01",
  "payload": {
    "streamId": "stream_01",
    "action": "focus_fullscreen",
    "targetMaxWidth": 1920,
    "targetMaxHeight": 1080,
    "targetMaxFps": 60
  }
}
```

Allowed `action` values: `"start"`, `"pause"`, `"resume"`, `"focus_fullscreen"`, `"return_to_grid"`, `"stop"`.

### 4.6 `ping` / `pong` (Bidirectional)
Application-level heartbeat every 5 seconds to detect dead Wi-Fi sockets cleanly before ICE times out.

```json
{
  "version": "1.0",
  "type": "ping",
  "messageId": "a1b2c3d4-0006-4000-8000-000000000006",
  "timestampMs": 1795176015000,
  "sessionId": "sess_k7m9p2",
  "senderPeerId": "peer_mac_01",
  "targetPeerId": "peer_tv_01",
  "payload": {}
}
```

### 4.7 `disconnect` (Bidirectional)
Graceful, authenticated teardown of a single stream or entire session.

```json
{
  "version": "1.0",
  "type": "disconnect",
  "messageId": "a1b2c3d4-0007-4000-8000-000000000007",
  "timestampMs": 1795176060000,
  "sessionId": "sess_k7m9p2",
  "senderPeerId": "peer_mac_01",
  "targetPeerId": "peer_tv_01",
  "payload": {
    "streamId": "stream_01",
    "reason": "user_stopped_casting"
  }
}
```

### 4.8 `error` (Bidirectional)
Structured protocol or runtime error reporting.

```json
{
  "version": "1.0",
  "type": "error",
  "messageId": "a1b2c3d4-0008-4000-8000-000000000008",
  "timestampMs": 1795176000500,
  "senderPeerId": "peer_tv_01",
  "targetPeerId": "peer_mac_01",
  "payload": {
    "code": "INVALID_TOKEN",
    "message": "The temporary pairing token has expired or does not match.",
    "recoverable": false
  }
}
```

Standard error codes:
- `UNSUPPORTED_VERSION`
- `INVALID_MESSAGE`
- `INVALID_TOKEN`
- `INVALID_ROOM_CODE`
- `APPROVAL_DECLINED`
- `SESSION_FULL`
- `CAPTURE_PERMISSION_DENIED`
- `WEBRTC_NEGOTIATION_FAILED`
