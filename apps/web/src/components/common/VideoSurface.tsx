import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2, Monitor, Volume2 } from 'lucide-react';
import type { AudioPlaybackStatus } from '../../types/studio';

interface VideoSurfaceProps {
  slotLabel: string;
  title: string;
  subtitle?: string;
  stream: MediaStream | null;
  muted?: boolean;
  autoplayBlocked?: boolean;
  standbyReason: string;
  statusBadge?: ReactNode;
  actions?: ReactNode;
  footerMeta?: ReactNode;
  highlight?: boolean;
  allowFullscreen?: boolean;
  large?: boolean;
  onVideoDimensionsChange?: (width: number | null, height: number | null) => void;
  onAudioPlaybackChange?: (state: {
    playbackStatus: AudioPlaybackStatus;
    autoplayBlocked: boolean;
  }) => void;
  onActivateAudio?: () => void;
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitCurrentFullScreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitCancelFullScreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitRequestFullScreen?: () => Promise<void> | void;
};

type FullscreenVideoElement = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
};

function getCurrentFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null;
  const fsDoc = document as FullscreenDocument;
  return (
    document.fullscreenElement ??
    fsDoc.webkitFullscreenElement ??
    fsDoc.webkitCurrentFullScreenElement ??
    null
  );
}

async function exitAnyFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return;
  const fsDoc = document as FullscreenDocument;
  if (typeof document.exitFullscreen === 'function') {
    await document.exitFullscreen();
  } else if (typeof fsDoc.webkitExitFullscreen === 'function') {
    await fsDoc.webkitExitFullscreen();
  } else if (typeof fsDoc.webkitCancelFullScreen === 'function') {
    await fsDoc.webkitCancelFullScreen();
  }
}

