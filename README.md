# Castora Pro

Castora Pro is a cross-platform, local-network-first screen-casting system built with native **macOS** (Swift / SwiftUI) and **Android & Android TV** (Kotlin / Jetpack Compose) applications, powered by **WebRTC** with **DTLS-SRTP** encryption.

> **Project Stage:** Phase 2 — Shared Signaling Protocol (`castora.v1`) & Automated Test Fixtures  
> **Official Repository:** `https://github.com/Pratyushsharma28/Castora-Pro`

---

## Functionality Status (Truthful Ledger)

| Area | Status | Notes |
| :--- | :--- | :--- |
| Phase 1 Documentation (`README.md`, `.gitignore`, Architecture, 15-Phase Roadmap, Testing Strategy) | **Implemented** | Completed in Phase 1 |
| Signaling Protocol (`castora.v1`), Draft 2020-12 JSON Schema, 37 Valid/Invalid Fixtures & `npm run test:protocol` | **Implemented & Validated** | Automated Ajv schema validation passes all 16 valid and 21 invalid fixtures |
| Cross-Platform Protocol Guide (`docs/PROTOCOL_IMPLEMENTATION.md`) | **Implemented** | Swift `Codable` and Kotlin `kotlinx.serialization` reference models |
| Native macOS App (`ScreenCaptureKit`, `VideoToolbox`, `Bonjour`, SwiftUI) | **Planned** | Starts in Phase 3 |
| Native Android & Android TV App (`MediaProjection`, `MediaCodec`, `NSD`, Compose) | **Planned** | Starts in Phase 4 |
| WebRTC Media Engine, Multi-Stream Grid, QR Pairing & Real `RTCStatsReport` Metrics | **Planned** | Starts in Phases 7–14 |
| Native Device & Cross-Platform Streaming Tests | **Not Yet Tested** | No native Swift/Kotlin apps or WebRTC engine exist yet |

---

## Product Goals

1. **Cross-platform casting:** macOS ↔ macOS, macOS → Android TV, Android phone → macOS, Android TV → macOS.
2. **Multi-stream topologies:** One sender to multiple receivers (`1:N`), multiple senders to one receiver (`N:1`), multi-screen grid layout, and per-stream fullscreen viewing.
3. **Zero-configuration LAN discovery & secure pairing:** Bonjour (`_castora._tcp`) on macOS + Network Service Discovery (NSD) on Android, QR-code and room-code pairing with temporary credentials, explicit receiver approval, and clean disconnection.
4. **Real performance:** Target up to **1080p @ 60 FPS** with adaptive bitrate and resolution when hardware and network support it, displaying only real WebRTC `RTCStatsReport` metrics (FPS, bitrate, RTT, dropped frames, latency).

---

## Core Documentation

- **[`docs/PROJECT_ARCHITECTURE.md`](docs/PROJECT_ARCHITECTURE.md)** — Overall system design, macOS & Android/TV architectures, WebRTC media pipeline, signaling protocol, Bonjour/NSD discovery, QR/room-code pairing, security, multi-stream design, real performance measurement, and technical risks.
- **[`docs/SIGNALING_PROTOCOL.md`](docs/SIGNALING_PROTOCOL.md)** — Full `castora.v1` 16-message signaling specification and envelope rules.
- **[`docs/PROTOCOL_IMPLEMENTATION.md`](docs/PROTOCOL_IMPLEMENTATION.md)** — Swift (`Codable`) and Kotlin (`kotlinx.serialization`) implementation patterns, unknown-field handling, and version checks.
- **[`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md)** — Complete **15-phase** development plan, phase dependencies, deliverables, and exit gates.
- **[`docs/TESTING_STRATEGY.md`](docs/TESTING_STRATEGY.md)** — Unit, integration, macOS, Android phone, Android TV, cross-platform, network interruption, performance, and release testing strategy.
- **[`.gitignore`](.gitignore)** — Ignore patterns for macOS/Xcode, Android/Gradle, local environment secrets, and workspace build artifacts.

---

## Repository Structure

```text
Castora-Pro/
├── README.md
├── .gitignore
├── package.json
├── docs/
│   ├── PROJECT_ARCHITECTURE.md       # Complete technical architecture & risk analysis
│   ├── DEVELOPMENT_ROADMAP.md        # 15-phase build plan & dependency map
│   ├── TESTING_STRATEGY.md           # Multi-platform & network testing plan
│   ├── SIGNALING_PROTOCOL.md         # castora.v1 16-message signaling specification
│   └── PROTOCOL_IMPLEMENTATION.md    # Swift Codable & Kotlin kotlinx.serialization guide
├── protocol/
│   ├── castora-protocol.schema.json  # JSON Schema (Draft 2020-12)
│   └── fixtures/                     # 16 valid + 21 invalid JSON test fixtures
├── scripts/
│   └── validate-protocol.mjs         # Automated Ajv Draft 2020-12 validator (`npm run test:protocol`)
├── macos/                            # Planned (Phase 3+): Native Swift/SwiftUI Xcode project
└── android/                          # Planned (Phase 4+): Native Kotlin/Compose Android & TV project
```
