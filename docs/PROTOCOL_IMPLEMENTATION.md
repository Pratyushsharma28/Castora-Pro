# Castora Pro — Cross-Platform Protocol Implementation Guide (`castora.v1`)

> **Status:** **Documentation & Reference Examples Only (Phase 2).**  
> Native Swift (`macos/`) and Kotlin (`android/`) projects are not created yet (planned for Phases 3–4). This guide defines the exact patterns both apps will use so they decode and encode identical JSON.

---

## 1. Design Goal: One Wire Format, Two Native Languages

Every message sent over Castora Pro's local WebSocket uses the same JSON envelope validated by `protocol/castora-protocol.schema.json`:

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

### Important Wire Rules
1. **ISO-8601 UTC Timestamps:** Always serialize `timestamp` in UTC with `Z` (e.g. `2026-11-21T12:20:02.000Z`).
2. **Explicit `null` for Absent Nullable Fields:** Always serialize `receiverDeviceId` and `roomId` (set to `null` on broadcast discovery messages like `device_announce` and `device_discover`).
3. **Never Transmit Permanent Secrets:** `pair_request` carries only a short-lived `ephemeralNonce` rotated every session—never passwords, API keys, or long-lived tokens.

---

## 2. Swift Implementation (`Codable`) — macOS

Swift's `Codable` automatically ignores unknown JSON keys during decoding unless you write a custom `init(from:)` that rejects them.

### Recommended Two-Step Decoding Pattern
Why two steps? If a future Castora Pro update adds a new message type or you receive an unsupported `protocolVersion`, decoding the outer envelope header **first** lets your app inspect `protocolVersion` and `messageType` safely before attempting to decode `payload`.

```swift
import Foundation

public enum CastoraProtocolConstants {
    public static let version = "castora.v1"
}

public enum CastoraPlatform: String, Codable, Sendable {
    case macos
    case android
    case androidTV = "android-tv"
}

public enum CastoraMessageType: String, Codable, Sendable {
    case deviceAnnounce = "device_announce"
    case deviceDiscover = "device_discover"
    case pairRequest = "pair_request"
    case pairResponse = "pair_response"
    case connectionRequest = "connection_request"
    case connectionAccepted = "connection_accepted"
    case connectionRejected = "connection_rejected"
    case sessionOffer = "session_offer"
    case sessionAnswer = "session_answer"
    case iceCandidate = "ice_candidate"
    case streamStart = "stream_start"
    case streamStop = "stream_stop"
    case streamStatus = "stream_status"
    case disconnect
    case error
    case heartbeat
}

/// Step 1: Lightweight header used to check protocolVersion before decoding typed payloads.
public struct CastoraEnvelopeHeader: Decodable, Sendable {
    public let protocolVersion: String
    public let messageType: String
    public let messageId: String
    public let senderDeviceId: String
    public let receiverDeviceId: String?
    public let roomId: String?
    public let timestamp: Date
}

/// Step 2: Generic typed envelope for encoding and decoding specific payloads.
public struct CastoraEnvelope<Payload: Codable & Sendable>: Codable, Sendable {
    public let protocolVersion: String
    public let messageType: CastoraMessageType
    public let messageId: String
    public let senderDeviceId: String
    public let receiverDeviceId: String?
    public let roomId: String?
    public let timestamp: Date
    public let payload: Payload

    public init(
        protocolVersion: String = CastoraProtocolConstants.version,
        messageType: CastoraMessageType,
        messageId: String = UUID().uuidString.lowercased(),
        senderDeviceId: String,
        receiverDeviceId: String?,
        roomId: String?,
        timestamp: Date = Date(),
        payload: Payload
    ) {
        self.protocolVersion = protocolVersion
        self.messageType = messageType
        self.messageId = messageId
        self.senderDeviceId = senderDeviceId
        self.receiverDeviceId = receiverDeviceId
        self.roomId = roomId
        self.timestamp = timestamp
        self.payload = payload
    }
}

public struct DeviceCapabilities: Codable, Sendable {
    public let maxWidth: Int
    public let maxHeight: Int
    public let maxFps: Int
    public let codecs: [String]
    public let supportsAudio: Bool
}

public enum CastoraCodecFactory {
    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
```

---

## 3. Kotlin Implementation (`kotlinx.serialization`) — Android & Android TV

In Kotlin, `kotlinx.serialization` is **strict by default**: if a JSON message contains an unknown field, `Json.decodeFromString` throws `SerializationException` unless `ignoreUnknownKeys = true` is configured.

