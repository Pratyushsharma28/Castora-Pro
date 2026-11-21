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
    <div className="grid grid-cols-2 sm:grid-cols-5 divide-x divide-y divide-[#252A2F] border border-[#252A2F] bg-[#131619]">
      {visibleCells.map((cell) => (
        <div key={cell.label} className="px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-[#929A9D]">
            {cell.label}
          </div>
          <div className="mt-1 text-sm font-medium text-[#F2F3F0] tabular-metrics">
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}
