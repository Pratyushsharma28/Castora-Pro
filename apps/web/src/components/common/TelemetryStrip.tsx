import type { StreamTelemetrySnapshot } from '../../types/studio';

interface TelemetryStripProps {
  telemetry: StreamTelemetrySnapshot;
  compact?: boolean;
}

function formatNumber(value: number | null, suffix: string, decimals = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(decimals)}${suffix}`;
}

export function TelemetryStrip({ telemetry, compact = false }: TelemetryStripProps) {
  const cells = [
    { label: 'Capture FPS', value: formatNumber(telemetry.captureFps, '') },
    { label: 'Encoded FPS', value: formatNumber(telemetry.encodedFps, '') },
    { label: 'Decoded FPS', value: formatNumber(telemetry.decodedFps, '') },
    { label: 'Target FPS', value: `${telemetry.targetFps}` },
    { label: 'Resolution', value: telemetry.resolution ?? '—' },
    {
      label: 'Bitrate',
      value:
        telemetry.bitrateKbps === null
          ? '—'
          : telemetry.bitrateKbps >= 1000
            ? `${(telemetry.bitrateKbps / 1000).toFixed(2)} Mbps`
            : `${Math.round(telemetry.bitrateKbps)} kbps`,
    },
    { label: 'RTT', value: formatNumber(telemetry.rttMs, ' ms') },
    { label: 'Packet Loss', value: formatNumber(telemetry.packetLossPct, '%', 2) },
    { label: 'Jitter', value: formatNumber(telemetry.jitterMs, ' ms') },
    {
      label: 'Dropped',
      value: telemetry.droppedFrames === null ? '—' : `${telemetry.droppedFrames}`,
    },
  ];

  const visibleCells = compact ? cells.slice(0, 6) : cells;

  return (
    <div
      className={`grid grid-cols-2 ${
        compact ? 'sm:grid-cols-3 lg:grid-cols-6' : 'sm:grid-cols-5'
      } divide-x divide-y divide-[#E2E8F0] overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC]`}
    >
      {visibleCells.map((cell) => (
        <div key={cell.label} className="px-3 py-2">
          <div className="text-[11px] font-medium text-[#64748B]">{cell.label}</div>
          <div className="mt-0.5 text-sm font-semibold text-[#172033] tabular-metrics">
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}
