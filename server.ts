import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createServerEnvelope } from './apps/server/protocolValidator.ts';
import { RoomManager } from './apps/server/roomManager.ts';
import { SlidingWindowRateLimiter } from './apps/server/security.ts';
import { attachSignalingGateway } from './apps/server/signalingGateway.ts';
import type { BackendHealthStatus, CastoraPlatform } from './apps/server/types.ts';

dotenv.config();

const DEFAULT_PORT = Number(process.env.PORT ?? 3000) || 3000;
const EXPIRY_SWEEP_INTERVAL_MS = 5_000;
const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;
const DEVICE_ID_REGEX = /^[A-Za-z0-9._-]{3,64}$/;
const ALLOWED_PLATFORMS = new Set<CastoraPlatform>(['macos', 'android', 'android-tv']);

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

  const gateway = attachSignalingGateway({
    server,
    roomManager,
    roomRateLimiter,
    wsPort: port,
  });

  // --- REST API Routes ---
  app.get('/api/health', (_req: Request, res: Response) => {
    const stats = roomManager.getStats();
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
      timestamp: new Date().toISOString(),
    };
    res.status(200).json(body);
  });

  app.post('/api/rooms', (req: Request, res: Response) => {
    const body = req.body as {
      hostDeviceId?: unknown;
      hostDeviceName?: unknown;
      hostPlatform?: unknown;
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
      ttlMs: requestedTtl,
    });

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
      res.status(lookup.code === 'ROOM_EXPIRED' ? 410 : 404).json({
        error: lookup.code,
        message: lookup.message,
      });
      return;
    }

    res.status(200).json({ room: lookup.room });
  });

  app.post('/api/rooms/:roomId/join', (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    const rate = roomRateLimiter.consume(`http-join:${clientIp}`);
    if (!rate.allowed) {
      res.setHeader('Retry-After', Math.ceil(rate.retryAfterMs / 1000).toString());
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many room join attempts. Try again later.',
      });
      return;
    }

    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const body = req.body as {
      receiverDeviceId?: unknown;
      deviceName?: unknown;
      platform?: unknown;
    };

    const receiverDeviceId =
      typeof body?.receiverDeviceId === 'string' ? body.receiverDeviceId.trim() : '';
    const deviceName =
      typeof body?.deviceName === 'string' ? body.deviceName.trim().slice(0, 64) : '';
    const platform =
      typeof body?.platform === 'string' && ALLOWED_PLATFORMS.has(body.platform as CastoraPlatform)
        ? (body.platform as CastoraPlatform)
        : null;

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

    const joined = roomManager.joinRoom({
      roomId,
      receiverDeviceId,
      deviceName,
      platform,
    });

    if (!joined.ok) {
      const status =
        joined.code === 'ROOM_FULL'
          ? 409
          : joined.code === 'ROOM_EXPIRED'
            ? 410
            : joined.code === 'UNAUTHORIZED'
              ? 403
              : 404;
      res.status(status).json({
        error: joined.code,
        message: joined.message,
      });
      return;
    }

    // Security: never log memberToken
    res.status(200).json({
      room: joined.room,
      memberToken: joined.memberToken,
      assignedSlotIndex: joined.assignedSlotIndex,
    });
  });

  app.delete('/api/rooms/:roomId', (req: Request, res: Response) => {
    const roomId = String(req.params.roomId ?? '').trim().toUpperCase();
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' && auth.startsWith('Bearer ')
        ? auth.slice(7).trim()
        : '';

    if (!ROOM_CODE_REGEX.test(roomId) || !token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Valid roomId and Bearer host token required',
      });
      return;
    }

    const result = roomManager.closeRoom(roomId, token);
    if (!result.ok) {
      res.status(result.code === 'UNAUTHORIZED' ? 403 : 404).json({
        error: result.code,
        message: result.message,
      });
      return;
    }

    const closedNotice = createServerEnvelope({
      messageType: 'disconnect',
      receiverDeviceId: null,
      roomId,
      payload: {
        sessionId: null,
        streamId: null,
        reason: 'Room closed by host',
      },
    });
    const encoded = JSON.stringify(closedNotice);
    for (const sock of result.affectedSockets) {
      if (sock.readyState === 1) {
        sock.send(encoded);
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
      const notice = JSON.stringify(
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
          sock.send(notice);
        }
      }
    }
    roomRateLimiter.prune(now);
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
