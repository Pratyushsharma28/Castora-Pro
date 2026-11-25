import { MonitorPlay, Square } from 'lucide-react';
import type { SignalingSocketState } from '../../services/backendClient';
import type { StudioDestination } from '../../types/studio';
import { SignalBadge, type SignalTone } from '../common/SignalBadge';

interface NavDestinationItem {
  id: StudioDestination;
  label: string;
  matches: StudioDestination[];
}

const NAV_ITEMS: NavDestinationItem[] = [
  { id: 'control-room', label: 'Home', matches: ['control-room'] },
  { id: 'receivers', label: 'Rooms', matches: ['receivers'] },
  { id: 'sessions', label: 'Session', matches: ['sessions'] },
  { id: 'devices', label: 'Devices', matches: ['devices'] },
  { id: 'multi-view', label: 'Screens', matches: ['multi-view', 'cast'] },
  { id: 'digital-signage', label: 'Digital Signage', matches: ['digital-signage', 'signage-player'] },
  { id: 'settings', label: 'Settings', matches: ['settings', 'activity'] },
];

interface TopControlBarProps {
  activeDestination: StudioDestination;
  onSelectDestination: (destination: StudioDestination) => void;
  signalingState: SignalingSocketState;
  isSharingLocal: boolean;
  canQuickShare: boolean;
  onPrimaryAction: () => void;
}

export function TopControlBar({
  activeDestination,
  onSelectDestination,
  signalingState,
  isSharingLocal,
  canQuickShare,
  onPrimaryAction,
}: TopControlBarProps) {
  const wsStatus: { label: string; tone: SignalTone; pulse?: boolean } =
    signalingState === 'connected'
      ? { label: 'Connected', tone: 'active' }
      : signalingState === 'connecting'
        ? { label: 'Connecting', tone: 'signal', pulse: true }
        : signalingState === 'error'
          ? { label: 'Connection error', tone: 'fault' }
          : { label: 'Offline', tone: 'standby' };

  const primaryLabel = isSharingLocal
    ? 'Stop Sharing'
    : canQuickShare
      ? 'Share Screen'
      : 'Open Screens';

  return (
    <header
      data-castora-chrome
      className="sticky top-0 z-30 border-b border-[#D5D7DE] bg-white/92 backdrop-blur-md"
    >
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6">
        {/* Zone 1: Brand */}
        <button
          type="button"
          onClick={() => onSelectDestination('control-room')}
          className="group flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 rounded-lg py-1 pr-1"
        >
          <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#141414] text-white transition-colors group-hover:bg-[#FF6041]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <rect
                x="3.25"
                y="4.75"
                width="17.5"
                height="12.5"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.9"
              />
              <path
                d="M8.5 20.25H15.5"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
              <circle cx="17.25" cy="8.25" r="1.75" fill="#FF6041" className="transition-colors group-hover:fill-white" />
            </svg>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="font-display text-[15px] font-semibold tracking-tight text-[#141414]">
              Castora Pro
            </span>
            <span className="hidden lg:inline font-mono text-[10px] uppercase tracking-[0.14em] text-[#797D82]">
              Studio
            </span>
          </span>
        </button>

        {/* Zone 2: Primary architectural navigation */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex h-16 items-stretch gap-1 lg:gap-2"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.matches.includes(activeDestination);
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onSelectDestination(item.id)}
                className={`relative inline-flex items-center px-2.5 lg:px-3 text-[13px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'text-[#141414]'
                    : 'text-[#5C6063] hover:text-[#141414]'
                }`}
              >
                <span>{item.label}</span>
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-x-2 bottom-0 h-[2px] transition-all duration-150 ${
                    isActive
                      ? 'bg-[#FF6041] opacity-100'
                      : 'bg-[#141414]/30 opacity-0'
                  }`}
                />
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Connection status + Primary Action */}
        <div className="flex items-center gap-4 shrink-0">
          <div className="hidden sm:block">
            <SignalBadge label={wsStatus.label} tone={wsStatus.tone} pulse={wsStatus.pulse} />
          </div>

          <button
            type="button"
            onClick={onPrimaryAction}
            className={`castora-roll-trigger inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              isSharingLocal
                ? 'border border-[#DC2626]/35 bg-[#FEF2F2] text-[#DC2626] hover:bg-[#FEE2E2]'
                : 'bg-[#141414] text-white hover:bg-[#FF6041]'
            }`}
          >
            {isSharingLocal ? (
              <Square className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <MonitorPlay className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="castora-roll-label h-[1.25em]">
              <span className="castora-roll-track">
                <span>{primaryLabel}</span>
                <span aria-hidden="true">{primaryLabel}</span>
              </span>
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
