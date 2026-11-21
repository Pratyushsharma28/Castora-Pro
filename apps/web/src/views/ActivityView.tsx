import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ActivityEvent } from '../types/studio';

interface ActivityViewProps {
  events: ActivityEvent[];
  onClearEvents: () => void;
}

type CategoryFilter = 'all' | ActivityEvent['category'];

const FILTER_OPTIONS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'capability', label: 'Capability' },
  { id: 'ui', label: 'UI' },
  { id: 'signaling', label: 'Signaling' },
  { id: 'webrtc', label: 'WebRTC' },
  { id: 'error', label: 'Errors' },
];

export function ActivityView({ events, onClearEvents }: ActivityViewProps) {
  const [filter, setFilter] = useState<CategoryFilter>('all');

  const visibleEvents =
    filter === 'all' ? events : events.filter((evt) => evt.category === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
            Runtime Activity Log
          </h1>
          <p className="text-xs text-[#929A9D]">
            Chronological capability probes, pairing validation, and transport diagnostics.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filter Activity Events"
            className="inline-flex flex-wrap border border-[#252A2F] bg-[#191D20]"
          >
            {FILTER_OPTIONS.map((opt) => {
              const active = filter === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setFilter(opt.id)}
                  className={`min-h-[36px] px-3 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[#FF7849] text-[#101214]'
                      : 'text-[#929A9D] hover:text-[#F2F3F0]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={onClearEvents}
            disabled={events.length === 0}
            className="inline-flex min-h-[36px] items-center gap-1.5 border border-[#252A2F] bg-[#191D20] px-3 text-xs font-medium text-[#929A9D] hover:text-[#F2F3F0] disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      <div className="border border-[#252A2F] bg-[#191D20]">
        <div className="hidden sm:grid grid-cols-12 border-b border-[#252A2F] bg-[#131619] px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[#929A9D]">
          <span className="col-span-2">Timestamp</span>
          <span className="col-span-2">Category</span>
          <span className="col-span-3">Event</span>
          <span className="col-span-5">Detail</span>
        </div>

        {visibleEvents.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[#929A9D]">
            No activity events match the selected filter.
          </div>
        ) : (
          <ul className="divide-y divide-[#252A2F]">
            {visibleEvents.map((evt) => (
              <li
                key={evt.id}
                className="grid grid-cols-1 gap-1.5 px-4 py-3 text-xs sm:grid-cols-12 sm:items-start sm:gap-3"
              >
                <span className="font-mono text-[#929A9D] tabular-metrics sm:col-span-2">
                  {evt.timestamp}
                </span>
                <span className="font-mono uppercase tracking-[0.06em] text-[#FF7849] sm:col-span-2">
                  {evt.category}
                </span>
                <span className="font-medium text-[#F2F3F0] sm:col-span-3">
                  {evt.title}
                </span>
                <span className="text-[#929A9D] leading-relaxed sm:col-span-5">
                  {evt.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
