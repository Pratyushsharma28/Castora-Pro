import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Power, Volume2, VolumeX } from 'lucide-react';
import type {
  BrowserCapabilityReport,
  ConnectedReceiverSlot,
  MultiViewLayout,
  StreamTelemetrySnapshot,
} from '../types/studio';
import { SignalBadge } from '../components/common/SignalBadge';
import { VideoSurface } from '../components/common/VideoSurface';

interface MultiViewViewProps {
  layout: MultiViewLayout;
  onChangeLayout: (layout: MultiViewLayout) => void;
  slots: ConnectedReceiverSlot[];
  capabilities: BrowserCapabilityReport;
  onToggleMute?: (slotIndex: number) => void;
  onDisconnectSlot?: (peerDeviceId: string) => void;
  onLogEvent: (category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error', title: string, detail: string) => void;
}

const LAYOUT_OPTIONS: { id: MultiViewLayout; label: string; count: number }[] = [
  { id: '2-up', label: '2-Up', count: 2 },
  { id: '3-up', label: '3-Up', count: 3 },
  { id: '4-up', label: '4-Up', count: 4 },
  { id: '6-up', label: '6-Up', count: 6 },
  { id: 'spotlight', label: 'Spotlight', count: 6 },
];

const EMPTY_TELEMETRY: StreamTelemetrySnapshot = {
  captureFps: null,
  encodedFps: null,
  decodedFps: null,
  targetFps: 60,
  resolution: null,
  bitrateKbps: null,
  rttMs: null,
  packetLossPct: null,
  jitterMs: null,
  droppedFrames: null,
  connectionState: 'idle',
};

function formatBitrate(kbps: number | null): string {
  if (kbps === null || !Number.isFinite(kbps)) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function MultiViewView({
  layout,
  onChangeLayout,
  slots,
  capabilities,
  onToggleMute,
  onDisconnectSlot,
  onLogEvent,
}: MultiViewViewProps) {
  const [spotlightIndex, setSpotlightIndex] = useState<number>(0);
  const [wallNotice, setWallNotice] = useState<string | null>(null);
  const [isWallFullscreen, setIsWallFullscreen] = useState<boolean>(false);
  const wallRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const syncWallFullscreen = () => {
      const fsDoc = document as Document & { webkitFullscreenElement?: Element | null };
      const activeEl = document.fullscreenElement ?? fsDoc.webkitFullscreenElement ?? null;
      setIsWallFullscreen(activeEl !== null && activeEl === wallRef.current);
    };
    document.addEventListener('fullscreenchange', syncWallFullscreen);
    document.addEventListener('webkitfullscreenchange', syncWallFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', syncWallFullscreen);
      document.removeEventListener('webkitfullscreenchange', syncWallFullscreen);
    };
  }, []);

  const slotCount = LAYOUT_OPTIONS.find((opt) => opt.id === layout)?.count ?? 6;
  const activeStreamCount = slots.filter((s) => s.stream !== null).length;

  const normalizedSlots: ConnectedReceiverSlot[] = Array.from(
    { length: slotCount },
    (_, idx) =>
      slots[idx] ?? {
        slotIndex: idx,
        receiverDeviceId: '',
        deviceName: `Standby Feed ${String(idx + 1).padStart(2, '0')}`,
        platform: 'macos',
        connectionState: 'idle',
        stream: null,
        hasAudioTrack: false,
        muted: true,
        telemetry: EMPTY_TELEMETRY,
      }
  );

