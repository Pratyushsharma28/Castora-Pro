import type { CastoraVideoCodec } from '../types/protocol';
import type {
  AdaptationStatus,
  AdaptiveAdjustmentAction,
  CapturePreferences,
  CodecPreference,
  FrameRateTarget,
  NetworkConditionLevel,
  QualityProfileId,
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

export interface QualityProfileSpec {
  id: QualityProfileId;
  label: string;
  specLabel: string;
  resolution: ResolutionPresetId;
  targetFps: FrameRateTarget;
  defaultBitrateKbps: number;
  isDefault?: boolean;
}

export const QUALITY_PROFILE_ORDER: QualityProfileId[] = [
  'standard',
  'high',
  'ultra',
  'maximum',
];

export const QUALITY_PROFILES: Record<QualityProfileId, QualityProfileSpec> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    specLabel: '1080p30 · 7.5 Mbps',
    resolution: '1080p',
    targetFps: 30,
    defaultBitrateKbps: 7_500,
  },
  high: {
    id: 'high',
    label: 'High',
    specLabel: '1080p60 · 10 Mbps',
    resolution: '1080p',
    targetFps: 60,
    defaultBitrateKbps: 10_000,
    isDefault: true,
  },
  ultra: {
    id: 'ultra',
    label: 'Ultra',
    specLabel: '1440p60 · 20 Mbps',
    resolution: '1440p',
    targetFps: 60,
    defaultBitrateKbps: 20_000,
  },
  maximum: {
    id: 'maximum',
    label: 'Maximum',
    specLabel: '4K60 · 40 Mbps',
    resolution: '4k',
    targetFps: 60,
    defaultBitrateKbps: 40_000,
  },
};

export function resolveProfileIdFromPreferences(
  preferences: CapturePreferences
): QualityProfileId | null {
  if (preferences.resolution === '1080p' && preferences.targetFps === 30) {
    return 'standard';
  }
  if (preferences.resolution === '1080p' && preferences.targetFps === 60) {
    return 'high';
  }
  if (preferences.resolution === '1440p' && preferences.targetFps === 60) {
    return 'ultra';
  }
  if (preferences.resolution === '4k' && preferences.targetFps === 60) {
    return 'maximum';
  }
  return null;
}

export function applyQualityProfileToPreferences(
  current: CapturePreferences,
  profileId: QualityProfileId
): CapturePreferences {
  const profile = QUALITY_PROFILES[profileId] ?? QUALITY_PROFILES.high;
  return {
    ...current,
    resolution: profile.resolution,
    targetFps: profile.targetFps,
    maxBitrateKbps: profile.defaultBitrateKbps,
  };
}

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

  const targetWidth = actualDims?.width ?? preset.targetWidth ?? 1920;
  const targetHeight = actualDims?.height ?? preset.targetHeight ?? 1080;

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
 * smoothly up to 15 receivers so CPU, GPU hardware encoders, and uplink bandwidth
 * are not saturated.
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
      : activeOutboundPeers <= 5
        ? Math.max(0.5, Math.min(0.75, 1.35 / activeOutboundPeers))
        : Math.max(0.18, Math.min(0.45, 2.5 / activeOutboundPeers));
  return Math.max(minBitrateKbps, Math.round(configuredBitrateKbps * factor));
}

export interface CodecPreferenceResult {
  orderedCodecs: RTCRtpCodec[];
  codecHint: CastoraVideoCodec;
  availableVideoCodecs: CastoraVideoCodec[];
}

export function extractH264FmtpInfo(sdpFmtpLine: string | undefined): {
  profileLevelId: string | null;
  profilePrefix: string | null;
  packetizationMode: string | null;
  levelAsymmetryAllowed: boolean;
} {
  const fmtp = (sdpFmtpLine ?? '').toLowerCase();
  const profileMatch = fmtp.match(/profile-level-id=([0-9a-f]{4,6})/i);
  const packetMatch = fmtp.match(/packetization-mode=(\d+)/i);
  const profileLevelId = profileMatch ? profileMatch[1].toLowerCase() : null;
  return {
    profileLevelId,
    profilePrefix: profileLevelId ? profileLevelId.slice(0, 4) : null,
    packetizationMode: packetMatch ? packetMatch[1] : null,
    levelAsymmetryAllowed: fmtp.includes('level-asymmetry-allowed=1'),
  };
}

