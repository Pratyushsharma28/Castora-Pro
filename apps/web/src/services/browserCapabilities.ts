import type { CastoraPlatform } from '../types/protocol';
import type { BrowserCapabilityReport } from '../types/studio';

const DEVICE_ID_STORAGE_KEY = 'castora.web.deviceId';
const DEVICE_NAME_STORAGE_KEY = 'castora.web.deviceName';

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

function summarizeUserAgent(userAgent: string): string {
  const platform = detectPlatform(userAgent);
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : userAgent.includes('Chrome/')
      ? 'Chrome'
      : userAgent.includes('Firefox/')
        ? 'Firefox'
        : userAgent.includes('Safari/')
          ? 'Safari'
          : 'Browser';
  const osLabel =
    platform === 'android-tv'
      ? 'Android TV'
      : platform === 'android'
        ? 'Android'
        : userAgent.includes('Macintosh')
          ? 'macOS'
          : 'Desktop';
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
      userAgentSummary: 'Unavailable',
    };
  }

  const ua = navigator.userAgent || '';
  const senderCaps =
    typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function'
      ? RTCRtpSender.getCapabilities('video')
      : null;
  const receiverCaps =
    typeof RTCRtpReceiver !== 'undefined' && typeof RTCRtpReceiver.getCapabilities === 'function'
      ? RTCRtpReceiver.getCapabilities('video')
      : null;

  const senderCodecs = (senderCaps?.codecs ?? []).map((c) => c.mimeType);
  const receiverCodecs = (receiverCaps?.codecs ?? []).map((c) => c.mimeType);
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
    detectedVideoCodecs: uniqueCodecs,
    supportsBarcodeDetector: 'BarcodeDetector' in window,
    supportsFullscreen: Boolean(document.documentElement?.requestFullscreen),
    detectedPlatform: detectPlatform(ua),
    userAgentSummary: summarizeUserAgent(ua),
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
