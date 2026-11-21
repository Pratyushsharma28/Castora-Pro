import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2, MonitorOff } from 'lucide-react';

interface VideoSurfaceProps {
  slotLabel: string;
  title: string;
  stream: MediaStream | null;
  muted?: boolean;
  standbyReason: string;
  statusBadge?: ReactNode;
  actions?: ReactNode;
  footerMeta?: ReactNode;
  highlight?: boolean;
  allowFullscreen?: boolean;
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenVideoElement = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

function getCurrentFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null;
  const fsDoc = document as FullscreenDocument;
  return document.fullscreenElement ?? fsDoc.webkitFullscreenElement ?? null;
}

export function VideoSurface({
  slotLabel,
  title,
  stream,
  muted = true,
  standbyReason,
  statusBadge,
  actions,
  footerMeta,
  highlight = false,
  allowFullscreen = true,
}: VideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream) {
      el.srcObject = stream;
      void el.play().catch(() => {
        // Autoplay policy may hold unmuted playback until user gesture
      });
    } else {
      el.srcObject = null;
    }
    return () => {
      if (el) {
        el.srcObject = null;
      }
    };
  }, [stream]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const syncFullscreenState = () => {
      const activeEl = getCurrentFullscreenElement();
      const matched =
        activeEl !== null &&
        (activeEl === containerRef.current || activeEl === videoRef.current);
      setIsFullscreen(matched);
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
    };
  }, []);

  const handleFullscreen = useCallback(async () => {
    const target = (containerRef.current ?? videoRef.current) as FullscreenElement | null;
    const videoEl = videoRef.current as FullscreenVideoElement | null;
    if (!target) return;

    const fsDoc = document as FullscreenDocument;
    const activeEl = getCurrentFullscreenElement();

    try {
      if (activeEl && (activeEl === containerRef.current || activeEl === videoRef.current)) {
        if (typeof document.exitFullscreen === 'function') {
          await document.exitFullscreen();
        } else if (typeof fsDoc.webkitExitFullscreen === 'function') {
          await fsDoc.webkitExitFullscreen();
        }
        return;
      }

      // If a parent container (e.g. Multi-View wall) is currently fullscreen, exit it before
      // entering fullscreen for this specific stream so per-stream fullscreen works independently.
      if (activeEl) {
        if (typeof document.exitFullscreen === 'function') {
          await document.exitFullscreen();
        } else if (typeof fsDoc.webkitExitFullscreen === 'function') {
          await fsDoc.webkitExitFullscreen();
        }
      }

      if (typeof target.requestFullscreen === 'function') {
        await target.requestFullscreen();
      } else if (typeof target.webkitRequestFullscreen === 'function') {
        await target.webkitRequestFullscreen();
      } else if (videoEl && typeof videoEl.webkitEnterFullscreen === 'function') {
        videoEl.webkitEnterFullscreen();
      }
    } catch {
      // Ignore fullscreen rejection if browser blocks outside direct gesture
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? 'flex h-screen w-screen flex-col overflow-hidden bg-[#101214]'
          : `flex min-w-0 flex-col border bg-[#191D20] ${
              highlight ? 'border-[#FF7849]' : 'border-[#252A2F]'
            }`
      }
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#252A2F] bg-[#191D20] px-3 py-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-[11px] font-medium tracking-[0.08em] text-[#929A9D] tabular-metrics shrink-0">
            {slotLabel}
          </span>
          <span className="truncate text-xs font-medium text-[#F2F3F0]">{title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {statusBadge}
          {stream && allowFullscreen && (
            <button
              type="button"
              onClick={handleFullscreen}
              title={isFullscreen ? 'Exit fullscreen video' : 'Open stream in fullscreen'}
              aria-label={isFullscreen ? `Exit fullscreen ${slotLabel}` : `Fullscreen ${slotLabel}`}
              className={`inline-flex h-7 items-center gap-1.5 border px-2 text-[11px] font-medium transition-colors ${
                isFullscreen
                  ? 'border-[#FF7849] bg-[#FF7849] text-[#101214]'
                  : 'border-[#252A2F] bg-[#131619] text-[#F2F3F0] hover:border-[#FF7849]'
              }`}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3 w-3 shrink-0" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-3 w-3 shrink-0" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
            </button>
          )}
        </div>
      </div>

      <div
        className={
          isFullscreen
            ? 'relative flex-1 min-h-0 w-full bg-[#101214] overflow-hidden'
            : `relative w-full bg-[#131619] overflow-hidden ${
                stream ? 'aspect-video max-h-[75vh]' : 'aspect-video'
              }`
        }
      >
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            onDoubleClick={allowFullscreen ? () => void handleFullscreen() : undefined}
            className="absolute inset-0 h-full w-full object-contain bg-[#101214]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center px-4 py-6 text-center">
            <MonitorOff className="h-6 w-6 text-[#929A9D]/70" aria-hidden="true" />
            <p className="mt-2.5 text-xs font-medium tracking-[0.04em] text-[#F2F3F0]">
              NO ACTIVE SIGNAL
            </p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-[#929A9D]">
              {standbyReason}
            </p>
            {actions && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
          </div>
        )}
      </div>

      {footerMeta && (
        <div className="shrink-0 border-t border-[#252A2F] bg-[#131619] px-3 py-2">
          {footerMeta}
        </div>
      )}
    </div>
  );
}
