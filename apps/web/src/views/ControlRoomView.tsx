import { useState } from 'react';
import { ArrowRight, Cast, MonitorPlay, RefreshCw, ShieldAlert, Smartphone, Square } from 'lucide-react';
import type {
  BackendHealthResponse,
  PairingLifecycleStatus,
  RoomSnapshot,
  SignalingSocketState,
} from '../services/backendClient';
import type { WebRtcSessionSnapshot } from '../services/webrtcSignalingBridge';
import type {
  BrowserCapabilityReport,
  CapturePreferences,
  ConnectedReceiverSlot,
  SessionSummaryRecord,
  StudioDestination,
  WebRtcConnectionPhase,
} from '../types/studio';
import { IncomingScreensPanel } from '../components/common/IncomingScreensPanel';
import { SignalBadge, type SignalTone } from '../components/common/SignalBadge';
import { TelemetryStrip } from '../components/common/TelemetryStrip';
import { VideoSurface } from '../components/common/VideoSurface';

interface ControlRoomViewProps {
  deviceId: string;
  deviceName: string;
  capabilities: BrowserCapabilityReport;
  preferences: CapturePreferences;
  receivers: ConnectedReceiverSlot[];
  webrtcState: WebRtcSessionSnapshot;
  recentSessions: SessionSummaryRecord[];
  backendHealth: BackendHealthResponse | null;
  backendError: string | null;
  signalingState: SignalingSocketState;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  pairingStatus: PairingLifecycleStatus;
  onStartSharing: (targetSelection: string | string[] | null) => Promise<void>;
  onStopSharing: () => void;
  onReconnectBackend: () => void;
  onNavigate: (destination: StudioDestination) => void;
}

const MAX_INITIAL_RECEIVERS = 6;

function pairingTone(status: PairingLifecycleStatus): SignalTone {
  switch (status) {
    case 'Paired':
      return 'active';
    case 'Request pending':
    case 'Awaiting approval':
      return 'signal';
    case 'Expired':
    case 'Disconnected':
      return 'warn';
    case 'Rejected':
      return 'fault';
    default:
      return 'standby';
  }
}

function phaseBadge(phase: WebRtcConnectionPhase): { label: string; tone: SignalTone; pulse?: boolean } {
  switch (phase) {
    case 'connected':
      return { label: 'CONNECTED', tone: 'active' };
    case 'connecting':
      return { label: 'CONNECTING', tone: 'signal', pulse: true };
    case 'reconnecting':
      return { label: 'RECONNECTING', tone: 'warn', pulse: true };
    case 'failed':
      return { label: 'ERROR', tone: 'fault' };
    case 'disconnected':
      return { label: 'DISCONNECTED', tone: 'warn' };
    default:
      return { label: 'STANDBY', tone: 'standby' };
  }
}

