import type {
  CapturePreferences,
  ConnectionQualityLevel,
  PeerConnectionRecoveryInfo,
  QualityVerificationStatus,
  ResolutionPresetId,
  StreamTelemetrySnapshot,
  WebRtcConnectionPhase,
} from '../types/studio';
import { VIDEO_QUALITY_PRESETS } from './videoQualityService';

export interface ConnectionQualityAssessment {
  level: ConnectionQualityLevel;
  label: string;
  tone: 'active' | 'signal' | 'warn' | 'fault' | 'standby';
  detail: string;
}

export interface QualityVerificationResult {
  status: QualityVerificationStatus;
  tone: 'verified' | 'warn' | 'muted';
  detail: string;
}

export interface StageDiagnosticsSummary {
  requestedPresetLabel: string;
  requestedDimensionsLabel: string;
  requestedFps: number;
  connectionState: WebRtcConnectionPhase;
  capture: {
    width: number | null;
    height: number | null;
    fps: number | null;
    hasAudio: boolean;
    verification: QualityVerificationResult;
  };
  outgoing: {
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrateKbps: number | null;
    targetBitrateKbps: number | null;
    framesSent: number | null;
    framesEncoded: number | null;
    codec: string | null;
    verification: QualityVerificationResult;
  };
  incoming: {
    width: number | null;
    height: number | null;
    renderedWidth: number | null;
    renderedHeight: number | null;
    fps: number | null;
    bitrateKbps: number | null;
    framesDecoded: number | null;
    codec: string | null;
    verification: QualityVerificationResult;
  };
  overallVerification: QualityVerificationResult;
}

function classifyTier(
  width: number,
  height: number
): '4k' | '1440p' | '1080p' | '720p' | 'sd' {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);

  if (longEdge >= 3840 && shortEdge >= 2160) return '4k';
  if (longEdge >= 2560 && shortEdge >= 1440) return '1440p';
  if (longEdge >= 1920 && shortEdge >= 1080) return '1080p';
  if (longEdge >= 1280 && shortEdge >= 720) return '720p';
  return 'sd';
}

export function inferPresetFromDimensions(
  width?: number | null,
  height?: number | null
): ResolutionPresetId {
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return 'native';
  }
  const tier = classifyTier(width, height);
  if (tier === '4k') return '4k';
  if (tier === '1440p') return '1440p';
  if (tier === '1080p') return '1080p';
  if (tier === '720p') return '720p';
  return 'native';
}

export function formatDimensionsLabel(
  width?: number | null,
  height?: number | null,
  unavailableLabel = 'Unavailable'
): string {
  if (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    return `${Math.round(width)}×${Math.round(height)}`;
  }
  return unavailableLabel;
}

