import crypto from 'node:crypto';

export type TurnCredentialMode = 'ephemeral-hmac' | 'static' | 'disabled';

export interface IceServerDescriptor {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ServerIceConfigResponse {
  iceServers: IceServerDescriptor[];
  turnConfigured: boolean;
  turnMode: TurnCredentialMode;
  transports: Array<'udp' | 'tcp' | 'tls'>;
  ttlSeconds: number | null;
  expiresAt: string | null;
}

export interface IceConfigStatus {
  turnConfigured: boolean;
  turnMode: TurnCredentialMode;
  transports: Array<'udp' | 'tcp' | 'tls'>;
}

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302'];
const DEFAULT_TURN_TTL_SECONDS = 3600;
const MIN_TURN_TTL_SECONDS = 60;
const MAX_TURN_TTL_SECONDS = 86_400;

function parseUrlList(raw: string | undefined, allowedSchemes: string[]): string[] {
  if (!raw || !raw.trim()) return [];
  const seen = new Set<string>();
  const results: string[] = [];

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || /\s/.test(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    const validScheme = allowedSchemes.some((scheme) => lower.startsWith(`${scheme}:`));
    if (!validScheme) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      results.push(trimmed);
    }
  }
  return results;
}

function detectTurnTransports(turnUrls: string[]): Array<'udp' | 'tcp' | 'tls'> {
  const transports = new Set<'udp' | 'tcp' | 'tls'>();
  for (const url of turnUrls) {
    const lower = url.toLowerCase();
    if (lower.startsWith('turns:')) {
      transports.add('tls');
    } else if (lower.includes('transport=tcp')) {
      transports.add('tcp');
    } else if (lower.includes('transport=udp')) {
      transports.add('udp');
    } else {
      // Standard turn: without explicit ?transport= supports UDP (and often TCP fallback)
      transports.add('udp');
    }
  }
  return Array.from(transports);
}

export function clampTurnTtlSeconds(raw?: string | number): number {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_TURN_TTL_SECONDS;
  return Math.min(MAX_TURN_TTL_SECONDS, Math.max(MIN_TURN_TTL_SECONDS, Math.round(num)));
}

/**
 * Generates standard Coturn / WebRTC REST ephemeral HMAC-SHA1 TURN credentials.
 * Format: username = "<unix_expiry>:<deviceId>", credential = Base64(HMAC-SHA1(secret, username)).
 */
export function generateEphemeralTurnCredentials(params: {
  secret: string;
  deviceId: string;
  ttlSeconds?: number;
  nowMs?: number;
}): {
  username: string;
  credential: string;
  ttlSeconds: number;
  expiresAt: string;
} {
  const ttlSeconds = clampTurnTtlSeconds(params.ttlSeconds);
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const expirySec = nowSec + ttlSeconds;
  const sanitizedDevice =
    params.deviceId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48) || 'castora-peer';
  const username = `${expirySec}:${sanitizedDevice}`;
  const credential = crypto
    .createHmac('sha1', params.secret)
    .update(username)
    .digest('base64');

  return {
    username,
    credential,
    ttlSeconds,
    expiresAt: new Date(expirySec * 1000).toISOString(),
  };
}

export function getIceConfigStatus(env: NodeJS.ProcessEnv = process.env): IceConfigStatus {
  const turnUrls = parseUrlList(env.CASTORA_TURN_URLS, ['turn', 'turns']);
  const secret = env.CASTORA_TURN_AUTH_SECRET?.trim() ?? '';
  const staticUser = env.CASTORA_TURN_USERNAME?.trim() ?? '';
  const staticCred = env.CASTORA_TURN_CREDENTIAL ?? '';

  if (turnUrls.length === 0) {
    return { turnConfigured: false, turnMode: 'disabled', transports: [] };
  }
  if (secret.length > 0) {
    return {
      turnConfigured: true,
      turnMode: 'ephemeral-hmac',
      transports: detectTurnTransports(turnUrls),
    };
  }
  if (staticUser.length > 0 && staticCred.length > 0) {
    return {
      turnConfigured: true,
      turnMode: 'static',
      transports: detectTurnTransports(turnUrls),
    };
  }
  return { turnConfigured: false, turnMode: 'disabled', transports: [] };
}

export function buildIceConfigForDevice(
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
): ServerIceConfigResponse {
  const configuredStun = parseUrlList(env.CASTORA_STUN_URLS, ['stun', 'stuns']);
  const stunUrls = configuredStun.length > 0 ? configuredStun : [...DEFAULT_STUN_URLS];

  const iceServers: IceServerDescriptor[] = [{ urls: stunUrls }];

  const turnUrls = parseUrlList(env.CASTORA_TURN_URLS, ['turn', 'turns']);
  const secret = env.CASTORA_TURN_AUTH_SECRET?.trim() ?? '';
  const staticUser = env.CASTORA_TURN_USERNAME?.trim() ?? '';
  const staticCred = env.CASTORA_TURN_CREDENTIAL ?? '';

  if (turnUrls.length > 0 && secret.length > 0) {
    const ttlSeconds = clampTurnTtlSeconds(env.CASTORA_TURN_TTL_SECONDS);
    const ephemeral = generateEphemeralTurnCredentials({
      secret,
      deviceId,
      ttlSeconds,
      nowMs,
    });
    iceServers.push({
      urls: turnUrls,
      username: ephemeral.username,
      credential: ephemeral.credential,
    });
    return {
      iceServers,
      turnConfigured: true,
      turnMode: 'ephemeral-hmac',
      transports: detectTurnTransports(turnUrls),
      ttlSeconds: ephemeral.ttlSeconds,
      expiresAt: ephemeral.expiresAt,
    };
  }

  if (turnUrls.length > 0 && staticUser.length > 0 && staticCred.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: staticUser,
      credential: staticCred,
    });
    return {
      iceServers,
      turnConfigured: true,
      turnMode: 'static',
      transports: detectTurnTransports(turnUrls),
      ttlSeconds: null,
      expiresAt: null,
    };
  }

  return {
    iceServers,
    turnConfigured: false,
    turnMode: 'disabled',
    transports: [],
    ttlSeconds: null,
    expiresAt: null,
  };
}
