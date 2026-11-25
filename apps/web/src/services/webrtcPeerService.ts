import type { CastoraVideoCodec } from '../types/protocol';
import type {
  AdaptiveControlCapabilities,
  AudioTrackStatus,
  CapturePreferences,
  CodecPreference,
  NetworkPreferences,
  StreamTelemetrySnapshot,
  WebRtcConnectionPhase,
} from '../types/studio';
import {
  WebRtcStatsCollector,
  createEmptyTelemetry,
  type BidirectionalTelemetrySample,
} from './streamStatsService';
import {
  AdaptiveBitrateController,
  getNextFallbackCodec,
  inspectSdpNegotiatedMedia,
  normalizeVideoCodecName,
  orderVideoCodecsForPreference,
  resolveQualityTarget,
  type AdaptiveBitrateDecision,
} from './videoQualityService';

function parseCommaUrls(raw: string): string[] {
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0 && !/\s/.test(u));
}

export function buildRtcConfiguration(networkPrefs: NetworkPreferences): RTCConfiguration {
  const iceServers: RTCIceServer[] = [];
  const seenStun = new Set<string>();

  if (Array.isArray(networkPrefs.serverIceServers)) {
    for (const server of networkPrefs.serverIceServers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const cleanedUrls = urls.map((u) => String(u).trim()).filter(Boolean);
      if (cleanedUrls.length === 0) continue;
      for (const u of cleanedUrls) {
        if (u.toLowerCase().startsWith('stun:')) {
          seenStun.add(u);
        }
      }
      const entry: RTCIceServer = { urls: cleanedUrls };
      if (server.username) entry.username = server.username;
      if (server.credential) entry.credential = server.credential;
      iceServers.push(entry);
    }
  }

  const manualStunList = parseCommaUrls(networkPrefs.stunUrls).filter((u) => !seenStun.has(u));
  if (manualStunList.length > 0) {
    iceServers.push({ urls: manualStunList });
  }

  const manualTurnUrls = parseCommaUrls(networkPrefs.turnUrl);
  if (manualTurnUrls.length > 0) {
    const turnServer: RTCIceServer = {
      urls: manualTurnUrls.length === 1 ? manualTurnUrls[0] : manualTurnUrls,
    };
    if (networkPrefs.turnUsername.trim()) {
      turnServer.username = networkPrefs.turnUsername.trim();
    }
    if (networkPrefs.turnCredential) {
      turnServer.credential = networkPrefs.turnCredential;
    }
    iceServers.push(turnServer);
  }

  return {
    iceServers,
    iceCandidatePoolSize: 2,
  };
}

export interface PeerOfferPayload {
  sdp: string;
  streamId: string;
  hasVideo: boolean;
  hasAudio: boolean;
  codecHint: CastoraVideoCodec;
  iceRestart: boolean;
}

export interface PeerServiceCallbacks {
  onOfferCreated: (offer: PeerOfferPayload) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit, streamId: string) => void;
  onInboundStream: (stream: MediaStream | null) => void;
  onPhaseChange: (phase: WebRtcConnectionPhase, detail: string) => void;
  onIceConnectionChange: (iceState: RTCIceConnectionState) => void;
  onConnectionFailure?: (reason: string) => void;
  onCodecFallback?: (nextCodec: CastoraVideoCodec, reason: string) => void;
  onLocalTrackEnded?: (reason: string) => void;
  onRecoveryAttempt?: (info: { kind: string; detail: string }) => void;
  onStats: (stats: BidirectionalTelemetrySample) => void;
  onError: (message: string) => void;
}

export class CastoraWebRtcPeer {
  readonly localDeviceId: string;
  readonly peerDeviceId: string;
  readonly sessionId: string;
  readonly polite: boolean;

  private pc: RTCPeerConnection | null = null;
  private statsTimer: number | null = null;
  private statsJitterTimer: number | null = null;
  private iceRestartTimer: number | null = null;
  private statsCollector: WebRtcStatsCollector;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  private outboundStream: MediaStream | null = null;
  private outboundStreamId: string | null = null;
  private outboundCodecHint: CastoraVideoCodec = 'VP8';
  private selectedVideoCodec: CodecPreference = 'H264';
  private negotiatedVideoCodec: string | null = null;
  private negotiatedVideoProfile: string | null = null;
  private negotiatedAudioCodec: string | null = null;
  private codecFallbackReason: string | null = null;
  private triedVideoCodecs = new Set<CastoraVideoCodec>();
  private outboundZeroFrameSamples = 0;
  private codecStallSampleThreshold = 3;
  private lastFramesEncoded: number | null = null;
  private consecutiveEncoderStallSamples = 0;
  private encoderStallThresholdSamples = 5;
  private lastFramesDecoded: number | null = null;
  private consecutiveDecoderStallSamples = 0;
  private decoderStallThresholdSamples = 6;
  private lastSuccessfulVideoFrameAt: number | null = null;
  private lastSuccessfulAudioPacketAt: number | null = null;
  private lastAudioPacketsSent: number | null = null;
  private lastAudioPacketsReceived: number | null = null;
  private localTrackEndedNotified = false;
  private fallbackInFlight = false;

  private outboundPreferences: CapturePreferences | null = null;
  private activeOutboundPeersCount = 1;
  private abrController: AdaptiveBitrateController | null = null;
  private localVideoTrack: MediaStreamTrack | null = null;
  private localAudioTrack: MediaStreamTrack | null = null;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private supportedControls: AdaptiveControlCapabilities = {
    supportsSetParameters: true,
    supportsMaxBitrate: true,
    supportsMaxFramerate: true,
    supportsScaleResolutionDownBy: true,
    supportsDegradationPreference: true,
    lastError: null,
  };

  private inboundStream: MediaStream | null = null;
  private lastInboundStream: MediaStream | null = null;
  private inboundTracks = new Map<string, { track: MediaStreamTrack; cleanup: () => void }>();
  private sawInboundAudioEnded = false;
  private inboundStreamId: string | null = null;
  private inboundTargetFps = 60;
  private outboundTargetFps = 60;

  private currentPhase: WebRtcConnectionPhase = 'idle';
  private makingOffer = false;
  private ignoreOffer = false;
  private pendingRenegotiation = false;
  private pendingIceRestart = false;
  private iceRestartInFlight = false;
  private iceDisconnectGraceMs = 1500;
  private failureNotified = false;
  private negotiationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private callbacks: PeerServiceCallbacks;

