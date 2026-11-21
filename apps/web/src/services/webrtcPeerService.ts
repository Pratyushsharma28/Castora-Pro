import type { CastoraVideoCodec } from '../types/protocol';
import type {
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

export function buildRtcConfiguration(networkPrefs: NetworkPreferences): RTCConfiguration {
  const iceServers: RTCIceServer[] = [];

  const stunList = networkPrefs.stunUrls
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  if (stunList.length > 0) {
    iceServers.push({ urls: stunList });
  }

  const turnUrl = networkPrefs.turnUrl.trim();
  if (turnUrl) {
    const turnServer: RTCIceServer = { urls: turnUrl };
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
  private localVideoTrack: MediaStreamTrack | null = null;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;

  private inboundStream: MediaStream | null = null;
  private lastInboundStream: MediaStream | null = null;
  private inboundStreamId: string | null = null;
  private inboundTargetFps = 60;
  private outboundTargetFps = 60;

  private currentPhase: WebRtcConnectionPhase = 'idle';
  private makingOffer = false;
  private ignoreOffer = false;
  private pendingRenegotiation = false;
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
    this.statsCollector = new WebRtcStatsCollector('bidirectional');

    const config = buildRtcConfiguration(params.networkPrefs);
    this.pc = params.rtcFactory ? params.rtcFactory(config) : new RTCPeerConnection(config);
    this.attachPeerListeners(this.pc);
    this.startStatsPolling();
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
        this.setPhase('connected', `WebRTC ICE ${state}`);
      } else if (state === 'checking' || state === 'new') {
        this.setPhase('connecting', `Negotiating ICE (${state})...`);
      } else if (state === 'disconnected') {
        this.setPhase('reconnecting', 'ICE connection interrupted. Attempting recovery...');
        this.scheduleIceRestartIfInitiator();
      } else if (state === 'failed') {
        this.clearIceRestartTimer();
        this.setPhase(
          'failed',
          'ICE connectivity failed. Devices on isolated subnets or symmetric NAT may require a TURN relay in Settings.'
        );
        this.callbacks.onError(
          'ICE connectivity failed. Check local network firewall or configure a TURN server in Settings.'
        );
      } else if (state === 'closed') {
        this.clearIceRestartTimer();
        this.setPhase('disconnected', 'Peer connection closed.');
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.disposed) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        this.clearIceRestartTimer();
        this.setPhase('connected', 'WebRTC peer connection established.');
      } else if (state === 'connecting') {
        if (this.currentPhase !== 'reconnecting') {
          this.setPhase('connecting', 'Establishing DTLS/SRTP peer session...');
        }
      } else if (state === 'failed') {
        this.clearIceRestartTimer();
        this.setPhase(
          'failed',
          'WebRTC peer connection failed. Verify network reachability or configure optional TURN relay.'
        );
      } else if (state === 'closed') {
        this.setPhase('disconnected', 'WebRTC peer connection closed.');
      }
    };
  }

  private clearIceRestartTimer(): void {
    if (this.iceRestartTimer !== null) {
      globalThis.clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
  }

  private scheduleIceRestartIfInitiator(): void {
    // Only the impolite peer schedules automatic ICE restart to prevent simultaneous restart collisions;
    // Perfect Negotiation handles collisions if both sides renegotiate anyway.
    if (this.polite || this.iceRestartTimer !== null) {
      return;
    }
    this.iceRestartTimer = globalThis.setTimeout(() => {
      this.iceRestartTimer = null;
      if (this.disposed || !this.pc) return;
      if (
        this.pc.iceConnectionState !== 'disconnected' &&
        this.pc.iceConnectionState !== 'failed'
      ) {
        return;
      }
      void this.enqueueNegotiation(true);
    }, 2500) as unknown as number;
  }

  private startStatsPolling(): void {
    this.stopStatsPolling();
    if (typeof window === 'undefined') return;
    this.statsTimer = window.setInterval(async () => {
      if (this.disposed || !this.pc) return;
      const snapshot = await this.statsCollector.sampleBidirectional({
        pc: this.pc,
        outboundTargetFps: this.outboundTargetFps,
        inboundTargetFps: this.inboundTargetFps,
        connectionState: this.currentPhase,
        localVideoTrack: this.localVideoTrack,
        hasInboundVideo: Boolean(this.inboundStreamId || this.hasInboundStream()),
      });
      if (!this.disposed) {
        this.callbacks.onStats(snapshot);
      }
    }, 1000);
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

  private applyCodecAndEncodingHints(preferences: CapturePreferences): CastoraVideoCodec {
    let codecHint: CastoraVideoCodec = 'VP8';
    const videoTransceiver = this.findTransceiverForSender(this.videoSender);
    if (!videoTransceiver) return codecHint;

    if (
      preferences.codecPreference === 'H264' &&
      typeof RTCRtpSender !== 'undefined' &&
      typeof RTCRtpSender.getCapabilities === 'function' &&
      typeof videoTransceiver.setCodecPreferences === 'function'
    ) {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps?.codecs?.length) {
        const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
        const others = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264');
        if (h264.length > 0) {
          try {
            videoTransceiver.setCodecPreferences([...h264, ...others]);
            codecHint = 'H264';
          } catch {
            // Browser codec policy restriction
          }
        }
      }
    }

    if (this.videoSender && typeof this.videoSender.getParameters === 'function') {
      try {
        const senderParams = this.videoSender.getParameters();
        if (!senderParams.encodings || senderParams.encodings.length === 0) {
          senderParams.encodings = [{}];
        }
        senderParams.encodings[0].maxFramerate = preferences.targetFps;
        senderParams.encodings[0].maxBitrate =
          preferences.resolution === '720p' ? 4_500_000 : 8_000_000;
        senderParams.degradationPreference = 'maintain-framerate';
        void this.videoSender.setParameters(senderParams).catch(() => {});
      } catch {
        // Optional encoding parameters
      }
    }

    return codecHint;
  }

  async publishLocalStream(params: {
    localStream: MediaStream;
    streamId: string;
    preferences: CapturePreferences;
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

      resultCodec = this.applyCodecAndEncodingHints(params.preferences);
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

    if (!iceRestart && this.pc.signalingState !== 'stable') {
      this.pendingRenegotiation = true;
      return;
    }

    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (this.disposed || !this.pc) return;
      if (!iceRestart && this.pc.signalingState !== 'stable') {
        this.pendingRenegotiation = true;
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

      if (this.pendingRenegotiation && this.outboundStream) {
        this.pendingRenegotiation = false;
        // Schedule outbound renegotiation right after returning answer
        queueMicrotask(() => {
          if (!this.disposed) {
            void this.enqueueNegotiation(false);
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

      const answerInit: RTCSessionDescriptionInit = { type: 'answer', sdp };
      await this.pc.setRemoteDescription(
        typeof RTCSessionDescription !== 'undefined'
          ? new RTCSessionDescription(answerInit)
          : answerInit
      );
      await this.flushPendingIceCandidates();

      if (this.pendingRenegotiation && (this.pc.signalingState as RTCSignalingState) === 'stable') {
        this.pendingRenegotiation = false;
        queueMicrotask(() => {
          if (!this.disposed) {
            void this.enqueueNegotiation(false);
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
