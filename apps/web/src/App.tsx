import { useCallback, useState } from 'react';
import { MobileReceiverBar } from './components/layout/MobileReceiverBar';
import { TopControlBar } from './components/layout/TopControlBar';
import {
  loadOrCreateDeviceId,
  loadSavedDeviceName,
  probeBrowserCapabilities,
  saveDeviceName,
} from './services/browserCapabilities';
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

  // Honest Stage 1 empty state: zero fake connected receivers, approvals, or sessions
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
        category: 'ui',
        title: 'Castora Pro Stage 1 Control System initialized',
        detail: 'Signaling transport is in standby until Stage 2 WebSocket server integration.',
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
        isSignalingReady={false}
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