  const handleWallFullscreen = async () => {
    const wallEl = wallRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    if (!capabilities.supportsFullscreen || !wallEl) {
      setWallNotice('Fullscreen API is not available in this browser context.');
      return;
    }
    const fsDoc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const activeEl = document.fullscreenElement ?? fsDoc.webkitFullscreenElement ?? null;
    try {
      if (activeEl === wallEl) {
        if (typeof document.exitFullscreen === 'function') {
          await document.exitFullscreen();
        } else if (typeof fsDoc.webkitExitFullscreen === 'function') {
          await fsDoc.webkitExitFullscreen();
        }
        onLogEvent('ui', 'Exited monitor wall fullscreen', 'Returned Multi-View to standard viewport.');
      } else {
        if (activeEl) {
          if (typeof document.exitFullscreen === 'function') {
            await document.exitFullscreen();
          } else if (typeof fsDoc.webkitExitFullscreen === 'function') {
            await fsDoc.webkitExitFullscreen();
          }
        }
        if (typeof wallEl.requestFullscreen === 'function') {
          await wallEl.requestFullscreen();
        } else if (typeof wallEl.webkitRequestFullscreen === 'function') {
          await wallEl.webkitRequestFullscreen();
        }
        onLogEvent('ui', 'Entered monitor wall fullscreen', `Expanded ${layout} wall to fullscreen.`);
      }
      setWallNotice(null);
    } catch {
      setWallNotice('Browser blocked fullscreen request outside a direct gesture or iframe policy.');
    }
  };

  const gridClass =
    layout === '2-up'
      ? 'grid-cols-1 md:grid-cols-2'
      : layout === '3-up'
        ? 'grid-cols-1 md:grid-cols-3'
        : layout === '4-up'
          ? 'grid-cols-1 sm:grid-cols-2'
          : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3';

