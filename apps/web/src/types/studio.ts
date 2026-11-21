import type { CastoraPlatform, CastoraVideoCodec } from './protocol';

export type StudioDestination =
  | 'control-room'
  | 'cast'
  | 'receivers'
  | 'multi-view'
  | 'activity'
  | 'settings';

export type MultiViewLayout = 'auto' | '2-up' | '3-up' | '4-up' | '6-up' | 'spotlight';

export type WebRtcConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disconnected';

export type ResolutionPresetId = '1080p' | '720p' | 'native';
export type FrameRateTarget = 60 | 30;
export type CodecPreference = 'H264' | 'AUTO';

export interface CapturePreferences {
  resolution: ResolutionPresetId;
  targetFps: FrameRateTarget;
  codecPreference: CodecPreference;
  includeAudio: boolean;
}

export interface NetworkPreferences {
  preferLanDirectP2P: boolean;
  stunUrls: string;
  turnUrl: string;
  turnUsername: string;
  turnCredential: string;
}

export interface BrowserCapabilityReport {
  isSecureContext: boolean;
  origin: string;
  protocol: string;
  supportsDisplayMedia: boolean;
  supportsRtcPeerConnection: boolean;
  supportsVideoH264Encode: boolean;
  supportsVideoH264Decode: boolean;
  detectedVideoCodecs: string[];
  supportsBarcodeDetector: boolean;
  supportsFullscreen: boolean;
  detectedPlatform: CastoraPlatform;
  userAgentSummary: string;
}

export interface StreamTelemetrySnapshot {
  captureFps: number | null;
  encodedFps: number | null;
  decodedFps: number | null;
  targetFps: number;
  resolution: string | null;
  bitrateKbps: number | null;
  rttMs: number | null;
  packetLossPct: number | null;
  jitterMs: number | null;
  droppedFrames: number | null;
  connectionState: WebRtcConnectionPhase;
}

export interface ConnectedReceiverSlot {
  slotIndex: number; // 0..5 (up to 6 initial capacity)
  receiverDeviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  connectionState: WebRtcConnectionPhase;
  stream: MediaStream | null;
  hasAudioTrack: boolean;
  muted: boolean;
  telemetry: StreamTelemetrySnapshot;
}

export interface IncomingApprovalRequest {
  sessionId: string;
  streamId: string;
  senderDeviceId: string;
  senderName: string;
  senderPlatform: CastoraPlatform;
  requestedWidth: number;
  requestedHeight: number;
  requestedFps: number;
  preferredCodec: CastoraVideoCodec;
  receivedAt: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: string;
  category: 'capability' | 'ui' | 'signaling' | 'webrtc' | 'error';
  title: string;
  detail: string;
}

export interface SessionSummaryRecord {
  sessionId: string;
  direction: 'outbound' | 'inbound';
  peerName: string;
  resolution: string;
  durationLabel: string;
  outcome: 'completed' | 'rejected' | 'failed';
}
