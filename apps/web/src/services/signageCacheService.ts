import type {
  SignageCacheItemStatus,
  SignageMediaAsset,
  SignagePlayerManifest,
  SignagePlaylistItem,
} from '../types/signage';

const DB_NAME = 'castora-signage-offline-v1';
const DB_VERSION = 1;
const STORE_MEDIA = 'media_blobs';
const STORE_MANIFESTS = 'manifests';

export interface CachedMediaRecord {
  mediaId: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  downloadedAt: string;
  blob: Blob;
}

export interface StoragePersistenceReport {
  persisted: boolean;
  supported: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  engine: 'indexeddb' | 'memory';
}

export interface CacheSyncItemState {
  mediaId: string;
  status: SignageCacheItemStatus;
  sha256: string;
  bytesCached: number;
  bytesTotal: number;
  errorMessage?: string | null;
}

const memoryBlobFallback = new Map<string, CachedMediaRecord>();
const memoryManifestFallback = new Map<string, SignagePlayerManifest>();

function openOfflineDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          db.createObjectStore(STORE_MEDIA, { keyPath: 'mediaId' });
        }
        if (!db.objectStoreNames.contains(STORE_MANIFESTS)) {
          db.createObjectStore(STORE_MANIFESTS, { keyPath: 'screenId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function requestPersistentBrowserStorage(): Promise<StoragePersistenceReport> {
  const hasIdb = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
  const engine: 'indexeddb' | 'memory' = hasIdb ? 'indexeddb' : 'memory';

  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { persisted: false, supported: false, usageBytes: null, quotaBytes: null, engine };
  }

  let persisted = false;
  try {
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted();
    }
    if (!persisted && typeof navigator.storage.persist === 'function') {
      persisted = await navigator.storage.persist();
    }
  } catch {
    persisted = false;
  }

  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    if (typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      usageBytes = typeof est.usage === 'number' ? est.usage : null;
      quotaBytes = typeof est.quota === 'number' ? est.quota : null;
    }
  } catch {
    // Ignore quota probe errors
  }

  return {
    persisted,
    supported: true,
    usageBytes,
    quotaBytes,
    engine,
  };
}

export async function saveOfflineManifest(
  screenId: string,
  manifest: SignagePlayerManifest
): Promise<void> {
  memoryManifestFallback.set(screenId, manifest);
  const db = await openOfflineDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_MANIFESTS, 'readwrite');
      tx.objectStore(STORE_MANIFESTS).put({ screenId, manifest, savedAt: new Date().toISOString() });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function loadOfflineManifest(
  screenId: string
): Promise<SignagePlayerManifest | null> {
  const db = await openOfflineDb();
  if (!db) {
    return memoryManifestFallback.get(screenId) ?? null;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_MANIFESTS, 'readonly');
      const req = tx.objectStore(STORE_MANIFESTS).get(screenId);
      req.onsuccess = () => {
        const res = req.result as { manifest?: SignagePlayerManifest } | undefined;
        db.close();
        resolve(res?.manifest ?? memoryManifestFallback.get(screenId) ?? null);
      };
      req.onerror = () => {
        db.close();
        resolve(memoryManifestFallback.get(screenId) ?? null);
      };
    } catch {
      db.close();
      resolve(memoryManifestFallback.get(screenId) ?? null);
    }
  });
}

export async function getCachedMediaRecord(mediaId: string): Promise<CachedMediaRecord | null> {
  const db = await openOfflineDb();
  if (!db) {
    return memoryBlobFallback.get(mediaId) ?? null;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_MEDIA, 'readonly');
      const req = tx.objectStore(STORE_MEDIA).get(mediaId);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as CachedMediaRecord | undefined) ?? memoryBlobFallback.get(mediaId) ?? null);
      };
      req.onerror = () => {
        db.close();
        resolve(memoryBlobFallback.get(mediaId) ?? null);
      };
    } catch {
      db.close();
      resolve(memoryBlobFallback.get(mediaId) ?? null);
    }
  });
}

export async function putCachedMediaRecord(record: CachedMediaRecord): Promise<void> {
  memoryBlobFallback.set(record.mediaId, record);
  const db = await openOfflineDb();
  if (!db) return;

  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_MEDIA, 'readwrite');
      tx.objectStore(STORE_MEDIA).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(new Error('Failed to write media blob to IndexedDB'));
      };
    } catch (err) {
      db.close();
      reject(err instanceof Error ? err : new Error('IndexedDB write failed'));
    }
  });
}

