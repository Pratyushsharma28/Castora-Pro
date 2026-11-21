import type { CastoraVideoCodec } from '../types/protocol';
import type {
  AdaptationStatus,
  CapturePreferences,
  CodecPreference,
  ResolutionPresetId,
  StreamTelemetrySnapshot,
} from '../types/studio';

export interface VideoQualityPresetSpec {
  id: ResolutionPresetId;
  label: string;
  shortDetail: string;
  targetWidth: number | null;
  targetHeight: number | null;
  defaultBitrateKbps60: number;
  defaultBitrateKbps30: number;
  minBitrateKbps: number;
  maxBitrateKbps: number;
  minSmoothBitrateKbps: number;
  recommendedRangeLabel: string;
}

export const VIDEO_QUALITY_PRESETS: Record<ResolutionPresetId, VideoQualityPresetSpec> = {
  '720p': {
    id: '720p',
    label: '720p',
    shortDetail: '1280 × 720',
    targetWidth: 1280,
    targetHeight: 720,
    defaultBitrateKbps60: 4_500,
    defaultBitrateKbps30: 3_200,
    minBitrateKbps: 1_500,
    maxBitrateKbps: 8_000,
    minSmoothBitrateKbps: 1_500,
    recommendedRangeLabel: '3–6 Mbps',
  },
  '1080p': {
    id: '1080p',
    label: '1080p',
    shortDetail: '1920 × 1080',
    targetWidth: 1920,
    targetHeight: 1080,
    defaultBitrateKbps60: 10_000,
    defaultBitrateKbps30: 7_500,
    minBitrateKbps: 2_500,
    maxBitrateKbps: 16_000,
    minSmoothBitrateKbps: 3_000,
    recommendedRangeLabel: '8–12 Mbps',
  },
  '1440p': {
    id: '1440p',
    label: '1440p',
    shortDetail: '2560 × 1440',
    targetWidth: 2560,
    targetHeight: 1440,
    defaultBitrateKbps60: 20_000,
    defaultBitrateKbps30: 14_000,
    minBitrateKbps: 4_500,
    maxBitrateKbps: 30_000,
    minSmoothBitrateKbps: 6_000,
    recommendedRangeLabel: '15–25 Mbps',
  },
  '4k': {
    id: '4k',
    label: '4K',
    shortDetail: '3840 × 2160',
    targetWidth: 3840,
    targetHeight: 2160,
    defaultBitrateKbps60: 40_000,
    defaultBitrateKbps30: 28_000,
    minBitrateKbps: 8_000,
    maxBitrateKbps: 55_000,
    minSmoothBitrateKbps: 12_000,
    recommendedRangeLabel: '30–50 Mbps',
  },
  native: {
    id: 'native',
    label: 'Native',
    shortDetail: 'Display native',
    targetWidth: null,
    targetHeight: null,
    defaultBitrateKbps60: 12_000,
    defaultBitrateKbps30: 9_000,
    minBitrateKbps: 2_500,
    maxBitrateKbps: 55_000,
    minSmoothBitrateKbps: 3_000,
    recommendedRangeLabel: 'Auto by display',
  },
};

export interface ResolvedQualityTarget {
  preset: VideoQualityPresetSpec;
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  configuredMaxBitrateKbps: number;
  minBitrateKbps: number;
  minSmoothBitrateKbps: number;
  adaptiveEnabled: boolean;
}

export function getPresetDefaultBitrateKbps(
  resolution: ResolutionPresetId,
  targetFps: number,
  actualDims?: { width?: number | null; height?: number | null }
): number {
  if (resolution === 'native' && actualDims?.width && actualDims?.height) {
    if (actualDims.width >= 3200 || actualDims.height >= 1800) {
      return targetFps >= 60
        ? VIDEO_QUALITY_PRESETS['4k'].defaultBitrateKbps60
        : VIDEO_QUALITY_PRESETS['4k'].defaultBitrateKbps30;
    }
    if (actualDims.width >= 2400 || actualDims.height >= 1350) {
      return targetFps >= 60
        ? VIDEO_QUALITY_PRESETS['1440p'].defaultBitrateKbps60
        : VIDEO_QUALITY_PRESETS['1440p'].defaultBitrateKbps30;
    }
    return targetFps >= 60
      ? VIDEO_QUALITY_PRESETS['1080p'].defaultBitrateKbps60
      : VIDEO_QUALITY_PRESETS['1080p'].defaultBitrateKbps30;
  }

  const preset = VIDEO_QUALITY_PRESETS[resolution];
  return targetFps >= 60 ? preset.defaultBitrateKbps60 : preset.defaultBitrateKbps30;
}

