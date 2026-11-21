import { useCallback, useEffect, useRef, useState } from 'react';
import { MobileReceiverBar } from './components/layout/MobileReceiverBar';
import { TopControlBar } from './components/layout/TopControlBar';
import {
  CastoraSignalingClient,
  closeBackendRoom,
  createBackendRoom,
  fetchBackendHealth,
  joinBackendRoom,
  type BackendHealthResponse,
  type RoomSnapshot,
  type SignalingSocketState,
} from './services/backendClient';
import {
  loadOrCreateDeviceId,
  loadSavedDeviceName,
  probeBrowserCapabilities,
  saveDeviceName,
} from './services/browserCapabilities';
import type { CastoraVideoCodec, DeviceCapabilities } from './types/protocol';
import type {
  ActivityEvent,
  BrowserCapabilityReport,
  CapturePreferences,
  ConnectedReceiverSlot,
  IncomingApprovalRequest,
  MultiViewLayout,
  NetworkPreferences,
  SessionSummaryRecord,
  StreamTelemetrySnapshot,
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
    stunUrls: '',
    turnUrl: '',
    turnUsername: '',
    turnCredential: '',
  });

  // Honest Stage 2 backend state: zero fake connected devices or streaming metrics
  const [backendHealth, setBackendHealth] = useState<BackendHealthResponse | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [signalingState, setSignalingState] = useState<SignalingSocketState>('disconnected');
  const [activeRoom, setActiveRoom] = useState<RoomSnapshot | null>(null);
  const [activeRoomRole, setActiveRoomRole] = useState<'host' | 'receiver' | null>(null);
  const roomTokenRef = useRef<string | null>(null);
  const signalingClientRef = useRef<CastoraSignalingClient | null>(null);

  const [receivers] = useState<ConnectedReceiverSlot[]>([]);
  const [incomingApprovals] = useState<IncomingApprovalRequest[]>([]);
  const [recentSessions] = useState<SessionSummaryRecord[]>([]);
  const [localStream] = useState<MediaStream | null>(null);

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
        title: 'Initializing Stage 2 backend connection',
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
            }
          },
          onEnvelope: (envelope) => {
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
              logEvent('signaling', 'Server disconnect notice', payload.reason ?? 'Disconnected');
              if (
                payload.reason === 'Room expired' ||
                payload.reason === 'Room closed by host'
              ) {
                roomTokenRef.current = null;
                setActiveRoom(null);
                setActiveRoomRole(null);
              }
              void refreshHealth();
            }
          },
        },
      });
    },
    [capabilities, deviceId, deviceName, logEvent, preferences, refreshHealth]
  );

  useEffect(() => {
    void refreshHealth();
    connectSignaling(null, null);
    const healthTimer = window.setInterval(() => {
      void refreshHealth();
    }, 15_000);

    return () => {
      window.clearInterval(healthTimer);
      signalingClientRef.current?.disconnect(true, deviceId, null);
    };
    // Initial boot connection on mount; explicit reconnects use handleReconnectBackend
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReconnectBackend = useCallback(() => {
    void refreshHealth();
    connectSignaling(activeRoom?.roomId ?? null, roomTokenRef.current);
  }, [activeRoom?.roomId, connectSignaling, refreshHealth]);

  const handleCreateRoom = useCallback(async () => {
    const created = await createBackendRoom({
      hostDeviceId: deviceId,
      hostDeviceName: deviceName,
      hostPlatform: capabilities.detectedPlatform,
    });
    roomTokenRef.current = created.hostToken;
    setActiveRoom(created.room);
    setActiveRoomRole('host');
    connectSignaling(created.room.roomId, created.hostToken);
    logEvent(
      'signaling',
      `Created room ${created.room.roomId}`,
      `Expires at ${new Date(created.room.expiresAt).toLocaleTimeString()}.`
    );
    void refreshHealth();
    return created.room;
  }, [capabilities.detectedPlatform, connectSignaling, deviceId, deviceName, logEvent, refreshHealth]);

  const handleJoinRoom = useCallback(
    async (roomId: string) => {
      const joined = await joinBackendRoom({
        roomId,
        receiverDeviceId: deviceId,
        deviceName,
        platform: capabilities.detectedPlatform,
      });
      roomTokenRef.current = joined.memberToken;
      setActiveRoom(joined.room);
      setActiveRoomRole('receiver');
      connectSignaling(joined.room.roomId, joined.memberToken);
      logEvent(
        'signaling',
        `Joined room ${joined.room.roomId}`,
        `Assigned slot ${joined.assignedSlotIndex + 1}; host: ${joined.room.hostDeviceName}.`
      );
      void refreshHealth();
      return joined.room;
    },
    [capabilities.detectedPlatform, connectSignaling, deviceId, deviceName, logEvent, refreshHealth]
  );

  const handleCloseRoom = useCallback(async () => {
    if (!activeRoom || !roomTokenRef.current) return;
    const roomId = activeRoom.roomId;
    await closeBackendRoom(roomId, roomTokenRef.current);
    roomTokenRef.current = null;
    setActiveRoom(null);
    setActiveRoomRole(null);
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

  const programTelemetry: StreamTelemetrySnapshot = {
    captureFps: null,
    encodedFps: null,
    decodedFps: null,
    targetFps: preferences.targetFps,
    resolution: null,
    bitrateKbps: null,
    rttMs: null,
    packetLossPct: null,
    jitterMs: null,
    droppedFrames: null,
    connectionState: 'idle',
  };

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
            localStream={localStream}
            programTelemetry={programTelemetry}
            recentSessions={recentSessions}
            backendHealth={backendHealth}
            backendError={backendError}
            signalingState={signalingState}
            activeRoom={activeRoom}
            onReconnectBackend={handleReconnectBackend}
            onNavigate={setDestination}
          />
        )}

        {destination === 'cast' && (
          <CastView
            capabilities={capabilities}
            preferences={preferences}
            onUpdatePreferences={setPreferences}
            localStream={localStream}
            receivers={receivers}
            programTelemetry={programTelemetry}
            onLogEvent={logEvent}
          />
        )}

        {destination === 'receivers' && (
          <ReceiversView
            deviceId={deviceId}
            deviceName={deviceName}
            capabilities={capabilities}
            initialRoomCode={initialRoute.roomCode}
            incomingApprovals={incomingApprovals}
            activePhase="idle"
            signalingState={signalingState}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
            onCloseRoom={handleCloseRoom}
            onLogEvent={logEvent}
          />
        )}

        {destination === 'multi-view' && (
          <MultiViewView
            layout={multiViewLayout}
            onChangeLayout={setMultiViewLayout}
            slots={receivers}
            capabilities={capabilities}
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
