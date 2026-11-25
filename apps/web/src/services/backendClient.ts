import {
  CASTORA_PROTOCOL_VERSION,
  type CastoraEnvelope,
  type CastoraMessageType,
  type CastoraPairingMethod,
  type CastoraPlatform,
  type DeviceCapabilities,
} from '../types/protocol';
import type { DetectedDeviceType, RoomPrivacyMode } from '../types/studio';

export type SignalingSocketState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type PairingLifecycleStatus =
  | 'Available'
  | 'Request pending'
  | 'Awaiting approval'
  | 'Paired'
  | 'Disconnected'
  | 'Rejected'
  | 'Expired';

export interface BackendHealthResponse {
  status: 'ok';
  service: string;
  protocolVersion: string;
  transport: 'http+ws' | 'https+wss';
  httpsEnabled: boolean;
  wsPath: string;
  uptimeSec: number;
  activeDevices: number;
  activeRooms: number;
  maxReceiversPerRoom: number;
  turnConfigured?: boolean;
  turnMode?: 'ephemeral-hmac' | 'static' | 'disabled';
  timestamp: string;
}

export interface BackendIceServersResponse {
  iceServers: RTCIceServer[];
  turnConfigured: boolean;
  turnMode: 'ephemeral-hmac' | 'static' | 'disabled';
  transports: Array<'udp' | 'tcp' | 'tls'>;
  ttlSeconds: number | null;
  expiresAt: string | null;
}

export interface PendingRequestInfo {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType?: DetectedDeviceType;
  pairingMethod: CastoraPairingMethod;
  connected: boolean;
  requestedAt: string;
  lastSeenAt?: string;
  sessionId: string;
}

export interface PairedReceiverInfo {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType?: DetectedDeviceType;
  connected: boolean;
  assignedSlotIndex: number;
  pairedAt: string;
  lastSeenAt?: string;
  sessionId: string;
}

export interface ActiveRoomStreamInfo {
  streamId: string;
  sessionId: string;
  publisherDeviceId: string;
  publisherName: string;
  publisherPlatform: CastoraPlatform;
  targetDeviceId: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  hasAudio?: boolean;
  startedAt: string;
}

export interface PublicHostTransfer {
  transferId: string;
  fromHostDeviceId: string;
  targetDeviceId: string;
  targetDeviceName: string;
  initiatedAt: string;
  expiresAt: string;
}

export interface RoomSnapshot {
  roomId: string;
  roomName?: string;
  privacyMode?: RoomPrivacyMode;
  passwordProtected?: boolean;
  hostTransfer?: PublicHostTransfer | null;
  status: 'active' | 'closed' | 'expired';
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  hostDeviceType?: DetectedDeviceType;
  hostConnected: boolean;
  hostLastSeenAt?: string;
  createdAt?: string;
  expiresAt: string;
  maxReceivers: number;
  activeReceiverCount: number;
  pairedReceiverCount: number;
  pendingCount: number;
  pendingRequests: PendingRequestInfo[];
  pairedReceivers: PairedReceiverInfo[];
  activeStreams?: ActiveRoomStreamInfo[];
}

export interface CreateRoomResponse {
  room: RoomSnapshot;
  hostToken: string;
  inviteCode: string;
}

export interface SubmitPairRequestResponse {
  room: RoomSnapshot;
  memberToken: string;
  sessionId: string;
  requestStatus: 'pending_approval' | 'paired';
  assignedSlotIndex?: number;
}

export interface RoomInvitationResponse {
  room: RoomSnapshot;
  inviteCode: string;
  privacyMode: RoomPrivacyMode;
  passwordProtected: boolean;
}

export interface ValidateInvitationResponse {
  room: RoomSnapshot;
  inviteValid: boolean;
  canRequestJoin: boolean;
  availableSlots: number;
}

export interface RestoreSessionResponse {
  room: RoomSnapshot;
  deviceId: string;
  role: 'host' | 'paired' | 'pending';
  inviteCode?: string;
}

function createMessageId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 14)
      : Math.random().toString(36).slice(2, 14);
  return `web-${random}`;
}

