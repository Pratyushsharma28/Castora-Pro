import type { CastoraVideoCodec } from '../types/protocol';
import type {
  CapturePreferences,
  NetworkPreferences,
  StreamTelemetrySnapshot,
  WebRtcConnectionPhase,
} from '../types/studio';
import { WebRtcStatsCollector, createEmptyTelemetry } from './streamStatsService';

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

export interface PeerServiceCallbacks {
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onPhaseChange: (phase: WebRtcConnectionPhase, detail: string) => void;
  onIceConnectionChange: (iceState: RTCIceConnectionState) => void;
  onStats: (stats: StreamTelemetrySnapshot) => void;
  onIceRestartOffer?: (sdp: string) => void;
  onError: (message: string) => void;
}

export class CastoraWebRtcPeer {
  readonly role: 'sender' | 'receiver';
  readonly peerDeviceId: string;
  readonly sessionId: string;
  readonly streamId: string;

  private pc: RTCPeerConnection | null = null;
  private statsTimer: number | null = null;
  private iceRestartTimer: number | null = null;
  private statsCollector: WebRtcStatsCollector;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteStream: MediaStream | null = null;
  private localVideoTrack: MediaStreamTrack | null = null;
  private currentPhase: WebRtcConnectionPhase = 'idle';
  private targetFps: number;
  private disposed = false;
  private callbacks: PeerServiceCallbacks;

