import { useState } from 'react';
import { AlertTriangle, MonitorPlay, Square, Volume2, VolumeX } from 'lucide-react';
import type { PairingLifecycleStatus, RoomSnapshot } from '../services/backendClient';
import type {
  BrowserCapabilityReport,
  CapturePreferences,
  CodecPreference,
  ConnectedReceiverSlot,
  FrameRateTarget,
  ResolutionPresetId,
  StreamTelemetrySnapshot,
  StudioDestination,
} from '../types/studio';
import { SignalBadge } from '../components/common/SignalBadge';
import { TelemetryStrip } from '../components/common/TelemetryStrip';
import { VideoSurface } from '../components/common/VideoSurface';

interface CastViewProps {
  capabilities: BrowserCapabilityReport;
  preferences: CapturePreferences;
  onUpdatePreferences: (next: CapturePreferences) => void;
  localStream: MediaStream | null;
  receivers: ConnectedReceiverSlot[];
  activeRoom: RoomSnapshot | null;
  pairingStatus: PairingLifecycleStatus;
  programTelemetry: StreamTelemetrySnapshot;
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

export function CastView({
  capabilities,
  preferences,
  onUpdatePreferences,
  localStream,
  receivers,
  activeRoom,
  pairingStatus,
  programTelemetry,
  onNavigate,
  onLogEvent,
}: CastViewProps) {
  const [stageNotice, setStageNotice] = useState<string | null>(null);

  const canCapture = capabilities.isSecureContext && capabilities.supportsDisplayMedia;
  const pairedReceivers = activeRoom?.pairedReceivers ?? [];
  const connectedCount = pairedReceivers.filter((r) => r.connected).length;

  const handleRequestStartCapture = () => {
    if (!capabilities.isSecureContext) {
      const msg =
        'Screen capture blocked: current origin is non-secure HTTP. Trust local HTTPS certificate first (see Settings).';
      setStageNotice(msg);
      onLogEvent('capability', 'Capture blocked (insecure origin)', msg);
      return;
    }
    if (!capabilities.supportsDisplayMedia) {
      const msg =
        'navigator.mediaDevices.getDisplayMedia() is not exposed by this browser. Mobile Android browsers typically operate as receivers.';
      setStageNotice(msg);
      onLogEvent('capability', 'Display capture unsupported', msg);
      return;
    }
    const msg =
      activeRoom && pairedReceivers.length > 0
        ? `Room ${activeRoom.roomId} has ${connectedCount} connected paired receiver(s) ready. Live screen capture & WebRTC SDP/ICE streaming activate in Stage 4.`
        : 'Stage 3 pairing active. Create a room and approve receivers in the Receivers tab; live getDisplayMedia() + WebRTC streaming activate in Stage 4.';
    setStageNotice(msg);
    onLogEvent(
      'ui',
      'Cast Studio capture readiness checked',
      `Configured ${preferences.resolution} @ ${preferences.targetFps} FPS target (${preferences.codecPreference}). Room=${activeRoom?.roomId ?? 'none'}, Pairing=${pairingStatus}.`
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
            Cast Studio
          </h1>
          <p className="text-xs text-[#929A9D]">
            Configure sender capture targets, inspect browser encode readiness, and monitor paired outbound receivers.
          </p>
        </div>
        <SignalBadge
          label={canCapture ? 'DISPLAY CAPTURE AVAILABLE' : 'CAPTURE RESTRICTED'}
          tone={canCapture ? 'active' : 'warn'}
        />
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
              Mac desktop Chrome/Edge/Safari on HTTPS supports screen capture; Android Chrome should use the Receivers tab to view streams.
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Capture Configuration & Receiver Selection */}
        <section className="space-y-4 lg:col-span-5" aria-label="Capture Parameters">
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-5">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Capture Constraints
              </h2>
              <span className="font-mono text-[11px] text-[#929A9D]">Sender Policy</span>
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
                        onLogEvent('ui', 'Sender FPS target updated', `Target set to ${opt.value} FPS (measured FPS reported live).`);
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
                Actual capture and encoded FPS depend on browser ScreenCaptureKit pacing, GPU encoder load, and receiver count (tested 1 → 2 → 3 → 6).
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

            {/* Capture Action */}
            <div className="border-t border-[#252A2F] pt-4 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleRequestStartCapture}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 bg-[#FF7849] px-4 text-xs font-semibold text-[#101214] hover:opacity-90"
              >
                <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                <span>{localStream ? 'Replace Capture Source' : 'Start Screen Capture'}</span>
              </button>
              <button
                type="button"
                disabled={!localStream}
                onClick={() => setStageNotice('No active capture stream to stop.')}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 border border-[#252A2F] bg-[#131619] px-4 text-xs font-medium text-[#929A9D] disabled:opacity-50"
              >
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Stop</span>
              </button>
            </div>

            {stageNotice && (
              <div className="border border-[#252A2F] bg-[#131619] px-3 py-2.5 text-xs leading-relaxed text-[#F2F3F0]">
                {stageNotice}
              </div>
            )}
          </div>

          {/* Target Receiver Roster */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Paired Target Receivers
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

            {!activeRoom ? (
              <p className="text-xs leading-relaxed text-[#929A9D]">
                No active room. Create a room and approve receivers in Receivers &amp; Pairing to populate real paired targets here.
              </p>
            ) : pairedReceivers.length === 0 ? (
              <p className="text-xs leading-relaxed text-[#929A9D]">
                Room <span className="font-mono text-[#F2F3F0]">{activeRoom.roomId}</span> has 0 paired receivers ({activeRoom.pendingCount} awaiting approval).
              </p>
            ) : (
              <ul className="divide-y divide-[#252A2F] text-xs">
                {pairedReceivers.map((rx) => (
                  <li key={rx.deviceId} className="flex items-center justify-between py-2 gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[#F2F3F0]">{rx.deviceName}</div>
                      <div className="font-mono text-[11px] text-[#929A9D] tabular-metrics">
                        SLOT {String(rx.assignedSlotIndex + 1).padStart(2, '0')} · {rx.platform}
                      </div>
                    </div>
                    <SignalBadge
                      label={rx.connected ? 'Paired' : 'Disconnected'}
                      tone={rx.connected ? 'active' : 'warn'}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Right: Local Preview & Measured Encoding Workload */}
        <section className="space-y-4 lg:col-span-7" aria-label="Local Capture Preview and Workload">
          <VideoSurface
            slotLabel="CAP-01"
            title="Local Screen Capture Preview"
            stream={localStream}
            muted
            standbyReason="Capture pipeline is in standby. Real frames from getDisplayMedia() will render here with measured Capture FPS vs Encoded FPS in Stage 4."
            statusBadge={
              <SignalBadge
                label={localStream ? 'CAPTURING' : 'STANDBY'}
                tone={localStream ? 'active' : 'standby'}
              />
            }
          />

          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Encoder & Outbound Workload
              </h2>
              <span className="font-mono text-xs text-[#929A9D] tabular-metrics">
                {receivers.length} active outbound stream{receivers.length === 1 ? '' : 's'}
              </span>
            </div>
            <TelemetryStrip telemetry={programTelemetry} />
            <p className="text-[11px] leading-relaxed text-[#929A9D]">
              Stage 3 pairing verifies up to 6 authorized receivers per room; Stage 4 enables progressive stream fan-out (1 → 2 → 3 → 6) with live encoder measurement.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
