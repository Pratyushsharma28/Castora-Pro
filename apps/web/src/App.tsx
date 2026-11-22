import { useCallback, useEffect, useRef, useState } from 'react';
import { MobileReceiverBar } from './components/layout/MobileReceiverBar';
import { TopControlBar } from './components/layout/TopControlBar';
import {
  CastoraSignalingClient,
  approveBackendPairRequest,
  cancelBackendHostTransfer,
  closeBackendRoom,
  createBackendRoom,
  fetchBackendHealth,
  fetchBackendIceServers,
  fetchBackendRoom,
  fetchBackendRoomInvitation,
  initiateBackendHostTransfer,
  leaveBackendRoom,
  rejectBackendPairRequest,
  removeBackendReceiver,
  renameBackendRoom,
  renameBackendRoomDevice,
  requestBackendDeviceReconnect,
  respondBackendHostTransfer,
  restoreBackendSession,
  rotateBackendRoomInvitation,
  stopBackendDeviceStream,
  submitBackendPairRequest,
  updateBackendRoomSettings,
  validateBackendInvitation,
  type BackendHealthResponse,
  type PairingLifecycleStatus,
  type PublicHostTransfer,
  type RoomSnapshot,
  type SignalingSocketState,
} from './services/backendClient';
import {
  loadOrCreateDeviceId,
  loadSavedDeviceName,
  probeBrowserCapabilities,
  saveDeviceName,
  validateDeviceDisplayName,
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
  RoomPrivacyMode,
  SessionSummaryRecord,
  StudioDestination,
} from './types/studio';
import { ActivityView } from './views/ActivityView';
import { ControlRoomView } from './views/ControlRoomView';
import { DevicesView } from './views/DevicesView';
import { MultiViewView } from './views/MultiViewView';
import { ReceiversView } from './views/ReceiversView';
import { SessionView } from './views/SessionView';
import { SettingsView } from './views/SettingsView';

function formatClockTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function getInitialRouteState(): {
  destination: StudioDestination;
  roomCode: string;
  inviteCode: string;
} {
  if (typeof window === 'undefined') {
    return { destination: 'control-room', roomCode: '', inviteCode: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const room = (params.get('room') ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  const inviteCode = (params.get('invite') ?? '').trim().slice(0, 128);

  if (window.location.pathname.includes('/join') || room.length > 0) {
    return { destination: 'receivers', roomCode: room, inviteCode };
  }

  const viewParam = (params.get('view') ?? '').toLowerCase();
  if (viewParam === 'rooms' || viewParam === 'receivers') {
    return { destination: 'receivers', roomCode: '', inviteCode: '' };
  }
  if (viewParam === 'sessions' || viewParam === 'session') {
    return { destination: 'sessions', roomCode: '', inviteCode: '' };
  }
  if (viewParam === 'devices') {
    return { destination: 'devices', roomCode: '', inviteCode: '' };
  }
  if (viewParam === 'screens' || viewParam === 'multi-view') {
    return { destination: 'multi-view', roomCode: '', inviteCode: '' };
  }
  if (viewParam === 'cast') {
    return { destination: 'cast', roomCode: '', inviteCode: '' };
  }
  if (viewParam === 'settings') {
    return { destination: 'settings', roomCode: '', inviteCode: '' };
  }
  if (viewParam === 'activity') {
    return { destination: 'activity', roomCode: '', inviteCode: '' };
  }

  return { destination: 'control-room', roomCode: '', inviteCode: '' };
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

  const maxWidth =
    prefs.resolution === '720p'
      ? 1280
      : prefs.resolution === '1080p'
        ? 1920
        : prefs.resolution === '1440p'
          ? 2560
          : 3840;
  const maxHeight =
    prefs.resolution === '720p'
      ? 720
      : prefs.resolution === '1080p'
        ? 1080
        : prefs.resolution === '1440p'
          ? 1440
          : 2160;

  return {
    maxWidth,
    maxHeight,
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
    roomName: typeof payload.roomName === 'string' ? payload.roomName : undefined,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : undefined,
    privacyMode:
      payload.privacyMode === 'private' ||
      payload.privacyMode === 'approval_required' ||
      payload.privacyMode === 'open'
        ? payload.privacyMode
        : undefined,
    passwordProtected:
      typeof payload.passwordProtected === 'boolean' ? payload.passwordProtected : undefined,
    hostTransfer:
      payload.hostTransfer && typeof payload.hostTransfer === 'object'
        ? (payload.hostTransfer as PublicHostTransfer)
        : null,
    status: (payload.status as RoomSnapshot['status']) ?? 'active',
    hostDeviceId: String(payload.hostDeviceId ?? ''),
    hostDeviceName: String(payload.hostDeviceName ?? ''),
    hostPlatform: (payload.hostPlatform as RoomSnapshot['hostPlatform']) ?? 'macos',
    hostDeviceType: (payload.hostDeviceType as RoomSnapshot['hostDeviceType']) ?? 'Unknown',
    hostConnected: Boolean(payload.hostConnected),
    hostLastSeenAt:
      typeof payload.hostLastSeenAt === 'string' ? payload.hostLastSeenAt : undefined,
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
  const [multiViewLayout, setMultiViewLayout] = useState<MultiViewLayout>('auto');

  const [preferences, setPreferences] = useState<CapturePreferences>({
    resolution: '1080p',
    targetFps: 60,
    codecPreference: 'H264',
    includeAudio: false,
    maxBitrateKbps: 10_000,
    adaptiveBitrate: true,
  });
  const [qualityNotice, setQualityNotice] = useState<string | null>(null);

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
  const [lastSignalingActivityAt, setLastSignalingActivityAt] = useState<string | null>(null);
  const [focusedStreamDeviceId, setFocusedStreamDeviceId] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<RoomSnapshot | null>(null);
  const [activeRoomRole, setActiveRoomRole] = useState<'host' | 'receiver' | null>(null);
  const [hostInviteCode, setHostInviteCode] = useState<string | null>(null);
  const [inviteValidationMessage, setInviteValidationMessage] = useState<string | null>(null);
  const [transferActionBusy, setTransferActionBusy] = useState<boolean>(false);
  const [pairingStatus, setPairingStatus] = useState<PairingLifecycleStatus>('Available');
  const [pairingDetail, setPairingDetail] = useState<string | null>(null);

  const roomTokenRef = useRef<string | null>(null);
  const activeRoomIdRef = useRef<string | null>(null);
  const activeRoomRoleRef = useRef<'host' | 'receiver' | null>(null);
  const networkPrefsRef = useRef<NetworkPreferences>(networkPrefs);
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

  const refreshIceServerConfig = useCallback(
    async (
      explicitRoomId?: string | null,
      explicitToken?: string | null
    ): Promise<NetworkPreferences | null> => {
      try {
        const roomIdToUse =
          explicitRoomId !== undefined ? explicitRoomId : activeRoomIdRef.current;
        const tokenToUse =
          explicitToken !== undefined ? explicitToken : roomTokenRef.current;
        const res = await fetchBackendIceServers({
          roomId: roomIdToUse,
          deviceId,
          token: tokenToUse,
        });
        const nextPrefs: NetworkPreferences = {
          ...networkPrefsRef.current,
          serverIceServers: res.iceServers,
          turnConfigured: res.turnConfigured,
          turnMode: res.turnMode,
          turnTransports: res.transports,
          turnExpiresAt: res.expiresAt,
        };
        networkPrefsRef.current = nextPrefs;
        setNetworkPrefs(nextPrefs);
        return nextPrefs;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to refresh ICE configuration';
        logEvent('signaling', 'ICE configuration lookup deferred', msg);
        return null;
      }
    },
    [deviceId, logEvent]
  );

  if (!bridgeRef.current) {
    bridgeRef.current = new WebRtcSignalingBridge({
      deviceId,
      preferences,
      networkPrefs,
      getSignalingClient: () => signalingClientRef.current,
      onRefreshIceServers: () => refreshIceServerConfig(),
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
    networkPrefsRef.current = networkPrefs;
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
        setHostInviteCode(null);
        setActiveRoom(null);
        setActiveRoomRole(null);
        setPairingStatus('Expired');
        setPairingDetail(`Room ${snapshot.roomId} expired.`);
        setNetworkPrefs((prev) => ({
          ...prev,
          serverIceServers: undefined,
          turnExpiresAt: null,
        }));
        return;
      }

      if (snapshot.status === 'closed') {
        roomTokenRef.current = null;
        activeRoomIdRef.current = null;
        activeRoomRoleRef.current = null;
        setHostInviteCode(null);
        setActiveRoom(null);
        setActiveRoomRole(null);
        setPairingStatus('Disconnected');
        setPairingDetail(`Room ${snapshot.roomId} was closed by the host.`);
        setNetworkPrefs((prev) => ({
          ...prev,
          serverIceServers: undefined,
          turnExpiresAt: null,
        }));
        return;
      }

      setActiveRoom(snapshot);

      const previousRole = activeRoomRoleRef.current;
      const computedRole: 'host' | 'receiver' =
        snapshot.hostDeviceId === deviceId ? 'host' : 'receiver';

      if (computedRole !== previousRole) {
        activeRoomRoleRef.current = computedRole;
        setActiveRoomRole(computedRole);
        if (computedRole === 'host') {
          logEvent(
            'signaling',
            'Host ownership transferred to this device',
            `You are now the host of room ${snapshot.roomId}. Active streams remain live.`
          );
          if (roomTokenRef.current) {
            void fetchBackendRoomInvitation({
              roomId: snapshot.roomId,
              hostToken: roomTokenRef.current,
            })
              .then((inv) => setHostInviteCode(inv.inviteCode))
              .catch(() => {
                // Non-fatal; user can sync manually if needed
              });
          }
        } else {
          setHostInviteCode(null);
          logEvent(
            'signaling',
            'Host ownership transferred',
            `${snapshot.hostDeviceName} is now the host of room ${snapshot.roomId}.`
          );
        }
      }

      if (computedRole === 'host') {
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

      const isPaired = snapshot.pairedReceivers.some((r) => r.deviceId === deviceId);
      const isPending = snapshot.pendingRequests.some((r) => r.deviceId === deviceId);

      if (isPaired) {
        if (!snapshot.hostConnected) {
          setPairingStatus('Disconnected');
          setPairingDetail('Host disconnected temporarily. Waiting for host reconnect or room expiry.');
        } else {
          setPairingStatus('Paired');
          setPairingDetail(`Paired with ${snapshot.hostDeviceName} in room ${snapshot.roomId}.`);
          if (!networkPrefsRef.current.turnExpiresAt) {
            void refreshIceServerConfig(snapshot.roomId, roomTokenRef.current);
          }
        }
      } else if (isPending) {
        setPairingStatus('Awaiting approval');
        setPairingDetail(`Request pending approval from ${snapshot.hostDeviceName}.`);
      } else {
        roomTokenRef.current = null;
        activeRoomIdRef.current = null;
        activeRoomRoleRef.current = null;
        setHostInviteCode(null);
        setActiveRoom(null);
        setActiveRoomRole(null);
        setPairingStatus('Disconnected');
        setPairingDetail('Removed from room.');
        setNetworkPrefs((prev) => ({
          ...prev,
          serverIceServers: undefined,
          turnExpiresAt: null,
        }));
      }
    },
    [deviceId, logEvent, refreshIceServerConfig]
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
        deviceType: capabilities.detectedDeviceType,
        capabilities: toProtocolCapabilities(capabilities, preferences),
        roomId,
        token,
        handlers: {
          onStateChange: (nextState, detail) => {
            setSignalingState(nextState);
            if (nextState === 'connected') {
              setLastSignalingActivityAt(new Date().toISOString());
              logEvent('signaling', 'Connected to /castora', detail ?? 'Device registered on server.');
              void refreshHealth();
              if (activeRoomIdRef.current && roomTokenRef.current) {
                void refreshIceServerConfig(activeRoomIdRef.current, roomTokenRef.current);
              }
            } else if (nextState === 'error') {
              logEvent('error', 'Signaling socket error', detail ?? 'Unable to connect to /castora.');
            } else if (nextState === 'disconnected') {
              logEvent('signaling', 'Signaling socket disconnected', detail ?? 'Socket closed.');
              if (activeRoomIdRef.current) {
                setPairingDetail('Signaling connection lost. Reconnecting automatically...');
              }
            }
          },
          onReconnectScheduled: (attempt, maxAttempts, delayMs) => {
            setSignalingState('connecting');
            setPairingDetail(
              `Signaling interrupted. Reconnecting (${attempt}/${maxAttempts}) in ${Math.round(
                delayMs / 100
              ) / 10}s...`
            );
            logEvent(
              'signaling',
              'Scheduled signaling reconnect',
              `Attempt ${attempt}/${maxAttempts} in ${delayMs} ms`
            );
          },
          onEnvelope: (envelope) => {
            setLastSignalingActivityAt(new Date().toISOString());
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
                if (envelope.roomId && roomTokenRef.current) {
                  void refreshIceServerConfig(envelope.roomId, roomTokenRef.current);
                }
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
              const payload = envelope.payload as { code?: string; message?: string; recoverable?: boolean };
              logEvent(
                'error',
                `Server error (${payload.code ?? 'UNKNOWN'})`,
                payload.message ?? 'Signaling error received'
              );
              if (
                payload.recoverable === false &&
                activeRoomIdRef.current &&
                envelope.roomId === activeRoomIdRef.current &&
                (payload.code === 'INVALID_ROOM_ID' || payload.code === 'APPROVAL_DECLINED')
              ) {
                roomTokenRef.current = null;
                activeRoomIdRef.current = null;
                activeRoomRoleRef.current = null;
                setHostInviteCode(null);
                setActiveRoom(null);
                setActiveRoomRole(null);
                setPairingStatus('Expired');
                setPairingDetail(payload.message ?? 'Session expired or no longer valid.');
                return;
              }
              if (
                payload.code === 'WEBRTC_NEGOTIATION_FAILED' &&
                typeof payload.message === 'string' &&
                payload.message.toLowerCase().includes('reconnect')
              ) {
                void bridgeRef.current?.retryAllFailedConnections();
                void refreshHealth();
              }
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
                setHostInviteCode(null);
                setActiveRoom(null);
                setActiveRoomRole(null);
                setPairingStatus('Expired');
                setPairingDetail('Room expired on server.');
              } else if (reason === 'Room closed by host' || reason === 'Removed by host') {
                roomTokenRef.current = null;
                activeRoomIdRef.current = null;
                activeRoomRoleRef.current = null;
                setHostInviteCode(null);
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
      refreshIceServerConfig,
      syncReceiverLifecycleFromSnapshot,
    ]
  );

  useEffect(() => {
    void refreshHealth();
    void refreshIceServerConfig(null, null);
    connectSignaling(null, null);

    if (initialRoute.roomCode.length === 6) {
      void validateBackendInvitation({
        roomId: initialRoute.roomCode,
        inviteCode: initialRoute.inviteCode || undefined,
      })
        .then((res) => {
          const roomLabel = res.room.roomName || `Room ${res.room.roomId}`;
          const pwdNote = res.room.passwordProtected ? ' · Password required' : '';
          setInviteValidationMessage(
            `${roomLabel} (${res.availableSlots} of ${res.room.maxReceivers} slots open${pwdNote})`
          );
        })
        .catch((err) => {
          setInviteValidationMessage(
            err instanceof Error ? err.message : 'Invitation link could not be verified'
          );
        });
    }

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
    void refreshIceServerConfig(activeRoomIdRef.current, roomTokenRef.current);
    connectSignaling(activeRoomIdRef.current, roomTokenRef.current);
  }, [connectSignaling, refreshHealth, refreshIceServerConfig]);

  const handleCreateRoom = useCallback(
    async (options?: {
      roomName?: string;
      privacyMode?: RoomPrivacyMode;
      password?: string;
    }) => {
      const created = await createBackendRoom({
        hostDeviceId: deviceId,
        hostDeviceName: deviceName,
        hostPlatform: capabilities.detectedPlatform,
        hostDeviceType: capabilities.detectedDeviceType,
        ...(options?.roomName ? { roomName: options.roomName } : {}),
        ...(options?.privacyMode ? { privacyMode: options.privacyMode } : {}),
        ...(options?.password ? { password: options.password } : {}),
      });
      roomTokenRef.current = created.hostToken;
      activeRoomIdRef.current = created.room.roomId;
      activeRoomRoleRef.current = 'host';
      setHostInviteCode(created.inviteCode);
      setActiveRoom(created.room);
      setActiveRoomRole('host');
      setPairingStatus('Available');
      setPairingDetail(`Room ${created.room.roomId} active. Waiting for receiver pairing requests.`);
      connectSignaling(created.room.roomId, created.hostToken);
      logEvent(
        'signaling',
        `Created room ${created.room.roomId}`,
        `Privacy=${created.room.privacyMode ?? 'approval_required'} · Expires at ${new Date(created.room.expiresAt).toLocaleTimeString()}.`
      );
      void refreshHealth();
      void refreshIceServerConfig(created.room.roomId, created.hostToken);
      return created.room;
    },
    [
      capabilities.detectedDeviceType,
      capabilities.detectedPlatform,
      connectSignaling,
      deviceId,
      deviceName,
      logEvent,
      refreshHealth,
      refreshIceServerConfig,
    ]
  );

  const handleSubmitPairRequest = useCallback(
    async (
      roomId: string,
      options?: { inviteCode?: string; password?: string }
    ) => {
      setPairingStatus('Request pending');
      setPairingDetail(`Submitting pairing request for room ${roomId}...`);
      try {
        const effectiveInvite =
          options?.inviteCode ?? (initialRoute.roomCode === roomId ? initialRoute.inviteCode : '');
        const submitted = await submitBackendPairRequest({
          roomId,
          receiverDeviceId: deviceId,
          deviceName,
          platform: capabilities.detectedPlatform,
          deviceType: capabilities.detectedDeviceType,
          pairingMethod: effectiveInvite ? 'qr' : 'room_code',
          ...(effectiveInvite ? { inviteCode: effectiveInvite } : {}),
          ...(options?.password ? { password: options.password } : {}),
        });
        roomTokenRef.current = submitted.memberToken;
        activeRoomIdRef.current = submitted.room.roomId;
        activeRoomRoleRef.current = 'receiver';
        setHostInviteCode(null);
        setActiveRoom(submitted.room);
        setActiveRoomRole('receiver');
        setInviteValidationMessage(null);
        if (submitted.requestStatus === 'paired') {
          setPairingStatus('Paired');
          setPairingDetail(`Joined ${submitted.room.roomName ?? submitted.room.roomId} via Open access.`);
          void refreshIceServerConfig(submitted.room.roomId, submitted.memberToken);
        } else {
          setPairingStatus('Awaiting approval');
          setPairingDetail(`Waiting for ${submitted.room.hostDeviceName} to approve pairing.`);
        }
        connectSignaling(submitted.room.roomId, submitted.memberToken);
        logEvent(
          'signaling',
          submitted.requestStatus === 'paired'
            ? `Joined open room ${submitted.room.roomId}`
            : `Pairing request submitted (${submitted.room.roomId})`,
          submitted.requestStatus === 'paired'
            ? `Assigned slot ${(submitted.assignedSlotIndex ?? 0) + 1}.`
            : `Awaiting host approval from ${submitted.room.hostDeviceName}.`
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
    [
      capabilities.detectedDeviceType,
      capabilities.detectedPlatform,
      connectSignaling,
      deviceId,
      deviceName,
      initialRoute.inviteCode,
      initialRoute.roomCode,
      logEvent,
      refreshHealth,
      refreshIceServerConfig,
    ]
  );

  const handleRenameRoom = useCallback(
    async (roomName: string) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Authorized host session required');
      }
      const updated = await renameBackendRoom({
        roomId: activeRoom.roomId,
        roomName,
        hostToken: roomTokenRef.current,
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent('signaling', 'Room renamed', `Room ${updated.roomId} renamed to "${updated.roomName ?? ''}".`);
      return updated;
    },
    [activeRoom, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleUpdatePrivacyMode = useCallback(
    async (privacyMode: RoomPrivacyMode) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Authorized host session required');
      }
      const updated = await updateBackendRoomSettings({
        roomId: activeRoom.roomId,
        hostToken: roomTokenRef.current,
        privacyMode,
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent('signaling', 'Room privacy updated', `Room ${updated.roomId} mode set to ${privacyMode}.`);
      return updated;
    },
    [activeRoom, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleUpdateRoomPassword = useCallback(
    async (password: string | null) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Authorized host session required');
      }
      const updated = await updateBackendRoomSettings({
        roomId: activeRoom.roomId,
        hostToken: roomTokenRef.current,
        password,
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent(
        'signaling',
        password === null ? 'Room password removed' : 'Room password configured',
        `Updated password protection on room ${updated.roomId}.`
      );
      return updated;
    },
    [activeRoom, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleRotateInvitation = useCallback(async () => {
    if (!activeRoom || !roomTokenRef.current) {
      throw new Error('Authorized host session required');
    }
    const rotated = await rotateBackendRoomInvitation({
      roomId: activeRoom.roomId,
      hostToken: roomTokenRef.current,
    });
    setHostInviteCode(rotated.inviteCode);
    syncReceiverLifecycleFromSnapshot(rotated.room);
    logEvent('signaling', 'Invitation link rotated', `Revoked previous invite links for ${rotated.room.roomId}.`);
    return rotated.inviteCode;
  }, [activeRoom, logEvent, syncReceiverLifecycleFromSnapshot]);

  const handleInitiateHostTransfer = useCallback(
    async (targetDeviceId: string) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Authorized host session required');
      }
      const updated = await initiateBackendHostTransfer({
        roomId: activeRoom.roomId,
        targetDeviceId,
        hostToken: roomTokenRef.current,
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent(
        'signaling',
        'Host transfer initiated',
        `Requested ownership transfer to ${updated.hostTransfer?.targetDeviceName ?? targetDeviceId}.`
      );
      return updated;
    },
    [activeRoom, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleCancelHostTransfer = useCallback(async () => {
    if (!activeRoom || !roomTokenRef.current) {
      throw new Error('Authorized host session required');
    }
    const updated = await cancelBackendHostTransfer({
      roomId: activeRoom.roomId,
      hostToken: roomTokenRef.current,
    });
    syncReceiverLifecycleFromSnapshot(updated);
    logEvent('signaling', 'Host transfer cancelled', `Cancelled pending transfer in room ${updated.roomId}.`);
    return updated;
  }, [activeRoom, logEvent, syncReceiverLifecycleFromSnapshot]);

  const handleRespondHostTransfer = useCallback(
    async (accept: boolean) => {
      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Active participant session token required');
      }
      setTransferActionBusy(true);
      try {
        const res = await respondBackendHostTransfer({
          roomId: activeRoom.roomId,
          accept,
          token: roomTokenRef.current,
        });
        syncReceiverLifecycleFromSnapshot(res.room);
        logEvent(
          'signaling',
          accept ? 'Accepted host transfer' : 'Declined host transfer',
          accept
            ? `Ownership of room ${res.room.roomId} transferred cleanly.`
            : `Declined host ownership for room ${res.room.roomId}.`
        );
      } finally {
        setTransferActionBusy(false);
      }
    },
    [activeRoom, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleRestoreSession = useCallback(async () => {
    if (!activeRoomIdRef.current || !roomTokenRef.current) {
      throw new Error('No active authenticated room session to verify');
    }
    const restored = await restoreBackendSession({
      roomId: activeRoomIdRef.current,
      token: roomTokenRef.current,
    });
    if (restored.role === 'host' && restored.inviteCode) {
      setHostInviteCode(restored.inviteCode);
    }
    syncReceiverLifecycleFromSnapshot(restored.room);
    connectSignaling(restored.room.roomId, roomTokenRef.current);
  }, [connectSignaling, syncReceiverLifecycleFromSnapshot]);

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
    setHostInviteCode(null);
    setActiveRoom(null);
    setActiveRoomRole(null);
    setPairingStatus('Available');
    setPairingDetail(`Left room ${roomId}.`);
    setNetworkPrefs((prev) => ({
      ...prev,
      serverIceServers: undefined,
      turnExpiresAt: null,
    }));
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
    setHostInviteCode(null);
    setActiveRoom(null);
    setActiveRoomRole(null);
    setPairingStatus('Available');
    setPairingDetail(`Room ${roomId} closed.`);
    setNetworkPrefs((prev) => ({
      ...prev,
      serverIceServers: undefined,
      turnExpiresAt: null,
    }));
    connectSignaling(null, null);
    logEvent('signaling', `Closed room ${roomId}`, 'Room removed from server.');
    void refreshHealth();
  }, [activeRoom, connectSignaling, logEvent, refreshHealth]);

  const handleRenameDevice = useCallback(
    async (targetDeviceId: string, newName: string) => {
      const validationError = validateDeviceDisplayName(newName);
      if (validationError) {
        throw new Error(validationError);
      }
      const normalized = newName.replace(/\s+/g, ' ').trim();

      if (activeRoom && roomTokenRef.current) {
        const updated = await renameBackendRoomDevice({
          roomId: activeRoom.roomId,
          targetDeviceId,
          deviceName: normalized,
          token: roomTokenRef.current,
        });
        syncReceiverLifecycleFromSnapshot(updated);
      }

      if (targetDeviceId === deviceId) {
        const saved = saveDeviceName(normalized);
        if (saved) {
          setDeviceName(saved);
        }
      }

      logEvent(
        'ui',
        'Device display name updated',
        `Renamed ${targetDeviceId} to "${normalized}".`
      );
    },
    [activeRoom, deviceId, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleSaveDeviceName = (nextName: string) => {
    const validationError = validateDeviceDisplayName(nextName);
    if (validationError) {
      logEvent('error', 'Invalid device name', validationError);
      return;
    }
    if (activeRoom && roomTokenRef.current) {
      void handleRenameDevice(deviceId, nextName).catch((err) => {
        logEvent(
          'error',
          'Room device rename rejected',
          err instanceof Error ? err.message : 'Unable to sync display name with room'
        );
      });
      return;
    }
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
    setQualityNotice(null);
    await bridgeRef.current.startScreenSharing(targetSelection);
  }, []);

  const handleUpdatePreferences = useCallback(async (nextPrefs: CapturePreferences) => {
    setQualityNotice(null);
    if (!bridgeRef.current) {
      setPreferences(nextPrefs);
      return;
    }
    const result = await bridgeRef.current.applyCapturePreferencesUpdate(nextPrefs);
    setPreferences(result.appliedPreferences);
    if (result.notice) {
      setQualityNotice(result.notice);
    }
  }, []);

  const handleSetPeerQualityOverride = useCallback(
    async (peerDeviceId: string, override: Partial<CapturePreferences> | null) => {
      if (!bridgeRef.current) return;
      await bridgeRef.current.setPeerQualityOverride(peerDeviceId, override);
    },
    []
  );

  const handleConnectReceiver = useCallback(async (targetReceiverId: string) => {
    if (!bridgeRef.current) return;
    await bridgeRef.current.connectStreamToReceiver(targetReceiverId);
  }, []);

  const handleIncomingVideoDimensions = useCallback(
    (senderDeviceId: string, width: number | null, height: number | null) => {
      bridgeRef.current?.updateIncomingRenderedDimensions(senderDeviceId, width, height);
    },
    []
  );

  const handleRetryPeer = useCallback((peerDeviceId: string) => {
    if (!bridgeRef.current) return;
    void bridgeRef.current.retryPeerConnection(peerDeviceId);
  }, []);

  const handleRetryAllFailed = useCallback(() => {
    if (!bridgeRef.current) return;
    void bridgeRef.current.retryAllFailedConnections();
  }, []);

  const handleToggleMutePeer = useCallback((peerDeviceId: string) => {
    setMutedSlots((prev) => ({
      ...prev,
      [peerDeviceId]: !(prev[peerDeviceId] ?? true),
    }));
  }, []);

  const handleToggleAdaptiveLock = useCallback(
    async (targetDeviceId: string, isSelf: boolean, nextLocked: boolean) => {
      if (isSelf) {
        await handleUpdatePreferences({
          ...preferences,
          adaptiveBitrate: !nextLocked,
        });
        return;
      }
      await handleSetPeerQualityOverride(targetDeviceId, {
        adaptiveBitrate: !nextLocked,
      });
    },
    [handleSetPeerQualityOverride, handleUpdatePreferences, preferences]
  );

  const handleRefreshDevices = useCallback(async () => {
    await refreshHealth();
    if (activeRoomIdRef.current) {
      try {
        const snapshot = await fetchBackendRoom(activeRoomIdRef.current);
        syncReceiverLifecycleFromSnapshot(snapshot);
      } catch {
        // Room snapshot refresh failed cleanly; health state updated above
      }
    }
  }, [refreshHealth, syncReceiverLifecycleFromSnapshot]);

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

  const handleStopDeviceStream = useCallback(
    async (
      targetDeviceId: string,
      mode: 'outbound-to-peer' | 'participant-room-stream'
    ) => {
      if (mode === 'outbound-to-peer') {
        await bridgeRef.current?.stopOutgoingStreamToPeer(targetDeviceId);
        logEvent(
          'webrtc',
          'Stopped individual outgoing stream',
          `Terminated outbound stream to ${targetDeviceId} without interrupting other peers.`
        );
        return;
      }

      if (targetDeviceId === deviceId) {
        handleStopSharing();
        return;
      }

      if (!activeRoom || !roomTokenRef.current) {
        throw new Error('Active room session required to stop participant stream.');
      }
      const updated = await stopBackendDeviceStream({
        roomId: activeRoom.roomId,
        targetDeviceId,
        token: roomTokenRef.current,
      });
      syncReceiverLifecycleFromSnapshot(updated);
      logEvent(
        'webrtc',
        'Stopped participant stream',
        `Host stopped active room stream for ${targetDeviceId}.`
      );
    },
    [activeRoom, deviceId, handleStopSharing, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleReconnectDevice = useCallback(
    async (targetDeviceId: string) => {
      const localRetried = await bridgeRef.current?.retryPeerConnection(targetDeviceId);
      if (
        activeRoom &&
        roomTokenRef.current &&
        (activeRoomRole === 'host' || targetDeviceId === deviceId)
      ) {
        const updated = await requestBackendDeviceReconnect({
          roomId: activeRoom.roomId,
          targetDeviceId,
          token: roomTokenRef.current,
        });
        syncReceiverLifecycleFromSnapshot(updated);
      } else if (!localRetried) {
        throw new Error('Peer connection is already healthy or unavailable for local retry.');
      }
      logEvent('webrtc', 'Requested device reconnection', `Target device: ${targetDeviceId}`);
    },
    [activeRoom, activeRoomRole, deviceId, logEvent, syncReceiverLifecycleFromSnapshot]
  );

  const handleViewDeviceStream = useCallback(
    (senderDeviceId: string) => {
      setFocusedStreamDeviceId(senderDeviceId);
      setDestination('multi-view');
      logEvent('ui', 'Focused participant stream', `Viewing stream from ${senderDeviceId}.`);
    },
    [logEvent]
  );

  const receivers: ConnectedReceiverSlot[] = (() => {
    if (!activeRoom) return [];
    const list: ConnectedReceiverSlot[] = [];
    if (activeRoom.hostDeviceId !== deviceId) {
      const incomingFromHost = webrtcState.incomingStreams.find(
        (s) => s.senderDeviceId === activeRoom.hostDeviceId
      );
      const outboundToHost = webrtcState.outboundPeers.find(
        (o) => o.targetDeviceId === activeRoom.hostDeviceId
      );
      list.push({
        slotIndex: 0,
        receiverDeviceId: activeRoom.hostDeviceId,
        deviceName: `${activeRoom.hostDeviceName} (Host)`,
        platform: activeRoom.hostPlatform,
        connectionState:
          incomingFromHost?.phase ??
          outboundToHost?.phase ??
          (activeRoom.hostConnected ? 'idle' : 'disconnected'),
        iceConnectionState:
          incomingFromHost?.iceConnectionState ?? outboundToHost?.iceConnectionState ?? null,
        errorMessage: incomingFromHost?.errorMessage ?? outboundToHost?.errorMessage ?? null,
        recovery: incomingFromHost?.recovery ?? outboundToHost?.recovery ?? null,
        stream: incomingFromHost?.stream ?? null,
        hasAudioTrack: Boolean(incomingFromHost?.stream?.getAudioTracks().length),
        muted: mutedSlots[activeRoom.hostDeviceId] ?? true,
        telemetry:
          incomingFromHost?.telemetry ??
          outboundToHost?.telemetry ??
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
        iceConnectionState: incoming?.iceConnectionState ?? outbound?.iceConnectionState ?? null,
        errorMessage: incoming?.errorMessage ?? outbound?.errorMessage ?? null,
        recovery: incoming?.recovery ?? outbound?.recovery ?? null,
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
    iceConnectionState: entry.iceConnectionState,
    errorMessage: entry.errorMessage,
    recovery: entry.recovery ?? null,
    stream: entry.stream,
    hasAudioTrack: Boolean(entry.stream?.getAudioTracks().length),
    muted: mutedSlots[entry.senderDeviceId] ?? true,
    telemetry: entry.telemetry,
  }));

  const sessionDeviceName = (() => {
    if (!activeRoom) return deviceName;
    if (activeRoom.hostDeviceId === deviceId) return activeRoom.hostDeviceName;
    const pairedSelf = activeRoom.pairedReceivers.find((r) => r.deviceId === deviceId);
    if (pairedSelf) return pairedSelf.deviceName;
    const pendingSelf = activeRoom.pendingRequests.find((r) => r.deviceId === deviceId);
    if (pendingSelf) return pendingSelf.deviceName;
    return deviceName;
  })();

  const isApprovedInRoom =
    Boolean(activeRoom) &&
    (activeRoomRole === 'host' ||
      Boolean(activeRoom?.pairedReceivers.some((r) => r.deviceId === deviceId)));
  const canQuickShare =
    capabilities.isSecureContext &&
    capabilities.supportsDisplayMedia &&
    (!activeRoom || isApprovedInRoom);

  const handleTopBarPrimaryAction = () => {
    if (webrtcState.isSharingLocal) {
      handleStopSharing();
      return;
    }
    if (canQuickShare) {
      setDestination('multi-view');
      void handleStartSharing(null).catch(() => {
        // Picker cancellation or capture error is surfaced via bridge state / activity log
      });
      return;
    }
    setDestination('multi-view');
  };

  return (
    <div className="min-h-screen bg-[#F5F7FB] text-[#172033] flex flex-col">
      <TopControlBar
        activeDestination={destination}
        onSelectDestination={setDestination}
        signalingState={signalingState}
        isSharingLocal={webrtcState.isSharingLocal}
        canQuickShare={canQuickShare}
        onPrimaryAction={handleTopBarPrimaryAction}
      />

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 pb-24 sm:px-6 md:pb-8">
        {activeRoom?.hostTransfer && activeRoom.hostTransfer.targetDeviceId === deviceId && (
          <div
            data-castora-chrome
            role="status"
            className="mb-6 flex flex-col gap-3 rounded-xl border border-[#2563EB]/40 bg-[#EFF6FF] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-sm font-semibold text-[#172033]">
                {activeRoom.hostDeviceName} invited you to become the host of{' '}
                {activeRoom.roomName || `Room ${activeRoom.roomId}`}
              </p>
              <p className="text-xs text-[#64748B]">
                Accepting transfers room ownership and host controls immediately while keeping active WebRTC streams live.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={transferActionBusy}
                onClick={() => {
                  void handleRespondHostTransfer(true);
                }}
                className="inline-flex h-9 items-center rounded-lg bg-[#2563EB] px-4 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
              >
                {transferActionBusy ? 'Updating...' : 'Accept Host Role'}
              </button>
              <button
                type="button"
                disabled={transferActionBusy}
                onClick={() => {
                  void handleRespondHostTransfer(false);
                }}
                className="inline-flex h-9 items-center rounded-lg border border-[#E2E8F0] bg-white px-3.5 text-xs font-medium text-[#172033] hover:bg-[#F8FAFC] disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          </div>
        )}

        {destination === 'control-room' && (
          <ControlRoomView
            deviceId={deviceId}
            deviceName={sessionDeviceName}
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
            onCreateRoom={() => handleCreateRoom()}
            onSubmitPairRequest={(code) => handleSubmitPairRequest(code)}
            onStartSharing={handleStartSharing}
            onStopSharing={handleStopSharing}
            onReconnectBackend={handleReconnectBackend}
            onRetryPeer={handleRetryPeer}
            onRetryAllFailed={handleRetryAllFailed}
            mutedByPeerId={mutedSlots}
            onToggleMutePeer={handleToggleMutePeer}
            onNavigate={setDestination}
            onIncomingVideoDimensions={handleIncomingVideoDimensions}
          />
        )}

        {destination === 'receivers' && (
          <ReceiversView
            deviceId={deviceId}
            deviceName={sessionDeviceName}
            capabilities={capabilities}
            preferences={preferences}
            initialRoomCode={initialRoute.roomCode}
            initialInviteCode={initialRoute.inviteCode}
            hostInviteCode={hostInviteCode}
            inviteValidationMessage={inviteValidationMessage}
            activePhase={webrtcState.phase}
            signalingState={signalingState}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            pairingStatus={pairingStatus}
            pairingDetail={pairingDetail}
            webrtcState={webrtcState}
            mutedByPeerId={mutedSlots}
            onCreateRoom={handleCreateRoom}
            onSubmitPairRequest={handleSubmitPairRequest}
            onApproveReceiver={handleApproveReceiver}
            onRejectReceiver={handleRejectReceiver}
            onRemoveReceiver={handleRemoveReceiver}
            onRenameDevice={handleRenameDevice}
            onStopDeviceStream={handleStopDeviceStream}
            onReconnectDevice={handleReconnectDevice}
            onToggleMutePeer={handleToggleMutePeer}
            onToggleAdaptiveLock={handleToggleAdaptiveLock}
            onRefreshDevices={handleRefreshDevices}
            onLeaveRoom={handleLeaveRoom}
            onCloseRoom={handleCloseRoom}
            onStartSharing={handleStartSharing}
            onStopSharing={handleStopSharing}
            onReconnectBackend={handleReconnectBackend}
            onRetryPeer={handleRetryPeer}
            onViewStream={handleViewDeviceStream}
            lastSignalingActivityAt={lastSignalingActivityAt}
            onNavigate={setDestination}
            onLogEvent={logEvent}
          />
        )}

        {destination === 'sessions' && (
          <SessionView
            deviceId={deviceId}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            inviteCode={hostInviteCode}
            signalingState={signalingState}
            backendHealth={backendHealth}
            webrtcState={webrtcState}
            onCreateRoom={handleCreateRoom}
            onRenameRoom={handleRenameRoom}
            onUpdatePrivacyMode={handleUpdatePrivacyMode}
            onUpdateRoomPassword={handleUpdateRoomPassword}
            onRotateInvitation={handleRotateInvitation}
            onInitiateHostTransfer={handleInitiateHostTransfer}
            onCancelHostTransfer={handleCancelHostTransfer}
            onRespondHostTransfer={handleRespondHostTransfer}
            onRestoreSession={handleRestoreSession}
            onCloseRoom={handleCloseRoom}
            onLeaveRoom={handleLeaveRoom}
            onNavigate={setDestination}
          />
        )}

        {destination === 'devices' && (
          <DevicesView
            deviceId={deviceId}
            deviceName={sessionDeviceName}
            capabilities={capabilities}
            preferences={preferences}
            signalingState={signalingState}
            backendError={backendError}
            lastSignalingActivityAt={lastSignalingActivityAt}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            webrtcState={webrtcState}
            mutedByPeerId={mutedSlots}
            onRenameDevice={handleRenameDevice}
            onApproveReceiver={handleApproveReceiver}
            onRejectReceiver={handleRejectReceiver}
            onRemoveReceiver={handleRemoveReceiver}
            onStopDeviceStream={handleStopDeviceStream}
            onReconnectDevice={handleReconnectDevice}
            onToggleMutePeer={handleToggleMutePeer}
            onToggleAdaptiveLock={handleToggleAdaptiveLock}
            onViewStream={handleViewDeviceStream}
            onRefresh={handleRefreshDevices}
            onReconnectBackend={handleReconnectBackend}
            onNavigate={setDestination}
          />
        )}

        {(destination === 'multi-view' || destination === 'cast') && (
          <MultiViewView
            layout={multiViewLayout}
            onChangeLayout={setMultiViewLayout}
            slots={multiViewSlots}
            capabilities={capabilities}
            deviceId={deviceId}
            deviceName={sessionDeviceName}
            preferences={preferences}
            onUpdatePreferences={(next) => {
              void handleUpdatePreferences(next);
            }}
            onSetPeerQualityOverride={(peerId, override) => {
              void handleSetPeerQualityOverride(peerId, override);
            }}
            qualityNotice={qualityNotice}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            pairingStatus={pairingStatus}
            webrtcState={webrtcState}
            onStartSharing={handleStartSharing}
            onConnectReceiver={handleConnectReceiver}
            onStopSharing={handleStopSharing}
            onRetryPeer={handleRetryPeer}
            onRetryAllFailed={handleRetryAllFailed}
            onNavigate={setDestination}
            defaultShowSharePanel={destination === 'cast'}
            focusedDeviceId={focusedStreamDeviceId}
            onClearFocusedDevice={() => setFocusedStreamDeviceId(null)}
            onToggleMute={(slotIndex) => {
              const targetId = multiViewSlots[slotIndex]?.receiverDeviceId ?? String(slotIndex);
              setMutedSlots((prev) => ({ ...prev, [targetId]: !(prev[targetId] ?? true) }));
            }}
            onDisconnectSlot={
              activeRoomRole === 'host'
                ? (peerId) => {
                    void handleRemoveReceiver(peerId);
                  }
                : undefined
            }
            onIncomingVideoDimensions={handleIncomingVideoDimensions}
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
            onUpdatePreferences={(next) => {
              void handleUpdatePreferences(next);
            }}
            networkPrefs={networkPrefs}
            onUpdateNetworkPrefs={setNetworkPrefs}
            backendHealth={backendHealth}
            onRefreshIceConfig={() => {
              void refreshIceServerConfig(activeRoomIdRef.current, roomTokenRef.current);
            }}
            capabilities={capabilities}
            onReprobeCapabilities={handleReprobeCapabilities}
            activityEvents={activityEvents}
            onClearActivityEvents={() => setActivityEvents([])}
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
