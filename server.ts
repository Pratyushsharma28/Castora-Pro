import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { buildIceConfigForDevice, getIceConfigStatus } from './apps/server/iceConfig.ts';
import { createServerEnvelope } from './apps/server/protocolValidator.ts';
import { RoomManager, toRoomStatePayload } from './apps/server/roomManager.ts';
import { SlidingWindowRateLimiter } from './apps/server/security.ts';
import {
  attachSignalingGateway,
  broadcastRoomState,
  emitTerminatedStreams,
  sendJson,
} from './apps/server/signalingGateway.ts';
import type {
  BackendHealthStatus,
  CastoraPlatform,
  PairingMethod,
} from './apps/server/types.ts';

dotenv.config();

const DEFAULT_PORT = Number(process.env.PORT ?? 3000) || 3000;
const EXPIRY_SWEEP_INTERVAL_MS = 2_000;
const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;
const DEVICE_ID_REGEX = /^[A-Za-z0-9._-]{3,64}$/;
const ALLOWED_PLATFORMS = new Set<CastoraPlatform>(['macos', 'android', 'android-tv']);
const ALLOWED_PAIRING_METHODS = new Set<PairingMethod>(['qr', 'room_code', 'manual_ip']);

export interface CastoraServerOptions {
  port?: number;
  host?: string;
  enableViteMiddleware?: boolean;
  roomTtlMs?: number;
  rateLimitMaxAttempts?: number;
  rateLimitWindowMs?: number;
}

