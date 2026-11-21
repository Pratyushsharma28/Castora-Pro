import Foundation

// MARK: - Protocol Constants

public enum CastoraProtocolConstants {
    public static let version = "castora.v1"
    public static let bonjourServiceType = "_castora._tcp"
    public static let webSocketPath = "/castora"
}

// MARK: - Shared Enums

public enum CastoraPlatform: String, Codable, Sendable, CaseIterable {
    case macos
    case android
    case androidTV = "android-tv"

    public var displayName: String {
        switch self {
        case .macos: return "macOS"
        case .android: return "Android"
        case .androidTV: return "Android TV"
        }
    }
}

public enum CastoraDeviceRole: String, Codable, Sendable {
    case sender
    case receiver
    case both
}

public enum CastoraRequestedRole: String, Codable, Sendable {
    case sender
    case receiver
    case any
}

public enum CastoraVideoCodec: String, Codable, Sendable, CaseIterable, Identifiable {
    case h264 = "H264"
    case hevc = "HEVC"
    case vp8 = "VP8"
    case vp9 = "VP9"
    case av1 = "AV1"

    public var id: String { rawValue }
}

public enum CastoraMessageType: String, Codable, Sendable, CaseIterable {
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

public enum CastoraPairingMethod: String, Codable, Sendable {
    case qr
    case roomCode = "room_code"
    case manualIP = "manual_ip"
}

public enum CastoraRejectionReasonCode: String, Codable, Sendable {
    case userDeclined = "USER_DECLINED"
    case sessionFull = "SESSION_FULL"
    case capabilityMismatch = "CAPABILITY_MISMATCH"
    case timeout = "TIMEOUT"
}

public enum CastoraStreamStopReason: String, Codable, Sendable {
    case userStopped = "user_stopped"
    case receiverClosed = "receiver_closed"
    case captureRevoked = "capture_revoked"
    case networkLost = "network_lost"
}

public enum CastoraStreamState: String, Codable, Sendable {
    case starting
    case active
    case paused
    case degraded
}

public enum CastoraLayoutMode: String, Codable, Sendable {
    case grid
    case fullscreen
}

public enum CastoraErrorCode: String, Codable, Sendable {
    case unsupportedVersion = "UNSUPPORTED_VERSION"
    case invalidMessage = "INVALID_MESSAGE"
    case invalidNonce = "INVALID_NONCE"
    case invalidRoomID = "INVALID_ROOM_ID"
    case approvalDeclined = "APPROVAL_DECLINED"
    case sessionFull = "SESSION_FULL"
    case capturePermissionDenied = "CAPTURE_PERMISSION_DENIED"
    case webrtcNegotiationFailed = "WEBRTC_NEGOTIATION_FAILED"
    case internalError = "INTERNAL_ERROR"
}

public enum CastoraPeerRole: String, Codable, Sendable {
    case sender
    case receiver
}

// MARK: - Envelope

/// Lightweight header decoded first to validate `protocolVersion` and inspect `messageType` safely.
public struct CastoraEnvelopeHeader: Decodable, Sendable, Equatable {
    public let protocolVersion: String
    public let messageType: String
    public let messageId: String
    public let senderDeviceId: String
    public let receiverDeviceId: String?
    public let roomId: String?
    public let timestamp: Date
}

/// Strict `castora.v1` envelope matching `protocol/castora-protocol.schema.json`.
/// Explicitly encodes `null` for `receiverDeviceId` and `roomId` when `nil`.
public struct CastoraEnvelope<Payload: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
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
        receiverDeviceId: String? = nil,
        roomId: String? = nil,
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

    private enum CodingKeys: String, CodingKey {
        case protocolVersion
        case messageType
        case messageId
        case senderDeviceId
        case receiverDeviceId
        case roomId
        case timestamp
        case payload
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(messageType, forKey: .messageType)
        try container.encode(messageId, forKey: .messageId)
        try container.encode(senderDeviceId, forKey: .senderDeviceId)
        try container.encode(receiverDeviceId, forKey: .receiverDeviceId)
        try container.encode(roomId, forKey: .roomId)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(payload, forKey: .payload)
    }
}

