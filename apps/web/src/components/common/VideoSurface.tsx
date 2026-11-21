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
          ? 'flex h-screen w-screen flex-col overflow-hidden bg-[#0F172A]'
          : `flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${
              highlight ? 'border-[#2563EB]/50 ring-1 ring-[#2563EB]/15' : 'border-[#E2E8F0]'
            }`
      }
    >
      <div
        className={
          isFullscreen
            ? 'flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[#0F172A] px-4 py-2.5'
            : 'flex shrink-0 items-center justify-between gap-3 border-b border-[#E2E8F0] bg-white px-4 py-2.5'
        }
      >
        <div className="min-w-0 flex items-center gap-2.5">
          <span
            className={`font-mono text-[11px] font-medium tabular-metrics shrink-0 ${
              isFullscreen ? 'text-slate-400' : 'text-[#64748B]'
            }`}
          >
            {slotLabel}
          </span>
          <div className="min-w-0">
            <div
              className={`truncate text-sm font-semibold ${
                isFullscreen ? 'text-white' : 'text-[#172033]'
              }`}
            >
              {title}
            </div>
            {subtitle && (
              <div
                className={`truncate text-[11px] ${
                  isFullscreen ? 'text-slate-400' : 'text-[#64748B]'
                }`}
              >
                {subtitle}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {statusBadge}
          {stream && allowFullscreen && (
            <button
              type="button"
              onClick={handleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Open stream in fullscreen'}
              aria-label={isFullscreen ? `Exit fullscreen for ${title}` : `Fullscreen ${title}`}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                isFullscreen
                  ? 'border-white/20 bg-white/10 text-white hover:bg-white/20'
                  : 'border-[#E2E8F0] bg-[#F8FAFC] text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]'
              }`}
            >
              {isFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
            </button>
          )}
        </div>
      </div>

      <div
        className={
          isFullscreen
            ? 'relative flex-1 min-h-0 w-full overflow-hidden bg-[#0F172A]'
            : `relative w-full overflow-hidden ${
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
            onDoubleClick={allowFullscreen ? () => void handleFullscreen() : undefined}
            className="absolute inset-0 h-full w-full bg-[#0F172A] object-contain"
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
          className={
            isFullscreen
              ? 'shrink-0 border-t border-white/10 bg-[#0F172A] px-4 py-2 text-slate-300'
              : 'shrink-0 border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2.5'
          }
        >
          {footerMeta}
        </div>
      )}
    </div>
  );
}
