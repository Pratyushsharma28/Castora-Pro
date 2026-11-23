import type { CastoraPlatform } from '../types/protocol';
import type { BrowserCapabilityReport, DetectedDeviceType } from '../types/studio';

const DEVICE_ID_STORAGE_KEY = 'castora.web.deviceId';
const DEVICE_NAME_STORAGE_KEY = 'castora.web.deviceName';

const RESERVED_EXACT_LABELS = new Set<string>([
  'host',
  'room host',
  'admin',
  'administrator',
  'system',
  'server',
  'castora',
  'castora server',
  'castora signaling server',
  'castora pro',
  'moderator',
  'mod',
  'root',
  'superuser',
  'operator',
  'all',
  'everyone',
  'broadcast',
  'unknown',
  'you',
  'me',
  'anonymous',
  'null',
  'undefined',
  'none',
  'device',
  'local',
  'localhost',
]);

const MISLEADING_SYSTEM_LABEL_REGEX =
  /(\[(?:host|admin|administrator|system|server|moderator|mod|you)\]|\((?:host|admin|administrator|system|server|moderator|mod|you)\)|^(?:host|admin|administrator|system|server|moderator)\s*:)/i;

export function validateDeviceDisplayName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length < 2 || collapsed.length > 48) {
    return 'Device name must be between 2 and 48 characters.';
  }
  if (/[\u0000-\u001F\u007F<>]/.test(collapsed)) {
    return 'Device name contains invalid control or markup characters.';
  }
  const canonical = collapsed.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (RESERVED_EXACT_LABELS.has(canonical) || MISLEADING_SYSTEM_LABEL_REGEX.test(collapsed)) {
    return `"${collapsed}" is a reserved or misleading system label. Choose a descriptive device name.`;
  }
  return null;
}

function detectPlatform(userAgent: string): CastoraPlatform {
  const ua = userAgent.toLowerCase();
  if (ua.includes('android')) {
    if (ua.includes('aft') || ua.includes('bravia') || ua.includes('tv')) {
      return 'android-tv';
    }
    return 'android';
  }
  return 'macos';
}

export function detectDeviceType(
  userAgent: string,
  uaDataPlatform?: string,
  maxTouchPoints = 0
): DetectedDeviceType {
  const ua = (userAgent || '').toLowerCase();
  const hint = (uaDataPlatform || '').toLowerCase();

  if (!ua && !hint) {
    return 'Unknown';
  }

  if (
    ua.includes('smart-tv') ||
    ua.includes('smarttv') ||
    ua.includes('googletv') ||
    ua.includes('android tv') ||
    ua.includes('bravia') ||
    ua.includes('aft') ||
    ua.includes('tizen') ||
    ua.includes('webos') ||
    ua.includes('appletv') ||
    ua.includes('roku')
  ) {
    return 'TV';
  }
  if (ua.includes('ipad') || (ua.includes('macintosh') && maxTouchPoints > 1)) {
    return 'iPad';
  }
  if (ua.includes('iphone') || ua.includes('ipod')) {
    return 'iPhone';
  }
  if (ua.includes('cros') || ua.includes('chromebook')) {
    return 'Chromebook';
  }
  if (ua.includes('android') || hint === 'android') {
    return 'Android';
  }
  if (ua.includes('windows') || hint.includes('win')) {
    return 'Windows';
  }
  if (ua.includes('macintosh') || ua.includes('mac os') || hint === 'macos') {
    return 'Mac';
  }
  if (ua.includes('linux') || ua.includes('x11') || hint === 'linux') {
    return 'Linux';
  }
  return 'Unknown';
}

function summarizeUserAgent(userAgent: string, detectedDeviceType: DetectedDeviceType): string {
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : userAgent.includes('Chrome/')
      ? 'Chrome'
      : userAgent.includes('Firefox/')
        ? 'Firefox'
        : userAgent.includes('Safari/')
          ? 'Safari'
          : 'Browser';
  const osLabel = detectedDeviceType === 'Unknown' ? 'Unknown Device' : detectedDeviceType;
  return `${osLabel} · ${browser}`;
}