export async function fetchBackendHealth(): Promise<BackendHealthResponse> {
  const response = await fetch('/api/health', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Health check returned HTTP ${response.status}`);
  }
  return (await response.json()) as BackendHealthResponse;
}

export async function fetchBackendIceServers(params?: {
  roomId?: string | null;
  deviceId?: string | null;
  token?: string | null;
}): Promise<BackendIceServersResponse> {
  const query = new URLSearchParams();
  if (params?.roomId) query.set('roomId', params.roomId);
  if (params?.deviceId) query.set('deviceId', params.deviceId);
  const qs = query.toString();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (params?.token) {
    headers.Authorization = `Bearer ${params.token}`;
  }
  const response = await fetch(`/api/ice-servers${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers,
    cache: 'no-store',
  });
  const data = (await response.json()) as BackendIceServersResponse & { message?: string };
  if (!response.ok) {
    throw new Error(data.message ?? `Failed to load ICE servers (HTTP ${response.status})`);
  }
  return data;
}

export async function createBackendRoom(params: {
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  hostDeviceType?: DetectedDeviceType;
  roomName?: string;
  privacyMode?: RoomPrivacyMode;
  password?: string;
}): Promise<CreateRoomResponse> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    cache: 'no-store',
  });
  const data = (await response.json()) as CreateRoomResponse & { message?: string };
  if (!response.ok) {
    throw new Error(data.message ?? `Room creation failed (HTTP ${response.status})`);
  }
  return data;
}

export async function submitBackendPairRequest(params: {
  roomId: string;
  receiverDeviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  deviceType?: DetectedDeviceType;
  pairingMethod?: CastoraPairingMethod;
  inviteCode?: string;
  password?: string;
}): Promise<SubmitPairRequestResponse> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/pair-requests`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        receiverDeviceId: params.receiverDeviceId,
        deviceName: params.deviceName,
        platform: params.platform,
        deviceType: params.deviceType,
        pairingMethod: params.pairingMethod ?? 'room_code',
        ...(params.inviteCode ? { inviteCode: params.inviteCode } : {}),
        ...(params.password !== undefined && params.password !== ''
          ? { password: params.password }
          : {}),
      }),
    }
  );
  const data = (await response.json()) as SubmitPairRequestResponse & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    const baseMsg = data.message ?? `Failed to submit pairing request (HTTP ${response.status})`;
    throw new Error(
      data.error === 'ROOM_CAPACITY_REACHED' ? `ROOM_CAPACITY_REACHED: ${baseMsg}` : baseMsg
    );
  }
  return data;
}

export async function approveBackendPairRequest(params: {
  roomId: string;
  receiverDeviceId: string;
  hostToken: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/pair-requests/${encodeURIComponent(params.receiverDeviceId)}/approve`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.hostToken}`,
      },
    }
  );
  const data = (await response.json()) as {
    room?: RoomSnapshot;
    error?: string;
    message?: string;
  };
  if (!response.ok || !data.room) {
    const baseMsg = data.message ?? `Approval failed (HTTP ${response.status})`;
    throw new Error(
      data.error === 'ROOM_CAPACITY_REACHED' ? `ROOM_CAPACITY_REACHED: ${baseMsg}` : baseMsg
    );
  }
  return data.room;
}

export async function rejectBackendPairRequest(params: {
  roomId: string;
  receiverDeviceId: string;
  hostToken: string;
  reason?: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/pair-requests/${encodeURIComponent(params.receiverDeviceId)}/reject`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.hostToken}`,
      },
      body: JSON.stringify({ reason: params.reason }),
    }
  );
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Rejection failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function removeBackendReceiver(params: {
  roomId: string;
  receiverDeviceId: string;
  hostToken: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/receivers/${encodeURIComponent(params.receiverDeviceId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${params.hostToken}`,
      },
    }
  );
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Receiver removal failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function leaveBackendRoom(params: {
  roomId: string;
  deviceId: string;
  memberToken: string;
}): Promise<void> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/leave`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.memberToken}`,
      },
      body: JSON.stringify({ deviceId: params.deviceId }),
    }
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? `Failed to leave room (HTTP ${response.status})`);
  }
}

