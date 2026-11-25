import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { generateRoomCode, generateSessionToken, hashToken, verifyToken } from './security.ts';
import {
  MAX_IMAGE_DURATION_SEC,
  MAX_SIGNAGE_SCREENS,
  MIN_IMAGE_DURATION_SEC,
  SCREEN_ONLINE_TIMEOUT_MS,
  sanitizeDisplayName,
  type SignageCacheItemStatus,
  type SignageDbProvider,
  type SignageDeviceCacheRecord,
  type SignageMediaAsset,
  type SignageMediaKind,
  type SignagePlaybackCommand,
  type SignagePlaybackState,
  type SignagePlaylist,
  type SignagePlaylistItem,
  type SignageScreen,
} from './signageTypes.ts';
import type { CastoraPlatform, DetectedDeviceType } from './types.ts';

export interface WorkspaceAuthResult {
  workspaceId: string;
  hostToken: string;
  recoveryCode: string;
}

export interface CreateMediaInput {
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
  uploadStatus: 'ready' | 'failed';
}

export interface PlaylistItemInput {
  id?: string;
  mediaId: string;
  sortOrder: number;
  imageDurationSec: number;
  repeatCount: number;
  playUntilEnd: boolean;
}

export interface ScreenSyncPayload {
  playbackState: SignagePlaybackState;
  currentItemId: string | null;
  currentMediaId: string | null;
  currentMediaName: string | null;
  currentPositionSec: number;
  totalPlaybackSec: number;
  lastSyncError: string | null;
  cacheItems: Array<{
    mediaId: string;
    status: SignageCacheItemStatus;
    sha256: string;
    bytesCached: number;
    bytesTotal: number;
    errorMessage?: string | null;
  }>;
}

export interface SignageStore {
  readonly dbProvider: SignageDbProvider;
  init(): Promise<void>;
  close(): Promise<void>;

  bootstrapWorkspace(params?: {
    workspaceId?: string;
    existingHostToken?: string;
  }): Promise<WorkspaceAuthResult>;
  recoverWorkspace(params: {
    workspaceId: string;
    recoveryCode: string;
  }): Promise<{ ok: true; workspaceId: string; hostToken: string } | { ok: false; message: string }>;
  verifyHostToken(token: string): Promise<string | null>;

  listMedia(workspaceId: string): Promise<SignageMediaAsset[]>;
  getMediaById(mediaId: string): Promise<SignageMediaAsset | null>;
  createMedia(input: CreateMediaInput): Promise<SignageMediaAsset>;
  updateMedia(params: {
    workspaceId: string;
    mediaId: string;
    displayName?: string;
    durationSec?: number | null;
    width?: number | null;
    height?: number | null;
  }): Promise<SignageMediaAsset | null>;
  deleteMedia(params: {
    workspaceId: string;
    mediaId: string;
  }): Promise<{ deleted: SignageMediaAsset | null; affectedScreenIds: string[] }>;

  listPlaylists(workspaceId: string): Promise<SignagePlaylist[]>;
  getPlaylistById(workspaceId: string, playlistId: string): Promise<SignagePlaylist | null>;
  createPlaylist(params: {
    workspaceId: string;
    name: string;
    description?: string;
    loopPlaylist: boolean;
    items: PlaylistItemInput[];
  }): Promise<SignagePlaylist>;
  updatePlaylist(params: {
    workspaceId: string;
    playlistId: string;
    name?: string;
    description?: string;
    loopPlaylist?: boolean;
    items?: PlaylistItemInput[];
  }): Promise<{ playlist: SignagePlaylist | null; affectedScreenIds: string[] }>;
  deletePlaylist(params: {
    workspaceId: string;
    playlistId: string;
  }): Promise<{ deleted: boolean; affectedScreenIds: string[] }>;

  listScreens(workspaceId: string): Promise<SignageScreen[]>;
  getScreenById(workspaceId: string, screenId: string): Promise<SignageScreen | null>;
  createScreen(params: {
    workspaceId: string;
    name: string;
    platform: CastoraPlatform;
    deviceType: DetectedDeviceType;
    slotNumber?: number;
    deviceId?: string | null;
    pairedFromRoomId?: string | null;
  }): Promise<{ ok: true; screen: SignageScreen } | { ok: false; code: string; message: string }>;
  updateScreen(params: {
    workspaceId: string;
    screenId: string;
    name?: string;
    regenerateCode?: boolean;
  }): Promise<SignageScreen | null>;
  deleteScreen(workspaceId: string, screenId: string): Promise<boolean>;

  assignPlaylistToScreens(params: {
    workspaceId: string;
    screenIds: string[];
    playlistId: string | null;
    autoPlay?: boolean;
  }): Promise<SignageScreen[]>;
  controlScreens(params: {
    workspaceId: string;
    screenIds: string[];
    command: SignagePlaybackCommand;
    jumpToItemId?: string | null;
  }): Promise<SignageScreen[]>;

  claimScreenByCode(params: {
    screenCode: string;
    deviceId?: string;
    deviceName?: string;
    platform?: CastoraPlatform;
    deviceType?: DetectedDeviceType;
    forceReclaim?: boolean;
  }): Promise<
    | { ok: true; screen: SignageScreen; screenToken: string }
    | { ok: false; code: string; message: string }
  >;
  verifyScreenToken(token: string): Promise<SignageScreen | null>;
  getPlayerManifest(screenId: string): Promise<{
    screen: SignageScreen;
    playlist: SignagePlaylist | null;
  } | null>;
  recordPlayerSync(params: {
    screenId: string;
    payload: ScreenSyncPayload;
  }): Promise<SignageScreen | null>;
}

function clampImageDuration(sec: number): number {
  if (!Number.isFinite(sec)) return 10;
  return Math.min(MAX_IMAGE_DURATION_SEC, Math.max(MIN_IMAGE_DURATION_SEC, Math.round(sec)));
}

function clampRepeatCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.min(100, Math.max(1, Math.round(count)));
}

function computeOnlineStatus(lastSeenAt: string | null): 'online' | 'offline' {
  if (!lastSeenAt) return 'offline';
  const ts = Date.parse(lastSeenAt);
  if (!Number.isFinite(ts)) return 'offline';
  return Date.now() - ts <= SCREEN_ONLINE_TIMEOUT_MS ? 'online' : 'offline';
}

function summarizeCacheProgress(
  playlist: SignagePlaylist | null,
  cacheRecords: SignageDeviceCacheRecord[]
): {
  cacheProgressPct: number;
  cachedMediaCount: number;
  totalMediaCount: number;
  cachedBytes: number;
  totalBytes: number;
} {
  if (!playlist || playlist.items.length === 0) {
    return {
      cacheProgressPct: 100,
      cachedMediaCount: 0,
      totalMediaCount: 0,
      cachedBytes: 0,
      totalBytes: 0,
    };
  }

  const uniqueAssets = new Map<string, SignageMediaAsset>();
  for (const item of playlist.items) {
    if (item.media) {
      uniqueAssets.set(item.media.id, item.media);
    }
  }
  const cacheByMediaId = new Map(cacheRecords.map((r) => [r.mediaId, r]));

  let totalBytes = 0;
  let cachedBytes = 0;
  let cachedMediaCount = 0;
  const totalMediaCount = uniqueAssets.size;

  for (const asset of uniqueAssets.values()) {
    totalBytes += asset.sizeBytes;
    const rec = cacheByMediaId.get(asset.id);
    if (rec && rec.sha256 === asset.sha256) {
      if (rec.status === 'cached') {
        cachedMediaCount += 1;
        cachedBytes += asset.sizeBytes;
      } else {
        cachedBytes += Math.min(asset.sizeBytes, Math.max(0, rec.bytesCached));
      }
    }
  }

  const cacheProgressPct =
    totalBytes > 0
      ? Math.min(100, Math.round((cachedBytes / totalBytes) * 100))
      : totalMediaCount > 0
        ? Math.round((cachedMediaCount / totalMediaCount) * 100)
        : 100;

  return {
    cacheProgressPct,
    cachedMediaCount,
    totalMediaCount,
    cachedBytes,
    totalBytes,
  };
}

function chooseTargetSlotNumber(usedSlots: Set<number>, preferredSlotNumber?: number): number {
  if (
    typeof preferredSlotNumber === 'number' &&
    Number.isInteger(preferredSlotNumber) &&
    preferredSlotNumber >= 1 &&
    preferredSlotNumber <= MAX_SIGNAGE_SCREENS &&
    !usedSlots.has(preferredSlotNumber)
  ) {
    return preferredSlotNumber;
  }
  let slotNumber = 1;
  while (usedSlots.has(slotNumber) && slotNumber <= MAX_SIGNAGE_SCREENS) {
    slotNumber += 1;
  }
  return slotNumber;
}

