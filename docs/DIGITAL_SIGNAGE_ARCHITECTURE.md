# Castora Pro — Digital Signage & Autonomous Media Player Architecture

This document explains how Castora Pro's **Digital Signage / Media Player** feature is structured, how it remains completely independent of live WebRTC screen casting, and what trade-offs exist between the browser/PWA player running on a **Haier Google TV** versus a native Android TV APK.

---

## 1. Castora Components Reused vs. New Signage Subsystems

### Reused from Existing Castora Pro
- **Express HTTP Server & Security Utilities (`server.ts`, `apps/server/security.ts`)**: Shared Express server entry point on port 3000, sliding-window IP rate limiters (`SlidingWindowRateLimiter`), and constant-time secret verification (`verifyConstantTimeSecret`).
- **Device Identity & Platform Normalization (`apps/server/roomManager.ts`, `apps/web/src/services/browserCapabilities.ts`)**: `normalizeDeviceType`, `CastoraPlatform` (`macos`, `android`, `android-tv`), persistent browser `deviceId`, and `WakeLock` management (`CastoraWakeLockController`).
- **Design System & Control Center Chrome (`TopControlBar.tsx`, `MobileReceiverBar.tsx`, `SignalBadge.tsx`)**: Same surface tokens (`#F5F7FB`, `#FFFFFF`, `#E2E8F0`, `#2563EB`), typography, and navigation layout without altering existing WebRTC rooms (`MAX_RECEIVERS_PER_ROOM = 6`), signaling (`/castora`), or `protocol/castora-protocol.schema.json`.
- **Optional Enrollment Bridge**: Already-paired TVs in an active live casting room can be enrolled into Digital Signage with one click ("Enroll room TVs" in `DigitalSignageView.tsx`), creating autonomous signage screen registrations without tying signage playback to the WebRTC room lifecycle.

### New Subsystems Added for Digital Signage
- **Persistent Object Storage (`apps/server/objectStorage.ts`)**:
  - `S3ObjectStorage` (`@aws-sdk/client-s3`) supporting AWS S3, Cloudflare R2, Backblaze B2, and MinIO via `CASTORA_S3_*` environment variables, with native HTTP byte-range reads in a single `GetObjectCommand` round-trip (eliminating redundant `HeadObjectCommand` calls under 15-screen fan-out).
  - `LocalDiskObjectStorage` for local development (`NODE_ENV !== 'production'` or explicit `CASTORA_LOCAL_STORAGE_DIR` when attached to a Render persistent disk).
  - `UnconfiguredProductionObjectStorage` guard in production (`NODE_ENV=production`) when neither S3 nor an explicit persistent disk directory is configured—explicitly rejecting ephemeral container writes with `503 STORAGE_NOT_CONFIGURED`.
- **Relational Persistence & Migrations (`apps/server/signageDatabase.ts`)**:
  - Dual repository implementation behind `SignageStore`:
    - `PostgresSignageRepository` (`pg` Pool, default `max: 20` configurable via `CASTORA_PG_POOL_MAX`) when `CASTORA_DATABASE_URL` or `DATABASE_URL` is configured (recommended for Render production).
    - `SqliteSignageRepository` using Node 22 built-in `node:sqlite` (`DatabaseSync` with WAL, `busy_timeout = 5000`, and foreign keys) for local/disk-backed deployments.
  - Tracked idempotent schema migrations (`signage_migrations`: `001_initial_signage`, `002_capacity_15_and_indexes`) safely upgrade legacy 7-screen or 12-screen databases to `MAX_SIGNAGE_SCREENS = 15`, preserve all existing screens and playlist assignments, support atomic slot allocation/reuse (`1..15`), add composite indexes, and batch-hydrate screens without N+1 queries.
  - Schema tables: `signage_migrations`, `signage_workspaces`, `signage_media`, `signage_playlists`, `signage_playlist_items`, `signage_screens`, `signage_device_cache`.
- **Signage HTTP & SSE API (`apps/server/signageRoutes.ts`)**:
  - Supports up to **15 independent screens** per workspace (`MAX_SIGNAGE_SCREENS = 15`), rejecting a 16th screen with `409 SIGNAGE_CAPACITY_REACHED`, while keeping WebRTC live casting at `MAX_RECEIVERS_PER_ROOM = 6`.
  - Streaming multipart uploads (`busboy`) via temporary staging files with SHA-256 hashing, magic-byte file signature inspection (`detectMediaSignatureFromHeader`), and strict extension/MIME allowlisting (`JPG/JPEG`, `PNG`, `WebP`, `GIF`, `MP4`, `WebM`, `MOV`).
  - Authenticated binary media streaming (`/api/signage/media/:mediaId/content`) supporting `ETag` (`304 Not Modified`), HTTP `Accept-Ranges: bytes` (`206 Partial Content`), and a server-side concurrent stream semaphore (`CASTORA_SIGNAGE_MAX_CONCURRENT_STREAMS`, default `6`, returning `503 SERVICE_BUSY` + `Retry-After: 3` after queue timeout so 15 TVs caching simultaneously never exhaust Node memory or S3 sockets).
  - Separate bearer tokens for Host Workspace (`hostToken` hashed via SHA-256 in DB) and each TV Screen (`screenToken` hashed via SHA-256 in DB), Server-Sent Events (`/api/signage/events`, capped subscriber pool with `X-Accel-Buffering: no`), and NAT-friendly player claim bursts (`35`/min/IP).
