import type { CastoraPlatform } from '../types/protocol';
import type {
  SignageCacheItemStatus,
  SignageMediaAsset,
  SignagePlaybackCommand,
  SignagePlaybackState,
  SignagePlayerManifest,
  SignagePlaylist,
  SignageScreen,
  SignageScreenCredentials,
  SignageStorageStatus,
  SignageWorkspaceCredentials,
} from '../types/signage';
import type { DetectedDeviceType } from '../types/studio';

const WORKSPACE_ID_KEY = 'castora.signage.workspaceId';
const HOST_TOKEN_KEY = 'castora.signage.hostToken';
const RECOVERY_CODE_KEY = 'castora.signage.recoveryCode';

const SCREEN_ID_KEY = 'castora.signage.screenId';
const SCREEN_CODE_KEY = 'castora.signage.screenCode';
const SCREEN_TOKEN_KEY = 'castora.signage.screenToken';

export interface ProbedFileMetadata {
  fileName: string;
  displayName: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

export function loadSavedWorkspaceCredentials(): {
  workspaceId: string | null;
  hostToken: string | null;
  recoveryCode: string | null;
} {
  if (typeof window === 'undefined') {
    return { workspaceId: null, hostToken: null, recoveryCode: null };
  }
  try {
    return {
      workspaceId: window.localStorage.getItem(WORKSPACE_ID_KEY),
      hostToken: window.localStorage.getItem(HOST_TOKEN_KEY),
      recoveryCode: window.localStorage.getItem(RECOVERY_CODE_KEY),
    };
  } catch {
    return { workspaceId: null, hostToken: null, recoveryCode: null };
  }
}

export function saveWorkspaceCredentials(creds: {
  workspaceId: string;
  hostToken: string;
  recoveryCode?: string | null;
}): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WORKSPACE_ID_KEY, creds.workspaceId);
    window.localStorage.setItem(HOST_TOKEN_KEY, creds.hostToken);
    if (creds.recoveryCode) {
      window.localStorage.setItem(RECOVERY_CODE_KEY, creds.recoveryCode);
    }
  } catch {
    // Ignore storage write errors
  }
}

export function loadSavedScreenCredentials(): SignageScreenCredentials | null {
  if (typeof window === 'undefined') return null;
  try {
    const screenId = window.localStorage.getItem(SCREEN_ID_KEY);
    const screenCode = window.localStorage.getItem(SCREEN_CODE_KEY);
    const screenToken = window.localStorage.getItem(SCREEN_TOKEN_KEY);
    if (screenId && screenCode && screenToken) {
      return { screenId, screenCode, screenToken };
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

export function saveScreenCredentials(creds: SignageScreenCredentials | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!creds) {
      window.localStorage.removeItem(SCREEN_ID_KEY);
      window.localStorage.removeItem(SCREEN_CODE_KEY);
      window.localStorage.removeItem(SCREEN_TOKEN_KEY);
      return;
    }
    window.localStorage.setItem(SCREEN_ID_KEY, creds.screenId);
    window.localStorage.setItem(SCREEN_CODE_KEY, creds.screenCode);
    window.localStorage.setItem(SCREEN_TOKEN_KEY, creds.screenToken);
  } catch {
    // Ignore storage write errors
  }
}

async function apiJson<T>(
  url: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    cache: 'no-store',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = (await response.json()) as T & { message?: string; error?: string };
  if (!response.ok) {
    throw new Error(data.message ?? `Request failed (HTTP ${response.status})`);
  }
  return data;
}

export async function fetchSignageStorageStatus(): Promise<SignageStorageStatus> {
  return apiJson<SignageStorageStatus>('/api/signage/storage-status');
}

export async function bootstrapSignageWorkspace(params?: {
  existingHostToken?: string | null;
  accessKey?: string;
}): Promise<SignageWorkspaceCredentials> {
  const result = await apiJson<SignageWorkspaceCredentials>('/api/signage/workspace/bootstrap', {
    method: 'POST',
    token: params?.existingHostToken ?? undefined,
    body: params?.accessKey ? { accessKey: params.accessKey } : {},
  });
  saveWorkspaceCredentials(result);
  return result;
}

export async function recoverSignageWorkspace(params: {
  workspaceId: string;
  recoveryCode: string;
}): Promise<SignageWorkspaceCredentials> {
  const result = await apiJson<SignageWorkspaceCredentials>('/api/signage/workspace/recover', {
    method: 'POST',
    body: params,
  });
  saveWorkspaceCredentials(result);
  return result;
}

export async function fetchSignageMedia(hostToken: string): Promise<{
  items: SignageMediaAsset[];
  storageStatus: SignageStorageStatus;
}> {
  return apiJson('/api/signage/media', { token: hostToken });
}

export async function probeMediaFileMetadata(file: File): Promise<ProbedFileMetadata> {
  const fallback: ProbedFileMetadata = {
    fileName: file.name,
    displayName: file.name,
    durationSec: null,
    width: null,
    height: null,
  };
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return fallback;
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      const dims = await new Promise<{ width: number; height: number } | null>((resolve) => {
        const img = new Image();
        const timer = window.setTimeout(() => resolve(null), 4000);
        img.onload = () => {
          window.clearTimeout(timer);
          resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
        };
        img.onerror = () => {
          window.clearTimeout(timer);
          resolve(null);
        };
        img.src = objectUrl;
      });
      return {
        ...fallback,
        width: dims?.width || null,
        height: dims?.height || null,
      };
    }

    if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
      const meta = await new Promise<{
        durationSec: number | null;
        width: number | null;
        height: number | null;
      }>((resolve) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        const timer = window.setTimeout(
          () => resolve({ durationSec: null, width: null, height: null }),
          5000
        );
        video.onloadedmetadata = () => {
          window.clearTimeout(timer);
          resolve({
            durationSec:
              Number.isFinite(video.duration) && video.duration > 0
                ? Math.round(video.duration * 100) / 100
                : null,
            width: video.videoWidth || null,
            height: video.videoHeight || null,
          });
        };
        video.onerror = () => {
          window.clearTimeout(timer);
          resolve({ durationSec: null, width: null, height: null });
        };
        video.src = objectUrl;
      });
      return { ...fallback, ...meta };
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return fallback;
}

