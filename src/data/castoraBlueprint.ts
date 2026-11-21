export interface PlatformLayerRow {
  layer: string;
  macos: string;
  android: string;
  purpose: string;
}

export interface TopologySpec {
  id: 'one-to-one' | 'one-to-many' | 'many-to-one';
  title: string;
  subtitle: string;
  captureStrategy: string;
  signalingFlow: string;
  receiverLayout: string;
  steps: { actor: string; detail: string }[];
}

export interface ProtocolMessageSpec {
  type: string;
  direction: string;
  summary: string;
  requiredFields: string[];
  exampleJson: string;
}

export interface RoadmapPhase {
  phase: number;
  title: string;
  dependsOn: string;
  status: 'Implemented' | 'Planned';
  goal: string;
  exitGate: string;
}

export const ROADMAP_PHASES: RoadmapPhase[] = [
  {
    phase: 1,
    title: 'Repository Inspection & Core Documentation',
    dependsOn: 'None',
    status: 'Implemented',
    goal: 'Inspect empty GitHub repo, write README, .gitignore, PROJECT_ARCHITECTURE, 15-phase roadmap, and TESTING_STRATEGY.',
    exitGate: 'All Phase 1 docs reviewed and committed cleanly to GitHub.',
  },
  {
    phase: 2,
    title: 'Shared Signaling Protocol (castora.v1) & Test Fixtures',
    dependsOn: 'Phase 1',
    status: 'Planned',
    goal: 'Finalize castora.v1 schema and shared valid/invalid JSON test fixtures for Swift and Kotlin.',
    exitGate: 'Schema validation passes all valid fixtures and rejects malformed credentials.',
  },
  {
    phase: 3,
    title: 'Native macOS Project Bootstrap & Permissions Shell',
    dependsOn: 'Phase 1',
    status: 'Planned',
    goal: 'Create Xcode SwiftUI project with Info.plist local network/Bonjour keys and Screen Recording preflight.',
    exitGate: 'macOS app compiles cleanly and detects Screen Recording permission status.',
  },
  {
    phase: 4,
    title: 'Native Android & Android TV Bootstrap & Permissions Shell',
    dependsOn: 'Phase 1',
    status: 'Planned',
    goal: 'Create Kotlin Jetpack Compose app supporting Phone touch and Android TV Leanback D-Pad navigation.',
    exitGate: 'Compiles and launches on both Android phone and Android TV emulators/devices.',
  },
  {
    phase: 5,
    title: 'Local Network Discovery (Bonjour & Android NSD)',
    dependsOn: 'Phases 2, 3, 4',
    status: 'Planned',
    goal: 'Implement _castora._tcp advertising and browsing via Network.framework and NsdManager.',
    exitGate: 'macOS and Android/TV discover each other on the same Wi-Fi LAN.',
  },
  {
    phase: 6,
    title: 'Local WebSocket Signaling & Handshake Interop',
    dependsOn: 'Phases 2, 5',
    status: 'Planned',
    goal: 'Implement local WebSocket servers and clients exchanging castora.v1 JSON envelopes.',
    exitGate: 'macOS and Android exchange valid JSON envelopes and heartbeats cleanly.',
  },
  {
    phase: 7,
    title: 'QR-Code & Room-Code Pairing + Receiver Approval',
    dependsOn: 'Phase 6',
    status: 'Planned',
    goal: 'Implement temporary 6-char room codes, 128-bit tokens, castora:// QR codes, and approval modal.',
    exitGate: 'Invalid tokens rejected; approved sessions advance; disconnect revokes access.',
  },
  {
    phase: 8,
    title: 'macOS ScreenCaptureKit & VideoToolbox Pipeline',
    dependsOn: 'Phase 3',
    status: 'Planned',
    goal: 'Capture display/window frames with ScreenCaptureKit and wire hardware VideoToolbox encoding.',
    exitGate: 'macOS captures cleanly up to 1080p60 and releases SCStream on stop.',
  },
  {
    phase: 9,
    title: 'Android & TV MediaProjection & MediaCodec Pipeline',
    dependsOn: 'Phase 4',
    status: 'Planned',
    goal: 'Implement MediaProjection consent, Android 14+ Foreground Service, VirtualDisplay, and MediaCodec.',
    exitGate: 'Android starts/stops capture cleanly with active foreground notification.',
  },
  {
    phase: 10,
    title: 'WebRTC 1:1 Media Transport, DTLS-SRTP & Adaptive Bitrate',
    dependsOn: 'Phases 7, 8, 9',
    status: 'Planned',
    goal: 'Wire SDP/ICE over signaling with DTLS-SRTP encryption and GCC adaptive bitrate up to 1080p60.',
    exitGate: 'Real 1:1 encrypted WebRTC video stream renders smoothly over LAN.',
  },
  {
    phase: 11,
    title: 'Real Telemetry & Performance Measurement (RTCStatsReport)',
    dependsOn: 'Phase 10',
    status: 'Planned',
    goal: 'Query live RTCStatsReport snapshots for true FPS, bitrate, RTT, dropped frames, and latency.',
    exitGate: 'Stats reflect live WebRTC counters only and clear cleanly on disconnect.',
  },
  {
    phase: 12,
    title: 'Cross-Platform 1:1 Matrix Verification',
    dependsOn: 'Phases 10, 11',
    status: 'Planned',
    goal: 'Verify macOS↔macOS, macOS→Android TV, Android phone→macOS, and Android TV→macOS on real hardware.',
    exitGate: 'All 4 device combinations pair, stream, measure telemetry, and disconnect.',
  },
  {
    phase: 13,
    title: 'Multi-Receiver Broadcasting (1:N)',
    dependsOn: 'Phase 12',
    status: 'Planned',
    goal: 'Share one captured VideoTrack across N independent RTCPeerConnections with per-peer adaptation.',
    exitGate: 'One Sender casts simultaneously to 2+ Receivers without duplicate capture.',
  },
  {
    phase: 14,
    title: 'Multi-Sender Grid View & Fullscreen Switching (N:1)',
    dependsOn: 'Phase 12',
    status: 'Planned',
    goal: 'Render multiple approved Senders in an adaptive grid with per-tile fullscreen controls.',
    exitGate: '2+ Senders display concurrently in grid and switch to fullscreen cleanly.',
  },
  {
    phase: 15,
    title: 'Network Resilience, Hardening & Release Verification',
    dependsOn: 'Phases 13, 14',
    status: 'Planned',
    goal: 'Test Wi-Fi drops, sleep/wake, decoder limits, and execute full TESTING_STRATEGY release audit.',
    exitGate: 'All release checks pass on real hardware with reproducible build instructions.',
  },
];

