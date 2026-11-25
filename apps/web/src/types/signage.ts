import type { CastoraPlatform } from './protocol';
import type { DetectedDeviceType } from './studio';

export const MAX_SIGNAGE_SCREENS = 15;

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
  contentPath?: string | null;
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

export interface SignagePlayerManifest {
  screen: SignageScreen;
  playlist: SignagePlaylist | null;
  serverTime: string;
}

export interface SignageWorkspaceCredentials {
  workspaceId: string;
  hostToken: string;
  recoveryCode: string | null;
  storageStatus: SignageStorageStatus;
}

export interface SignageScreenCredentials {
  screenId: string;
  screenCode: string;
  screenToken: string;
}
