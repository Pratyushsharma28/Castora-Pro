import { useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  LogIn,
  MonitorPlay,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
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
  AudioPlaybackStatus,
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
  onRetryPeer?: (peerDeviceId: string) => void;
  onRetryAllFailed?: () => void;
  mutedByPeerId?: Record<string, boolean>;
  onToggleMutePeer?: (peerDeviceId: string) => void;
  onNavigate: (destination: StudioDestination) => void;
  onIncomingVideoDimensions?: (
    senderDeviceId: string,
    width: number | null,
    height: number | null
  ) => void;
  onIncomingAudioPlayback?: (
    senderDeviceId: string,
    state: { playbackStatus: AudioPlaybackStatus; autoplayBlocked: boolean }
  ) => void;
}

const MAX_INITIAL_RECEIVERS = 15;
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
  onRetryPeer,
  onRetryAllFailed,
  mutedByPeerId,
  onToggleMutePeer,
  onNavigate,
  onIncomingVideoDimensions,
  onIncomingAudioPlayback,
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
      const msg = err instanceof Error ? err.message : 'Unable to join room';
      if (msg.toLowerCase().includes('password') || msg.toLowerCase().includes('invitation')) {
        setActionError(`${msg} Open Rooms to enter the password or invitation link.`);
      } else {
        setActionError(msg);
      }
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

      {/* Primary Workspace Overview Card — Obsidian architectural header + Swiss 4-column hairline grid */}
      <section
        aria-label="Workspace Summary"
        className="overflow-hidden rounded-xl border border-[#141414] bg-white castora-stage-shadow"
      >
        <div className="bg-[#141414] p-6 text-white sm:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[#A3A8AE]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#FF6041]" aria-hidden="true" />
                  <span>01 · Studio Control</span>
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${
                    signalingState === 'connected'
                      ? 'text-[#81FF28]'
                      : signalingState === 'connecting'
                        ? 'text-[#FF6041]'
                        : signalingState === 'error'
                          ? 'text-[#F87171]'
                          : 'text-[#A3A8AE]'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      signalingState === 'connected'
                        ? 'bg-[#81FF28]'
                        : signalingState === 'connecting'
                          ? 'bg-[#FF6041]'
                          : signalingState === 'error'
                            ? 'bg-[#F87171]'
                            : 'bg-[#5C6063]'
                    }`}
                    aria-hidden="true"
                  />
                  <span>{wsBadge.label}</span>
                </span>
                {(signalingState === 'disconnected' || signalingState === 'error' || backendError) && (
                  <button
                    type="button"
                    onClick={onReconnectBackend}
                    aria-label="Reconnect to signaling server"
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-white/20 bg-white/10 px-2.5 text-xs font-medium text-white transition-colors hover:bg-white/20"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    <span>Reconnect</span>
                  </button>
                )}
              </div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-[28px]">
                Castora Pro Workspace
              </h1>
              <p className="text-xs text-[#A3A8AE] sm:text-sm">
                Device: <span className="font-medium text-white">{deviceName}</span>
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
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 text-sm font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50"
                  >
                    <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                    <span>{shareBusy ? 'Starting...' : 'Change Screen'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={onStopSharing}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-[#DC2626] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#B91C1C]"
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
                  className="castora-roll-trigger inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-[#FF6041] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#E85032] disabled:opacity-50"
                >
                  <MonitorPlay className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="castora-roll-label h-[1.25em]">
                    <span className="castora-roll-track">
                      <span>{shareBusy ? 'Starting...' : 'Share Screen'}</span>
                      <span aria-hidden="true">{shareBusy ? 'Starting...' : 'Share Screen'}</span>
                    </span>
                  </span>
                </button>
              )}

              {!activeRoom ? (
                <button
                  type="button"
                  disabled={roomBusy}
                  onClick={handleQuickCreateRoom}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 text-sm font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>{roomBusy ? 'Creating...' : 'Create Room'}</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onNavigate('receivers')}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 text-sm font-medium text-white transition-colors hover:bg-white/20"
                  >
                    <Users className="h-4 w-4" aria-hidden="true" />
                    <span>Manage Room</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('sessions')}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 text-sm font-medium text-white transition-colors hover:bg-white/20"
                  >
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    <span>Session Controls</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Single-row Swiss Hairline Status Strip */}
        <div className="grid grid-cols-1 divide-y divide-[#D5D7DE] bg-white sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
          <div className="px-5 py-4">
            <div className="font-mono text-[11px] uppercase tracking-wider text-[#797D82]">
              {activeRoom?.roomName ? activeRoom.roomName : 'Current Room'}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              {activeRoom ? (
                <>
                  <span className="font-mono text-lg font-semibold tracking-wider text-[#141414] tabular-metrics">
                    {activeRoom.roomId}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyRoomCode}
                    aria-label="Copy room code"
                    className="inline-flex h-6 items-center gap-1 rounded-[4px] border border-[#D5D7DE] bg-[#FAFAFA] px-2 text-[11px] font-medium text-[#5C6063] transition-colors hover:border-[#141414] hover:text-[#141414]"
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
                <span className="text-sm font-medium text-[#5C6063]">No active room</span>
              )}
            </div>
          </div>

          <div className="px-5 py-4">
            <div className="font-mono text-[11px] uppercase tracking-wider text-[#797D82]">
              Connected Participants
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-lg font-semibold text-[#141414] tabular-metrics">
                {activeRoom ? connectedCount : 0}
              </span>
              <span className="text-xs text-[#5C6063] tabular-metrics">
                {activeRoom
                  ? `in room (${pairedReceivers.length} / ${MAX_INITIAL_RECEIVERS} receiver slots)`
                  : `of ${MAX_INITIAL_RECEIVERS} receiver capacity`}
              </span>
            </div>
          </div>

          <div className="px-5 py-4">
            <div className="font-mono text-[11px] uppercase tracking-wider text-[#797D82]">
              Screen Sharing
            </div>
            <div className="mt-1.5 flex items-center gap-2.5">
              <span className="text-sm font-semibold text-[#141414]">{sharingSummary}</span>
              <SignalBadge
                label={streamBadge.label}
                tone={streamBadge.tone}
                pulse={streamBadge.pulse}
              />
            </div>
          </div>

          <div className="px-5 py-4">
            <div className="font-mono text-[11px] uppercase tracking-wider text-[#797D82]">
              Room Access
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-[#141414]">
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
                  className="text-xs font-semibold text-[#FF6041] hover:underline"
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
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#DC2626]/35 bg-[#FEF2F2] px-4 py-3 text-sm text-[#B91C1C]"
        >
          <span>{actionError ?? webrtcState.errorMessage ?? backendError}</span>
          {onRetryAllFailed &&
            (webrtcState.incomingStreams.some((s) => s.phase === 'failed' || s.recovery?.exhausted) ||
              webrtcState.outboundPeers.some((o) => o.phase === 'failed' || o.recovery?.exhausted)) && (
              <button
                type="button"
                onClick={onRetryAllFailed}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[#DC2626]/30 bg-white px-3 text-xs font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Retry Failed Connections</span>
              </button>
            )}
        </div>
      )}

      {/* Room Onboarding when not yet in a room */}
      {!activeRoom && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="castora-card castora-card-interactive flex flex-col justify-between p-6">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#797D82]">
                01 · Host Broadcast
              </div>
              <h2 className="mt-2 font-display text-lg font-semibold text-[#141414]">
                Create a Room
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-[#5C6063]">
                Start a secure room with a 6-character code. Approve up to 15 participants and share screens in any direction.
              </p>
            </div>
            <div className="mt-6">
              <button
                type="button"
                disabled={roomBusy}
                onClick={handleQuickCreateRoom}
                className="castora-roll-trigger inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[#141414] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#FF6041] disabled:opacity-50"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="castora-roll-label h-[1.25em]">
                  <span className="castora-roll-track">
                    <span>{roomBusy ? 'Creating Room...' : 'Create Room'}</span>
                    <span aria-hidden="true">{roomBusy ? 'Creating Room...' : 'Create Room'}</span>
                  </span>
                </span>
              </button>
            </div>
          </div>

          <form
            onSubmit={handleQuickJoinRoom}
            className="castora-card castora-card-interactive flex flex-col justify-between p-6"
          >
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#797D82]">
                02 · Connect Receiver
              </div>
              <h2 className="mt-2 font-display text-lg font-semibold text-[#141414]">
                Join an Existing Room
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-[#5C6063]">
                Enter the 6-character code shared by the room host to request access.
              </p>
              <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
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
                  className="h-11 flex-1 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-3.5 font-mono text-sm font-semibold tracking-widest text-[#141414] placeholder:font-sans placeholder:tracking-normal placeholder:font-normal placeholder:text-[#797D82] focus:border-[#FF6041] focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={roomBusy || joinCode.length < 6}
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-[#141414] bg-white px-4 text-sm font-semibold text-[#141414] transition-colors hover:bg-[#141414] hover:text-white disabled:border-[#D5D7DE] disabled:text-[#797D82] disabled:hover:bg-white disabled:opacity-60"
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
        <div className="flex flex-col gap-3 rounded-xl border border-[#FF6041]/45 bg-[#FFF4F1] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-[#141414]">
              {activeRoom.pendingCount}{' '}
              {activeRoom.pendingCount === 1
                ? 'participant is waiting for approval'
                : 'participants are waiting for approval'}
            </p>
            <p className="text-xs text-[#5C6063]">
              Review pending devices in Rooms before they can share or view screens.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('receivers')}
            className="inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-lg bg-[#FF6041] px-4 text-xs font-semibold text-white transition-colors hover:bg-[#E85032]"
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
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#797D82]">
                03 · Live Signals
              </span>
              <h2 className="font-display text-base font-semibold text-[#141414]">
                Active Screens
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('multi-view')}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#141414] transition-colors hover:text-[#FF6041]"
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
              mutedByPeerId={mutedByPeerId}
              onToggleMutePeer={onToggleMutePeer}
              onRetryPeer={onRetryPeer}
              onIncomingVideoDimensions={onIncomingVideoDimensions}
              onIncomingAudioPlayback={onIncomingAudioPlayback}
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
