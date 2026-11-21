import crypto from 'node:crypto';

// Ambiguity-free alphanumeric alphabet matching ^[A-Z0-9]{6}$
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    const idx = crypto.randomInt(0, ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyToken(rawToken: string, expectedHashHex: string): boolean {
  if (!rawToken || !expectedHashHex) {
    return false;
  }
  const actualBuf = crypto.createHash('sha256').update(rawToken, 'utf8').digest();
  const expectedBuf = Buffer.from(expectedHashHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function generateMessageId(prefix = 'srv'): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(maxAttempts = 10, windowMs = 60_000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const cutoff = now - this.windowMs;
    const existing = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);

    if (existing.length >= this.maxAttempts) {
      const oldest = existing[0] ?? now;
      const retryAfterMs = Math.max(1_000, oldest + this.windowMs - now);
      this.buckets.set(key, existing);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
      };
    }

    existing.push(now);
    this.buckets.set(key, existing);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxAttempts - existing.length),
      retryAfterMs: 0,
    };
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.buckets.entries()) {
      const fresh = timestamps.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, fresh);
      }
    }
  }
}
