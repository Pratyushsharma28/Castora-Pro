import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { SignageStorageProvider } from './signageTypes.ts';

export interface PutObjectParams {
  key: string;
  filePath: string;
  contentType: string;
  contentLength: number;
  sha256: string;
}

export interface GetObjectRangeParams {
  key: string;
  rangeStart?: number;
  rangeEnd?: number;
}

export interface ObjectStreamResult {
  stream: Readable;
  contentLength: number;
  totalSize: number;
  contentType?: string;
  etag?: string;
  isPartial: boolean;
  rangeStart: number;
  rangeEnd: number;
}

export interface SignageObjectStorage {
  readonly provider: SignageStorageProvider;
  readonly persistent: boolean;
  readonly bucketName: string | null;
  readonly warning: string | null;
  putObjectFromFile(params: PutObjectParams): Promise<void>;
  getObjectStream(params: GetObjectRangeParams): Promise<ObjectStreamResult | null>;
  deleteObject(key: string): Promise<void>;
}

function sanitizeStorageKey(key: string): string {
  const cleaned = key.replace(/^\/+/, '').replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('..') || /[\u0000-\u001F\u007F]/.test(cleaned)) {
    throw new Error('Invalid object storage key');
  }
  return cleaned;
}

class S3ObjectStorage implements SignageObjectStorage {
  readonly provider: SignageStorageProvider = 's3';
  readonly persistent = true;
  readonly bucketName: string;
  readonly warning: string | null = null;
  private readonly client: S3Client;

  constructor(config: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  }) {
    this.bucketName = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putObjectFromFile(params: PutObjectParams): Promise<void> {
    const key = sanitizeStorageKey(params.key);
    const body = fs.createReadStream(params.filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: params.contentType,
        ContentLength: params.contentLength,
        Metadata: {
          sha256: params.sha256,
        },
      })
    );
  }

  async getObjectStream(params: GetObjectRangeParams): Promise<ObjectStreamResult | null> {
    const key = sanitizeStorageKey(params.key);
    try {
      const hasRange =
        typeof params.rangeStart === 'number' &&
        Number.isFinite(params.rangeStart) &&
        params.rangeStart >= 0;
      const requestedStart = hasRange ? Math.max(0, Math.floor(params.rangeStart!)) : 0;
      const requestedEnd =
        hasRange && typeof params.rangeEnd === 'number' && Number.isFinite(params.rangeEnd)
          ? Math.max(requestedStart, Math.floor(params.rangeEnd))
          : undefined;

      const rangeHeader = hasRange
        ? `bytes=${requestedStart}-${requestedEnd !== undefined ? requestedEnd : ''}`
        : undefined;

      const obj = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        })
      );
      if (!obj.Body) {
        return null;
      }

      const contentLength = Number(obj.ContentLength ?? 0);
      let totalSize = contentLength;
      let start = 0;
      let end = Math.max(0, contentLength - 1);

      if (hasRange && typeof obj.ContentRange === 'string') {
        const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(obj.ContentRange.trim());
        if (match) {
          start = Number(match[1]);
          end = Number(match[2]);
          totalSize = match[3] === '*' ? end + 1 : Number(match[3]);
        } else {
          start = requestedStart;
          end = requestedStart + Math.max(0, contentLength - 1);
          totalSize = end + 1;
        }
      }

      return {
        stream: obj.Body as Readable,
        contentLength,
        totalSize,
        contentType: obj.ContentType,
        etag: obj.ETag,
        isPartial: hasRange,
        rangeStart: start,
        rangeEnd: end,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (status === 404) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const safeKey = sanitizeStorageKey(key);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: safeKey,
      })
    );
  }
}

class LocalDiskObjectStorage implements SignageObjectStorage {
  readonly provider: SignageStorageProvider = 'local-dev';
  readonly persistent: boolean;
  readonly bucketName: string | null = null;
  readonly warning: string | null;
  private readonly rootDir: string;

