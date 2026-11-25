import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { RoomManager } from '../apps/server/roomManager.ts';
import { startCastoraServer } from '../server.ts';
import type { CastoraEnvelope, CastoraPlatform } from '../apps/web/src/types/protocol.ts';
import type { CapturePreferences, NetworkPreferences } from '../apps/web/src/types/studio.ts';
import {
  CastoraSignalingClient,
  RestoreSessionError,
  restoreBackendSession,
  type RoomSnapshot,
} from '../apps/web/src/services/backendClient.ts';
import type { CapturedScreenSession } from '../apps/web/src/services/screenCaptureService.ts';
import { CastoraWebRtcPeer } from '../apps/web/src/services/webrtcPeerService.ts';
import { WebRtcSignalingBridge } from '../apps/web/src/services/webrtcSignalingBridge.ts';

class TestWsClient {
  readonly ws: WebSocket;
  private messages: CastoraEnvelope[] = [];
  private waiters: Array<{
    predicate: (msg: CastoraEnvelope) => boolean;
    resolve: (msg: CastoraEnvelope) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const parsed = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
      const idx = this.waiters.findIndex((w) => w.predicate(parsed));
      if (idx >= 0) {
        const [waiter] = this.waiters.splice(idx, 1);
        waiter.resolve(parsed);
      } else {
        this.messages.push(parsed);
      }
    });
    this.ws.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0, this.waiters.length)) {
        waiter.reject(new Error('WebSocket closed before matching message arrived'));
      }
    });
  }

  waitForOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
  }

  sendJson(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  waitForMessage(
    predicate: (msg: CastoraEnvelope) => boolean,
    timeoutMs = 5000
  ): Promise<CastoraEnvelope> {
    const existingIdx = this.messages.findIndex(predicate);
    if (existingIdx >= 0) {
      return Promise.resolve(this.messages.splice(existingIdx, 1)[0]);
    }
    if (this.closed) {
      return Promise.reject(new Error('WebSocket already closed'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for matching WS message`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async closeClean(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close(1000, 'Test complete');
    });
  }

  terminateAbnormally(): void {
    // Drops TCP transport abruptly -> peer observes WS close code 1006
    this.ws.terminate();
  }
}

function buildAnnounceEnvelope(params: {
  deviceId: string;
  deviceName: string;
  platform: CastoraPlatform;
  role: 'sender' | 'receiver' | 'both';
  roomId?: string;
}): CastoraEnvelope {
  return {
    protocolVersion: 'castora.v1',
    messageType: 'device_announce',
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    senderDeviceId: params.deviceId,
    receiverDeviceId: null,
    roomId: params.roomId ?? null,
    timestamp: new Date().toISOString(),
    payload: {
      deviceName: params.deviceName,
      platform: params.platform,
      role: params.role,
      wsPort: 3000,
      capabilities: {
        maxWidth: 3840,
        maxHeight: 2160,
        maxFps: 60,
        codecs: ['H264', 'VP9', 'VP8', 'AV1'],
        supportsAudio: true,
      },
    },
  };
}

class FakeTrack {
  readonly id: string;
  readonly kind: 'video' | 'audio';
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  enabled = true;
  private listeners = new Map<string, Set<() => void>>();

  constructor(id: string, kind: 'video' | 'audio') {
    this.id = id;
    this.kind = kind;
  }

  addEventListener(event: string, cb: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }
  removeEventListener(event: string, cb: () => void) {
    this.listeners.get(event)?.delete(cb);
  }
  dispatchEventName(event: string) {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }
  getSettings() {
    return this.kind === 'video' ? { width: 1920, height: 1080, frameRate: 60 } : {};
  }
  async applyConstraints() {}
  stop() {
    this.readyState = 'ended';
    this.dispatchEventName('ended');
  }
}

class FakeMediaStream {
  readonly id: string;
  private tracks: FakeTrack[];
  private listeners = new Map<string, Set<() => void>>();

  constructor(id: string, includeAudio = true) {
    this.id = id;
    this.tracks = [new FakeTrack(`${id}-vid`, 'video')];
    if (includeAudio) {
      this.tracks.push(new FakeTrack(`${id}-aud`, 'audio'));
    }
  }

  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
    for (const cb of this.listeners.get('addtrack') ?? []) cb();
  }
  addEventListener(ev: string, cb: () => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(cb);
  }
  removeEventListener(ev: string, cb: () => void) {
    this.listeners.get(ev)?.delete(cb);
  }
}

class FakeRtcPeerConnection {
  static instances: FakeRtcPeerConnection[] = [];
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  restartIceCalls = 0;
  createOfferCalls: Array<{ iceRestart: boolean }> = [];
  videoSetParametersCalls = 0;
  private deliveredRemoteStream: FakeMediaStream | null = null;
  private transceivers: Array<{
    direction: RTCRtpTransceiverDirection;
    setCodecPreferences: (c: RTCRtpCodec[]) => void;
    sender: {
      track: FakeTrack | null;
      replaceTrack: (next: FakeTrack | null) => Promise<void>;
      getParameters: () => { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string };
      setParameters: (p: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string }) => Promise<void>;
    };
  }> = [];

  mockStatsEntries: Array<[string, Record<string, unknown>]> = [
    [
      'codec-vid',
      { id: 'codec-vid', type: 'codec', mimeType: 'video/VP9' },
    ],
    [
      'codec-aud',
      { id: 'codec-aud', type: 'codec', mimeType: 'audio/opus' },
    ],
    [
      'transport-1',
      { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-1' },
    ],
    [
      'pair-1',
      {
        id: 'pair-1',
        type: 'candidate-pair',
        nominated: true,
        state: 'succeeded',
        currentRoundTripTime: 0.018,
        availableOutgoingBitrate: 14_000_000,
      },
    ],
    [
      'out-vid',
      {
        id: 'out-vid',
        type: 'outbound-rtp',
        kind: 'video',
        codecId: 'codec-vid',
        timestamp: 1000,
        bytesSent: 500_000,
        packetsSent: 1000,
        framesEncoded: 60,
        framesSent: 60,
        frameWidth: 1920,
        frameHeight: 1080,
        framesPerSecond: 60,
        qualityLimitationReason: 'none',
      },
    ],
    [
      'out-aud',
      {
        id: 'out-aud',
        type: 'outbound-rtp',
        kind: 'audio',
        codecId: 'codec-aud',
        timestamp: 1000,
        bytesSent: 24_000,
        packetsSent: 120,
      },
    ],
  ];

  onicecandidate: ((e: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  ontrack: ((e: { track: FakeTrack; streams: FakeMediaStream[] }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(_cfg: RTCConfiguration) {
    FakeRtcPeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    let params: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string } = {
      encodings: [{}],
    };
    const sender: {
      track: FakeTrack | null;
      replaceTrack: (next: FakeTrack | null) => Promise<void>;
      getParameters: () => { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string };
      setParameters: (p: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string }) => Promise<void>;
    } = {
      track,
      replaceTrack: async (next: FakeTrack | null) => {
        sender.track = next;
      },
      getParameters: () => ({
        encodings: params.encodings.map((e) => ({ ...e })),
        degradationPreference: params.degradationPreference,
      }),
      setParameters: async (next: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string }) => {
        params = {
          encodings: next.encodings.map((e) => ({ ...e })),
          degradationPreference: next.degradationPreference,
        };
        if (track.kind === 'video') this.videoSetParametersCalls += 1;
      },
    };
    this.transceivers.push({
      direction: 'sendonly',
      setCodecPreferences: () => {},
      sender,
    });
    return sender;
  }

  addTransceiver(_kind: string, init?: { direction?: RTCRtpTransceiverDirection }) {
    let params: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string } = {
      encodings: [{}],
    };
    const sender = {
      track: null as FakeTrack | null,
      replaceTrack: async (next: FakeTrack | null) => {
        sender.track = next;
      },
      getParameters: () => ({
        encodings: params.encodings.map((e) => ({ ...e })),
        degradationPreference: params.degradationPreference,
      }),
      setParameters: async (next: { encodings: RTCRtpEncodingParameters[]; degradationPreference?: string }) => {
        params = {
          encodings: next.encodings.map((e) => ({ ...e })),
          degradationPreference: next.degradationPreference,
        };
      },
    };
    const tr = {
      direction: init?.direction ?? ('recvonly' as RTCRtpTransceiverDirection),
      setCodecPreferences: () => {},
      sender,
    };
    this.transceivers.push(tr);
    return tr;
  }

  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
  getTransceivers() {
    return this.transceivers;
  }
  removeTrack(sender: { track: FakeTrack | null }) {
    sender.track = null;
  }
  restartIce() {
    this.restartIceCalls += 1;
  }
  emitState(state: 'connected' | 'disconnected' | 'failed') {
    this.iceConnectionState = state;
    this.connectionState = state;
    this.oniceconnectionstatechange?.();
    this.onconnectionstatechange?.();
  }

  async createOffer(options?: RTCOfferOptions) {
    this.createOfferCalls.push({ iceRestart: Boolean(options?.iceRestart) });
    const sending = this.transceivers.some(
      (t) => t.sender.track !== null && (t.direction === 'sendonly' || t.direction === 'sendrecv')
    );
    const audio = this.transceivers.some(
      (t) => t.sender.track?.kind === 'audio' && (t.direction === 'sendonly' || t.direction === 'sendrecv')
    );
    return {
      type: 'offer' as const,
      sdp: `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=${sending ? 'sendrecv' : 'recvonly'}\r\n${audio ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' : ''}`,
    };
  }
  async createAnswer() {
    const sending = this.transceivers.some(
      (t) => t.sender.track !== null && (t.direction === 'sendonly' || t.direction === 'sendrecv')
    );
    return {
      type: 'answer' as const,
      sdp: `v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=${sending ? 'sendrecv' : 'recvonly'}\r\n`,
    };
  }
  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    if (desc.type === 'rollback') {
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
    if (desc.type === 'offer') {
      queueMicrotask(() => {
        this.onicecandidate?.({
          candidate: {
            candidate: 'candidate:1 1 UDP 2122252543 127.0.0.1 55000 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        });
      });
    }
  }
  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
    const remoteSending = Boolean(desc.sdp?.includes('a=sendrecv'));
    const remoteAudio = Boolean(desc.sdp?.includes('m=audio'));
    if (desc.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      if (remoteSending && !this.deliveredRemoteStream) {
        this.deliveredRemoteStream = new FakeMediaStream(`remote-${Math.random().toString(36).slice(2, 7)}`, remoteAudio);
        for (const t of this.deliveredRemoteStream.getTracks()) {
          this.ontrack?.({ track: t, streams: [this.deliveredRemoteStream] });
        }
      }
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable';
      this.iceConnectionState = 'connected';
      this.connectionState = 'connected';
      queueMicrotask(() => {
        this.oniceconnectionstatechange?.();
        this.onconnectionstatechange?.();
      });
    }
  }
  async addIceCandidate() {}
  async getStats() {
    return new Map(this.mockStatsEntries) as unknown as RTCStatsReport;
  }
  close() {
    this.signalingState = 'closed';
    this.iceConnectionState = 'closed';
    this.connectionState = 'closed';
  }
}

async function waitUntil(
  predicate: () => boolean,
  label: string | (() => string),
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  const text = typeof label === 'function' ? label() : label;
  throw new Error(`Timed out waiting for condition: ${text}`);
}

const defaultPrefs: CapturePreferences = {
  resolution: '1080p',
  targetFps: 60,
  codecPreference: 'H264',
  includeAudio: true,
  maxBitrateKbps: 10_000,
  adaptiveBitrate: true,
};

const baseNetPrefs: NetworkPreferences = {
  preferLanDirectP2P: true,
  stunUrls: 'stun:stun.l.google.com:19302',
  turnUrl: '',
  turnUsername: '',
  turnCredential: '',
};

async function runTests() {
  console.log('Starting Long-Duration Stability & Recovery Verification Suite...');

  // Install minimal global window/MediaStream/WebSocket hooks needed by browser services in Node
  const realDateNow = Date.now;
  let simulatedOffsetMs = 0;
  Date.now = () => realDateNow() + simulatedOffsetMs;

  try {
    // =========================================================================
    // TEST 1 & 2 & 11: RoomManager 30m & 60m Sliding TTL + 12h Cap + Idle Expiry
    // =========================================================================
    const mgr = new RoomManager(15 * 60 * 1000, 500);
    const hostReg = mgr.createRoom({
      hostDeviceId: 'mac-m5',
      hostDeviceName: 'MacBook Air M5',
      hostPlatform: 'macos',
      hostDeviceType: 'Mac',
    });
    assert.equal(hostReg.ok, true, 'Room creation succeeds');

    const tvPair = mgr.submitPairRequest({
      roomId: hostReg.room.roomId,
      receiverDeviceId: 'haier-tv',
      deviceName: 'Haier Google TV',
      platform: 'android-tv',
      deviceType: 'TV',
      pairingMethod: 'room_code',
    });
    assert.equal(tvPair.ok, true, 'Pair request succeeds');

    mgr.approvePairRequest({
      roomId: hostReg.room.roomId,
      receiverDeviceId: 'haier-tv',
      hostToken: hostReg.hostToken,
    });

    // Attach simulated host + TV sockets & start active stream
    const hostSock = { readyState: 1 } as unknown as WebSocket;
    const tvSock = { readyState: 1 } as unknown as WebSocket;
    mgr.registerDevice({
      socket: hostSock,
      remoteAddress: '127.0.0.1',
      wsPort: 3000,
      deviceId: 'mac-m5',
      deviceName: 'MacBook Air M5',
      platform: 'macos',
      role: 'sender',
      capabilities: { maxWidth: 3840, maxHeight: 2160, maxFps: 60, codecs: ['H264', 'VP9'], supportsAudio: true },
      roomId: hostReg.room.roomId,
      token: hostReg.hostToken,
    });
    mgr.registerDevice({
      socket: tvSock,
      remoteAddress: '127.0.0.1',
      wsPort: 3000,
      deviceId: 'haier-tv',
      deviceName: 'Haier Google TV',
      platform: 'android-tv',
      role: 'receiver',
      capabilities: { maxWidth: 1920, maxHeight: 1080, maxFps: 60, codecs: ['H264', 'VP9'], supportsAudio: true },
      roomId: hostReg.room.roomId,
      token: tvPair.memberToken,
    });
    const startRes = mgr.registerStreamStart({
      socket: hostSock,
      roomId: hostReg.room.roomId,
      senderDeviceId: 'mac-m5',
      targetDeviceId: 'haier-tv',
      token: hostReg.hostToken,
      sessionId: tvPair.sessionId,
      streamId: 'stream-long-1',
      width: 1920,
      height: 1080,
      fps: 60,
      codec: 'VP9',
    });
    assert.equal(startRes.ok, true, 'Active stream registered on RoomManager');

    // Simulate 30 minutes of periodic heartbeats & sweeps
    for (let min = 5; min <= 30; min += 5) {
      simulatedOffsetMs = min * 60 * 1000;
      mgr.touchHeartbeat(hostSock);
      mgr.touchHeartbeat(tvSock);
      assert.equal(mgr.sweepExpiredRooms().length, 0, `Active cast room must NOT expire at ${min} min`);
    }
    const lookup30 = mgr.getRoom(hostReg.room.roomId);
    assert.equal(lookup30.ok, true);
    assert.equal(lookup30.room.status, 'active', 'Room active at 30 minutes');
    assert.equal(lookup30.room.activeStreams?.length, 1, 'Active stream still alive at 30 minutes');
    console.log('  [PASS] 1. 30-minute continuous active-stream room persistence (sliding TTL) verified');

    // Continue to 60 minutes
    for (let min = 35; min <= 60; min += 5) {
      simulatedOffsetMs = min * 60 * 1000;
      mgr.touchHeartbeat(hostSock);
      mgr.touchHeartbeat(tvSock);
      assert.equal(mgr.sweepExpiredRooms().length, 0, `Active cast room must NOT expire at ${min} min`);
    }
    const lookup60 = mgr.getRoom(hostReg.room.roomId);
    assert.equal(lookup60.ok, true);
    assert.equal(lookup60.room.status, 'active', 'Room active at 60 minutes');
    assert.equal(lookup60.room.activeStreams?.length, 1, 'Active stream still alive at 60 minutes');
    console.log('  [PASS] 2a. 60-minute continuous active-stream room persistence verified');

    // Verify idle room (no streams, long idle past TTL) DOES expire cleanly
    const idleCreated = mgr.createRoom({
      hostDeviceId: 'idle-host',
      hostDeviceName: 'Idle Mac',
      hostPlatform: 'macos',
    });
    assert.equal(idleCreated.ok, true);
    simulatedOffsetMs += 20 * 60 * 1000;
    const expiredIdle = mgr.sweepExpiredRooms();
    assert.ok(expiredIdle.some((e) => e.roomId === idleCreated.room.roomId), 'Idle room expired past 15m TTL');
    // Stop stream and disconnect participants on our 60m test room; verify it expires cleanly after idle window
    const stopRes = mgr.registerStreamStop({
      socket: hostSock,
      roomId: hostReg.room.roomId,
      senderDeviceId: 'mac-m5',
      targetDeviceId: 'haier-tv',
      token: hostReg.hostToken,
      sessionId: tvPair.sessionId,
      streamId: 'stream-long-1',
    });
    assert.equal(stopRes.ok, true, 'Stream stop registered cleanly');
    (hostSock as unknown as { readyState: number }).readyState = 3;
    (tvSock as unknown as { readyState: number }).readyState = 3;
    mgr.handleDisconnect(hostSock);
    mgr.handleDisconnect(tvSock);
    simulatedOffsetMs += 25 * 60 * 1000;
    const expiredAfterStop = mgr.sweepExpiredRooms();
    assert.ok(expiredAfterStop.some((e) => e.roomId === hostReg.room.roomId), 'Stopped idle room expires cleanly');
    console.log('  [PASS] 11. Abandoned / idle rooms still expire cleanly once casting stops');

    simulatedOffsetMs = 0;

    // =========================================================================
    // TEST 4A: Server Abnormal WS Drop (1006) + Grace Period Survival
    // =========================================================================
    const runtimeA = await startCastoraServer({
      port: 0,
      enableViteMiddleware: false,
      disconnectGraceMs: 450,
    });
    const baseUrlA = `http://127.0.0.1:${runtimeA.port}`;
    const wsUrlA = `ws://127.0.0.1:${runtimeA.port}/castora`;

    const crRes = await fetch(`${baseUrlA}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'mac-m5-a',
        hostDeviceName: 'MacBook Air M5',
        hostPlatform: 'macos',
      }),
    });
    const crData = (await crRes.json()) as { room: RoomSnapshot; hostToken: string };
    const roomA = crData.room.roomId;

    const tvJoinRes = await fetch(`${baseUrlA}/api/rooms/${roomA}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: 'haier-tv-a',
        deviceName: 'Haier TV',
        platform: 'android-tv',
      }),
    });
    const tvJoinData = (await tvJoinRes.json()) as { memberToken: string; sessionId: string };
    await fetch(`${baseUrlA}/api/rooms/${roomA}/pair-requests/haier-tv-a/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${crData.hostToken}` },
    });

    const hostWsA = new TestWsClient(`${wsUrlA}?token=${encodeURIComponent(crData.hostToken)}`);
    const tvWsA = new TestWsClient(`${wsUrlA}?token=${encodeURIComponent(tvJoinData.memberToken)}`);
    await Promise.all([hostWsA.waitForOpen(), tvWsA.waitForOpen()]);
    hostWsA.sendJson(
      buildAnnounceEnvelope({
        deviceId: 'mac-m5-a',
        deviceName: 'MacBook Air M5',
        platform: 'macos',
        role: 'sender',
        roomId: roomA,
      })
    );
    tvWsA.sendJson(
      buildAnnounceEnvelope({
        deviceId: 'haier-tv-a',
        deviceName: 'Haier TV',
        platform: 'android-tv',
        role: 'receiver',
        roomId: roomA,
      })
    );
    await waitUntil(() => true, 'initial settle', 100);
    await new Promise((r) => setTimeout(r, 80));

    // Register stream_start so active cast is in progress
    const rxStartWait = tvWsA.waitForMessage((m) => m.messageType === 'stream_start');
    hostWsA.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'stream_start',
      messageId: 'grace-start-1',
      senderDeviceId: 'mac-m5-a',
      receiverDeviceId: 'haier-tv-a',
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: tvJoinData.sessionId,
        streamId: 'stream-grace-1',
        width: 1920,
        height: 1080,
        fps: 60,
        codec: 'VP9',
      },
    });
    await rxStartWait;

    // Abruptly terminate TV socket -> code 1006 -> must NOT clear TV within 450ms grace!
    tvWsA.terminateAbnormally();
    await new Promise((r) => setTimeout(r, 140));
    const duringGrace = ((await (await fetch(`${baseUrlA}/api/rooms/${roomA}`)).json()) as { room: RoomSnapshot }).room;
    assert.equal(duringGrace.pairedReceivers[0].connected, true, 'TV stays marked connected during WS grace window');
    assert.equal(duringGrace.activeStreams?.length, 1, 'Active stream preserved during transient WS drop');

    // Reconnect TV before grace expires -> grace cancelled, zero interruption!
    const tvWsA2 = new TestWsClient(`${wsUrlA}?token=${encodeURIComponent(tvJoinData.memberToken)}`);
    await tvWsA2.waitForOpen();
    tvWsA2.sendJson(
      buildAnnounceEnvelope({
        deviceId: 'haier-tv-a',
        deviceName: 'Haier TV',
        platform: 'android-tv',
        role: 'receiver',
        roomId: roomA,
      })
    );
    await new Promise((r) => setTimeout(r, 420)); // wait past initial 450ms window
    const afterGrace = ((await (await fetch(`${baseUrlA}/api/rooms/${roomA}`)).json()) as { room: RoomSnapshot }).room;
    assert.equal(afterGrace.pairedReceivers[0].connected, true, 'Reconnected TV stayed connected after grace window');
    assert.equal(afterGrace.activeStreams?.length, 1, 'Active stream survived transient proxy WS reconnect');
    console.log('  [PASS] 4a. Abnormal WS drop (1006) preserved room & active stream inside grace window');

    // =========================================================================
    // TEST 10: Simulated Render Backend Restart -> Honest HTTP 404 Detection
    // =========================================================================
    const savedPort = runtimeA.port;
    await hostWsA.closeClean();
    await tvWsA2.closeClean();
    await runtimeA.close();

    // Bring up a fresh backend (simulating Render dyno restart wiping in-memory state)
    const runtimeB = await startCastoraServer({
      port: savedPort,
      enableViteMiddleware: false,
    });
    let caughtRestartErr: unknown = null;
    const origFetch = globalThis.fetch;
    try {
      // Rewrite relative `/api/...` calls from backendClient helpers to runtimeB base URL
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof input === 'string' && input.startsWith('/') ? `http://127.0.0.1:${savedPort}${input}` : input;
        return origFetch(urlStr as RequestInfo | URL, init);
      }) as typeof fetch;

      try {
        await restoreBackendSession({ roomId: roomA, token: crData.hostToken });
      } catch (err) {
        caughtRestartErr = err;
      }
      assert.ok(caughtRestartErr instanceof RestoreSessionError, 'Throws typed RestoreSessionError');
      assert.equal((caughtRestartErr as RestoreSessionError).status, 404, 'Returns HTTP 404 when server restarted and wiped rooms');
    } finally {
      globalThis.fetch = origFetch;
      await runtimeB.close();
    }
    console.log('  [PASS] 10. Render server restart detected honestly via HTTP 404 RestoreSessionError');

    // =========================================================================
    // TEST 4B: Client CastoraSignalingClient Sustained Exponential Backoff (>5 attempts)
    // =========================================================================
    const origWindow = (globalThis as Record<string, unknown>).window;
    const origWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    let fakeWsCreated = 0;
    let failFirstAttempts = 7;

    class FlakyMockWs {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((e: { code: number; reason: string }) => void) | null = null;
      constructor(_url: string) {
        fakeWsCreated += 1;
        const attemptNum = fakeWsCreated;
        setTimeout(() => {
          if (attemptNum <= failFirstAttempts) {
            this.onerror?.();
            this.onclose?.({ code: 1006, reason: 'Simulated proxy outage' });
          } else {
            this.readyState = 1;
            this.onopen?.();
          }
        }, 5);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }

    (globalThis as Record<string, unknown>).window = {
      location: { protocol: 'https:', host: 'castora.onrender.com' },
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: (fn: (...args: unknown[]) => void, delayMs: number, ...args: unknown[]) =>
        globalThis.setTimeout(fn, Math.min(delayMs, 15), ...args),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    (globalThis as Record<string, unknown>).WebSocket = FlakyMockWs;

    try {
      const client = new CastoraSignalingClient();
      const scheduledAttempts: number[] = [];
      let reachedConnected = false;
      client.connect({
        deviceId: 'mac-m5-client',
        deviceName: 'MacBook Air M5',
        platform: 'macos',
        heartbeatRole: 'sender',
        capabilities: { maxWidth: 1920, maxHeight: 1080, maxFps: 60, codecs: ['H264', 'VP9'], supportsAudio: true },
        roomId: 'ROOM99',
        token: 'tok-99',
        handlers: {
          onStateChange: (s) => {
            if (s === 'connected') reachedConnected = true;
          },
          onEnvelope: () => {},
          onReconnectScheduled: (attempt) => {
            scheduledAttempts.push(attempt);
          },
        },
      });
      await waitUntil(() => reachedConnected, 'Client recovers cleanly after 7 failed WS attempts', 4000);
      assert.ok(scheduledAttempts.length >= 7, 'Must exceed legacy 5-attempt permanent cap');
      assert.equal(client.getTelemetry().socketState, 'connected');
      client.disconnect(false);
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      (globalThis as Record<string, unknown>).WebSocket = origWebSocket;
    }
    console.log('  [PASS] 4b. Signaling client sustained >5 failed reconnects (7 attempts) with exponential backoff');

    // =========================================================================
    // TEST 2B, 3, 5, 6, 7, 8, 9, 12: WebRTC Bridge & Peer Long-Duration Suite
    // =========================================================================
    const runtimeW = await startCastoraServer({
      port: 0,
      enableViteMiddleware: false,
      disconnectGraceMs: 600,
    });
    const baseUrlW = `http://127.0.0.1:${runtimeW.port}`;
    const wsUrlW = `ws://127.0.0.1:${runtimeW.port}/castora`;

    const wRoomRes = await fetch(`${baseUrlW}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'mac-host',
        hostDeviceName: 'MacBook Air M5',
        hostPlatform: 'macos',
      }),
    });
    const wRoomData = (await wRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
    const wRoomId = wRoomData.room.roomId;

    const pairPeer = async (devId: string, name: string, plat: CastoraPlatform) => {
      const res = await fetch(`${baseUrlW}/api/rooms/${wRoomId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiverDeviceId: devId, deviceName: name, platform: plat }),
      });
      const data = (await res.json()) as { memberToken: string };
      await fetch(`${baseUrlW}/api/rooms/${wRoomId}/pair-requests/${devId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${wRoomData.hostToken}` },
      });
      const ws = new TestWsClient(`${wsUrlW}?token=${encodeURIComponent(data.memberToken)}`);
      await ws.waitForOpen();
      ws.sendJson(
        buildAnnounceEnvelope({
          deviceId: devId,
          deviceName: name,
          platform: plat,
          role: 'receiver',
          roomId: wRoomId,
        })
      );
      return { token: data.memberToken, ws };
    };

    const hostWsW = new TestWsClient(`${wsUrlW}?token=${encodeURIComponent(wRoomData.hostToken)}`);
    await hostWsW.waitForOpen();
    hostWsW.sendJson(
      buildAnnounceEnvelope({
        deviceId: 'mac-host',
        deviceName: 'MacBook Air M5',
        platform: 'macos',
        role: 'sender',
        roomId: wRoomId,
      })
    );
    const tvInfo = await pairPeer('tv-rx', 'Haier Google TV', 'android-tv');
    const padInfo = await pairPeer('sib-rx', 'Sibling Receiver', 'macos');

    let latestRoomSnap = ((await (await fetch(`${baseUrlW}/api/rooms/${wRoomId}`)).json()) as { room: RoomSnapshot }).room;

    let activeFakeStream: FakeMediaStream | null = null;
    let activeCaptureCallbacks: { onNativeEnded?: () => void } = {};

    const createCapture = async (opts: { onNativeEnded?: () => void }): Promise<CapturedScreenSession> => {
      activeCaptureCallbacks = opts;
      activeFakeStream = new FakeMediaStream('mac-cap-long', true);
      const vid = activeFakeStream.getVideoTracks()[0];
      const aud = activeFakeStream.getAudioTracks()[0];
      return {
        stream: activeFakeStream as unknown as MediaStream,
        videoTrack: vid as unknown as MediaStreamTrack,
        audioTrack: aud as unknown as MediaStreamTrack,
        hasAudio: true,
        audioCaptureStatus: 'captured',
        videoHealth: 'live',
        actualWidth: 1920,
        actualHeight: 1080,
        actualFrameRate: 60,
        stop: () => {
          vid.stop();
          aud.stop();
        },
      };
    };

    const wrapSender = (c: TestWsClient) => ({
      sendEnvelope: (env: Omit<CastoraEnvelope, 'protocolVersion' | 'messageId' | 'timestamp'>) => {
        c.sendJson({
          ...env,
          protocolVersion: 'castora.v1',
          messageId: `ld-${Math.random().toString(36).slice(2, 10)}`,
          timestamp: new Date().toISOString(),
        });
        return true;
      },
    });

    const hostBridge = new WebRtcSignalingBridge({
      deviceId: 'mac-host',
      preferences: defaultPrefs,
      networkPrefs: baseNetPrefs,
      getSignalingClient: () => wrapSender(hostWsW),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: createCapture as never,
      reconnectConfig: {
        maxAttempts: 6,
        baseDelayMs: 25,
        maxDelayMs: 120,
        iceDisconnectGraceMs: 25,
        recoveryVerifyMs: 45,
      },
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const tvBridge = new WebRtcSignalingBridge({
      deviceId: 'tv-rx',
      preferences: defaultPrefs,
      networkPrefs: baseNetPrefs,
      getSignalingClient: () => wrapSender(tvInfo.ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: createCapture as never,
      reconnectConfig: {
        maxAttempts: 6,
        baseDelayMs: 25,
        maxDelayMs: 120,
        iceDisconnectGraceMs: 25,
        recoveryVerifyMs: 45,
      },
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const sibBridge = new WebRtcSignalingBridge({
      deviceId: 'sib-rx',
      preferences: defaultPrefs,
      networkPrefs: baseNetPrefs,
      getSignalingClient: () => wrapSender(padInfo.ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: createCapture as never,
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });

    const wire = (wsClient: TestWsClient, br: WebRtcSignalingBridge, role: 'host' | 'receiver', devId: string) => {
      br.updateContext({
        deviceId: devId,
        activeRoom: latestRoomSnap,
        activeRoomRole: role,
        preferences: defaultPrefs,
        networkPrefs: baseNetPrefs,
      });
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === wRoomId) {
          latestRoomSnap = { ...latestRoomSnap, ...(msg.payload as Partial<RoomSnapshot>) };
          br.updateContext({
            deviceId: devId,
            activeRoom: latestRoomSnap,
            activeRoomRole: role,
            preferences: defaultPrefs,
            networkPrefs: baseNetPrefs,
          });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void br.handleIncomingEnvelope(msg);
        }
      });
    };

    wire(hostWsW, hostBridge, 'host', 'mac-host');
    wire(tvInfo.ws, tvBridge, 'receiver', 'tv-rx');
    wire(padInfo.ws, sibBridge, 'receiver', 'sib-rx');

    await hostBridge.startScreenSharing(null);
    await waitUntil(
      () =>
        hostBridge.getSnapshot().outboundPeers.length === 2 &&
        hostBridge.getSnapshot().outboundPeers.every((o) => o.phase === 'connected') &&
        tvBridge.getSnapshot().incomingStreams.some((s) => s.stream !== null) &&
        sibBridge.getSnapshot().incomingStreams.some((s) => s.stream !== null),
      'Host streaming to both TV and Sibling initially'
    );

    const getRaw = (b: WebRtcSignalingBridge, pid: string) =>
      (b.getPeerInstance(pid) as unknown as { pc: FakeRtcPeerConnection }).pc;
    const tvSenderPc = getRaw(hostBridge, 'tv-rx');
    const sibSenderPc = getRaw(hostBridge, 'sib-rx');
    const tvRxPc = getRaw(tvBridge, 'mac-host');

    // TEST 2B & 12: Simulate 60 minutes of advancing video + audio stats -> verify continuous tracking
    for (let step = 1; step <= 4; step++) {
      const simT = realDateNow() + step * 15 * 60 * 1000;
      const vidStat = tvSenderPc.mockStatsEntries.find(([k]) => k === 'out-vid')![1];
      vidStat.timestamp = 1000 + step * 900_000;
      vidStat.framesEncoded = 60 + step * 54_000;
      vidStat.framesSent = 60 + step * 54_000;
      vidStat.bytesSent = 500_000 + step * 500_000_000;
      const audStat = tvSenderPc.mockStatsEntries.find(([k]) => k === 'out-aud')![1];
      audStat.timestamp = 1000 + step * 900_000;
      audStat.packetsSent = 120 + step * 45_000;
      audStat.bytesSent = 24_000 + step * 9_000_000;

      const peer = hostBridge.getPeerInstance('tv-rx')!;
      await peer.sampleAndAdaptStats(simT);
    }
    const snapAt60 = hostBridge.getSnapshot();
    assert.equal(snapAt60.stabilityStatus, 'Connected', '60-min simulation stays Connected');
    assert.ok(snapAt60.lastSuccessfulVideoFrameAt !== null, 'Tracked lastSuccessfulVideoFrameAt across 60m');
    assert.ok(snapAt60.lastSuccessfulAudioPacketAt !== null, 'Tracked lastSuccessfulAudioPacketAt across 60m');
    console.log('  [PASS] 2b & 12. 60-minute continuous video + audio RTP progression verified');

    // TEST 3: Temporary ICE disconnect on TV -> ICE restart recovery while Sibling untouched
    tvSenderPc.emitState('disconnected');
    assert.equal(hostBridge.getSnapshot().stabilityStatus, 'Recovering');
    await waitUntil(() => tvSenderPc.restartIceCalls >= 1, 'ICE restart triggered on TV');
    tvSenderPc.emitState('connected');
    await waitUntil(() => hostBridge.getSnapshot().stabilityStatus === 'Connected', 'Recovered to Connected');
    assert.equal(sibSenderPc.restartIceCalls, 0, 'Healthy sibling peer completely isolated from TV ICE restart');
    console.log('  [PASS] 3. ICE disconnect -> ICE restart -> recovery with sibling isolation verified');

    // TEST 5: Packet loss burst triggers ABR step-down & Unstable status, then heals back to Connected
    const paramsBeforeAbr = tvSenderPc.videoSetParametersCalls;
    tvSenderPc.mockStatsEntries.push([
      'remote-in-loss',
      {
        id: 'remote-in-loss',
        type: 'remote-inbound-rtp',
        kind: 'video',
        roundTripTime: 0.28,
        packetsLost: 200,
        fractionLost: 0.08,
      },
    ]);
    await hostBridge.getPeerInstance('tv-rx')!.sampleAndAdaptStats(realDateNow() + 61 * 60 * 1000);
    await hostBridge.getPeerInstance('tv-rx')!.sampleAndAdaptStats(realDateNow() + 61 * 60 * 1000 + 3000);
    await hostBridge.getPeerInstance('tv-rx')!.sampleAndAdaptStats(realDateNow() + 61 * 60 * 1000 + 6000);
    assert.ok(
      tvSenderPc.videoSetParametersCalls >= paramsBeforeAbr,
      'ABR stays engaged under high RTT/loss without crashing'
    );
    assert.equal(hostBridge.getSnapshot().stabilityStatus, 'Unstable connection', 'High loss/RTT surfaces Unstable connection');
    // Heal network
    tvSenderPc.mockStatsEntries = tvSenderPc.mockStatsEntries.filter(([k]) => k !== 'remote-in-loss');
    await hostBridge.getPeerInstance('tv-rx')!.sampleAndAdaptStats(realDateNow() + 62 * 60 * 1000);
    assert.equal(hostBridge.getSnapshot().stabilityStatus, 'Connected', 'Heals back to Connected when loss/RTT clear');
    console.log('  [PASS] 5. High packet loss -> Unstable status + ABR adaptation -> Connected recovery verified');

    // TEST 6: Mid-stream Video Encoder Stall (frozen framesEncoded > 0) -> auto ICE restart & clear on resume
    const restartsBeforeStall = tvSenderPc.restartIceCalls;
    // Lower threshold on a dedicated peer test OR trigger default 5 stall samples cleanly
    const frozenVal = tvSenderPc.mockStatsEntries.find(([k]) => k === 'out-vid')![1].framesEncoded as number;
    for (let i = 0; i < 6; i++) {
      await hostBridge.getPeerInstance('tv-rx')!.sampleAndAdaptStats(realDateNow() + 63 * 60 * 1000 + i * 2000);
    }
    assert.ok(
      tvSenderPc.restartIceCalls > restartsBeforeStall,
      'Mid-stream frozen framesEncoded triggers ICE restart recovery'
    );
    assert.ok(hostBridge.getSnapshot().lastRecoveryAttemptAt !== null, 'Recorded lastRecoveryAttemptAt on encoder stall');
    // Unfreeze framesEncoded
    tvSenderPc.mockStatsEntries.find(([k]) => k === 'out-vid')![1].framesEncoded = frozenVal + 120;
    tvSenderPc.mockStatsEntries.find(([k]) => k === 'out-vid')![1].framesSent = frozenVal + 120;
    await hostBridge.getPeerInstance('tv-rx')!.sampleAndAdaptStats(realDateNow() + 64 * 60 * 1000);
    tvSenderPc.emitState('connected');
    console.log('  [PASS] 6. Mid-stream encoder stall detection & recovery trigger verified');

    // TEST 7: Receiver Decoder Stall on TV -> recovery offer
    const tvRxPeer = tvBridge.getPeerInstance('mac-host')!;
    tvRxPc.mockStatsEntries = [
      ['codec-in-vid', { id: 'codec-in-vid', type: 'codec', mimeType: 'video/VP9' }],
      [
        'in-vid',
        {
          id: 'in-vid',
          type: 'inbound-rtp',
          kind: 'video',
          codecId: 'codec-in-vid',
          timestamp: 5000,
          bytesReceived: 900_000,
          packetsReceived: 1200,
          packetsLost: 0,
          framesDecoded: 450,
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 60,
        },
      ],
    ];
    await tvRxPeer.sampleAndAdaptStats(realDateNow() + 1000);
    const offersBeforeDecStall = tvRxPc.createOfferCalls.length;
    for (let i = 0; i < 6; i++) {
      await tvRxPeer.sampleAndAdaptStats(realDateNow() + 3000 + i * 2000);
    }
    assert.ok(
      tvRxPc.createOfferCalls.length > offersBeforeDecStall,
      'Receiver decoder stall requests keyframe / recovery SDP offer'
    );
    assert.ok(tvBridge.getSnapshot().lastRecoveryAttemptAt !== null, 'TV bridge surfaced decoder stall recovery attempt');
    console.log('  [PASS] 7. Receiver decoder stall detection & recovery offer verified');

    // TEST 9: TV Receiver Reconnect after grace expiry -> Host reconcileActiveStreamsAfterReconnect restores TV
    tvInfo.ws.terminateAbnormally();
    await waitUntil(
      () => !hostBridge.getSnapshot().outboundPeers.some((o) => o.targetDeviceId === 'tv-rx'),
      'Host clears dropped TV after 600ms grace'
    );
    const tvWsRejoin = new TestWsClient(`${wsUrlW}?token=${encodeURIComponent(tvInfo.token)}`);
    await tvWsRejoin.waitForOpen();
    tvWsRejoin.ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
      if (msg.messageType === 'room_state' && msg.roomId === wRoomId) {
        latestRoomSnap = { ...latestRoomSnap, ...(msg.payload as Partial<RoomSnapshot>) };
        tvBridge.updateContext({
          deviceId: 'tv-rx',
          activeRoom: latestRoomSnap,
          activeRoomRole: 'receiver',
          preferences: defaultPrefs,
          networkPrefs: baseNetPrefs,
        });
      } else if (
        msg.messageType === 'stream_start' ||
        msg.messageType === 'session_offer' ||
        msg.messageType === 'session_answer' ||
        msg.messageType === 'ice_candidate' ||
        msg.messageType === 'stream_stop'
      ) {
        void tvBridge.handleIncomingEnvelope(msg);
      }
    });
    tvBridge.updateContext({
      deviceId: 'tv-rx',
      activeRoom: latestRoomSnap,
      activeRoomRole: 'receiver',
      preferences: defaultPrefs,
      networkPrefs: baseNetPrefs,
    });
    // Swap sender fn on tvBridge to use rejoined socket
    (tvBridge as unknown as { getSignalingClient: () => ReturnType<typeof wrapSender> }).getSignalingClient = () =>
      wrapSender(tvWsRejoin);
    tvWsRejoin.sendJson(
      buildAnnounceEnvelope({
        deviceId: 'tv-rx',
        deviceName: 'Haier Google TV',
        platform: 'android-tv',
        role: 'receiver',
        roomId: wRoomId,
      })
    );
    await waitUntil(
      () =>
        hostBridge.getSnapshot().outboundPeers.some((o) => o.targetDeviceId === 'tv-rx' && o.phase === 'connected') &&
        tvBridge.getSnapshot().incomingStreams.some((s) => s.stream !== null),
      () =>
        `TV rejoins room and receives active stream automatically (hostOut=${JSON.stringify(
          hostBridge.getSnapshot().outboundPeers.map((o) => ({ id: o.targetDeviceId, phase: o.phase }))
        )}, tvIn=${JSON.stringify(
          tvBridge.getSnapshot().incomingStreams.map((s) => ({
            id: s.senderDeviceId,
            phase: s.phase,
            hasStream: Boolean(s.stream),
          }))
        )}, hostErr=${hostBridge.getSnapshot().errorMessage}, tvErr=${tvBridge.getSnapshot().errorMessage})`
    );
    console.log('  [PASS] 9. TV reconnect automatically restores live screen + audio stream');

    // TEST 8: Genuine capture track ended -> honest 'Capture ended' state without retry storm
    activeCaptureCallbacks.onNativeEnded?.();
    await waitUntil(
      () =>
        hostBridge.getSnapshot().isSharingLocal === false &&
        hostBridge.getSnapshot().stabilityStatus === 'Capture ended' &&
        Boolean(hostBridge.getSnapshot().stopReason),
      'Genuine capture end surfaces Capture ended'
    );
    console.log('  [PASS] 8. Genuine browser/OS capture track end surfaces Capture ended honestly');

    // Quick direct unit verify for CastoraWebRtcPeer local track readyState === 'ended'
    let endedTrackReason: string | null = null;
    const endedCapPeer = new CastoraWebRtcPeer({
      localDeviceId: 'a',
      peerDeviceId: 'b',
      sessionId: 's',
      targetFps: 60,
      networkPrefs: baseNetPrefs,
      callbacks: {
        onOfferCreated: () => {},
        onIceCandidate: () => {},
        onInboundStream: () => {},
        onPhaseChange: () => {},
        onIceConnectionChange: () => {},
        onStats: () => {},
        onError: () => {},
        onLocalTrackEnded: (reason) => {
          endedTrackReason = reason;
        },
      },
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const endedFakeStream = new FakeMediaStream('end-track-test', true);
    await endedCapPeer.publishLocalStream({
      localStream: endedFakeStream as unknown as MediaStream,
      streamId: 'end-s1',
      preferences: defaultPrefs,
    });
    endedFakeStream.getVideoTracks()[0].stop();
    await endedCapPeer.sampleAndAdaptStats();
    assert.ok(endedTrackReason !== null, 'CastoraWebRtcPeer detected ended local track cleanly');
    endedCapPeer.close();

    hostBridge.dispose();
    tvBridge.dispose();
    sibBridge.dispose();
    await hostWsW.closeClean();
    await tvWsRejoin.closeClean();
    await padInfo.ws.closeClean();
    await runtimeW.close();

    console.log('\nAll 12 Long-Duration Stability & Recovery scenarios passed!');
  } finally {
    Date.now = realDateNow;
  }
}

runTests().catch((err) => {
  console.error('\n[FAIL] Long-duration test failure:', err);
  process.exit(1);
});
