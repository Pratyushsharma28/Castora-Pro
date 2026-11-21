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
            <h2 className="font-display text-base font-semibold text-[#172033]">
              Activity &amp; Diagnostics Log
            </h2>
          ) : (
            <h1 className="font-display text-xl font-semibold tracking-tight text-[#172033]">
              Activity Log
            </h1>
          )}
          <p className="text-xs text-[#64748B]">
            Runtime browser checks, room signaling events, and WebRTC diagnostics.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filter Activity Events"
            className="inline-flex flex-wrap rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-0.5"
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
                      ? 'bg-white text-[#172033] shadow-xs'
                      : 'text-[#64748B] hover:text-[#172033]'
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
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#64748B] hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="hidden sm:grid grid-cols-12 border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2.5 text-xs font-medium text-[#64748B]">
          <span className="col-span-2">Time</span>
          <span className="col-span-2">Category</span>
          <span className="col-span-3">Event</span>
          <span className="col-span-5">Detail</span>
        </div>

        {visibleEvents.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[#64748B]">
            No activity events match the selected filter.
          </div>
        ) : (
          <ul className="divide-y divide-[#E2E8F0]">
            {visibleEvents.map((evt) => (
              <li
                key={evt.id}
                className="grid grid-cols-1 gap-1.5 px-4 py-3 text-xs sm:grid-cols-12 sm:items-start sm:gap-3"
              >
                <span className="font-mono text-[#64748B] tabular-metrics sm:col-span-2">
                  {evt.timestamp}
                </span>
                <span className="font-medium capitalize text-[#2563EB] sm:col-span-2">
                  {evt.category}
                </span>
                <span className="font-medium text-[#172033] sm:col-span-3">{evt.title}</span>
                <span className="text-[#64748B] leading-relaxed sm:col-span-5">{evt.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
