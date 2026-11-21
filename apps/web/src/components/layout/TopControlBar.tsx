import { Cast, Radio } from 'lucide-react';
import type { StudioDestination } from '../../types/studio';

interface NavDestinationItem {
  id: StudioDestination;
  label: string;
}

const NAV_ITEMS: NavDestinationItem[] = [
  { id: 'control-room', label: 'CONTROL ROOM' },
  { id: 'cast', label: 'CAST' },
  { id: 'receivers', label: 'RECEIVERS' },
  { id: 'multi-view', label: 'MULTI-VIEW' },
  { id: 'activity', label: 'ACTIVITY' },
  { id: 'settings', label: 'SETTINGS' },
];

interface TopControlBarProps {
  activeDestination: StudioDestination;
  onSelectDestination: (destination: StudioDestination) => void;
  isSignalingReady: boolean;
  isSecureContext: boolean;
  onPrimaryAction: () => void;
}

export function TopControlBar({
  activeDestination,
  onSelectDestination,
  isSignalingReady,
  isSecureContext,
  onPrimaryAction,
}: TopControlBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-[#252A2F] bg-[#191D20]">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6">
        <button
          type="button"
          onClick={() => onSelectDestination('control-room')}
          className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF7849]"
        >
          <span className="inline-flex h-6 w-6 items-center justify-center border border-[#FF7849]/60 bg-[#101214] text-[#FF7849]">
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="font-display text-sm font-bold tracking-[0.14em] text-[#F2F3F0]">
            CASTORA PRO
          </span>
        </button>

        <nav
          aria-label="Broadcast Control Destinations"
          className="hidden md:flex items-center gap-1 overflow-x-auto"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.id === activeDestination;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectDestination(item.id)}
                className={`relative px-3 py-4 text-xs font-medium tracking-[0.08em] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF7849] ${
                  isActive
                    ? 'text-[#F2F3F0]'
                    : 'text-[#929A9D] hover:text-[#F2F3F0]'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 bottom-0 h-[2px] bg-[#FF7849]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-4 shrink-0">
          <div className="hidden lg:flex items-center gap-3 text-[11px] tabular-metrics text-[#929A9D] whitespace-nowrap shrink-0">
            <span>{isSecureContext ? 'HTTPS READY' : 'HTTP ONLY'}</span>
            <span aria-hidden="true">·</span>
            <span>{isSignalingReady ? 'WS ONLINE' : 'WS STANDBY'}</span>
          </div>

          <button
            type="button"
            onClick={onPrimaryAction}
            className="inline-flex h-9 items-center gap-2 bg-[#FF7849] px-4 text-xs font-semibold tracking-wide text-[#101214] transition-opacity hover:opacity-90 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F2F3F0]"
          >
            <Cast className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Cast Screen</span>
          </button>
        </div>
      </div>
    </header>
  );
}
