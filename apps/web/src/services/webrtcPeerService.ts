import type { CastoraVideoCodec } from '../types/protocol';
import type {
  AdaptiveControlCapabilities,
  CapturePreferences,
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
  private iceRestartTimer: number | null = null;
  private statsCollector: WebRtcStatsCollector;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  private outboundStream: MediaStream | null = null;
  private outboundStreamId: string | null = null;
  private outboundCodecHint: CastoraVideoCodec = 'VP8';
  private outboundPreferences: CapturePreferences | null = null;
  private activeOutboundPeersCount = 1;
  private abrController: AdaptiveBitrateController | null = null;
  private localVideoTrack: MediaStreamTrack | null = null;
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

  clearInboundStream(reason?: string): void {
    this.inboundStreamId = null;
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

      if (sourceStream) {
        this.inboundStream = sourceStream;
        this.lastInboundStream = sourceStream;
      } else {
        if (!this.inboundStream) {
          this.inboundStream = this.lastInboundStream ?? new MediaStream();
        }
        if (!this.inboundStream.getTracks().some((t) => t.id === track.id)) {
          this.inboundStream.addTrack(track);
        }
        this.lastInboundStream = this.inboundStream;
      }

      const handleTrackRemoved = () => {
        if (this.disposed || !this.inboundStream) return;
        const stillLiveVideo = this.inboundStream
          .getVideoTracks()
          .some((t) => t.readyState === 'live' && !t.muted);
        if (!stillLiveVideo) {
          this.callbacks.onInboundStream(null);
        }
      };

      const handleTrackUnmuted = () => {
        if (this.disposed) return;
        if (this.inboundStreamId && track.readyState === 'live') {
          const base = this.inboundStream ?? this.lastInboundStream;
          if (typeof MediaStream !== 'undefined') {
            const liveTracks = base
              ? base.getTracks().filter((t) => t.readyState === 'live')
              : [];
            this.inboundStream = new MediaStream(liveTracks.length > 0 ? liveTracks : [track]);
          } else {
            this.inboundStream = base ?? null;
          }
          this.lastInboundStream = this.inboundStream;
          this.callbacks.onInboundStream(this.inboundStream);
          this.setPhase('connected', 'Receiving live remote screen stream.');
        }
      };

      if (typeof track.addEventListener === 'function') {
        track.addEventListener('ended', handleTrackRemoved);
        track.addEventListener('unmute', handleTrackUnmuted);
      }

      this.callbacks.onInboundStream(this.inboundStream);
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

  async triggerIceRestart(): Promise<boolean> {
    if (this.disposed || !this.pc || this.pc.signalingState === 'closed') {
      return false;
    }
    if (this.isHealthy()) {
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

    const snapshot = await this.statsCollector.sampleBidirectional({
      pc: this.pc,
      outboundTargetFps: this.outboundTargetFps,
      inboundTargetFps: this.inboundTargetFps,
      connectionState: this.currentPhase,
      localVideoTrack: this.localVideoTrack,
      hasInboundVideo: Boolean(this.inboundStreamId || this.hasInboundStream()),
    });

    if (this.hasOutboundStream() && this.abrController) {
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
      snapshot.outbound.supportedAdaptiveControls = { ...this.supportedControls };
      if (!snapshot.outbound.codecMimeType) {
        snapshot.outbound.codecMimeType = this.outboundCodecHint;
      }
    }

    if (!this.disposed) {
      this.callbacks.onStats(snapshot);
    }
    return snapshot;
  }

  private startStatsPolling(): void {
    this.stopStatsPolling();
    if (typeof window === 'undefined') return;
    this.statsTimer = window.setInterval(() => {
      void this.sampleAndAdaptStats();
    }, 2000);
  }

  private stopStatsPolling(): void {
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

  private applyCodecAndEncodingHints(
    preferences: CapturePreferences,
    activeOutboundPeers = 1
  ): CastoraVideoCodec {
    let codecHint: CastoraVideoCodec =
      preferences.codecPreference === 'H264'
        ? 'H264'
        : preferences.codecPreference === 'VP9'
          ? 'VP9'
          : preferences.codecPreference === 'AV1'
            ? 'AV1'
            : 'VP8';
    const videoTransceiver = this.findTransceiverForSender(this.videoSender);
    if (!videoTransceiver) return codecHint;

    if (
      typeof RTCRtpSender !== 'undefined' &&
      typeof RTCRtpSender.getCapabilities === 'function' &&
      typeof videoTransceiver.setCodecPreferences === 'function'
    ) {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps?.codecs?.length) {
        const ranked = orderVideoCodecsForPreference(caps.codecs, preferences.codecPreference);
        if (ranked.orderedCodecs.length > 0) {
          try {
            videoTransceiver.setCodecPreferences(ranked.orderedCodecs);
            codecHint = ranked.codecHint;
          } catch {
            // Browser codec policy restriction
          }
        }
      }
    }

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

  async updateEncodingPreferences(
    preferences: CapturePreferences,
    activeOutboundPeers = 1
  ): Promise<void> {
    if (this.disposed || !this.pc) return;
    this.outboundPreferences = preferences;
    this.outboundTargetFps = preferences.targetFps;
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

    const videoTransceiver = this.findTransceiverForSender(this.videoSender);
    if (
      videoTransceiver &&
      typeof RTCRtpSender !== 'undefined' &&
      typeof RTCRtpSender.getCapabilities === 'function' &&
      typeof videoTransceiver.setCodecPreferences === 'function'
    ) {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps?.codecs?.length) {
        const ranked = orderVideoCodecsForPreference(caps.codecs, preferences.codecPreference);
        if (ranked.orderedCodecs.length > 0) {
          try {
            videoTransceiver.setCodecPreferences(ranked.orderedCodecs);
            this.outboundCodecHint = ranked.codecHint;
          } catch {
            // Ignore codec change rejection on live transceiver
          }
        }
      }
    }

    await this.applySenderEncodingDecision(decision);
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
      const audioTrack = params.localStream.getAudioTracks()[0] ?? null;
      hasVideo = Boolean(videoTrack);
      hasAudio = Boolean(audioTrack);

      this.outboundStream = params.localStream;
      this.outboundStreamId = params.streamId;
      this.outboundTargetFps = params.preferences.targetFps;
      this.localVideoTrack = videoTrack;
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
      this.abrController = null;
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
    await this.enqueueOperation(async () => {
      if (this.disposed || !this.pc) {
        throw new Error('Peer connection is closed');
      }
      if (this.pc.signalingState !== 'have-local-offer') {
        return;
      }

      this.ignoreOffer = false;
      const answerInit: RTCSessionDescriptionInit = { type: 'answer', sdp };
      await this.pc.setRemoteDescription(
        typeof RTCSessionDescription !== 'undefined'
          ? new RTCSessionDescription(answerInit)
          : answerInit
      );
      await this.flushPendingIceCandidates();

      if (
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