export async function fetchBackendRoom(roomId: string): Promise<RoomSnapshot> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Room lookup failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function closeBackendRoom(roomId: string, hostToken: string): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${hostToken}`,
    },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? `Failed to close room (HTTP ${response.status})`);
  }
}

export async function renameBackendRoom(params: {
  roomId: string;
  roomName: string;
  hostToken: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(params.roomId)}/name`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.hostToken}`,
    },
    body: JSON.stringify({ roomName: params.roomName }),
  });
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Room rename failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function updateBackendRoomSettings(params: {
  roomId: string;
  hostToken: string;
  roomName?: string;
  privacyMode?: RoomPrivacyMode;
  password?: string | null;
}): Promise<RoomSnapshot> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(params.roomId)}/settings`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.hostToken}`,
    },
    cache: 'no-store',
    body: JSON.stringify({
      ...(params.roomName !== undefined ? { roomName: params.roomName } : {}),
      ...(params.privacyMode !== undefined ? { privacyMode: params.privacyMode } : {}),
      ...(params.password !== undefined ? { password: params.password } : {}),
    }),
  });
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Room settings update failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function fetchBackendRoomInvitation(params: {
  roomId: string;
  hostToken: string;
}): Promise<RoomInvitationResponse> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(params.roomId)}/invitation`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${params.hostToken}`,
    },
    cache: 'no-store',
  });
  const data = (await response.json()) as RoomInvitationResponse & { message?: string };
  if (!response.ok || !data.inviteCode) {
    throw new Error(data.message ?? `Failed to load room invitation (HTTP ${response.status})`);
  }
  return data;
}

export async function rotateBackendRoomInvitation(params: {
  roomId: string;
  hostToken: string;
}): Promise<RoomInvitationResponse> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/invitation/rotate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.hostToken}`,
      },
      cache: 'no-store',
    }
  );
  const data = (await response.json()) as RoomInvitationResponse & { message?: string };
  if (!response.ok || !data.inviteCode) {
    throw new Error(data.message ?? `Failed to regenerate invitation link (HTTP ${response.status})`);
  }
  return data;
}

export async function validateBackendInvitation(params: {
  roomId: string;
  inviteCode?: string;
}): Promise<ValidateInvitationResponse> {
  const query = new URLSearchParams();
  if (params.inviteCode) {
    query.set('invite', params.inviteCode);
  }
  const qs = query.toString();
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/invitation/validate${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }
  );
  const data = (await response.json()) as ValidateInvitationResponse & { message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Invitation validation failed (HTTP ${response.status})`);
  }
  return data;
}

export class RestoreSessionError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'RestoreSessionError';
    this.status = status;
    this.code = code;
  }
}

export async function restoreBackendSession(params: {
  roomId: string;
  token: string;
}): Promise<RestoreSessionResponse> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(params.roomId)}/session`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    cache: 'no-store',
  });
  const data = (await response.json()) as RestoreSessionResponse & {
    message?: string;
    code?: string;
  };
  if (!response.ok || !data.room) {
    throw new RestoreSessionError(
      data.message ?? `Session restore failed (HTTP ${response.status})`,
      response.status,
      data.code
    );
  }
  return data;
}

export async function initiateBackendHostTransfer(params: {
  roomId: string;
  targetDeviceId: string;
  hostToken: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/host-transfer`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.hostToken}`,
      },
      body: JSON.stringify({ targetDeviceId: params.targetDeviceId }),
    }
  );
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Host transfer request failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function cancelBackendHostTransfer(params: {
  roomId: string;
  hostToken: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/host-transfer`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${params.hostToken}`,
      },
    }
  );
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Cancel host transfer failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function respondBackendHostTransfer(params: {
  roomId: string;
  accept: boolean;
  token: string;
}): Promise<{ room: RoomSnapshot; accepted: boolean; newHostDeviceId: string }> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/host-transfer/respond`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({ accept: params.accept }),
    }
  );
  const data = (await response.json()) as {
    room?: RoomSnapshot;
    accepted?: boolean;
    newHostDeviceId?: string;
    message?: string;
  };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Host transfer response failed (HTTP ${response.status})`);
  }
  return {
    room: data.room,
    accepted: Boolean(data.accepted),
    newHostDeviceId: data.newHostDeviceId ?? data.room.hostDeviceId,
  };
}

