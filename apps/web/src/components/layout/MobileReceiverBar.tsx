import { Home, Laptop, MonitorPlay, Settings, ShieldCheck, Tv, Users } from 'lucide-react';
import type { StudioDestination } from '../../types/studio';

interface MobileReceiverBarProps {
  activeDestination: StudioDestination;
  onSelectDestination: (destination: StudioDestination) => void;
}

const MOBILE_ITEMS: {
  id: StudioDestination;
  label: string;
  icon: typeof Home;
  matches: StudioDestination[];
}[] = [
  { id: 'control-room', label: 'Home', icon: Home, matches: ['control-room'] },
  { id: 'receivers', label: 'Rooms', icon: Users, matches: ['receivers'] },
  { id: 'sessions', label: 'Session', icon: ShieldCheck, matches: ['sessions'] },
  { id: 'devices', label: 'Devices', icon: Laptop, matches: ['devices'] },
  { id: 'multi-view', label: 'Screens', icon: MonitorPlay, matches: ['multi-view', 'cast'] },
  { id: 'digital-signage', label: 'Signage', icon: Tv, matches: ['digital-signage', 'signage-player'] },
  { id: 'settings', label: 'Settings', icon: Settings, matches: ['settings', 'activity'] },
];

export function MobileReceiverBar({
  activeDestination,
  onSelectDestination,
}: MobileReceiverBarProps) {
  return (
    <nav
      data-castora-chrome
      aria-label="Mobile Navigation"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-7 border-t border-[#E2E8F0] bg-white md:hidden"
    >
      {MOBILE_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = item.matches.includes(activeDestination);
        return (
          <button
            key={item.id}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onSelectDestination(item.id)}
            className={`flex min-h-[56px] flex-col items-center justify-center gap-1 px-2 text-[11px] font-medium transition-colors ${
              isActive ? 'text-[#2563EB]' : 'text-[#64748B] hover:text-[#172033]'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
