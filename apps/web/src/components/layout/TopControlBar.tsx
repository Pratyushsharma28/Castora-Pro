import { Cast, MonitorPlay, Square } from 'lucide-react';
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

  return (
    <header
      data-castora-chrome
      className="sticky top-0 z-30 border-b border-[#E2E8F0] bg-white"
    >
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6">
        {/* Zone 1: Brand */}
        <button
          type="button"
          onClick={() => onSelectDestination('control-room')}
          className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 rounded-lg py-1 pr-1"
        >
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#2563EB] text-white shadow-xs">
            <Cast className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="font-display text-base font-bold tracking-tight text-[#172033]">
            Castora Pro
          </span>
        </button>

        {/* Zone 2: Primary navigation */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-0.5 lg:gap-1"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = item.matches.includes(activeDestination);
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onSelectDestination(item.id)}
                className={`relative rounded-lg px-2.5 lg:px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-[#EFF6FF] text-[#2563EB]'
                    : 'text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#172033]'
                }`}
              >
                {item.label}
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
            className={`inline-flex h-10 items-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 ${
              isSharingLocal
                ? 'border border-[#DC2626]/30 bg-[#FEF2F2] text-[#DC2626] hover:bg-[#FEE2E2]'
                : 'bg-[#2563EB] text-white hover:bg-[#1D4ED8]'
            }`}
          >
            {isSharingLocal ? (
              <>
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Stop Sharing</span>
              </>
            ) : (
              <>
                <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                <span>{canQuickShare ? 'Share Screen' : 'Open Screens'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