  constructor(params: {
    localDeviceId: string;
    peerDeviceId: string;
    sessionId: string;
    targetFps: number;
    networkPrefs: NetworkPreferences;
    callbacks: PeerServiceCallbacks;
    rtcFactory?: (config: RTCConfiguration) => RTCPeerConnection;
    iceDisconnectGraceMs?: number;
    codecStallSampleThreshold?: number;
    encoderStallThresholdSamples?: number;
    decoderStallThresholdSamples?: number;
  }) {
    if (!params.rtcFactory && typeof RTCPeerConnection === 'undefined') {
      throw new Error('RTCPeerConnection is not supported in this browser.');
    }

    this.localDeviceId = params.localDeviceId;
    this.peerDeviceId = params.peerDeviceId;
    this.sessionId = params.sessionId;
    // Deterministic Perfect Negotiation tie-breaker:
    // lexicographically smaller deviceId acts as polite peer during simultaneous offer glare.
    this.polite = params.localDeviceId < params.peerDeviceId;
    this.outboundTargetFps = params.targetFps;
    this.inboundTargetFps = params.targetFps;
    this.callbacks = params.callbacks;
    if (typeof params.iceDisconnectGraceMs === 'number' && params.iceDisconnectGraceMs >= 0) {
      this.iceDisconnectGraceMs = params.iceDisconnectGraceMs;
    }
    if (typeof params.codecStallSampleThreshold === 'number' && params.codecStallSampleThreshold >= 1) {
      this.codecStallSampleThreshold = Math.floor(params.codecStallSampleThreshold);
    }
    if (
      typeof params.encoderStallThresholdSamples === 'number' &&
      params.encoderStallThresholdSamples >= 2
    ) {
      this.encoderStallThresholdSamples = Math.floor(params.encoderStallThresholdSamples);
    }
    if (
      typeof params.decoderStallThresholdSamples === 'number' &&
      params.decoderStallThresholdSamples >= 2
    ) {
      this.decoderStallThresholdSamples = Math.floor(params.decoderStallThresholdSamples);
    }
    this.statsCollector = new WebRtcStatsCollector('bidirectional');

    const config = buildRtcConfiguration(params.networkPrefs);
    this.pc = params.rtcFactory ? params.rtcFactory(config) : new RTCPeerConnection(config);
    this.attachPeerListeners(this.pc);
    this.startStatsPolling();
  }

  getConnectionDiagnostics(): {
    phase: WebRtcConnectionPhase;
    connectionState: RTCPeerConnectionState | null;
    iceConnectionState: RTCIceConnectionState | null;
    signalingState: RTCSignalingState | null;
  } {
    return {
      phase: this.currentPhase,
      connectionState: this.pc?.connectionState ?? null,
      iceConnectionState: this.pc?.iceConnectionState ?? null,
      signalingState: this.pc?.signalingState ?? null,
    };
  }

  getSupportedAdaptiveControls(): AdaptiveControlCapabilities {
    return { ...this.supportedControls };
  }

  getAdaptiveState() {
    return this.abrController?.getCurrentState() ?? null;
  }

  getHealthSummary(): {
    lastSuccessfulVideoFrameAt: number | null;
    lastSuccessfulAudioPacketAt: number | null;
    lastFramesEncoded: number | null;
    lastFramesDecoded: number | null;
  } {
    return {
      lastSuccessfulVideoFrameAt: this.lastSuccessfulVideoFrameAt,
      lastSuccessfulAudioPacketAt: this.lastSuccessfulAudioPacketAt,
      lastFramesEncoded: this.lastFramesEncoded,
      lastFramesDecoded: this.lastFramesDecoded,
    };
  }

  isHealthy(): boolean {
    if (this.disposed || !this.pc || this.pc.signalingState === 'closed') {
      return false;
    }
    const iceOk =
      this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed';
    const connOk = this.pc.connectionState === 'connected';
    const hasFailure =
      this.pc.iceConnectionState === 'failed' ||
      this.pc.iceConnectionState === 'disconnected' ||
      this.pc.connectionState === 'failed' ||
      this.pc.connectionState === 'disconnected';
    return !hasFailure && (iceOk || connOk) && this.currentPhase === 'connected';
  }

  getActiveOutboundStreamId(): string | null {
    return this.outboundStreamId;
  }

  getActiveInboundStreamId(): string | null {
    return this.inboundStreamId;
  }

  getInboundStream(): MediaStream | null {
    return this.inboundStream;
  }

  hasOutboundStream(): boolean {
    return Boolean(this.outboundStream && this.outboundStreamId);
  }

  hasInboundStream(): boolean {
    return Boolean(this.inboundStream && this.inboundStream.getVideoTracks().some((t) => t.readyState === 'live'));
  }

  isIdle(): boolean {
    return !this.hasOutboundStream() && !this.hasInboundStream() && !this.inboundStreamId;
  }

  markInboundStreamExpected(streamId: string, fps: number): void {
    this.inboundStreamId = streamId;
    this.inboundTargetFps = fps;
  }

  getCodecDiagnostics(): {
    selectedVideoCodec: CodecPreference;
    outboundCodecHint: CastoraVideoCodec;
    negotiatedVideoCodec: string | null;
    negotiatedVideoProfile: string | null;
    negotiatedAudioCodec: string | null;
    codecFallbackReason: string | null;
  } {
    return {
      selectedVideoCodec: this.selectedVideoCodec,
      outboundCodecHint: this.outboundCodecHint,
      negotiatedVideoCodec: this.negotiatedVideoCodec,
      negotiatedVideoProfile: this.negotiatedVideoProfile,
      negotiatedAudioCodec: this.negotiatedAudioCodec,
      codecFallbackReason: this.codecFallbackReason,
    };
  }

  getAudioSenderTrackStatus(): AudioTrackStatus {
    if (!this.audioSender || !this.localAudioTrack) {
      return 'none';
    }
    if (this.localAudioTrack.readyState === 'ended') {
      return 'ended';
    }
    if (this.localAudioTrack.muted) {
      return 'muted';
    }
    return 'live';
  }

  getAudioReceiverTrackStatus(): AudioTrackStatus {
    const streamAudio = this.inboundStream?.getAudioTracks?.() ?? [];
    const trackedAudio = Array.from(this.inboundTracks.values())
      .map((entry) => entry.track)
      .filter((t) => t.kind === 'audio');
    const audioTracks = streamAudio.length > 0 ? streamAudio : trackedAudio;
    const liveAudio = audioTracks.find((t) => t.readyState !== 'ended');
    if (liveAudio) {
      return liveAudio.muted ? 'muted' : 'live';
    }
    if (this.sawInboundAudioEnded || audioTracks.some((t) => t.readyState === 'ended')) {
      return 'ended';
    }
    return 'none';
  }

  private clearInboundTrackListeners(): void {
    for (const entry of this.inboundTracks.values()) {
      entry.cleanup();
    }
    this.inboundTracks.clear();
  }

  private rebuildInboundStream(sourceStream: MediaStream | null): MediaStream | null {
    for (const [id, entry] of Array.from(this.inboundTracks.entries())) {
      if (entry.track.readyState === 'ended') {
        if (entry.track.kind === 'audio') {
          this.sawInboundAudioEnded = true;
        }
        entry.cleanup();
        this.inboundTracks.delete(id);
      }
    }

    const liveTracked = Array.from(this.inboundTracks.values())
      .map((e) => e.track)
      .filter((t) => t.readyState !== 'ended');

    const sourceLiveTracks = sourceStream
      ? sourceStream.getTracks().filter((t) => t.readyState !== 'ended')
      : [];

    const mergedById = new Map<string, MediaStreamTrack>();
    for (const t of sourceLiveTracks) {
      mergedById.set(t.id, t);
    }
    for (const t of liveTracked) {
      mergedById.set(t.id, t);
    }

    const liveTracks = Array.from(mergedById.values());
    if (liveTracks.length === 0) {
      this.inboundStream = null;
      return null;
    }

    if (typeof MediaStream !== 'undefined') {
      const combined = new MediaStream(liveTracks);
      this.inboundStream = combined;
      this.lastInboundStream = combined;
      return combined;
    }

    const base = sourceStream ?? this.inboundStream ?? this.lastInboundStream;
    if (base && typeof base.addTrack === 'function') {
      const existingIds = new Set(base.getTracks().map((t) => t.id));
      for (const t of liveTracks) {
        if (!existingIds.has(t.id)) {
          base.addTrack(t);
        }
      }
    }
    this.inboundStream = base ?? null;
    this.lastInboundStream = this.inboundStream;
    return this.inboundStream;
  }

