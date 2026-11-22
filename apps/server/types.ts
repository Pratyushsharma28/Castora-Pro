import type { WebSocket } from 'ws';

export type CastoraPlatform = 'macos' | 'android' | 'android-tv';
export type DetectedDeviceType =
  | 'Mac'
  | 'Windows'
  | 'Linux'
  | 'iPad'
  | 'iPhone'
  | 'Android'
  | 'TV'
  | 'Chromebook'
  | 'Unknown';
export type CastoraDeviceRole = 'sender' | 'receiver' | 'both';
export type CastoraVideoCodec = 'H264' | 'HEVC' | 'VP8' | 'VP9' | 'AV1';
export type PairingMethod = 'qr' | 'room_code' | 'manual_ip';
export type RoomPrivacyMode = 'private' | 'approval_required' | 'open';

export interface PendingHostTransfer {
  transferId: string;
  fromHostDeviceId: string;
  targetDeviceId: string;
  targetDeviceName: string;
  initiatedAt: number;
  expiresAt: number;
}

export interface PublicHostTransfer {
  transferId: string;
  fromHostDeviceId: string;
  targetDeviceId: string;
  targetDeviceName: string;
  initiatedAt: string;
  expiresAt: string;
}

export interface DeviceCapabilities {
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  codecs: CastoraVideoCodec[];
  supportsAudio: boolean;
}

export interface RegisteredDevice {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType: DetectedDeviceType;
  role: CastoraDeviceRole;
  wsPort: number;
  capabilities: DeviceCapabilities;
  socket: WebSocket;
  remoteAddress: string;
  connectedAt: number;
  lastSeenAt: number;
  roomId: string | null;
}

export interface PendingPairRequest {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType: DetectedDeviceType;
  pairingMethod: PairingMethod;
  tokenHash: string;
  connected: boolean;
  requestedAt: number;
  lastSeenAt: number;
  sessionId: string;
}

export interface PairedReceiverMember {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType: DetectedDeviceType;
  tokenHash: string;
  connected: boolean;
  assignedSlotIndex: number;
  pairedAt: number;
  lastSeenAt: number;
  sessionId: string;
}

export interface ActiveRoomStream {
  streamId: string;
  sessionId: string;
  publisherDeviceId: string;
  publisherName: string;
  publisherPlatform: CastoraPlatform;
  targetDeviceId: string;
  width: number;
  height: number;
  fps: number;
  codec: CastoraVideoCodec;
  hasAudio?: boolean;
  startedAt: number;
}

export interface PublicActiveStream {
  streamId: string;
  sessionId: string;
  publisherDeviceId: string;
  publisherName: string;
  publisherPlatform: CastoraPlatform;
  targetDeviceId: string;
  width: number;
  height: number;
  fps: number;
  codec: CastoraVideoCodec;
  hasAudio?: boolean;
  startedAt: string;
}

export interface CastoraRoom {
  roomId: string;
  roomName: string;
  privacyMode: RoomPrivacyMode;
  passwordHash: string | null;
  inviteCode: string;
  pendingHostTransfer: PendingHostTransfer | null;
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  hostDeviceType: DetectedDeviceType;
  hostTokenHash: string;
  hostConnected: boolean;
  hostLastSeenAt: number;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  maxReceivers: number;
  pendingRequests: Map<string, PendingPairRequest>;
  pairedReceivers: Map<string, PairedReceiverMember>;
  activeStreams: Map<string, ActiveRoomStream>;
}

export interface PublicPendingRequest {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType: DetectedDeviceType;
  pairingMethod: PairingMethod;
  connected: boolean;
  requestedAt: string;
  lastSeenAt: string;
  sessionId: string;
}

export interface PublicPairedReceiver {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType: DetectedDeviceType;
  connected: boolean;
  assignedSlotIndex: number;
  pairedAt: string;
  lastSeenAt: string;
  sessionId: string;
}

export interface PublicRoomSnapshot {
  roomId: string;
  roomName: string;
  privacyMode: RoomPrivacyMode;
  passwordProtected: boolean;
  hostTransfer: PublicHostTransfer | null;
  status: 'active' | 'closed' | 'expired';
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  hostDeviceType: DetectedDeviceType;
  hostConnected: boolean;
  hostLastSeenAt: string;
  createdAt: string;
  expiresAt: string;
  maxReceivers: number;
  activeReceiverCount: number;
  pairedReceiverCount: number;
  pendingCount: number;
  pendingRequests: PublicPendingRequest[];
  pairedReceivers: PublicPairedReceiver[];
  activeStreams: PublicActiveStream[];
}

export interface BackendHealthStatus {
  status: 'ok';
  service: 'castora-pro-signaling';
  protocolVersion: 'castora.v1';
  transport: 'http+ws' | 'https+wss';
  httpsEnabled: boolean;
  wsPath: '/castora';
  uptimeSec: number;
  activeDevices: number;
  activeRooms: number;
  maxReceiversPerRoom: number;
  turnConfigured?: boolean;
  turnMode?: 'ephemeral-hmac' | 'static' | 'disabled';
  timestamp: string;
}