export function evaluateQualityVerification(params: {
  stage: 'capture' | 'outbound' | 'inbound';
  requestedPreset: ResolutionPresetId;
  requestedFps?: number | null;
  width: number | null | undefined;
  height: number | null | undefined;
  actualFps?: number | null;
  secondaryWidth?: number | null;
  secondaryHeight?: number | null;
}): QualityVerificationResult {
  const hasPrimary =
    typeof params.width === 'number' &&
    typeof params.height === 'number' &&
    Number.isFinite(params.width) &&
    Number.isFinite(params.height) &&
    params.width > 0 &&
    params.height > 0;

  if (!hasPrimary) {
    return {
      status: 'Statistics unavailable',
      tone: 'muted',
      detail:
        params.stage === 'capture'
          ? 'No active screen capture track settings detected.'
          : params.stage === 'outbound'
            ? 'Outgoing WebRTC RTP video statistics unavailable.'
            : 'Incoming WebRTC RTP video statistics unavailable.',
    };
  }

  const primaryW = params.width as number;
  const primaryH = params.height as number;

  const hasSecondary =
    typeof params.secondaryWidth === 'number' &&
    typeof params.secondaryHeight === 'number' &&
    Number.isFinite(params.secondaryWidth) &&
    Number.isFinite(params.secondaryHeight) &&
    params.secondaryWidth > 0 &&
    params.secondaryHeight > 0;

  // If both RTP decoded dimensions and DOM <video> dimensions are known,
  // verify against the lower of the two so upscaled/downscaled rendering is never over-claimed.
  const effectiveW = hasSecondary ? Math.min(primaryW, params.secondaryWidth as number) : primaryW;
  const effectiveH = hasSecondary ? Math.min(primaryH, params.secondaryHeight as number) : primaryH;

  const tier = classifyTier(effectiveW, effectiveH);
  const actualLabel = `${Math.round(effectiveW)}×${Math.round(effectiveH)}`;
  const fpsNote =
    typeof params.actualFps === 'number' && Number.isFinite(params.actualFps) && params.actualFps > 0
      ? ` @ ${Math.round(params.actualFps)} FPS`
      : '';

  if (params.requestedPreset === '4k') {
    if (tier === '4k') {
      return {
        status: '4K verified',
        tone: 'verified',
        detail: `Actual stream verified at ${actualLabel}${fpsNote}.`,
      };
    }
    return {
      status: 'Requested quality not achieved',
      tone: 'warn',
      detail: `Requested 4K (3840×2160), actual stream is ${actualLabel}${fpsNote}.`,
    };
  }

  if (params.requestedPreset === '1440p') {
    if (tier === '4k' || tier === '1440p') {
      return {
        status: '1440p verified',
        tone: 'verified',
        detail: `Actual stream verified at ${actualLabel}${fpsNote}.`,
      };
    }
    return {
      status: 'Requested quality not achieved',
      tone: 'warn',
      detail: `Requested 1440p (2560×1440), actual stream is ${actualLabel}${fpsNote}.`,
    };
  }

  if (params.requestedPreset === '1080p') {
    if (tier === '4k' || tier === '1440p' || tier === '1080p') {
      return {
        status: '1080p verified',
        tone: 'verified',
        detail: `Actual stream verified at ${actualLabel}${fpsNote}.`,
      };
    }
    return {
      status: 'Requested quality not achieved',
      tone: 'warn',
      detail: `Requested 1080p (1920×1080), actual stream is ${actualLabel}${fpsNote}.`,
    };
  }

  if (params.requestedPreset === '720p') {
    if (tier !== 'sd') {
      return {
        status: '720p verified',
        tone: 'verified',
        detail: `Actual stream verified at ${actualLabel}${fpsNote}.`,
      };
    }
    return {
      status: 'Requested quality not achieved',
      tone: 'warn',
      detail: `Requested 720p (1280×720), actual stream is ${actualLabel}${fpsNote}.`,
    };
  }

  // 'native' preset: verify based on what actual RTP/capture stats genuinely support
  if (tier === '4k') {
    return { status: '4K verified', tone: 'verified', detail: `Native capture verified at ${actualLabel}${fpsNote}.` };
  }
  if (tier === '1440p') {
    return { status: '1440p verified', tone: 'verified', detail: `Native capture verified at ${actualLabel}${fpsNote}.` };
  }
  if (tier === '1080p') {
    return { status: '1080p verified', tone: 'verified', detail: `Native capture verified at ${actualLabel}${fpsNote}.` };
  }
  if (tier === '720p') {
    return { status: '720p verified', tone: 'verified', detail: `Native capture verified at ${actualLabel}${fpsNote}.` };
  }
  return {
    status: 'Requested quality not achieved',
    tone: 'warn',
    detail: `Native stream resolution (${actualLabel}) is below 720p.`,
  };
}

