import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowRight,
  Check,
  Clock,
  Copy,
  Edit3,
  KeyRound,
  Link2,
  Lock,
  LogOut,
  Plus,
  QrCode,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import type {
  BackendHealthResponse,
  RoomSnapshot,
  SignalingSocketState,
} from '../../services/backendClient';
import type { WebRtcSessionSnapshot } from '../../services/webrtcSignalingBridge';
import type { RoomPrivacyMode, StudioDestination } from '../../types/studio';
import { SignalBadge, type SignalTone } from './SignalBadge';

interface SessionManagementDashboardProps {
  deviceId: string;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  inviteCode: string | null;
  signalingState: SignalingSocketState;
  backendHealth: BackendHealthResponse | null;
  webrtcState: WebRtcSessionSnapshot;
  onCreateRoom: (options?: {
    roomName?: string;
    privacyMode?: RoomPrivacyMode;
    password?: string;
  }) => Promise<RoomSnapshot>;
  onRenameRoom: (roomName: string) => Promise<RoomSnapshot>;
  onUpdatePrivacyMode: (privacyMode: RoomPrivacyMode) => Promise<RoomSnapshot>;
  onUpdateRoomPassword: (password: string | null) => Promise<RoomSnapshot>;
  onRotateInvitation: () => Promise<string>;
  onInitiateHostTransfer: (targetDeviceId: string) => Promise<RoomSnapshot>;
  onCancelHostTransfer: () => Promise<RoomSnapshot>;
  onRespondHostTransfer: (accept: boolean) => Promise<void>;
  onRestoreSession: () => Promise<void>;
  onCloseRoom: () => Promise<void>;
  onLeaveRoom: () => Promise<void>;
  onNavigate: (destination: StudioDestination) => void;
}

const PRIVACY_OPTIONS: Array<{
  mode: RoomPrivacyMode;
  label: string;
  summary: string;
}> = [
  {
    mode: 'private',
    label: 'Private',
    summary: 'Only participants with a valid invitation link can request access. Host approval still required.',
  },
  {
    mode: 'approval_required',
    label: 'Approval Required',
    summary: 'Participants with the room code or invitation link wait in the pending queue for host approval.',
  },
  {
    mode: 'open',
    label: 'Open',
    summary: 'Anyone with the room code or invitation link (and password if set) joins an open slot automatically.',
  },
];

function formatDurationSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function formatClockTimestamp(iso?: string | null): string {
  if (!iso) return 'Unavailable';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'Unavailable';
  return new Date(parsed).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function privacyLabel(mode?: RoomPrivacyMode): string {
  if (mode === 'private') return 'Private';
  if (mode === 'open') return 'Open';
  return 'Approval Required';
}

export function SessionManagementDashboard({
  deviceId,
  activeRoom,
  activeRoomRole,
  inviteCode,
  signalingState,
  backendHealth,
  webrtcState,
  onCreateRoom,
  onRenameRoom,
  onUpdatePrivacyMode,
  onUpdateRoomPassword,
  onRotateInvitation,
  onInitiateHostTransfer,
  onCancelHostTransfer,
  onRespondHostTransfer,
  onRestoreSession,
  onCloseRoom,
  onLeaveRoom,
  onNavigate,
}: SessionManagementDashboardProps) {
  const isHost = Boolean(activeRoom && (activeRoomRole === 'host' || activeRoom.hostDeviceId === deviceId));

  // Clock tick for live session duration
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!activeRoom) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeRoom]);

  // Empty-state room creation fields
  const [createRoomName, setCreateRoomName] = useState('');
  const [createPrivacy, setCreatePrivacy] = useState<RoomPrivacyMode>('approval_required');
  const [createPassword, setCreatePassword] = useState('');

  // Active room editing states
  const [editingRoomName, setEditingRoomName] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [selectedTransferTarget, setSelectedTransferTarget] = useState('');
  const [confirmEndOpen, setConfirmEndOpen] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<'invite' | 'code' | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const invitationUrl = useMemo(() => {
    if (!activeRoom || typeof window === 'undefined') return '';
    if (inviteCode) {
      return `${window.location.origin}/?room=${encodeURIComponent(activeRoom.roomId)}&invite=${encodeURIComponent(inviteCode)}`;
    }
    return `${window.location.origin}/?room=${encodeURIComponent(activeRoom.roomId)}`;
  }, [activeRoom, inviteCode]);

  useEffect(() => {
    let cancelled = false;
    if (!activeRoom || !invitationUrl || !isHost || !inviteCode) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(invitationUrl, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#141414',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoom, invitationUrl, isHost, inviteCode]);

  useEffect(() => {
    if (!activeRoom) {
      setConfirmEndOpen(false);
      setEditingRoomName(false);
      setSelectedTransferTarget('');
      return;
    }
    const connectedReceivers = activeRoom.pairedReceivers.filter((r) => r.connected && r.deviceId !== deviceId);
    if (
      connectedReceivers.length > 0 &&
      !connectedReceivers.some((r) => r.deviceId === selectedTransferTarget)
    ) {
      setSelectedTransferTarget(connectedReceivers[0].deviceId);
    } else if (connectedReceivers.length === 0) {
      setSelectedTransferTarget('');
    }
  }, [activeRoom, deviceId, selectedTransferTarget]);

  const lastParticipantActivityIso = useMemo(() => {
    if (!activeRoom) return null;
    const timestamps: number[] = [];
    const pushIso = (iso?: string) => {
      if (!iso) return;
      const t = Date.parse(iso);
      if (Number.isFinite(t)) timestamps.push(t);
    };
    pushIso(activeRoom.hostLastSeenAt);
    for (const r of activeRoom.pairedReceivers) pushIso(r.lastSeenAt ?? r.pairedAt);
    for (const p of activeRoom.pendingRequests) pushIso(p.lastSeenAt ?? p.requestedAt);
    if (timestamps.length === 0) return null;
    return new Date(Math.max(...timestamps)).toISOString();
  }, [activeRoom]);

  const handleCopyText = async (key: 'invite' | 'code', text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      setFeedback({ tone: 'error', text: 'Clipboard permission denied by browser.' });
    }
  };

  if (!activeRoom) {
    return (
      <div data-castora-chrome className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#797D82]">
              05 · SESSION GOVERNANCE
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-[#141414]">
              Session Management
            </h1>
            <p className="mt-1 text-sm text-[#5C6063]">
              Configure room identity, privacy mode, optional password protection, invitations, and host ownership.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('receivers')}
            className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#D5D7DE] bg-white px-4 text-sm font-medium text-[#141414] transition-colors hover:border-[#141414]"
          >
            <span>Join via Code or Link</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {feedback && (
          <div
            role={feedback.tone === 'error' ? 'alert' : 'status'}
            className={`rounded-xl border px-4 py-3 text-sm ${
              feedback.tone === 'error'
                ? 'border-[#DC2626]/30 bg-[#FEF2F2] text-[#B91C1C]'
                : 'border-[#D5D7DE] bg-white text-[#141414]'
            }`}
          >
            {feedback.text}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFeedback(null);
            setBusyAction('create');
            const trimmedPwd = createPassword;
            setCreatePassword('');
            void onCreateRoom({
              roomName: createRoomName.trim() || undefined,
              privacyMode: createPrivacy,
              password: trimmedPwd.length > 0 ? trimmedPwd : undefined,
            })
              .then((created) => {
                setCreateRoomName('');
                setFeedback({
                  tone: 'info',
                  text: `Session "${created.roomName ?? created.roomId}" (${created.roomId}) is active.`,
                });
              })
              .catch((err) => {
                setFeedback({
                  tone: 'error',
                  text: err instanceof Error ? err.message : 'Unable to create session',
                });
              })
              .finally(() => setBusyAction(null));
          }}
          className="castora-card p-6 space-y-5 max-w-2xl"
        >
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight text-[#141414]">
              Start a Managed Session
            </h2>
            <p className="mt-1 text-sm text-[#5C6063]">
              Create a new room with custom privacy rules and an optional hashed password.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label htmlFor="session-create-name" className="block font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Room Name (optional)
              </label>
              <input
                id="session-create-name"
                type="text"
                maxLength={64}
                value={createRoomName}
                onChange={(e) => setCreateRoomName(e.target.value)}
                placeholder="Design Review · Studio A"
                className="mt-1.5 h-11 w-full rounded-[10px] border border-[#D5D7DE] bg-[#FAFAFA] px-3.5 text-sm text-[#141414] placeholder:text-[#797D82] focus:border-[#FF6041] focus:bg-white focus:outline-none"
              />
            </div>

            <div>
              <span className="block font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Privacy Mode</span>
              <div className="mt-1.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                {PRIVACY_OPTIONS.map((opt) => (
                  <button
                    key={opt.mode}
                    type="button"
                    onClick={() => setCreatePrivacy(opt.mode)}
                    className={`rounded-[10px] border p-3 text-left transition-colors ${
                      createPrivacy === opt.mode
                        ? 'border-[#FF6041] bg-[#FFF4F1]'
                        : 'border-[#D5D7DE] bg-[#FAFAFA] hover:bg-white'
                    }`}
                  >
                    <div className="text-xs font-semibold text-[#141414]">{opt.label}</div>
                    <p className="mt-1 text-[11px] leading-relaxed text-[#5C6063]">{opt.summary}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="session-create-password" className="block font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Optional Room Password (4–64 characters)
              </label>
              <input
                id="session-create-password"
                type="password"
                maxLength={64}
                autoComplete="new-password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                placeholder="Leave blank for no password"
                className="mt-1.5 h-11 w-full rounded-[10px] border border-[#D5D7DE] bg-[#FAFAFA] px-3.5 text-sm text-[#141414] placeholder:text-[#797D82] focus:border-[#FF6041] focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={busyAction !== null}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-[10px] bg-[#141414] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#FF6041] disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>{busyAction === 'create' ? 'Creating Session...' : 'Create Session Room'}</span>
          </button>
        </form>
      </div>
    );
  }

  const createdMs = activeRoom.createdAt ? Date.parse(activeRoom.createdAt) : NaN;
  const durationSec = Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 1000) : 0;
  const availableSlots = Math.max(0, activeRoom.maxReceivers - activeRoom.pairedReceiverCount);
  const connectedTotal =
    (activeRoom.hostConnected ? 1 : 0) +
    activeRoom.pairedReceivers.filter((r) => r.connected).length;
  const incomingStreamCount = webrtcState.incomingStreams.filter((s) => s.stream !== null).length;
  const outgoingStreamCount = webrtcState.outboundPeers.filter((o) => o.phase === 'connected').length;
  const totalTrackedRoomStreams = activeRoom.activeStreams?.length ?? 0;

  const healthTone: SignalTone =
    signalingState === 'connected'
      ? activeRoom.hostConnected
        ? 'active'
        : 'warn'
      : signalingState === 'connecting'
        ? 'signal'
        : 'fault';
  const healthLabel =
    signalingState === 'connected'
      ? activeRoom.hostConnected
        ? 'Healthy'
        : 'Host Offline'
      : signalingState === 'connecting'
        ? 'Reconnecting'
        : 'Disconnected';

  const eligibleTransferTargets = activeRoom.pairedReceivers.filter(
    (r) => r.connected && r.deviceId !== activeRoom.hostDeviceId
  );

  return (
    <div data-castora-chrome className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#797D82]">
            05 · SESSION GOVERNANCE
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-2xl font-semibold tracking-tight text-[#141414]">
              {activeRoom.roomName || `Room ${activeRoom.roomId}`}
            </h1>
            <SignalBadge label={privacyLabel(activeRoom.privacyMode)} tone="signal" />
            {activeRoom.passwordProtected && (
              <SignalBadge label="Password Protected" tone="warn" />
            )}
          </div>
          <p className="mt-1 text-xs text-[#5C6063] tabular-metrics">
            Room <span className="font-mono font-semibold text-[#141414]">{activeRoom.roomId}</span>
            {' · '}Host: <span className="font-medium text-[#141414]">{activeRoom.hostDeviceName}</span>
            {' · '}Your Role: <span className="font-medium text-[#141414]">{isHost ? 'Host' : 'Participant'}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => {
              setFeedback(null);
              setBusyAction('restore');
              void onRestoreSession()
                .then(() => {
                  setFeedback({ tone: 'info', text: 'Session state synchronized with signaling backend.' });
                })
                .catch((err) => {
                  setFeedback({
                    tone: 'error',
                    text: err instanceof Error ? err.message : 'Unable to refresh session state',
                  });
                })
                .finally(() => setBusyAction(null));
            }}
            className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#D5D7DE] bg-white px-3.5 text-sm font-medium text-[#141414] transition-colors hover:border-[#141414] disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            <span>{busyAction === 'restore' ? 'Syncing...' : 'Verify Session'}</span>
          </button>

          {isHost ? (
            confirmEndOpen ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => {
                    setBusyAction('close');
                    void onCloseRoom()
                      .catch((err) => {
                        setFeedback({
                          tone: 'error',
                          text: err instanceof Error ? err.message : 'Failed to end session',
                        });
                      })
                      .finally(() => {
                        setBusyAction(null);
                        setConfirmEndOpen(false);
                      });
                  }}
                  className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-[#DC2626] px-4 text-sm font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-50"
                >
                  <span>{busyAction === 'close' ? 'Ending...' : 'Confirm End Session'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmEndOpen(false)}
                  className="inline-flex h-10 items-center rounded-[10px] border border-[#D5D7DE] bg-white px-3 text-sm font-medium text-[#5C6063] hover:text-[#141414]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmEndOpen(true)}
                className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#DC2626]/30 bg-white px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEF2F2]"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>End Session</span>
              </button>
            )
          ) : (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => {
                setBusyAction('leave');
                void onLeaveRoom()
                  .catch((err) => {
                    setFeedback({
                      tone: 'error',
                      text: err instanceof Error ? err.message : 'Unable to leave room',
                    });
                  })
                  .finally(() => setBusyAction(null));
              }}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#DC2626]/30 bg-white px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>{busyAction === 'leave' ? 'Leaving...' : 'Leave Session'}</span>
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
              : 'border-[#D5D7DE] bg-white text-[#141414]'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Session Overview Strip */}
      <section
        aria-label="Session Overview Metrics"
        className="castora-card overflow-hidden"
      >
        <div className="grid grid-cols-1 divide-y divide-[#D5D7DE] sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
          <div className="p-5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Session Duration</span>
            </div>
            <div className="mt-1.5 font-mono text-2xl font-bold text-[#141414] tabular-metrics">
              {Number.isFinite(createdMs) ? formatDurationSeconds(durationSec) : 'Unavailable'}
            </div>
            <div className="mt-1 text-xs text-[#5C6063] tabular-metrics">
              Created {formatClockTimestamp(activeRoom.createdAt)} · Expires{' '}
              {formatClockTimestamp(activeRoom.expiresAt)}
            </div>
          </div>

          <div className="p-5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Room Capacity &amp; Queue</span>
            </div>
            <div className="mt-1.5 text-2xl font-bold text-[#141414] tabular-metrics">
              {activeRoom.pairedReceiverCount} / {activeRoom.maxReceivers}
            </div>
            <div className="mt-1 text-xs text-[#5C6063] tabular-metrics">
              {connectedTotal} online · {availableSlots} slots open · {activeRoom.pendingCount} pending
            </div>
          </div>

          <div className="p-5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Active Streams</div>
            <div className="mt-1.5 text-2xl font-bold text-[#141414] tabular-metrics">
              {incomingStreamCount} in · {outgoingStreamCount} out
            </div>
            <div className="mt-1 text-xs text-[#5C6063] tabular-metrics">
              {totalTrackedRoomStreams} active room stream{totalTrackedRoomStreams === 1 ? '' : 's'}
            </div>
          </div>

          <div className="p-5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Connection Health</div>
            <div className="mt-2 flex items-center gap-2">
              <SignalBadge label={healthLabel} tone={healthTone} pulse={signalingState === 'connecting'} />
              <span className="text-xs text-[#5C6063]">
                {backendHealth?.turnConfigured ? `TURN (${backendHealth.turnMode})` : 'P2P / STUN'}
              </span>
            </div>
            <div className="mt-1.5 text-xs text-[#5C6063] tabular-metrics">
              Last activity: {formatClockTimestamp(lastParticipantActivityIso)}
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column: Room Info, Privacy, Password */}
        <div className="space-y-6 lg:col-span-6">
          {/* Room Information & Rename */}
          <section className="castora-card p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-[#D5D7DE] pb-3">
              <h2 className="font-display text-base font-semibold text-[#141414]">
                Room Details
              </h2>
              {isHost && !editingRoomName && (
                <button
                  type="button"
                  onClick={() => {
                    setRoomNameDraft(activeRoom.roomName ?? `Room ${activeRoom.roomId}`);
                    setEditingRoomName(true);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-2.5 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414] hover:bg-white"
                >
                  <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Rename Room</span>
                </button>
              )}
            </div>

            {editingRoomName && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setFeedback(null);
                  setBusyAction('rename');
                  void onRenameRoom(roomNameDraft)
                    .then((updated) => {
                      setEditingRoomName(false);
                      setFeedback({
                        tone: 'info',
                        text: `Room renamed to "${updated.roomName ?? updated.roomId}".`,
                      });
                    })
                    .catch((err) => {
                      setFeedback({
                        tone: 'error',
                        text: err instanceof Error ? err.message : 'Unable to rename room',
                      });
                    })
                    .finally(() => setBusyAction(null));
                }}
                className="flex flex-col gap-2 sm:flex-row"
              >
                <label htmlFor="session-rename-input" className="sr-only">
                  Room Name
                </label>
                <input
                  id="session-rename-input"
                  type="text"
                  maxLength={64}
                  value={roomNameDraft}
                  onChange={(e) => setRoomNameDraft(e.target.value)}
                  className="h-10 flex-1 rounded-[10px] border border-[#D5D7DE] bg-[#FAFAFA] px-3 text-sm text-[#141414] focus:border-[#FF6041] focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={busyAction !== null}
                  className="inline-flex h-10 items-center justify-center rounded-[10px] bg-[#141414] px-4 text-xs font-semibold text-white transition-colors hover:bg-[#FF6041] disabled:opacity-50"
                >
                  {busyAction === 'rename' ? 'Saving...' : 'Save Name'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingRoomName(false)}
                  className="inline-flex h-10 items-center justify-center rounded-[10px] border border-[#D5D7DE] px-3 text-xs font-medium text-[#5C6063] hover:text-[#141414]"
                >
                  Cancel
                </button>
              </form>
            )}

            <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Room Name</dt>
                <dd className="mt-0.5 font-medium text-[#141414]">
                  {activeRoom.roomName || `Room ${activeRoom.roomId}`}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Room ID</dt>
                <dd className="mt-0.5 font-mono font-semibold text-[#141414] tabular-metrics">
                  {activeRoom.roomId}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Current Host</dt>
                <dd className="mt-0.5 font-medium text-[#141414]">
                  {activeRoom.hostDeviceName}{' '}
                  <span className="text-[#5C6063]">
                    ({activeRoom.hostConnected ? 'Connected' : 'Temporarily disconnected'})
                  </span>
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Created</dt>
                <dd className="mt-0.5 text-[#141414] tabular-metrics">
                  {activeRoom.createdAt ? new Date(activeRoom.createdAt).toLocaleString() : 'Unavailable'}
                </dd>
              </div>
            </dl>
          </section>

          {/* Privacy Mode Card */}
          <section className="castora-card p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-[#D5D7DE] pb-3">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-[#FF6041]" aria-hidden="true" />
                <h2 className="font-display text-base font-semibold text-[#141414]">
                  Privacy Mode
                </h2>
              </div>
              <SignalBadge label={privacyLabel(activeRoom.privacyMode)} tone="signal" />
            </div>

            <div className="space-y-2.5">
              {PRIVACY_OPTIONS.map((opt) => {
                const selected = (activeRoom.privacyMode ?? 'approval_required') === opt.mode;
                return (
                  <button
                    key={opt.mode}
                    type="button"
                    disabled={!isHost || busyAction !== null}
                    onClick={() => {
                      if (selected) return;
                      setFeedback(null);
                      setBusyAction(`privacy-${opt.mode}`);
                      void onUpdatePrivacyMode(opt.mode)
                        .then(() => {
                          setFeedback({
                            tone: 'info',
                            text: `Room privacy updated to ${opt.label}.`,
                          });
                        })
                        .catch((err) => {
                          setFeedback({
                            tone: 'error',
                            text: err instanceof Error ? err.message : 'Unable to update privacy mode',
                          });
                        })
                        .finally(() => setBusyAction(null));
                    }}
                    className={`w-full rounded-[10px] border p-3.5 text-left transition-colors ${
                      selected
                        ? 'border-[#FF6041] bg-[#FFF4F1]'
                        : 'border-[#D5D7DE] bg-[#FAFAFA] hover:bg-white'
                    } disabled:cursor-default disabled:opacity-80`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[#141414]">{opt.label}</span>
                      {selected && <Check className="h-4 w-4 text-[#FF6041]" aria-hidden="true" />}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-[#5C6063]">{opt.summary}</p>
                  </button>
                );
              })}
            </div>
            {!isHost && (
              <p className="text-xs text-[#5C6063]">
                Only the current authorized host can change room privacy policies.
              </p>
            )}
          </section>

          {/* Optional Room Password Card */}
          <section className="castora-card p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-[#D5D7DE] pb-3">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-[#FF6041]" aria-hidden="true" />
                <h2 className="font-display text-base font-semibold text-[#141414]">
                  Room Password
                </h2>
              </div>
              <SignalBadge
                label={activeRoom.passwordProtected ? 'Protected' : 'No Password'}
                tone={activeRoom.passwordProtected ? 'warn' : 'standby'}
              />
            </div>

            {isHost ? (
              <div className="space-y-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const candidate = passwordDraft;
                    setPasswordDraft('');
                    setFeedback(null);
                    setBusyAction('password');
                    void onUpdateRoomPassword(candidate)
                      .then(() => {
                        setFeedback({
                          tone: 'info',
                          text: activeRoom.passwordProtected
                            ? 'Room password updated and stored securely on the server.'
                            : 'Room password enabled and stored securely on the server.',
                        });
                      })
                      .catch((err) => {
                        setFeedback({
                          tone: 'error',
                          text: err instanceof Error ? err.message : 'Unable to update room password',
                        });
                      })
                      .finally(() => setBusyAction(null));
                  }}
                  className="flex flex-col gap-2 sm:flex-row"
                >
                  <label htmlFor="session-password-input" className="sr-only">
                    New Room Password
                  </label>
                  <input
                    id="session-password-input"
                    type="password"
                    minLength={4}
                    maxLength={64}
                    autoComplete="new-password"
                    value={passwordDraft}
                    onChange={(e) => setPasswordDraft(e.target.value)}
                    placeholder={
                      activeRoom.passwordProtected
                        ? 'Enter new password (4–64 chars)'
                        : 'Set optional password (4–64 chars)'
                    }
                    className="h-10 flex-1 rounded-[10px] border border-[#D5D7DE] bg-[#FAFAFA] px-3 text-sm text-[#141414] placeholder:text-[#797D82] focus:border-[#FF6041] focus:bg-white focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={busyAction !== null || passwordDraft.length < 4}
                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] bg-[#141414] px-4 text-xs font-semibold text-white transition-colors hover:bg-[#FF6041] disabled:opacity-50"
                  >
                    <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {busyAction === 'password'
                        ? 'Saving...'
                        : activeRoom.passwordProtected
                          ? 'Change Password'
                          : 'Set Password'}
                    </span>
                  </button>
                </form>

                {activeRoom.passwordProtected && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => {
                      setFeedback(null);
                      setBusyAction('remove-password');
                      void onUpdateRoomPassword(null)
                        .then(() => {
                          setFeedback({
                            tone: 'info',
                            text: 'Room password removed.',
                          });
                        })
                        .catch((err) => {
                          setFeedback({
                            tone: 'error',
                            text: err instanceof Error ? err.message : 'Unable to remove password',
                          });
                        })
                        .finally(() => setBusyAction(null));
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#DC2626]/30 bg-white px-3 text-xs font-medium text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{busyAction === 'remove-password' ? 'Removing...' : 'Remove Password'}</span>
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-[#5C6063]">
                {activeRoom.passwordProtected
                  ? 'This room requires a password validated securely by the server.'
                  : 'No room password is currently set by the host.'}
              </p>
            )}
          </section>
        </div>

        {/* Right Column: Invitation & QR, Host Transfer, Participant Overview */}
        <div className="space-y-6 lg:col-span-6">
          {/* Invitation & QR Code Card */}
          <section className="castora-card p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-[#D5D7DE] pb-3">
              <div className="flex items-center gap-2">
                <QrCode className="h-4 w-4 text-[#FF6041]" aria-hidden="true" />
                <h2 className="font-display text-base font-semibold text-[#141414]">
                  Room Invitation &amp; QR Code
                </h2>
              </div>
              {isHost && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => {
                    setFeedback(null);
                    setBusyAction('rotate-invite');
                    void onRotateInvitation()
                      .then(() => {
                        setFeedback({
                          tone: 'info',
                          text: 'Generated a new invitation link. Previous invitation links have been revoked.',
                        });
                      })
                      .catch((err) => {
                        setFeedback({
                          tone: 'error',
                          text: err instanceof Error ? err.message : 'Unable to rotate invitation link',
                        });
                      })
                      .finally(() => setBusyAction(null));
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-2.5 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414] hover:bg-white disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{busyAction === 'rotate-invite' ? 'Rotating...' : 'Rotate Link'}</span>
                </button>
              )}
            </div>

            {isHost ? (
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <div className="flex h-[180px] w-[180px] shrink-0 items-center justify-center rounded-xl border border-[#D5D7DE] bg-white p-2">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`QR invitation for room ${activeRoom.roomId}`}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="text-center text-xs text-[#5C6063]">
                      {inviteCode ? 'Rendering QR...' : 'Sync session to load invitation QR'}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">Shareable Invitation Link</div>
                    <div className="mt-1 break-all rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-3 py-2 font-mono text-[11px] text-[#141414]">
                      {inviteCode
                        ? invitationUrl
                        : 'Click Verify Session above to load host invitation link.'}
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-[#5C6063]">
                    Invitation links identify the room without exposing authentication tokens. Existing room privacy and password rules still apply.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={!inviteCode}
                      onClick={() => void handleCopyText('invite', invitationUrl)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#141414] px-3.5 text-xs font-semibold text-white transition-colors hover:bg-[#FF6041] disabled:opacity-50"
                    >
                      {copiedKey === 'invite' ? (
                        <>
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Invitation Copied</span>
                        </>
                      ) : (
                        <>
                          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy Invitation</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyText('code', activeRoom.roomId)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-white px-3 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414]"
                    >
                      {copiedKey === 'code' ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-[#16A34A]" aria-hidden="true" />
                          <span className="text-[#16A34A]">Code Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy Room Code</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2 text-xs leading-relaxed text-[#5C6063]">
                <p>
                  Invitation links and QR rotation are restricted to the room host to protect Private room access control.
                </p>
                {activeRoom.privacyMode !== 'private' && (
                  <button
                    type="button"
                    onClick={() => void handleCopyText('code', activeRoom.roomId)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-white px-3 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414]"
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{copiedKey === 'code' ? 'Code Copied' : `Copy Room Code (${activeRoom.roomId})`}</span>
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Host Ownership & Secure Transfer Card */}
          <section className="castora-card p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2 border-b border-[#D5D7DE] pb-3">
              <ShieldCheck className="h-4 w-4 text-[#FF6041]" aria-hidden="true" />
              <h2 className="font-display text-base font-semibold text-[#141414]">
                Host Ownership &amp; Transfer
              </h2>
            </div>

            {activeRoom.hostTransfer && (
              <div className="rounded-xl border border-[#FF6041]/35 bg-[#FFF4F1] p-4 space-y-3">
                <div className="text-xs font-semibold text-[#141414]">
                  Pending Host Transfer → {activeRoom.hostTransfer.targetDeviceName}
                </div>
                <p className="text-xs text-[#5C6063] tabular-metrics">
                  Request expires at {formatClockTimestamp(activeRoom.hostTransfer.expiresAt)}. Active streams remain live during ownership handoff.
                </p>

                {activeRoom.hostTransfer.targetDeviceId === deviceId && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => {
                        setFeedback(null);
                        setBusyAction('accept-transfer');
                        void onRespondHostTransfer(true)
                          .then(() => {
                            setFeedback({
                              tone: 'info',
                              text: 'You are now the authorized host of this room.',
                            });
                          })
                          .catch((err) => {
                            setFeedback({
                              tone: 'error',
                              text: err instanceof Error ? err.message : 'Transfer acceptance failed',
                            });
                          })
                          .finally(() => setBusyAction(null));
                      }}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#141414] px-3.5 text-xs font-semibold text-white transition-colors hover:bg-[#FF6041] disabled:opacity-50"
                    >
                      <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{busyAction === 'accept-transfer' ? 'Accepting...' : 'Accept Host Role'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => {
                        setFeedback(null);
                        setBusyAction('decline-transfer');
                        void onRespondHostTransfer(false)
                          .then(() => {
                            setFeedback({
                              tone: 'info',
                              text: 'Declined host transfer request.',
                            });
                          })
                          .catch((err) => {
                            setFeedback({
                              tone: 'error',
                              text: err instanceof Error ? err.message : 'Unable to decline transfer',
                            });
                          })
                          .finally(() => setBusyAction(null));
                      }}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-white px-3 text-xs font-medium text-[#141414] hover:bg-[#FAFAFA] disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Decline</span>
                    </button>
                  </div>
                )}

                {isHost && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => {
                      setFeedback(null);
                      setBusyAction('cancel-transfer');
                      void onCancelHostTransfer()
                        .then(() => {
                          setFeedback({ tone: 'info', text: 'Cancelled pending host transfer.' });
                        })
                        .catch((err) => {
                          setFeedback({
                            tone: 'error',
                            text: err instanceof Error ? err.message : 'Unable to cancel transfer',
                          });
                        })
                        .finally(() => setBusyAction(null));
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-white px-3 text-xs font-medium text-[#141414] hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Cancel Pending Transfer</span>
                  </button>
                )}
              </div>
            )}

            {isHost ? (
              eligibleTransferTargets.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-xs leading-relaxed text-[#5C6063]">
                    Room ownership stays bound to you across temporary network drops. To hand off host permissions without interrupting active streams, choose a connected participant below—they must explicitly accept.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <label htmlFor="host-transfer-target" className="sr-only">
                      Target Participant for Host Transfer
                    </label>
                    <select
                      id="host-transfer-target"
                      value={selectedTransferTarget}
                      disabled={Boolean(activeRoom.hostTransfer) || busyAction !== null}
                      onChange={(e) => setSelectedTransferTarget(e.target.value)}
                      className="h-10 flex-1 rounded-[10px] border border-[#D5D7DE] bg-[#FAFAFA] px-3 text-sm text-[#141414] focus:border-[#FF6041] focus:bg-white focus:outline-none disabled:opacity-50"
                    >
                      {eligibleTransferTargets.map((member) => (
                        <option key={member.deviceId} value={member.deviceId}>
                          {member.deviceName} ({member.deviceType ?? member.platform})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={
                        !selectedTransferTarget ||
                        Boolean(activeRoom.hostTransfer) ||
                        busyAction !== null
                      }
                      onClick={() => {
                        if (!selectedTransferTarget) return;
                        setFeedback(null);
                        setBusyAction('initiate-transfer');
                        void onInitiateHostTransfer(selectedTransferTarget)
                          .then((updated) => {
                            setFeedback({
                              tone: 'info',
                              text: `Transfer request sent to ${updated.hostTransfer?.targetDeviceName ?? selectedTransferTarget}. Waiting for explicit acceptance.`,
                            });
                          })
                          .catch((err) => {
                            setFeedback({
                              tone: 'error',
                              text: err instanceof Error ? err.message : 'Unable to initiate host transfer',
                            });
                          })
                          .finally(() => setBusyAction(null));
                      }}
                      className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[10px] border border-[#D5D7DE] bg-white px-4 text-xs font-semibold text-[#141414] transition-colors hover:border-[#141414] disabled:opacity-50"
                    >
                      <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{busyAction === 'initiate-transfer' ? 'Sending...' : 'Transfer Host'}</span>
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-xs leading-relaxed text-[#5C6063]">
                  Host ownership is preserved across temporary disconnections. Connect and pair another device to transfer host permissions cleanly.
                </p>
              )
            ) : (
              <p className="text-xs leading-relaxed text-[#5C6063]">
                Room ownership stays reserved for {activeRoom.hostDeviceName} even if their socket disconnects briefly. If they initiate a host transfer to you, an acceptance prompt will appear here.
              </p>
            )}
          </section>

          {/* Participant Overview Card */}
          <section className="castora-card p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-[#D5D7DE] pb-3">
              <h2 className="font-display text-base font-semibold text-[#141414]">
                Participant Overview
              </h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onNavigate('devices')}
                  className="text-xs font-medium text-[#FF6041] hover:underline"
                >
                  Device Controls
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('receivers')}
                  className="text-xs font-medium text-[#FF6041] hover:underline"
                >
                  Approvals ({activeRoom.pendingCount})
                </button>
              </div>
            </div>

            <ul className="divide-y divide-[#D5D7DE] text-xs">
              <li className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <span className="font-semibold text-[#141414]">{activeRoom.hostDeviceName}</span>
                  <span className="ml-2 text-[#5C6063]">
                    Host · {activeRoom.hostDeviceType ?? activeRoom.hostPlatform}
                  </span>
                </div>
                <SignalBadge
                  label={activeRoom.hostConnected ? 'Connected' : 'Disconnected'}
                  tone={activeRoom.hostConnected ? 'active' : 'warn'}
                />
              </li>

              {activeRoom.pairedReceivers.map((rx) => (
                <li key={rx.deviceId} className="flex items-center justify-between gap-3 py-2.5">
                  <div>
                    <span className="font-semibold text-[#141414]">{rx.deviceName}</span>
                    <span className="ml-2 text-[#5C6063] tabular-metrics">
                      Slot {rx.assignedSlotIndex + 1} · {rx.deviceType ?? rx.platform}
                    </span>
                  </div>
                  <SignalBadge
                    label={rx.connected ? 'Paired' : 'Disconnected'}
                    tone={rx.connected ? 'active' : 'warn'}
                  />
                </li>
              ))}

              {activeRoom.pendingRequests.map((req) => (
                <li key={req.deviceId} className="flex items-center justify-between gap-3 py-2.5">
                  <div>
                    <span className="font-semibold text-[#141414]">{req.deviceName}</span>
                    <span className="ml-2 text-[#5C6063]">
                      Pending · {req.deviceType ?? req.platform}
                    </span>
                  </div>
                  <SignalBadge label="Awaiting Approval" tone="signal" />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
