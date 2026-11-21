import Foundation
import XCTest
@testable import CastoraPro

final class ProtocolModelTests: XCTestCase {
    private let codec = ProtocolCodecService()

    func testDecodeAndRoundTripAll16MessageTypes() throws {
        let samples: [(CastoraMessageType, String)] = [
            (.deviceAnnounce, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "device_announce",
              "messageId": "msg-0001-announce",
              "senderDeviceId": "dev-tv-livingroom",
              "receiverDeviceId": null,
              "roomId": null,
              "timestamp": "2026-11-21T12:20:00.000Z",
              "payload": {
                "deviceName": "Living Room Android TV",
                "platform": "android-tv",
                "role": "receiver",
                "wsPort": 49152,
                "capabilities": {
                  "maxWidth": 1920,
                  "maxHeight": 1080,
                  "maxFps": 60,
                  "codecs": ["H264", "HEVC"],
                  "supportsAudio": true
                }
              }
            }
            """),
            (.deviceDiscover, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "device_discover",
              "messageId": "msg-0002-discover",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": null,
              "roomId": null,
              "timestamp": "2026-11-21T12:20:01Z",
              "payload": {
                "requestedRole": "receiver",
                "requesterPlatform": "macos",
                "filterPlatform": "android-tv"
              }
            }
            """),
            (.pairRequest, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "pair_request",
              "messageId": "msg-0003-pair-req",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:02.000Z",
              "payload": {
                "pairingMethod": "qr",
                "ephemeralNonce": "ephemeral_demo_nonce_0001",
                "deviceName": "Studio MacBook Pro",
                "platform": "macos",
                "capabilities": {
                  "maxWidth": 1920,
                  "maxHeight": 1080,
                  "maxFps": 60,
                  "codecs": ["H264", "HEVC"],
                  "supportsAudio": true
                }
              }
            }
            """),
            (.pairResponse, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "pair_response",
              "messageId": "msg-0004-pair-resp",
              "senderDeviceId": "dev-tv-livingroom",
              "receiverDeviceId": "dev-mac-pro-01",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:03.000Z",
              "payload": {
                "paired": true,
                "reason": null,
                "receiverName": "Living Room Android TV",
                "receiverPlatform": "android-tv",
                "sessionId": "sess-k7m9p2-001"
              }
            }
            """),
            (.connectionRequest, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "connection_request",
              "messageId": "msg-0005-conn-req",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:04.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "senderName": "Studio MacBook Pro",
                "senderPlatform": "macos",
                "requestedQuality": {
                  "targetWidth": 1920,
                  "targetHeight": 1080,
                  "targetFps": 60,
                  "preferredCodec": "H264"
                }
              }
            }
            """),
            (.connectionAccepted, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "connection_accepted",
              "messageId": "msg-0006-conn-acc",
              "senderDeviceId": "dev-tv-livingroom",
              "receiverDeviceId": "dev-mac-pro-01",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:06.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "assignedSlotIndex": 0,
                "iceConfig": { "iceServers": [] }
              }
            }
            """),
            (.connectionRejected, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "connection_rejected",
              "messageId": "msg-0007-conn-rej",
              "senderDeviceId": "dev-tv-livingroom",
              "receiverDeviceId": "dev-mac-pro-01",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:06.500Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "reasonCode": "USER_DECLINED",
                "message": "Receiver user declined the incoming cast request."
              }
            }
            """),
            (.sessionOffer, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "session_offer",
              "messageId": "msg-0008-offer",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:08.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "sdpType": "offer",
                "sdp": "v=0\\r\\no=- 123456789 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=video 9 UDP/TLS/RTP/SAVPF 96\\r\\n",
                "mediaInfo": {
                  "hasVideo": true,
                  "hasAudio": false,
                  "codecHint": "H264"
                }
              }
            }
            """),
            (.sessionAnswer, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "session_answer",
              "messageId": "msg-0009-answer",
              "senderDeviceId": "dev-tv-livingroom",
              "receiverDeviceId": "dev-mac-pro-01",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:09.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "sdpType": "answer",
                "sdp": "v=0\\r\\no=- 987654321 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=video 9 UDP/TLS/RTP/SAVPF 96\\r\\n"
              }
            }
            """),
            (.iceCandidate, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "ice_candidate",
              "messageId": "msg-0010-ice",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:09.500Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "sdpMid": "0",
                "sdpMLineIndex": 0,
                "candidate": "candidate:842163049 1 udp 1677729535 192.168.1.25 54321 typ host"
              }
            }
            """),
            (.streamStart, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "stream_start",
              "messageId": "msg-0011-start",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:10.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "width": 1920,
                "height": 1080,
                "fps": 60,
                "codec": "H264"
              }
            }
            """),
            (.streamStop, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "stream_stop",
              "messageId": "msg-0012-stop",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:25:00.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "reason": "user_stopped"
              }
            }
            """),
            (.streamStatus, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "stream_status",
              "messageId": "msg-0013-status",
              "senderDeviceId": "dev-tv-livingroom",
              "receiverDeviceId": "dev-mac-pro-01",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:21:00.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "state": "active",
                "layoutMode": "fullscreen",
                "measuredStats": {
                  "fps": 59.8,
                  "bitrateKbps": 7400.5,
                  "rttMs": 2.4,
                  "droppedFrames": 0
                }
              }
            }
            """),
            (.disconnect, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "disconnect",
              "messageId": "msg-0014-disconnect",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:26:00.000Z",
              "payload": {
                "sessionId": "sess-k7m9p2-001",
                "streamId": "stream-01",
                "reason": "user_ended_session"
              }
            }
            """),
            (.error, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "error",
              "messageId": "msg-0015-error",
              "senderDeviceId": "dev-tv-livingroom",
              "receiverDeviceId": "dev-mac-pro-01",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:20:02.500Z",
              "payload": {
                "code": "INVALID_NONCE",
                "message": "The ephemeral pairing nonce is expired or does not match.",
                "recoverable": false,
                "relatedMessageId": "msg-0003-pair-req"
              }
            }
            """),
            (.heartbeat, """
            {
              "protocolVersion": "castora.v1",
              "messageType": "heartbeat",
              "messageId": "msg-0016-heartbeat",
              "senderDeviceId": "dev-mac-pro-01",
              "receiverDeviceId": "dev-tv-livingroom",
              "roomId": "K7M9P2",
              "timestamp": "2026-11-21T12:21:05.000Z",
              "payload": {
                "sequence": 42,
                "role": "sender"
              }
            }
            """)
        ]

        XCTAssertEqual(samples.count, CastoraMessageType.allCases.count)

        for (expectedType, jsonString) in samples {
            let data = Data(jsonString.utf8)
            let decoded = try codec.decode(data)

            switch (expectedType, decoded) {
            case (.deviceAnnounce, .deviceAnnounce(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.deviceDiscover, .deviceDiscover(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.pairRequest, .pairRequest(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.pairResponse, .pairResponse(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.connectionRequest, .connectionRequest(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.connectionAccepted, .connectionAccepted(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.connectionRejected, .connectionRejected(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.sessionOffer, .sessionOffer(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.sessionAnswer, .sessionAnswer(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.iceCandidate, .iceCandidate(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.streamStart, .streamStart(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.streamStop, .streamStop(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.streamStatus, .streamStatus(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.disconnect, .disconnect(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.error, .error(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            case (.heartbeat, .heartbeat(let env)):
                let reencoded = try codec.encode(env)
                XCTAssertEqual(try codec.decode(reencoded), decoded)
            default:
                XCTFail("Decoded message variant did not match expected type \(expectedType.rawValue)")
            }
        }
    }

    func testRepositoryValidFixturesDecodeWhenPresentOnDisk() throws {
        let testFileURL = URL(fileURLWithPath: #filePath)
        // apps/macos/Tests/CastoraProTests/ProtocolModelTests.swift -> repo root
        let repoRoot = testFileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let validDir = repoRoot.appendingPathComponent("protocol/fixtures/valid")

        guard FileManager.default.fileExists(atPath: validDir.path) else {
            return
        }

        let files = try FileManager.default.contentsOfDirectory(
            at: validDir,
            includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "json" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }

        XCTAssertEqual(files.count, 16, "Expected all 16 valid fixtures in protocol/fixtures/valid/")

        for fileURL in files {
            let data = try Data(contentsOf: fileURL)
            XCTAssertNoThrow(try codec.decode(data), "Fixture \(fileURL.lastPathComponent) should decode cleanly")
        }
    }

    func testNullableEnvelopeAndPayloadFieldsEncodeExplicitNulls() throws {
        let announce = CastoraEnvelope(
            messageType: .deviceAnnounce,
            messageId: "msg-null-check-01",
            senderDeviceId: "mac-local-01",
            receiverDeviceId: nil,
            roomId: nil,
            payload: DeviceAnnouncePayload(
                deviceName: "Studio Mac",
                platform: .macos,
                role: .both,
                wsPort: 49152,
                capabilities: DeviceCapabilities(
                    maxWidth: 1920,
                    maxHeight: 1080,
                    maxFps: 60,
                    codecs: [.h264, .hevc],
                    supportsAudio: false
                )
            )
        )

        let data = try codec.encode(announce)
        let jsonObject = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(jsonObject["receiverDeviceId"] is NSNull)
        XCTAssertTrue(jsonObject["roomId"] is NSNull)

        let ice = CastoraEnvelope(
            messageType: .iceCandidate,
            messageId: "msg-null-check-02",
            senderDeviceId: "mac-local-01",
            receiverDeviceId: "tv-room-01",
            roomId: "A1B2C3",
            payload: IceCandidatePayload(
                sessionId: "sess-001",
                streamId: "stream-01",
                sdpMid: nil,
                sdpMLineIndex: 0,
                candidate: "candidate:1 1 udp 123 192.168.1.5 50000 typ host"
            )
        )

        let iceData = try codec.encode(ice)
        let iceObject = try XCTUnwrap(JSONSerialization.jsonObject(with: iceData) as? [String: Any])
        let icePayload = try XCTUnwrap(iceObject["payload"] as? [String: Any])
        XCTAssertTrue(icePayload["sdpMid"] is NSNull)
    }

    func testRejectsUnsupportedProtocolVersion() {
        let json = """
        {
          "protocolVersion": "castora.v2",
          "messageType": "heartbeat",
          "messageId": "msg-bad-ver-01",
          "senderDeviceId": "mac-01",
          "receiverDeviceId": null,
          "roomId": null,
          "timestamp": "2026-11-21T12:00:00.000Z",
          "payload": { "sequence": 1, "role": "sender" }
        }
        """

        XCTAssertThrowsError(try codec.decode(Data(json.utf8))) { error in
            XCTAssertEqual(
                error as? ProtocolCodecError,
                .unsupportedVersion(received: "castora.v2", expected: "castora.v1")
            )
        }
    }

    func testRejectsUnknownMessageType() {
        let json = """
        {
          "protocolVersion": "castora.v1",
          "messageType": "future_unknown_event",
          "messageId": "msg-bad-type-01",
          "senderDeviceId": "mac-01",
          "receiverDeviceId": null,
          "roomId": null,
          "timestamp": "2026-11-21T12:00:00.000Z",
          "payload": {}
        }
        """

        XCTAssertThrowsError(try codec.decode(Data(json.utf8))) { error in
            XCTAssertEqual(error as? ProtocolCodecError, .unknownMessageType("future_unknown_event"))
        }
    }
}
