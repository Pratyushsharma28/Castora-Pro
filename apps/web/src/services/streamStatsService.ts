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

interface PriorAudioSample {
  timestampMs: number;
  bytes: number;
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
    captureWidth: null,
    captureHeight: null,
    encodedWidth: null,
    encodedHeight: null,
    framesSent: null,
    framesEncoded: null,
    decodedWidth: null,
    decodedHeight: null,
    framesDecoded: null,
    renderedWidth: null,
    renderedHeight: null,
    configuredMaxBitrateKbps: null,
    targetBitrateKbps: null,
    targetFramerate: null,
    availableOutgoingBitrateKbps: null,
    qualityLimitationReason: null,
    codecMimeType: null,
    scaleResolutionDownBy: null,
    adaptationStatus: null,
    adaptiveMode: null,
    networkCondition: null,
    lastAdjustmentReason: null,
    lastAdjustmentAt: null,
    lastAdjustmentAction: null,
    supportedAdaptiveControls: null,
    selectedVideoCodec: null,
    negotiatedVideoCodec: null,
    negotiatedVideoProfile: null,
    codecFallbackReason: null,
    negotiatedAudioCodec: null,
    audioCaptureStatus: null,
    audioSenderTrackStatus: null,
    audioReceiverTrackStatus: null,
    audioPacketsSent: null,
    audioBytesSent: null,
    audioPacketsReceived: null,
    audioBytesReceived: null,
    audioBitrateKbps: null,
    audioPlaybackStatus: null,
    autoplayBlocked: null,
    audioDiagnosticStatus: null,
    lastSuccessfulVideoFrameAt: null,
    lastSuccessfulAudioPacketAt: null,
  };
}

