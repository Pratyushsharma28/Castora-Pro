import { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import {
  buildStageDiagnosticsSummary,
  evaluateConnectionQuality,
  evaluateQualityVerification,
  formatDimensionsLabel,
  inferPresetFromDimensions,
  type QualityVerificationResult,
} from '../../services/streamingDiagnosticsService';
import type { WebRtcSessionSnapshot } from '../../services/webrtcSignalingBridge';
import type {
  AudioDiagnosticState,
  CapturePreferences,
  QualityVerificationStatus,
  WebRtcConnectionPhase,
} from '../../types/studio';

interface StreamingQualityDiagnosticsPanelProps {
  preferences: CapturePreferences;
  webrtcState: WebRtcSessionSnapshot;
  defaultExpanded?: boolean;
  onRetryPeer?: (peerDeviceId: string) => void;
}

function formatRate(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) {
    return 'Unavailable';
  }
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatFps(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || !Number.isFinite(fps)) {
    return 'Unavailable';
  }
  return `${fps.toFixed(1)} FPS`;
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'Unavailable';
  }
  return Math.round(value).toLocaleString();
}

function formatAudioTraffic(
  packets: number | null | undefined,
  bytes: number | null | undefined
): string {
  if (packets === null || packets === undefined) {
    return 'Unavailable';
  }
  if (bytes !== null && bytes !== undefined) {
    const kb = (bytes / 1024).toFixed(1);
    return `${Math.round(packets).toLocaleString()} pkts (${kb} KB)`;
  }
  return `${Math.round(packets).toLocaleString()} pkts`;
}

function audioDiagnosticBadgeClass(status: AudioDiagnosticState): {
  dot: string;
  text: string;
} {
  switch (status) {
    case 'Audio successfully playing':
      return { dot: 'bg-[#16A34A]', text: 'text-[#15803D]' };
    case 'Audio received but playback blocked':
      return { dot: 'bg-[#D97706]', text: 'text-[#B45309]' };
    case 'Audio not transmitted':
    case 'Audio not received':
      return { dot: 'bg-[#DC2626]', text: 'text-[#B91C1C]' };
    default:
      return { dot: 'bg-[#94A3B8]', text: 'text-[#64748B]' };
  }
}

function formatConnectionLabel(phase: WebRtcConnectionPhase): string {
  switch (phase) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'failed':
      return 'Failed';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Standby';
  }
}

function statusAccentClasses(tone: QualityVerificationResult['tone']): {
  dot: string;
  text: string;
} {
  switch (tone) {
    case 'verified':
      return { dot: 'bg-[#16A34A]', text: 'text-[#15803D]' };
    case 'warn':
      return { dot: 'bg-[#D97706]', text: 'text-[#B45309]' };
    default:
      return { dot: 'bg-[#94A3B8]', text: 'text-[#64748B]' };
  }
}

