import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
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
    rateLimitMaxAttempts: 20,
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

    // Rate limiting check
    let hit429 = false;
    for (let i = 0; i < 25; i += 1) {
      const res = await fetch(`${baseUrl}/api/rooms/ZZZZ99`);
      if (res.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.equal(hit429, true, 'Rate limiter must return HTTP 429 after exceeding window limit');
    console.log('  [PASS] Extra. Room lookup rate limiting verified (HTTP 429)');

    console.log('\nAll 14 Stage 3 backend & multi-client pairing scenarios passed!');
  } finally {
    await instance.close();
  }
}

main().catch((err) => {
  console.error('Stage 3 backend verification failed:', err);
  process.exit(1);
});
