import { useEffect, useRef, type ReactNode } from 'react';
import { MonitorOff } from 'lucide-react';

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
}: VideoSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream) {
      el.srcObject = stream;
    } else {
      el.srcObject = null;
    }
    return () => {
      if (el) {
        el.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div
      ref={containerRef}
      className={`flex flex-col border bg-[#191D20] ${
        highlight ? 'border-[#FF7849]' : 'border-[#252A2F]'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[#252A2F] px-3 py-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-[11px] font-medium tracking-[0.08em] text-[#929A9D] tabular-metrics shrink-0">
            {slotLabel}
          </span>
          <span className="truncate text-xs font-medium text-[#F2F3F0]">{title}</span>
        </div>
        {statusBadge && <div className="shrink-0">{statusBadge}</div>}
      </div>

      <div className="relative aspect-video w-full bg-[#131619] overflow-hidden">
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={muted}
            className="h-full w-full object-contain bg-[#101214]"
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
        <div className="border-t border-[#252A2F] bg-[#131619] px-3 py-2">
          {footerMeta}
        </div>
      )}
    </div>
  );
}
