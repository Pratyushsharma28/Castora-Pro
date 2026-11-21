import type { CastoraEnvelope, CastoraVideoCodec } from '../types/protocol';
import type {
  CapturePreferences,
  NetworkPreferences,
  StreamTelemetrySnapshot,
  WebRtcConnectionPhase,
} from '../types/studio';
import type { CastoraSignalingClient, RoomSnapshot } from './backendClient';
import {
  startScreenCapture,
  type CapturedScreenSession,
} from './screenCaptureService';
import { createEmptyTelemetry } from './streamStatsService';
import { CastoraWebRtcPeer } from './webrtcPeerService';

export interface WebRtcSessionSnapshot {
  phase: WebRtcConnectionPhase;
  statusDetail: string | null;
  errorMessage: string | null;
  iceConnectionState: RTCIceConnectionState | null;
  localStream: MediaStream | null;
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

export class WebRtcSignalingBridge {
  private deviceId: string;
  private activeRoom: RoomSnapshot | null = null;
  private activeRoomRole: 'host' | 'receiver' | null = null;
  private preferences: CapturePreferences;
  private networkPrefs: NetworkPreferences;
  private getSignalingClient: () => CastoraSignalingClient | null;
  private callbacks: WebRtcBridgeCallbacks;

  private captureSession: CapturedScreenSession | null = null;
  private peer: CastoraWebRtcPeer | null = null;
  private state: WebRtcSessionSnapshot;

  constructor(params: {
    deviceId: string;
    preferences: CapturePreferences;
    networkPrefs: NetworkPreferences;
    getSignalingClient: () => CastoraSignalingClient | null;
    callbacks: WebRtcBridgeCallbacks;
  }) {
    this.deviceId = params.deviceId;
    this.preferences = params.preferences;
    this.networkPrefs = params.networkPrefs;
    this.getSignalingClient = params.getSignalingClient;
    this.callbacks = params.callbacks;

    this.state = {
      phase: 'idle',
      statusDetail: null,
      errorMessage: null,
      iceConnectionState: null,
      localStream: null,
      remoteStream: null,
      activeSessionId: null,
      activeStreamId: null,
      targetPeerDeviceId: null,
      remoteStreamMeta: null,
      telemetry: createEmptyTelemetry(params.preferences.targetFps, 'idle'),
    };
  }

  private emit(partial: Partial<WebRtcSessionSnapshot>): void {
    this.state = { ...this.state, ...partial };
    this.callbacks.onStateChange(this.state);
  }

  getSnapshot(): WebRtcSessionSnapshot {
    return this.state;
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

    // Room closed/expired/left -> full teardown
    if (prevRoomId && !nextRoomId) {
      this.teardownPeerOnly('Room closed or disconnected.', 'disconnected');
      if (this.captureSession) {
        this.captureSession.stop();
        this.captureSession = null;
      }
      this.emit({
        phase: 'idle',
        localStream: null,
        remoteStream: null,
        activeSessionId: null,
        activeStreamId: null,
        targetPeerDeviceId: null,
        remoteStreamMeta: null,
        iceConnectionState: null,
        statusDetail: null,
        telemetry: createEmptyTelemetry(this.preferences.targetFps, 'idle'),
      });
      return;
    }

    // If current peer target disappeared from paired receivers or disconnected, close peer cleanly
    if (this.peer && this.activeRoom && this.activeRoomRole === 'host') {
      const target = this.activeRoom.pairedReceivers.find(
        (r) => r.deviceId === this.peer?.peerDeviceId
      );
      if (!target || !target.connected) {
        const peerId = this.peer.peerDeviceId;
        this.teardownPeerOnly(`Target receiver ${peerId} disconnected.`, 'disconnected');
        this.emit({
          phase: this.captureSession ? 'idle' : 'disconnected',
          statusDetail: `Receiver ${peerId} disconnected.`,
          targetPeerDeviceId: null,
        });
      }
    }
  }

