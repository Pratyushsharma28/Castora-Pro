import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ActivityEvent } from '../types/studio';

interface ActivityViewProps {
  events: ActivityEvent[];
  onClearEvents: () => void;
  embedded?: boolean;
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

export function ActivityView({
  events,
  onClearEvents,
  embedded = false,
}: ActivityViewProps) {
  const [filter, setFilter] = useState<CategoryFilter>('all');

  const visibleEvents =
    filter === 'all' ? events : events.filter((evt) => evt.category === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {embedded ? (
            <h2 className="font-display text-base font-semibold text-[#141414]">
              Activity &amp; Diagnostics Log
            </h2>
          ) : (
            <>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#797D82]">
                06 · RUNTIME TELEMETRY
              </div>
              <h1 className="mt-0.5 font-display text-2xl font-bold tracking-[-0.025em] text-[#141414]">
                Activity Log
              </h1>
            </>
          )}
          <p className="text-xs text-[#5C6063]">
            Runtime browser checks, room signaling events, and WebRTC diagnostics.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filter Activity Events"
            className="inline-flex flex-wrap rounded-[10px] border border-[#D5D7DE] bg-[#EBEBEB] p-0.5"
          >
            {FILTER_OPTIONS.map((opt) => {
              const active = filter === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setFilter(opt.id)}
                  className={`min-h-[32px] rounded-lg px-2.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[#141414] text-white'
                      : 'text-[#5C6063] hover:text-[#141414]'
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
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] border border-[#D5D7DE] bg-white px-3 text-xs font-medium text-[#5C6063] transition-colors hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      <div className="castora-card overflow-hidden">
        <div className="hidden sm:grid grid-cols-12 border-b border-[#D5D7DE] bg-[#FAFAFA] px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-[#797D82]">
          <span className="col-span-2">Time</span>
          <span className="col-span-2">Category</span>
          <span className="col-span-3">Event</span>
          <span className="col-span-5">Detail</span>
        </div>

        {visibleEvents.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[#5C6063]">
            No activity events match the selected filter.
          </div>
        ) : (
          <ul className="divide-y divide-[#D5D7DE]">
            {visibleEvents.map((evt) => (
              <li
                key={evt.id}
                className="grid grid-cols-1 gap-1.5 px-4 py-3 text-xs sm:grid-cols-12 sm:items-start sm:gap-3"
              >
                <span className="font-mono text-[#5C6063] tabular-metrics sm:col-span-2">
                  {evt.timestamp}
                </span>
                <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-[#FF6041] sm:col-span-2">
                  {evt.category}
                </span>
                <span className="font-medium text-[#141414] sm:col-span-3">{evt.title}</span>
                <span className="text-[#5C6063] leading-relaxed sm:col-span-5">{evt.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
