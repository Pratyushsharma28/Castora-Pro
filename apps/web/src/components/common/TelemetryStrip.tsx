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

function formatRate(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) {
    return '—';
  }
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatAdaptationLabel(telemetry: StreamTelemetrySnapshot): string {
  if (telemetry.qualityLimitationReason === 'bandwidth') {
    return 'BW Limited';
  }
  if (telemetry.qualityLimitationReason === 'cpu') {
    return 'CPU Limited';
  }
  if (telemetry.adaptationStatus === 'degraded') {
    return 'Adapting Down';
  }
  if (telemetry.adaptationStatus === 'recovering') {
    return 'Recovering';
  }
  if (telemetry.scaleResolutionDownBy && telemetry.scaleResolutionDownBy > 1) {
    return `Scaled ÷${telemetry.scaleResolutionDownBy.toFixed(1)}`;
  }
  return telemetry.connectionState === 'connected' ? 'Optimal' : '—';
}

export function TelemetryStrip({ telemetry, compact = false }: TelemetryStripProps) {
  const measuredRate = formatRate(telemetry.bitrateKbps);
  const targetRate =
    telemetry.targetBitrateKbps && telemetry.targetBitrateKbps > 0
      ? formatRate(telemetry.targetBitrateKbps)
      : null;

  const cells = [
    { label: 'Resolution', value: telemetry.resolution ?? '—' },
    {
      label: 'Bitrate',
      value:
        measuredRate !== '—'
          ? targetRate
            ? `${measuredRate} / ${targetRate}`
            : measuredRate
          : targetRate
            ? `Target ${targetRate}`
            : '—',
    },
    { label: 'Capture FPS', value: formatNumber(telemetry.captureFps, '') },
    { label: 'Encoded FPS', value: formatNumber(telemetry.encodedFps, '') },
    { label: 'Decoded FPS', value: formatNumber(telemetry.decodedFps, '') },
    { label: 'Target FPS', value: `${telemetry.targetFps}` },
    { label: 'Codec', value: telemetry.codecMimeType ?? '—' },
    { label: 'ABR State', value: formatAdaptationLabel(telemetry) },
    { label: 'RTT', value: formatNumber(telemetry.rttMs, ' ms') },
    { label: 'Packet Loss', value: formatNumber(telemetry.packetLossPct, '%', 2) },
    { label: 'Jitter', value: formatNumber(telemetry.jitterMs, ' ms') },
    {
      label: 'Dropped',
      value: telemetry.droppedFrames === null ? '—' : `${telemetry.droppedFrames}`,
    },
  ];

  const visibleCells = compact
    ? [cells[0], cells[1], cells[3], cells[4], cells[6], cells[7]]
    : cells;

  return (
    <div
      className={`grid grid-cols-2 ${
        compact ? 'sm:grid-cols-3 lg:grid-cols-6' : 'sm:grid-cols-4 lg:grid-cols-6'
      } divide-x divide-y divide-[#E2E8F0] overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC]`}
    >
      {visibleCells.map((cell) => (
        <div key={cell.label} className="px-3 py-2">
          <div className="text-[11px] font-medium text-[#64748B]">{cell.label}</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-[#172033] tabular-metrics">
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}
