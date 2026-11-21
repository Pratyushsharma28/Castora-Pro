# Castora Pro Signaling Protocol Fixtures (`castora.v1`)

These JSON files are pure protocol payloads (no comments or test metadata embedded inside the JSON) used by `npm run test:protocol` (`scripts/validate-protocol.mjs`), and later by Swift (`XCTest`) and Kotlin (`JUnit 5`) unit tests.

## Valid Fixtures (`valid/`)
One valid example for every one of the 16 `castora.v1` message types:
- `01-device-announce.json` — `device_announce`
- `02-device-discover.json` — `device_discover`
- `03-pair-request.json` — `pair_request`
- `04-pair-response.json` — `pair_response`
- `05-connection-request.json` — `connection_request`
- `06-connection-accepted.json` — `connection_accepted`
- `07-connection-rejected.json` — `connection_rejected`
- `08-session-offer.json` — `session_offer`
- `09-session-answer.json` — `session_answer`
- `10-ice-candidate.json` — `ice_candidate`
- `11-stream-start.json` — `stream_start`
- `12-stream-stop.json` — `stream_stop`
- `13-stream-status.json` — `stream_status`
- `14-disconnect.json` — `disconnect`
- `15-error.json` — `error`
- `16-heartbeat.json` — `heartbeat`

## Invalid Fixtures (`invalid/`)
Each invalid fixture tests one specific schema failure condition:
- `invalid-unsupported-version.json` — Rejects `protocolVersion: "castora.v2"`
- `invalid-unknown-message-type.json` — Rejects unknown `messageType`
- `invalid-missing-sender-device-id.json` — Rejects missing required `senderDeviceId`
- `invalid-timestamp-format.json` — Rejects non-ISO-8601 `timestamp`
- `invalid-room-id-pattern.json` — Rejects lowercase/5-char `roomId` (`"abc12"`)
- `invalid-device-announce-port-type.json` — Rejects string `wsPort` (`"49152"`) instead of integer
- `invalid-device-discover-role.json` — Rejects invalid `requestedRole` (`"admin"`)
- `invalid-pair-request-short-nonce.json` — Rejects `ephemeralNonce` shorter than 16 characters
- `invalid-pair-response-null-receiver.json` — Rejects `null` `receiverDeviceId` on directed `pair_response`
- `invalid-connection-request-missing-quality.json` — Rejects missing `requestedQuality`
- `invalid-connection-accepted-slot-negative.json` — Rejects negative `assignedSlotIndex`
- `invalid-connection-rejected-reason-code.json` — Rejects undocumented `reasonCode`
- `invalid-session-offer-wrong-sdp-type.json` — Rejects `"answer"` inside `session_offer`
- `invalid-session-answer-empty-sdp.json` — Rejects `sdp` shorter than minimum length
- `invalid-ice-candidate-negative-mline.json` — Rejects negative `sdpMLineIndex`
- `invalid-stream-start-zero-fps.json` — Rejects `fps: 0`
- `invalid-stream-stop-unknown-reason.json` — Rejects unknown stop `reason`
- `invalid-stream-status-extra-property.json` — Rejects undeclared extra property inside payload
- `invalid-disconnect-missing-reason.json` — Rejects missing `reason`
- `invalid-error-unknown-code.json` — Rejects unknown error `code`
- `invalid-heartbeat-negative-sequence.json` — Rejects negative `sequence`