export const REPO_FILES = [
  { path: 'README.md', role: 'Project overview, status ledger, and documentation index' },
  { path: '.gitignore', role: 'Ignore rules for macOS/Xcode, Android/Gradle, keystores, and workspace' },
  { path: 'docs/PROJECT_ARCHITECTURE.md', role: 'System architecture, macOS/Android/TV, WebRTC, security, and risks' },
  { path: 'docs/DEVELOPMENT_ROADMAP.md', role: 'Complete 15-phase roadmap and dependency graph' },
  { path: 'docs/TESTING_STRATEGY.md', role: 'Unit, integration, device, network, performance, and release testing' },
  { path: 'docs/SIGNALING_PROTOCOL.md', role: 'Draft castora.v1 JSON message formats & QR URI specification' },
  { path: 'protocol/castora-protocol.schema.json', role: 'Draft JSON Schema (2020-12) shared by Swift & Kotlin' },
];

export const PLATFORM_STACK: PlatformLayerRow[] = [
  {
    layer: 'UI & Language',
    macos: 'Swift, SwiftUI',
    android: 'Kotlin, Jetpack Compose (Touch + TV D-Pad)',
    purpose: 'Native desktop windowing, menu controls, phone touch, and 10-foot TV focus navigation.',
  },
  {
    layer: 'LAN Discovery',
    macos: 'Bonjour (NWBrowser / NWListener, _castora._tcp)',
    android: 'Android Network Service Discovery (NsdManager)',
    purpose: 'Zero-configuration local network discovery without requiring a permanent cloud server.',
  },
  {
    layer: 'Signaling Transport',
    macos: 'Local WebSocket (Network.framework / URLSession)',
    android: 'Local WebSocket (Ktor CIO / OkHttp)',
    purpose: 'Exchanges interoperable castora.v1 JSON envelopes on ws://<lan-ip>:<port>/castora.',
  },
  {
    layer: 'Screen Capture',
    macos: 'ScreenCaptureKit (SCStream, SCContentFilter)',
    android: 'MediaProjection + VirtualDisplay + Foreground Service',
    purpose: 'Captures display or window frames with OS-level permission consent.',
  },
  {
    layer: 'Hardware Codec',
    macos: 'VideoToolbox (H.264 High / HEVC)',
    android: 'MediaCodec (HardwareVideoEncoderFactory)',
    purpose: 'Hardware-accelerated encoding and decoding targeting up to 1080p at 60 FPS.',
  },
  {
    layer: 'Media Transport',
    macos: 'WebRTC (DTLS-SRTP, LAN host ICE candidates)',
    android: 'WebRTC (DTLS-SRTP, LAN host ICE candidates)',
    purpose: 'Encrypted direct peer-to-peer RTP media with GCC adaptive bitrate and RTCStatsReport.',
  },
];