function StatusLabel({
  status,
  tone,
}: {
  status: QualityVerificationStatus;
  tone: QualityVerificationResult['tone'];
}) {
  const accent = statusAccentClasses(tone);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${accent.text}`}>
      <span className={`h-2 w-2 rounded-full shrink-0 ${accent.dot}`} aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

export function StreamingQualityDiagnosticsPanel({
  preferences,
  webrtcState,
  defaultExpanded = true,
  onRetryPeer,
}: StreamingQualityDiagnosticsPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const primaryIncoming = webrtcState.incomingStreams[0] ?? null;
  const primaryOutbound = webrtcState.outboundPeers[0] ?? null;
  const summary = buildStageDiagnosticsSummary({
    preferences,
    connectionState: webrtcState.phase,
    isSharingLocal: webrtcState.isSharingLocal,
    localCaptureMeta: webrtcState.localCaptureMeta,
    outboundTelemetry: webrtcState.outboundTelemetry,
    primaryIncoming: primaryIncoming
      ? {
          streamMeta: primaryIncoming.streamMeta,
          telemetry: primaryIncoming.telemetry,
          renderedWidth: primaryIncoming.renderedWidth,
          renderedHeight: primaryIncoming.renderedHeight,
          phase: primaryIncoming.phase,
        }
      : null,
  });

  const overallQuality = evaluateConnectionQuality({
    phase: webrtcState.phase,
    iceConnectionState: webrtcState.iceConnectionState,
    telemetry: primaryIncoming?.telemetry ?? webrtcState.outboundTelemetry,
    recovery: primaryIncoming?.recovery ?? primaryOutbound?.recovery ?? null,
  });

  const hasMultiplePeers =
    webrtcState.outboundPeers.length > 0 || webrtcState.incomingStreams.length > 0;

  return (
    <section
      data-castora-chrome
      aria-label="Streaming Quality Diagnostics"
      className="castora-card overflow-hidden"
    >
      {/* Header bar */}
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[#FF6041]" aria-hidden="true" />
              <h2 className="font-display text-sm font-semibold text-[#141414]">
                Streaming Quality Diagnostics
              </h2>
            </div>
            <StatusLabel
              status={summary.overallVerification.status}
              tone={summary.overallVerification.tone}
            />
          </div>
          <p className="text-xs text-[#5C6063]">
            {summary.overallVerification.detail}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 shrink-0 text-xs">
          <div className="tabular-metrics">
            <span className="text-[#5C6063]">Requested: </span>
            <strong className="font-semibold text-[#141414]">
              {summary.requestedPresetLabel}
            </strong>
          </div>
          <div className="tabular-metrics">
            <span className="text-[#5C6063]">Connection: </span>
            <strong className="font-semibold text-[#141414]">
              {formatConnectionLabel(summary.connectionState)}
            </strong>
          </div>
          <div className="tabular-metrics" title={overallQuality.detail}>
            <span className="text-[#5C6063]">Link Quality: </span>
            <strong className="font-semibold text-[#141414]">
              {overallQuality.label}
            </strong>
          </div>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-2.5 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414]"
          >
            <span>{expanded ? 'Hide Details' : 'Show Details'}</span>
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
          {/* Three-stage pipeline matrix */}
          <div className="grid grid-cols-1 divide-y divide-[#D5D7DE] border-t border-[#D5D7DE] bg-[#FAFAFA] md:grid-cols-3 md:divide-x md:divide-y-0">
            {/* Stage 1: Screen Capture */}
            <div className="p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#141414]">
                  1. Screen Capture
                </span>
                <span className="font-mono text-[11px] text-[#797D82]">getSettings()</span>
              </div>

              <dl className="space-y-1.5 text-xs tabular-metrics">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Requested Quality</dt>
                  <dd className="font-medium text-[#141414]">{summary.requestedDimensionsLabel}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Actual Capture</dt>
                  <dd className="font-semibold text-[#141414]">
                    {formatDimensionsLabel(summary.capture.width, summary.capture.height)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Capture FPS</dt>
                  <dd className="font-medium text-[#141414]">{formatFps(summary.capture.fps)}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Selected Codec</dt>
                  <dd className="font-mono font-medium text-[#141414]">{summary.selectedCodec}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Audio Capture</dt>
                  <dd className="font-medium text-[#141414]">
                    {webrtcState.isSharingLocal
                      ? summary.capture.hasAudio
                        ? 'Captured (audio + video)'
                        : summary.capture.audioCaptureStatus === 'not-requested'
                          ? 'Disabled (video only)'
                          : summary.capture.audioCaptureStatus === 'ended'
                            ? 'Audio track ended'
                            : 'No audio source captured'
                      : preferences.includeAudio
                        ? 'Standby (audio enabled)'
                        : 'Disabled'}
                  </dd>
                </div>
              </dl>

              {summary.capture.audioNotice && (
                <p className="rounded-md border border-[#D97706]/30 bg-[#FFFBEB] px-2.5 py-1.5 text-[11px] leading-snug text-[#B45309]">
                  {summary.capture.audioNotice}
                </p>
              )}

              <div className="border-t border-[#D5D7DE] pt-2">
                <StatusLabel
                  status={summary.capture.verification.status}
                  tone={summary.capture.verification.tone}
                />
              </div>
            </div>

            {/* Stage 2: Outgoing WebRTC Encoding */}
            <div className="p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#141414]">
                  2. Outgoing WebRTC
                </span>
                <span className="font-mono text-[11px] text-[#797D82]">outbound-rtp</span>
              </div>

              <dl className="space-y-1.5 text-xs tabular-metrics">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Encoded Resolution</dt>
                  <dd className="font-semibold text-[#141414]">
                    {formatDimensionsLabel(summary.outgoing.width, summary.outgoing.height)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Encoded FPS</dt>
                  <dd className="font-medium text-[#141414]">{formatFps(summary.outgoing.fps)}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Video Codec</dt>
                  <dd className="font-mono font-medium text-[#141414]">
                    {summary.outgoing.negotiatedCodec ?? summary.outgoing.codec ?? summary.outgoing.selectedCodec ?? 'Unavailable'}
                    {summary.outgoing.negotiatedProfile ? ` (${summary.outgoing.negotiatedProfile})` : ''}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Outgoing Bitrate</dt>
                  <dd className="font-medium text-[#141414]">
                    {formatRate(summary.outgoing.bitrateKbps)}
                    {summary.outgoing.bitrateKbps !== null &&
                    summary.outgoing.targetBitrateKbps !== null
                      ? ` / ${formatRate(summary.outgoing.targetBitrateKbps)}`
                      : ''}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Frames Sent</dt>
                  <dd className="font-medium text-[#141414]">
                    {formatCount(summary.outgoing.framesSent)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Audio Sender</dt>
                  <dd className="font-medium text-[#141414]">
                    {summary.outgoing.audioSenderTrackStatus ?? 'none'}
                    {summary.outgoing.audioCodec ? ` (${summary.outgoing.audioCodec})` : ''}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Audio RTP Sent</dt>
                  <dd className="font-medium text-[#141414]">
                    {formatAudioTraffic(
                      summary.outgoing.audioPacketsSent,
                      summary.outgoing.audioBytesSent
                    )}
                  </dd>
                </div>
              </dl>

              {summary.outgoing.fallbackReason && (
                <p className="rounded-md border border-[#D97706]/30 bg-[#FFFBEB] px-2.5 py-1.5 text-[11px] leading-snug text-[#B45309]">
                  {summary.outgoing.fallbackReason}
                </p>
              )}

              <div className="border-t border-[#D5D7DE] pt-2">
                <StatusLabel
                  status={summary.outgoing.verification.status}
                  tone={summary.outgoing.verification.tone}
                />
              </div>
            </div>

            {/* Stage 3: Incoming WebRTC Decoding & Rendering */}
            <div className="p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#141414]">
                  3. Incoming &amp; Render
                </span>
                <span className="font-mono text-[11px] text-[#797D82]">inbound-rtp + &lt;video&gt;</span>
              </div>

              <dl className="space-y-1.5 text-xs tabular-metrics">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Decoded Resolution</dt>
                  <dd className="font-semibold text-[#141414]">
                    {formatDimensionsLabel(summary.incoming.width, summary.incoming.height)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">&lt;video&gt; Element Size</dt>
                  <dd className="font-semibold text-[#141414]">
                    {formatDimensionsLabel(
                      summary.incoming.renderedWidth,
                      summary.incoming.renderedHeight
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Decoded FPS</dt>
                  <dd className="font-medium text-[#141414]">{formatFps(summary.incoming.fps)}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Video Codec</dt>
                  <dd className="font-mono font-medium text-[#141414]">
                    {summary.incoming.negotiatedCodec ?? summary.incoming.codec ?? 'Unavailable'}
                    {summary.incoming.negotiatedProfile ? ` (${summary.incoming.negotiatedProfile})` : ''}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Incoming Bitrate</dt>
                  <dd className="font-medium text-[#141414]">
                    {formatRate(summary.incoming.bitrateKbps)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Frames Decoded</dt>
                  <dd className="font-medium text-[#141414]">
                    {formatCount(summary.incoming.framesDecoded)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Audio Receiver</dt>
                  <dd className="font-medium text-[#141414]">
                    {summary.incoming.audioReceiverTrackStatus ?? 'none'}
                    {summary.incoming.audioCodec ? ` (${summary.incoming.audioCodec})` : ''}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">Audio RTP Received</dt>
                  <dd className="font-medium text-[#141414]">
                    {formatAudioTraffic(
                      summary.incoming.audioPacketsReceived,
                      summary.incoming.audioBytesReceived
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[#5C6063]">TV Audio Playback</dt>
                  <dd className="font-medium text-[#141414]">
                    {summary.incoming.autoplayBlocked
                      ? 'autoplay-blocked'
                      : summary.incoming.audioPlaybackStatus ?? 'Unavailable'}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#D5D7DE] pt-2">
                <StatusLabel
                  status={summary.incoming.verification.status}
                  tone={summary.incoming.verification.tone}
                />
                {(() => {
                  const audioAccent = audioDiagnosticBadgeClass(summary.audioDiagnosticStatus);
                  return (
                    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${audioAccent.text}`}>
                      <span className={`h-2 w-2 rounded-full shrink-0 ${audioAccent.dot}`} aria-hidden="true" />
                      <span>{summary.audioDiagnosticStatus}</span>
                    </span>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Per-peer live verification table when any outbound or incoming stream exists */}
          {hasMultiplePeers && (
            <div className="overflow-x-auto border-t border-[#D5D7DE] bg-white">
              <table className="w-full min-w-[920px] text-left text-xs">
                <thead className="border-b border-[#D5D7DE] bg-[#FAFAFA] font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
                  <tr>
                    <th className="px-4 py-2.5">Stream</th>
                    <th className="px-4 py-2.5">Direction</th>
                    <th className="px-4 py-2.5">Connection</th>
                    <th className="px-4 py-2.5">Codec</th>
                    <th className="px-4 py-2.5">RTP Resolution</th>
                    <th className="px-4 py-2.5">&lt;video&gt; Size</th>
                    <th className="px-4 py-2.5">Actual FPS</th>
                    <th className="px-4 py-2.5">Bitrate</th>
                    <th className="px-4 py-2.5">Frames</th>
                    <th className="px-4 py-2.5">Audio</th>
                    <th className="px-4 py-2.5">Quality Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#D5D7DE] tabular-metrics">
                  {webrtcState.outboundPeers.map((peer) => {
                    const effectiveReq = peer.qualityOverride?.resolution ?? preferences.resolution;
                    const verification = evaluateQualityVerification({
                      stage: 'outbound',
                      requestedPreset: effectiveReq,
                      requestedFps: peer.qualityOverride?.targetFps ?? preferences.targetFps,
                      width: peer.telemetry.encodedWidth ?? null,
                      height: peer.telemetry.encodedHeight ?? null,
                      actualFps: peer.telemetry.encodedFps,
                    });
                    const linkQuality = evaluateConnectionQuality({
                      phase: peer.phase,
                      iceConnectionState: peer.iceConnectionState,
                      telemetry: peer.telemetry,
                      recovery: peer.recovery,
                    });
                    const canRetry =
                      Boolean(onRetryPeer) &&
                      (peer.phase === 'failed' ||
                        peer.phase === 'disconnected' ||
                        Boolean(peer.recovery?.exhausted));
                    return (
                      <tr key={`out-${peer.targetDeviceId}`}>
                        <td className="px-4 py-2.5 font-sans font-medium text-[#141414]">
                          {peer.targetName}
                        </td>
                        <td className="px-4 py-2.5 font-sans text-[#5C6063]">Outgoing</td>
                        <td className="px-4 py-2.5 font-sans" title={linkQuality.detail}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[#141414]">{linkQuality.label}</span>
                            {canRetry && (
                              <button
                                type="button"
                                onClick={() => onRetryPeer?.(peer.targetDeviceId)}
                                className="inline-flex items-center gap-1 rounded border border-[#DC2626]/30 bg-[#FEF2F2] px-1.5 py-0.5 text-[11px] font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
                              >
                                <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
                                <span>Retry</span>
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[#141414]">
                          {peer.telemetry.negotiatedVideoCodec ??
                            peer.telemetry.codecMimeType ??
                            peer.telemetry.selectedVideoCodec ??
                            '—'}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatDimensionsLabel(
                            peer.telemetry.encodedWidth,
                            peer.telemetry.encodedHeight
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-[#5C6063]">—</td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatFps(peer.telemetry.encodedFps)}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatRate(peer.telemetry.bitrateKbps)}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatCount(peer.telemetry.framesSent)}
                        </td>
                        <td className="px-4 py-2.5 font-sans text-[#141414]">
                          {peer.telemetry.audioSenderTrackStatus ?? 'none'}
                          {peer.telemetry.audioPacketsSent !== null &&
                          peer.telemetry.audioPacketsSent !== undefined
                            ? ` (${peer.telemetry.audioPacketsSent})`
                            : ''}
                        </td>
                        <td className="px-4 py-2.5 font-sans">
                          <StatusLabel status={verification.status} tone={verification.tone} />
                        </td>
                      </tr>
                    );
                  })}
                  {webrtcState.incomingStreams.map((entry) => {
                    const inferredReq = entry.streamMeta
                      ? inferPresetFromDimensions(entry.streamMeta.width, entry.streamMeta.height)
                      : preferences.resolution;
                    const verification = evaluateQualityVerification({
                      stage: 'inbound',
                      requestedPreset: inferredReq,
                      requestedFps: entry.streamMeta?.fps ?? preferences.targetFps,
                      width: entry.telemetry.decodedWidth ?? null,
                      height: entry.telemetry.decodedHeight ?? null,
                      actualFps: entry.telemetry.decodedFps,
                      secondaryWidth: entry.renderedWidth ?? entry.telemetry.renderedWidth ?? null,
                      secondaryHeight: entry.renderedHeight ?? entry.telemetry.renderedHeight ?? null,
                    });
                    const linkQuality = evaluateConnectionQuality({
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
                    return (
                      <tr key={`in-${entry.senderDeviceId}`}>
                        <td className="px-4 py-2.5 font-sans font-medium text-[#141414]">
                          {entry.senderName}
                        </td>
                        <td className="px-4 py-2.5 font-sans text-[#5C6063]">Incoming</td>
                        <td className="px-4 py-2.5 font-sans" title={linkQuality.detail}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[#141414]">{linkQuality.label}</span>
                            {canRetry && (
                              <button
                                type="button"
                                onClick={() => onRetryPeer?.(entry.senderDeviceId)}
                                className="inline-flex items-center gap-1 rounded border border-[#DC2626]/30 bg-[#FEF2F2] px-1.5 py-0.5 text-[11px] font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
                              >
                                <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
                                <span>Retry</span>
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[#141414]">
                          {entry.telemetry.negotiatedVideoCodec ??
                            entry.telemetry.codecMimeType ??
                            entry.streamMeta?.codec ??
                            '—'}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatDimensionsLabel(
                            entry.telemetry.decodedWidth,
                            entry.telemetry.decodedHeight
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatDimensionsLabel(
                            entry.renderedWidth ?? entry.telemetry.renderedWidth,
                            entry.renderedHeight ?? entry.telemetry.renderedHeight
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatFps(entry.telemetry.decodedFps)}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatRate(entry.telemetry.bitrateKbps)}
                        </td>
                        <td className="px-4 py-2.5 text-[#141414]">
                          {formatCount(entry.telemetry.framesDecoded)}
                        </td>
                        <td className="px-4 py-2.5 font-sans text-[#141414]">
                          {entry.telemetry.autoplayBlocked
                            ? 'autoplay-blocked'
                            : entry.telemetry.audioPlaybackStatus ??
                              entry.telemetry.audioReceiverTrackStatus ??
                              'none'}
                        </td>
                        <td className="px-4 py-2.5 font-sans">
                          <StatusLabel status={verification.status} tone={verification.tone} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
