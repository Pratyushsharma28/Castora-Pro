import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Power,
  Radio,
  SlidersHorizontal,
  Square,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { PairingLifecycleStatus, RoomSnapshot } from '../services/backendClient';
import {
  VIDEO_QUALITY_PRESETS,
  getPresetDefaultBitrateKbps,
  resolveQualityTarget,
} from '../services/videoQualityService';
import type { WebRtcSessionSnapshot } from '../services/webrtcSignalingBridge';
import type { CastoraPlatform } from '../types/protocol';
import type {
  BrowserCapabilityReport,
  CapturePreferences,
  CodecPreference,
  ConnectedReceiverSlot,
  FrameRateTarget,
  MultiViewLayout,
  ResolutionPresetId,
  StreamTelemetrySnapshot,
  StudioDestination,
} from '../types/studio';
import { SignalBadge } from '../components/common/SignalBadge';
import { TelemetryStrip } from '../components/common/TelemetryStrip';
import { VideoSurface } from '../components/common/VideoSurface';

interface MultiViewViewProps {
  layout: MultiViewLayout;
  onChangeLayout: (layout: MultiViewLayout) => void;
  slots: ConnectedReceiverSlot[];
  capabilities: BrowserCapabilityReport;
  deviceId?: string;
  deviceName?: string;
  preferences?: CapturePreferences;
  onUpdatePreferences?: (next: CapturePreferences) => void;
  onSetPeerQualityOverride?: (
    peerDeviceId: string,
    override: Partial<CapturePreferences> | null
  ) => void;
  qualityNotice?: string | null;
  activeRoom?: RoomSnapshot | null;
  activeRoomRole?: 'host' | 'receiver' | null;
  pairingStatus?: PairingLifecycleStatus;
  webrtcState?: WebRtcSessionSnapshot;
  onStartSharing?: (targetSelection: string | string[] | null) => Promise<void>;
  onConnectReceiver?: (targetPeerId: string) => Promise<void>;
  onStopSharing?: () => void;
  onNavigate?: (destination: StudioDestination) => void;
  defaultShowSharePanel?: boolean;
  onToggleMute?: (slotIndex: number) => void;
  onDisconnectSlot?: (peerDeviceId: string) => void;
  onLogEvent: (
    category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error',
    title: string,
    detail: string
  ) => void;
}

interface PublishTargetOption {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  roleLabel: string;
  connected: boolean;
}

const LAYOUT_OPTIONS: { id: MultiViewLayout; label: string; count: number }[] = [
  { id: 'auto', label: 'Auto', count: 0 },
  { id: '2-up', label: '2-Up', count: 2 },
  { id: '3-up', label: '3-Up', count: 3 },
  { id: '4-up', label: '4-Up', count: 4 },
  { id: '6-up', label: '6-Up', count: 6 },
  { id: 'spotlight', label: 'Spotlight', count: 6 },
];

const RESOLUTION_OPTIONS: { id: ResolutionPresetId; label: string }[] = [
  { id: '720p', label: '720p' },
  { id: '1080p', label: '1080p' },
  { id: '1440p', label: '1440p' },
  { id: '4k', label: '4K' },
  { id: 'native', label: 'Native' },
];

const FPS_OPTIONS: { value: FrameRateTarget; label: string }[] = [
  { value: 60, label: '60 FPS' },
  { value: 30, label: '30 FPS' },
];

