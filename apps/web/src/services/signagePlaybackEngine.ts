import type { SignagePlaybackState, SignagePlaylist, SignagePlaylistItem } from '../types/signage';

export interface SignagePlaybackSnapshot {
  status: SignagePlaybackState;
  playlistId: string | null;
  playlistName: string | null;
  currentItemIndex: number;
  currentItem: SignagePlaylistItem | null;
  currentItemRepeat: number;
  itemElapsedSec: number;
  itemTargetDurationSec: number | null;
  totalPlaybackSec: number;
  loopCount: number;
  errorCount: number;
  consecutiveErrors: number;
  lastError: string | null;
}

export class SignagePlaybackEngine {
  private playlist: SignagePlaylist | null = null;
  private status: SignagePlaybackState = 'idle';
  private currentItemIndex = 0;
  private currentItemRepeat = 1;
  private itemElapsedSec = 0;
  private totalPlaybackSec = 0;
  private loopCount = 0;
  private errorCount = 0;
  private consecutiveErrors = 0;
  private lastError: string | null = null;
  private lastTickMs: number | null = null;
  private readonly nowFn: () => number;
  private listeners = new Set<(snap: SignagePlaybackSnapshot) => void>();

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  subscribe(listener: (snap: SignagePlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  getSnapshot(): SignagePlaybackSnapshot {
    const currentItem =
      this.playlist && this.playlist.items.length > 0
        ? (this.playlist.items[this.currentItemIndex] ?? null)
        : null;
    const isImage = currentItem?.media?.mediaKind === 'image';
    const targetDuration = isImage
      ? currentItem.imageDurationSec
      : (currentItem?.media?.durationSec ?? null);

    return {
      status: this.status,
      playlistId: this.playlist?.id ?? null,
      playlistName: this.playlist?.name ?? null,
      currentItemIndex: this.currentItemIndex,
      currentItem,
      currentItemRepeat: this.currentItemRepeat,
      itemElapsedSec: Math.round(this.itemElapsedSec * 10) / 10,
      itemTargetDurationSec: targetDuration,
      totalPlaybackSec: Math.round(this.totalPlaybackSec * 10) / 10,
      loopCount: this.loopCount,
      errorCount: this.errorCount,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
    };
  }

  setPlaylist(
    playlist: SignagePlaylist | null,
    command: 'play' | 'pause' | 'stop' = 'play',
    jumpToItemId?: string | null
  ): void {
    const previousPlaylistId = this.playlist?.id ?? null;
    const prevCurrentId = this.playlist?.items[this.currentItemIndex]?.id ?? null;

    this.playlist = playlist;
    if (!playlist || playlist.items.length === 0) {
      this.currentItemIndex = 0;
      this.currentItemRepeat = 1;
      this.itemElapsedSec = 0;
      this.status = command === 'stop' ? 'stopped' : 'idle';
      this.lastTickMs = null;
      this.emit();
      return;
    }

    if (jumpToItemId) {
      const idx = playlist.items.findIndex((i) => i.id === jumpToItemId);
      if (idx >= 0) {
        this.currentItemIndex = idx;
        this.currentItemRepeat = 1;
        this.itemElapsedSec = 0;
      }
    } else if (previousPlaylistId === playlist.id && prevCurrentId) {
      const preservedIdx = playlist.items.findIndex((i) => i.id === prevCurrentId);
      this.currentItemIndex = preservedIdx >= 0 ? preservedIdx : 0;
      if (preservedIdx < 0) {
        this.currentItemRepeat = 1;
        this.itemElapsedSec = 0;
      }
    } else {
      this.currentItemIndex = 0;
      this.currentItemRepeat = 1;
      this.itemElapsedSec = 0;
      this.loopCount = 0;
    }

    this.applyCommand(command);
  }

  applyCommand(command: 'play' | 'pause' | 'stop'): void {
    if (!this.playlist || this.playlist.items.length === 0) {
      this.status = command === 'stop' ? 'stopped' : 'idle';
      this.lastTickMs = null;
      this.emit();
      return;
    }

    if (command === 'pause') {
      this.status = 'paused';
      this.lastTickMs = null;
    } else if (command === 'stop') {
      this.status = 'stopped';
      this.currentItemIndex = 0;
      this.currentItemRepeat = 1;
      this.itemElapsedSec = 0;
      this.lastTickMs = null;
    } else {
      this.status = 'playing';
      this.lastTickMs = this.nowFn();
    }
    this.emit();
  }

  advance(trigger: 'timer' | 'video_ended' | 'manual' | 'error_skip' = 'manual'): void {
    if (!this.playlist || this.playlist.items.length === 0) {
      this.status = 'idle';
      this.emit();
      return;
    }

    const currentItem = this.playlist.items[this.currentItemIndex];
    const targetRepeat = Math.max(1, currentItem?.repeatCount ?? 1);

    if (trigger !== 'error_skip' && trigger !== 'manual' && this.currentItemRepeat < targetRepeat) {
      this.currentItemRepeat += 1;
      this.itemElapsedSec = 0;
      this.lastTickMs = this.nowFn();
      this.emit();
      return;
    }

    this.currentItemRepeat = 1;
    this.itemElapsedSec = 0;

    if (this.currentItemIndex + 1 < this.playlist.items.length) {
      this.currentItemIndex += 1;
      this.lastTickMs = this.nowFn();
      this.emit();
      return;
    }

    if (this.playlist.loopPlaylist) {
      this.currentItemIndex = 0;
      this.loopCount += 1;
      this.lastTickMs = this.nowFn();
      this.emit();
      return;
    }

    this.status = 'stopped';
    this.currentItemIndex = 0;
    this.lastTickMs = null;
    this.emit();
  }

  tick(explicitNowMs?: number): void {
    if (this.status !== 'playing' || !this.playlist || this.playlist.items.length === 0) {
      return;
    }

    const now = typeof explicitNowMs === 'number' ? explicitNowMs : this.nowFn();
    const prev = this.lastTickMs ?? now;
    const deltaSec = Math.max(0, (now - prev) / 1000);
    this.lastTickMs = now;

    this.itemElapsedSec += deltaSec;
    this.totalPlaybackSec += deltaSec;

    const currentItem = this.playlist.items[this.currentItemIndex];
    if (currentItem?.media?.mediaKind === 'image') {
      const targetSec = Math.max(1, currentItem.imageDurationSec || 10);
      if (this.itemElapsedSec >= targetSec) {
        this.advance('timer');
        return;
      }
    }

    this.emit();
  }

  notifyVideoTimeUpdate(positionSec: number): void {
    if (this.status !== 'playing') return;
    if (Number.isFinite(positionSec) && positionSec >= 0) {
      this.itemElapsedSec = positionSec;
      this.consecutiveErrors = 0;
      this.lastError = null;
      this.emit();
    }
  }

  notifyVideoEnded(): void {
    if (this.status !== 'playing') return;
    this.consecutiveErrors = 0;
    this.lastError = null;
    this.advance('video_ended');
  }

  notifyMediaPlaybackSuccess(): void {
    this.consecutiveErrors = 0;
    this.lastError = null;
  }

  notifyMediaError(message: string): void {
    this.errorCount += 1;
    this.consecutiveErrors += 1;
    this.lastError = message;

    if (!this.playlist || this.playlist.items.length === 0) {
      this.status = 'error';
      this.emit();
      return;
    }

    if (this.playlist.items.length > 1 && this.consecutiveErrors < this.playlist.items.length * 2) {
      this.advance('error_skip');
      return;
    }

    // Even if all items errored once, keep state recoverable so timer/sync can retry
    if (this.consecutiveErrors >= this.playlist.items.length * 3) {
      this.status = 'error';
    }
    this.emit();
  }
}
