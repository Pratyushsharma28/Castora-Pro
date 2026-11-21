import { useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  LogIn,
  MonitorPlay,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
  Users,
} from 'lucide-react';
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
  onCreateRoom: () => Promise<RoomSnapshot>;
  onSubmitPairRequest: (roomId: string) => Promise<RoomSnapshot>;
  onStartSharing: (targetSelection: string | string[] | null) => Promise<void>;
  onStopSharing: () => void;
  onReconnectBackend: () => void;
  onNavigate: (destination: StudioDestination) => void;
}

const MAX_INITIAL_RECEIVERS = 6;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;

function phaseBadge(phase: WebRtcConnectionPhase): {
  label: string;
  tone: SignalTone;
  pulse?: boolean;
} {
  switch (phase) {
    case 'connected':
      return { label: 'Live', tone: 'active' };
    case 'connecting':
      return { label: 'Connecting', tone: 'signal', pulse: true };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warn', pulse: true };
    case 'failed':
      return { label: 'Error', tone: 'fault' };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'warn' };
    default:
      return { label: 'Standby', tone: 'standby' };
  }
}

export function ControlRoomView({
  deviceId,
  deviceName,
  capabilities,
  receivers,
  webrtcState,
  backendError,
  signalingState,
  activeRoom,
  activeRoomRole,
  pairingStatus,
  onCreateRoom,
  onSubmitPairRequest,
  onStartSharing,
  onStopSharing,
  onReconnectBackend,
  onNavigate,
}: ControlRoomViewProps) {
  const [shareBusy, setShareBusy] = useState(false);
  const [roomBusy, setRoomBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  const pairedReceivers = activeRoom?.pairedReceivers ?? [];
  const connectedPairedCount = pairedReceivers.filter((r) => r.connected).length;
  const connectedCount = activeRoom
    ? connectedPairedCount + (activeRoom.hostConnected ? 1 : 0)
    : receivers.filter((r) => r.connectionState === 'connected').length;

  const isApprovedInRoom =
    Boolean(activeRoom) &&
    (activeRoomRole === 'host' ||
      Boolean(activeRoom?.pairedReceivers.some((r) => r.deviceId === deviceId)));
  const canShareScreen =
    capabilities.isSecureContext &&
    capabilities.supportsDisplayMedia &&
    (!activeRoom || isApprovedInRoom);

  const incomingCount = webrtcState.incomingStreams.filter((s) => s.stream !== null).length;
  const streamBadge = phaseBadge(webrtcState.phase);

  const wsBadge: { label: string; tone: SignalTone; pulse?: boolean } =
    signalingState === 'connected'
      ? { label: 'Server Connected', tone: 'active' }
      : signalingState === 'connecting'
        ? { label: 'Connecting', tone: 'signal', pulse: true }
        : signalingState === 'error'
          ? { label: 'Connection Error', tone: 'fault' }
          : { label: 'Disconnected', tone: 'warn' };

  const sharingSummary = webrtcState.isSharingLocal
    ? incomingCount > 0
      ? `Sharing · ${incomingCount} incoming`
      : 'Sharing screen'
    : incomingCount > 0
      ? `Viewing ${incomingCount} ${incomingCount === 1 ? 'screen' : 'screens'}`
      : 'Idle';

  const handleQuickShare = async () => {
    setActionError(null);
    setShareBusy(true);
    try {
      await onStartSharing(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to start screen sharing');
    } finally {
      setShareBusy(false);
    }
  };

  const handleQuickCreateRoom = async () => {
    setActionError(null);
    setRoomBusy(true);
    try {
      await onCreateRoom();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to create room');
    } finally {
      setRoomBusy(false);
    }
  };

  const handleQuickJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = joinCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!ROOM_CODE_PATTERN.test(cleaned)) {
      setActionError('Enter a valid 6-character room code.');
      return;
    }
    setActionError(null);
    setRoomBusy(true);
    try {
      await onSubmitPairRequest(cleaned);
      setJoinCode('');
      onNavigate('receivers');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to join room');
    } finally {
      setRoomBusy(false);
    }
  };

  const handleCopyRoomCode = async () => {
    if (!activeRoom) return;
    try {
      await navigator.clipboard.writeText(activeRoom.roomId);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  };

  return (
    <div className="space-y-6">
      {!capabilities.isSecureContext && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-[#F59E0B]/40 bg-[#FFFBEB] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#B45309]" aria-hidden="true" />
            <div className="text-xs leading-relaxed text-[#78350F]">
              <span className="font-semibold">HTTPS required for browser screen capture.</span>{' '}
              Current origin ({capabilities.origin || 'unknown'}) is not a secure context.
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#F59E0B]/40 bg-white px-3 text-xs font-medium text-[#78350F] hover:bg-[#FEF3C7] whitespace-nowrap"
          >
            <span>Setup Guide</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Primary Workspace Overview Card */}
      <section
        aria-label="Workspace Summary"
        className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      >
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-xl font-semibold tracking-tight text-[#172033]">
                Castora Pro Workspace
              </h1>
              <SignalBadge label={wsBadge.label} tone={wsBadge.tone} pulse={wsBadge.pulse} />
              {(signalingState === 'disconnected' || signalingState === 'error' || backendError) && (
                <button
                  type="button"
                  onClick={onReconnectBackend}
                  aria-label="Reconnect to signaling server"
                  className="inline-flex h-7 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  <span>Reconnect</span>
                </button>
              )}
            </div>
            <p className="text-sm text-[#64748B]">
              Device: <span className="font-medium text-[#172033]">{deviceName}</span>
              <span aria-hidden="true"> · </span>
              <span>{capabilities.userAgentSummary}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {webrtcState.isSharingLocal ? (
              <>
                <button
                  type="button"
                  disabled={shareBusy || !canShareScreen}
                  onClick={handleQuickShare}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
                >
                  <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                  <span>{shareBusy ? 'Starting...' : 'Change Screen'}</span>
                </button>
                <button
                  type="button"
                  onClick={onStopSharing}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] bg-[#DC2626] px-4 text-sm font-semibold text-white hover:bg-[#B91C1C]"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Stop Sharing</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={shareBusy || !canShareScreen}
                onClick={handleQuickShare}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
              >
                <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                <span>{shareBusy ? 'Starting...' : 'Share Screen'}</span>
              </button>
            )}

            {!activeRoom ? (
              <button
                type="button"
                disabled={roomBusy}
                onClick={handleQuickCreateRoom}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>{roomBusy ? 'Creating...' : 'Create Room'}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate('receivers')}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
              >
                <Users className="h-4 w-4" aria-hidden="true" />
                <span>Manage Room</span>
              </button>
            )}
          </div>
        </div>

        {/* Single-row Status Strip (no nested cards) */}
        <div className="grid grid-cols-1 divide-y divide-[#E2E8F0] border-t border-[#E2E8F0] bg-[#F8FAFC] sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Current Room</div>
            <div className="mt-1 flex items-center gap-2">
              {activeRoom ? (
                <>
                  <span className="font-mono text-base font-semibold tracking-wider text-[#172033] tabular-metrics">
                    {activeRoom.roomId}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyRoomCode}
                    aria-label="Copy room code"
                    className="inline-flex h-6 items-center gap-1 rounded-md border border-[#E2E8F0] bg-white px-2 text-[11px] font-medium text-[#64748B] hover:border-[#2563EB] hover:text-[#2563EB]"
                  >
                    {copiedCode ? (
                      <>
                        <Check className="h-3 w-3 text-[#16A34A]" aria-hidden="true" />
                        <span className="text-[#16A34A]">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" aria-hidden="true" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <span className="text-sm font-medium text-[#64748B]">No active room</span>
              )}
            </div>
          </div>

          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Connected Participants</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-base font-semibold text-[#172033] tabular-metrics">
                {activeRoom ? connectedCount : 0}
              </span>
              <span className="text-xs text-[#64748B] tabular-metrics">
                {activeRoom
                  ? `in room (${pairedReceivers.length} / ${MAX_INITIAL_RECEIVERS} receiver slots)`
                  : `of ${MAX_INITIAL_RECEIVERS} receiver capacity`}
              </span>
            </div>
          </div>

          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Screen Sharing</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-sm font-semibold text-[#172033]">{sharingSummary}</span>
              <SignalBadge
                label={streamBadge.label}
                tone={streamBadge.tone}
                pulse={streamBadge.pulse}
              />
            </div>
          </div>

          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Room Access</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-[#172033]">
                {activeRoom
                  ? activeRoomRole === 'host'
                    ? 'Host'
                    : pairingStatus
                  : 'Standalone'}
              </span>
              {activeRoom && activeRoomRole === 'host' && activeRoom.pendingCount > 0 && (
                <button
                  type="button"
                  onClick={() => onNavigate('receivers')}
                  className="text-xs font-semibold text-[#2563EB] hover:underline"
                >
                  {activeRoom.pendingCount} pending
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {(actionError || webrtcState.errorMessage || backendError) && (
        <div
          role="alert"
          className="rounded-xl border border-[#DC2626]/30 bg-[#FEF2F2] px-4 py-3 text-sm text-[#B91C1C]"
        >
          {actionError ?? webrtcState.errorMessage ?? backendError}
        </div>
      )}

      {/* Room Onboarding when not yet in a room */}
      {!activeRoom && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="flex flex-col justify-between rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <div>
              <h2 className="font-display text-base font-semibold text-[#172033]">
                Create a Room
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-[#64748B]">
                Start a secure room with a 6-character code. Approve up to 6 participants and share screens in any direction.
              </p>
            </div>
            <div className="mt-5">
              <button
                type="button"
                disabled={roomBusy}
                onClick={handleQuickCreateRoom}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>{roomBusy ? 'Creating Room...' : 'Create Room'}</span>
              </button>
            </div>
          </div>

          <form
            onSubmit={handleQuickJoinRoom}
            className="flex flex-col justify-between rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
          >
            <div>
              <h2 className="font-display text-base font-semibold text-[#172033]">
                Join an Existing Room
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-[#64748B]">
                Enter the 6-character code shared by the room host to request access.
              </p>
              <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
                <label htmlFor="home-join-room-code" className="sr-only">
                  6-character room code
                </label>
                <input
                  id="home-join-room-code"
                  type="text"
                  maxLength={6}
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={joinCode}
                  onChange={(e) =>
                    setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))
                  }
                  placeholder="Room code (e.g. K7M4P9)"
                  className="h-11 flex-1 rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 font-mono text-sm font-semibold tracking-widest text-[#172033] placeholder:font-sans placeholder:tracking-normal placeholder:font-normal placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={roomBusy || joinCode.length < 6}
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-semibold text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
                >
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  <span>{roomBusy ? 'Joining...' : 'Join Room'}</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Pending approval alert for Host */}
      {activeRoom && activeRoomRole === 'host' && activeRoom.pendingCount > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-[#2563EB]/30 bg-[#EFF6FF] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-[#172033]">
              {activeRoom.pendingCount}{' '}
              {activeRoom.pendingCount === 1
                ? 'participant is waiting for approval'
                : 'participants are waiting for approval'}
            </p>
            <p className="text-xs text-[#64748B]">
              Review pending devices in Rooms before they can share or view screens.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('receivers')}
            className="inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-[10px] bg-[#2563EB] px-4 text-xs font-semibold text-white hover:bg-[#1D4ED8]"
          >
            <span>Review Requests</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Active Screens Preview on Home */}
      {(webrtcState.incomingStreams.length > 0 || webrtcState.localStream) && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-[#172033]">
              Active Screens
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('multi-view')}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#2563EB] hover:underline"
            >
              <span>Open Screens Workspace</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {webrtcState.incomingStreams.length > 0 && (
            <IncomingScreensPanel
              streams={webrtcState.incomingStreams}
              compactTelemetry
              hideTelemetry
            />
          )}

          {webrtcState.localStream && (
            <VideoSurface
              slotLabel="My Screen"
              title={`${deviceName} (Local Outbound Preview)`}
              subtitle={
                webrtcState.outboundPeers.length > 0
                  ? `Sharing to ${webrtcState.outboundPeers.map((o) => o.targetName).join(', ')}`
                  : 'Ready to transmit'
              }
              stream={webrtcState.localStream}
              muted
              highlight
              standbyReason="Local screen preview."
              statusBadge={<SignalBadge label="Sharing" tone="active" />}
            />
          )}
        </div>
      )}
    </div>
  );
}
