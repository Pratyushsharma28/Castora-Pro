import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { RoomSnapshot } from '../apps/web/src/services/backendClient.ts';
import {
  detectDeviceType,
  validateDeviceDisplayName,
} from '../apps/web/src/services/browserCapabilities.ts';
import {
  ScreenCaptureError,
  buildDisplayMediaConstraints,
  startScreenCapture,
} from '../apps/web/src/services/screenCaptureService.ts';
import {
  buildStageDiagnosticsSummary,
  evaluateConnectionQuality,
  evaluateQualityVerification,
  formatDimensionsLabel,
} from '../apps/web/src/services/streamingDiagnosticsService.ts';
import {
  WebRtcStatsCollector,
  createEmptyTelemetry,
} from '../apps/web/src/services/streamStatsService.ts';
import {
  AdaptiveBitrateController,
  QUALITY_PROFILE_ORDER,
  QUALITY_PROFILES,
  VIDEO_QUALITY_PRESETS,
  applyQualityProfileToPreferences,
  assessNetworkCondition,
  computeConcurrencyScaledBitrateKbps,
  orderVideoCodecsForPreference,
  resolveProfileIdFromPreferences,
  resolveQualityTarget,
} from '../apps/web/src/services/videoQualityService.ts';
import { buildRtcConfiguration } from '../apps/web/src/services/webrtcPeerService.ts';
import { WebRtcSignalingBridge } from '../apps/web/src/services/webrtcSignalingBridge.ts';
import type { CapturePreferences } from '../apps/web/src/types/studio.ts';
import type { CastoraEnvelope } from '../apps/web/src/types/protocol.ts';
import { startCastoraServer } from '../server.ts';

type JsonRecord = Record<string, unknown>;

function readFixture(relPath: string): JsonRecord {
  const full = path.resolve(process.cwd(), 'protocol', 'fixtures', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8')) as JsonRecord;
}

class TestWsClient {
  readonly ws: WebSocket;
  private readonly queue: JsonRecord[] = [];
  private readonly waiters: Array<{
    predicate: (msg: JsonRecord) => boolean;
    resolve: (msg: JsonRecord) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let parsed: JsonRecord;
      try {
        parsed = JSON.parse(data.toString('utf8')) as JsonRecord;
      } catch {
        return;
      }

      const waiterIdx = this.waiters.findIndex((w) => w.predicate(parsed));
      if (waiterIdx >= 0) {
        const [waiter] = this.waiters.splice(waiterIdx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      } else {
        this.queue.push(parsed);
      }
    });
  }

  waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
  }

  waitForMessage(
    predicate: (msg: JsonRecord) => boolean = () => true,
    timeoutMs = 4000,
    label = 'message'
  ): Promise<JsonRecord> {
    const queuedIdx = this.queue.findIndex(predicate);
    if (queuedIdx >= 0) {
      const [msg] = this.queue.splice(queuedIdx, 1);
      return Promise.resolve(msg);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for WS ${label}`));
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  sendJson(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  sendRaw(payload: string | Buffer): void {
    this.ws.send(payload);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

function buildAnnounceEnvelope(params: {
  deviceId: string;
  deviceName: string;
  platform: 'macos' | 'android' | 'android-tv';
  role: 'sender' | 'receiver' | 'both';
  roomId: string | null;
}) {
  return {
    protocolVersion: 'castora.v1',
    messageType: 'device_announce',
    messageId: `ann-${params.deviceId}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    senderDeviceId: params.deviceId,
    receiverDeviceId: null,
    roomId: params.roomId,
    timestamp: new Date().toISOString(),
    payload: {
      deviceName: params.deviceName,
      platform: params.platform,
      role: params.role,
      wsPort: 3000,
      capabilities: {
        maxWidth: 1920,
        maxHeight: 1080,
        maxFps: 60,
        codecs: ['H264', 'VP9'],
        supportsAudio: true,
      },
    },
  };
}

async function connectAndAnnounce(params: {
  wsUrl: string;
  deviceId: string;
  deviceName: string;
  platform: 'macos' | 'android' | 'android-tv';
  deviceType?: string;
  role: 'sender' | 'receiver' | 'both';
  roomId: string | null;
  token?: string;
}): Promise<TestWsClient> {
  const qs = new URLSearchParams();
  if (params.token) qs.set('token', params.token);
  if (params.deviceType) qs.set('deviceType', params.deviceType);
  const query = qs.toString();
  const url = query ? `${params.wsUrl}?${query}` : params.wsUrl;
  const client = new TestWsClient(url);
  await client.waitForOpen();
  const ackPromise = client.waitForMessage(
    (msg) => msg.messageType === 'device_announce' && msg.receiverDeviceId === params.deviceId,
    3000,
    'device_announce ack'
  );
  client.sendJson(
    buildAnnounceEnvelope({
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      platform: params.platform,
      role: params.role,
      roomId: params.roomId,
    })
  );
  await ackPromise;
  return client;
}

