import type { CastoraEnvelope, CastoraPlatform, CastoraVideoCodec } from '../types/protocol';
import type {
  CapturePreferences,
  NetworkPreferences,
  StreamTelemetrySnapshot,
  WebRtcConnectionPhase,
} from '../types/studio';
import type { CastoraSignalingClient, RoomSnapshot } from './backendClient';
import {
  applyCaptureTrackConstraints,
  startScreenCapture,
  type CapturedScreenSession,
} from './screenCaptureService';
import { createEmptyTelemetry } from './streamStatsService';
import { resolveQualityTarget } from './videoQualityService';
import { CastoraWebRtcPeer } from './webrtcPeerService';

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
  stream: MediaStream | null;
  streamMeta: {
    width: number;
    height: number;
    fps: number;
    codec: CastoraVideoCodec;
  } | null;
  telemetry: StreamTelemetrySnapshot;
  startedAt: string;
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
  telemetry: StreamTelemetrySnapshot;
  qualityOverride?: Partial<CapturePreferences> | null;
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

  private captureSession: CapturedScreenSession | null = null;
  private outboundStreamId: string | null = null;
  private autoBroadcastToRoom = false;
  private pendingAutoPublishPeers = new Set<string>();
  private peers = new Map<string, CastoraWebRtcPeer>();
  private incomingMap = new Map<string, IncomingScreenEntry>();
  private outboundMap = new Map<string, OutboundPeerEntry>();
  private peerQualityOverrides = new Map<string, Partial<CapturePreferences>>();
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
  }) {
    this.deviceId = params.deviceId;
    this.preferences = params.preferences;
    this.networkPrefs = params.networkPrefs;
    this.getSignalingClient = params.getSignalingClient;
    this.callbacks = params.callbacks;
    this.captureFn = params.captureFn ?? startScreenCapture;
    this.rtcFactory = params.rtcFactory;
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
        outEntry.telemetry = {
          ...outEntry.telemetry,
          configuredMaxBitrateKbps: target.configuredMaxBitrateKbps,
          targetBitrateKbps: target.configuredMaxBitrateKbps,
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

    this.preferences = nextPreferences;
    const activeCount = Math.max(1, this.outboundMap.size);

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
        if (outEntry) {
          outEntry.telemetry = {
            ...outEntry.telemetry,
            targetFps: effectivePrefs.targetFps,
            configuredMaxBitrateKbps: resolved.configuredMaxBitrateKbps,
            targetBitrateKbps: resolved.configuredMaxBitrateKbps,
            resolution:
              this.captureSession?.actualWidth && this.captureSession?.actualHeight
                ? `${this.captureSession.actualWidth}×${this.captureSession.actualHeight}`
                : outEntry.telemetry.resolution,
          };
          this.outboundMap.set(peerId, outEntry);
        }
      }
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
    const resolvedGlobal = resolveQualityTarget(this.preferences, {
      width: this.captureSession?.actualWidth,
      height: this.captureSession?.actualHeight,
    });

    const outboundTelemetry: StreamTelemetrySnapshot = primaryOutbound
      ? primaryOutbound.telemetry
      : {
          ...createEmptyTelemetry(this.preferences.targetFps, this.captureSession ? phase : 'idle'),
          captureFps: this.captureSession?.actualFrameRate ?? null,
          resolution:
            this.captureSession?.actualWidth && this.captureSession?.actualHeight
              ? `${this.captureSession.actualWidth}×${this.captureSession.actualHeight}`
              : null,
          configuredMaxBitrateKbps: this.captureSession
            ? resolvedGlobal.configuredMaxBitrateKbps
            : null,
          targetBitrateKbps: this.captureSession
            ? resolvedGlobal.configuredMaxBitrateKbps
            : null,
        };

    const inboundTelemetry: StreamTelemetrySnapshot = primaryInbound
      ? primaryInbound.telemetry
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
            width: this.captureSession.actualWidth,
            height: this.captureSession.actualHeight,
            fps: this.captureSession.actualFrameRate,
            hasAudio: this.captureSession.hasAudio,
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
              stream,
              streamMeta: null,
              telemetry: createEmptyTelemetry(this.preferences.targetFps, 'connected'),
              startedAt: new Date().toISOString(),
            };
            entry.stream = stream;
            entry.phase = 'connected';
            entry.errorMessage = null;
            entry.statusDetail = `Receiving live screen from ${entry.senderName}.`;
            this.incomingMap.set(peerDeviceId, entry);
            this.statusDetail = `Receiving live screen from ${entry.senderName}.`;
          } else if (existingEntry) {
            existingEntry.stream = null;
            if (!peer.getActiveInboundStreamId()) {
              this.incomingMap.delete(peerDeviceId);
            } else {
              this.incomingMap.set(peerDeviceId, existingEntry);
            }
          }
          this.emit();
        },
        onPhaseChange: (phase, detail) => {
          const outEntry = this.outboundMap.get(peerDeviceId);
          if (outEntry) {
            outEntry.phase = phase;
            outEntry.statusDetail = detail;
            this.outboundMap.set(peerDeviceId, outEntry);
          }
          const inEntry = this.incomingMap.get(peerDeviceId);
          if (inEntry) {
            inEntry.phase = phase;
            inEntry.statusDetail = detail;
            this.incomingMap.set(peerDeviceId, inEntry);
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
        onStats: (dualStats) => {
          const outEntry = this.outboundMap.get(peerDeviceId);
          if (outEntry) {
            outEntry.telemetry = dualStats.outbound;
            this.outboundMap.set(peerDeviceId, outEntry);
          }
          const inEntry = this.incomingMap.get(peerDeviceId);
          if (inEntry) {
            inEntry.telemetry = dualStats.inbound;
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

  private removePeerConnection(peerDeviceId: string, reason: string): void {
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
      this.pendingAutoPublishPeers.clear();
      this.statusDetail = null;
      this.errorMessage = null;
      this.emit();
      return;
    }

    if (!this.activeRoom) return;

    // Close only peers that left the room or dropped their signaling connection;
    // keep all other peer streams and local capture completely undisturbed.
    let changed = false;
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
        if (!serverInboundPublishers.has(senderId)) {
          const peer = this.peers.get(senderId);
          peer?.clearInboundStream(`${entry.senderName} stopped screen sharing.`);
          this.incomingMap.delete(senderId);
          changed = true;
        }
      }
    }

    if (
      this.captureSession &&
      this.autoBroadcastToRoom &&
      this.isSelfAuthorizedInRoom()
    ) {
      const roomPeers = this.resolvePublishTargets('ALL');
      for (const peerId of roomPeers) {
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

    this.callbacks.onLogEvent(
      'webrtc',
      'Local screen capture started',
      `Track active${resLabel ? ` (${resLabel})` : ''}${session.actualFrameRate ? ` @ ${Math.round(session.actualFrameRate)} FPS` : ''}.`
    );

    const targets = this.resolvePublishTargets(targetSelection);
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
      telemetry: {
        ...createEmptyTelemetry(effectivePrefs.targetFps, 'connecting'),
        configuredMaxBitrateKbps: resolvedQuality.configuredMaxBitrateKbps,
        targetBitrateKbps: resolvedQuality.configuredMaxBitrateKbps,
        resolution:
          this.captureSession.actualWidth && this.captureSession.actualHeight
            ? `${this.captureSession.actualWidth}×${this.captureSession.actualHeight}`
            : null,
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

  stopSharing(reason: 'user_stopped' | 'capture_revoked' = 'user_stopped'): void {
    this.autoBroadcastToRoom = false;
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
        startedAt: existing?.startedAt ?? new Date().toISOString(),
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
      const p = envelope.payload as { reason?: string };
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
    for (const peerId of Array.from(this.peers.keys())) {
      this.removePeerConnection(peerId, 'Session disposed');
    }
    if (this.captureSession) {
      this.captureSession.stop();
      this.captureSession = null;
    }
    this.outboundStreamId = null;
  }
}
