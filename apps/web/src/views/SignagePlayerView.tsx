import {
  AlertTriangle,
  ArrowLeft,
  HardDrive,
  Info,
  Maximize2,
  Minimize2,
  RefreshCw,
  Tv,
  Unplug,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PWAInstallButton, useOnlineStatus } from '../components/common/PWAInstallButton';
import { CastoraWakeLockController } from '../services/screenCaptureService';
import {
  claimSignageScreen,
  fetchSignagePlayerManifest,
  loadSavedScreenCredentials,
  saveScreenCredentials,
  subscribeSignageEvents,
  syncSignagePlayerTelemetry,
} from '../services/signageApiClient';
import {
  ObjectUrlPool,
  loadOfflineManifest,
  requestPersistentBrowserStorage,
  saveOfflineManifest,
  syncPlaylistMediaCache,
  type CacheSyncItemState,
  type StoragePersistenceReport,
} from '../services/signageCacheService';
import {
  SignagePlaybackEngine,
  type SignagePlaybackSnapshot,
} from '../services/signagePlaybackEngine';
import type {
  SignagePlayerManifest,
  SignageScreenCredentials,
} from '../types/signage';
import type { BrowserCapabilityReport } from '../types/studio';

interface SignagePlayerViewProps {
  deviceId: string;
  deviceName: string;
  capabilities: BrowserCapabilityReport;
  initialScreenCode?: string;
  onExitPlayer: () => void;
}

function formatClockDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function SignagePlayerView({
  deviceId,
  deviceName,
  capabilities,
  initialScreenCode = '',
  onExitPlayer,
}: SignagePlayerViewProps) {
  const isOnline = useOnlineStatus();
  const [creds, setCreds] = useState<SignageScreenCredentials | null>(() =>
    loadSavedScreenCredentials()
  );
  const [codeInput, setCodeInput] = useState<string>(
    initialScreenCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  );
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const [manifest, setManifest] = useState<SignagePlayerManifest | null>(null);
  const [cacheStates, setCacheStates] = useState<CacheSyncItemState[]>([]);
  const [storageReport, setStorageReport] = useState<StoragePersistenceReport | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  const engineRef = useRef<SignagePlaybackEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new SignagePlaybackEngine();
  }
  const [playback, setPlayback] = useState<SignagePlaybackSnapshot>(() =>
    engineRef.current!.getSnapshot()
  );

  const urlPoolRef = useRef<ObjectUrlPool>(new ObjectUrlPool());
  const [activeMediaUrl, setActiveMediaUrl] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wakeLockRef = useRef<CastoraWakeLockController>(new CastoraWakeLockController());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const hudTimerRef = useRef<number | null>(null);
  const lastVideoProgressRef = useRef<{ time: number; updatedAt: number }>({
    time: 0,
    updatedAt: Date.now(),
  });

  // Subscribe to deterministic playback engine
  useEffect(() => {
    const engine = engineRef.current!;
    return engine.subscribe((snap) => {
      setPlayback(snap);
    });
  }, []);

  // Auto-claim if initialScreenCode matches query param and not already claimed with that code
  const handleClaimCode = useCallback(
    async (rawCode: string) => {
      const normalized = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (normalized.length !== 6) {
        setPairingError('Enter a valid 6-character signage screen code.');
        return;
      }
      setPairingBusy(true);
      setPairingError(null);
      try {
        const res = await claimSignageScreen({
          screenCode: normalized,
          deviceId,
          deviceName,
          platform: capabilities.detectedPlatform,
          deviceType: capabilities.detectedDeviceType,
        });
        setCreds({
          screenId: res.screen.id,
          screenCode: res.screen.screenCode,
          screenToken: res.screenToken,
        });
      } catch (error) {
        setPairingError(error instanceof Error ? error.message : 'Unable to pair signage screen');
      } finally {
        setPairingBusy(false);
      }
    },
    [capabilities.detectedDeviceType, capabilities.detectedPlatform, deviceId, deviceName]
  );

  useEffect(() => {
    if (
      initialScreenCode &&
      initialScreenCode.length === 6 &&
      (!creds || creds.screenCode !== initialScreenCode)
    ) {
      void handleClaimCode(initialScreenCode);
    }
  }, [creds, handleClaimCode, initialScreenCode]);

  // Persistent browser storage probe & wake lock management
  useEffect(() => {
    void requestPersistentBrowserStorage().then(setStorageReport);
    void wakeLockRef.current.acquire();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void wakeLockRef.current.acquire();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void wakeLockRef.current.release();
      urlPoolRef.current.disposeAll();
    };
  }, []);

  // Fullscreen listener
  useEffect(() => {
    const onFs = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Load cached manifest first (offline-boot resilience), then sync with backend when online
  const cacheAbortRef = useRef<AbortController | null>(null);
  const lastPlaylistRevisionRef = useRef<number | null>(null);
  const activeCacheSignatureRef = useRef<string | null>(null);
  const syncInFlightRef = useRef<boolean>(false);

  const syncWithServer = useCallback(async () => {
    if (!creds) return;
    try {
      const nextManifest = await fetchSignagePlayerManifest(creds.screenToken);
      setManifest(nextManifest);
      setLastSyncAt(new Date().toISOString());
      setLastSyncError(null);
      await saveOfflineManifest(creds.screenId, nextManifest);

      const items = nextManifest.playlist?.items ?? [];
      const activeIds = new Set(items.map((i) => i.mediaId));
      urlPoolRef.current.retainOnly(activeIds);

      if (nextManifest.screen.revision !== lastPlaylistRevisionRef.current) {
        lastPlaylistRevisionRef.current = nextManifest.screen.revision;
        engineRef.current?.setPlaylist(
          nextManifest.playlist,
          nextManifest.screen.playbackCommand,
          nextManifest.screen.currentItemId
        );
      } else {
        engineRef.current?.applyCommand(nextManifest.screen.playbackCommand);
      }

      const mediaSig = items
        .map((i) => `${i.mediaId}:${i.media?.sha256 ?? ''}`)
        .join('|');
      if (syncInFlightRef.current && activeCacheSignatureRef.current === mediaSig) {
        // Keep the active download running without aborting it on periodic 25s polls
        return;
      }

      cacheAbortRef.current?.abort();
      const abort = new AbortController();
      cacheAbortRef.current = abort;
      activeCacheSignatureRef.current = mediaSig;
      syncInFlightRef.current = true;

      try {
        const updatedCache = await syncPlaylistMediaCache({
          items,
          screenToken: creds.screenToken,
          signal: abort.signal,
          onProgress: (states) => {
            setCacheStates(states);
          },
        });
        if (!abort.signal.aborted) {
          setCacheStates(updatedCache);
        }
      } finally {
        if (cacheAbortRef.current === abort) {
          syncInFlightRef.current = false;
        }
      }
    } catch (error) {
      // Transient network errors NEVER interrupt local offline playback
      setLastSyncError(
        error instanceof Error ? `Offline mode (${error.message})` : 'Offline mode'
      );
    }
  }, [creds]);

  useEffect(() => {
    if (!creds) return;
    let active = true;
    let sseStaggerTimer: number | null = null;

    void (async () => {
      const offline = await loadOfflineManifest(creds.screenId);
      if (active && offline) {
        setManifest(offline);
        engineRef.current?.setPlaylist(
          offline.playlist,
          offline.screen.playbackCommand,
          offline.screen.currentItemId
        );
      }
      if (active) {
        await syncWithServer();
      }
    })();

    const unsubSse = subscribeSignageEvents(creds.screenToken, (event) => {
      if (event === 'manifest_update') {
        if (sseStaggerTimer) window.clearTimeout(sseStaggerTimer);
        const staggerMs = 200 + Math.round(Math.random() * 1400);
        sseStaggerTimer = window.setTimeout(() => {
          void syncWithServer();
        }, staggerMs);
      }
    });

    const manifestPoll = window.setInterval(() => {
      void syncWithServer();
    }, 25_000);

    return () => {
      active = false;
      if (sseStaggerTimer) window.clearTimeout(sseStaggerTimer);
      unsubSse();
      window.clearInterval(manifestPoll);
      cacheAbortRef.current?.abort();
      syncInFlightRef.current = false;
    };
  }, [creds, syncWithServer]);

  // Playback 250ms clock tick for accurate image durations & total duration tracking
  useEffect(() => {
    const timer = window.setInterval(() => {
      engineRef.current?.tick(Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  // Resolve active media ObjectURL strictly from local cache (falling back to authenticated URL only while downloading)
  const currentMedia = playback.currentItem?.media ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!currentMedia) {
      setActiveMediaUrl(null);
      return;
    }

    void (async () => {
      const cachedUrl = await urlPoolRef.current.ensureUrl(currentMedia);
      if (cancelled) return;
      if (cachedUrl) {
        setActiveMediaUrl(cachedUrl);
      } else {
        setActiveMediaUrl(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentMedia, cacheStates]);

  // Video play/pause sync & long-duration stall watchdog
  useEffect(() => {
    const video = videoRef.current;
    if (!video || currentMedia?.mediaKind !== 'video' || !activeMediaUrl) return;

    if (playback.status === 'playing') {
      lastVideoProgressRef.current = { time: video.currentTime, updatedAt: Date.now() };
      void video.play().catch(() => {
        // Fallback muted autoplay if browser blocks unmuted video on first boot
        video.muted = true;
        void video.play().catch(() => {});
      });
    } else if (playback.status === 'paused') {
      video.pause();
    } else if (playback.status === 'stopped') {
      video.pause();
      video.currentTime = 0;
    }
  }, [activeMediaUrl, currentMedia?.mediaKind, playback.status, playback.currentItemRepeat]);

  useEffect(() => {
    if (currentMedia?.mediaKind !== 'video' || playback.status !== 'playing') return;
    const watchdog = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const now = Date.now();
      if (Math.abs(video.currentTime - lastVideoProgressRef.current.time) > 0.1) {
        lastVideoProgressRef.current = { time: video.currentTime, updatedAt: now };
        return;
      }
      if (!video.paused && !video.ended && now - lastVideoProgressRef.current.updatedAt > 15_000) {
        engineRef.current?.notifyMediaError(`Video stalled on ${currentMedia.displayName}`);
        lastVideoProgressRef.current = { time: 0, updatedAt: now };
      }
    }, 5_000);
    return () => window.clearInterval(watchdog);
  }, [currentMedia, playback.status]);

  // Report telemetry back to server every 15s and immediately on track/status change (fails gracefully offline)
  const syncTelemetryRef = useRef({ creds, playback, cacheStates, lastSyncError });
  syncTelemetryRef.current = { creds, playback, cacheStates, lastSyncError };

  useEffect(() => {
    if (!creds) return;
    const sendTelemetry = () => {
      const snap = syncTelemetryRef.current;
      if (!snap.creds) return;
      void syncSignagePlayerTelemetry(snap.creds.screenToken, {
        playbackState: snap.playback.status,
        currentItemId: snap.playback.currentItem?.id ?? null,
        currentMediaId: snap.playback.currentItem?.media?.id ?? null,
        currentMediaName: snap.playback.currentItem?.media?.displayName ?? null,
        currentPositionSec: snap.playback.itemElapsedSec,
        totalPlaybackSec: snap.playback.totalPlaybackSec,
        lastSyncError: snap.lastSyncError,
        cacheItems: snap.cacheStates,
      }).catch(() => {
        // Offline / host down: keep playing locally without raising errors
      });
    };

    sendTelemetry();
    const timer = window.setInterval(sendTelemetry, 15_000);
    return () => window.clearInterval(timer);
  }, [creds, playback.currentItem?.id, playback.status]);

  const bumpHud = useCallback(() => {
    setShowHud(true);
    if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => {
      setShowHud(false);
    }, 5_000);
  }, []);

  useEffect(() => {
    bumpHud();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'i' || e.key === 'I' || e.key === 'Enter' || e.key === ' ') {
        bumpHud();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
    };
  }, [bumpHud]);

  const handleToggleFullscreen = async () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await containerRef.current.requestFullscreen().catch(() => {});
    }
  };

  const cachedCount = cacheStates.filter((c) => c.status === 'cached').length;
  const totalCount = cacheStates.length;

  // Unpaired TV Enrollment View
  if (!creds) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-[#141414] p-6 text-white">
        <div className="w-full max-w-md rounded-2xl border border-[#262626] bg-[#1B1B1E] p-7 castora-stage-shadow space-y-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#FF6041]">
                <Tv className="h-5 w-5 text-white" />
              </span>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#9A9FA6]">
                  SIGNAGE RECEIVER
                </p>
                <h1 className="font-display text-lg font-semibold text-white">Castora TV Signage Player</h1>
                <p className="text-xs text-[#A1A6AE]">Autonomous offline-cached display</p>
              </div>
            </div>
            <PWAInstallButton compact />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleClaimCode(codeInput);
            }}
            className="space-y-4"
          >
            <div>
              <label
                htmlFor="tv-screen-code"
                className="block font-mono text-[10px] uppercase tracking-wider text-[#9A9FA6]"
              >
                6-Character Screen Code (from Host Digital Signage tab)
              </label>
              <input
                id="tv-screen-code"
                type="text"
                maxLength={6}
                value={codeInput}
                onChange={(e) =>
                  setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))
                }
                placeholder="ABC123"
                className="mt-2 h-14 w-full rounded-xl border border-white/15 bg-[#141414] px-4 text-center font-mono text-2xl font-bold tracking-[0.28em] text-white placeholder:text-[#5C6063] focus:border-[#FF6041] focus:outline-none"
              />
            </div>

            {pairingError && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-2 text-xs text-red-200">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{pairingError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={pairingBusy || codeInput.length !== 6}
              className="h-12 w-full rounded-xl bg-[#FF6041] text-sm font-semibold text-white transition-colors hover:bg-[#E85032] disabled:opacity-50"
            >
              {pairingBusy ? 'Pairing Display...' : 'Pair Display & Start Caching'}
            </button>
          </form>

          <div className="flex items-center justify-between border-t border-white/10 pt-4 text-xs text-[#9A9FA6]">
            <button
              type="button"
              onClick={onExitPlayer}
              className="inline-flex items-center gap-1.5 text-white hover:text-[#FF6041] transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to Studio</span>
            </button>
            <span className="font-mono text-[10px] uppercase tracking-wider">No WebRTC or host required</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={bumpHud}
      onClick={bumpHud}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black text-white select-none overflow-hidden"
    >
      {/* Full-bleed Media Canvas */}
      {currentMedia && activeMediaUrl && playback.status !== 'stopped' ? (
        currentMedia.mediaKind === 'image' ? (
          <img
            key={`${playback.currentItem?.id}-${playback.currentItemRepeat}`}
            src={activeMediaUrl}
            alt={currentMedia.displayName}
            onLoad={() => engineRef.current?.notifyMediaPlaybackSuccess()}
            onError={() =>
              engineRef.current?.notifyMediaError(`Failed to render image ${currentMedia.displayName}`)
            }
            className="h-full w-full object-contain bg-black"
          />
        ) : (
          <video
            key={`${playback.currentItem?.id}-${playback.currentItemRepeat}`}
            ref={videoRef}
            src={activeMediaUrl}
            playsInline
            autoPlay={playback.status === 'playing'}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              lastVideoProgressRef.current = { time: t, updatedAt: Date.now() };
              engineRef.current?.notifyVideoTimeUpdate(t);
            }}
            onEnded={() => engineRef.current?.notifyVideoEnded()}
            onError={() =>
              engineRef.current?.notifyMediaError(`Video playback error on ${currentMedia.displayName}`)
            }
            className="h-full w-full object-contain bg-black"
          />
        )
      ) : (
        <div className="max-w-md px-6 text-center space-y-3">
          <Tv className="mx-auto h-12 w-12 text-slate-500" />
          <h2 className="font-display text-xl font-semibold">
            {manifest?.screen.name ?? `Screen ${creds.screenCode}`}
          </h2>
          <p className="text-sm text-slate-400">
            {playback.status === 'stopped'
              ? 'Playback stopped by host.'
              : totalCount > 0 && cachedCount < totalCount
                ? `Downloading & verifying local cache (${cachedCount}/${totalCount})...`
                : 'Waiting for a playlist assignment from the host dashboard.'}
          </p>
        </div>
      )}

      {/* Subtle Auto-Hiding OSD HUD */}
      <div
        className={`absolute inset-x-0 top-0 p-4 transition-opacity duration-300 ${
          showHud ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 rounded-xl border border-white/15 bg-[#141414]/90 px-4 py-2.5 backdrop-blur-md text-xs castora-stage-shadow">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onExitPlayer}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-white/15 px-2.5 text-white hover:border-white/40 hover:bg-white/10"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Studio</span>
            </button>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-[#FF6041]">
                <Tv className="h-3 w-3 text-white" />
              </span>
              <span className="font-semibold text-white">
                {manifest?.screen.name ?? `Screen ${creds.screenCode}`}
              </span>
              <span className="font-mono text-[#9A9FA6]">({creds.screenCode})</span>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider font-medium ${
                isOnline && !lastSyncError
                  ? 'border-[#81FF28]/30 bg-[#81FF28]/10 text-[#81FF28]'
                  : 'border-amber-400/30 bg-amber-500/15 text-amber-300'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  isOnline && !lastSyncError ? 'bg-[#81FF28]' : 'bg-amber-400'
                }`}
              />
              {isOnline && !lastSyncError ? (
                <Wifi className="h-3 w-3" />
              ) : (
                <WifiOff className="h-3 w-3" />
              )}
              <span>{isOnline && !lastSyncError ? 'Online Synced' : 'Offline Cached Playback'}</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-[#A1A6AE] tabular-metrics">
            <span>
              Cache: {cachedCount}/{totalCount}
            </span>
            <span className="text-white">
              {playback.currentItem?.media?.displayName ?? 'Idle'} ·{' '}
              {formatClockDuration(playback.totalPlaybackSec)} (Loops: {playback.loopCount})
            </span>
            {storageReport && (
              <span
                title={
                  storageReport.persisted
                    ? 'Browser persistent storage granted'
                    : 'Best-effort browser storage (native Android TV APK recommended for un-evictable 24/7 storage)'
                }
                className="inline-flex items-center gap-1 text-[#9A9FA6]"
              >
                <HardDrive className="h-3 w-3" />
                <span>{storageReport.persisted ? 'Persisted' : 'Best-effort cache'}</span>
              </span>
            )}
            <button
              type="button"
              onClick={() => void syncWithServer()}
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#FF6041] px-2.5 font-sans text-xs font-semibold text-white transition-colors hover:bg-[#E85032]"
            >
              <RefreshCw className="h-3 w-3" />
              <span>Sync</span>
            </button>
            <button
              type="button"
              onClick={() => void handleToggleFullscreen()}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-white/15 px-2.5 font-sans text-xs text-white hover:bg-white/10"
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
              <span>{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                saveScreenCredentials(null);
                setCreds(null);
                setManifest(null);
              }}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-red-500/30 px-2.5 font-sans text-xs text-red-300 hover:bg-red-500/20"
            >
              <Unplug className="h-3.5 w-3.5" />
              <span>Unpair</span>
            </button>
          </div>
        </div>
        {lastSyncAt && (
          <p className="mx-auto mt-1 max-w-6xl px-2 font-mono text-[10px] text-[#9A9FA6]">
            <Info className="mr-1 inline h-3 w-3" />
            Last server sync: {new Date(lastSyncAt).toLocaleTimeString()} · Playback runs locally from IndexedDB cache without host connection.
          </p>
        )}
      </div>
    </div>
  );
}
