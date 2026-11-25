import { useState } from 'react';
import {
  Check,
  Copy,
  Link2,
  LogIn,
  LogOut,
  MonitorPlay,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type {
  PairingLifecycleStatus,
  RoomSnapshot,
  SignalingSocketState,
} from '../services/backendClient';
import type { WebRtcSessionSnapshot } from '../services/webrtcSignalingBridge';
import type {
  AudioPlaybackStatus,
  BrowserCapabilityReport,
  CapturePreferences,
  RoomPrivacyMode,
  StudioDestination,
  WebRtcConnectionPhase,
} from '../types/studio';
import { DeviceManagerPanel } from '../components/common/DeviceManagerPanel';
import { IncomingScreensPanel } from '../components/common/IncomingScreensPanel';
import { SignalBadge, type SignalTone } from '../components/common/SignalBadge';

interface ReceiversViewProps {
  deviceId: string;
  deviceName: string;
  capabilities: BrowserCapabilityReport;
  preferences: CapturePreferences;
  initialRoomCode: string;
  initialInviteCode?: string;
  hostInviteCode?: string | null;
  inviteValidationMessage?: string | null;
  activePhase: WebRtcConnectionPhase;
  signalingState: SignalingSocketState;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  pairingStatus: PairingLifecycleStatus;
  pairingDetail: string | null;
  webrtcState: WebRtcSessionSnapshot;
  mutedByPeerId: Record<string, boolean>;
  onCreateRoom: (options?: {
    roomName?: string;
    privacyMode?: RoomPrivacyMode;
    password?: string;
  }) => Promise<RoomSnapshot>;
  onSubmitPairRequest: (
    roomId: string,
    options?: { inviteCode?: string; password?: string }
  ) => Promise<RoomSnapshot>;
  onApproveReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onRejectReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onRemoveReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onRenameDevice: (targetDeviceId: string, newName: string) => Promise<void>;
  onStopDeviceStream: (
    targetDeviceId: string,
    mode: 'outbound-to-peer' | 'participant-room-stream'
  ) => Promise<void>;
  onReconnectDevice: (targetDeviceId: string) => Promise<void>;
  onToggleMutePeer: (peerDeviceId: string) => void;
  onToggleAdaptiveLock: (
    targetDeviceId: string,
    isSelf: boolean,
    nextLocked: boolean
  ) => Promise<void>;
  onRefreshDevices: () => Promise<void>;
  onLeaveRoom: () => Promise<void>;
  onCloseRoom: () => Promise<void>;
  onStartSharing: (targetSelection: string | string[] | null) => Promise<void>;
  onStopSharing: () => void;
  onReconnectBackend?: () => void;
  onRetryPeer?: (peerDeviceId: string) => void;
  onViewStream?: (senderDeviceId: string) => void;
  onIncomingAudioPlayback?: (
    senderDeviceId: string,
    state: { playbackStatus: AudioPlaybackStatus; autoplayBlocked: boolean }
  ) => void;
  lastSignalingActivityAt?: string | null;
  onNavigate: (destination: StudioDestination) => void;
  onLogEvent: (
    category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error',
    title: string,
    detail: string
  ) => void;
}

const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;

function statusToTone(status: PairingLifecycleStatus): SignalTone {
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

export function ReceiversView({
  deviceId,
  deviceName,
  capabilities,
  preferences,
  initialRoomCode,
  initialInviteCode = '',
  hostInviteCode = null,
  inviteValidationMessage = null,
  signalingState,
  activeRoom,
  activeRoomRole,
  pairingStatus,
  pairingDetail,
  webrtcState,
  mutedByPeerId,
  onCreateRoom,
  onSubmitPairRequest,
  onApproveReceiver,
  onRejectReceiver,
  onRemoveReceiver,
  onRenameDevice,
  onStopDeviceStream,
  onReconnectDevice,
  onToggleMutePeer,
  onToggleAdaptiveLock,
  onRefreshDevices,
  onLeaveRoom,
  onCloseRoom,
  onStartSharing,
  onStopSharing,
  onReconnectBackend,
  onRetryPeer,
  onViewStream,
  onIncomingAudioPlayback,
  lastSignalingActivityAt = null,
  onNavigate,
  onLogEvent,
}: ReceiversViewProps) {
  const [mode, setMode] = useState<'join' | 'host'>(
    activeRoomRole === 'host' ? 'host' : 'join'
  );
  const [roomCode, setRoomCode] = useState<string>(initialRoomCode);
  const [joinInviteCode, setJoinInviteCode] = useState<string>(initialInviteCode);
  const [joinPassword, setJoinPassword] = useState<string>('');
  const [createRoomName, setCreateRoomName] = useState<string>('');
  const [createPrivacy, setCreatePrivacy] = useState<RoomPrivacyMode>('approval_required');
  const [createPassword, setCreatePassword] = useState<string>('');
  const [qrInput, setQrInput] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [shareBusy, setShareBusy] = useState<boolean>(false);
  const [copiedType, setCopiedType] = useState<'code' | 'link' | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const pairedReceivers = activeRoom?.pairedReceivers ?? [];
  const myPairedSlot = pairedReceivers.find((r) => r.deviceId === deviceId);
  const isApprovedMember =
    Boolean(activeRoom) &&
    (activeRoomRole === 'host' || Boolean(myPairedSlot));
  const canShareScreen =
    capabilities.isSecureContext && capabilities.supportsDisplayMedia && isApprovedMember;

  const handleRoomInputChange = (raw: string) => {
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    setRoomCode(cleaned);
    if (feedback?.tone === 'error') {
      setFeedback(null);
    }
  };

  const handleCopy = async (kind: 'code' | 'link') => {
    if (!activeRoom) return;
    const text =
      kind === 'code'
        ? activeRoom.roomId
        : hostInviteCode
          ? `${window.location.origin}/?room=${encodeURIComponent(activeRoom.roomId)}&invite=${encodeURIComponent(hostInviteCode)}`
          : `${window.location.origin}/?room=${encodeURIComponent(activeRoom.roomId)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(kind);
      window.setTimeout(() => setCopiedType(null), 1800);
    } catch {
      setFeedback({ tone: 'error', text: 'Clipboard access blocked by browser.' });
    }
  };

  const handleSubmitJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ROOM_CODE_PATTERN.test(roomCode)) {
      const msg = 'Enter a valid 6-character alphanumeric room code (example: K7M4P9).';
      setFeedback({ tone: 'error', text: msg });
      onLogEvent('ui', 'Room code validation failed', `Input "${roomCode || '(empty)'}" is not 6 alphanumeric characters.`);
      return;
    }

    setBusy(true);
    const pwdToSubmit = joinPassword;
    setJoinPassword('');
    try {
      const submitted = await onSubmitPairRequest(roomCode, {
        inviteCode: joinInviteCode.trim() || undefined,
        password: pwdToSubmit.length > 0 ? pwdToSubmit : undefined,
      });
      const isAlreadyPaired = submitted.pairedReceivers.some((r) => r.deviceId === deviceId);
      setFeedback({
        tone: 'info',
        text: isAlreadyPaired
          ? `Joined room ${submitted.roomId} (${submitted.roomName ?? submitted.hostDeviceName}) immediately via Open access.`
          : `Request sent to room ${submitted.roomId} (${submitted.hostDeviceName}). Waiting for host approval.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to submit pairing request';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const handleParseQrPayload = () => {
    const trimmed = qrInput.trim();
    if (!trimmed) {
      setFeedback({ tone: 'error', text: 'Paste a join URL or 6-character room code first.' });
      return;
    }
    try {
      const url = new URL(trimmed);
      const paramRoom = (url.searchParams.get('room') ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 6);
      const paramInvite = (url.searchParams.get('invite') ?? '').trim().slice(0, 128);
      if (ROOM_CODE_PATTERN.test(paramRoom)) {
        setRoomCode(paramRoom);
        if (paramInvite) {
          setJoinInviteCode(paramInvite);
        }
        setFeedback({
          tone: 'info',
          text: paramInvite
            ? `Loaded room ${paramRoom} and invitation token from link.`
            : `Loaded room code ${paramRoom} from join link.`,
        });
        onLogEvent('ui', 'Parsed invitation link', `Extracted room code ${paramRoom}.`);
        return;
      }
    } catch {
      // Not a full URL; fall back to direct token check
    }

    const fallbackCode = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (ROOM_CODE_PATTERN.test(fallbackCode)) {
      setRoomCode(fallbackCode);
      setFeedback({ tone: 'info', text: `Loaded room code ${fallbackCode}.` });
      onLogEvent('ui', 'Parsed QR room token', `Loaded room code ${fallbackCode}.`);
      return;
    }

    setFeedback({ tone: 'error', text: 'Could not find a valid 6-character room code.' });
  };

  const handleCreateRoom = async () => {
    setBusy(true);
    const pwdToSubmit = createPassword;
    setCreatePassword('');
    try {
      const created = await onCreateRoom({
        roomName: createRoomName.trim() || undefined,
        privacyMode: createPrivacy,
        password: pwdToSubmit.length > 0 ? pwdToSubmit : undefined,
      });
      setCreateRoomName('');
      setFeedback({
        tone: 'info',
        text: `Room "${created.roomName ?? created.roomId}" (${created.roomId}) created. Expires at ${new Date(created.expiresAt).toLocaleTimeString()}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to create room';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const handleCloseRoom = async () => {
    setBusy(true);
    try {
      await onCloseRoom();
      setFeedback({ tone: 'info', text: 'Room closed and all participants disconnected.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to close room';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const handleLeaveRoom = async () => {
    setBusy(true);
    try {
      await onLeaveRoom();
      setFeedback({ tone: 'info', text: 'Left room.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to leave room';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const handleShareBack = async () => {
    setShareBusy(true);
    try {
      await onStartSharing(null);
      setFeedback({ tone: 'info', text: 'Sharing your screen with connected participants.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to share your screen';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-[#172033]">
            Rooms &amp; Participants
          </h1>
          <p className="text-sm text-[#64748B]">
            Create or join a room with up to 15 paired participants. All approved members can share and view screens.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SignalBadge
            label={pairingStatus}
            tone={statusToTone(pairingStatus)}
            pulse={pairingStatus === 'Request pending' || pairingStatus === 'Awaiting approval'}
          />
          <SignalBadge
            label={
              signalingState === 'connected'
                ? 'Server Online'
                : signalingState === 'connecting'
                  ? 'Reconnecting'
                  : 'Offline'
            }
            tone={
              signalingState === 'connected'
                ? 'active'
                : signalingState === 'connecting'
                  ? 'warn'
                  : 'standby'
            }
            pulse={signalingState === 'connecting'}
          />
          {(signalingState === 'disconnected' || signalingState === 'error') && onReconnectBackend && (
            <button
              type="button"
              onClick={onReconnectBackend}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Reconnect</span>
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={`rounded-xl border px-4 py-3 text-sm ${
            feedback.tone === 'error'
              ? 'border-[#DC2626]/30 bg-[#FEF2F2] text-[#B91C1C]'
              : 'border-[#E2E8F0] bg-white text-[#172033]'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Active Room Summary Card */}
      {activeRoom && (
        <section
          aria-label="Active Room Details"
          className="rounded-xl border border-[#E2E8F0] bg-white p-5 sm:p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-medium text-[#64748B]">Room Code</span>
                <span className="font-mono text-2xl font-bold tracking-[0.2em] text-[#172033] tabular-metrics">
                  {activeRoom.roomId}
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy('code')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                >
                  {copiedType === 'code' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-[#16A34A]" aria-hidden="true" />
                      <span className="text-[#16A34A]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Copy Code</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopy('link')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                >
                  {copiedType === 'link' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-[#16A34A]" aria-hidden="true" />
                      <span className="text-[#16A34A]">Link Copied</span>
                    </>
                  ) : (
                    <>
                      <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Copy Invite Link</span>
                    </>
                  )}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B] tabular-metrics">
                {activeRoom.roomName && (
                  <>
                    <strong className="font-semibold text-[#172033]">{activeRoom.roomName}</strong>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span>
                  Role:{' '}
                  <strong className="font-semibold text-[#172033]">
                    {activeRoomRole === 'host' ? 'Host' : 'Participant'}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>Host: {activeRoom.hostDeviceName}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {activeRoom.privacyMode === 'private'
                    ? 'Private'
                    : activeRoom.privacyMode === 'open'
                      ? 'Open'
                      : 'Approval Required'}
                  {activeRoom.passwordProtected ? ' (Password)' : ''}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {activeRoom.activeReceiverCount} connected / {activeRoom.pairedReceiverCount} paired (max{' '}
                  {activeRoom.maxReceivers})
                </span>
                <span aria-hidden="true">·</span>
                <span>Expires {new Date(activeRoom.expiresAt).toLocaleTimeString()}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => onNavigate('sessions')}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                <span>Session Controls</span>
              </button>
              {isApprovedMember && (
                <>
                  <button
                    type="button"
                    disabled={shareBusy || !canShareScreen}
                    onClick={handleShareBack}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
                  >
                    <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                    <span>
                      {shareBusy
                        ? 'Starting...'
                        : webrtcState.isSharingLocal
                          ? 'Change Screen'
                          : 'Share Screen'}
                    </span>
                  </button>
                  {webrtcState.isSharingLocal && (
                    <button
                      type="button"
                      onClick={onStopSharing}
                      className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#DC2626]/30 bg-[#FEF2F2] px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
                    >
                      <Square className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Stop Sharing</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onNavigate('multi-view')}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                  >
                    <span>Open Screens</span>
                  </button>
                </>
              )}

              {activeRoomRole === 'host' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleCloseRoom}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#DC2626]/30 bg-white px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  <span>{busy ? 'Closing...' : 'Close Room'}</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleLeaveRoom}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#DC2626]/30 bg-white px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  <span>{busy ? 'Leaving...' : 'Leave Room'}</span>
                </button>
              )}
            </div>
          </div>

          {pairingDetail && activeRoomRole === 'receiver' && (
            <p className="mt-3 border-t border-[#E2E8F0] pt-3 text-xs text-[#64748B]">
              {pairingDetail}
              {myPairedSlot && (
                <span className="ml-2 font-mono text-[#172033] tabular-metrics">
                  · Assigned Slot {myPairedSlot.assignedSlotIndex + 1}
                </span>
              )}
            </p>
          )}
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Join or Create Room */}
        <section className="min-w-0 space-y-4 lg:col-span-5" aria-label="Join or Create Room">
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-5">
            <div className="grid grid-cols-2 gap-1 rounded-[10px] bg-[#F1F5F9] p-1">
              <button
                type="button"
                onClick={() => setMode('join')}
                className={`min-h-[40px] rounded-lg text-sm font-semibold transition-colors ${
                  mode === 'join'
                    ? 'bg-white text-[#172033] shadow-xs'
                    : 'text-[#64748B] hover:text-[#172033]'
                }`}
              >
                Join Room
              </button>
              <button
                type="button"
                onClick={() => setMode('host')}
                className={`min-h-[40px] rounded-lg text-sm font-semibold transition-colors ${
                  mode === 'host'
                    ? 'bg-white text-[#172033] shadow-xs'
                    : 'text-[#64748B] hover:text-[#172033]'
                }`}
              >
                Create Room
              </button>
            </div>

            {mode === 'join' ? (
              <form onSubmit={handleSubmitJoin} className="space-y-4">
                {inviteValidationMessage && !activeRoom && (
                  <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs text-[#172033]">
                    {inviteValidationMessage}
                  </div>
                )}

                <div>
                  <label
                    htmlFor="castora-room-code"
                    className="block text-xs font-medium text-[#172033]"
                  >
                    6-Character Room Code
                  </label>
                  <input
                    id="castora-room-code"
                    type="text"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={6}
                    value={roomCode}
                    onChange={(e) => handleRoomInputChange(e.target.value)}
                    placeholder="K7M4P9"
                    disabled={Boolean(activeRoom)}
                    className="mt-1.5 h-12 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 font-mono text-lg font-semibold tracking-[0.25em] text-[#172033] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:bg-white focus:outline-none tabular-metrics disabled:opacity-60"
                  />
                </div>

                <div>
                  <label
                    htmlFor="castora-room-password"
                    className="block text-xs font-medium text-[#172033]"
                  >
                    Room Password (if required)
                  </label>
                  <input
                    id="castora-room-password"
                    type="password"
                    maxLength={64}
                    autoComplete="off"
                    value={joinPassword}
                    onChange={(e) => setJoinPassword(e.target.value)}
                    placeholder="Enter password if room is protected"
                    disabled={Boolean(activeRoom)}
                    className="mt-1.5 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-sm text-[#172033] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:bg-white focus:outline-none disabled:opacity-60"
                  />
                </div>

                {joinInviteCode && (
                  <p className="text-[11px] font-medium text-[#2563EB]">
                    Invitation token attached for verification.
                  </p>
                )}

                {activeRoom && activeRoomRole === 'receiver' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleLeaveRoom}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-[10px] border border-[#DC2626]/30 bg-[#FEF2F2] px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEE2E2] disabled:opacity-50"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    <span>{busy ? 'Leaving Room...' : `Leave Room ${activeRoom.roomId}`}</span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={busy || Boolean(activeRoom)}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
                  >
                    <LogIn className="h-4 w-4" aria-hidden="true" />
                    <span>{busy ? 'Submitting Request...' : 'Request to Join Room'}</span>
                  </button>
                )}

                <div className="border-t border-[#E2E8F0] pt-4 space-y-2">
                  <label
                    htmlFor="castora-qr-input"
                    className="block text-xs font-medium text-[#64748B]"
                  >
                    Or paste invite link / room token
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="castora-qr-input"
                      type="text"
                      value={qrInput}
                      onChange={(e) => setQrInput(e.target.value)}
                      placeholder="https://.../?room=K7M4P9&invite=..."
                      className="h-11 flex-1 rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs text-[#172033] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleParseQrPayload}
                      className="min-h-[44px] rounded-[10px] border border-[#E2E8F0] bg-white px-3.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                    >
                      Load
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                {activeRoom && activeRoomRole === 'host' ? (
                  <div className="flex flex-col items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-6 text-center">
                    <QrCode className="h-8 w-8 text-[#2563EB]" aria-hidden="true" />
                    <p className="mt-3 font-mono text-2xl font-bold tracking-[0.22em] text-[#172033] tabular-metrics">
                      {activeRoom.roomId}
                    </p>
                    <p className="mt-1 text-xs text-[#64748B] tabular-metrics">
                      Expires {new Date(activeRoom.expiresAt).toLocaleTimeString()} ·{' '}
                      {activeRoom.activeReceiverCount} connected / {activeRoom.pairedReceiverCount} paired (max{' '}
                      {activeRoom.maxReceivers})
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor="castora-create-room-name"
                        className="block text-xs font-medium text-[#172033]"
                      >
                        Room Name (optional)
                      </label>
                      <input
                        id="castora-create-room-name"
                        type="text"
                        maxLength={64}
                        value={createRoomName}
                        onChange={(e) => setCreateRoomName(e.target.value)}
                        placeholder="Studio Review Room"
                        className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-sm text-[#172033] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="castora-create-privacy"
                        className="block text-xs font-medium text-[#172033]"
                      >
                        Privacy Mode
                      </label>
                      <select
                        id="castora-create-privacy"
                        value={createPrivacy}
                        onChange={(e) => setCreatePrivacy(e.target.value as RoomPrivacyMode)}
                        className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-sm text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                      >
                        <option value="approval_required">Approval Required</option>
                        <option value="private">Private (Invitation Required)</option>
                        <option value="open">Open (Auto-join available slots)</option>
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="castora-create-password"
                        className="block text-xs font-medium text-[#172033]"
                      >
                        Optional Room Password (4–64 chars)
                      </label>
                      <input
                        id="castora-create-password"
                        type="password"
                        maxLength={64}
                        autoComplete="new-password"
                        value={createPassword}
                        onChange={(e) => setCreatePassword(e.target.value)}
                        placeholder="Leave blank for open code access"
                        className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-sm text-[#172033] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                      />
                    </div>
                  </div>
                )}

                {activeRoom && activeRoomRole === 'host' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleCloseRoom}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-[10px] border border-[#DC2626]/30 bg-[#FEF2F2] px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEE2E2] disabled:opacity-50"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    <span>{busy ? 'Closing...' : 'Close Active Room'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy || Boolean(activeRoom)}
                    onClick={handleCreateRoom}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    <span>{busy ? 'Creating Room...' : 'Create Room'}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Local Device Info */}
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <h2 className="border-b border-[#E2E8F0] pb-2.5 text-sm font-semibold text-[#172033]">
              Your Device
            </h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#64748B]">Name</dt>
                <dd className="font-medium text-[#172033]">{deviceName}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#64748B]">Device ID</dt>
                <dd className="font-mono text-[#172033] tabular-metrics">{deviceId}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#64748B]">Device Type</dt>
                <dd className="text-[#172033]">{capabilities.detectedDeviceType}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#64748B]">Platform</dt>
                <dd className="text-[#172033]">{capabilities.detectedPlatform}</dd>
              </div>
            </dl>
          </div>
        </section>

        {/* Right: Device Manager (Approvals, Roster, Naming, Per-Device Controls) & Incoming Screens */}
        <section className="min-w-0 space-y-6 lg:col-span-7" aria-label="Participants and Approvals">
          <DeviceManagerPanel
            deviceId={deviceId}
            deviceName={deviceName}
            capabilities={capabilities}
            preferences={preferences}
            signalingState={signalingState}
            activeRoom={activeRoom}
            activeRoomRole={activeRoomRole}
            webrtcState={webrtcState}
            mutedByPeerId={mutedByPeerId}
            onRenameDevice={onRenameDevice}
            onApproveReceiver={onApproveReceiver}
            onRejectReceiver={onRejectReceiver}
            onRemoveReceiver={onRemoveReceiver}
            onStopDeviceStream={onStopDeviceStream}
            onReconnectDevice={onReconnectDevice}
            onToggleMutePeer={onToggleMutePeer}
            onToggleAdaptiveLock={onToggleAdaptiveLock}
            onViewStream={(senderDeviceId) => {
              if (onViewStream) {
                onViewStream(senderDeviceId);
              } else {
                onNavigate('multi-view');
              }
            }}
            onRefresh={onRefreshDevices}
            onReconnectBackend={onReconnectBackend}
            lastSignalingActivityAt={lastSignalingActivityAt}
          />

          {(isApprovedMember || webrtcState.incomingStreams.length > 0) && (
            <IncomingScreensPanel
              streams={webrtcState.incomingStreams}
              compactTelemetry
              mutedByPeerId={mutedByPeerId}
              onToggleMutePeer={onToggleMutePeer}
              onRetryPeer={onRetryPeer}
              onIncomingAudioPlayback={onIncomingAudioPlayback}
              emptyMessage={
                activeRoomRole === 'receiver'
                  ? `Connected to room ${activeRoom?.roomId ?? ''}. Incoming screens appear here whenever a participant shares.`
                  : 'No participant is sharing a screen right now.'
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}