function buildHydratedScreenFromData(params: {
  row: Record<string, unknown>;
  playlist: SignagePlaylist | null;
  cacheItems: SignageDeviceCacheRecord[];
}): SignageScreen {
  const { row, playlist, cacheItems } = params;
  const cacheSummary = summarizeCacheProgress(playlist, cacheItems);
  const lastSeenAt = row.last_seen_at === null ? null : String(row.last_seen_at);
  const onlineStatus = computeOnlineStatus(lastSeenAt);
  const rawPlaybackState = row.playback_state as SignagePlaybackState;
  const playbackState: SignagePlaybackState =
    onlineStatus === 'offline' && rawPlaybackState === 'playing' ? 'offline' : rawPlaybackState;

  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    slotNumber: Number(row.slot_number),
    screenCode: String(row.screen_code),
    name: String(row.name),
    platform: row.platform as CastoraPlatform,
    deviceType: row.device_type as DetectedDeviceType,
    deviceId: row.device_id === null ? null : String(row.device_id),
    pairedFromRoomId:
      row.paired_from_room_id === null ? null : String(row.paired_from_room_id),
    claimed: Boolean(row.token_hash),
    assignedPlaylistId:
      row.assigned_playlist_id === null ? null : String(row.assigned_playlist_id),
    assignedPlaylistName: playlist?.name ?? null,
    playbackCommand: row.playback_command as SignagePlaybackCommand,
    playbackState,
    onlineStatus,
    currentItemId: row.current_item_id === null ? null : String(row.current_item_id),
    currentMediaId: row.current_media_id === null ? null : String(row.current_media_id),
    currentMediaName: row.current_media_name === null ? null : String(row.current_media_name),
    currentPositionSec: Number(row.current_position_sec ?? 0),
    totalPlaybackSec: Number(row.total_playback_sec ?? 0),
    cacheProgressPct: cacheSummary.cacheProgressPct,
    cachedMediaCount: cacheSummary.cachedMediaCount,
    totalMediaCount: cacheSummary.totalMediaCount,
    cachedBytes: cacheSummary.cachedBytes,
    totalBytes: cacheSummary.totalBytes,
    lastSyncAt: row.last_sync_at === null ? null : String(row.last_sync_at),
    lastSyncError: row.last_sync_error === null ? null : String(row.last_sync_error),
    lastSeenAt,
    revision: Number(row.revision ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    cacheItems,
  };
}