export function probeBrowserCapabilities(): BrowserCapabilityReport {
  if (typeof window === 'undefined') {
    return {
      isSecureContext: false,
      origin: '',
      protocol: '',
      supportsDisplayMedia: false,
      supportsRtcPeerConnection: false,
      supportsVideoH264Encode: false,
      supportsVideoH264Decode: false,
      detectedVideoCodecs: [],
      supportsBarcodeDetector: false,
      supportsFullscreen: false,
      detectedPlatform: 'macos',
      detectedDeviceType: 'Unknown',
      userAgentSummary: 'Unknown Device',
    };
  }

  const ua = navigator.userAgent || '';
  const navWithUaData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const uaDataPlatform = navWithUaData.userAgentData?.platform ?? '';
  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  const detectedDeviceType = detectDeviceType(ua, uaDataPlatform, maxTouchPoints);

  const senderCaps =
    typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function'
      ? RTCRtpSender.getCapabilities('video')
      : null;
  const receiverCaps =
    typeof RTCRtpReceiver !== 'undefined' && typeof RTCRtpReceiver.getCapabilities === 'function'
      ? RTCRtpReceiver.getCapabilities('video')
      : null;

  const senderCodecObjs = senderCaps?.codecs ?? [];
  const receiverCodecObjs = receiverCaps?.codecs ?? [];
  const senderCodecs = senderCodecObjs.map((c) => c.mimeType);
  const receiverCodecs = receiverCodecObjs.map((c) => c.mimeType);
  const h264Profiles = Array.from(
    new Set(
      [...senderCodecObjs, ...receiverCodecObjs]
        .filter((c) => c.mimeType.toLowerCase() === 'video/h264' && c.sdpFmtpLine)
        .map((c) => {
          const m = c.sdpFmtpLine?.match(/profile-level-id=([0-9a-f]+)/i);
          return m ? m[1].toLowerCase() : null;
        })
        .filter((p): p is string => Boolean(p))
    )
  );
  const uniqueCodecs = Array.from(
    new Set(
      [...senderCodecs, ...receiverCodecs]
        .filter((mime) => mime.startsWith('video/'))
        .map((mime) => mime.replace('video/', '').toUpperCase())
        .filter((codec) => !['RTX', 'RED', 'ULPFEC', 'FLEXFEC-03'].includes(codec))
    )
  );

  return {
    isSecureContext: Boolean(window.isSecureContext),
    origin: window.location.origin,
    protocol: window.location.protocol,
    supportsDisplayMedia: Boolean(
      navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'
    ),
    supportsRtcPeerConnection: typeof RTCPeerConnection === 'function',
    supportsVideoH264Encode: senderCodecs.some((m) => m.toLowerCase() === 'video/h264'),
    supportsVideoH264Decode: receiverCodecs.some((m) => m.toLowerCase() === 'video/h264'),
    supportsVideoVp9Encode: senderCodecs.some((m) => m.toLowerCase() === 'video/vp9'),
    supportsVideoVp9Decode: receiverCodecs.some((m) => m.toLowerCase() === 'video/vp9'),
    supportsVideoAv1Encode: senderCodecs.some((m) => m.toLowerCase() === 'video/av1'),
    supportsVideoAv1Decode: receiverCodecs.some((m) => m.toLowerCase() === 'video/av1'),
    h264Profiles,
    detectedVideoCodecs: uniqueCodecs,
    supportsBarcodeDetector: 'BarcodeDetector' in window,
    supportsFullscreen: Boolean(
      document.documentElement?.requestFullscreen ||
        (document.documentElement as unknown as { webkitRequestFullscreen?: () => Promise<void> } | null)
          ?.webkitRequestFullscreen
    ),
    detectedPlatform: detectPlatform(ua),
    detectedDeviceType,
    userAgentSummary: summarizeUserAgent(ua, detectedDeviceType),
  };
}

export function loadOrCreateDeviceId(): string {
  if (typeof window === 'undefined') {
    return 'web-ssr-0000';
  }
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && existing.length >= 6) {
      return existing;
    }
    const randomPart =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    const id = `web-${randomPart}`;
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
    return id;
  } catch {
    return `web-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function loadSavedDeviceName(fallbackSummary: string): string {
  if (typeof window === 'undefined') {
    return fallbackSummary;
  }
  try {
    const saved = window.localStorage.getItem(DEVICE_NAME_STORAGE_KEY);
    if (saved && saved.trim().length > 0) {
      return saved.trim();
    }
  } catch {
    // Ignore storage read failure
  }
  return fallbackSummary;
}

export function saveDeviceName(name: string): string {
  const cleaned = name.trim().slice(0, 48);
  if (!cleaned) {
    return '';
  }
  try {
    window.localStorage.setItem(DEVICE_NAME_STORAGE_KEY, cleaned);
  } catch {
    // Ignore storage write failure
  }
  return cleaned;
}