export function buildStageDiagnosticsSummary(params: {
  preferences: CapturePreferences;
  connectionState: WebRtcConnectionPhase;
  isSharingLocal: boolean;
  localCaptureMeta: {
    width: number | null;
    height: number | null;
    fps: number | null;
    hasAudio: boolean;
  } | null;
  outboundTelemetry: StreamTelemetrySnapshot;
  primaryIncoming?: {
    streamMeta: { width: number; height: number; fps: number; codec: string } | null;
    telemetry: StreamTelemetrySnapshot;
    renderedWidth: number | null;
    renderedHeight: number | null;
    phase: WebRtcConnectionPhase;
  } | null;
}): StageDiagnosticsSummary {
  const presetSpec = VIDEO_QUALITY_PRESETS[params.preferences.resolution];
  const requestedPresetLabel = `${presetSpec.label} (${presetSpec.shortDetail}) @ ${params.preferences.targetFps} FPS`;

  const capWidth =
    params.outboundTelemetry.captureWidth ?? params.localCaptureMeta?.width ?? null;
  const capHeight =
    params.outboundTelemetry.captureHeight ?? params.localCaptureMeta?.height ?? null;
  const capFps =
    params.outboundTelemetry.captureFps ?? params.localCaptureMeta?.fps ?? null;

  const captureVerification = evaluateQualityVerification({
    stage: 'capture',
    requestedPreset: params.preferences.resolution,
    requestedFps: params.preferences.targetFps,
    width: capWidth,
    height: capHeight,
    actualFps: capFps,
  });

  const encWidth = params.outboundTelemetry.encodedWidth ?? null;
  const encHeight = params.outboundTelemetry.encodedHeight ?? null;
  const encFps = params.outboundTelemetry.encodedFps ?? null;

  const outgoingVerification = evaluateQualityVerification({
    stage: 'outbound',
    requestedPreset: params.preferences.resolution,
    requestedFps: params.preferences.targetFps,
    width: encWidth,
    height: encHeight,
    actualFps: encFps,
  });

  const inTelemetry = params.primaryIncoming?.telemetry ?? null;
  const decWidth = inTelemetry?.decodedWidth ?? null;
  const decHeight = inTelemetry?.decodedHeight ?? null;
  const decFps = inTelemetry?.decodedFps ?? null;
  const renWidth = params.primaryIncoming?.renderedWidth ?? inTelemetry?.renderedWidth ?? null;
  const renHeight = params.primaryIncoming?.renderedHeight ?? inTelemetry?.renderedHeight ?? null;

  const incomingRequestedPreset = params.primaryIncoming?.streamMeta
    ? inferPresetFromDimensions(
        params.primaryIncoming.streamMeta.width,
        params.primaryIncoming.streamMeta.height
      )
    : params.preferences.resolution;

  const incomingVerification = evaluateQualityVerification({
    stage: 'inbound',
    requestedPreset: incomingRequestedPreset,
    requestedFps: params.primaryIncoming?.streamMeta?.fps ?? params.preferences.targetFps,
    width: decWidth,
    height: decHeight,
    actualFps: decFps,
    secondaryWidth: renWidth,
    secondaryHeight: renHeight,
  });

  // Pick overall verification honestly:
  // 1) If sharing outbound and RTP stats exist, evaluate outbound RTP (plus capture mismatch if RTP absent).
  // 2) Else if receiving incoming and RTP stats exist, evaluate incoming RTP + <video>.
  // 3) If sharing local and capture missed requested preset before RTP exists, report capture mismatch rather than "verified".
  let overallVerification: QualityVerificationResult;
  if (params.isSharingLocal && encWidth !== null && encHeight !== null) {
    overallVerification = outgoingVerification;
  } else if (params.primaryIncoming && decWidth !== null && decHeight !== null) {
    overallVerification = incomingVerification;
  } else if (params.isSharingLocal && captureVerification.status === 'Requested quality not achieved') {
    overallVerification = captureVerification;
  } else if (params.primaryIncoming) {
    overallVerification = incomingVerification;
  } else {
    overallVerification = outgoingVerification;
  }

  return {
    requestedPresetLabel,
    requestedDimensionsLabel: presetSpec.shortDetail,
    requestedFps: params.preferences.targetFps,
    connectionState: params.connectionState,
    capture: {
      width: capWidth,
      height: capHeight,
      fps: capFps,
      hasAudio: Boolean(params.localCaptureMeta?.hasAudio),
      verification: captureVerification,
    },
    outgoing: {
      width: encWidth,
      height: encHeight,
      fps: encFps,
      bitrateKbps: params.outboundTelemetry.bitrateKbps ?? null,
      targetBitrateKbps: params.outboundTelemetry.targetBitrateKbps ?? null,
      framesSent: params.outboundTelemetry.framesSent ?? null,
      framesEncoded: params.outboundTelemetry.framesEncoded ?? null,
      codec: params.outboundTelemetry.codecMimeType ?? null,
      verification: outgoingVerification,
    },
    incoming: {
      width: decWidth,
      height: decHeight,
      renderedWidth: renWidth,
      renderedHeight: renHeight,
      fps: decFps,
      bitrateKbps: inTelemetry?.bitrateKbps ?? null,
      framesDecoded: inTelemetry?.framesDecoded ?? null,
      codec: inTelemetry?.codecMimeType ?? null,
      verification: incomingVerification,
    },
    overallVerification,
  };
}