### Recommended `Json` Configuration & Envelope Models

```kotlin
package com.castorapro.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

object CastoraProtocolConstants {
    const val VERSION = "castora.v1"
}

@Serializable
enum class CastoraPlatform {
    @SerialName("macos") MACOS,
    @SerialName("android") ANDROID,
    @SerialName("android-tv") ANDROID_TV
}

@Serializable
enum class CastoraMessageType {
    @SerialName("device_announce") DEVICE_ANNOUNCE,
    @SerialName("device_discover") DEVICE_DISCOVER,
    @SerialName("pair_request") PAIR_REQUEST,
    @SerialName("pair_response") PAIR_RESPONSE,
    @SerialName("connection_request") CONNECTION_REQUEST,
    @SerialName("connection_accepted") CONNECTION_ACCEPTED,
    @SerialName("connection_rejected") CONNECTION_REJECTED,
    @SerialName("session_offer") SESSION_OFFER,
    @SerialName("session_answer") SESSION_ANSWER,
    @SerialName("ice_candidate") ICE_CANDIDATE,
    @SerialName("stream_start") STREAM_START,
    @SerialName("stream_stop") STREAM_STOP,
    @SerialName("stream_status") STREAM_STATUS,
    @SerialName("disconnect") DISCONNECT,
    @SerialName("error") ERROR,
    @SerialName("heartbeat") HEARTBEAT
}

/** Step 1: Inspect header strings safely before parsing messageType/payload. */
@Serializable
data class CastoraEnvelopeHeader(
    val protocolVersion: String,
    val messageType: String,
    val messageId: String,
    val senderDeviceId: String,
    val receiverDeviceId: String? = null,
    val roomId: String? = null,
    val timestamp: String
)

/** Step 2: Strongly typed envelope for a known payload. */
@Serializable
data class CastoraEnvelope<T>(
    val protocolVersion: String = CastoraProtocolConstants.VERSION,
    val messageType: CastoraMessageType,
    val messageId: String,
    val senderDeviceId: String,
    val receiverDeviceId: String? = null,
    val roomId: String? = null,
    val timestamp: String,
    val payload: T
)

@Serializable
data class DeviceCapabilities(
    val maxWidth: Int,
    val maxHeight: Int,
    val maxFps: Int,
    val codecs: List<String>,
    val supportsAudio: Boolean
)

val castoraJson = Json {
    ignoreUnknownKeys = true   // Allows forward-compatible optional fields
    encodeDefaults = true      // Always writes protocolVersion and null fields
    explicitNulls = true       // Keeps receiverDeviceId/roomId present as null
}
```

---

## 4. Handling Unknown Fields & Unsupported Protocol Versions

### Handling Unknown Fields
- **Schema Validation (Tests & CI):** `protocol/castora-protocol.schema.json` uses `additionalProperties: false` so typos in fixtures or code (like `"room_id"` instead of `"roomId"`) are caught immediately during `npm run test:protocol`.
- **Runtime Apps (Forward Compatibility):**
  - On **Swift**, `Codable` naturally ignores unknown keys.
  - On **Kotlin**, set `ignoreUnknownKeys = true` in `Json { ... }`.
  - If a newer Castora Pro client adds a non-breaking optional field in a minor update (e.g., `castora.v1` adding an optional hint), older clients won't crash—while strict schema unit tests in CI still catch accidental typos.

### Handling Unsupported Protocol Versions
Before dispatching any incoming WebSocket frame:
1. Decode the header (`CastoraEnvelopeHeader`) with `protocolVersion` and `messageType` as raw `String` values.
2. Check `header.protocolVersion == "castora.v1"`.
3. If `protocolVersion` does not match `"castora.v1"`:
   - **Do not** attempt to parse `payload` or start pairing/WebRTC.
   - Reply immediately with a structured `error` message using `protocolVersion: "castora.v1"`:
     - `code`: `"UNSUPPORTED_VERSION"`
     - `message`: `"Unsupported protocolVersion '<received>'. Expected 'castora.v1'."`
     - `recoverable`: `false`
     - `relatedMessageId`: `header.messageId`
   - Close the WebSocket cleanly if the handshake cannot proceed.
4. If `messageType` is unknown (not one of the 16 supported enum values):
   - Reply with `error` (`code: "INVALID_MESSAGE"`, `recoverable: true`, `relatedMessageId: header.messageId`) and ignore the unknown frame instead of crashing.