const CODEC_OPTIONS: { value: CodecPreference; label: string }[] = [
  { value: 'H264', label: 'H.264' },
  { value: 'VP9', label: 'VP9' },
  { value: 'AV1', label: 'AV1' },
  { value: 'AUTO', label: 'Auto' },
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
  deviceId,
  deviceName = 'My Device',
  preferences,
  onUpdatePreferences,
  onSetPeerQualityOverride,
  qualityNotice = null,
  activeRoom = null,
  activeRoomRole = null,
  webrtcState,
  onStartSharing,
  onConnectReceiver,
  onStopSharing,
  onNavigate,
  defaultShowSharePanel = false,
  onToggleMute,
  onDisconnectSlot,
  onLogEvent,
}: MultiViewViewProps) {
  const [spotlightIndex, setSpotlightIndex] = useState<number>(0);
  const [wallNotice, setWallNotice] = useState<string | null>(null);
  const [isWallFullscreen, setIsWallFullscreen] = useState<boolean>(false);
  const [showSharePanel, setShowSharePanel] = useState<boolean>(defaultShowSharePanel);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState<boolean>(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const wallRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (defaultShowSharePanel) {
      setShowSharePanel(true);
    }
  }, [defaultShowSharePanel]);

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

  const canCapture = capabilities.isSecureContext && capabilities.supportsDisplayMedia;
  const isApprovedInRoom =
    Boolean(activeRoom) &&
    (activeRoomRole === 'host' ||
      Boolean(activeRoom?.pairedReceivers.some((r) => r.deviceId === deviceId)));
  const isPendingParticipant = Boolean(activeRoom) && !isApprovedInRoom;

  const roomPeers: PublishTargetOption[] = useMemo(() => {
    if (!activeRoom || !isApprovedInRoom || !deviceId) return [];
    const list: PublishTargetOption[] = [];
    if (activeRoom.hostDeviceId !== deviceId) {
      list.push({
        deviceId: activeRoom.hostDeviceId,
        deviceName: activeRoom.hostDeviceName,
        platform: activeRoom.hostPlatform,
        roleLabel: 'Host',
        connected: activeRoom.hostConnected,
      });
    }
    for (const rx of activeRoom.pairedReceivers) {
      if (rx.deviceId === deviceId) continue;
      list.push({
        deviceId: rx.deviceId,
        deviceName: rx.deviceName,
        platform: rx.platform,
        roleLabel: `Slot ${rx.assignedSlotIndex + 1}`,
        connected: rx.connected,
      });
    }
    return list;
  }, [activeRoom, deviceId, isApprovedInRoom]);

  const connectedPeers = roomPeers.filter((p) => p.connected);

  useEffect(() => {
    if (connectedPeers.length === 0) {
      setSelectedTarget(null);
      return;
    }
    if (selectedTarget === 'ALL') return;
    const stillValid = connectedPeers.some((p) => p.deviceId === selectedTarget);
    if (!stillValid) {
      setSelectedTarget(connectedPeers.length > 1 ? 'ALL' : connectedPeers[0].deviceId);
    }
  }, [connectedPeers, selectedTarget]);

  const handleStartLocalShare = async () => {
    if (!onStartSharing) return;
    setShareError(null);
    setShareBusy(true);
    try {
      await onStartSharing(selectedTarget);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Unable to start screen sharing');
    } finally {
      setShareBusy(false);
    }
  };

  const handleConnectSelected = async () => {
    if (!onConnectReceiver || !selectedTarget) return;
    setShareError(null);
    setShareBusy(true);
    try {
      if (selectedTarget === 'ALL') {
        for (const peer of connectedPeers) {
          await onConnectReceiver(peer.deviceId);
        }
      } else {
        await onConnectReceiver(selectedTarget);
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Unable to send screen to peer');
    } finally {
      setShareBusy(false);
    }
  };

  const activeStreamCount = slots.filter((s) => s.stream !== null).length;
  const activeOutboundTargets = webrtcState?.outboundPeers ?? [];
  const needsTargetSend =
    Boolean(webrtcState?.localStream) &&
    Boolean(selectedTarget) &&
    Boolean(onConnectReceiver) &&
    (selectedTarget === 'ALL'
      ? connectedPeers.some(
          (p) => !activeOutboundTargets.some((o) => o.targetDeviceId === p.deviceId)
        )
      : !activeOutboundTargets.some((o) => o.targetDeviceId === selectedTarget));

  const slotCount =
    layout === 'auto'
      ? slots.length
      : LAYOUT_OPTIONS.find((opt) => opt.id === layout)?.count ?? 6;

  const normalizedSlots: ConnectedReceiverSlot[] =
    layout === 'auto'
      ? slots
      : Array.from(
          { length: slotCount },
          (_, idx) =>
            slots[idx] ?? {
              slotIndex: idx,
              receiverDeviceId: '',
              deviceName: `Standby Feed ${idx + 1}`,
              platform: 'macos',
              connectionState: 'idle',
              stream: null,
              hasAudioTrack: false,
              muted: true,
              telemetry: EMPTY_TELEMETRY,
            }
        );

  const handleWallFullscreen = async () => {
    const wallEl = wallRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void })
      | null;
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
        onLogEvent('ui', 'Exited monitor wall fullscreen', 'Returned Screens grid to standard view.');
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
        onLogEvent('ui', 'Entered monitor wall fullscreen', `Expanded ${layout} grid to fullscreen.`);
      }
      setWallNotice(null);
    } catch {
      setWallNotice('Browser blocked fullscreen request outside a direct gesture.');
    }
  };

  const gridClass =
    layout === 'auto'
      ? normalizedSlots.length <= 1
        ? 'grid-cols-1'
        : normalizedSlots.length === 2
          ? 'grid-cols-1 md:grid-cols-2'
          : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
      : layout === '2-up'
        ? 'grid-cols-1 md:grid-cols-2'
        : layout === '3-up'
          ? 'grid-cols-1 md:grid-cols-3'
          : layout === '4-up'
            ? 'grid-cols-1 sm:grid-cols-2'
            : 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3';

  const renderTile = (slot: ConnectedReceiverSlot, isPrimarySpotlight = false) => {
    const slotCode = `Screen ${slot.slotIndex + 1}`;
    const hasRealPeer = slot.receiverDeviceId.length > 0;
    const isActive = hasRealPeer && slot.connectionState === 'connected' && slot.stream !== null;
    const isConnecting =
      hasRealPeer &&
      (slot.connectionState === 'connecting' || slot.connectionState === 'reconnecting');
    const isDisconnected = hasRealPeer && slot.connectionState === 'disconnected';
    const isError = hasRealPeer && slot.connectionState === 'failed';
    const isSpotlightTarget = layout === 'spotlight' && slot.slotIndex === spotlightIndex;
    const isSingleLarge = layout === 'auto' && normalizedSlots.length === 1;

    const measuredFps =
      slot.telemetry.decodedFps ?? slot.telemetry.encodedFps ?? slot.telemetry.captureFps;

    return (
      <VideoSurface
        key={`${slot.slotIndex}-${slot.receiverDeviceId || 'standby'}`}
        slotLabel={slotCode}
        title={hasRealPeer ? slot.deviceName : slot.deviceName}
        subtitle={
          hasRealPeer ? `${slot.platform} · ${slot.receiverDeviceId}` : undefined
        }
        stream={slot.stream}
        muted={slot.muted}
        large={isPrimarySpotlight || isSingleLarge}
        highlight={isPrimarySpotlight || isSpotlightTarget || isActive}
        standbyReason={
          hasRealPeer
            ? `Connecting to stream from ${slot.deviceName}...`
            : 'Available feed slot. Incoming participant screens appear here automatically.'
        }
        statusBadge={
          <SignalBadge
            label={
              isActive
                ? 'Live'
                : isConnecting
                  ? 'Connecting'
                  : isDisconnected
                    ? 'Disconnected'
                    : isError
                      ? 'Error'
                      : 'Standby'
            }
            tone={
              isActive
                ? 'active'
                : isConnecting
                  ? 'signal'
                  : isDisconnected
                    ? 'warn'
                    : isError
                      ? 'fault'
                      : 'standby'
            }
            pulse={isConnecting}
          />
        }
        footerMeta={
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-metrics">
            <div className="flex flex-wrap items-center gap-3 text-[#64748B]">
              <span>
                FPS:{' '}
                <strong className="font-semibold text-[#172033]">
                  {measuredFps !== null ? measuredFps.toFixed(1) : '—'}
                </strong>
              </span>
              <span>
                Bitrate:{' '}
                <strong className="font-semibold text-[#172033]">
                  {formatBitrate(slot.telemetry.bitrateKbps)}
                </strong>
              </span>
              <span>
                Res:{' '}
                <strong className="font-semibold text-[#172033]">
                  {slot.telemetry.resolution ?? '—'}
                </strong>
              </span>
              {slot.telemetry.codecMimeType && (
                <span>
                  Codec:{' '}
                  <strong className="font-semibold text-[#172033]">
                    {slot.telemetry.codecMimeType}
                  </strong>
                </span>
              )}
              <span>
                RTT:{' '}
                <strong className="font-semibold text-[#172033]">
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
                    onLogEvent(
                      'ui',
                      'Spotlight tile switched',
                      `Focused ${slotCode} in Screens spotlight.`
                    );
                  }}
                  className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
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
                      ? 'Unmute audio'
                      : 'Mute audio'
                    : 'No audio track'
                }
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-40"
                aria-label={`Toggle mute for ${slot.deviceName}`}
              >
                {slot.muted ? (
                  <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                )}
              </button>
              {onDisconnectSlot && (
                <button
                  type="button"
                  disabled={!hasRealPeer}
                  onClick={() => onDisconnectSlot(slot.receiverDeviceId)}
                  title={hasRealPeer ? 'Disconnect participant' : 'No active participant'}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-40"
                  aria-label={`Disconnect ${slot.deviceName}`}
                >
                  <Power className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        }
      />
    );
  };

  return (
    <div className="space-y-5">
      {/* Unified Screen-Sharing Control Bar */}
      <div
        data-castora-chrome
        className="flex flex-col gap-3 rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] lg:flex-row lg:items-center lg:justify-between"
      >
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-lg font-semibold tracking-tight text-[#172033]">
              Screens
            </h1>
            <span className="text-xs text-[#64748B] tabular-metrics">
              {activeStreamCount} incoming {activeStreamCount === 1 ? 'stream' : 'streams'} live
              {webrtcState?.isSharingLocal ? ' · Sharing your screen' : ''}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[#64748B]">
            View shared participant screens in full resolution or broadcast your own display simultaneously.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onStartSharing && (
            <>
              <button
                type="button"
                disabled={shareBusy || !canCapture || isPendingParticipant}
                onClick={handleStartLocalShare}
                className="inline-flex min-h-[38px] items-center gap-2 rounded-[10px] bg-[#2563EB] px-3.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
              >
                <MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {shareBusy
                    ? 'Starting...'
                    : webrtcState?.isSharingLocal
                      ? 'Change Screen'
                      : 'Share Screen'}
                </span>
              </button>
              {webrtcState?.isSharingLocal && onStopSharing && (
                <button
                  type="button"
                  onClick={onStopSharing}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-[10px] border border-[#DC2626]/30 bg-[#FEF2F2] px-3.5 text-xs font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
                >
                  <Square className="h-3 w-3" aria-hidden="true" />
                  <span>Stop Sharing</span>
                </button>
              )}
            </>
          )}

          {preferences && onUpdatePreferences && (
            <button
              type="button"
              aria-expanded={showSharePanel}
              onClick={() => setShowSharePanel((prev) => !prev)}
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-[10px] border px-3 text-xs font-medium transition-colors ${
                showSharePanel
                  ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                  : 'border-[#E2E8F0] bg-white text-[#172033] hover:border-[#2563EB]'
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Share Controls</span>
              {showSharePanel ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          )}

          <div
            role="group"
            aria-label="Screen Grid Layout"
            className="inline-flex overflow-x-auto rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-0.5"
          >
            {LAYOUT_OPTIONS.map((opt) => {
              const active = layout === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onChangeLayout(opt.id);
                    onLogEvent('ui', 'Screens layout switched', `Grid set to ${opt.label}.`);
                  }}
                  className={`min-h-[32px] rounded-lg px-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-white text-[#172033] shadow-xs'
                      : 'text-[#64748B] hover:text-[#172033]'
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
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-[10px] border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
          >
            {isWallFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">
              {isWallFullscreen ? 'Exit Fullscreen' : 'Fullscreen Grid'}
            </span>
          </button>
        </div>
      </div>

      {!canCapture && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-[#F59E0B]/40 bg-[#FFFBEB] px-4 py-3 text-xs text-[#78350F]"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#B45309]" aria-hidden="true" />
          <span>
            {!capabilities.isSecureContext
              ? 'Screen sharing requires a secure HTTPS origin. Receiving incoming streams remains available.'
              : 'Screen capture (getDisplayMedia) is unavailable in this browser.'}
          </span>
        </div>
      )}

      {isPendingParticipant && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#F59E0B]/40 bg-[#FFFBEB] px-4 py-3 text-xs text-[#78350F]">
          <span>
            Waiting for host approval in room{' '}
            <strong className="font-mono">{activeRoom?.roomId}</strong> before sharing or viewing screens.
          </span>
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('receivers')}
              className="rounded-lg border border-[#F59E0B]/40 bg-white px-3 py-1.5 font-medium text-[#78350F] hover:bg-[#FEF3C7]"
            >
              View Room Status
            </button>
          )}
        </div>
      )}

      {(shareError || webrtcState?.errorMessage || wallNotice || qualityNotice) && (
        <div
          role="alert"
          className="rounded-xl border border-[#DC2626]/30 bg-[#FEF2F2] px-4 py-3 text-xs text-[#B91C1C]"
        >
          {shareError ?? webrtcState?.errorMessage ?? qualityNotice ?? wallNotice}
        </div>
      )}

      {/* Expandable Share Settings & Outbound Preview Drawer */}
      {showSharePanel && preferences && onUpdatePreferences && (() => {
        const resolvedQuality = resolveQualityTarget(preferences, {
          width: webrtcState?.localCaptureMeta?.width,
          height: webrtcState?.localCaptureMeta?.height,
        });
        const presetSpec = VIDEO_QUALITY_PRESETS[preferences.resolution];
        const adaptiveEnabled = preferences.adaptiveBitrate !== false;

        return (
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-5">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="space-y-4 lg:col-span-6">
                <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2.5">
                  <h2 className="text-sm font-semibold text-[#172033]">
                    Outbound Capture &amp; Quality
                  </h2>
                  <span className="text-xs text-[#64748B] tabular-metrics">
                    {connectedPeers.length} {connectedPeers.length === 1 ? 'peer' : 'peers'} connected
                  </span>
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-medium text-[#64748B]">Resolution Preset</span>
                      <span className="text-[#64748B] tabular-metrics">
                        {presetSpec.shortDetail} · Suggested {presetSpec.recommendedRangeLabel}
                      </span>
                    </div>
                    <div className="flex rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-0.5">
                      {RESOLUTION_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            const nextBitrate = getPresetDefaultBitrateKbps(
                              opt.id,
                              preferences.targetFps,
                              {
                                width: webrtcState?.localCaptureMeta?.width,
                                height: webrtcState?.localCaptureMeta?.height,
                              }
                            );
                            onUpdatePreferences({
                              ...preferences,
                              resolution: opt.id,
                              maxBitrateKbps: nextBitrate,
                            });
                          }}
                          className={`flex-1 rounded-md py-1.5 text-xs font-medium whitespace-nowrap ${
                            preferences.resolution === opt.id
                              ? 'bg-white text-[#172033] shadow-xs'
                              : 'text-[#64748B] hover:text-[#172033]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <div className="mb-1.5 text-xs font-medium text-[#64748B]">Frame Rate</div>
                      <div className="flex rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-0.5">
                        {FPS_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() =>
                              onUpdatePreferences({
                                ...preferences,
                                targetFps: opt.value,
                                maxBitrateKbps: getPresetDefaultBitrateKbps(
                                  preferences.resolution,
                                  opt.value,
                                  {
                                    width: webrtcState?.localCaptureMeta?.width,
                                    height: webrtcState?.localCaptureMeta?.height,
                                  }
                                ),
                              })
                            }
                            className={`flex-1 rounded-md py-1.5 text-xs font-medium tabular-metrics ${
                              preferences.targetFps === opt.value
                                ? 'bg-white text-[#172033] shadow-xs'
                                : 'text-[#64748B] hover:text-[#172033]'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-1.5 text-xs font-medium text-[#64748B]">Codec &amp; Audio</div>
                      <div className="flex gap-1.5">
                        <div className="flex flex-1 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-0.5">
                          {CODEC_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() =>
                                onUpdatePreferences({ ...preferences, codecPreference: opt.value })
                              }
                              className={`flex-1 rounded-md py-1.5 text-xs font-medium ${
                                preferences.codecPreference === opt.value
                                  ? 'bg-white text-[#172033] shadow-xs'
                                  : 'text-[#64748B] hover:text-[#172033]'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({
                              ...preferences,
                              includeAudio: !preferences.includeAudio,
                            })
                          }
                          title="Include system or tab audio"
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap ${
                            preferences.includeAudio
                              ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                              : 'border-[#E2E8F0] bg-white text-[#64748B]'
                          }`}
                        >
                          {preferences.includeAudio ? (
                            <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          <span>Audio</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Configurable Video Bitrate & Adaptive Bitrate Control */}
                  <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <label htmlFor="mv-bitrate-range" className="font-medium text-[#172033]">
                        Target Max Bitrate
                      </label>
                      <div className="flex items-center gap-2.5 tabular-metrics">
                        <span className="font-mono font-semibold text-[#2563EB]">
                          {(resolvedQuality.configuredMaxBitrateKbps / 1000).toFixed(1)} Mbps
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            onUpdatePreferences({
                              ...preferences,
                              adaptiveBitrate: !adaptiveEnabled,
                            })
                          }
                          className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                            adaptiveEnabled
                              ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                              : 'border-[#E2E8F0] bg-white text-[#64748B]'
                          }`}
                        >
                          {adaptiveEnabled ? 'Adaptive ABR: Auto' : 'Adaptive ABR: Fixed'}
                        </button>
                      </div>
                    </div>
                    <input
                      id="mv-bitrate-range"
                      type="range"
                      min={presetSpec.minBitrateKbps}
                      max={presetSpec.maxBitrateKbps}
                      step={500}
                      value={resolvedQuality.configuredMaxBitrateKbps}
                      onChange={(e) =>
                        onUpdatePreferences({
                          ...preferences,
                          maxBitrateKbps: Number(e.target.value),
                        })
                      }
                      className="h-1.5 w-full cursor-pointer accent-[#2563EB]"
                    />
                    <div className="flex items-center justify-between text-[11px] text-[#64748B] tabular-metrics">
                      <span>{(presetSpec.minBitrateKbps / 1000).toFixed(1)} Mbps</span>
                      <span>
                        1080p60: 8–12M · 1440p60: 15–25M · 4K60: 30–50M
                      </span>
                      <span>{(presetSpec.maxBitrateKbps / 1000).toFixed(0)} Mbps</span>
                    </div>
                  </div>
                </div>

              {/* Target Participant Selection */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[#64748B]">Share Target</span>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate('receivers')}
                      className="font-medium text-[#2563EB] hover:underline"
                    >
                      Manage Room
                    </button>
                  )}
                </div>

                {!activeRoom || !isApprovedInRoom ? (
                  <p className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5 text-xs text-[#64748B]">
                    Join or create a room in Rooms to share with participants.
                  </p>
                ) : connectedPeers.length === 0 ? (
                  <p className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5 text-xs text-[#64748B]">
                    Waiting for other approved participants in room{' '}
                    <span className="font-mono font-semibold text-[#172033]">{activeRoom.roomId}</span>.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {connectedPeers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setSelectedTarget('ALL')}
                        className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border px-3 text-xs font-medium ${
                          selectedTarget === 'ALL'
                            ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                            : 'border-[#E2E8F0] bg-white text-[#172033] hover:border-[#2563EB]'
                        }`}
                      >
                        <Users className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>All Participants ({connectedPeers.length})</span>
                      </button>
                    )}
                    {connectedPeers.map((peer) => {
                      const active = selectedTarget === peer.deviceId;
                      return (
                        <button
                          key={peer.deviceId}
                          type="button"
                          onClick={() => setSelectedTarget(peer.deviceId)}
                          className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border px-3 text-xs font-medium ${
                            active
                              ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                              : 'border-[#E2E8F0] bg-white text-[#172033] hover:border-[#2563EB]'
                          }`}
                        >
                          <span>{peer.deviceName}</span>
                          <span className="text-[11px] opacity-70">({peer.roleLabel})</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {needsTargetSend && (
                  <button
                    type="button"
                    disabled={shareBusy}
                    onClick={handleConnectSelected}
                    className="inline-flex min-h-[38px] items-center gap-2 rounded-[10px] border border-[#16A34A]/40 bg-[#F0FDF4] px-3.5 text-xs font-semibold text-[#15803D] hover:bg-[#DCFCE7]"
                  >
                    <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>
                      {selectedTarget === 'ALL'
                        ? 'Send Active Screen to All Participants'
                        : 'Send Active Screen to Selected Participant'}
                    </span>
                  </button>
                )}

                {/* Per-Outgoing Stream Diagnostics & Independent Bitrate Control */}
                {activeOutboundTargets.length > 0 && onSetPeerQualityOverride && (
                  <div className="pt-2 space-y-1.5">
                    <div className="text-xs font-medium text-[#64748B]">
                      Per-Stream Quality (Independent per Peer)
                    </div>
                    <div className="divide-y divide-[#E2E8F0] rounded-lg border border-[#E2E8F0] bg-[#F8FAFC]">
                      {activeOutboundTargets.map((out) => {
                        const overrideCap = out.qualityOverride?.maxBitrateKbps ?? null;
                        return (
                          <div
                            key={out.targetDeviceId}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium text-[#172033]">
                                {out.targetName}
                              </div>
                              <div className="text-[11px] text-[#64748B] tabular-metrics">
                                {out.telemetry.resolution ?? 'Negotiating'} ·{' '}
                                {formatBitrate(out.telemetry.bitrateKbps)} /{' '}
                                {formatBitrate(out.telemetry.targetBitrateKbps ?? null)}
                                {out.telemetry.codecMimeType ? ` · ${out.telemetry.codecMimeType}` : ''}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              {[
                                { label: 'Global', kbps: null },
                                { label: '10M', kbps: 10_000 },
                                { label: '20M', kbps: 20_000 },
                                { label: '40M', kbps: 40_000 },
                              ].map((opt) => {
                                const isActive = overrideCap === opt.kbps;
                                return (
                                  <button
                                    key={opt.label}
                                    type="button"
                                    onClick={() =>
                                      onSetPeerQualityOverride(
                                        out.targetDeviceId,
                                        opt.kbps === null ? null : { maxBitrateKbps: opt.kbps }
                                      )
                                    }
                                    className={`rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-metrics ${
                                      isActive
                                        ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                                        : 'border-[#E2E8F0] bg-white text-[#64748B] hover:text-[#172033]'
                                    }`}
                                  >
                                    {opt.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3 lg:col-span-6">
              <VideoSurface
                slotLabel="My Screen"
                title={
                  webrtcState?.isSharingLocal
                    ? activeOutboundTargets.length > 0
                      ? `${deviceName} → ${activeOutboundTargets.map((o) => o.targetName).join(', ')}`
                      : `${deviceName} (Local Preview)`
                    : 'Local Outbound Preview'
                }
                stream={webrtcState?.localStream ?? null}
                muted
                highlight={Boolean(webrtcState?.isSharingLocal)}
                standbyReason="Click Share Screen to pick a display, window, or browser tab."
                statusBadge={
                  <SignalBadge
                    label={
                      webrtcState?.isSharingLocal
                        ? activeOutboundTargets.some((o) => o.phase === 'connected')
                          ? 'Live'
                          : 'Preview'
                        : 'Idle'
                    }
                    tone={
                      webrtcState?.isSharingLocal
                        ? activeOutboundTargets.some((o) => o.phase === 'connected')
                          ? 'active'
                          : 'signal'
                        : 'standby'
                    }
                  />
                }
              />
              {webrtcState && <TelemetryStrip telemetry={webrtcState.outboundTelemetry} compact />}
            </div>
          </div>
        </div>
        );
      })()}

      {/* Primary Received Video Stage */}
      <div
        ref={wallRef}
        className={
          isWallFullscreen
            ? 'castora-panel-fs-host h-screen w-screen overflow-y-auto bg-[#F5F7FB] p-4 sm:p-6'
            : 'castora-panel-fs-host min-w-0'
        }
      >
        {layout === 'auto' && normalizedSlots.length === 0 ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-[#E2E8F0] bg-white px-6 py-12 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] text-[#2563EB]">
              <MonitorPlay className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-display text-base font-semibold text-[#172033]">
              No incoming screens yet
            </h2>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-[#64748B]">
              {activeRoom
                ? 'When a participant in this room shares their screen, their video fills this stage automatically. You can also share your own screen at any time.'
                : 'Create or join a room first, then any participant can share and receive screens independently.'}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {onStartSharing && canCapture && !isPendingParticipant && (
                <button
                  type="button"
                  disabled={shareBusy}
                  onClick={handleStartLocalShare}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
                >
                  <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                  <span>{shareBusy ? 'Starting...' : 'Share Your Screen'}</span>
                </button>
              )}
              {!activeRoom && onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('receivers')}
                  className="inline-flex min-h-[42px] items-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-semibold text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                >
                  <Users className="h-4 w-4" aria-hidden="true" />
                  <span>Go to Rooms</span>
                </button>
              )}
            </div>
          </div>
        ) : layout === 'spotlight' ? (
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

      {/* Compact Outbound Status Strip when sharing & drawer collapsed */}
      {webrtcState?.isSharingLocal && !showSharePanel && (
        <div
          data-castora-chrome
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#2563EB]/30 bg-[#EFF6FF] px-4 py-3"
        >
          <div className="flex items-center gap-3 text-sm">
            <SignalBadge label="Sharing your screen" tone="active" />
            <span className="text-xs text-[#64748B]">
              {activeOutboundTargets.length > 0
                ? `Streaming to ${activeOutboundTargets.map((o) => o.targetName).join(', ')}`
                : 'Local capture active — waiting for connected peers'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSharePanel(true)}
              className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
            >
              Show Self-Preview
            </button>
            {onStopSharing && (
              <button
                type="button"
                onClick={onStopSharing}
                className="rounded-lg bg-[#DC2626] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#B91C1C]"
              >
                Stop Sharing
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