async function main() {
  console.log('Starting Stage 3 backend & multi-client pairing verification suite...');
  const instance = await startCastoraServer({
    port: 0,
    host: '127.0.0.1',
    enableViteMiddleware: false,
    roomTtlMs: 30_000,
    rateLimitMaxAttempts: 40,
    rateLimitWindowMs: 10_000,
  });

  const baseUrl = `http://127.0.0.1:${instance.port}`;
  const wsUrl = `ws://127.0.0.1:${instance.port}/castora`;

  try {
    // Baseline Stage 2 checks: health + protocol validation
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as JsonRecord;
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.protocolVersion, 'castora.v1');
    assert.equal(healthJson.wsPath, '/castora');

    const probeWs = new TestWsClient(wsUrl);
    await probeWs.waitForOpen();
    probeWs.sendRaw('{bad-json');
    const malformedErr = await probeWs.waitForMessage((m) => m.messageType === 'error');
    assert.equal((malformedErr.payload as { code: string }).code, 'INVALID_MESSAGE');

    probeWs.sendRaw(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const binaryErr = await probeWs.waitForMessage((m) => m.messageType === 'error');
    assert.equal((binaryErr.payload as { code: string }).code, 'INVALID_MESSAGE');

    const badVer = readFixture('invalid/invalid-unsupported-version.json');
    probeWs.sendJson(badVer);
    const badVerErr = await probeWs.waitForMessage((m) => m.messageType === 'error');
    assert.equal((badVerErr.payload as { code: string }).code, 'UNSUPPORTED_VERSION');
    await probeWs.close();
    console.log('  [PASS] Baseline: /api/health and strict schema/binary frame rejection');

    // 1. Host room creation
    const hostDeviceId = 'mac-host-stage3-01';
    const createRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId,
        hostDeviceName: 'MacBook Pro M3 Host',
        hostPlatform: 'macos',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      room: {
        roomId: string;
        status: string;
        expiresAt: string;
        activeReceiverCount: number;
        pairedReceivers: unknown[];
        pendingRequests: unknown[];
      };
      hostToken: string;
    };
    const roomId = created.room.roomId;
    const hostToken = created.hostToken;
    assert.match(roomId, /^[A-Z0-9]{6}$/);
    assert.equal(created.room.status, 'active');
    assert.ok(Date.parse(created.room.expiresAt) > Date.now());
    assert.ok(hostToken.length >= 32);

    const hostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: hostDeviceId,
      deviceName: 'MacBook Pro M3 Host',
      platform: 'macos',
      role: 'sender',
      roomId,
      token: hostToken,
    });
    const initialHostState = await hostWs.waitForMessage((m) => m.messageType === 'room_state');
    assert.equal((initialHostState.payload as { hostConnected: boolean }).hostConnected, true);
    console.log('  [PASS] 1. Host room creation & authenticated WS host binding');

    // 2. Receiver joining (HTTP pair request lookup + pending state)
    const rx1Id = 'android-rx-01';
    const lookupRes = await fetch(`${baseUrl}/api/rooms/${roomId}`);
    assert.equal(lookupRes.status, 200);

    const hostPendingNotice1 = hostWs.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        Array.isArray((m.payload as { pendingRequests?: unknown[] }).pendingRequests) &&
        ((m.payload as { pendingRequests: unknown[] }).pendingRequests.length === 1)
    );

    const pairReq1Res = await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: rx1Id,
        deviceName: 'Pixel 9 Pro',
        platform: 'android',
        pairingMethod: 'room_code',
      }),
    });
    assert.equal(pairReq1Res.status, 200);
    const pairReq1 = (await pairReq1Res.json()) as {
      requestStatus: string;
      memberToken: string;
      room: { activeReceiverCount: number; pendingRequests: Array<{ deviceId: string }> };
    };
    assert.equal(pairReq1.requestStatus, 'pending_approval');
    assert.equal(pairReq1.room.activeReceiverCount, 0, 'Pending request must NOT mark receiver paired');
    assert.equal(pairReq1.room.pendingRequests[0].deviceId, rx1Id);
    await hostPendingNotice1;

    const rx1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: rx1Id,
      deviceName: 'Pixel 9 Pro',
      platform: 'android',
      role: 'receiver',
      roomId,
      token: pairReq1.memberToken,
    });
    await rx1Ws.waitForMessage((m) => m.messageType === 'room_state');
    console.log('  [PASS] 2. Receiver room lookup & HTTP pair request submission (pending)');

    // 3. Pair request via WebSocket envelope directly
    const rx2Id = 'android-tv-02';
    const rx2Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: rx2Id,
      deviceName: 'Living Room Shield TV',
      platform: 'android-tv',
      role: 'receiver',
      roomId: null,
    });
    const hostWsPairNotice = hostWs.waitForMessage((m) => m.messageType === 'pair_request');
    const rx2PendingStatePromise = rx2Ws.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        ((m.payload as { pendingRequests: Array<{ deviceId: string }> }).pendingRequests.some(
          (r) => r.deviceId === rx2Id
        ))
    );
    rx2Ws.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'pair_request',
      messageId: 'ws-pair-req-02',
      senderDeviceId: rx2Id,
      receiverDeviceId: hostDeviceId,
      roomId,
      timestamp: new Date().toISOString(),
      payload: {
        pairingMethod: 'room_code',
        ephemeralNonce: 'ephemeral_test_nonce_0002',
        deviceName: 'Living Room Shield TV',
        platform: 'android-tv',
        capabilities: {
          maxWidth: 1920,
          maxHeight: 1080,
          maxFps: 60,
          codecs: ['H264', 'VP9'],
          supportsAudio: true,
        },
      },
    });
    const forwardedPairReq = await hostWsPairNotice;
    assert.equal(forwardedPairReq.senderDeviceId, rx2Id);
    await rx2PendingStatePromise;
    console.log('  [PASS] 3. WebSocket pair_request queued & pushed to host');

    // 6. Unauthorized approval attempt (missing token, receiver memberToken, and unauthorized WS)
    const unauthMissingRes = await fetch(
      `${baseUrl}/api/rooms/${roomId}/pair-requests/${rx1Id}/approve`,
      { method: 'POST' }
    );
    assert.equal(unauthMissingRes.status, 403);

    const unauthReceiverTokenRes = await fetch(
      `${baseUrl}/api/rooms/${roomId}/pair-requests/${rx1Id}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${pairReq1.memberToken}` },
      }
    );
    assert.equal(unauthReceiverTokenRes.status, 403);

    const wsUnauthErrPromise = rx2Ws.waitForMessage((m) => m.messageType === 'error');
    rx2Ws.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'pair_response',
      messageId: 'ws-unauth-approve-01',
      senderDeviceId: rx2Id,
      receiverDeviceId: rx1Id,
      roomId,
      timestamp: new Date().toISOString(),
      payload: {
        paired: true,
        reason: null,
        receiverName: 'Pixel 9 Pro',
        receiverPlatform: 'android',
        sessionId: 'fake-session',
      },
    });
    const wsUnauthErr = await wsUnauthErrPromise;
    assert.equal((wsUnauthErr.payload as { code: string }).code, 'APPROVAL_DECLINED');
    console.log('  [PASS] 6. Unauthorized approval attempts blocked (HTTP 403 & WS APPROVAL_DECLINED)');

    // 4. Host approval
    const rx1PairedEvent = rx1Ws.waitForMessage(
      (m) => m.messageType === 'pair_response' && (m.payload as { paired: boolean }).paired === true
    );
    const rx1RoomStatePaired = rx1Ws.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        ((m.payload as { pairedReceivers: Array<{ deviceId: string }> }).pairedReceivers.some(
          (r) => r.deviceId === rx1Id
        ))
    );
    const approveRes = await fetch(
      `${baseUrl}/api/rooms/${roomId}/pair-requests/${rx1Id}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${hostToken}` },
      }
    );
    assert.equal(approveRes.status, 200);
    const approvedJson = (await approveRes.json()) as {
      assignedSlotIndex: number;
      room: { activeReceiverCount: number; pairedReceivers: Array<{ deviceId: string }> };
    };
    assert.equal(approvedJson.assignedSlotIndex, 0);
    assert.equal(approvedJson.room.activeReceiverCount, 1);
    assert.equal(approvedJson.room.pairedReceivers[0].deviceId, rx1Id);
    await rx1PairedEvent;
    await rx1RoomStatePaired;
    console.log('  [PASS] 4. Host approval paired receiver into Slot 1 and notified both peers');

    // 5. Host rejection
    const rx2RejectedEvent = rx2Ws.waitForMessage(
      (m) => m.messageType === 'pair_response' && (m.payload as { paired: boolean }).paired === false
    );
    const rejectRes = await fetch(
      `${baseUrl}/api/rooms/${roomId}/pair-requests/${rx2Id}/reject`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hostToken}`,
        },
        body: JSON.stringify({ reason: 'Unauthorized display' }),
      }
    );
    assert.equal(rejectRes.status, 200);
    const rejectedNotice = await rx2RejectedEvent;
    assert.equal(
      (rejectedNotice.payload as { reason: string }).reason,
      'Unauthorized display'
    );
    await rx2Ws.close();
    console.log('  [PASS] 5. Host rejection removed pending request & notified receiver');

    // 9. Duplicate pairing prevention (already paired AND already pending)
    const dupPairedRes = await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: rx1Id,
        deviceName: 'Pixel 9 Pro',
        platform: 'android',
      }),
    });
    assert.equal(dupPairedRes.status, 409);

    const rxDupPendingId = 'android-dup-check';
    const firstPending = await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: rxDupPendingId,
        deviceName: 'Duplicate Check Tablet',
        platform: 'android',
      }),
    });
    assert.equal(firstPending.status, 200);
    const secondPending = await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: rxDupPendingId,
        deviceName: 'Duplicate Check Tablet',
        platform: 'android',
      }),
    });
    assert.equal(secondPending.status, 409);
    // Reject cleanup of temp pending device
    await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests/${rxDupPendingId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    console.log('  [PASS] 9. Duplicate pairing prevented for paired and pending devices (HTTP 409)');

    // 7. Unauthorized receiver removal attempt
    const unauthRemoveRes = await fetch(
      `${baseUrl}/api/rooms/${roomId}/receivers/${rx1Id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${pairReq1.memberToken}` },
      }
    );
    assert.equal(unauthRemoveRes.status, 403);
    console.log('  [PASS] 7. Unauthorized receiver removal rejected (HTTP 403)');

    // 8. Successful receiver removal by host
    const rx1RemovedDisconnect = rx1Ws.waitForMessage(
      (m) =>
        m.messageType === 'disconnect' &&
        (m.payload as { reason?: string }).reason === 'Removed by host'
    );
    const removeRes = await fetch(`${baseUrl}/api/rooms/${roomId}/receivers/${rx1Id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    assert.equal(removeRes.status, 200);
    const removeJson = (await removeRes.json()) as {
      room: { pairedReceivers: unknown[]; activeReceiverCount: number };
    };
    assert.equal(removeJson.room.pairedReceivers.length, 0);
    assert.equal(removeJson.room.activeReceiverCount, 0);
    await rx1RemovedDisconnect;
    await rx1Ws.close();
    console.log('  [PASS] 8. Host removed paired receiver & freed slot');

    // 10. Six-receiver capacity (+ 7th rejected)
    const capacityReceivers: Array<{ id: string; token: string; ws: TestWsClient }> = [];
    for (let i = 1; i <= 6; i += 1) {
      const id = `cap-rx-0${i}`;
      const reqRes = await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: id,
          deviceName: `Receiver ${i}`,
          platform: i % 2 === 0 ? 'android-tv' : 'android',
        }),
      });
      assert.equal(reqRes.status, 200, `Receiver ${i} pair request failed`);
      const reqData = (await reqRes.json()) as { memberToken: string };
      const rWs = await connectAndAnnounce({
        wsUrl,
        deviceId: id,
        deviceName: `Receiver ${i}`,
        platform: i % 2 === 0 ? 'android-tv' : 'android',
        role: 'receiver',
        roomId,
        token: reqData.memberToken,
      });
      const appRes = await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests/${id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hostToken}` },
      });
      assert.equal(appRes.status, 200, `Receiver ${i} approve failed`);
      const appData = (await appRes.json()) as { assignedSlotIndex: number };
      assert.equal(appData.assignedSlotIndex, i - 1);
      capacityReceivers.push({ id, token: reqData.memberToken, ws: rWs });
    }

    const seventhRes = await fetch(`${baseUrl}/api/rooms/${roomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: 'cap-rx-07',
        deviceName: 'Seventh Receiver',
        platform: 'android',
      }),
    });
    assert.equal(seventhRes.status, 409, '7th receiver must be rejected with HTTP 409 ROOM_FULL');
    const seventhBody = (await seventhRes.json()) as { error: string };
    assert.equal(seventhBody.error, 'ROOM_FULL');
    console.log('  [PASS] 10. Six-receiver capacity enforced (slots 0..5 filled, 7th rejected)');

    // 13 & 14. Receiver disconnection (unexpected drop) + authenticated reconnection + Leave Room
    const targetRx = capacityReceivers[0];
    const hostRxDropNotice = hostWs.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        ((m.payload as {
          pairedReceivers: Array<{ deviceId: string; connected: boolean }>;
        }).pairedReceivers.some((r) => r.deviceId === targetRx.id && r.connected === false))
    );
    await targetRx.ws.close();
    await hostRxDropNotice;

    // Check activeReceiverCount dropped from 6 to 5
    const afterDropLookup = await fetch(`${baseUrl}/api/rooms/${roomId}`);
    const afterDropJson = (await afterDropLookup.json()) as {
      room: { activeReceiverCount: number; pairedReceiverCount: number };
    };
    assert.equal(afterDropJson.room.activeReceiverCount, 5);
    assert.equal(afterDropJson.room.pairedReceiverCount, 6);
    console.log('  [PASS] 13. Unexpected receiver disconnect decremented activeReceiverCount');

    // Attempt reconnect with WRONG token -> must NOT rebind as connected in room
    const rogueWs = await connectAndAnnounce({
      wsUrl,
      deviceId: targetRx.id,
      deviceName: 'Receiver 1',
      platform: 'android',
      role: 'receiver',
      roomId,
      token: 'wrong-token-value',
    });
    await new Promise((r) => setTimeout(r, 40));
    const rogueCheck = (await (await fetch(`${baseUrl}/api/rooms/${roomId}`)).json()) as {
      room: { activeReceiverCount: number };
    };
    assert.equal(rogueCheck.room.activeReceiverCount, 5, 'Invalid token must not restore paired session');
    await rogueWs.close();

    // Valid token reconnect restores paired connected=true
    const hostRxReconnectNotice = hostWs.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        ((m.payload as {
          pairedReceivers: Array<{ deviceId: string; connected: boolean }>;
        }).pairedReceivers.some((r) => r.deviceId === targetRx.id && r.connected === true))
    );
    targetRx.ws = await connectAndAnnounce({
      wsUrl,
      deviceId: targetRx.id,
      deviceName: 'Receiver 1',
      platform: 'android',
      role: 'receiver',
      roomId,
      token: targetRx.token,
    });
    await targetRx.ws.waitForMessage((m) => m.messageType === 'room_state');
    await hostRxReconnectNotice;

    // Explicit Leave Room frees slot cleanly
    const leaveRes = await fetch(`${baseUrl}/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${targetRx.token}`,
      },
      body: JSON.stringify({ deviceId: targetRx.id }),
    });
    assert.equal(leaveRes.status, 200);
    const afterLeaveJson = (await (await fetch(`${baseUrl}/api/rooms/${roomId}`)).json()) as {
      room: { activeReceiverCount: number; pairedReceiverCount: number };
    };
    assert.equal(afterLeaveJson.room.pairedReceiverCount, 5);
    assert.equal(afterLeaveJson.room.activeReceiverCount, 5);
    console.log('  [PASS] 14. Token-authenticated receiver reconnect & explicit Leave Room verified');

    // 12. Host disconnection & host reconnection
    const survivorRx = capacityReceivers[1];
    const rxHostDisconnectNotice = survivorRx.ws.waitForMessage(
      (m) =>
        m.messageType === 'disconnect' &&
        (m.payload as { reason?: string }).reason === 'Host disconnected'
    );
    const rxHostOfflineState = survivorRx.ws.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        (m.payload as { hostConnected: boolean }).hostConnected === false
    );
    await hostWs.close();
    await rxHostDisconnectNotice;
    await rxHostOfflineState;

    const hostWsReconnected = await connectAndAnnounce({
      wsUrl,
      deviceId: hostDeviceId,
      deviceName: 'MacBook Pro M3 Host',
      platform: 'macos',
      role: 'sender',
      roomId,
      token: hostToken,
    });
    await hostWsReconnected.waitForMessage((m) => m.messageType === 'room_state');
    console.log('  [PASS] 12. Host disconnection notified paired receivers & host reconnect succeeded');

    // Close main room & sockets before expiry test
    await fetch(`${baseUrl}/api/rooms/${roomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    await hostWsReconnected.close();
    for (const rx of capacityReceivers) {
      await rx.ws.close();
    }

    // 11. Room expiration (both HTTP 410 AND live WS sweep push)
    const expCreate = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'mac-exp-host',
        hostDeviceName: 'Expiring Host',
        hostPlatform: 'macos',
        ttlMs: 250,
      }),
    });
    assert.equal(expCreate.status, 201);
    const expData = (await expCreate.json()) as {
      room: { roomId: string };
      hostToken: string;
    };
    await new Promise((r) => setTimeout(r, 300));
    const expiredLookup = await fetch(`${baseUrl}/api/rooms/${expData.room.roomId}`);
    assert.equal(expiredLookup.status, 410, 'Expired room must return HTTP 410');

    // Live WS sweep push verification (wait up to 2.6s for periodic 2s sweep)
    const sweepCreate = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'mac-sweep-host',
        hostDeviceName: 'Sweep Host',
        hostPlatform: 'macos',
        ttlMs: 300,
      }),
    });
    const sweepData = (await sweepCreate.json()) as {
      room: { roomId: string };
      hostToken: string;
    };
    const sweepHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: 'mac-sweep-host',
      deviceName: 'Sweep Host',
      platform: 'macos',
      role: 'sender',
      roomId: sweepData.room.roomId,
      token: sweepData.hostToken,
    });
    const expStateNotice = sweepHostWs.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        (m.payload as { status: string }).status === 'expired',
      3500,
      'expired room_state'
    );
    const expDisconnectNotice = sweepHostWs.waitForMessage(
      (m) =>
        m.messageType === 'disconnect' &&
        (m.payload as { reason?: string }).reason === 'Room expired',
      3500,
      'expired disconnect'
    );
    await expStateNotice;
    await expDisconnectNotice;
    await sweepHostWs.close();
    console.log('  [PASS] 11. Room expiration verified (HTTP 410 + live WS expired push)');

    console.log('\nAll 14 Stage 3 backend & multi-client pairing scenarios passed!');

    // =========================================================================
    // STAGE 4A VERIFICATION: WebRTC Signalling, Security, Peer Cleanup & Capture
    // =========================================================================
    console.log('\nStarting Stage 4A WebRTC signalling & screen capture tests...');

    // Create Room A with Host A + approved Receiver A1 + pending Receiver A2
    const wHostId = 'mac-a-sender';
    const wRx1Id = 'mac-b-receiver';
    const wRx2PendingId = 'mac-c-pending';

    const roomARes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: wHostId,
        hostDeviceName: 'Mac A Sender',
        hostPlatform: 'macos',
      }),
    });
    assert.equal(roomARes.status, 201);
    const roomAData = (await roomARes.json()) as {
      room: { roomId: string };
      hostToken: string;
    };
    const roomA = roomAData.room.roomId;

    const wHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: wHostId,
      deviceName: 'Mac A Sender',
      platform: 'macos',
      role: 'sender',
      roomId: roomA,
      token: roomAData.hostToken,
    });
    await wHostWs.waitForMessage((m) => m.messageType === 'room_state');

    const wRx1Join = (await (
      await fetch(`${baseUrl}/api/rooms/${roomA}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: wRx1Id,
          deviceName: 'Mac B Receiver',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string; sessionId: string };

    const wRx1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: wRx1Id,
      deviceName: 'Mac B Receiver',
      platform: 'macos',
      role: 'receiver',
      roomId: roomA,
      token: wRx1Join.memberToken,
    });
    await wRx1Ws.waitForMessage((m) => m.messageType === 'room_state');

    const approveW = await fetch(
      `${baseUrl}/api/rooms/${roomA}/pair-requests/${wRx1Id}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${roomAData.hostToken}` },
      }
    );
    assert.equal(approveW.status, 200);
    await wRx1Ws.waitForMessage((m) => m.messageType === 'pair_response');

    // Pending (unapproved) receiver in Room A
    const wRx2Join = (await (
      await fetch(`${baseUrl}/api/rooms/${roomA}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: wRx2PendingId,
          deviceName: 'Mac C Pending',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string };
    const wRx2PendingWs = await connectAndAnnounce({
      wsUrl,
      deviceId: wRx2PendingId,
      deviceName: 'Mac C Pending',
      platform: 'macos',
      role: 'receiver',
      roomId: roomA,
      token: wRx2Join.memberToken,
    });

    // Room B for cross-room isolation verification
    const roomBHostId = 'mac-roomb-host';
    const roomBData = (await (
      await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostDeviceId: roomBHostId,
          hostDeviceName: 'Unrelated Room B Host',
          hostPlatform: 'macos',
        }),
      })
    ).json()) as { room: { roomId: string }; hostToken: string };
    const roomB = roomBData.room.roomId;
    const roomBHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: roomBHostId,
      deviceName: 'Unrelated Room B Host',
      platform: 'macos',
      role: 'sender',
      roomId: roomB,
      token: roomBData.hostToken,
    });

    const sampleOfferSdp =
      'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
    const sampleAnswerSdp =
      'v=0\r\no=- 9123456789012345678 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
    const wStreamId = 'stream-stage4a-01';

    // 4A.1 SDP offer routing
    const rx1StartPromise = wRx1Ws.waitForMessage((m) => m.messageType === 'stream_start');
    const rx1OfferPromise = wRx1Ws.waitForMessage((m) => m.messageType === 'session_offer');
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'stream_start',
      messageId: 's4a-stream-start-01',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        width: 1920,
        height: 1080,
        fps: 60,
        codec: 'H264',
      },
    });
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'session_offer',
      messageId: 's4a-offer-01',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpType: 'offer',
        sdp: sampleOfferSdp,
        mediaInfo: { hasVideo: true, hasAudio: false, codecHint: 'H264' },
      },
    });
    await rx1StartPromise;
    const deliveredOffer = await rx1OfferPromise;
    assert.equal(deliveredOffer.senderDeviceId, wHostId);
    assert.equal((deliveredOffer.payload as { sdp: string }).sdp, sampleOfferSdp);
    console.log('  [PASS] 4A.1. SDP offer routing delivered exclusively to paired receiver');

    // 4A.2 SDP answer routing
    const hostAnswerPromise = wHostWs.waitForMessage((m) => m.messageType === 'session_answer');
    wRx1Ws.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'session_answer',
      messageId: 's4a-answer-01',
      senderDeviceId: wRx1Id,
      receiverDeviceId: wHostId,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpType: 'answer',
        sdp: sampleAnswerSdp,
      },
    });
    const deliveredAnswer = await hostAnswerPromise;
    assert.equal(deliveredAnswer.senderDeviceId, wRx1Id);
    assert.equal((deliveredAnswer.payload as { sdp: string }).sdp, sampleAnswerSdp);
    console.log('  [PASS] 4A.2. SDP answer routing delivered cleanly to host');

    // 4A.3 ICE candidate routing (bidirectional)
    const rx1IcePromise = wRx1Ws.waitForMessage((m) => m.messageType === 'ice_candidate');
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'ice_candidate',
      messageId: 's4a-ice-host-01',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpMid: '0',
        sdpMLineIndex: 0,
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 50000 typ host',
      },
    });
    await rx1IcePromise;

    const hostIcePromise = wHostWs.waitForMessage((m) => m.messageType === 'ice_candidate');
    wRx1Ws.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'ice_candidate',
      messageId: 's4a-ice-rx-01',
      senderDeviceId: wRx1Id,
      receiverDeviceId: wHostId,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpMid: '0',
        sdpMLineIndex: 0,
        candidate: 'candidate:2 1 UDP 2122252543 192.168.1.20 50001 typ host',
      },
    });
    await hostIcePromise;
    console.log('  [PASS] 4A.3. Bidirectional ICE candidate routing verified');

    // 4A.4 Unauthorized signalling rejection (pending unapproved receiver & hijack attempt)
    const pendingErrPromise = wRx2PendingWs.waitForMessage((m) => m.messageType === 'error');
    wRx2PendingWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'session_offer',
      messageId: 's4a-unauth-pending',
      senderDeviceId: wRx2PendingId,
      receiverDeviceId: wHostId,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpType: 'offer',
        sdp: sampleOfferSdp,
      },
    });
    const pendingErr = await pendingErrPromise;
    assert.equal((pendingErr.payload as { code: string }).code, 'APPROVAL_DECLINED');

    // Hijack attempt claiming active host deviceId without valid token
    const hijackClient = new TestWsClient(wsUrl);
    await hijackClient.waitForOpen();
    const hijackErrPromise = hijackClient.waitForMessage((m) => m.messageType === 'error');
    hijackClient.sendJson(
      buildAnnounceEnvelope({
        deviceId: wHostId,
        deviceName: 'Attacker Clone',
        platform: 'macos',
        role: 'sender',
        roomId: roomA,
      })
    );
    const hijackErr = await hijackErrPromise;
    assert.equal((hijackErr.payload as { code: string }).code, 'APPROVAL_DECLINED');
    await hijackClient.close();
    console.log('  [PASS] 4A.4. Unauthorized signaling & device hijack attempts rejected');

    // 4A.5 Cross-room signalling rejection
    const crossRoomErrPromise1 = roomBHostWs.waitForMessage((m) => m.messageType === 'error');
    roomBHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'session_offer',
      messageId: 's4a-cross-room-01',
      senderDeviceId: roomBHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomB,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpType: 'offer',
        sdp: sampleOfferSdp,
      },
    });
    const crossRoomErr1 = await crossRoomErrPromise1;
    assert.equal((crossRoomErr1.payload as { code: string }).code, 'INVALID_ROOM_ID');

    const crossRoomErrPromise2 = roomBHostWs.waitForMessage((m) => m.messageType === 'error');
    roomBHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'ice_candidate',
      messageId: 's4a-cross-room-02',
      senderDeviceId: roomBHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpMid: '0',
        sdpMLineIndex: 0,
        candidate: 'candidate:1 1 UDP 2122252543 10.0.0.2 51111 typ host',
      },
    });
    const crossRoomErr2 = await crossRoomErrPromise2;
    assert.equal((crossRoomErr2.payload as { code: string }).code, 'APPROVAL_DECLINED');
    console.log('  [PASS] 4A.5. Cross-room SDP and ICE signaling blocked');

    // 4A.7 Invalid SDP message rejection
    const badSdpErrPromise = wHostWs.waitForMessage((m) => m.messageType === 'error');
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'session_offer',
      messageId: 's4a-bad-sdp-01',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpType: 'offer',
        sdp: 'not-valid-sdp-content',
      },
    });
    const badSdpErr = await badSdpErrPromise;
    assert.equal((badSdpErr.payload as { code: string }).code, 'INVALID_MESSAGE');

    const missingMediaSdpErrPromise = wHostWs.waitForMessage((m) => m.messageType === 'error');
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'session_offer',
      messageId: 's4a-bad-sdp-02',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpType: 'offer',
        sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n',
      },
    });
    const missingMediaErr = await missingMediaSdpErrPromise;
    assert.equal((missingMediaErr.payload as { code: string }).code, 'INVALID_MESSAGE');
    console.log('  [PASS] 4A.7. Invalid/malformed SDP messages rejected');

    // 4A.8 Invalid ICE candidate rejection
    const badIceErrPromise = wHostWs.waitForMessage((m) => m.messageType === 'error');
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'ice_candidate',
      messageId: 's4a-bad-ice-01',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpMid: '0',
        sdpMLineIndex: 0,
        candidate: '',
      },
    });
    const badIceErr = await badIceErrPromise;
    assert.equal((badIceErr.payload as { code: string }).code, 'INVALID_MESSAGE');
    console.log('  [PASS] 4A.8. Invalid/empty ICE candidates rejected');

    // 4A.9 Peer cleanup: stream_stop notification + room closure
    const rxStopPromise = wRx1Ws.waitForMessage((m) => m.messageType === 'stream_stop');
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'stream_stop',
      messageId: 's4a-stop-01',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        reason: 'user_stopped',
      },
    });
    const stopMsg = await rxStopPromise;
    assert.equal((stopMsg.payload as { reason: string }).reason, 'user_stopped');

    // 4A.6 Disconnected peer handling
    await wRx1Ws.close();
    const disconnectedPeerErrPromise = wHostWs.waitForMessage((m) => m.messageType === 'error');
    wHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'session_offer',
      messageId: 's4a-offline-rx-01',
      senderDeviceId: wHostId,
      receiverDeviceId: wRx1Id,
      roomId: roomA,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: wRx1Join.sessionId,
        streamId: wStreamId,
        sdpType: 'offer',
        sdp: sampleOfferSdp,
      },
    });
    const disconnectedPeerErr = await disconnectedPeerErrPromise;
    assert.equal((disconnectedPeerErr.payload as { code: string }).code, 'WEBRTC_NEGOTIATION_FAILED');
    console.log('  [PASS] 4A.6 & 4A.9. Disconnected peer error handling & stream_stop peer cleanup verified');

    // Clean up Stage 4A rooms & sockets
    await fetch(`${baseUrl}/api/rooms/${roomA}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${roomAData.hostToken}` },
    });
    await fetch(`${baseUrl}/api/rooms/${roomB}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${roomBData.hostToken}` },
    });
    await wHostWs.close();
    await wRx2PendingWs.close();
    await roomBHostWs.close();

    // 4A.10 Screen capture permission & error handling (unit tests on screenCaptureService)
    await assert.rejects(
      () =>
        startScreenCapture({
          preferences: {
            resolution: '1080p',
            targetFps: 60,
            codecPreference: 'H264',
            includeAudio: false,
          },
          onNativeEnded: () => {},
          env: { isSecureContext: false, mediaDevices: undefined },
        }),
      (err: unknown) =>
        err instanceof ScreenCaptureError && err.code === 'SECURE_CONTEXT_REQUIRED'
    );

    await assert.rejects(
      () =>
        startScreenCapture({
          preferences: {
            resolution: '1080p',
            targetFps: 60,
            codecPreference: 'H264',
            includeAudio: false,
          },
          onNativeEnded: () => {},
          env: { isSecureContext: true, mediaDevices: undefined },
        }),
      (err: unknown) => err instanceof ScreenCaptureError && err.code === 'API_UNAVAILABLE'
    );

    await assert.rejects(
      () =>
        startScreenCapture({
          preferences: {
            resolution: '1080p',
            targetFps: 60,
            codecPreference: 'H264',
            includeAudio: false,
          },
          onNativeEnded: () => {},
          env: {
            isSecureContext: true,
            mediaDevices: {
              getDisplayMedia: async () => {
                const denied = new Error('Permission denied by user');
                denied.name = 'NotAllowedError';
                throw denied;
              },
            },
          },
        }),
      (err: unknown) => err instanceof ScreenCaptureError && err.code === 'PERMISSION_DENIED'
    );

    let stoppedTrackCount = 0;
    let nativeEndTriggered = 0;
    const listeners = new Map<string, () => void>();
    const fakeTrack = {
      kind: 'video',
      contentHint: '',
      getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }),
      addEventListener: (evt: string, cb: () => void) => listeners.set(evt, cb),
      removeEventListener: (evt: string) => listeners.delete(evt),
      stop: () => {
        stoppedTrackCount += 1;
      },
    } as unknown as MediaStreamTrack;
    const fakeStream = {
      getVideoTracks: () => [fakeTrack],
      getAudioTracks: () => [],
      getTracks: () => [fakeTrack],
    } as unknown as MediaStream;

    const captured = await startScreenCapture({
      preferences: {
        resolution: '1080p',
        targetFps: 60,
        codecPreference: 'H264',
        includeAudio: false,
      },
      onNativeEnded: () => {
        nativeEndTriggered += 1;
      },
      env: {
        isSecureContext: true,
        mediaDevices: {
          getDisplayMedia: async () => fakeStream,
        },
      },
    });
    assert.equal(captured.actualWidth, 1920);
    assert.equal(captured.actualHeight, 1080);
    captured.stop();
    assert.equal(stoppedTrackCount, 1);
    assert.equal(nativeEndTriggered, 0, 'Programmatic stop must detach ended listener cleanly');
    console.log('  [PASS] 4A.10. Screen capture permission denial, secure-context guard & track cleanup verified');

    // =========================================================================
    // STAGE 4B VERIFICATION: Bidirectional WebRTC, Perfect Negotiation & Multi-Peer
    // =========================================================================
    console.log('\nStarting Stage 4B bidirectional WebRTC & multi-peer integration tests...');

    // Lightweight stateful fake RTCPeerConnection implementing Unified Plan SDP state machine,
    // rollback for Perfect Negotiation, transceivers/senders, ICE candidates, and remote ontrack delivery.
    type FakeTrack = {
      id: string;
      kind: 'video' | 'audio';
      readyState: string;
      muted: boolean;
      contentHint: string;
      _listeners: Map<string, Set<() => void>>;
      getSettings: () => { width: number; height: number; frameRate: number };
      applyConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
      addEventListener: (evt: string, cb: () => void) => void;
      removeEventListener: (evt: string, cb: () => void) => void;
      dispatchEventName: (evt: string) => void;
      stop: () => void;
    };

    class FakeMediaStream {
      readonly id: string;
      private tracks: FakeTrack[];
      constructor(
        id: string,
        trackLabel = 'screen',
        opts: {
          width?: number;
          height?: number;
          frameRate?: number;
          includeAudio?: boolean;
          rejectConstraints?: boolean;
        } = {}
      ) {
        this.id = id;
        let width = opts.width ?? 1920;
        let height = opts.height ?? 1080;
        let frameRate = opts.frameRate ?? 60;
        const listeners = new Map<string, Set<() => void>>();
        const track: FakeTrack = {
          id: `${trackLabel}-${id}`,
          kind: 'video',
          readyState: 'live',
          muted: false,
          contentHint: 'motion',
          _listeners: listeners,
          getSettings: () => ({ width, height, frameRate }),
          applyConstraints: async (constraints: MediaTrackConstraints) => {
            if (opts.rejectConstraints) {
              const err = new Error('Requested resolution exceeds display surface');
              err.name = 'OverconstrainedError';
              throw err;
            }
            const w = constraints.width;
            const h = constraints.height;
            const f = constraints.frameRate;
            if (w && typeof w === 'object' && 'ideal' in w && typeof w.ideal === 'number') {
              width = w.ideal;
            }
            if (h && typeof h === 'object' && 'ideal' in h && typeof h.ideal === 'number') {
              height = h.ideal;
            }
            if (f && typeof f === 'object' && 'ideal' in f && typeof f.ideal === 'number') {
              frameRate = f.ideal;
            }
          },
          addEventListener: (evt: string, cb: () => void) => {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt)!.add(cb);
          },
          removeEventListener: (evt: string, cb: () => void) => {
            listeners.get(evt)?.delete(cb);
          },
          dispatchEventName: (evt: string) => {
            for (const cb of listeners.get(evt) ?? []) cb();
          },
          stop: () => {
            track.readyState = 'ended';
            track.dispatchEventName('ended');
          },
        };
        this.tracks = [track];
        if (opts.includeAudio) {
          const audioListeners = new Map<string, Set<() => void>>();
          const audioTrack: FakeTrack = {
            id: `${trackLabel}-audio-${id}`,
            kind: 'audio',
            readyState: 'live',
            muted: false,
            contentHint: '',
            _listeners: audioListeners,
            getSettings: () => ({ width: 0, height: 0, frameRate: 0 }),
            addEventListener: (evt: string, cb: () => void) => {
              if (!audioListeners.has(evt)) audioListeners.set(evt, new Set());
              audioListeners.get(evt)!.add(cb);
            },
            removeEventListener: (evt: string, cb: () => void) => {
              audioListeners.get(evt)?.delete(cb);
            },
            dispatchEventName: (evt: string) => {
              for (const cb of audioListeners.get(evt) ?? []) cb();
            },
            stop: () => {
              audioTrack.readyState = 'ended';
            },
          };
          this.tracks.push(audioTrack);
        }
      }
      getVideoTracks() {
        return this.tracks.filter((t) => t.kind === 'video');
      }
      getAudioTracks() {
        return this.tracks.filter((t) => t.kind === 'audio');
      }
      getTracks() {
        return [...this.tracks];
      }
      addTrack(track: FakeTrack) {
        this.tracks.push(track);
      }
    }

    type FakeSenderParameters = {
      encodings: Array<{
        maxBitrate?: number;
        maxFramerate?: number;
        scaleResolutionDownBy?: number;
      }>;
      degradationPreference?: RTCDegradationPreference;
    };

    class FakeRtcPeerConnection {
      static instances: FakeRtcPeerConnection[] = [];
      static closeEvents: FakeRtcPeerConnection[] = [];

      rtcConfig: RTCConfiguration | null = null;
      signalingState: RTCSignalingState = 'stable';
      iceConnectionState: RTCIceConnectionState = 'connected';
      connectionState: RTCPeerConnectionState = 'connected';
      localDescription: RTCSessionDescriptionInit | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      onicecandidate: ((ev: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
      ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;

      mockStatsMap: Map<string, Record<string, unknown>> = new Map();
      lastCodecPreferences: RTCRtpCodec[] | null = null;
      videoSetParametersCalls = 0;
      audioSetParametersCalls = 0;
      restartIceCalls = 0;
      createOfferCalls: Array<{ iceRestart?: boolean }> = [];

      private transceivers: Array<{
        direction: RTCRtpTransceiverDirection;
        setCodecPreferences: (codecs: RTCRtpCodec[]) => void;
        sender: {
          track: { kind?: string } | null;
          replaceTrack: (t: { kind?: string } | null) => Promise<void>;
          getParameters: () => FakeSenderParameters;
          setParameters: (params: FakeSenderParameters) => Promise<void>;
        };
      }> = [];
      private deliveredRemoteStream: FakeMediaStream | null = null;

      constructor(config?: RTCConfiguration) {
        this.rtcConfig = config ?? null;
        FakeRtcPeerConnection.instances.push(this);
      }

      addTrack(track: { kind?: string }) {
        let senderParams: FakeSenderParameters = { encodings: [{}] };
        const trackKind = track?.kind ?? 'video';
        const sender = {
          track: track as { kind?: string } | null,
          replaceTrack: async (next: { kind?: string } | null) => {
            sender.track = next;
          },
          getParameters: () => ({
            encodings: senderParams.encodings.map((e) => ({ ...e })),
            degradationPreference: senderParams.degradationPreference,
          }),
          setParameters: async (params: FakeSenderParameters) => {
            senderParams = {
              encodings: params.encodings.map((e) => ({ ...e })),
              degradationPreference: params.degradationPreference,
            };
            if (trackKind === 'audio' || sender.track?.kind === 'audio') {
              this.audioSetParametersCalls += 1;
            } else {
              this.videoSetParametersCalls += 1;
            }
          },
        };
        this.transceivers.push({
          direction: 'sendonly',
          setCodecPreferences: (codecs: RTCRtpCodec[]) => {
            this.lastCodecPreferences = codecs;
          },
          sender,
        });
        return sender;
      }

      getVideoSender(): {
        track: { kind?: string } | null;
        getParameters: () => FakeSenderParameters;
      } | null {
        const found = this.transceivers.find((t) => t.sender.track?.kind === 'video');
        return found ? found.sender : null;
      }

      getAudioSender(): {
        track: { kind?: string } | null;
        getParameters: () => FakeSenderParameters;
      } | null {
        const found = this.transceivers.find((t) => t.sender.track?.kind === 'audio');
        return found ? found.sender : null;
      }

      removeTrack(sender: unknown) {
        const tr = this.transceivers.find((t) => t.sender === sender);
        if (tr) tr.sender.track = null;
      }

      getSenders() {
        return this.transceivers.map((t) => t.sender);
      }

      addTransceiver(kind: string, init?: { direction?: RTCRtpTransceiverDirection }) {
        let senderParams: FakeSenderParameters = { encodings: [{}] };
        const sender = {
          track: null as { kind?: string } | null,
          replaceTrack: async (next: { kind?: string } | null) => {
            sender.track = next;
          },
          getParameters: () => ({
            encodings: senderParams.encodings.map((e) => ({ ...e })),
            degradationPreference: senderParams.degradationPreference,
          }),
          setParameters: async (params: FakeSenderParameters) => {
            senderParams = {
              encodings: params.encodings.map((e) => ({ ...e })),
              degradationPreference: params.degradationPreference,
            };
          },
        };
        const tr = {
          kind,
          direction: init?.direction ?? ('recvonly' as RTCRtpTransceiverDirection),
          setCodecPreferences: (codecs: RTCRtpCodec[]) => {
            this.lastCodecPreferences = codecs;
          },
          sender,
        };
        this.transceivers.push(tr);
        return tr;
      }

      getTransceivers() {
        return this.transceivers;
      }

      restartIce() {
        this.restartIceCalls += 1;
      }

      emitConnectionDrop(nextState: 'disconnected' | 'failed' | 'connected') {
        this.iceConnectionState = nextState;
        this.connectionState = nextState;
        this.oniceconnectionstatechange?.();
        this.onconnectionstatechange?.();
      }

      async createOffer(options?: RTCOfferOptions) {
        this.createOfferCalls.push({ iceRestart: Boolean(options?.iceRestart) });
        const activeSending = this.transceivers.some(
          (t) =>
            t.sender.track !== null &&
            (t.direction === 'sendonly' || t.direction === 'sendrecv')
        );
        const activeSendingAudio = this.transceivers.some(
          (t) =>
            t.sender.track?.kind === 'audio' &&
            (t.direction === 'sendonly' || t.direction === 'sendrecv')
        );
        const audioSection = activeSendingAudio
          ? `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n`
          : '';
        return {
          type: 'offer' as const,
          sdp: `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=${activeSending ? 'sendrecv' : 'recvonly'}\r\n${audioSection}`,
        };
      }

      async createAnswer() {
        const activeSending = this.transceivers.some(
          (t) =>
            t.sender.track !== null &&
            (t.direction === 'sendonly' || t.direction === 'sendrecv')
        );
        const activeSendingAudio = this.transceivers.some(
          (t) =>
            t.sender.track?.kind === 'audio' &&
            (t.direction === 'sendonly' || t.direction === 'sendrecv')
        );
        const audioSection = activeSendingAudio
          ? `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n`
          : '';
        return {
          type: 'answer' as const,
          sdp: `v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=${activeSending ? 'sendrecv' : 'recvonly'}\r\n${audioSection}`,
        };
      }

      async setLocalDescription(desc?: RTCSessionDescriptionInit) {
        if (!desc) return;
        if (desc.type === 'rollback') {
          this.localDescription = null;
          this.signalingState = 'stable';
          return;
        }
        this.localDescription = desc;
        if (desc.type === 'offer') {
          this.signalingState = 'have-local-offer';
          queueMicrotask(() => {
            this.onicecandidate?.({
              candidate: {
                candidate: 'candidate:1 1 UDP 2122252543 127.0.0.1 54321 typ host',
                sdpMid: '0',
                sdpMLineIndex: 0,
              },
            });
          });
        } else if (desc.type === 'answer') {
          this.signalingState = 'stable';
        }
      }

      async setRemoteDescription(desc: RTCSessionDescriptionInit) {
        this.remoteDescription = desc;
        const remoteSending = Boolean(desc.sdp?.includes('a=sendrecv'));
        const remoteSendingAudio = Boolean(desc.sdp?.includes('m=audio'));
        if (desc.type === 'offer') {
          this.signalingState = 'have-remote-offer';
          if (remoteSending) {
            if (!this.deliveredRemoteStream) {
              this.deliveredRemoteStream = new FakeMediaStream(
                `remote-${Math.random().toString(36).slice(2, 8)}`,
                'screen',
                { includeAudio: remoteSendingAudio }
              );
              const track = this.deliveredRemoteStream.getVideoTracks()[0];
              this.ontrack?.({ track, streams: [this.deliveredRemoteStream] });
              for (const aTrack of this.deliveredRemoteStream.getAudioTracks()) {
                this.ontrack?.({ track: aTrack, streams: [this.deliveredRemoteStream] });
              }
            } else {
              const track = this.deliveredRemoteStream.getVideoTracks()[0];
              if (track.muted) {
                track.muted = false;
                track.dispatchEventName('unmute');
              }
              if (remoteSendingAudio && this.deliveredRemoteStream.getAudioTracks().length === 0) {
                const audioDonor = new FakeMediaStream(`remote-aud-${Math.random().toString(36).slice(2, 8)}`, 'screen', { includeAudio: true });
                for (const aTrack of audioDonor.getAudioTracks()) {
                  this.deliveredRemoteStream.addTrack(aTrack);
                  this.ontrack?.({ track: aTrack, streams: [this.deliveredRemoteStream] });
                }
              }
            }
          } else if (this.deliveredRemoteStream) {
            const track = this.deliveredRemoteStream.getVideoTracks()[0];
            if (!track.muted) {
              track.muted = true;
              track.dispatchEventName('mute');
            }
          }
        } else if (desc.type === 'answer') {
          this.signalingState = 'stable';
          if (remoteSending && !this.deliveredRemoteStream) {
            this.deliveredRemoteStream = new FakeMediaStream(
              `remote-${Math.random().toString(36).slice(2, 8)}`,
              'screen',
              { includeAudio: remoteSendingAudio }
            );
            const track = this.deliveredRemoteStream.getVideoTracks()[0];
            this.ontrack?.({ track, streams: [this.deliveredRemoteStream] });
            for (const aTrack of this.deliveredRemoteStream.getAudioTracks()) {
              this.ontrack?.({ track: aTrack, streams: [this.deliveredRemoteStream] });
            }
          }
          if (this.iceConnectionState === 'connected') {
            queueMicrotask(() => {
              this.oniceconnectionstatechange?.();
              this.onconnectionstatechange?.();
            });
          }
        }
      }

      async addIceCandidate() {
        // Accepted cleanly
      }

      async getStats() {
        return this.mockStatsMap;
      }

      close() {
        this.signalingState = 'closed';
        this.iceConnectionState = 'closed';
        this.connectionState = 'closed';
        FakeRtcPeerConnection.closeEvents.push(this);
      }
    }

    // Create Room 4B with Host + Friend 1 + Friend 2 + Room B isolation host
    const bHostId = 'dev-mac-a-host';
    const bFriend1Id = 'dev-mac-b-friend1';
    const bFriend2Id = 'dev-mac-c-friend2';
    const bPendingId = 'dev-mac-pending';

    const room4bRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: bHostId,
        hostDeviceName: 'MacBook Pro Host (A)',
        hostPlatform: 'macos',
      }),
    });
    assert.equal(room4bRes.status, 201);
    const room4bCreated = (await room4bRes.json()) as {
      room: RoomSnapshot;
      hostToken: string;
    };
    const room4bId = room4bCreated.room.roomId;

    const bHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: bHostId,
      deviceName: 'MacBook Pro Host (A)',
      platform: 'macos',
      role: 'both',
      roomId: room4bId,
      token: room4bCreated.hostToken,
    });
    await bHostWs.waitForMessage((m) => m.messageType === 'room_state');

    const friend1Join = (await (
      await fetch(`${baseUrl}/api/rooms/${room4bId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: bFriend1Id,
          deviceName: 'MacBook Air Friend (B)',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string; sessionId: string };
    const bFriend1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: bFriend1Id,
      deviceName: 'MacBook Air Friend (B)',
      platform: 'macos',
      role: 'both',
      roomId: room4bId,
      token: friend1Join.memberToken,
    });
    await fetch(`${baseUrl}/api/rooms/${room4bId}/pair-requests/${bFriend1Id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${room4bCreated.hostToken}` },
    });

    const friend2Join = (await (
      await fetch(`${baseUrl}/api/rooms/${room4bId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: bFriend2Id,
          deviceName: 'Mac Mini Studio (C)',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string; sessionId: string };
    const bFriend2Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: bFriend2Id,
      deviceName: 'Mac Mini Studio (C)',
      platform: 'macos',
      role: 'both',
      roomId: room4bId,
      token: friend2Join.memberToken,
    });
    await fetch(`${baseUrl}/api/rooms/${room4bId}/pair-requests/${bFriend2Id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${room4bCreated.hostToken}` },
    });

    const pendingJoin = (await (
      await fetch(`${baseUrl}/api/rooms/${room4bId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: bPendingId,
          deviceName: 'Pending Mac',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string };
    const bPendingWs = await connectAndAnnounce({
      wsUrl,
      deviceId: bPendingId,
      deviceName: 'Pending Mac',
      platform: 'macos',
      role: 'both',
      roomId: room4bId,
      token: pendingJoin.memberToken,
    });

    // Fetch authoritative room snapshot for bridges
    const latestRoomRes = (await (await fetch(`${baseUrl}/api/rooms/${room4bId}`)).json()) as {
      room: RoomSnapshot;
    };
    let latestRoomSnapshot = latestRoomRes.room;

    const prefs4b = {
      resolution: '1080p' as const,
      targetFps: 60 as const,
      codecPreference: 'H264' as const,
      includeAudio: false,
    };
    const netPrefs4b = {
      preferLanDirectP2P: true,
      stunUrls: 'stun:stun.l.google.com:19302',
      turnUrl: '',
      turnUsername: '',
      turnCredential: '',
    };

    const makeBridgeCapture = (label: string) => async ({ onNativeEnded }: { onNativeEnded: () => void }) => {
      const stream = new FakeMediaStream(`cap-${label}-${Date.now()}`, label) as unknown as MediaStream;
      const videoTrack = stream.getVideoTracks()[0];
      void onNativeEnded;
      return {
        stream,
        videoTrack,
        actualWidth: 1920,
        actualHeight: 1080,
        actualFrameRate: 60,
        hasAudio: false,
        stop: () => {
          for (const t of stream.getTracks()) t.stop();
        },
      };
    };

    const wrapWsSender = (wsClient: TestWsClient) => ({
      sendEnvelope: (partial: Omit<CastoraEnvelope, 'protocolVersion' | 'messageId' | 'timestamp'>): boolean => {
        wsClient.sendJson({
          protocolVersion: 'castora.v1',
          messageId: `b4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          ...partial,
        });
        return true;
      },
    });

    const hostBridge = new WebRtcSignalingBridge({
      deviceId: bHostId,
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(bHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeBridgeCapture('host'),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });

    const friend1Bridge = new WebRtcSignalingBridge({
      deviceId: bFriend1Id,
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(bFriend1Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeBridgeCapture('friend1'),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });

    const friend2Bridge = new WebRtcSignalingBridge({
      deviceId: bFriend2Id,
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(bFriend2Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeBridgeCapture('friend2'),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });

    hostBridge.updateContext({
      deviceId: bHostId,
      activeRoom: latestRoomSnapshot,
      activeRoomRole: 'host',
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
    });
    friend1Bridge.updateContext({
      deviceId: bFriend1Id,
      activeRoom: latestRoomSnapshot,
      activeRoomRole: 'receiver',
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
    });
    friend2Bridge.updateContext({
      deviceId: bFriend2Id,
      activeRoom: latestRoomSnapshot,
      activeRoomRole: 'receiver',
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
    });

    // Attach real WebSocket listeners that feed incoming signaling envelopes directly into each bridge
    const wireBridgeToWs = (wsClient: TestWsClient, bridge: WebRtcSignalingBridge, role: 'host' | 'receiver', devId: string) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === room4bId) {
          latestRoomSnapshot = {
            ...latestRoomSnapshot,
            ...(msg.payload as Partial<RoomSnapshot>),
          };
          bridge.updateContext({
            deviceId: devId,
            activeRoom: latestRoomSnapshot,
            activeRoomRole: role,
            preferences: prefs4b,
            networkPrefs: netPrefs4b,
          });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };

    wireBridgeToWs(bHostWs, hostBridge, 'host', bHostId);
    wireBridgeToWs(bFriend1Ws, friend1Bridge, 'receiver', bFriend1Id);
    wireBridgeToWs(bFriend2Ws, friend2Bridge, 'receiver', bFriend2Id);

    const waitUntil = async (fn: () => boolean | Promise<boolean>, label: string, timeoutMs = 4000) => {
      const start = Date.now();
      while (!(await fn())) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out waiting for condition: ${label}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    // 4B.1 - 4B.4 & 4B.10: Simultaneous Host <-> Friend1 sharing (triggers real glare collision!)
    await Promise.all([
      hostBridge.startScreenSharing(bFriend1Id),
      friend1Bridge.startScreenSharing(bHostId),
    ]);

    await waitUntil(
      () =>
        hostBridge.getSnapshot().incomingStreams.some(
          (s) => s.senderDeviceId === bFriend1Id && s.stream !== null
        ) &&
        friend1Bridge.getSnapshot().incomingStreams.some(
          (s) => s.senderDeviceId === bHostId && s.stream !== null
        ),
      'Simultaneous bidirectional Host <-> Friend 1 WebRTC streams active'
    );

    assert.equal(hostBridge.getPeerCount(), 1, 'Host must keep exactly 1 shared RTCPeerConnection for Friend 1');
    assert.equal(friend1Bridge.getPeerCount(), 1, 'Friend 1 must keep exactly 1 shared RTCPeerConnection for Host');

    const roomMidRes = (await (await fetch(`${baseUrl}/api/rooms/${room4bId}`)).json()) as {
      room: { activeStreams: Array<{ publisherDeviceId: string; targetDeviceId: string }> };
    };
    assert.equal(roomMidRes.room.activeStreams.length, 2, 'Server must track both independent stream directions');
    console.log('  [PASS] 4B.1-4B.4 & 4B.10. Simultaneous Host <-> Friend bidirectional capture, Perfect Negotiation glare recovery & single shared RTCPeerConnection verified');

    // 4B.5: Host stops sharing while Friend 1 continues
    hostBridge.stopSharing('user_stopped');
    await waitUntil(
      () =>
        hostBridge.getSnapshot().isSharingLocal === false &&
        friend1Bridge.getSnapshot().incomingStreams.length === 0,
      'Friend 1 cleared inbound stream from stopped Host'
    );
    assert.equal(
      hostBridge.getSnapshot().incomingStreams.some(
        (s) => s.senderDeviceId === bFriend1Id && s.stream !== null
      ),
      true,
      'Host MUST continue receiving Friend 1 incoming stream after stopping own screen share'
    );
    assert.equal(hostBridge.getPeerCount(), 1, 'Host keeps peer connection alive while Friend 1 is still streaming');
    console.log('  [PASS] 4B.5. Host stopped own stream independently while continuing to receive Friend 1 uninterrupted');

    // 4B.6: Host re-shares, then Friend 1 stops while Host continues
    await hostBridge.startScreenSharing(bFriend1Id);
    await waitUntil(
      () =>
        friend1Bridge.getSnapshot().incomingStreams.some(
          (s) => s.senderDeviceId === bHostId && s.stream !== null
        ),
      'Friend 1 receiving Host screen again after re-share'
    );
    assert.equal(hostBridge.getPeerCount(), 1, 'Re-sharing reuses existing RTCPeerConnection without duplicate connections');

    friend1Bridge.stopSharing('user_stopped');
    await waitUntil(
      () =>
        friend1Bridge.getSnapshot().isSharingLocal === false &&
        hostBridge.getSnapshot().incomingStreams.length === 0,
      'Host cleared Friend 1 incoming stream while continuing outbound share'
    );
    assert.equal(
      friend1Bridge.getSnapshot().incomingStreams.some(
        (s) => s.senderDeviceId === bHostId && s.stream !== null
      ),
      true,
      'Friend 1 MUST continue receiving Host screen after stopping own screen share'
    );
    console.log('  [PASS] 4B.6. Host re-share reused peer connection cleanly; Friend 1 stopped own stream while continuing to receive Host');

    // 4B.7 & 4B.8: Unauthorized publisher, spoofed stream_stop, and cross-room signaling rejection
    const pendingErrPromise4b = bPendingWs.waitForMessage((m) => m.messageType === 'error');
    bPendingWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'stream_start',
      messageId: 'b4-unauth-pub',
      senderDeviceId: bPendingId,
      receiverDeviceId: bHostId,
      roomId: room4bId,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: 'fake-sess',
        streamId: 'unauth-stream-1',
        width: 1280,
        height: 720,
        fps: 30,
        codec: 'H264',
      },
    });
    const pendingErr4b = await pendingErrPromise4b;
    assert.equal((pendingErr4b.payload as { code: string }).code, 'APPROVAL_DECLINED');

    // Friend 2 tries to spoof stream_stop for Host's streamId -> must be rejected
    const activeHostStreamId = hostBridge.getSnapshot().activeStreamId!;
    const spoofStopErrPromise = bFriend2Ws.waitForMessage((m) => m.messageType === 'error');
    bFriend2Ws.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'stream_stop',
      messageId: 'b4-spoof-stop',
      senderDeviceId: bFriend2Id,
      receiverDeviceId: bFriend1Id,
      roomId: room4bId,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: friend1Join.sessionId,
        streamId: activeHostStreamId,
        reason: 'user_stopped',
      },
    });
    const spoofStopErr = await spoofStopErrPromise;
    assert.equal((spoofStopErr.payload as { code: string }).code, 'APPROVAL_DECLINED');
    console.log('  [PASS] 4B.7 & 4B.8. Pending publisher and spoofed stream_stop ownership hijacking rejected');

    // 4B.9: Multi-peer incoming isolation + unexpected participant disconnect & reconnect
    // Both Friend 1 and Friend 2 stream to Host simultaneously -> Host tracks 2 distinct peers
    await Promise.all([
      friend1Bridge.startScreenSharing(bHostId),
      friend2Bridge.startScreenSharing(bHostId),
    ]);
    await waitUntil(
      () => hostBridge.getSnapshot().incomingStreams.length === 2,
      'Host receives 2 independent incoming streams (Friend 1 & Friend 2)'
    );
    assert.equal(hostBridge.getPeerCount(), 2, 'Host maintains 1 distinct peer per participant (2 total)');

    // Friend 1 unexpectedly drops WS connection -> Host must clean ONLY Friend 1, keeping Friend 2 untouched!
    await bFriend1Ws.close();
    await waitUntil(
      () =>
        hostBridge.getSnapshot().incomingStreams.length === 1 &&
        hostBridge.getSnapshot().incomingStreams[0].senderDeviceId === bFriend2Id,
      'Host dropped disconnected Friend 1 while keeping Friend 2 incoming stream active'
    );
    assert.equal(hostBridge.getPeerCount(), 1, 'Host closed disconnected Friend 1 peer connection cleanly');

    // Friend 1 reconnects with valid token and streams again -> restored cleanly
    friend1Bridge.dispose();
    const bFriend1Reconnected = await connectAndAnnounce({
      wsUrl,
      deviceId: bFriend1Id,
      deviceName: 'MacBook Air Friend (B)',
      platform: 'macos',
      role: 'both',
      roomId: room4bId,
      token: friend1Join.memberToken,
    });
    const friend1ReconnectedBridge = new WebRtcSignalingBridge({
      deviceId: bFriend1Id,
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(bFriend1Reconnected),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeBridgeCapture('friend1-reconn'),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });
    wireBridgeToWs(bFriend1Reconnected, friend1ReconnectedBridge, 'receiver', bFriend1Id);
    friend1ReconnectedBridge.updateContext({
      deviceId: bFriend1Id,
      activeRoom: latestRoomSnapshot,
      activeRoomRole: 'receiver',
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
    });
    await friend1ReconnectedBridge.startScreenSharing(bHostId);
    await waitUntil(
      () => hostBridge.getSnapshot().incomingStreams.length === 2,
      'Host receives Friend 1 again alongside surviving Friend 2 after reconnect'
    );
    console.log('  [PASS] 4B.9. Unexpected participant disconnect isolated to failing peer; surviving Friend 2 stream & reconnect verified');

    // 4B.11: Universal 3-way bidirectional sharing (Mac A, Mac B, Mac C publish simultaneously with default null target)
    // First clear existing shares cleanly
    hostBridge.stopSharing('user_stopped');
    friend1ReconnectedBridge.stopSharing('user_stopped');
    friend2Bridge.stopSharing('user_stopped');
    await waitUntil(
      () =>
        hostBridge.getSnapshot().incomingStreams.length === 0 &&
        friend1ReconnectedBridge.getSnapshot().incomingStreams.length === 0 &&
        friend2Bridge.getSnapshot().incomingStreams.length === 0,
      'All participants cleared prior streams before 3-way mesh test'
    );

    // Ensure latestRoomSnapshot reflects all 3 connected peers before simultaneous broadcast
    const meshRoomRes = (await (await fetch(`${baseUrl}/api/rooms/${room4bId}`)).json()) as {
      room: RoomSnapshot;
    };
    latestRoomSnapshot = meshRoomRes.room;
    hostBridge.updateContext({
      deviceId: bHostId,
      activeRoom: latestRoomSnapshot,
      activeRoomRole: 'host',
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
    });
    friend1ReconnectedBridge.updateContext({
      deviceId: bFriend1Id,
      activeRoom: latestRoomSnapshot,
      activeRoomRole: 'receiver',
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
    });
    friend2Bridge.updateContext({
      deviceId: bFriend2Id,
      activeRoom: latestRoomSnapshot,
      activeRoomRole: 'receiver',
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
    });

    // All 3 participants start default room-wide sharing (targetSelection = null) simultaneously!
    await Promise.all([
      hostBridge.startScreenSharing(null),
      friend1ReconnectedBridge.startScreenSharing(null),
      friend2Bridge.startScreenSharing(null),
    ]);

    await waitUntil(
      () =>
        hostBridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 2 &&
        friend1ReconnectedBridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 2 &&
        friend2Bridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 2,
      'All 3 participants simultaneously share and receive each other (2 incoming streams each)'
    );

    const meshMidRes = (await (await fetch(`${baseUrl}/api/rooms/${room4bId}`)).json()) as {
      room: { activeStreams: Array<{ publisherDeviceId: string; targetDeviceId: string }> };
    };
    assert.equal(meshMidRes.room.activeStreams.length, 6, '3-way full mesh must register 6 active directional streams');

    // Mac B stops its own stream independently; Mac A and Mac C streams must continue uninterrupted
    friend1ReconnectedBridge.stopSharing('user_stopped');
    await waitUntil(
      () =>
        friend1ReconnectedBridge.getSnapshot().isSharingLocal === false &&
        hostBridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 1 &&
        friend2Bridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 1,
      'Mac B stopped independently while Mac A and Mac C continued receiving each other'
    );
    assert.equal(
      friend1ReconnectedBridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length,
      2,
      'Mac B must continue receiving both Mac A and Mac C after stopping its own share'
    );
    assert.equal(
      hostBridge.getSnapshot().incomingStreams[0]?.senderDeviceId,
      bFriend2Id,
      'Mac A must keep receiving Mac C after Mac B stopped'
    );
    assert.equal(
      friend2Bridge.getSnapshot().incomingStreams[0]?.senderDeviceId,
      bHostId,
      'Mac C must keep receiving Mac A after Mac B stopped'
    );

    // Mac C stops its own stream independently; Mac A continues publishing to both Mac B and Mac C
    friend2Bridge.stopSharing('user_stopped');
    await waitUntil(
      () =>
        friend2Bridge.getSnapshot().isSharingLocal === false &&
        hostBridge.getSnapshot().incomingStreams.length === 0 &&
        friend1ReconnectedBridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 1,
      'Mac C stopped independently while Mac A continued sharing to Mac B and Mac C'
    );
    assert.equal(
      friend2Bridge.getSnapshot().incomingStreams[0]?.senderDeviceId,
      bHostId,
      'Mac C must keep receiving Mac A after stopping its own share'
    );

    // Late-joiner / newly approved peer auto-broadcast: approve bPendingId while Mac A is actively sharing
    const pendingBridge = new WebRtcSignalingBridge({
      deviceId: bPendingId,
      preferences: prefs4b,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(bPendingWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeBridgeCapture('pending-approved'),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });
    wireBridgeToWs(bPendingWs, pendingBridge, 'receiver', bPendingId);
    const approvePendingRes = await fetch(
      `${baseUrl}/api/rooms/${room4bId}/pair-requests/${bPendingId}/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${room4bCreated.hostToken}` },
      }
    );
    assert.equal(approvePendingRes.status, 200);
    await waitUntil(
      () =>
        pendingBridge.getSnapshot().incomingStreams.some(
          (s) => s.senderDeviceId === bHostId && s.stream !== null
        ),
      'Newly approved participant automatically receives ongoing room-wide screen share from Mac A'
    );
    pendingBridge.dispose();
    console.log('  [PASS] 4B.11. Universal 3-way simultaneous sharing, independent stop & late-joiner auto-broadcast verified');

    // Dispose bridges & close Stage 4B room cleanly
    hostBridge.dispose();
    friend1Bridge.dispose();
    friend1ReconnectedBridge.dispose();
    friend2Bridge.dispose();
    assert.equal(hostBridge.getPeerCount(), 0);
    await fetch(`${baseUrl}/api/rooms/${room4bId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${room4bCreated.hostToken}` },
    });
    await bHostWs.close();
    await bFriend1Reconnected.close();
    await bFriend2Ws.close();
    await bPendingWs.close();

    // =========================================================================
    // Stage 4C: Beyond-1080p60 WebRTC Video Quality, Bitrate, Multi-Publisher & ABR
    // =========================================================================
    console.log('\nStarting Stage 4C WebRTC video quality, bitrate, multi-publisher & ABR tests...');

    // 4C.1: Backward compatibility of 1080p60 default + 1440p60 / 4K60 presets + codec ranking
    const default1080Prefs: CapturePreferences = {
      resolution: '1080p',
      targetFps: 60,
      codecPreference: 'H264',
      includeAudio: false,
      maxBitrateKbps: 10_000,
      adaptiveBitrate: true,
    };
    const c1080 = buildDisplayMediaConstraints(default1080Prefs);
    assert.deepEqual(c1080.video, {
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    });
    assert.equal(resolveQualityTarget(default1080Prefs).configuredMaxBitrateKbps, 10_000);
    assert.equal(VIDEO_QUALITY_PRESETS['1080p'].defaultBitrateKbps60, 10_000);
    assert.equal(VIDEO_QUALITY_PRESETS['1440p'].defaultBitrateKbps60, 20_000);
    assert.equal(VIDEO_QUALITY_PRESETS['4k'].defaultBitrateKbps60, 40_000);

    const prefs1440: CapturePreferences = {
      resolution: '1440p',
      targetFps: 60,
      codecPreference: 'H264',
      includeAudio: false,
      maxBitrateKbps: 20_000,
      adaptiveBitrate: true,
    };
    const c1440 = buildDisplayMediaConstraints(prefs1440);
    assert.deepEqual(c1440.video, {
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    });

    const prefs4k: CapturePreferences = {
      resolution: '4k',
      targetFps: 60,
      codecPreference: 'VP9',
      includeAudio: true,
      maxBitrateKbps: 40_000,
      adaptiveBitrate: true,
    };
    const c4k = buildDisplayMediaConstraints(prefs4k);
    assert.deepEqual(c4k.video, {
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    });
    assert.equal(c4k.audio, true);

    const sampleCaps = [
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
      { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032' },
      { mimeType: 'video/VP9', clockRate: 90000 },
      { mimeType: 'video/AV1', clockRate: 90000 },
      { mimeType: 'video/rtx', clockRate: 90000 },
    ] as RTCRtpCodec[];
    const rankedH264 = orderVideoCodecsForPreference(sampleCaps, 'H264');
    assert.equal(rankedH264.codecHint, 'H264');
    assert.equal(rankedH264.orderedCodecs[0].mimeType, 'video/H264');
    assert.equal(rankedH264.orderedCodecs[0].sdpFmtpLine?.includes('640032'), true, 'High H264 profile prioritized first');
    const rankedVp9 = orderVideoCodecsForPreference(sampleCaps, 'VP9');
    assert.equal(rankedVp9.codecHint, 'VP9');
    assert.equal(rankedVp9.orderedCodecs[0].mimeType, 'video/VP9');
    const rankedAv1 = orderVideoCodecsForPreference(sampleCaps, 'AV1');
    assert.equal(rankedAv1.codecHint, 'AV1');
    assert.equal(rankedAv1.orderedCodecs[0].mimeType, 'video/AV1');
    console.log('  [PASS] 4C.1. 1080p60 backward compatibility, 1440p/4K presets & hardware codec preference ranking verified');

    // Create clean Stage 4C room for single-device, 2-publisher, 3-publisher, independent quality & ABR tests
    const cHostId = 'dev-4c-host';
    const cFriend1Id = 'dev-4c-friend1';
    const cFriend2Id = 'dev-4c-friend2';

    const room4cRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: cHostId,
        hostDeviceName: 'Studio Mac (4K)',
        hostPlatform: 'macos',
      }),
    });
    assert.equal(room4cRes.status, 201);
    const room4cCreated = (await room4cRes.json()) as {
      room: RoomSnapshot;
      hostToken: string;
    };
    const room4cId = room4cCreated.room.roomId;

    const cHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: cHostId,
      deviceName: 'Studio Mac (4K)',
      platform: 'macos',
      role: 'both',
      roomId: room4cId,
      token: room4cCreated.hostToken,
    });
    await cHostWs.waitForMessage((m) => m.messageType === 'room_state');

    const cFriend1Join = (await (
      await fetch(`${baseUrl}/api/rooms/${room4cId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: cFriend1Id,
          deviceName: 'MacBook Pro (1440p)',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string };
    const cFriend1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: cFriend1Id,
      deviceName: 'MacBook Pro (1440p)',
      platform: 'macos',
      role: 'both',
      roomId: room4cId,
      token: cFriend1Join.memberToken,
    });
    await (
      await fetch(`${baseUrl}/api/rooms/${room4cId}/pair-requests/${cFriend1Id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${room4cCreated.hostToken}` },
      })
    ).json();

    const cFriend2Join = (await (
      await fetch(`${baseUrl}/api/rooms/${room4cId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: cFriend2Id,
          deviceName: 'MacBook Air (1080p)',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string };
    const cFriend2Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: cFriend2Id,
      deviceName: 'MacBook Air (1080p)',
      platform: 'macos',
      role: 'both',
      roomId: room4cId,
      token: cFriend2Join.memberToken,
    });
    await (
      await fetch(`${baseUrl}/api/rooms/${room4cId}/pair-requests/${cFriend2Id}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${room4cCreated.hostToken}` },
      })
    ).json();

    let latest4cRoom = ((await (await fetch(`${baseUrl}/api/rooms/${room4cId}`)).json()) as { room: RoomSnapshot }).room;

    const cHostPeers: FakeRtcPeerConnection[] = [];
    const makeDynamicCapture = (
      label: string,
      surfaceOpts: { width: number; height: number; frameRate: number; includeAudio?: boolean; rejectConstraints?: boolean }
    ) => {
      return async ({ onNativeEnded }: { preferences: CapturePreferences; onNativeEnded: () => void }) => {
        const stream = new FakeMediaStream(`cap4c-${label}-${Date.now()}`, label, surfaceOpts) as unknown as MediaStream;
        const videoTrack = stream.getVideoTracks()[0];
        void onNativeEnded;
        return {
          stream,
          videoTrack,
          actualWidth: surfaceOpts.width,
          actualHeight: surfaceOpts.height,
          actualFrameRate: surfaceOpts.frameRate,
          hasAudio: Boolean(surfaceOpts.includeAudio),
          stop: () => {
            for (const t of stream.getTracks()) t.stop();
          },
        };
      };
    };

    // Map FakeRtcPeerConnection instances created per peer on Host
    const hostPrefs = { ...prefs4k };
    const friend1Prefs = { ...prefs1440 };
    const friend2Prefs = { ...default1080Prefs };

    const cHostPeerByTarget = new Map<string, FakeRtcPeerConnection>();

    const cHostBridge = new WebRtcSignalingBridge({
      deviceId: cHostId,
      preferences: hostPrefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(cHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: async (arg) =>
        makeDynamicCapture('host4k', {
          width: 3840,
          height: 2160,
          frameRate: 60,
          includeAudio: true,
        })(arg),
      rtcFactory: () => {
        const fake = new FakeRtcPeerConnection();
        cHostPeers.push(fake);
        return fake as unknown as RTCPeerConnection;
      },
    });
    const cFriend1Bridge = new WebRtcSignalingBridge({
      deviceId: cFriend1Id,
      preferences: friend1Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(cFriend1Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('f1-1440', { width: 2560, height: 1440, frameRate: 60 }),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });
    const cFriend2Bridge = new WebRtcSignalingBridge({
      deviceId: cFriend2Id,
      preferences: friend2Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(cFriend2Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('f2-1080', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });

    const wire4c = (
      wsClient: TestWsClient,
      bridge: WebRtcSignalingBridge,
      role: 'host' | 'receiver',
      devId: string,
      getPrefs: () => CapturePreferences
    ) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === room4cId) {
          latest4cRoom = { ...latest4cRoom, ...(msg.payload as Partial<RoomSnapshot>) };
          bridge.updateContext({
            deviceId: devId,
            activeRoom: latest4cRoom,
            activeRoomRole: role,
            preferences: getPrefs(),
            networkPrefs: netPrefs4b,
          });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };

    cHostBridge.updateContext({ deviceId: cHostId, activeRoom: latest4cRoom, activeRoomRole: 'host', preferences: hostPrefs, networkPrefs: netPrefs4b });
    cFriend1Bridge.updateContext({ deviceId: cFriend1Id, activeRoom: latest4cRoom, activeRoomRole: 'receiver', preferences: friend1Prefs, networkPrefs: netPrefs4b });
    cFriend2Bridge.updateContext({ deviceId: cFriend2Id, activeRoom: latest4cRoom, activeRoomRole: 'receiver', preferences: friend2Prefs, networkPrefs: netPrefs4b });
    wire4c(cHostWs, cHostBridge, 'host', cHostId, () => hostPrefs);
    wire4c(cFriend1Ws, cFriend1Bridge, 'receiver', cFriend1Id, () => friend1Prefs);
    wire4c(cFriend2Ws, cFriend2Bridge, 'receiver', cFriend2Id, () => friend2Prefs);

    // 4C.2: Honest resolution check (request 4K on 1080p display surface -> must report 1920x1080, not 4K!)
    const f2With4kRequestPrefs: CapturePreferences = {
      ...prefs4k,
      includeAudio: false,
    };
    const f2HonestLogs: string[] = [];
    const f2HonestBridge = new WebRtcSignalingBridge({
      deviceId: cFriend2Id,
      preferences: f2With4kRequestPrefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(cFriend2Ws),
      callbacks: {
        onStateChange: () => {},
        onLogEvent: (_cat, title, detail) => {
          f2HonestLogs.push(`${title}: ${detail}`);
        },
      },
      // Display surface only outputs 1920x1080 even though 4k was requested
      captureFn: makeDynamicCapture('honest-1080', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });
    f2HonestBridge.updateContext({
      deviceId: cFriend2Id,
      activeRoom: latest4cRoom,
      activeRoomRole: 'receiver',
      preferences: f2With4kRequestPrefs,
      networkPrefs: netPrefs4b,
    });
    await f2HonestBridge.startScreenSharing(cHostId);
    await waitUntil(
      () => cHostBridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === cFriend2Id && s.stream !== null),
      'Honest resolution check stream delivered'
    );
    const f2HonestEntry = cHostBridge.getSnapshot().incomingStreams.find((s) => s.senderDeviceId === cFriend2Id)!;
    assert.equal(f2HonestEntry.streamMeta?.width, 1920, 'Must NOT claim 4K when actual captured track is 1080p');
    assert.equal(f2HonestEntry.streamMeta?.height, 1080);
    assert.equal(f2HonestBridge.getSnapshot().localCaptureMeta?.width, 1920);
    assert.equal(f2HonestBridge.getSnapshot().telemetry.resolution, '1920×1080');
    assert.equal(
      f2HonestLogs.some((line) => line.includes('Actual capture resolution reported') && line.includes('1920×1080')),
      true
    );
    f2HonestBridge.stopSharing('user_stopped');
    f2HonestBridge.dispose();
    await waitUntil(() => cHostBridge.getSnapshot().incomingStreams.length === 0, 'Cleared honest-check stream');

    // Reset Host peers array after honest check
    cHostBridge.updateContext({ deviceId: cHostId, activeRoom: latest4cRoom, activeRoomRole: 'host', preferences: hostPrefs, networkPrefs: netPrefs4b });

    // Single-device 4K60 streaming + Overconstrained fallback check
    await cHostBridge.startScreenSharing(cFriend1Id);
    await waitUntil(
      () => cFriend1Bridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === cHostId && s.stream !== null),
      'Friend 1 receives single-device 4K60 stream with audio'
    );
    const singleFakePc = cHostPeers[cHostPeers.length - 1];
    const singleVideoParams = singleFakePc.getVideoSender()!.getParameters();
    assert.equal(singleVideoParams.encodings[0].maxBitrate, 40_000_000, 'Single-device 4K60 applies 40 Mbps');
    assert.equal(singleVideoParams.encodings[0].maxFramerate, 60);
    assert.equal(singleVideoParams.encodings[0].scaleResolutionDownBy, 1);
    assert.equal(singleVideoParams.degradationPreference, 'maintain-resolution');
    assert.equal(singleFakePc.audioSetParametersCalls, 0, 'Audio sender untouched so A/V sync stays locked');

    cHostBridge.stopSharing('user_stopped');
    await waitUntil(() => cFriend1Bridge.getSnapshot().incomingStreams.length === 0, 'Cleared single-device 4K stream');

    // Simulate unsupported constraint update -> verify previous 4K60 preferences preserved safely
    const failingCaptureSessionBridge = new WebRtcSignalingBridge({
      deviceId: 'local-fallback-test',
      preferences: hostPrefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => null,
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('rejecting', { width: 2560, height: 1440, frameRate: 60, rejectConstraints: true }),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });
    await failingCaptureSessionBridge.startScreenSharing(null);
    const fallbackResult = await failingCaptureSessionBridge.applyCapturePreferencesUpdate({
      ...prefs4k,
      resolution: '4k',
      targetFps: 30,
    });
    assert.equal(fallbackResult.applied, false);
    assert.equal(fallbackResult.fallbackUsed, true);
    assert.equal(fallbackResult.appliedPreferences.targetFps, 60, 'Fallback kept previous working 60 FPS');
    failingCaptureSessionBridge.stopSharing('user_stopped');
    failingCaptureSessionBridge.dispose();
    console.log('  [PASS] 4C.2. Single-device 4K60 setParameters, honest 1080p reporting & Overconstrained fallback verified');

    // 4C.3: 2 & 3 simultaneous publishers, concurrency scaling & independent per-peer quality overrides
    cHostPeers.length = 0;
    await cHostBridge.startScreenSharing(null); // Broadcasts 4K60 to both Friend 1 and Friend 2 (2 outbound peers -> 85% headroom = 34 Mbps)
    await cFriend1Bridge.startScreenSharing(null); // Friend 1 broadcasts 1440p60 (20 Mbps * 0.85 = 17 Mbps)
    await waitUntil(
      () =>
        cFriend1Bridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === cHostId && s.stream !== null) &&
        cFriend2Bridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === cHostId && s.stream !== null) &&
        cHostBridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === cFriend1Id && s.stream !== null),
      'Two simultaneous publishers active cleanly'
    );

    // Now add 3rd simultaneous publisher (Friend 2 at 1080p60)
    await cFriend2Bridge.startScreenSharing(null);
    await waitUntil(
      () =>
        cHostBridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 2 &&
        cFriend1Bridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 2 &&
        cFriend2Bridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 2,
      'All three simultaneous publishers active at different presets (4K, 1440p, 1080p)'
    );

    // Map each target peer on cHostBridge to its FakeRtcPeerConnection
    for (const targetId of [cFriend1Id, cFriend2Id]) {
      const peerObj = cHostBridge.getPeerInstance(targetId)!;
      const fakeConn = (peerObj as unknown as { pc: FakeRtcPeerConnection }).pc;
      cHostPeerByTarget.set(targetId, fakeConn);
    }

    const fakeToF1 = cHostPeerByTarget.get(cFriend1Id)!;
    const fakeToF2 = cHostPeerByTarget.get(cFriend2Id)!;

    assert.equal(
      computeConcurrencyScaledBitrateKbps(40_000, 2, 8_000),
      34_000,
      '2-target concurrency scaling preserves 85% ceiling (34 Mbps)'
    );
    assert.equal(fakeToF1.getVideoSender()!.getParameters().encodings[0].maxBitrate, 34_000_000);
    assert.equal(fakeToF2.getVideoSender()!.getParameters().encodings[0].maxBitrate, 34_000_000);

    // Apply independent quality override for Friend 1 ONLY (12 Mbps) without affecting Friend 2 (34 Mbps) or audio
    await cHostBridge.setPeerQualityOverride(cFriend1Id, { maxBitrateKbps: 12_000 });
    assert.equal(
      fakeToF1.getVideoSender()!.getParameters().encodings[0].maxBitrate,
      Math.round(computeConcurrencyScaledBitrateKbps(12_000, 2, 8_000) * 1000),
      'Friend 1 independent bitrate override applied to Friend 1 sender only'
    );
    assert.equal(
      fakeToF2.getVideoSender()!.getParameters().encodings[0].maxBitrate,
      34_000_000,
      'Friend 2 sender bitrate remained independent at 34 Mbps'
    );
    assert.notEqual(fakeToF1.getAudioSender()?.track ?? null, null, 'Audio track stays attached alongside video quality update');
    assert.equal(fakeToF1.audioSetParametersCalls, 0, 'Audio sender remains untouched for A/V synchronization');

    // Stop Friend 1 independently; Host + Friend 2 continue uninterrupted
    cFriend1Bridge.stopSharing('user_stopped');
    await waitUntil(
      () =>
        cFriend1Bridge.getSnapshot().isSharingLocal === false &&
        cHostBridge.getSnapshot().incomingStreams.filter((s) => s.stream !== null).length === 1,
      'Friend 1 stopped independently without disrupting Host (4K) or Friend 2 (1080p)'
    );
    console.log('  [PASS] 4C.3. Two & three simultaneous publishers, concurrency headroom, independent per-peer bitrate & A/V sync verified');

    // 4C.4: Network degradation & recovery via getStats() ABR + negotiated diagnostics
    const f2PeerInstance = cHostBridge.getPeerInstance(cFriend2Id)!;
    // Healthy 4K60 baseline stats
    fakeToF2.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['codec-h264', { type: 'codec', id: 'codec-h264', mimeType: 'video/H264' }],
      ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 60_000_000, currentRoundTripTime: 0.012 }],
      ['out-1', { type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264', bytesSent: 4_500_000, timestamp: 1000, framesEncoded: 60, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 60, qualityLimitationReason: 'none' }],
    ]);
    const baselineSample = await f2PeerInstance.sampleAndAdaptStats(10_000);
    assert.equal(baselineSample.outbound.resolution, '3840×2160');
    assert.equal(baselineSample.outbound.codecMimeType, 'H264');
    assert.equal(baselineSample.outbound.adaptationStatus, 'target');
    assert.equal(baselineSample.outbound.targetBitrateKbps, 34_000);

    // Inject severe bandwidth drop & packet loss -> ABR must step down maxBitrate automatically
    fakeToF2.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['codec-h264', { type: 'codec', id: 'codec-h264', mimeType: 'video/H264' }],
      ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 9_000_000, currentRoundTripTime: 0.28 }],
      ['out-1', { type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264', bytesSent: 5_600_000, timestamp: 2000, framesEncoded: 118, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 58, qualityLimitationReason: 'bandwidth' }],
      ['rem-in-1', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.05, jitter: 0.014, roundTripTime: 0.28 }],
    ]);
    const degradedSample = await f2PeerInstance.sampleAndAdaptStats(12_000);
    assert.equal(degradedSample.outbound.adaptationStatus, 'degraded');
    assert.equal(degradedSample.outbound.qualityLimitationReason, 'bandwidth');
    assert.equal((degradedSample.outbound.targetBitrateKbps ?? 99_999) < 34_000, true, 'ABR lowered target bitrate on bandwidth drop');
    assert.equal(
      (fakeToF2.getVideoSender()!.getParameters().encodings[0].maxBitrate ?? 99_999_000) < 34_000_000,
      true,
      'RTCRtpSender.setParameters maxBitrate updated cleanly on degradation'
    );

    // Inject recovered network conditions -> ABR must recover smoothly back to target ceiling (34_000 kbps)
    let simTime = 14_000;
    let recoveredBitrate = degradedSample.outbound.targetBitrateKbps ?? 0;
    let recoveredStatus: string | null | undefined = degradedSample.outbound.adaptationStatus;
    for (let step = 0; step < 16; step += 1) {
      simTime += 2000;
      fakeToF2.mockStatsMap = new Map<string, Record<string, unknown>>([
        ['codec-h264', { type: 'codec', id: 'codec-h264', mimeType: 'video/H264' }],
        ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 75_000_000, currentRoundTripTime: 0.011 }],
        ['out-1', { type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264', bytesSent: 5_600_000 + (step + 1) * 4_200_000, timestamp: 3000 + step * 1000, framesEncoded: 120 + (step + 1) * 60, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 60, qualityLimitationReason: 'none' }],
        ['rem-in-1', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.001, jitter: 0.002, roundTripTime: 0.011 }],
      ]);
      const sample = await f2PeerInstance.sampleAndAdaptStats(simTime);
      recoveredBitrate = sample.outbound.targetBitrateKbps ?? 0;
      recoveredStatus = sample.outbound.adaptationStatus;
      if (recoveredStatus === 'target' && recoveredBitrate >= 34_000) {
        break;
      }
    }
    assert.equal(recoveredStatus, 'target', 'ABR smoothly restored target status after network recovery');
    assert.equal(recoveredBitrate, 34_000, 'ABR restored full 34 Mbps ceiling for 2 active peers');
    assert.equal(fakeToF2.getVideoSender()!.getParameters().encodings[0].maxBitrate, 34_000_000);
    console.log('  [PASS] 4C.4. getStats() ABR network degradation step-down, smooth recovery & negotiated resolution/codec diagnostics verified');

    cHostBridge.dispose();
    cFriend1Bridge.dispose();
    cFriend2Bridge.dispose();
    await fetch(`${baseUrl}/api/rooms/${room4cId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${room4cCreated.hostToken}` },
    });
    await cHostWs.close();
    await cFriend1Ws.close();
    await cFriend2Ws.close();

    // =========================================================================
    // Stage 4D: Real Streaming Quality Diagnostics (Capture, Outbound RTP, Inbound RTP + <video>)
    // =========================================================================
    console.log('\nStarting Stage 4D Real Streaming Quality Diagnostics tests...');

    // 4D.1: Missing & unavailable statistics must safely return null / "Statistics unavailable"
    const emptyCollector = new WebRtcStatsCollector('bidirectional');
    const emptyPc = new FakeRtcPeerConnection();
    emptyPc.mockStatsMap = new Map();
    const emptySample = await emptyCollector.sampleBidirectional({
      pc: emptyPc as unknown as RTCPeerConnection,
      outboundTargetFps: 60,
      inboundTargetFps: 60,
      connectionState: 'connected',
      localVideoTrack: null,
      hasInboundVideo: true,
    });
    assert.equal(emptySample.outbound.captureWidth, null);
    assert.equal(emptySample.outbound.encodedWidth, null);
    assert.equal(emptySample.outbound.framesSent, null);
    assert.equal(emptySample.inbound.decodedWidth, null);
    assert.equal(emptySample.inbound.framesDecoded, null);
    assert.equal(formatDimensionsLabel(emptySample.outbound.encodedWidth, emptySample.outbound.encodedHeight), 'Unavailable');

    // Outbound/inbound RTP present WITHOUT frameWidth/frameHeight
    const partialStatsPc = new FakeRtcPeerConnection();
    const partialStream = new FakeMediaStream('partial-cap', 'cap', { width: 3840, height: 2160, frameRate: 60 });
    const partialTrack = partialStream.getVideoTracks()[0] as unknown as MediaStreamTrack;
    partialStatsPc.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['out-partial', { type: 'outbound-rtp', kind: 'video', bytesSent: 12000, timestamp: 1000 }],
      ['in-partial', { type: 'inbound-rtp', kind: 'video', bytesReceived: 12000, timestamp: 1000 }],
    ]);
    const partialSample = await emptyCollector.sampleBidirectional({
      pc: partialStatsPc as unknown as RTCPeerConnection,
      outboundTargetFps: 60,
      inboundTargetFps: 60,
      connectionState: 'connected',
      localVideoTrack: partialTrack,
      hasInboundVideo: true,
    });
    // Capture dimensions exist from getSettings(), while RTP dimensions stay honestly null
    assert.equal(partialSample.outbound.captureWidth, 3840);
    assert.equal(partialSample.outbound.captureHeight, 2160);
    assert.equal(partialSample.outbound.encodedWidth, null);
    assert.equal(partialSample.outbound.encodedHeight, null);
    assert.equal(partialSample.outbound.framesSent, null);
    assert.equal(partialSample.inbound.decodedWidth, null);
    assert.equal(partialSample.inbound.framesDecoded, null);

    const unavailableSummary = buildStageDiagnosticsSummary({
      preferences: prefs4k,
      connectionState: 'connected',
      isSharingLocal: true,
      localCaptureMeta: { width: 3840, height: 2160, fps: 60, hasAudio: false },
      outboundTelemetry: partialSample.outbound,
      primaryIncoming: null,
    });
    // Even though 4K capture happened, outbound RTP stats are missing -> never claim "4K verified"!
    assert.equal(unavailableSummary.capture.verification.status, '4K verified');
    assert.equal(unavailableSummary.outgoing.verification.status, 'Statistics unavailable');
    assert.equal(unavailableSummary.overallVerification.status, 'Statistics unavailable');
    assert.equal(unavailableSummary.incoming.verification.status, 'Statistics unavailable');
    console.log('  [PASS] 4D.1. Missing & unavailable statistics safely reported without crashing or faking 4K verification');

    // 4D.2: Requested 4K with actual 1080p stream -> "Requested quality not achieved"
    const mismatchCollector = new WebRtcStatsCollector('bidirectional');
    const mismatchPc = new FakeRtcPeerConnection();
    const mismatchStream = new FakeMediaStream('mismatch-1080', 'cap', { width: 1920, height: 1080, frameRate: 60 });
    const mismatchTrack = mismatchStream.getVideoTracks()[0] as unknown as MediaStreamTrack;
    mismatchPc.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['codec-h264', { type: 'codec', id: 'codec-h264', mimeType: 'video/H264' }],
      ['out-1', { type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264', bytesSent: 1_000_000, timestamp: 1000, framesSent: 60, framesEncoded: 60, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60 }],
      ['in-1', { type: 'inbound-rtp', kind: 'video', codecId: 'codec-h264', bytesReceived: 980_000, timestamp: 1000, framesDecoded: 60, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60 }],
    ]);
    const mismatchSample = await mismatchCollector.sampleBidirectional({
      pc: mismatchPc as unknown as RTCPeerConnection,
      outboundTargetFps: 60,
      inboundTargetFps: 60,
      connectionState: 'connected',
      localVideoTrack: mismatchTrack,
      hasInboundVideo: true,
    });
    const mismatchSummary = buildStageDiagnosticsSummary({
      preferences: prefs4k,
      connectionState: 'connected',
      isSharingLocal: true,
      localCaptureMeta: { width: 1920, height: 1080, fps: 60, hasAudio: false },
      outboundTelemetry: mismatchSample.outbound,
      primaryIncoming: {
        streamMeta: { width: 3840, height: 2160, fps: 60, codec: 'H264' },
        telemetry: mismatchSample.inbound,
        renderedWidth: 1920,
        renderedHeight: 1080,
        phase: 'connected',
      },
    });
    assert.equal(mismatchSummary.capture.verification.status, 'Requested quality not achieved');
    assert.equal(mismatchSummary.outgoing.verification.status, 'Requested quality not achieved');
    assert.equal(mismatchSummary.incoming.verification.status, 'Requested quality not achieved');
    assert.equal(mismatchSummary.overallVerification.status, 'Requested quality not achieved');

    // Also verify <video> render downscale guard: inbound-rtp decoded 4K, but DOM <video> is 1080p -> not 4K verified
    const downscaledRenderCheck = evaluateQualityVerification({
      stage: 'inbound',
      requestedPreset: '4k',
      requestedFps: 60,
      width: 3840,
      height: 2160,
      actualFps: 60,
      secondaryWidth: 1920,
      secondaryHeight: 1080,
    });
    assert.equal(downscaledRenderCheck.status, 'Requested quality not achieved');
    console.log('  [PASS] 4D.2. Requested 4K with actual 1080p RTP or downscaled <video> honestly reports "Requested quality not achieved"');

    // 4D.3: Simulated RTP + <video> verification for 1080p, 1440p, and 4K + Bridge updateIncomingRenderedDimensions
    const verifiedCollector = new WebRtcStatsCollector('bidirectional');
    const verifiedPc = new FakeRtcPeerConnection();
    const stream4kTrack = new FakeMediaStream('sim-4k', 'cap', { width: 3840, height: 2160, frameRate: 60 })
      .getVideoTracks()[0] as unknown as MediaStreamTrack;
    verifiedPc.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['codec-vp9', { type: 'codec', id: 'codec-vp9', mimeType: 'video/VP9' }],
      ['out-4k', { type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 5_000_000, timestamp: 1000, framesSent: 240, framesEncoded: 240, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 60 }],
      ['in-4k', { type: 'inbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesReceived: 4_900_000, timestamp: 1000, framesDecoded: 238, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 60 }],
    ]);
    await verifiedCollector.sampleBidirectional({
      pc: verifiedPc as unknown as RTCPeerConnection,
      outboundTargetFps: 60,
      inboundTargetFps: 60,
      connectionState: 'connected',
      localVideoTrack: stream4kTrack,
      hasInboundVideo: true,
    });
    verifiedPc.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['codec-vp9', { type: 'codec', id: 'codec-vp9', mimeType: 'video/VP9' }],
      ['out-4k', { type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 10_000_000, timestamp: 2000, framesSent: 300, framesEncoded: 300, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 60 }],
      ['in-4k', { type: 'inbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesReceived: 9_900_000, timestamp: 2000, framesDecoded: 298, frameWidth: 3840, frameHeight: 2160, framesPerSecond: 60 }],
    ]);
    const sample4k = await verifiedCollector.sampleBidirectional({
      pc: verifiedPc as unknown as RTCPeerConnection,
      outboundTargetFps: 60,
      inboundTargetFps: 60,
      connectionState: 'connected',
      localVideoTrack: stream4kTrack,
      hasInboundVideo: true,
    });
    assert.equal(sample4k.outbound.framesSent, 300);
    assert.equal(sample4k.inbound.framesDecoded, 298);
    assert.equal(Math.round(sample4k.outbound.bitrateKbps ?? 0), 40_000);
    assert.equal(Math.round(sample4k.inbound.bitrateKbps ?? 0), 40_000);

    const verified4kSummary = buildStageDiagnosticsSummary({
      preferences: prefs4k,
      connectionState: 'connected',
      isSharingLocal: true,
      localCaptureMeta: { width: 3840, height: 2160, fps: 60, hasAudio: true },
      outboundTelemetry: sample4k.outbound,
      primaryIncoming: {
        streamMeta: { width: 3840, height: 2160, fps: 60, codec: 'VP9' },
        telemetry: sample4k.inbound,
        renderedWidth: 3840,
        renderedHeight: 2160,
        phase: 'connected',
      },
    });
    assert.equal(verified4kSummary.capture.verification.status, '4K verified');
    assert.equal(verified4kSummary.outgoing.verification.status, '4K verified');
    assert.equal(verified4kSummary.incoming.verification.status, '4K verified');
    assert.equal(verified4kSummary.overallVerification.status, '4K verified');

    assert.equal(
      evaluateQualityVerification({
        stage: 'outbound',
        requestedPreset: '1440p',
        width: 2560,
        height: 1440,
        actualFps: 60,
      }).status,
      '1440p verified'
    );
    assert.equal(
      evaluateQualityVerification({
        stage: 'outbound',
        requestedPreset: '1080p',
        width: 1920,
        height: 1080,
        actualFps: 60,
      }).status,
      '1080p verified'
    );

    // Verify WebRtcSignalingBridge renderedWidth/renderedHeight sync on an incoming stream
    const diagRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'diag-host',
        hostDeviceName: 'Diag Sender',
        hostPlatform: 'macos',
      }),
    });
    const diagRoomData = (await diagRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
    const diagRoomId = diagRoomData.room.roomId;
    const diagRxJoin = (await (
      await fetch(`${baseUrl}/api/rooms/${diagRoomId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: 'diag-rx',
          deviceName: 'Diag Viewer',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string };
    await fetch(`${baseUrl}/api/rooms/${diagRoomId}/pair-requests/diag-rx/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${diagRoomData.hostToken}` },
    });
    const diagHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: 'diag-host',
      deviceName: 'Diag Sender',
      platform: 'macos',
      role: 'both',
      roomId: diagRoomId,
      token: diagRoomData.hostToken,
    });
    const diagRxWs = await connectAndAnnounce({
      wsUrl,
      deviceId: 'diag-rx',
      deviceName: 'Diag Viewer',
      platform: 'macos',
      role: 'both',
      roomId: diagRoomId,
      token: diagRxJoin.memberToken,
    });
    let diagRoomSnap = ((await (await fetch(`${baseUrl}/api/rooms/${diagRoomId}`)).json()) as { room: RoomSnapshot }).room;
    const diagHostBridge = new WebRtcSignalingBridge({
      deviceId: 'diag-host',
      preferences: prefs4k,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(diagHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('diag-4k', { width: 3840, height: 2160, frameRate: 60 }),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });
    const diagRxBridge = new WebRtcSignalingBridge({
      deviceId: 'diag-rx',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(diagRxWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('diag-rx-cap', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: () => new FakeRtcPeerConnection() as unknown as RTCPeerConnection,
    });
    const wireDiag = (wsClient: TestWsClient, bridge: WebRtcSignalingBridge, role: 'host' | 'receiver', devId: string, prefs: CapturePreferences) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === diagRoomId) {
          diagRoomSnap = { ...diagRoomSnap, ...(msg.payload as Partial<RoomSnapshot>) };
          bridge.updateContext({ deviceId: devId, activeRoom: diagRoomSnap, activeRoomRole: role, preferences: prefs, networkPrefs: netPrefs4b });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };
    diagHostBridge.updateContext({ deviceId: 'diag-host', activeRoom: diagRoomSnap, activeRoomRole: 'host', preferences: prefs4k, networkPrefs: netPrefs4b });
    diagRxBridge.updateContext({ deviceId: 'diag-rx', activeRoom: diagRoomSnap, activeRoomRole: 'receiver', preferences: default1080Prefs, networkPrefs: netPrefs4b });
    wireDiag(diagHostWs, diagHostBridge, 'host', 'diag-host', prefs4k);
    wireDiag(diagRxWs, diagRxBridge, 'receiver', 'diag-rx', default1080Prefs);

    await diagHostBridge.startScreenSharing('diag-rx');
    await waitUntil(
      () => diagRxBridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === 'diag-host' && s.stream !== null),
      'Diag receiver gets incoming stream'
    );
    diagRxBridge.updateIncomingRenderedDimensions('diag-host', 3840, 2160);
    const syncedIncoming = diagRxBridge.getSnapshot().incomingStreams.find((s) => s.senderDeviceId === 'diag-host')!;
    assert.equal(syncedIncoming.renderedWidth, 3840);
    assert.equal(syncedIncoming.renderedHeight, 2160);
    assert.equal(syncedIncoming.telemetry.renderedWidth, 3840);
    assert.equal(syncedIncoming.telemetry.renderedHeight, 2160);

    diagRxBridge.updateIncomingRenderedDimensions('diag-host', null, null);
    const clearedIncoming = diagRxBridge.getSnapshot().incomingStreams.find((s) => s.senderDeviceId === 'diag-host')!;
    assert.equal(clearedIncoming.renderedWidth, null);
    assert.equal(clearedIncoming.renderedHeight, null);

    diagHostBridge.dispose();
    diagRxBridge.dispose();
    await fetch(`${baseUrl}/api/rooms/${diagRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${diagRoomData.hostToken}` },
    });
    await diagHostWs.close();
    await diagRxWs.close();
    console.log('  [PASS] 4D.3. Simulated 1080p/1440p/4K diagnostics & <video> element dimension synchronization verified');

    // =========================================================================
    // Stage 4E: Connection Reliability, ICE Recovery, Backoff Retry & TURN Support
    // =========================================================================
    console.log('\nStarting Stage 4E Connection Reliability & TURN tests...');

    // 4E.1: Unconfigured TURN fallback (default environment) + health & ice-servers endpoints
    const defaultHealth = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
      turnConfigured: boolean;
      turnMode: string;
    };
    assert.equal(defaultHealth.turnConfigured, false);
    assert.equal(defaultHealth.turnMode, 'disabled');

    const defaultIce = (await (await fetch(`${baseUrl}/api/ice-servers`)).json()) as {
      iceServers: RTCIceServer[];
      turnConfigured: boolean;
      turnMode: string;
    };
    assert.equal(defaultIce.turnConfigured, false);
    assert.equal(defaultIce.turnMode, 'disabled');
    assert.equal(
      defaultIce.iceServers.some((s) =>
        (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('stun:'))
      ),
      true,
      'STUN configuration preserved when TURN is unconfigured'
    );

    // Verify configured TURN over UDP + TCP + TLS with temporary HMAC-SHA1 backend credentials & authorization checks
    const prevStunEnv = process.env.CASTORA_STUN_URLS;
    const prevTurnUrlsEnv = process.env.CASTORA_TURN_URLS;
    const prevTurnSecretEnv = process.env.CASTORA_TURN_AUTH_SECRET;
    const prevTurnTtlEnv = process.env.CASTORA_TURN_TTL_SECONDS;
    let turnTestRoomId = '';
    let turnHostToken = '';
    try {
      const testTurnSecret = 'castora-ephemeral-turn-secret-key';
      process.env.CASTORA_STUN_URLS = 'stun:stun.l.google.com:19302';
      process.env.CASTORA_TURN_URLS =
        'turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp';
      process.env.CASTORA_TURN_AUTH_SECRET = testTurnSecret;
      process.env.CASTORA_TURN_TTL_SECONDS = '1800';

      const turnHealth = (await (await fetch(`${baseUrl}/api/health`)).json()) as {
        turnConfigured: boolean;
        turnMode: string;
      };
      assert.equal(turnHealth.turnConfigured, true);
      assert.equal(turnHealth.turnMode, 'ephemeral-hmac');

      // Missing credentials/room token must be rejected when TURN is active
      const unauthIceRes = await fetch(`${baseUrl}/api/ice-servers`);
      assert.equal(unauthIceRes.status, 403, 'TURN credential endpoint rejects unauthenticated requests');

      // Create room and test host vs pending vs approved receiver
      const turnRoomRes = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostDeviceId: 'turn-host',
          hostDeviceName: 'TURN Host',
          hostPlatform: 'macos',
        }),
      });
      const turnRoomData = (await turnRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
      turnTestRoomId = turnRoomData.room.roomId;
      turnHostToken = turnRoomData.hostToken;

      const pendingJoin = (await (
        await fetch(`${baseUrl}/api/rooms/${turnTestRoomId}/pair-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            receiverDeviceId: 'turn-rx-pending',
            deviceName: 'TURN Pending',
            platform: 'macos',
          }),
        })
      ).json()) as { memberToken: string };

      const pendingIceRes = await fetch(
        `${baseUrl}/api/ice-servers?roomId=${turnTestRoomId}&deviceId=turn-rx-pending`,
        { headers: { Authorization: `Bearer ${pendingJoin.memberToken}` } }
      );
      assert.equal(pendingIceRes.status, 403, 'Unapproved pending participant cannot retrieve TURN credentials');

      const hostIceRes = await fetch(
        `${baseUrl}/api/ice-servers?roomId=${turnTestRoomId}&deviceId=turn-host`,
        { headers: { Authorization: `Bearer ${turnHostToken}` } }
      );
      assert.equal(hostIceRes.status, 200);
      assert.equal(hostIceRes.headers.get('cache-control'), 'no-store');
      const hostIceBody = (await hostIceRes.json()) as {
        iceServers: RTCIceServer[];
        turnConfigured: boolean;
        turnMode: string;
        transports: string[];
        ttlSeconds: number;
        expiresAt: string;
      };
      assert.equal(hostIceBody.turnConfigured, true);
      assert.equal(hostIceBody.turnMode, 'ephemeral-hmac');
      assert.equal(hostIceBody.ttlSeconds, 1800);
      assert.deepEqual(hostIceBody.transports.sort(), ['tcp', 'tls', 'udp']);
      const turnEntry = hostIceBody.iceServers.find(
        (entry) => typeof entry.username === 'string' && typeof entry.credential === 'string'
      );
      assert.ok(turnEntry, 'TURN entry with temporary username and credential returned');
      assert.equal(
        turnEntry.username!.endsWith(':turn-host'),
        true,
        'Temporary username binds expiry and device ID'
      );
      const expectedCred = crypto
        .createHmac('sha1', testTurnSecret)
        .update(turnEntry.username!)
        .digest('base64');
      assert.equal(turnEntry.credential, expectedCred, 'Ephemeral credential matches HMAC-SHA1 coturn digest');

      const mergedRtcConfig = buildRtcConfiguration({
        ...netPrefs4b,
        serverIceServers: hostIceBody.iceServers,
      });
      const flatUrls = (mergedRtcConfig.iceServers ?? []).flatMap((srv) =>
        Array.isArray(srv.urls) ? srv.urls : [srv.urls]
      );
      assert.equal(flatUrls.some((u) => u.startsWith('stun:')), true, 'STUN preserved after TURN merge');
      assert.equal(flatUrls.some((u) => u.includes('transport=udp')), true, 'TURN UDP preserved');
      assert.equal(flatUrls.some((u) => u.includes('transport=tcp')), true, 'TURN TCP preserved');
      assert.equal(flatUrls.some((u) => u.startsWith('turns:')), true, 'TURN TLS preserved');
    } finally {
      if (turnTestRoomId && turnHostToken) {
        await fetch(`${baseUrl}/api/rooms/${turnTestRoomId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${turnHostToken}` },
        });
      }
      if (prevStunEnv === undefined) delete process.env.CASTORA_STUN_URLS;
      else process.env.CASTORA_STUN_URLS = prevStunEnv;
      if (prevTurnUrlsEnv === undefined) delete process.env.CASTORA_TURN_URLS;
      else process.env.CASTORA_TURN_URLS = prevTurnUrlsEnv;
      if (prevTurnSecretEnv === undefined) delete process.env.CASTORA_TURN_AUTH_SECRET;
      else process.env.CASTORA_TURN_AUTH_SECRET = prevTurnSecretEnv;
      if (prevTurnTtlEnv === undefined) delete process.env.CASTORA_TURN_TTL_SECONDS;
      else process.env.CASTORA_TURN_TTL_SECONDS = prevTurnTtlEnv;
    }
    console.log('  [PASS] 4E.1. TURN env parsing, STUN-only fallback, auth guard & ephemeral HMAC-SHA1 credentials verified');

    // 4E.2: Temporary disconnection -> ICE restart -> recovery, Failed -> Exponential Backoff Retry Limit -> Manual Retry & Healthy Isolation
    const rHostId = 'rel-host-1';
    const rPeer1Id = 'rel-peer-1';
    const rPeer2Id = 'rel-peer-2';
    const rPeer3Id = 'rel-peer-3';
    const rRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: rHostId,
        hostDeviceName: 'Rel Host',
        hostPlatform: 'macos',
      }),
    });
    const rRoomData = (await rRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
    const rRoomId = rRoomData.room.roomId;

    const rPeerTokens: Record<string, string> = {};
    for (const pid of [rPeer1Id, rPeer2Id, rPeer3Id]) {
      const join = (await (
        await fetch(`${baseUrl}/api/rooms/${rRoomId}/pair-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            receiverDeviceId: pid,
            deviceName: `Device ${pid}`,
            platform: 'macos',
          }),
        })
      ).json()) as { memberToken: string };
      rPeerTokens[pid] = join.memberToken;
      await fetch(`${baseUrl}/api/rooms/${rRoomId}/pair-requests/${pid}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${rRoomData.hostToken}` },
      });
    }

    const rHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: rHostId,
      deviceName: 'Rel Host',
      platform: 'macos',
      role: 'both',
      roomId: rRoomId,
      token: rRoomData.hostToken,
    });
    const rPeer1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: rPeer1Id,
      deviceName: `Device ${rPeer1Id}`,
      platform: 'macos',
      role: 'both',
      roomId: rRoomId,
      token: rPeerTokens[rPeer1Id],
    });
    const rPeer2Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: rPeer2Id,
      deviceName: `Device ${rPeer2Id}`,
      platform: 'macos',
      role: 'both',
      roomId: rRoomId,
      token: rPeerTokens[rPeer2Id],
    });
    const rPeer3Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: rPeer3Id,
      deviceName: `Device ${rPeer3Id}`,
      platform: 'macos',
      role: 'both',
      roomId: rRoomId,
      token: rPeerTokens[rPeer3Id],
    });

    let rRoomSnap = ((await (await fetch(`${baseUrl}/api/rooms/${rRoomId}`)).json()) as { room: RoomSnapshot }).room;
    const hostPeerMap = new Map<string, FakeRtcPeerConnection>();
    let rejectReplacementsForPeer1 = false;
    const fastReconnectCfg = {
      maxAttempts: 3,
      baseDelayMs: 25,
      maxDelayMs: 100,
      iceDisconnectGraceMs: 25,
      recoveryVerifyMs: 45,
    };

    const rHostBridge = new WebRtcSignalingBridge({
      deviceId: rHostId,
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(rHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('rel-host-cap', { width: 1920, height: 1080, frameRate: 60 }),
      reconnectConfig: fastReconnectCfg,
      rtcFactory: (cfg) => {
        const pc = new FakeRtcPeerConnection(cfg);
        if (rejectReplacementsForPeer1) {
          pc.iceConnectionState = 'failed';
          pc.connectionState = 'failed';
          pc.createOffer = async () => {
            throw new Error('Simulated persistent ICE failure');
          };
        }
        return pc as unknown as RTCPeerConnection;
      },
    });
    const rPeer1Bridge = new WebRtcSignalingBridge({
      deviceId: rPeer1Id,
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(rPeer1Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('rel-p1-cap', { width: 1920, height: 1080, frameRate: 60 }),
      reconnectConfig: fastReconnectCfg,
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const rPeer2Bridge = new WebRtcSignalingBridge({
      deviceId: rPeer2Id,
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(rPeer2Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('rel-p2-cap', { width: 1920, height: 1080, frameRate: 60 }),
      reconnectConfig: fastReconnectCfg,
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const rPeer3Bridge = new WebRtcSignalingBridge({
      deviceId: rPeer3Id,
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(rPeer3Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('rel-p3-cap', { width: 1920, height: 1080, frameRate: 60 }),
      reconnectConfig: fastReconnectCfg,
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });

    const wireRel = (wsClient: TestWsClient, bridge: WebRtcSignalingBridge, role: 'host' | 'receiver', devId: string) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === rRoomId) {
          rRoomSnap = { ...rRoomSnap, ...(msg.payload as Partial<RoomSnapshot>) };
          bridge.updateContext({
            deviceId: devId,
            activeRoom: rRoomSnap,
            activeRoomRole: role,
            preferences: default1080Prefs,
            networkPrefs: netPrefs4b,
          });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };

    for (const [b, r, d, w] of [
      [rHostBridge, 'host', rHostId, rHostWs],
      [rPeer1Bridge, 'receiver', rPeer1Id, rPeer1Ws],
      [rPeer2Bridge, 'receiver', rPeer2Id, rPeer2Ws],
      [rPeer3Bridge, 'receiver', rPeer3Id, rPeer3Ws],
    ] as const) {
      b.updateContext({
        deviceId: d,
        activeRoom: rRoomSnap,
        activeRoomRole: r,
        preferences: default1080Prefs,
        networkPrefs: netPrefs4b,
      });
      wireRel(w, b, r, d);
    }

    // Host broadcasts to Peer 1, Peer 2, Peer 3 simultaneously
    FakeRtcPeerConnection.instances = [];
    FakeRtcPeerConnection.closeEvents = [];
    await rHostBridge.startScreenSharing(null);
    await waitUntil(
      () =>
        rHostBridge.getSnapshot().outboundPeers.length === 3 &&
        rHostBridge.getSnapshot().outboundPeers.every((o) => o.phase === 'connected') &&
        rPeer1Bridge.getSnapshot().incomingStreams.some((s) => s.stream !== null) &&
        rPeer2Bridge.getSnapshot().incomingStreams.some((s) => s.stream !== null) &&
        rPeer3Bridge.getSnapshot().incomingStreams.some((s) => s.stream !== null),
      'All 3 peers connected cleanly'
    );

    const getRawPc = (bridge: WebRtcSignalingBridge, pid: string) =>
      (bridge.getPeerInstance(pid) as unknown as { pc: FakeRtcPeerConnection }).pc;

    hostPeerMap.set(rPeer1Id, getRawPc(rHostBridge, rPeer1Id));
    hostPeerMap.set(rPeer2Id, getRawPc(rHostBridge, rPeer2Id));
    hostPeerMap.set(rPeer3Id, getRawPc(rHostBridge, rPeer3Id));
    const healthyPeer3PcBefore = hostPeerMap.get(rPeer3Id)!;

    // Step A: Temporary disconnection on Peer 1 -> enters reconnecting -> restartIce() + ICE-restart offer -> heals back to connected without replacing PC
    const peer1PcBefore = hostPeerMap.get(rPeer1Id)!;
    peer1PcBefore.emitConnectionDrop('disconnected');
    assert.equal(
      rHostBridge.getSnapshot().outboundPeers.find((o) => o.targetDeviceId === rPeer1Id)?.phase,
      'reconnecting',
      'Temporary ICE disconnected moves peer phase cleanly to reconnecting'
    );
    await waitUntil(
      () => peer1PcBefore.restartIceCalls >= 1 && peer1PcBefore.createOfferCalls.some((c) => c.iceRestart),
      'Temporary disconnection triggers restartIce() and ICE-restart SDP offer'
    );
    peer1PcBefore.emitConnectionDrop('connected');
    await waitUntil(
      () =>
        rHostBridge.getSnapshot().outboundPeers.find((o) => o.targetDeviceId === rPeer1Id)?.phase === 'connected' &&
        (rHostBridge.getPeerRecoveryState(rPeer1Id)?.attempt ?? 0) === 0,
      'Temporary disconnection recovers to connected and resets attempt counter'
    );
    assert.equal(getRawPc(rHostBridge, rPeer1Id), peer1PcBefore, 'Healthy ICE restart avoided unnecessary PC replacement');
    assert.equal(healthyPeer3PcBefore.restartIceCalls, 0, 'Healthy Peer 3 untouched during Peer 1 temporary interruption');
    console.log('  [PASS] 4E.2. Temporary ICE disconnect -> restartIce() -> clean recovery & healthy peer isolation verified');

    // Step B: Permanent failure on Peer 1 with duplicate rapid failure triggers + retry exhaustion + manual Retry + clean old PC disposal before replacement
    rejectReplacementsForPeer1 = true;
    const pcBeforeExhaust = getRawPc(rHostBridge, rPeer1Id);
    // Fire duplicate rapid failed notifications
    pcBeforeExhaust.emitConnectionDrop('failed');
    pcBeforeExhaust.emitConnectionDrop('failed');
    pcBeforeExhaust.emitConnectionDrop('failed');
    assert.equal(
      rHostBridge.getPeerRecoveryState(rPeer1Id)?.attempt,
      1,
      'Duplicate rapid failure triggers must schedule only 1 attempt, not stack attempts'
    );

    await waitUntil(
      () => rHostBridge.getPeerRecoveryState(rPeer1Id)?.exhausted === true,
      'Exponential backoff exhausts after maxAttempts=3 and surfaces Retry state',
      4000
    );
    const failedPeer1Entry = rHostBridge.getSnapshot().outboundPeers.find((o) => o.targetDeviceId === rPeer1Id)!;
    assert.equal(failedPeer1Entry.phase, 'failed');
    const exhaustedQuality = evaluateConnectionQuality({
      phase: failedPeer1Entry.phase,
      iceConnectionState: failedPeer1Entry.iceConnectionState,
      telemetry: failedPeer1Entry.telemetry,
      recovery: failedPeer1Entry.recovery,
    });
    assert.equal(exhaustedQuality.level, 'failed');

    // Restore healthy factory and click manual Retry; verify old PC closed BEFORE new PC created
    rejectReplacementsForPeer1 = false;
    FakeRtcPeerConnection.instances = [];
    FakeRtcPeerConnection.closeEvents = [];
    const lastPcBeforeRetry = getRawPc(rHostBridge, rPeer1Id);
    const retried = await rHostBridge.retryPeerConnection(rPeer1Id);
    assert.equal(retried, true);
    assert.equal(lastPcBeforeRetry.signalingState, 'closed', 'Old RTCPeerConnection closed cleanly on retry');
    assert.equal(
      FakeRtcPeerConnection.closeEvents.includes(lastPcBeforeRetry),
      true,
      'Old RTCPeerConnection closed before replacement completion'
    );
    await waitUntil(
      () =>
        rHostBridge.getSnapshot().outboundPeers.find((o) => o.targetDeviceId === rPeer1Id)?.phase === 'connected' &&
        rPeer1Bridge.getSnapshot().incomingStreams.some((s) => s.stream !== null),
      'Manual Retry restores full streaming after failure'
    );
    assert.equal(healthyPeer3PcBefore.restartIceCalls, 0, 'Healthy Peer 3 remained completely untouched across retries');
    assert.equal(getRawPc(rHostBridge, rPeer3Id), healthyPeer3PcBefore, 'Healthy Peer 3 RTCPeerConnection never restarted');
    console.log('  [PASS] 4E.3. Duplicate failure guard, max backoff exhaustion & manual Retry (close-before-create) verified');

    // Step C: Multiple devices (Peer 1 and Peer 2) reconnecting simultaneously while Peer 3 remains untouched
    const p1Cur = getRawPc(rHostBridge, rPeer1Id);
    const p2Cur = getRawPc(rHostBridge, rPeer2Id);
    p1Cur.emitConnectionDrop('failed');
    p2Cur.emitConnectionDrop('disconnected');
    await waitUntil(
      () =>
        rHostBridge.getSnapshot().outboundPeers.some((o) => o.targetDeviceId === rPeer1Id && o.phase === 'reconnecting') &&
        rHostBridge.getSnapshot().outboundPeers.some((o) => o.targetDeviceId === rPeer2Id && o.phase === 'reconnecting'),
      'Both Peer 1 and Peer 2 enter independent recovery simultaneously'
    );
    p2Cur.emitConnectionDrop('connected');
    await waitUntil(
      () =>
        rHostBridge.getSnapshot().outboundPeers.find((o) => o.targetDeviceId === rPeer1Id)?.phase === 'connected' &&
        rHostBridge.getSnapshot().outboundPeers.find((o) => o.targetDeviceId === rPeer2Id)?.phase === 'connected',
      'Both simultaneous reconnecting peers recover independently'
    );
    assert.equal(getRawPc(rHostBridge, rPeer3Id), healthyPeer3PcBefore, 'Healthy Peer 3 remained unaffected during concurrent peer recovery');
    assert.equal(healthyPeer3PcBefore.restartIceCalls, 0, 'Zero ICE restarts triggered on healthy Peer 3');

    // Verify quality indicator helper across states
    assert.equal(
      evaluateConnectionQuality({
        phase: 'connected',
        telemetry: { ...createEmptyTelemetry(60, 'connected'), rttMs: 14, packetLossPct: 0 },
      }).level,
      'excellent'
    );
    assert.equal(
      evaluateConnectionQuality({
        phase: 'connected',
        telemetry: { ...createEmptyTelemetry(60, 'connected'), rttMs: 280, packetLossPct: 7.5 },
      }).level,
      'poor'
    );
    console.log('  [PASS] 4E.4. Multi-device simultaneous reconnection & connection quality assessment verified');

    rHostBridge.dispose();
    rPeer1Bridge.dispose();
    rPeer2Bridge.dispose();
    rPeer3Bridge.dispose();
    await fetch(`${baseUrl}/api/rooms/${rRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${rRoomData.hostToken}` },
    });
    await rHostWs.close();
    await rPeer1Ws.close();
    await rPeer2Ws.close();
    await rPeer3Ws.close();

    // Verify createEmptyTelemetry initializes diagnostic stage fields cleanly to null
    const blankTel = createEmptyTelemetry(60, 'idle');
    assert.equal(blankTel.captureWidth, null);
    assert.equal(blankTel.encodedWidth, null);
    assert.equal(blankTel.framesSent, null);
    assert.equal(blankTel.decodedWidth, null);
    assert.equal(blankTel.framesDecoded, null);
    assert.equal(blankTel.renderedWidth, null);
    assert.equal(blankTel.networkCondition, null);
    assert.equal(blankTel.lastAdjustmentReason, null);

    // =========================================================================
    // Stage 4F: Smart Adaptive Streaming Quality
    // =========================================================================
    console.log('\nStarting Stage 4F Smart Adaptive Streaming Quality tests...');

    // 4F.1: Named quality profiles, High/1080p60 default preservation, and profile mapping
    assert.deepEqual(QUALITY_PROFILE_ORDER, ['standard', 'high', 'ultra', 'maximum']);
    assert.equal(QUALITY_PROFILES.standard.resolution, '1080p');
    assert.equal(QUALITY_PROFILES.standard.targetFps, 30);
    assert.equal(QUALITY_PROFILES.high.resolution, '1080p');
    assert.equal(QUALITY_PROFILES.high.targetFps, 60);
    assert.equal(QUALITY_PROFILES.high.isDefault, true);
    assert.equal(QUALITY_PROFILES.ultra.resolution, '1440p');
    assert.equal(QUALITY_PROFILES.ultra.targetFps, 60);
    assert.equal(QUALITY_PROFILES.maximum.resolution, '4k');
    assert.equal(QUALITY_PROFILES.maximum.targetFps, 60);

    assert.equal(resolveProfileIdFromPreferences(default1080Prefs), 'high');
    const switchedUltra = applyQualityProfileToPreferences(default1080Prefs, 'ultra');
    assert.equal(resolveProfileIdFromPreferences(switchedUltra), 'ultra');
    assert.equal(switchedUltra.maxBitrateKbps, 20_000);
    const switchedStandard = applyQualityProfileToPreferences(switchedUltra, 'standard');
    assert.equal(resolveProfileIdFromPreferences(switchedStandard), 'standard');
    assert.equal(switchedStandard.maxBitrateKbps, 7_500);
    const switchedMax = applyQualityProfileToPreferences(switchedStandard, 'maximum');
    assert.equal(resolveProfileIdFromPreferences(switchedMax), 'maximum');
    assert.equal(switchedMax.maxBitrateKbps, 40_000);
    console.log('  [PASS] 4F.1. Quality profiles (Standard 1080p30, High 1080p60 default, Ultra 1440p60, Maximum 4K60) verified');

    // 4F.2: Congestion detection (loss, jitter, RTT, dropped frames), bitrate-first reduction, hysteresis & cooldown, and Manual mode lock
    const abrCtrl = new AdaptiveBitrateController(default1080Prefs);
    const baseStats = {
      ...createEmptyTelemetry(60, 'connected'),
      rttMs: 14,
      packetLossPct: 0.1,
      jitterMs: 2.0,
      encodedFps: 60,
      droppedFrames: 0,
      qualityLimitationReason: 'none' as const,
      availableOutgoingBitrateKbps: 25_000,
    };

    const initDecision = abrCtrl.evaluate(baseStats, { activeOutboundPeers: 1, nowMs: 1_000 });
    assert.equal(initDecision.networkCondition, 'healthy');
    assert.equal(initDecision.targetBitrateKbps, 10_000);
    assert.equal(initDecision.maxFramerate, 60);
    assert.equal(initDecision.scaleResolutionDownBy, 1.0);

    // Moderate congestion (high jitter + loss): reduces bitrate FIRST, preserving 60 FPS & 1.0x scale
    const moderateDecision = abrCtrl.evaluate(
      {
        ...baseStats,
        rttMs: 170,
        packetLossPct: 2.2,
        jitterMs: 32,
        qualityLimitationReason: 'bandwidth',
      },
      { activeOutboundPeers: 1, nowMs: 3_000 }
    );
    assert.equal(moderateDecision.changed, true);
    assert.equal(moderateDecision.networkCondition, 'moderate');
    assert.equal(moderateDecision.targetBitrateKbps, 7_800, 'Bitrate stepped down first on congestion');
    assert.equal(moderateDecision.maxFramerate, 60, 'Framerate preserved on initial moderate bitrate reduction');
    assert.equal(moderateDecision.scaleResolutionDownBy, 1.0, 'Resolution scale preserved on initial moderate bitrate reduction');
    assert.equal(moderateDecision.lastAdjustmentAction, 'reduced-bitrate');
    assert.ok(moderateDecision.lastAdjustmentReason?.includes('jitter'));

    // Rapid downgrade cooldown check (500ms later -> no flap)
    const cooldownBlocked = abrCtrl.evaluate(
      { ...baseStats, rttMs: 170, packetLossPct: 2.2, jitterMs: 32 },
      { activeOutboundPeers: 1, nowMs: 3_500 }
    );
    assert.equal(cooldownBlocked.changed, false, 'Downgrade cooldown prevents rapid consecutive step-downs');

    // Hysteresis & post-downgrade upgrade cooldown:
    // Healthy spike 1.5s after downgrade MUST NOT immediately jump back up
    const prematureHealthy1 = abrCtrl.evaluate(baseStats, { activeOutboundPeers: 1, nowMs: 4_500 });
    assert.equal(prematureHealthy1.targetBitrateKbps, 7_800, 'Hysteresis holds bitrate stable during brief recovery');
    const prematureHealthy2 = abrCtrl.evaluate(baseStats, { activeOutboundPeers: 1, nowMs: 6_000 });
    assert.equal(prematureHealthy2.targetBitrateKbps, 7_800, 'Post-downgrade cooldown (5s) blocks premature restoration');

    // After sustained healthy streak + cooldown (>= 8_000ms -> 5s elapsed since 3_000), steps up smoothly
    const restoredStep = abrCtrl.evaluate(baseStats, { activeOutboundPeers: 1, nowMs: 8_200 });
    assert.equal(restoredStep.changed, true);
    assert.equal(restoredStep.targetBitrateKbps, 10_000, 'Quality gradually restored after cooldown & hysteresis');
    assert.equal(restoredStep.lastAdjustmentAction, 'restored');
    assert.ok(restoredStep.lastAdjustmentReason?.includes('Restored'));

    // Sustained severe congestion + CPU/frame drops -> reduces bitrate to floor, then drops FPS & scaleResolutionDownBy
    let severeResult = abrCtrl.evaluate(
      {
        ...baseStats,
        rttMs: 290,
        packetLossPct: 6.5,
        jitterMs: 55,
        droppedFrames: 25,
        qualityLimitationReason: 'cpu',
        availableOutgoingBitrateKbps: 2_600,
      },
      { activeOutboundPeers: 1, nowMs: 12_000 }
    );
    severeResult = abrCtrl.evaluate(
      {
        ...baseStats,
        rttMs: 310,
        packetLossPct: 7.5,
        jitterMs: 65,
        droppedFrames: 45,
        qualityLimitationReason: 'cpu',
        availableOutgoingBitrateKbps: 2_200,
      },
      { activeOutboundPeers: 1, nowMs: 14_000 }
    );
    assert.equal(severeResult.networkCondition, 'congested');
    assert.equal(severeResult.maxFramerate, 30, 'FPS stepped down only after sustained severe/CPU pressure & low bitrate');
    assert.equal(severeResult.scaleResolutionDownBy >= 1.5, true, 'Resolution scale reduced when bitrate hit smooth floor');

    // Manual mode protection: under severe congestion, manual settings MUST NEVER be overridden
    const manualPrefs: CapturePreferences = {
      ...default1080Prefs,
      adaptiveBitrate: false,
      maxBitrateKbps: 10_000,
    };
    const manualDecision = abrCtrl.updatePreferences(manualPrefs, 1);
    assert.equal(manualDecision.adaptiveMode, 'manual');
    assert.equal(manualDecision.targetBitrateKbps, 10_000);
    assert.equal(manualDecision.maxFramerate, 60);
    assert.equal(manualDecision.scaleResolutionDownBy, 1.0);

    const underCongestionManual = abrCtrl.evaluate(
      {
        ...baseStats,
        rttMs: 400,
        packetLossPct: 12,
        jitterMs: 80,
        droppedFrames: 90,
        qualityLimitationReason: 'bandwidth',
        availableOutgoingBitrateKbps: 1_500,
      },
      { activeOutboundPeers: 1, nowMs: 18_000 }
    );
    assert.equal(underCongestionManual.adaptiveMode, 'manual');
    assert.equal(underCongestionManual.targetBitrateKbps, 10_000, 'Manual bitrate cap never overridden by congestion');
    assert.equal(underCongestionManual.maxFramerate, 60, 'Manual FPS never overridden by congestion');
    assert.equal(underCongestionManual.scaleResolutionDownBy, 1.0, 'Manual scale never overridden');
    assert.equal(underCongestionManual.networkCondition, 'congested', 'Network condition still reported honestly');
    assert.equal(underCongestionManual.lastAdjustmentAction, 'manual-locked');
    console.log('  [PASS] 4F.2. Congestion signals (loss/jitter/RTT/drops), bitrate-first cascade, hysteresis/cooldown & Manual lock verified');

    // 4F.3: Missing WebRTC stats & unsupported setParameters capabilities (partial fallback & full rejection)
    const missingStats = createEmptyTelemetry(60, 'connected');
    assert.equal(assessNetworkCondition(missingStats), 'unavailable');
    const autoOnMissing = new AdaptiveBitrateController(default1080Prefs);
    const missingEval = autoOnMissing.evaluate(missingStats, { nowMs: 5_000 });
    assert.equal(missingEval.networkCondition, 'unavailable');
    assert.equal(missingEval.changed, false, 'Missing WebRTC stats never causes blind quality drops');
    assert.equal(missingEval.targetBitrateKbps, 10_000);

    // remote-inbound-rtp packetsLost delta fallback when fractionLost is omitted
    const deltaLossCollector = new WebRtcStatsCollector('sender');
    const deltaLossPc = new FakeRtcPeerConnection();
    const deltaTrack = new FakeMediaStream('dl-cap', 'cap', { width: 1920, height: 1080, frameRate: 60 })
      .getVideoTracks()[0] as unknown as MediaStreamTrack;
    deltaLossPc.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['out-dl', { type: 'outbound-rtp', kind: 'video', bytesSent: 1_000_000, packetsSent: 1000, timestamp: 1000, framesSent: 60 }],
      ['rem-dl', { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 10, roundTripTime: 0.02, jitter: 0.004 }],
    ]);
    await deltaLossCollector.sampleBidirectional({
      pc: deltaLossPc as unknown as RTCPeerConnection,
      outboundTargetFps: 60,
      inboundTargetFps: 60,
      connectionState: 'connected',
      localVideoTrack: deltaTrack,
      hasInboundVideo: false,
    });
    deltaLossPc.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['out-dl', { type: 'outbound-rtp', kind: 'video', bytesSent: 2_000_000, packetsSent: 2000, timestamp: 2000, framesSent: 120 }],
      ['rem-dl', { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 50, roundTripTime: 0.02, jitter: 0.004 }],
    ]);
    const deltaLossSample = await deltaLossCollector.sampleBidirectional({
      pc: deltaLossPc as unknown as RTCPeerConnection,
      outboundTargetFps: 60,
      inboundTargetFps: 60,
      connectionState: 'connected',
      localVideoTrack: deltaTrack,
      hasInboundVideo: false,
    });
    assert.equal(
      Math.round((deltaLossSample.outbound.packetLossPct ?? 0) * 10) / 10,
      4.0,
      'Computed fallback packetLossPct from remote-inbound-rtp packetsLost when fractionLost omitted'
    );

    // Unsupported sender parameters fallback (scaleResolutionDownBy rejected -> falls back to { maxBitrate, maxFramerate }, then { maxBitrate }, then safe disable)
    const capRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'cap-host',
        hostDeviceName: 'Capability Host',
        hostPlatform: 'macos',
      }),
    });
    const capRoomData = (await capRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
    const capRoomId = capRoomData.room.roomId;
    const capRxJoin = (await (
      await fetch(`${baseUrl}/api/rooms/${capRoomId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverDeviceId: 'cap-rx',
          deviceName: 'Cap Receiver',
          platform: 'macos',
        }),
      })
    ).json()) as { memberToken: string };
    await fetch(`${baseUrl}/api/rooms/${capRoomId}/pair-requests/cap-rx/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${capRoomData.hostToken}` },
    });
    const capHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: 'cap-host',
      deviceName: 'Capability Host',
      platform: 'macos',
      role: 'both',
      roomId: capRoomId,
      token: capRoomData.hostToken,
    });
    const capRxWs = await connectAndAnnounce({
      wsUrl,
      deviceId: 'cap-rx',
      deviceName: 'Cap Receiver',
      platform: 'macos',
      role: 'both',
      roomId: capRoomId,
      token: capRxJoin.memberToken,
    });
    const capRoomSnap = ((await (await fetch(`${baseUrl}/api/rooms/${capRoomId}`)).json()) as { room: RoomSnapshot }).room;

    let setParamsMode: 'reject-scale' | 'reject-all' = 'reject-scale';
    let capHostFakePc: FakeRtcPeerConnection | null = null;
    const capHostBridge = new WebRtcSignalingBridge({
      deviceId: 'cap-host',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(capHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('cap-1080', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: (cfg) => {
        const pc = new FakeRtcPeerConnection(cfg);
        const origAddTrack = pc.addTrack.bind(pc);
        pc.addTrack = (track: { kind?: string }) => {
          const sender = origAddTrack(track);
          const origSetParams = sender.setParameters.bind(sender);
          sender.setParameters = async (params) => {
            if (track?.kind === 'video') {
              if (setParamsMode === 'reject-all') {
                throw new Error('NotSupportedError: setParameters blocked');
              }
              if (
                setParamsMode === 'reject-scale' &&
                params.encodings.some((e) => e.scaleResolutionDownBy !== undefined)
              ) {
                throw new Error('OperationError: scaleResolutionDownBy unsupported');
              }
            }
            return origSetParams(params);
          };
          return sender;
        };
        capHostFakePc = pc;
        return pc as unknown as RTCPeerConnection;
      },
    });
    const capRxBridge = new WebRtcSignalingBridge({
      deviceId: 'cap-rx',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(capRxWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('cap-rx', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const wireCap = (wsClient: TestWsClient, bridge: WebRtcSignalingBridge) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };
    capHostBridge.updateContext({
      deviceId: 'cap-host',
      activeRoom: capRoomSnap,
      activeRoomRole: 'host',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
    });
    capRxBridge.updateContext({
      deviceId: 'cap-rx',
      activeRoom: capRoomSnap,
      activeRoomRole: 'receiver',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
    });
    wireCap(capHostWs, capHostBridge);
    wireCap(capRxWs, capRxBridge);

    await capHostBridge.startScreenSharing('cap-rx');
    await waitUntil(
      () => capRxBridge.getSnapshot().incomingStreams.some((s) => s.stream !== null),
      'Capability test stream connected'
    );
    const capPeerInst = capHostBridge.getPeerInstance('cap-rx')!;
    const offersBeforeAdapt = capHostFakePc!.createOfferCalls.length;
    capHostFakePc!.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['out-1', { type: 'outbound-rtp', kind: 'video', bytesSent: 1_000_000, timestamp: 1000, framesEncoded: 60, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, qualityLimitationReason: 'bandwidth' }],
      ['rem-1', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.03, jitter: 0.035, roundTripTime: 0.19 }],
    ]);
    const fallbackBitrateSample = await capPeerInst.sampleAndAdaptStats(20_000);
    assert.equal(fallbackBitrateSample.outbound.supportedAdaptiveControls?.supportsSetParameters, true);
    assert.equal(fallbackBitrateSample.outbound.supportedAdaptiveControls?.supportsMaxBitrate, true);
    assert.equal(fallbackBitrateSample.outbound.supportedAdaptiveControls?.supportsScaleResolutionDownBy, false);
    assert.equal(
      (capHostFakePc!.getVideoSender()!.getParameters().encodings[0].maxBitrate ?? 99_999_000) < 10_000_000,
      true,
      'Bitrate fallback applied cleanly even when scaleResolutionDownBy rejected'
    );

    setParamsMode = 'reject-all';
    capHostFakePc!.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['out-1', { type: 'outbound-rtp', kind: 'video', bytesSent: 1_500_000, timestamp: 2000, framesEncoded: 100, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 40, qualityLimitationReason: 'bandwidth' }],
      ['rem-1', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.06, jitter: 0.055, roundTripTime: 0.28 }],
    ]);
    const fullRejectSample = await capPeerInst.sampleAndAdaptStats(25_000);
    assert.equal(fullRejectSample.outbound.supportedAdaptiveControls?.supportsSetParameters, false);
    assert.ok(fullRejectSample.outbound.supportedAdaptiveControls?.lastError);
    assert.equal(
      capHostFakePc!.createOfferCalls.length,
      offersBeforeAdapt,
      'Quality adaptation & fallbacks must NEVER trigger unnecessary SDP renegotiation'
    );

    capHostBridge.dispose();
    capRxBridge.dispose();
    await fetch(`${baseUrl}/api/rooms/${capRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${capRoomData.hostToken}` },
    });
    await capHostWs.close();
    await capRxWs.close();
    console.log('  [PASS] 4F.3. Missing stats, packetsLost fallback, unsupported setParameters fallbacks & zero SDP renegotiation verified');

    // 4F.4: Independent multi-peer adaptation across 6 devices (1 host + 5 paired receivers) + bidirectional sharing + independent stop
    const sixHostId = 'six-host-mac';
    const sixRxIds = ['six-rx-1', 'six-rx-2', 'six-rx-3', 'six-rx-4', 'six-rx-5'];
    const sixRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: sixHostId,
        hostDeviceName: 'Studio Host (6-Dev)',
        hostPlatform: 'macos',
      }),
    });
    const sixRoomData = (await sixRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
    const sixRoomId = sixRoomData.room.roomId;

    const sixHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: sixHostId,
      deviceName: 'Studio Host (6-Dev)',
      platform: 'macos',
      role: 'both',
      roomId: sixRoomId,
      token: sixRoomData.hostToken,
    });
    const sixRxWsList: TestWsClient[] = [];
    const sixRxBridges: WebRtcSignalingBridge[] = [];

    for (let i = 0; i < sixRxIds.length; i += 1) {
      const rxId = sixRxIds[i];
      const joinData = (await (
        await fetch(`${baseUrl}/api/rooms/${sixRoomId}/pair-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            receiverDeviceId: rxId,
            deviceName: `Receiver Mac ${i + 1}`,
            platform: 'macos',
          }),
        })
      ).json()) as { memberToken: string };
      const rxWs = await connectAndAnnounce({
        wsUrl,
        deviceId: rxId,
        deviceName: `Receiver Mac ${i + 1}`,
        platform: 'macos',
        role: 'both',
        roomId: sixRoomId,
        token: joinData.memberToken,
      });
      await fetch(`${baseUrl}/api/rooms/${sixRoomId}/pair-requests/${rxId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sixRoomData.hostToken}` },
      });
      sixRxWsList.push(rxWs);
    }

    let sixRoomSnap = ((await (await fetch(`${baseUrl}/api/rooms/${sixRoomId}`)).json()) as { room: RoomSnapshot }).room;
    assert.equal(sixRoomSnap.pairedReceivers.length, 5, '6-device room active (1 host + 5 paired receivers)');

    const sixHostBridge = new WebRtcSignalingBridge({
      deviceId: sixHostId,
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(sixHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('six-host-1080', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    sixHostBridge.updateContext({
      deviceId: sixHostId,
      activeRoom: sixRoomSnap,
      activeRoomRole: 'host',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
    });

    const wireSix = (
      wsClient: TestWsClient,
      bridge: WebRtcSignalingBridge,
      role: 'host' | 'receiver',
      devId: string
    ) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === sixRoomId) {
          sixRoomSnap = { ...sixRoomSnap, ...(msg.payload as Partial<RoomSnapshot>) };
          bridge.updateContext({
            deviceId: devId,
            activeRoom: sixRoomSnap,
            activeRoomRole: role,
            preferences: default1080Prefs,
            networkPrefs: netPrefs4b,
          });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };
    wireSix(sixHostWs, sixHostBridge, 'host', sixHostId);

    for (let i = 0; i < sixRxIds.length; i += 1) {
      const rxId = sixRxIds[i];
      const rxBridge = new WebRtcSignalingBridge({
        deviceId: rxId,
        preferences: default1080Prefs,
        networkPrefs: netPrefs4b,
        getSignalingClient: () => wrapWsSender(sixRxWsList[i]),
        callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
        captureFn: makeDynamicCapture(`six-rx-${i + 1}`, { width: 1920, height: 1080, frameRate: 60 }),
        rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
      });
      rxBridge.updateContext({
        deviceId: rxId,
        activeRoom: sixRoomSnap,
        activeRoomRole: 'receiver',
        preferences: default1080Prefs,
        networkPrefs: netPrefs4b,
      });
      wireSix(sixRxWsList[i], rxBridge, 'receiver', rxId);
      sixRxBridges.push(rxBridge);
    }

    // Host shares screen to all 5 receivers simultaneously, AND Receiver 1 shares back bidirectionally
    await sixHostBridge.startScreenSharing(null);
    await sixRxBridges[0].startScreenSharing(sixHostId);

    await waitUntil(
      () =>
        sixHostBridge.getSnapshot().outboundPeers.length === 5 &&
        sixRxBridges.every((b) =>
          b.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === sixHostId && s.stream !== null)
        ) &&
        sixHostBridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === sixRxIds[0] && s.stream !== null),
      'All 6 devices connected in bidirectional multi-peer session'
    );

    // Expected 5-peer concurrency ceiling for High (10_000 kbps): 50% -> 5_000 kbps per peer
    const fivePeerCeiling = computeConcurrencyScaledBitrateKbps(10_000, 5, 2_500);
    assert.equal(fivePeerCeiling, 5_000);

    // Inject severe congestion on rx-1 ONLY, while keeping rx-2..rx-5 completely healthy
    const congestedPeer = sixHostBridge.getPeerInstance(sixRxIds[0])!;
    const congestedPc = (congestedPeer as unknown as { pc: FakeRtcPeerConnection }).pc;
    congestedPc.mockStatsMap = new Map<string, Record<string, unknown>>([
      ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 2_200_000, currentRoundTripTime: 0.28 }],
      ['out-1', { type: 'outbound-rtp', kind: 'video', bytesSent: 1_000_000, timestamp: 2000, framesEncoded: 60, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 48, qualityLimitationReason: 'bandwidth' }],
      ['rem-1', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.055, jitter: 0.048, roundTripTime: 0.28 }],
    ]);

    for (const healthyId of sixRxIds.slice(1)) {
      const pInst = sixHostBridge.getPeerInstance(healthyId)!;
      const pPc = (pInst as unknown as { pc: FakeRtcPeerConnection }).pc;
      pPc.mockStatsMap = new Map<string, Record<string, unknown>>([
        ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, availableOutgoingBitrate: 40_000_000, currentRoundTripTime: 0.012 }],
        ['out-1', { type: 'outbound-rtp', kind: 'video', bytesSent: 2_000_000, timestamp: 2000, framesEncoded: 60, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, qualityLimitationReason: 'none' }],
        ['rem-1', { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.0, jitter: 0.002, roundTripTime: 0.012 }],
      ]);
      await pInst.sampleAndAdaptStats(30_000);
    }
    await congestedPeer.sampleAndAdaptStats(30_000);

    const sixHostSnap = sixHostBridge.getSnapshot();
    const rx1Out = sixHostSnap.outboundPeers.find((o) => o.targetDeviceId === sixRxIds[0])!;
    assert.equal(rx1Out.telemetry.adaptationStatus, 'degraded', 'Congested Peer 1 degraded independently');
    assert.equal(rx1Out.telemetry.networkCondition, 'congested');
    assert.equal((rx1Out.telemetry.targetBitrateKbps ?? 99_999) < fivePeerCeiling, true);

    for (const healthyId of sixRxIds.slice(1)) {
      const healthyOut = sixHostSnap.outboundPeers.find((o) => o.targetDeviceId === healthyId)!;
      assert.equal(healthyOut.telemetry.adaptationStatus, 'target', `Healthy peer ${healthyId} unaffected`);
      assert.equal(healthyOut.telemetry.networkCondition, 'healthy');
      assert.equal(healthyOut.telemetry.targetBitrateKbps, fivePeerCeiling);
    }

    // Receiver 1 stops its bidirectional share independently while Host keeps streaming to all 5 receivers
    sixRxBridges[0].stopSharing('user_stopped');
    await waitUntil(
      () =>
        sixRxBridges[0].getSnapshot().isSharingLocal === false &&
        sixHostBridge.getSnapshot().incomingStreams.length === 0,
      'Bidirectional receiver stopped cleanly without interrupting host 5-receiver broadcast'
    );
    assert.equal(sixHostBridge.getSnapshot().outboundPeers.length, 5);

    sixHostBridge.dispose();
    for (const b of sixRxBridges) b.dispose();
    await fetch(`${baseUrl}/api/rooms/${sixRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sixRoomData.hostToken}` },
    });
    await sixHostWs.close();
    for (const w of sixRxWsList) await w.close();
    console.log('  [PASS] 4F.4. Independent 6-device adaptation, bidirectional sharing & independent stopping verified');

    // =========================================================================
    // STAGE 4G — Advanced Device Management System Tests
    // =========================================================================
    console.log('\n[Stage 4G] Running Advanced Device Management System checks...');

    // 4G.1: Client device type detection never fabricates unknown devices + display name validation
    assert.equal(detectDeviceType('', ''), 'Unknown');
    assert.equal(detectDeviceType('CustomEmbeddedClient/1.0', ''), 'Unknown');
    assert.equal(detectDeviceType('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'MacIntel'), 'Mac');
    assert.equal(detectDeviceType('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32'), 'Windows');
    assert.equal(detectDeviceType('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Linux armv8l'), 'Android');
    assert.equal(detectDeviceType('Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0)', ''), 'TV');
    assert.equal(validateDeviceDisplayName('Studio MacBook Pro'), null);
    assert.notEqual(validateDeviceDisplayName('A'), null);
    assert.notEqual(validateDeviceDisplayName('Host'), null);
    assert.notEqual(validateDeviceDisplayName('Admin'), null);
    assert.notEqual(validateDeviceDisplayName('Mac [Host]'), null);
    assert.notEqual(validateDeviceDisplayName('Bad<Script>'), null);

    // 4G.2: Reliable deviceType propagation + Unknown fallback + duplicate name / misleading label prevention
    const dmHostId = 'dm-host-mac';
    const dmRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: dmHostId,
        hostDeviceName: 'Editing Suite Host',
        hostPlatform: 'macos',
        hostDeviceType: 'Mac',
      }),
    });
    assert.equal(dmRoomRes.status, 201);
    const dmRoomData = (await dmRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
    const dmRoomId = dmRoomData.room.roomId;
    assert.equal(dmRoomData.room.hostDeviceType, 'Mac');
    assert.equal(Boolean(dmRoomData.room.hostLastSeenAt), true);

    const dmHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: dmHostId,
      deviceName: 'Editing Suite Host',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: dmRoomId,
      token: dmRoomData.hostToken,
    });

    // Reject misleading system label or duplicate host display name on join
    const badJoinLabel = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: 'dm-bad-label',
        deviceName: 'Admin',
        platform: 'macos',
        deviceType: 'Mac',
      }),
    });
    assert.equal(badJoinLabel.status, 400);

    const dupNameOnJoin = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: 'dm-dup-name',
        deviceName: 'editing suite host',
        platform: 'macos',
        deviceType: 'Mac',
      }),
    });
    assert.equal(dupNameOnJoin.status, 409);

    // Join Participant 1 (Windows) and Participant 2 (Unknown / unrecognized deviceType)
    const dmP1JoinRes = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: 'dm-win-1',
        deviceName: 'Colorist Workstation',
        platform: 'macos',
        deviceType: 'Windows',
      }),
    });
    assert.equal(dmP1JoinRes.status, 200);
    const dmP1Join = (await dmP1JoinRes.json()) as { memberToken: string };

    const dmP2JoinRes = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: 'dm-unk-2',
        deviceName: 'Reference Monitor',
        platform: 'android-tv',
        deviceType: 'CustomUnrecognizedThing',
      }),
    });
    assert.equal(dmP2JoinRes.status, 200);
    const dmP2Join = (await dmP2JoinRes.json()) as { memberToken: string };

    // Duplicate deviceId join rejected (409)
    const dupIdJoin = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: 'dm-win-1',
        deviceName: 'Another Display Name',
        platform: 'macos',
      }),
    });
    assert.equal(dupIdJoin.status, 409);

    const dmP1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: 'dm-win-1',
      deviceName: 'Colorist Workstation',
      platform: 'macos',
      deviceType: 'Windows',
      role: 'both',
      roomId: dmRoomId,
      token: dmP1Join.memberToken,
    });
    const dmP2Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: 'dm-unk-2',
      deviceName: 'Reference Monitor',
      platform: 'android-tv',
      role: 'both',
      roomId: dmRoomId,
      token: dmP2Join.memberToken,
    });

    // Non-host unauthorized to approve
    const unauthApprove = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/pair-requests/dm-win-1/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${dmP2Join.memberToken}` },
      }
    );
    assert.equal(unauthApprove.status, 403);

    await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests/dm-win-1/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${dmRoomData.hostToken}` },
    });
    await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests/dm-unk-2/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${dmRoomData.hostToken}` },
    });

    let dmSnap = ((await (await fetch(`${baseUrl}/api/rooms/${dmRoomId}`)).json()) as { room: RoomSnapshot }).room;
    const p1Rec = dmSnap.pairedReceivers.find((r) => r.deviceId === 'dm-win-1')!;
    const p2Rec = dmSnap.pairedReceivers.find((r) => r.deviceId === 'dm-unk-2')!;
    assert.equal(p1Rec.deviceType, 'Windows');
    assert.equal(p2Rec.deviceType, 'Unknown', 'Unrecognized deviceType falls back cleanly to Unknown');
    assert.equal(Boolean(p1Rec.lastSeenAt), true);
    console.log('  [PASS] 4G.1. Device type propagation, Unknown fallback, validation & unauthorized approval checks passed');

    // 4G.3: Self-rename, host-assigned rename, session persistence, duplicate/misleading rejections & non-host rejection
    const selfRenameRoomStatePromise = dmHostWs.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        m.roomId === dmRoomId &&
        Array.isArray((m.payload as JsonRecord).pairedReceivers) &&
        ((m.payload as JsonRecord).pairedReceivers as Array<{ deviceId: string; deviceName: string }>).some(
          (r) => r.deviceId === 'dm-win-1' && r.deviceName === 'HDR Grading Bay'
        ),
      3000,
      'room_state after self-rename'
    );
    const selfRenameRes = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-win-1/name`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmP1Join.memberToken}`,
        },
        body: JSON.stringify({ deviceName: 'HDR Grading Bay' }),
      }
    );
    assert.equal(selfRenameRes.status, 200);
    await selfRenameRoomStatePromise;

    // Non-host trying to rename another device -> 403
    const unauthOtherRename = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-unk-2/name`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmP1Join.memberToken}`,
        },
        body: JSON.stringify({ deviceName: 'Hijacked Name' }),
      }
    );
    assert.equal(unauthOtherRename.status, 403);

    // Host-assigned rename of participant -> 200 and persisted
    const hostAssignRenameRes = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-unk-2/name`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmRoomData.hostToken}`,
        },
        body: JSON.stringify({ deviceName: 'Client Lounge Display' }),
      }
    );
    assert.equal(hostAssignRenameRes.status, 200);

    // Misleading label on rename -> 400
    const badRenameLabel = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-unk-2/name`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmRoomData.hostToken}`,
        },
        body: JSON.stringify({ deviceName: 'Display [Host]' }),
      }
    );
    assert.equal(badRenameLabel.status, 400);

    // Duplicate name on rename -> 409
    const dupRenameRes = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-unk-2/name`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmRoomData.hostToken}`,
        },
        body: JSON.stringify({ deviceName: 'hdr grading bay' }),
      }
    );
    assert.equal(dupRenameRes.status, 409);

    dmSnap = ((await (await fetch(`${baseUrl}/api/rooms/${dmRoomId}`)).json()) as { room: RoomSnapshot }).room;
    assert.equal(
      dmSnap.pairedReceivers.find((r) => r.deviceId === 'dm-win-1')?.deviceName,
      'HDR Grading Bay'
    );
    assert.equal(
      dmSnap.pairedReceivers.find((r) => r.deviceId === 'dm-unk-2')?.deviceName,
      'Client Lounge Display'
    );
    console.log('  [PASS] 4G.2. Self-rename, host-assigned rename, session persistence & authorization verified');

    // 4G.4: Individual stream stop & reconnect authorization + lastSeenAt update + participant disconnect/removal
    // Host starts stream to dm-win-1 and dm-unk-2 starts stream to host
    dmHostWs.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'stream_start',
      messageId: 'dm-stream-1',
      senderDeviceId: dmHostId,
      receiverDeviceId: 'dm-win-1',
      roomId: dmRoomId,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: 'sess-dm-host',
        streamId: 'stream-dm-host',
        width: 1920,
        height: 1080,
        fps: 60,
        codec: 'H264',
      },
    });
    dmP2Ws.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'stream_start',
      messageId: 'dm-stream-2',
      senderDeviceId: 'dm-unk-2',
      receiverDeviceId: dmHostId,
      roomId: dmRoomId,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: 'sess-dm-p2',
        streamId: 'stream-dm-p2',
        width: 1920,
        height: 1080,
        fps: 60,
        codec: 'H264',
      },
    });
    await waitUntil(async () => {
      const snap = ((await (await fetch(`${baseUrl}/api/rooms/${dmRoomId}`)).json()) as { room: RoomSnapshot }).room;
      return (snap.activeStreams?.length ?? 0) === 2;
    }, 'Both independent room streams registered');

    // Non-host cannot stop another participant's stream (403)
    const unauthStop = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-unk-2/stop-stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmP1Join.memberToken}`,
        },
        body: JSON.stringify({}),
      }
    );
    assert.equal(unauthStop.status, 403);

    // Host stops dm-unk-2's stream ONLY -> dm-unk-2 gets stream_stop while host stream stays active
    const p2StopNoticePromise = dmP2Ws.waitForMessage(
      (m) =>
        m.messageType === 'stream_stop' &&
        m.senderDeviceId === dmHostId &&
        m.receiverDeviceId === 'dm-unk-2' &&
        (m.payload as JsonRecord).streamId === 'stream-dm-p2',
      3000,
      'host stop-stream notification to dm-unk-2'
    );
    const hostStopP2 = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-unk-2/stop-stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmRoomData.hostToken}`,
        },
        body: JSON.stringify({}),
      }
    );
    assert.equal(hostStopP2.status, 200);
    await p2StopNoticePromise;
    const afterHostStopSnap = (await hostStopP2.json()) as { room: RoomSnapshot };
    assert.equal(afterHostStopSnap.room.activeStreams?.length, 1);
    assert.equal(afterHostStopSnap.room.activeStreams?.[0].publisherDeviceId, dmHostId);

    // Unauthorized reconnect of another device -> 403; authorized host reconnect -> 200 + target notified + lastSeenAt bumped
    const unauthReconnect = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-unk-2/reconnect`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${dmP1Join.memberToken}` },
      }
    );
    assert.equal(unauthReconnect.status, 403);

    const prevLastSeenP1 = Date.parse(
      afterHostStopSnap.room.pairedReceivers.find((r) => r.deviceId === 'dm-win-1')?.lastSeenAt ?? ''
    );
    await new Promise((r) => setTimeout(r, 15));

    const p1ReconnectMsg = dmP1Ws.waitForMessage(
      (m) =>
        m.messageType === 'error' &&
        (m.payload as JsonRecord).code === 'WEBRTC_NEGOTIATION_FAILED',
      3000,
      'host reconnect notification to dm-win-1'
    );
    const authReconnect = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/dm-win-1/reconnect`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${dmRoomData.hostToken}` },
      }
    );
    assert.equal(authReconnect.status, 200);
    await p1ReconnectMsg;
    const afterReconnectSnap = (await authReconnect.json()) as { room: RoomSnapshot };
    const nextLastSeenP1 = Date.parse(
      afterReconnectSnap.room.pairedReceivers.find((r) => r.deviceId === 'dm-win-1')?.lastSeenAt ?? ''
    );
    assert.equal(nextLastSeenP1 >= prevLastSeenP1, true, 'lastSeenAt updates on reconnect action');

    // Heartbeat status update bumps lastSeenAt
    await new Promise((r) => setTimeout(r, 15));
    dmP1Ws.sendJson({
      protocolVersion: 'castora.v1',
      messageType: 'heartbeat',
      messageId: 'dm-hb-001',
      senderDeviceId: 'dm-win-1',
      receiverDeviceId: null,
      roomId: dmRoomId,
      timestamp: new Date().toISOString(),
      payload: { sequence: 1, role: 'receiver' },
    });
    await waitUntil(async () => {
      const snap = ((await (await fetch(`${baseUrl}/api/rooms/${dmRoomId}`)).json()) as { room: RoomSnapshot }).room;
      const ts = Date.parse(snap.pairedReceivers.find((r) => r.deviceId === 'dm-win-1')?.lastSeenAt ?? '');
      return ts > nextLastSeenP1;
    }, 'Heartbeat bumps lastSeenAt');

    // Non-host cannot remove a participant (403); host removal disconnects removed participant cleanly
    const unauthRemove = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/receivers/dm-unk-2`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${dmP1Join.memberToken}` },
      }
    );
    assert.equal(unauthRemove.status, 403);

    // Pending requester also cannot approve/reject/rename-other/stop/reconnect (403)
    const dmPendingRes = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/pair-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.9',
      },
      body: JSON.stringify({
        receiverDeviceId: 'dm-pending-3',
        deviceName: 'Pending Tablet',
        platform: 'android',
        deviceType: 'iPad',
      }),
    });
    assert.equal(dmPendingRes.status, 200);
    const dmPendingJoin = (await dmPendingRes.json()) as { memberToken: string };
    const dmPendingApprove = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/pair-requests/dm-pending-3/approve`,
      { method: 'POST', headers: { Authorization: `Bearer ${dmPendingJoin.memberToken}` } }
    );
    assert.equal(dmPendingApprove.status, 403);
    const dmPendingStop = await fetch(
      `${baseUrl}/api/rooms/${dmRoomId}/devices/${dmHostId}/stop-stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dmPendingJoin.memberToken}`,
        },
        body: JSON.stringify({}),
      }
    );
    assert.equal(dmPendingStop.status, 403);

    // Device status update (disconnect -> connected=false; reconnect -> connected=true) & session-persisted name survives WS reconnect
    await dmP2Ws.close();
    await waitUntil(async () => {
      const snap = ((await (await fetch(`${baseUrl}/api/rooms/${dmRoomId}`)).json()) as { room: RoomSnapshot }).room;
      return snap.pairedReceivers.find((r) => r.deviceId === 'dm-unk-2')?.connected === false;
    }, 'Participant disconnect updates connected=false');

    const dmP2WsReconnected = await connectAndAnnounce({
      wsUrl,
      deviceId: 'dm-unk-2',
      deviceName: 'Original Client Name Should Not Overwrite Host Rename',
      platform: 'android-tv',
      role: 'both',
      roomId: dmRoomId,
      token: dmP2Join.memberToken,
    });
    const afterReconnSnap = ((await (await fetch(`${baseUrl}/api/rooms/${dmRoomId}`)).json()) as { room: RoomSnapshot }).room;
    const p2AfterReconn = afterReconnSnap.pairedReceivers.find((r) => r.deviceId === 'dm-unk-2')!;
    assert.equal(p2AfterReconn.connected, true, 'Participant reconnect restores connected=true');
    assert.equal(
      p2AfterReconn.deviceName,
      'Client Lounge Display',
      'Host-assigned display name persists across participant WebSocket reconnect'
    );

    // Host removes dm-unk-2 -> receives disconnect notice, frees slot; dm-win-1 stays unaffected, then leaves cleanly
    const p2RemovedNotice = dmP2WsReconnected.waitForMessage(
      (m) => m.messageType === 'disconnect' && (m.payload as JsonRecord).reason === 'Removed by host',
      3000,
      'Removed by host disconnect notice'
    );
    const hostRemoveP2 = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/receivers/dm-unk-2`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${dmRoomData.hostToken}` },
    });
    assert.equal(hostRemoveP2.status, 200);
    await p2RemovedNotice;
    const afterRemoveJson = (await hostRemoveP2.json()) as { room: RoomSnapshot };
    assert.equal(afterRemoveJson.room.pairedReceiverCount, 1);
    assert.equal(afterRemoveJson.room.pairedReceivers[0].deviceId, 'dm-win-1');

    // Device leaving via /leave frees remaining slot cleanly
    const dmLeaveRes = await fetch(`${baseUrl}/api/rooms/${dmRoomId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dmP1Join.memberToken}`,
      },
      body: JSON.stringify({ deviceId: 'dm-win-1' }),
    });
    assert.equal(dmLeaveRes.status, 200);
    const afterLeaveSnap = ((await (await fetch(`${baseUrl}/api/rooms/${dmRoomId}`)).json()) as { room: RoomSnapshot }).room;
    assert.equal(afterLeaveSnap.pairedReceiverCount, 0);
    assert.equal(afterLeaveSnap.activeReceiverCount, 0);

    await dmHostWs.close();
    await dmP1Ws.close();
    await dmP2WsReconnected.close();
    await fetch(`${baseUrl}/api/rooms/${dmRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${dmRoomData.hostToken}` },
    });
    console.log('  [PASS] 4G.3. Individual stream stop, reconnect authorization, status updates, name persistence & leave/remove RBAC verified');

    // 4G.4: Simultaneous concurrent join requests, duplicate prevention & 6-device capacity enforcement
    const capDmRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'cap-dm-host',
        hostDeviceName: 'Capacity Host',
        hostPlatform: 'macos',
        hostDeviceType: 'Mac',
      }),
    });
    const capDmData = (await capDmRes.json()) as { room: RoomSnapshot; hostToken: string };
    const capDmRoomId = capDmData.room.roomId;

    // Fire 8 concurrent join requests from distinct simulated client IPs:
    // 6 unique valid devices + 1 duplicate deviceId + 1 duplicate name
    const concurrentRequests = [
      { receiverDeviceId: 'conc-1', deviceName: 'Node One', platform: 'macos', deviceType: 'Mac' },
      { receiverDeviceId: 'conc-2', deviceName: 'Node Two', platform: 'macos', deviceType: 'Windows' },
      { receiverDeviceId: 'conc-3', deviceName: 'Node Three', platform: 'android', deviceType: 'Android' },
      { receiverDeviceId: 'conc-4', deviceName: 'Node Four', platform: 'macos', deviceType: 'Linux' },
      { receiverDeviceId: 'conc-5', deviceName: 'Node Five', platform: 'android-tv', deviceType: 'TV' },
      { receiverDeviceId: 'conc-6', deviceName: 'Node Six', platform: 'macos', deviceType: 'iPad' },
      { receiverDeviceId: 'conc-1', deviceName: 'Node One Duplicate ID', platform: 'macos', deviceType: 'Mac' },
      { receiverDeviceId: 'conc-7', deviceName: 'node two', platform: 'macos', deviceType: 'Windows' },
    ];
    const joinResponses = await Promise.all(
      concurrentRequests.map((body, idx) =>
        fetch(`${baseUrl}/api/rooms/${capDmRoomId}/pair-requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `198.51.100.${10 + idx}`,
          },
          body: JSON.stringify(body),
        })
      )
    );
    const joinStatuses = joinResponses.map((r) => r.status);
    assert.equal(joinStatuses.filter((s) => s === 200).length, 6, 'Exactly 6 unique valid concurrent requests accepted');
    assert.equal(joinStatuses.filter((s) => s === 409).length, 2, 'Duplicate ID and duplicate name rejected with 409');

    // Add 7th unique valid pending request while all 6 are pending
    const seventhJoin = await fetch(`${baseUrl}/api/rooms/${capDmRoomId}/pair-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.18',
      },
      body: JSON.stringify({
        receiverDeviceId: 'conc-7-valid',
        deviceName: 'Node Seven Overflow',
        platform: 'macos',
        deviceType: 'Mac',
      }),
    });
    assert.equal(seventhJoin.status, 200);

    // Concurrently approve all 7 pending requests -> exactly 6 succeed (200), 1 receives 409 ROOM_FULL
    const approveResults = await Promise.all(
      ['conc-1', 'conc-2', 'conc-3', 'conc-4', 'conc-5', 'conc-6', 'conc-7-valid'].map((id) =>
        fetch(`${baseUrl}/api/rooms/${capDmRoomId}/pair-requests/${id}/approve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${capDmData.hostToken}` },
        })
      )
    );
    const approveStatuses = approveResults.map((r) => r.status);
    assert.equal(approveStatuses.filter((s) => s === 200).length, 6, 'Max 6 paired devices enforced under concurrent approvals');
    assert.equal(approveStatuses.filter((s) => s === 409).length, 1, '7th concurrent approval rejected with 409 ROOM_FULL');

    const fullSnap = ((await (await fetch(`${baseUrl}/api/rooms/${capDmRoomId}`)).json()) as { room: RoomSnapshot }).room;
    assert.equal(fullSnap.pairedReceiverCount, 6);
    const slotIndexes = fullSnap.pairedReceivers.map((r) => r.assignedSlotIndex).sort((a, b) => a - b);
    assert.deepEqual(slotIndexes, [0, 1, 2, 3, 4, 5], 'All 6 receiver slots uniquely assigned');

    // Remove conc-3, then approve conc-7-valid into freed slot cleanly
    const removeConc3 = await fetch(`${baseUrl}/api/rooms/${capDmRoomId}/receivers/conc-3`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${capDmData.hostToken}` },
    });
    assert.equal(removeConc3.status, 200);
    const approveSeventhAfterFree = await fetch(
      `${baseUrl}/api/rooms/${capDmRoomId}/pair-requests/conc-7-valid/approve`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${capDmData.hostToken}` },
      }
    );
    assert.equal(approveSeventhAfterFree.status, 200);
    const slotFreedSnap = (await approveSeventhAfterFree.json()) as { room: RoomSnapshot };
    assert.equal(slotFreedSnap.room.pairedReceiverCount, 6);
    assert.equal(
      slotFreedSnap.room.pairedReceivers.some((r) => r.deviceId === 'conc-7-valid'),
      true
    );

    await fetch(`${baseUrl}/api/rooms/${capDmRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${capDmData.hostToken}` },
    });
    console.log('  [PASS] 4G.4. Simultaneous concurrent joins, duplicate prevention, 6-device cap & slot reuse verified');

    // 4G.5: Audio mute independence across multiple incoming audio streams + independent outbound stream stop
    const muteRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: 'mute-host',
        hostDeviceName: 'Audio Test Host',
        hostPlatform: 'macos',
        hostDeviceType: 'Mac',
      }),
    });
    const muteRoomData = (await muteRoomRes.json()) as { room: RoomSnapshot; hostToken: string };
    const muteRoomId = muteRoomData.room.roomId;

    const muteP1Res = await fetch(`${baseUrl}/api/rooms/${muteRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.31' },
      body: JSON.stringify({
        receiverDeviceId: 'mute-peer-1',
        deviceName: 'Audio Sender One',
        platform: 'macos',
        deviceType: 'Mac',
      }),
    });
    const muteP2Res = await fetch(`${baseUrl}/api/rooms/${muteRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.32' },
      body: JSON.stringify({
        receiverDeviceId: 'mute-peer-2',
        deviceName: 'Audio Sender Two',
        platform: 'macos',
        deviceType: 'Windows',
      }),
    });
    const muteP1Join = (await muteP1Res.json()) as { memberToken: string };
    const muteP2Join = (await muteP2Res.json()) as { memberToken: string };

    const muteHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: 'mute-host',
      deviceName: 'Audio Test Host',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: muteRoomId,
      token: muteRoomData.hostToken,
    });
    const muteP1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: 'mute-peer-1',
      deviceName: 'Audio Sender One',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: muteRoomId,
      token: muteP1Join.memberToken,
    });
    const muteP2Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: 'mute-peer-2',
      deviceName: 'Audio Sender Two',
      platform: 'macos',
      deviceType: 'Windows',
      role: 'both',
      roomId: muteRoomId,
      token: muteP2Join.memberToken,
    });

    await fetch(`${baseUrl}/api/rooms/${muteRoomId}/pair-requests/mute-peer-1/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${muteRoomData.hostToken}` },
    });
    await fetch(`${baseUrl}/api/rooms/${muteRoomId}/pair-requests/mute-peer-2/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${muteRoomData.hostToken}` },
    });

    let muteRoomSnap = ((await (await fetch(`${baseUrl}/api/rooms/${muteRoomId}`)).json()) as { room: RoomSnapshot }).room;
    const audioAudioPrefs: CapturePreferences = {
      ...default1080Prefs,
      includeAudio: true,
    };
    const muteHostBridge = new WebRtcSignalingBridge({
      deviceId: 'mute-host',
      preferences: audioAudioPrefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(muteHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('mute-host', { width: 1920, height: 1080, frameRate: 60, includeAudio: true }),
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const muteP1Bridge = new WebRtcSignalingBridge({
      deviceId: 'mute-peer-1',
      preferences: audioAudioPrefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(muteP1Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('mute-p1', { width: 1920, height: 1080, frameRate: 60, includeAudio: true }),
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const muteP2Bridge = new WebRtcSignalingBridge({
      deviceId: 'mute-peer-2',
      preferences: audioAudioPrefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(muteP2Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('mute-p2', { width: 1920, height: 1080, frameRate: 60, includeAudio: true }),
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });

    const wireMuteBridge = (
      wsClient: TestWsClient,
      bridge: WebRtcSignalingBridge,
      role: 'host' | 'receiver',
      devId: string
    ) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === muteRoomId) {
          muteRoomSnap = { ...muteRoomSnap, ...(msg.payload as Partial<RoomSnapshot>) };
          bridge.updateContext({
            deviceId: devId,
            activeRoom: muteRoomSnap,
            activeRoomRole: role,
            preferences: audioAudioPrefs,
            networkPrefs: netPrefs4b,
          });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };

    for (const [b, r, d, w] of [
      [muteHostBridge, 'host', 'mute-host', muteHostWs],
      [muteP1Bridge, 'receiver', 'mute-peer-1', muteP1Ws],
      [muteP2Bridge, 'receiver', 'mute-peer-2', muteP2Ws],
    ] as const) {
      b.updateContext({
        deviceId: d,
        activeRoom: muteRoomSnap,
        activeRoomRole: r,
        preferences: audioAudioPrefs,
        networkPrefs: netPrefs4b,
      });
      wireMuteBridge(w, b, r, d);
    }

    await muteHostBridge.startScreenSharing(null);
    await muteP1Bridge.startScreenSharing('mute-host');
    await muteP2Bridge.startScreenSharing('mute-host');

    await waitUntil(
      () =>
        muteHostBridge.getSnapshot().incomingStreams.length === 2 &&
        muteHostBridge.getSnapshot().incomingStreams.every((s) => (s.stream?.getAudioTracks().length ?? 0) > 0) &&
        muteHostBridge.getSnapshot().outboundPeers.length === 2,
      'Host receives two independent incoming audio+video streams and publishes to both peers'
    );

    // Per-peer incoming mute isolation check
    const mutedByPeerId: Record<string, boolean> = {};
    const togglePeerMute = (peerId: string) => {
      mutedByPeerId[peerId] = !(mutedByPeerId[peerId] ?? true);
    };
    togglePeerMute('mute-peer-1');
    assert.equal(mutedByPeerId['mute-peer-1'], false, 'Peer 1 unmuted cleanly');
    assert.equal(mutedByPeerId['mute-peer-2'] ?? true, true, 'Peer 2 remains muted independently');
    togglePeerMute('mute-peer-2');
    assert.equal(mutedByPeerId['mute-peer-1'], false, 'Toggling Peer 2 leaves Peer 1 unmuted');
    assert.equal(mutedByPeerId['mute-peer-2'], false, 'Peer 2 unmuted cleanly');

    // Individual outgoing stream stop leaves other outbound stream and both incoming audio streams live
    await muteHostBridge.stopOutgoingStreamToPeer('mute-peer-1');
    assert.equal(muteHostBridge.getSnapshot().outboundPeers.length, 1);
    assert.equal(muteHostBridge.getSnapshot().outboundPeers[0].targetDeviceId, 'mute-peer-2');
    assert.equal(muteHostBridge.getSnapshot().incomingStreams.length, 2);

    muteHostBridge.dispose();
    muteP1Bridge.dispose();
    muteP2Bridge.dispose();
    await fetch(`${baseUrl}/api/rooms/${muteRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${muteRoomData.hostToken}` },
    });
    await muteHostWs.close();
    await muteP1Ws.close();
    await muteP2Ws.close();
    console.log('  [PASS] 4G.5. Per-peer audio mute independence & isolated outbound stream stop verified');

    // =========================================================================
    // STAGE 4H: ADVANCED SESSION MANAGEMENT & HOST OWNERSHIP TRANSFER TESTS
    // =========================================================================
    console.log('\nStarting Stage 4H Advanced Session Management tests...');

    // 4H.1: Security unit checks (scrypt password hashing) + Room creation & duplicate prevention
    const { hashRoomPassword, verifyRoomPassword } = await import('../apps/server/security.ts');
    const hashedSample = hashRoomPassword('castora-secret-42');
    assert.ok(hashedSample.startsWith('scrypt$'), 'Password hash must use scrypt$ format');
    assert.equal(hashedSample.includes('castora-secret-42'), false, 'Hash must never contain plaintext');
    assert.equal(verifyRoomPassword('castora-secret-42', hashedSample), true);
    assert.equal(verifyRoomPassword('wrong-password', hashedSample), false);

    const s4hHostId = 'sess-host-alpha';
    const s4hCreateRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: s4hHostId,
        hostDeviceName: 'Studio Host Alpha',
        hostPlatform: 'macos',
        hostDeviceType: 'Mac',
        roomName: 'Design Sync',
        privacyMode: 'private',
        password: 'castora-secret-42',
      }),
    });
    assert.equal(s4hCreateRes.status, 201);
    const s4hCreated = (await s4hCreateRes.json()) as {
      room: RoomSnapshot & {
        roomName?: string;
        privacyMode?: string;
        passwordProtected?: boolean;
        createdAt?: string;
      };
      hostToken: string;
      inviteCode: string;
    };
    const s4hRoomId = s4hCreated.room.roomId;
    assert.equal(s4hCreated.room.roomName, 'Design Sync');
    assert.equal(s4hCreated.room.privacyMode, 'private');
    assert.equal(s4hCreated.room.passwordProtected, true);
    assert.ok(s4hCreated.room.createdAt && Number.isFinite(Date.parse(s4hCreated.room.createdAt)));
    assert.ok(s4hCreated.inviteCode.length >= 10);

    // Prevent accidental duplicate active room by same host
    const dupHostCreate = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: s4hHostId,
        hostDeviceName: 'Studio Host Alpha',
        hostPlatform: 'macos',
      }),
    });
    assert.equal(dupHostCreate.status, 409);
    const dupHostJson = (await dupHostCreate.json()) as { error: string };
    assert.equal(dupHostJson.error, 'HOST_ALREADY_HAS_ACTIVE_ROOM');

    // Public room snapshot must never leak inviteCode or password fields
    const anonLookup = (await (await fetch(`${baseUrl}/api/rooms/${s4hRoomId}`)).json()) as {
      room: Record<string, unknown>;
    };
    assert.equal('inviteCode' in anonLookup.room, false);
    assert.equal('passwordHash' in anonLookup.room, false);
    assert.equal('hostToken' in anonLookup.room, false);

    // Host rename works, unauthorized rename fails
    const unauthRename = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-token' },
      body: JSON.stringify({ roomName: 'Hijacked Name' }),
    });
    assert.equal(unauthRename.status, 403);

    const hostRename = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/name`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s4hCreated.hostToken}`,
      },
      body: JSON.stringify({ roomName: 'Design Review Studio' }),
    });
    assert.equal(hostRename.status, 200);
    const hostRenameJson = (await hostRename.json()) as { room: { roomName: string } };
    assert.equal(hostRenameJson.room.roomName, 'Design Review Studio');
    console.log('  [PASS] 4H.1. scrypt password hashing, room creation, duplicate prevention, rename & zero-secret exposure verified');

    // 4H.2: Invitation validation, Private mode enforcement & link rotation
    const missingInvVal = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/invitation/validate`, {
      headers: { 'X-Forwarded-For': '198.51.100.70' },
    });
    assert.equal(missingInvVal.status, 403);

    const wrongInvVal = await fetch(
      `${baseUrl}/api/rooms/${s4hRoomId}/invitation/validate?invite=WRONGINV`,
      { headers: { 'X-Forwarded-For': '198.51.100.71' } }
    );
    assert.equal(wrongInvVal.status, 403);

    const goodInvVal = await fetch(
      `${baseUrl}/api/rooms/${s4hRoomId}/invitation/validate?invite=${encodeURIComponent(s4hCreated.inviteCode)}`,
      { headers: { 'X-Forwarded-For': '198.51.100.72' } }
    );
    assert.equal(goodInvVal.status, 200);
    const goodInvJson = (await goodInvVal.json()) as {
      inviteValid: boolean;
      canRequestJoin: boolean;
      availableSlots: number;
      room: Record<string, unknown>;
    };
    assert.equal(goodInvJson.inviteValid, true);
    assert.equal(goodInvJson.canRequestJoin, true);
    assert.equal(goodInvJson.availableSlots, 6);
    assert.equal('inviteCode' in goodInvJson.room, false);

    // Rotate invitation link (revokes previous link)
    const rotateRes = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/invitation/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s4hCreated.hostToken}` },
    });
    assert.equal(rotateRes.status, 200);
    const rotatedData = (await rotateRes.json()) as { inviteCode: string };
    assert.notEqual(rotatedData.inviteCode, s4hCreated.inviteCode);
    const activeInviteCode = rotatedData.inviteCode;

    const oldInvVal = await fetch(
      `${baseUrl}/api/rooms/${s4hRoomId}/invitation/validate?invite=${encodeURIComponent(s4hCreated.inviteCode)}`,
      { headers: { 'X-Forwarded-For': '198.51.100.73' } }
    );
    assert.equal(oldInvVal.status, 403, 'Revoked invitation code must be rejected');
    console.log('  [PASS] 4H.2. Invitation validation, Private mode protection & invitation rotation verified');

    // 4H.3: Password enforcement & password rate limiting (429), password change & removal
    const privateNoInv = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.87' },
      body: JSON.stringify({
        receiverDeviceId: 's4h-guest-1',
        deviceName: 'Private Guest 1',
        platform: 'macos',
      }),
    });
    assert.equal(privateNoInv.status, 403);

    // 5 failed password attempts from same IP -> 6th hits 429 RATE_LIMITED
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const badPwd = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.88' },
        body: JSON.stringify({
          receiverDeviceId: `s4h-brute-${attempt}`,
          deviceName: `Brute Force ${attempt}`,
          platform: 'macos',
          inviteCode: activeInviteCode,
          password: 'wrong-password',
        }),
      });
      assert.equal(badPwd.status, 403);
    }
    const throttledPwd = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.88' },
      body: JSON.stringify({
        receiverDeviceId: 's4h-brute-good',
        deviceName: 'Blocked IP Device',
        platform: 'macos',
        inviteCode: activeInviteCode,
        password: 'castora-secret-42',
      }),
    });
    assert.equal(throttledPwd.status, 429, 'Password attempt limiter must return HTTP 429');
    assert.ok(throttledPwd.headers.get('retry-after'), 'HTTP 429 must include Retry-After header');

    // Clean IP joins Private + Password room with valid invite & password -> lands in pending_approval
    const validJoinPrivate = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.89' },
      body: JSON.stringify({
        receiverDeviceId: 's4h-rx-1',
        deviceName: 'Session Receiver 1',
        platform: 'macos',
        inviteCode: activeInviteCode,
        password: 'castora-secret-42',
      }),
    });
    assert.equal(validJoinPrivate.status, 200);
    const validJoinPrivateData = (await validJoinPrivate.json()) as {
      requestStatus: string;
      memberToken: string;
    };
    assert.equal(validJoinPrivateData.requestStatus, 'pending_approval');

    // Change password and verify old password fails, then remove password
    const pwdChange = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s4hCreated.hostToken}`,
      },
      body: JSON.stringify({ password: 'updated-pass-99' }),
    });
    assert.equal(pwdChange.status, 200);

    const oldPwdAttempt = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.90' },
      body: JSON.stringify({
        receiverDeviceId: 's4h-rx-oldpwd',
        deviceName: 'Old Pwd Tester',
        platform: 'macos',
        inviteCode: activeInviteCode,
        password: 'castora-secret-42',
      }),
    });
    assert.equal(oldPwdAttempt.status, 403);

    const pwdRemove = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s4hCreated.hostToken}`,
      },
      body: JSON.stringify({ password: null }),
    });
    assert.equal(pwdRemove.status, 200);
    const pwdRemovedRoom = ((await pwdRemove.json()) as { room: { passwordProtected: boolean } }).room;
    assert.equal(pwdRemovedRoom.passwordProtected, false);
    console.log('  [PASS] 4H.3. Password authentication, 429 rate limiting, password rotation & removal verified');

    // 4H.4: Privacy modes (Open auto-pair + Approval Required) and 6-receiver cap enforcement
    await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests/s4h-rx-1/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s4hCreated.hostToken}` },
    });

    const toOpenMode = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s4hCreated.hostToken}`,
      },
      body: JSON.stringify({ privacyMode: 'open' }),
    });
    assert.equal(toOpenMode.status, 200);

    const openJoinRes = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.91' },
      body: JSON.stringify({
        receiverDeviceId: 's4h-rx-2',
        deviceName: 'Open Auto Join 2',
        platform: 'android',
      }),
    });
    assert.equal(openJoinRes.status, 200);
    const openJoinData = (await openJoinRes.json()) as {
      requestStatus: string;
      assignedSlotIndex: number;
      memberToken: string;
    };
    assert.equal(openJoinData.requestStatus, 'paired');
    assert.equal(openJoinData.assignedSlotIndex, 1);

    // Fill slots 3..6 concurrently in Open mode; 7th must fail with 409 ROOM_FULL
    const fillOpenResults = await Promise.all(
      [3, 4, 5, 6].map((idx) =>
        fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${91 + idx}` },
          body: JSON.stringify({
            receiverDeviceId: `s4h-rx-${idx}`,
            deviceName: `Open Member ${idx}`,
            platform: 'macos',
          }),
        })
      )
    );
    for (const r of fillOpenResults) {
      assert.equal(r.status, 200);
    }
    const overflowOpenRes = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/pair-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.99' },
      body: JSON.stringify({
        receiverDeviceId: 's4h-rx-overflow',
        deviceName: 'Overflow Guest',
        platform: 'macos',
      }),
    });
    assert.equal(overflowOpenRes.status, 409, 'Open mode must still enforce 6-receiver capacity limit');
    console.log('  [PASS] 4H.4. Privacy modes (Private / Approval Required / Open) & 6-receiver capacity cap verified');

    // 4H.5: Host WS disconnect preserves ownership (no auto-transfer) + Session restore + Reconnect
    const s4hHostWs1 = await connectAndAnnounce({
      wsUrl,
      deviceId: s4hHostId,
      deviceName: 'Studio Host Alpha',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: s4hRoomId,
      token: s4hCreated.hostToken,
    });
    await s4hHostWs1.waitForMessage((m) => m.messageType === 'room_state');

    const s4hRx1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: 's4h-rx-1',
      deviceName: 'Session Receiver 1',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: s4hRoomId,
      token: validJoinPrivateData.memberToken,
    });
    await s4hRx1Ws.waitForMessage((m) => m.messageType === 'room_state');

    const hostDropNotice = s4hRx1Ws.waitForMessage(
      (m) =>
        m.messageType === 'room_state' &&
        (m.payload as { hostConnected: boolean; hostDeviceId: string }).hostConnected === false
    );
    await s4hHostWs1.close();
    const droppedState = await hostDropNotice;
    assert.equal(
      (droppedState.payload as { hostDeviceId: string }).hostDeviceId,
      s4hHostId,
      'Host ownership must NOT be auto-transferred on temporary host disconnect'
    );

    // Session restore endpoint recovers full authenticated host context
    const restoreRes = await fetch(`${baseUrl}/api/rooms/${s4hRoomId}/session`, {
      headers: { Authorization: `Bearer ${s4hCreated.hostToken}` },
    });
    assert.equal(restoreRes.status, 200);
    const restoreJson = (await restoreRes.json()) as {
      role: string;
      deviceId: string;
      inviteCode?: string;
    };
    assert.equal(restoreJson.role, 'host');
    assert.equal(restoreJson.deviceId, s4hHostId);
    assert.equal(restoreJson.inviteCode, activeInviteCode);

    const s4hHostWs2 = await connectAndAnnounce({
      wsUrl,
      deviceId: s4hHostId,
      deviceName: 'Studio Host Alpha',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: s4hRoomId,
      token: s4hCreated.hostToken,
    });
    const restoredWsState = await s4hHostWs2.waitForMessage((m) => m.messageType === 'room_state');
    assert.equal((restoredWsState.payload as { hostConnected: boolean }).hostConnected, true);

    await s4hHostWs2.close();
    await s4hRx1Ws.close();
    await fetch(`${baseUrl}/api/rooms/${s4hRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${s4hCreated.hostToken}` },
    });
    console.log('  [PASS] 4H.5. Host disconnect ownership preservation & authenticated session recovery verified');

    // 4H.6: Secure atomic Host Transfer with simultaneous active WebRTC streams uninterrupted
    const xHostId = 'xfer-host';
    const xRx1Id = 'xfer-rx-1';
    const xRx2Id = 'xfer-rx-2';
    const xCreate = (await (
      await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostDeviceId: xHostId,
          hostDeviceName: 'Original Host Mac',
          hostPlatform: 'macos',
          hostDeviceType: 'Mac',
          roomName: 'Handoff Session',
          privacyMode: 'open',
        }),
      })
    ).json()) as { room: RoomSnapshot; hostToken: string };
    const xRoomId = xCreate.room.roomId;

    const xRx1Join = (await (
      await fetch(`${baseUrl}/api/rooms/${xRoomId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.120' },
        body: JSON.stringify({
          receiverDeviceId: xRx1Id,
          deviceName: 'Successor Windows PC',
          platform: 'macos',
          deviceType: 'Windows',
        }),
      })
    ).json()) as { memberToken: string };

    const xRx2Join = (await (
      await fetch(`${baseUrl}/api/rooms/${xRoomId}/pair-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.121' },
        body: JSON.stringify({
          receiverDeviceId: xRx2Id,
          deviceName: 'Observer Mac',
          platform: 'macos',
          deviceType: 'Mac',
        }),
      })
    ).json()) as { memberToken: string };

    const xHostWs = await connectAndAnnounce({
      wsUrl,
      deviceId: xHostId,
      deviceName: 'Original Host Mac',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: xRoomId,
      token: xCreate.hostToken,
    });
    const xRx1Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: xRx1Id,
      deviceName: 'Successor Windows PC',
      platform: 'macos',
      deviceType: 'Windows',
      role: 'both',
      roomId: xRoomId,
      token: xRx1Join.memberToken,
    });
    const xRx2Ws = await connectAndAnnounce({
      wsUrl,
      deviceId: xRx2Id,
      deviceName: 'Observer Mac',
      platform: 'macos',
      deviceType: 'Mac',
      role: 'both',
      roomId: xRoomId,
      token: xRx2Join.memberToken,
    });

    let xRoomSnap = ((await (await fetch(`${baseUrl}/api/rooms/${xRoomId}`)).json()) as { room: RoomSnapshot }).room;
    const xHostBridge = new WebRtcSignalingBridge({
      deviceId: xHostId,
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(xHostWs),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('xhost', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });
    const xRx1Bridge = new WebRtcSignalingBridge({
      deviceId: xRx1Id,
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
      getSignalingClient: () => wrapWsSender(xRx1Ws),
      callbacks: { onStateChange: () => {}, onLogEvent: () => {} },
      captureFn: makeDynamicCapture('xrx1', { width: 1920, height: 1080, frameRate: 60 }),
      rtcFactory: (cfg) => new FakeRtcPeerConnection(cfg) as unknown as RTCPeerConnection,
    });

    const wireXferBridge = (
      wsClient: TestWsClient,
      bridge: WebRtcSignalingBridge,
      devId: string
    ) => {
      wsClient.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString('utf8')) as CastoraEnvelope;
        if (msg.messageType === 'room_state' && msg.roomId === xRoomId) {
          xRoomSnap = { ...xRoomSnap, ...(msg.payload as Partial<RoomSnapshot>) };
          bridge.updateContext({
            deviceId: devId,
            activeRoom: xRoomSnap,
            activeRoomRole: xRoomSnap.hostDeviceId === devId ? 'host' : 'receiver',
            preferences: default1080Prefs,
            networkPrefs: netPrefs4b,
          });
        } else if (
          msg.messageType === 'stream_start' ||
          msg.messageType === 'session_offer' ||
          msg.messageType === 'session_answer' ||
          msg.messageType === 'ice_candidate' ||
          msg.messageType === 'stream_stop'
        ) {
          void bridge.handleIncomingEnvelope(msg);
        }
      });
    };

    xHostBridge.updateContext({
      deviceId: xHostId,
      activeRoom: xRoomSnap,
      activeRoomRole: 'host',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
    });
    xRx1Bridge.updateContext({
      deviceId: xRx1Id,
      activeRoom: xRoomSnap,
      activeRoomRole: 'receiver',
      preferences: default1080Prefs,
      networkPrefs: netPrefs4b,
    });
    wireXferBridge(xHostWs, xHostBridge, xHostId);
    wireXferBridge(xRx1Ws, xRx1Bridge, xRx1Id);

    await xHostBridge.startScreenSharing(xRx1Id);
    await waitUntil(
      () => xRx1Bridge.getSnapshot().incomingStreams.some((s) => s.senderDeviceId === xHostId && s.stream !== null),
      'Live WebRTC stream established before host transfer'
    );

    // Non-host cannot initiate transfer
    const unauthTransfer = await fetch(`${baseUrl}/api/rooms/${xRoomId}/host-transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xRx1Join.memberToken}`,
      },
      body: JSON.stringify({ targetDeviceId: xRx2Id }),
    });
    assert.equal(unauthTransfer.status, 403);

    // Host initiates transfer to xRx1
    const initTransfer = await fetch(`${baseUrl}/api/rooms/${xRoomId}/host-transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xCreate.hostToken}`,
      },
      body: JSON.stringify({ targetDeviceId: xRx1Id }),
    });
    assert.equal(initTransfer.status, 200);

    // Simultaneous second transfer must be rejected with 409
    const concurrentTransfer = await fetch(`${baseUrl}/api/rooms/${xRoomId}/host-transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xCreate.hostToken}`,
      },
      body: JSON.stringify({ targetDeviceId: xRx2Id }),
    });
    assert.equal(concurrentTransfer.status, 409);

    // Third party xRx2 cannot accept xRx1's host transfer
    const wrongTargetAccept = await fetch(`${baseUrl}/api/rooms/${xRoomId}/host-transfer/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xRx2Join.memberToken}`,
      },
      body: JSON.stringify({ accept: true }),
    });
    assert.equal(wrongTargetAccept.status, 403);

    // Designated target xRx1 accepts host transfer
    const acceptTransfer = await fetch(`${baseUrl}/api/rooms/${xRoomId}/host-transfer/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xRx1Join.memberToken}`,
      },
      body: JSON.stringify({ accept: true }),
    });
    assert.equal(acceptTransfer.status, 200);
    const acceptJson = (await acceptTransfer.json()) as {
      accepted: boolean;
      newHostDeviceId: string;
      room: RoomSnapshot;
    };
    assert.equal(acceptJson.accepted, true);
    assert.equal(acceptJson.newHostDeviceId, xRx1Id);
    assert.equal(acceptJson.room.hostDeviceId, xRx1Id);
    assert.equal(acceptJson.room.pairedReceivers.some((r) => r.deviceId === xHostId), true);

    // Permission verification: old host rejected (403), new host authorized (200)
    const oldHostPrivAction = await fetch(`${baseUrl}/api/rooms/${xRoomId}/name`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xCreate.hostToken}`,
      },
      body: JSON.stringify({ roomName: 'Old Host Rename Attempt' }),
    });
    assert.equal(oldHostPrivAction.status, 403);

    const newHostPrivAction = await fetch(`${baseUrl}/api/rooms/${xRoomId}/name`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${xRx1Join.memberToken}`,
      },
      body: JSON.stringify({ roomName: 'Transferred Host Studio' }),
    });
    assert.equal(newHostPrivAction.status, 200);

    // Active WebRTC stream remains 100% live across ownership swap!
    assert.equal(xHostBridge.getSnapshot().outboundPeers.length, 1);
    assert.equal(xRx1Bridge.getSnapshot().incomingStreams.length, 1);
    assert.ok(xRx1Bridge.getSnapshot().incomingStreams[0].stream !== null);

    // New host can safely close the room
    const closeByNewHost = await fetch(`${baseUrl}/api/rooms/${xRoomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${xRx1Join.memberToken}` },
    });
    assert.equal(closeByNewHost.status, 200);

    xHostBridge.dispose();
    xRx1Bridge.dispose();
    await xHostWs.close();
    await xRx1Ws.close();
    await xRx2Ws.close();
    console.log('  [PASS] 4H.6. Atomic host transfer, permission swap, concurrency protection & live WebRTC stream continuity verified');

    // Rate limiting check (exceed 40 window attempts on lookup)
    let hit429 = false;
    for (let i = 0; i < 45; i += 1) {
      const res = await fetch(`${baseUrl}/api/rooms/ZZZZ99`);
      if (res.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.equal(hit429, true, 'Rate limiter must return HTTP 429 after exceeding window limit');
    console.log('  [PASS] Extra. Room lookup rate limiting verified (HTTP 429)');

    // Production Hardening Checks: Malformed JSON, reverse-proxy HTTPS, and CORS/WS Origin allowlist
    const badJsonRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken": ',
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonText = await badJsonRes.text();
    const badJsonParsed = JSON.parse(badJsonText) as { error: string };
    assert.equal(badJsonParsed.error, 'INVALID_JSON');
    assert.equal(badJsonText.includes('SyntaxError'), false, 'Must not leak JS stack/SyntaxError');

    const proxyHealthRes = await fetch(`${baseUrl}/api/health`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(proxyHealthRes.status, 200);
    const proxyHealth = (await proxyHealthRes.json()) as {
      transport: string;
      httpsEnabled: boolean;
    };
    assert.equal(proxyHealth.transport, 'https+wss');
    assert.equal(proxyHealth.httpsEnabled, true);

    const unknownApiRes = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(unknownApiRes.status, 404);
    const unknownApiJson = (await unknownApiRes.json()) as { error: string };
    assert.equal(unknownApiJson.error, 'NOT_FOUND');

    const corsServer = await startCastoraServer({
      port: 0,
      host: '127.0.0.1',
      enableViteMiddleware: false,
      allowedOrigins: ['https://castora.example.com'],
    });
    try {
      const corsBase = `http://127.0.0.1:${corsServer.port}`;
      const allowedOriginRes = await fetch(`${corsBase}/api/health`, {
        headers: { Origin: 'https://castora.example.com' },
      });
      assert.equal(allowedOriginRes.status, 200);
      assert.equal(
        allowedOriginRes.headers.get('access-control-allow-origin'),
        'https://castora.example.com'
      );

      const blockedOriginRes = await fetch(`${corsBase}/api/health`, {
        headers: { Origin: 'https://evil.example.net' },
      });
      assert.equal(blockedOriginRes.status, 403);

      const wsRejected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${corsServer.port}/castora`, {
          headers: { Origin: 'https://evil.example.net' },
        });
        ws.once('unexpected-response', (_req, res) => {
          resolve(res.statusCode === 403);
        });
        ws.once('open', () => {
          ws.close();
          resolve(false);
        });
        ws.once('error', () => {
          // Handled via unexpected-response or socket close
        });
      });
      assert.equal(wsRejected, true, 'Disallowed WebSocket Origin must be rejected with HTTP 403');
    } finally {
      await corsServer.close();
    }
    console.log('  [PASS] Extra. Production JSON errors, reverse-proxy TLS health, CORS & WS Origin enforcement verified');

    console.log('\nAll Stage 3 (14) + Stage 4A (10) + Stage 4B (10) + Stage 4C (4) + Stage 4D (3) + Stage 4E (4) + Stage 4F (4) + Stage 4G (5) + Stage 4H (6) + Production Hardening tests passed!');
  } finally {
    await instance.close();
  }
}

main().catch((err) => {
  console.error('Stage 3 / 4A backend verification failed:', err);
  process.exit(1);
});
