import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RotateCcw, ShieldCheck } from 'lucide-react';
import type { SignalingSocketState } from '../../services/backendClient';
import type { WebRtcSessionSnapshot } from '../../services/webrtcSignalingBridge';
import type {
  CaptureHealthStatus,
  SignalingStabilitySnapshot,
  StreamingStabilityStatus,
} from '../../types/studio';

interface StreamingStabilityPanelProps {
  webrtcState: WebRtcSessionSnapshot;
  signalingState: SignalingSocketState;
  signalingStability?: SignalingStabilitySnapshot | null;
  defaultExpanded?: boolean;
  onRetryConnection?: () => void;
  onReconnectBackend?: () => void;
}

function formatDuration(startedAt: number | null, nowMs: number): string {
  if (!startedAt || nowMs < startedAt) return '00:00:00';
  const totalSec = Math.floor((nowMs - startedAt) / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatClock(timestampMs: number | null): string {
  if (!timestampMs) return 'None';
  return new Date(timestampMs).toLocaleTimeString();
}

function formatBitrate(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return 'Unavailable';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatCaptureHealth(status: CaptureHealthStatus): string {
  switch (status) {
    case 'Active':
      return 'Live capture';
    case 'Paused / Muted':
      return 'Paused / Muted';
    case 'Capture ended':
      return 'Capture ended';
    default:
      return 'Not capturing';
  }
}

function stabilityAccent(status: StreamingStabilityStatus): {
  dot: string;
  text: string;
} {
  switch (status) {
    case 'Connected':
      return { dot: 'bg-[#16A34A]', text: 'text-[#15803D]' };
    case 'Recovering':
      return { dot: 'bg-[#FF6041]', text: 'text-[#FF6041]' };
    case 'Unstable connection':
      return { dot: 'bg-[#D97706]', text: 'text-[#B45309]' };
    case 'Capture ended':
    case 'Receiver disconnected':
    case 'Streaming stopped':
      return { dot: 'bg-[#DC2626]', text: 'text-[#B91C1C]' };
    default:
      return { dot: 'bg-[#94A3B8]', text: 'text-[#64748B]' };
  }
}

export function StreamingStabilityPanel({
  webrtcState,
  signalingState,
  signalingStability = null,
  defaultExpanded = true,
  onRetryConnection,
  onReconnectBackend,
}: StreamingStabilityPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hasActiveStreaming =
    webrtcState.streamingStartedAt !== null &&
    (webrtcState.isSharingLocal || webrtcState.incomingStreams.length > 0);

  useEffect(() => {
    if (!hasActiveStreaming || typeof window === 'undefined') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveStreaming]);

  const effectiveStatus: StreamingStabilityStatus =
    signalingStability &&
    !signalingStability.backendAvailable &&
    webrtcState.stabilityStatus === 'Connected'
      ? 'Recovering'
      : webrtcState.stabilityStatus;

  const accent = stabilityAccent(effectiveStatus);
  const tel = webrtcState.telemetry;
  const primaryIn = webrtcState.incomingStreams[0] ?? null;

  const actualResolution =
    primaryIn?.telemetry.decodedWidth && primaryIn?.telemetry.decodedHeight
      ? `${primaryIn.telemetry.decodedWidth}×${primaryIn.telemetry.decodedHeight}`
      : tel.encodedWidth && tel.encodedHeight
        ? `${tel.encodedWidth}×${tel.encodedHeight}`
        : tel.resolution ??
          (webrtcState.localCaptureMeta?.width && webrtcState.localCaptureMeta?.height
            ? `${webrtcState.localCaptureMeta.width}×${webrtcState.localCaptureMeta.height}`
            : 'Unavailable');

  const actualFps =
    primaryIn?.telemetry.decodedFps ??
    tel.encodedFps ??
    tel.captureFps ??
    webrtcState.localCaptureMeta?.fps ??
    null;

  const resolutionAndFps =
    actualResolution === 'Unavailable'
      ? 'Unavailable'
      : actualFps !== null && Number.isFinite(actualFps)
        ? `${actualResolution} @ ${actualFps.toFixed(1)} FPS`
        : actualResolution;

  const currentCodec =
    tel.negotiatedVideoCodec ??
    tel.codecMimeType ??
    tel.selectedVideoCodec ??
    primaryIn?.streamMeta?.codec ??
    'Auto';

  const packetLossLabel =
    tel.packetLossPct !== null && Number.isFinite(tel.packetLossPct)
      ? `${tel.packetLossPct.toFixed(2)}%`
      : 'Unavailable';

  const wsStateLabel =
    signalingStability && signalingStability.reconnectAttempt > 0 && signalingState !== 'connected'
      ? `${signalingState} (attempt ${signalingStability.reconnectAttempt})`
      : signalingState;

  const lastReconnectTime =
    webrtcState.lastRecoveryAttemptAt && signalingStability?.lastReconnectAttemptAt
      ? Math.max(webrtcState.lastRecoveryAttemptAt, signalingStability.lastReconnectAttemptAt)
      : webrtcState.lastRecoveryAttemptAt ?? signalingStability?.lastReconnectAttemptAt ?? null;

  const lastRecoveryResult =
    webrtcState.lastRecoveryResult ??
    (signalingStability?.reconnectAttempt && signalingState === 'connected'
      ? 'Signaling reconnected cleanly'
      : 'None');

  const hasRetryAction =
    Boolean(onRetryConnection) &&
    (effectiveStatus === 'Unstable connection' ||
      effectiveStatus === 'Recovering' ||
      webrtcState.phase === 'failed');

  const hasWsReconnectAction =
    Boolean(onReconnectBackend) && signalingState !== 'connected';

  return (
    <section
      data-castora-chrome
      className="castora-card overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#D5D7DE] px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] text-[#FF6041]">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-display text-sm font-semibold text-[#141414]">
              Long-Duration Streaming Stability
            </h2>
            <p className="text-xs text-[#5C6063]">
              Session continuity, capture health, ICE & signaling recovery telemetry
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <span className={`inline-flex items-center gap-2 text-xs font-semibold ${accent.text}`}>
            <span className={`h-2 w-2 rounded-full shrink-0 ${accent.dot}`} aria-hidden="true" />
            <span>{effectiveStatus}</span>
          </span>

          <span className="font-mono text-xs font-medium text-[#141414] tabular-metrics">
            {formatDuration(webrtcState.streamingStartedAt, nowMs)}
          </span>

          {hasRetryAction && (
            <button
              type="button"
              onClick={onRetryConnection}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-2.5 py-1 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414] hover:bg-[#141414] hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Retry Media</span>
            </button>
          )}

          {hasWsReconnectAction && (
            <button
              type="button"
              onClick={onReconnectBackend}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-2.5 py-1 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414] hover:bg-[#141414] hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Reconnect WS</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-2.5 py-1 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414]"
          >
            <span>{expanded ? 'Hide' : 'Details'}</span>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="divide-y divide-[#D5D7DE]">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Streaming Duration
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#141414] tabular-metrics">
                {formatDuration(webrtcState.streamingStartedAt, nowMs)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Capture Status
              </div>
              <div className="mt-1 text-sm font-semibold text-[#141414]">
                {formatCaptureHealth(webrtcState.captureHealthStatus)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                ICE State
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#141414]">
                {webrtcState.iceConnectionState ?? 'idle'}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                WebSocket State
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#141414] capitalize">
                {wsStateLabel}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Current Codec
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#141414]">
                {currentCodec}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Resolution &amp; FPS
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#141414] tabular-metrics">
                {resolutionAndFps}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Current Bitrate
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#141414] tabular-metrics">
                {formatBitrate(tel.bitrateKbps)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Packet Loss
              </div>
              <div className="mt-1 font-mono text-sm font-semibold text-[#141414] tabular-metrics">
                {packetLossLabel}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Last Video Frame
              </div>
              <div className="mt-1 font-mono text-xs font-medium text-[#141414] tabular-metrics">
                {formatClock(webrtcState.lastSuccessfulVideoFrameAt)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Last Heartbeat Ack
              </div>
              <div className="mt-1 font-mono text-xs font-medium text-[#141414] tabular-metrics">
                {formatClock(signalingStability?.lastHeartbeatAckAt ?? null)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Last Reconnect Attempt
              </div>
              <div className="mt-1 font-mono text-xs font-medium text-[#141414] tabular-metrics">
                {formatClock(lastReconnectTime)}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                Turn Lease Expiry
              </div>
              <div className="mt-1 font-mono text-xs font-medium text-[#141414] tabular-metrics">
                {signalingStability?.turnExpiresAt
                  ? formatClock(signalingStability.turnExpiresAt)
                  : 'Default STUN'}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 bg-[#FAFAFA] px-5 py-3 text-xs sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="font-medium text-[#5C6063]">Last recovery result: </span>
              <span className="font-medium text-[#141414]">{lastRecoveryResult}</span>
            </div>
            {webrtcState.stopReason && (
              <div className="text-[#B91C1C]">
                <span className="font-semibold">Stop reason: </span>
                <span>{webrtcState.stopReason}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