export const TOPOLOGIES: TopologySpec[] = [
  {
    id: 'one-to-one',
    title: 'Direct Cross-Platform Cast (1:1)',
    subtitle: 'macOS ↔ macOS, macOS → Android TV, Android → macOS, Android TV → macOS',
    captureStrategy: 'Single capture stream encoded once via VideoToolbox or MediaCodec.',
    signalingFlow: '1 WebSocket session on LAN; explicit receiver approval before SDP offer.',
    receiverLayout: 'Single stage view with instant fullscreen toggle and real RTCStatsReport inspector.',
    steps: [
      { actor: 'Receiver', detail: 'Advertises _castora._tcp via Bonjour/NSD and displays Room Code + QR URI.' },
      { actor: 'Sender', detail: 'Resolves LAN IP/port, opens WebSocket, and sends pair_request with temporary token.' },
      { actor: 'Receiver', detail: 'Prompts user to approve or decline; returns pair_approval with assignedStreamId.' },
      { actor: 'Peers', detail: 'Exchange sdp_offer, sdp_answer, and local host ice_candidate messages.' },
      { actor: 'Media', detail: 'Direct DTLS-SRTP WebRTC stream starts over LAN, adapting up to 1080p60.' },
    ],
  },
  {
    id: 'one-to-many',
    title: 'One Sender → Multiple Receivers (1:N)',
    subtitle: 'Broadcast one Mac or Android screen to several Macs or Android TVs simultaneously',
    captureStrategy: 'ScreenCaptureKit or MediaProjection captures once into one shared local VideoTrack.',
    signalingFlow: 'Sender connects to each approved Receiver independently over local WebSocket.',
    receiverLayout: 'Each Receiver adapts bitrate independently based on its own Wi-Fi/Ethernet link.',
    steps: [
      { actor: 'Sender', detail: 'Creates one local VideoSource / VideoTrack from a single screen capture session.' },
      { actor: 'Receivers', detail: 'Each Receiver independently validates its own room code, token, and user approval.' },
      { actor: 'Sender', detail: 'Spawns N separate RTCPeerConnection instances sharing the single VideoTrack.' },
      { actor: 'WebRTC', detail: 'GCC congestion control tunes each peer connection independently without re-capturing.' },
    ],
  },
  {
    id: 'many-to-one',
    title: 'Multiple Senders → One Receiver (N:1 Grid)',
    subtitle: 'Combine multiple laptops and phones into one multi-screen grid on macOS or Android TV',
    captureStrategy: 'Each Sender captures and encodes its own screen locally.',
    signalingFlow: 'Receiver hosts one WebSocket server and assigns unique peerId + streamId per Sender.',
    receiverLayout: 'Adaptive grid (1x1, 2x1, 2x2, 3x2) with click/D-Pad fullscreen per tile.',
    steps: [
      { actor: 'Receiver', detail: 'Accepts multiple inbound pair_request sessions up to hardware decode limits.' },
      { actor: 'Receiver', detail: 'Assigns distinct stream_01, stream_02, ... identifiers and isolates each RTCPeerConnection.' },
      { actor: 'UI Grid', detail: 'Renders each decoded VideoTrack into an adaptive multi-screen tile.' },
      { actor: 'Fullscreen', detail: 'Focusing one tile emits stream_control (focus_fullscreen) and expands that stream.' },
    ],
  },
];

