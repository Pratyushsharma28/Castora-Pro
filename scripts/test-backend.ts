import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startCastoraServer } from '../server.ts';

function readFixture(relPath: string): Record<string, unknown> {
  const full = path.resolve(process.cwd(), 'protocol', 'fixtures', relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
  });
}

async function main() {
  console.log('Starting Stage 2 backend verification suite...');
  const instance = await startCastoraServer({
    port: 0,
    host: '127.0.0.1',
    enableViteMiddleware: false,
    roomTtlMs: 15_000,
    rateLimitMaxAttempts: 5,
    rateLimitWindowMs: 10_000,
  });

  const baseUrl = `http://127.0.0.1:${instance.port}`;
  const wsUrl = `ws://127.0.0.1:${instance.port}/castora`;

  try {
    // 1 & 2. Health endpoint
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200, '/api/health must return HTTP 200');
    const healthJson = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.protocolVersion, 'castora.v1');
    assert.equal(healthJson.wsPath, '/castora');
    assert.equal(healthJson.activeDevices, 0);
    assert.equal(healthJson.activeRooms, 0);
    console.log('  [PASS] 1-2. Server started & GET /api/health returned HTTP 200');

    // 3. WebSocket connect + valid protocol messages
    const hostWs = new WebSocket(wsUrl);
    await waitForOpen(hostWs);

    const announceFixture = readFixture('valid/01-device-announce.json');
    const hostId = String(announceFixture.senderDeviceId);
    const ackPromise = nextMessage(hostWs);
    hostWs.send(JSON.stringify(announceFixture));
    const ack = await ackPromise;
    assert.equal(ack.protocolVersion, 'castora.v1');
    assert.equal(ack.messageType, 'device_announce');
    assert.equal(ack.receiverDeviceId, hostId);

    const heartbeatFixture = readFixture('valid/16-heartbeat.json');
    heartbeatFixture.senderDeviceId = hostId;
    const hbAckPromise = nextMessage(hostWs);
    hostWs.send(JSON.stringify(heartbeatFixture));
    const hbAck = await hbAckPromise;
    assert.equal(hbAck.messageType, 'heartbeat');
    console.log('  [PASS] 3-4. WebSocket /castora connected & valid castora.v1 messages accepted');

    // 5. Invalid messages rejected cleanly (malformed JSON, binary, invalid version, invalid schema)
    const malformedPromise = nextMessage(hostWs);
    hostWs.send('{not-valid-json');
    const malformedErr = await malformedPromise;
    assert.equal(malformedErr.messageType, 'error');
    assert.equal((malformedErr.payload as { code: string }).code, 'INVALID_MESSAGE');

    const binaryPromise = nextMessage(hostWs);
    hostWs.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const binaryErr = await binaryPromise;
    assert.equal(binaryErr.messageType, 'error');
    assert.equal((binaryErr.payload as { code: string }).code, 'INVALID_MESSAGE');

    const badVersionFixture = readFixture('invalid/invalid-unsupported-version.json');
    badVersionFixture.senderDeviceId = hostId;
    const versionPromise = nextMessage(hostWs);
    hostWs.send(JSON.stringify(badVersionFixture));
    const versionErr = await versionPromise;
    assert.equal(versionErr.messageType, 'error');
    assert.equal((versionErr.payload as { code: string }).code, 'UNSUPPORTED_VERSION');

    const badTypeFixture = readFixture('invalid/invalid-unknown-message-type.json');
    badTypeFixture.senderDeviceId = hostId;
    const badTypePromise = nextMessage(hostWs);
    hostWs.send(JSON.stringify(badTypeFixture));
    const badTypeErr = await badTypePromise;
    assert.equal(badTypeErr.messageType, 'error');
    assert.equal((badTypeErr.payload as { code: string }).code, 'INVALID_MESSAGE');
    console.log('  [PASS] 5. Invalid JSON, binary frames, and invalid protocol messages rejected');

    // 6. Room creation, room joining, discovery, and disconnect cleanup
    const createRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: hostId,
        hostDeviceName: 'MacBook Pro Sender',
        hostPlatform: 'macos',
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      room: { roomId: string; activeReceiverCount: number };
      hostToken: string;
    };
    assert.match(created.room.roomId, /^[A-Z0-9]{6}$/);
    assert.ok(created.hostToken.length >= 32);

    const receiverId = 'android-pixel-test-01';
    const joinRes = await fetch(`${baseUrl}/api/rooms/${created.room.roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receiverDeviceId: receiverId,
        deviceName: 'Pixel 9 Pro',
        platform: 'android',
      }),
    });
    assert.equal(joinRes.status, 200);
    const joined = (await joinRes.json()) as {
      room: { roomId: string; activeReceiverCount: number };
      memberToken: string;
      assignedSlotIndex: number;
    };
    assert.equal(joined.assignedSlotIndex, 0);
    assert.ok(joined.memberToken.length >= 32);

    // Connect receiver WS with token bound to room
    const receiverWs = new WebSocket(`${wsUrl}?token=${encodeURIComponent(joined.memberToken)}`);
    await waitForOpen(receiverWs);
    const rxAckPromise = nextMessage(receiverWs);
    receiverWs.send(
      JSON.stringify({
        protocolVersion: 'castora.v1',
        messageType: 'device_announce',
        messageId: 'rx-announce-0001',
        senderDeviceId: receiverId,
        receiverDeviceId: null,
        roomId: created.room.roomId,
        timestamp: new Date().toISOString(),
        payload: {
          deviceName: 'Pixel 9 Pro',
          platform: 'android',
          role: 'receiver',
          wsPort: 3000,
          capabilities: {
            maxWidth: 1920,
            maxHeight: 1080,
            maxFps: 60,
            codecs: ['H264', 'VP9'],
            supportsAudio: true,
          },
        },
      })
    );
    await rxAckPromise;

    const healthWithPeersRes = await fetch(`${baseUrl}/api/health`);
    const healthWithPeers = (await healthWithPeersRes.json()) as {
      activeDevices: number;
      activeRooms: number;
    };
    assert.equal(healthWithPeers.activeDevices, 2);
    assert.equal(healthWithPeers.activeRooms, 1);
    console.log('  [PASS] 6. Room creation, room joining, and live WS binding verified');

    // Disconnect cleanup check
    const hostDisconnectNotice = nextMessage(hostWs);
    receiverWs.close();
    await waitForClose(receiverWs);
    const disconnectMsg = await hostDisconnectNotice;
    assert.equal(disconnectMsg.messageType, 'disconnect');

    await new Promise((r) => setTimeout(r, 50));
    const afterDisconnectRes = await fetch(`${baseUrl}/api/health`);
    const afterDisconnect = (await afterDisconnectRes.json()) as { activeDevices: number };
    assert.equal(afterDisconnect.activeDevices, 1, 'Disconnected receiver must be removed');
    console.log('  [PASS] 7. Disconnect cleanup decremented activeDevices & notified peer');

    // Room expiry check (short-lived 250ms TTL room)
    const expiringRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostDeviceId: hostId,
        hostDeviceName: 'Expiring Room Host',
        hostPlatform: 'macos',
        ttlMs: 250,
      }),
    });
    assert.equal(expiringRes.status, 201);
    const expiring = (await expiringRes.json()) as { room: { roomId: string } };
    await new Promise((r) => setTimeout(r, 320));
    const expiredLookup = await fetch(`${baseUrl}/api/rooms/${expiring.room.roomId}`);
    assert.equal(expiredLookup.status, 410, 'Expired room must return HTTP 410 Gone');
    console.log('  [PASS] 8. Room expiry verified (HTTP 410 after TTL)');

    // Rate limiting check (4 remaining attempts after 1 lookup above -> 6th attempt must 429)
    let hit429 = false;
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${baseUrl}/api/rooms/ZZZZ99`);
      if (res.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.equal(hit429, true, 'Rate limiter must return HTTP 429 after exceeding limit');
    console.log('  [PASS] 9. Room lookup rate limiting verified (HTTP 429)');

    hostWs.close();
    await waitForClose(hostWs);
    console.log('\nAll Stage 2 backend tests passed!');
  } finally {
    await instance.close();
  }
}

main().catch((err) => {
  console.error('Stage 2 backend verification failed:', err);
  process.exit(1);
});
