import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, MonitorPlay, Radio, Square, Volume2, VolumeX } from 'lucide-react';
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
  FrameRateTarget,
  ResolutionPresetId,
  StudioDestination,
  WebRtcConnectionPhase,
} from '../types/studio';
import { IncomingScreensPanel } from '../components/common/IncomingScreensPanel';
import { SignalBadge, type SignalTone } from '../components/common/SignalBadge';
import { StreamingQualityDiagnosticsPanel } from '../components/common/StreamingQualityDiagnosticsPanel';
import { TelemetryStrip } from '../components/common/TelemetryStrip';
import { VideoSurface } from '../components/common/VideoSurface';

interface CastViewProps {
  deviceId: string;
  capabilities: BrowserCapabilityReport;
  preferences: CapturePreferences;
  onUpdatePreferences: (next: CapturePreferences) => void;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  pairingStatus: PairingLifecycleStatus;
  webrtcState: WebRtcSessionSnapshot;
  onStartSharing: (targetSelection: string | string[] | null) => Promise<void>;
  onConnectReceiver: (targetPeerId: string) => Promise<void>;
  onStopSharing: () => void;
  onNavigate: (destination: StudioDestination) => void;
  onIncomingVideoDimensions?: (
    senderDeviceId: string,
    width: number | null,
    height: number | null
  ) => void;
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

const RESOLUTION_OPTIONS: { id: ResolutionPresetId; label: string; detail: string }[] = [
  { id: '720p', label: '720p', detail: '1280 × 720' },
  { id: '1080p', label: '1080p', detail: '1920 × 1080' },
  { id: '1440p', label: '1440p', detail: '2560 × 1440' },
  { id: '4k', label: '4K', detail: '3840 × 2160' },
  { id: 'native', label: 'Native', detail: 'Display bounds' },
];

const FPS_OPTIONS: { value: FrameRateTarget; label: string }[] = [
  { value: 60, label: '60 FPS' },
  { value: 30, label: '30 FPS' },
];

const CODEC_OPTIONS: { value: CodecPreference; label: string }[] = [
  { value: 'H264', label: 'H.264 Preferred' },
  { value: 'VP9', label: 'VP9 Screen' },
  { value: 'AV1', label: 'AV1 High-Eff' },
  { value: 'AUTO', label: 'Auto Negotiate' },
];

function webrtcPhaseBadge(phase: WebRtcConnectionPhase): {
  label: string;
  tone: SignalTone;
  pulse?: boolean;
} {
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

export function CastView({
  deviceId,
  capabilities,
  preferences,
  onUpdatePreferences,
  activeRoom,
  activeRoomRole,
  pairingStatus,
  webrtcState,
  onStartSharing,
  onConnectReceiver,
  onStopSharing,
  onNavigate,
  onIncomingVideoDimensions,
  onLogEvent,
}: CastViewProps) {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canCapture = capabilities.isSecureContext && capabilities.supportsDisplayMedia;
  const isApprovedInRoom =
    Boolean(activeRoom) &&
    (activeRoomRole === 'host' ||
      Boolean(activeRoom?.pairedReceivers.some((r) => r.deviceId === deviceId)));

  const roomPeers: PublishTargetOption[] = useMemo(() => {
    if (!activeRoom || !isApprovedInRoom) return [];
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
    if (selectedTarget === 'ALL') {
      return;
    }
    const stillValid = connectedPeers.some((p) => p.deviceId === selectedTarget);
    if (!stillValid) {
      setSelectedTarget(connectedPeers.length > 1 ? 'ALL' : connectedPeers[0].deviceId);
    }
  }, [connectedPeers, selectedTarget]);

  const handleRequestStartSharing = async () => {
    setLocalError(null);
    setBusy(true);
    try {
      await onStartSharing(selectedTarget);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Unable to start screen sharing');
    } finally {
      setBusy(false);
    }
  };

  const handleConnectSelected = async () => {
    if (!selectedTarget) return;
    setLocalError(null);
    setBusy(true);
    try {
      if (selectedTarget === 'ALL') {
        for (const p of connectedPeers) {
          await onConnectReceiver(p.deviceId);
        }
      } else {
        await onConnectReceiver(selectedTarget);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Unable to connect WebRTC peer');
    } finally {
      setBusy(false);
    }
  };

  const badge = webrtcPhaseBadge(webrtcState.phase);
  const errorToDisplay = localError ?? webrtcState.errorMessage;
  const activeOutboundTargets = webrtcState.outboundPeers;
  const needsTargetSend =
    Boolean(webrtcState.localStream) &&
    Boolean(selectedTarget) &&
    (selectedTarget === 'ALL'
      ? connectedPeers.some(
          (p) => !activeOutboundTargets.some((o) => o.targetDeviceId === p.deviceId)
        )
      : !activeOutboundTargets.some((o) => o.targetDeviceId === selectedTarget));

  const isPendingParticipant = Boolean(activeRoom) && !isApprovedInRoom;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-[#172033]">
            Screen Sharing Controls
          </h1>
          <p className="text-sm text-[#64748B]">
            Configure capture quality, target participants, and preview incoming screens.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SignalBadge label={badge.label} tone={badge.tone} pulse={badge.pulse} />
          <SignalBadge
            label={canCapture ? 'Capture Ready' : 'Capture Restricted'}
            tone={canCapture ? 'active' : 'warn'}
          />
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
              ? 'Secure HTTPS origin required for getDisplayMedia.'
              : 'getDisplayMedia is unavailable in this browser.'}
          </span>
        </div>
      )}

      {isPendingParticipant && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#F59E0B]/40 bg-[#FFFBEB] px-4 py-3 text-xs text-[#78350F]">
          <span>
            Waiting for host approval in room{' '}
            <strong className="font-mono">{activeRoom?.roomId}</strong> before sharing.
          </span>
          <button
            type="button"
            onClick={() => onNavigate('receivers')}
            className="shrink-0 rounded-lg border border-[#F59E0B]/40 bg-white px-3 py-1.5 font-medium text-[#78350F] hover:bg-[#FEF3C7]"
          >
            Check Room
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="min-w-0 space-y-4 lg:col-span-5" aria-label="Capture Parameters">
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-5">
            <h2 className="border-b border-[#E2E8F0] pb-2.5 text-sm font-semibold text-[#172033]">
              Capture Settings
            </h2>

            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-[#64748B]">Resolution Target</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {RESOLUTION_OPTIONS.map((opt) => {
                  const selected = preferences.resolution === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        onUpdatePreferences({
                          ...preferences,
                          resolution: opt.id,
                          maxBitrateKbps: getPresetDefaultBitrateKbps(
                            opt.id,
                            preferences.targetFps,
                            {
                              width: webrtcState.localCaptureMeta?.width,
                              height: webrtcState.localCaptureMeta?.height,
                            }
                          ),
                        });
                        onLogEvent('ui', 'Sender resolution target updated', `Target set to ${opt.label}.`);
                      }}
                      className={`min-h-[44px] rounded-[10px] border px-3 py-2 text-left transition-colors ${
                        selected
                          ? 'border-[#2563EB] bg-[#EFF6FF] text-[#172033]'
                          : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B] hover:text-[#172033]'
                      }`}
                    >
                      <div className="text-xs font-semibold tabular-metrics">{opt.label}</div>
                      <div className="mt-0.5 text-[11px] opacity-80">{opt.detail}</div>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-[#64748B]">Frame Rate Target</legend>
              <div className="grid grid-cols-2 gap-2">
                {FPS_OPTIONS.map((opt) => {
                  const selected = preferences.targetFps === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        onUpdatePreferences({
                          ...preferences,
                          targetFps: opt.value,
                          maxBitrateKbps: getPresetDefaultBitrateKbps(
                            preferences.resolution,
                            opt.value,
                            {
                              width: webrtcState.localCaptureMeta?.width,
                              height: webrtcState.localCaptureMeta?.height,
                            }
                          ),
                        });
                        onLogEvent('ui', 'Sender FPS target updated', `Target set to ${opt.value} FPS.`);
                      }}
                      className={`min-h-[42px] rounded-[10px] border px-3 py-2 text-left text-xs font-semibold tabular-metrics transition-colors ${
                        selected
                          ? 'border-[#2563EB] bg-[#EFF6FF] text-[#172033]'
                          : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B] hover:text-[#172033]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {(() => {
              const presetSpec = VIDEO_QUALITY_PRESETS[preferences.resolution];
              const resolvedQuality = resolveQualityTarget(preferences, {
                width: webrtcState.localCaptureMeta?.width,
                height: webrtcState.localCaptureMeta?.height,
              });
              const adaptiveEnabled = preferences.adaptiveBitrate !== false;
              return (
                <div className="rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="cast-bitrate-range" className="font-medium text-[#172033]">
                      Target Max Bitrate
                    </label>
                    <div className="flex items-center gap-2 tabular-metrics">
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
                        className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                          adaptiveEnabled
                            ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                            : 'border-[#E2E8F0] bg-white text-[#64748B]'
                        }`}
                      >
                        {adaptiveEnabled ? 'ABR Auto' : 'Fixed'}
                      </button>
                    </div>
                  </div>
                  <input
                    id="cast-bitrate-range"
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
                  <div className="text-[11px] text-[#64748B] tabular-metrics">
                    Suggested {presetSpec.label}: {presetSpec.recommendedRangeLabel}
                  </div>
                </div>
              );
            })()}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-[#64748B]">Codec Policy</legend>
                <div className="grid grid-cols-2 gap-1.5">
                  {CODEC_OPTIONS.map((opt) => {
                    const selected = preferences.codecPreference === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          onUpdatePreferences({ ...preferences, codecPreference: opt.value })
                        }
                        className={`flex min-h-[38px] items-center justify-center rounded-[10px] border px-2.5 text-xs font-medium transition-colors ${
                          selected
                            ? 'border-[#2563EB] bg-[#EFF6FF] text-[#172033]'
                            : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B] hover:text-[#172033]'
                        }`}
                      >
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="space-y-2">
                <div className="text-xs font-medium text-[#64748B]">System / Tab Audio</div>
                <button
                  type="button"
                  onClick={() =>
                    onUpdatePreferences({ ...preferences, includeAudio: !preferences.includeAudio })
                  }
                  className={`flex min-h-[44px] w-full items-center justify-between rounded-[10px] border px-3 text-xs font-medium transition-colors ${
                    preferences.includeAudio
                      ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                      : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {preferences.includeAudio ? (
                      <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{preferences.includeAudio ? 'Audio Enabled' : 'Video Only'}</span>
                  </span>
                </button>
              </div>
            </div>

            <div className="border-t border-[#E2E8F0] pt-4 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={busy || !canCapture || isPendingParticipant}
                  onClick={handleRequestStartSharing}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
                >
                  <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {busy
                      ? 'Starting...'
                      : webrtcState.isSharingLocal
                        ? 'Change Screen'
                        : 'Share Screen'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!webrtcState.isSharingLocal}
                  onClick={onStopSharing}
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-[10px] border border-[#DC2626]/30 bg-[#FEF2F2] px-4 text-sm font-semibold text-[#DC2626] hover:bg-[#FEE2E2] disabled:border-[#E2E8F0] disabled:bg-[#F8FAFC] disabled:text-[#94A3B8] disabled:opacity-50"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Stop</span>
                </button>
              </div>

              {needsTargetSend && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleConnectSelected}
                  className="inline-flex min-h-[40px] w-full items-center justify-center gap-2 rounded-[10px] border border-[#16A34A]/40 bg-[#F0FDF4] px-4 text-xs font-semibold text-[#15803D] hover:bg-[#DCFCE7] disabled:opacity-50"
                >
                  <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>
                    {selectedTarget === 'ALL'
                      ? 'Send Screen to All Connected Peers'
                      : 'Send Screen to Selected Peer'}
                  </span>
                </button>
              )}
            </div>

            {errorToDisplay && (
              <div
                role="alert"
                className="rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]"
              >
                {errorToDisplay}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-3">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2.5">
              <h2 className="text-sm font-semibold text-[#172033]">Target Participants</h2>
              <button
                type="button"
                onClick={() => onNavigate('receivers')}
                className="text-xs font-medium text-[#2563EB] hover:underline"
              >
                Manage
              </button>
            </div>
            {!activeRoom || !isApprovedInRoom ? (
              <p className="text-xs text-[#64748B]">
                {activeRoom
                  ? `Awaiting approval in room ${activeRoom.roomId} (${pairingStatus}).`
                  : 'Create or join a room in Rooms to target participants.'}
              </p>
            ) : roomPeers.length === 0 ? (
              <p className="text-xs text-[#64748B]">
                No other paired participants connected in room {activeRoom.roomId} yet.
              </p>
            ) : (
              <div className="space-y-2">
                {connectedPeers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setSelectedTarget('ALL')}
                    className={`flex min-h-[38px] w-full items-center justify-between rounded-lg border px-3 text-xs font-medium ${
                      selectedTarget === 'ALL'
                        ? 'border-[#2563EB] bg-[#EFF6FF] text-[#2563EB]'
                        : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]'
                    }`}
                  >
                    <span>All Connected Participants ({connectedPeers.length})</span>
                  </button>
                )}
                <ul className="divide-y divide-[#E2E8F0] text-xs">
                  {roomPeers.map((peer) => (
                    <li key={peer.deviceId} className="flex items-center justify-between py-2.5 gap-2">
                      <button
                        type="button"
                        disabled={!peer.connected}
                        onClick={() => setSelectedTarget(peer.deviceId)}
                        className="min-w-0 flex-1 text-left disabled:opacity-50"
                      >
                        <div className="truncate font-semibold text-[#172033]">{peer.deviceName}</div>
                        <div className="text-[11px] text-[#64748B] tabular-metrics">
                          {peer.roleLabel} · {peer.platform}
                        </div>
                      </button>
                      <SignalBadge
                        label={peer.connected ? 'Connected' : 'Disconnected'}
                        tone={peer.connected ? 'active' : 'warn'}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className="min-w-0 space-y-4 lg:col-span-7" aria-label="Preview and Incoming">
          <IncomingScreensPanel
            streams={webrtcState.incomingStreams}
            onIncomingVideoDimensions={onIncomingVideoDimensions}
          />

          <VideoSurface
            slotLabel="My Screen"
            title={
              webrtcState.isSharingLocal
                ? activeOutboundTargets.length > 0
                  ? `Sharing → ${activeOutboundTargets.map((o) => o.targetName).join(', ')}`
                  : 'Local Outbound Preview'
                : 'Local Outbound Preview'
            }
            stream={webrtcState.localStream}
            muted
            highlight={webrtcState.isSharingLocal && webrtcState.phase === 'connected'}
            standbyReason="Click Share Screen to select a display, window, or tab."
            statusBadge={
              <SignalBadge
                label={webrtcState.isSharingLocal ? 'Sharing' : 'Standby'}
                tone={webrtcState.isSharingLocal ? 'active' : 'standby'}
              />
            }
          />

          <TelemetryStrip telemetry={webrtcState.outboundTelemetry} compact />
        </section>
      </div>

      <StreamingQualityDiagnosticsPanel
        preferences={preferences}
        webrtcState={webrtcState}
      />
    </div>
  );
}
