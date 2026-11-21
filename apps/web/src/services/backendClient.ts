import {
  CASTORA_PROTOCOL_VERSION,
  type CastoraEnvelope,
  type CastoraMessageType,
  type CastoraPlatform,
  type DeviceCapabilities,
} from '../types/protocol';

export type SignalingSocketState = 'disconnected' | 'connecting' | 'connected' | 'error';

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
  timestamp: string;
}

export interface RoomMemberInfo {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  role: 'host' | 'receiver';
  connected: boolean;
  assignedSlotIndex: number | null;
}

export interface RoomSnapshot {
  roomId: string;
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
  createdAt: string;
  expiresAt: string;
  maxReceivers: number;
  activeReceiverCount: number;
  members: RoomMemberInfo[];
}

export interface CreateRoomResponse {
  room: RoomSnapshot;
  hostToken: string;
}

export interface JoinRoomResponse {
  room: RoomSnapshot;
  memberToken: string;
  assignedSlotIndex: number;
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

export async function createBackendRoom(params: {
  hostDeviceId: string;
  hostDeviceName: string;
  hostPlatform: CastoraPlatform;
}): Promise<CreateRoomResponse> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = (await response.json()) as CreateRoomResponse & { message?: string };
  if (!response.ok) {
    throw new Error(data.message ?? `Room creation failed (HTTP ${response.status})`);
  }
  return data;
}

export async function joinBackendRoom(params: {
  roomId: string;
  receiverDeviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
}): Promise<JoinRoomResponse> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(params.roomId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receiverDeviceId: params.receiverDeviceId,
      deviceName: params.deviceName,
      platform: params.platform,
    }),
  });
  const data = (await response.json()) as JoinRoomResponse & { message?: string };
  if (!response.ok) {
    throw new Error(data.message ?? `Failed to join room (HTTP ${response.status})`);
  }
  return data;
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

export interface SignalingClientHandlers {
  onStateChange: (state: SignalingSocketState, detail?: string) => void;
  onEnvelope: (envelope: CastoraEnvelope) => void;
}

export class CastoraSignalingClient {
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private sequence = 0;

  connect(params: {
    deviceId: string;
    deviceName: string;
    platform: CastoraPlatform;
    capabilities: DeviceCapabilities;
    roomId: string | null;
    token?: string | null;
    handlers: SignalingClientHandlers;
  }): void {
    this.disconnect(false);

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tokenQuery = params.token ? `?token=${encodeURIComponent(params.token)}` : '';
    const wsUrl = `${scheme}//${window.location.host}/castora${tokenQuery}`;

    params.handlers.onStateChange('connecting', 'Connecting to /castora signaling gateway...');

    const ws = new WebSocket(wsUrl);
    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;
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
        if (ws.readyState !== WebSocket.OPEN) return;
        this.sequence += 1;
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
            role: 'sender',
          },
        };
        ws.send(JSON.stringify(hb));
      }, 20_000);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const envelope = JSON.parse(event.data) as CastoraEnvelope;
        params.handlers.onEnvelope(envelope);
      } catch {
        // Ignore non-JSON frames
      }
    };

    ws.onerror = () => {
      if (this.socket !== ws) return;
      params.handlers.onStateChange('error', 'WebSocket /castora connection error');
    };

    ws.onclose = (evt) => {
      if (this.heartbeatTimer !== null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.socket === ws) {
        this.socket = null;
        params.handlers.onStateChange(
          'disconnected',
          evt.reason ? `Closed: ${evt.reason}` : 'Signaling socket closed'
        );
      }
    };
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
      ws.close();
    }
  }
}
