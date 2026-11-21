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
}

function incomingBadge(
  phase: WebRtcConnectionPhase,
  hasStream: boolean
): { label: string; tone: SignalTone; pulse?: boolean } {
  if (hasStream && phase === 'connected') {
    return { label: 'LIVE', tone: 'active' };
  }
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

export function IncomingScreensPanel({
  streams,
  emptyMessage = 'No incoming participant screens right now. When a paired host or friend shares their screen, their live video and getStats() telemetry appear here automatically.',
  compactTelemetry = false,
}: IncomingScreensPanelProps) {
  const [mutedMap, setMutedMap] = useState<Record<string, boolean>>({});

  return (
    <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#252A2F] pb-2.5">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-[#8BD7B0]" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
            Incoming Screens
          </h2>
        </div>
        <span className="font-mono text-xs text-[#929A9D] tabular-metrics">
          {streams.filter((s) => s.stream !== null).length} active / {streams.length} total
        </span>
      </div>

      {streams.length === 0 ? (
        <p className="text-xs leading-relaxed text-[#929A9D]">{emptyMessage}</p>
      ) : (
        <div className="space-y-5">
          {streams.map((entry, idx) => {
            const muted = mutedMap[entry.senderDeviceId] ?? true;
            const badge = incomingBadge(entry.phase, entry.stream !== null);
            const hasAudio = Boolean(entry.stream?.getAudioTracks().length);

            return (
              <div key={entry.senderDeviceId} className="space-y-3">
                <VideoSurface
                  slotLabel={`IN-${String(idx + 1).padStart(2, '0')}`}
                  title={`${entry.senderName} (${entry.senderPlatform} · ${entry.senderDeviceId})`}
                  stream={entry.stream}
                  muted={muted}
                  highlight={entry.phase === 'connected' && entry.stream !== null}
                  standbyReason={
                    entry.errorMessage ??
                    entry.statusDetail ??
                    `Negotiating incoming screen stream from ${entry.senderName}...`
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
                      <div className="font-mono text-[11px] text-[#929A9D] tabular-metrics">
                        <span>ID: {entry.senderDeviceId}</span>
                        <span> · ICE: {entry.iceConnectionState ?? 'idle'}</span>
                        {entry.streamMeta && (
                          <span>
                            {' '}
                            · Announced {entry.streamMeta.width}×{entry.streamMeta.height} @{' '}
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
                        className="inline-flex min-h-[30px] items-center gap-1.5 border border-[#252A2F] bg-[#191D20] px-2.5 text-[11px] font-medium text-[#F2F3F0] hover:border-[#FF7849] disabled:opacity-40"
                      >
                        {muted ? (
                          <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5 text-[#8BD7B0]" aria-hidden="true" />
                        )}
                        <span>{hasAudio ? (muted ? 'Unmute Audio' : 'Mute Audio') : 'No Audio'}</span>
                      </button>
                    </div>
                  }
                />

                {entry.errorMessage && (
                  <div
                    role="alert"
                    className="border border-[#EF4444]/60 bg-[#131619] px-3 py-2 text-xs text-[#EF4444]"
                  >
                    {entry.errorMessage}
                  </div>
                )}

                <TelemetryStrip telemetry={entry.telemetry} compact={compactTelemetry} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