export async function renameBackendRoomDevice(params: {
  roomId: string;
  targetDeviceId: string;
  deviceName: string;
  token: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/devices/${encodeURIComponent(params.targetDeviceId)}/name`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({ deviceName: params.deviceName }),
    }
  );
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Device rename failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function stopBackendDeviceStream(params: {
  roomId: string;
  targetDeviceId: string;
  streamTargetDeviceId?: string;
  token: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/devices/${encodeURIComponent(params.targetDeviceId)}/stop-stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify(
        params.streamTargetDeviceId
          ? { streamTargetDeviceId: params.streamTargetDeviceId }
          : {}
      ),
    }
  );
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Stop stream failed (HTTP ${response.status})`);
  }
  return data.room;
}

export async function requestBackendDeviceReconnect(params: {
  roomId: string;
  targetDeviceId: string;
  token: string;
}): Promise<RoomSnapshot> {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(params.roomId)}/devices/${encodeURIComponent(params.targetDeviceId)}/reconnect`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
      },
    }
  );
  const data = (await response.json()) as { room?: RoomSnapshot; message?: string };
  if (!response.ok || !data.room) {
    throw new Error(data.message ?? `Reconnect request failed (HTTP ${response.status})`);
  }
  return data.room;
}

export interface SignalingHeartbeatTelemetry {
  socketState: SignalingSocketState;
  reconnectAttempt: number;
  lastReconnectAttemptAt: number | null;
  lastReconnectResult: string | null;
  lastHeartbeatSentAt: number | null;
  lastHeartbeatAckAt: number | null;
  consecutiveMissedHeartbeats: number;
}

export interface SignalingClientHandlers {
  onStateChange: (state: SignalingSocketState, detail?: string) => void;
  onEnvelope: (envelope: CastoraEnvelope) => void;
  onReconnectScheduled?: (attempt: number, maxAttempts: number, delayMs: number) => void;
  onTelemetryChange?: (telemetry: SignalingHeartbeatTelemetry) => void;
}

const WS_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_CONSECUTIVE_MISSED_HEARTBEATS = 3;

export class CastoraSignalingClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private sequence = 0;
  private pendingHeartbeatSinceAt: number | null = null;
  private telemetry: SignalingHeartbeatTelemetry = {
    socketState: 'disconnected',
    reconnectAttempt: 0,
    lastReconnectAttemptAt: null,
    lastReconnectResult: null,
    lastHeartbeatSentAt: null,
    lastHeartbeatAckAt: null,
    consecutiveMissedHeartbeats: 0,
  };
  private lastConnectParams: {
    deviceId: string;
    deviceName: string;
    platform: CastoraPlatform;
    deviceType?: DetectedDeviceType;
    capabilities: DeviceCapabilities;
    roomId: string | null;
    token?: string | null;
    heartbeatRole?: 'sender' | 'receiver';
    handlers: SignalingClientHandlers;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
  } | null = null;

  getTelemetry(): SignalingHeartbeatTelemetry {
    return { ...this.telemetry };
  }

  private emitTelemetry(handlers?: SignalingClientHandlers): void {
    (handlers ?? this.lastConnectParams?.handlers)?.onTelemetryChange?.({
      ...this.telemetry,
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  connect(params: {
    deviceId: string;
    deviceName: string;
    platform: CastoraPlatform;
    deviceType?: DetectedDeviceType;
    capabilities: DeviceCapabilities;
    roomId: string | null;
    token?: string | null;
    heartbeatRole?: 'sender' | 'receiver';
    handlers: SignalingClientHandlers;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
  }): void {
    this.clearReconnectTimer();
    this.lastConnectParams = params;
    this.disconnect(false);
    this.manualDisconnect = false;
    this.reconnectAttempt = 0;
    this.telemetry = {
      ...this.telemetry,
      reconnectAttempt: 0,
      consecutiveMissedHeartbeats: 0,
    };
    this.openSocket(params);
  }

  private openSocket(params: NonNullable<typeof this.lastConnectParams>): void {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams();
    if (params.token) qs.set('token', params.token);
    if (params.deviceType) qs.set('deviceType', params.deviceType);
    const querySuffix = qs.toString() ? `?${qs.toString()}` : '';
    const wsUrl = `${scheme}//${window.location.host}/castora${querySuffix}`;

    this.telemetry = {
      ...this.telemetry,
      socketState: 'connecting',
      reconnectAttempt: this.reconnectAttempt,
      ...(this.reconnectAttempt > 0 ? { lastReconnectAttemptAt: Date.now() } : {}),
    };
    this.emitTelemetry(params.handlers);

    params.handlers.onStateChange(
      'connecting',
      this.reconnectAttempt > 0
        ? `Reconnecting to /castora (attempt ${this.reconnectAttempt})...`
        : 'Connecting to /castora signaling gateway...'
    );

    const ws = new WebSocket(wsUrl);
    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;
      const wasReconnect = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.pendingHeartbeatSinceAt = null;
      this.telemetry = {
        ...this.telemetry,
        socketState: 'connected',
        reconnectAttempt: 0,
        lastHeartbeatAckAt: Date.now(),
        consecutiveMissedHeartbeats: 0,
        ...(wasReconnect ? { lastReconnectResult: 'Reconnected to /castora signaling gateway' } : {}),
      };
      this.emitTelemetry(params.handlers);
      params.handlers.onStateChange('connected', 'Connected to /castora');

      const wsPort = Number(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80);
      const announce: CastoraEnvelope = {
        protocolVersion: CASTORA_PROTOCOL_VERSION,
        messageType: 'device_announce',
        messageId: createMessageId(),
        senderDeviceId: params.deviceId,
        receiverDeviceId: null,
        roomId: params.roomId,
        timestamp: new Date().toISOString(),
        payload: {
          deviceName: params.deviceName,
          platform: params.platform,
          role: 'both',
          wsPort: Math.min(65535, Math.max(1024, wsPort === 80 || wsPort === 443 ? 3000 : wsPort)),
          capabilities: params.capabilities,
        },
      };
      ws.send(JSON.stringify(announce));

      this.heartbeatTimer = window.setInterval(() => {
        if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) return;

        // Watchdog: if previous heartbeat remained unacked through interval, increment missed counter
        if (this.pendingHeartbeatSinceAt !== null) {
          this.telemetry = {
            ...this.telemetry,
            consecutiveMissedHeartbeats: this.telemetry.consecutiveMissedHeartbeats + 1,
          };
          this.emitTelemetry(params.handlers);
          if (this.telemetry.consecutiveMissedHeartbeats >= MAX_CONSECUTIVE_MISSED_HEARTBEATS) {
            // Force close with 4000 (abnormal) so reconnect flow replaces dead zombie socket while preserving grace
            this.telemetry = {
              ...this.telemetry,
              lastReconnectResult: 'Heartbeat timeout; cycling WebSocket connection',
            };
            ws.close(4000, 'Heartbeat timeout');
            return;
          }
        }

        const now = Date.now();
        this.sequence += 1;
        this.pendingHeartbeatSinceAt = now;
        this.telemetry = {
          ...this.telemetry,
          lastHeartbeatSentAt: now,
        };
        this.emitTelemetry(params.handlers);

        const hb: CastoraEnvelope = {
          protocolVersion: CASTORA_PROTOCOL_VERSION,
          messageType: 'heartbeat',
          messageId: createMessageId(),
          senderDeviceId: params.deviceId,
          receiverDeviceId: null,
          roomId: params.roomId,
          timestamp: new Date().toISOString(),
          payload: {
            sequence: this.sequence,
            role: params.heartbeatRole ?? (params.platform === 'android-tv' ? 'receiver' : 'sender'),
          },
        };
        ws.send(JSON.stringify(hb));
      }, WS_HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const envelope = JSON.parse(event.data) as CastoraEnvelope;
        const now = Date.now();
        this.pendingHeartbeatSinceAt = null;
        this.telemetry = {
          ...this.telemetry,
          lastHeartbeatAckAt: now,
          consecutiveMissedHeartbeats: 0,
        };
        this.emitTelemetry(params.handlers);
        params.handlers.onEnvelope(envelope);
      } catch {
        // Ignore non-JSON frames
      }
    };

    ws.onerror = () => {
      if (this.socket !== ws) return;
      this.telemetry = {
        ...this.telemetry,
        socketState: 'error',
        lastReconnectResult: 'WebSocket transport error',
      };
      this.emitTelemetry(params.handlers);
      params.handlers.onStateChange('error', 'WebSocket /castora connection error');
    };

    ws.onclose = (evt) => {
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.socket === ws) {
        this.socket = null;
        this.pendingHeartbeatSinceAt = null;
        this.telemetry = {
          ...this.telemetry,
          socketState: 'disconnected',
        };
        this.emitTelemetry(params.handlers);
        params.handlers.onStateChange(
          'disconnected',
          evt.reason ? `Closed: ${evt.reason}` : 'Signaling socket closed'
        );

        // Sustained bounded exponential backoff: never permanently give up after 5 drops during long sessions
        // unless caller explicitly supplied a finite maxReconnectAttempts limit.
        const maxAttempts = params.maxReconnectAttempts ?? Infinity;
        const shouldReconnect =
          !this.manualDisconnect &&
          params.autoReconnect !== false &&
          this.reconnectAttempt < maxAttempts &&
          this.reconnectTimer === null &&
          typeof window !== 'undefined';

        if (shouldReconnect) {
          this.reconnectAttempt += 1;
          const attempt = this.reconnectAttempt;
          const delayMs = Math.min(20_000, 1000 * Math.pow(2, Math.min(attempt - 1, 5)));
          this.telemetry = {
            ...this.telemetry,
            reconnectAttempt: attempt,
            lastReconnectAttemptAt: Date.now(),
            lastReconnectResult: `Scheduled reconnect #${attempt} in ${Math.round(delayMs / 1000)}s`,
          };
          this.emitTelemetry(params.handlers);
          params.handlers.onReconnectScheduled?.(attempt, maxAttempts, delayMs);
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.manualDisconnect && this.lastConnectParams === params) {
              this.openSocket(params);
            }
          }, delayMs);
        }
      }
    };
  }

  triggerImmediateReconnect(): boolean {
    if (this.manualDisconnect || !this.lastConnectParams) return false;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return false;
    }
    this.clearReconnectTimer();
    this.openSocket(this.lastConnectParams);
    return true;
  }

  sendEnvelope(params: {
    messageType: CastoraMessageType;
    senderDeviceId: string;
    receiverDeviceId: string | null;
    roomId: string | null;
    payload: Record<string, unknown>;
  }): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const envelope: CastoraEnvelope = {
      protocolVersion: CASTORA_PROTOCOL_VERSION,
      messageType: params.messageType,
      messageId: createMessageId(),
      senderDeviceId: params.senderDeviceId,
      receiverDeviceId: params.receiverDeviceId,
      roomId: params.roomId,
      timestamp: new Date().toISOString(),
      payload: params.payload,
    };
    this.socket.send(JSON.stringify(envelope));
    return true;
  }

  disconnect(sendDisconnectEnvelope = true, deviceId?: string, roomId?: string | null): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      const ws = this.socket;
      this.socket = null;
      if (sendDisconnectEnvelope && deviceId && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            protocolVersion: CASTORA_PROTOCOL_VERSION,
            messageType: 'disconnect',
            messageId: createMessageId(),
            senderDeviceId: deviceId,
            receiverDeviceId: null,
            roomId: roomId ?? null,
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: null,
              streamId: null,
              reason: 'Client closed connection',
            },
          })
        );
      }
      ws.close(1000, 'Client manual disconnect');
    }
    this.telemetry = {
      ...this.telemetry,
      socketState: 'disconnected',
    };
    this.emitTelemetry();
  }
}