// MARK: - Shared Supporting Models

public struct DeviceCapabilities: Codable, Sendable, Equatable {
    public let maxWidth: Int
    public let maxHeight: Int
    public let maxFps: Int
    public let codecs: [CastoraVideoCodec]
    public let supportsAudio: Bool

    public init(
        maxWidth: Int,
        maxHeight: Int,
        maxFps: Int,
        codecs: [CastoraVideoCodec],
        supportsAudio: Bool
    ) {
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
        self.maxFps = maxFps
        self.codecs = codecs
        self.supportsAudio = supportsAudio
    }
}

public struct CastoraIceServer: Codable, Sendable, Equatable {
    public let urls: [String]

    public init(urls: [String]) {
        self.urls = urls
    }
}

public struct CastoraIceConfig: Codable, Sendable, Equatable {
    public let iceServers: [CastoraIceServer]

    public init(iceServers: [CastoraIceServer] = []) {
        self.iceServers = iceServers
    }
}

public struct RequestedStreamQuality: Codable, Sendable, Equatable {
    public let targetWidth: Int
    public let targetHeight: Int
    public let targetFps: Int
    public let preferredCodec: CastoraVideoCodec

    public init(
        targetWidth: Int,
        targetHeight: Int,
        targetFps: Int,
        preferredCodec: CastoraVideoCodec
    ) {
        self.targetWidth = targetWidth
        self.targetHeight = targetHeight
        self.targetFps = targetFps
        self.preferredCodec = preferredCodec
    }
}

public struct SessionOfferMediaInfo: Codable, Sendable, Equatable {
    public let hasVideo: Bool
    public let hasAudio: Bool
    public let codecHint: CastoraVideoCodec?

    public init(hasVideo: Bool, hasAudio: Bool, codecHint: CastoraVideoCodec? = nil) {
        self.hasVideo = hasVideo
        self.hasAudio = hasAudio
        self.codecHint = codecHint
    }
}

public struct MeasuredStreamStats: Codable, Sendable, Equatable {
    public let fps: Double
    public let bitrateKbps: Double
    public let rttMs: Double
    public let droppedFrames: Int

    public init(fps: Double, bitrateKbps: Double, rttMs: Double, droppedFrames: Int) {
        self.fps = fps
        self.bitrateKbps = bitrateKbps
        self.rttMs = rttMs
        self.droppedFrames = droppedFrames
    }
}

// MARK: - 16 Protocol Payloads

public struct DeviceAnnouncePayload: Codable, Sendable, Equatable {
    public let deviceName: String
    public let platform: CastoraPlatform
    public let role: CastoraDeviceRole
    public let wsPort: Int
    public let capabilities: DeviceCapabilities

    public init(
        deviceName: String,
        platform: CastoraPlatform,
        role: CastoraDeviceRole,
        wsPort: Int,
        capabilities: DeviceCapabilities
    ) {
        self.deviceName = deviceName
        self.platform = platform
        self.role = role
        self.wsPort = wsPort
        self.capabilities = capabilities
    }
}

public struct DeviceDiscoverPayload: Codable, Sendable, Equatable {
    public let requestedRole: CastoraRequestedRole
    public let requesterPlatform: CastoraPlatform
    public let filterPlatform: CastoraPlatform?

    public init(
        requestedRole: CastoraRequestedRole,
        requesterPlatform: CastoraPlatform,
        filterPlatform: CastoraPlatform? = nil
    ) {
        self.requestedRole = requestedRole
        self.requesterPlatform = requesterPlatform
        self.filterPlatform = filterPlatform
    }
}