export function VideoSurface({
  slotLabel,
  title,
  subtitle,
  stream,
  muted = true,
  autoplayBlocked = false,
  standbyReason,
  statusBadge,
  actions,
  footerMeta,
  highlight = false,
  allowFullscreen = true,
  large = false,
  onVideoDimensionsChange,
  onAudioPlaybackChange,
  onActivateAudio,
}: VideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoViewportRef = useRef<HTMLDivElement | null>(null);
  const onVideoDimensionsChangeRef = useRef(onVideoDimensionsChange);
  onVideoDimensionsChangeRef.current = onVideoDimensionsChange;
  const onAudioPlaybackChangeRef = useRef(onAudioPlaybackChange);
  onAudioPlaybackChangeRef.current = onAudioPlaybackChange;
  const lastReportedDimsRef = useRef<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  const lastReportedAudioRef = useRef<{
    playbackStatus: AudioPlaybackStatus | null;
    autoplayBlocked: boolean;
  }>({ playbackStatus: null, autoplayBlocked: false });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [internalAutoplayBlocked, setInternalAutoplayBlocked] = useState(false);
  const [hasAudioTracks, setHasAudioTracks] = useState(false);

  const emitVideoDimensions = useCallback((width: number | null, height: number | null) => {
    const last = lastReportedDimsRef.current;
    if (last.width === width && last.height === height) return;
    lastReportedDimsRef.current = { width, height };
    onVideoDimensionsChangeRef.current?.(width, height);
  }, []);

  const emitAudioPlaybackState = useCallback(
    (playbackStatus: AudioPlaybackStatus, blocked: boolean) => {
      const last = lastReportedAudioRef.current;
      if (last.playbackStatus === playbackStatus && last.autoplayBlocked === blocked) return;
      lastReportedAudioRef.current = { playbackStatus, autoplayBlocked: blocked };
      onAudioPlaybackChangeRef.current?.({ playbackStatus, autoplayBlocked: blocked });
    },
    []
  );

  const syncAudioState = useCallback(
    (blockedOverride?: boolean) => {
      const el = videoRef.current;
      const audioCount = stream?.getAudioTracks?.().length ?? 0;
      setHasAudioTracks(audioCount > 0);
      if (!stream || !el) return;

      const blocked = blockedOverride ?? internalAutoplayBlocked;
      if (audioCount === 0) {
        emitAudioPlaybackState('no-audio-track', false);
        return;
      }
      if (blocked) {
        emitAudioPlaybackState('autoplay-blocked', true);
        return;
      }
      if (muted || el.muted) {
        emitAudioPlaybackState('muted-by-user', false);
        return;
      }
      if (el.paused) {
        emitAudioPlaybackState('paused', false);
        return;
      }
      if (el.readyState >= 2) {
        emitAudioPlaybackState('playing', false);
      } else {
        emitAudioPlaybackState('waiting', false);
      }
    },
    [emitAudioPlaybackState, internalAutoplayBlocked, muted, stream]
  );

  const syncVideoDimensions = useCallback(() => {
    const el = videoRef.current;
    if (!el || el.videoWidth <= 0 || el.videoHeight <= 0) {
      emitVideoDimensions(null, null);
      return;
    }
    emitVideoDimensions(el.videoWidth, el.videoHeight);
  }, [emitVideoDimensions]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) {
      emitVideoDimensions(null, null);
      setHasAudioTracks(false);
      return;
    }

    let cancelled = false;
    setInternalAutoplayBlocked(false);

    if (stream) {
      const audioCount = stream.getAudioTracks?.().length ?? 0;
      setHasAudioTracks(audioCount > 0);
      el.srcObject = stream;
      el.playsInline = true;
      el.volume = 1;
      el.muted = muted;

      const attemptPlay = async () => {
        try {
          await el.play();
          if (cancelled) return;
          setInternalAutoplayBlocked(false);
          if (audioCount > 0) {
            emitAudioPlaybackState(muted || el.muted ? 'muted-by-user' : 'playing', false);
          } else {
            emitAudioPlaybackState('no-audio-track', false);
          }
        } catch {
          if (cancelled) return;
          if (!muted) {
            setInternalAutoplayBlocked(true);
            el.muted = true;
            try {
              await el.play();
            } catch {
              // Video play also rejected outside interaction gesture
            }
            if (!cancelled) {
              emitAudioPlaybackState(
                audioCount > 0 ? 'autoplay-blocked' : 'no-audio-track',
                audioCount > 0
              );
            }
          }
        }
      };

      void attemptPlay();
      syncVideoDimensions();

      const handleTrackChange = () => {
        const nextCount = stream.getAudioTracks?.().length ?? 0;
        setHasAudioTracks(nextCount > 0);
        if (nextCount > 0 && !muted && el.paused) {
          void attemptPlay();
        } else {
          syncAudioState();
        }
      };

      const lastPlaybackRecoveryAtRef = { current: 0 };
      let consecutiveStallRecoveries = 0;

      const handleMediaEvent = () => {
        if (!el.paused && el.readyState >= 2) {
          consecutiveStallRecoveries = 0;
        }
        syncAudioState();
      };

      const attemptPlaybackRecovery = () => {
        if (cancelled) return;
        const liveVideoTracks = stream.getVideoTracks?.().filter((t) => t.readyState === 'live') ?? [];
        if (liveVideoTracks.length === 0) {
          syncAudioState();
          return;
        }
        const now = Date.now();
        if (now - lastPlaybackRecoveryAtRef.current < 1500) return;
        if (consecutiveStallRecoveries >= 3) {
          syncAudioState();
          return;
        }
        lastPlaybackRecoveryAtRef.current = now;
        consecutiveStallRecoveries += 1;
        void attemptPlay();
      };

      const handleVideoStall = () => {
        attemptPlaybackRecovery();
      };

      const handleUnexpectedPause = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          syncAudioState();
          return;
        }
        if (el.ended) {
          syncAudioState();
          return;
        }
        attemptPlaybackRecovery();
      };

      stream.addEventListener?.('addtrack', handleTrackChange);
      stream.addEventListener?.('removetrack', handleTrackChange);
      el.addEventListener('playing', handleMediaEvent);
      el.addEventListener('pause', handleUnexpectedPause);
      el.addEventListener('stalled', handleVideoStall);
      el.addEventListener('waiting', handleMediaEvent);
      el.addEventListener('volumechange', handleMediaEvent);
      el.addEventListener('loadedmetadata', handleMediaEvent);

      return () => {
        cancelled = true;
        stream.removeEventListener?.('addtrack', handleTrackChange);
        stream.removeEventListener?.('removetrack', handleTrackChange);
        el.removeEventListener('playing', handleMediaEvent);
        el.removeEventListener('pause', handleUnexpectedPause);
        el.removeEventListener('stalled', handleVideoStall);
        el.removeEventListener('waiting', handleMediaEvent);
        el.removeEventListener('volumechange', handleMediaEvent);
        el.removeEventListener('loadedmetadata', handleMediaEvent);
        el.srcObject = null;
        emitVideoDimensions(null, null);
      };
    } else {
      el.srcObject = null;
      setHasAudioTracks(false);
      emitVideoDimensions(null, null);
    }
    return () => {
      cancelled = true;
      if (el) {
        el.srcObject = null;
      }
      emitVideoDimensions(null, null);
    };
  }, [emitAudioPlaybackState, emitVideoDimensions, stream, syncVideoDimensions]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    let cancelled = false;
    el.volume = 1;

    if (muted) {
      el.muted = true;
      setInternalAutoplayBlocked(false);
      syncAudioState(false);
      return;
    }

    el.muted = false;
    void el
      .play()
      .then(() => {
        if (cancelled) return;
        setInternalAutoplayBlocked(false);
        syncAudioState(false);
      })
      .catch(async () => {
        if (cancelled) return;
        const audioCount = stream.getAudioTracks?.().length ?? 0;
        if (audioCount > 0) {
          setInternalAutoplayBlocked(true);
          el.muted = true;
          try {
            await el.play();
          } catch {
            // Ignore secondary fallback rejection
          }
          if (!cancelled) {
            emitAudioPlaybackState('autoplay-blocked', true);
          }
        }
      });

    return () => {
      cancelled = true;
    };
  }, [emitAudioPlaybackState, muted, stream, syncAudioState]);

  const handleActivateAudio = useCallback(async () => {
    const el = videoRef.current;
    if (!el || !stream) return;
    if (muted) {
      onActivateAudio?.();
    }
    el.muted = false;
    el.volume = 1;
    try {
      await el.play();
      setInternalAutoplayBlocked(false);
      emitAudioPlaybackState(
        (stream.getAudioTracks?.().length ?? 0) > 0 ? 'playing' : 'no-audio-track',
        false
      );
    } catch {
      setInternalAutoplayBlocked(true);
      el.muted = true;
      emitAudioPlaybackState('autoplay-blocked', true);
    }
  }, [emitAudioPlaybackState, muted, onActivateAudio, stream]);

  const handleExitFullscreen = useCallback(async () => {
    const videoEl = videoRef.current as FullscreenVideoElement | null;
    const activeEl = getCurrentFullscreenElement();
    try {
      if (
        activeEl &&
        (activeEl === videoViewportRef.current || activeEl === videoRef.current)
      ) {
        await exitAnyFullscreen();
      } else if (
        videoEl?.webkitDisplayingFullscreen &&
        typeof videoEl.webkitExitFullscreen === 'function'
      ) {
        videoEl.webkitExitFullscreen();
      }
    } catch {
      // Ignore fullscreen exit rejection
    }
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const syncFullscreenState = () => {
      const activeEl = getCurrentFullscreenElement();
      const videoEl = videoRef.current as FullscreenVideoElement | null;
      const matched =
        (activeEl !== null &&
          (activeEl === videoViewportRef.current || activeEl === videoRef.current)) ||
        Boolean(videoEl?.webkitDisplayingFullscreen);
      setIsFullscreen(matched);
    };

    const handleWebkitBegin = () => setIsFullscreen(true);
    const handleWebkitEnd = () => setIsFullscreen(false);

    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    const currentVideo = videoRef.current;
    currentVideo?.addEventListener('webkitbeginfullscreen', handleWebkitBegin);
    currentVideo?.addEventListener('webkitendfullscreen', handleWebkitEnd);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
      currentVideo?.removeEventListener('webkitbeginfullscreen', handleWebkitBegin);
      currentVideo?.removeEventListener('webkitendfullscreen', handleWebkitEnd);
    };
  }, [stream]);

  useEffect(() => {
    if (!isFullscreen || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void handleExitFullscreen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [handleExitFullscreen, isFullscreen]);

  const handleFullscreen = useCallback(async () => {
    const target = videoViewportRef.current as FullscreenElement | null;
    const videoEl = videoRef.current as FullscreenVideoElement | null;
    if (!target) return;

    // Clicking Fullscreen is a user gesture — also unlock blocked audio if caller wants unmuted playback
    if (videoEl && !muted && internalAutoplayBlocked && stream) {
      videoEl.muted = false;
      videoEl.volume = 1;
      void videoEl
        .play()
        .then(() => {
          setInternalAutoplayBlocked(false);
          emitAudioPlaybackState(
            (stream.getAudioTracks?.().length ?? 0) > 0 ? 'playing' : 'no-audio-track',
            false
          );
        })
        .catch(() => {
          videoEl.muted = true;
        });
    }

    const activeEl = getCurrentFullscreenElement();

    try {
      if (
        (activeEl &&
          (activeEl === videoViewportRef.current || activeEl === videoRef.current)) ||
        videoEl?.webkitDisplayingFullscreen
      ) {
        await handleExitFullscreen();
        return;
      }

      if (activeEl) {
        await exitAnyFullscreen();
      }

      if (typeof target.requestFullscreen === 'function') {
        await target.requestFullscreen();
      } else if (typeof target.webkitRequestFullscreen === 'function') {
        await target.webkitRequestFullscreen();
      } else if (typeof target.webkitRequestFullScreen === 'function') {
        await target.webkitRequestFullScreen();
      } else if (videoEl && typeof videoEl.webkitEnterFullscreen === 'function') {
        videoEl.webkitEnterFullscreen();
      }
    } catch {
      // Ignore fullscreen rejection if browser blocks outside direct gesture
    }
  }, [emitAudioPlaybackState, handleExitFullscreen, internalAutoplayBlocked, muted, stream]);

  const effectiveAutoplayBlocked =
    Boolean(stream) && hasAudioTracks && (autoplayBlocked || internalAutoplayBlocked);

  return (
    <div
      className={`castora-surface-card flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white castora-stage-shadow transition-colors ${
        highlight ? 'border-[#FF6041]/70 ring-1 ring-[#FF6041]/20' : 'border-[#D5D7DE]'
      }`}
    >
      <div
        data-castora-card-header
        className={
          isFullscreen
            ? 'hidden'
            : 'flex shrink-0 items-center justify-between gap-3 border-b border-[#D5D7DE] bg-white px-4 py-2.5'
        }
      >
        <div className="min-w-0 flex items-center gap-2.5">
          <span className="font-mono text-[11px] font-normal tabular-metrics shrink-0 text-[#5C6063] bg-[#EBEBEB] px-1.5 py-0.5 rounded-[4px]">
            {slotLabel}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[#141414]">{title}</div>
            {subtitle && (
              <div className="truncate text-[11px] text-[#5C6063]">{subtitle}</div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {statusBadge}
          {stream && allowFullscreen && (
            <button
              type="button"
              onClick={handleFullscreen}
              aria-pressed={isFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Open stream in fullscreen'}
              aria-label={
                isFullscreen ? `Exit fullscreen for ${title}` : `Fullscreen ${title}`
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#D5D7DE] bg-[#FAFAFA] px-2.5 text-xs font-medium text-[#141414] transition-colors hover:border-[#141414] hover:bg-[#141414] hover:text-white whitespace-nowrap"
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">
                {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Dedicated video-only fullscreen container: contains zero Castora Pro UI */}
      <div
        ref={videoViewportRef}
        data-castora-video-fullscreen={isFullscreen ? 'true' : 'false'}
        className={
          isFullscreen
            ? 'castora-video-fs fixed inset-0 h-screen w-screen overflow-hidden bg-black p-0 m-0 border-0 rounded-none shadow-none'
            : `castora-video-fs relative w-full overflow-hidden ${
                stream
                  ? `bg-[#000000] aspect-video ${large ? 'max-h-[78vh]' : 'max-h-[72vh]'}`
                  : 'bg-[#FAFAFA] aspect-video max-h-[56vh]'
              }`
        }
      >
        {stream ? (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted={muted || internalAutoplayBlocked}
              onLoadedMetadata={syncVideoDimensions}
              onResize={syncVideoDimensions}
              onDoubleClick={allowFullscreen ? () => void handleFullscreen() : undefined}
              className={
                isFullscreen
                  ? 'h-screen w-screen bg-black object-contain block m-0 p-0 rounded-none'
                  : 'absolute inset-0 h-full w-full bg-[#000000] object-contain'
              }
            />
            {effectiveAutoplayBlocked && !isFullscreen && (
              <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
                <button
                  type="button"
                  onClick={() => void handleActivateAudio()}
                  className="pointer-events-auto inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-white/25 bg-[#141414]/90 px-4 py-2 text-xs font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-[#FF6041] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6041]"
                >
                  <Volume2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Activate Audio</span>
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center px-6 py-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#D5D7DE] bg-white text-[#5C6063]">
              <Monitor className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="mt-3 text-sm font-semibold text-[#141414]">Waiting for screen signal</p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-[#5C6063]">
              {standbyReason}
            </p>
            {actions && (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
                {actions}
              </div>
            )}
          </div>
        )}
      </div>

      {footerMeta && (
        <div
          data-castora-card-footer
          className={
            isFullscreen
              ? 'hidden'
              : 'shrink-0 border-t border-[#D5D7DE] bg-[#FAFAFA] px-4 py-2.5'
          }
        >
          {footerMeta}
        </div>
      )}
    </div>
  );
}
