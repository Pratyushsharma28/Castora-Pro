import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { RoomSnapshot } from '../apps/web/src/services/backendClient.ts';
import {
  ScreenCaptureError,
  buildDisplayMediaConstraints,
  startScreenCapture,
} from '../apps/web/src/services/screenCaptureService.ts';
import {
  VIDEO_QUALITY_PRESETS,
  computeConcurrencyScaledBitrateKbps,
  orderVideoCodecsForPreference,
  resolveQualityTarget,
} from '../apps/web/src/services/videoQualityService.ts';
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
  role: 'sender' | 'receiver' | 'both';
  roomId: string | null;
  token?: string;
}): Promise<TestWsClient> {
  const url = params.token
    ? `${params.wsUrl}?token=${encodeURIComponent(params.token)}`
    : params.wsUrl;
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

      constructor() {
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

      getTransceivers() {
        return this.transceivers;
      }

      async createOffer() {
        const activeSending = this.transceivers.some(
          (t) =>
            t.sender.track !== null &&
            (t.direction === 'sendonly' || t.direction === 'sendrecv')
        );
        return {
          type: 'offer' as const,
          sdp: `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=${activeSending ? 'sendrecv' : 'recvonly'}\r\n`,
        };
      }

      async createAnswer() {
        const activeSending = this.transceivers.some(
          (t) =>
            t.sender.track !== null &&
            (t.direction === 'sendonly' || t.direction === 'sendrecv')
        );
        return {
          type: 'answer' as const,
          sdp: `v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=${activeSending ? 'sendrecv' : 'recvonly'}\r\n`,
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
        if (desc.type === 'offer') {
          this.signalingState = 'have-remote-offer';
          const remoteSending = Boolean(desc.sdp?.includes('a=sendrecv'));
          if (remoteSending) {
            if (!this.deliveredRemoteStream) {
              this.deliveredRemoteStream = new FakeMediaStream(
                `remote-${Math.random().toString(36).slice(2, 8)}`
              );
              const track = this.deliveredRemoteStream.getVideoTracks()[0];
              this.ontrack?.({ track, streams: [this.deliveredRemoteStream] });
            } else {
              const track = this.deliveredRemoteStream.getVideoTracks()[0];
              if (track.muted) {
                track.muted = false;
                track.dispatchEventName('unmute');
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

    const waitUntil = async (fn: () => boolean, label: string, timeoutMs = 4000) => {
      const start = Date.now();
      while (!fn()) {
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

    console.log('\nAll Stage 3 (14) + Stage 4A (10) + Stage 4B (10) + Stage 4C (4) backend, WebRTC quality, ABR & multi-peer tests passed!');
  } finally {
    await instance.close();
  }
}

main().catch((err) => {
  console.error('Stage 3 / 4A backend verification failed:', err);
  process.exit(1);
});