class SqliteSignageRepository implements SignageStore {
  readonly dbProvider: SignageDbProvider = 'sqlite';
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('Signage SQLite database not initialized');
    }
    return this.db;
  }

  async init(): Promise<void> {
    if (this.db) return;
    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(this.dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signage_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_workspaces (
        id TEXT PRIMARY KEY,
        host_token_hash TEXT NOT NULL,
        recovery_code_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_media (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        format TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        duration_sec REAL,
        width INTEGER,
        height INTEGER,
        sha256 TEXT NOT NULL,
        storage_provider TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        upload_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_playlists (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        loop_playlist INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_playlist_items (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL REFERENCES signage_playlists(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES signage_media(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        image_duration_sec INTEGER NOT NULL DEFAULT 10,
        repeat_count INTEGER NOT NULL DEFAULT 1,
        play_until_end INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_screens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
        slot_number INTEGER NOT NULL,
        screen_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        device_type TEXT NOT NULL,
        device_id TEXT,
        paired_from_room_id TEXT,
        token_hash TEXT,
        assigned_playlist_id TEXT REFERENCES signage_playlists(id) ON DELETE SET NULL,
        playback_command TEXT NOT NULL DEFAULT 'play',
        playback_state TEXT NOT NULL DEFAULT 'idle',
        current_item_id TEXT,
        current_media_id TEXT,
        current_media_name TEXT,
        current_position_sec REAL NOT NULL DEFAULT 0,
        total_playback_sec REAL NOT NULL DEFAULT 0,
        last_sync_at TEXT,
        last_sync_error TEXT,
        last_seen_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, slot_number)
      );

      CREATE TABLE IF NOT EXISTS signage_device_cache (
        screen_id TEXT NOT NULL REFERENCES signage_screens(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES signage_media(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes_cached INTEGER NOT NULL DEFAULT 0,
        bytes_total INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        error_message TEXT,
        PRIMARY KEY (screen_id, media_id)
      );
    `);

    const now = new Date().toISOString();
    this.db
      .prepare('INSERT OR IGNORE INTO signage_migrations (id, applied_at) VALUES (?, ?)')
      .run('001_initial_signage', now);

    const hasCap15Migration = this.db
      .prepare('SELECT id FROM signage_migrations WHERE id = ?')
      .get('002_capacity_15_and_indexes');

    if (!hasCap15Migration) {
      // Safe migration: if an older SQLite table had a CHECK constraint on slot_number (e.g. <= 7 or <= 12),
      // rebuild signage_screens losslessly preserving every row and foreign key reference.
      const tableMeta = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'signage_screens'")
        .get() as { sql?: string } | undefined;
      if (tableMeta?.sql && /check\s*\(/i.test(tableMeta.sql) && /slot_number/i.test(tableMeta.sql)) {
        this.db.exec('PRAGMA foreign_keys = OFF;');
        this.db.exec('BEGIN IMMEDIATE;');
        try {
          this.db.exec(`
            CREATE TABLE signage_screens_v2 (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
              slot_number INTEGER NOT NULL,
              screen_code TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              platform TEXT NOT NULL,
              device_type TEXT NOT NULL,
              device_id TEXT,
              paired_from_room_id TEXT,
              token_hash TEXT,
              assigned_playlist_id TEXT REFERENCES signage_playlists(id) ON DELETE SET NULL,
              playback_command TEXT NOT NULL DEFAULT 'play',
              playback_state TEXT NOT NULL DEFAULT 'idle',
              current_item_id TEXT,
              current_media_id TEXT,
              current_media_name TEXT,
              current_position_sec REAL NOT NULL DEFAULT 0,
              total_playback_sec REAL NOT NULL DEFAULT 0,
              last_sync_at TEXT,
              last_sync_error TEXT,
              last_seen_at TEXT,
              revision INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(workspace_id, slot_number)
            );
            INSERT INTO signage_screens_v2 (
              id, workspace_id, slot_number, screen_code, name, platform, device_type,
              device_id, paired_from_room_id, token_hash, assigned_playlist_id,
              playback_command, playback_state, current_item_id, current_media_id,
              current_media_name, current_position_sec, total_playback_sec, last_sync_at,
              last_sync_error, last_seen_at, revision, created_at, updated_at
            )
            SELECT
              id, workspace_id, slot_number, screen_code, name, platform, device_type,
              device_id, paired_from_room_id, token_hash, assigned_playlist_id,
              playback_command, playback_state, current_item_id, current_media_id,
              current_media_name, current_position_sec, total_playback_sec, last_sync_at,
              last_sync_error, last_seen_at, revision, created_at, updated_at
            FROM signage_screens;
            DROP TABLE signage_screens;
            ALTER TABLE signage_screens_v2 RENAME TO signage_screens;
          `);
          this.db.exec('COMMIT;');
        } catch (err) {
          this.db.exec('ROLLBACK;');
          this.db.exec('PRAGMA foreign_keys = ON;');
          throw err;
        }
        this.db.exec('PRAGMA foreign_keys = ON;');
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_signage_screens_workspace_slot ON signage_screens(workspace_id, slot_number);
        CREATE INDEX IF NOT EXISTS idx_signage_playlist_items_playlist_sort ON signage_playlist_items(playlist_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_signage_media_workspace_created ON signage_media(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_signage_device_cache_screen ON signage_device_cache(screen_id);
      `);
      this.db
        .prepare('INSERT OR IGNORE INTO signage_migrations (id, applied_at) VALUES (?, ?)')
        .run('002_capacity_15_and_indexes', now);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private mapMediaRow(row: Record<string, unknown>): SignageMediaAsset {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      originalName: String(row.original_name),
      displayName: String(row.display_name),
      mediaKind: row.media_kind as SignageMediaKind,
      mimeType: String(row.mime_type),
      format: String(row.format),
      sizeBytes: Number(row.size_bytes),
      durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      sha256: String(row.sha256),
      storageProvider: row.storage_provider as 's3' | 'local-dev',
      storageKey: String(row.storage_key),
      uploadStatus: row.upload_status as 'uploading' | 'ready' | 'failed',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async bootstrapWorkspace(params?: {
    workspaceId?: string;
    existingHostToken?: string;
  }): Promise<WorkspaceAuthResult> {
    const db = this.getDb();
    if (params?.existingHostToken) {
      const tokenHash = hashToken(params.existingHostToken);
      const found = db
        .prepare('SELECT id FROM signage_workspaces WHERE host_token_hash = ? LIMIT 1')
        .get(tokenHash) as { id: string } | undefined;
      if (found) {
        return {
          workspaceId: found.id,
          hostToken: params.existingHostToken,
          recoveryCode: '',
        };
      }
    }

    const workspaceId =
      params?.workspaceId && /^[A-Za-z0-9_-]{4,48}$/.test(params.workspaceId)
        ? params.workspaceId
        : `ws-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const hostToken = generateSessionToken();
    const recoveryCode = `${generateRoomCode()}-${generateRoomCode()}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO signage_workspaces (id, host_token_hash, recovery_code_hash, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(workspaceId, hashToken(hostToken), hashToken(recoveryCode), now);

    return { workspaceId, hostToken, recoveryCode };
  }

  async recoverWorkspace(params: {
    workspaceId: string;
    recoveryCode: string;
  }): Promise<
    { ok: true; workspaceId: string; hostToken: string } | { ok: false; message: string }
  > {
    const db = this.getDb();
    const row = db
      .prepare('SELECT id, recovery_code_hash FROM signage_workspaces WHERE id = ?')
      .get(params.workspaceId) as { id: string; recovery_code_hash: string } | undefined;
    if (!row || !verifyToken(params.recoveryCode.trim().toUpperCase(), row.recovery_code_hash)) {
      return { ok: false, message: 'Invalid workspace ID or recovery key' };
    }
    const nextToken = generateSessionToken();
    db.prepare('UPDATE signage_workspaces SET host_token_hash = ? WHERE id = ?').run(
      hashToken(nextToken),
      row.id
    );
    return { ok: true, workspaceId: row.id, hostToken: nextToken };
  }

  async verifyHostToken(token: string): Promise<string | null> {
    if (!token) return null;
    const db = this.getDb();
    const tokenHash = hashToken(token);
    const row = db
      .prepare('SELECT id FROM signage_workspaces WHERE host_token_hash = ? LIMIT 1')
      .get(tokenHash) as { id: string } | undefined;
    return row ? row.id : null;
  }

  async listMedia(workspaceId: string): Promise<SignageMediaAsset[]> {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM signage_media WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMediaRow(r));
  }

  async getMediaById(mediaId: string): Promise<SignageMediaAsset | null> {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM signage_media WHERE id = ? LIMIT 1')
      .get(mediaId) as Record<string, unknown> | undefined;
    return row ? this.mapMediaRow(row) : null;
  }

  async createMedia(input: CreateMediaInput): Promise<SignageMediaAsset> {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO signage_media (
        id, workspace_id, original_name, display_name, media_kind, mime_type, format,
        size_bytes, duration_sec, width, height, sha256, storage_provider, storage_key,
        upload_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.workspaceId,
      input.originalName,
      sanitizeDisplayName(input.displayName, input.originalName),
      input.mediaKind,
      input.mimeType,
      input.format,
      input.sizeBytes,
      input.durationSec,
      input.width,
      input.height,
      input.sha256,
      input.storageProvider,
      input.storageKey,
      input.uploadStatus,
      now,
      now
    );
    const created = await this.getMediaById(input.id);
    if (!created) throw new Error('Failed to load created media');
    return created;
  }

  async updateMedia(params: {
    workspaceId: string;
    mediaId: string;
    displayName?: string;
    durationSec?: number | null;
    width?: number | null;
    height?: number | null;
  }): Promise<SignageMediaAsset | null> {
    const db = this.getDb();
    const existing = await this.getMediaById(params.mediaId);
    if (!existing || existing.workspaceId !== params.workspaceId) return null;
    const now = new Date().toISOString();
    const nextName =
      params.displayName !== undefined
        ? sanitizeDisplayName(params.displayName, existing.displayName)
        : existing.displayName;
    const nextDuration =
      params.durationSec !== undefined ? params.durationSec : existing.durationSec;
    const nextWidth = params.width !== undefined ? params.width : existing.width;
    const nextHeight = params.height !== undefined ? params.height : existing.height;

    db.prepare(
      `UPDATE signage_media
       SET display_name = ?, duration_sec = ?, width = ?, height = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    ).run(nextName, nextDuration, nextWidth, nextHeight, now, params.mediaId, params.workspaceId);

    return this.getMediaById(params.mediaId);
  }

  async deleteMedia(params: {
    workspaceId: string;
    mediaId: string;
  }): Promise<{ deleted: SignageMediaAsset | null; affectedScreenIds: string[] }> {
    const db = this.getDb();
    const existing = await this.getMediaById(params.mediaId);
    if (!existing || existing.workspaceId !== params.workspaceId) {
      return { deleted: null, affectedScreenIds: [] };
    }

    const playlistRows = db
      .prepare('SELECT DISTINCT playlist_id FROM signage_playlist_items WHERE media_id = ?')
      .all(params.mediaId) as Array<{ playlist_id: string }>;
    const playlistIds = playlistRows.map((r) => r.playlist_id);

    const affectedScreenIds: string[] = [];
    if (playlistIds.length > 0) {
      const screens = await this.listScreens(params.workspaceId);
      const playlistSet = new Set(playlistIds);
      const now = new Date().toISOString();
      for (const s of screens) {
        if (s.assignedPlaylistId && playlistSet.has(s.assignedPlaylistId)) {
          affectedScreenIds.push(s.id);
          db.prepare('UPDATE signage_screens SET revision = revision + 1, updated_at = ? WHERE id = ?').run(
            now,
            s.id
          );
        }
      }
    }

    db.prepare('DELETE FROM signage_media WHERE id = ? AND workspace_id = ?').run(
      params.mediaId,
      params.workspaceId
    );
    return { deleted: existing, affectedScreenIds };
  }

  private hydratePlaylist(playlistRow: Record<string, unknown>): SignagePlaylist {
    const db = this.getDb();
    const itemRows = db
      .prepare(
        `SELECT i.*,
          m.id as m_id, m.workspace_id as m_workspace_id, m.original_name as m_original_name,
          m.display_name as m_display_name, m.media_kind as m_media_kind, m.mime_type as m_mime_type,
          m.format as m_format, m.size_bytes as m_size_bytes, m.duration_sec as m_duration_sec,
          m.width as m_width, m.height as m_height, m.sha256 as m_sha256,
          m.storage_provider as m_storage_provider, m.storage_key as m_storage_key,
          m.upload_status as m_upload_status, m.created_at as m_created_at, m.updated_at as m_updated_at
         FROM signage_playlist_items i
         JOIN signage_media m ON m.id = i.media_id
         WHERE i.playlist_id = ?
         ORDER BY i.sort_order ASC, i.created_at ASC`
      )
      .all(String(playlistRow.id)) as Array<Record<string, unknown>>;

    const items: SignagePlaylistItem[] = itemRows.map((row) => ({
      id: String(row.id),
      playlistId: String(row.playlist_id),
      mediaId: String(row.media_id),
      sortOrder: Number(row.sort_order),
      imageDurationSec: Number(row.image_duration_sec),
      repeatCount: Number(row.repeat_count),
      playUntilEnd: Boolean(row.play_until_end),
      createdAt: String(row.created_at),
      media: {
        id: String(row.m_id),
        workspaceId: String(row.m_workspace_id),
        originalName: String(row.m_original_name),
        displayName: String(row.m_display_name),
        mediaKind: row.m_media_kind as SignageMediaKind,
        mimeType: String(row.m_mime_type),
        format: String(row.m_format),
        sizeBytes: Number(row.m_size_bytes),
        durationSec: row.m_duration_sec === null ? null : Number(row.m_duration_sec),
        width: row.m_width === null ? null : Number(row.m_width),
        height: row.m_height === null ? null : Number(row.m_height),
        sha256: String(row.m_sha256),
        storageProvider: row.m_storage_provider as 's3' | 'local-dev',
        storageKey: String(row.m_storage_key),
        uploadStatus: row.m_upload_status as 'uploading' | 'ready' | 'failed',
        createdAt: String(row.m_created_at),
        updatedAt: String(row.m_updated_at),
      },
    }));

    return {
      id: String(playlistRow.id),
      workspaceId: String(playlistRow.workspace_id),
      name: String(playlistRow.name),
      description: String(playlistRow.description),
      loopPlaylist: Boolean(playlistRow.loop_playlist),
      items,
      createdAt: String(playlistRow.created_at),
      updatedAt: String(playlistRow.updated_at),
    };
  }

  async listPlaylists(workspaceId: string): Promise<SignagePlaylist[]> {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM signage_playlists WHERE workspace_id = ? ORDER BY updated_at DESC')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydratePlaylist(row));
  }

  async getPlaylistById(workspaceId: string, playlistId: string): Promise<SignagePlaylist | null> {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM signage_playlists WHERE id = ? AND workspace_id = ? LIMIT 1')
      .get(playlistId, workspaceId) as Record<string, unknown> | undefined;
    return row ? this.hydratePlaylist(row) : null;
  }

  private replacePlaylistItems(
    workspaceId: string,
    playlistId: string,
    items: PlaylistItemInput[]
  ): void {
    const db = this.getDb();
    db.prepare('DELETE FROM signage_playlist_items WHERE playlist_id = ?').run(playlistId);
    const now = new Date().toISOString();
    const validMediaRows = db
      .prepare('SELECT id FROM signage_media WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ id: string }>;
    const validMediaSet = new Set(validMediaRows.map((r) => r.id));

    let idx = 0;
    const stmt = db.prepare(
      `INSERT INTO signage_playlist_items (
        id, playlist_id, media_id, sort_order, image_duration_sec, repeat_count, play_until_end, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of items) {
      if (!validMediaSet.has(item.mediaId)) continue;
      const itemId =
        item.id && /^[A-Za-z0-9_-]{6,64}$/.test(item.id)
          ? item.id
          : `pli-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      stmt.run(
        itemId,
        playlistId,
        item.mediaId,
        idx,
        clampImageDuration(item.imageDurationSec),
        clampRepeatCount(item.repeatCount),
        item.playUntilEnd ? 1 : 0,
        now
      );
      idx += 1;
    }
  }

  async createPlaylist(params: {
    workspaceId: string;
    name: string;
    description?: string;
    loopPlaylist: boolean;
    items: PlaylistItemInput[];
  }): Promise<SignagePlaylist> {
    const db = this.getDb();
    const id = `pl-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO signage_playlists (id, workspace_id, name, description, loop_playlist, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.workspaceId,
      sanitizeDisplayName(params.name, 'Untitled Playlist'),
      sanitizeDisplayName(params.description ?? '', '').slice(0, 240),
      params.loopPlaylist ? 1 : 0,
      now,
      now
    );
    this.replacePlaylistItems(params.workspaceId, id, params.items);
    const created = await this.getPlaylistById(params.workspaceId, id);
    if (!created) throw new Error('Failed to load created playlist');
    return created;
  }

  async updatePlaylist(params: {
    workspaceId: string;
    playlistId: string;
    name?: string;
    description?: string;
    loopPlaylist?: boolean;
    items?: PlaylistItemInput[];
  }): Promise<{ playlist: SignagePlaylist | null; affectedScreenIds: string[] }> {
    const db = this.getDb();
    const existing = await this.getPlaylistById(params.workspaceId, params.playlistId);
    if (!existing) return { playlist: null, affectedScreenIds: [] };

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE signage_playlists
       SET name = ?, description = ?, loop_playlist = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    ).run(
      params.name !== undefined
        ? sanitizeDisplayName(params.name, existing.name)
        : existing.name,
      params.description !== undefined
        ? sanitizeDisplayName(params.description, '').slice(0, 240)
        : existing.description,
      params.loopPlaylist !== undefined
        ? params.loopPlaylist
          ? 1
          : 0
        : existing.loopPlaylist
          ? 1
          : 0,
      now,
      params.playlistId,
      params.workspaceId
    );

    if (params.items !== undefined) {
      this.replacePlaylistItems(params.workspaceId, params.playlistId, params.items);
    }

    const screenRows = db
      .prepare('SELECT id FROM signage_screens WHERE workspace_id = ? AND assigned_playlist_id = ?')
      .all(params.workspaceId, params.playlistId) as Array<{ id: string }>;
    const affectedScreenIds = screenRows.map((r) => r.id);
    if (affectedScreenIds.length > 0) {
      db.prepare(
        'UPDATE signage_screens SET revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND assigned_playlist_id = ?'
      ).run(now, params.workspaceId, params.playlistId);
    }

    const updated = await this.getPlaylistById(params.workspaceId, params.playlistId);
    return { playlist: updated, affectedScreenIds };
  }

  async deletePlaylist(params: {
    workspaceId: string;
    playlistId: string;
  }): Promise<{ deleted: boolean; affectedScreenIds: string[] }> {
    const db = this.getDb();
    const existing = await this.getPlaylistById(params.workspaceId, params.playlistId);
    if (!existing) return { deleted: false, affectedScreenIds: [] };

    const now = new Date().toISOString();
    const screenRows = db
      .prepare('SELECT id FROM signage_screens WHERE workspace_id = ? AND assigned_playlist_id = ?')
      .all(params.workspaceId, params.playlistId) as Array<{ id: string }>;
    const affectedScreenIds = screenRows.map((r) => r.id);

    db.prepare(
      `UPDATE signage_screens
       SET assigned_playlist_id = NULL, playback_command = 'stop', playback_state = 'idle',
           current_item_id = NULL, current_media_id = NULL, current_media_name = NULL,
           revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND assigned_playlist_id = ?`
    ).run(now, params.workspaceId, params.playlistId);

    db.prepare('DELETE FROM signage_playlists WHERE id = ? AND workspace_id = ?').run(
      params.playlistId,
      params.workspaceId
    );
    return { deleted: true, affectedScreenIds };
  }

  private mapCacheRows(rows: Array<Record<string, unknown>>): SignageDeviceCacheRecord[] {
    return rows.map((c) => ({
      screenId: String(c.screen_id),
      mediaId: String(c.media_id),
      status: c.status as SignageCacheItemStatus,
      sha256: String(c.sha256),
      bytesCached: Number(c.bytes_cached),
      bytesTotal: Number(c.bytes_total),
      syncedAt: c.synced_at === null ? null : String(c.synced_at),
      errorMessage: c.error_message === null ? null : String(c.error_message),
    }));
  }

  private async hydrateScreen(row: Record<string, unknown>): Promise<SignageScreen> {
    const db = this.getDb();
    const workspaceId = String(row.workspace_id);
    const screenId = String(row.id);
    const assignedPlaylistId =
      row.assigned_playlist_id === null ? null : String(row.assigned_playlist_id);
    const playlist = assignedPlaylistId
      ? await this.getPlaylistById(workspaceId, assignedPlaylistId)
      : null;

    const cacheRows = db
      .prepare('SELECT * FROM signage_device_cache WHERE screen_id = ?')
      .all(screenId) as Array<Record<string, unknown>>;

    return buildHydratedScreenFromData({
      row,
      playlist,
      cacheItems: this.mapCacheRows(cacheRows),
    });
  }

  private async hydrateScreensBatch(
    workspaceId: string,
    rows: Array<Record<string, unknown>>
  ): Promise<SignageScreen[]> {
    if (rows.length === 0) return [];
    const db = this.getDb();
    const playlists = await this.listPlaylists(workspaceId);
    const playlistMap = new Map(playlists.map((p) => [p.id, p]));

    const cacheRows = db
      .prepare(
        `SELECT dc.* FROM signage_device_cache dc
         JOIN signage_screens s ON s.id = dc.screen_id
         WHERE s.workspace_id = ?`
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    const cacheByScreenId = new Map<string, SignageDeviceCacheRecord[]>();
    for (const item of this.mapCacheRows(cacheRows)) {
      const arr = cacheByScreenId.get(item.screenId);
      if (arr) arr.push(item);
      else cacheByScreenId.set(item.screenId, [item]);
    }

    return rows.map((row) => {
      const assignedPlaylistId =
        row.assigned_playlist_id === null ? null : String(row.assigned_playlist_id);
      return buildHydratedScreenFromData({
        row,
        playlist: assignedPlaylistId ? (playlistMap.get(assignedPlaylistId) ?? null) : null,
        cacheItems: cacheByScreenId.get(String(row.id)) ?? [],
      });
    });
  }

  async listScreens(workspaceId: string): Promise<SignageScreen[]> {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM signage_screens WHERE workspace_id = ? ORDER BY slot_number ASC')
      .all(workspaceId) as Array<Record<string, unknown>>;
    return this.hydrateScreensBatch(workspaceId, rows);
  }

  async getScreenById(workspaceId: string, screenId: string): Promise<SignageScreen | null> {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM signage_screens WHERE id = ? AND workspace_id = ? LIMIT 1')
      .get(screenId, workspaceId) as Record<string, unknown> | undefined;
    return row ? this.hydrateScreen(row) : null;
  }

  async createScreen(params: {
    workspaceId: string;
    name: string;
    platform: CastoraPlatform;
    deviceType: DetectedDeviceType;
    slotNumber?: number;
    deviceId?: string | null;
    pairedFromRoomId?: string | null;
  }): Promise<{ ok: true; screen: SignageScreen } | { ok: false; code: string; message: string }> {
    const db = this.getDb();
    const id = `scr-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE;');
    try {
      const existingRows = db
        .prepare('SELECT slot_number FROM signage_screens WHERE workspace_id = ?')
        .all(params.workspaceId) as Array<{ slot_number: number }>;

      if (existingRows.length >= MAX_SIGNAGE_SCREENS) {
        db.exec('ROLLBACK;');
        return {
          ok: false,
          code: 'SIGNAGE_CAPACITY_REACHED',
          message: `Digital Signage supports a maximum of ${MAX_SIGNAGE_SCREENS} registered screens`,
        };
      }

      const usedSlots = new Set(existingRows.map((r) => r.slot_number));
      const slotNumber = chooseTargetSlotNumber(usedSlots, params.slotNumber);

      let screenCode = generateRoomCode();
      for (let i = 0; i < 20; i += 1) {
        const collision = db
          .prepare('SELECT id FROM signage_screens WHERE screen_code = ?')
          .get(screenCode);
        if (!collision) break;
        screenCode = generateRoomCode();
      }

      db.prepare(
        `INSERT INTO signage_screens (
          id, workspace_id, slot_number, screen_code, name, platform, device_type,
          device_id, paired_from_room_id, playback_command, playback_state, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'play', 'idle', 1, ?, ?)`
      ).run(
        id,
        params.workspaceId,
        slotNumber,
        screenCode,
        sanitizeDisplayName(params.name, `TV Screen ${slotNumber}`),
        params.platform,
        params.deviceType,
        params.deviceId ?? null,
        params.pairedFromRoomId ?? null,
        now,
        now
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const screen = await this.getScreenById(params.workspaceId, id);
    if (!screen) throw new Error('Failed to load created screen');
    return { ok: true, screen };
  }

  async updateScreen(params: {
    workspaceId: string;
    screenId: string;
    name?: string;
    regenerateCode?: boolean;
  }): Promise<SignageScreen | null> {
    const db = this.getDb();
    const existing = await this.getScreenById(params.workspaceId, params.screenId);
    if (!existing) return null;

    const now = new Date().toISOString();
    let nextCode = existing.screenCode;
    if (params.regenerateCode) {
      nextCode = generateRoomCode();
      db.prepare('UPDATE signage_screens SET token_hash = NULL WHERE id = ?').run(params.screenId);
    }

    db.prepare(
      `UPDATE signage_screens
       SET name = ?, screen_code = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    ).run(
      params.name !== undefined ? sanitizeDisplayName(params.name, existing.name) : existing.name,
      nextCode,
      now,
      params.screenId,
      params.workspaceId
    );
    return this.getScreenById(params.workspaceId, params.screenId);
  }

  async deleteScreen(workspaceId: string, screenId: string): Promise<boolean> {
    const db = this.getDb();
    const info = db
      .prepare('DELETE FROM signage_screens WHERE id = ? AND workspace_id = ?')
      .run(screenId, workspaceId);
    return info.changes > 0;
  }

  async assignPlaylistToScreens(params: {
    workspaceId: string;
    screenIds: string[];
    playlistId: string | null;
    autoPlay?: boolean;
  }): Promise<SignageScreen[]> {
    const db = this.getDb();
    if (params.playlistId !== null) {
      const pl = await this.getPlaylistById(params.workspaceId, params.playlistId);
      if (!pl) throw new Error('PLAYLIST_NOT_FOUND');
    }

    const now = new Date().toISOString();
    const nextCommand: SignagePlaybackCommand =
      params.playlistId === null ? 'stop' : params.autoPlay === false ? 'pause' : 'play';
    const nextState: SignagePlaybackState = params.playlistId === null ? 'stopped' : 'syncing';

    for (const screenId of params.screenIds) {
      db.prepare(
        `UPDATE signage_screens
         SET assigned_playlist_id = ?, playback_command = ?, playback_state = ?,
             current_item_id = NULL, current_media_id = NULL, current_media_name = NULL,
             current_position_sec = 0, revision = revision + 1, updated_at = ?
         WHERE id = ? AND workspace_id = ?`
      ).run(params.playlistId, nextCommand, nextState, now, screenId, params.workspaceId);
    }

    const screens = await this.listScreens(params.workspaceId);
    const idSet = new Set(params.screenIds);
    return screens.filter((s) => idSet.has(s.id));
  }

  async controlScreens(params: {
    workspaceId: string;
    screenIds: string[];
    command: SignagePlaybackCommand;
    jumpToItemId?: string | null;
  }): Promise<SignageScreen[]> {
    const db = this.getDb();
    const now = new Date().toISOString();
    const nextState: SignagePlaybackState =
      params.command === 'pause'
        ? 'paused'
        : params.command === 'stop'
          ? 'stopped'
          : 'playing';

    for (const screenId of params.screenIds) {
      if (params.command === 'stop') {
        db.prepare(
          `UPDATE signage_screens
           SET playback_command = 'stop', playback_state = 'stopped',
               current_position_sec = 0, revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ?`
        ).run(now, screenId, params.workspaceId);
      } else {
        db.prepare(
          `UPDATE signage_screens
           SET playback_command = ?, playback_state = ?,
               current_item_id = COALESCE(?, current_item_id),
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ?`
        ).run(
          params.command,
          nextState,
          params.jumpToItemId ?? null,
          now,
          screenId,
          params.workspaceId
        );
      }
    }

    const screens = await this.listScreens(params.workspaceId);
    const idSet = new Set(params.screenIds);
    return screens.filter((s) => idSet.has(s.id));
  }

  async claimScreenByCode(params: {
    screenCode: string;
    deviceId?: string;
    deviceName?: string;
    platform?: CastoraPlatform;
    deviceType?: DetectedDeviceType;
    forceReclaim?: boolean;
  }): Promise<
    { ok: true; screen: SignageScreen; screenToken: string } | { ok: false; code: string; message: string }
  > {
    const db = this.getDb();
    const normalizedCode = params.screenCode.trim().toUpperCase();
    const row = db
      .prepare('SELECT * FROM signage_screens WHERE screen_code = ? LIMIT 1')
      .get(normalizedCode) as Record<string, unknown> | undefined;

    if (!row) {
      return {
        ok: false,
        code: 'SCREEN_NOT_FOUND',
        message: 'No signage screen registered with that 6-character code',
      };
    }

    const existingDeviceId = row.device_id ? String(row.device_id) : null;
    if (
      row.token_hash &&
      !params.forceReclaim &&
      existingDeviceId &&
      params.deviceId &&
      existingDeviceId !== params.deviceId
    ) {
      return {
        ok: false,
        code: 'SCREEN_ALREADY_CLAIMED',
        message: 'Screen code is already bound to another TV. Regenerate the code from the host dashboard to re-pair.',
      };
    }

    const screenToken = generateSessionToken();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE signage_screens
       SET token_hash = ?,
           device_id = COALESCE(?, device_id),
           platform = COALESCE(?, platform),
           device_type = COALESCE(?, device_type),
           last_seen_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      hashToken(screenToken),
      params.deviceId ?? null,
      params.platform ?? null,
      params.deviceType ?? null,
      now,
      now,
      String(row.id)
    );

    const screen = await this.getScreenById(String(row.workspace_id), String(row.id));
    if (!screen) throw new Error('Screen not found after claim');
    return { ok: true, screen, screenToken };
  }

  async verifyScreenToken(token: string): Promise<SignageScreen | null> {
    if (!token) return null;
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM signage_screens WHERE token_hash = ? LIMIT 1')
      .get(hashToken(token)) as Record<string, unknown> | undefined;
    return row ? this.hydrateScreen(row) : null;
  }

  async getPlayerManifest(screenId: string): Promise<{
    screen: SignageScreen;
    playlist: SignagePlaylist | null;
  } | null> {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM signage_screens WHERE id = ? LIMIT 1')
      .get(screenId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const now = new Date().toISOString();
    db.prepare('UPDATE signage_screens SET last_seen_at = ? WHERE id = ?').run(now, screenId);

    const updatedRow = db
      .prepare('SELECT * FROM signage_screens WHERE id = ? LIMIT 1')
      .get(screenId) as Record<string, unknown>;
    const screen = await this.hydrateScreen(updatedRow);
    const playlist = screen.assignedPlaylistId
      ? await this.getPlaylistById(screen.workspaceId, screen.assignedPlaylistId)
      : null;

    return { screen, playlist };
  }

  async recordPlayerSync(params: {
    screenId: string;
    payload: ScreenSyncPayload;
  }): Promise<SignageScreen | null> {
    const db = this.getDb();
    const existingRow = db
      .prepare('SELECT * FROM signage_screens WHERE id = ? LIMIT 1')
      .get(params.screenId) as Record<string, unknown> | undefined;
    if (!existingRow) return null;

    const now = new Date().toISOString();
    const workspaceId = String(existingRow.workspace_id);

    const upsertCache = db.prepare(
      `INSERT INTO signage_device_cache (
         screen_id, media_id, status, sha256, bytes_cached, bytes_total, synced_at, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(screen_id, media_id) DO UPDATE SET
         status = excluded.status,
         sha256 = excluded.sha256,
         bytes_cached = excluded.bytes_cached,
         bytes_total = excluded.bytes_total,
         synced_at = excluded.synced_at,
         error_message = excluded.error_message`
    );

    const validMedia = new Set(
      (
        db
          .prepare('SELECT id FROM signage_media WHERE workspace_id = ?')
          .all(workspaceId) as Array<{ id: string }>
      ).map((m) => m.id)
    );

    db.exec('BEGIN;');
    try {
      for (const item of params.payload.cacheItems) {
        if (!validMedia.has(item.mediaId)) continue;
        upsertCache.run(
          params.screenId,
          item.mediaId,
          item.status,
          item.sha256,
          Math.max(0, Math.round(item.bytesCached)),
          Math.max(0, Math.round(item.bytesTotal)),
          item.status === 'cached' ? now : null,
          item.errorMessage ?? null
        );
      }

      db.prepare(
        `UPDATE signage_screens
         SET playback_state = ?,
             current_item_id = ?,
             current_media_id = ?,
             current_media_name = ?,
             current_position_sec = ?,
             total_playback_sec = ?,
             last_sync_at = ?,
             last_sync_error = ?,
             last_seen_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        params.payload.playbackState,
        params.payload.currentItemId,
        params.payload.currentMediaId,
        params.payload.currentMediaName,
        Math.max(0, params.payload.currentPositionSec),
        Math.max(0, params.payload.totalPlaybackSec),
        now,
        params.payload.lastSyncError,
        now,
        now,
        params.screenId
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    return this.getScreenById(workspaceId, params.screenId);
  }
}

class PostgresSignageRepository implements SignageStore {
  readonly dbProvider: SignageDbProvider = 'postgres';
  private readonly pool: Pool;
  private initialized = false;

  constructor(connectionString: string) {
    const envMax = Number(process.env.CASTORA_PG_POOL_MAX);
    const poolMax = Number.isFinite(envMax) && envMax >= 10 ? Math.min(100, Math.floor(envMax)) : 20;
    this.pool = new Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    this.pool.on('error', (err) => {
      console.error('[signage-pg] Idle client error:', err.message);
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS signage_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_workspaces (
        id TEXT PRIMARY KEY,
        host_token_hash TEXT NOT NULL,
        recovery_code_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_media (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        format TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        duration_sec DOUBLE PRECISION,
        width INTEGER,
        height INTEGER,
        sha256 TEXT NOT NULL,
        storage_provider TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        upload_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_playlists (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        loop_playlist BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_playlist_items (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL REFERENCES signage_playlists(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES signage_media(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        image_duration_sec INTEGER NOT NULL DEFAULT 10,
        repeat_count INTEGER NOT NULL DEFAULT 1,
        play_until_end BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signage_screens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
        slot_number INTEGER NOT NULL,
        screen_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        device_type TEXT NOT NULL,
        device_id TEXT,
        paired_from_room_id TEXT,
        token_hash TEXT,
        assigned_playlist_id TEXT REFERENCES signage_playlists(id) ON DELETE SET NULL,
        playback_command TEXT NOT NULL DEFAULT 'play',
        playback_state TEXT NOT NULL DEFAULT 'idle',
        current_item_id TEXT,
        current_media_id TEXT,
        current_media_name TEXT,
        current_position_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
        total_playback_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
        last_sync_at TEXT,
        last_sync_error TEXT,
        last_seen_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, slot_number)
      );

      CREATE TABLE IF NOT EXISTS signage_device_cache (
        screen_id TEXT NOT NULL REFERENCES signage_screens(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES signage_media(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes_cached BIGINT NOT NULL DEFAULT 0,
        bytes_total BIGINT NOT NULL DEFAULT 0,
        synced_at TEXT,
        error_message TEXT,
        PRIMARY KEY (screen_id, media_id)
      );
    `);

    const now = new Date().toISOString();
    await this.pool.query(
      'INSERT INTO signage_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      ['001_initial_signage', now]
    );

    const migRes = await this.pool.query(
      'SELECT id FROM signage_migrations WHERE id = $1 LIMIT 1',
      ['002_capacity_15_and_indexes']
    );
    if (migRes.rows.length === 0) {
      // Safely drop any legacy CHECK constraint limiting slot_number to 7 or 12 while preserving all existing rows.
      const checkConstraints = await this.pool.query(
        `SELECT conname
         FROM pg_constraint
         WHERE conrelid = 'signage_screens'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%slot_number%'`
      );
      for (const row of checkConstraints.rows) {
        const name = String(row.conname).replace(/"/g, '""');
        await this.pool.query(`ALTER TABLE signage_screens DROP CONSTRAINT IF EXISTS "${name}"`);
      }

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_signage_screens_workspace_slot ON signage_screens(workspace_id, slot_number);
        CREATE INDEX IF NOT EXISTS idx_signage_playlist_items_playlist_sort ON signage_playlist_items(playlist_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_signage_media_workspace_created ON signage_media(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_signage_device_cache_screen ON signage_device_cache(screen_id);
      `);
      await this.pool.query(
        'INSERT INTO signage_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        ['002_capacity_15_and_indexes', now]
      );
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapMediaRow(row: Record<string, unknown>): SignageMediaAsset {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      originalName: String(row.original_name),
      displayName: String(row.display_name),
      mediaKind: row.media_kind as SignageMediaKind,
      mimeType: String(row.mime_type),
      format: String(row.format),
      sizeBytes: Number(row.size_bytes),
      durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      sha256: String(row.sha256),
      storageProvider: row.storage_provider as 's3' | 'local-dev',
      storageKey: String(row.storage_key),
      uploadStatus: row.upload_status as 'uploading' | 'ready' | 'failed',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async bootstrapWorkspace(params?: {
    workspaceId?: string;
    existingHostToken?: string;
  }): Promise<WorkspaceAuthResult> {
    if (params?.existingHostToken) {
      const res = await this.pool.query(
        'SELECT id FROM signage_workspaces WHERE host_token_hash = $1 LIMIT 1',
        [hashToken(params.existingHostToken)]
      );
      if (res.rows[0]) {
        return {
          workspaceId: String(res.rows[0].id),
          hostToken: params.existingHostToken,
          recoveryCode: '',
        };
      }
    }

    const workspaceId =
      params?.workspaceId && /^[A-Za-z0-9_-]{4,48}$/.test(params.workspaceId)
        ? params.workspaceId
        : `ws-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const hostToken = generateSessionToken();
    const recoveryCode = `${generateRoomCode()}-${generateRoomCode()}`;
    const now = new Date().toISOString();

    await this.pool.query(
      'INSERT INTO signage_workspaces (id, host_token_hash, recovery_code_hash, created_at) VALUES ($1, $2, $3, $4)',
      [workspaceId, hashToken(hostToken), hashToken(recoveryCode), now]
    );

    return { workspaceId, hostToken, recoveryCode };
  }

  async recoverWorkspace(params: {
    workspaceId: string;
    recoveryCode: string;
  }): Promise<
    { ok: true; workspaceId: string; hostToken: string } | { ok: false; message: string }
  > {
    const res = await this.pool.query(
      'SELECT id, recovery_code_hash FROM signage_workspaces WHERE id = $1',
      [params.workspaceId]
    );
    const row = res.rows[0] as { id: string; recovery_code_hash: string } | undefined;
    if (!row || !verifyToken(params.recoveryCode.trim().toUpperCase(), row.recovery_code_hash)) {
      return { ok: false, message: 'Invalid workspace ID or recovery key' };
    }
    const nextToken = generateSessionToken();
    await this.pool.query('UPDATE signage_workspaces SET host_token_hash = $1 WHERE id = $2', [
      hashToken(nextToken),
      row.id,
    ]);
    return { ok: true, workspaceId: row.id, hostToken: nextToken };
  }

  async verifyHostToken(token: string): Promise<string | null> {
    if (!token) return null;
    const res = await this.pool.query(
      'SELECT id FROM signage_workspaces WHERE host_token_hash = $1 LIMIT 1',
      [hashToken(token)]
    );
    return res.rows[0] ? String(res.rows[0].id) : null;
  }

  async listMedia(workspaceId: string): Promise<SignageMediaAsset[]> {
    const res = await this.pool.query(
      'SELECT * FROM signage_media WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return res.rows.map((r) => this.mapMediaRow(r));
  }

  async getMediaById(mediaId: string): Promise<SignageMediaAsset | null> {
    const res = await this.pool.query('SELECT * FROM signage_media WHERE id = $1 LIMIT 1', [
      mediaId,
    ]);
    return res.rows[0] ? this.mapMediaRow(res.rows[0]) : null;
  }

  async createMedia(input: CreateMediaInput): Promise<SignageMediaAsset> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO signage_media (
        id, workspace_id, original_name, display_name, media_kind, mime_type, format,
        size_bytes, duration_sec, width, height, sha256, storage_provider, storage_key,
        upload_status, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        input.id,
        input.workspaceId,
        input.originalName,
        sanitizeDisplayName(input.displayName, input.originalName),
        input.mediaKind,
        input.mimeType,
        input.format,
        input.sizeBytes,
        input.durationSec,
        input.width,
        input.height,
        input.sha256,
        input.storageProvider,
        input.storageKey,
        input.uploadStatus,
        now,
        now,
      ]
    );
    const created = await this.getMediaById(input.id);
    if (!created) throw new Error('Failed to load created media');
    return created;
  }

  async updateMedia(params: {
    workspaceId: string;
    mediaId: string;
    displayName?: string;
    durationSec?: number | null;
    width?: number | null;
    height?: number | null;
  }): Promise<SignageMediaAsset | null> {
    const existing = await this.getMediaById(params.mediaId);
    if (!existing || existing.workspaceId !== params.workspaceId) return null;
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE signage_media
       SET display_name = $1, duration_sec = $2, width = $3, height = $4, updated_at = $5
       WHERE id = $6 AND workspace_id = $7`,
      [
        params.displayName !== undefined
          ? sanitizeDisplayName(params.displayName, existing.displayName)
          : existing.displayName,
        params.durationSec !== undefined ? params.durationSec : existing.durationSec,
        params.width !== undefined ? params.width : existing.width,
        params.height !== undefined ? params.height : existing.height,
        now,
        params.mediaId,
        params.workspaceId,
      ]
    );
    return this.getMediaById(params.mediaId);
  }

  async deleteMedia(params: {
    workspaceId: string;
    mediaId: string;
  }): Promise<{ deleted: SignageMediaAsset | null; affectedScreenIds: string[] }> {
    const existing = await this.getMediaById(params.mediaId);
    if (!existing || existing.workspaceId !== params.workspaceId) {
      return { deleted: null, affectedScreenIds: [] };
    }
    const screenRows = await this.pool.query(
      `SELECT DISTINCT s.id
       FROM signage_screens s
       JOIN signage_playlist_items i ON i.playlist_id = s.assigned_playlist_id
       WHERE s.workspace_id = $1 AND i.media_id = $2`,
      [params.workspaceId, params.mediaId]
    );
    const affectedScreenIds = screenRows.rows.map((r) => String(r.id));
    if (affectedScreenIds.length > 0) {
      await this.pool.query(
        'UPDATE signage_screens SET revision = revision + 1, updated_at = $1 WHERE id = ANY($2::text[])',
        [new Date().toISOString(), affectedScreenIds]
      );
    }
    await this.pool.query('DELETE FROM signage_media WHERE id = $1 AND workspace_id = $2', [
      params.mediaId,
      params.workspaceId,
    ]);
    return { deleted: existing, affectedScreenIds };
  }

  private async hydratePlaylist(row: Record<string, unknown>): Promise<SignagePlaylist> {
    const itemRes = await this.pool.query(
      `SELECT i.*,
        m.id as m_id, m.workspace_id as m_workspace_id, m.original_name as m_original_name,
        m.display_name as m_display_name, m.media_kind as m_media_kind, m.mime_type as m_mime_type,
        m.format as m_format, m.size_bytes as m_size_bytes, m.duration_sec as m_duration_sec,
        m.width as m_width, m.height as m_height, m.sha256 as m_sha256,
        m.storage_provider as m_storage_provider, m.storage_key as m_storage_key,
        m.upload_status as m_upload_status, m.created_at as m_created_at, m.updated_at as m_updated_at
       FROM signage_playlist_items i
       JOIN signage_media m ON m.id = i.media_id
       WHERE i.playlist_id = $1
       ORDER BY i.sort_order ASC, i.created_at ASC`,
      [String(row.id)]
    );

    const items: SignagePlaylistItem[] = itemRes.rows.map((r) => ({
      id: String(r.id),
      playlistId: String(r.playlist_id),
      mediaId: String(r.media_id),
      sortOrder: Number(r.sort_order),
      imageDurationSec: Number(r.image_duration_sec),
      repeatCount: Number(r.repeat_count),
      playUntilEnd: Boolean(r.play_until_end),
      createdAt: String(r.created_at),
      media: {
        id: String(r.m_id),
        workspaceId: String(r.m_workspace_id),
        originalName: String(r.m_original_name),
        displayName: String(r.m_display_name),
        mediaKind: r.m_media_kind as SignageMediaKind,
        mimeType: String(r.m_mime_type),
        format: String(r.m_format),
        sizeBytes: Number(r.m_size_bytes),
        durationSec: r.m_duration_sec === null ? null : Number(r.m_duration_sec),
        width: r.m_width === null ? null : Number(r.m_width),
        height: r.m_height === null ? null : Number(r.m_height),
        sha256: String(r.m_sha256),
        storageProvider: r.m_storage_provider as 's3' | 'local-dev',
        storageKey: String(r.m_storage_key),
        uploadStatus: r.m_upload_status as 'uploading' | 'ready' | 'failed',
        createdAt: String(r.m_created_at),
        updatedAt: String(r.m_updated_at),
      },
    }));

    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      description: String(row.description),
      loopPlaylist: Boolean(row.loop_playlist),
      items,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async listPlaylists(workspaceId: string): Promise<SignagePlaylist[]> {
    const res = await this.pool.query(
      'SELECT * FROM signage_playlists WHERE workspace_id = $1 ORDER BY updated_at DESC',
      [workspaceId]
    );
    const out: SignagePlaylist[] = [];
    for (const row of res.rows) {
      out.push(await this.hydratePlaylist(row));
    }
    return out;
  }

  async getPlaylistById(workspaceId: string, playlistId: string): Promise<SignagePlaylist | null> {
    const res = await this.pool.query(
      'SELECT * FROM signage_playlists WHERE id = $1 AND workspace_id = $2 LIMIT 1',
      [playlistId, workspaceId]
    );
    return res.rows[0] ? this.hydratePlaylist(res.rows[0]) : null;
  }

  private async replacePlaylistItems(
    workspaceId: string,
    playlistId: string,
    items: PlaylistItemInput[]
  ): Promise<void> {
    await this.pool.query('DELETE FROM signage_playlist_items WHERE playlist_id = $1', [
      playlistId,
    ]);
    const mediaRes = await this.pool.query(
      'SELECT id FROM signage_media WHERE workspace_id = $1',
      [workspaceId]
    );
    const validMediaSet = new Set(mediaRes.rows.map((r) => String(r.id)));
    const now = new Date().toISOString();
    let idx = 0;
    for (const item of items) {
      if (!validMediaSet.has(item.mediaId)) continue;
      const itemId =
        item.id && /^[A-Za-z0-9_-]{6,64}$/.test(item.id)
          ? item.id
          : `pli-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await this.pool.query(
        `INSERT INTO signage_playlist_items (
          id, playlist_id, media_id, sort_order, image_duration_sec, repeat_count, play_until_end, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          itemId,
          playlistId,
          item.mediaId,
          idx,
          clampImageDuration(item.imageDurationSec),
          clampRepeatCount(item.repeatCount),
          item.playUntilEnd,
          now,
        ]
      );
      idx += 1;
    }
  }

  async createPlaylist(params: {
    workspaceId: string;
    name: string;
    description?: string;
    loopPlaylist: boolean;
    items: PlaylistItemInput[];
  }): Promise<SignagePlaylist> {
    const id = `pl-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO signage_playlists (id, workspace_id, name, description, loop_playlist, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        params.workspaceId,
        sanitizeDisplayName(params.name, 'Untitled Playlist'),
        sanitizeDisplayName(params.description ?? '', '').slice(0, 240),
        params.loopPlaylist,
        now,
        now,
      ]
    );
    await this.replacePlaylistItems(params.workspaceId, id, params.items);
    const created = await this.getPlaylistById(params.workspaceId, id);
    if (!created) throw new Error('Failed to load created playlist');
    return created;
  }

  async updatePlaylist(params: {
    workspaceId: string;
    playlistId: string;
    name?: string;
    description?: string;
    loopPlaylist?: boolean;
    items?: PlaylistItemInput[];
  }): Promise<{ playlist: SignagePlaylist | null; affectedScreenIds: string[] }> {
    const existing = await this.getPlaylistById(params.workspaceId, params.playlistId);
    if (!existing) return { playlist: null, affectedScreenIds: [] };
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE signage_playlists
       SET name = $1, description = $2, loop_playlist = $3, updated_at = $4
       WHERE id = $5 AND workspace_id = $6`,
      [
        params.name !== undefined
          ? sanitizeDisplayName(params.name, existing.name)
          : existing.name,
        params.description !== undefined
          ? sanitizeDisplayName(params.description, '').slice(0, 240)
          : existing.description,
        params.loopPlaylist !== undefined ? params.loopPlaylist : existing.loopPlaylist,
        now,
        params.playlistId,
        params.workspaceId,
      ]
    );

    if (params.items !== undefined) {
      await this.replacePlaylistItems(params.workspaceId, params.playlistId, params.items);
    }

    const screenRows = await this.pool.query(
      'SELECT id FROM signage_screens WHERE workspace_id = $1 AND assigned_playlist_id = $2',
      [params.workspaceId, params.playlistId]
    );
    const affectedScreenIds = screenRows.rows.map((r) => String(r.id));
    if (affectedScreenIds.length > 0) {
      await this.pool.query(
        'UPDATE signage_screens SET revision = revision + 1, updated_at = $1 WHERE workspace_id = $2 AND assigned_playlist_id = $3',
        [now, params.workspaceId, params.playlistId]
      );
    }
    const updated = await this.getPlaylistById(params.workspaceId, params.playlistId);
    return { playlist: updated, affectedScreenIds };
  }

  async deletePlaylist(params: {
    workspaceId: string;
    playlistId: string;
  }): Promise<{ deleted: boolean; affectedScreenIds: string[] }> {
    const existing = await this.getPlaylistById(params.workspaceId, params.playlistId);
    if (!existing) return { deleted: false, affectedScreenIds: [] };

    const now = new Date().toISOString();
    const screenRows = await this.pool.query(
      'SELECT id FROM signage_screens WHERE workspace_id = $1 AND assigned_playlist_id = $2',
      [params.workspaceId, params.playlistId]
    );
    const affectedScreenIds = screenRows.rows.map((r) => String(r.id));

    await this.pool.query(
      `UPDATE signage_screens
       SET assigned_playlist_id = NULL, playback_command = 'stop', playback_state = 'idle',
           current_item_id = NULL, current_media_id = NULL, current_media_name = NULL,
           revision = revision + 1, updated_at = $1
       WHERE workspace_id = $2 AND assigned_playlist_id = $3`,
      [now, params.workspaceId, params.playlistId]
    );
    await this.pool.query('DELETE FROM signage_playlists WHERE id = $1 AND workspace_id = $2', [
      params.playlistId,
      params.workspaceId,
    ]);
    return { deleted: true, affectedScreenIds };
  }

  private mapCacheRows(rows: Array<Record<string, unknown>>): SignageDeviceCacheRecord[] {
    return rows.map((c) => ({
      screenId: String(c.screen_id),
      mediaId: String(c.media_id),
      status: c.status as SignageCacheItemStatus,
      sha256: String(c.sha256),
      bytesCached: Number(c.bytes_cached),
      bytesTotal: Number(c.bytes_total),
      syncedAt: c.synced_at === null ? null : String(c.synced_at),
      errorMessage: c.error_message === null ? null : String(c.error_message),
    }));
  }

  private async hydrateScreen(row: Record<string, unknown>): Promise<SignageScreen> {
    const workspaceId = String(row.workspace_id);
    const screenId = String(row.id);
    const assignedPlaylistId =
      row.assigned_playlist_id === null ? null : String(row.assigned_playlist_id);
    const playlist = assignedPlaylistId
      ? await this.getPlaylistById(workspaceId, assignedPlaylistId)
      : null;

    const cacheRes = await this.pool.query(
      'SELECT * FROM signage_device_cache WHERE screen_id = $1',
      [screenId]
    );
    return buildHydratedScreenFromData({
      row,
      playlist,
      cacheItems: this.mapCacheRows(cacheRes.rows),
    });
  }

  private async hydrateScreensBatch(
    workspaceId: string,
    rows: Array<Record<string, unknown>>
  ): Promise<SignageScreen[]> {
    if (rows.length === 0) return [];
    const playlists = await this.listPlaylists(workspaceId);
    const playlistMap = new Map(playlists.map((p) => [p.id, p]));

    const cacheRes = await this.pool.query(
      `SELECT dc.* FROM signage_device_cache dc
       JOIN signage_screens s ON s.id = dc.screen_id
       WHERE s.workspace_id = $1`,
      [workspaceId]
    );
    const cacheByScreenId = new Map<string, SignageDeviceCacheRecord[]>();
    for (const item of this.mapCacheRows(cacheRes.rows)) {
      const arr = cacheByScreenId.get(item.screenId);
      if (arr) arr.push(item);
      else cacheByScreenId.set(item.screenId, [item]);
    }

    return rows.map((row) => {
      const assignedPlaylistId =
        row.assigned_playlist_id === null ? null : String(row.assigned_playlist_id);
      return buildHydratedScreenFromData({
        row,
        playlist: assignedPlaylistId ? (playlistMap.get(assignedPlaylistId) ?? null) : null,
        cacheItems: cacheByScreenId.get(String(row.id)) ?? [],
      });
    });
  }

  async listScreens(workspaceId: string): Promise<SignageScreen[]> {
    const res = await this.pool.query(
      'SELECT * FROM signage_screens WHERE workspace_id = $1 ORDER BY slot_number ASC',
      [workspaceId]
    );
    return this.hydrateScreensBatch(workspaceId, res.rows);
  }

  async getScreenById(workspaceId: string, screenId: string): Promise<SignageScreen | null> {
    const res = await this.pool.query(
      'SELECT * FROM signage_screens WHERE id = $1 AND workspace_id = $2 LIMIT 1',
      [screenId, workspaceId]
    );
    return res.rows[0] ? this.hydrateScreen(res.rows[0]) : null;
  }

  async createScreen(params: {
    workspaceId: string;
    name: string;
    platform: CastoraPlatform;
    deviceType: DetectedDeviceType;
    slotNumber?: number;
    deviceId?: string | null;
    pairedFromRoomId?: string | null;
  }): Promise<{ ok: true; screen: SignageScreen } | { ok: false; code: string; message: string }> {
    const id = `scr-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [params.workspaceId]);

      const existingRes = await client.query(
        'SELECT slot_number FROM signage_screens WHERE workspace_id = $1',
        [params.workspaceId]
      );
      if (existingRes.rows.length >= MAX_SIGNAGE_SCREENS) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          code: 'SIGNAGE_CAPACITY_REACHED',
          message: `Digital Signage supports a maximum of ${MAX_SIGNAGE_SCREENS} registered screens`,
        };
      }

      const usedSlots = new Set(existingRes.rows.map((r) => Number(r.slot_number)));
      const slotNumber = chooseTargetSlotNumber(usedSlots, params.slotNumber);

      let screenCode = generateRoomCode();
      for (let i = 0; i < 20; i += 1) {
        const col = await client.query('SELECT id FROM signage_screens WHERE screen_code = $1', [
          screenCode,
        ]);
        if (col.rows.length === 0) break;
        screenCode = generateRoomCode();
      }

      await client.query(
        `INSERT INTO signage_screens (
          id, workspace_id, slot_number, screen_code, name, platform, device_type,
          device_id, paired_from_room_id, playback_command, playback_state, revision, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'play','idle',1,$10,$11)`,
        [
          id,
          params.workspaceId,
          slotNumber,
          screenCode,
          sanitizeDisplayName(params.name, `TV Screen ${slotNumber}`),
          params.platform,
          params.deviceType,
          params.deviceId ?? null,
          params.pairedFromRoomId ?? null,
          now,
          now,
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const screen = await this.getScreenById(params.workspaceId, id);
    if (!screen) throw new Error('Failed to load created screen');
    return { ok: true, screen };
  }

  async updateScreen(params: {
    workspaceId: string;
    screenId: string;
    name?: string;
    regenerateCode?: boolean;
  }): Promise<SignageScreen | null> {
    const existing = await this.getScreenById(params.workspaceId, params.screenId);
    if (!existing) return null;

    const now = new Date().toISOString();
    let nextCode = existing.screenCode;
    if (params.regenerateCode) {
      nextCode = generateRoomCode();
      await this.pool.query('UPDATE signage_screens SET token_hash = NULL WHERE id = $1', [
        params.screenId,
      ]);
    }
    await this.pool.query(
      'UPDATE signage_screens SET name = $1, screen_code = $2, updated_at = $3 WHERE id = $4 AND workspace_id = $5',
      [
        params.name !== undefined ? sanitizeDisplayName(params.name, existing.name) : existing.name,
        nextCode,
        now,
        params.screenId,
        params.workspaceId,
      ]
    );
    return this.getScreenById(params.workspaceId, params.screenId);
  }

  async deleteScreen(workspaceId: string, screenId: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM signage_screens WHERE id = $1 AND workspace_id = $2',
      [screenId, workspaceId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async assignPlaylistToScreens(params: {
    workspaceId: string;
    screenIds: string[];
    playlistId: string | null;
    autoPlay?: boolean;
  }): Promise<SignageScreen[]> {
    if (params.playlistId !== null) {
      const pl = await this.getPlaylistById(params.workspaceId, params.playlistId);
      if (!pl) throw new Error('PLAYLIST_NOT_FOUND');
    }
    const now = new Date().toISOString();
    const nextCommand: SignagePlaybackCommand =
      params.playlistId === null ? 'stop' : params.autoPlay === false ? 'pause' : 'play';
    const nextState: SignagePlaybackState = params.playlistId === null ? 'stopped' : 'syncing';

    await this.pool.query(
      `UPDATE signage_screens
       SET assigned_playlist_id = $1, playback_command = $2, playback_state = $3,
           current_item_id = NULL, current_media_id = NULL, current_media_name = NULL,
           current_position_sec = 0, revision = revision + 1, updated_at = $4
       WHERE id = ANY($5::text[]) AND workspace_id = $6`,
      [params.playlistId, nextCommand, nextState, now, params.screenIds, params.workspaceId]
    );
    const screens = await this.listScreens(params.workspaceId);
    const idSet = new Set(params.screenIds);
    return screens.filter((s) => idSet.has(s.id));
  }

  async controlScreens(params: {
    workspaceId: string;
    screenIds: string[];
    command: SignagePlaybackCommand;
    jumpToItemId?: string | null;
  }): Promise<SignageScreen[]> {
    const now = new Date().toISOString();
    const nextState: SignagePlaybackState =
      params.command === 'pause'
        ? 'paused'
        : params.command === 'stop'
          ? 'stopped'
          : 'playing';

    if (params.command === 'stop') {
      await this.pool.query(
        `UPDATE signage_screens
         SET playback_command = 'stop', playback_state = 'stopped',
             current_position_sec = 0, revision = revision + 1, updated_at = $1
         WHERE id = ANY($2::text[]) AND workspace_id = $3`,
        [now, params.screenIds, params.workspaceId]
      );
    } else {
      await this.pool.query(
        `UPDATE signage_screens
         SET playback_command = $1, playback_state = $2,
             current_item_id = COALESCE($3, current_item_id),
             revision = revision + 1, updated_at = $4
         WHERE id = ANY($5::text[]) AND workspace_id = $6`,
        [
          params.command,
          nextState,
          params.jumpToItemId ?? null,
          now,
          params.screenIds,
          params.workspaceId,
        ]
      );
    }
    const screens = await this.listScreens(params.workspaceId);
    const idSet = new Set(params.screenIds);
    return screens.filter((s) => idSet.has(s.id));
  }

  async claimScreenByCode(params: {
    screenCode: string;
    deviceId?: string;
    deviceName?: string;
    platform?: CastoraPlatform;
    deviceType?: DetectedDeviceType;
    forceReclaim?: boolean;
  }): Promise<
    { ok: true; screen: SignageScreen; screenToken: string } | { ok: false; code: string; message: string }
  > {
    const normalizedCode = params.screenCode.trim().toUpperCase();
    const res = await this.pool.query(
      'SELECT * FROM signage_screens WHERE screen_code = $1 LIMIT 1',
      [normalizedCode]
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return {
        ok: false,
        code: 'SCREEN_NOT_FOUND',
        message: 'No signage screen registered with that 6-character code',
      };
    }

    const existingDeviceId = row.device_id ? String(row.device_id) : null;
    if (
      row.token_hash &&
      !params.forceReclaim &&
      existingDeviceId &&
      params.deviceId &&
      existingDeviceId !== params.deviceId
    ) {
      return {
        ok: false,
        code: 'SCREEN_ALREADY_CLAIMED',
        message: 'Screen code is already bound to another TV. Regenerate the code from the host dashboard to re-pair.',
      };
    }

    const screenToken = generateSessionToken();
    const now = new Date().toISOString();
    await this.pool.query(
      `UPDATE signage_screens
       SET token_hash = $1,
           device_id = COALESCE($2, device_id),
           platform = COALESCE($3, platform),
           device_type = COALESCE($4, device_type),
           last_seen_at = $5,
           updated_at = $6
       WHERE id = $7`,
      [
        hashToken(screenToken),
        params.deviceId ?? null,
        params.platform ?? null,
        params.deviceType ?? null,
        now,
        now,
        String(row.id),
      ]
    );
    const screen = await this.getScreenById(String(row.workspace_id), String(row.id));
    if (!screen) throw new Error('Screen not found after claim');
    return { ok: true, screen, screenToken };
  }

  async verifyScreenToken(token: string): Promise<SignageScreen | null> {
    if (!token) return null;
    const res = await this.pool.query(
      'SELECT * FROM signage_screens WHERE token_hash = $1 LIMIT 1',
      [hashToken(token)]
    );
    return res.rows[0] ? this.hydrateScreen(res.rows[0]) : null;
  }

  async getPlayerManifest(screenId: string): Promise<{
    screen: SignageScreen;
    playlist: SignagePlaylist | null;
  } | null> {
    const res = await this.pool.query('SELECT * FROM signage_screens WHERE id = $1 LIMIT 1', [
      screenId,
    ]);
    if (!res.rows[0]) return null;
    const now = new Date().toISOString();
    await this.pool.query('UPDATE signage_screens SET last_seen_at = $1 WHERE id = $2', [
      now,
      screenId,
    ]);
    const refreshed = await this.pool.query('SELECT * FROM signage_screens WHERE id = $1 LIMIT 1', [
      screenId,
    ]);
    const screen = await this.hydrateScreen(refreshed.rows[0]);
    const playlist = screen.assignedPlaylistId
      ? await this.getPlaylistById(screen.workspaceId, screen.assignedPlaylistId)
      : null;
    return { screen, playlist };
  }

  async recordPlayerSync(params: {
    screenId: string;
    payload: ScreenSyncPayload;
  }): Promise<SignageScreen | null> {
    const client = await this.pool.connect();
    let workspaceId = '';
    try {
      await client.query('BEGIN');
      const res = await client.query('SELECT * FROM signage_screens WHERE id = $1 LIMIT 1', [
        params.screenId,
      ]);
      const existingRow = res.rows[0] as Record<string, unknown> | undefined;
      if (!existingRow) {
        await client.query('ROLLBACK');
        return null;
      }
      workspaceId = String(existingRow.workspace_id);
      const now = new Date().toISOString();

      const mediaRes = await client.query(
        'SELECT id FROM signage_media WHERE workspace_id = $1',
        [workspaceId]
      );
      const validMedia = new Set(mediaRes.rows.map((r) => String(r.id)));

      for (const item of params.payload.cacheItems) {
        if (!validMedia.has(item.mediaId)) continue;
        await client.query(
          `INSERT INTO signage_device_cache (
             screen_id, media_id, status, sha256, bytes_cached, bytes_total, synced_at, error_message
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(screen_id, media_id) DO UPDATE SET
             status = EXCLUDED.status,
             sha256 = EXCLUDED.sha256,
             bytes_cached = EXCLUDED.bytes_cached,
             bytes_total = EXCLUDED.bytes_total,
             synced_at = EXCLUDED.synced_at,
             error_message = EXCLUDED.error_message`,
          [
            params.screenId,
            item.mediaId,
            item.status,
            item.sha256,
            Math.max(0, Math.round(item.bytesCached)),
            Math.max(0, Math.round(item.bytesTotal)),
            item.status === 'cached' ? now : null,
            item.errorMessage ?? null,
          ]
        );
      }

      await client.query(
        `UPDATE signage_screens
         SET playback_state = $1,
             current_item_id = $2,
             current_media_id = $3,
             current_media_name = $4,
             current_position_sec = $5,
             total_playback_sec = $6,
             last_sync_at = $7,
             last_sync_error = $8,
             last_seen_at = $9,
             updated_at = $10
         WHERE id = $11`,
        [
          params.payload.playbackState,
          params.payload.currentItemId,
          params.payload.currentMediaId,
          params.payload.currentMediaName,
          Math.max(0, params.payload.currentPositionSec),
          Math.max(0, params.payload.totalPlaybackSec),
          now,
          params.payload.lastSyncError,
          now,
          now,
          params.screenId,
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return this.getScreenById(workspaceId, params.screenId);
  }
}

export function createSignageDatabase(options?: {
  sqlitePath?: string;
  postgresUrl?: string;
}): SignageStore {
  const pgUrl =
    options?.postgresUrl?.trim() ||
    process.env.CASTORA_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (pgUrl) {
    return new PostgresSignageRepository(pgUrl);
  }
  const sqlitePath =
    options?.sqlitePath?.trim() ||
    process.env.CASTORA_SIGNAGE_DB_PATH?.trim() ||
    path.resolve(process.cwd(), '.castora-data', 'signage.db');
  return new SqliteSignageRepository(sqlitePath);
}
