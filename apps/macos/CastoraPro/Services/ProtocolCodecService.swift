import Foundation

public enum ProtocolCodecError: LocalizedError, Equatable, Sendable {
    case unsupportedVersion(received: String, expected: String)
    case unknownMessageType(String)
    case invalidTimestamp(String)
    case invalidPayload(messageType: String, detail: String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let received, let expected):
            return "Unsupported protocolVersion '\(received)'. Expected '\(expected)'."
        case .unknownMessageType(let type):
            return "Unknown messageType '\(type)'."
        case .invalidTimestamp(let raw):
            return "Invalid ISO-8601 timestamp '\(raw)'."
        case .invalidPayload(let messageType, let detail):
            return "Failed to decode payload for '\(messageType)': \(detail)"
        }
    }
}

public struct ProtocolCodecService: Sendable {
    public init() {}

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }

    public static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)

            let fractionalFormatter = ISO8601DateFormatter()
            fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractionalFormatter.date(from: raw) {
                return date
            }

            let standardFormatter = ISO8601DateFormatter()
            standardFormatter.formatOptions = [.withInternetDateTime]
            if let date = standardFormatter.date(from: raw) {
                return date
            }

            throw ProtocolCodecError.invalidTimestamp(raw)
        }
        return decoder
    }

    public func encode<Payload: Codable & Sendable & Equatable>(
        _ envelope: CastoraEnvelope<Payload>
    ) throws -> Data {
        try Self.makeEncoder().encode(envelope)
    }

    public func decode(_ data: Data) throws -> CastoraSignalingMessage {
        let decoder = Self.makeDecoder()
        let header = try decoder.decode(CastoraEnvelopeHeader.self, from: data)

        guard header.protocolVersion == CastoraProtocolConstants.version else {
            throw ProtocolCodecError.unsupportedVersion(
                received: header.protocolVersion,
                expected: CastoraProtocolConstants.version
            )
        }

        guard let messageType = CastoraMessageType(rawValue: header.messageType) else {
            throw ProtocolCodecError.unknownMessageType(header.messageType)
        }

        do {
            switch messageType {
            case .deviceAnnounce:
                return .deviceAnnounce(try decoder.decode(CastoraEnvelope<DeviceAnnouncePayload>.self, from: data))
            case .deviceDiscover:
                return .deviceDiscover(try decoder.decode(CastoraEnvelope<DeviceDiscoverPayload>.self, from: data))
            case .pairRequest:
                return .pairRequest(try decoder.decode(CastoraEnvelope<PairRequestPayload>.self, from: data))
            case .pairResponse:
                return .pairResponse(try decoder.decode(CastoraEnvelope<PairResponsePayload>.self, from: data))
            case .connectionRequest:
                return .connectionRequest(try decoder.decode(CastoraEnvelope<ConnectionRequestPayload>.self, from: data))
            case .connectionAccepted:
                return .connectionAccepted(try decoder.decode(CastoraEnvelope<ConnectionAcceptedPayload>.self, from: data))
            case .connectionRejected:
                return .connectionRejected(try decoder.decode(CastoraEnvelope<ConnectionRejectedPayload>.self, from: data))
            case .sessionOffer:
                return .sessionOffer(try decoder.decode(CastoraEnvelope<SessionOfferPayload>.self, from: data))
            case .sessionAnswer:
                return .sessionAnswer(try decoder.decode(CastoraEnvelope<SessionAnswerPayload>.self, from: data))
            case .iceCandidate:
                return .iceCandidate(try decoder.decode(CastoraEnvelope<IceCandidatePayload>.self, from: data))
            case .streamStart:
                return .streamStart(try decoder.decode(CastoraEnvelope<StreamStartPayload>.self, from: data))
            case .streamStop:
                return .streamStop(try decoder.decode(CastoraEnvelope<StreamStopPayload>.self, from: data))
            case .streamStatus:
                return .streamStatus(try decoder.decode(CastoraEnvelope<StreamStatusPayload>.self, from: data))
            case .disconnect:
                return .disconnect(try decoder.decode(CastoraEnvelope<DisconnectPayload>.self, from: data))
            case .error:
                return .error(try decoder.decode(CastoraEnvelope<ErrorPayload>.self, from: data))
            case .heartbeat:
                return .heartbeat(try decoder.decode(CastoraEnvelope<HeartbeatPayload>.self, from: data))
            }
        } catch let error as ProtocolCodecError {
            throw error
        } catch {
            throw ProtocolCodecError.invalidPayload(
                messageType: messageType.rawValue,
                detail: error.localizedDescription
            )
        }
    }
}