export function resolveQualityTarget(
  preferences: CapturePreferences,
  actualDims?: { width?: number | null; height?: number | null }
): ResolvedQualityTarget {
  const preset = VIDEO_QUALITY_PRESETS[preferences.resolution] ?? VIDEO_QUALITY_PRESETS['1080p'];
  const defaultBitrate = getPresetDefaultBitrateKbps(
    preferences.resolution,
    preferences.targetFps,
    actualDims
  );
  const rawBitrate =
    typeof preferences.maxBitrateKbps === 'number' && Number.isFinite(preferences.maxBitrateKbps)
      ? Math.round(preferences.maxBitrateKbps)
      : defaultBitrate;

  const configuredMaxBitrateKbps = Math.max(
    preset.minBitrateKbps,
    Math.min(55_000, rawBitrate)
  );

  const targetWidth =
    actualDims?.width ?? preset.targetWidth ?? 1920;
  const targetHeight =
    actualDims?.height ?? preset.targetHeight ?? 1080;

  return {
    preset,
    targetWidth,
    targetHeight,
    targetFps: preferences.targetFps,
    configuredMaxBitrateKbps,
    minBitrateKbps: preset.minBitrateKbps,
    minSmoothBitrateKbps: preset.minSmoothBitrateKbps,
    adaptiveEnabled: preferences.adaptiveBitrate !== false,
  };
}

/**
 * Multi-publisher / multi-receiver headroom budgeting:
 * A single peer receives 100% of configured target bitrate. When broadcasting
 * high-bitrate streams to multiple peers concurrently, scale per-stream ceiling
 * smoothly so CPU, GPU hardware encoders, and uplink bandwidth are not saturated.
 */
export function computeConcurrencyScaledBitrateKbps(
  configuredBitrateKbps: number,
  activeOutboundPeers: number,
  minBitrateKbps: number
): number {
  if (activeOutboundPeers <= 1) {
    return configuredBitrateKbps;
  }
  const factor =
    activeOutboundPeers === 2
      ? 0.85
      : Math.max(0.5, Math.min(0.75, 1.35 / activeOutboundPeers));
  return Math.max(minBitrateKbps, Math.round(configuredBitrateKbps * factor));
}

export interface CodecPreferenceResult {
  orderedCodecs: RTCRtpCodec[];
  codecHint: CastoraVideoCodec;
}

function getH264ProfilePriority(sdpFmtpLine: string | undefined): number {
  const fmtp = (sdpFmtpLine ?? '').toLowerCase();
  // Prefer packetization-mode=1 and High/Main/Constrained Baseline profiles (hardware-accelerated across macOS/Win/Android)
  const packetizationBonus = fmtp.includes('packetization-mode=1') ? 10 : 0;
  if (fmtp.includes('profile-level-id=6400')) return 40 + packetizationBonus;
  if (fmtp.includes('profile-level-id=4d00')) return 35 + packetizationBonus;
  if (fmtp.includes('profile-level-id=42e0')) return 30 + packetizationBonus;
  if (fmtp.includes('profile-level-id=4200')) return 25 + packetizationBonus;
  return 10 + packetizationBonus;
}