export async function uploadSignageMediaFiles(params: {
  hostToken: string;
  files: File[];
  metadata: ProbedFileMetadata[];
  onProgress?: (pct: number) => void;
}): Promise<{
  uploaded: SignageMediaAsset[];
  errors: Array<{ fileName: string; code: string; message: string }>;
}> {
  const formData = new FormData();
  formData.append('metadata', JSON.stringify(params.metadata));
  for (const file of params.files) {
    formData.append('files', file, file.name);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/signage/media/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${params.hostToken}`);

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && params.onProgress) {
        params.onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
      }
    };

    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText) as {
          uploaded?: SignageMediaAsset[];
          errors?: Array<{ fileName: string; code: string; message: string }>;
          message?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            uploaded: parsed.uploaded ?? [],
            errors: parsed.errors ?? [],
          });
        } else {
          reject(new Error(parsed.message ?? `Upload failed (HTTP ${xhr.status})`));
        }
      } catch {
        reject(new Error(`Upload failed with HTTP ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during media upload'));
    xhr.send(formData);
  });
}

export async function renameSignageMedia(params: {
  hostToken: string;
  mediaId: string;
  displayName: string;
}): Promise<SignageMediaAsset> {
  const res = await apiJson<{ media: SignageMediaAsset }>(
    `/api/signage/media/${encodeURIComponent(params.mediaId)}`,
    {
      method: 'PATCH',
      token: params.hostToken,
      body: { displayName: params.displayName },
    }
  );
  return res.media;
}

export async function deleteSignageMedia(params: {
  hostToken: string;
  mediaId: string;
}): Promise<void> {
  await apiJson(`/api/signage/media/${encodeURIComponent(params.mediaId)}`, {
    method: 'DELETE',
    token: params.hostToken,
  });
}

export function buildAuthenticatedMediaUrl(mediaId: string, token: string): string {
  return `/api/signage/media/${encodeURIComponent(mediaId)}/content?token=${encodeURIComponent(token)}`;
}

export async function fetchSignagePlaylists(hostToken: string): Promise<SignagePlaylist[]> {
  const res = await apiJson<{ playlists: SignagePlaylist[] }>('/api/signage/playlists', {
    token: hostToken,
  });
  return res.playlists;
}

export interface PlaylistItemPayload {
  id?: string;
  mediaId: string;
  imageDurationSec: number;
  repeatCount: number;
  playUntilEnd: boolean;
}

export async function createSignagePlaylist(params: {
  hostToken: string;
  name: string;
  description?: string;
  loopPlaylist: boolean;
  items: PlaylistItemPayload[];
}): Promise<SignagePlaylist> {
  const res = await apiJson<{ playlist: SignagePlaylist }>('/api/signage/playlists', {
    method: 'POST',
    token: params.hostToken,
    body: {
      name: params.name,
      description: params.description ?? '',
      loopPlaylist: params.loopPlaylist,
      items: params.items,
    },
  });
  return res.playlist;
}

export async function updateSignagePlaylist(params: {
  hostToken: string;
  playlistId: string;
  name?: string;
  description?: string;
  loopPlaylist?: boolean;
  items?: PlaylistItemPayload[];
}): Promise<SignagePlaylist> {
  const res = await apiJson<{ playlist: SignagePlaylist }>(
    `/api/signage/playlists/${encodeURIComponent(params.playlistId)}`,
    {
      method: 'PATCH',
      token: params.hostToken,
      body: {
        name: params.name,
        description: params.description,
        loopPlaylist: params.loopPlaylist,
        items: params.items,
      },
    }
  );
  return res.playlist;
}

export async function deleteSignagePlaylist(params: {
  hostToken: string;
  playlistId: string;
}): Promise<void> {
  await apiJson(`/api/signage/playlists/${encodeURIComponent(params.playlistId)}`, {
    method: 'DELETE',
    token: params.hostToken,
  });
}

