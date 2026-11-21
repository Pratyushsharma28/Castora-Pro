import { Activity, Grid2x2, Monitor, Radio, Settings, Smartphone } from 'lucide-react';
import type { StudioDestination } from '../../types/studio';

interface MobileReceiverBarProps {
  activeDestination: StudioDestination;
  onSelectDestination: (destination: StudioDestination) => void;
}

const MOBILE_ITEMS: { id: StudioDestination; label: string; icon: typeof Radio }[] = [
  { id: 'control-room', label: 'Control', icon: Radio },
  { id: 'receivers', label: 'Join', icon: Smartphone },
  { id: 'multi-view', label: 'Wall', icon: Grid2x2 },
  { id: 'cast', label: 'Cast', icon: Monitor },
  { id: 'activity', label: 'Log', icon: Activity },
  { id: 'settings', label: 'Setup', icon: Settings },
];

export function MobileReceiverBar({
  activeDestination,
  onSelectDestination,
}: MobileReceiverBarProps) {
  return (
    <nav
      aria-label="Mobile Broadcast Navigation"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-[#252A2F] bg-[#191D20] md:hidden"
    >
      {MOBILE_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === activeDestination;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectDestination(item.id)}
            className={`flex min-h-[52px] flex-col items-center justify-center gap-1 px-1 text-[10px] font-medium tracking-wide transition-colors ${
              isActive ? 'text-[#FF7849]' : 'text-[#929A9D] hover:text-[#F2F3F0]'
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
