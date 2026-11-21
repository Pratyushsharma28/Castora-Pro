import { useEffect, useState } from 'react';
import { AlertTriangle, MonitorPlay, Radio, Square, Volume2, VolumeX } from 'lucide-react';
import type { PairingLifecycleStatus, RoomSnapshot } from '../services/backendClient';
import type { WebRtcSessionSnapshot } from '../services/webrtcSignalingBridge';
import type {
  BrowserCapabilityReport,
  CapturePreferences,
  CodecPreference,
  FrameRateTarget,
  ResolutionPresetId,
  StudioDestination,
  WebRtcConnectionPhase,
} from '../types/studio';
import { SignalBadge, type SignalTone } from '../components/common/SignalBadge';
import { TelemetryStrip } from '../components/common/TelemetryStrip';
import { VideoSurface } from '../components/common/VideoSurface';

interface CastViewProps {
  capabilities: BrowserCapabilityReport;
  preferences: CapturePreferences;
  onUpdatePreferences: (next: CapturePreferences) => void;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  pairingStatus: PairingLifecycleStatus;
  webrtcState: WebRtcSessionSnapshot;
  onStartSharing: (targetReceiverId: string | null) => Promise<void>;
  onConnectReceiver: (targetReceiverId: string) => Promise<void>;
  onStopSharing: () => void;
  onNavigate: (destination: StudioDestination) => void;
  onLogEvent: (category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error', title: string, detail: string) => void;
}

const RESOLUTION_OPTIONS: { id: ResolutionPresetId; label: string; detail: string }[] = [
  { id: '1080p', label: '1080p', detail: '1920 × 1080 target' },
  { id: '720p', label: '720p', detail: '1280 × 720 target' },
  { id: 'native', label: 'Native', detail: 'Display native bounds' },
];

const FPS_OPTIONS: { value: FrameRateTarget; label: string }[] = [
  { value: 60, label: '60 FPS Target' },
  { value: 30, label: '30 FPS Target' },
];

const CODEC_OPTIONS: { value: CodecPreference; label: string }[] = [
  { value: 'H264', label: 'H.264 Preferred' },
  { value: 'AUTO', label: 'Auto Negotiate' },
];

function webrtcPhaseBadge(phase: WebRtcConnectionPhase): { label: string; tone: SignalTone; pulse?: boolean } {
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

export function CastView({
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
  onLogEvent,
}: CastViewProps) {
  const [selectedReceiverId, setSelectedReceiverId] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canCapture = capabilities.isSecureContext && capabilities.supportsDisplayMedia;
  const pairedReceivers = activeRoomRole === 'host' ? (activeRoom?.pairedReceivers ?? []) : [];
  const connectedReceivers = pairedReceivers.filter((r) => r.connected);
  const connectedCount = connectedReceivers.length;

  useEffect(() => {
    if (connectedReceivers.length === 0) {
      setSelectedReceiverId(null);
      return;
    }
    const stillValid = connectedReceivers.some((r) => r.deviceId === selectedReceiverId);
    if (!stillValid) {
      setSelectedReceiverId(connectedReceivers[0].deviceId);
    }
  }, [connectedReceivers, selectedReceiverId]);

  const handleRequestStartSharing = async () => {
    setLocalError(null);
    setBusy(true);
    try {
      await onStartSharing(selectedReceiverId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to start screen sharing';
      setLocalError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleConnectSelected = async () => {
    if (!selectedReceiverId) return;
    setLocalError(null);
    setBusy(true);
    try {
      await onConnectReceiver(selectedReceiverId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to connect WebRTC peer';
      setLocalError(msg);
    } finally {
      setBusy(false);
    }
  };

  const badge = webrtcPhaseBadge(webrtcState.phase);
  const errorToDisplay = localError ?? webrtcState.errorMessage;
  const activeTarget = connectedReceivers.find((r) => r.deviceId === webrtcState.targetPeerDeviceId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
            Cast Studio
          </h1>
          <p className="text-xs text-[#929A9D]">
            Capture a display, window, or tab via getDisplayMedia() and stream real-time WebRTC video to an approved receiver.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SignalBadge label={badge.label} tone={badge.tone} pulse={badge.pulse} />
          <SignalBadge
            label={canCapture ? 'DISPLAY CAPTURE READY' : 'CAPTURE RESTRICTED'}
            tone={canCapture ? 'active' : 'warn'}
          />
        </div>
      </div>

      {!canCapture && (
        <div
          role="alert"
          className="flex items-start gap-3 border border-[#F59E0B]/50 bg-[#191D20] px-4 py-3 text-xs leading-relaxed text-[#F2F3F0]"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#F59E0B]" aria-hidden="true" />
          <div>
            <span className="font-semibold text-[#F59E0B]">
              {!capabilities.isSecureContext
                ? 'Secure HTTPS origin required for getDisplayMedia.'
                : 'getDisplayMedia is unavailable in this browser.'}
            </span>{' '}
            <span className="text-[#929A9D]">
              Mac desktop Chrome, Edge, or Safari over HTTPS/localhost supports screen sharing.
            </span>
          </div>
        </div>
      )}

      {activeRoomRole === 'receiver' && (
        <div className="flex items-center justify-between gap-3 border border-[#252A2F] bg-[#191D20] px-4 py-3 text-xs text-[#929A9D]">
          <span>
            This browser is currently joined to room <strong className="font-mono text-[#F2F3F0]">{activeRoom?.roomId}</strong> as a receiver. Switch to Receivers &amp; Pairing to view inbound video.
          </span>
          <button
            type="button"
            onClick={() => onNavigate('receivers')}
            className="shrink-0 border border-[#252A2F] bg-[#131619] px-3 py-1.5 font-medium text-[#F2F3F0] hover:border-[#FF7849]"
          >
            Open Receiver Player
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Capture Configuration & Receiver Target */}
        <section className="space-y-4 lg:col-span-5" aria-label="Capture Parameters">
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-5">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Capture Constraints
              </h2>
              <span className="font-mono text-[11px] text-[#929A9D]">Stage 4A · 1:1 WebRTC</span>
            </div>

            {/* Resolution */}
            <fieldset className="space-y-2">
              <legend className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#929A9D]">
                Resolution Target
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {RESOLUTION_OPTIONS.map((opt) => {
                  const selected = preferences.resolution === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        onUpdatePreferences({ ...preferences, resolution: opt.id });
                        onLogEvent('ui', 'Sender resolution target updated', `Target set to ${opt.label} (${opt.detail}).`);
                      }}
                      className={`min-h-[44px] border px-2.5 py-2 text-left transition-colors ${
                        selected
                          ? 'border-[#FF7849] bg-[#131619] text-[#F2F3F0]'
                          : 'border-[#252A2F] bg-[#131619] text-[#929A9D] hover:text-[#F2F3F0]'
                      }`}
                    >
                      <div className="text-xs font-semibold tabular-metrics">{opt.label}</div>
                      <div className="mt-0.5 text-[10px] text-[#929A9D]">{opt.detail}</div>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Frame rate */}
            <fieldset className="space-y-2">
              <legend className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#929A9D]">
                Frame Rate Target
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {FPS_OPTIONS.map((opt) => {
                  const selected = preferences.targetFps === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        onUpdatePreferences({ ...preferences, targetFps: opt.value });
                        onLogEvent('ui', 'Sender FPS target updated', `Target set to ${opt.value} FPS.`);
                      }}
                      className={`min-h-[44px] border px-3 py-2 text-left text-xs font-medium tabular-metrics transition-colors ${
                        selected
                          ? 'border-[#FF7849] bg-[#131619] text-[#F2F3F0]'
                          : 'border-[#252A2F] bg-[#131619] text-[#929A9D] hover:text-[#F2F3F0]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] leading-relaxed text-[#929A9D]">
                Starts at 1080p / 60 FPS target where supported. Actual FPS and resolution are measured live from RTCPeerConnection.getStats().
              </p>
            </fieldset>

            {/* Codec & Audio */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <fieldset className="space-y-2">
                <legend className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#929A9D]">
                  Codec Policy
                </legend>
                <div className="space-y-1.5">
                  {CODEC_OPTIONS.map((opt) => {
                    const selected = preferences.codecPreference === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          onUpdatePreferences({ ...preferences, codecPreference: opt.value });
                          onLogEvent('ui', 'Codec preference updated', `Codec policy: ${opt.label}`);
                        }}
                        className={`flex min-h-[40px] w-full items-center justify-between border px-3 text-xs font-medium transition-colors ${
                          selected
                            ? 'border-[#FF7849] bg-[#131619] text-[#F2F3F0]'
                            : 'border-[#252A2F] bg-[#131619] text-[#929A9D] hover:text-[#F2F3F0]'
                        }`}
                      >
                        <span>{opt.label}</span>
                        {opt.value === 'H264' && (
                          <span className="font-mono text-[10px] text-[#929A9D]">
                            {capabilities.supportsVideoH264Encode ? 'HW/SW OK' : 'UNAVAILABLE'}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#929A9D]">
                  System / Tab Audio
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = !preferences.includeAudio;
                    onUpdatePreferences({ ...preferences, includeAudio: next });
                    onLogEvent('ui', 'Capture audio toggled', next ? 'Audio capture enabled' : 'Audio capture disabled');
                  }}
                  className={`flex min-h-[44px] w-full items-center justify-between border px-3 text-xs font-medium transition-colors ${
                    preferences.includeAudio
                      ? 'border-[#FF7849] bg-[#131619] text-[#F2F3F0]'
                      : 'border-[#252A2F] bg-[#131619] text-[#929A9D]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {preferences.includeAudio ? (
                      <Volume2 className="h-3.5 w-3.5 text-[#FF7849]" aria-hidden="true" />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{preferences.includeAudio ? 'Include Audio' : 'Video Only'}</span>
                  </span>
                  <span className="font-mono text-[10px] uppercase">
                    {preferences.includeAudio ? 'ON' : 'OFF'}
                  </span>
                </button>
              </div>
            </div>

            {/* Capture Action Buttons */}
            <div className="border-t border-[#252A2F] pt-4 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={busy || !canCapture || activeRoomRole === 'receiver'}
                  onClick={handleRequestStartSharing}
                  className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 bg-[#FF7849] px-4 text-xs font-semibold text-[#101214] hover:opacity-90 disabled:opacity-50"
                >
                  <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {busy
                      ? 'Requesting Screen...'
                      : webrtcState.localStream
                        ? 'Replace Shared Screen'
                        : 'Start Sharing'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!webrtcState.localStream}
                  onClick={onStopSharing}
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 border border-[#EF4444]/60 bg-[#131619] px-4 text-xs font-semibold text-[#EF4444] hover:bg-[#EF4444]/10 disabled:border-[#252A2F] disabled:text-[#929A9D] disabled:opacity-50"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Stop Sharing</span>
                </button>
              </div>

              {webrtcState.localStream &&
                selectedReceiverId &&
                webrtcState.targetPeerDeviceId !== selectedReceiverId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleConnectSelected}
                    className="inline-flex min-h-[40px] w-full items-center justify-center gap-2 border border-[#8BD7B0]/60 bg-[#131619] px-4 text-xs font-semibold text-[#8BD7B0] hover:bg-[#8BD7B0]/10 disabled:opacity-50"
                  >
                    <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Transmit Active Screen to Selected Receiver</span>
                  </button>
                )}
            </div>

            {errorToDisplay && (
              <div
                role="alert"
                className="border border-[#EF4444]/60 bg-[#131619] px-3 py-2.5 text-xs leading-relaxed text-[#EF4444]"
              >
                {errorToDisplay}
              </div>
            )}

            {!errorToDisplay && webrtcState.statusDetail && (
              <div className="border border-[#252A2F] bg-[#131619] px-3 py-2.5 text-xs leading-relaxed text-[#F2F3F0]">
                {webrtcState.statusDetail}
              </div>
            )}
          </div>

          {/* Target Receiver Roster */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Approved Target Receiver
              </h2>
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-[#929A9D] tabular-metrics">
                  {connectedCount} / {activeRoom?.maxReceivers ?? 6}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate('receivers')}
                  className="text-[11px] font-medium text-[#FF7849] hover:underline"
                >
                  Manage
                </button>
              </div>
            </div>

            {!activeRoom || activeRoomRole !== 'host' ? (
              <p className="text-xs leading-relaxed text-[#929A9D]">
                No active host room. Create a room and approve Mac B in Receivers &amp; Pairing ({pairingStatus}).
              </p>
            ) : pairedReceivers.length === 0 ? (
              <p className="text-xs leading-relaxed text-[#929A9D]">
                Room <span className="font-mono text-[#F2F3F0]">{activeRoom.roomId}</span> has 0 paired receivers ({activeRoom.pendingCount} awaiting approval).
              </p>
            ) : (
              <ul className="divide-y divide-[#252A2F] text-xs">
                {pairedReceivers.map((rx) => {
                  const isSelected = selectedReceiverId === rx.deviceId;
                  const isActiveTarget = webrtcState.targetPeerDeviceId === rx.deviceId;
                  return (
                    <li key={rx.deviceId} className="flex items-center justify-between py-2.5 gap-2">
                      <button
                        type="button"
                        disabled={!rx.connected}
                        onClick={() => setSelectedReceiverId(rx.deviceId)}
                        className="min-w-0 flex-1 text-left disabled:opacity-50"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              isSelected ? 'bg-[#FF7849]' : 'bg-[#252A2F]'
                            }`}
                          />
                          <span className="truncate font-medium text-[#F2F3F0]">{rx.deviceName}</span>
                        </div>
                        <div className="mt-0.5 pl-4 font-mono text-[11px] text-[#929A9D] tabular-metrics">
                          SLOT {String(rx.assignedSlotIndex + 1).padStart(2, '0')} · {rx.platform}
                        </div>
                      </button>
                      <SignalBadge
                        label={
                          isActiveTarget
                            ? badge.label
                            : rx.connected
                              ? 'Paired'
                              : 'Disconnected'
                        }
                        tone={
                          isActiveTarget
                            ? badge.tone
                            : rx.connected
                              ? 'active'
                              : 'warn'
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Right: Local Preview & Measured Encoding Workload */}
        <section className="space-y-4 lg:col-span-7" aria-label="Local Capture Preview and Workload">
          <VideoSurface
            slotLabel="CAP-01"
            title={
              webrtcState.localStream
                ? activeTarget
                  ? `Local Screen Preview → ${activeTarget.deviceName}`
                  : 'Local Screen Capture Preview'
                : 'Local Screen Capture Preview'
            }
            stream={webrtcState.localStream}
            muted
            highlight={webrtcState.phase === 'connected'}
            standbyReason="Click Start Sharing and choose a display, window, or tab in the browser picker to begin real screen capture and WebRTC transmission."
            statusBadge={
              <SignalBadge
                label={
                  webrtcState.phase === 'connected'
                    ? 'LIVE WEBRTC'
                    : webrtcState.localStream
                      ? 'LOCAL PREVIEW'
                      : 'STANDBY'
                }
                tone={
                  webrtcState.phase === 'connected'
                    ? 'active'
                    : webrtcState.localStream
                      ? 'signal'
                      : 'standby'
                }
              />
            }
          />

          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#252A2F] pb-2">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Live WebRTC Encoder Telemetry (getStats)
              </h2>
              <span className="font-mono text-xs text-[#929A9D] tabular-metrics">
                ICE: {webrtcState.iceConnectionState ?? 'idle'}
              </span>
            </div>
            <TelemetryStrip telemetry={webrtcState.telemetry} />
          </div>
        </section>
      </div>
    </div>
  );
}
