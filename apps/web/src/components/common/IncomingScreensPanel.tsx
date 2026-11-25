import { useState } from 'react';
import { Monitor, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { evaluateConnectionQuality } from '../../services/streamingDiagnosticsService';
import type { IncomingScreenEntry } from '../../services/webrtcSignalingBridge';
import type {
  AudioPlaybackStatus,
  PeerConnectionRecoveryInfo,
  WebRtcConnectionPhase,
} from '../../types/studio';
import { SignalBadge, type SignalTone } from './SignalBadge';
import { TelemetryStrip } from './TelemetryStrip';
import { VideoSurface } from './VideoSurface';

interface IncomingScreensPanelProps {
  streams: IncomingScreenEntry[];
  emptyMessage?: string;
  compactTelemetry?: boolean;
  hideTelemetry?: boolean;
  mutedByPeerId?: Record<string, boolean>;
  onToggleMutePeer?: (peerDeviceId: string) => void;
  onRetryPeer?: (peerDeviceId: string) => void;
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

function incomingBadge(
  phase: WebRtcConnectionPhase,
  hasStream: boolean,
  recovery?: PeerConnectionRecoveryInfo | null
): { label: string; tone: SignalTone; pulse?: boolean } {
  if (phase === 'reconnecting' || recovery?.reconnecting) {
    const suffix =
      recovery && recovery.attempt > 0
        ? ` (${recovery.attempt}/${recovery.maxAttempts})`
        : '';
    return { label: `Reconnecting${suffix}`, tone: 'warn', pulse: true };
  }
  if (hasStream && phase === 'connected') {
    return { label: 'Live', tone: 'active' };
  }
  switch (phase) {
    case 'connected':
      return { label: 'Connected', tone: 'active' };
    case 'connecting':
      return { label: 'Connecting', tone: 'signal', pulse: true };
    case 'failed':
      return { label: 'Failed', tone: 'fault' };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'warn' };
    default:
      return { label: 'Standby', tone: 'standby' };
  }
}

export function IncomingScreensPanel({
  streams,
  emptyMessage = 'No incoming participant screens right now. When another participant shares their screen, their video appears here automatically.',
  compactTelemetry = false,
  hideTelemetry = false,
  mutedByPeerId,
  onToggleMutePeer,
  onRetryPeer,
  onIncomingVideoDimensions,
  onIncomingAudioPlayback,
}: IncomingScreensPanelProps) {
  const [mutedMap, setMutedMap] = useState<Record<string, boolean>>({});

  const gridClass =
    streams.length <= 1
      ? 'grid-cols-1'
      : streams.length === 2
        ? 'grid-cols-1 md:grid-cols-2'
        : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3';

  return (
    <div className="castora-panel-fs-host castora-card p-4 sm:p-5 space-y-4">
      <div
        data-castora-chrome
        className="flex flex-wrap items-center justify-between gap-2 border-b border-[#D5D7DE] pb-3"
      >
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-[#FF6041]" aria-hidden="true" />
          <h2 className="font-display text-sm font-semibold text-[#141414]">Incoming Screens</h2>
        </div>
        <span className="font-mono text-xs text-[#5C6063] tabular-metrics">
          {streams.filter((s) => s.stream !== null).length} active · {streams.length} total
        </span>
      </div>

      {streams.length === 0 ? (
        <p className="py-2 text-xs leading-relaxed text-[#5C6063]">{emptyMessage}</p>
      ) : (
        <div className={`grid gap-4 ${gridClass}`}>
          {streams.map((entry, idx) => {
            const muted =
              mutedByPeerId !== undefined
                ? (mutedByPeerId[entry.senderDeviceId] ?? false)
                : (mutedMap[entry.senderDeviceId] ?? false);
            const badge = incomingBadge(entry.phase, entry.stream !== null, entry.recovery);
            const quality = evaluateConnectionQuality({
              phase: entry.phase,
              iceConnectionState: entry.iceConnectionState,
              telemetry: entry.telemetry,
              recovery: entry.recovery,
            });
            const canRetry =
              Boolean(onRetryPeer) &&
              (entry.phase === 'failed' ||
                entry.phase === 'disconnected' ||
                Boolean(entry.recovery?.exhausted));
            const hasAudio = Boolean(entry.stream?.getAudioTracks().length);
            const audioBlocked = Boolean(entry.autoplayBlocked || entry.telemetry.autoplayBlocked);

            return (
              <div key={entry.senderDeviceId} className="min-w-0 space-y-2.5">
                <VideoSurface
                  slotLabel={`Screen ${idx + 1}`}
                  title={entry.senderName}
                  subtitle={`${entry.senderPlatform} · ${entry.senderDeviceId}`}
                  stream={entry.stream}
                  muted={muted}
                  autoplayBlocked={audioBlocked}
                  allowFullscreen
                  large={streams.length === 1}
                  highlight={entry.phase === 'connected' && entry.stream !== null}
                  onVideoDimensionsChange={(width, height) =>
                    onIncomingVideoDimensions?.(entry.senderDeviceId, width, height)
                  }
                  onAudioPlaybackChange={(state) =>
                    onIncomingAudioPlayback?.(entry.senderDeviceId, state)
                  }
                  onActivateAudio={() => {
                    if (muted) {
                      if (onToggleMutePeer) {
                        onToggleMutePeer(entry.senderDeviceId);
                      } else {
                        setMutedMap((prev) => ({
                          ...prev,
                          [entry.senderDeviceId]: false,
                        }));
                      }
                    }
                  }}
                  standbyReason={
                    entry.errorMessage ??
                    entry.statusDetail ??
                    `Connecting to incoming screen from ${entry.senderName}...`
                  }
                  statusBadge={
                    <SignalBadge
                      label={badge.label}
                      tone={badge.tone}
                      pulse={badge.pulse}
                    />
                  }
                  footerMeta={
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[#5C6063] tabular-metrics">
                        <span>ICE: {entry.iceConnectionState ?? 'idle'}</span>
                        <span aria-hidden="true">·</span>
                        <span title={quality.detail}>
                          Quality:{' '}
                          <strong className="font-semibold text-[#141414]">
                            {quality.label}
                          </strong>
                        </span>
                        {entry.streamMeta && (
                          <span>
                            · {entry.streamMeta.width}×{entry.streamMeta.height} @{' '}
                            {entry.streamMeta.fps} FPS ({entry.streamMeta.codec})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {canRetry && (
                          <button
                            type="button"
                            onClick={() => onRetryPeer?.(entry.senderDeviceId)}
                            className="inline-flex h-7 items-center gap-1 rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] px-2.5 text-xs font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
                          >
                            <RotateCcw className="h-3 w-3" aria-hidden="true" />
                            <span>Retry</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!entry.stream || !hasAudio}
                          onClick={() => {
                            if (audioBlocked) {
                              onIncomingAudioPlayback?.(entry.senderDeviceId, {
                                playbackStatus: 'playing',
                                autoplayBlocked: false,
                              });
                              if (!muted) return;
                            }
                            if (onToggleMutePeer) {
                              onToggleMutePeer(entry.senderDeviceId);
                            } else {
                              setMutedMap((prev) => ({
                                ...prev,
                                [entry.senderDeviceId]: !muted,
                              }));
                            }
                          }}
                          className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-45 ${
                            audioBlocked && hasAudio
                              ? 'border-[#D97706] bg-[#FFFBEB] text-[#B45309] hover:bg-[#FEF3C7]'
                              : 'border-[#D5D7DE] bg-white text-[#141414] hover:border-[#141414] hover:bg-[#141414] hover:text-white'
                          }`}
                        >
                          {muted || audioBlocked ? (
                            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Volume2 className="h-3.5 w-3.5 text-[#FF6041]" aria-hidden="true" />
                          )}
                          <span>
                            {!hasAudio
                              ? 'No audio'
                              : audioBlocked
                                ? 'Activate Audio'
                                : muted
                                  ? 'Unmute'
                                  : 'Mute'}
                          </span>
                        </button>
                      </div>
                    </div>
                  }
                />

                {(entry.errorMessage || (entry.recovery?.exhausted && !entry.errorMessage)) && (
                  <div
                    role="alert"
                    data-castora-chrome
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] px-3 py-2 text-xs text-[#DC2626]"
                  >
                    <span>
                      {entry.errorMessage ??
                        entry.recovery?.lastError ??
                        `Connection to ${entry.senderName} failed.`}
                    </span>
                    {canRetry && (
                      <button
                        type="button"
                        onClick={() => onRetryPeer?.(entry.senderDeviceId)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[#DC2626]/30 bg-white px-2.5 font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        <span>Retry</span>
                      </button>
                    )}
                  </div>
                )}

                {!hideTelemetry && (
                  <div data-castora-chrome>
                    <TelemetryStrip telemetry={entry.telemetry} compact={compactTelemetry} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