function normalizeVideoCodecLabel(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string' || !mimeType) return null;
  if (/^audio\//i.test(mimeType)) return null;
  return mimeType.replace(/^video\//i, '').toUpperCase();
}

function normalizeAudioCodecLabel(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string' || !mimeType) return null;
  if (/^video\//i.test(mimeType)) return null;
  return mimeType.replace(/^audio\//i, '').toUpperCase();
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
  private priorOutboundAudio: PriorAudioSample | null = null;
  private priorInboundAudio: PriorAudioSample | null = null;

  constructor(role: 'sender' | 'receiver' | 'bidirectional' = 'bidirectional') {
    this.role = role;
  }

  reset(): void {
    this.priorOutbound = null;
    this.priorInbound = null;
    this.priorOutboundAudio = null;
    this.priorInboundAudio = null;
  }

  resetOutbound(): void {
    this.priorOutbound = null;
    this.priorOutboundAudio = null;
  }

  resetInbound(): void {
    this.priorInbound = null;
    this.priorInboundAudio = null;
  }

  async sample(params: {
    pc: RTCPeerConnection | null;
    targetFps: number;
    connectionState: WebRtcConnectionPhase;
    localVideoTrack?: MediaStreamTrack | null;
    localAudioTrack?: MediaStreamTrack | null;
  }): Promise<StreamTelemetrySnapshot> {
    const dual = await this.sampleBidirectional({
      pc: params.pc,
      outboundTargetFps: params.targetFps,
      inboundTargetFps: params.targetFps,
      connectionState: params.connectionState,
      localVideoTrack: params.localVideoTrack ?? null,
      localAudioTrack: params.localAudioTrack ?? null,
      hasInboundVideo: this.role !== 'sender',
      hasInboundAudio: this.role !== 'sender',
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
    localAudioTrack?: MediaStreamTrack | null;
    hasInboundVideo: boolean;
    hasInboundAudio?: boolean;
  }): Promise<BidirectionalTelemetrySample> {
    const outbound = createEmptyTelemetry(params.outboundTargetFps, params.connectionState);
    const inbound = createEmptyTelemetry(params.inboundTargetFps, params.connectionState);

    if (params.localVideoTrack && params.localVideoTrack.readyState === 'live') {
      const settings = params.localVideoTrack.getSettings();
      if (
        typeof settings.width === 'number' &&
        typeof settings.height === 'number' &&
        Number.isFinite(settings.width) &&
        Number.isFinite(settings.height) &&
        settings.width > 0 &&
        settings.height > 0
      ) {
        outbound.captureWidth = settings.width;
        outbound.captureHeight = settings.height;
        outbound.resolution = `${settings.width}×${settings.height}`;
      }
      if (
        typeof settings.frameRate === 'number' &&
        Number.isFinite(settings.frameRate) &&
        settings.frameRate > 0
      ) {
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
    const videoCodecMap = new Map<string, string>();
    const audioCodecMap = new Map<string, string>();

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'transport') {
        const t = stat as RTCTransportStats;
        if (typeof t.selectedCandidatePairId === 'string') {
          activeTransportPairId = t.selectedCandidatePairId;
        }
      } else if (stat.type === 'codec' && typeof stat.id === 'string') {
        const videoLabel = normalizeVideoCodecLabel(rec.mimeType);
        if (videoLabel) {
          videoCodecMap.set(stat.id, videoLabel);
        }
        const audioLabel = normalizeAudioCodecLabel(rec.mimeType);
        if (audioLabel) {
          audioCodecMap.set(stat.id, audioLabel);
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

    const hasLiveLocalVideo = Boolean(
      params.localVideoTrack && params.localVideoTrack.readyState === 'live'
    );
    const hasLiveLocalAudio = Boolean(
      params.localAudioTrack && params.localAudioTrack.readyState === 'live'
    );

    if (hasLiveLocalVideo || hasLiveLocalAudio) {
      this.extractSenderStats(report, outbound, videoCodecMap, audioCodecMap);
    } else {
      this.priorOutbound = null;
      this.priorOutboundAudio = null;
    }

    if (params.hasInboundVideo || params.hasInboundAudio) {
      this.extractReceiverStats(report, inbound, videoCodecMap, audioCodecMap);
    } else {
      this.priorInbound = null;
      this.priorInboundAudio = null;
    }

    return { outbound, inbound };
  }

  private extractSenderStats(
    report: RTCStatsReport,
    target: StreamTelemetrySnapshot,
    videoCodecMap: Map<string, string>,
    audioCodecMap: Map<string, string>
  ): void {
    let outboundVideo: Record<string, unknown> | null = null;
    let outboundAudio: Record<string, unknown> | null = null;
    let remoteInboundVideo: Record<string, unknown> | null = null;
    let mediaSourceVideo: Record<string, unknown> | null = null;

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'outbound-rtp' && rec.kind === 'video') {
        if (rec.active !== false || !outboundVideo) {
          outboundVideo = rec;
        }
      } else if (stat.type === 'outbound-rtp' && rec.kind === 'audio') {
        if (rec.active !== false || !outboundAudio) {
          outboundAudio = rec;
        }
      } else if (stat.type === 'remote-inbound-rtp' && rec.kind === 'video') {
        remoteInboundVideo = rec;
      } else if (stat.type === 'media-source' && rec.kind === 'video') {
        mediaSourceVideo = rec;
      }
    });

    if (mediaSourceVideo) {
      const ms = mediaSourceVideo as Record<string, unknown>;
      if (
        target.captureFps === null &&
        typeof ms.framesPerSecond === 'number' &&
        Number.isFinite(ms.framesPerSecond) &&
        ms.framesPerSecond > 0
      ) {
        target.captureFps = ms.framesPerSecond;
      }
      if (
        target.captureWidth === null &&
        typeof ms.width === 'number' &&
        typeof ms.height === 'number' &&
        ms.width > 0 &&
        ms.height > 0
      ) {
        target.captureWidth = ms.width;
        target.captureHeight = ms.height;
        target.resolution = target.resolution ?? `${ms.width}×${ms.height}`;
      }
    }

    const ri = remoteInboundVideo as Record<string, unknown> | null;

    if (outboundVideo) {
      const ob = outboundVideo as Record<string, unknown>;
      const ts = typeof ob.timestamp === 'number' ? ob.timestamp : performance.now();
      const bytesSent =
        typeof ob.bytesSent === 'number' && Number.isFinite(ob.bytesSent) ? ob.bytesSent : null;
      const framesEncoded =
        typeof ob.framesEncoded === 'number' && Number.isFinite(ob.framesEncoded)
          ? ob.framesEncoded
          : null;
      const framesSent =
        typeof ob.framesSent === 'number' && Number.isFinite(ob.framesSent)
          ? ob.framesSent
          : null;

      target.framesEncoded = framesEncoded;
      target.framesSent = framesSent;

      if (
        typeof ob.frameWidth === 'number' &&
        typeof ob.frameHeight === 'number' &&
        Number.isFinite(ob.frameWidth) &&
        Number.isFinite(ob.frameHeight) &&
        ob.frameWidth > 0 &&
        ob.frameHeight > 0
      ) {
        target.encodedWidth = ob.frameWidth;
        target.encodedHeight = ob.frameHeight;
        target.resolution = `${ob.frameWidth}×${ob.frameHeight}`;
      }

      if (typeof ob.framesPerSecond === 'number' && Number.isFinite(ob.framesPerSecond)) {
        target.encodedFps = ob.framesPerSecond;
      }

      if (typeof ob.codecId === 'string' && videoCodecMap.has(ob.codecId)) {
        const videoCodec = videoCodecMap.get(ob.codecId) ?? null;
        target.codecMimeType = videoCodec;
        target.negotiatedVideoCodec = videoCodec;
      }

      target.qualityLimitationReason = normalizeLimitationReason(ob.qualityLimitationReason);

      if (typeof ob.framesDropped === 'number' && Number.isFinite(ob.framesDropped)) {
        target.droppedFrames = ob.framesDropped;
      }

      if (
        typeof ob.targetBitrate === 'number' &&
        Number.isFinite(ob.targetBitrate) &&
        ob.targetBitrate > 0
      ) {
        target.targetBitrateKbps = ob.targetBitrate / 1000;
      }

      const frameCounter = framesEncoded ?? framesSent ?? 0;
      const packetsSent =
        typeof ob.packetsSent === 'number' && Number.isFinite(ob.packetsSent)
          ? ob.packetsSent
          : 0;
      const remotePacketsLost =
        ri &&
        typeof ri.packetsLost === 'number' &&
        Number.isFinite(ri.packetsLost)
          ? Math.max(0, ri.packetsLost)
          : 0;
      const packetsTotal = Math.max(0, packetsSent);

      if (this.priorOutbound && ts > this.priorOutbound.timestampMs) {
        const dtSec = (ts - this.priorOutbound.timestampMs) / 1000;
        if (bytesSent !== null && bytesSent >= this.priorOutbound.bytes) {
          const dBytes = bytesSent - this.priorOutbound.bytes;
          target.bitrateKbps = (dBytes * 8) / 1000 / dtSec;
        }

        if (
          target.encodedFps === null &&
          (framesEncoded !== null || framesSent !== null) &&
          frameCounter >= this.priorOutbound.frames
        ) {
          target.encodedFps = (frameCounter - this.priorOutbound.frames) / dtSec;
        }

        if (ri && typeof ri.fractionLost !== 'number') {
          const dTotal = packetsTotal - this.priorOutbound.packetsTotal;
          const dLost = Math.max(0, remotePacketsLost - this.priorOutbound.packetsLost);
          if (dTotal > 0 && typeof ri.packetsLost === 'number') {
            target.packetLossPct = Math.min(100, (dLost / dTotal) * 100);
          }
        }
      }

      this.priorOutbound = {
        timestampMs: ts,
        bytes: bytesSent ?? 0,
        frames: frameCounter,
        packetsLost: remotePacketsLost,
        packetsTotal,
      };
    }

    if (outboundAudio) {
      const oa = outboundAudio as Record<string, unknown>;
      const ts = typeof oa.timestamp === 'number' ? oa.timestamp : performance.now();
      const audioBytesSent =
        typeof oa.bytesSent === 'number' && Number.isFinite(oa.bytesSent) ? oa.bytesSent : null;
      const audioPacketsSent =
        typeof oa.packetsSent === 'number' && Number.isFinite(oa.packetsSent) ? oa.packetsSent : null;

      target.audioBytesSent = audioBytesSent;
      target.audioPacketsSent = audioPacketsSent;

      if (typeof oa.codecId === 'string' && audioCodecMap.has(oa.codecId)) {
        target.negotiatedAudioCodec = audioCodecMap.get(oa.codecId) ?? null;
      }

      if (
        this.priorOutboundAudio &&
        ts > this.priorOutboundAudio.timestampMs &&
        audioBytesSent !== null &&
        audioBytesSent >= this.priorOutboundAudio.bytes
      ) {
        const dtSec = (ts - this.priorOutboundAudio.timestampMs) / 1000;
        target.audioBitrateKbps = ((audioBytesSent - this.priorOutboundAudio.bytes) * 8) / 1000 / dtSec;
      }

      this.priorOutboundAudio = {
        timestampMs: ts,
        bytes: audioBytesSent ?? 0,
      };
    } else {
      this.priorOutboundAudio = null;
    }

    if (ri) {
      if (typeof ri.roundTripTime === 'number' && Number.isFinite(ri.roundTripTime)) {
        target.rttMs = ri.roundTripTime * 1000;
      }
      if (typeof ri.fractionLost === 'number' && Number.isFinite(ri.fractionLost)) {
        target.packetLossPct = Math.max(0, ri.fractionLost * 100);
      }
      if (typeof ri.jitter === 'number' && Number.isFinite(ri.jitter)) {
        target.jitterMs = ri.jitter * 1000;
      }
      if (
        target.droppedFrames === null &&
        typeof ri.framesDropped === 'number' &&
        Number.isFinite(ri.framesDropped)
      ) {
        target.droppedFrames = ri.framesDropped;
      }
    }
  }

  private extractReceiverStats(
    report: RTCStatsReport,
    target: StreamTelemetrySnapshot,
    videoCodecMap: Map<string, string>,
    audioCodecMap: Map<string, string>
  ): void {
    let inboundVideo: Record<string, unknown> | null = null;
    let inboundAudio: Record<string, unknown> | null = null;

    report.forEach((stat) => {
      const rec = stat as unknown as Record<string, unknown>;
      if (stat.type === 'inbound-rtp' && rec.kind === 'video') {
        const bytes = typeof rec.bytesReceived === 'number' ? rec.bytesReceived : 0;
        const prevBytes =
          inboundVideo && typeof inboundVideo.bytesReceived === 'number'
            ? inboundVideo.bytesReceived
            : -1;
        if (!inboundVideo || bytes >= prevBytes) {
          inboundVideo = rec;
        }
      } else if (stat.type === 'inbound-rtp' && rec.kind === 'audio') {
        const bytes = typeof rec.bytesReceived === 'number' ? rec.bytesReceived : 0;
        const prevBytes =
          inboundAudio && typeof inboundAudio.bytesReceived === 'number'
            ? inboundAudio.bytesReceived
            : -1;
        if (!inboundAudio || bytes >= prevBytes) {
          inboundAudio = rec;
        }
      }
    });

    if (inboundVideo) {
      const ib = inboundVideo as Record<string, unknown>;
      const ts = typeof ib.timestamp === 'number' ? ib.timestamp : performance.now();
      const bytesReceived =
        typeof ib.bytesReceived === 'number' && Number.isFinite(ib.bytesReceived)
          ? ib.bytesReceived
          : null;
      const framesDecoded =
        typeof ib.framesDecoded === 'number' && Number.isFinite(ib.framesDecoded)
          ? ib.framesDecoded
          : null;
      const packetsLost =
        typeof ib.packetsLost === 'number' && Number.isFinite(ib.packetsLost) ? ib.packetsLost : 0;
      const packetsReceived =
        typeof ib.packetsReceived === 'number' && Number.isFinite(ib.packetsReceived)
          ? ib.packetsReceived
          : 0;
      const packetsTotal = Math.max(0, packetsReceived + Math.max(0, packetsLost));

      target.framesDecoded = framesDecoded;

      if (
        typeof ib.frameWidth === 'number' &&
        typeof ib.frameHeight === 'number' &&
        Number.isFinite(ib.frameWidth) &&
        Number.isFinite(ib.frameHeight) &&
        ib.frameWidth > 0 &&
        ib.frameHeight > 0
      ) {
        target.decodedWidth = ib.frameWidth;
        target.decodedHeight = ib.frameHeight;
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

      if (typeof ib.codecId === 'string' && videoCodecMap.has(ib.codecId)) {
        const videoCodec = videoCodecMap.get(ib.codecId) ?? null;
        target.codecMimeType = videoCodec;
        target.negotiatedVideoCodec = videoCodec;
      }

      if (this.priorInbound && ts > this.priorInbound.timestampMs) {
        const dtSec = (ts - this.priorInbound.timestampMs) / 1000;
        if (bytesReceived !== null && bytesReceived >= this.priorInbound.bytes) {
          const dBytes = bytesReceived - this.priorInbound.bytes;
          target.bitrateKbps = (dBytes * 8) / 1000 / dtSec;
        }

        if (
          target.decodedFps === null &&
          framesDecoded !== null &&
          framesDecoded >= this.priorInbound.frames
        ) {
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
        bytes: bytesReceived ?? 0,
        frames: framesDecoded ?? 0,
        packetsLost: Math.max(0, packetsLost),
        packetsTotal,
      };
    }

    if (inboundAudio) {
      const ia = inboundAudio as Record<string, unknown>;
      const ts = typeof ia.timestamp === 'number' ? ia.timestamp : performance.now();
      const audioBytesReceived =
        typeof ia.bytesReceived === 'number' && Number.isFinite(ia.bytesReceived)
          ? ia.bytesReceived
          : null;
      const audioPacketsReceived =
        typeof ia.packetsReceived === 'number' && Number.isFinite(ia.packetsReceived)
          ? ia.packetsReceived
          : null;

      target.audioBytesReceived = audioBytesReceived;
      target.audioPacketsReceived = audioPacketsReceived;

      if (typeof ia.codecId === 'string' && audioCodecMap.has(ia.codecId)) {
        target.negotiatedAudioCodec = audioCodecMap.get(ia.codecId) ?? null;
      }

      if (
        this.priorInboundAudio &&
        ts > this.priorInboundAudio.timestampMs &&
        audioBytesReceived !== null &&
        audioBytesReceived >= this.priorInboundAudio.bytes
      ) {
        const dtSec = (ts - this.priorInboundAudio.timestampMs) / 1000;
        target.audioBitrateKbps =
          ((audioBytesReceived - this.priorInboundAudio.bytes) * 8) / 1000 / dtSec;
      }

      this.priorInboundAudio = {
        timestampMs: ts,
        bytes: audioBytesReceived ?? 0,
      };
    } else {
      this.priorInboundAudio = null;
    }
  }
}
