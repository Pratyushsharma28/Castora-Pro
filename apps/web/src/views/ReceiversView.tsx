import { useState } from 'react';
import { Check, QrCode, ScanLine, ShieldCheck, X } from 'lucide-react';
import type {
  BrowserCapabilityReport,
  IncomingApprovalRequest,
  WebRtcConnectionPhase,
} from '../types/studio';
import { SignalBadge } from '../components/common/SignalBadge';

interface ReceiversViewProps {
  deviceId: string;
  deviceName: string;
  capabilities: BrowserCapabilityReport;
  initialRoomCode: string;
  incomingApprovals: IncomingApprovalRequest[];
  activePhase: WebRtcConnectionPhase;
  onLogEvent: (category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error', title: string, detail: string) => void;
}

const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;

export function ReceiversView({
  deviceId,
  deviceName,
  capabilities,
  initialRoomCode,
  incomingApprovals,
  activePhase,
  onLogEvent,
}: ReceiversViewProps) {
  const [mode, setMode] = useState<'join' | 'host'>('join');
  const [roomCode, setRoomCode] = useState<string>(initialRoomCode);
  const [qrInput, setQrInput] = useState<string>('');
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const handleRoomInputChange = (raw: string) => {
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    setRoomCode(cleaned);
    if (feedback?.tone === 'error') {
      setFeedback(null);
    }
  };

  const handleSubmitJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ROOM_CODE_PATTERN.test(roomCode)) {
      const msg = 'Enter a valid 6-character alphanumeric room code (example: K7M4P9).';
      setFeedback({ tone: 'error', text: msg });
      onLogEvent('ui', 'Room code validation failed', `Input "${roomCode || '(empty)'}" is not 6 alphanumeric characters.`);
      return;
    }

    const msg = `Room code ${roomCode} validated. Live room pairing & approval handshake activate in Stage 2–3 once WebSocket signaling (/castora) is mounted.`;
    setFeedback({ tone: 'info', text: msg });
    onLogEvent('signaling', 'Room join validated (Stage 1 standby)', `Validated room ${roomCode} as ${deviceName} (${deviceId}).`);
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

  const handleHostStandby = () => {
    const msg =
      'Host QR & ephemeral 6-character room code generation require the Stage 2–3 signaling coordinator so room IDs are server-verified and collision-free.';
    setFeedback({ tone: 'info', text: msg });
    onLogEvent('signaling', 'Host room requested (Stage 2–3 pending)', msg);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
            Receivers &amp; Pairing
          </h1>
          <p className="text-xs text-[#929A9D]">
            Touch-friendly pairing for Android phones and Mac browsers with explicit receiver approval.
          </p>
        </div>
        <SignalBadge
          label={activePhase === 'connected' ? 'SESSION ACTIVE' : 'STANDBY'}
          tone={activePhase === 'connected' ? 'active' : 'standby'}
        />
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
                    className="mt-1.5 h-12 w-full border border-[#252A2F] bg-[#131619] px-3 font-mono text-lg font-semibold tracking-[0.28em] text-[#F2F3F0] placeholder:text-[#929A9D]/40 focus:border-[#FF7849] focus:outline-none tabular-metrics"
                  />
                </div>

                <button
                  type="submit"
                  className="inline-flex min-h-[44px] w-full items-center justify-center bg-[#FF7849] px-4 text-xs font-semibold text-[#101214] hover:opacity-90"
                >
                  Validate &amp; Join Room
                </button>

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
                <div className="flex flex-col items-center justify-center border border-[#252A2F] bg-[#131619] px-4 py-8 text-center">
                  <QrCode className="h-8 w-8 text-[#929A9D]" aria-hidden="true" />
                  <p className="mt-3 text-xs font-medium text-[#F2F3F0]">
                    QR Room Code Standby
                  </p>
                  <p className="mt-1 max-w-xs text-xs leading-relaxed text-[#929A9D]">
                    Server-issued room codes and scannable HTTPS LAN QR links activate in Stage 2–3.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleHostStandby}
                  className="inline-flex min-h-[44px] w-full items-center justify-center border border-[#252A2F] bg-[#131619] px-4 text-xs font-semibold text-[#F2F3F0] hover:border-[#FF7849]"
                >
                  Check Room Host Readiness
                </button>
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
              Receiver Identity
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

        {/* Right: Incoming Approval Queue & Active Session Control */}
        <section className="space-y-4 lg:col-span-7" aria-label="Receiver Approval Queue">
          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-[#8BD7B0]" aria-hidden="true" />
                <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                  Incoming Approval Queue
                </h2>
              </div>
              <span className="font-mono text-xs text-[#929A9D] tabular-metrics">
                {incomingApprovals.length} pending
              </span>
            </div>

            {incomingApprovals.length === 0 ? (
              <div className="py-6">
                <div className="hidden sm:grid grid-cols-4 border-b border-[#252A2F] pb-2 text-[10px] uppercase tracking-[0.08em] text-[#929A9D]">
                  <span>Sender</span>
                  <span>Platform</span>
                  <span>Requested Quality</span>
                  <span className="text-right">Action</span>
                </div>
                <p className="mt-4 text-xs leading-relaxed text-[#929A9D]">
                  No incoming cast requests. Receivers never auto-accept streams — every sender must be explicitly approved here before WebRTC media tracks attach.
                </p>
              </div>
            ) : (
              <div className="mt-3 divide-y divide-[#252A2F]">
                {incomingApprovals.map((req) => (
                  <div
                    key={req.sessionId}
                    className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-0.5 text-xs">
                      <div className="font-medium text-[#F2F3F0]">{req.senderName}</div>
                      <div className="font-mono text-[#929A9D] tabular-metrics">
                        {req.senderPlatform} · {req.requestedWidth}×{req.requestedHeight} @{' '}
                        {req.requestedFps} FPS ({req.preferredCodec})
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex min-h-[44px] items-center gap-1.5 bg-[#8BD7B0] px-3 text-xs font-semibold text-[#101214]"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Approve</span>
                      </button>
                      <button
                        type="button"
                        className="inline-flex min-h-[44px] items-center gap-1.5 border border-[#252A2F] bg-[#131619] px-3 text-xs font-medium text-[#F2F3F0]"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Reject</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border border-[#252A2F] bg-[#191D20] p-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Active Inbound Stream
              </h2>
              <button
                type="button"
                disabled={activePhase !== 'connected'}
                className="min-h-[36px] border border-[#252A2F] bg-[#131619] px-3 text-xs font-medium text-[#929A9D] disabled:opacity-45"
              >
                Disconnect
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[#929A9D]">
              Inbound stream playback, live decoded FPS, resolution, RTT, and instant fullscreen view activate here once a sender is approved in Stage 3–4.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