export function getH264ProfilePriority(sdpFmtpLine: string | undefined): number {
  const { profilePrefix, packetizationMode, levelAsymmetryAllowed } =
    extractH264FmtpInfo(sdpFmtpLine);

  // TV, Android Chrome, and WebRTC mandatory-to-implement H.264 requires packetization-mode=1.
  const packetizationBonus =
    packetizationMode === '1' ? 200 : packetizationMode === '0' ? 0 : 100;
  const asymmetryBonus = levelAsymmetryAllowed ? 20 : 0;

  // Prioritize universally compatible H.264 profiles (Constrained Baseline 42e0 / Baseline 4200)
  // ahead of Main (4d00) and High (6400), which many TV/mobile hardware decoders reject.
  let profileScore = 10;
  if (profilePrefix === '42e0') profileScore = 50;
  else if (profilePrefix === '4200') profileScore = 40;
  else if (profilePrefix === '4d00') profileScore = 30;
  else if (profilePrefix === '6400') profileScore = 20;

  return packetizationBonus + asymmetryBonus + profileScore;
}

export function normalizeVideoCodecName(mimeType: string | undefined): CastoraVideoCodec | null {
  if (!mimeType) return null;
  const lower = mimeType.toLowerCase();
  if (lower === 'video/h264' || lower === 'h264') return 'H264';
  if (lower === 'video/vp9' || lower === 'vp9') return 'VP9';
  if (lower === 'video/av1' || lower === 'av1' || lower === 'av1x') return 'AV1';
  if (lower === 'video/vp8' || lower === 'vp8') return 'VP8';
  return null;
}

export function getCodecFallbackChain(
  preferred: CodecPreference | CastoraVideoCodec,
  availableVideoCodecs?: CastoraVideoCodec[]
): CastoraVideoCodec[] {
  const baseChain: CastoraVideoCodec[] =
    preferred === 'H264'
      ? ['H264', 'VP9', 'VP8']
      : preferred === 'AV1'
        ? ['AV1', 'VP9', 'H264', 'VP8']
        : preferred === 'VP9'
          ? ['VP9', 'H264', 'VP8']
          : preferred === 'VP8'
            ? ['VP8', 'VP9', 'H264']
            : ['H264', 'VP9', 'VP8', 'AV1'];

  if (!availableVideoCodecs || availableVideoCodecs.length === 0) {
    return baseChain;
  }
  const availableSet = new Set(availableVideoCodecs);
  const filtered = baseChain.filter((c) => availableSet.has(c));
  for (const codec of availableVideoCodecs) {
    if (!filtered.includes(codec)) {
      filtered.push(codec);
    }
  }
  return filtered.length > 0 ? filtered : baseChain;
}

