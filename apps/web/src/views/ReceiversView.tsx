import { useState } from 'react';
import { Cast, Check, LogOut, QrCode, ScanLine, ShieldCheck, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import type {
  PairingLifecycleStatus,
  RoomSnapshot,
  SignalingSocketState,
} from '../services/backendClient';
import type { WebRtcSessionSnapshot } from '../services/webrtcSignalingBridge';
import type {
  BrowserCapabilityReport,
  StudioDestination,
  WebRtcConnectionPhase,
} from '../types/studio';
import { SignalBadge, type SignalTone } from '../components/common/SignalBadge';
import { TelemetryStrip } from '../components/common/TelemetryStrip';
import { VideoSurface } from '../components/common/VideoSurface';

interface ReceiversViewProps {
  deviceId: string;
  deviceName: string;
  capabilities: BrowserCapabilityReport;
  initialRoomCode: string;
  activePhase: WebRtcConnectionPhase;
  signalingState: SignalingSocketState;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  pairingStatus: PairingLifecycleStatus;
  pairingDetail: string | null;
  webrtcState: WebRtcSessionSnapshot;
  onCreateRoom: () => Promise<RoomSnapshot>;
  onSubmitPairRequest: (roomId: string) => Promise<RoomSnapshot>;
  onApproveReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onRejectReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onRemoveReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onLeaveRoom: () => Promise<void>;
  onCloseRoom: () => Promise<void>;
  onNavigate: (destination: StudioDestination) => void;
  onLogEvent: (category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error', title: string, detail: string) => void;
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

function webrtcPhaseToBadge(phase: WebRtcConnectionPhase): { label: string; tone: SignalTone; pulse?: boolean } {
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
      return { label: 'WAITING FOR HOST', tone: 'standby' };
  }
}

export function ReceiversView({
  deviceId,
  deviceName,
  capabilities,
  initialRoomCode,
  activePhase,
  signalingState,
  activeRoom,
  activeRoomRole,
  pairingStatus,
  pairingDetail,
  webrtcState,
  onCreateRoom,
  onSubmitPairRequest,
  onApproveReceiver,
  onRejectReceiver,
  onRemoveReceiver,
  onLeaveRoom,
  onCloseRoom,
  onNavigate,
  onLogEvent,
}: ReceiversViewProps) {
  const [mode, setMode] = useState<'join' | 'host'>(
    activeRoomRole === 'host' ? 'host' : 'join'
  );
  const [roomCode, setRoomCode] = useState<string>(initialRoomCode);
  const [qrInput, setQrInput] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [receiverMuted, setReceiverMuted] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const pendingRequests = activeRoom?.pendingRequests ?? [];
  const pairedReceivers = activeRoom?.pairedReceivers ?? [];
  const myPairedSlot = pairedReceivers.find((r) => r.deviceId === deviceId);
  const webrtcBadge = webrtcPhaseToBadge(webrtcState.phase);

  const handleRoomInputChange = (raw: string) => {
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    setRoomCode(cleaned);
    if (feedback?.tone === 'error') {
      setFeedback(null);
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
    try {
      const submitted = await onSubmitPairRequest(roomCode);
      setFeedback({
        tone: 'info',
        text: `Pairing request submitted to room ${submitted.roomId} (${submitted.hostDeviceName}). Awaiting host approval.`,
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
      setFeedback({ tone: 'error', text: 'Paste a Castora join URL or 6-character room code first.' });
      return;
    }
    try {
      const url = new URL(trimmed);
      const paramRoom = (url.searchParams.get('room') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (ROOM_CODE_PATTERN.test(paramRoom)) {
        setRoomCode(paramRoom);
        setFeedback({ tone: 'info', text: `Extracted room code ${paramRoom} from join URL.` });
        onLogEvent('ui', 'Parsed QR join URL', `Extracted room code ${paramRoom}.`);
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

    setFeedback({ tone: 'error', text: 'Could not extract a valid 6-character room code from input.' });
  };

  const handleCreateRoom = async () => {
    setBusy(true);
    try {
      const created = await onCreateRoom();
      setFeedback({
        tone: 'info',
        text: `Room ${created.roomId} active until ${new Date(created.expiresAt).toLocaleTimeString()}.`,
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
      setFeedback({ tone: 'info', text: 'Room closed and all receiver sessions detached.' });
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
      setFeedback({ tone: 'info', text: 'Left room cleanly.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to leave room';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const runHostDecision = async (
    targetDeviceId: string,
    action: 'approve' | 'reject' | 'remove'
  ) => {
    setActionId(targetDeviceId);
    try {
      if (action === 'approve') {
        await onApproveReceiver(targetDeviceId);
        setFeedback({ tone: 'info', text: `Approved receiver ${targetDeviceId}.` });
      } else if (action === 'reject') {
        await onRejectReceiver(targetDeviceId);
        setFeedback({ tone: 'info', text: `Rejected request from ${targetDeviceId}.` });
      } else {
        await onRemoveReceiver(targetDeviceId);
        setFeedback({ tone: 'info', text: `Removed paired receiver ${targetDeviceId}.` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      setFeedback({ tone: 'error', text: message });
    } finally {
      setActionId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
            Receivers &amp; Pairing
          </h1>
          <p className="text-xs text-[#929A9D]">
            Server-verified room codes, explicit host approval, and up to 6 paired receivers per room.
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
              activePhase === 'connected'
                ? 'STREAM LIVE'
                : activeRoom
                  ? `ROOM ${activeRoom.roomId}`
                  : signalingState === 'connected'
                    ? 'WS ONLINE'
                    : 'STANDBY'
            }
            tone={
              activePhase === 'connected' || signalingState === 'connected'
                ? 'active'
                : 'standby'
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Join / Host Pairing Panel */}
        <section className="space-y-4 lg:col-span-5" aria-label="Room Pairing">
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-4">
            <div className="grid grid-cols-2 border border-[#252A2F] bg-[#131619]">
              <button
                type="button"
                onClick={() => setMode('join')}
                className={`min-h-[44px] text-xs font-semibold tracking-wide transition-colors ${
                  mode === 'join'
                    ? 'bg-[#FF7849] text-[#101214]'
                    : 'text-[#929A9D] hover:text-[#F2F3F0]'
                }`}
              >
                Join Room
              </button>
              <button
                type="button"
                onClick={() => setMode('host')}
                className={`min-h-[44px] text-xs font-semibold tracking-wide transition-colors ${
                  mode === 'host'
                    ? 'bg-[#FF7849] text-[#101214]'
                    : 'text-[#929A9D] hover:text-[#F2F3F0]'
                }`}
              >
                Host Receiver Room
              </button>
            </div>

            {mode === 'join' ? (
              <form onSubmit={handleSubmitJoin} className="space-y-4">
                <div>
                  <label
                    htmlFor="castora-room-code"
                    className="block text-[11px] font-medium uppercase tracking-[0.08em] text-[#929A9D]"
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
                    placeholder="ABC123"
                    disabled={Boolean(activeRoom && activeRoomRole === 'receiver')}
                    className="mt-1.5 h-12 w-full border border-[#252A2F] bg-[#131619] px-3 font-mono text-lg font-semibold tracking-[0.28em] text-[#F2F3F0] placeholder:text-[#929A9D]/40 focus:border-[#FF7849] focus:outline-none tabular-metrics disabled:opacity-60"
                  />
                </div>

                {activeRoom && activeRoomRole === 'receiver' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleLeaveRoom}
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 border border-[#EF4444]/60 bg-[#131619] px-4 text-xs font-semibold text-[#EF4444] hover:bg-[#EF4444]/10 disabled:opacity-50"
                  >
                    <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{busy ? 'Leaving Room...' : `Leave Room ${activeRoom.roomId}`}</span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={busy || activeRoomRole === 'host'}
                    className="inline-flex min-h-[44px] w-full items-center justify-center bg-[#FF7849] px-4 text-xs font-semibold text-[#101214] hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? 'Submitting Request...' : 'Submit Pairing Request'}
                  </button>
                )}

                <div className="border-t border-[#252A2F] pt-3 space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-[#929A9D]">
                    <span className="inline-flex items-center gap-1.5 uppercase tracking-[0.08em]">
                      <ScanLine className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>QR Link / Token</span>
                    </span>
                    <span className="font-mono">
                      BarcodeDetector: {capabilities.supportsBarcodeDetector ? 'YES' : 'NO'}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={qrInput}
                      onChange={(e) => setQrInput(e.target.value)}
                      placeholder="https://.../join?room=K7M4P9"
                      aria-label="Paste QR join URL or room token"
                      className="h-11 flex-1 border border-[#252A2F] bg-[#131619] px-3 text-xs text-[#F2F3F0] placeholder:text-[#929A9D]/50 focus:border-[#FF7849] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleParseQrPayload}
                      className="min-h-[44px] border border-[#252A2F] bg-[#131619] px-3 text-xs font-medium text-[#F2F3F0] hover:border-[#FF7849]"
                    >
                      Parse
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col items-center justify-center border border-[#252A2F] bg-[#131619] px-4 py-6 text-center">
                  <QrCode className="h-8 w-8 text-[#929A9D]" aria-hidden="true" />
                  {activeRoom && activeRoomRole === 'host' ? (
                    <>
                      <p className="mt-3 font-mono text-2xl font-bold tracking-[0.25em] text-[#FF7849] tabular-metrics">
                        {activeRoom.roomId}
                      </p>
                      <p className="mt-1 text-xs text-[#929A9D] tabular-metrics">
                        Expires {new Date(activeRoom.expiresAt).toLocaleTimeString()} ·{' '}
                        {activeRoom.activeReceiverCount} connected / {activeRoom.pairedReceiverCount} paired (max {activeRoom.maxReceivers})
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="mt-3 text-xs font-medium text-[#F2F3F0]">
                        Create Ephemeral Signaling Room
                      </p>
                      <p className="mt-1 max-w-xs text-xs leading-relaxed text-[#929A9D]">
                        Generates a server-verified 6-character room code with automatic TTL expiration and host approval controls.
                      </p>
                    </>
                  )}
                </div>

                {activeRoom && activeRoomRole === 'host' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleCloseRoom}
                    className="inline-flex min-h-[44px] w-full items-center justify-center border border-[#EF4444]/60 bg-[#131619] px-4 text-xs font-semibold text-[#EF4444] hover:bg-[#EF4444]/10 disabled:opacity-50"
                  >
                    Close Active Room
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy || activeRoomRole === 'receiver'}
                    onClick={handleCreateRoom}
                    className="inline-flex min-h-[44px] w-full items-center justify-center bg-[#FF7849] px-4 text-xs font-semibold text-[#101214] hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? 'Creating Room...' : 'Create Room Code'}
                  </button>
                )}
              </div>
            )}

            {feedback && (
              <div
                role={feedback.tone === 'error' ? 'alert' : 'status'}
                className={`border px-3 py-2.5 text-xs leading-relaxed ${
                  feedback.tone === 'error'
                    ? 'border-[#EF4444]/60 bg-[#131619] text-[#EF4444]'
                    : 'border-[#252A2F] bg-[#131619] text-[#F2F3F0]'
                }`}
              >
                {feedback.text}
              </div>
            )}
          </div>

          {/* Receiver Identity */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <h2 className="border-b border-[#252A2F] pb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
              Local Endpoint Identity
            </h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Display Name</dt>
                <dd className="font-medium text-[#F2F3F0]">{deviceName}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Device ID</dt>
                <dd className="font-mono text-[#F2F3F0] tabular-metrics">{deviceId}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Platform</dt>
                <dd className="font-mono text-[#F2F3F0]">{capabilities.detectedPlatform}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">H.264 Decode</dt>
                <dd className="font-mono text-[#8BD7B0]">
                  {capabilities.supportsVideoH264Decode ? 'Supported' : 'Check Codecs'}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* Right: Host Approval Queue & Paired Receivers OR Receiver Pairing Status */}
        <section className="space-y-4 lg:col-span-7" aria-label="Approval Queue and Pairing Status">
          {/* Receiver Pairing Status Card (always shown when acting as receiver or when status is Rejected/Expired/Disconnected) */}
          {(activeRoomRole === 'receiver' ||
            pairingStatus === 'Rejected' ||
            pairingStatus === 'Expired' ||
            pairingStatus === 'Disconnected' ||
            pairingStatus === 'Request pending' ||
            pairingStatus === 'Awaiting approval') && (
            <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                  Receiver Pairing Status
                </h2>
                <SignalBadge
                  label={pairingStatus}
                  tone={statusToTone(pairingStatus)}
                  pulse={pairingStatus === 'Request pending' || pairingStatus === 'Awaiting approval'}
                />
              </div>
              <p className="text-xs leading-relaxed text-[#F2F3F0]">
                {pairingDetail ?? 'Ready to pair with a host room code.'}
              </p>
              {activeRoom && activeRoomRole === 'receiver' && (
                <dl className="grid grid-cols-2 gap-2 border-t border-[#252A2F] pt-3 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.08em] text-[#929A9D]">Room</dt>
                    <dd className="mt-0.5 font-mono text-[#F2F3F0] tabular-metrics">{activeRoom.roomId}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.08em] text-[#929A9D]">Host</dt>
                    <dd className="mt-0.5 truncate text-[#F2F3F0]">{activeRoom.hostDeviceName}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.08em] text-[#929A9D]">Assigned Slot</dt>
                    <dd className="mt-0.5 font-mono text-[#F2F3F0] tabular-metrics">
                      {myPairedSlot ? `SLOT ${String(myPairedSlot.assignedSlotIndex + 1).padStart(2, '0')}` : 'Pending'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.08em] text-[#929A9D]">Expires</dt>
                    <dd className="mt-0.5 font-mono text-[#F2F3F0] tabular-metrics">
                      {new Date(activeRoom.expiresAt).toLocaleTimeString()}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
          )}

          {/* Receiver Live WebRTC Screen Player */}
          {activeRoomRole === 'receiver' &&
            (pairingStatus === 'Paired' ||
              webrtcState.remoteStream !== null ||
              webrtcState.phase === 'connecting' ||
              webrtcState.phase === 'reconnecting' ||
              webrtcState.phase === 'failed' ||
              webrtcState.phase === 'disconnected') && (
              <div className="space-y-3">
                <VideoSurface
                  slotLabel={
                    myPairedSlot
                      ? `SLOT ${String(myPairedSlot.assignedSlotIndex + 1).padStart(2, '0')}`
                      : 'RX-01'
                  }
                  title={
                    activeRoom
                      ? `${activeRoom.hostDeviceName} — Live Shared Screen`
                      : 'Inbound Screen Stream'
                  }
                  stream={webrtcState.remoteStream}
                  muted={receiverMuted}
                  highlight={webrtcState.phase === 'connected'}
                  standbyReason={
                    webrtcState.errorMessage ??
                    webrtcState.statusDetail ??
                    'Paired with host. Waiting for host to click Start Sharing in Cast Studio.'
                  }
                  statusBadge={
                    <SignalBadge
                      label={webrtcBadge.label}
                      tone={webrtcBadge.tone}
                      pulse={webrtcBadge.pulse}
                    />
                  }
                  footerMeta={
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-[11px] text-[#929A9D] tabular-metrics">
                        ICE: {webrtcState.iceConnectionState ?? 'idle'}
                        {webrtcState.remoteStreamMeta
                          ? ` · Host ${webrtcState.remoteStreamMeta.width}×${webrtcState.remoteStreamMeta.height} @ ${webrtcState.remoteStreamMeta.fps} FPS (${webrtcState.remoteStreamMeta.codec})`
                          : ''}
                      </span>
                      <button
                        type="button"
                        disabled={!webrtcState.remoteStream}
                        onClick={() => setReceiverMuted((m) => !m)}
                        className="inline-flex min-h-[30px] items-center gap-1.5 border border-[#252A2F] bg-[#191D20] px-2.5 text-[11px] font-medium text-[#F2F3F0] hover:border-[#FF7849] disabled:opacity-40"
                      >
                        {receiverMuted ? (
                          <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5 text-[#8BD7B0]" aria-hidden="true" />
                        )}
                        <span>{receiverMuted ? 'Unmute Audio' : 'Mute Audio'}</span>
                      </button>
                    </div>
                  }
                />

                {webrtcState.errorMessage && (
                  <div
                    role="alert"
                    className="border border-[#EF4444]/60 bg-[#191D20] px-3 py-2 text-xs text-[#EF4444]"
                  >
                    {webrtcState.errorMessage}
                  </div>
                )}

                <TelemetryStrip telemetry={webrtcState.telemetry} />
              </div>
            )}

          {/* Host Incoming Approval Queue */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#8BD7B0]" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                  Incoming Approval Queue
                </h2>
              </div>
              <span className="font-mono text-xs text-[#929A9D] tabular-metrics">
                {pendingRequests.length} pending
              </span>
            </div>

            {pendingRequests.length === 0 ? (
              <div className="py-6">
                <div className="hidden sm:grid grid-cols-4 border-b border-[#252A2F] pb-2 text-[10px] uppercase tracking-[0.08em] text-[#929A9D]">
                  <span>Receiver</span>
                  <span>Platform</span>
                  <span>Status</span>
                  <span className="text-right">Action</span>
                </div>
                <p className="mt-4 text-xs leading-relaxed text-[#929A9D]">
                  No incoming pairing requests. Receivers never auto-pair — every device joining a room code must be explicitly approved by the host before pairing completes.
                </p>
              </div>
            ) : (
              <div className="mt-3 divide-y divide-[#252A2F]">
                {pendingRequests.map((req) => (
                  <div
                    key={req.deviceId}
                    className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-0.5 text-xs">
                      <div className="font-medium text-[#F2F3F0]">{req.deviceName}</div>
                      <div className="font-mono text-[#929A9D] tabular-metrics">
                        {req.platform} · {req.deviceId} · Awaiting approval
                      </div>
                    </div>
                    {activeRoomRole === 'host' && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={actionId === req.deviceId}
                          onClick={() => runHostDecision(req.deviceId, 'approve')}
                          className="inline-flex min-h-[44px] items-center gap-1.5 bg-[#8BD7B0] px-3 text-xs font-semibold text-[#101214] hover:opacity-90 disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Approve</span>
                        </button>
                        <button
                          type="button"
                          disabled={actionId === req.deviceId}
                          onClick={() => runHostDecision(req.deviceId, 'reject')}
                          className="inline-flex min-h-[44px] items-center gap-1.5 border border-[#252A2F] bg-[#131619] px-3 text-xs font-medium text-[#F2F3F0] hover:border-[#EF4444] disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Reject</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Host / Room Paired Receivers Roster */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Paired Receivers
              </h2>
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-[#929A9D] tabular-metrics">
                  {activeRoom ? `${activeRoom.activeReceiverCount} connected / ${pairedReceivers.length} paired` : '0 / 6'}
                </span>
                {activeRoomRole === 'host' && pairedReceivers.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onNavigate('cast')}
                    className="inline-flex min-h-[30px] items-center gap-1.5 bg-[#FF7849] px-3 text-[11px] font-semibold text-[#101214] hover:opacity-90"
                  >
                    <Cast className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Open Cast Studio</span>
                  </button>
                )}
              </div>
            </div>

            {pairedReceivers.length === 0 ? (
              <p className="mt-3 text-xs leading-relaxed text-[#929A9D]">
                No paired receivers in this room yet. Approved receivers appear here with assigned slots (up to 6) and individual disconnect controls.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-[#252A2F]">
                {pairedReceivers.map((rx) => (
                  <li
                    key={rx.deviceId}
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-0.5 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-[#929A9D] tabular-metrics">
                          SLOT {String(rx.assignedSlotIndex + 1).padStart(2, '0')}
                        </span>
                        <span className="font-medium text-[#F2F3F0]">{rx.deviceName}</span>
                      </div>
                      <div className="font-mono text-[11px] text-[#929A9D] tabular-metrics">
                        {rx.platform} · {rx.deviceId}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <SignalBadge
                        label={rx.connected ? 'Paired' : 'Disconnected'}
                        tone={rx.connected ? 'active' : 'warn'}
                      />
                      {activeRoomRole === 'host' && (
                        <button
                          type="button"
                          disabled={actionId === rx.deviceId}
                          onClick={() => runHostDecision(rx.deviceId, 'remove')}
                          className="inline-flex min-h-[36px] items-center gap-1.5 border border-[#252A2F] bg-[#131619] px-3 text-xs font-medium text-[#F2F3F0] hover:border-[#EF4444] hover:text-[#EF4444] disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Remove</span>
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