  clearInboundStream(reason?: string): void {
    this.inboundStreamId = null;
    this.sawInboundAudioEnded = false;
    this.lastFramesDecoded = null;
    this.consecutiveDecoderStallSamples = 0;
    this.lastAudioPacketsReceived = null;
    this.clearInboundTrackListeners();
    this.statsCollector.resetInbound();
    if (this.inboundStream) {
      this.inboundStream = null;
      this.callbacks.onInboundStream(null);
    }
    if (reason && !this.hasOutboundStream()) {
      this.setPhase('disconnected', reason);
    }
  }

  private setPhase(phase: WebRtcConnectionPhase, detail: string): void {
    if (this.disposed) return;
    this.currentPhase = phase;
    this.callbacks.onPhaseChange(phase, detail);
  }

  private attachPeerListeners(pc: RTCPeerConnection): void {
    pc.onicecandidate = (event) => {
      if (this.disposed || !event.candidate) return;
      const json = typeof event.candidate.toJSON === 'function'
        ? event.candidate.toJSON()
        : (event.candidate as RTCIceCandidateInit);
      if (!json.candidate) return;
      const associatedStreamId = this.outboundStreamId ?? this.inboundStreamId ?? this.sessionId;
      this.callbacks.onIceCandidate(
        {
          candidate: json.candidate,
          sdpMid: json.sdpMid ?? null,
          sdpMLineIndex: typeof json.sdpMLineIndex === 'number' ? json.sdpMLineIndex : 0,
        },
        associatedStreamId
      );
    };

    pc.ontrack = (event) => {
      if (this.disposed) return;
      const track = event.track;
      if (!track || track.readyState === 'ended') return;

      const sourceStream =
        event.streams && event.streams.length > 0 ? event.streams[0] : null;

      if (!this.inboundTracks.has(track.id)) {
        const handleTrackEnded = () => {
          if (this.disposed) return;
          if (track.kind === 'audio') {
            this.sawInboundAudioEnded = true;
          }
          const updated = this.rebuildInboundStream(null);
          this.callbacks.onInboundStream(updated);
        };

        const handleTrackMuted = () => {
          if (this.disposed) return;
          // Preserve stream + peer connection when a single track mutes transiently;
          // re-emit stats/state if needed without dropping video or audio.
          if (track.kind === 'audio' && this.inboundStream) {
            this.callbacks.onInboundStream(this.inboundStream);
          }
        };

        const handleTrackUnmuted = () => {
          if (this.disposed) return;
          if (track.readyState !== 'ended') {
            const updated = this.rebuildInboundStream(sourceStream);
            this.callbacks.onInboundStream(updated);
            if (updated) {
              this.setPhase('connected', 'Receiving live remote screen and audio stream.');
            }
          }
        };

        if (typeof track.addEventListener === 'function') {
          track.addEventListener('ended', handleTrackEnded);
          track.addEventListener('mute', handleTrackMuted);
          track.addEventListener('unmute', handleTrackUnmuted);
        }

        this.inboundTracks.set(track.id, {
          track,
          cleanup: () => {
            if (typeof track.removeEventListener === 'function') {
              track.removeEventListener('ended', handleTrackEnded);
              track.removeEventListener('mute', handleTrackMuted);
              track.removeEventListener('unmute', handleTrackUnmuted);
            }
          },
        });
      }

      const combined = this.rebuildInboundStream(sourceStream);
      this.callbacks.onInboundStream(combined);
      this.setPhase('connected', 'Receiving live WebRTC media track.');
    };

    pc.oniceconnectionstatechange = () => {
      if (this.disposed) return;
      const state = pc.iceConnectionState;
      this.callbacks.onIceConnectionChange(state);

      if (state === 'connected' || state === 'completed') {
        this.clearIceRestartTimer();
        this.iceRestartInFlight = false;
        this.failureNotified = false;
        this.setPhase('connected', `WebRTC ICE ${state}`);
      } else if (state === 'checking' || state === 'new') {
        if (this.currentPhase !== 'reconnecting') {
          this.setPhase('connecting', `Negotiating ICE (${state})...`);
        }
      } else if (state === 'disconnected') {
        this.failureNotified = false;
        this.setPhase(
          'reconnecting',
          'Temporary ICE interruption detected. Attempting automatic ICE recovery...'
        );
        this.scheduleIceRestart();
      } else if (state === 'failed') {
        this.clearIceRestartTimer();
        this.iceRestartInFlight = false;
        const reason =
          'ICE connectivity failed. Devices on isolated subnets or symmetric NAT may require a TURN relay in Settings.';
        this.setPhase('failed', reason);
        this.notifyFailureOnce(reason);
      } else if (state === 'closed') {
        this.clearIceRestartTimer();
        this.iceRestartInFlight = false;
        this.setPhase('disconnected', 'Peer connection closed.');
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.disposed) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        this.clearIceRestartTimer();
        this.iceRestartInFlight = false;
        this.failureNotified = false;
        this.setPhase('connected', 'WebRTC peer connection established.');
      } else if (state === 'connecting') {
        if (this.currentPhase !== 'reconnecting') {
          this.setPhase('connecting', 'Establishing DTLS/SRTP peer session...');
        }
      } else if (state === 'disconnected') {
        this.failureNotified = false;
        this.setPhase(
          'reconnecting',
          'Peer connection interrupted temporarily. Waiting for ICE recovery...'
        );
        this.scheduleIceRestart();
      } else if (state === 'failed') {
        this.clearIceRestartTimer();
        this.iceRestartInFlight = false;
        const reason =
          'WebRTC peer connection failed. Verify network reachability or configure a TURN relay.';
        this.setPhase('failed', reason);
        this.notifyFailureOnce(reason);
      } else if (state === 'closed') {
        this.clearIceRestartTimer();
        this.iceRestartInFlight = false;
        this.setPhase('disconnected', 'WebRTC peer connection closed.');
      }
    };
  }

  private notifyFailureOnce(reason: string): void {
    if (this.disposed || this.failureNotified) return;
    this.failureNotified = true;
    this.callbacks.onError(reason);
    this.callbacks.onConnectionFailure?.(reason);
  }

  private clearIceRestartTimer(): void {
    if (this.iceRestartTimer !== null) {
      globalThis.clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
  }

  private scheduleIceRestart(): void {
    if (this.iceRestartTimer !== null || this.iceRestartInFlight) {
      return;
    }
    // Impolite peer attempts ICE restart quickly; polite peer waits slightly longer as fallback
    // so both sides do not race simultaneously while still recovering if the remote peer stalled.
    const delayMs = this.polite
      ? Math.max(this.iceDisconnectGraceMs * 2, this.iceDisconnectGraceMs + 1000)
      : this.iceDisconnectGraceMs;

    this.iceRestartTimer = globalThis.setTimeout(() => {
      this.iceRestartTimer = null;
      if (this.disposed || !this.pc) return;
      const iceDisconnected =
        this.pc.iceConnectionState === 'disconnected' ||
        this.pc.iceConnectionState === 'failed';
      const connDisconnected =
        this.pc.connectionState === 'disconnected' ||
        this.pc.connectionState === 'failed';
      if (!iceDisconnected && !connDisconnected) {
        return;
      }
      void this.triggerIceRestart();
    }, delayMs) as unknown as number;
  }

  async triggerIceRestart(force = false): Promise<boolean> {
    if (this.disposed || !this.pc || this.pc.signalingState === 'closed') {
      return false;
    }
    if (!force && this.isHealthy()) {
      return false;
    }
    if (this.iceRestartInFlight) {
      return false;
    }

    this.clearIceRestartTimer();
    this.iceRestartInFlight = true;
    this.setPhase('reconnecting', 'Performing WebRTC ICE restart...');

    try {
      if (typeof this.pc.restartIce === 'function') {
        this.pc.restartIce();
      }
      await this.enqueueNegotiation(true);
      return true;
    } catch {
      return false;
    } finally {
      this.iceRestartInFlight = false;
    }
  }

  async requestInboundRecoveryOffer(): Promise<void> {
    await this.enqueueOperation(async () => {
      if (this.disposed || !this.pc || this.pc.signalingState === 'closed') return;
      if (typeof this.pc.addTransceiver === 'function') {
        const transceivers = this.pc.getTransceivers?.() ?? [];
        if (transceivers.length === 0) {
          this.pc.addTransceiver('video', { direction: 'recvonly' });
        }
      }
      await this.negotiateOfferInternal(true);
    });
  }

  async sampleAndAdaptStats(nowMs?: number): Promise<BidirectionalTelemetrySample> {
    const empty: BidirectionalTelemetrySample = {
      outbound: createEmptyTelemetry(this.outboundTargetFps, this.currentPhase),
      inbound: createEmptyTelemetry(this.inboundTargetFps, this.currentPhase),
    };
    if (this.disposed || !this.pc) return empty;

    const sampleTimeMs = typeof nowMs === 'number' ? nowMs : Date.now();

    if (
      this.hasOutboundStream() &&
      this.localVideoTrack &&
      this.localVideoTrack.readyState === 'ended'
    ) {
      if (!this.localTrackEndedNotified) {
        this.localTrackEndedNotified = true;
        this.callbacks.onLocalTrackEnded?.('Screen capture video track ended.');
      }
      return empty;
    }

    const hasInboundVideo = Boolean(this.inboundStreamId || this.hasInboundStream());
    const hasInboundAudio = Boolean(
      this.inboundStream?.getAudioTracks?.().length ||
        Array.from(this.inboundTracks.values()).some((e) => e.track.kind === 'audio')
    );

    const snapshot = await this.statsCollector.sampleBidirectional({
      pc: this.pc,
      outboundTargetFps: this.outboundTargetFps,
      inboundTargetFps: this.inboundTargetFps,
      connectionState: this.currentPhase,
      localVideoTrack: this.localVideoTrack,
      localAudioTrack: this.localAudioTrack,
      hasInboundVideo,
      hasInboundAudio: hasInboundAudio || hasInboundVideo,
    });

    if (this.hasOutboundStream()) {
      if (this.abrController) {
        const decision = this.abrController.evaluate(snapshot.outbound, {
          activeOutboundPeers: this.activeOutboundPeersCount,
          nowMs,
        });
        if (decision.changed) {
          await this.applySenderEncodingDecision(decision);
        }

        const abrState = this.abrController.getCurrentState();
        snapshot.outbound.configuredMaxBitrateKbps = abrState.configuredMaxBitrateKbps;
        snapshot.outbound.targetBitrateKbps = abrState.targetBitrateKbps;
        snapshot.outbound.targetFramerate = abrState.targetFramerate;
        snapshot.outbound.scaleResolutionDownBy = abrState.scaleResolutionDownBy;
        snapshot.outbound.adaptationStatus = abrState.adaptationStatus;
        snapshot.outbound.adaptiveMode = abrState.adaptiveMode;
        snapshot.outbound.networkCondition = abrState.networkCondition;
        snapshot.outbound.lastAdjustmentReason = abrState.lastAdjustmentReason;
        snapshot.outbound.lastAdjustmentAt = abrState.lastAdjustmentAt;
        snapshot.outbound.lastAdjustmentAction = abrState.lastAdjustmentAction;
      }

      snapshot.outbound.supportedAdaptiveControls = { ...this.supportedControls };
      snapshot.outbound.selectedVideoCodec = this.selectedVideoCodec;
      snapshot.outbound.negotiatedVideoCodec =
        snapshot.outbound.negotiatedVideoCodec ??
        snapshot.outbound.codecMimeType ??
        this.negotiatedVideoCodec;
      snapshot.outbound.negotiatedVideoProfile = this.negotiatedVideoProfile;
      snapshot.outbound.codecFallbackReason = this.codecFallbackReason;
      snapshot.outbound.negotiatedAudioCodec =
        snapshot.outbound.negotiatedAudioCodec ?? this.negotiatedAudioCodec;
      snapshot.outbound.audioSenderTrackStatus = this.getAudioSenderTrackStatus();

      if (!snapshot.outbound.codecMimeType) {
        snapshot.outbound.codecMimeType =
          snapshot.outbound.negotiatedVideoCodec ?? this.outboundCodecHint;
      }

      const encodedCount = snapshot.outbound.framesEncoded ?? snapshot.outbound.framesSent;
      if (typeof encodedCount === 'number') {
        if (
          encodedCount > 0 &&
          (this.lastFramesEncoded === null || encodedCount > this.lastFramesEncoded)
        ) {
          this.lastSuccessfulVideoFrameAt = sampleTimeMs;
          this.consecutiveEncoderStallSamples = 0;
        } else if (
          this.currentPhase === 'connected' &&
          this.localVideoTrack?.readyState === 'live' &&
          !this.localVideoTrack.muted &&
          this.lastFramesEncoded !== null &&
          this.lastFramesEncoded > 0 &&
          encodedCount === this.lastFramesEncoded
        ) {
          this.consecutiveEncoderStallSamples += 1;
          if (this.consecutiveEncoderStallSamples === 2 && this.abrController) {
            const currentAbr = this.abrController.getCurrentState();
            void this.applySenderEncodingDecision({
              changed: true,
              targetBitrateKbps: Math.max(800, Math.round(currentAbr.targetBitrateKbps * 0.9)),
              maxFramerate: currentAbr.targetFramerate,
              scaleResolutionDownBy: currentAbr.scaleResolutionDownBy,
              degradationPreference: 'maintain-framerate',
              adaptationStatus: 'recovering',
              adaptiveMode: currentAbr.adaptiveMode,
              networkCondition: currentAbr.networkCondition,
              lastAdjustmentReason: 'Nudging sender encoding parameters after brief frame stall',
              lastAdjustmentAt: sampleTimeMs,
              lastAdjustmentAction: 'reduced-bitrate',
            });
          } else if (this.consecutiveEncoderStallSamples === this.encoderStallThresholdSamples) {
            this.callbacks.onRecoveryAttempt?.({
              kind: 'encoder-stall',
              detail: 'Video encoder stalled mid-stream; triggering ICE restart to resume frames.',
            });
            void this.triggerIceRestart(true);
          } else if (this.consecutiveEncoderStallSamples >= this.encoderStallThresholdSamples + 2) {
            this.notifyFailureOnce(
              'Video encoder stalled mid-stream; recovering peer connection.'
            );
          }
        }
        this.lastFramesEncoded = encodedCount;
      }

      const audioSent = snapshot.outbound.audioPacketsSent;
      if (typeof audioSent === 'number' && audioSent > 0) {
        if (this.lastAudioPacketsSent === null || audioSent > this.lastAudioPacketsSent) {
          this.lastSuccessfulAudioPacketAt = sampleTimeMs;
        }
        this.lastAudioPacketsSent = audioSent;
      }

      snapshot.outbound.lastSuccessfulVideoFrameAt = this.lastSuccessfulVideoFrameAt;
      snapshot.outbound.lastSuccessfulAudioPacketAt = this.lastSuccessfulAudioPacketAt;

      // Detect zero-frame encoder stall on H.264 / AV1 and step down cleanly without dropping audio
      if (
        this.currentPhase === 'connected' &&
        snapshot.outbound.framesEncoded === 0 &&
        (snapshot.outbound.framesSent === null || snapshot.outbound.framesSent === 0) &&
        (this.outboundCodecHint === 'H264' || this.outboundCodecHint === 'AV1')
      ) {
        this.outboundZeroFrameSamples += 1;
        if (this.outboundZeroFrameSamples >= this.codecStallSampleThreshold) {
          void this.tryFallbackCodec(
            `${this.outboundCodecHint} produced 0 encoded frames on connected peer; switching to fallback codec.`
          );
        }
      } else if (
        (snapshot.outbound.framesEncoded ?? 0) > 0 ||
        (snapshot.outbound.framesSent ?? 0) > 0
      ) {
        this.outboundZeroFrameSamples = 0;
      }
    }

    if (hasInboundVideo || hasInboundAudio) {
      snapshot.inbound.negotiatedVideoCodec =
        snapshot.inbound.negotiatedVideoCodec ??
        snapshot.inbound.codecMimeType ??
        this.negotiatedVideoCodec;
      snapshot.inbound.negotiatedVideoProfile = this.negotiatedVideoProfile;
      snapshot.inbound.codecFallbackReason = this.codecFallbackReason;
      snapshot.inbound.negotiatedAudioCodec =
        snapshot.inbound.negotiatedAudioCodec ?? this.negotiatedAudioCodec;
      snapshot.inbound.audioReceiverTrackStatus = this.getAudioReceiverTrackStatus();
      if (!snapshot.inbound.codecMimeType && snapshot.inbound.negotiatedVideoCodec) {
        snapshot.inbound.codecMimeType = snapshot.inbound.negotiatedVideoCodec;
      }

      const decodedCount = snapshot.inbound.framesDecoded;
      const inboundVideoTrackLive =
        this.inboundStream?.getVideoTracks?.().some((t) => t.readyState === 'live' && !t.muted) ??
        false;
      if (typeof decodedCount === 'number') {
        if (
          decodedCount > 0 &&
          (this.lastFramesDecoded === null || decodedCount > this.lastFramesDecoded)
        ) {
          this.lastSuccessfulVideoFrameAt = sampleTimeMs;
          this.consecutiveDecoderStallSamples = 0;
        } else if (
          this.hasInboundStream() &&
          this.currentPhase === 'connected' &&
          inboundVideoTrackLive &&
          this.lastFramesDecoded !== null &&
          this.lastFramesDecoded > 0 &&
          decodedCount === this.lastFramesDecoded
        ) {
          this.consecutiveDecoderStallSamples += 1;
          if (this.consecutiveDecoderStallSamples === this.decoderStallThresholdSamples) {
            this.callbacks.onRecoveryAttempt?.({
              kind: 'decoder-stall',
              detail: 'Video decoder stalled mid-stream; requesting keyframe / recovery offer.',
            });
            void this.requestInboundRecoveryOffer();
          } else if (this.consecutiveDecoderStallSamples >= this.decoderStallThresholdSamples + 2) {
            this.notifyFailureOnce(
              'Receiver video decoder stalled mid-stream; recovering peer connection.'
            );
          }
        }
        this.lastFramesDecoded = decodedCount;
      }

      const audioReceived = snapshot.inbound.audioPacketsReceived;
      if (typeof audioReceived === 'number' && audioReceived > 0) {
        if (
          this.lastAudioPacketsReceived === null ||
          audioReceived > this.lastAudioPacketsReceived
        ) {
          this.lastSuccessfulAudioPacketAt = sampleTimeMs;
        }
        this.lastAudioPacketsReceived = audioReceived;
      }

      snapshot.inbound.lastSuccessfulVideoFrameAt = this.lastSuccessfulVideoFrameAt;
      snapshot.inbound.lastSuccessfulAudioPacketAt = this.lastSuccessfulAudioPacketAt;
    }

    if (!this.disposed) {
      this.callbacks.onStats(snapshot);
    }
    return snapshot;
  }

  private startStatsPolling(): void {
    this.stopStatsPolling();
    if (typeof window === 'undefined') return;
    // Deterministic per-peer offset (0..900ms) spreads getStats() calls across frames
    // when up to 15 concurrent peer connections are active in a mesh room.
    let hash = 0;
    for (let i = 0; i < this.peerDeviceId.length; i += 1) {
      hash = (hash * 31 + this.peerDeviceId.charCodeAt(i)) >>> 0;
    }
    const staggerMs = hash % 900;
    this.statsJitterTimer = window.setTimeout(() => {
      this.statsJitterTimer = null;
      if (this.disposed) return;
      void this.sampleAndAdaptStats();
      this.statsTimer = window.setInterval(() => {
        void this.sampleAndAdaptStats();
      }, 2000);
    }, staggerMs);
  }

  private stopStatsPolling(): void {
    if (this.statsJitterTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.statsJitterTimer);
      this.statsJitterTimer = null;
    }
    if (this.statsTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private findTransceiverForSender(sender: RTCRtpSender | null): RTCRtpTransceiver | null {
    if (!this.pc || !sender || typeof this.pc.getTransceivers !== 'function') return null;
    return this.pc.getTransceivers().find((t) => t.sender === sender) ?? null;
  }

  private getLocalVideoActualDims(): { width: number | null; height: number | null } {
    const settings = this.localVideoTrack?.getSettings?.();
    return {
      width: typeof settings?.width === 'number' ? settings.width : null,
      height: typeof settings?.height === 'number' ? settings.height : null,
    };
  }

  private async applySenderEncodingDecision(decision: AdaptiveBitrateDecision): Promise<void> {
    if (
      !this.videoSender ||
      typeof this.videoSender.getParameters !== 'function' ||
      typeof this.videoSender.setParameters !== 'function'
    ) {
      this.supportedControls = {
        supportsSetParameters: false,
        supportsMaxBitrate: false,
        supportsMaxFramerate: false,
        supportsScaleResolutionDownBy: false,
        supportsDegradationPreference: false,
        lastError: 'RTCRtpSender.setParameters is unavailable in this browser.',
      };
      return;
    }

    const maxBitrateBps = Math.round(decision.targetBitrateKbps * 1000);

    try {
      const senderParams = this.videoSender.getParameters();
      if (!senderParams.encodings || senderParams.encodings.length === 0) {
        senderParams.encodings = [{}];
      }
      senderParams.encodings[0].maxBitrate = maxBitrateBps;
      senderParams.encodings[0].maxFramerate = decision.maxFramerate;
      senderParams.encodings[0].scaleResolutionDownBy = decision.scaleResolutionDownBy;
      senderParams.degradationPreference = decision.degradationPreference;
      await this.videoSender.setParameters(senderParams);
      this.supportedControls = {
        supportsSetParameters: true,
        supportsMaxBitrate: true,
        supportsMaxFramerate: true,
        supportsScaleResolutionDownBy: true,
        supportsDegradationPreference: true,
        lastError: null,
      };
      return;
    } catch (fullErr) {
      const errMsg =
        fullErr instanceof Error ? fullErr.message : 'Partial sender encoding restriction';

      // Fallback 1: Try { maxBitrate, maxFramerate } without scaleResolutionDownBy / degradationPreference
      try {
        const fallback1 = this.videoSender.getParameters();
        if (!fallback1.encodings || fallback1.encodings.length === 0) {
          fallback1.encodings = [{}];
        }
        fallback1.encodings[0].maxBitrate = maxBitrateBps;
        fallback1.encodings[0].maxFramerate = decision.maxFramerate;
        delete fallback1.encodings[0].scaleResolutionDownBy;
        delete fallback1.degradationPreference;
        await this.videoSender.setParameters(fallback1);
        this.supportedControls = {
          supportsSetParameters: true,
          supportsMaxBitrate: true,
          supportsMaxFramerate: true,
          supportsScaleResolutionDownBy: false,
          supportsDegradationPreference: false,
          lastError: errMsg,
        };
        return;
      } catch {
        // Continue to bitrate-only fallback
      }

      // Fallback 2: Try { maxBitrate } only
      try {
        const fallback2 = this.videoSender.getParameters();
        if (!fallback2.encodings || fallback2.encodings.length === 0) {
          fallback2.encodings = [{}];
        }
        fallback2.encodings[0].maxBitrate = maxBitrateBps;
        delete fallback2.encodings[0].maxFramerate;
        delete fallback2.encodings[0].scaleResolutionDownBy;
        delete fallback2.degradationPreference;
        await this.videoSender.setParameters(fallback2);
        this.supportedControls = {
          supportsSetParameters: true,
          supportsMaxBitrate: true,
          supportsMaxFramerate: false,
          supportsScaleResolutionDownBy: false,
          supportsDegradationPreference: false,
          lastError: errMsg,
        };
        return;
      } catch (bitrateErr) {
        const finalMsg =
          bitrateErr instanceof Error ? bitrateErr.message : errMsg;
        this.supportedControls = {
          supportsSetParameters: false,
          supportsMaxBitrate: false,
          supportsMaxFramerate: false,
          supportsScaleResolutionDownBy: false,
          supportsDegradationPreference: false,
          lastError: finalMsg,
        };
      }
    }
  }

  private applyVideoCodecPreferenceToTransceiver(
    preference: CodecPreference | CastoraVideoCodec
  ): CastoraVideoCodec {
    let codecHint: CastoraVideoCodec =
      preference === 'H264'
        ? 'H264'
        : preference === 'VP9'
          ? 'VP9'
          : preference === 'AV1'
            ? 'AV1'
            : 'VP8';
    const videoTransceiver = this.findTransceiverForSender(this.videoSender);
    if (!videoTransceiver) return codecHint;

    const senderCaps =
      typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function'
        ? RTCRtpSender.getCapabilities('video')
        : null;
    const receiverCaps =
      typeof RTCRtpReceiver !== 'undefined' && typeof RTCRtpReceiver.getCapabilities === 'function'
        ? RTCRtpReceiver.getCapabilities('video')
        : null;

    if (
      senderCaps?.codecs?.length &&
      typeof videoTransceiver.setCodecPreferences === 'function'
    ) {
      const ranked = orderVideoCodecsForPreference(
        senderCaps.codecs,
        preference,
        receiverCaps?.codecs
      );
      if (ranked.orderedCodecs.length > 0) {
        try {
          videoTransceiver.setCodecPreferences(ranked.orderedCodecs);
          codecHint = ranked.codecHint;
          if (preference !== 'AUTO' && ranked.codecHint !== preference && !this.codecFallbackReason) {
            this.codecFallbackReason = `${preference} encoder unavailable in this browser; using ${ranked.codecHint}.`;
          }
        } catch {
          // Browser codec policy restriction
        }
      }
    }

    return codecHint;
  }

  private applyCodecAndEncodingHints(
    preferences: CapturePreferences,
    activeOutboundPeers = 1
  ): CastoraVideoCodec {
    const codecHint = this.applyVideoCodecPreferenceToTransceiver(preferences.codecPreference);

    const actualDims = this.getLocalVideoActualDims();
    this.outboundPreferences = preferences;
    this.activeOutboundPeersCount = Math.max(1, activeOutboundPeers);
    this.abrController = new AdaptiveBitrateController(preferences, actualDims);
    const initialDecision = this.abrController.updatePreferences(
      preferences,
      this.activeOutboundPeersCount,
      actualDims
    );
    void this.applySenderEncodingDecision(initialDecision);

    return codecHint;
  }

  private async tryFallbackCodec(reason: string): Promise<boolean> {
    if (
      this.disposed ||
      !this.pc ||
      this.pc.signalingState === 'closed' ||
      !this.hasOutboundStream() ||
      !this.outboundPreferences ||
      this.fallbackInFlight
    ) {
      return false;
    }

    const senderCaps =
      typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function'
        ? RTCRtpSender.getCapabilities('video')?.codecs
        : undefined;
    const availableCodecs = senderCaps
      ? orderVideoCodecsForPreference(senderCaps, this.outboundCodecHint).availableVideoCodecs
      : undefined;

    const nextCodec = getNextFallbackCodec(
      this.outboundPreferences.codecPreference,
      this.triedVideoCodecs,
      availableCodecs && availableCodecs.length > 0 ? availableCodecs : undefined
    );
    if (!nextCodec) {
      return false;
    }

    this.fallbackInFlight = true;
    try {
      this.outboundZeroFrameSamples = 0;
      this.outboundCodecHint = nextCodec;
      this.triedVideoCodecs.add(nextCodec);
      this.codecFallbackReason = reason;
      this.applyVideoCodecPreferenceToTransceiver(nextCodec);
      this.callbacks.onCodecFallback?.(nextCodec, reason);
      await this.enqueueNegotiation(false);
      return true;
    } finally {
      this.fallbackInFlight = false;
    }
  }

  async updateEncodingPreferences(
    preferences: CapturePreferences,
    activeOutboundPeers = 1
  ): Promise<void> {
    if (this.disposed || !this.pc) return;
    const prevCodecPreference = this.outboundPreferences?.codecPreference ?? this.selectedVideoCodec;
    const prevCodecHint = this.outboundCodecHint;

    this.outboundPreferences = preferences;
    this.outboundTargetFps = preferences.targetFps;
    this.selectedVideoCodec = preferences.codecPreference;
    this.activeOutboundPeersCount = Math.max(1, activeOutboundPeers);

    if (!this.hasOutboundStream()) return;

    const actualDims = this.getLocalVideoActualDims();
    if (!this.abrController) {
      this.abrController = new AdaptiveBitrateController(preferences, actualDims);
    }
    const decision = this.abrController.updatePreferences(
      preferences,
      this.activeOutboundPeersCount,
      actualDims
    );

    const nextHint = this.applyVideoCodecPreferenceToTransceiver(preferences.codecPreference);
    const codecChanged =
      prevCodecPreference !== preferences.codecPreference || prevCodecHint !== nextHint;
    if (codecChanged) {
      this.outboundCodecHint = nextHint;
      this.triedVideoCodecs.clear();
      this.triedVideoCodecs.add(nextHint);
      this.codecFallbackReason = null;
      this.outboundZeroFrameSamples = 0;
    }

    await this.applySenderEncodingDecision(decision);

    if (codecChanged && this.pc.signalingState !== 'closed') {
      await this.enqueueNegotiation(false);
    }
  }

  getResolvedQualityTarget(): ReturnType<typeof resolveQualityTarget> | null {
    if (!this.outboundPreferences) return null;
    return resolveQualityTarget(this.outboundPreferences, this.getLocalVideoActualDims());
  }

  async publishLocalStream(params: {
    localStream: MediaStream;
    streamId: string;
    preferences: CapturePreferences;
    activeOutboundPeers?: number;
  }): Promise<{ codecHint: CastoraVideoCodec; hasVideo: boolean; hasAudio: boolean }> {
    let resultCodec: CastoraVideoCodec = 'VP8';
    let hasVideo = false;
    let hasAudio = false;

    await this.enqueueOperation(async () => {
      if (this.disposed || !this.pc) {
        throw new Error('Peer connection is closed');
      }

      const videoTrack = params.localStream.getVideoTracks()[0] ?? null;
      const audioTrack =
        params.localStream.getAudioTracks().find((t) => t.readyState !== 'ended') ??
        params.localStream.getAudioTracks()[0] ??
        null;
      hasVideo = Boolean(videoTrack);
      hasAudio = Boolean(audioTrack && audioTrack.readyState !== 'ended');

      this.outboundStream = params.localStream;
      this.outboundStreamId = params.streamId;
      this.outboundTargetFps = params.preferences.targetFps;
      this.localVideoTrack = videoTrack;
      this.localAudioTrack = audioTrack;
      this.selectedVideoCodec = params.preferences.codecPreference;
      this.triedVideoCodecs.clear();
      this.codecFallbackReason = null;
      this.outboundZeroFrameSamples = 0;
      this.lastFramesEncoded = null;
      this.consecutiveEncoderStallSamples = 0;
      this.lastAudioPacketsSent = null;
      this.localTrackEndedNotified = false;
      this.statsCollector.resetOutbound();

      if (videoTrack) {
        if (this.videoSender) {
          await this.videoSender.replaceTrack(videoTrack);
          const transceiver = this.findTransceiverForSender(this.videoSender);
          if (transceiver) {
            if (transceiver.direction === 'inactive') {
              transceiver.direction = 'sendonly';
            } else if (transceiver.direction === 'recvonly') {
              transceiver.direction = 'sendrecv';
            }
          }
        } else {
          this.videoSender = this.pc.addTrack(videoTrack, params.localStream);
        }
      }

      if (audioTrack) {
        if (this.audioSender) {
          await this.audioSender.replaceTrack(audioTrack);
          const transceiver = this.findTransceiverForSender(this.audioSender);
          if (transceiver) {
            if (transceiver.direction === 'inactive') {
              transceiver.direction = 'sendonly';
            } else if (transceiver.direction === 'recvonly') {
              transceiver.direction = 'sendrecv';
            }
          }
        } else {
          this.audioSender = this.pc.addTrack(audioTrack, params.localStream);
        }
      } else if (this.audioSender) {
        await this.audioSender.replaceTrack(null);
        const audioTransceiver = this.findTransceiverForSender(this.audioSender);
        if (audioTransceiver) {
          audioTransceiver.direction =
            audioTransceiver.direction === 'sendrecv' ? 'recvonly' : 'inactive';
        }
      }

      resultCodec = this.applyCodecAndEncodingHints(
        params.preferences,
        params.activeOutboundPeers ?? 1
      );
      this.outboundCodecHint = resultCodec;
      this.triedVideoCodecs.add(resultCodec);

      if (this.currentPhase === 'idle' || this.currentPhase === 'disconnected') {
        this.setPhase('connecting', 'Negotiating outbound WebRTC offer...');
      }

      await this.negotiateOfferInternal(false);
    });

    return {
      codecHint: resultCodec,
      hasVideo,
      hasAudio,
    };
  }

  async stopLocalStream(): Promise<void> {
    await this.enqueueOperation(async () => {
      if (this.disposed || !this.pc) return;

      this.outboundStream = null;
      this.outboundStreamId = null;
      this.localVideoTrack = null;
      this.localAudioTrack = null;
      this.abrController = null;
      this.outboundZeroFrameSamples = 0;
      this.lastFramesEncoded = null;
      this.consecutiveEncoderStallSamples = 0;
      this.lastAudioPacketsSent = null;
      this.localTrackEndedNotified = false;
      this.codecFallbackReason = null;
      this.statsCollector.resetOutbound();

      let modifiedTransceiver = false;

      if (this.videoSender) {
        try {
          await this.videoSender.replaceTrack(null);
        } catch {
          // Ignore if track already stopped
        }
        const transceiver = this.findTransceiverForSender(this.videoSender);
        if (transceiver) {
          if (transceiver.direction === 'sendrecv') {
            transceiver.direction = 'recvonly';
            modifiedTransceiver = true;
          } else if (transceiver.direction === 'sendonly') {
            transceiver.direction = 'inactive';
            modifiedTransceiver = true;
          }
        }
      }

      if (this.audioSender) {
        try {
          await this.audioSender.replaceTrack(null);
        } catch {
          // Ignore if track already stopped
        }
        const audioTransceiver = this.findTransceiverForSender(this.audioSender);
        if (audioTransceiver) {
          if (audioTransceiver.direction === 'sendrecv') {
            audioTransceiver.direction = 'recvonly';
            modifiedTransceiver = true;
          } else if (audioTransceiver.direction === 'sendonly') {
            audioTransceiver.direction = 'inactive';
            modifiedTransceiver = true;
          }
        }
      }

      // Preserve the peer connection when an inbound stream is active or warm;
      // renegotiate direction cleanly so the remote peer keeps sending uninterrupted.
      if (modifiedTransceiver && this.pc.signalingState !== 'closed') {
        await this.negotiateOfferInternal(false);
      }
    });
  }

  private enqueueOperation<T>(task: () => Promise<T>): Promise<T> {
    const next = this.negotiationQueue.then(task, task);
    this.negotiationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private enqueueNegotiation(iceRestart: boolean): Promise<void> {
    return this.enqueueOperation(async () => {
      await this.negotiateOfferInternal(iceRestart);
    });
  }

  private async negotiateOfferInternal(iceRestart: boolean): Promise<void> {
    if (this.disposed || !this.pc || this.pc.signalingState === 'closed') return;

    if (this.makingOffer || this.pc.signalingState !== 'stable') {
      if (iceRestart) {
        this.pendingIceRestart = true;
      } else {
        this.pendingRenegotiation = true;
      }
      return;
    }

    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (this.disposed || !this.pc) return;
      if (this.pc.signalingState !== 'stable') {
        if (iceRestart) {
          this.pendingIceRestart = true;
        } else {
          this.pendingRenegotiation = true;
        }
        return;
      }

      await this.pc.setLocalDescription(offer);
      const sdp = this.pc.localDescription?.sdp ?? offer.sdp;
      if (!sdp) {
        throw new Error('Browser produced an empty SDP offer');
      }

      this.callbacks.onOfferCreated({
        sdp,
        streamId: this.outboundStreamId ?? this.inboundStreamId ?? this.sessionId,
        hasVideo: Boolean(this.outboundStream?.getVideoTracks().length),
        hasAudio: Boolean(this.outboundStream?.getAudioTracks().length),
        codecHint: this.outboundCodecHint,
        iceRestart,
      });
    } finally {
      this.makingOffer = false;
    }
  }

  async acceptOfferAndCreateAnswer(sdp: string, inboundStreamId?: string): Promise<string | null> {
    return this.enqueueOperation(async () => {
      if (this.disposed || !this.pc) {
        throw new Error('Peer connection is closed');
      }

      if (inboundStreamId && !this.inboundStreamId) {
        this.inboundStreamId = inboundStreamId;
      }

      const offerCollision = this.makingOffer || this.pc.signalingState !== 'stable';
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        return null;
      }

      if (this.pc.signalingState !== 'stable') {
        await this.pc.setLocalDescription({ type: 'rollback' });
        if (this.outboundStream) {
          this.pendingRenegotiation = true;
        }
      }

      if (this.currentPhase === 'idle' || this.currentPhase === 'disconnected') {
        this.setPhase('connecting', 'Applying peer SDP offer & generating answer...');
      }

      const offerInit: RTCSessionDescriptionInit = { type: 'offer', sdp };
      await this.pc.setRemoteDescription(
        typeof RTCSessionDescription !== 'undefined'
          ? new RTCSessionDescription(offerInit)
          : offerInit
      );
      await this.flushPendingIceCandidates();

      if (
        this.inboundStreamId &&
        !this.inboundStream &&
        this.lastInboundStream
          ?.getVideoTracks()
          .some((t) => t.readyState === 'live' && !t.muted)
      ) {
        const liveTracks = this.lastInboundStream
          .getTracks()
          .filter((t) => t.readyState === 'live');
        this.inboundStream =
          typeof MediaStream !== 'undefined'
            ? new MediaStream(liveTracks)
            : this.lastInboundStream;
        this.lastInboundStream = this.inboundStream;
        this.callbacks.onInboundStream(this.inboundStream);
        this.setPhase('connected', 'Receiving resumed remote screen stream.');
      }

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      const answerSdp = this.pc.localDescription?.sdp ?? answer.sdp;
      if (!answerSdp) {
        throw new Error('Browser produced an empty SDP answer');
      }

      const negotiated = inspectSdpNegotiatedMedia(answerSdp);
      if (negotiated.primaryVideoCodec) {
        this.negotiatedVideoCodec = negotiated.primaryVideoCodec;
        this.negotiatedVideoProfile = negotiated.h264ProfileLevelId;
      }
      if (negotiated.primaryAudioCodec) {
        this.negotiatedAudioCodec = negotiated.primaryAudioCodec;
      }

      if (this.pendingIceRestart || (this.pendingRenegotiation && this.outboundStream)) {
        const doIceRestart = this.pendingIceRestart;
        this.pendingIceRestart = false;
        this.pendingRenegotiation = false;
        // Schedule outbound renegotiation right after returning answer
        queueMicrotask(() => {
          if (!this.disposed) {
            void this.enqueueNegotiation(doIceRestart);
          }
        });
      }

      return answerSdp;
    });
  }

  async acceptAnswer(sdp: string): Promise<void> {
    let fallbackNeededReason: string | null = null;
    await this.enqueueOperation(async () => {
      if (this.disposed || !this.pc) {
        throw new Error('Peer connection is closed');
      }
      if (this.pc.signalingState !== 'have-local-offer') {
        return;
      }

      this.ignoreOffer = false;
      const answerInit: RTCSessionDescriptionInit = { type: 'answer', sdp };
      try {
        await this.pc.setRemoteDescription(
          typeof RTCSessionDescription !== 'undefined'
            ? new RTCSessionDescription(answerInit)
            : answerInit
        );
      } catch (err) {
        fallbackNeededReason =
          err instanceof Error
            ? `SDP answer failed (${err.message}); trying fallback codec.`
            : 'SDP answer failed; trying fallback codec.';
        return;
      }
      await this.flushPendingIceCandidates();

      const answerMedia = inspectSdpNegotiatedMedia(sdp);
      if (answerMedia.primaryAudioCodec) {
        this.negotiatedAudioCodec = answerMedia.primaryAudioCodec;
      }
      if (answerMedia.primaryVideoCodec) {
        this.negotiatedVideoCodec = answerMedia.primaryVideoCodec;
        this.negotiatedVideoProfile = answerMedia.h264ProfileLevelId;
      }

      if (answerMedia.videoRejected && this.hasOutboundStream()) {
        fallbackNeededReason = `Remote peer rejected ${this.outboundCodecHint} video track (port 0); falling back to compatible codec.`;
      } else if (
        answerMedia.primaryVideoCodec !== null &&
        answerMedia.primaryVideoCodec !== this.outboundCodecHint &&
        this.hasOutboundStream()
      ) {
        const normalized = normalizeVideoCodecName(answerMedia.primaryVideoCodec);
        if (normalized) {
          const prevCodec = this.outboundCodecHint;
          this.outboundCodecHint = normalized;
          this.triedVideoCodecs.add(normalized);
          this.codecFallbackReason = `Receiver negotiated ${normalized} instead of ${prevCodec}.`;
        }
      }

      if (
        !fallbackNeededReason &&
        (this.pendingIceRestart || this.pendingRenegotiation) &&
        (this.pc.signalingState as RTCSignalingState) === 'stable'
      ) {
        const doIceRestart = this.pendingIceRestart;
        this.pendingIceRestart = false;
        this.pendingRenegotiation = false;
        queueMicrotask(() => {
          if (!this.disposed) {
            void this.enqueueNegotiation(doIceRestart);
          }
        });
      }
    });

    if (fallbackNeededReason) {
      const triggered = await this.tryFallbackCodec(fallbackNeededReason);
      if (!triggered) {
        throw new Error(fallbackNeededReason);
      }
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.disposed || !this.pc) return;
    if (!this.pc.remoteDescription) {
      if (this.pendingCandidates.length < 128) {
        this.pendingCandidates.push(candidate);
      }
      return;
    }
    try {
      await this.pc.addIceCandidate(
        typeof RTCIceCandidate !== 'undefined' ? new RTCIceCandidate(candidate) : candidate
      );
    } catch (err) {
      if (!this.ignoreOffer) {
        const msg = err instanceof Error ? err.message : 'Failed to apply ICE candidate';
        this.callbacks.onError(`ICE candidate warning: ${msg}`);
      }
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (this.disposed || !this.pc || !this.pc.remoteDescription) return;
    const queued = this.pendingCandidates.splice(0, this.pendingCandidates.length);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(
          typeof RTCIceCandidate !== 'undefined' ? new RTCIceCandidate(candidate) : candidate
        );
      } catch {
        // Ignore stale candidate from rolled-back offer
      }
    }
  }

  close(reason = 'Peer connection closed'): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIceRestartTimer();
    this.stopStatsPolling();
    this.clearInboundTrackListeners();
    this.pendingCandidates = [];

    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      try {
        for (const sender of this.pc.getSenders()) {
          this.pc.removeTrack(sender);
        }
      } catch {
        // Ignore removeTrack errors if already closed
      }
      try {
        this.pc.close();
      } catch {
        // Ignore close errors
      }
      this.pc = null;
    }

    this.outboundStream = null;
    this.outboundStreamId = null;
    this.inboundStream = null;
    this.inboundStreamId = null;
    this.localVideoTrack = null;
    this.localAudioTrack = null;
    this.videoSender = null;
    this.audioSender = null;
    this.statsCollector.reset();
    this.callbacks.onInboundStream(null);
    const disconnectedOutbound: StreamTelemetrySnapshot = createEmptyTelemetry(
      this.outboundTargetFps,
      'disconnected'
    );
    const disconnectedInbound: StreamTelemetrySnapshot = createEmptyTelemetry(
      this.inboundTargetFps,
      'disconnected'
    );
    this.callbacks.onStats({ outbound: disconnectedOutbound, inbound: disconnectedInbound });
    this.callbacks.onPhaseChange('disconnected', reason);
  }
}
