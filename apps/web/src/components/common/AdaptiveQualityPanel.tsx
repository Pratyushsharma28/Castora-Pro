import { useState } from 'react';
import { ChevronDown, ChevronUp, Gauge, Lock, SlidersHorizontal } from 'lucide-react';
import {
  QUALITY_PROFILE_ORDER,
  QUALITY_PROFILES,
  applyQualityProfileToPreferences,
  resolveProfileIdFromPreferences,
  resolveQualityTarget,
} from '../../services/videoQualityService';
import type { OutboundPeerEntry, WebRtcSessionSnapshot } from '../../services/webrtcSignalingBridge';
import type {
  AdaptiveControlCapabilities,
  CapturePreferences,
  NetworkConditionLevel,
  QualityProfileId,
} from '../../types/studio';

interface AdaptiveQualityPanelProps {
  preferences: CapturePreferences;
  onUpdatePreferences: (next: CapturePreferences) => void;
  onSetPeerQualityOverride?: (
    peerDeviceId: string,
    override: Partial<CapturePreferences> | null
  ) => void;
  webrtcState: WebRtcSessionSnapshot;
  defaultExpanded?: boolean;
}

function formatRate(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return 'Unavailable';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatCapRate(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return 'Unavailable';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatNetworkCondition(level: NetworkConditionLevel | null | undefined): {
  label: string;
  toneClass: string;
} {
  switch (level) {
    case 'healthy':
      return { label: 'Healthy', toneClass: 'text-[#15803D]' };
    case 'moderate':
      return { label: 'Moderate Load', toneClass: 'text-[#B45309]' };
    case 'congested':
      return { label: 'Congested', toneClass: 'text-[#DC2626]' };
    default:
      return { label: 'Stats Unavailable', toneClass: 'text-[#64748B]' };
  }
}

function summarizeSupportedControls(caps: AdaptiveControlCapabilities | null | undefined): string | null {
  if (!caps) return null;
  if (
    caps.supportsSetParameters &&
    caps.supportsMaxBitrate &&
    caps.supportsMaxFramerate &&
    caps.supportsScaleResolutionDownBy
  ) {
    return 'RTCRtpSender.setParameters supports bitrate, frame rate, and resolution scaling.';
  }
  if (!caps.supportsSetParameters) {
    return 'Browser rejected RTCRtpSender.setParameters; automatic encoder scaling is unavailable.';
  }
  const active: string[] = [];
  if (caps.supportsMaxBitrate) active.push('bitrate');
  if (caps.supportsMaxFramerate) active.push('frame rate');
  if (caps.supportsScaleResolutionDownBy) active.push('resolution scale');
  return `Partial encoder control in this browser: ${active.join(', ') || 'none'} supported.`;
}

function derivePeerCondition(peer: OutboundPeerEntry): NetworkConditionLevel {
  return peer.telemetry.networkCondition ?? 'unavailable';
}

export function AdaptiveQualityPanel({
  preferences,
  onUpdatePreferences,
  onSetPeerQualityOverride,
  webrtcState,
  defaultExpanded = true,
}: AdaptiveQualityPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const adaptiveEnabled = preferences.adaptiveBitrate !== false;
  const activeProfileId = resolveProfileIdFromPreferences(preferences);
  const resolvedGlobal = resolveQualityTarget(preferences, {
    width: webrtcState.localCaptureMeta?.width,
    height: webrtcState.localCaptureMeta?.height,
  });

  const primaryOut = webrtcState.outboundPeers[0] ?? null;
  const telemetry = primaryOut?.telemetry ?? webrtcState.outboundTelemetry;
  const netInfo = formatNetworkCondition(telemetry.networkCondition);

  const actualWidth =
    telemetry.encodedWidth ?? telemetry.captureWidth ?? webrtcState.localCaptureMeta?.width ?? null;
  const actualHeight =
    telemetry.encodedHeight ??
    telemetry.captureHeight ??
    webrtcState.localCaptureMeta?.height ??
    null;
  const actualResLabel =
    actualWidth && actualHeight ? `${actualWidth}×${actualHeight}` : 'Not streaming';
  const actualFps =
    telemetry.encodedFps ?? telemetry.captureFps ?? webrtcState.localCaptureMeta?.fps ?? null;
  const currentTargetFps = telemetry.targetFramerate ?? preferences.targetFps;
  const currentTargetBitrate =
    telemetry.targetBitrateKbps ??
    (webrtcState.isSharingLocal ? resolvedGlobal.configuredMaxBitrateKbps : null);
  const scaleFactor = telemetry.scaleResolutionDownBy ?? 1.0;

  const adjustmentText = !adaptiveEnabled
    ? 'Manual mode locked — automatic quality changes disabled.'
    : telemetry.lastAdjustmentReason
      ? telemetry.lastAdjustmentReason
      : webrtcState.isSharingLocal
        ? 'Operating at target profile — monitoring live getStats() metrics.'
        : `Ready at ${
            activeProfileId ? QUALITY_PROFILES[activeProfileId].label : preferences.resolution.toUpperCase()
          } (${resolvedGlobal.targetFps} FPS).`;

  const adjustmentTimeLabel =
    adaptiveEnabled && telemetry.lastAdjustmentAt
      ? new Date(telemetry.lastAdjustmentAt).toLocaleTimeString()
      : null;

  const controlSupportNote = summarizeSupportedControls(telemetry.supportedAdaptiveControls);

  const handleSelectMode = (nextAuto: boolean) => {
    if (nextAuto === adaptiveEnabled) return;
    onUpdatePreferences({
      ...preferences,
      adaptiveBitrate: nextAuto,
    });
  };

  const handleSelectProfile = (profileId: QualityProfileId) => {
    onUpdatePreferences(applyQualityProfileToPreferences(preferences, profileId));
  };

  const rttText =
    telemetry.rttMs !== null && telemetry.rttMs !== undefined
      ? `${Math.round(telemetry.rttMs)} ms`
      : '—';
  const lossText =
    telemetry.packetLossPct !== null && telemetry.packetLossPct !== undefined
      ? `${telemetry.packetLossPct.toFixed(1)}%`
      : '—';
  const jitterText =
    telemetry.jitterMs !== null && telemetry.jitterMs !== undefined
      ? `${telemetry.jitterMs.toFixed(1)} ms`
      : '—';
  const availText =
    telemetry.availableOutgoingBitrateKbps !== null &&
    telemetry.availableOutgoingBitrateKbps !== undefined
      ? formatCapRate(telemetry.availableOutgoingBitrateKbps)
      : '—';

  return (
    <section
      data-castora-chrome
      aria-label="Adaptive Streaming Quality"
      className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      {/* Header Row */}
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-[#172033]">
                Adaptive Streaming Quality
              </h2>
            </div>
            <span className="text-xs font-semibold text-[#2563EB]">
              {adaptiveEnabled ? 'Auto Mode' : 'Manual Mode'}
            </span>
            <span className={`text-xs font-medium ${netInfo.toneClass}`}>
              · Network: {netInfo.label}
            </span>
          </div>
          <p className="text-xs text-[#64748B]">
            Monitors WebRTC RTT, loss, jitter, dropped frames, and estimated uplink per peer without renegotiating SDP.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div
            role="group"
            aria-label="Quality Control Mode"
            className="inline-flex rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-0.5"
          >
            <button
              type="button"
              onClick={() => handleSelectMode(true)}
              className={`min-h-[30px] rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                adaptiveEnabled
                  ? 'bg-white text-[#172033] shadow-xs'
                  : 'text-[#64748B] hover:text-[#172033]'
              }`}
            >
              Auto
            </button>
            <button
              type="button"
              onClick={() => handleSelectMode(false)}
              className={`min-h-[30px] rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                !adaptiveEnabled
                  ? 'bg-white text-[#172033] shadow-xs'
                  : 'text-[#64748B] hover:text-[#172033]'
              }`}
            >
              Manual
            </button>
          </div>

          {adaptiveEnabled && (
            <button
              type="button"
              onClick={() => handleSelectMode(false)}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] whitespace-nowrap"
            >
              <Lock className="h-3 w-3" aria-hidden="true" />
              <span>Return to Manual</span>
            </button>
          )}

          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
          >
            <span>{expanded ? 'Hide Controls' : 'Show Controls'}</span>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <>
          {/* Quality Profiles Selector */}
          <div className="border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3.5 sm:px-5 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5 font-medium text-[#172033]">
                <SlidersHorizontal className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
                <span>Quality Profile</span>
              </div>
              <span className="text-[11px] text-[#64748B]">
                {activeProfileId
                  ? `Selected: ${QUALITY_PROFILES[activeProfileId].label} (${QUALITY_PROFILES[activeProfileId].specLabel})`
                  : `Custom (${preferences.resolution.toUpperCase()} · ${preferences.targetFps} FPS · ${formatCapRate(resolvedGlobal.configuredMaxBitrateKbps)})`}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {QUALITY_PROFILE_ORDER.map((id) => {
                const profile = QUALITY_PROFILES[id];
                const isSelected = activeProfileId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handleSelectProfile(id)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? 'border-[#2563EB] bg-[#EFF6FF]'
                        : 'border-[#E2E8F0] bg-white hover:border-[#2563EB]/60'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span
                        className={`text-xs font-semibold ${
                          isSelected ? 'text-[#2563EB]' : 'text-[#172033]'
                        }`}
                      >
                        {profile.label}
                      </span>
                      {profile.isDefault && (
                        <span className="text-[11px] font-medium text-[#64748B]">Default</span>
                      )}
                    </div>
                    <span className="mt-0.5 text-[11px] text-[#64748B] tabular-metrics">
                      {profile.specLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live Readouts Strip */}
          <div className="grid grid-cols-2 divide-y divide-[#E2E8F0] border-t border-[#E2E8F0] bg-white sm:grid-cols-4 sm:divide-x sm:divide-y-0 tabular-metrics">
            <div className="px-4 py-3">
              <div className="text-[11px] font-medium text-[#64748B]">Actual Resolution</div>
              <div className="mt-0.5 text-sm font-semibold text-[#172033]">{actualResLabel}</div>
              <div className="mt-0.5 text-[11px] text-[#64748B]">
                {scaleFactor > 1
                  ? `Encoder scale: ${scaleFactor.toFixed(1)}× down`
                  : `Requested: ${preferences.resolution.toUpperCase()}`}
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] font-medium text-[#64748B]">Current FPS</div>
              <div className="mt-0.5 text-sm font-semibold text-[#172033]">
                {actualFps !== null && Number.isFinite(actualFps)
                  ? `${actualFps.toFixed(1)} FPS`
                  : 'Unavailable'}
              </div>
              <div className="mt-0.5 text-[11px] text-[#64748B]">
                Target cap: {currentTargetFps} FPS
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] font-medium text-[#64748B]">Current Bitrate</div>
              <div className="mt-0.5 text-sm font-semibold text-[#172033]">
                {formatRate(telemetry.bitrateKbps)}
              </div>
              <div className="mt-0.5 text-[11px] text-[#64748B]">
                Target cap: {formatCapRate(currentTargetBitrate)}
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] font-medium text-[#64748B]">Network Assessment</div>
              <div className={`mt-0.5 text-sm font-semibold ${netInfo.toneClass}`}>
                {netInfo.label}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-[#64748B]">
                RTT {rttText} · Loss {lossText} · Jitter {jitterText}
                {availText !== '—' ? ` · Est ${availText}` : ''}
              </div>
            </div>
          </div>

          {/* Last Automatic Adjustment Explanation */}
          <div className="flex flex-col gap-2 border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-semibold text-[#172033]">Last Adjustment:</span>
                <span className="text-[#172033]">{adjustmentText}</span>
                {adjustmentTimeLabel && (
                  <span className="font-mono text-[11px] text-[#64748B] tabular-metrics">
                    ({adjustmentTimeLabel})
                  </span>
                )}
              </div>
              {controlSupportNote && (
                <p className="text-[11px] text-[#64748B]">{controlSupportNote}</p>
              )}
            </div>
          </div>

          {/* Per-Peer Independent Adaptation Status (up to 6 receivers) */}
          <div className="border-t border-[#E2E8F0] bg-white">
            {webrtcState.outboundPeers.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[#64748B] sm:px-5">
                Per-peer adaptive status activates once you share your screen with connected room participants (up to 6 peers, each adapted independently).
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-medium text-[#64748B]">
                    <tr>
                      <th className="px-4 py-2">Receiving Peer</th>
                      <th className="px-4 py-2">Mode</th>
                      <th className="px-4 py-2">Network</th>
                      <th className="px-4 py-2">Actual Output</th>
                      <th className="px-4 py-2">Target Ceiling</th>
                      <th className="px-4 py-2">Adaptation State &amp; Reason</th>
                      {onSetPeerQualityOverride && <th className="px-4 py-2 text-right">Lock</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2E8F0] tabular-metrics">
                    {webrtcState.outboundPeers.map((peer) => {
                      const peerNet = formatNetworkCondition(derivePeerCondition(peer));
                      const peerAuto =
                        (peer.qualityOverride?.adaptiveBitrate ?? preferences.adaptiveBitrate) !==
                        false;
                      const peerScale = peer.telemetry.scaleResolutionDownBy ?? 1.0;
                      const peerTargetFps =
                        peer.telemetry.targetFramerate ??
                        peer.qualityOverride?.targetFps ??
                        preferences.targetFps;
                      const peerRes =
                        peer.telemetry.encodedWidth && peer.telemetry.encodedHeight
                          ? `${peer.telemetry.encodedWidth}×${peer.telemetry.encodedHeight}`
                          : peer.telemetry.resolution ?? 'Negotiating';
                      const peerFps =
                        peer.telemetry.encodedFps !== null && peer.telemetry.encodedFps !== undefined
                          ? `${peer.telemetry.encodedFps.toFixed(0)} FPS`
                          : '—';
                      const peerReason =
                        peer.telemetry.lastAdjustmentReason ??
                        (peerAuto ? 'At configured target' : 'Manual locked');

                      return (
                        <tr key={peer.targetDeviceId}>
                          <td className="px-4 py-2 font-sans font-medium text-[#172033]">
                            {peer.targetName}
                          </td>
                          <td className="px-4 py-2 font-sans text-[#172033]">
                            {peerAuto ? 'Auto' : 'Manual'}
                          </td>
                          <td className={`px-4 py-2 font-sans font-medium ${peerNet.toneClass}`}>
                            {peerNet.label}
                          </td>
                          <td className="px-4 py-2 text-[#172033]">
                            {peerRes} · {peerFps} · {formatRate(peer.telemetry.bitrateKbps)}
                          </td>
                          <td className="px-4 py-2 text-[#172033]">
                            {formatCapRate(peer.telemetry.targetBitrateKbps)} · {peerTargetFps} FPS
                            {peerScale > 1 ? ` · ${peerScale.toFixed(1)}× scale` : ''}
                          </td>
                          <td className="max-w-[280px] truncate px-4 py-2 font-sans text-[#64748B]" title={peerReason}>
                            {peerReason}
                          </td>
                          {onSetPeerQualityOverride && (
                            <td className="px-4 py-2 text-right font-sans">
                              <button
                                type="button"
                                onClick={() =>
                                  onSetPeerQualityOverride(peer.targetDeviceId, {
                                    adaptiveBitrate: !peerAuto,
                                  })
                                }
                                className="rounded-md border border-[#E2E8F0] bg-[#F8FAFC] px-2 py-1 text-[11px] font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                              >
                                {peerAuto ? 'Lock Manual' : 'Use Auto'}
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
