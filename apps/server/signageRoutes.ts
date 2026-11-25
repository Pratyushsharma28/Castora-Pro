import Busboy from 'busboy';
import crypto from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeDeviceType } from './roomManager.ts';
import { SlidingWindowRateLimiter, verifyConstantTimeSecret } from './security.ts';
import type { SignageObjectStorage } from './objectStorage.ts';
import type { PlaylistItemInput, SignageStore } from './signageDatabase.ts';
import {
  DEFAULT_IMAGE_DURATION_SEC,
  DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS,
  DEFAULT_MAX_SIGNAGE_FILE_BYTES,
  MAX_SIGNAGE_SCREENS,
  SUPPORTED_SIGNAGE_MEDIA,
  detectMediaSignatureFromHeader,
  isCompatibleMagicSignature,
  resolveSupportedMediaSpec,
  sanitizeDisplayName,
  type SignageCacheItemStatus,
  type SignageMediaAsset,
  type SignagePlaybackCommand,
  type SignagePlaybackState,
  type SignageScreen,
  type SignageStorageStatus,
} from './signageTypes.ts';
import type { CastoraPlatform } from './types.ts';

const ALLOWED_PLATFORMS = new Set<CastoraPlatform>(['macos', 'android', 'android-tv']);
const ALLOWED_COMMANDS = new Set<SignagePlaybackCommand>(['play', 'pause', 'stop']);
const ALLOWED_PLAYBACK_STATES = new Set<SignagePlaybackState>([
  'idle',
  'syncing',
  'playing',
  'paused',
  'stopped',
  'offline',
  'error',
]);
const ALLOWED_CACHE_STATUSES = new Set<SignageCacheItemStatus>([
  'pending',
  'downloading',
  'cached',
  'error',
]);
const SCREEN_CODE_REGEX = /^[A-Z0-9]{6}$/;

interface SseSubscriber {
  res: Response;
  kind: 'host' | 'screen';
  workspaceId: string;
  screenId?: string;
}

export interface SignageRouterOptions {
  store: SignageStore;
  storage: SignageObjectStorage;
  maxFileSizeBytes?: number;
}

function extractToken(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  return queryToken;
}

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function parseRangeHeader(
  rangeHeader: string | undefined,
  totalSize: number
): { start: number; end: number } | 'invalid' | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }
  const spec = rangeHeader.slice(6).split(',')[0]?.trim() ?? '';
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';

  if (!rawStart && rawEnd) {
    const suffixLen = Number(rawEnd);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return 'invalid';
    const start = Math.max(0, totalSize - suffixLen);
    return { start, end: totalSize - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Math.min(totalSize - 1, Number(rawEnd)) : totalSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || end < start) {
    return 'invalid';
  }
  return { start, end };
}