public struct PairRequestPayload: Codable, Sendable, Equatable {
    public let pairingMethod: CastoraPairingMethod
    public let ephemeralNonce: String
    public let deviceName: String
    public let platform: CastoraPlatform
    public let capabilities: DeviceCapabilities

    public init(
        pairingMethod: CastoraPairingMethod,
        ephemeralNonce: String,
        deviceName: String,
        platform: CastoraPlatform,
        capabilities: DeviceCapabilities
    ) {
        self.pairingMethod = pairingMethod
        self.ephemeralNonce = ephemeralNonce
        self.deviceName = deviceName
        self.platform = platform
        self.capabilities = capabilities
    }
}

public struct PairResponsePayload: Codable, Sendable, Equatable {
    public let paired: Bool
    public let reason: String?
    public let receiverName: String
    public let receiverPlatform: CastoraPlatform
    public let sessionId: String?

    public init(
        paired: Bool,
        reason: String?,
        receiverName: String,
        receiverPlatform: CastoraPlatform,
        sessionId: String?
    ) {
        self.paired = paired
        self.reason = reason
        self.receiverName = receiverName
        self.receiverPlatform = receiverPlatform
        self.sessionId = sessionId
    }

    private enum CodingKeys: String, CodingKey {
        case paired
        case reason
        case receiverName
        case receiverPlatform
        case sessionId
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(paired, forKey: .paired)
        try container.encode(reason, forKey: .reason)
        try container.encode(receiverName, forKey: .receiverName)
        try container.encode(receiverPlatform, forKey: .receiverPlatform)
        try container.encode(sessionId, forKey: .sessionId)
    }
}

public struct ConnectionRequestPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let senderName: String
    public let senderPlatform: CastoraPlatform
    public let requestedQuality: RequestedStreamQuality

    public init(
        sessionId: String,
        streamId: String,
        senderName: String,
        senderPlatform: CastoraPlatform,
        requestedQuality: RequestedStreamQuality
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.senderName = senderName
        self.senderPlatform = senderPlatform
        self.requestedQuality = requestedQuality
    }
}

public struct ConnectionAcceptedPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let assignedSlotIndex: Int
    public let iceConfig: CastoraIceConfig

    public init(
        sessionId: String,
        streamId: String,
        assignedSlotIndex: Int,
        iceConfig: CastoraIceConfig
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.assignedSlotIndex = assignedSlotIndex
        self.iceConfig = iceConfig
    }
}

public struct ConnectionRejectedPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let reasonCode: CastoraRejectionReasonCode
    public let message: String

    public init(
        sessionId: String,
        reasonCode: CastoraRejectionReasonCode,
        message: String
    ) {
        self.sessionId = sessionId
        self.reasonCode = reasonCode
        self.message = message
    }
}

public struct SessionOfferPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let sdpType: String
    public let sdp: String
    public let mediaInfo: SessionOfferMediaInfo?

    public init(
        sessionId: String,
        streamId: String,
        sdpType: String = "offer",
        sdp: String,
        mediaInfo: SessionOfferMediaInfo? = nil
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.sdpType = sdpType
        self.sdp = sdp
        self.mediaInfo = mediaInfo
    }
}

public struct SessionAnswerPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let sdpType: String
    public let sdp: String

    public init(
        sessionId: String,
        streamId: String,
        sdpType: String = "answer",
        sdp: String
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.sdpType = sdpType
        self.sdp = sdp
    }
}

public struct IceCandidatePayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let sdpMid: String?
    public let sdpMLineIndex: Int
    public let candidate: String

    public init(
        sessionId: String,
        streamId: String,
        sdpMid: String?,
        sdpMLineIndex: Int,
        candidate: String
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
        self.candidate = candidate
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case streamId
        case sdpMid
        case sdpMLineIndex
        case candidate
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(streamId, forKey: .streamId)
        try container.encode(sdpMid, forKey: .sdpMid)
        try container.encode(sdpMLineIndex, forKey: .sdpMLineIndex)
        try container.encode(candidate, forKey: .candidate)
    }
}