export async function pruneUnusedCachedMedia(activeMediaIds: Set<string>): Promise<void> {
  for (const key of memoryBlobFallback.keys()) {
    if (!activeMediaIds.has(key)) {
      memoryBlobFallback.delete(key);
    }
  }
  const db = await openOfflineDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_MEDIA, 'readwrite');
      const store = tx.objectStore(STORE_MEDIA);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        for (const key of keysReq.result) {
          if (typeof key === 'string' && !activeMediaIds.has(key)) {
            store.delete(key);
          }
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function computeBlobSha256(blob: Blob): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return null;
  }
  try {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

export class ObjectUrlPool {
  private readonly urls = new Map<string, { sha256: string; url: string }>();

  async ensureUrl(media: SignageMediaAsset): Promise<string | null> {
    const existing = this.urls.get(media.id);
    if (existing && existing.sha256 === media.sha256) {
      return existing.url;
    }

    const cached = await getCachedMediaRecord(media.id);
    if (!cached || cached.sha256 !== media.sha256) {
      return null;
    }

    if (existing) {
      URL.revokeObjectURL(existing.url);
    }
    const url = URL.createObjectURL(cached.blob);
    this.urls.set(media.id, { sha256: cached.sha256, url });
    return url;
  }

  retainOnly(activeMediaIds: Set<string>): void {
    for (const [mediaId, entry] of this.urls.entries()) {
      if (!activeMediaIds.has(mediaId)) {
        URL.revokeObjectURL(entry.url);
        this.urls.delete(mediaId);
      }
    }
  }

  disposeAll(): void {
    for (const entry of this.urls.values()) {
      URL.revokeObjectURL(entry.url);
    }
    this.urls.clear();
  }
}

export async function syncPlaylistMediaCache(params: {
  items: SignagePlaylistItem[];
  screenToken: string;
  signal?: AbortSignal;
  onProgress?: (states: CacheSyncItemState[]) => void;
}): Promise<CacheSyncItemState[]> {
  const uniqueAssets = new Map<string, SignageMediaAsset>();
  for (const item of params.items) {
    if (item.media) {
      uniqueAssets.set(item.media.id, item.media);
    }
  }

  const assets = Array.from(uniqueAssets.values());
  const stateMap = new Map<string, CacheSyncItemState>();

  for (const asset of assets) {
    const cached = await getCachedMediaRecord(asset.id);
    if (cached && cached.sha256 === asset.sha256 && cached.sizeBytes === asset.sizeBytes) {
      stateMap.set(asset.id, {
        mediaId: asset.id,
        status: 'cached',
        sha256: asset.sha256,
        bytesCached: asset.sizeBytes,
        bytesTotal: asset.sizeBytes,
      });
    } else {
      stateMap.set(asset.id, {
        mediaId: asset.id,
        status: 'pending',
        sha256: asset.sha256,
        bytesCached: 0,
        bytesTotal: asset.sizeBytes,
      });
    }
  }

  params.onProgress?.(Array.from(stateMap.values()));

  for (const asset of assets) {
    if (params.signal?.aborted) break;
    const current = stateMap.get(asset.id);
    if (current?.status === 'cached') {
      continue;
    }

    stateMap.set(asset.id, {
      mediaId: asset.id,
      status: 'downloading',
      sha256: asset.sha256,
      bytesCached: 0,
      bytesTotal: asset.sizeBytes,
    });
    params.onProgress?.(Array.from(stateMap.values()));

    let attemptError: Error | null = null;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (params.signal?.aborted) break;
      try {
        const res = await fetch(`/api/signage/media/${encodeURIComponent(asset.id)}/content`, {
          headers: {
            Authorization: `Bearer ${params.screenToken}`,
          },
          signal: params.signal,
        });

        if ((res.status === 503 || res.status === 429) && attempt < maxAttempts) {
          const retryAfterSec = Number(res.headers.get('retry-after') ?? '2');
          const baseWait = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 2000;
          const jitter = Math.round(Math.random() * 1200);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(10_000, baseWait + jitter));
            params.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} downloading ${asset.displayName}`);
        }

        const chunks: BlobPart[] = [];
        let received = 0;

        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              received += value.byteLength;
              stateMap.set(asset.id, {
                mediaId: asset.id,
                status: 'downloading',
                sha256: asset.sha256,
                bytesCached: received,
                bytesTotal: asset.sizeBytes,
              });
              params.onProgress?.(Array.from(stateMap.values()));
            }
          }
        } else {
          const buf = await res.arrayBuffer();
          chunks.push(buf);
          received = buf.byteLength;
        }

        const blob = new Blob(chunks, { type: asset.mimeType });
        const actualSha = await computeBlobSha256(blob);
        if (actualSha && asset.sha256 && actualSha !== asset.sha256) {
          throw new Error(`Checksum mismatch for ${asset.displayName}`);
        }

        await putCachedMediaRecord({
          mediaId: asset.id,
          sha256: asset.sha256,
          mimeType: asset.mimeType,
          sizeBytes: blob.size,
          downloadedAt: new Date().toISOString(),
          blob,
        });

        stateMap.set(asset.id, {
          mediaId: asset.id,
          status: 'cached',
          sha256: asset.sha256,
          bytesCached: blob.size,
          bytesTotal: asset.sizeBytes,
        });
        params.onProgress?.(Array.from(stateMap.values()));
        attemptError = null;
        break;
      } catch (error) {
        if (params.signal?.aborted) {
          attemptError = null;
          break;
        }
        attemptError = error instanceof Error ? error : new Error('Download failed');
        if (attempt < maxAttempts) {
          const waitMs = 1500 * attempt + Math.round(Math.random() * 1000);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            params.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
      }
    }

    if (attemptError && !params.signal?.aborted) {
      stateMap.set(asset.id, {
        mediaId: asset.id,
        status: 'error',
        sha256: asset.sha256,
        bytesCached: 0,
        bytesTotal: asset.sizeBytes,
        errorMessage: attemptError.message,
      });
      params.onProgress?.(Array.from(stateMap.values()));
    }
  }

  await pruneUnusedCachedMedia(new Set(assets.map((a) => a.id)));
  return Array.from(stateMap.values());
}
