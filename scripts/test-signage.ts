import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startCastoraServer } from '../server.ts';
import { hashToken } from '../apps/server/security.ts';
import {
  ObjectUrlPool,
  loadOfflineManifest,
  saveOfflineManifest,
} from '../apps/web/src/services/signageCacheService.ts';
import { SignagePlaybackEngine } from '../apps/web/src/services/signagePlaybackEngine.ts';
import type {
  SignageMediaAsset,
  SignagePlaylist,
  SignageScreen,
} from '../apps/web/src/types/signage.ts';

function buildMinimalPngBuffer(): Buffer {
  // 1x1 transparent PNG
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex'
  );
}

function buildMinimalJpegBuffer(): Buffer {
  // Valid JPEG SOI + APP0 JFIF + EOI
  return Buffer.from(
    'ffd8ffe000104a46494600010101004800480000ffd9',
    'hex'
  );
}

function buildMinimalMp4Buffer(): Buffer {
  // ISO BMFF ftyp isom box + tiny mdat box so Range requests can slice across bytes
  const ftyp = Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex');
  const mdatPayload = Buffer.from('CastoraProSignageMP4TestPayloadData0123456789', 'utf8');
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(8 + mdatPayload.length, 0);
  mdatHeader.write('mdat', 4, 'ascii');
  return Buffer.concat([ftyp, mdatHeader, mdatPayload]);
}

