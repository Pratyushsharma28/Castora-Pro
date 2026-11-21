import type { StreamTelemetrySnapshot, WebRtcConnectionPhase } from '../types/studio';

interface PriorRtpSample {
  timestampMs: number;
  bytes: number;
  frames: number;
  packetsLost: number;
  packetsTotal: number;
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
  };
}

export class WebRtcStatsCollector {
  private readonly role: 'sender' | 'receiver';
  private priorRtp: PriorRtpSample | null = null;

  constructor(role: 'sender' | 'receiver') {
    this.role = role;
  }

  reset(): void {
    this.priorRtp = null;
  }

  async sample(params: {
    pc: RTCPeerConnection | null;
    targetFps: number;
    connectionState: WebRtcConnectionPhase;
    localVideoTrack?: MediaStreamTrack | null;
  }): Promise<StreamTelemetrySnapshot> {
    const base = createEmptyTelemetry(params.targetFps, params.connectionState);

    if (params.localVideoTrack) {
      const settings = params.localVideoTrack.getSettings();
      if (typeof settings.width === 'number' && typeof settings.height === 'number') {
        base.resolution = `${settings.width}×${settings.height}`;
      }
      if (typeof settings.frameRate === 'number' && Number.isFinite(settings.frameRate)) {
        base.captureFps = settings.frameRate;
      }
    }

    if (!params.pc || params.pc.signalingState === 'closed') {
      return base;
    }

    let report: RTCStatsReport;
    try {
      report = await params.pc.getStats();
    } catch {
      return base;
    }

    let selectedPairRttSec: number | null = null;
    let activeTransportPairId: string | null = null;

    report.forEach((stat) => {
      if (stat.type === 'transport') {
        const t = stat as RTCTransportStats;
        if (typeof t.selectedCandidatePairId === 'string') {
          activeTransportPairId = t.selectedCandidatePairId;
        }
      }
    });

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair') {
        const pair = stat as RTCIceCandidatePairStats;
        const isSelected =
          (activeTransportPairId && pair.id === activeTransportPairId) ||
          (pair.nominated && pair.state === 'succeeded');
        if (isSelected && typeof pair.currentRoundTripTime === 'number') {
          selectedPairRttSec = pair.currentRoundTripTime;
        }
      }
    });

    if (selectedPairRttSec !== null) {
      base.rttMs = selectedPairRttSec * 1000;
    }

    if (this.role === 'sender') {
      this.extractSenderStats(report, base);
    } else {
      this.extractReceiverStats(report, base);
    }

    return base;
  }

  private extractSenderStats(report: RTCStatsReport, target: StreamTelemetrySnapshot): void {
    let outbound: Record<string, unknown> | null = null;
    let remoteInbound: Record<string, unknown> | null = null;
    let mediaSource: Record<string, unknown> | null = null;

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'outbound-rtp' && rec.kind === 'video') {
        outbound = rec;
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
      if (typeof ms.width === 'number' && typeof ms.height === 'number') {
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

      if (this.priorRtp && ts > this.priorRtp.timestampMs) {
        const dtSec = (ts - this.priorRtp.timestampMs) / 1000;
        const dBytes = Math.max(0, bytesSent - this.priorRtp.bytes);
        target.bitrateKbps = (dBytes * 8) / 1000 / dtSec;

        if (target.encodedFps === null && framesEncoded >= this.priorRtp.frames) {
          target.encodedFps = (framesEncoded - this.priorRtp.frames) / dtSec;
        }
      }

      this.priorRtp = {
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

  private extractReceiverStats(report: RTCStatsReport, target: StreamTelemetrySnapshot): void {
    let inbound: Record<string, unknown> | null = null;

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'inbound-rtp' && rec.kind === 'video') {
        inbound = rec;
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

    if (this.priorRtp && ts > this.priorRtp.timestampMs) {
      const dtSec = (ts - this.priorRtp.timestampMs) / 1000;
      const dBytes = Math.max(0, bytesReceived - this.priorRtp.bytes);
      target.bitrateKbps = (dBytes * 8) / 1000 / dtSec;

      if (target.decodedFps === null && framesDecoded >= this.priorRtp.frames) {
        target.decodedFps = (framesDecoded - this.priorRtp.frames) / dtSec;
      }

      const dTotal = packetsTotal - this.priorRtp.packetsTotal;
      const dLost = Math.max(0, packetsLost - this.priorRtp.packetsLost);
      if (dTotal > 0) {
        target.packetLossPct = Math.min(100, (dLost / dTotal) * 100);
      }
    }

    this.priorRtp = {
      timestampMs: ts,
      bytes: bytesReceived,
      frames: framesDecoded,
      packetsLost: Math.max(0, packetsLost),
      packetsTotal,
    };
  }
}
