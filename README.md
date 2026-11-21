# Castora

Castora is a cross-platform, local-network-first screen-casting system built with native **macOS** (Swift / SwiftUI) and **Android & Android TV** (Kotlin / Jetpack Compose) applications, powered by **WebRTC** with **DTLS-SRTP** encryption.

> **Project Stage:** Phase 1 — Repository Inspection & Core Documentation  
> **Repository Checked:** `https://github.com/Pratyushsharma28/Castora` (confirmed empty at project start)

---

## Functionality Status (Truthful Ledger)

| Area | Status | Notes |
| :--- | :--- | :--- |
| Phase 1 Documentation (`README.md`, `.gitignore`, Architecture, 15-Phase Roadmap, Testing Strategy) | **Implemented** | Written and ready for Phase 1 review |
| Signaling JSON Schema (`protocol/castora-protocol.schema.json`) & Spec (`docs/SIGNALING_PROTOCOL.md`) | **Implemented (Draft v1.0)** | Supporting contract draft for upcoming Phase 2 validation |
| Native macOS App (`ScreenCaptureKit`, `VideoToolbox`, `Bonjour`, SwiftUI) | **Planned** | Starts in Phase 3 |
| Native Android & Android TV App (`MediaProjection`, `MediaCodec`, `NSD`, Compose) | **Planned** | Starts in Phase 4 |
| WebRTC Media Engine, Multi-Stream Grid, QR Pairing & Real `RTCStatsReport` Metrics | **Planned** | Starts in Phases 7–14 |
| Device & Cross-Platform Tests | **Not Yet Tested** | No native app code exists yet |

---

## Product Goals

1. **Cross-platform casting:** macOS ↔ macOS, macOS → Android TV, Android phone → macOS, Android TV → macOS.
2. **Multi-stream topologies:** One sender to multiple receivers (`1:N`), multiple senders to one receiver (`N:1`), multi-screen grid layout, and per-stream fullscreen viewing.
3. **Zero-configuration LAN discovery & secure pairing:** Bonjour (`_castora._tcp`) on macOS + Network Service Discovery (NSD) on Android, QR-code and room-code pairing with temporary credentials, explicit receiver approval, and clean disconnection.
4. **Real performance:** Target up to **1080p @ 60 FPS** with adaptive bitrate and resolution when hardware and network support it, displaying only real WebRTC `RTCStatsReport` metrics (FPS, bitrate, RTT, dropped frames, latency).

---

## Core Documentation

- **[`docs/PROJECT_ARCHITECTURE.md`](docs/PROJECT_ARCHITECTURE.md)** — Overall system design, macOS & Android/TV architectures, WebRTC media pipeline, signaling protocol, Bonjour/NSD discovery, QR/room-code pairing, security, multi-stream design, real performance measurement, and technical risks.
- **[`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md)** — Complete **15-phase** development plan, phase dependencies, deliverables, and exit gates.
- **[`docs/TESTING_STRATEGY.md`](docs/TESTING_STRATEGY.md)** — Unit, integration, macOS, Android phone, Android TV, cross-platform, network interruption, performance, and release testing strategy.
- **[`.gitignore`](.gitignore)** — Ignore patterns for macOS/Xcode, Android/Gradle, local environment secrets, and workspace build artifacts.

---

## Planned Repository Structure

```text
Castora/
├── README.md
├── .gitignore
├── docs/
│   ├── PROJECT_ARCHITECTURE.md    # Complete technical architecture & risk analysis
│   ├── DEVELOPMENT_ROADMAP.md     # 15-phase build plan & dependency map
│   ├── TESTING_STRATEGY.md        # Multi-platform & network testing plan
│   └── SIGNALING_PROTOCOL.md      # Draft castora.v1 JSON message details
├── protocol/
│   └── castora-protocol.schema.json  # Shared JSON Schema draft
├── macos/                         # Planned (Phase 3+): Native Swift/SwiftUI Xcode project
└── android/                       # Planned (Phase 4+): Native Kotlin/Compose Android & TV project
```