  constructor(params: {
    role: 'sender' | 'receiver';
    peerDeviceId: string;
    sessionId: string;
    streamId: string;
    targetFps: number;
    networkPrefs: NetworkPreferences;
    callbacks: PeerServiceCallbacks;
  }) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('RTCPeerConnection is not supported in this browser.');
    }

    this.role = params.role;
    this.peerDeviceId = params.peerDeviceId;
    this.sessionId = params.sessionId;
    this.streamId = params.streamId;
    this.targetFps = params.targetFps;
    this.callbacks = params.callbacks;
    this.statsCollector = new WebRtcStatsCollector(params.role);

    const config = buildRtcConfiguration(params.networkPrefs);
    this.pc = new RTCPeerConnection(config);
    this.attachPeerListeners(this.pc);
    this.startStatsPolling();
  }

  private setPhase(phase: WebRtcConnectionPhase, detail: string): void {
    if (this.disposed) return;
    this.currentPhase = phase;
    this.callbacks.onPhaseChange(phase, detail);
  }

  private attachPeerListeners(pc: RTCPeerConnection): void {
    pc.onicecandidate = (event) => {
      if (this.disposed || !event.candidate) return;
      const json = event.candidate.toJSON();
      if (!json.candidate) return;
      this.callbacks.onIceCandidate({
        candidate: json.candidate,
        sdpMid: json.sdpMid ?? null,
        sdpMLineIndex: typeof json.sdpMLineIndex === 'number' ? json.sdpMLineIndex : 0,
      });
    };

    pc.ontrack = (event) => {
      if (this.disposed) return;
      const incomingStream =
        event.streams && event.streams.length > 0 ? event.streams[0] : null;
      if (incomingStream) {
        this.remoteStream = incomingStream;
      } else {
        if (!this.remoteStream) {
          this.remoteStream = new MediaStream();
        }
        this.remoteStream.addTrack(event.track);
      }

      this.callbacks.onRemoteStream(this.remoteStream);
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
        this.scheduleIceRestartIfSender();
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
      window.clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
  }

  private scheduleIceRestartIfSender(): void {
    if (this.role !== 'sender' || this.iceRestartTimer !== null || !this.callbacks.onIceRestartOffer) {
      return;
    }
    this.iceRestartTimer = window.setTimeout(async () => {
      this.iceRestartTimer = null;
      if (this.disposed || !this.pc) return;
      if (
        this.pc.iceConnectionState !== 'disconnected' &&
        this.pc.iceConnectionState !== 'failed'
      ) {
        return;
      }
      try {
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        if (offer.sdp && this.callbacks.onIceRestartOffer) {
          this.callbacks.onIceRestartOffer(offer.sdp);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'ICE restart failed';
        this.callbacks.onError(`ICE restart failed: ${msg}`);
      }
    }, 2500);
  }

  private startStatsPolling(): void {
    this.stopStatsPolling();
    this.statsTimer = window.setInterval(async () => {
      if (this.disposed || !this.pc) return;
      const snapshot = await this.statsCollector.sample({
        pc: this.pc,
        targetFps: this.targetFps,
        connectionState: this.currentPhase,
        localVideoTrack: this.localVideoTrack,
      });
      if (!this.disposed) {
        this.callbacks.onStats(snapshot);
      }
    }, 1000);
  }

  private stopStatsPolling(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  async createSenderOffer(params: {
    localStream: MediaStream;
    preferences: CapturePreferences;
  }): Promise<{ sdp: string; hasVideo: boolean; hasAudio: boolean; codecHint: CastoraVideoCodec }> {
    if (this.disposed || !this.pc) {
      throw new Error('Peer connection is closed');
    }

    this.setPhase('connecting', 'Creating WebRTC SDP offer...');
    const videoTracks = params.localStream.getVideoTracks();
    this.localVideoTrack = videoTracks[0] ?? null;

    for (const track of params.localStream.getTracks()) {
      this.pc.addTrack(track, params.localStream);
    }

    let codecHint: CastoraVideoCodec = 'VP8';
    const videoTransceiver = this.pc
      .getTransceivers()
      .find((t) => t.sender.track?.kind === 'video');

    if (videoTransceiver) {
      if (
        params.preferences.codecPreference === 'H264' &&
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
              // Ignore browser codec reordering restriction
            }
          }
        }
      }

      const sender = videoTransceiver.sender;
      try {
        const senderParams = sender.getParameters();
        if (!senderParams.encodings || senderParams.encodings.length === 0) {
          senderParams.encodings = [{}];
        }
        senderParams.encodings[0].maxFramerate = params.preferences.targetFps;
        senderParams.encodings[0].maxBitrate =
          params.preferences.resolution === '720p' ? 4_500_000 : 8_000_000;
        senderParams.degradationPreference = 'maintain-framerate';
        await sender.setParameters(senderParams);
      } catch {
        // Parameter hints are optional across browsers
      }
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (!offer.sdp) {
      throw new Error('Browser produced an empty SDP offer');
    }

    return {
      sdp: offer.sdp,
      hasVideo: videoTracks.length > 0,
      hasAudio: params.localStream.getAudioTracks().length > 0,
      codecHint,
    };
  }

  async acceptOfferAndCreateAnswer(sdp: string): Promise<string> {
    if (this.disposed || !this.pc) {
      throw new Error('Peer connection is closed');
    }

    this.setPhase('connecting', 'Applying host SDP offer & generating answer...');
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'offer', sdp })
    );
    await this.flushPendingIceCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (!answer.sdp) {
      throw new Error('Browser produced an empty SDP answer');
    }

    return answer.sdp;
  }

  async acceptAnswer(sdp: string): Promise<void> {
    if (this.disposed || !this.pc) {
      throw new Error('Peer connection is closed');
    }

    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'answer', sdp })
    );
    await this.flushPendingIceCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.disposed || !this.pc) return;
    if (!this.pc.remoteDescription) {
      if (this.pendingCandidates.length < 64) {
        this.pendingCandidates.push(candidate);
      }
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to apply ICE candidate';
      this.callbacks.onError(`ICE candidate warning: ${msg}`);
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (this.disposed || !this.pc || !this.pc.remoteDescription) return;
    const queued = this.pendingCandidates.splice(0, this.pendingCandidates.length);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore stale candidate
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

    this.remoteStream = null;
    this.localVideoTrack = null;
    this.statsCollector.reset();
    this.callbacks.onRemoteStream(null);
    this.callbacks.onStats(createEmptyTelemetry(this.targetFps, 'disconnected'));
    this.callbacks.onPhaseChange('disconnected', reason);
  }
}
