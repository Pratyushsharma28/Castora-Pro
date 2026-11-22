import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2, Monitor } from 'lucide-react';

interface VideoSurfaceProps {
  slotLabel: string;
  title: string;
  subtitle?: string;
  stream: MediaStream | null;
  muted?: boolean;
  standbyReason: string;
  statusBadge?: ReactNode;
  actions?: ReactNode;
  footerMeta?: ReactNode;
  highlight?: boolean;
  allowFullscreen?: boolean;
  large?: boolean;
  onVideoDimensionsChange?: (width: number | null, height: number | null) => void;
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
  standbyReason,
  statusBadge,
  actions,
  footerMeta,
  highlight = false,
  allowFullscreen = true,
  large = false,
  onVideoDimensionsChange,
}: VideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoViewportRef = useRef<HTMLDivElement | null>(null);
  const onVideoDimensionsChangeRef = useRef(onVideoDimensionsChange);
  onVideoDimensionsChangeRef.current = onVideoDimensionsChange;
  const lastReportedDimsRef = useRef<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  const [isFullscreen, setIsFullscreen] = useState(false);

  const emitVideoDimensions = useCallback((width: number | null, height: number | null) => {
    const last = lastReportedDimsRef.current;
    if (last.width === width && last.height === height) return;
    lastReportedDimsRef.current = { width, height };
    onVideoDimensionsChangeRef.current?.(width, height);
  }, []);

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
      return;
    }
    if (stream) {
      el.srcObject = stream;
      void el.play().catch(() => {
        // Autoplay policy may hold unmuted playback until user gesture
      });
      syncVideoDimensions();
    } else {
      el.srcObject = null;
      emitVideoDimensions(null, null);
    }
    return () => {
      if (el) {
        el.srcObject = null;
      }
      emitVideoDimensions(null, null);
    };
  }, [emitVideoDimensions, stream, syncVideoDimensions]);

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
  }, [handleExitFullscreen]);

  return (
    <div
      className={`castora-surface-card flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${
        highlight ? 'border-[#2563EB]/50 ring-1 ring-[#2563EB]/15' : 'border-[#E2E8F0]'
      }`}
    >
      <div
        data-castora-card-header
        className={
          isFullscreen
            ? 'hidden'
            : 'flex shrink-0 items-center justify-between gap-3 border-b border-[#E2E8F0] bg-white px-4 py-2.5'
        }
      >
        <div className="min-w-0 flex items-center gap-2.5">
          <span className="font-mono text-[11px] font-medium tabular-metrics shrink-0 text-[#64748B]">
            {slotLabel}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[#172033]">{title}</div>
            {subtitle && (
              <div className="truncate text-[11px] text-[#64748B]">{subtitle}</div>
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
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 text-xs font-medium text-[#172033] transition-colors hover:border-[#2563EB] hover:text-[#2563EB] whitespace-nowrap"
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
                  ? `bg-[#0F172A] aspect-video ${large ? 'max-h-[78vh]' : 'max-h-[72vh]'}`
                  : 'bg-[#F8FAFC] aspect-video max-h-[56vh]'
              }`
        }
      >
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            onLoadedMetadata={syncVideoDimensions}
            onResize={syncVideoDimensions}
            onDoubleClick={allowFullscreen ? () => void handleFullscreen() : undefined}
            className={
              isFullscreen
                ? 'h-screen w-screen bg-black object-contain block m-0 p-0 rounded-none'
                : 'absolute inset-0 h-full w-full bg-[#0F172A] object-contain'
            }
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center px-6 py-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#E2E8F0] bg-white text-[#64748B] shadow-xs">
              <Monitor className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="mt-3 text-sm font-semibold text-[#172033]">Waiting for screen signal</p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-[#64748B]">
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
              : 'shrink-0 border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2.5'
          }
        >
          {footerMeta}
        </div>
      )}
    </div>
  );
}