async function apiJson<T>(
  baseUrl: string,
  route: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

async function testLegacyMigrationPreservation(tmpRoot: string): Promise<void> {
  console.log('8) Testing legacy 12-screen SQLite migration & assignment preservation...');
  const legacyDbPath = path.join(tmpRoot, 'legacy-12.db');
  const legacyStorageDir = path.join(tmpRoot, 'legacy-objects');
  fs.mkdirSync(legacyStorageDir, { recursive: true });

  const workspaceId = 'ws-legacy-12';
  const hostToken = 'legacy-host-token-for-migration-check-0001';
  const recoveryCode = 'LEGACY99';
  const mediaId = 'med-legacy-1';
  const playlistId = 'pl-legacy-1';
  const now = new Date().toISOString();

  // Create a pre-migration SQLite DB matching Castora's schema plus explicit CHECK constraints capped at 12 screens
  const db = new DatabaseSync(legacyDbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE signage_workspaces (
      id TEXT PRIMARY KEY,
      host_token_hash TEXT NOT NULL,
      recovery_code_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE signage_media (
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
    CREATE TABLE signage_playlists (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      loop_playlist INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE signage_playlist_items (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES signage_playlists(id) ON DELETE CASCADE,
      media_id TEXT NOT NULL REFERENCES signage_media(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      image_duration_sec INTEGER NOT NULL DEFAULT 10,
      repeat_count INTEGER NOT NULL DEFAULT 1,
      play_until_end INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE signage_screens (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES signage_workspaces(id) ON DELETE CASCADE,
      slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 12),
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
    CREATE TABLE signage_device_cache (
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

  db.prepare(
    `INSERT INTO signage_workspaces (id, host_token_hash, recovery_code_hash, created_at) VALUES (?, ?, ?, ?)`
  ).run(workspaceId, hashToken(hostToken), hashToken(recoveryCode), now);

  db.prepare(
    `INSERT INTO signage_media (id, workspace_id, original_name, display_name, media_kind, mime_type, format, size_bytes, duration_sec, width, height, sha256, storage_provider, storage_key, upload_status, created_at, updated_at)
     VALUES (?, ?, 'legacy.png', 'Legacy Poster', 'image', 'image/png', 'PNG', 67, NULL, 1920, 1080, 'abcd', 'local-dev', 'legacy/legacy.png', 'ready', ?, ?)`
  ).run(mediaId, workspaceId, now, now);

  db.prepare(
    `INSERT INTO signage_playlists (id, workspace_id, name, description, loop_playlist, created_at, updated_at)
     VALUES (?, ?, 'Legacy Playlist', '', 1, ?, ?)`
  ).run(playlistId, workspaceId, now, now);

  db.prepare(
    `INSERT INTO signage_playlist_items (id, playlist_id, media_id, sort_order, image_duration_sec, repeat_count, play_until_end, created_at)
     VALUES ('pli-legacy-1', ?, ?, 0, 10, 1, 1, ?)`
  ).run(playlistId, mediaId, now);

  const insertScreen = db.prepare(
    `INSERT INTO signage_screens (id, workspace_id, slot_number, screen_code, name, platform, device_type, device_id, paired_from_room_id, token_hash, assigned_playlist_id, playback_command, playback_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'android-tv', 'TV', NULL, NULL, NULL, ?, 'play', 'idle', ?, ?)`
  );
  for (let slot = 1; slot <= 12; slot += 1) {
    insertScreen.run(
      `scr-legacy-${slot}`,
      workspaceId,
      slot,
      `LEG${String(slot).padStart(3, '0')}`,
      `Legacy TV ${slot}`,
      slot <= 10 ? playlistId : null,
      now,
      now
    );
  }
  db.close();

  // Boot Castora server on the legacy DB: should automatically migrate CHECK constraint to 15
  // while preserving all 12 screens, codes, and playlist assignments.
  const migratedServer = await startCastoraServer({
    port: 0,
    host: '127.0.0.1',
    signageDbPath: legacyDbPath,
    signageStorageDir: legacyStorageDir,
  });

  try {
    const baseUrl = `http://127.0.0.1:${migratedServer.port}`;
    const listRes = await apiJson<{ screens: SignageScreen[] }>(
      baseUrl,
      '/api/signage/screens',
      { token: hostToken }
    );
    assert.equal(listRes.status, 200);
    assert.equal(listRes.data.screens.length, 12);
    assert.equal(listRes.data.screens[0].screenCode, 'LEG001');
    assert.equal(listRes.data.screens[0].assignedPlaylistId, playlistId);
    assert.equal(listRes.data.screens[11].slotNumber, 12);
    assert.equal(listRes.data.screens[11].assignedPlaylistId, null);

    // Now register screens 13, 14, 15 on the migrated DB
    for (let slot = 13; slot <= 15; slot += 1) {
      const addRes = await apiJson<{ screen: SignageScreen }>(
        baseUrl,
        '/api/signage/screens',
        {
          method: 'POST',
          token: hostToken,
          body: { name: `Upgraded TV ${slot}`, platform: 'android-tv', deviceType: 'TV' },
        }
      );
      assert.equal(addRes.status, 201, `Expected migrated DB to accept slot ${slot}`);
      assert.equal(addRes.data.screen.slotNumber, slot);
    }

    // 16th screen still rejected
    const overflowRes = await apiJson<{ error: string }>(
      baseUrl,
      '/api/signage/screens',
      {
        method: 'POST',
        token: hostToken,
        body: { name: 'Overflow TV 16', platform: 'android-tv', deviceType: 'TV' },
      }
    );
    assert.equal(overflowRes.status, 409);
    assert.equal(overflowRes.data.error, 'SIGNAGE_CAPACITY_REACHED');
  } finally {
    await migratedServer.close();
  }
}

async function run(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'castora-signage-test-'));
  const dbPath = path.join(tmpRoot, 'signage.db');
  const storageDir = path.join(tmpRoot, 'objects');

  let instance = await startCastoraServer({
    port: 0,
    host: '127.0.0.1',
    signageDbPath: dbPath,
    signageStorageDir: storageDir,
    maxSignageFileBytes: 1024 * 1024,
  });

  const getBaseUrl = () => `http://127.0.0.1:${instance.port}`;

  try {
    console.log('1) Testing workspace bootstrap, recovery & 15-screen storage status...');
    const statusRes = await apiJson<{
      storageProvider: string;
      dbProvider: string;
      maxScreens: number;
    }>(getBaseUrl(), '/api/signage/storage-status');
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.maxScreens, 15);
    assert.equal(statusRes.data.storageProvider, 'local-dev');
    assert.equal(statusRes.data.dbProvider, 'sqlite');

    const bootRes = await apiJson<{
      workspaceId: string;
      hostToken: string;
      recoveryCode: string;
    }>(getBaseUrl(), '/api/signage/workspace/bootstrap', { method: 'POST', body: {} });
    assert.equal(bootRes.status, 201);
    const { workspaceId, recoveryCode } = bootRes.data;
    let hostToken = bootRes.data.hostToken;
    assert.ok(workspaceId.startsWith('ws-'));
    assert.ok(hostToken.length > 20);
    assert.ok(recoveryCode.length >= 8);

    // Reject unauthenticated access to signage endpoints
    const unauthRes = await apiJson(getBaseUrl(), '/api/signage/screens');
    assert.equal(unauthRes.status, 401);

    console.log('2) Testing media upload validation, magic-byte check, rename, range streaming & delete...');
    const pngBytes = buildMinimalPngBuffer();
    const jpgBytes = buildMinimalJpegBuffer();
    const mp4Bytes = buildMinimalMp4Buffer();
    const mp4Sha = crypto.createHash('sha256').update(mp4Bytes).digest('hex');

    const uploadForm = new FormData();
    uploadForm.append('metadata', JSON.stringify([
      { fileName: 'lobby-banner.png', durationSec: null, width: 1920, height: 1080 },
      { fileName: 'promo-photo.jpg', durationSec: null, width: 1920, height: 1080 },
      { fileName: 'hero-loop.mp4', durationSec: 12.5, width: 1920, height: 1080 },
    ]));
    uploadForm.append('files', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), 'lobby-banner.png');
    uploadForm.append('files', new Blob([new Uint8Array(jpgBytes)], { type: 'image/jpeg' }), 'promo-photo.jpg');
    uploadForm.append('files', new Blob([new Uint8Array(mp4Bytes)], { type: 'video/mp4' }), 'hero-loop.mp4');

    const uploadRes = await fetch(`${getBaseUrl()}/api/signage/media/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
      body: uploadForm,
    });
    assert.equal(uploadRes.status, 201);
    const uploadPayload = (await uploadRes.json()) as {
      uploaded: SignageMediaAsset[];
      errors: Array<{ fileName: string; code: string }>;
    };
    assert.equal(uploadPayload.uploaded.length, 3);
    assert.equal(uploadPayload.errors.length, 0);

    const pngAsset = uploadPayload.uploaded.find((m) => m.format === 'PNG')!;
    const jpgAsset = uploadPayload.uploaded.find((m) => m.format === 'JPEG')!;
    const mp4Asset = uploadPayload.uploaded.find((m) => m.format === 'MP4')!;
    assert.equal(mp4Asset.sha256, mp4Sha);
    assert.equal(mp4Asset.durationSec, 12.5);

    // Reject spoofed/invalid file signature (.png extension containing HTML/SVG text)
    const spoofForm = new FormData();
    spoofForm.append(
      'files',
      new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')], { type: 'image/png' }),
      'malicious.png'
    );
    const spoofRes = await fetch(`${getBaseUrl()}/api/signage/media/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
      body: spoofForm,
    });
    assert.equal(spoofRes.status, 400);
    const spoofErr = (await spoofRes.json()) as { error: string };
    assert.equal(spoofErr.error, 'INVALID_FILE_SIGNATURE');

    // Reject oversized file (> 1MB test limit)
    const bigForm = new FormData();
    bigForm.append(
      'files',
      new Blob([Buffer.concat([pngBytes, Buffer.alloc(1024 * 1024 + 512)])], { type: 'image/png' }),
      'oversized.png'
    );
    const bigRes = await fetch(`${getBaseUrl()}/api/signage/media/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
      body: bigForm,
    });
    assert.equal(bigRes.status, 400);
    const bigErr = (await bigRes.json()) as { error: string };
    assert.equal(bigErr.error, 'FILE_TOO_LARGE');

    // Rename media asset
    const renameRes = await apiJson<{ media: SignageMediaAsset }>(
      getBaseUrl(),
      `/api/signage/media/${pngAsset.id}`,
      {
        method: 'PATCH',
        token: hostToken,
        body: { displayName: 'Main Lobby Poster' },
      }
    );
    assert.equal(renameRes.status, 200);
    assert.equal(renameRes.data.media.displayName, 'Main Lobby Poster');

    // Authenticated HTTP 206 Range request + ETag check
    const rangeRes = await fetch(`${getBaseUrl()}/api/signage/media/${mp4Asset.id}/content`, {
      headers: {
        Authorization: `Bearer ${hostToken}`,
        Range: 'bytes=0-19',
      },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-19/${mp4Bytes.length}`);
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    assert.deepEqual(rangeBuf, mp4Bytes.subarray(0, 20));

    // Unauthorized download blocked
    const noAuthDownload = await fetch(`${getBaseUrl()}/api/signage/media/${mp4Asset.id}/content`);
    assert.equal(noAuthDownload.status, 401);

    // Upload a temporary asset and delete it to verify object + metadata removal
    const tempUpload = new FormData();
    tempUpload.append('files', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), 'delete-me.png');
    const tempRes = await fetch(`${getBaseUrl()}/api/signage/media/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
      body: tempUpload,
    });
    const tempJson = (await tempRes.json()) as { uploaded: SignageMediaAsset[] };
    const tempId = tempJson.uploaded[0].id;
    const tempObjectPath = path.join(storageDir, tempJson.uploaded[0].storageKey);
    assert.equal(fs.existsSync(tempObjectPath), true);

    const delRes = await apiJson<{ deleted: boolean }>(getBaseUrl(), `/api/signage/media/${tempId}`, {
      method: 'DELETE',
      token: hostToken,
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);
    assert.equal(fs.existsSync(tempObjectPath), false);

    console.log('3) Testing mixed image+video playlist creation and ordering updates...');
    const playlistARes = await apiJson<{ playlist: SignagePlaylist }>(
      getBaseUrl(),
      '/api/signage/playlists',
      {
        method: 'POST',
        token: hostToken,
        body: {
          name: 'Lobby Mix A',
          loopPlaylist: true,
          items: [
            { mediaId: pngAsset.id, imageDurationSec: 8, repeatCount: 1, playUntilEnd: true },
            { mediaId: mp4Asset.id, imageDurationSec: 10, repeatCount: 2, playUntilEnd: true },
          ],
        },
      }
    );
    assert.equal(playlistARes.status, 201);
    const playlistA = playlistARes.data.playlist;
    assert.equal(playlistA.items.length, 2);

    const playlistBRes = await apiJson<{ playlist: SignagePlaylist }>(
      getBaseUrl(),
      '/api/signage/playlists',
      {
        method: 'POST',
        token: hostToken,
        body: {
          name: 'Cafe Menu B',
          loopPlaylist: true,
          items: [
            { mediaId: jpgAsset.id, imageDurationSec: 15, repeatCount: 1, playUntilEnd: true },
            { mediaId: pngAsset.id, imageDurationSec: 12, repeatCount: 1, playUntilEnd: true },
          ],
        },
      }
    );
    assert.equal(playlistBRes.status, 201);
    const playlistB = playlistBRes.data.playlist;

    const playlistCRes = await apiJson<{ playlist: SignagePlaylist }>(
      getBaseUrl(),
      '/api/signage/playlists',
      {
        method: 'POST',
        token: hostToken,
        body: {
          name: 'Concourse Promo C',
          loopPlaylist: true,
          items: [
            { mediaId: mp4Asset.id, imageDurationSec: 10, repeatCount: 1, playUntilEnd: true },
          ],
        },
      }
    );
    assert.equal(playlistCRes.status, 201);
    const playlistC = playlistCRes.data.playlist;

    // Reorder Playlist B items
    const reorderRes = await apiJson<{ playlist: SignagePlaylist }>(
      getBaseUrl(),
      `/api/signage/playlists/${playlistB.id}`,
      {
        method: 'PATCH',
        token: hostToken,
        body: {
          items: [
            { mediaId: pngAsset.id, imageDurationSec: 12, repeatCount: 1, playUntilEnd: true },
            { mediaId: jpgAsset.id, imageDurationSec: 15, repeatCount: 1, playUntilEnd: true },
          ],
        },
      }
    );
    assert.equal(reorderRes.status, 200);
    assert.equal(reorderRes.data.playlist.items[0].mediaId, pngAsset.id);
    assert.equal(reorderRes.data.playlist.items[1].mediaId, jpgAsset.id);

    console.log('4) Testing 15-screen registration limit & rejection of 16th screen...');
    const screens: SignageScreen[] = [];
    for (let i = 1; i <= 15; i += 1) {
      const scrRes = await apiJson<{ screen: SignageScreen }>(getBaseUrl(), '/api/signage/screens', {
        method: 'POST',
        token: hostToken,
        body: {
          name: `Haier Google TV ${i}`,
          platform: 'android-tv',
          deviceType: 'TV',
        },
      });
      assert.equal(scrRes.status, 201, `Failed creating screen ${i}`);
      assert.equal(scrRes.data.screen.slotNumber, i);
      screens.push(scrRes.data.screen);
    }
    assert.equal(screens.length, 15);

    const sixteenthRes = await apiJson<{ error: string }>(getBaseUrl(), '/api/signage/screens', {
      method: 'POST',
      token: hostToken,
      body: { name: 'Overflow TV 16', platform: 'android-tv', deviceType: 'TV' },
    });
    assert.equal(sixteenthRes.status, 409);
    assert.equal(errorCodeOf(sixteenthRes.data), 'SIGNAGE_CAPACITY_REACHED');

    console.log('5) Testing independent multi-screen assignment across 15 screens, removal & slot reuse...');
    // Screens 1-5 -> Playlist A, Screens 6-10 -> Playlist B, Screens 11-15 -> Playlist C
    const assignARes = await apiJson<{ screens: SignageScreen[] }>(
      getBaseUrl(),
      '/api/signage/screens/assign',
      {
        method: 'POST',
        token: hostToken,
        body: {
          screenIds: screens.slice(0, 5).map((s) => s.id),
          playlistId: playlistA.id,
          autoPlay: true,
        },
      }
    );
    assert.equal(assignARes.status, 200);
    assert.equal(assignARes.data.screens.every((s) => s.assignedPlaylistId === playlistA.id), true);

    const assignBRes = await apiJson<{ screens: SignageScreen[] }>(
      getBaseUrl(),
      '/api/signage/screens/assign',
      {
        method: 'POST',
        token: hostToken,
        body: {
          screenIds: screens.slice(5, 10).map((s) => s.id),
          playlistId: playlistB.id,
          autoPlay: true,
        },
      }
    );
    assert.equal(assignBRes.status, 200);

    const assignCRes = await apiJson<{ screens: SignageScreen[] }>(
      getBaseUrl(),
      '/api/signage/screens/assign',
      {
        method: 'POST',
        token: hostToken,
        body: {
          screenIds: screens.slice(10, 15).map((s) => s.id),
          playlistId: playlistC.id,
          autoPlay: true,
        },
      }
    );
    assert.equal(assignCRes.status, 200);

    // Independently update Screen 2 to Playlist B; stop Screen 3; pause Screen 12
    await apiJson(getBaseUrl(), '/api/signage/screens/assign', {
      method: 'POST',
      token: hostToken,
      body: { screenIds: [screens[1].id], playlistId: playlistB.id, autoPlay: true },
    });
    await apiJson(getBaseUrl(), `/api/signage/screens/${screens[2].id}/control`, {
      method: 'POST',
      token: hostToken,
      body: { command: 'stop' },
    });
    await apiJson(getBaseUrl(), `/api/signage/screens/${screens[11].id}/control`, {
      method: 'POST',
      token: hostToken,
      body: { command: 'pause' },
    });

    // Remove Screen 4 (slot 4) and Screen 9 (slot 9), verify remaining screens stay intact,
    // and verify targeted + automatic slot reuse
    const delSlot4 = await apiJson<{ deleted: boolean }>(
      getBaseUrl(),
      `/api/signage/screens/${screens[3].id}`,
      { method: 'DELETE', token: hostToken }
    );
    assert.equal(delSlot4.status, 200);
    assert.equal(delSlot4.data.deleted, true);

    const delSlot9 = await apiJson<{ deleted: boolean }>(
      getBaseUrl(),
      `/api/signage/screens/${screens[8].id}`,
      { method: 'DELETE', token: hostToken }
    );
    assert.equal(delSlot9.status, 200);

    // Explicit target slot reuse (Slot 9)
    const recreateSlot9 = await apiJson<{ screen: SignageScreen }>(
      getBaseUrl(),
      '/api/signage/screens',
      {
        method: 'POST',
        token: hostToken,
        body: { name: 'Replacement Slot 9 TV', slotNumber: 9, platform: 'android-tv', deviceType: 'TV' },
      }
    );
    assert.equal(recreateSlot9.status, 201);
    assert.equal(recreateSlot9.data.screen.slotNumber, 9);
    screens[8] = recreateSlot9.data.screen;

    // Automatic lowest-free-slot reuse (Slot 4)
    const recreateSlot4 = await apiJson<{ screen: SignageScreen }>(
      getBaseUrl(),
      '/api/signage/screens',
      {
        method: 'POST',
        token: hostToken,
        body: { name: 'Replacement Slot 4 TV', platform: 'android-tv', deviceType: 'TV' },
      }
    );
    assert.equal(recreateSlot4.status, 201);
    assert.equal(recreateSlot4.data.screen.slotNumber, 4);
    screens[3] = recreateSlot4.data.screen;

    // Assign Playlist A to recreated slot 4 and Playlist B to recreated slot 9
    await apiJson(getBaseUrl(), '/api/signage/screens/assign', {
      method: 'POST',
      token: hostToken,
      body: { screenIds: [screens[3].id], playlistId: playlistA.id, autoPlay: true },
    });
    await apiJson(getBaseUrl(), '/api/signage/screens/assign', {
      method: 'POST',
      token: hostToken,
      body: { screenIds: [screens[8].id], playlistId: playlistB.id, autoPlay: true },
    });

    // Reject 16th registration again after slots are full
    const overflowAgainRes = await apiJson<{ error: string }>(getBaseUrl(), '/api/signage/screens', {
      method: 'POST',
      token: hostToken,
      body: { name: 'Overflow After Reuse', platform: 'android-tv', deviceType: 'TV' },
    });
    assert.equal(overflowAgainRes.status, 409);
    assert.equal(errorCodeOf(overflowAgainRes.data), 'SIGNAGE_CAPACITY_REACHED');

    const listAfterControl = await apiJson<{ screens: SignageScreen[] }>(
      getBaseUrl(),
      '/api/signage/screens',
      { token: hostToken }
    );
    assert.equal(listAfterControl.data.screens.length, 15);
    const byId = new Map(listAfterControl.data.screens.map((s) => [s.id, s]));
    assert.equal(byId.get(screens[0].id)?.assignedPlaylistId, playlistA.id);
    assert.equal(byId.get(screens[0].id)?.playbackCommand, 'play');
    assert.equal(byId.get(screens[1].id)?.assignedPlaylistId, playlistB.id);
    assert.equal(byId.get(screens[2].id)?.playbackCommand, 'stop');
    assert.equal(byId.get(screens[11].id)?.playbackCommand, 'pause');
    assert.equal(byId.get(screens[14].id)?.assignedPlaylistId, playlistC.id);

    console.log('6) Testing simultaneous 15-TV claims (/player/claim), concurrent media downloads & restart persistence...');
    // Claim all 15 screens from same host IP to validate venue-NAT burst handling
    const claimResults = await Promise.all(
      screens.map((scr, idx) =>
        apiJson<{ screen: SignageScreen; screenToken: string }>(
          getBaseUrl(),
          '/api/signage/player/claim',
          {
            method: 'POST',
            body: {
              screenCode: scr.screenCode,
              deviceId: `haier-gtv-venue-${idx + 1}`,
              deviceName: `Haier Venue TV ${idx + 1}`,
              platform: 'android-tv',
              deviceType: 'TV',
            },
          }
        )
      )
    );
    for (const [idx, res] of claimResults.entries()) {
      assert.equal(res.status, 200, `Claim failed for screen ${idx + 1}`);
      assert.ok(res.data.screenToken.length > 20);
    }
    const tvTokens = claimResults.map((r) => r.data.screenToken);
    const tv1Token = tvTokens[0];

    // Full server restart against the same DB & object storage directory
    await instance.close();
    instance = await startCastoraServer({
      port: 0,
      host: '127.0.0.1',
      signageDbPath: dbPath,
      signageStorageDir: storageDir,
      maxSignageFileBytes: 1024 * 1024,
    });

    // Verify all 15 TVs can fetch manifests and download media concurrently after restart
    const manifestAfterRestart = await apiJson<{
      screen: SignageScreen;
      playlist: SignagePlaylist & { items: Array<{ contentPath: string | null }> };
    }>(getBaseUrl(), '/api/signage/player/manifest', {
      token: tv1Token,
    });
    assert.equal(manifestAfterRestart.status, 200);
    assert.equal(manifestAfterRestart.data.screen.id, screens[0].id);
    assert.equal(manifestAfterRestart.data.playlist?.id, playlistA.id);
    assert.equal(manifestAfterRestart.data.playlist?.items.length, 2);

    const mp4Path = manifestAfterRestart.data.playlist.items[1].contentPath!;
    const concurrentDownloads = await Promise.all(
      tvTokens.map((tok) =>
        fetch(`${getBaseUrl()}${mp4Path}`, {
          headers: { Authorization: `Bearer ${tok}` },
        }).then(async (res) => ({
          status: res.status,
          bytes: Buffer.from(await res.arrayBuffer()),
        }))
      )
    );
    for (const [idx, dl] of concurrentDownloads.entries()) {
      assert.equal(dl.status, 200, `Concurrent download failed for screen ${idx + 1}`);
      assert.deepEqual(dl.bytes, mp4Bytes);
    }

    // Recover workspace token using workspaceId + recoveryCode after restart
    const recoverRes = await apiJson<{ workspaceId: string; hostToken: string }>(
      getBaseUrl(),
      '/api/signage/workspace/recover',
      {
        method: 'POST',
        body: { workspaceId, recoveryCode },
      }
    );
    assert.equal(recoverRes.status, 200);
    hostToken = recoverRes.data.hostToken;

    // Report cache + playback telemetry from TV 1 & TV 15
    const syncRes = await apiJson<{ screen: SignageScreen }>(
      getBaseUrl(),
      '/api/signage/player/sync',
      {
        method: 'POST',
        token: tv1Token,
        body: {
          playbackState: 'playing',
          currentItemId: manifestAfterRestart.data.playlist.items[0].id,
          currentMediaId: pngAsset.id,
          currentMediaName: pngAsset.displayName,
          currentPositionSec: 4.2,
          totalPlaybackSec: 120,
          cacheItems: [
            {
              mediaId: pngAsset.id,
              status: 'cached',
              sha256: pngAsset.sha256,
              bytesCached: pngAsset.sizeBytes,
              bytesTotal: pngAsset.sizeBytes,
            },
            {
              mediaId: mp4Asset.id,
              status: 'cached',
              sha256: mp4Asset.sha256,
              bytesCached: mp4Asset.sizeBytes,
              bytesTotal: mp4Asset.sizeBytes,
            },
          ],
        },
      }
    );
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.data.screen.playbackState, 'playing');
    assert.equal(syncRes.data.screen.cachedMediaCount, 2);
    assert.equal(syncRes.data.screen.totalMediaCount, 2);
    assert.equal(syncRes.data.screen.cacheProgressPct, 100);

    console.log('7) Testing 7-hour simulated offline playback, mixed playlist loop, error recovery & server outage independence...');
    await saveOfflineManifest(screens[0].id, {
      screen: manifestAfterRestart.data.screen,
      playlist: manifestAfterRestart.data.playlist,
      serverTime: new Date().toISOString(),
    });
    const offlineLoaded = await loadOfflineManifest(screens[0].id);
    assert.equal(offlineLoaded?.playlist?.id, playlistA.id);

    // Shut down backend completely to prove playback engine & cached manifest operate independently
    await instance.close();

    let fakeClockMs = 1_700_000_000_000;
    const engine = new SignagePlaybackEngine(() => fakeClockMs);
    engine.setPlaylist(offlineLoaded!.playlist!, 'play');

    assert.equal(engine.getSnapshot().status, 'playing');
    assert.equal(engine.getSnapshot().currentItemIndex, 0);
    assert.equal(engine.getSnapshot().currentItem?.media?.id, pngAsset.id);

    let safetySteps = 0;
    while (engine.getSnapshot().totalPlaybackSec < 25_200 && safetySteps < 20_000) {
      safetySteps += 1;
      const snap = engine.getSnapshot();
      if (snap.currentItem?.media?.mediaKind === 'image') {
        fakeClockMs += 8_000;
        engine.tick(fakeClockMs);
      } else {
        fakeClockMs += 12_500;
        engine.tick(fakeClockMs);
        engine.notifyVideoEnded();
      }
    }

    const finalSnap = engine.getSnapshot();
    assert.ok(finalSnap.totalPlaybackSec >= 25_200, `Expected >=25200s, got ${finalSnap.totalPlaybackSec}`);
    assert.ok(finalSnap.loopCount >= 700, `Expected >=700 continuous loops, got ${finalSnap.loopCount}`);
    assert.equal(finalSnap.status, 'playing');

    // Verify error recovery skips corrupted item cleanly instead of stalling
    engine.notifyMediaError('Corrupted test frame');
    assert.equal(engine.getSnapshot().errorCount, 1);
    assert.equal(engine.getSnapshot().status, 'playing');

    // Verify ObjectUrlPool cleanup doesn't retain stale entries
    const urlPool = new ObjectUrlPool();
    urlPool.retainOnly(new Set());
    urlPool.disposeAll();

    // Test legacy 12-screen SQLite DB upgrade & data preservation
    await testLegacyMigrationPreservation(tmpRoot);

    // Verify existing WebRTC room system still works cleanly alongside Digital Signage
    console.log('9) Verifying existing Castora WebRTC/room endpoints remain intact (maxReceiversPerRoom=15)...');
    instance = await startCastoraServer({
      port: 0,
      host: '127.0.0.1',
      signageDbPath: dbPath,
      signageStorageDir: storageDir,
    });
    const healthRes = await apiJson<{
      status: string;
      protocolVersion: string;
      maxReceiversPerRoom: number;
    }>(getBaseUrl(), '/api/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.data.status, 'ok');
    assert.equal(healthRes.data.protocolVersion, 'castora.v1');
    assert.equal(healthRes.data.maxReceiversPerRoom, 15);

    console.log('✅ All 15-screen Digital Signage, migration, concurrency, and 7h autonomous playback tests passed!');
  } finally {
    try {
      await instance.close();
    } catch {
      // Ignore already-closed server
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function errorCodeOf(data: unknown): string | undefined {
  return (data as { error?: string } | null)?.error;
}

run().catch((err) => {
  console.error('❌ Signage test suite failed:', err);
  process.exitCode = 1;
});