export function orderVideoCodecsForPreference(
  capabilitiesCodecs: RTCRtpCodec[],
  preference: CodecPreference
): CodecPreferenceResult {
  if (!capabilitiesCodecs || capabilitiesCodecs.length === 0) {
    return {
      orderedCodecs: [],
      codecHint: preference === 'H264' ? 'H264' : preference === 'VP9' ? 'VP9' : preference === 'AV1' ? 'AV1' : 'VP8',
    };
  }

  const normalizedMime = (c: RTCRtpCodec) => c.mimeType.toLowerCase();
  const auxiliary = capabilitiesCodecs.filter((c) => {
    const m = normalizedMime(c);
    return m === 'video/rtx' || m === 'video/red' || m === 'video/ulpfec' || m === 'video/flexfec-03';
  });

  const h264 = capabilitiesCodecs
    .filter((c) => normalizedMime(c) === 'video/h264')
    .sort((a, b) => getH264ProfilePriority(b.sdpFmtpLine) - getH264ProfilePriority(a.sdpFmtpLine));
  const av1 = capabilitiesCodecs.filter((c) => normalizedMime(c) === 'video/av1');
  const vp9 = capabilitiesCodecs.filter((c) => normalizedMime(c) === 'video/vp9');
  const vp8 = capabilitiesCodecs.filter((c) => normalizedMime(c) === 'video/vp8');
  const rest = capabilitiesCodecs.filter((c) => {
    const m = normalizedMime(c);
    return (
      m !== 'video/h264' &&
      m !== 'video/av1' &&
      m !== 'video/vp9' &&
      m !== 'video/vp8' &&
      !auxiliary.includes(c)
    );
  });

  if (preference === 'H264') {
    const ordered = [...h264, ...vp9, ...av1, ...vp8, ...rest, ...auxiliary];
    return {
      orderedCodecs: ordered,
      codecHint: h264.length > 0 ? 'H264' : vp9.length > 0 ? 'VP9' : av1.length > 0 ? 'AV1' : 'VP8',
    };
  }

  if (preference === 'VP9') {
    const ordered = [...vp9, ...h264, ...av1, ...vp8, ...rest, ...auxiliary];
    return {
      orderedCodecs: ordered,
      codecHint: vp9.length > 0 ? 'VP9' : h264.length > 0 ? 'H264' : 'VP8',
    };
  }

  if (preference === 'AV1') {
    const ordered = [...av1, ...vp9, ...h264, ...vp8, ...rest, ...auxiliary];
    return {
      orderedCodecs: ordered,
      codecHint: av1.length > 0 ? 'AV1' : vp9.length > 0 ? 'VP9' : h264.length > 0 ? 'H264' : 'VP8',
    };
  }

  // AUTO: Prefer efficient screen codecs (H264 hardware-friendly or VP9/AV1) while keeping all fallbacks
  const ordered = [...h264, ...vp9, ...av1, ...vp8, ...rest, ...auxiliary];
  return {
    orderedCodecs: ordered,
    codecHint: h264.length > 0 ? 'H264' : vp9.length > 0 ? 'VP9' : av1.length > 0 ? 'AV1' : 'VP8',
  };
}

export interface AdaptiveBitrateDecision {
  changed: boolean;
  targetBitrateKbps: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  degradationPreference: RTCDegradationPreference;
  adaptationStatus: AdaptationStatus;
}

export class AdaptiveBitrateController {
  private configuredTarget: ResolvedQualityTarget;
  private currentBitrateKbps: number;
  private currentScaleDown = 1.0;
  private currentMaxFramerate: number;
  private currentStatus: AdaptationStatus = 'target';
  private healthySamplesStreak = 0;
  private lastAdjustmentAtMs = 0;

  constructor(preferences: CapturePreferences, actualDims?: { width?: number | null; height?: number | null }) {
    this.configuredTarget = resolveQualityTarget(preferences, actualDims);
    this.currentBitrateKbps = this.configuredTarget.configuredMaxBitrateKbps;
    this.currentMaxFramerate = this.configuredTarget.targetFps;
  }

  updatePreferences(
    preferences: CapturePreferences,
    activeOutboundPeers = 1,
    actualDims?: { width?: number | null; height?: number | null }
  ): AdaptiveBitrateDecision {
    this.configuredTarget = resolveQualityTarget(preferences, actualDims);
    const ceiling = computeConcurrencyScaledBitrateKbps(
      this.configuredTarget.configuredMaxBitrateKbps,
      activeOutboundPeers,
      this.configuredTarget.minBitrateKbps
    );
    this.currentBitrateKbps = ceiling;
    this.currentScaleDown = 1.0;
    this.currentMaxFramerate = this.configuredTarget.targetFps;
    this.currentStatus = 'target';
    this.healthySamplesStreak = 0;
    this.lastAdjustmentAtMs = 0;

    return {
      changed: true,
      targetBitrateKbps: this.currentBitrateKbps,
      maxFramerate: this.currentMaxFramerate,
      scaleResolutionDownBy: this.currentScaleDown,
      degradationPreference: this.selectDegradationPreference(),
      adaptationStatus: this.currentStatus,
    };
  }

  getCurrentState(): {
    configuredMaxBitrateKbps: number;
    targetBitrateKbps: number;
    scaleResolutionDownBy: number;
    adaptationStatus: AdaptationStatus;
  } {
    return {
      configuredMaxBitrateKbps: this.configuredTarget.configuredMaxBitrateKbps,
      targetBitrateKbps: this.currentBitrateKbps,
      scaleResolutionDownBy: this.currentScaleDown,
      adaptationStatus: this.currentStatus,
    };
  }

