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
      ? 'text-[#15803D]'
      : tone === 'signal'
        ? 'text-[#FF6041]'
        : tone === 'warn'
          ? 'text-[#B45309]'
          : tone === 'fault'
            ? 'text-[#DC2626]'
            : 'text-[#5C6063]';

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap tabular-metrics ${toneClass}`}
    >
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
          className="inline-block h-2 w-2 rounded-full bg-[#D5D7DE]"
        />
      )}
      <span>{label}</span>
    </span>
  );
}
