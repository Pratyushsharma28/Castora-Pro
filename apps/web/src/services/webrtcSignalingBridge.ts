import type { CastoraEnvelope, CastoraPlatform, CastoraVideoCodec } from '../types/protocol';
import type {
  AudioCaptureStatus,
  AudioPlaybackStatus,
  CapturePreferences,
  NetworkPreferences,
  PeerConnectionRecoveryInfo,
  StreamTelemetrySnapshot,
  WebRtcConnectionPhase,
} from '../types/studio';
import type { CastoraSignalingClient, RoomSnapshot } from './backendClient';
import {
  applyCaptureTrackConstraints,
  startScreenCapture,
  type CapturedScreenSession,
} from './screenCaptureService';
import { evaluateAudioDiagnosticState } from './streamingDiagnosticsService';
import { createEmptyTelemetry } from './streamStatsService';
import { resolveQualityTarget } from './videoQualityService';
import { CastoraWebRtcPeer } from './webrtcPeerService';

export interface ReconnectPolicyConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  iceDisconnectGraceMs?: number;
  recoveryVerifyMs?: number;
}

export interface IncomingScreenEntry {
  senderDeviceId: string;
  senderName: string;
  senderPlatform: CastoraPlatform;
  sessionId: string;
  streamId: string;
  phase: WebRtcConnectionPhase;
  iceConnectionState: RTCIceConnectionState | null;
  statusDetail: string | null;
  errorMessage: string | null;
  recovery?: PeerConnectionRecoveryInfo | null;
  stream: MediaStream | null;
  streamMeta: {
    width: number;
    height: number;
    fps: number;
    codec: CastoraVideoCodec;
  } | null;
  telemetry: StreamTelemetrySnapshot;
  renderedWidth: number | null;
  renderedHeight: number | null;
  audioPlaybackStatus?: AudioPlaybackStatus | null;
  autoplayBlocked?: boolean;
  startedAt: string;
  lastActivityAt: number;
}

export interface OutboundPeerEntry {
  targetDeviceId: string;
  targetName: string;
  targetPlatform: CastoraPlatform;
  sessionId: string;
  streamId: string;
  phase: WebRtcConnectionPhase;
  iceConnectionState: RTCIceConnectionState | null;
  statusDetail: string | null;
  errorMessage: string | null;
  recovery?: PeerConnectionRecoveryInfo | null;
  telemetry: StreamTelemetrySnapshot;
  qualityOverride?: Partial<CapturePreferences> | null;
  lastActivityAt: number;
}

export interface WebRtcSessionSnapshot {
  phase: WebRtcConnectionPhase;
  statusDetail: string | null;
  errorMessage: string | null;
  iceConnectionState: RTCIceConnectionState | null;
  isSharingLocal: boolean;
  localStream: MediaStream | null;
  localCaptureMeta: {
    width: number | null;
    height: number | null;
    fps: number | null;
    hasAudio: boolean;
    audioCaptureStatus?: AudioCaptureStatus;
    audioNotice?: string | null;
  } | null;
  remoteStream: MediaStream | null;
  activeSessionId: string | null;
  activeStreamId: string | null;
  targetPeerDeviceId: string | null;
  remoteStreamMeta: {
    width: number;
    height: number;
    fps: number;
    codec: CastoraVideoCodec;
  } | null;
  telemetry: StreamTelemetrySnapshot;
  outboundTelemetry: StreamTelemetrySnapshot;
  inboundTelemetry: StreamTelemetrySnapshot;
  incomingStreams: IncomingScreenEntry[];
  outboundPeers: OutboundPeerEntry[];
  peerCount: number;
}

export interface SignalingSender {
  sendEnvelope: CastoraSignalingClient['sendEnvelope'];
}

export interface WebRtcBridgeCallbacks {
  onStateChange: (snapshot: WebRtcSessionSnapshot) => void;
  onLogEvent: (
    category: 'capability' | 'ui' | 'signaling' | 'webrtc' | 'error',
    title: string,
    detail: string
  ) => void;
}

