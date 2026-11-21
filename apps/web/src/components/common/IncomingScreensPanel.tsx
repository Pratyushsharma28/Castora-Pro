import { useState } from 'react';
import { Monitor, Volume2, VolumeX } from 'lucide-react';
import type { IncomingScreenEntry } from '../../services/webrtcSignalingBridge';
import type { WebRtcConnectionPhase } from '../../types/studio';
import { SignalBadge, type SignalTone } from './SignalBadge';
import { TelemetryStrip } from './TelemetryStrip';
import { VideoSurface } from './VideoSurface';

interface IncomingScreensPanelProps {
  streams: IncomingScreenEntry[];
  emptyMessage?: string;
  compactTelemetry?: boolean;
  hideTelemetry?: boolean;
}

function incomingBadge(
  phase: WebRtcConnectionPhase,
  hasStream: boolean
): { label: string; tone: SignalTone; pulse?: boolean } {
  if (hasStream && phase === 'connected') {
    return { label: 'Live', tone: 'active' };
  }
  switch (phase) {
    case 'connected':
      return { label: 'Connected', tone: 'active' };
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

export function IncomingScreensPanel({
  streams,
  emptyMessage = 'No incoming participant screens right now. When another participant shares their screen, their video appears here automatically.',
  compactTelemetry = false,
  hideTelemetry = false,
}: IncomingScreensPanelProps) {
  const [mutedMap, setMutedMap] = useState<Record<string, boolean>>({});

  const gridClass =
    streams.length <= 1
      ? 'grid-cols-1'
      : streams.length === 2
        ? 'grid-cols-1 md:grid-cols-2'
        : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3';

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 sm:p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2E8F0] pb-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-[#172033]">Incoming Screens</h2>
        </div>
        <span className="text-xs text-[#64748B] tabular-metrics">
          {streams.filter((s) => s.stream !== null).length} active · {streams.length} total
        </span>
      </div>

      {streams.length === 0 ? (
        <p className="py-2 text-xs leading-relaxed text-[#64748B]">{emptyMessage}</p>
      ) : (
        <div className={`grid gap-4 ${gridClass}`}>
          {streams.map((entry, idx) => {
            const muted = mutedMap[entry.senderDeviceId] ?? true;
            const badge = incomingBadge(entry.phase, entry.stream !== null);
            const hasAudio = Boolean(entry.stream?.getAudioTracks().length);

            return (
              <div key={entry.senderDeviceId} className="min-w-0 space-y-2.5">
                <VideoSurface
                  slotLabel={`Screen ${idx + 1}`}
                  title={entry.senderName}
                  subtitle={`${entry.senderPlatform} · ${entry.senderDeviceId}`}
                  stream={entry.stream}
                  muted={muted}
                  allowFullscreen
                  large={streams.length === 1}
                  highlight={entry.phase === 'connected' && entry.stream !== null}
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
                      <div className="text-xs text-[#64748B] tabular-metrics">
                        <span>ICE: {entry.iceConnectionState ?? 'idle'}</span>
                        {entry.streamMeta && (
                          <span>
                            {' '}
                            · {entry.streamMeta.width}×{entry.streamMeta.height} @{' '}
                            {entry.streamMeta.fps} FPS ({entry.streamMeta.codec})
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={!entry.stream || !hasAudio}
                        onClick={() =>
                          setMutedMap((prev) => ({
                            ...prev,
                            [entry.senderDeviceId]: !muted,
                          }))
                        }
                        className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-45"
                      >
                        {muted ? (
                          <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                        )}
                        <span>{hasAudio ? (muted ? 'Unmute' : 'Mute') : 'No audio'}</span>
                      </button>
                    </div>
                  }
                />

                {entry.errorMessage && (
                  <div
                    role="alert"
                    className="rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] px-3 py-2 text-xs text-[#DC2626]"
                  >
                    {entry.errorMessage}
                  </div>
                )}

                {!hideTelemetry && (
                  <TelemetryStrip telemetry={entry.telemetry} compact={compactTelemetry} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
