import { useCallback, useEffect, useRef, useState } from 'react';
import { MobileReceiverBar } from './components/layout/MobileReceiverBar';
import { TopControlBar } from './components/layout/TopControlBar';
import {
  CastoraSignalingClient,
  approveBackendPairRequest,
  closeBackendRoom,
  createBackendRoom,
  fetchBackendHealth,
  leaveBackendRoom,
  rejectBackendPairRequest,
  removeBackendReceiver,
  submitBackendPairRequest,
  type BackendHealthResponse,
  type PairingLifecycleStatus,
  type RoomSnapshot,
  type SignalingSocketState,
} from './services/backendClient';
import {
  loadOrCreateDeviceId,
  loadSavedDeviceName,
  probeBrowserCapabilities,
  saveDeviceName,
} from './services/browserCapabilities';
import { createEmptyTelemetry } from './services/streamStatsService';
import {
  WebRtcSignalingBridge,
  type WebRtcSessionSnapshot,
} from './services/webrtcSignalingBridge';
import type { CastoraVideoCodec, DeviceCapabilities } from './types/protocol';
import type {
  ActivityEvent,
  BrowserCapabilityReport,
  CapturePreferences,
  ConnectedReceiverSlot,
  MultiViewLayout,
  NetworkPreferences,
  SessionSummaryRecord,
  StudioDestination,
} from './types/studio';
import { ActivityView } from './views/ActivityView';
import { CastView } from './views/CastView';
import { ControlRoomView } from './views/ControlRoomView';
import { MultiViewView } from './views/MultiViewView';
import { ReceiversView } from './views/ReceiversView';
import { SettingsView } from './views/SettingsView';

function formatClockTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function getInitialRouteState(): {
  destination: StudioDestination;
  roomCode: string;
} {
  if (typeof window === 'undefined') {
    return { destination: 'control-room', roomCode: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const room = (params.get('room') ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);

  if (window.location.pathname.includes('/join') || room.length > 0) {
    return { destination: 'receivers', roomCode: room };
  }
  return { destination: 'control-room', roomCode: '' };
}

function toProtocolCapabilities(
  caps: BrowserCapabilityReport,
  prefs: CapturePreferences
): DeviceCapabilities {
  const mappedCodecs: CastoraVideoCodec[] = [];
  if (caps.supportsVideoH264Encode || caps.supportsVideoH264Decode) {
    mappedCodecs.push('H264');
  }
  if (caps.detectedVideoCodecs.includes('VP9')) mappedCodecs.push('VP9');
  if (caps.detectedVideoCodecs.includes('VP8')) mappedCodecs.push('VP8');
  if (caps.detectedVideoCodecs.includes('AV1')) mappedCodecs.push('AV1');
  if (mappedCodecs.length === 0) mappedCodecs.push('H264');

  return {
    maxWidth: prefs.resolution === '720p' ? 1280 : 1920,
    maxHeight: prefs.resolution === '720p' ? 720 : 1080,
    maxFps: prefs.targetFps,
    codecs: mappedCodecs,
    supportsAudio: prefs.includeAudio,
  };
}

function parseRoomSnapshotFromEnvelope(
  roomId: string,
  payload: Record<string, unknown>
): RoomSnapshot {
  const pendingRequests = Array.isArray(payload.pendingRequests)
    ? (payload.pendingRequests as RoomSnapshot['pendingRequests'])
    : [];
  const pairedReceivers = Array.isArray(payload.pairedReceivers)
    ? (payload.pairedReceivers as RoomSnapshot['pairedReceivers'])
    : [];
  const activeStreams = Array.isArray(payload.activeStreams)
    ? (payload.activeStreams as NonNullable<RoomSnapshot['activeStreams']>)
    : [];

  return {
    roomId,
    status: (payload.status as RoomSnapshot['status']) ?? 'active',
    hostDeviceId: String(payload.hostDeviceId ?? ''),
    hostDeviceName: String(payload.hostDeviceName ?? ''),
    hostPlatform: (payload.hostPlatform as RoomSnapshot['hostPlatform']) ?? 'macos',
    hostConnected: Boolean(payload.hostConnected),
    expiresAt: String(payload.expiresAt ?? ''),
    maxReceivers: Number(payload.maxReceivers ?? 6),
    activeReceiverCount: pairedReceivers.filter((r) => r.connected).length,
    pairedReceiverCount: pairedReceivers.length,
    pendingCount: pendingRequests.length,
    pendingRequests,
    pairedReceivers,
    activeStreams,
  };
}

export function App() {
  const [capabilities, setCapabilities] = useState<BrowserCapabilityReport>(() =>
    probeBrowserCapabilities()
  );
  const [deviceId] = useState<string>(() => loadOrCreateDeviceId());
  const [deviceName, setDeviceName] = useState<string>(() =>
    loadSavedDeviceName(probeBrowserCapabilities().userAgentSummary)
  );

  const initialRoute = getInitialRouteState();
  const [destination, setDestination] = useState<StudioDestination>(initialRoute.destination);
  const [multiViewLayout, setMultiViewLayout] = useState<MultiViewLayout>('4-up');

  const [preferences, setPreferences] = useState<CapturePreferences>({
    resolution: '1080p',
    targetFps: 60,
    codecPreference: 'H264',
    includeAudio: false,
  });

  const [networkPrefs, setNetworkPrefs] = useState<NetworkPreferences>({
    preferLanDirectP2P: true,
    stunUrls: 'stun:stun.l.google.com:19302',
    turnUrl: '',
    turnUsername: '',
    turnCredential: '',
  });

  // Authoritative Stage 3 pairing & backend state (tokens held in memory only)
  const [backendHealth, setBackendHealth] = useState<BackendHealthResponse | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [signalingState, setSignalingState] = useState<SignalingSocketState>('disconnected');
  const [activeRoom, setActiveRoom] = useState<RoomSnapshot | null>(null);
  const [activeRoomRole, setActiveRoomRole] = useState<'host' | 'receiver' | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingLifecycleStatus>('Available');
  const [pairingDetail, setPairingDetail] = useState<string | null>(null);

  const roomTokenRef = useRef<string | null>(null);
  const activeRoomIdRef = useRef<string | null>(null);
  const activeRoomRoleRef = useRef<'host' | 'receiver' | null>(null);
  const signalingClientRef = useRef<CastoraSignalingClient | null>(null);
  const bridgeRef = useRef<WebRtcSignalingBridge | null>(null);
  const sessionStartedAtRef = useRef<number | null>(null);

  const [webrtcState, setWebrtcState] = useState<WebRtcSessionSnapshot>(() => ({
    phase: 'idle',
    statusDetail: null,
    errorMessage: null,
    iceConnectionState: null,
    isSharingLocal: false,
    localStream: null,
    localCaptureMeta: null,
    remoteStream: null,
    activeSessionId: null,
    activeStreamId: null,
    targetPeerDeviceId: null,
    remoteStreamMeta: null,
    telemetry: createEmptyTelemetry(60, 'idle'),
    outboundTelemetry: createEmptyTelemetry(60, 'idle'),
    inboundTelemetry: createEmptyTelemetry(60, 'idle'),
    incomingStreams: [],
    outboundPeers: [],
    peerCount: 0,
  }));
  const [mutedSlots, setMutedSlots] = useState<Record<string, boolean>>({});
  const [recentSessions, setRecentSessions] = useState<SessionSummaryRecord[]>([]);

  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>(() => {
    const bootCaps = probeBrowserCapabilities();
    const now = formatClockTime(new Date());
    return [
      {
        id: 'boot-cap-1',
        timestamp: now,
        category: 'capability',
        title: 'Runtime capability probe completed',
        detail: `${bootCaps.userAgentSummary} · SecureContext=${bootCaps.isSecureContext} · getDisplayMedia=${bootCaps.supportsDisplayMedia} · H264(enc=${bootCaps.supportsVideoH264Encode}, dec=${bootCaps.supportsVideoH264Decode})`,
      },
      {
        id: 'boot-ui-2',
        timestamp: now,
        category: 'signaling',
        title: 'Initializing Castora Pro signaling connection',
        detail: 'Checking GET /api/health and connecting WebSocket /castora...',
      },
    ];
  });

  const logEvent = useCallback(
    (
      category: ActivityEvent['category'],
      title: string,
      detail: string
    ) => {
      const event: ActivityEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: formatClockTime(new Date()),
        category,
        title,
        detail,
      };
      setActivityEvents((prev) => [event, ...prev].slice(0, 200));
    },
    []
  );

  if (!bridgeRef.current) {
    bridgeRef.current = new WebRtcSignalingBridge({
      deviceId,
      preferences,
      networkPrefs,
      getSignalingClient: () => signalingClientRef.current,
      callbacks: {
        onStateChange: (snapshot) => {
          setWebrtcState(snapshot);
          if (snapshot.phase === 'connected' && sessionStartedAtRef.current === null) {
            sessionStartedAtRef.current = Date.now();
          }
        },
        onLogEvent: logEvent,
      },
    });
  }

  useEffect(() => {
    bridgeRef.current?.updateContext({
      deviceId,
      activeRoom,
      activeRoomRole,
      preferences,
      networkPrefs,
    });
  }, [deviceId, activeRoom, activeRoomRole, preferences, networkPrefs]);

  const refreshHealth = useCallback(async () => {
    try {
      const health = await fetchBackendHealth();
      setBackendHealth(health);
      setBackendError(null);
      return health;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Backend unreachable';
      setBackendHealth(null);
      setBackendError(msg);
      return null;
    }
  }, []);

  const syncReceiverLifecycleFromSnapshot = useCallback(
    (snapshot: RoomSnapshot) => {
      if (
        !activeRoomRoleRef.current ||
        activeRoomIdRef.current !== snapshot.roomId
      ) {
        return;
      }

      if (snapshot.status === 'expired') {
        roomTokenRef.current = null;
        activeRoomIdRef.current = null;
        activeRoomRoleRef.current = null;
        setActiveRoom(null);
        setActiveRoomRole(null);
        setPairingStatus('Expired');
        setPairingDetail(`Room ${snapshot.roomId} expired.`);
        return;
      }

      if (snapshot.status === 'closed') {
        roomTokenRef.current = null;
        activeRoomIdRef.current = null;
        activeRoomRoleRef.current = null;
        setActiveRoom(null);
        setActiveRoomRole(null);
        setPairingStatus('Disconnected');
        setPairingDetail(`Room ${snapshot.roomId} was closed by the host.`);
        return;
      }

      setActiveRoom(snapshot);

      if (activeRoomRoleRef.current === 'host') {
        if (snapshot.pairedReceiverCount > 0) {
          setPairingStatus('Paired');
          setPairingDetail(
            `${snapshot.activeReceiverCount} connected · ${snapshot.pairedReceiverCount}/${snapshot.maxReceivers} paired.`
          );
        } else if (snapshot.pendingCount > 0) {
          setPairingStatus('Awaiting approval');
          setPairingDetail(`${snapshot.pendingCount} pairing request awaiting host approval.`);
        } else {
          setPairingStatus('Available');
          setPairingDetail(`Room ${snapshot.roomId} active. Waiting for receiver requests.`);
        }
        return;
      }

      if (activeRoomRoleRef.current === 'receiver') {
        const isPaired = snapshot.pairedReceivers.some((r) => r.deviceId === deviceId);
        const isPending = snapshot.pendingRequests.some((r) => r.deviceId === deviceId);

        if (isPaired) {
          if (!snapshot.hostConnected) {
            setPairingStatus('Disconnected');
            setPairingDetail('Host disconnected temporarily. Waiting for host reconnect or room expiry.');
          } else {
            setPairingStatus('Paired');
            setPairingDetail(`Paired with ${snapshot.hostDeviceName} in room ${snapshot.roomId}.`);
          }
        } else if (isPending) {
          setPairingStatus('Awaiting approval');
          setPairingDetail(`Request pending approval from ${snapshot.hostDeviceName}.`);
        } else {
          roomTokenRef.current = null;
          activeRoomIdRef.current = null;
          activeRoomRoleRef.current = null;
          setActiveRoom(null);
          setActiveRoomRole(null);
          setPairingStatus('Disconnected');
          setPairingDetail('Removed from room.');
        }
      }
    },
    [deviceId]
  );

  const connectSignaling = useCallback(
    (roomId: string | null, token: string | null) => {
      if (!signalingClientRef.current) {
        signalingClientRef.current = new CastoraSignalingClient();
      }
      signalingClientRef.current.connect({
        deviceId,
        deviceName,
        platform: capabilities.detectedPlatform,
        capabilities: toProtocolCapabilities(capabilities, preferences),
        roomId,
        token,
        handlers: {
          onStateChange: (nextState, detail) => {
            setSignalingState(nextState);
            if (nextState === 'connected') {
              logEvent('signaling', 'Connected to /castora', detail ?? 'Device registered on server.');
              void refreshHealth();
            } else if (nextState === 'error') {
              logEvent('error', 'Signaling socket error', detail ?? 'Unable to connect to /castora.');
            } else if (nextState === 'disconnected') {
              logEvent('signaling', 'Signaling socket disconnected', detail ?? 'Socket closed.');
              if (activeRoomIdRef.current) {
                setPairingStatus('Disconnected');
                setPairingDetail('Signaling connection lost. Click reconnect to restore room state.');
              }
            }
          },
          onEnvelope: (envelope) => {
            if (envelope.messageType === 'room_state' && envelope.roomId) {
              const snapshot = parseRoomSnapshotFromEnvelope(envelope.roomId, envelope.payload);
              syncReceiverLifecycleFromSnapshot(snapshot);
              void refreshHealth();
              return;
            }

            if (envelope.messageType === 'pair_response') {
              const payload = envelope.payload as {
                paired?: boolean;
                reason?: string | null;
                sessionId?: string | null;
              };
              if (payload.paired) {
                setPairingStatus('Paired');
                setPairingDetail('Host approved pairing request.');
                logEvent('signaling', 'Pairing approved by host', `Room ${envelope.roomId ?? ''}`);
              } else {
                roomTokenRef.current = null;
                activeRoomIdRef.current = null;
                activeRoomRoleRef.current = null;
                setActiveRoom(null);
                setActiveRoomRole(null);
                setPairingStatus('Rejected');
                setPairingDetail(payload.reason ?? 'Host declined pairing request.');
                logEvent('signaling', 'Pairing rejected by host', payload.reason ?? 'Declined');
              }
              void refreshHealth();
              return;
            }

            if (envelope.messageType === 'error') {
              const payload = envelope.payload as { code?: string; message?: string };
              logEvent(
                'error',
                `Server error (${payload.code ?? 'UNKNOWN'})`,
                payload.message ?? 'Signaling error received'
              );
              return;
            }

            if (envelope.messageType === 'disconnect') {
              const payload = envelope.payload as { reason?: string };
              const reason = payload.reason ?? 'Disconnected';
              logEvent('signaling', 'Server disconnect notice', reason);

              if (reason === 'Room expired') {
                roomTokenRef.current = null;
                activeRoomIdRef.current = null;
                activeRoomRoleRef.current = null;
                setActiveRoom(null);
                setActiveRoomRole(null);
                setPairingStatus('Expired');
                setPairingDetail('Room expired on server.');
              } else if (reason === 'Room closed by host' || reason === 'Removed by host') {
                roomTokenRef.current = null;
                activeRoomIdRef.current = null;
                activeRoomRoleRef.current = null;
                setActiveRoom(null);
                setActiveRoomRole(null);
                setPairingStatus('Disconnected');
                setPairingDetail(reason);
              } else if (reason === 'Host disconnected') {
                setPairingStatus('Disconnected');
                setPairingDetail('Host disconnected. Waiting for host reconnection or room expiry.');
              }
              void refreshHealth();
              return;
            }

            if (
              envelope.messageType === 'stream_start' ||
              envelope.messageType === 'session_offer' ||
              envelope.messageType === 'session_answer' ||
              envelope.messageType === 'ice_candidate' ||
              envelope.messageType === 'stream_stop'
            ) {
              void bridgeRef.current?.handleIncomingEnvelope(envelope);
            }
          },
        },
      });
    },
    [
      capabilities,
      deviceId,
      deviceName,
      logEvent,
      preferences,
      refreshHealth,
      syncReceiverLifecycleFromSnapshot,
    ]
  );

  useEffect(() => {
    void refreshHealth();
    connectSignaling(null, null);
    const healthTimer = window.setInterval(() => {
      void refreshHealth();
    }, 15_000);

    return () => {
      window.clearInterval(healthTimer);
      bridgeRef.current?.dispose();
      signalingClientRef.current?.disconnect(false);
    };
    // Initial boot connection on mount; explicit reconnects use handleReconnectBackend
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReconnectBackend = useCallback(() => {
    void refreshHealth();
    connectSignaling(activeRoomIdRef.current, roomTokenRef.current);
  }, [connectSignaling, refreshHealth]);

  const handleCreateRoom = useCallback(async () => {
    const created = await createBackendRoom({
      hostDeviceId: deviceId,
      hostDeviceName: deviceName,
      hostPlatform: capabilities.detectedPlatform,
    });
    roomTokenRef.current = created.hostToken;
    activeRoomIdRef.current = created.room.roomId;
    activeRoomRoleRef.current = 'host';
    setActiveRoom(created.room);
    setActiveRoomRole('host');
    setPairingStatus('Available');
    setPairingDetail(`Room ${created.room.roomId} active. Waiting for receiver pairing requests.`);
    connectSignaling(created.room.roomId, created.hostToken);
    logEvent(
      'signaling',
      `Created room ${created.room.roomId}`,
      `Expires at ${new Date(created.room.expiresAt).toLocaleTimeString()}.`
    );
    void refreshHealth();
    return created.room;
  }, [capabilities.detectedPlatform, connectSignaling, deviceId, deviceName, logEvent, refreshHealth]);

  const handleSubmitPairRequest = useCallback(
    async (roomId: string) => {
      setPairingStatus('Request pending');
      setPairingDetail(`Submitting pairing request for room ${roomId}...`);
      try {
        const submitted = await submitBackendPairRequest({
          roomId,
          receiverDeviceId: deviceId,
          deviceName,
          platform: capabilities.detectedPlatform,
          pairingMethod: 'room_code',
        });
        roomTokenRef.current = submitted.memberToken;
        activeRoomIdRef.current = submitted.room.roomId;
        activeRoomRoleRef.current = 'receiver';
        setActiveRoom(submitted.room);
        setActiveRoomRole('receiver');
        setPairingStatus('Awaiting approval');
        setPairingDetail(`Waiting for ${submitted.room.hostDeviceName} to approve pairing.`);
        connectSignaling(submitted.room.roomId, submitted.memberToken);
        logEvent(
          'signaling',
          `Pairing request submitted (${submitted.room.roomId})`,
          `Awaiting host approval from ${submitted.room.hostDeviceName}.`
        );
        void refreshHealth();
        return submitted.room;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to submit pairing request';
        if (msg.toLowerCase().includes('expired')) {
          setPairingStatus('Expired');
        } else {
          setPairingStatus('Available');
        }
        setPairingDetail(msg);
        throw err;
      }
    },
    [capabilities.detectedPlatform, connectSignaling, deviceId, deviceName, logEvent, refreshHealth]
  );

  const handleApproveReceiver = useCallback(
    async (receiverDeviceId: string) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Host session token unavailable');
      }
      const updated = await approveBackendPairRequest({
        roomId: activeRoom.roomId,
        receiverDeviceId,
        hostToken: roomTokenRef.current,
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent('signaling', `Approved receiver ${receiverDeviceId}`, `Paired in room ${updated.roomId}.`);
      void refreshHealth();
      return updated;
    },
    [activeRoom, logEvent, refreshHealth, syncReceiverLifecycleFromSnapshot]
  );

  const handleRejectReceiver = useCallback(
    async (receiverDeviceId: string) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Host session token unavailable');
      }
      const updated = await rejectBackendPairRequest({
        roomId: activeRoom.roomId,
        receiverDeviceId,
        hostToken: roomTokenRef.current,
        reason: 'Host declined pairing request',
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent('signaling', `Rejected receiver ${receiverDeviceId}`, `Removed pending request from ${updated.roomId}.`);
      void refreshHealth();
      return updated;
    },
    [activeRoom, logEvent, refreshHealth, syncReceiverLifecycleFromSnapshot]
  );

  const handleRemoveReceiver = useCallback(
    async (receiverDeviceId: string) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Host session token unavailable');
      }
      const updated = await removeBackendReceiver({
        roomId: activeRoom.roomId,
        receiverDeviceId,
        hostToken: roomTokenRef.current,
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent('signaling', `Removed paired receiver ${receiverDeviceId}`, `Freed receiver slot in room ${updated.roomId}.`);
      void refreshHealth();
      return updated;
    },
    [activeRoom, logEvent, refreshHealth, syncReceiverLifecycleFromSnapshot]
  );

  const handleLeaveRoom = useCallback(async () => {
    if (!activeRoom || !roomTokenRef.current) return;
    const roomId = activeRoom.roomId;
    await leaveBackendRoom({
      roomId,
      deviceId,
      memberToken: roomTokenRef.current,
    });
    roomTokenRef.current = null;
    activeRoomIdRef.current = null;
    activeRoomRoleRef.current = null;
    setActiveRoom(null);
    setActiveRoomRole(null);
    setPairingStatus('Available');
    setPairingDetail(`Left room ${roomId}.`);
    connectSignaling(null, null);
    logEvent('signaling', `Left room ${roomId}`, 'Receiver membership cleared.');
    void refreshHealth();
  }, [activeRoom, connectSignaling, deviceId, logEvent, refreshHealth]);

  const handleCloseRoom = useCallback(async () => {
    if (!activeRoom || !roomTokenRef.current) return;
    const roomId = activeRoom.roomId;
    await closeBackendRoom(roomId, roomTokenRef.current);
    roomTokenRef.current = null;
    activeRoomIdRef.current = null;
    activeRoomRoleRef.current = null;
    setActiveRoom(null);
    setActiveRoomRole(null);
    setPairingStatus('Available');
    setPairingDetail(`Room ${roomId} closed.`);
    connectSignaling(null, null);
    logEvent('signaling', `Closed room ${roomId}`, 'Room removed from server.');
    void refreshHealth();
  }, [activeRoom, connectSignaling, logEvent, refreshHealth]);

  const handleSaveDeviceName = (nextName: string) => {
    const saved = saveDeviceName(nextName);
    if (saved) {
      setDeviceName(saved);
      logEvent('ui', 'Local device identity updated', `Device display name set to "${saved}".`);
    }
  };

  const handleReprobeCapabilities = () => {
    const next = probeBrowserCapabilities();
    setCapabilities(next);
    logEvent(
      'capability',
      'Browser capability probe refreshed',
      `SecureContext=${next.isSecureContext} · getDisplayMedia=${next.supportsDisplayMedia} · Codecs=${next.detectedVideoCodecs.join(', ') || 'none'}`
    );
  };

  const handleStartSharing = useCallback(async (targetSelection: string | string[] | null = null) => {
    if (!bridgeRef.current) return;
    await bridgeRef.current.startScreenSharing(targetSelection);
  }, []);

  const handleConnectReceiver = useCallback(async (targetReceiverId: string) => {
    if (!bridgeRef.current) return;
    await bridgeRef.current.connectStreamToReceiver(targetReceiverId);
  }, []);

  const handleStopSharing = useCallback(() => {
    if (!bridgeRef.current) return;
    const snap = bridgeRef.current.getSnapshot();
    const primaryOut = snap.outboundPeers[0];
    if ((primaryOut || snap.isSharingLocal) && sessionStartedAtRef.current !== null) {
      const elapsedSec = Math.max(1, Math.round((Date.now() - sessionStartedAtRef.current) / 1000));
      const peerName =
        snap.outboundPeers.length > 1
          ? `${snap.outboundPeers.length} participants`
          : primaryOut?.targetName ?? 'Peer';
      setRecentSessions((prev) => [
        {
          sessionId: primaryOut?.sessionId ?? snap.activeSessionId ?? `sess-${Date.now()}`,
          direction: 'outbound',
          peerName,
          resolution: snap.outboundTelemetry.resolution ?? preferences.resolution.toUpperCase(),
          durationLabel: `${elapsedSec}s`,
          outcome: 'completed',
        },
        ...prev.slice(0, 9),
      ]);
    }
    if (snap.incomingStreams.length === 0) {
      sessionStartedAtRef.current = null;
    }
    bridgeRef.current.stopSharing('user_stopped');
  }, [preferences.resolution]);

  const receivers: ConnectedReceiverSlot[] = (() => {
    if (!activeRoom) return [];
    const list: ConnectedReceiverSlot[] = [];
    if (activeRoom.hostDeviceId !== deviceId) {
      const incomingFromHost = webrtcState.incomingStreams.find(
        (s) => s.senderDeviceId === activeRoom.hostDeviceId
      );
      list.push({
        slotIndex: 0,
        receiverDeviceId: activeRoom.hostDeviceId,
        deviceName: `${activeRoom.hostDeviceName} (Host)`,
        platform: activeRoom.hostPlatform,
        connectionState: incomingFromHost?.phase ?? (activeRoom.hostConnected ? 'idle' : 'disconnected'),
        stream: incomingFromHost?.stream ?? null,
        hasAudioTrack: Boolean(incomingFromHost?.stream?.getAudioTracks().length),
        muted: mutedSlots[activeRoom.hostDeviceId] ?? true,
        telemetry:
          incomingFromHost?.telemetry ??
          createEmptyTelemetry(preferences.targetFps, activeRoom.hostConnected ? 'idle' : 'disconnected'),
      });
    }
    for (const rx of activeRoom.pairedReceivers) {
      if (rx.deviceId === deviceId) continue;
      const incoming = webrtcState.incomingStreams.find((s) => s.senderDeviceId === rx.deviceId);
      const outbound = webrtcState.outboundPeers.find((o) => o.targetDeviceId === rx.deviceId);
      list.push({
        slotIndex: rx.assignedSlotIndex,
        receiverDeviceId: rx.deviceId,
        deviceName: rx.deviceName,
        platform: rx.platform,
        connectionState:
          incoming?.phase ??
          outbound?.phase ??
          (rx.connected ? 'idle' : 'disconnected'),
        stream: incoming?.stream ?? null,
        hasAudioTrack: Boolean(incoming?.stream?.getAudioTracks().length),
        muted: mutedSlots[rx.deviceId] ?? true,
        telemetry:
          incoming?.telemetry ??
          outbound?.telemetry ??
          createEmptyTelemetry(preferences.targetFps, rx.connected ? 'idle' : 'disconnected'),
      });
    }
    return list;
  })();

  const multiViewSlots: ConnectedReceiverSlot[] = webrtcState.incomingStreams.map((entry, idx) => ({
    slotIndex: idx,
    receiverDeviceId: entry.senderDeviceId,
    deviceName: entry.senderName,
    platform: entry.senderPlatform,
    connectionState: entry.phase,
    stream: entry.stream,
    hasAudioTrack: Boolean(entry.stream?.getAudioTracks().length),
    muted: mutedSlots[entry.senderDeviceId] ?? true,
    telemetry: entry.telemetry,
  }));

  return (
    <div className="min-h-screen bg-[#101214] text-[#F2F3F0] flex flex-col">
      <TopControlBar
        activeDestination={destination}
        onSelectDestination={setDestination}
        signalingState={signalingState}
        isSecureContext={capabilities.isSecureContext}
        onPrimaryAction={() => setDestination('cast')}
      />

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 pb-24 sm:px-6 md:pb-8">
        {destination === 'control-room' && (
          <ControlRoomView
            deviceId={deviceId}
            deviceName={deviceName}
            capabilities={capabilities}
            preferences={preferences}
            receivers={receivers}
            webrtcState={webrtcState}
            recentSessions={recentSessions}
            backendHealth={backendHealth}
            backendError={backendError}
            signalingState={signalingState}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            pairingStatus={pairingStatus}
            onStartSharing={handleStartSharing}
            onStopSharing={handleStopSharing}
            onReconnectBackend={handleReconnectBackend}
            onNavigate={setDestination}
          />
        )}

        {destination === 'cast' && (
          <CastView
            deviceId={deviceId}
            capabilities={capabilities}
            preferences={preferences}
            onUpdatePreferences={setPreferences}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            pairingStatus={pairingStatus}
            webrtcState={webrtcState}
            onStartSharing={handleStartSharing}
            onConnectReceiver={handleConnectReceiver}
            onStopSharing={handleStopSharing}
            onNavigate={setDestination}
            onLogEvent={logEvent}
          />
        )}

        {destination === 'receivers' && (
          <ReceiversView
            deviceId={deviceId}
            deviceName={deviceName}
            capabilities={capabilities}
            initialRoomCode={initialRoute.roomCode}
            activePhase={webrtcState.phase}
            signalingState={signalingState}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            pairingStatus={pairingStatus}
            pairingDetail={pairingDetail}
            webrtcState={webrtcState}
            onCreateRoom={handleCreateRoom}
            onSubmitPairRequest={handleSubmitPairRequest}
            onApproveReceiver={handleApproveReceiver}
            onRejectReceiver={handleRejectReceiver}
            onRemoveReceiver={handleRemoveReceiver}
            onLeaveRoom={handleLeaveRoom}
            onCloseRoom={handleCloseRoom}
            onStartSharing={handleStartSharing}
            onStopSharing={handleStopSharing}
            onNavigate={setDestination}
            onLogEvent={logEvent}
          />
        )}

        {destination === 'multi-view' && (
          <MultiViewView
            layout={multiViewLayout}
            onChangeLayout={setMultiViewLayout}
            slots={multiViewSlots}
            capabilities={capabilities}
            onToggleMute={(slotIndex) => {
              const targetId = multiViewSlots[slotIndex]?.receiverDeviceId ?? String(slotIndex);
              setMutedSlots((prev) => ({ ...prev, [targetId]: !(prev[targetId] ?? true) }));
            }}
            onDisconnectSlot={(peerId) => {
              if (activeRoomRole === 'host') {
                void handleRemoveReceiver(peerId);
              } else {
                void handleLeaveRoom();
              }
            }}
            onLogEvent={logEvent}
          />
        )}

        {destination === 'activity' && (
          <ActivityView
            events={activityEvents}
            onClearEvents={() => setActivityEvents([])}
          />
        )}

        {destination === 'settings' && (
          <SettingsView
            deviceId={deviceId}
            deviceName={deviceName}
            onSaveDeviceName={handleSaveDeviceName}
            preferences={preferences}
            onUpdatePreferences={setPreferences}
            networkPrefs={networkPrefs}
            onUpdateNetworkPrefs={setNetworkPrefs}
            capabilities={capabilities}
            onReprobeCapabilities={handleReprobeCapabilities}
            onLogEvent={logEvent}
          />
        )}
      </main>

      <MobileReceiverBar
        activeDestination={destination}
        onSelectDestination={setDestination}
      />
    </div>
  );
}

export default App;
