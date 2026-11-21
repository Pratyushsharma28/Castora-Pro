import { AlertTriangle, CheckCircle2, CircleSlash, Loader2 } from 'lucide-react';

export type SignalTone = 'active' | 'signal' | 'warn' | 'fault' | 'standby';

interface SignalBadgeProps {
  label: string;
  tone: SignalTone;
  pulse?: boolean;
}

export function SignalBadge({ label, tone, pulse = false }: SignalBadgeProps) {
  const toneClass =
    tone === 'active'
      ? 'text-[#8BD7B0]'
      : tone === 'signal'
        ? 'text-[#FF7849]'
        : tone === 'warn'
          ? 'text-[#F59E0B]'
          : tone === 'fault'
            ? 'text-[#EF4444]'
            : 'text-[#929A9D]';

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium tabular-metrics whitespace-nowrap ${toneClass}`}>
      {tone === 'active' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {tone === 'warn' && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {tone === 'fault' && <CircleSlash className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {tone === 'signal' && (
        <Loader2
          className={`h-3.5 w-3.5 shrink-0 ${pulse ? 'animate-spin' : ''}`}
          aria-hidden="true"
        />
      )}
      {tone === 'standby' && (
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 border border-[#929A9D]"
        />
      )}
      <span>{label}</span>
    </span>
  );
}