  const renderTile = (slot: ConnectedReceiverSlot, isPrimarySpotlight = false) => {
    const slotCode = `IN-${String(slot.slotIndex + 1).padStart(2, '0')}`;
    const hasRealPeer = slot.receiverDeviceId.length > 0;
    const isActive = hasRealPeer && slot.connectionState === 'connected' && slot.stream !== null;
    const isConnecting = hasRealPeer && (slot.connectionState === 'connecting' || slot.connectionState === 'reconnecting');
    const isError = hasRealPeer && slot.connectionState === 'failed';
    const isSpotlightTarget = layout === 'spotlight' && slot.slotIndex === spotlightIndex;

    const measuredFps = slot.telemetry.decodedFps ?? slot.telemetry.encodedFps ?? slot.telemetry.captureFps;

    return (
      <VideoSurface
        key={`${slot.slotIndex}-${slot.receiverDeviceId || 'standby'}`}
        slotLabel={slotCode}
        title={
          hasRealPeer
            ? `${slot.deviceName} (${slot.receiverDeviceId})`
            : `${slot.deviceName}`
        }
        stream={slot.stream}
        muted={slot.muted}
        highlight={isPrimarySpotlight || isSpotlightTarget || isActive}
        standbyReason={
          hasRealPeer
            ? `Connecting to incoming stream from ${slot.deviceName}...`
            : 'No incoming stream on this feed. Real incoming participant screens and getStats() telemetry appear automatically when shared.'
        }
        statusBadge={
          <SignalBadge
            label={isActive ? 'LIVE' : isConnecting ? 'CONNECTING' : isError ? 'ERROR' : 'STANDBY'}
            tone={isActive ? 'active' : isConnecting ? 'signal' : isError ? 'fault' : 'standby'}
            pulse={isConnecting}
          />
        }
        footerMeta={
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-metrics">
            <div className="flex flex-wrap items-center gap-3 text-[#929A9D]">
              <span>
                FPS:{' '}
                <strong className="font-medium text-[#F2F3F0]">
                  {measuredFps !== null ? measuredFps.toFixed(1) : '—'}
                </strong>
              </span>
              <span>
                Bitrate:{' '}
                <strong className="font-medium text-[#F2F3F0]">
                  {formatBitrate(slot.telemetry.bitrateKbps)}
                </strong>
              </span>
              <span>
                Res:{' '}
                <strong className="font-medium text-[#F2F3F0]">
                  {slot.telemetry.resolution ?? '—'}
                </strong>
              </span>
              <span>
                RTT:{' '}
                <strong className="font-medium text-[#F2F3F0]">
                  {slot.telemetry.rttMs !== null ? `${slot.telemetry.rttMs.toFixed(1)} ms` : '—'}
                </strong>
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {layout === 'spotlight' && !isPrimarySpotlight && (
                <button
                  type="button"
                  onClick={() => {
                    setSpotlightIndex(slot.slotIndex);
                    onLogEvent('ui', 'Spotlight tile switched', `Focused ${slotCode} in Multi-View spotlight stage.`);
                  }}
                  className="border border-[#252A2F] bg-[#191D20] px-2 py-1 text-[10px] font-medium text-[#F2F3F0] hover:border-[#FF7849]"
                >
                  Focus
                </button>
              )}
              <button
                type="button"
                disabled={!isActive || !slot.hasAudioTrack || !onToggleMute}
                onClick={() => onToggleMute?.(slot.slotIndex)}
                title={
                  isActive && slot.hasAudioTrack
                    ? slot.muted
                      ? 'Unmute tile'
                      : 'Mute tile'
                    : 'Available when stream has audio'
                }
                className="inline-flex h-7 w-7 items-center justify-center border border-[#252A2F] bg-[#191D20] text-[#929A9D] hover:border-[#FF7849] hover:text-[#F2F3F0] disabled:opacity-40"
                aria-label={`Toggle mute for ${slotCode}`}
              >
                {slot.muted ? (
                  <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                disabled={!hasRealPeer || !onDisconnectSlot}
                onClick={() => onDisconnectSlot?.(slot.receiverDeviceId)}
                title={hasRealPeer ? 'Disconnect participant' : 'Available when participant is connected'}
                className="inline-flex h-7 w-7 items-center justify-center border border-[#252A2F] bg-[#191D20] text-[#929A9D] hover:border-[#EF4444] hover:text-[#EF4444] disabled:opacity-40"
                aria-label={`Disconnect ${slotCode}`}
              >
                <Power className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        }
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
            Multi-View Incoming Screens
          </h1>
          <p className="text-xs text-[#929A9D]">
            Live incoming participant screens ({activeStreamCount} active) with real getStats() FPS, bitrate, resolution, and RTT.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Multi-View Grid Layout"
            className="inline-flex border border-[#252A2F] bg-[#191D20]"
          >
            {LAYOUT_OPTIONS.map((opt) => {
              const active = layout === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onChangeLayout(opt.id);
                    onLogEvent('ui', 'Multi-View layout switched', `Monitor wall set to ${opt.label}.`);
                  }}
                  className={`min-h-[36px] px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-[#FF7849] text-[#101214]'
                      : 'text-[#929A9D] hover:text-[#F2F3F0]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={handleWallFullscreen}
            className="inline-flex min-h-[36px] items-center gap-1.5 border border-[#252A2F] bg-[#191D20] px-3 text-xs font-medium text-[#F2F3F0] hover:border-[#FF7849]"
          >
            {isWallFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{isWallFullscreen ? 'Exit Wall Fullscreen' : 'Fullscreen Wall'}</span>
          </button>
        </div>
      </div>

      {wallNotice && (
        <div className="border border-[#252A2F] bg-[#191D20] px-3 py-2 text-xs text-[#929A9D]">
          {wallNotice}
        </div>
      )}

      <div
        ref={wallRef}
        className={
          isWallFullscreen
            ? 'h-screen w-screen overflow-y-auto bg-[#101214] p-4'
            : 'min-w-0 bg-[#101214]'
        }
      >
        {layout === 'spotlight' ? (
          <div className="space-y-4">
            <div className="min-w-0">
              {renderTile(
                normalizedSlots[spotlightIndex] ?? normalizedSlots[0],
                true
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {normalizedSlots
                .filter((_, idx) => idx !== spotlightIndex)
                .map((slot) => renderTile(slot, false))}
            </div>
          </div>
        ) : (
          <div className={`grid gap-4 ${gridClass}`}>
            {normalizedSlots.map((slot) => renderTile(slot, false))}
          </div>
        )}
      </div>
    </div>
  );
}