export function evaluateConnectionQuality(params: {
  phase: WebRtcConnectionPhase;
  iceConnectionState?: RTCIceConnectionState | null;
  telemetry?: StreamTelemetrySnapshot | null;
  recovery?: PeerConnectionRecoveryInfo | null;
}): ConnectionQualityAssessment {
  if (params.phase === 'failed' || params.recovery?.exhausted) {
    return {
      level: 'failed',
      label: 'Failed',
      tone: 'fault',
      detail:
        params.recovery?.lastError ??
        'Automatic recovery exhausted. Retry connection or configure a TURN relay.',
    };
  }

  if (params.phase === 'reconnecting' || params.recovery?.reconnecting) {
    const attemptInfo =
      params.recovery && params.recovery.attempt > 0
        ? ` (attempt ${params.recovery.attempt}/${params.recovery.maxAttempts})`
        : '';
    return {
      level: 'reconnecting',
      label: `Reconnecting${attemptInfo}`,
      tone: 'warn',
      detail: 'Connection interrupted temporarily. Attempting automatic ICE/peer recovery.',
    };
  }

  if (params.phase === 'connecting') {
    return {
      level: 'unknown',
      label: 'Connecting',
      tone: 'signal',
      detail: `ICE state: ${params.iceConnectionState ?? 'checking'}.`,
    };
  }

  if (params.phase === 'disconnected') {
    return {
      level: 'unknown',
      label: 'Disconnected',
      tone: 'warn',
      detail: 'Peer session closed or disconnected.',
    };
  }

  if (params.phase !== 'connected') {
    return {
      level: 'unknown',
      label: 'Standby',
      tone: 'standby',
      detail: 'No active WebRTC peer session.',
    };
  }

  const rtt = params.telemetry?.rttMs ?? null;
  const loss = params.telemetry?.packetLossPct ?? null;
  const jitter = params.telemetry?.jitterMs ?? null;

  if (rtt === null && loss === null) {
    return {
      level: 'good',
      label: 'Connected',
      tone: 'active',
      detail: 'WebRTC peer connected; waiting for RTT/loss statistics.',
    };
  }

  const effectiveRtt = rtt ?? 0;
  const effectiveLoss = loss ?? 0;

  if (effectiveRtt <= 35 && effectiveLoss <= 0.5) {
    return {
      level: 'excellent',
      label: 'Excellent',
      tone: 'active',
      detail: `RTT ${Math.round(effectiveRtt)} ms · Loss ${effectiveLoss.toFixed(1)}%${jitter !== null ? ` · Jitter ${jitter.toFixed(1)} ms` : ''}`,
    };
  }

  if (effectiveRtt <= 100 && effectiveLoss <= 2.0) {
    return {
      level: 'good',
      label: 'Good',
      tone: 'active',
      detail: `RTT ${Math.round(effectiveRtt)} ms · Loss ${effectiveLoss.toFixed(1)}%`,
    };
  }

  if (effectiveRtt <= 220 && effectiveLoss <= 5.0) {
    return {
      level: 'fair',
      label: 'Fair',
      tone: 'warn',
      detail: `Elevated latency or loss (RTT ${Math.round(effectiveRtt)} ms · Loss ${effectiveLoss.toFixed(1)}%)`,
    };
  }

  return {
    level: 'poor',
    label: 'Poor',
    tone: 'warn',
    detail: `Degraded link (RTT ${Math.round(effectiveRtt)} ms · Loss ${effectiveLoss.toFixed(1)}%)`,
  };
}