export const PROTOCOL_MESSAGES: ProtocolMessageSpec[] = [
  {
    type: 'pair_request',
    direction: 'Sender → Receiver',
    summary: 'Presents temporary room code, 128-bit session token, device metadata, and video capabilities.',
    requiredFields: ['roomCode', 'sessionToken', 'deviceName', 'platform', 'role', 'capabilities'],
    exampleJson: JSON.stringify(
      {
        version: '1.0',
        type: 'pair_request',
        messageId: 'a1b2c3d4-0001-4000-8000-000000000001',
        timestampMs: 1795176000100,
        senderPeerId: 'peer_mac_01',
        payload: {
          roomCode: 'K7M9P2',
          sessionToken: 'x9F3aL8qR2mV7nP4',
          deviceName: "Pratyush's MacBook Pro",
          platform: 'macos',
          role: 'sender',
          capabilities: {
            maxWidth: 1920,
            maxHeight: 1080,
            maxFps: 60,
            codecs: ['H264', 'HEVC'],
            supportsAudio: true,
          },
        },
      },
      null,
      2
    ),
  },
  {
    type: 'pair_approval',
    direction: 'Receiver → Sender',
    summary: 'Confirms explicit user approval, assigns streamId, and supplies ICE configuration.',
    requiredFields: ['approved', 'receiverName', 'receiverPlatform', 'assignedStreamId'],
    exampleJson: JSON.stringify(
      {
        version: '1.0',
        type: 'pair_approval',
        messageId: 'a1b2c3d4-0002-4000-8000-000000000002',
        timestampMs: 1795176002400,
        sessionId: 'sess_k7m9p2',
        senderPeerId: 'peer_tv_01',
        targetPeerId: 'peer_mac_01',
        payload: {
          approved: true,
          reason: null,
          receiverName: 'Living Room Android TV',
          receiverPlatform: 'android-tv',
          assignedStreamId: 'stream_01',
          iceConfig: { iceServers: [] },
        },
      },
      null,
      2
    ),
  },
  {
    type: 'sdp_offer',
    direction: 'Sender → Receiver',
    summary: 'Delivers WebRTC SDP offer containing DTLS fingerprint and hardware codec parameters.',
    requiredFields: ['streamId', 'sdp'],
    exampleJson: JSON.stringify(
      {
        version: '1.0',
        type: 'sdp_offer',
        messageId: 'a1b2c3d4-0003-4000-8000-000000000003',
        timestampMs: 1795176002600,
        sessionId: 'sess_k7m9p2',
        senderPeerId: 'peer_mac_01',
        targetPeerId: 'peer_tv_01',
        payload: {
          streamId: 'stream_01',
          sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n...',
        },
      },
      null,
      2
    ),
  },
  {
    type: 'ice_candidate',
    direction: 'Bidirectional',
    summary: 'Trickles LAN host ICE candidates so media flows directly without external TURN servers.',
    requiredFields: ['streamId', 'sdpMid', 'sdpMLineIndex', 'candidate'],
    exampleJson: JSON.stringify(
      {
        version: '1.0',
        type: 'ice_candidate',
        messageId: 'a1b2c3d4-0004-4000-8000-000000000004',
        timestampMs: 1795176002700,
        sessionId: 'sess_k7m9p2',
        senderPeerId: 'peer_mac_01',
        targetPeerId: 'peer_tv_01',
        payload: {
          streamId: 'stream_01',
          sdpMid: '0',
          sdpMLineIndex: 0,
          candidate: 'candidate:842163049 1 udp 1677729535 192.168.1.25 54321 typ host',
        },
      },
      null,
      2
    ),
  },
  {
    type: 'stream_control',
    direction: 'Bidirectional',
    summary: 'Requests grid/fullscreen transitions or pause/resume hints for multi-stream bandwidth control.',
    requiredFields: ['streamId', 'action'],
    exampleJson: JSON.stringify(
      {
        version: '1.0',
        type: 'stream_control',
        messageId: 'a1b2c3d4-0005-4000-8000-000000000005',
        timestampMs: 1795176010000,
        sessionId: 'sess_k7m9p2',
        senderPeerId: 'peer_tv_01',
        targetPeerId: 'peer_mac_01',
        payload: {
          streamId: 'stream_01',
          action: 'focus_fullscreen',
          targetMaxWidth: 1920,
          targetMaxHeight: 1080,
          targetMaxFps: 60,
        },
      },
      null,
      2
    ),
  },
  {
    type: 'disconnect',
    direction: 'Bidirectional',
    summary: 'Cleanly terminates the WebRTC peer connection, stops screen capture, and revokes credentials.',
    requiredFields: ['reason'],
    exampleJson: JSON.stringify(
      {
        version: '1.0',
        type: 'disconnect',
        messageId: 'a1b2c3d4-0007-4000-8000-000000000007',
        timestampMs: 1795176060000,
        sessionId: 'sess_k7m9p2',
        senderPeerId: 'peer_mac_01',
        targetPeerId: 'peer_tv_01',
        payload: {
          streamId: 'stream_01',
          reason: 'user_stopped_casting',
        },
      },
      null,
      2
    ),
  },
];
