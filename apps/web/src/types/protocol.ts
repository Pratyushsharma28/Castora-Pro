// Strictly aligned with protocol/castora-protocol.schema.json (castora.v1).
// Do not rename message types or envelope keys.

export const CASTORA_PROTOCOL_VERSION = 'castora.v1' as const;

export type CastoraPlatform = 'macos' | 'android' | 'android-tv';
export type CastoraDeviceRole = 'sender' | 'receiver' | 'both';
export type CastoraVideoCodec = 'H264' | 'HEVC' | 'VP8' | 'VP9' | 'AV1';
export type CastoraPairingMethod = 'qr' | 'room_code' | 'manual_ip';

export type CastoraMessageType =
  | 'device_announce'
  | 'device_discover'
  | 'pair_request'
  | 'pair_response'
  | 'connection_request'
  | 'connection_accepted'
  | 'connection_rejected'
  | 'session_offer'
  | 'session_answer'
  | 'ice_candidate'
  | 'stream_start'
  | 'stream_stop'
  | 'stream_status'
  | 'disconnect'
  | 'error'
  | 'heartbeat'
  | 'room_state';

export interface CastoraEnvelope<TPayload = Record<string, unknown>> {
  protocolVersion: typeof CASTORA_PROTOCOL_VERSION;
  messageType: CastoraMessageType;
  messageId: string;
  senderDeviceId: string;
  receiverDeviceId: string | null;
  roomId: string | null;
  timestamp: string;
  payload: TPayload;
}

export interface DeviceCapabilities {
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  codecs: CastoraVideoCodec[];
  supportsAudio: boolean;
}

export interface MeasuredStreamStats {
  fps: number;
  bitrateKbps: number;
  rttMs: number;
  droppedFrames: number;
}