  constructor(rootDir: string, options: { explicitPersistentMount: boolean }) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.persistent = options.explicitPersistentMount;
    this.warning = options.explicitPersistentMount
      ? null
      : 'Using local workspace media directory for development/preview. Configure CASTORA_S3_* object storage env vars before deploying to Render.';
  }

  private resolveSafePath(key: string): string {
    const safeKey = sanitizeStorageKey(key);
    const resolved = path.resolve(this.rootDir, safeKey);
    const prefix = this.rootDir.endsWith(path.sep) ? this.rootDir : `${this.rootDir}${path.sep}`;
    if (!resolved.startsWith(prefix)) {
      throw new Error('Resolved path escapes object storage root directory');
    }
    return resolved;
  }

  async putObjectFromFile(params: PutObjectParams): Promise<void> {
    const destPath = this.resolveSafePath(params.key);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.copyFile(params.filePath, destPath);
  }

  async getObjectStream(params: GetObjectRangeParams): Promise<ObjectStreamResult | null> {
    const fullPath = this.resolveSafePath(params.key);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      return null;
    }
    if (!stat.isFile()) {
      return null;
    }

    const totalSize = stat.size;
    if (totalSize === 0) {
      return {
        stream: fs.createReadStream(fullPath),
        contentLength: 0,
        totalSize: 0,
        isPartial: false,
        rangeStart: 0,
        rangeEnd: 0,
      };
    }

    const hasRange =
      typeof params.rangeStart === 'number' &&
      Number.isFinite(params.rangeStart) &&
      params.rangeStart >= 0;
    const start = hasRange ? Math.min(Math.floor(params.rangeStart!), totalSize - 1) : 0;
    const end =
      hasRange && typeof params.rangeEnd === 'number' && Number.isFinite(params.rangeEnd)
        ? Math.min(Math.max(start, Math.floor(params.rangeEnd)), totalSize - 1)
        : totalSize - 1;

    return {
      stream: fs.createReadStream(fullPath, { start, end }),
      contentLength: end - start + 1,
      totalSize,
      isPartial: hasRange,
      rangeStart: start,
      rangeEnd: end,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const fullPath = this.resolveSafePath(key);
    try {
      await fs.promises.unlink(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

class UnconfiguredProductionObjectStorage implements SignageObjectStorage {
  readonly provider: SignageStorageProvider = 'unconfigured';
  readonly persistent = false;
  readonly bucketName = null;
  readonly warning =
    'Production object storage is not configured. Set CASTORA_S3_BUCKET, CASTORA_S3_ACCESS_KEY_ID, CASTORA_S3_SECRET_ACCESS_KEY (or mount a persistent disk via CASTORA_LOCAL_STORAGE_DIR) so media survives Render restarts.';

  async putObjectFromFile(): Promise<void> {
    throw new Error('STORAGE_NOT_CONFIGURED');
  }

  async getObjectStream(): Promise<ObjectStreamResult | null> {
    return null;
  }

  async deleteObject(): Promise<void> {
    // No-op when unconfigured
  }
}

export function createSignageObjectStorage(options?: {
  localStorageDir?: string;
}): SignageObjectStorage {
  const s3Bucket = process.env.CASTORA_S3_BUCKET?.trim();
  const s3AccessKey = process.env.CASTORA_S3_ACCESS_KEY_ID?.trim();
  const s3SecretKey = process.env.CASTORA_S3_SECRET_ACCESS_KEY?.trim();

  if (s3Bucket && s3AccessKey && s3SecretKey) {
    return new S3ObjectStorage({
      bucket: s3Bucket,
      region: process.env.CASTORA_S3_REGION?.trim() || 'auto',
      endpoint: process.env.CASTORA_S3_ENDPOINT?.trim() || undefined,
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
      forcePathStyle: process.env.CASTORA_S3_FORCE_PATH_STYLE === 'true',
    });
  }

  if (options?.localStorageDir) {
    return new LocalDiskObjectStorage(options.localStorageDir, {
      explicitPersistentMount: false,
    });
  }

  const explicitMountDir = process.env.CASTORA_LOCAL_STORAGE_DIR?.trim();
  if (explicitMountDir) {
    return new LocalDiskObjectStorage(explicitMountDir, {
      explicitPersistentMount: true,
    });
  }

  if (process.env.NODE_ENV === 'production') {
    return new UnconfiguredProductionObjectStorage();
  }

  return new LocalDiskObjectStorage(
    path.resolve(process.cwd(), '.castora-data', 'media-objects'),
    { explicitPersistentMount: false }
  );
}