function createId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${rand}`;
}

function aggregatePhase(phases: WebRtcConnectionPhase[]): WebRtcConnectionPhase {
  if (phases.includes('connected')) return 'connected';
  if (phases.includes('reconnecting')) return 'reconnecting';
  if (phases.includes('connecting')) return 'connecting';
  if (phases.includes('failed')) return 'failed';
  if (phases.includes('disconnected')) return 'disconnected';
  return 'idle';
}

export class WebRtcSignalingBridge {
  private deviceId: string;
  private activeRoom: RoomSnapshot | null = null;
  private activeRoomRole: 'host' | 'receiver' | null = null;
  private preferences: CapturePreferences;
  private networkPrefs: NetworkPreferences;
  private getSignalingClient: () => SignalingSender | null;
  private callbacks: WebRtcBridgeCallbacks;
  private captureFn: typeof startScreenCapture;
  private rtcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
  private onRefreshIceServers?: () => Promise<NetworkPreferences | null>;
  private reconnectConfig: Required<ReconnectPolicyConfig>;

  private captureSession: CapturedScreenSession | null = null;
  private outboundStreamId: string | null = null;
  private autoBroadcastToRoom = false;
  private desiredOutboundTargets = new Set<string>();
  private pendingAutoPublishPeers = new Set<string>();
  private peers = new Map<string, CastoraWebRtcPeer>();
  private incomingMap = new Map<string, IncomingScreenEntry>();
  private outboundMap = new Map<string, OutboundPeerEntry>();
  private peerQualityOverrides = new Map<string, Partial<CapturePreferences>>();
  private recoveryMap = new Map<string, PeerConnectionRecoveryInfo>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private verifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectingPeers = new Set<string>();
  private disposed = false;
  private statusDetail: string | null = null;
  private errorMessage: string | null = null;

  constructor(params: {
    deviceId: string;
    preferences: CapturePreferences;
    networkPrefs: NetworkPreferences;
    getSignalingClient: () => SignalingSender | null;
    callbacks: WebRtcBridgeCallbacks;
    captureFn?: typeof startScreenCapture;
    rtcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
    reconnectConfig?: ReconnectPolicyConfig;
    onRefreshIceServers?: () => Promise<NetworkPreferences | null>;
  }) {
    this.deviceId = params.deviceId;
    this.preferences = params.preferences;
    this.networkPrefs = params.networkPrefs;
    this.getSignalingClient = params.getSignalingClient;
    this.callbacks = params.callbacks;
    this.captureFn = params.captureFn ?? startScreenCapture;
    this.rtcFactory = params.rtcFactory;
    this.onRefreshIceServers = params.onRefreshIceServers;
    this.reconnectConfig = {
      maxAttempts: Math.max(1, params.reconnectConfig?.maxAttempts ?? 3),
      baseDelayMs: Math.max(10, params.reconnectConfig?.baseDelayMs ?? 1000),
      maxDelayMs: Math.max(20, params.reconnectConfig?.maxDelayMs ?? 8000),
      iceDisconnectGraceMs: Math.max(0, params.reconnectConfig?.iceDisconnectGraceMs ?? 1500),
      recoveryVerifyMs: Math.max(50, params.reconnectConfig?.recoveryVerifyMs ?? 3500),
    };
  }

  getPeerRecoveryState(peerDeviceId: string): PeerConnectionRecoveryInfo | null {
    const rec = this.recoveryMap.get(peerDeviceId);
    return rec ? { ...rec } : null;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  getPeerDeviceIds(): string[] {
    return Array.from(this.peers.keys());
  }

  getPeerInstance(peerDeviceId: string): CastoraWebRtcPeer | undefined {
    return this.peers.get(peerDeviceId);
  }

  updateIncomingRenderedDimensions(
    senderDeviceId: string,
    width: number | null,
    height: number | null
  ): void {
    const entry = this.incomingMap.get(senderDeviceId);
    if (!entry) return;
    const normalizedW =
      typeof width === 'number' && Number.isFinite(width) && width > 0 ? Math.round(width) : null;
    const normalizedH =
      typeof height === 'number' && Number.isFinite(height) && height > 0 ? Math.round(height) : null;
    if (entry.renderedWidth === normalizedW && entry.renderedHeight === normalizedH) {
      return;
    }
    entry.renderedWidth = normalizedW;
    entry.renderedHeight = normalizedH;
    entry.telemetry = {
      ...entry.telemetry,
      renderedWidth: normalizedW,
      renderedHeight: normalizedH,
    };
    this.incomingMap.set(senderDeviceId, entry);
    this.emit();
  }

  updateIncomingAudioPlaybackState(
    senderDeviceId: string,
    state: { playbackStatus: AudioPlaybackStatus; autoplayBlocked: boolean }
  ): void {
    const entry = this.incomingMap.get(senderDeviceId);
    if (!entry) return;
    if (
      entry.audioPlaybackStatus === state.playbackStatus &&
      Boolean(entry.autoplayBlocked) === state.autoplayBlocked
    ) {
      return;
    }
    entry.audioPlaybackStatus = state.playbackStatus;
    entry.autoplayBlocked = state.autoplayBlocked;
    const hasIncomingAudioTrack = Boolean(entry.stream?.getAudioTracks().length);
    const audioDiagnosticStatus = evaluateAudioDiagnosticState({
      isSharingLocal: false,
      hasIncomingStream: Boolean(entry.stream),
      connectionState: entry.phase,
      hasIncomingAudioTrack,
      audioReceiverTrackStatus: entry.telemetry.audioReceiverTrackStatus,
      audioPacketsReceived: entry.telemetry.audioPacketsReceived,
      audioPlaybackStatus: state.playbackStatus,
      autoplayBlocked: state.autoplayBlocked,
    });
    entry.telemetry = {
      ...entry.telemetry,
      audioPlaybackStatus: state.playbackStatus,
      autoplayBlocked: state.autoplayBlocked,
      audioDiagnosticStatus,
    };
    this.incomingMap.set(senderDeviceId, entry);
    this.emit();
  }

  getEffectivePreferencesForPeer(peerDeviceId: string): CapturePreferences {
    const override = this.peerQualityOverrides.get(peerDeviceId);
    if (!override) return this.preferences;
    return {
      ...this.preferences,
      ...override,
    };
  }

  async setPeerQualityOverride(
    peerDeviceId: string,
    override: Partial<CapturePreferences> | null
  ): Promise<void> {
    if (!override || Object.keys(override).length === 0) {
      this.peerQualityOverrides.delete(peerDeviceId);
    } else {
      const merged = {
        ...(this.peerQualityOverrides.get(peerDeviceId) ?? {}),
        ...override,
      };
      this.peerQualityOverrides.set(peerDeviceId, merged);
    }

    const outEntry = this.outboundMap.get(peerDeviceId);
    if (outEntry) {
      outEntry.qualityOverride = this.peerQualityOverrides.get(peerDeviceId) ?? null;
      this.outboundMap.set(peerDeviceId, outEntry);
    }

    const peer = this.peers.get(peerDeviceId);
    if (peer && peer.hasOutboundStream()) {
      const effectivePrefs = this.getEffectivePreferencesForPeer(peerDeviceId);
      await peer.updateEncodingPreferences(
        effectivePrefs,
        Math.max(1, this.outboundMap.size)
      );
      const target = resolveQualityTarget(effectivePrefs, {
        width: this.captureSession?.actualWidth,
        height: this.captureSession?.actualHeight,
      });
      if (outEntry) {
        const abrState = peer.getAdaptiveState();
        outEntry.telemetry = {
          ...outEntry.telemetry,
          targetFps: effectivePrefs.targetFps,
          targetFramerate: abrState?.targetFramerate ?? effectivePrefs.targetFps,
          configuredMaxBitrateKbps: target.configuredMaxBitrateKbps,
          targetBitrateKbps: abrState?.targetBitrateKbps ?? target.configuredMaxBitrateKbps,
          scaleResolutionDownBy: abrState?.scaleResolutionDownBy ?? 1.0,
          adaptationStatus: abrState?.adaptationStatus ?? 'target',
          adaptiveMode: target.adaptiveEnabled ? 'auto' : 'manual',
          lastAdjustmentReason: abrState?.lastAdjustmentReason ?? null,
          lastAdjustmentAt: abrState?.lastAdjustmentAt ?? null,
          lastAdjustmentAction:
            abrState?.lastAdjustmentAction ?? (target.adaptiveEnabled ? 'none' : 'manual-locked'),
          supportedAdaptiveControls: peer.getSupportedAdaptiveControls(),
        };
        this.outboundMap.set(peerDeviceId, outEntry);
      }
      this.callbacks.onLogEvent(
        'webrtc',
        `Updated stream quality for ${outEntry?.targetName ?? peerDeviceId}`,
        `Bitrate cap ${(target.configuredMaxBitrateKbps / 1000).toFixed(1)} Mbps · ${effectivePrefs.targetFps} FPS · ABR=${target.adaptiveEnabled ? 'on' : 'off'}`
      );
    }
    this.emit();
  }

  async applyCapturePreferencesUpdate(nextPreferences: CapturePreferences): Promise<{
    applied: boolean;
    fallbackUsed: boolean;
    notice: string | null;
    appliedPreferences: CapturePreferences;
  }> {
    const previousPrefs = this.preferences;
    const resolutionOrFpsChanged =
      previousPrefs.resolution !== nextPreferences.resolution ||
      previousPrefs.targetFps !== nextPreferences.targetFps;
    const codecChanged = previousPrefs.codecPreference !== nextPreferences.codecPreference;
    const audioChanged = previousPrefs.includeAudio !== nextPreferences.includeAudio;

    let notice: string | null = null;

    if (this.captureSession && resolutionOrFpsChanged) {
      const constraintResult = await applyCaptureTrackConstraints(
        this.captureSession,
        nextPreferences
      );

      if (!constraintResult.applied) {
        this.errorMessage = constraintResult.errorMessage;
        this.callbacks.onLogEvent(
          'error',
          'Capture constraint update failed',
          constraintResult.errorMessage ?? 'Kept previous working capture settings.'
        );
        this.emit();
        return {
          applied: false,
          fallbackUsed: true,
          notice:
            constraintResult.errorMessage ??
            'Requested resolution or frame rate is unsupported; kept previous settings.',
          appliedPreferences: previousPrefs,
        };
      }

      const requestedTarget = resolveQualityTarget(nextPreferences);
      if (
        nextPreferences.resolution !== 'native' &&
        constraintResult.actualWidth &&
        constraintResult.actualHeight &&
        (constraintResult.actualWidth < requestedTarget.targetWidth ||
          constraintResult.actualHeight < requestedTarget.targetHeight)
      ) {
        notice = `Selected source delivered ${constraintResult.actualWidth}×${constraintResult.actualHeight} instead of ${requestedTarget.targetWidth}×${requestedTarget.targetHeight}; streaming at actual captured resolution.`;
        this.statusDetail = notice;
        this.callbacks.onLogEvent('webrtc', 'Capture resolution capped by display surface', notice);
      }
    }

    if (
      this.captureSession &&
      audioChanged &&
      nextPreferences.includeAudio &&
      !this.captureSession.hasAudio
    ) {
      const audioMsg =
        'Audio is enabled, but the active screen capture only contains video. Click Change Screen and enable audio in the browser picker to include audio.';
      notice = notice ? `${notice} ${audioMsg}` : audioMsg;
      this.statusDetail = audioMsg;
      this.callbacks.onLogEvent('webrtc', 'Screen re-share needed to add audio track', audioMsg);
    }

    this.preferences = nextPreferences;
    const activeCount = Math.max(1, this.outboundMap.size);
    const signaling = this.getSignalingClient();
    const roomId = this.activeRoom?.roomId ?? null;

    for (const peerId of Array.from(this.outboundMap.keys())) {
      const peer = this.peers.get(peerId);
      if (peer && peer.hasOutboundStream()) {
        const effectivePrefs = this.getEffectivePreferencesForPeer(peerId);
        await peer.updateEncodingPreferences(effectivePrefs, activeCount);
        const outEntry = this.outboundMap.get(peerId);
        const resolved = resolveQualityTarget(effectivePrefs, {
          width: this.captureSession?.actualWidth,
          height: this.captureSession?.actualHeight,
        });
        const codecDiag = peer.getCodecDiagnostics();
        if (outEntry) {
          const abrState = peer.getAdaptiveState();
          outEntry.telemetry = {
            ...outEntry.telemetry,
            targetFps: effectivePrefs.targetFps,
            targetFramerate: abrState?.targetFramerate ?? effectivePrefs.targetFps,
            configuredMaxBitrateKbps: resolved.configuredMaxBitrateKbps,
            targetBitrateKbps: abrState?.targetBitrateKbps ?? resolved.configuredMaxBitrateKbps,
            scaleResolutionDownBy: abrState?.scaleResolutionDownBy ?? 1.0,
            adaptationStatus: abrState?.adaptationStatus ?? 'target',
            adaptiveMode: resolved.adaptiveEnabled ? 'auto' : 'manual',
            lastAdjustmentReason: abrState?.lastAdjustmentReason ?? null,
            lastAdjustmentAt: abrState?.lastAdjustmentAt ?? null,
            lastAdjustmentAction:
              abrState?.lastAdjustmentAction ??
              (resolved.adaptiveEnabled ? 'none' : 'manual-locked'),
            supportedAdaptiveControls: peer.getSupportedAdaptiveControls(),
            selectedVideoCodec: effectivePrefs.codecPreference,
            negotiatedVideoCodec: codecDiag.negotiatedVideoCodec,
            negotiatedVideoProfile: codecDiag.negotiatedVideoProfile,
            codecFallbackReason: codecDiag.codecFallbackReason,
            resolution:
              this.captureSession?.actualWidth && this.captureSession?.actualHeight
                ? `${this.captureSession.actualWidth}×${this.captureSession.actualHeight}`
                : outEntry.telemetry.resolution,
          };
          this.outboundMap.set(peerId, outEntry);

          if (codecChanged && signaling && roomId) {
            const width = Math.max(
              320,
              Math.min(3840, Math.round(this.captureSession?.actualWidth ?? resolved.targetWidth))
            );
            const height = Math.max(
              240,
              Math.min(2160, Math.round(this.captureSession?.actualHeight ?? resolved.targetHeight))
            );
            const fps = Math.max(
              1,
              Math.min(120, Math.round(this.captureSession?.actualFrameRate ?? effectivePrefs.targetFps))
            );
            const announcedCodec: CastoraVideoCodec =
              effectivePrefs.codecPreference === 'H264'
                ? 'H264'
                : effectivePrefs.codecPreference === 'VP9'
                  ? 'VP9'
                  : effectivePrefs.codecPreference === 'AV1'
                    ? 'AV1'
                    : 'VP8';
            signaling.sendEnvelope({
              messageType: 'stream_start',
              senderDeviceId: this.deviceId,
              receiverDeviceId: peerId,
              roomId,
              payload: {
                sessionId: outEntry.sessionId,
                streamId: outEntry.streamId,
                width,
                height,
                fps,
                codec: announcedCodec,
              },
            });
          }
        }
      }
    }

    if (codecChanged && this.outboundMap.size > 0) {
      this.callbacks.onLogEvent(
        'webrtc',
        'Updated video codec preference',
        `Renegotiating active outbound stream(s) for ${nextPreferences.codecPreference} while keeping audio intact.`
      );
    }

    this.emit();
    return {
      applied: true,
      fallbackUsed: false,
      notice,
      appliedPreferences: nextPreferences,
    };
  }

  private resolveParticipantMeta(peerDeviceId: string): {
    deviceName: string;
    platform: CastoraPlatform;
    sessionId: string;
    connected: boolean;
  } | null {
    if (!this.activeRoom) return null;
    if (peerDeviceId === this.activeRoom.hostDeviceId) {
      return {
        deviceName: this.activeRoom.hostDeviceName,
        platform: this.activeRoom.hostPlatform,
        sessionId:
          this.activeRoom.pairedReceivers.find((r) => r.deviceId === this.deviceId)?.sessionId ??
          createId('sess'),
        connected: this.activeRoom.hostConnected,
      };
    }
    const rx = this.activeRoom.pairedReceivers.find((r) => r.deviceId === peerDeviceId);
    if (!rx) return null;
    return {
      deviceName: rx.deviceName,
      platform: rx.platform,
      sessionId: rx.sessionId,
      connected: rx.connected,
    };
  }

  private isSelfAuthorizedInRoom(): boolean {
    if (!this.activeRoom) return false;
    if (this.activeRoom.hostDeviceId === this.deviceId) return true;
    return this.activeRoom.pairedReceivers.some((r) => r.deviceId === this.deviceId);
  }

  getSnapshot(): WebRtcSessionSnapshot {
    const incomingStreams = Array.from(this.incomingMap.values());
    const outboundPeers = Array.from(this.outboundMap.values());

    const phases: WebRtcConnectionPhase[] = [
      ...outboundPeers.map((o) => o.phase),
      ...incomingStreams.map((i) => i.phase),
    ];
    const phase = aggregatePhase(phases);

    const primaryOutbound = outboundPeers[0] ?? null;
    const primaryInbound = incomingStreams.find((i) => i.stream !== null) ?? incomingStreams[0] ?? null;

    // Read fresh Stage 1 MediaStreamTrack.getSettings() when capturing locally
    let liveCapWidth: number | null = this.captureSession?.actualWidth ?? null;
    let liveCapHeight: number | null = this.captureSession?.actualHeight ?? null;
    let liveCapFps: number | null = this.captureSession?.actualFrameRate ?? null;
    if (this.captureSession?.videoTrack && typeof this.captureSession.videoTrack.getSettings === 'function') {
      const settings = this.captureSession.videoTrack.getSettings();
      if (typeof settings.width === 'number' && settings.width > 0) {
        liveCapWidth = settings.width;
        this.captureSession.actualWidth = settings.width;
      }
      if (typeof settings.height === 'number' && settings.height > 0) {
        liveCapHeight = settings.height;
        this.captureSession.actualHeight = settings.height;
      }
      if (typeof settings.frameRate === 'number' && settings.frameRate > 0) {
        liveCapFps = settings.frameRate;
        this.captureSession.actualFrameRate = settings.frameRate;
      }
    }

    const resolvedGlobal = resolveQualityTarget(this.preferences, {
      width: liveCapWidth,
      height: liveCapHeight,
    });

    const localCaptureAudioStatus: AudioCaptureStatus = this.captureSession
      ? (this.captureSession.audioCaptureStatus ?? (this.captureSession.hasAudio ? 'captured' : 'unknown'))
      : this.preferences.includeAudio
        ? 'unknown'
        : 'not-requested';

    const outboundTelemetry: StreamTelemetrySnapshot = primaryOutbound
      ? {
          ...primaryOutbound.telemetry,
          captureWidth: primaryOutbound.telemetry.captureWidth ?? liveCapWidth,
          captureHeight: primaryOutbound.telemetry.captureHeight ?? liveCapHeight,
          captureFps: primaryOutbound.telemetry.captureFps ?? liveCapFps,
          selectedVideoCodec:
            primaryOutbound.telemetry.selectedVideoCodec ?? this.preferences.codecPreference,
          audioCaptureStatus:
            primaryOutbound.telemetry.audioCaptureStatus ?? localCaptureAudioStatus,
          audioDiagnosticStatus:
            primaryOutbound.telemetry.audioDiagnosticStatus ??
            evaluateAudioDiagnosticState({
              isSharingLocal: Boolean(this.captureSession),
              hasIncomingStream: false,
              connectionState: primaryOutbound.phase,
              localHasAudio: this.captureSession?.hasAudio ?? false,
              audioCaptureStatus: localCaptureAudioStatus,
              audioSenderTrackStatus: primaryOutbound.telemetry.audioSenderTrackStatus,
              audioPacketsSent: primaryOutbound.telemetry.audioPacketsSent,
            }),
        }
      : {
          ...createEmptyTelemetry(this.preferences.targetFps, this.captureSession ? phase : 'idle'),
          captureFps: liveCapFps,
          captureWidth: liveCapWidth,
          captureHeight: liveCapHeight,
          resolution:
            liveCapWidth && liveCapHeight ? `${liveCapWidth}×${liveCapHeight}` : null,
          configuredMaxBitrateKbps: this.captureSession
            ? resolvedGlobal.configuredMaxBitrateKbps
            : null,
          targetBitrateKbps: this.captureSession
            ? resolvedGlobal.configuredMaxBitrateKbps
            : null,
          targetFramerate: resolvedGlobal.targetFps,
          adaptiveMode: resolvedGlobal.adaptiveEnabled ? 'auto' : 'manual',
          scaleResolutionDownBy: this.captureSession ? 1.0 : null,
          adaptationStatus: this.captureSession ? 'target' : null,
          lastAdjustmentAction: resolvedGlobal.adaptiveEnabled ? 'none' : 'manual-locked',
          lastAdjustmentReason: resolvedGlobal.adaptiveEnabled
            ? null
            : 'Manual quality locked — automatic adaptation paused.',
          selectedVideoCodec: this.preferences.codecPreference,
          audioCaptureStatus: this.captureSession ? localCaptureAudioStatus : null,
          audioSenderTrackStatus: this.captureSession
            ? this.captureSession.hasAudio
              ? 'live'
              : 'none'
            : null,
          audioDiagnosticStatus: this.captureSession
            ? evaluateAudioDiagnosticState({
                isSharingLocal: true,
                hasIncomingStream: false,
                connectionState: phase,
                localHasAudio: this.captureSession.hasAudio,
                audioCaptureStatus: localCaptureAudioStatus,
                audioSenderTrackStatus: this.captureSession.hasAudio ? 'live' : 'none',
              })
            : null,
        };

    const inboundTelemetry: StreamTelemetrySnapshot = primaryInbound
      ? {
          ...primaryInbound.telemetry,
          renderedWidth: primaryInbound.renderedWidth,
          renderedHeight: primaryInbound.renderedHeight,
          audioPlaybackStatus:
            primaryInbound.audioPlaybackStatus ?? primaryInbound.telemetry.audioPlaybackStatus ?? null,
          autoplayBlocked:
            primaryInbound.autoplayBlocked ?? primaryInbound.telemetry.autoplayBlocked ?? false,
          audioDiagnosticStatus:
            primaryInbound.telemetry.audioDiagnosticStatus ??
            evaluateAudioDiagnosticState({
              isSharingLocal: false,
              hasIncomingStream: Boolean(primaryInbound.stream),
              connectionState: primaryInbound.phase,
              hasIncomingAudioTrack: Boolean(primaryInbound.stream?.getAudioTracks().length),
              audioReceiverTrackStatus: primaryInbound.telemetry.audioReceiverTrackStatus,
              audioPacketsReceived: primaryInbound.telemetry.audioPacketsReceived,
              audioPlaybackStatus:
                primaryInbound.audioPlaybackStatus ??
                primaryInbound.telemetry.audioPlaybackStatus ??
                null,
              autoplayBlocked:
                primaryInbound.autoplayBlocked ?? primaryInbound.telemetry.autoplayBlocked ?? false,
            }),
        }
      : createEmptyTelemetry(this.preferences.targetFps, 'idle');

    const telemetry = this.captureSession ? outboundTelemetry : inboundTelemetry;
    const iceConnectionState =
      primaryOutbound?.iceConnectionState ?? primaryInbound?.iceConnectionState ?? null;

    return {
      phase,
      statusDetail: this.statusDetail,
      errorMessage: this.errorMessage,
      iceConnectionState,
      isSharingLocal: Boolean(this.captureSession),
      localStream: this.captureSession?.stream ?? null,
      localCaptureMeta: this.captureSession
        ? {
            width: liveCapWidth,
            height: liveCapHeight,
            fps: liveCapFps,
            hasAudio: this.captureSession.hasAudio,
            audioCaptureStatus: localCaptureAudioStatus,
            audioNotice: this.captureSession.audioNotice ?? null,
          }
        : null,
      remoteStream: primaryInbound?.stream ?? null,
      activeSessionId: primaryOutbound?.sessionId ?? primaryInbound?.sessionId ?? null,
      activeStreamId: this.outboundStreamId ?? primaryInbound?.streamId ?? null,
      targetPeerDeviceId: primaryOutbound?.targetDeviceId ?? primaryInbound?.senderDeviceId ?? null,
      remoteStreamMeta: primaryInbound?.streamMeta ?? null,
      telemetry,
      outboundTelemetry,
      inboundTelemetry,
      incomingStreams,
      outboundPeers,
      peerCount: this.peers.size,
    };
  }

  private emit(): void {
    this.callbacks.onStateChange(this.getSnapshot());
  }

  private getOrCreatePeer(peerDeviceId: string, sessionId: string): CastoraWebRtcPeer {
    const existing = this.peers.get(peerDeviceId);
    if (existing) {
      return existing;
    }

    const peerMeta = this.resolveParticipantMeta(peerDeviceId);
    const peerLabel = peerMeta?.deviceName ?? peerDeviceId;

    const peer = new CastoraWebRtcPeer({
      localDeviceId: this.deviceId,
      peerDeviceId,
      sessionId,
      targetFps: this.preferences.targetFps,
      networkPrefs: this.networkPrefs,
      rtcFactory: this.rtcFactory,
      iceDisconnectGraceMs: this.reconnectConfig.iceDisconnectGraceMs,
      callbacks: {
        onOfferCreated: (offer) => {
          const signaling = this.getSignalingClient();
          const roomId = this.activeRoom?.roomId;
          if (!signaling || !roomId) return;

          signaling.sendEnvelope({
            messageType: 'session_offer',
            senderDeviceId: this.deviceId,
            receiverDeviceId: peerDeviceId,
            roomId,
            payload: {
              sessionId,
              streamId: offer.streamId,
              sdpType: 'offer',
              sdp: offer.sdp,
              mediaInfo: {
                hasVideo: offer.hasVideo,
                hasAudio: offer.hasAudio,
                codecHint: offer.codecHint,
              },
            },
          });

          this.callbacks.onLogEvent(
            'webrtc',
            offer.iceRestart ? 'Sent WebRTC ICE restart offer' : 'Sent WebRTC SDP offer',
            `Peer: ${peerLabel} (${peerDeviceId}) · Stream ${offer.streamId}`
          );
        },
        onIceCandidate: (candidate, streamId) => {
          const signaling = this.getSignalingClient();
          const roomId = this.activeRoom?.roomId;
          if (!signaling || !roomId) return;

          signaling.sendEnvelope({
            messageType: 'ice_candidate',
            senderDeviceId: this.deviceId,
            receiverDeviceId: peerDeviceId,
            roomId,
            payload: {
              sessionId,
              streamId,
              sdpMid: candidate.sdpMid ?? null,
              sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
              candidate: candidate.candidate ?? '',
            },
          });
        },
        onInboundStream: (stream) => {
          const existingEntry = this.incomingMap.get(peerDeviceId);
          if (stream) {
            const meta = this.resolveParticipantMeta(peerDeviceId);
            const now = Date.now();
            const entry: IncomingScreenEntry = existingEntry ?? {
              senderDeviceId: peerDeviceId,
              senderName: meta?.deviceName ?? peerDeviceId,
              senderPlatform: meta?.platform ?? 'macos',
              sessionId,
              streamId: peer.getActiveInboundStreamId() ?? sessionId,
              phase: 'connected',
              iceConnectionState: null,
              statusDetail: 'Receiving live remote screen.',
              errorMessage: null,
              recovery: this.getPeerRecoveryState(peerDeviceId),
              stream,
              streamMeta: null,
              telemetry: createEmptyTelemetry(this.preferences.targetFps, 'connected'),
              renderedWidth: null,
              renderedHeight: null,
              startedAt: new Date(now).toISOString(),
              lastActivityAt: now,
            };
            entry.stream = stream;
            entry.phase = 'connected';
            entry.errorMessage = null;
            entry.lastActivityAt = now;
            entry.statusDetail = `Receiving live screen from ${entry.senderName}.`;
            this.incomingMap.set(peerDeviceId, entry);
            this.statusDetail = `Receiving live screen from ${entry.senderName}.`;
          } else if (existingEntry) {
            existingEntry.stream = null;
            existingEntry.renderedWidth = null;
            existingEntry.renderedHeight = null;
            if (!peer.getActiveInboundStreamId() && !this.reconnectingPeers.has(peerDeviceId)) {
              this.incomingMap.delete(peerDeviceId);
            } else {
              this.incomingMap.set(peerDeviceId, existingEntry);
            }
          }
          this.emit();
        },
        onPhaseChange: (phase, detail) => {
          if (phase === 'connected') {
            this.resetPeerRecovery(peerDeviceId);
          }
          const rec = this.getPeerRecoveryState(peerDeviceId);
          const effectivePhase =
            rec?.reconnecting && phase === 'disconnected' ? 'reconnecting' : phase;

          const outEntry = this.outboundMap.get(peerDeviceId);
          if (outEntry) {
            outEntry.phase = effectivePhase;
            outEntry.statusDetail = detail;
            outEntry.recovery = rec;
            if (phase === 'connected') {
              outEntry.errorMessage = null;
            }
            this.outboundMap.set(peerDeviceId, outEntry);
          }
          const inEntry = this.incomingMap.get(peerDeviceId);
          if (inEntry) {
            inEntry.phase = effectivePhase;
            inEntry.statusDetail = detail;
            inEntry.recovery = rec;
            if (phase === 'connected') {
              inEntry.errorMessage = null;
            }
            this.incomingMap.set(peerDeviceId, inEntry);
          }
          if (phase === 'connected') {
            const anyFailed =
              Array.from(this.outboundMap.values()).some((o) => o.phase === 'failed') ||
              Array.from(this.incomingMap.values()).some((i) => i.phase === 'failed');
            if (!anyFailed) {
              this.errorMessage = null;
            }
          }
          this.statusDetail = detail;
          this.emit();
        },
        onIceConnectionChange: (iceState) => {
          const outEntry = this.outboundMap.get(peerDeviceId);
          if (outEntry) {
            outEntry.iceConnectionState = iceState;
            this.outboundMap.set(peerDeviceId, outEntry);
          }
          const inEntry = this.incomingMap.get(peerDeviceId);
          if (inEntry) {
            inEntry.iceConnectionState = iceState;
            this.incomingMap.set(peerDeviceId, inEntry);
          }
          this.emit();
        },
        onConnectionFailure: (reason) => {
          this.schedulePeerRecovery(peerDeviceId, reason);
        },
        onCodecFallback: (nextCodec, reason) => {
          this.statusDetail = reason;
          this.callbacks.onLogEvent(
            'webrtc',
            `Video codec fell back to ${nextCodec} (${peerLabel})`,
            reason
          );
          const outEntry = this.outboundMap.get(peerDeviceId);
          if (outEntry) {
            outEntry.statusDetail = reason;
            outEntry.telemetry = {
              ...outEntry.telemetry,
              negotiatedVideoCodec: nextCodec,
              codecMimeType: `video/${nextCodec}`,
              codecFallbackReason: reason,
            };
            this.outboundMap.set(peerDeviceId, outEntry);
            const signaling = this.getSignalingClient();
            const roomId = this.activeRoom?.roomId;
            if (signaling && roomId) {
              const resolved = resolveQualityTarget(this.getEffectivePreferencesForPeer(peerDeviceId), {
                width: this.captureSession?.actualWidth,
                height: this.captureSession?.actualHeight,
              });
              signaling.sendEnvelope({
                messageType: 'stream_start',
                senderDeviceId: this.deviceId,
                receiverDeviceId: peerDeviceId,
                roomId,
                payload: {
                  sessionId: outEntry.sessionId,
                  streamId: outEntry.streamId,
                  width: Math.max(
                    320,
                    Math.min(3840, Math.round(this.captureSession?.actualWidth ?? resolved.targetWidth))
                  ),
                  height: Math.max(
                    240,
                    Math.min(2160, Math.round(this.captureSession?.actualHeight ?? resolved.targetHeight))
                  ),
                  fps: Math.max(
                    1,
                    Math.min(120, Math.round(this.captureSession?.actualFrameRate ?? resolved.targetFps))
                  ),
                  codec: nextCodec,
                },
              });
            }
          }
          this.emit();
        },
        onStats: (dualStats) => {
          const now = Date.now();
          const captureAudioStatus = this.captureSession?.audioCaptureStatus ?? null;
          const outEntry = this.outboundMap.get(peerDeviceId);
          if (outEntry) {
            const outAudioStatus = evaluateAudioDiagnosticState({
              isSharingLocal: Boolean(this.captureSession),
              hasIncomingStream: false,
              connectionState: outEntry.phase,
              localHasAudio: this.captureSession?.hasAudio ?? false,
              audioCaptureStatus: captureAudioStatus,
              audioSenderTrackStatus: dualStats.outbound.audioSenderTrackStatus,
              audioPacketsSent: dualStats.outbound.audioPacketsSent,
            });
            outEntry.telemetry = {
              ...dualStats.outbound,
              audioCaptureStatus: captureAudioStatus,
              audioDiagnosticStatus: outAudioStatus,
            };
            outEntry.lastActivityAt = now;
            this.outboundMap.set(peerDeviceId, outEntry);
          }
          const inEntry = this.incomingMap.get(peerDeviceId);
          if (inEntry) {
            const playbackStatus = inEntry.audioPlaybackStatus ?? null;
            const blocked = Boolean(inEntry.autoplayBlocked);
            const hasIncomingAudio = Boolean(inEntry.stream?.getAudioTracks().length);
            const inAudioStatus = evaluateAudioDiagnosticState({
              isSharingLocal: false,
              hasIncomingStream: Boolean(inEntry.stream),
              connectionState: inEntry.phase,
              hasIncomingAudioTrack: hasIncomingAudio,
              audioReceiverTrackStatus: dualStats.inbound.audioReceiverTrackStatus,
              audioPacketsReceived: dualStats.inbound.audioPacketsReceived,
              audioPlaybackStatus: playbackStatus,
              autoplayBlocked: blocked,
            });
            inEntry.telemetry = {
              ...dualStats.inbound,
              renderedWidth: inEntry.renderedWidth,
              renderedHeight: inEntry.renderedHeight,
              audioPlaybackStatus: playbackStatus,
              autoplayBlocked: blocked,
              audioDiagnosticStatus: inAudioStatus,
            };
            inEntry.lastActivityAt = now;
            this.incomingMap.set(peerDeviceId, inEntry);
          }
          this.emit();
        },
        onError: (msg) => {
          this.errorMessage = msg;
          const outEntry = this.outboundMap.get(peerDeviceId);
          if (outEntry) {
            outEntry.errorMessage = msg;
            this.outboundMap.set(peerDeviceId, outEntry);
          }
          const inEntry = this.incomingMap.get(peerDeviceId);
          if (inEntry) {
            inEntry.errorMessage = msg;
            this.incomingMap.set(peerDeviceId, inEntry);
          }
          this.callbacks.onLogEvent('error', `WebRTC peer error (${peerLabel})`, msg);
          this.emit();
        },
      },
    });

    this.peers.set(peerDeviceId, peer);
    return peer;
  }

  private clearPeerRecoveryTimers(peerDeviceId: string): void {
    const t = this.reconnectTimers.get(peerDeviceId);
    if (t !== undefined) {
      globalThis.clearTimeout(t);
      this.reconnectTimers.delete(peerDeviceId);
    }
    const v = this.verifyTimers.get(peerDeviceId);
    if (v !== undefined) {
      globalThis.clearTimeout(v);
      this.verifyTimers.delete(peerDeviceId);
    }
  }

  private resetPeerRecovery(peerDeviceId: string): void {
    this.clearPeerRecoveryTimers(peerDeviceId);
    const existing = this.recoveryMap.get(peerDeviceId);
    if (!existing || (!existing.reconnecting && !existing.exhausted && existing.attempt === 0)) {
      return;
    }
    const cleared: PeerConnectionRecoveryInfo = {
      attempt: 0,
      maxAttempts: this.reconnectConfig.maxAttempts,
      reconnecting: false,
      exhausted: false,
      lastError: null,
      mode: 'idle',
      nextRetryAt: null,
    };
    this.recoveryMap.set(peerDeviceId, cleared);
    const outEntry = this.outboundMap.get(peerDeviceId);
    if (outEntry) {
      outEntry.recovery = { ...cleared };
      outEntry.errorMessage = null;
      this.outboundMap.set(peerDeviceId, outEntry);
    }
    const inEntry = this.incomingMap.get(peerDeviceId);
    if (inEntry) {
      inEntry.recovery = { ...cleared };
      inEntry.errorMessage = null;
      this.incomingMap.set(peerDeviceId, inEntry);
    }
  }

  private syncRecoveryToEntries(
    peerDeviceId: string,
    rec: PeerConnectionRecoveryInfo,
    phaseOverride?: WebRtcConnectionPhase,
    detailOverride?: string
  ): void {
    const outEntry = this.outboundMap.get(peerDeviceId);
    if (outEntry) {
      outEntry.recovery = { ...rec };
      if (phaseOverride) outEntry.phase = phaseOverride;
      if (detailOverride) outEntry.statusDetail = detailOverride;
      if (rec.exhausted && rec.lastError) outEntry.errorMessage = rec.lastError;
      this.outboundMap.set(peerDeviceId, outEntry);
    }
    const inEntry = this.incomingMap.get(peerDeviceId);
    if (inEntry) {
      inEntry.recovery = { ...rec };
      if (phaseOverride) inEntry.phase = phaseOverride;
      if (detailOverride) inEntry.statusDetail = detailOverride;
      if (rec.exhausted && rec.lastError) inEntry.errorMessage = rec.lastError;
      this.incomingMap.set(peerDeviceId, inEntry);
    }
  }

  private schedulePeerRecovery(peerDeviceId: string, reason: string): void {
    if (this.disposed || !this.activeRoom || !this.isSelfAuthorizedInRoom()) return;

    const existingPeer = this.peers.get(peerDeviceId);
    if (existingPeer?.isHealthy()) {
      return;
    }

    const meta = this.resolveParticipantMeta(peerDeviceId);
    if (!meta || !meta.connected) {
      return;
    }

    // Prevent duplicate reconnection attempts for the same peer
    if (this.reconnectTimers.has(peerDeviceId) || this.reconnectingPeers.has(peerDeviceId)) {
      return;
    }

    const prev = this.recoveryMap.get(peerDeviceId) ?? {
      attempt: 0,
      maxAttempts: this.reconnectConfig.maxAttempts,
      reconnecting: false,
      exhausted: false,
      lastError: null,
      mode: 'idle' as const,
      nextRetryAt: null,
    };

    if (prev.attempt >= prev.maxAttempts) {
      const exhaustedRec: PeerConnectionRecoveryInfo = {
        ...prev,
        reconnecting: false,
        exhausted: true,
        lastError: reason,
        mode: 'idle',
        nextRetryAt: null,
      };
      this.recoveryMap.set(peerDeviceId, exhaustedRec);
      this.syncRecoveryToEntries(peerDeviceId, exhaustedRec, 'failed', reason);
      this.errorMessage = `Connection to ${meta.deviceName} failed after ${prev.maxAttempts} recovery attempts. Click Retry to reconnect.`;
      this.callbacks.onLogEvent(
        'error',
        `Automatic reconnection exhausted (${meta.deviceName})`,
        reason
      );
      this.emit();
      return;
    }

    const nextAttempt = prev.attempt + 1;
    const delayMs = Math.min(
      this.reconnectConfig.maxDelayMs,
      this.reconnectConfig.baseDelayMs * Math.pow(2, nextAttempt - 1)
    );
    const diag = existingPeer?.getConnectionDiagnostics();
    const mode: 'ice-restart' | 'peer-replace' =
      nextAttempt === 1 && existingPeer && diag && diag.signalingState !== 'closed'
        ? 'ice-restart'
        : 'peer-replace';

    const nextRec: PeerConnectionRecoveryInfo = {
      attempt: nextAttempt,
      maxAttempts: prev.maxAttempts,
      reconnecting: true,
      exhausted: false,
      lastError: reason,
      mode,
      nextRetryAt: Date.now() + delayMs,
    };
    this.recoveryMap.set(peerDeviceId, nextRec);
    this.syncRecoveryToEntries(
      peerDeviceId,
      nextRec,
      'reconnecting',
      `Reconnecting to ${meta.deviceName} (attempt ${nextAttempt}/${nextRec.maxAttempts})...`
    );
    this.callbacks.onLogEvent(
      'webrtc',
      `Scheduled reconnection for ${meta.deviceName}`,
      `Attempt ${nextAttempt}/${nextRec.maxAttempts} (${mode}) in ${delayMs} ms`
    );
    this.emit();

    const timer = globalThis.setTimeout(() => {
      this.reconnectTimers.delete(peerDeviceId);
      void this.executePeerRecovery(peerDeviceId, nextAttempt, mode, reason);
    }, delayMs);
    this.reconnectTimers.set(peerDeviceId, timer);
  }

  private async executePeerRecovery(
    peerDeviceId: string,
    attempt: number,
    mode: 'ice-restart' | 'peer-replace',
    reason: string
  ): Promise<void> {
    if (this.disposed || !this.activeRoom || !this.isSelfAuthorizedInRoom()) return;
    if (this.reconnectingPeers.has(peerDeviceId)) return;

    this.reconnectingPeers.add(peerDeviceId);
    let failedErrMsg: string | null = null;
    try {
      if (this.onRefreshIceServers) {
        try {
          const freshPrefs = await this.onRefreshIceServers();
          if (freshPrefs) {
            this.networkPrefs = freshPrefs;
          }
        } catch {
          // Proceed with current ICE config if refresh fails transiently
        }
      }

      if (this.disposed || !this.activeRoom) return;
      const meta = this.resolveParticipantMeta(peerDeviceId);
      if (!meta || !meta.connected) return;

      const currentPeer = this.peers.get(peerDeviceId);
      if (currentPeer?.isHealthy()) {
        this.resetPeerRecovery(peerDeviceId);
        this.emit();
        return;
      }

      const activeRec: PeerConnectionRecoveryInfo = {
        attempt,
        maxAttempts: this.reconnectConfig.maxAttempts,
        reconnecting: true,
        exhausted: false,
        lastError: reason,
        mode,
        nextRetryAt: null,
      };
      this.recoveryMap.set(peerDeviceId, activeRec);

      if (mode === 'ice-restart' && currentPeer) {
        const restarted = await currentPeer.triggerIceRestart();
        if (restarted) {
          this.syncRecoveryToEntries(
            peerDeviceId,
            activeRec,
            'reconnecting',
            `ICE restart sent to ${meta.deviceName} (attempt ${attempt}/${activeRec.maxAttempts})...`
          );
          this.emit();

          // Arm verification check: if peer has not recovered cleanly, advance retry state
          const vTimer = globalThis.setTimeout(() => {
            this.verifyTimers.delete(peerDeviceId);
            if (this.disposed) return;
            const checkedPeer = this.peers.get(peerDeviceId);
            if (checkedPeer?.isHealthy()) {
              this.resetPeerRecovery(peerDeviceId);
              this.emit();
              return;
            }
            const cur = this.recoveryMap.get(peerDeviceId);
            if (cur?.reconnecting) {
              this.schedulePeerRecovery(peerDeviceId, reason);
            }
          }, this.reconnectConfig.recoveryVerifyMs);
          this.verifyTimers.set(peerDeviceId, vTimer);
          return;
        }
      }

      // Full peer replacement: snapshot state, clean up old RTCPeerConnection BEFORE creating replacement
      const prevOut = this.outboundMap.get(peerDeviceId) ?? null;
      const prevIn = this.incomingMap.get(peerDeviceId) ?? null;
      const hadOutbound = Boolean(
        this.captureSession && (prevOut || this.desiredOutboundTargets.has(peerDeviceId))
      );
      const expectedInboundStreamId =
        currentPeer?.getActiveInboundStreamId() ?? prevIn?.streamId ?? null;
      const sessionId = prevOut?.sessionId ?? prevIn?.sessionId ?? meta.sessionId;

      if (currentPeer) {
        this.peers.delete(peerDeviceId);
        currentPeer.close('Replacing failed peer connection');
      }

      if (prevIn) {
        this.incomingMap.set(peerDeviceId, {
          ...prevIn,
          stream: null,
          phase: 'reconnecting',
          errorMessage: null,
          recovery: { ...activeRec, mode: 'peer-replace' },
          statusDetail: `Replacing connection to ${meta.deviceName}...`,
        });
      }
      if (prevOut) {
        this.outboundMap.set(peerDeviceId, {
          ...prevOut,
          phase: 'reconnecting',
          errorMessage: null,
          recovery: { ...activeRec, mode: 'peer-replace' },
          statusDetail: `Replacing connection to ${meta.deviceName}...`,
        });
      }

      const replacement = this.getOrCreatePeer(peerDeviceId, sessionId);
      if (hadOutbound && this.captureSession) {
        await this.publishActiveCaptureToPeer(
          peerDeviceId,
          Math.max(1, this.outboundMap.size)
        );
      } else if (prevIn) {
        replacement.markInboundStreamExpected(
          expectedInboundStreamId ?? sessionId,
          prevIn.streamMeta?.fps ?? this.preferences.targetFps
        );
        await replacement.requestInboundRecoveryOffer();
      }

      this.callbacks.onLogEvent(
        'webrtc',
        `Replaced failed peer connection for ${meta.deviceName}`,
        `Cleanly closed prior RTCPeerConnection and started replacement handshake (attempt ${attempt}/${activeRec.maxAttempts}).`
      );
      this.emit();

      // Verify replacement progresses to connected; otherwise schedule next attempt up to maxAttempts
      const vTimer = globalThis.setTimeout(() => {
        this.verifyTimers.delete(peerDeviceId);
        if (this.disposed) return;
        const checkedPeer = this.peers.get(peerDeviceId);
        if (checkedPeer?.isHealthy()) {
          this.resetPeerRecovery(peerDeviceId);
          this.emit();
          return;
        }
        const cur = this.recoveryMap.get(peerDeviceId);
        if (cur?.reconnecting) {
          this.schedulePeerRecovery(peerDeviceId, reason);
        }
      }, this.reconnectConfig.recoveryVerifyMs);
      this.verifyTimers.set(peerDeviceId, vTimer);
    } catch (err) {
      failedErrMsg = err instanceof Error ? err.message : reason;
    } finally {
      this.reconnectingPeers.delete(peerDeviceId);
    }
    if (failedErrMsg !== null && !this.disposed) {
      this.schedulePeerRecovery(peerDeviceId, failedErrMsg);
    }
  }

  async retryPeerConnection(peerDeviceId: string): Promise<boolean> {
    if (this.disposed || !this.activeRoom || !this.isSelfAuthorizedInRoom()) {
      return false;
    }
    const existing = this.peers.get(peerDeviceId);
    if (existing?.isHealthy()) {
      return false;
    }
    const meta = this.resolveParticipantMeta(peerDeviceId);
    if (!meta || !meta.connected) {
      return false;
    }

    this.clearPeerRecoveryTimers(peerDeviceId);
    this.recoveryMap.set(peerDeviceId, {
      attempt: 1,
      maxAttempts: this.reconnectConfig.maxAttempts,
      reconnecting: true,
      exhausted: false,
      lastError: null,
      mode: 'peer-replace',
      nextRetryAt: null,
    });
    this.errorMessage = null;
    await this.executePeerRecovery(peerDeviceId, 1, 'peer-replace', 'Manual connection retry');
    return true;
  }

  async retryAllFailedConnections(): Promise<number> {
    const candidates = new Set<string>();
    for (const [id, entry] of this.incomingMap.entries()) {
      if (entry.phase === 'failed' || entry.recovery?.exhausted) {
        candidates.add(id);
      }
    }
    for (const [id, entry] of this.outboundMap.entries()) {
      if (entry.phase === 'failed' || entry.recovery?.exhausted) {
        candidates.add(id);
      }
    }
    for (const [id, rec] of this.recoveryMap.entries()) {
      if (rec.exhausted) {
        candidates.add(id);
      }
    }

    let triggered = 0;
    for (const peerId of candidates) {
      if (await this.retryPeerConnection(peerId)) {
        triggered += 1;
      }
    }
    return triggered;
  }

  private removePeerConnection(peerDeviceId: string, reason: string): void {
    this.clearPeerRecoveryTimers(peerDeviceId);
    this.reconnectingPeers.delete(peerDeviceId);
    this.recoveryMap.delete(peerDeviceId);
    const peer = this.peers.get(peerDeviceId);
    if (peer) {
      this.peers.delete(peerDeviceId);
      peer.close(reason);
    }
    this.outboundMap.delete(peerDeviceId);
    this.incomingMap.delete(peerDeviceId);
    this.peerQualityOverrides.delete(peerDeviceId);
  }

  updateContext(params: {
    deviceId: string;
    activeRoom: RoomSnapshot | null;
    activeRoomRole: 'host' | 'receiver' | null;
    preferences: CapturePreferences;
    networkPrefs: NetworkPreferences;
  }): void {
    this.deviceId = params.deviceId;
    this.preferences = params.preferences;
    this.networkPrefs = params.networkPrefs;

    const prevRoomId = this.activeRoom?.roomId ?? null;
    const nextRoomId = params.activeRoom?.roomId ?? null;
    this.activeRoom = params.activeRoom;
    this.activeRoomRole = params.activeRoomRole;

    if (prevRoomId && !nextRoomId) {
      for (const peerId of Array.from(this.peers.keys())) {
        this.removePeerConnection(peerId, 'Room closed or disconnected.');
      }
      if (this.captureSession) {
        this.captureSession.stop();
        this.captureSession = null;
      }
      this.outboundStreamId = null;
      this.autoBroadcastToRoom = false;
      this.desiredOutboundTargets.clear();
      this.pendingAutoPublishPeers.clear();
      this.statusDetail = null;
      this.errorMessage = null;
      this.emit();
      return;
    }

    if (!this.activeRoom) return;

    // Close only peers that left the room or dropped their signaling connection;
    // keep all other peer streams and local capture completely undisturbed.
    // Also synchronize renamed participant display names onto live incoming/outbound entries.
    let changed = false;
    for (const [peerId, inEntry] of this.incomingMap.entries()) {
      const meta = this.resolveParticipantMeta(peerId);
      if (meta && inEntry.senderName !== meta.deviceName) {
        inEntry.senderName = meta.deviceName;
        this.incomingMap.set(peerId, inEntry);
        changed = true;
      }
    }
    for (const [peerId, outEntry] of this.outboundMap.entries()) {
      const meta = this.resolveParticipantMeta(peerId);
      if (meta && outEntry.targetName !== meta.deviceName) {
        outEntry.targetName = meta.deviceName;
        this.outboundMap.set(peerId, outEntry);
        changed = true;
      }
    }
    for (const peerId of Array.from(this.peers.keys())) {
      const meta = this.resolveParticipantMeta(peerId);
      if (!meta || !meta.connected) {
        this.removePeerConnection(peerId, `Peer ${peerId} disconnected or removed.`);
        this.statusDetail = `Peer ${meta?.deviceName ?? peerId} disconnected.`;
        changed = true;
      }
    }

    // Reconcile server-authoritative activeStreams if a remote stream ended remotely
    if (Array.isArray(this.activeRoom.activeStreams)) {
      const serverInboundPublishers = new Set(
        this.activeRoom.activeStreams
          .filter((s) => s.targetDeviceId === this.deviceId)
          .map((s) => s.publisherDeviceId)
      );
      for (const [senderId, entry] of this.incomingMap.entries()) {
        if (!serverInboundPublishers.has(senderId) && !this.reconnectingPeers.has(senderId)) {
          const peer = this.peers.get(senderId);
          peer?.clearInboundStream(`${entry.senderName} stopped screen sharing.`);
          this.incomingMap.delete(senderId);
          changed = true;
        }
      }
    }

    // Resume sharing automatically when a target or room participant reconnects
    if (this.captureSession && this.isSelfAuthorizedInRoom()) {
      const candidates = this.autoBroadcastToRoom
        ? this.resolvePublishTargets('ALL')
        : Array.from(this.desiredOutboundTargets).filter((id) => {
            const m = this.resolveParticipantMeta(id);
            return Boolean(m?.connected);
          });
      for (const peerId of candidates) {
        if (
          !this.outboundMap.has(peerId) &&
          !this.pendingAutoPublishPeers.has(peerId)
        ) {
          this.pendingAutoPublishPeers.add(peerId);
          void this.publishActiveCaptureToPeer(peerId)
            .catch(() => {
              // Ignore transient peer connection failures on auto-broadcast; error logged via peer callback
            })
            .finally(() => {
              this.pendingAutoPublishPeers.delete(peerId);
            });
        }
      }
    }

    if (changed) {
      this.emit();
    }
  }

  private resolvePublishTargets(targetSelection: string | string[] | null): string[] {
    if (!this.activeRoom || !this.isSelfAuthorizedInRoom()) {
      return [];
    }

    const connectedPeers: string[] = [];
    if (this.activeRoom.hostDeviceId !== this.deviceId && this.activeRoom.hostConnected) {
      connectedPeers.push(this.activeRoom.hostDeviceId);
    }
    for (const rx of this.activeRoom.pairedReceivers) {
      if (rx.deviceId !== this.deviceId && rx.connected) {
        connectedPeers.push(rx.deviceId);
      }
    }

    if (targetSelection === 'ALL' || targetSelection === null) {
      return connectedPeers;
    }

    if (Array.isArray(targetSelection)) {
      return targetSelection.filter((id) => connectedPeers.includes(id));
    }

    if (typeof targetSelection === 'string' && targetSelection.trim().length > 0) {
      return connectedPeers.includes(targetSelection) ? [targetSelection] : [];
    }

    return connectedPeers;
  }

  async startScreenSharing(targetSelection: string | string[] | null = null): Promise<void> {
    this.errorMessage = null;

    if (this.activeRoom && !this.isSelfAuthorizedInRoom()) {
      const msg = 'Waiting for host pairing approval before sharing your screen.';
      this.errorMessage = msg;
      this.statusDetail = msg;
      this.emit();
      throw new Error(msg);
    }

    let session: CapturedScreenSession;
    try {
      session = await this.captureFn({
        preferences: this.preferences,
        onNativeEnded: () => {
          this.callbacks.onLogEvent(
            'webrtc',
            'Screen sharing ended via browser control',
            'Stopped local screen capture tracks and notified peers.'
          );
          this.stopSharing('capture_revoked');
        },
        onAudioTrackStateChange: (status, notice) => {
          if (this.captureSession === session) {
            this.captureSession.audioCaptureStatus = status;
            this.captureSession.audioNotice = notice;
            if (notice) {
              this.statusDetail = notice;
              this.callbacks.onLogEvent('webrtc', 'Screen audio track state updated', notice);
            }
            this.emit();
          }
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start screen capture';
      // Preserve any existing working capture session if re-capture/upgrade was cancelled or failed
      this.errorMessage = message;
      this.statusDetail = this.captureSession
        ? `${message} Previous screen share remains active.`
        : message;
      this.callbacks.onLogEvent('error', 'Screen capture failed', message);
      this.emit();
      throw err;
    }

    if (this.captureSession) {
      this.captureSession.stop();
    }
    this.captureSession = session;
    this.outboundStreamId = createId('stream');
    this.autoBroadcastToRoom = targetSelection === null || targetSelection === 'ALL';

    const resLabel =
      session.actualWidth && session.actualHeight
        ? `${session.actualWidth}×${session.actualHeight}`
        : null;

    const requestedSpec = resolveQualityTarget(this.preferences);
    if (
      this.preferences.resolution !== 'native' &&
      session.actualWidth &&
      session.actualHeight &&
      (session.actualWidth < requestedSpec.targetWidth ||
        session.actualHeight < requestedSpec.targetHeight)
    ) {
      const capNotice = `Requested ${requestedSpec.preset.label} (${requestedSpec.targetWidth}×${requestedSpec.targetHeight}), display surface provided actual ${session.actualWidth}×${session.actualHeight}.`;
      this.statusDetail = capNotice;
      this.callbacks.onLogEvent('webrtc', 'Actual capture resolution reported', capNotice);
    }

    if (this.preferences.includeAudio && !session.hasAudio && session.audioNotice) {
      this.callbacks.onLogEvent('webrtc', 'Screen shared without audio track', session.audioNotice);
      if (!this.statusDetail) {
        this.statusDetail = session.audioNotice;
      }
    }

    this.callbacks.onLogEvent(
      'webrtc',
      'Local screen capture started',
      `Track active${resLabel ? ` (${resLabel})` : ''}${session.actualFrameRate ? ` @ ${Math.round(session.actualFrameRate)} FPS` : ''} · Audio: ${session.hasAudio ? 'captured' : session.audioCaptureStatus}.`
    );

    const targets = this.resolvePublishTargets(targetSelection);
    this.desiredOutboundTargets = new Set(targets);
    if (targets.length === 0) {
      if (!this.statusDetail) {
        this.statusDetail = this.activeRoom
          ? 'Local preview active. Waiting for an approved connected peer in this room.'
          : 'Local preview active. Create or join a paired room to share your screen.';
      }
      this.emit();
      return;
    }

    // Stop outbound on any previous targets not in the new target list
    for (const oldTargetId of Array.from(this.outboundMap.keys())) {
      if (!targets.includes(oldTargetId)) {
        await this.stopPublishingToPeer(oldTargetId, 'user_stopped');
      }
    }

    const errors: string[] = [];
    for (const peerId of targets) {
      try {
        await this.publishActiveCaptureToPeer(peerId, targets.length);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : `Failed connecting to ${peerId}`);
      }
    }

    if (errors.length > 0 && errors.length === targets.length) {
      const msg = errors[0];
      this.errorMessage = msg;
      this.statusDetail = msg;
      this.emit();
      throw new Error(msg);
    }

    this.emit();
  }

  async connectStreamToReceiver(targetPeerDeviceId: string): Promise<void> {
    if (!this.captureSession) {
      throw new Error('Start screen capture before connecting to a participant.');
    }
    if (!this.activeRoom || !this.isSelfAuthorizedInRoom()) {
      throw new Error('Create or join an approved room before transmitting your screen.');
    }
    this.desiredOutboundTargets.add(targetPeerDeviceId);
    await this.publishActiveCaptureToPeer(
      targetPeerDeviceId,
      Math.max(1, this.outboundMap.size + 1)
    );
    this.emit();
  }

  private async publishActiveCaptureToPeer(
    targetPeerDeviceId: string,
    expectedOutboundPeersCount?: number
  ): Promise<void> {
    if (!this.captureSession || !this.activeRoom) return;

    const meta = this.resolveParticipantMeta(targetPeerDeviceId);
    if (!meta || !meta.connected) {
      throw new Error(`Participant ${targetPeerDeviceId} is not connected in this room.`);
    }

    const signaling = this.getSignalingClient();
    if (!signaling) {
      throw new Error('Signaling WebSocket is not connected.');
    }

    const streamId = this.outboundStreamId ?? createId('stream');
    this.outboundStreamId = streamId;
    const sessionId = meta.sessionId;
    const roomId = this.activeRoom.roomId;

    const effectivePrefs = this.getEffectivePreferencesForPeer(targetPeerDeviceId);
    const resolvedQuality = resolveQualityTarget(effectivePrefs, {
      width: this.captureSession.actualWidth,
      height: this.captureSession.actualHeight,
    });

    const peer = this.getOrCreatePeer(targetPeerDeviceId, sessionId);

    this.outboundMap.set(targetPeerDeviceId, {
      targetDeviceId: targetPeerDeviceId,
      targetName: meta.deviceName,
      targetPlatform: meta.platform,
      sessionId,
      streamId,
      phase: 'connecting',
      iceConnectionState: null,
      statusDetail: `Connecting outbound stream to ${meta.deviceName}...`,
      errorMessage: null,
      qualityOverride: this.peerQualityOverrides.get(targetPeerDeviceId) ?? null,
      lastActivityAt: Date.now(),
      telemetry: {
        ...createEmptyTelemetry(effectivePrefs.targetFps, 'connecting'),
        configuredMaxBitrateKbps: resolvedQuality.configuredMaxBitrateKbps,
        targetBitrateKbps: resolvedQuality.configuredMaxBitrateKbps,
        targetFramerate: effectivePrefs.targetFps,
        scaleResolutionDownBy: 1.0,
        adaptationStatus: 'target',
        adaptiveMode: resolvedQuality.adaptiveEnabled ? 'auto' : 'manual',
        networkCondition: 'unavailable',
        lastAdjustmentAction: resolvedQuality.adaptiveEnabled ? 'none' : 'manual-locked',
        lastAdjustmentReason: resolvedQuality.adaptiveEnabled
          ? null
          : 'Manual quality locked — automatic adaptation paused.',
        resolution:
          this.captureSession.actualWidth && this.captureSession.actualHeight
            ? `${this.captureSession.actualWidth}×${this.captureSession.actualHeight}`
            : null,
        selectedVideoCodec: effectivePrefs.codecPreference,
        audioCaptureStatus: this.captureSession.audioCaptureStatus,
        audioSenderTrackStatus: this.captureSession.hasAudio ? 'live' : 'none',
        audioDiagnosticStatus: evaluateAudioDiagnosticState({
          isSharingLocal: true,
          hasIncomingStream: false,
          connectionState: 'connecting',
          localHasAudio: this.captureSession.hasAudio,
          audioCaptureStatus: this.captureSession.audioCaptureStatus,
          audioSenderTrackStatus: this.captureSession.hasAudio ? 'live' : 'none',
        }),
      },
    });
    this.statusDetail = `Sharing screen to ${meta.deviceName}...`;
    this.emit();

    const width = Math.max(
      320,
      Math.min(3840, Math.round(this.captureSession.actualWidth ?? resolvedQuality.targetWidth))
    );
    const height = Math.max(
      240,
      Math.min(2160, Math.round(this.captureSession.actualHeight ?? resolvedQuality.targetHeight))
    );
    const fps = Math.max(
      1,
      Math.min(120, Math.round(this.captureSession.actualFrameRate ?? effectivePrefs.targetFps))
    );
    const announcedCodec: CastoraVideoCodec =
      effectivePrefs.codecPreference === 'H264'
        ? 'H264'
        : effectivePrefs.codecPreference === 'VP9'
          ? 'VP9'
          : effectivePrefs.codecPreference === 'AV1'
            ? 'AV1'
            : 'VP8';

    // Register stream_start on signaling server before/alongside SDP offer
    signaling.sendEnvelope({
      messageType: 'stream_start',
      senderDeviceId: this.deviceId,
      receiverDeviceId: targetPeerDeviceId,
      roomId,
      payload: {
        sessionId,
        streamId,
        width,
        height,
        fps,
        codec: announcedCodec,
      },
    });

    const activePeerCount = expectedOutboundPeersCount ?? Math.max(1, this.outboundMap.size);

    await peer.publishLocalStream({
      localStream: this.captureSession.stream,
      streamId,
      preferences: effectivePrefs,
      activeOutboundPeers: activePeerCount,
    });
  }

  private async stopPublishingToPeer(
    targetPeerDeviceId: string,
    reason: 'user_stopped' | 'capture_revoked'
  ): Promise<void> {
    const outEntry = this.outboundMap.get(targetPeerDeviceId);
    const signaling = this.getSignalingClient();
    const roomId = this.activeRoom?.roomId ?? null;

    if (outEntry && signaling && roomId) {
      signaling.sendEnvelope({
        messageType: 'stream_stop',
        senderDeviceId: this.deviceId,
        receiverDeviceId: targetPeerDeviceId,
        roomId,
        payload: {
          sessionId: outEntry.sessionId,
          streamId: outEntry.streamId,
          reason,
        },
      });
    }

    this.outboundMap.delete(targetPeerDeviceId);
    this.desiredOutboundTargets.delete(targetPeerDeviceId);
    const peer = this.peers.get(targetPeerDeviceId);
    if (peer) {
      await peer.stopLocalStream();
    }

    // Rebalance concurrency headroom for remaining outbound peers cleanly
    const remainingCount = this.outboundMap.size;
    if (remainingCount > 0) {
      for (const remainingPeerId of this.outboundMap.keys()) {
        const remainingPeer = this.peers.get(remainingPeerId);
        if (remainingPeer && remainingPeer.hasOutboundStream()) {
          void remainingPeer.updateEncodingPreferences(
            this.getEffectivePreferencesForPeer(remainingPeerId),
            remainingCount
          );
        }
      }
    }
  }

  async stopOutgoingStreamToPeer(targetPeerDeviceId: string): Promise<void> {
    const outEntry = this.outboundMap.get(targetPeerDeviceId);
    const targetName = outEntry?.targetName ?? targetPeerDeviceId;
    this.autoBroadcastToRoom = false;
    await this.stopPublishingToPeer(targetPeerDeviceId, 'user_stopped');
    this.statusDetail = `Stopped outgoing stream to ${targetName}.`;
    this.callbacks.onLogEvent(
      'webrtc',
      `Stopped outgoing stream to ${targetName}`,
      this.outboundMap.size > 0
        ? `Remaining ${this.outboundMap.size} outbound stream(s) unaffected.`
        : 'Local screen preview remains ready.'
    );
    this.emit();
  }

  stopSharing(reason: 'user_stopped' | 'capture_revoked' = 'user_stopped'): void {
    this.autoBroadcastToRoom = false;
    this.desiredOutboundTargets.clear();
    this.pendingAutoPublishPeers.clear();
    const activeTargetIds = Array.from(this.outboundMap.keys());
    for (const peerId of activeTargetIds) {
      void this.stopPublishingToPeer(peerId, reason);
    }

    if (this.captureSession) {
      this.captureSession.stop();
      this.captureSession = null;
    }
    this.outboundStreamId = null;
    this.errorMessage = null;
    this.statusDetail =
      this.incomingMap.size > 0
        ? 'Stopped your outbound screen share. Incoming streams remain active.'
        : reason === 'capture_revoked'
          ? 'Screen sharing ended via browser controls.'
          : 'Screen sharing stopped.';

    this.callbacks.onLogEvent(
      'webrtc',
      'Stopped local screen share',
      this.incomingMap.size > 0
        ? `Stopped outbound tracks (${reason}) while keeping ${this.incomingMap.size} incoming stream(s) active.`
        : `Stopped outbound tracks (${reason}).`
    );

    this.emit();
  }

  async handleIncomingEnvelope(envelope: CastoraEnvelope): Promise<void> {
    if (!this.activeRoom || envelope.roomId !== this.activeRoom.roomId) {
      return;
    }
    if (envelope.senderDeviceId === this.deviceId) {
      return;
    }
    if (!this.isSelfAuthorizedInRoom()) {
      return;
    }

    const senderMeta = this.resolveParticipantMeta(envelope.senderDeviceId);
    if (!senderMeta) {
      return;
    }

    const signaling = this.getSignalingClient();
    if (!signaling) return;

    if (envelope.messageType === 'stream_start') {
      const p = envelope.payload as {
        width: number;
        height: number;
        fps: number;
        codec: CastoraVideoCodec;
        sessionId: string;
        streamId: string;
      };

      const peer = this.getOrCreatePeer(envelope.senderDeviceId, p.sessionId);
      peer.markInboundStreamExpected(p.streamId, p.fps);

      const existing = this.incomingMap.get(envelope.senderDeviceId);
      const now = Date.now();
      this.incomingMap.set(envelope.senderDeviceId, {
        senderDeviceId: envelope.senderDeviceId,
        senderName: senderMeta.deviceName,
        senderPlatform: senderMeta.platform,
        sessionId: p.sessionId,
        streamId: p.streamId,
        phase: existing?.stream ? 'connected' : 'connecting',
        iceConnectionState: existing?.iceConnectionState ?? null,
        statusDetail: `${senderMeta.deviceName} started ${p.width}×${p.height} @ ${p.fps} FPS (${p.codec}).`,
        errorMessage: null,
        stream: existing?.stream ?? null,
        streamMeta: {
          width: p.width,
          height: p.height,
          fps: p.fps,
          codec: p.codec,
        },
        telemetry: existing?.telemetry ?? createEmptyTelemetry(p.fps, 'connecting'),
        renderedWidth: existing?.renderedWidth ?? null,
        renderedHeight: existing?.renderedHeight ?? null,
        startedAt: existing?.startedAt ?? new Date(now).toISOString(),
        lastActivityAt: now,
      });
      this.statusDetail = `Receiving stream announcement from ${senderMeta.deviceName}...`;
      this.callbacks.onLogEvent(
        'webrtc',
        'Incoming stream announcement',
        `${senderMeta.deviceName} started ${p.width}×${p.height} @ ${p.fps} FPS (${p.codec}).`
      );
      this.emit();
      return;
    }

    if (envelope.messageType === 'session_offer') {
      const p = envelope.payload as {
        sessionId: string;
        streamId: string;
        sdp: string;
        mediaInfo?: { hasVideo?: boolean; hasAudio?: boolean };
      };

      const peer = this.getOrCreatePeer(envelope.senderDeviceId, p.sessionId);
      try {
        const expectedInboundStreamId =
          p.mediaInfo?.hasVideo === false ? undefined : p.streamId;
        const answerSdp = await peer.acceptOfferAndCreateAnswer(
          p.sdp,
          expectedInboundStreamId
        );
        if (answerSdp) {
          signaling.sendEnvelope({
            messageType: 'session_answer',
            senderDeviceId: this.deviceId,
            receiverDeviceId: envelope.senderDeviceId,
            roomId: envelope.roomId,
            payload: {
              sessionId: p.sessionId,
              streamId: p.streamId,
              sdpType: 'answer',
              sdp: answerSdp,
            },
          });
          this.callbacks.onLogEvent(
            'webrtc',
            'Sent WebRTC SDP answer',
            `Returned SDP answer to ${senderMeta.deviceName} (${envelope.senderDeviceId}).`
          );
        } else {
          this.callbacks.onLogEvent(
            'webrtc',
            'Resolved SDP offer glare (impolite)',
            `Ignored colliding offer from ${senderMeta.deviceName}; awaiting peer answer.`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to negotiate SDP offer';
        this.errorMessage = msg;
        this.statusDetail = msg;
        this.callbacks.onLogEvent('error', 'SDP offer handling failed', msg);
        this.emit();
      }
      return;
    }

    if (envelope.messageType === 'session_answer') {
      const peer = this.peers.get(envelope.senderDeviceId);
      if (!peer) return;
      const p = envelope.payload as { sessionId: string; streamId: string; sdp: string };
      try {
        await peer.acceptAnswer(p.sdp);
        this.callbacks.onLogEvent(
          'webrtc',
          'Applied WebRTC SDP answer',
          `Completed SDP handshake with ${senderMeta.deviceName} (${envelope.senderDeviceId}).`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to apply SDP answer';
        this.errorMessage = msg;
        this.statusDetail = msg;
        this.callbacks.onLogEvent('error', 'SDP answer error', msg);
        this.emit();
      }
      return;
    }

    if (envelope.messageType === 'ice_candidate') {
      const peer = this.peers.get(envelope.senderDeviceId);
      if (!peer) return;
      const p = envelope.payload as {
        sessionId: string;
        sdpMid: string | null;
        sdpMLineIndex: number;
        candidate: string;
      };
      await peer.addIceCandidate({
        candidate: p.candidate,
        sdpMid: p.sdpMid,
        sdpMLineIndex: p.sdpMLineIndex,
      });
      return;
    }

    if (envelope.messageType === 'stream_stop') {
      const p = envelope.payload as { reason?: string; streamId?: string };

      // Host-initiated remote stop of our own outbound stream
      const matchingOutbound = Array.from(this.outboundMap.values()).find(
        (o) => (p.streamId && o.streamId === p.streamId) || o.targetDeviceId === envelope.senderDeviceId
      );
      if (
        matchingOutbound &&
        envelope.receiverDeviceId === this.deviceId &&
        envelope.senderDeviceId === this.activeRoom?.hostDeviceId
      ) {
        const stoppedTargets = Array.from(this.outboundMap.entries())
          .filter(([, o]) => !p.streamId || o.streamId === p.streamId)
          .map(([id]) => id);
        for (const targetId of stoppedTargets) {
          this.outboundMap.delete(targetId);
          this.desiredOutboundTargets.delete(targetId);
          const peer = this.peers.get(targetId);
          if (peer) {
            await peer.stopLocalStream();
          }
        }
        if (this.outboundMap.size === 0 && this.captureSession) {
          this.captureSession.stop();
          this.captureSession = null;
          this.outboundStreamId = null;
          this.autoBroadcastToRoom = false;
        }
        const hostReason = 'Your outgoing screen share was stopped by the room host.';
        this.statusDetail = hostReason;
        this.callbacks.onLogEvent('webrtc', 'Outgoing stream stopped by host', hostReason);
        this.emit();
        return;
      }

      const reasonText =
        p.reason === 'capture_revoked'
          ? `${senderMeta.deviceName} ended screen sharing via browser controls.`
          : p.reason === 'network_lost'
            ? `${senderMeta.deviceName}'s stream ended due to network disconnection.`
            : `${senderMeta.deviceName} stopped screen sharing.`;

      this.incomingMap.delete(envelope.senderDeviceId);
      const peer = this.peers.get(envelope.senderDeviceId);
      peer?.clearInboundStream(reasonText);

      this.statusDetail = reasonText;
      this.callbacks.onLogEvent('webrtc', 'Remote stream stopped', reasonText);
      this.emit();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const peerId of Array.from(this.peers.keys())) {
      this.removePeerConnection(peerId, 'Session disposed');
    }
    for (const peerId of Array.from(this.reconnectTimers.keys())) {
      this.clearPeerRecoveryTimers(peerId);
    }
    if (this.captureSession) {
      this.captureSession.stop();
      this.captureSession = null;
    }
    this.outboundStreamId = null;
    this.desiredOutboundTargets.clear();
  }
}