export function createSignageRouter(options: SignageRouterOptions): {
  router: Router;
  shutdown: () => void;
} {
  const { store, storage } = options;
  const configuredMax = Number(process.env.CASTORA_SIGNAGE_MAX_FILE_BYTES);
  const maxFileSizeBytes =
    options.maxFileSizeBytes ??
    (Number.isFinite(configuredMax) && configuredMax >= 1024 * 1024
      ? configuredMax
      : DEFAULT_MAX_SIGNAGE_FILE_BYTES);

  const configuredConcurrentStreams = Number(process.env.CASTORA_SIGNAGE_MAX_CONCURRENT_STREAMS);
  const maxConcurrentStreams =
    Number.isFinite(configuredConcurrentStreams) && configuredConcurrentStreams >= 1
      ? Math.min(32, Math.floor(configuredConcurrentStreams))
      : DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS;

  let activeMediaStreams = 0;
  const mediaStreamWaiters: Array<(granted: boolean) => void> = [];

  function acquireMediaStreamSlot(timeoutMs = 3_000): Promise<boolean> {
    if (activeMediaStreams < maxConcurrentStreams) {
      activeMediaStreams += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = (granted: boolean) => {
        clearTimeout(timer);
        resolve(granted);
      };
      const timer = setTimeout(() => {
        const idx = mediaStreamWaiters.indexOf(waiter);
        if (idx >= 0) mediaStreamWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      mediaStreamWaiters.push(waiter);
    });
  }

  function releaseMediaStreamSlot(): void {
    const nextWaiter = mediaStreamWaiters.shift();
    if (nextWaiter) {
      nextWaiter(true);
      return;
    }
    activeMediaStreams = Math.max(0, activeMediaStreams - 1);
  }

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // 35 claims/min per IP safely allows all 15 TVs behind one shared venue NAT IP to pair simultaneously
  const claimRateLimiter = new SlidingWindowRateLimiter(35, 60_000);
  const recoverRateLimiter = new SlidingWindowRateLimiter(8, 60_000);

  const MAX_SSE_SUBSCRIBERS = 200;
  const subscribers = new Set<SseSubscriber>();
  const keepAliveTimer = setInterval(() => {
    for (const sub of subscribers) {
      if (!sub.res.writableEnded) {
        sub.res.write(': keepalive\n\n');
      } else {
        subscribers.delete(sub);
      }
    }
  }, 20_000);
  keepAliveTimer.unref();

  function emitSseEvent(
    workspaceId: string,
    event: string,
    payload: unknown,
    targetScreenIds?: string[]
  ): void {
    const targetSet = targetScreenIds ? new Set(targetScreenIds) : null;
    const serialized = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const sub of subscribers) {
      if (sub.workspaceId !== workspaceId) continue;
      if (sub.kind === 'screen' && targetSet && sub.screenId && !targetSet.has(sub.screenId)) {
        continue;
      }
      if (!sub.res.writableEnded) {
        sub.res.write(serialized);
      }
    }
  }

  function buildStorageStatus(): SignageStorageStatus {
    return {
      storageProvider: storage.provider,
      dbProvider: store.dbProvider,
      persistentObjectStorage: storage.persistent,
      maxFileSizeBytes,
      maxScreens: MAX_SIGNAGE_SCREENS,
      supportedMimeTypes: SUPPORTED_SIGNAGE_MEDIA.map((m) => m.mimeType),
      bucketName: storage.bucketName,
      warning: storage.warning,
    };
  }

  async function requireHostWorkspace(req: Request, res: Response): Promise<string | null> {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Host Bearer token required for Digital Signage management',
      });
      return null;
    }
    const workspaceId = await store.verifyHostToken(token);
    if (!workspaceId) {
      res.status(403).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid or expired Digital Signage host token',
      });
      return null;
    }
    return workspaceId;
  }

  async function requirePlayerScreen(req: Request, res: Response): Promise<SignageScreen | null> {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Screen Bearer token required',
      });
      return null;
    }
    const screen = await store.verifyScreenToken(token);
    if (!screen) {
      res.status(403).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid or revoked screen token',
      });
      return null;
    }
    return screen;
  }

  router.get('/storage-status', (_req: Request, res: Response) => {
    res.status(200).json(buildStorageStatus());
  });

  router.post('/workspace/bootstrap', async (req: Request, res: Response) => {
    try {
      const existingToken = extractToken(req);
      const body = (req.body ?? {}) as { workspaceId?: unknown; accessKey?: unknown };

      if (existingToken) {
        const verifiedWs = await store.verifyHostToken(existingToken);
        if (verifiedWs) {
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).json({
            workspaceId: verifiedWs,
            hostToken: existingToken,
            recoveryCode: null,
            storageStatus: buildStorageStatus(),
          });
          return;
        }
      }

      const requiredKey = process.env.CASTORA_SIGNAGE_ACCESS_KEY?.trim();
      if (requiredKey) {
        const candidateKey = typeof body.accessKey === 'string' ? body.accessKey.trim() : '';
        if (!verifyConstantTimeSecret(candidateKey, requiredKey)) {
          res.status(403).json({
            error: 'ACCESS_KEY_REQUIRED',
            message: 'A valid CASTORA_SIGNAGE_ACCESS_KEY is required to create a new signage studio workspace',
          });
          return;
        }
      }

      const created = await store.bootstrapWorkspace({
        workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId.trim() : undefined,
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        workspaceId: created.workspaceId,
        hostToken: created.hostToken,
        recoveryCode: created.recoveryCode,
        storageStatus: buildStorageStatus(),
      });
    } catch (error) {
      console.error('[signage] Workspace bootstrap failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to initialize workspace' });
    }
  });

  router.post('/workspace/recover', async (req: Request, res: Response) => {
    const rate = recoverRateLimiter.consume(`recover:${getClientIp(req)}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000).toString());
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many workspace recovery attempts. Try again shortly.',
      });
      return;
    }

    try {
      const body = (req.body ?? {}) as { workspaceId?: unknown; recoveryCode?: unknown };
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
      const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode.trim() : '';
      if (!workspaceId || !recoveryCode) {
        res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'workspaceId and recoveryCode are required',
        });
        return;
      }

      const result = await store.recoverWorkspace({ workspaceId, recoveryCode });
      if (!result.ok) {
        res.status(403).json({ error: 'UNAUTHORIZED', message: result.message });
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        workspaceId: result.workspaceId,
        hostToken: result.hostToken,
        storageStatus: buildStorageStatus(),
      });
    } catch (error) {
      console.error('[signage] Workspace recover failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to recover workspace' });
    }
  });

  router.get('/events', async (req: Request, res: Response) => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token required for live signage events' });
      return;
    }

    const hostWorkspaceId = await store.verifyHostToken(token);
    let subscriber: SseSubscriber | null = null;
    if (hostWorkspaceId) {
      subscriber = { res, kind: 'host', workspaceId: hostWorkspaceId };
    } else {
      const screen = await store.verifyScreenToken(token);
      if (screen) {
        subscriber = {
          res,
          kind: 'screen',
          workspaceId: screen.workspaceId,
          screenId: screen.id,
        };
      }
    }

    if (!subscriber) {
      res.status(403).json({ error: 'UNAUTHORIZED', message: 'Invalid token for event stream' });
      return;
    }

    if (subscribers.size >= MAX_SSE_SUBSCRIBERS) {
      res.status(503).json({
        error: 'SSE_CAPACITY_REACHED',
        message: 'Too many active event streams connected',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    subscribers.add(subscriber);
    res.write(`event: ready\ndata: ${JSON.stringify({ kind: subscriber.kind })}\n\n`);

    const cleanup = () => {
      if (subscriber) {
        subscribers.delete(subscriber);
      }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  // --- Media Library Endpoints ---
  router.get('/media', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const items = await store.listMedia(workspaceId);
      res.status(200).json({ items, storageStatus: buildStorageStatus() });
    } catch (error) {
      console.error('[signage] List media failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load media library' });
    }
  });

  router.post('/media/upload', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;

    if (storage.provider === 'unconfigured') {
      res.status(503).json({
        error: 'STORAGE_NOT_CONFIGURED',
        message:
          storage.warning ??
          'Persistent object storage is not configured in production.',
      });
      return;
    }

    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      res.status(400).json({
        error: 'INVALID_CONTENT_TYPE',
        message: 'Expected multipart/form-data upload request',
      });
      return;
    }

    interface ParsedClientMeta {
      fileName?: string;
      displayName?: string;
      durationSec?: number | null;
      width?: number | null;
      height?: number | null;
    }

    const clientMetaList: ParsedClientMeta[] = [];
    const uploadedAssets: SignageMediaAsset[] = [];
    const errors: Array<{ fileName: string; code: string; message: string }> = [];
    const pendingJobs: Array<Promise<void>> = [];

    await new Promise<void>((resolve) => {
      let busboyFinished = false;
      const bb = Busboy({
        headers: req.headers,
        limits: {
          files: 10,
          fileSize: maxFileSizeBytes,
          fieldSize: 128 * 1024,
        },
      });

      const maybeDone = () => {
        if (busboyFinished && pendingJobs.length > 0) {
          void Promise.allSettled(pendingJobs).then(() => resolve());
        } else if (busboyFinished && pendingJobs.length === 0) {
          resolve();
        }
      };

      bb.on('field', (name, value) => {
        if (name === 'metadata') {
          try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item && typeof item === 'object') {
                  clientMetaList.push(item as ParsedClientMeta);
                }
              }
            }
          } catch {
            // Ignore malformed optional metadata JSON
          }
        }
      });

      let fileCounter = 0;
      bb.on('file', (_fieldname, fileStream, info) => {
        const index = fileCounter;
        fileCounter += 1;
        const originalName = sanitizeDisplayName(
          path.basename(info.filename || `media-${index + 1}`),
          `media-${index + 1}`
        );
        const spec = resolveSupportedMediaSpec(info.mimeType, originalName);

        if (!spec) {
          fileStream.resume();
          errors.push({
            fileName: originalName,
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: `Unsupported format for "${originalName}". Allowed: JPG, JPEG, PNG, WebP, GIF, MP4, WebM, MOV.`,
          });
          return;
        }

        const job = (async () => {
          const mediaId = `med-${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
          const ext = spec.extensions[0];
          const tmpFile = path.join(os.tmpdir(), `castora-upload-${mediaId}${ext}`);
          const hash = crypto.createHash('sha256');
          const headerChunks: Buffer[] = [];
          let headerBytes = 0;
          let sizeBytes = 0;
          let truncated = false;

          const writeStream = fs.createWriteStream(tmpFile);

          try {
            await new Promise<void>((streamResolve, streamReject) => {
              fileStream.on('limit', () => {
                truncated = true;
              });
              fileStream.on('data', (chunk: Buffer) => {
                sizeBytes += chunk.length;
                hash.update(chunk);
                if (headerBytes < 64) {
                  const needed = 64 - headerBytes;
                  headerChunks.push(chunk.subarray(0, needed));
                  headerBytes += Math.min(chunk.length, needed);
                }
              });
              fileStream.on('error', streamReject);
              writeStream.on('error', streamReject);
              writeStream.on('finish', () => streamResolve());
              fileStream.pipe(writeStream);
            });

            if (truncated) {
              errors.push({
                fileName: originalName,
                code: 'FILE_TOO_LARGE',
                message: `"${originalName}" exceeds the ${Math.round(maxFileSizeBytes / (1024 * 1024))} MB per-file limit.`,
              });
              return;
            }

            if (sizeBytes === 0) {
              errors.push({
                fileName: originalName,
                code: 'EMPTY_FILE',
                message: `"${originalName}" is empty.`,
              });
              return;
            }

            const header = Buffer.concat(headerChunks);
            const detectedSignature = detectMediaSignatureFromHeader(header);
            if (!isCompatibleMagicSignature(spec, detectedSignature)) {
              errors.push({
                fileName: originalName,
                code: 'INVALID_FILE_SIGNATURE',
                message: `File header of "${originalName}" does not match a valid ${spec.format} media signature.`,
              });
              return;
            }

            const sha256 = hash.digest('hex');
            const storageKey = `${workspaceId}/${mediaId}${ext}`;
            await storage.putObjectFromFile({
              key: storageKey,
              filePath: tmpFile,
              contentType: spec.mimeType,
              contentLength: sizeBytes,
              sha256,
            });

            const matchedMeta =
              clientMetaList.find((m) => m.fileName === info.filename) ??
              clientMetaList[index];

            const durationSec =
              typeof matchedMeta?.durationSec === 'number' &&
              Number.isFinite(matchedMeta.durationSec) &&
              matchedMeta.durationSec > 0
                ? Math.round(matchedMeta.durationSec * 100) / 100
                : null;
            const width =
              typeof matchedMeta?.width === 'number' &&
              Number.isFinite(matchedMeta.width) &&
              matchedMeta.width > 0
                ? Math.round(matchedMeta.width)
                : null;
            const height =
              typeof matchedMeta?.height === 'number' &&
              Number.isFinite(matchedMeta.height) &&
              matchedMeta.height > 0
                ? Math.round(matchedMeta.height)
                : null;

            const asset = await store.createMedia({
              id: mediaId,
              workspaceId,
              originalName,
              displayName: matchedMeta?.displayName
                ? sanitizeDisplayName(matchedMeta.displayName, originalName)
                : originalName,
              mediaKind: spec.mediaKind,
              mimeType: spec.mimeType,
              format: spec.format,
              sizeBytes,
              durationSec,
              width,
              height,
              sha256,
              storageProvider: storage.provider === 's3' ? 's3' : 'local-dev',
              storageKey,
              uploadStatus: 'ready',
            });

            uploadedAssets.push(asset);
          } catch (err) {
            console.error(`[signage] Upload failed for ${originalName}:`, err);
            errors.push({
              fileName: originalName,
              code: 'UPLOAD_FAILED',
              message: `Failed to store "${originalName}" in object storage.`,
            });
          } finally {
            try {
              await fs.promises.unlink(tmpFile);
            } catch {
              // Ignore temp cleanup failure
            }
          }
        })();

        pendingJobs.push(job);
      });

      bb.on('filesLimit', () => {
        errors.push({
          fileName: 'batch',
          code: 'TOO_MANY_FILES',
          message: 'Maximum 10 files per upload batch.',
        });
      });

      bb.on('finish', () => {
        busboyFinished = true;
        maybeDone();
      });

      bb.on('error', (err: unknown) => {
        console.error('[signage] Busboy parse error:', err);
        busboyFinished = true;
        errors.push({
          fileName: 'request',
          code: 'UPLOAD_PARSE_ERROR',
          message: 'Malformed multipart upload payload',
        });
        maybeDone();
      });

      req.pipe(bb);
    });

    if (uploadedAssets.length > 0) {
      emitSseEvent(workspaceId, 'media_updated', {
        added: uploadedAssets.map((a) => a.id),
      });
    }

    if (uploadedAssets.length === 0 && errors.length > 0) {
      res.status(400).json({
        error: errors[0].code,
        message: errors[0].message,
        uploaded: [],
        errors,
      });
      return;
    }

    res.status(uploadedAssets.length > 0 ? 201 : 400).json({
      uploaded: uploadedAssets,
      errors,
    });
  });

  router.patch('/media/:mediaId', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const mediaId = String(req.params.mediaId ?? '').trim();
      const body = (req.body ?? {}) as {
        displayName?: unknown;
        durationSec?: unknown;
        width?: unknown;
        height?: unknown;
      };
      const updated = await store.updateMedia({
        workspaceId,
        mediaId,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        durationSec:
          typeof body.durationSec === 'number' && Number.isFinite(body.durationSec)
            ? body.durationSec
            : undefined,
        width:
          typeof body.width === 'number' && Number.isFinite(body.width) ? body.width : undefined,
        height:
          typeof body.height === 'number' && Number.isFinite(body.height) ? body.height : undefined,
      });
      if (!updated) {
        res.status(404).json({ error: 'MEDIA_NOT_FOUND', message: 'Media asset not found' });
        return;
      }
      emitSseEvent(workspaceId, 'media_updated', { updated: updated.id });
      res.status(200).json({ media: updated });
    } catch (error) {
      console.error('[signage] Update media failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update media metadata' });
    }
  });

  router.delete('/media/:mediaId', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const mediaId = String(req.params.mediaId ?? '').trim();
      const { deleted, affectedScreenIds } = await store.deleteMedia({ workspaceId, mediaId });
      if (!deleted) {
        res.status(404).json({ error: 'MEDIA_NOT_FOUND', message: 'Media asset not found' });
        return;
      }

      try {
        await storage.deleteObject(deleted.storageKey);
      } catch (err) {
        console.warn(`[signage] Warning deleting object ${deleted.storageKey}:`, err);
      }

      emitSseEvent(workspaceId, 'media_updated', { deleted: mediaId });
      if (affectedScreenIds.length > 0) {
        emitSseEvent(workspaceId, 'manifest_update', { screenIds: affectedScreenIds }, affectedScreenIds);
      }
      res.status(200).json({ deleted: true, mediaId });
    } catch (error) {
      console.error('[signage] Delete media failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete media' });
    }
  });

  router.get('/media/:mediaId/content', async (req: Request, res: Response) => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Bearer or query token required' });
      return;
    }

    const mediaId = String(req.params.mediaId ?? '').trim();
    const media = await store.getMediaById(mediaId);
    if (!media) {
      res.status(404).json({ error: 'MEDIA_NOT_FOUND', message: 'Media asset not found' });
      return;
    }

    const hostWorkspaceId = await store.verifyHostToken(token);
    const screen = hostWorkspaceId ? null : await store.verifyScreenToken(token);
    const authorizedWorkspace = hostWorkspaceId ?? screen?.workspaceId ?? null;
    if (!authorizedWorkspace || authorizedWorkspace !== media.workspaceId) {
      res.status(403).json({ error: 'UNAUTHORIZED', message: 'Not authorized to access this media asset' });
      return;
    }

    const etag = `"${media.sha256}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    const parsedRange = parseRangeHeader(req.headers.range, media.sizeBytes);
    if (parsedRange === 'invalid') {
      res.setHeader('Content-Range', `bytes */${media.sizeBytes}`);
      res.status(416).end();
      return;
    }

    const granted = await acquireMediaStreamSlot(3_000);
    if (!granted) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        error: 'SERVICE_BUSY',
        message: 'Too many simultaneous media downloads in progress. Retrying shortly.',
      });
      return;
    }

    let slotReleased = false;
    const releaseSlotOnce = () => {
      if (!slotReleased) {
        slotReleased = true;
        releaseMediaStreamSlot();
      }
    };

    try {
      const obj = await storage.getObjectStream({
        key: media.storageKey,
        ...(parsedRange ? { rangeStart: parsedRange.start, rangeEnd: parsedRange.end } : {}),
      });
      if (!obj) {
        releaseSlotOnce();
        res.status(404).json({ error: 'OBJECT_NOT_FOUND', message: 'Media payload not found in object storage' });
        return;
      }

      res.setHeader('Content-Type', media.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', etag);
      res.setHeader('X-Castora-Sha256', media.sha256);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('Content-Length', String(obj.contentLength));

      if (obj.isPartial) {
        res.setHeader('Content-Range', `bytes ${obj.rangeStart}-${obj.rangeEnd}/${obj.totalSize}`);
        res.status(206);
      } else {
        res.status(200);
      }

      const cleanupStream = () => {
        if (!obj.stream.destroyed) {
          obj.stream.destroy();
        }
        releaseSlotOnce();
      };

      res.on('finish', releaseSlotOnce);
      res.on('close', cleanupStream);
      obj.stream.on('end', releaseSlotOnce);
      obj.stream.on('error', (err) => {
        console.error(`[signage] Stream error for ${media.id}:`, err);
        releaseSlotOnce();
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy();
        }
      });
      obj.stream.pipe(res);
    } catch (error) {
      releaseSlotOnce();
      console.error('[signage] Object read failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to stream media object' });
    }
  });

  // --- Playlist Endpoints ---
  router.get('/playlists', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const playlists = await store.listPlaylists(workspaceId);
      res.status(200).json({ playlists });
    } catch (error) {
      console.error('[signage] List playlists failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load playlists' });
    }
  });

  function parsePlaylistItemsBody(rawItems: unknown): PlaylistItemInput[] | null {
    if (!Array.isArray(rawItems)) return null;
    const out: PlaylistItemInput[] = [];
    for (let i = 0; i < rawItems.length; i += 1) {
      const item = rawItems[i] as Record<string, unknown> | null;
      if (!item || typeof item !== 'object' || typeof item.mediaId !== 'string') {
        return null;
      }
      out.push({
        id: typeof item.id === 'string' ? item.id : undefined,
        mediaId: item.mediaId.trim(),
        sortOrder: i,
        imageDurationSec:
          typeof item.imageDurationSec === 'number'
            ? item.imageDurationSec
            : DEFAULT_IMAGE_DURATION_SEC,
        repeatCount: typeof item.repeatCount === 'number' ? item.repeatCount : 1,
        playUntilEnd: typeof item.playUntilEnd === 'boolean' ? item.playUntilEnd : true,
      });
    }
    return out;
  }

  router.post('/playlists', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const body = (req.body ?? {}) as {
        name?: unknown;
        description?: unknown;
        loopPlaylist?: unknown;
        items?: unknown;
      };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Playlist name is required' });
        return;
      }
      const items = body.items === undefined ? [] : parsePlaylistItemsBody(body.items);
      if (items === null) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Playlist items must be an array' });
        return;
      }

      const playlist = await store.createPlaylist({
        workspaceId,
        name,
        description: typeof body.description === 'string' ? body.description : '',
        loopPlaylist: typeof body.loopPlaylist === 'boolean' ? body.loopPlaylist : true,
        items,
      });

      emitSseEvent(workspaceId, 'playlists_updated', { playlistId: playlist.id });
      res.status(201).json({ playlist });
    } catch (error) {
      console.error('[signage] Create playlist failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create playlist' });
    }
  });

  router.patch('/playlists/:playlistId', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const playlistId = String(req.params.playlistId ?? '').trim();
      const body = (req.body ?? {}) as {
        name?: unknown;
        description?: unknown;
        loopPlaylist?: unknown;
        items?: unknown;
      };
      const items = body.items === undefined ? undefined : parsePlaylistItemsBody(body.items);
      if (body.items !== undefined && items === null) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Invalid playlist items payload' });
        return;
      }

      const updated = await store.updatePlaylist({
        workspaceId,
        playlistId,
        name: typeof body.name === 'string' ? body.name : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        loopPlaylist: typeof body.loopPlaylist === 'boolean' ? body.loopPlaylist : undefined,
        items: items ?? undefined,
      });

      if (!updated.playlist) {
        res.status(404).json({ error: 'PLAYLIST_NOT_FOUND', message: 'Playlist not found' });
        return;
      }

      emitSseEvent(workspaceId, 'playlists_updated', { playlistId });
      if (updated.affectedScreenIds.length > 0) {
        emitSseEvent(
          workspaceId,
          'manifest_update',
          { screenIds: updated.affectedScreenIds },
          updated.affectedScreenIds
        );
      }

      res.status(200).json({ playlist: updated.playlist });
    } catch (error) {
      console.error('[signage] Update playlist failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update playlist' });
    }
  });

  router.delete('/playlists/:playlistId', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const playlistId = String(req.params.playlistId ?? '').trim();
      const result = await store.deletePlaylist({ workspaceId, playlistId });
      if (!result.deleted) {
        res.status(404).json({ error: 'PLAYLIST_NOT_FOUND', message: 'Playlist not found' });
        return;
      }
      emitSseEvent(workspaceId, 'playlists_updated', { deleted: playlistId });
      if (result.affectedScreenIds.length > 0) {
        emitSseEvent(
          workspaceId,
          'manifest_update',
          { screenIds: result.affectedScreenIds },
          result.affectedScreenIds
        );
      }
      res.status(200).json({ deleted: true, playlistId });
    } catch (error) {
      console.error('[signage] Delete playlist failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete playlist' });
    }
  });

  // --- Screens & Assignment Endpoints (up to 15 screens) ---
  router.get('/screens', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const screens = await store.listScreens(workspaceId);
      res.status(200).json({ screens, maxScreens: MAX_SIGNAGE_SCREENS });
    } catch (error) {
      console.error('[signage] List screens failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load signage screens' });
    }
  });

  router.post('/screens', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const body = (req.body ?? {}) as {
        name?: unknown;
        platform?: unknown;
        deviceType?: unknown;
        slotNumber?: unknown;
        deviceId?: unknown;
        pairedFromRoomId?: unknown;
      };

      const platform: CastoraPlatform =
        typeof body.platform === 'string' && ALLOWED_PLATFORMS.has(body.platform as CastoraPlatform)
          ? (body.platform as CastoraPlatform)
          : 'android-tv';
      const deviceType = normalizeDeviceType(body.deviceType ?? 'TV');
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Google TV Display';

      let slotNumber: number | undefined;
      if (body.slotNumber !== undefined && body.slotNumber !== null) {
        const parsedSlot = Number(body.slotNumber);
        if (!Number.isInteger(parsedSlot) || parsedSlot < 1 || parsedSlot > MAX_SIGNAGE_SCREENS) {
          res.status(400).json({
            error: 'INVALID_SLOT_NUMBER',
            message: `slotNumber must be an integer between 1 and ${MAX_SIGNAGE_SCREENS}`,
          });
          return;
        }
        slotNumber = parsedSlot;
      }

      const created = await store.createScreen({
        workspaceId,
        name,
        platform,
        deviceType,
        slotNumber,
        deviceId: typeof body.deviceId === 'string' ? body.deviceId.trim() : null,
        pairedFromRoomId:
          typeof body.pairedFromRoomId === 'string' ? body.pairedFromRoomId.trim() : null,
      });

      if (!created.ok) {
        res.status(409).json({ error: created.code, message: created.message });
        return;
      }

      emitSseEvent(workspaceId, 'screens_updated', { screen: created.screen });
      res.status(201).json({ screen: created.screen });
    } catch (error) {
      console.error('[signage] Create screen failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to register signage screen' });
    }
  });

  router.patch('/screens/:screenId', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const screenId = String(req.params.screenId ?? '').trim();
      const body = (req.body ?? {}) as { name?: unknown; regenerateCode?: unknown };
      const updated = await store.updateScreen({
        workspaceId,
        screenId,
        name: typeof body.name === 'string' ? body.name : undefined,
        regenerateCode: body.regenerateCode === true,
      });
      if (!updated) {
        res.status(404).json({ error: 'SCREEN_NOT_FOUND', message: 'Signage screen not found' });
        return;
      }
      emitSseEvent(workspaceId, 'screens_updated', { screen: updated });
      res.status(200).json({ screen: updated });
    } catch (error) {
      console.error('[signage] Update screen failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update signage screen' });
    }
  });

  router.delete('/screens/:screenId', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const screenId = String(req.params.screenId ?? '').trim();
      const deleted = await store.deleteScreen(workspaceId, screenId);
      if (!deleted) {
        res.status(404).json({ error: 'SCREEN_NOT_FOUND', message: 'Signage screen not found' });
        return;
      }
      emitSseEvent(workspaceId, 'screens_updated', { deletedScreenId: screenId });
      res.status(200).json({ deleted: true, screenId });
    } catch (error) {
      console.error('[signage] Delete screen failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete signage screen' });
    }
  });

  router.post('/screens/assign', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const body = (req.body ?? {}) as {
        screenIds?: unknown;
        playlistId?: unknown;
        autoPlay?: unknown;
      };
      if (!Array.isArray(body.screenIds) || body.screenIds.length === 0) {
        res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'screenIds must be a non-empty array of screen IDs',
        });
        return;
      }
      const screenIds = Array.from(
        new Set(
          body.screenIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim())
        )
      ).slice(0, MAX_SIGNAGE_SCREENS);
      if (screenIds.length === 0) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'No valid screen IDs provided' });
        return;
      }

      const playlistId =
        body.playlistId === null || body.playlistId === ''
          ? null
          : typeof body.playlistId === 'string'
            ? body.playlistId.trim()
            : null;

      const updatedScreens = await store.assignPlaylistToScreens({
        workspaceId,
        screenIds,
        playlistId,
        autoPlay: typeof body.autoPlay === 'boolean' ? body.autoPlay : true,
      });

      emitSseEvent(workspaceId, 'screens_updated', { screenIds });
      emitSseEvent(workspaceId, 'manifest_update', { screenIds }, screenIds);
      res.status(200).json({ screens: updatedScreens });
    } catch (error) {
      if (error instanceof Error && error.message === 'PLAYLIST_NOT_FOUND') {
        res.status(404).json({ error: 'PLAYLIST_NOT_FOUND', message: 'Target playlist not found' });
        return;
      }
      console.error('[signage] Assign playlist failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to assign playlist to screens' });
    }
  });

  router.post('/screens/control-bulk', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const body = (req.body ?? {}) as {
        screenIds?: unknown;
        command?: unknown;
        jumpToItemId?: unknown;
      };
      if (!Array.isArray(body.screenIds) || body.screenIds.length === 0) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'screenIds array required' });
        return;
      }
      const command =
        typeof body.command === 'string' && ALLOWED_COMMANDS.has(body.command as SignagePlaybackCommand)
          ? (body.command as SignagePlaybackCommand)
          : null;
      if (!command) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'command must be play, pause, or stop' });
        return;
      }
      const screenIds = Array.from(
        new Set(
          body.screenIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim())
        )
      ).slice(0, MAX_SIGNAGE_SCREENS);

      const updated = await store.controlScreens({
        workspaceId,
        screenIds,
        command,
        jumpToItemId: typeof body.jumpToItemId === 'string' ? body.jumpToItemId : null,
      });

      emitSseEvent(workspaceId, 'screens_updated', { screenIds });
      emitSseEvent(workspaceId, 'manifest_update', { screenIds, command }, screenIds);
      res.status(200).json({ screens: updated });
    } catch (error) {
      console.error('[signage] Bulk control failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to control signage screens' });
    }
  });

  router.post('/screens/:screenId/control', async (req: Request, res: Response) => {
    const workspaceId = await requireHostWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const screenId = String(req.params.screenId ?? '').trim();
      const body = (req.body ?? {}) as { command?: unknown; jumpToItemId?: unknown };
      const command =
        typeof body.command === 'string' && ALLOWED_COMMANDS.has(body.command as SignagePlaybackCommand)
          ? (body.command as SignagePlaybackCommand)
          : null;
      if (!command) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'command must be play, pause, or stop' });
        return;
      }

      const updated = await store.controlScreens({
        workspaceId,
        screenIds: [screenId],
        command,
        jumpToItemId: typeof body.jumpToItemId === 'string' ? body.jumpToItemId : null,
      });
      if (updated.length === 0) {
        res.status(404).json({ error: 'SCREEN_NOT_FOUND', message: 'Signage screen not found' });
        return;
      }
      emitSseEvent(workspaceId, 'screens_updated', { screenIds: [screenId] });
      emitSseEvent(workspaceId, 'manifest_update', { screenIds: [screenId], command }, [screenId]);
      res.status(200).json({ screen: updated[0] });
    } catch (error) {
      console.error('[signage] Screen control failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update screen playback control' });
    }
  });

  // --- Autonomous TV Player Endpoints (Independent of Host & WebRTC) ---
  router.post('/player/claim', async (req: Request, res: Response) => {
    const rate = claimRateLimiter.consume(`claim:${getClientIp(req)}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000).toString());
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many screen pairing attempts. Wait before retrying.',
      });
      return;
    }

    try {
      const body = (req.body ?? {}) as {
        screenCode?: unknown;
        deviceId?: unknown;
        deviceName?: unknown;
        platform?: unknown;
        deviceType?: unknown;
      };
      const screenCode = typeof body.screenCode === 'string' ? body.screenCode.trim().toUpperCase() : '';
      if (!SCREEN_CODE_REGEX.test(screenCode)) {
        res.status(400).json({
          error: 'INVALID_SCREEN_CODE',
          message: 'Screen code must be 6 uppercase alphanumeric characters',
        });
        return;
      }

      const platform: CastoraPlatform | undefined =
        typeof body.platform === 'string' && ALLOWED_PLATFORMS.has(body.platform as CastoraPlatform)
          ? (body.platform as CastoraPlatform)
          : undefined;
      const deviceType =
        body.deviceType !== undefined ? normalizeDeviceType(body.deviceType) : undefined;

      const claimed = await store.claimScreenByCode({
        screenCode,
        deviceId: typeof body.deviceId === 'string' ? body.deviceId.trim().slice(0, 64) : undefined,
        deviceName: typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 64) : undefined,
        platform,
        deviceType,
      });

      if (!claimed.ok) {
        const status = claimed.code === 'SCREEN_NOT_FOUND' ? 404 : 409;
        res.status(status).json({ error: claimed.code, message: claimed.message });
        return;
      }

      emitSseEvent(claimed.screen.workspaceId, 'screens_updated', { screen: claimed.screen });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        screen: claimed.screen,
        screenToken: claimed.screenToken,
      });
    } catch (error) {
      console.error('[signage] Claim screen failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to pair signage screen' });
    }
  });

  router.get('/player/manifest', async (req: Request, res: Response) => {
    const screen = await requirePlayerScreen(req, res);
    if (!screen) return;
    try {
      const manifest = await store.getPlayerManifest(screen.id);
      if (!manifest) {
        res.status(404).json({ error: 'SCREEN_NOT_FOUND', message: 'Screen no longer registered' });
        return;
      }

      const items = (manifest.playlist?.items ?? []).map((item) => ({
        ...item,
        contentPath: item.media ? `/api/signage/media/${item.media.id}/content` : null,
      }));

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        screen: manifest.screen,
        playlist: manifest.playlist
          ? {
              ...manifest.playlist,
              items,
            }
          : null,
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[signage] Load manifest failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load player manifest' });
    }
  });

  router.post('/player/sync', async (req: Request, res: Response) => {
    const screen = await requirePlayerScreen(req, res);
    if (!screen) return;
    try {
      const body = (req.body ?? {}) as {
        playbackState?: unknown;
        currentItemId?: unknown;
        currentMediaId?: unknown;
        currentMediaName?: unknown;
        currentPositionSec?: unknown;
        totalPlaybackSec?: unknown;
        lastSyncError?: unknown;
        cacheItems?: unknown;
      };

      const playbackState: SignagePlaybackState =
        typeof body.playbackState === 'string' &&
        ALLOWED_PLAYBACK_STATES.has(body.playbackState as SignagePlaybackState)
          ? (body.playbackState as SignagePlaybackState)
          : 'idle';

      const cacheItemsRaw = Array.isArray(body.cacheItems) ? body.cacheItems : [];
      const cacheItems = cacheItemsRaw
        .map((entry) => entry as Record<string, unknown> | null)
        .filter((e): e is Record<string, unknown> => Boolean(e && typeof e.mediaId === 'string'))
        .map((e) => ({
          mediaId: String(e.mediaId),
          status:
            typeof e.status === 'string' &&
            ALLOWED_CACHE_STATUSES.has(e.status as SignageCacheItemStatus)
              ? (e.status as SignageCacheItemStatus)
              : 'pending',
          sha256: typeof e.sha256 === 'string' ? e.sha256 : '',
          bytesCached: typeof e.bytesCached === 'number' && Number.isFinite(e.bytesCached) ? e.bytesCached : 0,
          bytesTotal: typeof e.bytesTotal === 'number' && Number.isFinite(e.bytesTotal) ? e.bytesTotal : 0,
          errorMessage: typeof e.errorMessage === 'string' ? e.errorMessage.slice(0, 240) : null,
        }));

      const updated = await store.recordPlayerSync({
        screenId: screen.id,
        payload: {
          playbackState,
          currentItemId: typeof body.currentItemId === 'string' ? body.currentItemId : null,
          currentMediaId: typeof body.currentMediaId === 'string' ? body.currentMediaId : null,
          currentMediaName:
            typeof body.currentMediaName === 'string'
              ? sanitizeDisplayName(body.currentMediaName, '')
              : null,
          currentPositionSec:
            typeof body.currentPositionSec === 'number' && Number.isFinite(body.currentPositionSec)
              ? body.currentPositionSec
              : 0,
          totalPlaybackSec:
            typeof body.totalPlaybackSec === 'number' && Number.isFinite(body.totalPlaybackSec)
              ? body.totalPlaybackSec
              : 0,
          lastSyncError:
            typeof body.lastSyncError === 'string' ? body.lastSyncError.slice(0, 240) : null,
          cacheItems,
        },
      });

      if (!updated) {
        res.status(404).json({ error: 'SCREEN_NOT_FOUND', message: 'Screen not found' });
        return;
      }

      emitSseEvent(updated.workspaceId, 'screens_updated', { screen: updated });
      res.status(200).json({ screen: updated });
    } catch (error) {
      console.error('[signage] Player sync failed:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to record player sync status' });
    }
  });

  return {
    router,
    shutdown: () => {
      clearInterval(keepAliveTimer);
      for (const sub of subscribers) {
        if (!sub.res.writableEnded) {
          sub.res.end();
        }
      }
      subscribers.clear();
    },
  };
}
