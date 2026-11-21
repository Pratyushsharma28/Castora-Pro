import type { WebSocket } from 'ws';

export type CastoraPlatform = 'macos' | 'android' | 'android-tv';
export type CastoraDeviceRole = 'sender' | 'receiver' | 'both';
export type CastoraVideoCodec = 'H264' | 'HEVC' | 'VP8' | 'VP9' | 'AV1';

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

export interface RoomMember {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  role: 'host' | 'receiver';
  tokenHash: string;
  connected: boolean;
  joinedAt: number;
  lastSeenAt: number;
  assignedSlotIndex: number | null;
}

export interface CastoraRoom {
  roomId: string;
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  hostTokenHash: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  maxReceivers: number;
  members: Map<string, RoomMember>;
}

export interface PublicRoomSnapshot {
  roomId: string;
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  createdAt: string;
  expiresAt: string;
  maxReceivers: number;
  activeReceiverCount: number;
  members: Array<{
    deviceId: string;
    deviceName: string;
    platform: CastoraPlatform;
    role: 'host' | 'receiver';
    connected: boolean;
    assignedSlotIndex: number | null;
  }>;
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
