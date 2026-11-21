import type {
  QualityLimitationReason,
  StreamTelemetrySnapshot,
  WebRtcConnectionPhase,
} from '../types/studio';

interface PriorRtpSample {
  timestampMs: number;
  bytes: number;
  frames: number;
  packetsLost: number;
  packetsTotal: number;
}

export interface BidirectionalTelemetrySample {
  outbound: StreamTelemetrySnapshot;
  inbound: StreamTelemetrySnapshot;
}

export function createEmptyTelemetry(
  targetFps: number,
  connectionState: WebRtcConnectionPhase = 'idle'
): StreamTelemetrySnapshot {
  return {
    captureFps: null,
    encodedFps: null,
    decodedFps: null,
    targetFps,
    resolution: null,
    bitrateKbps: null,
    rttMs: null,
    packetLossPct: null,
    jitterMs: null,
    droppedFrames: null,
    connectionState,
    configuredMaxBitrateKbps: null,
    targetBitrateKbps: null,
    availableOutgoingBitrateKbps: null,
    qualityLimitationReason: null,
    codecMimeType: null,
    scaleResolutionDownBy: null,
    adaptationStatus: null,
  };
}

function normalizeCodecLabel(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string' || !mimeType) return null;
  return mimeType.replace(/^video\//i, '').toUpperCase();
}

function normalizeLimitationReason(reason: unknown): QualityLimitationReason | null {
  if (reason === 'none' || reason === 'cpu' || reason === 'bandwidth' || reason === 'other') {
    return reason;
  }
  return null;
}

export class WebRtcStatsCollector {
  private readonly role: 'sender' | 'receiver' | 'bidirectional';
  private priorOutbound: PriorRtpSample | null = null;
  private priorInbound: PriorRtpSample | null = null;

  constructor(role: 'sender' | 'receiver' | 'bidirectional' = 'bidirectional') {
    this.role = role;
  }

  reset(): void {
    this.priorOutbound = null;
    this.priorInbound = null;
  }

  resetOutbound(): void {
    this.priorOutbound = null;
  }

  resetInbound(): void {
    this.priorInbound = null;
  }

  async sample(params: {
    pc: RTCPeerConnection | null;
    targetFps: number;
    connectionState: WebRtcConnectionPhase;
    localVideoTrack?: MediaStreamTrack | null;
  }): Promise<StreamTelemetrySnapshot> {
    const dual = await this.sampleBidirectional({
      pc: params.pc,
      outboundTargetFps: params.targetFps,
      inboundTargetFps: params.targetFps,
      connectionState: params.connectionState,
      localVideoTrack: params.localVideoTrack ?? null,
      hasInboundVideo: this.role !== 'sender',
    });
    if (this.role === 'receiver') {
      return dual.inbound;
    }
    return dual.outbound;
  }

  async sampleBidirectional(params: {
    pc: RTCPeerConnection | null;
    outboundTargetFps: number;
    inboundTargetFps: number;
    connectionState: WebRtcConnectionPhase;
    localVideoTrack?: MediaStreamTrack | null;
    hasInboundVideo: boolean;
  }): Promise<BidirectionalTelemetrySample> {
    const outbound = createEmptyTelemetry(params.outboundTargetFps, params.connectionState);
    const inbound = createEmptyTelemetry(params.inboundTargetFps, params.connectionState);

    if (params.localVideoTrack && params.localVideoTrack.readyState === 'live') {
      const settings = params.localVideoTrack.getSettings();
      if (typeof settings.width === 'number' && typeof settings.height === 'number') {
        outbound.resolution = `${settings.width}×${settings.height}`;
      }
      if (typeof settings.frameRate === 'number' && Number.isFinite(settings.frameRate)) {
        outbound.captureFps = settings.frameRate;
      }
    }

    if (!params.pc || params.pc.signalingState === 'closed') {
      return { outbound, inbound };
    }

    let report: RTCStatsReport;
    try {
      report = await params.pc.getStats();
    } catch {
      return { outbound, inbound };
    }

    let selectedPairRttSec: number | null = null;
    let availableOutgoingBps: number | null = null;
    let activeTransportPairId: string | null = null;
    const codecMap = new Map<string, string>();

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'transport') {
        const t = stat as RTCTransportStats;
        if (typeof t.selectedCandidatePairId === 'string') {
          activeTransportPairId = t.selectedCandidatePairId;
        }
      } else if (stat.type === 'codec' && typeof stat.id === 'string') {
        const label = normalizeCodecLabel(rec.mimeType);
        if (label) {
          codecMap.set(stat.id, label);
        }
      }
    });

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair') {
        const pair = stat as RTCIceCandidatePairStats & {
          availableOutgoingBitrate?: number;
        };
        const isSelected =
          (activeTransportPairId && pair.id === activeTransportPairId) ||
          (pair.nominated && pair.state === 'succeeded');
        if (isSelected) {
          if (typeof pair.currentRoundTripTime === 'number') {
            selectedPairRttSec = pair.currentRoundTripTime;
          }
          if (
            typeof pair.availableOutgoingBitrate === 'number' &&
            Number.isFinite(pair.availableOutgoingBitrate) &&
            pair.availableOutgoingBitrate > 0
          ) {
            availableOutgoingBps = pair.availableOutgoingBitrate;
          }
        }
      }
    });

    if (selectedPairRttSec !== null) {
      outbound.rttMs = selectedPairRttSec * 1000;
      inbound.rttMs = selectedPairRttSec * 1000;
    }

    if (availableOutgoingBps !== null) {
      outbound.availableOutgoingBitrateKbps = availableOutgoingBps / 1000;
    }

    if (params.localVideoTrack && params.localVideoTrack.readyState === 'live') {
      this.extractSenderStats(report, outbound, codecMap);
    } else {
      this.priorOutbound = null;
    }

    if (params.hasInboundVideo) {
      this.extractReceiverStats(report, inbound, codecMap);
    } else {
      this.priorInbound = null;
    }

    return { outbound, inbound };
  }

  private extractSenderStats(
    report: RTCStatsReport,
    target: StreamTelemetrySnapshot,
    codecMap: Map<string, string>
  ): void {
    let outbound: Record<string, unknown> | null = null;
    let remoteInbound: Record<string, unknown> | null = null;
    let mediaSource: Record<string, unknown> | null = null;

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'outbound-rtp' && rec.kind === 'video') {
        if (rec.active !== false || !outbound) {
          outbound = rec;
        }
      } else if (stat.type === 'remote-inbound-rtp' && rec.kind === 'video') {
        remoteInbound = rec;
      } else if (stat.type === 'media-source' && rec.kind === 'video') {
        mediaSource = rec;
      }
    });

    if (mediaSource) {
      const ms = mediaSource as Record<string, unknown>;
      if (typeof ms.framesPerSecond === 'number' && Number.isFinite(ms.framesPerSecond)) {
        target.captureFps = ms.framesPerSecond;
      }
      if (typeof ms.width === 'number' && typeof ms.height === 'number' && ms.width > 0) {
        target.resolution = `${ms.width}×${ms.height}`;
      }
    }

    if (outbound) {
      const ob = outbound as Record<string, unknown>;
      const ts = typeof ob.timestamp === 'number' ? ob.timestamp : performance.now();
      const bytesSent = typeof ob.bytesSent === 'number' ? ob.bytesSent : 0;
      const framesEncoded = typeof ob.framesEncoded === 'number' ? ob.framesEncoded : 0;

      if (typeof ob.frameWidth === 'number' && typeof ob.frameHeight === 'number' && ob.frameWidth > 0) {
        target.resolution = `${ob.frameWidth}×${ob.frameHeight}`;
      }

      if (typeof ob.framesPerSecond === 'number' && Number.isFinite(ob.framesPerSecond)) {
        target.encodedFps = ob.framesPerSecond;
      }

      if (typeof ob.codecId === 'string' && codecMap.has(ob.codecId)) {
        target.codecMimeType = codecMap.get(ob.codecId) ?? null;
      }

      target.qualityLimitationReason = normalizeLimitationReason(ob.qualityLimitationReason);

      if (
        typeof ob.targetBitrate === 'number' &&
        Number.isFinite(ob.targetBitrate) &&
        ob.targetBitrate > 0
      ) {
        target.targetBitrateKbps = ob.targetBitrate / 1000;
      }

      if (this.priorOutbound && ts > this.priorOutbound.timestampMs) {
        const dtSec = (ts - this.priorOutbound.timestampMs) / 1000;
        const dBytes = Math.max(0, bytesSent - this.priorOutbound.bytes);
        target.bitrateKbps = (dBytes * 8) / 1000 / dtSec;

        if (target.encodedFps === null && framesEncoded >= this.priorOutbound.frames) {
          target.encodedFps = (framesEncoded - this.priorOutbound.frames) / dtSec;
        }
      }

      this.priorOutbound = {
        timestampMs: ts,
        bytes: bytesSent,
        frames: framesEncoded,
        packetsLost: 0,
        packetsTotal: 0,
      };
    }

    if (remoteInbound) {
      const ri = remoteInbound as Record<string, unknown>;
      if (typeof ri.roundTripTime === 'number' && Number.isFinite(ri.roundTripTime)) {
        target.rttMs = ri.roundTripTime * 1000;
      }
      if (typeof ri.fractionLost === 'number' && Number.isFinite(ri.fractionLost)) {
        target.packetLossPct = Math.max(0, ri.fractionLost * 100);
      }
      if (typeof ri.jitter === 'number' && Number.isFinite(ri.jitter)) {
        target.jitterMs = ri.jitter * 1000;
      }
    }
  }

  private extractReceiverStats(
    report: RTCStatsReport,
    target: StreamTelemetrySnapshot,
    codecMap: Map<string, string>
  ): void {
    let inbound: Record<string, unknown> | null = null;

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'inbound-rtp' && rec.kind === 'video') {
        const bytes = typeof rec.bytesReceived === 'number' ? rec.bytesReceived : 0;
        const prevBytes =
          inbound && typeof inbound.bytesReceived === 'number' ? inbound.bytesReceived : -1;
        if (!inbound || bytes >= prevBytes) {
          inbound = rec;
        }
      }
    });

    if (!inbound) return;

    const ib = inbound as Record<string, unknown>;
    const ts = typeof ib.timestamp === 'number' ? ib.timestamp : performance.now();
    const bytesReceived = typeof ib.bytesReceived === 'number' ? ib.bytesReceived : 0;
    const framesDecoded = typeof ib.framesDecoded === 'number' ? ib.framesDecoded : 0;
    const packetsLost = typeof ib.packetsLost === 'number' ? ib.packetsLost : 0;
    const packetsReceived = typeof ib.packetsReceived === 'number' ? ib.packetsReceived : 0;
    const packetsTotal = Math.max(0, packetsReceived + Math.max(0, packetsLost));

    if (typeof ib.frameWidth === 'number' && typeof ib.frameHeight === 'number' && ib.frameWidth > 0) {
      target.resolution = `${ib.frameWidth}×${ib.frameHeight}`;
    }

    if (typeof ib.framesPerSecond === 'number' && Number.isFinite(ib.framesPerSecond)) {
      target.decodedFps = ib.framesPerSecond;
    }

    if (typeof ib.framesDropped === 'number' && Number.isFinite(ib.framesDropped)) {
      target.droppedFrames = ib.framesDropped;
    }

    if (typeof ib.jitter === 'number' && Number.isFinite(ib.jitter)) {
      target.jitterMs = ib.jitter * 1000;
    }

    if (typeof ib.codecId === 'string' && codecMap.has(ib.codecId)) {
      target.codecMimeType = codecMap.get(ib.codecId) ?? null;
    }

    if (this.priorInbound && ts > this.priorInbound.timestampMs) {
      const dtSec = (ts - this.priorInbound.timestampMs) / 1000;
      const dBytes = Math.max(0, bytesReceived - this.priorInbound.bytes);
      target.bitrateKbps = (dBytes * 8) / 1000 / dtSec;

      if (target.decodedFps === null && framesDecoded >= this.priorInbound.frames) {
        target.decodedFps = (framesDecoded - this.priorInbound.frames) / dtSec;
      }

      const dTotal = packetsTotal - this.priorInbound.packetsTotal;
      const dLost = Math.max(0, packetsLost - this.priorInbound.packetsLost);
      if (dTotal > 0) {
        target.packetLossPct = Math.min(100, (dLost / dTotal) * 100);
      }
    }

    this.priorInbound = {
      timestampMs: ts,
      bytes: bytesReceived,
      frames: framesDecoded,
      packetsLost: Math.max(0, packetsLost),
      packetsTotal,
    };
  }
}