export function getNextFallbackCodec(
  currentCodec: CodecPreference | CastoraVideoCodec,
  triedCodecs: ReadonlySet<CastoraVideoCodec>,
  availableVideoCodecs?: CastoraVideoCodec[]
): CastoraVideoCodec | null {
  const chain = getCodecFallbackChain(currentCodec, availableVideoCodecs);
  for (const candidate of chain) {
    if (!triedCodecs.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function orderVideoCodecsForPreference(
  capabilitiesCodecs: RTCRtpCodec[],
  preference: CodecPreference | CastoraVideoCodec,
  receiverCapabilitiesCodecs?: RTCRtpCodec[] | null
): CodecPreferenceResult {
  if (!capabilitiesCodecs || capabilitiesCodecs.length === 0) {
    return {
      orderedCodecs: [],
      codecHint:
        preference === 'H264'
          ? 'H264'
          : preference === 'VP9'
            ? 'VP9'
            : preference === 'AV1'
              ? 'AV1'
              : 'VP8',
      availableVideoCodecs: [],
    };
  }

  const normalizedMime = (c: RTCRtpCodec) => c.mimeType.toLowerCase();
  const auxiliary = capabilitiesCodecs.filter((c) => {
    const m = normalizedMime(c);
    return m === 'video/rtx' || m === 'video/red' || m === 'video/ulpfec' || m === 'video/flexfec-03';
  });

  // If receiver capabilities are provided, slightly boost mutually matching codecs/profiles
  // without removing fallback sender codecs needed for heterogeneous remote peers (e.g. TVs).
  const receiverH264Keys = new Set(
    (receiverCapabilitiesCodecs ?? [])
      .filter((c) => normalizedMime(c) === 'video/h264')
      .map((c) => {
        const info = extractH264FmtpInfo(c.sdpFmtpLine);
        return `${info.profilePrefix ?? ''}:${info.packetizationMode ?? ''}`;
      })
  );

  const h264 = capabilitiesCodecs
    .filter((c) => normalizedMime(c) === 'video/h264')
    .sort((a, b) => {
      const aInfo = extractH264FmtpInfo(a.sdpFmtpLine);
      const bInfo = extractH264FmtpInfo(b.sdpFmtpLine);
      const aMatchBonus =
        receiverH264Keys.size > 0 &&
        receiverH264Keys.has(`${aInfo.profilePrefix ?? ''}:${aInfo.packetizationMode ?? ''}`)
          ? 5
          : 0;
      const bMatchBonus =
        receiverH264Keys.size > 0 &&
        receiverH264Keys.has(`${bInfo.profilePrefix ?? ''}:${bInfo.packetizationMode ?? ''}`)
          ? 5
          : 0;
      return (
        getH264ProfilePriority(b.sdpFmtpLine) +
        bMatchBonus -
        (getH264ProfilePriority(a.sdpFmtpLine) + aMatchBonus)
      );
    });
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

  const availableVideoCodecs: CastoraVideoCodec[] = [];
  if (h264.length > 0) availableVideoCodecs.push('H264');
  if (vp9.length > 0) availableVideoCodecs.push('VP9');
  if (av1.length > 0) availableVideoCodecs.push('AV1');
  if (vp8.length > 0) availableVideoCodecs.push('VP8');

  if (preference === 'H264') {
    const ordered = [...h264, ...vp9, ...vp8, ...av1, ...rest, ...auxiliary];
    return {
      orderedCodecs: ordered,
      codecHint: h264.length > 0 ? 'H264' : vp9.length > 0 ? 'VP9' : vp8.length > 0 ? 'VP8' : 'AV1',
      availableVideoCodecs,
    };
  }

  if (preference === 'VP9') {
    const ordered = [...vp9, ...h264, ...vp8, ...av1, ...rest, ...auxiliary];
    return {
      orderedCodecs: ordered,
      codecHint: vp9.length > 0 ? 'VP9' : h264.length > 0 ? 'H264' : vp8.length > 0 ? 'VP8' : 'AV1',
      availableVideoCodecs,
    };
  }

  if (preference === 'AV1') {
    const ordered = [...av1, ...vp9, ...h264, ...vp8, ...rest, ...auxiliary];
    return {
      orderedCodecs: ordered,
      codecHint: av1.length > 0 ? 'AV1' : vp9.length > 0 ? 'VP9' : h264.length > 0 ? 'H264' : 'VP8',
      availableVideoCodecs,
    };
  }

  if (preference === 'VP8') {
    const ordered = [...vp8, ...vp9, ...h264, ...av1, ...rest, ...auxiliary];
    return {
      orderedCodecs: ordered,
      codecHint: vp8.length > 0 ? 'VP8' : vp9.length > 0 ? 'VP9' : h264.length > 0 ? 'H264' : 'AV1',
      availableVideoCodecs,
    };
  }

  const ordered = [...h264, ...vp9, ...vp8, ...av1, ...rest, ...auxiliary];
  return {
    orderedCodecs: ordered,
    codecHint: h264.length > 0 ? 'H264' : vp9.length > 0 ? 'VP9' : vp8.length > 0 ? 'VP8' : 'AV1',
    availableVideoCodecs,
  };
}

export interface SdpNegotiatedMediaInfo {
  hasVideo: boolean;
  videoRejected: boolean;
  primaryVideoCodec: CastoraVideoCodec | null;
  videoCodecOrder: CastoraVideoCodec[];
  videoFmtp: string | null;
  h264ProfileLevelId: string | null;
  hasAudio: boolean;
  audioRejected: boolean;
  audioActive: boolean;
  primaryAudioCodec: string | null;
}

export function inspectSdpNegotiatedMedia(sdp: string | undefined | null): SdpNegotiatedMediaInfo {
  const empty: SdpNegotiatedMediaInfo = {
    hasVideo: false,
    videoRejected: false,
    primaryVideoCodec: null,
    videoCodecOrder: [],
    videoFmtp: null,
    h264ProfileLevelId: null,
    hasAudio: false,
    audioRejected: false,
    audioActive: false,
    primaryAudioCodec: null,
  };
  if (!sdp || typeof sdp !== 'string') return empty;

  const lines = sdp.split(/\r?\n/);
  let currentMedia: 'video' | 'audio' | 'other' | null = null;
  let videoPortZero = false;
  let audioPortZero = false;
  let videoDirection = 'sendrecv';
  let audioDirection = 'sendrecv';
  const videoPayloadOrder: string[] = [];
  const audioPayloadOrder: string[] = [];
  const videoRtpmap = new Map<string, string>();
  const videoFmtp = new Map<string, string>();
  const audioRtpmap = new Map<string, string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(/\s+/);
      const kind = parts[0]?.toLowerCase();
      const port = Number(parts[1] ?? '0');
      const payloads = parts.slice(3);
      if (kind === 'video') {
        currentMedia = 'video';
        empty.hasVideo = true;
        if (port === 0) videoPortZero = true;
        videoPayloadOrder.push(...payloads);
      } else if (kind === 'audio') {
        currentMedia = 'audio';
        empty.hasAudio = true;
        if (port === 0) audioPortZero = true;
        audioPayloadOrder.push(...payloads);
      } else {
        currentMedia = 'other';
      }
      continue;
    }

    if (line === 'a=inactive' || line === 'a=recvonly' || line === 'a=sendonly' || line === 'a=sendrecv') {
      const dir = line.slice(2);
      if (currentMedia === 'video') videoDirection = dir;
      if (currentMedia === 'audio') audioDirection = dir;
      continue;
    }

    if (line.startsWith('a=rtpmap:')) {
      const match = line.match(/^a=rtpmap:(\S+)\s+([^/\s]+)/i);
      if (match) {
        const [, pt, codec] = match;
        if (currentMedia === 'video') videoRtpmap.set(pt, codec.toUpperCase());
        if (currentMedia === 'audio') audioRtpmap.set(pt, codec.toUpperCase());
      }
      continue;
    }

    if (line.startsWith('a=fmtp:')) {
      const match = line.match(/^a=fmtp:(\S+)\s+(.+)$/i);
      if (match && currentMedia === 'video') {
        videoFmtp.set(match[1], match[2]);
      }
    }
  }

  const videoCodecOrder: CastoraVideoCodec[] = [];
  let primaryFmtp: string | null = null;
  let primaryProfileLevelId: string | null = null;

  for (const pt of videoPayloadOrder) {
    const codecName = videoRtpmap.get(pt);
    if (!codecName) continue;
    if (codecName === 'RTX' || codecName === 'RED' || codecName === 'ULPFEC' || codecName === 'FLEXFEC-03') {
      continue;
    }
    const normalized = normalizeVideoCodecName(codecName);
    if (normalized) {
      if (videoCodecOrder.length === 0) {
        primaryFmtp = videoFmtp.get(pt) ?? null;
        if (normalized === 'H264' && primaryFmtp) {
          primaryProfileLevelId = extractH264FmtpInfo(primaryFmtp).profileLevelId;
        }
      }
      if (!videoCodecOrder.includes(normalized)) {
        videoCodecOrder.push(normalized);
      }
    }
  }

  let primaryAudioCodec: string | null = null;
  for (const pt of audioPayloadOrder) {
    const codecName = audioRtpmap.get(pt);
    if (!codecName || codecName === 'TELEPHONE-EVENT' || codecName === 'CN') continue;
    primaryAudioCodec = codecName;
    break;
  }

  return {
    hasVideo: empty.hasVideo,
    videoRejected: empty.hasVideo && (videoPortZero || videoDirection === 'inactive'),
    primaryVideoCodec: videoCodecOrder[0] ?? null,
    videoCodecOrder,
    videoFmtp: primaryFmtp,
    h264ProfileLevelId: primaryProfileLevelId,
    hasAudio: empty.hasAudio,
    audioRejected: empty.hasAudio && (audioPortZero || audioDirection === 'inactive'),
    audioActive: empty.hasAudio && !audioPortZero && audioDirection !== 'inactive',
    primaryAudioCodec,
  };
}

export function formatMbpsLabel(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function assessNetworkCondition(
  stats: StreamTelemetrySnapshot,
  referenceBitrateKbps?: number,
  deltaDroppedFrames = 0
): NetworkConditionLevel {
  const hasAnySignal =
    stats.rttMs !== null ||
    stats.packetLossPct !== null ||
    stats.jitterMs !== null ||
    stats.availableOutgoingBitrateKbps !== null ||
    stats.qualityLimitationReason !== null ||
    stats.encodedFps !== null ||
    stats.droppedFrames !== null;

  if (!hasAnySignal) {
    return 'unavailable';
  }

  const packetLoss = stats.packetLossPct ?? 0;
  const rttMs = stats.rttMs ?? 0;
  const jitterMs = stats.jitterMs ?? 0;
  const limiter = stats.qualityLimitationReason ?? 'none';
  const availableKbps = stats.availableOutgoingBitrateKbps ?? null;
  const targetFps = stats.targetFps > 0 ? stats.targetFps : 60;
  const actualFps = stats.encodedFps ?? null;

  const severeFpsShortfall =
    actualFps !== null && actualFps > 0 && actualFps < Math.max(12, targetFps * 0.45);
  const moderateFpsShortfall =
    actualFps !== null && actualFps > 0 && actualFps < Math.max(20, targetFps * 0.7);
  const availableSevere =
    availableKbps !== null &&
    availableKbps > 0 &&
    Boolean(referenceBitrateKbps && referenceBitrateKbps > 0) &&
    availableKbps < (referenceBitrateKbps ?? 0) * 0.62;
  const availableModerate =
    availableKbps !== null &&
    availableKbps > 0 &&
    Boolean(referenceBitrateKbps && referenceBitrateKbps > 0) &&
    availableKbps < (referenceBitrateKbps ?? 0) * 0.88;

  if (
    packetLoss >= 4.0 ||
    rttMs >= 240 ||
    jitterMs >= 45 ||
    availableSevere ||
    deltaDroppedFrames >= 12 ||
    severeFpsShortfall
  ) {
    return 'congested';
  }

  if (
    packetLoss >= 1.5 ||
    rttMs >= 150 ||
    jitterMs >= 25 ||
    limiter === 'bandwidth' ||
    limiter === 'cpu' ||
    availableModerate ||
    deltaDroppedFrames >= 4 ||
    moderateFpsShortfall
  ) {
    return 'moderate';
  }

  return 'healthy';
}

export interface AdaptiveBitrateDecision {
  changed: boolean;
  targetBitrateKbps: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  degradationPreference: RTCDegradationPreference;
  adaptationStatus: AdaptationStatus;
  adaptiveMode: 'auto' | 'manual';
  networkCondition: NetworkConditionLevel;
  lastAdjustmentReason: string | null;
  lastAdjustmentAt: number | null;
  lastAdjustmentAction: AdaptiveAdjustmentAction;
}

export interface AdaptiveControllerOptions {
  downgradeCooldownMs?: number;
  severeDowngradeCooldownMs?: number;
  postDowngradeUpgradeCooldownMs?: number;
  upgradeCooldownMs?: number;
  upgradeHealthyStreakRequired?: number;
}

export class AdaptiveBitrateController {
  private configuredTarget: ResolvedQualityTarget;
  private currentBitrateKbps: number;
  private currentScaleDown = 1.0;
  private currentMaxFramerate: number;
  private currentStatus: AdaptationStatus = 'target';
  private networkCondition: NetworkConditionLevel = 'unavailable';
  private healthySamplesStreak = 0;
  private congestedSamplesStreak = 0;
  private lastAdjustmentAtMs = 0;
  private lastDowngradeAtMs = 0;
  private lastAdjustmentAt: number | null = null;
  private lastAdjustmentReason: string | null = null;
  private lastAdjustmentAction: AdaptiveAdjustmentAction = 'none';
  private prevDroppedFrames: number | null = null;

  private readonly downgradeCooldownMs: number;
  private readonly severeDowngradeCooldownMs: number;
  private readonly postDowngradeUpgradeCooldownMs: number;
  private readonly upgradeCooldownMs: number;
  private readonly upgradeHealthyStreakRequired: number;

  constructor(
    preferences: CapturePreferences,
    actualDims?: { width?: number | null; height?: number | null },
    options: AdaptiveControllerOptions = {}
  ) {
    this.configuredTarget = resolveQualityTarget(preferences, actualDims);
    this.currentBitrateKbps = this.configuredTarget.configuredMaxBitrateKbps;
    this.currentMaxFramerate = this.configuredTarget.targetFps;
    this.downgradeCooldownMs = Math.max(250, options.downgradeCooldownMs ?? 1800);
    this.severeDowngradeCooldownMs = Math.max(200, options.severeDowngradeCooldownMs ?? 1000);
    this.postDowngradeUpgradeCooldownMs = Math.max(
      500,
      options.postDowngradeUpgradeCooldownMs ?? 5000
    );
    this.upgradeCooldownMs = Math.max(500, options.upgradeCooldownMs ?? 3000);
    this.upgradeHealthyStreakRequired = Math.max(1, options.upgradeHealthyStreakRequired ?? 2);

    if (!this.configuredTarget.adaptiveEnabled) {
      this.lastAdjustmentAction = 'manual-locked';
      this.lastAdjustmentReason = 'Manual quality selected — automatic adaptation disabled.';
    }
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
    this.congestedSamplesStreak = 0;
    this.lastAdjustmentAtMs = 0;
    this.lastDowngradeAtMs = 0;
    this.prevDroppedFrames = null;

    if (!this.configuredTarget.adaptiveEnabled) {
      this.lastAdjustmentAction = 'manual-locked';
      this.lastAdjustmentReason = 'Manual quality locked — automatic adaptation paused.';
    } else {
      this.lastAdjustmentAction = 'none';
      this.lastAdjustmentReason = null;
    }

    return this.buildDecision(true);
  }

  getCurrentState(): {
    configuredMaxBitrateKbps: number;
    targetBitrateKbps: number;
    targetFramerate: number;
    scaleResolutionDownBy: number;
    adaptationStatus: AdaptationStatus;
    adaptiveMode: 'auto' | 'manual';
    networkCondition: NetworkConditionLevel;
    lastAdjustmentReason: string | null;
    lastAdjustmentAt: number | null;
    lastAdjustmentAction: AdaptiveAdjustmentAction;
  } {
    return {
      configuredMaxBitrateKbps: this.configuredTarget.configuredMaxBitrateKbps,
      targetBitrateKbps: this.currentBitrateKbps,
      targetFramerate: this.currentMaxFramerate,
      scaleResolutionDownBy: this.currentScaleDown,
      adaptationStatus: this.currentStatus,
      adaptiveMode: this.configuredTarget.adaptiveEnabled ? 'auto' : 'manual',
      networkCondition: this.networkCondition,
      lastAdjustmentReason: this.lastAdjustmentReason,
      lastAdjustmentAt: this.lastAdjustmentAt,
      lastAdjustmentAction: this.lastAdjustmentAction,
    };
  }

  private selectDegradationPreference(): RTCDegradationPreference {
    if (
      this.configuredTarget.preset.id === '1440p' ||
      this.configuredTarget.preset.id === '4k'
    ) {
      return 'maintain-resolution';
    }
    return 'balanced';
  }

  private computeDeltaDroppedFrames(droppedFrames: number | null): number {
    if (droppedFrames === null || !Number.isFinite(droppedFrames) || droppedFrames < 0) {
      return 0;
    }
    if (this.prevDroppedFrames === null) {
      this.prevDroppedFrames = droppedFrames;
      return 0;
    }
    const delta =
      droppedFrames >= this.prevDroppedFrames
        ? droppedFrames - this.prevDroppedFrames
        : droppedFrames;
    this.prevDroppedFrames = droppedFrames;
    return delta;
  }

  private buildDecision(changed: boolean): AdaptiveBitrateDecision {
    return {
      changed,
      targetBitrateKbps: this.currentBitrateKbps,
      maxFramerate: this.currentMaxFramerate,
      scaleResolutionDownBy: this.currentScaleDown,
      degradationPreference: this.selectDegradationPreference(),
      adaptationStatus: this.currentStatus,
      adaptiveMode: this.configuredTarget.adaptiveEnabled ? 'auto' : 'manual',
      networkCondition: this.networkCondition,
      lastAdjustmentReason: this.lastAdjustmentReason,
      lastAdjustmentAt: this.lastAdjustmentAt,
      lastAdjustmentAction: this.lastAdjustmentAction,
    };
  }

  private buildPressureReasons(params: {
    packetLoss: number;
    rttMs: number;
    jitterMs: number;
    limiter: string;
    availableKbps: number | null;
    deltaDropped: number;
    encodedFps: number | null;
  }): string {
    const reasons: string[] = [];
    if (params.packetLoss >= 1.5) reasons.push(`${params.packetLoss.toFixed(1)}% packet loss`);
    if (params.rttMs >= 150) reasons.push(`${Math.round(params.rttMs)} ms RTT`);
    if (params.jitterMs >= 25) reasons.push(`${params.jitterMs.toFixed(1)} ms jitter`);
    if (
      params.availableKbps !== null &&
      params.availableKbps > 0 &&
      params.availableKbps < this.currentBitrateKbps * 0.88
    ) {
      reasons.push(`uplink est. ${formatMbpsLabel(params.availableKbps)}`);
    }
    if (params.deltaDropped >= 4) reasons.push(`${params.deltaDropped} dropped frames`);
    if (
      params.encodedFps !== null &&
      params.encodedFps > 0 &&
      params.encodedFps < Math.max(20, this.configuredTarget.targetFps * 0.7)
    ) {
      reasons.push(`FPS dipped to ${params.encodedFps.toFixed(0)}`);
    }
    if (params.limiter === 'cpu') reasons.push('encoder CPU limit');
    else if (params.limiter === 'bandwidth' && reasons.length === 0) {
      reasons.push('bandwidth congestion');
    }
    return reasons.length > 0 ? reasons.join(', ') : 'network congestion';
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

    const deltaDropped = this.computeDeltaDroppedFrames(stats.droppedFrames);
    this.networkCondition = assessNetworkCondition(stats, this.currentBitrateKbps, deltaDropped);

    // Manual mode protection: NEVER override user-selected profile or bitrate automatically
    if (!this.configuredTarget.adaptiveEnabled) {
      const changed =
        this.currentBitrateKbps !== ceilingKbps ||
        this.currentScaleDown !== 1.0 ||
        this.currentMaxFramerate !== this.configuredTarget.targetFps ||
        this.currentStatus !== 'target';
      this.currentBitrateKbps = ceilingKbps;
      this.currentScaleDown = 1.0;
      this.currentMaxFramerate = this.configuredTarget.targetFps;
      this.currentStatus = 'target';
      this.healthySamplesStreak = 0;
      this.congestedSamplesStreak = 0;
      this.lastAdjustmentAction = 'manual-locked';
      this.lastAdjustmentReason = 'Manual quality locked — automatic adaptation paused.';
      return this.buildDecision(changed);
    }

    // When WebRTC statistics are unavailable, avoid blind degradation or false upgrades
    if (this.networkCondition === 'unavailable') {
      return this.buildDecision(false);
    }

    const packetLoss = stats.packetLossPct ?? 0;
    const rttMs = stats.rttMs ?? 0;
    const jitterMs = stats.jitterMs ?? 0;
    const limiter = stats.qualityLimitationReason ?? 'none';
    const availableKbps = stats.availableOutgoingBitrateKbps ?? null;
    const encodedFps = stats.encodedFps ?? null;

    const severePressure = this.networkCondition === 'congested';
    const moderatePressure = this.networkCondition === 'moderate';

    if (severePressure || moderatePressure) {
      this.healthySamplesStreak = 0;
      this.congestedSamplesStreak += 1;

      const minCooldown = severePressure
        ? this.severeDowngradeCooldownMs
        : this.downgradeCooldownMs;
      if (
        this.lastAdjustmentAtMs > 0 &&
        nowMs - this.lastAdjustmentAtMs < minCooldown &&
        this.currentBitrateKbps <= ceilingKbps
      ) {
        return this.buildDecision(false);
      }

      // Step 1: Always reduce bitrate first
      const factor = severePressure ? 0.65 : 0.78;
      let nextBitrate = Math.round(this.currentBitrateKbps * factor);
      if (availableKbps !== null && availableKbps > 0 && availableKbps < nextBitrate) {
        nextBitrate = Math.round(availableKbps * 0.85);
      }
      nextBitrate = Math.max(this.configuredTarget.minBitrateKbps, Math.min(ceilingKbps, nextBitrate));

      // Step 2: Reduce FPS or resolution scaling ONLY when bitrate alone is at/near floor
      // or sustained CPU/frame-drop pressure requires lowering pixel/frame load.
      const bitrateAtSmoothFloor = nextBitrate <= this.configuredTarget.minSmoothBitrateKbps;
      const sustainedPressure = this.congestedSamplesStreak >= 2;

      let nextMaxFps = this.currentMaxFramerate;
      if (
        this.configuredTarget.targetFps > 30 &&
        ((limiter === 'cpu' && nextBitrate <= ceilingKbps * 0.75) ||
          (sustainedPressure && nextBitrate <= ceilingKbps * 0.6) ||
          (deltaDropped >= 10 && bitrateAtSmoothFloor))
      ) {
        nextMaxFps = 30;
      }

      let nextScaleDown = this.currentScaleDown;
      if (
        bitrateAtSmoothFloor ||
        (limiter === 'cpu' && this.configuredTarget.targetWidth >= 2560 && sustainedPressure)
      ) {
        if (nextBitrate <= this.configuredTarget.minBitrateKbps * 1.15 && sustainedPressure) {
          nextScaleDown = Math.max(nextScaleDown, 2.0);
        } else {
          nextScaleDown = Math.max(nextScaleDown, 1.5);
        }
      }

      const changed =
        nextBitrate !== this.currentBitrateKbps ||
        nextScaleDown !== this.currentScaleDown ||
        nextMaxFps !== this.currentMaxFramerate ||
        this.currentStatus !== 'degraded';

      if (changed) {
        const pressureSummary = this.buildPressureReasons({
          packetLoss,
          rttMs,
          jitterMs,
          limiter,
          availableKbps,
          deltaDropped,
          encodedFps,
        });

        let action: AdaptiveAdjustmentAction = 'reduced-bitrate';
        const adjustments: string[] = [];
        if (nextBitrate < this.currentBitrateKbps) {
          adjustments.push(`bitrate to ${formatMbpsLabel(nextBitrate)}`);
        }
        if (nextMaxFps < this.currentMaxFramerate) {
          action = 'reduced-fps';
          adjustments.push(`frame rate to ${nextMaxFps} FPS`);
        }
        if (nextScaleDown > this.currentScaleDown) {
          action = 'reduced-resolution';
          adjustments.push(`resolution scale ${nextScaleDown.toFixed(1)}× down`);
        }

        const changeSummary =
          adjustments.length > 0 ? adjustments.join(' and ') : `bitrate cap ${formatMbpsLabel(nextBitrate)}`;
        this.lastAdjustmentAction = action;
        this.lastAdjustmentReason = `Lowered ${changeSummary} due to ${pressureSummary}.`;
        this.lastAdjustmentAt = nowMs;
      }

      this.currentBitrateKbps = nextBitrate;
      this.currentScaleDown = nextScaleDown;
      this.currentMaxFramerate = nextMaxFps;
      this.currentStatus =
        nextBitrate < ceilingKbps ||
        nextScaleDown > 1.0 ||
        nextMaxFps < this.configuredTarget.targetFps
          ? 'degraded'
          : 'target';
      this.lastAdjustmentAtMs = nowMs;
      this.lastDowngradeAtMs = nowMs;

      return this.buildDecision(changed);
    }

    // Healthy network sample
    this.congestedSamplesStreak = 0;

    const needsRecovery =
      this.currentBitrateKbps < ceilingKbps ||
      this.currentScaleDown > 1.0 ||
      this.currentMaxFramerate < this.configuredTarget.targetFps;

    if (!needsRecovery) {
      const statusChanged = this.currentStatus !== 'target';
      this.currentStatus = 'target';
      return this.buildDecision(statusChanged);
    }

    const healthyForUpgrade =
      limiter === 'none' &&
      packetLoss < 0.8 &&
      rttMs < 130 &&
      jitterMs < 20 &&
      (availableKbps === null || availableKbps >= this.currentBitrateKbps * 1.12);

    if (healthyForUpgrade) {
      this.healthySamplesStreak += 1;
    } else {
      this.healthySamplesStreak = 0;
    }

    // Hysteresis: wait longer right after any downgrade before stepping back up
    const elapsedSinceLastAdj = nowMs - this.lastAdjustmentAtMs;
    const elapsedSinceDowngrade =
      this.lastDowngradeAtMs > 0 ? nowMs - this.lastDowngradeAtMs : Number.POSITIVE_INFINITY;
    const cooldownSatisfied =
      elapsedSinceLastAdj >= this.upgradeCooldownMs &&
      elapsedSinceDowngrade >= this.postDowngradeUpgradeCooldownMs;

    if (this.healthySamplesStreak >= this.upgradeHealthyStreakRequired && cooldownSatisfied) {
      let nextBitrate = Math.min(ceilingKbps, Math.round(this.currentBitrateKbps * 1.3));
      if (availableKbps !== null && availableKbps > 0) {
        nextBitrate = Math.min(nextBitrate, Math.round(availableKbps * 0.9));
      }
      nextBitrate = Math.max(this.currentBitrateKbps, nextBitrate);

      const nextScaleDown =
        nextBitrate >= this.configuredTarget.minSmoothBitrateKbps ? 1.0 : this.currentScaleDown;
      const nextMaxFps =
        nextBitrate >= ceilingKbps * 0.65
          ? this.configuredTarget.targetFps
          : this.currentMaxFramerate;

      const atTarget =
        nextBitrate >= ceilingKbps &&
        nextScaleDown === 1.0 &&
        nextMaxFps === this.configuredTarget.targetFps;

      const changed =
        nextBitrate !== this.currentBitrateKbps ||
        nextScaleDown !== this.currentScaleDown ||
        nextMaxFps !== this.currentMaxFramerate ||
        this.currentStatus !== (atTarget ? 'target' : 'recovering');

      if (changed) {
        this.lastAdjustmentAction = 'restored';
        this.lastAdjustmentReason = atTarget
          ? `Restored target quality (${formatMbpsLabel(nextBitrate)} @ ${nextMaxFps} FPS) after stable network recovery.`
          : `Stepped quality up toward target (${formatMbpsLabel(nextBitrate)} @ ${nextMaxFps} FPS) on healthy link metrics.`;
        this.lastAdjustmentAt = nowMs;
      }

      this.currentBitrateKbps = nextBitrate;
      this.currentScaleDown = nextScaleDown;
      this.currentMaxFramerate = nextMaxFps;
      this.currentStatus = atTarget ? 'target' : 'recovering';
      this.lastAdjustmentAtMs = nowMs;
      this.healthySamplesStreak = 0;

      return this.buildDecision(changed);
    }

    if (this.currentStatus === 'degraded' && healthyForUpgrade) {
      this.currentStatus = 'recovering';
      return this.buildDecision(true);
    }

    return this.buildDecision(false);
  }
}
