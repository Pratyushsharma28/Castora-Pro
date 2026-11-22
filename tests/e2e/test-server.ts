import { startCastoraServer } from '../../server.ts';

const port = Number(process.env.CASTORA_E2E_PORT ?? 4173);

async function boot() {
  const instance = await startCastoraServer({
    port,
    host: '127.0.0.1',
    enableViteMiddleware: true,
    roomTtlMs: Number(process.env.CASTORA_E2E_ROOM_TTL_MS ?? 1_800_000),
    rateLimitMaxAttempts: Number(process.env.CASTORA_E2E_RATE_LIMIT ?? 300),
    rateLimitWindowMs: 10_000,
    passwordRateLimitMaxAttempts: 5,
    passwordRateLimitWindowMs: 30_000,
  });

  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

boot().catch((err) => {
  console.error('[castora-e2e-server] Failed to start:', err);
  process.exit(1);
});