export async function fetchSignageScreens(hostToken: string): Promise<SignageScreen[]> {
  const res = await apiJson<{ screens: SignageScreen[] }>('/api/signage/screens', {
    token: hostToken,
  });
  return res.screens;
}

export async function createSignageScreen(params: {
  hostToken: string;
  name: string;
  platform?: CastoraPlatform;
  deviceType?: DetectedDeviceType;
  slotNumber?: number;
  deviceId?: string | null;
  pairedFromRoomId?: string | null;
}): Promise<SignageScreen> {
  const res = await apiJson<{ screen: SignageScreen }>('/api/signage/screens', {
    method: 'POST',
    token: params.hostToken,
    body: {
      name: params.name,
      platform: params.platform ?? 'android-tv',
      deviceType: params.deviceType ?? 'TV',
      ...(typeof params.slotNumber === 'number' ? { slotNumber: params.slotNumber } : {}),
      deviceId: params.deviceId ?? null,
      pairedFromRoomId: params.pairedFromRoomId ?? null,
    },
  });
  return res.screen;
}

export async function updateSignageScreen(params: {
  hostToken: string;
  screenId: string;
  name?: string;
  regenerateCode?: boolean;
}): Promise<SignageScreen> {
  const res = await apiJson<{ screen: SignageScreen }>(
    `/api/signage/screens/${encodeURIComponent(params.screenId)}`,
    {
      method: 'PATCH',
      token: params.hostToken,
      body: {
        name: params.name,
        regenerateCode: params.regenerateCode,
      },
    }
  );
  return res.screen;
}

export async function deleteSignageScreen(params: {
  hostToken: string;
  screenId: string;
}): Promise<void> {
  await apiJson(`/api/signage/screens/${encodeURIComponent(params.screenId)}`, {
    method: 'DELETE',
    token: params.hostToken,
  });
}

export async function assignSignagePlaylist(params: {
  hostToken: string;
  screenIds: string[];
  playlistId: string | null;
  autoPlay?: boolean;
}): Promise<SignageScreen[]> {
  const res = await apiJson<{ screens: SignageScreen[] }>('/api/signage/screens/assign', {
    method: 'POST',
    token: params.hostToken,
    body: {
      screenIds: params.screenIds,
      playlistId: params.playlistId,
      autoPlay: params.autoPlay ?? true,
    },
  });
  return res.screens;
}

export async function controlSignageScreens(params: {
  hostToken: string;
  screenIds: string[];
  command: SignagePlaybackCommand;
  jumpToItemId?: string | null;
}): Promise<SignageScreen[]> {
  const res = await apiJson<{ screens: SignageScreen[] }>('/api/signage/screens/control-bulk', {
    method: 'POST',
    token: params.hostToken,
    body: {
      screenIds: params.screenIds,
      command: params.command,
      jumpToItemId: params.jumpToItemId ?? null,
    },
  });
  return res.screens;
}

export async function claimSignageScreen(params: {
  screenCode: string;
  deviceId?: string;
  deviceName?: string;
  platform?: CastoraPlatform;
  deviceType?: DetectedDeviceType;
}): Promise<{ screen: SignageScreen; screenToken: string }> {
  const res = await apiJson<{ screen: SignageScreen; screenToken: string }>(
    '/api/signage/player/claim',
    {
      method: 'POST',
      body: params,
    }
  );
  saveScreenCredentials({
    screenId: res.screen.id,
    screenCode: res.screen.screenCode,
    screenToken: res.screenToken,
  });
  return res;
}

export async function fetchSignagePlayerManifest(
  screenToken: string
): Promise<SignagePlayerManifest> {
  return apiJson<SignagePlayerManifest>('/api/signage/player/manifest', {
    token: screenToken,
  });
}

export async function syncSignagePlayerTelemetry(
  screenToken: string,
  payload: {
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
): Promise<SignageScreen> {
  const res = await apiJson<{ screen: SignageScreen }>('/api/signage/player/sync', {
    method: 'POST',
    token: screenToken,
    body: payload,
  });
  return res.screen;
}

export function subscribeSignageEvents(
  token: string,
  onEvent: (event: string, data: unknown) => void
): () => void {
  const controller = new AbortController();
  let stopped = false;

  const connect = async () => {
    let backoffMs = 1500;
    while (!stopped) {
      try {
        const res = await fetch('/api/signage/events', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE HTTP ${res.status}`);
        }
        backoffMs = 1500;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = 'message';
        let dataLines: string[] = [];

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (line === '') {
              if (dataLines.length > 0) {
                const payloadText = dataLines.join('\n');
                try {
                  onEvent(currentEvent, JSON.parse(payloadText));
                } catch {
                  onEvent(currentEvent, payloadText);
                }
              }
              currentEvent = 'message';
              dataLines = [];
            } else if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trim());
            }
          }
        }
      } catch {
        if (stopped) break;
      }
      const jitterMs = Math.round(Math.random() * 800);
      await new Promise((r) => setTimeout(r, backoffMs + jitterMs));
      backoffMs = Math.min(15_000, Math.round(backoffMs * 1.5));
    }
  };

  void connect();

  return () => {
    stopped = true;
    controller.abort();
  };
}
