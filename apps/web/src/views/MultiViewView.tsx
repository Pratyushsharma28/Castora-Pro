import { useRef, useState } from 'react';
import { Maximize2, Power, Volume2, VolumeX } from 'lucide-react';
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

export function MultiViewView({
  layout,
  onChangeLayout,
  slots,
  capabilities,
  onLogEvent,
}: MultiViewViewProps) {
  const [spotlightIndex, setSpotlightIndex] = useState<number>(0);
  const [wallNotice, setWallNotice] = useState<string | null>(null);
  const wallRef = useRef<HTMLDivElement | null>(null);

  const slotCount = LAYOUT_OPTIONS.find((opt) => opt.id === layout)?.count ?? 6;

  const normalizedSlots: ConnectedReceiverSlot[] = Array.from(
    { length: slotCount },
    (_, idx) =>
      slots[idx] ?? {
        slotIndex: idx,
        receiverDeviceId: `standby-${idx + 1}`,
        deviceName: `Receiver Slot ${String(idx + 1).padStart(2, '0')}`,
        platform: 'android',
        connectionState: 'idle',
        stream: null,
        hasAudioTrack: false,
        muted: true,
        telemetry: EMPTY_TELEMETRY,
      }
  );

  const handleWallFullscreen = async () => {
    if (!capabilities.supportsFullscreen || !wallRef.current) {
      setWallNotice('Fullscreen API is not available in this browser context.');
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        onLogEvent('ui', 'Exited monitor wall fullscreen', 'Returned Multi-View to standard viewport.');
      } else {
        await wallRef.current.requestFullscreen();
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
    const slotCode = `SLOT ${String(slot.slotIndex + 1).padStart(2, '0')}`;
    const isActive = slot.connectionState === 'connected' && slot.stream !== null;
    const isSpotlightTarget = layout === 'spotlight' && slot.slotIndex === spotlightIndex;

    return (
      <VideoSurface
        key={slot.slotIndex}
        slotLabel={slotCode}
        title={isActive ? slot.deviceName : `${slot.deviceName} (Standby)`}
        stream={slot.stream}
        muted={slot.muted}
        highlight={isPrimarySpotlight || isSpotlightTarget}
        standbyReason="Awaiting Stage 3–4 receiver pairing. Real inbound tracks, decoded FPS, and RTT will populate this tile automatically."
        statusBadge={
          <SignalBadge
            label={isActive ? 'LIVE' : 'STANDBY'}
            tone={isActive ? 'active' : 'standby'}
          />
        }
        footerMeta={
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-metrics">
            <div className="flex items-center gap-3 text-[#929A9D]">
              <span>
                FPS:{' '}
                <strong className="font-medium text-[#F2F3F0]">
                  {slot.telemetry.decodedFps !== null ? slot.telemetry.decodedFps.toFixed(1) : '—'}
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
                disabled={!isActive}
                title={isActive ? (slot.muted ? 'Unmute tile' : 'Mute tile') : 'Available when stream is active'}
                className="inline-flex h-7 w-7 items-center justify-center border border-[#252A2F] bg-[#191D20] text-[#929A9D] disabled:opacity-40"
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
                disabled={!isActive}
                title={isActive ? 'Disconnect receiver' : 'Available when stream is active'}
                className="inline-flex h-7 w-7 items-center justify-center border border-[#252A2F] bg-[#191D20] text-[#929A9D] disabled:opacity-40"
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
            Multi-View Monitor Wall
          </h1>
          <p className="text-xs text-[#929A9D]">
            Up to 6 simultaneous screen slots with per-tile telemetry and independent spotlight / fullscreen staging.
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
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Fullscreen Wall</span>
          </button>
        </div>
      </div>

      {wallNotice && (
        <div className="border border-[#252A2F] bg-[#191D20] px-3 py-2 text-xs text-[#929A9D]">
          {wallNotice}
        </div>
      )}

      <div ref={wallRef} className="bg-[#101214]">
        {layout === 'spotlight' ? (
          <div className="space-y-4">
            <div>
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