export function ControlRoomView({
  deviceId,
  deviceName,
  capabilities,
  preferences,
  receivers,
  webrtcState,
  recentSessions,
  backendHealth,
  backendError,
  signalingState,
  activeRoom,
  activeRoomRole,
  pairingStatus,
  onStartSharing,
  onStopSharing,
  onReconnectBackend,
  onNavigate,
}: ControlRoomViewProps) {
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  const pairedReceivers = activeRoom?.pairedReceivers ?? [];
  const connectedPairedCount = pairedReceivers.filter((r) => r.connected).length;
  const capacityCount = activeRoom
    ? connectedPairedCount
    : receivers.filter((r) => r.connectionState === 'connected').length;

  const isApprovedInRoom =
    Boolean(activeRoom) &&
    (activeRoomRole === 'host' ||
      Boolean(activeRoom?.pairedReceivers.some((r) => r.deviceId === deviceId)));
  const canShareScreen =
    capabilities.isSecureContext &&
    capabilities.supportsDisplayMedia &&
    (!activeRoom || isApprovedInRoom);

  const firstIncoming = webrtcState.incomingStreams.find((s) => s.stream !== null) ?? webrtcState.incomingStreams[0] ?? null;
  const programStream = webrtcState.localStream ?? firstIncoming?.stream ?? null;
  const streamBadge = phaseBadge(webrtcState.phase);

  const monitorTitle = webrtcState.localStream
    ? `${deviceName} — Outbound Screen Capture`
    : firstIncoming
      ? `${firstIncoming.senderName} — Incoming Screen`
      : 'Master Program Monitor';

  const handleQuickShare = async () => {
    setShareError(null);
    setShareBusy(true);
    try {
      await onStartSharing(null);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Unable to start screen sharing');
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {!capabilities.isSecureContext && (
        <div
          role="alert"
          className="flex flex-col gap-3 border border-[#F59E0B]/50 bg-[#191D20] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#F59E0B]" aria-hidden="true" />
            <div className="text-xs leading-relaxed text-[#F2F3F0]">
              <span className="font-semibold text-[#F59E0B]">Non-secure HTTP origin detected</span>
              <span className="text-[#929A9D]">
                {' '}
                ({capabilities.origin || 'unknown origin'}). Mac browsers require HTTPS or localhost for reliable screen capture and WebRTC.
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-[#252A2F] bg-[#131619] px-3 text-xs font-medium text-[#F2F3F0] hover:border-[#FF7849] whitespace-nowrap"
          >
            <span>HTTPS Setup Guide</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Dominant Program Monitor Bay + Incoming Screens */}
        <section className="space-y-4 lg:col-span-8" aria-label="Program Monitor Workspace">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
                Control Room
              </h1>
              <p className="text-xs text-[#929A9D]">
                Master bidirectional preview, incoming participant screens, and real WebRTC getStats() telemetry.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={shareBusy || !canShareScreen}
                onClick={handleQuickShare}
                className="inline-flex h-8 items-center gap-1.5 bg-[#FF7849] px-3 text-xs font-semibold text-[#101214] hover:opacity-90 disabled:opacity-50"
              >
                <MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{shareBusy ? 'Starting...' : webrtcState.isSharingLocal ? 'Replace My Screen' : 'Share My Screen'}</span>
              </button>
              <button
                type="button"
                disabled={!webrtcState.isSharingLocal}
                onClick={onStopSharing}
                className="inline-flex h-8 items-center gap-1.5 border border-[#EF4444]/60 bg-[#191D20] px-3 text-xs font-semibold text-[#EF4444] hover:bg-[#EF4444]/10 disabled:border-[#252A2F] disabled:text-[#929A9D] disabled:opacity-50"
              >
                <Square className="h-3 w-3" aria-hidden="true" />
                <span>Stop My Screen</span>
              </button>
              <SignalBadge
                label={`Connection Status: ${streamBadge.label}`}
                tone={streamBadge.tone}
                pulse={streamBadge.pulse}
              />
            </div>
          </div>

          {(shareError || webrtcState.errorMessage) && (
            <div
              role="alert"
              className="border border-[#EF4444]/60 bg-[#191D20] px-3 py-2.5 text-xs text-[#EF4444]"
            >
              {shareError ?? webrtcState.errorMessage}
            </div>
          )}

          <VideoSurface
            slotLabel="PGM-01"
            title={monitorTitle}
            stream={programStream}
            muted={Boolean(webrtcState.localStream)}
            highlight={webrtcState.phase === 'connected'}
            standbyReason="No local screen capture or incoming participant stream is active. Pair devices in Receivers or click Share My Screen."
            statusBadge={
              <SignalBadge
                label={streamBadge.label}
                tone={streamBadge.tone}
                pulse={streamBadge.pulse}
              />
            }
            actions={
              <>
                <button
                  type="button"
                  onClick={() => onNavigate('cast')}
                  className="inline-flex min-h-[40px] items-center gap-2 bg-[#FF7849] px-4 text-xs font-semibold text-[#101214] hover:opacity-90"
                >
                  <Cast className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Open Cast Studio</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('receivers')}
                  className="inline-flex min-h-[40px] items-center gap-2 border border-[#252A2F] bg-[#191D20] px-4 text-xs font-medium text-[#F2F3F0] hover:border-[#FF7849]"
                >
                  <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Receivers &amp; Pairing</span>
                </button>
              </>
            }
          />

          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.08em] text-[#929A9D]">
              <span>Program Telemetry (getStats)</span>
              <span className="tabular-metrics">
                Target {preferences.resolution.toUpperCase()} · {preferences.targetFps} FPS · Peers {webrtcState.peerCount} · ICE {webrtcState.iceConnectionState ?? 'idle'}
              </span>
            </div>
            <TelemetryStrip telemetry={webrtcState.telemetry} />
          </div>

          <IncomingScreensPanel
            streams={webrtcState.incomingStreams}
            compactTelemetry
            emptyMessage="No incoming screens active. When the host or an approved friend shares their screen, their video stream and getStats() metrics appear here independently of your own screen share."
          />
        </section>

        {/* Right: Master Control Rail */}
        <aside className="space-y-4 lg:col-span-4" aria-label="Master Control Rail">
          {/* Backend & Pairing Status */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Backend &amp; Signaling
              </h2>
              <div className="flex items-center gap-2">
                <SignalBadge
                  label={
                    signalingState === 'connected'
                      ? 'WS ONLINE'
                      : signalingState === 'connecting'
                        ? 'CONNECTING'
                        : signalingState === 'error'
                          ? 'WS ERROR'
                          : 'OFFLINE'
                  }
                  tone={
                    signalingState === 'connected'
                      ? 'active'
                      : signalingState === 'connecting'
                        ? 'signal'
                        : signalingState === 'error'
                          ? 'fault'
                          : 'standby'
                  }
                  pulse={signalingState === 'connecting'}
                />
                <button
                  type="button"
                  onClick={onReconnectBackend}
                  title="Refresh backend health & reconnect signaling"
                  aria-label="Refresh backend connection"
                  className="inline-flex h-7 w-7 items-center justify-center border border-[#252A2F] bg-[#131619] text-[#929A9D] hover:border-[#FF7849] hover:text-[#F2F3F0]"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            </div>

            <dl className="mt-3 space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">API Health (/api/health)</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {backendHealth
                    ? `OK (${backendHealth.transport})`
                    : backendError
                      ? 'Unreachable'
                      : 'Checking...'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Pairing State</dt>
                <dd>
                  <SignalBadge label={pairingStatus} tone={pairingTone(pairingStatus)} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Connection Status</dt>
                <dd>
                  <SignalBadge label={streamBadge.label} tone={streamBadge.tone} pulse={streamBadge.pulse} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Active Room</dt>
                <dd className="font-mono text-[#F2F3F0] tabular-metrics">
                  {activeRoom ? activeRoom.roomId : 'None'}
                </dd>
              </div>
              {activeRoom && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#929A9D]">Room Expires</dt>
                  <dd className="font-mono text-[#F2F3F0] tabular-metrics">
                    {new Date(activeRoom.expiresAt).toLocaleTimeString()}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Server Devices / Rooms</dt>
                <dd className="font-mono text-[#F2F3F0] tabular-metrics">
                  {backendHealth
                    ? `${backendHealth.activeDevices} dev · ${backendHealth.activeRooms} rm`
                    : '—'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Secure Context</dt>
                <dd className="font-mono">
                  {capabilities.isSecureContext ? (
                    <span className="text-[#8BD7B0]">HTTPS / Secure</span>
                  ) : (
                    <span className="text-[#F59E0B]">HTTP (Restricted)</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          {/* Local Endpoint */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Local Endpoint
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="text-[11px] font-medium text-[#FF7849] hover:underline"
              >
                Edit
              </button>
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Device Name</dt>
                <dd className="truncate font-medium text-[#F2F3F0]">{deviceName}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Device ID</dt>
                <dd className="font-mono text-[#F2F3F0] tabular-metrics">{deviceId}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Runtime</dt>
                <dd className="text-[#F2F3F0]">{capabilities.userAgentSummary}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">H.264 Encode / Decode</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {capabilities.supportsVideoH264Encode ? 'ENC OK' : 'NO ENC'} /{' '}
                  {capabilities.supportsVideoH264Decode ? 'DEC OK' : 'NO DEC'}
                </dd>
              </div>
            </dl>
          </div>

          {/* Receiver Capacity Meter (0..6) */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Paired Participants
              </h2>
              <span className="font-mono text-xs font-semibold text-[#F2F3F0] tabular-metrics">
                {capacityCount} / {MAX_INITIAL_RECEIVERS}
              </span>
            </div>

            <div
              className="mt-3 grid grid-cols-6 gap-1.5"
              aria-label={`Paired receivers ${capacityCount} of ${MAX_INITIAL_RECEIVERS} connected`}
            >
              {Array.from({ length: MAX_INITIAL_RECEIVERS }, (_, idx) => {
                const slot = pairedReceivers.find((r) => r.assignedSlotIndex === idx);
                const isConnected = Boolean(slot?.connected);
                const isDisconnectedPaired = Boolean(slot && !slot.connected);
                return (
                  <div
                    key={idx}
                    className={`h-2.5 border ${
                      isConnected
                        ? 'border-[#8BD7B0] bg-[#8BD7B0]'
                        : isDisconnectedPaired
                          ? 'border-[#F59E0B] bg-[#F59E0B]/40'
                          : 'border-[#252A2F] bg-[#131619]'
                    }`}
                    title={
                      slot
                        ? `${slot.deviceName} (${slot.connected ? 'Paired & Connected' : 'Disconnected'})`
                        : `Slot ${idx + 1}: Available`
                    }
                  />
                );
              })}
            </div>

            <p className="mt-2.5 text-[11px] leading-relaxed text-[#929A9D]">
              {activeRoom
                ? `${activeRoom.pendingCount} pending approval · ${activeRoom.pairedReceiverCount} paired in room ${activeRoom.roomId}.`
                : 'No active room. Create or join a room in Receivers to pair up to 6 devices.'}
            </p>
          </div>

          {/* Recent Sessions */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Recent Sessions
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('activity')}
                className="text-[11px] font-medium text-[#929A9D] hover:text-[#F2F3F0]"
              >
                View Log
              </button>
            </div>

            {recentSessions.length === 0 ? (
              <p className="mt-3 text-xs leading-relaxed text-[#929A9D]">
                No completed WebRTC media sessions in this runtime yet. Summaries appear after ending a live cast.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-[#252A2F] text-xs">
                {recentSessions.map((session) => (
                  <li key={session.sessionId} className="flex items-center justify-between py-2">
                    <span className="truncate text-[#F2F3F0]">{session.peerName}</span>
                    <span className="font-mono text-[#929A9D] tabular-metrics">
                      {session.resolution} · {session.durationLabel}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