  async startScreenSharing(targetReceiverDeviceId: string | null): Promise<void> {
    this.emit({ errorMessage: null });

    let session: CapturedScreenSession;
    try {
      session = await startScreenCapture({
        preferences: this.preferences,
        onNativeEnded: () => {
          this.callbacks.onLogEvent(
            'webrtc',
            'Screen sharing ended via browser control',
            'Stopped capture tracks and closed outbound WebRTC session.'
          );
          this.stopSharing('capture_revoked');
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start screen capture';
      this.emit({
        phase: 'failed',
        errorMessage: message,
        statusDetail: message,
      });
      this.callbacks.onLogEvent('error', 'Screen capture failed', message);
      throw err;
    }

    // Stop any previous capture session cleanly after acquiring replacement track
    if (this.captureSession) {
      this.captureSession.stop();
    }
    this.captureSession = session;

    const resLabel =
      session.actualWidth && session.actualHeight
        ? `${session.actualWidth}×${session.actualHeight}`
        : null;

    this.callbacks.onLogEvent(
      'webrtc',
      'Local screen capture started',
      `Track active${resLabel ? ` (${resLabel})` : ''}${session.actualFrameRate ? ` @ ${Math.round(session.actualFrameRate)} FPS` : ''}.`
    );

    this.emit({
      localStream: session.stream,
      errorMessage: null,
      statusDetail: 'Local screen capture active.',
      telemetry: {
        ...createEmptyTelemetry(this.preferences.targetFps, this.state.phase),
        captureFps: session.actualFrameRate,
        resolution: resLabel,
      },
    });

    if (targetReceiverDeviceId && this.activeRoom && this.activeRoomRole === 'host') {
      await this.connectStreamToReceiver(targetReceiverDeviceId);
    } else {
      this.emit({
        phase: 'idle',
        statusDetail:
          'Local preview active. Pair and approve a receiver in Receivers & Pairing to begin WebRTC transmission.',
      });
    }
  }

  async connectStreamToReceiver(targetReceiverDeviceId: string): Promise<void> {
    if (!this.captureSession) {
      throw new Error('Start screen capture before connecting to a receiver.');
    }
    if (!this.activeRoom || this.activeRoomRole !== 'host') {
      throw new Error('Create a host room and approve a receiver first.');
    }

    const receiverMember = this.activeRoom.pairedReceivers.find(
      (r) => r.deviceId === targetReceiverDeviceId
    );
    if (!receiverMember || !receiverMember.connected) {
      throw new Error(`Receiver ${targetReceiverDeviceId} is not currently paired and connected.`);
    }

    const signaling = this.getSignalingClient();
    if (!signaling) {
      throw new Error('Signaling WebSocket is not connected.');
    }

    // Prevent duplicate peer connections
    if (this.peer) {
      this.teardownPeerOnly('Replacing outbound WebRTC session.', 'disconnected');
    }

    const sessionId = receiverMember.sessionId || createId('sess');
    const streamId = createId('stream');
    const roomId = this.activeRoom.roomId;

    const peer = new CastoraWebRtcPeer({
      role: 'sender',
      peerDeviceId: targetReceiverDeviceId,
      sessionId,
      streamId,
      targetFps: this.preferences.targetFps,
      networkPrefs: this.networkPrefs,
      callbacks: {
        onIceCandidate: (candidate) => {
          signaling.sendEnvelope({
            messageType: 'ice_candidate',
            senderDeviceId: this.deviceId,
            receiverDeviceId: targetReceiverDeviceId,
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
        onRemoteStream: () => {
          // Sender does not display remote stream
        },
        onPhaseChange: (phase, detail) => {
          this.emit({ phase, statusDetail: detail });
        },
        onIceConnectionChange: (iceConnectionState) => {
          this.emit({ iceConnectionState });
        },
        onStats: (stats) => {
          this.emit({ telemetry: stats });
        },
        onIceRestartOffer: (sdp) => {
          this.callbacks.onLogEvent(
            'webrtc',
            'Attempting WebRTC ICE restart',
            `Sending refreshed SDP offer to ${receiverMember.deviceName}.`
          );
          signaling.sendEnvelope({
            messageType: 'session_offer',
            senderDeviceId: this.deviceId,
            receiverDeviceId: targetReceiverDeviceId,
            roomId,
            payload: {
              sessionId,
              streamId,
              sdpType: 'offer',
              sdp,
              mediaInfo: {
                hasVideo: true,
                hasAudio: this.captureSession?.hasAudio ?? false,
                codecHint: this.preferences.codecPreference === 'H264' ? 'H264' : 'VP8',
              },
            },
          });
        },
        onError: (msg) => {
          this.emit({ errorMessage: msg });
          this.callbacks.onLogEvent('error', 'WebRTC sender error', msg);
        },
      },
    });

    this.peer = peer;
    this.emit({
      phase: 'connecting',
      errorMessage: null,
      activeSessionId: sessionId,
      activeStreamId: streamId,
      targetPeerDeviceId: targetReceiverDeviceId,
      statusDetail: `Connecting WebRTC session to ${receiverMember.deviceName}...`,
    });

    try {
      const offer = await peer.createSenderOffer({
        localStream: this.captureSession.stream,
        preferences: this.preferences,
      });

      const width =
        this.captureSession.actualWidth ?? (this.preferences.resolution === '720p' ? 1280 : 1920);
      const height =
        this.captureSession.actualHeight ?? (this.preferences.resolution === '720p' ? 720 : 1080);
      const fps = Math.max(
        1,
        Math.min(120, Math.round(this.captureSession.actualFrameRate ?? this.preferences.targetFps))
      );

      signaling.sendEnvelope({
        messageType: 'stream_start',
        senderDeviceId: this.deviceId,
        receiverDeviceId: targetReceiverDeviceId,
        roomId,
        payload: {
          sessionId,
          streamId,
          width,
          height,
          fps,
          codec: offer.codecHint,
        },
      });

      signaling.sendEnvelope({
        messageType: 'session_offer',
        senderDeviceId: this.deviceId,
        receiverDeviceId: targetReceiverDeviceId,
        roomId,
        payload: {
          sessionId,
          streamId,
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
        'Sent WebRTC SDP offer',
        `Target: ${receiverMember.deviceName} (${targetReceiverDeviceId}) · ${width}×${height} @ ${fps} FPS · Codec ${offer.codecHint}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create WebRTC offer';
      this.teardownPeerOnly(msg, 'failed');
      this.emit({ phase: 'failed', errorMessage: msg, statusDetail: msg });
      throw err;
    }
  }

  stopSharing(reason: 'user_stopped' | 'capture_revoked' = 'user_stopped'): void {
    const signaling = this.getSignalingClient();
    const roomId = this.activeRoom?.roomId ?? null;

    if (
      signaling &&
      roomId &&
      this.activeRoomRole === 'host' &&
      this.state.targetPeerDeviceId &&
      this.state.activeSessionId &&
      this.state.activeStreamId
    ) {
      signaling.sendEnvelope({
        messageType: 'stream_stop',
        senderDeviceId: this.deviceId,
        receiverDeviceId: this.state.targetPeerDeviceId,
        roomId,
        payload: {
          sessionId: this.state.activeSessionId,
          streamId: this.state.activeStreamId,
          reason,
        },
      });
    }

    this.teardownPeerOnly('Screen sharing stopped by host.', 'disconnected');

    if (this.captureSession) {
      this.captureSession.stop();
      this.captureSession = null;
    }

    this.emit({
      phase: 'idle',
      localStream: null,
      activeSessionId: null,
      activeStreamId: null,
      targetPeerDeviceId: null,
      iceConnectionState: null,
      errorMessage: null,
      statusDetail:
        reason === 'capture_revoked'
          ? 'Screen sharing stopped via browser control.'
          : 'Screen sharing stopped.',
      telemetry: createEmptyTelemetry(this.preferences.targetFps, 'idle'),
    });

    this.callbacks.onLogEvent(
      'webrtc',
      'Stopped screen sharing',
      `Stopped local media tracks and closed WebRTC peer connection (${reason}).`
    );
  }

  async handleIncomingEnvelope(envelope: CastoraEnvelope): Promise<void> {
    if (!this.activeRoom || envelope.roomId !== this.activeRoom.roomId) {
      return;
    }

    const signaling = this.getSignalingClient();
    if (!signaling) return;

    if (envelope.messageType === 'stream_start') {
      if (this.activeRoomRole !== 'receiver' || envelope.senderDeviceId !== this.activeRoom.hostDeviceId) {
        return;
      }
      const p = envelope.payload as {
        width: number;
        height: number;
        fps: number;
        codec: CastoraVideoCodec;
        sessionId: string;
        streamId: string;
      };
      this.emit({
        phase: 'connecting',
        errorMessage: null,
        activeSessionId: p.sessionId,
        activeStreamId: p.streamId,
        targetPeerDeviceId: envelope.senderDeviceId,
        remoteStreamMeta: {
          width: p.width,
          height: p.height,
          fps: p.fps,
          codec: p.codec,
        },
        statusDetail: `Host started ${p.width}×${p.height} @ ${p.fps} FPS (${p.codec}). Negotiating WebRTC...`,
      });
      this.callbacks.onLogEvent(
        'webrtc',
        'Incoming stream announcement',
        `Host started ${p.width}×${p.height} @ ${p.fps} FPS (${p.codec}).`
      );
      return;
    }

    if (envelope.messageType === 'session_offer') {
      if (this.activeRoomRole !== 'receiver' || envelope.senderDeviceId !== this.activeRoom.hostDeviceId) {
        return;
      }
      const p = envelope.payload as {
        sessionId: string;
        streamId: string;
        sdp: string;
      };

      const isIceRestart =
        this.peer &&
        this.peer.peerDeviceId === envelope.senderDeviceId &&
        this.peer.sessionId === p.sessionId &&
        this.peer.streamId === p.streamId;

      if (!isIceRestart) {
        if (this.peer) {
          this.teardownPeerOnly('Replacing receiver peer for new offer.', 'disconnected');
        }
        this.peer = new CastoraWebRtcPeer({
          role: 'receiver',
          peerDeviceId: envelope.senderDeviceId,
          sessionId: p.sessionId,
          streamId: p.streamId,
          targetFps: this.state.remoteStreamMeta?.fps ?? 60,
          networkPrefs: this.networkPrefs,
          callbacks: {
            onIceCandidate: (candidate) => {
              signaling.sendEnvelope({
                messageType: 'ice_candidate',
                senderDeviceId: this.deviceId,
                receiverDeviceId: envelope.senderDeviceId,
                roomId: envelope.roomId,
                payload: {
                  sessionId: p.sessionId,
                  streamId: p.streamId,
                  sdpMid: candidate.sdpMid ?? null,
                  sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
                  candidate: candidate.candidate ?? '',
                },
              });
            },
            onRemoteStream: (stream) => {
              this.emit({ remoteStream: stream });
            },
            onPhaseChange: (phase, detail) => {
              this.emit({ phase, statusDetail: detail });
            },
            onIceConnectionChange: (iceConnectionState) => {
              this.emit({ iceConnectionState });
            },
            onStats: (stats) => {
              this.emit({ telemetry: stats });
            },
            onError: (msg) => {
              this.emit({ errorMessage: msg });
              this.callbacks.onLogEvent('error', 'WebRTC receiver error', msg);
            },
          },
        });
      }

      this.emit({
        phase: 'connecting',
        errorMessage: null,
        activeSessionId: p.sessionId,
        activeStreamId: p.streamId,
        targetPeerDeviceId: envelope.senderDeviceId,
      });

      try {
        const answerSdp = await this.peer!.acceptOfferAndCreateAnswer(p.sdp);
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
          isIceRestart ? 'Processed ICE restart offer' : 'Sent WebRTC SDP answer',
          `Returned SDP answer to host ${envelope.senderDeviceId}.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to negotiate SDP offer';
        this.emit({ phase: 'failed', errorMessage: msg, statusDetail: msg });
        this.callbacks.onLogEvent('error', 'SDP offer handling failed', msg);
      }
      return;
    }

    if (envelope.messageType === 'session_answer') {
      if (this.activeRoomRole !== 'host' || !this.peer) {
        return;
      }
      const p = envelope.payload as { sessionId: string; streamId: string; sdp: string };
      if (
        envelope.senderDeviceId !== this.peer.peerDeviceId ||
        p.sessionId !== this.peer.sessionId
      ) {
        return;
      }
      try {
        await this.peer.acceptAnswer(p.sdp);
        this.callbacks.onLogEvent(
          'webrtc',
          'Applied WebRTC SDP answer',
          `Completed SDP handshake with receiver ${envelope.senderDeviceId}.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to apply SDP answer';
        this.emit({ phase: 'failed', errorMessage: msg, statusDetail: msg });
        this.callbacks.onLogEvent('error', 'SDP answer error', msg);
      }
      return;
    }

    if (envelope.messageType === 'ice_candidate') {
      if (!this.peer || envelope.senderDeviceId !== this.peer.peerDeviceId) {
        return;
      }
      const p = envelope.payload as {
        sessionId: string;
        sdpMid: string | null;
        sdpMLineIndex: number;
        candidate: string;
      };
      if (p.sessionId !== this.peer.sessionId) {
        return;
      }
      await this.peer.addIceCandidate({
        candidate: p.candidate,
        sdpMid: p.sdpMid,
        sdpMLineIndex: p.sdpMLineIndex,
      });
      return;
    }

    if (envelope.messageType === 'stream_stop') {
      if (this.activeRoomRole !== 'receiver' || envelope.senderDeviceId !== this.activeRoom.hostDeviceId) {
        return;
      }
      const p = envelope.payload as { reason?: string };
      const reasonText =
        p.reason === 'capture_revoked'
          ? 'Host ended screen sharing via browser controls.'
          : 'Host stopped screen sharing.';
      this.teardownPeerOnly(reasonText, 'disconnected');
      this.emit({
        phase: 'disconnected',
        remoteStream: null,
        activeSessionId: null,
        activeStreamId: null,
        remoteStreamMeta: null,
        iceConnectionState: null,
        statusDetail: reasonText,
        telemetry: createEmptyTelemetry(this.preferences.targetFps, 'disconnected'),
      });
      this.callbacks.onLogEvent('webrtc', 'Stream ended by host', reasonText);
    }
  }

  private teardownPeerOnly(reason: string, finalPhase: WebRtcConnectionPhase): void {
    if (this.peer) {
      const closing = this.peer;
      this.peer = null;
      closing.close(reason);
    }
    this.emit({
      phase: finalPhase,
      iceConnectionState: null,
    });
  }

  dispose(): void {
    this.teardownPeerOnly('Session disposed', 'disconnected');
    if (this.captureSession) {
      this.captureSession.stop();
      this.captureSession = null;
    }
  }
}
