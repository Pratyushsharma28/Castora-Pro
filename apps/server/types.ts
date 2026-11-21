import type { WebSocket } from 'ws';

export type CastoraPlatform = 'macos' | 'android' | 'android-tv';
export type CastoraDeviceRole = 'sender' | 'receiver' | 'both';
export type CastoraVideoCodec = 'H264' | 'HEVC' | 'VP8' | 'VP9' | 'AV1';
export type PairingMethod = 'qr' | 'room_code' | 'manual_ip';

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
  pairingMethod: PairingMethod;
  tokenHash: string;
  connected: boolean;
  requestedAt: number;
  sessionId: string;
}

export interface PairedReceiverMember {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
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
  startedAt: string;
}

export interface CastoraRoom {
  roomId: string;
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  hostTokenHash: string;
  hostConnected: boolean;
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
  pairingMethod: PairingMethod;
  connected: boolean;
  requestedAt: string;
  sessionId: string;
}

export interface PublicPairedReceiver {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  connected: boolean;
  assignedSlotIndex: number;
  pairedAt: string;
  sessionId: string;
}

export interface PublicRoomSnapshot {
  roomId: string;
  status: 'active' | 'closed' | 'expired';
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  hostConnected: boolean;
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
  timestamp: string;
}