function resolveTlsCredentials(): { cert: Buffer; key: Buffer } | null {
  const cwd = process.cwd();
  const certEnv = process.env.CASTORA_TLS_CERT?.trim();
  const keyEnv = process.env.CASTORA_TLS_KEY?.trim();

  const certPath = certEnv
    ? path.resolve(cwd, certEnv)
    : path.resolve(cwd, '.certs', 'castora-lan.pem');
  const keyPath = keyEnv
    ? path.resolve(cwd, keyEnv)
    : path.resolve(cwd, '.certs', 'castora-lan-key.pem');

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    return null;
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function extractBearerToken(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function mapRoomErrorStatus(code?: string): number {
  switch (code) {
    case 'INVALID_ROOM_ID':
    case 'INVALID_DEVICE_NAME':
      return 400;
    case 'UNAUTHORIZED':
      return 403;
    case 'ROOM_NOT_FOUND':
    case 'REQUEST_NOT_FOUND':
    case 'RECEIVER_NOT_FOUND':
    case 'STREAM_NOT_FOUND':
      return 404;
    case 'ROOM_FULL':
    case 'ALREADY_PAIRED':
    case 'DUPLICATE_PAIR_REQUEST':
    case 'DUPLICATE_DEVICE_NAME':
      return 409;
    case 'ROOM_EXPIRED':
      return 410;
    default:
      return 400;
  }
}

export async function startCastoraServer(options: CastoraServerOptions = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '0.0.0.0';
  const isProd = process.env.NODE_ENV === 'production';
  const useVite = options.enableViteMiddleware ?? !isProd;

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const tlsCredentials = resolveTlsCredentials();
  const httpsEnabled = Boolean(tlsCredentials);

  const server = tlsCredentials
    ? https.createServer(tlsCredentials, app)
    : http.createServer(app);

  const roomManager = new RoomManager(options.roomTtlMs);
  const roomRateLimiter = new SlidingWindowRateLimiter(
    options.rateLimitMaxAttempts ?? 10,
    options.rateLimitWindowMs ?? 60_000
  );

  const iceRateLimiter = new SlidingWindowRateLimiter(30, 60_000);

  const gateway = attachSignalingGateway({
    server,
    roomManager,
    roomRateLimiter,
    wsPort: port,
  });

  // --- REST API Routes ---
  app.get('/api/health', (_req: Request, res: Response) => {
    const stats = roomManager.getStats();
    const iceStatus = getIceConfigStatus();
    const body: BackendHealthStatus = {
      status: 'ok',
      service: 'castora-pro-signaling',
      protocolVersion: 'castora.v1',
      transport: httpsEnabled ? 'https+wss' : 'http+ws',
      httpsEnabled,
      wsPath: '/castora',
      uptimeSec: Math.round(process.uptime()),
      activeDevices: stats.activeDevices,
      activeRooms: stats.activeRooms,
      maxReceiversPerRoom: stats.maxReceiversPerRoom,
      turnConfigured: iceStatus.turnConfigured,
      turnMode: iceStatus.turnMode,
      timestamp: new Date().toISOString(),
    };
    res.status(200).json(body);
  });

  app.get('/api/ice-servers', (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    const rate = iceRateLimiter.consume(`http-ice:${clientIp}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000).toString());
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many ICE server configuration requests. Try again shortly.',
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    const iceStatus = getIceConfigStatus();

    // When TURN is not configured on the server, return STUN-only fallback safely.
    if (!iceStatus.turnConfigured) {
      const stunOnly = buildIceConfigForDevice('anonymous');
      res.status(200).json(stunOnly);
      return;
    }

    const roomId = typeof req.query.roomId === 'string' ? req.query.roomId.trim().toUpperCase() : '';
    const requestedDeviceId =
      typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : undefined;
    const token = extractBearerToken(req);

    if (!ROOM_CODE_REGEX.test(roomId) || !token) {
      res.status(403).json({
        error: 'UNAUTHORIZED',
        message: 'Valid roomId and approved member Bearer token required for TURN credentials',
      });
      return;
    }

    if (requestedDeviceId && !DEVICE_ID_REGEX.test(requestedDeviceId)) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid deviceId format',
      });
      return;
    }

    const verified = roomManager.verifyAuthorizedMemberSession({
      roomId,
      deviceId: requestedDeviceId,
      token,
    });
    if (!verified.ok) {
      res.status(mapRoomErrorStatus(verified.code)).json({
        error: verified.code,
        message: verified.message,
      });
      return;
    }

    // Never log ephemeral TURN credentials returned here
    const iceConfig = buildIceConfigForDevice(verified.deviceId);
    res.status(200).json(iceConfig);
  });

  app.post('/api/rooms', (req: Request, res: Response) => {
    const body = req.body as {
      hostDeviceId?: unknown;
      hostDeviceName?: unknown;
      hostPlatform?: unknown;
      hostDeviceType?: unknown;
      ttlMs?: unknown;
    };

    const hostDeviceId =
      typeof body?.hostDeviceId === 'string' ? body.hostDeviceId.trim() : '';
    const hostDeviceName =
      typeof body?.hostDeviceName === 'string' ? body.hostDeviceName.trim().slice(0, 64) : '';
    const hostPlatform =
      typeof body?.hostPlatform === 'string' && ALLOWED_PLATFORMS.has(body.hostPlatform as CastoraPlatform)
        ? (body.hostPlatform as CastoraPlatform)
        : null;

    if (!DEVICE_ID_REGEX.test(hostDeviceId) || !hostDeviceName || !hostPlatform) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'hostDeviceId, hostDeviceName, and valid hostPlatform (macos|android|android-tv) are required',
      });
      return;
    }

    const requestedTtl =
      typeof body?.ttlMs === 'number' && Number.isFinite(body.ttlMs)
        ? body.ttlMs
        : undefined;

    const created = roomManager.createRoom({
      hostDeviceId,
      hostDeviceName,
      hostPlatform,
      hostDeviceType: body?.hostDeviceType,
      ttlMs: requestedTtl,
    });

    if (!created.ok) {
      res.status(mapRoomErrorStatus(created.code)).json({
        error: created.code,
        message: created.message,
      });
      return;
    }

    // Security: never log hostToken
    res.status(201).json({
      room: created.room,
      hostToken: created.hostToken,
    });
  });

  app.get('/api/rooms/:roomId', (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    const rate = roomRateLimiter.consume(`http-lookup:${clientIp}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000).toString());
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many room code attempts. Try again later.',
      });
      return;
    }

    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(roomId)) {
      res.status(400).json({
        error: 'INVALID_ROOM_ID',
        message: 'Room code must be 6 uppercase alphanumeric characters',
      });
      return;
    }

    const lookup = roomManager.getRoom(roomId);
    if (!lookup.ok) {
      res.status(mapRoomErrorStatus(lookup.code)).json({
        error: lookup.code,
        message: lookup.message,
      });
      return;
    }

    res.status(200).json({ room: lookup.room });
  });

  const handleSubmitPairRequest = (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    const rate = roomRateLimiter.consume(`http-pair:${clientIp}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000).toString());
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many pairing requests. Try again later.',
      });
      return;
    }

    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const body = req.body as {
      receiverDeviceId?: unknown;
      deviceName?: unknown;
      platform?: unknown;
      deviceType?: unknown;
      pairingMethod?: unknown;
    };

    const receiverDeviceId =
      typeof body?.receiverDeviceId === 'string' ? body.receiverDeviceId.trim() : '';
    const deviceName =
      typeof body?.deviceName === 'string' ? body.deviceName.trim().slice(0, 64) : '';
    const platform =
      typeof body?.platform === 'string' && ALLOWED_PLATFORMS.has(body.platform as CastoraPlatform)
        ? (body.platform as CastoraPlatform)
        : null;
    const pairingMethod =
      typeof body?.pairingMethod === 'string' &&
      ALLOWED_PAIRING_METHODS.has(body.pairingMethod as PairingMethod)
        ? (body.pairingMethod as PairingMethod)
        : 'room_code';

    if (!ROOM_CODE_REGEX.test(roomId)) {
      res.status(400).json({
        error: 'INVALID_ROOM_ID',
        message: 'Room code must be 6 uppercase alphanumeric characters',
      });
      return;
    }

    if (!DEVICE_ID_REGEX.test(receiverDeviceId) || !deviceName || !platform) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'receiverDeviceId, deviceName, and valid platform are required',
      });
      return;
    }

    const submitted = roomManager.submitPairRequest({
      roomId,
      receiverDeviceId,
      deviceName,
      platform,
      deviceType: body?.deviceType,
      pairingMethod,
    });

    if (!submitted.ok) {
      res.status(mapRoomErrorStatus(submitted.code)).json({
        error: submitted.code,
        message: submitted.message,
      });
      return;
    }

    broadcastRoomState(roomManager, submitted.room);

    // Security: never log memberToken
    res.status(200).json({
      room: submitted.room,
      memberToken: submitted.memberToken,
      sessionId: submitted.sessionId,
      requestStatus: submitted.requestStatus,
    });
  };

  app.post('/api/rooms/:roomId/pair-requests', handleSubmitPairRequest);
  app.post('/api/rooms/:roomId/join', handleSubmitPairRequest);

  app.post('/api/rooms/:roomId/pair-requests/:receiverDeviceId/approve', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const receiverDeviceId = String(req.params.receiverDeviceId ?? '').trim();
    const hostToken = extractBearerToken(req);

    if (!ROOM_CODE_REGEX.test(roomId) || !DEVICE_ID_REGEX.test(receiverDeviceId) || !hostToken) {
      res.status(hostToken ? 400 : 403).json({
        error: hostToken ? 'INVALID_REQUEST' : 'UNAUTHORIZED',
        message: hostToken
          ? 'Valid roomId and receiverDeviceId required'
          : 'Authorization Bearer host token required',
      });
      return;
    }

    const approval = roomManager.approvePairRequest({
      roomId,
      receiverDeviceId,
      hostToken,
    });

    if (!approval.ok) {
      res.status(mapRoomErrorStatus(approval.code)).json({
        error: approval.code,
        message: approval.message,
      });
      return;
    }

    if (approval.receiverSocket) {
      sendJson(
        approval.receiverSocket,
        createServerEnvelope({
          messageType: 'pair_response',
          senderDeviceId: approval.room.hostDeviceId,
          receiverDeviceId: approval.approved.deviceId,
          roomId,
          payload: {
            paired: true,
            reason: null,
            receiverName: approval.approved.deviceName,
            receiverPlatform: approval.approved.platform,
            sessionId: approval.approved.sessionId,
          },
        })
      );
    }

    broadcastRoomState(roomManager, approval.room);

    res.status(200).json({
      room: approval.room,
      assignedSlotIndex: approval.approved.assignedSlotIndex,
      sessionId: approval.approved.sessionId,
    });
  });

  app.post('/api/rooms/:roomId/pair-requests/:receiverDeviceId/reject', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const receiverDeviceId = String(req.params.receiverDeviceId ?? '').trim();
    const hostToken = extractBearerToken(req);
    const body = req.body as { reason?: unknown } | undefined;
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;

    if (!ROOM_CODE_REGEX.test(roomId) || !DEVICE_ID_REGEX.test(receiverDeviceId) || !hostToken) {
      res.status(hostToken ? 400 : 403).json({
        error: hostToken ? 'INVALID_REQUEST' : 'UNAUTHORIZED',
        message: hostToken
          ? 'Valid roomId and receiverDeviceId required'
          : 'Authorization Bearer host token required',
      });
      return;
    }

    const rejection = roomManager.rejectPairRequest({
      roomId,
      receiverDeviceId,
      hostToken,
      reason,
    });

    if (!rejection.ok) {
      res.status(mapRoomErrorStatus(rejection.code)).json({
        error: rejection.code,
        message: rejection.message,
      });
      return;
    }

    if (rejection.receiverSocket) {
      sendJson(
        rejection.receiverSocket,
        createServerEnvelope({
          messageType: 'pair_response',
          senderDeviceId: rejection.room.hostDeviceId,
          receiverDeviceId: rejection.rejected.deviceId,
          roomId,
          payload: {
            paired: false,
            reason: rejection.reason,
            receiverName: rejection.rejected.deviceName,
            receiverPlatform: rejection.rejected.platform,
            sessionId: null,
          },
        })
      );
    }

    broadcastRoomState(
      roomManager,
      rejection.room,
      rejection.receiverSocket ? [rejection.receiverSocket] : []
    );

    res.status(200).json({ room: rejection.room });
  });

  app.delete('/api/rooms/:roomId/receivers/:receiverDeviceId', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const receiverDeviceId = String(req.params.receiverDeviceId ?? '').trim();
    const hostToken = extractBearerToken(req);

    if (!ROOM_CODE_REGEX.test(roomId) || !DEVICE_ID_REGEX.test(receiverDeviceId) || !hostToken) {
      res.status(hostToken ? 400 : 403).json({
        error: hostToken ? 'INVALID_REQUEST' : 'UNAUTHORIZED',
        message: hostToken
          ? 'Valid roomId and receiverDeviceId required'
          : 'Authorization Bearer host token required',
      });
      return;
    }

    const removed = roomManager.removePairedReceiver({
      roomId,
      receiverDeviceId,
      hostToken,
    });

    if (!removed.ok) {
      res.status(mapRoomErrorStatus(removed.code)).json({
        error: removed.code,
        message: removed.message,
      });
      return;
    }

    emitTerminatedStreams(roomId, removed.terminatedStreams, 'receiver_closed');

    if (removed.removedSocket) {
      sendJson(
        removed.removedSocket,
        createServerEnvelope({
          messageType: 'disconnect',
          receiverDeviceId: removed.removedDeviceId,
          roomId,
          payload: {
            sessionId: null,
            streamId: null,
            reason: 'Removed by host',
          },
        })
      );
    }

    broadcastRoomState(
      roomManager,
      removed.room,
      removed.removedSocket ? [removed.removedSocket] : []
    );

    res.status(200).json({ room: removed.room, removedDeviceId: removed.removedDeviceId });
  });

  app.post('/api/rooms/:roomId/leave', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const memberToken = extractBearerToken(req);
    const body = req.body as { deviceId?: unknown } | undefined;
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';

    if (!ROOM_CODE_REGEX.test(roomId) || !DEVICE_ID_REGEX.test(deviceId) || !memberToken) {
      res.status(memberToken ? 400 : 403).json({
        error: memberToken ? 'INVALID_REQUEST' : 'UNAUTHORIZED',
        message: 'Valid roomId, deviceId, and Bearer member token required',
      });
      return;
    }

    const left = roomManager.leaveRoom({
      roomId,
      deviceId,
      memberToken,
    });

    if (!left.ok) {
      res.status(mapRoomErrorStatus(left.code)).json({
        error: left.code,
        message: left.message,
      });
      return;
    }

    emitTerminatedStreams(roomId, left.terminatedStreams, 'receiver_closed');
    broadcastRoomState(roomManager, left.room);
    res.status(200).json({ left: true, roomId });
  });

  app.patch('/api/rooms/:roomId/devices/:targetDeviceId/name', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const targetDeviceId = String(req.params.targetDeviceId ?? '').trim();
    const token = extractBearerToken(req);
    const body = req.body as { deviceName?: unknown } | undefined;

    if (!ROOM_CODE_REGEX.test(roomId) || !DEVICE_ID_REGEX.test(targetDeviceId) || !token) {
      res.status(token ? 400 : 403).json({
        error: token ? 'INVALID_REQUEST' : 'UNAUTHORIZED',
        message: token
          ? 'Valid roomId and targetDeviceId required'
          : 'Authorization Bearer session token required',
      });
      return;
    }

    const renamed = roomManager.renameRoomDevice({
      roomId,
      targetDeviceId,
      newName: typeof body?.deviceName === 'string' ? body.deviceName : '',
      token,
    });

    if (!renamed.ok) {
      res.status(mapRoomErrorStatus(renamed.code)).json({
        error: renamed.code,
        message: renamed.message,
      });
      return;
    }

    broadcastRoomState(roomManager, renamed.room);
    res.status(200).json({
      room: renamed.room,
      targetDeviceId: renamed.targetDeviceId,
      deviceName: renamed.deviceName,
    });
  });

  app.post('/api/rooms/:roomId/devices/:targetDeviceId/stop-stream', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const publisherDeviceId = String(req.params.targetDeviceId ?? '').trim();
    const token = extractBearerToken(req);
    const body = req.body as { streamTargetDeviceId?: unknown } | undefined;
    const streamTargetDeviceId =
      typeof body?.streamTargetDeviceId === 'string' && DEVICE_ID_REGEX.test(body.streamTargetDeviceId.trim())
        ? body.streamTargetDeviceId.trim()
        : undefined;

    if (!ROOM_CODE_REGEX.test(roomId) || !DEVICE_ID_REGEX.test(publisherDeviceId) || !token) {
      res.status(token ? 400 : 403).json({
        error: token ? 'INVALID_REQUEST' : 'UNAUTHORIZED',
        message: token
          ? 'Valid roomId and targetDeviceId required'
          : 'Authorization Bearer session token required',
      });
      return;
    }

    const stopped = roomManager.stopStreamByControl({
      roomId,
      publisherDeviceId,
      streamTargetDeviceId,
      token,
    });

    if (!stopped.ok) {
      res.status(mapRoomErrorStatus(stopped.code)).json({
        error: stopped.code,
        message: stopped.message,
      });
      return;
    }

    emitTerminatedStreams(roomId, stopped.terminatedStreams, 'receiver_closed');

    // Notify the publisher's open signaling socket if a host stopped their stream remotely
    if (stopped.publisherSocket && stopped.publisherSocket.readyState === 1) {
      for (const item of stopped.terminatedStreams) {
        sendJson(
          stopped.publisherSocket,
          createServerEnvelope({
            messageType: 'stream_stop',
            senderDeviceId: stopped.room.hostDeviceId,
            receiverDeviceId: stopped.publisherDeviceId,
            roomId,
            payload: {
              sessionId: item.sessionId,
              streamId: item.streamId,
              reason: 'receiver_closed',
            },
          })
        );
      }
    }

    broadcastRoomState(roomManager, stopped.room);
    res.status(200).json({
      room: stopped.room,
      terminatedCount: stopped.terminatedStreams.length,
    });
  });

  app.post('/api/rooms/:roomId/devices/:targetDeviceId/reconnect', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const targetDeviceId = String(req.params.targetDeviceId ?? '').trim();
    const token = extractBearerToken(req);

    if (!ROOM_CODE_REGEX.test(roomId) || !DEVICE_ID_REGEX.test(targetDeviceId) || !token) {
      res.status(token ? 400 : 403).json({
        error: token ? 'INVALID_REQUEST' : 'UNAUTHORIZED',
        message: token
          ? 'Valid roomId and targetDeviceId required'
          : 'Authorization Bearer session token required',
      });
      return;
    }

    const recon = roomManager.authorizeDeviceReconnect({
      roomId,
      targetDeviceId,
      token,
    });

    if (!recon.ok) {
      res.status(mapRoomErrorStatus(recon.code)).json({
        error: recon.code,
        message: recon.message,
      });
      return;
    }

    if (recon.requestedByHost && recon.targetSocket && recon.targetSocket.readyState === 1) {
      sendJson(
        recon.targetSocket,
        createServerEnvelope({
          messageType: 'error',
          senderDeviceId: recon.room.hostDeviceId,
          receiverDeviceId: recon.targetDeviceId,
          roomId,
          payload: {
            code: 'WEBRTC_NEGOTIATION_FAILED',
            message: `Reconnect requested by host for room ${roomId}`,
            recoverable: true,
            relatedMessageId: null,
          },
        })
      );
    }

    broadcastRoomState(roomManager, recon.room);
    res.status(200).json({
      room: recon.room,
      targetDeviceId: recon.targetDeviceId,
      requestedByHost: recon.requestedByHost,
    });
  });

  app.delete('/api/rooms/:roomId', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const token = extractBearerToken(req);

    if (!ROOM_CODE_REGEX.test(roomId) || !token) {
      res.status(403).json({
        error: 'UNAUTHORIZED',
        message: 'Valid roomId and Bearer host token required',
      });
      return;
    }

    const result = roomManager.closeRoom(roomId, token);
    if (!result.ok) {
      res.status(mapRoomErrorStatus(result.code)).json({
        error: result.code,
        message: result.message,
      });
      return;
    }

    if (result.closedSnapshot) {
      const stateNotice = JSON.stringify(
        createServerEnvelope({
          messageType: 'room_state',
          receiverDeviceId: null,
          roomId,
          payload: toRoomStatePayload(result.closedSnapshot),
        })
      );
      for (const sock of result.affectedSockets) {
        if (sock.readyState === 1) {
          sock.send(stateNotice);
        }
      }
    }

    const closedNotice = JSON.stringify(
      createServerEnvelope({
        messageType: 'disconnect',
        receiverDeviceId: null,
        roomId,
        payload: {
          sessionId: null,
          streamId: null,
          reason: 'Room closed by host',
        },
      })
    );
    for (const sock of result.affectedSockets) {
      if (sock.readyState === 1) {
        sock.send(closedNotice);
      }
    }

    res.status(200).json({ closed: true, roomId });
  });

  // --- Frontend Mounting (Vite dev middleware or compiled apps/web/dist) ---
  let viteServer: { close: () => Promise<void> } | null = null;
  if (useVite) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.resolve(process.cwd(), 'apps', 'web', 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server },
      },
      appType: 'spa',
    });
    viteServer = vite;
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'apps', 'web', 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    app.use(express.static(distDir));
    app.get('*', (req: Request, res: Response, next) => {
      if (req.path.startsWith('/api/') || req.path === '/castora') {
        next();
        return;
      }
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(503).send('Frontend production bundle not built. Run npm run build.');
      }
    });
  }

  // Periodic room expiry & rate-limit bucket cleanup
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    const expiredRooms = roomManager.sweepExpiredRooms(now);
    for (const item of expiredRooms) {
      const stateNotice = JSON.stringify(
        createServerEnvelope({
          messageType: 'room_state',
          receiverDeviceId: null,
          roomId: item.roomId,
          payload: toRoomStatePayload(item.snapshot),
        })
      );
      const disconnectNotice = JSON.stringify(
        createServerEnvelope({
          messageType: 'disconnect',
          receiverDeviceId: null,
          roomId: item.roomId,
          payload: {
            sessionId: null,
            streamId: null,
            reason: 'Room expired',
          },
        })
      );
      for (const sock of item.sockets) {
        if (sock.readyState === 1) {
          sock.send(stateNotice);
          sock.send(disconnectNotice);
        }
      }
    }
    roomRateLimiter.prune(now);
    iceRateLimiter.prune(now);
  }, EXPIRY_SWEEP_INTERVAL_MS);
  sweepInterval.unref();

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const scheme = httpsEnabled ? 'https' : 'http';
  console.log(
    `[castora-server] Listening on ${scheme}://${host}:${actualPort} (WS path /castora, mode=${isProd ? 'production' : 'development'})`
  );

  return {
    app,
    server,
    port: actualPort,
    httpsEnabled,
    roomManager,
    close: async () => {
      clearInterval(sweepInterval);
      gateway.shutdown();
      if (viteServer) {
        await viteServer.close();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isEntrypoint) {
  startCastoraServer().catch((err) => {
    console.error('[castora-server] Fatal startup error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
