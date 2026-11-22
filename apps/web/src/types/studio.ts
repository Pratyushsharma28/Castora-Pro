import type { CastoraPlatform, CastoraVideoCodec } from './protocol';

export type StudioDestination =
  | 'control-room'
  | 'cast'
  | 'receivers'
  | 'devices'
  | 'multi-view'
  | 'activity'
  | 'settings';

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

export type DeviceManagerStatusFilter =
  | 'all'
  | 'connected'
  | 'streaming'
  | 'attention'
  | 'disconnected'
  | 'pending';

export type MultiViewLayout = 'auto' | '2-up' | '3-up' | '4-up' | '6-up' | 'spotlight';

export type WebRtcConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disconnected';

export type ConnectionQualityLevel =
  | 'excellent'
  | 'good'
  | 'fair'
  | 'poor'
  | 'reconnecting'
  | 'failed'
  | 'unknown';

export interface PeerConnectionRecoveryInfo {
  attempt: number;
  maxAttempts: number;
  reconnecting: boolean;
  exhausted: boolean;
  lastError: string | null;
  mode: 'idle' | 'ice-restart' | 'peer-replace';
  nextRetryAt: number | null;
}

export type ResolutionPresetId = '720p' | '1080p' | '1440p' | '4k' | 'native';
export type FrameRateTarget = 60 | 30;
export type CodecPreference = 'H264' | 'VP9' | 'AV1' | 'AUTO';
export type QualityLimitationReason = 'none' | 'cpu' | 'bandwidth' | 'other';
export type AdaptationStatus = 'target' | 'degraded' | 'recovering';

export type QualityProfileId = 'standard' | 'high' | 'ultra' | 'maximum';
export type NetworkConditionLevel = 'healthy' | 'moderate' | 'congested' | 'unavailable';
export type AdaptiveAdjustmentAction =
  | 'none'
  | 'reduced-bitrate'
  | 'reduced-fps'
  | 'reduced-resolution'
  | 'restored'
  | 'manual-locked';

export interface AdaptiveControlCapabilities {
  supportsSetParameters: boolean;
  supportsMaxBitrate: boolean;
  supportsMaxFramerate: boolean;
  supportsScaleResolutionDownBy: boolean;
  supportsDegradationPreference: boolean;
  lastError: string | null;
}

export type QualityVerificationStatus =
  | '1080p verified'
  | '1440p verified'
  | '4K verified'
  | '720p verified'
  | 'Requested quality not achieved'
  | 'Statistics unavailable';

export interface CapturePreferences {
  resolution: ResolutionPresetId;
  targetFps: FrameRateTarget;
  codecPreference: CodecPreference;
  includeAudio: boolean;
  /** Optional target video bitrate in kbps; defaults per resolution/FPS preset */
  maxBitrateKbps?: number;
  /** Enables getStats()-driven adaptive quality control (default: true) */
  adaptiveBitrate?: boolean;
}

export interface NetworkPreferences {
  preferLanDirectP2P: boolean;
  stunUrls: string;
  turnUrl: string;
  turnUsername: string;
  turnCredential: string;
  serverIceServers?: RTCIceServer[];
  turnConfigured?: boolean;
  turnMode?: 'ephemeral-hmac' | 'static' | 'disabled';
  turnTransports?: Array<'udp' | 'tcp' | 'tls'>;
  turnExpiresAt?: string | null;
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
  detectedDeviceType: DetectedDeviceType;
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
  /** Stage 1: MediaStreamTrack.getSettings() actual capture dimensions */
  captureWidth?: number | null;
  captureHeight?: number | null;
  /** Stage 2: outbound-rtp actual encoded dimensions & sent/encoded frames */
  encodedWidth?: number | null;
  encodedHeight?: number | null;
  framesSent?: number | null;
  framesEncoded?: number | null;
  /** Stage 3: inbound-rtp decoded dimensions/frames + <video> element dimensions */
  decodedWidth?: number | null;
  decodedHeight?: number | null;
  framesDecoded?: number | null;
  renderedWidth?: number | null;
  renderedHeight?: number | null;
  configuredMaxBitrateKbps?: number | null;
  targetBitrateKbps?: number | null;
  targetFramerate?: number | null;
  availableOutgoingBitrateKbps?: number | null;
  qualityLimitationReason?: QualityLimitationReason | null;
  codecMimeType?: string | null;
  scaleResolutionDownBy?: number | null;
  adaptationStatus?: AdaptationStatus | null;
  adaptiveMode?: 'auto' | 'manual' | null;
  networkCondition?: NetworkConditionLevel | null;
  lastAdjustmentReason?: string | null;
  lastAdjustmentAt?: number | null;
  lastAdjustmentAction?: AdaptiveAdjustmentAction | null;
  supportedAdaptiveControls?: AdaptiveControlCapabilities | null;
}

export interface ConnectedReceiverSlot {
  slotIndex: number; // 0..5 (up to 6 initial capacity)
  receiverDeviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  connectionState: WebRtcConnectionPhase;
  iceConnectionState?: RTCIceConnectionState | null;
  errorMessage?: string | null;
  recovery?: PeerConnectionRecoveryInfo | null;
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

export interface ManagedDeviceRecord {
  deviceId: string;
  deviceName: string;
  role: 'host' | 'participant' | 'pending';
  isSelf: boolean;
  platform: CastoraPlatform;
  deviceType: DetectedDeviceType;
  slotIndex: number | null;
  connected: boolean;
  connectionPhase: WebRtcConnectionPhase;
  connectionQualityLabel: string;
  connectionQualityTone: 'active' | 'signal' | 'warn' | 'fault' | 'standby';
  connectionQualityDetail: string;
  isIncomingStreaming: boolean;
  isOutgoingStreaming: boolean;
  resolution: string | null;
  fps: number | null;
  bitrateKbps: number | null;
  audioStatus: 'Sharing audio' | 'Video only' | 'Off';
  hasIncomingAudioTrack: boolean;
  incomingMuted: boolean;
  adaptiveLocked: boolean | null;
  lastActivityAt: string | null;
  canRetry: boolean;
  recoveryExhausted: boolean;
}