  private selectDegradationPreference(): RTCDegradationPreference {
    // Prioritize crisp text & UI resolution at 1440p/4K, balanced under normal 1080p60 motion
    if (
      this.configuredTarget.preset.id === '1440p' ||
      this.configuredTarget.preset.id === '4k'
    ) {
      return 'maintain-resolution';
    }
    return 'balanced';
  }

  evaluate(
    stats: StreamTelemetrySnapshot,
    options: { activeOutboundPeers?: number; nowMs?: number } = {}
  ): AdaptiveBitrateDecision {
    const activePeers = Math.max(1, options.activeOutboundPeers ?? 1);
    const nowMs = options.nowMs ?? Date.now();
    const ceilingKbps = computeConcurrencyScaledBitrateKbps(
      this.configuredTarget.configuredMaxBitrateKbps,
      activePeers,
      this.configuredTarget.minBitrateKbps
    );

    if (!this.configuredTarget.adaptiveEnabled) {
      const changed =
        this.currentBitrateKbps !== ceilingKbps ||
        this.currentScaleDown !== 1.0 ||
        this.currentMaxFramerate !== this.configuredTarget.targetFps;
      this.currentBitrateKbps = ceilingKbps;
      this.currentScaleDown = 1.0;
      this.currentMaxFramerate = this.configuredTarget.targetFps;
      this.currentStatus = 'target';
      return {
        changed,
        targetBitrateKbps: this.currentBitrateKbps,
        maxFramerate: this.currentMaxFramerate,
        scaleResolutionDownBy: this.currentScaleDown,
        degradationPreference: this.selectDegradationPreference(),
        adaptationStatus: this.currentStatus,
      };
    }

    const packetLoss = stats.packetLossPct ?? 0;
    const rttMs = stats.rttMs ?? 0;
    const limiter = stats.qualityLimitationReason ?? 'none';
    const availableKbps = stats.availableOutgoingBitrateKbps ?? null;

    const availableConstrained =
      availableKbps !== null && availableKbps > 0 && availableKbps < this.currentBitrateKbps * 0.88;
    const severeNetworkPressure =
      packetLoss >= 4.5 ||
      rttMs >= 260 ||
      (availableKbps !== null && availableKbps > 0 && availableKbps < this.currentBitrateKbps * 0.6);
    const moderatePressure =
      limiter === 'bandwidth' ||
      limiter === 'cpu' ||
      packetLoss >= 1.8 ||
      rttMs >= 165 ||
      availableConstrained;

    if (severeNetworkPressure || moderatePressure) {
      this.healthySamplesStreak = 0;

      // Step down at most once per 1500ms unless severe degradation arrives
      const minCooldown = severeNetworkPressure ? 800 : 1500;
      if (nowMs - this.lastAdjustmentAtMs < minCooldown && this.currentBitrateKbps <= ceilingKbps) {
        return {
          changed: false,
          targetBitrateKbps: this.currentBitrateKbps,
          maxFramerate: this.currentMaxFramerate,
          scaleResolutionDownBy: this.currentScaleDown,
          degradationPreference: this.selectDegradationPreference(),
          adaptationStatus: this.currentStatus,
        };
      }

      const factor = severeNetworkPressure ? 0.65 : 0.78;
      let nextBitrate = Math.round(this.currentBitrateKbps * factor);
      if (availableKbps !== null && availableKbps > 0 && availableKbps < nextBitrate) {
        nextBitrate = Math.round(availableKbps * 0.85);
      }
      nextBitrate = Math.max(this.configuredTarget.minBitrateKbps, nextBitrate);

      let nextScaleDown = 1.0;
      if (
        (limiter === 'cpu' && this.configuredTarget.targetWidth >= 2560) ||
        nextBitrate < this.configuredTarget.minSmoothBitrateKbps
      ) {
        nextScaleDown = nextBitrate < this.configuredTarget.minBitrateKbps * 1.2 ? 2.0 : 1.5;
      }

      let nextFps = this.configuredTarget.targetFps;
      if (limiter === 'cpu' && this.configuredTarget.targetFps > 30 && nextBitrate <= ceilingKbps * 0.65) {
        nextFps = 30;
      }

      const changed =
        nextBitrate !== this.currentBitrateKbps ||
        nextScaleDown !== this.currentScaleDown ||
        nextFps !== this.currentMaxFramerate ||
        this.currentStatus !== 'degraded';

      this.currentBitrateKbps = nextBitrate;
      this.currentScaleDown = nextScaleDown;
      this.currentMaxFramerate = nextFps;
      this.currentStatus = nextBitrate < ceilingKbps || nextScaleDown > 1.0 ? 'degraded' : 'target';
      this.lastAdjustmentAtMs = nowMs;

      return {
        changed,
        targetBitrateKbps: this.currentBitrateKbps,
        maxFramerate: this.currentMaxFramerate,
        scaleResolutionDownBy: this.currentScaleDown,
        degradationPreference: this.selectDegradationPreference(),
        adaptationStatus: this.currentStatus,
      };
    }

    // Network & encoder look healthy -> check recovery toward ceilingKbps
    const needsRecovery =
      this.currentBitrateKbps < ceilingKbps ||
      this.currentScaleDown > 1.0 ||
      this.currentMaxFramerate < this.configuredTarget.targetFps;

    if (!needsRecovery) {
      const statusChanged = this.currentStatus !== 'target';
      this.currentStatus = 'target';
      return {
        changed: statusChanged,
        targetBitrateKbps: this.currentBitrateKbps,
        maxFramerate: this.currentMaxFramerate,
        scaleResolutionDownBy: this.currentScaleDown,
        degradationPreference: this.selectDegradationPreference(),
        adaptationStatus: 'target',
      };
    }

    const healthyCondition =
      limiter === 'none' &&
      packetLoss < 0.8 &&
      rttMs < 130 &&
      (availableKbps === null || availableKbps >= this.currentBitrateKbps * 1.15);

    if (healthyCondition) {
      this.healthySamplesStreak += 1;
    } else {
      this.healthySamplesStreak = 0;
    }

    if (this.healthySamplesStreak >= 2 && nowMs - this.lastAdjustmentAtMs >= 1500) {
      let nextBitrate = Math.min(ceilingKbps, Math.round(this.currentBitrateKbps * 1.25));
      if (availableKbps !== null && availableKbps > 0) {
        nextBitrate = Math.min(nextBitrate, Math.round(availableKbps * 0.9));
      }
      nextBitrate = Math.max(this.currentBitrateKbps, nextBitrate);

      const nextScaleDown =
        nextBitrate >= this.configuredTarget.minSmoothBitrateKbps ? 1.0 : this.currentScaleDown;
      const nextFps =
        nextBitrate >= ceilingKbps * 0.7 ? this.configuredTarget.targetFps : this.currentMaxFramerate;

      const atTarget =
        nextBitrate >= ceilingKbps &&
        nextScaleDown === 1.0 &&
        nextFps === this.configuredTarget.targetFps;

      const changed =
        nextBitrate !== this.currentBitrateKbps ||
        nextScaleDown !== this.currentScaleDown ||
        nextFps !== this.currentMaxFramerate;

      this.currentBitrateKbps = nextBitrate;
      this.currentScaleDown = nextScaleDown;
      this.currentMaxFramerate = nextFps;
      this.currentStatus = atTarget ? 'target' : 'recovering';
      this.lastAdjustmentAtMs = nowMs;
      this.healthySamplesStreak = 0;

      return {
        changed,
        targetBitrateKbps: this.currentBitrateKbps,
        maxFramerate: this.currentMaxFramerate,
        scaleResolutionDownBy: this.currentScaleDown,
        degradationPreference: this.selectDegradationPreference(),
        adaptationStatus: this.currentStatus,
      };
    }

    if (this.currentStatus === 'degraded' && healthyCondition) {
      this.currentStatus = 'recovering';
      return {
        changed: true,
        targetBitrateKbps: this.currentBitrateKbps,
        maxFramerate: this.currentMaxFramerate,
        scaleResolutionDownBy: this.currentScaleDown,
        degradationPreference: this.selectDegradationPreference(),
        adaptationStatus: 'recovering',
      };
    }

    return {
      changed: false,
      targetBitrateKbps: this.currentBitrateKbps,
      maxFramerate: this.currentMaxFramerate,
      scaleResolutionDownBy: this.currentScaleDown,
      degradationPreference: this.selectDegradationPreference(),
      adaptationStatus: this.currentStatus,
    };
  }
}
