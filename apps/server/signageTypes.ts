import type { CastoraPlatform, DetectedDeviceType } from './types.ts';

export const MAX_SIGNAGE_SCREENS = 15;
export const DEFAULT_MAX_SIGNAGE_FILE_BYTES = 250 * 1024 * 1024; // 250 MB per asset
export const DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS = 6;
export const DEFAULT_IMAGE_DURATION_SEC = 10;
export const MIN_IMAGE_DURATION_SEC = 1;
export const MAX_IMAGE_DURATION_SEC = 3600;
export const SCREEN_ONLINE_TIMEOUT_MS = 45_000;

export type SignageMediaKind = 'image' | 'video';
export type SignageUploadStatus = 'uploading' | 'ready' | 'failed';
export type SignageStorageProvider = 's3' | 'local-dev' | 'unconfigured';
export type SignageDbProvider = 'postgres' | 'sqlite';

export type SignagePlaybackCommand = 'play' | 'pause' | 'stop';
export type SignagePlaybackState =
  | 'idle'
  | 'syncing'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'offline'
  | 'error';

export type SignageCacheItemStatus = 'pending' | 'downloading' | 'cached' | 'error';

export interface SignageMediaAsset {
  id: string;
  workspaceId: string;
  originalName: string;
  displayName: string;
  mediaKind: SignageMediaKind;
  mimeType: string;
  format: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  sha256: string;
  storageProvider: 's3' | 'local-dev';
  storageKey: string;
  uploadStatus: SignageUploadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SignagePlaylistItem {
  id: string;
  playlistId: string;
  mediaId: string;
  sortOrder: number;
  imageDurationSec: number;
  repeatCount: number;
  playUntilEnd: boolean;
  createdAt: string;
  media?: SignageMediaAsset | null;
}

export interface SignagePlaylist {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  loopPlaylist: boolean;
  items: SignagePlaylistItem[];
  createdAt: string;
  updatedAt: string;
}

export interface SignageDeviceCacheRecord {
  screenId: string;
  mediaId: string;
  status: SignageCacheItemStatus;
  sha256: string;
  bytesCached: number;
  bytesTotal: number;
  syncedAt: string | null;
  errorMessage: string | null;
}

export interface SignageScreen {
  id: string;
  workspaceId: string;
  slotNumber: number;
  screenCode: string;
  name: string;
  platform: CastoraPlatform;
  deviceType: DetectedDeviceType;
  deviceId: string | null;
  pairedFromRoomId: string | null;
  claimed: boolean;
  assignedPlaylistId: string | null;
  assignedPlaylistName: string | null;
  playbackCommand: SignagePlaybackCommand;
  playbackState: SignagePlaybackState;
  onlineStatus: 'online' | 'offline';
  currentItemId: string | null;
  currentMediaId: string | null;
  currentMediaName: string | null;
  currentPositionSec: number;
  totalPlaybackSec: number;
  cacheProgressPct: number;
  cachedMediaCount: number;
  totalMediaCount: number;
  cachedBytes: number;
  totalBytes: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSeenAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  cacheItems?: SignageDeviceCacheRecord[];
}

export interface SignageStorageStatus {
  storageProvider: SignageStorageProvider;
  dbProvider: SignageDbProvider;
  persistentObjectStorage: boolean;
  maxFileSizeBytes: number;
  maxScreens: number;
  supportedMimeTypes: string[];
  bucketName: string | null;
  warning: string | null;
}

export interface SupportedMediaSpec {
  mimeType: string;
  mediaKind: SignageMediaKind;
  format: string;
  extensions: string[];
}

export const SUPPORTED_SIGNAGE_MEDIA: SupportedMediaSpec[] = [
  {
    mimeType: 'image/jpeg',
    mediaKind: 'image',
    format: 'JPEG',
    extensions: ['.jpg', '.jpeg'],
  },
  {
    mimeType: 'image/png',
    mediaKind: 'image',
    format: 'PNG',
    extensions: ['.png'],
  },
  {
    mimeType: 'image/webp',
    mediaKind: 'image',
    format: 'WebP',
    extensions: ['.webp'],
  },
  {
    mimeType: 'image/gif',
    mediaKind: 'image',
    format: 'GIF',
    extensions: ['.gif'],
  },
  {
    mimeType: 'video/mp4',
    mediaKind: 'video',
    format: 'MP4',
    extensions: ['.mp4', '.m4v'],
  },
  {
    mimeType: 'video/webm',
    mediaKind: 'video',
    format: 'WebM',
    extensions: ['.webm'],
  },
  {
    mimeType: 'video/quicktime',
    mediaKind: 'video',
    format: 'MOV',
    extensions: ['.mov'],
  },
];

const MIME_BY_EXTENSION = new Map<string, SupportedMediaSpec>();
const SPEC_BY_MIME = new Map<string, SupportedMediaSpec>();

for (const spec of SUPPORTED_SIGNAGE_MEDIA) {
  SPEC_BY_MIME.set(spec.mimeType, spec);
  for (const ext of spec.extensions) {
    MIME_BY_EXTENSION.set(ext, spec);
  }
}

export function sanitizeDisplayName(raw: string, fallback = 'Untitled'): string {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 120);
}

export function resolveSupportedMediaSpec(
  declaredMime: string | undefined,
  filename: string | undefined
): SupportedMediaSpec | null {
  const normalizedMime = (declaredMime ?? '').toLowerCase().split(';')[0].trim();
  const extMatch = (filename ?? '').toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? '';

  if (normalizedMime === 'image/jpg') {
    return SPEC_BY_MIME.get('image/jpeg') ?? null;
  }
  if (normalizedMime && SPEC_BY_MIME.has(normalizedMime)) {
    return SPEC_BY_MIME.get(normalizedMime) ?? null;
  }
  if (extMatch && MIME_BY_EXTENSION.has(extMatch)) {
    return MIME_BY_EXTENSION.get(extMatch) ?? null;
  }
  return null;
}

/**
 * Validates file header magic bytes so spoofed HTML/SVG/executables cannot be uploaded
 * disguised as media assets.
 */
export function detectMediaSignatureFromHeader(header: Buffer): SupportedMediaSpec['mimeType'] | null {
  if (header.length < 4) return null;

  // JPEG: FF D8 FF
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: RIFF....WEBP
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  // GIF: GIF87a / GIF89a
  if (
    header.length >= 6 &&
    (header.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      header.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  // WebM / Matroska EBML header: 1A 45 DF A3
  if (
    header[0] === 0x1a &&
    header[1] === 0x45 &&
    header[2] === 0xdf &&
    header[3] === 0xa3
  ) {
    return 'video/webm';
  }
  // MP4 / MOV ISO Base Media File Format: offset 4 == 'ftyp'
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const majorBrand = header.subarray(8, 12).toString('ascii').toLowerCase();
    if (majorBrand.startsWith('qt')) {
      return 'video/quicktime';
    }
    return 'video/mp4';
  }
  return null;
}

export function isCompatibleMagicSignature(
  declaredSpec: SupportedMediaSpec,
  detectedMime: SupportedMediaSpec['mimeType'] | null
): boolean {
  if (!detectedMime) return false;
  if (declaredSpec.mimeType === detectedMime) return true;
  // MP4 and QuickTime MOV share ISO BMFF ftyp container headers
  if (
    (declaredSpec.mimeType === 'video/mp4' && detectedMime === 'video/quicktime') ||
    (declaredSpec.mimeType === 'video/quicktime' && detectedMime === 'video/mp4')
  ) {
    return true;
  }
  return false;
}