- **TV Offline Cache & Playback Engine (`apps/web/src/services/signageCacheService.ts`, `signagePlaybackEngine.ts`)**:
  - `IndexedDB` (`castora-signage-offline-v1`) stores manifests and media `Blob` payloads verified against server SHA-256 checksums, retries transient `503 Retry-After` download bursts cleanly with jittered backoff, requests `navigator.storage.persist()`, prunes unused old media, and pools `blob:` URLs via `ObjectUrlPool` to prevent memory growth over 6–7+ hour loops.
  - `SignagePlaybackEngine` manages mixed image timers, video completion (`ended`), per-item repeat counts, continuous playlist looping, playback commands (`play`/`pause`/`stop`), stall recovery, and corrupt-item skip without failing on network drops.
- **PWA Offline Shell (`apps/web/vite.config.ts`, `apps/web/public/*`)**:
  - `vite-plugin-pwa` with Workbox precaching so the Signage Player shell (`/?view=signage-player`) can launch and boot even if the TV starts offline or reloads after temporary network loss.

---

## 2. Why Autonomous 6–7+ Hour Playback Works Without the Host MacBook

1. **Zero MacBook Dependency**: Uploaded assets live in durable object storage (`S3`/`R2` or mounted persistent disk) and metadata/assignments live in PostgreSQL/SQLite. Once the host clicks **Assign & Start** and closes their MacBook lid, the TV continues autonomously.
2. **Zero WebRTC Dependency**: Live casting uses ephemeral peer-to-peer WebRTC tracks (`getDisplayMedia`), which stop if the Mac sleeps or the browser/network drops. Digital Signage never uses WebRTC—TVs download media over HTTPS and play directly from local IndexedDB blobs (`blob:` URLs).
3. **Resilience to Internet Drops**: Before playing offline, the TV caches playlist media into IndexedDB (`syncPlaylistMediaCache`) and persists the latest playlist manifest (`saveOfflineManifest`). If the Render server or Wi-Fi drops temporarily during hours 1–7, `SignagePlaybackEngine` continues looping from IndexedDB and silently resumes telemetry/manifest sync when connectivity returns.

---

## 3. Haier Google TV Browser / PWA Capabilities vs. Native Android TV APK

### What the Browser / PWA Player on Haier Google TV Can Do
- Install as a standalone PWA (or open fullscreen via `/?view=signage-player&screen=XXXXXX`) without needing Play Store deployment.
- Cache images and MP4/WebM videos locally in IndexedDB with SHA-256 integrity checks and play continuously for hours from local `blob:` URLs while offline.
- Request `navigator.storage.persist()`, keep the screen awake while active via Wake Lock (`navigator.wakeLock`), decode H.264 MP4 smoothly via hardware `<video>` decoding, and recover from video stalls or transient decode errors automatically.

### Real Browser & OS Limitations on Haier Google TV (Not Solved by a Browser App Alone)
1. **No Auto-Launch on Power-On (`BOOT_COMPLETED`)**: Android TV browsers/PWAs cannot register a system boot receiver to launch fullscreen automatically after a TV power outage or AC cycle. A TV user must open the browser/PWA once manually (or trigger it via ADB/launcher).
2. **OS Background Kill & Memory Reclamation**: Google TV devices typically ship with 1.5–2 GB RAM and aggressive Low Memory Killer (LMK) / Doze policies. If the user presses Home, switches HDMI input, or Android reclaims Chrome/WebView RAM, the browser stops until reopened.
3. **Storage Eviction Risk & Tighter Browser Quotas**: Even with `navigator.storage.persist()`, Chrome/WebView on low-storage TVs caps origin storage relative to available flash space (usually a fraction of free disk, e.g., a few hundred MB to a couple GB) and can still evict cache if the OS critically runs out of storage.
4. **Codec & Hardware Surface Constraints**: Browser `<video>` support depends on the TV WebView/Chrome build; 4K 60fps HEVC or high-bitrate 10-bit files can stutter compared to ExoPlayer/MediaCodec direct surface rendering, and seamless zero-black-frame video-to-video gapless transitions are harder with single `<video>` DOM elements.

### What Would Require a Native Android TV APK (Kotlin + Media3/ExoPlayer)
- `RECEIVE_BOOT_COMPLETED` kiosk launcher / auto-start after power loss.
- Foreground `Service` / WorkManager background media pre-fetcher downloading large MP4 assets (`FileOutputStream` in app private internal/external storage immune to browser cache eviction).
- AndroidX **Media3 (`ExoPlayer`)** with `SurfaceView`, seamless dual-decoder playlist pre-buffering, hardware HEVC/H.264 surface output, and HDMI-CEC / kiosk LockTask mode (Device Owner).
- Note: Any future native Android TV APK can reuse the exact same `/api/signage/player/claim`, `/api/signage/player/manifest`, `/api/signage/media/:id/content` (with HTTP Range resume), `/api/signage/player/sync`, and `/api/signage/events` endpoints unchanged.