public struct StreamStartPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let width: Int
    public let height: Int
    public let fps: Int
    public let codec: CastoraVideoCodec

    public init(
        sessionId: String,
        streamId: String,
        width: Int,
        height: Int,
        fps: Int,
        codec: CastoraVideoCodec
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.width = width
        self.height = height
        self.fps = fps
        self.codec = codec
    }
}

public struct StreamStopPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let reason: CastoraStreamStopReason

    public init(
        sessionId: String,
        streamId: String,
        reason: CastoraStreamStopReason
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.reason = reason
    }
}

public struct StreamStatusPayload: Codable, Sendable, Equatable {
    public let sessionId: String
    public let streamId: String
    public let state: CastoraStreamState
    public let layoutMode: CastoraLayoutMode
    public let measuredStats: MeasuredStreamStats?

    public init(
        sessionId: String,
        streamId: String,
        state: CastoraStreamState,
        layoutMode: CastoraLayoutMode,
        measuredStats: MeasuredStreamStats? = nil
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.state = state
        self.layoutMode = layoutMode
        self.measuredStats = measuredStats
    }
}

public struct DisconnectPayload: Codable, Sendable, Equatable {
    public let sessionId: String?
    public let streamId: String?
    public let reason: String

    public init(sessionId: String?, streamId: String?, reason: String) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case streamId
        case reason
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(streamId, forKey: .streamId)
        try container.encode(reason, forKey: .reason)
    }
}

public struct ErrorPayload: Codable, Sendable, Equatable {
    public let code: CastoraErrorCode
    public let message: String
    public let recoverable: Bool
    public let relatedMessageId: String?

    public init(
        code: CastoraErrorCode,
        message: String,
        recoverable: Bool,
        relatedMessageId: String?
    ) {
        self.code = code
        self.message = message
        self.recoverable = recoverable
        self.relatedMessageId = relatedMessageId
    }

    private enum CodingKeys: String, CodingKey {
        case code
        case message
        case recoverable
        case relatedMessageId
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(code, forKey: .code)
        try container.encode(message, forKey: .message)
        try container.encode(recoverable, forKey: .recoverable)
        try container.encode(relatedMessageId, forKey: .relatedMessageId)
    }
}

public struct HeartbeatPayload: Codable, Sendable, Equatable {
    public let sequence: Int
    public let role: CastoraPeerRole

    public init(sequence: Int, role: CastoraPeerRole) {
        self.sequence = sequence
        self.role = role
    }
}

// MARK: - Type-Safe Decoded Message Union

public enum CastoraSignalingMessage: Sendable, Equatable {
    case deviceAnnounce(CastoraEnvelope<DeviceAnnouncePayload>)
    case deviceDiscover(CastoraEnvelope<DeviceDiscoverPayload>)
    case pairRequest(CastoraEnvelope<PairRequestPayload>)
    case pairResponse(CastoraEnvelope<PairResponsePayload>)
    case connectionRequest(CastoraEnvelope<ConnectionRequestPayload>)
    case connectionAccepted(CastoraEnvelope<ConnectionAcceptedPayload>)
    case connectionRejected(CastoraEnvelope<ConnectionRejectedPayload>)
    case sessionOffer(CastoraEnvelope<SessionOfferPayload>)
    case sessionAnswer(CastoraEnvelope<SessionAnswerPayload>)
    case iceCandidate(CastoraEnvelope<IceCandidatePayload>)
    case streamStart(CastoraEnvelope<StreamStartPayload>)
    case streamStop(CastoraEnvelope<StreamStopPayload>)
    case streamStatus(CastoraEnvelope<StreamStatusPayload>)
    case disconnect(CastoraEnvelope<DisconnectPayload>)
    case error(CastoraEnvelope<ErrorPayload>)
    case heartbeat(CastoraEnvelope<HeartbeatPayload>)
}
