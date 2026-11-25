import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  generateInviteCode,
  generateRoomCode,
  generateSessionToken,
  hashRoomPassword,
  hashToken,
  normalizeAndValidateRoomPassword,
  verifyConstantTimeSecret,
  verifyRoomPassword,
  verifyToken,
} from './security.ts';
import type {
  ActiveRoomStream,
  CastoraDeviceRole,
  CastoraPlatform,
  CastoraRoom,
  CastoraVideoCodec,
  DetectedDeviceType,
  DeviceCapabilities,
  PairedReceiverMember,
  PairingMethod,
  PendingPairRequest,
  PublicHostTransfer,
  PublicRoomSnapshot,
  RegisteredDevice,
  RoomPrivacyMode,
} from './types.ts';

export const MAX_RECEIVERS_PER_ROOM = 15;
const DEFAULT_ROOM_TTL_MS = 15 * 60 * 1000;
const MIN_ROOM_TTL_MS = 200;
const MAX_ROOM_TTL_MS = 60 * 60 * 1000;
const ACTIVE_CAST_SLIDING_EXTENSION_MS = 15 * 60 * 1000;
const MAX_ACTIVE_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const ACTIVE_PARTICIPANT_RECENCY_MS = 5 * 60 * 1000;
const DEFAULT_DISCONNECT_GRACE_MS = 20_000;
const HOST_TRANSFER_TTL_MS = 120 * 1000;
const ALLOWED_PRIVACY_MODES = new Set<RoomPrivacyMode>([
  'private',
  'approval_required',
  'open',
]);

const ALLOWED_DEVICE_TYPES = new Set<DetectedDeviceType>([
  'Mac',
  'Windows',
  'Linux',
  'iPad',
  'iPhone',
  'Android',
  'TV',
  'Chromebook',
  'Unknown',
]);

const RESERVED_EXACT_LABELS = new Set<string>([
  'host',
  'room host',
  'admin',
  'administrator',
  'system',
  'server',
  'castora',
  'castora server',
  'castora signaling server',
  'castora pro',
  'moderator',
  'mod',
  'root',
  'superuser',
  'operator',
  'all',
  'everyone',
  'broadcast',
  'unknown',
  'you',
  'me',
  'anonymous',
  'null',
  'undefined',
  'none',
  'device',
  'local',
  'localhost',
]);

const MISLEADING_SYSTEM_LABEL_REGEX =
  /(\[(?:host|admin|administrator|system|server|moderator|mod|you)\]|\((?:host|admin|administrator|system|server|moderator|mod|you)\)|^(?:host|admin|administrator|system|server|moderator)\s*:)/i;

export function normalizeDeviceType(raw: unknown): DetectedDeviceType {
  if (typeof raw === 'string') {
    const trimmed = raw.trim() as DetectedDeviceType;
    if (ALLOWED_DEVICE_TYPES.has(trimmed)) {
      return trimmed;
    }
  }
  return 'Unknown';
}

export function normalizeAndValidateDeviceName(raw: unknown):
  | { ok: true; name: string }
  | { ok: false; code: 'INVALID_DEVICE_NAME'; message: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'INVALID_DEVICE_NAME',
      message: 'Device name must be a non-empty string',
    };
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length < 2 || collapsed.length > 48) {
    return {
      ok: false,
      code: 'INVALID_DEVICE_NAME',
      message: 'Device name must be between 2 and 48 characters',
    };
  }
  if (/[\u0000-\u001F\u007F<>]/.test(collapsed)) {
    return {
      ok: false,
      code: 'INVALID_DEVICE_NAME',
      message: 'Device name contains invalid control or markup characters',
    };
  }
  const canonical = collapsed.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (RESERVED_EXACT_LABELS.has(canonical) || MISLEADING_SYSTEM_LABEL_REGEX.test(collapsed)) {
    return {
      ok: false,
      code: 'INVALID_DEVICE_NAME',
      message: `Device name "${collapsed}" is a reserved or misleading system label`,
    };
  }
  return { ok: true, name: collapsed };
}

export function normalizePrivacyMode(raw: unknown): RoomPrivacyMode | null {
  if (typeof raw === 'string' && ALLOWED_PRIVACY_MODES.has(raw as RoomPrivacyMode)) {
    return raw as RoomPrivacyMode;
  }
  return null;
}

export function normalizeAndValidateRoomName(raw: unknown):
  | { ok: true; name: string }
  | { ok: false; code: 'INVALID_ROOM_NAME'; message: string } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'INVALID_ROOM_NAME',
      message: 'Room name must be a non-empty string',
    };
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length < 2 || collapsed.length > 64) {
    return {
      ok: false,
      code: 'INVALID_ROOM_NAME',
      message: 'Room name must be between 2 and 64 characters',
    };
  }
  if (/[\u0000-\u001F\u007F<>]/.test(collapsed)) {
    return {
      ok: false,
      code: 'INVALID_ROOM_NAME',
      message: 'Room name contains invalid control or markup characters',
    };
  }
  return { ok: true, name: collapsed };
}

export type RoomOperationErrorCode =
  | 'INVALID_ROOM_ID'
  | 'INVALID_ROOM_NAME'
  | 'INVALID_PRIVACY_MODE'
  | 'INVALID_ROOM_PASSWORD'
  | 'INVALID_DEVICE_NAME'
  | 'DUPLICATE_DEVICE_NAME'
  | 'HOST_ALREADY_HAS_ACTIVE_ROOM'
  | 'INVITATION_REQUIRED'
  | 'INVALID_INVITATION'
  | 'RATE_LIMITED'
  | 'HOST_TRANSFER_IN_PROGRESS'
  | 'TRANSFER_NOT_FOUND'
  | 'TRANSFER_EXPIRED'
  | 'RECEIVER_DISCONNECTED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_EXPIRED'
  | 'ROOM_CAPACITY_REACHED'
  | 'ALREADY_PAIRED'
  | 'DUPLICATE_PAIR_REQUEST'
  | 'REQUEST_NOT_FOUND'
  | 'RECEIVER_NOT_FOUND'
  | 'STREAM_NOT_FOUND'
  | 'UNAUTHORIZED';

export type RoomLookupResult =
  | { ok: true; room: PublicRoomSnapshot }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type SubmitPairRequestResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      memberToken: string;
      sessionId: string;
      requestStatus: 'pending_approval' | 'paired';
      assignedSlotIndex?: number;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type ApprovePairResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      approved: PairedReceiverMember;
      receiverSocket: WebSocket | null;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type RejectPairResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      rejected: PendingPairRequest;
      reason: string;
      receiverSocket: WebSocket | null;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export interface TerminatedStreamNotice {
  streamId: string;
  sessionId: string;
  publisherDeviceId: string;
  targetDeviceId: string;
  targetSocket: WebSocket | null;
}

export type RemoveReceiverResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      removedDeviceId: string;
      removedSocket: WebSocket | null;
      terminatedStreams: TerminatedStreamNotice[];
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type LeaveRoomResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      terminatedStreams: TerminatedStreamNotice[];
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type PeerSignalingAuthResult =
  | {
      ok: true;
      targetSocket: WebSocket;
    }
  | {
      ok: false;
      code: 'INVALID_ROOM_ID' | 'APPROVAL_DECLINED' | 'WEBRTC_NEGOTIATION_FAILED';
      message: string;
    };

export type StreamRegistrationResult =
  | {
      ok: true;
      targetSocket: WebSocket;
      room: PublicRoomSnapshot;
      authorizedSockets: WebSocket[];
    }
  | {
      ok: false;
      code: 'INVALID_ROOM_ID' | 'APPROVAL_DECLINED' | 'WEBRTC_NEGOTIATION_FAILED';
      message: string;
    };

export type CreateRoomResult =
  | { ok: true; room: PublicRoomSnapshot; hostToken: string; inviteCode: string }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type RoomSettingsUpdateResult =
  | { ok: true; room: PublicRoomSnapshot }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type RoomInvitationResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      inviteCode: string;
      privacyMode: RoomPrivacyMode;
      passwordProtected: boolean;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type InvitationValidationResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      inviteValid: boolean;
      canRequestJoin: boolean;
      availableSlots: number;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type SessionRestoreResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      deviceId: string;
      role: 'host' | 'paired' | 'pending';
      inviteCode?: string;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type InitiateHostTransferResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      transfer: PublicHostTransfer;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type RespondHostTransferResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      accepted: boolean;
      newHostDeviceId: string;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type RenameDeviceResult =
  | { ok: true; room: PublicRoomSnapshot; targetDeviceId: string; deviceName: string }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type StopStreamControlResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      publisherDeviceId: string;
      publisherSocket: WebSocket | null;
      terminatedStreams: TerminatedStreamNotice[];
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type ReconnectDeviceControlResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      targetDeviceId: string;
      targetSocket: WebSocket | null;
      requestedByHost: boolean;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export function toRoomStatePayload(snapshot: PublicRoomSnapshot): Record<string, unknown> {
  return {
    status: snapshot.status,
    roomName: snapshot.roomName,
    createdAt: snapshot.createdAt,
    privacyMode: snapshot.privacyMode,
    passwordProtected: snapshot.passwordProtected,
    hostTransfer: snapshot.hostTransfer,
    hostDeviceId: snapshot.hostDeviceId,
    hostDeviceName: snapshot.hostDeviceName,
    hostPlatform: snapshot.hostPlatform,
    hostDeviceType: snapshot.hostDeviceType,
    hostConnected: snapshot.hostConnected,
    hostLastSeenAt: snapshot.hostLastSeenAt,
    expiresAt: snapshot.expiresAt,
    maxReceivers: snapshot.maxReceivers,
    pendingRequests: snapshot.pendingRequests,
    pairedReceivers: snapshot.pairedReceivers,
    activeStreams: snapshot.activeStreams,
  };
}

export class RoomManager {
  private readonly devices = new Map<string, RegisteredDevice>();
  private readonly socketToDeviceId = new Map<WebSocket, string>();
  private readonly rooms = new Map<string, CastoraRoom>();
  private readonly disconnectGraceTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; socket: WebSocket }
  >();
  private readonly defaultTtlMs: number;
  private readonly disconnectGraceMs: number;

  constructor(defaultTtlMs?: number, disconnectGraceMs?: number) {
    const envTtl = Number(process.env.CASTORA_ROOM_TTL_MS);
    if (typeof defaultTtlMs === 'number' && Number.isFinite(defaultTtlMs)) {
      this.defaultTtlMs = this.clampTtl(defaultTtlMs);
    } else if (Number.isFinite(envTtl) && envTtl >= MIN_ROOM_TTL_MS) {
      this.defaultTtlMs = this.clampTtl(envTtl);
    } else {
      this.defaultTtlMs = DEFAULT_ROOM_TTL_MS;
    }

    const envGrace = Number(process.env.CASTORA_DISCONNECT_GRACE_MS);
    if (typeof disconnectGraceMs === 'number' && Number.isFinite(disconnectGraceMs)) {
      this.disconnectGraceMs = Math.max(0, Math.round(disconnectGraceMs));
    } else if (Number.isFinite(envGrace) && envGrace >= 0) {
      this.disconnectGraceMs = Math.round(envGrace);
    } else {
      this.disconnectGraceMs = DEFAULT_DISCONNECT_GRACE_MS;
    }
  }

  private clampTtl(ttlMs: number): number {
    return Math.min(MAX_ROOM_TTL_MS, Math.max(MIN_ROOM_TTL_MS, Math.round(ttlMs)));
  }

  private isSocketOpen(ws: WebSocket | undefined): boolean {
    return Boolean(ws && ws.readyState === 1);
  }

  private hasOpenSocket(deviceId: string): boolean {
    const dev = this.devices.get(deviceId);
    return Boolean(dev && this.isSocketOpen(dev.socket));
  }

  private isDeviceConnectedOrInGrace(deviceId: string): boolean {
    return this.hasOpenSocket(deviceId) || this.disconnectGraceTimers.has(deviceId);
  }

  private getOpenSocket(deviceId: string): WebSocket | null {
    const dev = this.devices.get(deviceId);
    return dev && this.isSocketOpen(dev.socket) ? dev.socket : null;
  }

  private cancelDisconnectGrace(deviceId: string): void {
    const entry = this.disconnectGraceTimers.get(deviceId);
    if (entry) {
      clearTimeout(entry.timer);
      this.disconnectGraceTimers.delete(deviceId);
    }
  }

  clearAllDisconnectGraceTimers(): void {
    for (const entry of this.disconnectGraceTimers.values()) {
      clearTimeout(entry.timer);
    }
    this.disconnectGraceTimers.clear();
  }

  getDisconnectGraceMs(): number {
    return this.disconnectGraceMs;
  }

  private extendActiveRoomExpiration(
    room: CastoraRoom,
    now: number,
    trigger: 'stream' | 'heartbeat' | 'sweep'
  ): boolean {
    const hardCap = room.createdAt + MAX_ACTIVE_SESSION_DURATION_MS;
    if (now >= hardCap) {
      return false;
    }

    const hasActiveStreams = room.activeStreams.size > 0;
    const anyParticipantConnected =
      (room.hostConnected && this.isDeviceConnectedOrInGrace(room.hostDeviceId)) ||
      Array.from(room.pairedReceivers.values()).some(
        (member) => member.connected && this.isDeviceConnectedOrInGrace(member.deviceId)
      );

    let latestSeenAt = room.hostLastSeenAt;
    for (const member of room.pairedReceivers.values()) {
      if (member.lastSeenAt > latestSeenAt) {
        latestSeenAt = member.lastSeenAt;
      }
    }
    const recencyWindow = Math.max(room.ttlMs, ACTIVE_PARTICIPANT_RECENCY_MS);
    const recentlyActive = now - latestSeenAt <= recencyWindow;

    if (hasActiveStreams && (anyParticipantConnected || recentlyActive || trigger === 'stream')) {
      const extension =
        room.ttlMs < 60_000
          ? Math.max(room.ttlMs, 2_000)
          : Math.max(room.ttlMs, ACTIVE_CAST_SLIDING_EXTENSION_MS);
      const nextExpiry = Math.min(hardCap, now + extension);
      if (nextExpiry > room.expiresAt) {
        room.expiresAt = nextExpiry;
        return true;
      }
      return false;
    }

    // Preserve short unit-test TTL expiry semantics when idle (no active streams),
    // while keeping active real-world rooms (ttlMs >= 60s) alive when connected members heartbeat.
    if (trigger === 'heartbeat' && room.ttlMs >= 60_000 && anyParticipantConnected) {
      const nextExpiry = Math.min(hardCap, now + Math.max(room.ttlMs, ACTIVE_CAST_SLIDING_EXTENSION_MS));
      if (nextExpiry > room.expiresAt) {
        room.expiresAt = nextExpiry;
        return true;
      }
    }

    return false;
  }

  private toPublicSnapshot(
    room: CastoraRoom,
    status: 'active' | 'closed' | 'expired' = 'active'
  ): PublicRoomSnapshot {
    const now = Date.now();
    if (room.pendingHostTransfer && now >= room.pendingHostTransfer.expiresAt) {
      room.pendingHostTransfer = null;
    }

    const hostConnected =
      status === 'active' &&
      room.hostConnected &&
      this.isDeviceConnectedOrInGrace(room.hostDeviceId);

    const pendingRequests = Array.from(room.pendingRequests.values()).map((req) => ({
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      platform: req.platform,
      deviceType: req.deviceType,
      pairingMethod: req.pairingMethod,
      connected:
        status === 'active' &&
        req.connected &&
        this.isDeviceConnectedOrInGrace(req.deviceId),
      requestedAt: new Date(req.requestedAt).toISOString(),
      lastSeenAt: new Date(req.lastSeenAt).toISOString(),
      sessionId: req.sessionId,
    }));

    const pairedReceivers = Array.from(room.pairedReceivers.values())
      .sort((a, b) => a.assignedSlotIndex - b.assignedSlotIndex)
      .map((member) => ({
        deviceId: member.deviceId,
        deviceName: member.deviceName,
        platform: member.platform,
        deviceType: member.deviceType,
        connected:
          status === 'active' &&
          member.connected &&
          this.isDeviceConnectedOrInGrace(member.deviceId),
        assignedSlotIndex: member.assignedSlotIndex,
        pairedAt: new Date(member.pairedAt).toISOString(),
        lastSeenAt: new Date(member.lastSeenAt).toISOString(),
        sessionId: member.sessionId,
      }));

    const activeReceiverCount = pairedReceivers.filter((r) => r.connected).length;

    const activeStreams =
      status === 'active'
        ? Array.from(room.activeStreams.values())
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((stream) => ({
              streamId: stream.streamId,
              sessionId: stream.sessionId,
              publisherDeviceId: stream.publisherDeviceId,
              publisherName: stream.publisherName,
              publisherPlatform: stream.publisherPlatform,
              targetDeviceId: stream.targetDeviceId,
              width: stream.width,
              height: stream.height,
              fps: stream.fps,
              codec: stream.codec,
              ...(typeof stream.hasAudio === 'boolean' ? { hasAudio: stream.hasAudio } : {}),
              startedAt: new Date(stream.startedAt).toISOString(),
            }))
        : [];

    const hostTransfer: PublicHostTransfer | null =
      status === 'active' && room.pendingHostTransfer
        ? {
            transferId: room.pendingHostTransfer.transferId,
            fromHostDeviceId: room.pendingHostTransfer.fromHostDeviceId,
            targetDeviceId: room.pendingHostTransfer.targetDeviceId,
            targetDeviceName: room.pendingHostTransfer.targetDeviceName,
            initiatedAt: new Date(room.pendingHostTransfer.initiatedAt).toISOString(),
            expiresAt: new Date(room.pendingHostTransfer.expiresAt).toISOString(),
          }
        : null;

    return {
      roomId: room.roomId,
      roomName: room.roomName,
      privacyMode: room.privacyMode,
      passwordProtected: room.passwordHash !== null,
      hostTransfer,
      status,
      hostDeviceId: room.hostDeviceId,
      hostDeviceName: room.hostDeviceName,
      hostPlatform: room.hostPlatform,
      hostDeviceType: room.hostDeviceType,
      hostConnected,
      hostLastSeenAt: new Date(room.hostLastSeenAt).toISOString(),
      createdAt: new Date(room.createdAt).toISOString(),
      expiresAt: new Date(room.expiresAt).toISOString(),
      maxReceivers: room.maxReceivers,
      activeReceiverCount,
      pairedReceiverCount: pairedReceivers.length,
      pendingCount: pendingRequests.length,
      pendingRequests,
      pairedReceivers,
      activeStreams,
    };
  }

  private hasDuplicateDeviceNameInRoom(
    room: CastoraRoom,
    candidateName: string,
    excludeDeviceId?: string
  ): boolean {
    const normalized = candidateName.trim().toLowerCase();
    if (
      room.hostDeviceId !== excludeDeviceId &&
      room.hostDeviceName.trim().toLowerCase() === normalized
    ) {
      return true;
    }
    for (const member of room.pairedReceivers.values()) {
      if (
        member.deviceId !== excludeDeviceId &&
        member.deviceName.trim().toLowerCase() === normalized
      ) {
        return true;
      }
    }
    for (const req of room.pendingRequests.values()) {
      if (
        req.deviceId !== excludeDeviceId &&
        req.deviceName.trim().toLowerCase() === normalized
      ) {
        return true;
      }
    }
    return false;
  }

  private findNextSlotIndex(room: CastoraRoom): number | null {
    const used = new Set<number>();
    for (const member of room.pairedReceivers.values()) {
      used.add(member.assignedSlotIndex);
    }
    for (let idx = 0; idx < room.maxReceivers; idx += 1) {
      if (!used.has(idx)) {
        return idx;
      }
    }
    return null;
  }

  private getActiveRoomOrError(roomId: string):
    | { ok: true; room: CastoraRoom }
    | { ok: false; code: RoomOperationErrorCode; message: string } {
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: 'Room ID must be 6 uppercase alphanumeric characters',
      };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      return {
        ok: false,
        code: 'ROOM_NOT_FOUND',
        message: 'Room does not exist',
      };
    }

    if (Date.now() >= room.expiresAt) {
      this.rooms.delete(roomId);
      return {
        ok: false,
        code: 'ROOM_EXPIRED',
        message: 'Room has expired',
      };
    }

    return { ok: true, room };
  }

  registerDevice(params: {
    socket: WebSocket;
    remoteAddress: string;
    deviceId: string;
    deviceName: string;
    platform: CastoraPlatform;
    deviceType?: DetectedDeviceType;
    role: CastoraDeviceRole;
    wsPort: number;
    capabilities: DeviceCapabilities;
    roomId: string | null;
    token?: string;
  }): {
    rejected?: boolean;
    message?: string;
    device?: RegisteredDevice;
    authenticatedRoom: PublicRoomSnapshot | null;
    authenticatedRole: 'host' | 'pending' | 'paired' | null;
  } {
    const now = Date.now();
    this.cancelDisconnectGrace(params.deviceId);
    const existing = this.devices.get(params.deviceId);
    const resolvedType = params.deviceType
      ? normalizeDeviceType(params.deviceType)
      : existing?.deviceType ?? 'Unknown';

    let verifiedRoomId: string | null = null;
    let authenticatedRole: 'host' | 'pending' | 'paired' | null = null;

    if (params.roomId && params.token) {
      const lookup = this.getActiveRoomOrError(params.roomId);
      if (lookup.ok) {
        const room = lookup.room;
        if (
          params.deviceId === room.hostDeviceId &&
          verifyToken(params.token, room.hostTokenHash)
        ) {
          room.hostConnected = true;
          room.hostLastSeenAt = now;
          if (room.hostDeviceType === 'Unknown' && resolvedType !== 'Unknown') {
            room.hostDeviceType = resolvedType;
          }
          verifiedRoomId = room.roomId;
          authenticatedRole = 'host';
        } else {
          const paired = room.pairedReceivers.get(params.deviceId);
          if (paired && verifyToken(params.token, paired.tokenHash)) {
            paired.connected = true;
            paired.lastSeenAt = now;
            if (paired.deviceType === 'Unknown' && resolvedType !== 'Unknown') {
              paired.deviceType = resolvedType;
            }
            verifiedRoomId = room.roomId;
            authenticatedRole = 'paired';
          } else {
            const pending = room.pendingRequests.get(params.deviceId);
            if (pending && verifyToken(params.token, pending.tokenHash)) {
              pending.connected = true;
              pending.lastSeenAt = now;
              if (pending.deviceType === 'Unknown' && resolvedType !== 'Unknown') {
                pending.deviceType = resolvedType;
              }
              verifiedRoomId = room.roomId;
              authenticatedRole = 'pending';
            }
          }
        }
      }
    }

    if (
      existing &&
      existing.socket !== params.socket &&
      this.isSocketOpen(existing.socket) &&
      existing.roomId &&
      !verifiedRoomId
    ) {
      return {
        rejected: true,
        message: 'Device ID is currently bound to an authenticated room session',
        authenticatedRoom: null,
        authenticatedRole: null,
      };
    }

    if (existing && existing.socket !== params.socket) {
      this.socketToDeviceId.delete(existing.socket);
    }

    let resolvedRoomDeviceName = params.deviceName;
    if (verifiedRoomId) {
      const authedRoom = this.rooms.get(verifiedRoomId);
      if (authedRoom) {
        if (authenticatedRole === 'host') {
          resolvedRoomDeviceName = authedRoom.hostDeviceName;
        } else if (authenticatedRole === 'paired') {
          resolvedRoomDeviceName =
            authedRoom.pairedReceivers.get(params.deviceId)?.deviceName ?? params.deviceName;
        } else if (authenticatedRole === 'pending') {
          resolvedRoomDeviceName =
            authedRoom.pendingRequests.get(params.deviceId)?.deviceName ?? params.deviceName;
        }
      }
    }

    const record: RegisteredDevice = {
      deviceId: params.deviceId,
      deviceName: resolvedRoomDeviceName,
      platform: params.platform,
      deviceType: resolvedType,
      role: params.role,
      wsPort: params.wsPort,
      capabilities: params.capabilities,
      socket: params.socket,
      remoteAddress: params.remoteAddress,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      roomId: verifiedRoomId,
    };

    this.devices.set(params.deviceId, record);
    this.socketToDeviceId.set(params.socket, params.deviceId);

    const authenticatedRoom =
      verifiedRoomId && this.rooms.has(verifiedRoomId)
        ? this.toPublicSnapshot(this.rooms.get(verifiedRoomId)!)
        : null;

    return { device: record, authenticatedRoom, authenticatedRole };
  }

  isAuthorizedHost(roomId: string, deviceId: string, rawToken?: string): boolean {
    const lookup = this.getActiveRoomOrError(roomId);
    if (!lookup.ok) return false;
    const room = lookup.room;
    if (room.hostDeviceId !== deviceId) return false;
    if (!rawToken) return false;
    return verifyToken(rawToken, room.hostTokenHash);
  }

  verifyAuthorizedMemberSession(params: {
    roomId: string;
    deviceId?: string;
    token: string;
  }):
    | { ok: true; deviceId: string; role: 'host' | 'paired' }
    | { ok: false; code: RoomOperationErrorCode; message: string } {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;
    const room = lookup.room;

    if (
      (!params.deviceId || params.deviceId === room.hostDeviceId) &&
      verifyToken(params.token, room.hostTokenHash)
    ) {
      return { ok: true, deviceId: room.hostDeviceId, role: 'host' };
    }

    if (params.deviceId) {
      const paired = room.pairedReceivers.get(params.deviceId);
      if (paired && verifyToken(params.token, paired.tokenHash)) {
        return { ok: true, deviceId: paired.deviceId, role: 'paired' };
      }
    } else {
      for (const paired of room.pairedReceivers.values()) {
        if (verifyToken(params.token, paired.tokenHash)) {
          return { ok: true, deviceId: paired.deviceId, role: 'paired' };
        }
      }
    }

    return {
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Unauthorized: valid approved room host or member Bearer token required',
    };
  }

  getDeviceBySocket(socket: WebSocket): RegisteredDevice | undefined {
    const id = this.socketToDeviceId.get(socket);
    if (!id) return undefined;
    return this.devices.get(id);
  }

  getDeviceById(deviceId: string): RegisteredDevice | undefined {
    return this.devices.get(deviceId);
  }

  discoverDevices(params: {
    requestedRole: 'sender' | 'receiver' | 'any';
    filterPlatform?: CastoraPlatform | null;
    excludeDeviceId?: string;
  }): RegisteredDevice[] {
    const results: RegisteredDevice[] = [];
    for (const dev of this.devices.values()) {
      if (!this.isSocketOpen(dev.socket)) continue;
      if (params.excludeDeviceId && dev.deviceId === params.excludeDeviceId) continue;
      if (params.filterPlatform && dev.platform !== params.filterPlatform) continue;
      if (
        params.requestedRole !== 'any' &&
        dev.role !== 'both' &&
        dev.role !== params.requestedRole
      ) {
        continue;
      }
      results.push(dev);
    }
    return results;
  }

  touchHeartbeat(socket: WebSocket, nowOverride?: number): RegisteredDevice | undefined {
    const device = this.getDeviceBySocket(socket);
    if (!device) return undefined;
    const now = typeof nowOverride === 'number' ? nowOverride : Date.now();
    device.lastSeenAt = now;

    if (device.roomId) {
      const room = this.rooms.get(device.roomId);
      if (room && room.expiresAt > now) {
        if (room.hostDeviceId === device.deviceId) {
          room.hostConnected = true;
          room.hostLastSeenAt = now;
        } else {
          const paired = room.pairedReceivers.get(device.deviceId);
          if (paired) {
            paired.lastSeenAt = now;
            paired.connected = true;
          }
          const pending = room.pendingRequests.get(device.deviceId);
          if (pending) {
            pending.lastSeenAt = now;
            pending.connected = true;
          }
        }
        this.extendActiveRoomExpiration(room, now, 'heartbeat');
      }
    }
    return device;
  }

  createRoom(params: {
    hostDeviceId: string;
    hostDeviceName: string;
    hostPlatform: CastoraPlatform;
    hostDeviceType?: unknown;
    roomName?: unknown;
    privacyMode?: unknown;
    password?: unknown;
    ttlMs?: number;
  }): CreateRoomResult {
    const nameCheck = normalizeAndValidateDeviceName(params.hostDeviceName);
    if (!nameCheck.ok) {
      return nameCheck;
    }

    const now = Date.now();
    for (const active of this.rooms.values()) {
      if (active.expiresAt > now && active.hostDeviceId === params.hostDeviceId) {
        return {
          ok: false,
          code: 'HOST_ALREADY_HAS_ACTIVE_ROOM',
          message: `Device already hosts active room ${active.roomId}. End that session before creating another room.`,
        };
      }
    }

    let resolvedRoomName: string;
    if (params.roomName !== undefined && params.roomName !== null && params.roomName !== '') {
      const roomNameCheck = normalizeAndValidateRoomName(params.roomName);
      if (!roomNameCheck.ok) {
        return roomNameCheck;
      }
      resolvedRoomName = roomNameCheck.name;
    } else {
      const base = nameCheck.name.slice(0, 48);
      resolvedRoomName = `${base}'s Session`.slice(0, 64);
    }

    let resolvedPrivacy: RoomPrivacyMode = 'approval_required';
    if (params.privacyMode !== undefined && params.privacyMode !== null) {
      const parsedPrivacy = normalizePrivacyMode(params.privacyMode);
      if (!parsedPrivacy) {
        return {
          ok: false,
          code: 'INVALID_PRIVACY_MODE',
          message: 'Privacy mode must be private, approval_required, or open',
        };
      }
      resolvedPrivacy = parsedPrivacy;
    }

    let passwordHash: string | null = null;
    if (params.password !== undefined && params.password !== null && params.password !== '') {
      const pwdCheck = normalizeAndValidateRoomPassword(params.password);
      if (!pwdCheck.ok) {
        return {
          ok: false,
          code: 'INVALID_ROOM_PASSWORD',
          message: pwdCheck.message,
        };
      }
      passwordHash = hashRoomPassword(pwdCheck.password);
    }

    let roomId = generateRoomCode();
    let attempts = 0;
    while (this.rooms.has(roomId) && attempts < 20) {
      roomId = generateRoomCode();
      attempts += 1;
    }

    const ttl =
      typeof params.ttlMs === 'number' && Number.isFinite(params.ttlMs)
        ? this.clampTtl(params.ttlMs)
        : this.defaultTtlMs;

    const hostToken = generateSessionToken();
    const hostTokenHash = hashToken(hostToken);
    const inviteCode = generateInviteCode();
    const hostSocketConnected = this.hasOpenSocket(params.hostDeviceId);
    const hostDevice = this.devices.get(params.hostDeviceId);
    const hostDeviceType =
      params.hostDeviceType !== undefined
        ? normalizeDeviceType(params.hostDeviceType)
        : hostDevice?.deviceType ?? 'Unknown';

    const room: CastoraRoom = {
      roomId,
      roomName: resolvedRoomName,
      privacyMode: resolvedPrivacy,
      passwordHash,
      inviteCode,
      pendingHostTransfer: null,
      hostDeviceId: params.hostDeviceId,
      hostDeviceName: nameCheck.name,
      hostPlatform: params.hostPlatform,
      hostDeviceType,
      hostTokenHash,
      hostConnected: hostSocketConnected,
      hostLastSeenAt: now,
      createdAt: now,
      expiresAt: now + ttl,
      ttlMs: ttl,
      maxReceivers: MAX_RECEIVERS_PER_ROOM,
      pendingRequests: new Map(),
      pairedReceivers: new Map(),
      activeStreams: new Map(),
    };

    this.rooms.set(roomId, room);

    if (hostDevice && this.isSocketOpen(hostDevice.socket)) {
      hostDevice.roomId = roomId;
      hostDevice.deviceName = nameCheck.name;
      if (hostDeviceType !== 'Unknown') {
        hostDevice.deviceType = hostDeviceType;
      }
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      hostToken,
      inviteCode,
    };
  }

  getRoom(roomId: string): RoomLookupResult {
    const lookup = this.getActiveRoomOrError(roomId);
    if (!lookup.ok) {
      return lookup;
    }
    return {
      ok: true,
      room: this.toPublicSnapshot(lookup.room),
    };
  }

  submitPairRequest(params: {
    roomId: string;
    receiverDeviceId: string;
    deviceName: string;
    platform: CastoraPlatform;
    deviceType?: unknown;
    pairingMethod?: PairingMethod;
    inviteCode?: string;
    password?: string;
    beforePasswordVerify?: () => boolean;
    onPasswordFailure?: () => void;
  }): SubmitPairRequestResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const nameCheck = normalizeAndValidateDeviceName(params.deviceName);
    if (!nameCheck.ok) {
      return nameCheck;
    }

    const room = lookup.room;
    const now = Date.now();

    if (params.receiverDeviceId === room.hostDeviceId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Host device cannot submit a receiver pairing request to its own room',
      };
    }

    const suppliedInvite =
      typeof params.inviteCode === 'string' ? params.inviteCode.trim() : '';

    if (room.privacyMode === 'private') {
      if (!suppliedInvite) {
        return {
          ok: false,
          code: 'INVITATION_REQUIRED',
          message: 'This room is Private. A valid room invitation link is required to join.',
        };
      }
      if (!verifyConstantTimeSecret(suppliedInvite, room.inviteCode)) {
        return {
          ok: false,
          code: 'INVALID_INVITATION',
          message: 'Invalid or revoked room invitation link.',
        };
      }
    } else if (suppliedInvite && !verifyConstantTimeSecret(suppliedInvite, room.inviteCode)) {
      return {
        ok: false,
        code: 'INVALID_INVITATION',
        message: 'Invalid or revoked room invitation link.',
      };
    }

    if (room.passwordHash !== null) {
      if (params.beforePasswordVerify && !params.beforePasswordVerify()) {
        return {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Too many invalid password attempts for this room. Wait before retrying.',
        };
      }
      const candidatePwd = typeof params.password === 'string' ? params.password : '';
      if (!candidatePwd || !verifyRoomPassword(candidatePwd, room.passwordHash)) {
        params.onPasswordFailure?.();
        return {
          ok: false,
          code: 'INVALID_ROOM_PASSWORD',
          message: candidatePwd
            ? 'Incorrect room password.'
            : 'This room requires a password to join.',
        };
      }
    }

    if (room.pairedReceivers.has(params.receiverDeviceId)) {
      return {
        ok: false,
        code: 'ALREADY_PAIRED',
        message: 'This device is already paired in the room',
      };
    }

    if (room.pendingRequests.has(params.receiverDeviceId)) {
      return {
        ok: false,
        code: 'DUPLICATE_PAIR_REQUEST',
        message: 'A pairing request for this device is already awaiting host approval',
      };
    }

    if (this.hasDuplicateDeviceNameInRoom(room, nameCheck.name, params.receiverDeviceId)) {
      return {
        ok: false,
        code: 'DUPLICATE_DEVICE_NAME',
        message: `Device name "${nameCheck.name}" is already in use in this room. Choose a unique device name.`,
      };
    }

    if (room.pairedReceivers.size >= room.maxReceivers) {
      return {
        ok: false,
        code: 'ROOM_CAPACITY_REACHED',
        message: `Room capacity reached (${room.maxReceivers} paired receivers maximum)`,
      };
    }

    const memberToken = generateSessionToken();
    const sessionId = `sess-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const dev = this.devices.get(params.receiverDeviceId);
    const resolvedType =
      params.deviceType !== undefined
        ? normalizeDeviceType(params.deviceType)
        : dev?.deviceType ?? 'Unknown';

    if (room.privacyMode === 'open') {
      const slotIndex = this.findNextSlotIndex(room);
      if (slotIndex === null) {
        return {
          ok: false,
          code: 'ROOM_CAPACITY_REACHED',
          message: `Room capacity reached (${room.maxReceivers} paired receivers maximum)`,
        };
      }

      const paired: PairedReceiverMember = {
        deviceId: params.receiverDeviceId,
        deviceName: nameCheck.name,
        platform: params.platform,
        deviceType: resolvedType,
        tokenHash: hashToken(memberToken),
        connected: this.hasOpenSocket(params.receiverDeviceId),
        assignedSlotIndex: slotIndex,
        pairedAt: now,
        lastSeenAt: now,
        sessionId,
      };
      room.pairedReceivers.set(paired.deviceId, paired);

      if (dev && this.isSocketOpen(dev.socket)) {
        dev.roomId = room.roomId;
        dev.deviceName = nameCheck.name;
        if (resolvedType !== 'Unknown') {
          dev.deviceType = resolvedType;
        }
      }

      return {
        ok: true,
        room: this.toPublicSnapshot(room),
        memberToken,
        sessionId,
        requestStatus: 'paired',
        assignedSlotIndex: slotIndex,
      };
    }

    const pending: PendingPairRequest = {
      deviceId: params.receiverDeviceId,
      deviceName: nameCheck.name,
      platform: params.platform,
      deviceType: resolvedType,
      pairingMethod: params.pairingMethod ?? (suppliedInvite ? 'qr' : 'room_code'),
      tokenHash: hashToken(memberToken),
      connected: this.hasOpenSocket(params.receiverDeviceId),
      requestedAt: now,
      lastSeenAt: now,
      sessionId,
    };

    room.pendingRequests.set(params.receiverDeviceId, pending);

    if (dev && this.isSocketOpen(dev.socket)) {
      dev.roomId = room.roomId;
      dev.deviceName = nameCheck.name;
      if (resolvedType !== 'Unknown') {
        dev.deviceType = resolvedType;
      }
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      memberToken,
      sessionId,
      requestStatus: 'pending_approval',
    };
  }

  approvePairRequest(params: {
    roomId: string;
    receiverDeviceId: string;
    hostToken: string;
  }): ApprovePairResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid host token required to approve receivers',
      };
    }

    if (room.pairedReceivers.has(params.receiverDeviceId)) {
      return {
        ok: false,
        code: 'ALREADY_PAIRED',
        message: 'Receiver is already paired',
      };
    }

    const pending = room.pendingRequests.get(params.receiverDeviceId);
    if (!pending) {
      return {
        ok: false,
        code: 'REQUEST_NOT_FOUND',
        message: 'No pending pairing request found for this receiver',
      };
    }

    if (room.pairedReceivers.size >= room.maxReceivers) {
      return {
        ok: false,
        code: 'ROOM_CAPACITY_REACHED',
        message: `Room capacity reached (${room.maxReceivers} paired receivers maximum)`,
      };
    }

    const slotIndex = this.findNextSlotIndex(room);
    if (slotIndex === null) {
      return {
        ok: false,
        code: 'ROOM_CAPACITY_REACHED',
        message: `Room capacity reached (${room.maxReceivers} paired receivers maximum)`,
      };
    }

    const now = Date.now();
    room.pendingRequests.delete(params.receiverDeviceId);

    const paired: PairedReceiverMember = {
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      platform: pending.platform,
      deviceType: pending.deviceType,
      tokenHash: pending.tokenHash,
      connected: this.hasOpenSocket(pending.deviceId),
      assignedSlotIndex: slotIndex,
      pairedAt: now,
      lastSeenAt: now,
      sessionId: pending.sessionId,
    };

    room.pairedReceivers.set(paired.deviceId, paired);

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      approved: paired,
      receiverSocket: this.getOpenSocket(paired.deviceId),
    };
  }

  rejectPairRequest(params: {
    roomId: string;
    receiverDeviceId: string;
    hostToken: string;
    reason?: string;
  }): RejectPairResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid host token required to reject receivers',
      };
    }

    const pending = room.pendingRequests.get(params.receiverDeviceId);
    if (!pending) {
      return {
        ok: false,
        code: 'REQUEST_NOT_FOUND',
        message: 'No pending pairing request found for this receiver',
      };
    }

    room.pendingRequests.delete(params.receiverDeviceId);
    const dev = this.devices.get(params.receiverDeviceId);
    if (dev && dev.roomId === room.roomId) {
      dev.roomId = null;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      rejected: pending,
      reason: params.reason?.trim().slice(0, 128) || 'Host declined pairing request',
      receiverSocket: this.getOpenSocket(pending.deviceId),
    };
  }

  removePairedReceiver(params: {
    roomId: string;
    receiverDeviceId: string;
    hostToken: string;
  }): RemoveReceiverResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid host token required to remove a receiver',
      };
    }

    const paired = room.pairedReceivers.get(params.receiverDeviceId);
    if (!paired) {
      return {
        ok: false,
        code: 'RECEIVER_NOT_FOUND',
        message: 'Receiver is not paired in this room',
      };
    }

    room.pairedReceivers.delete(params.receiverDeviceId);
    if (room.pendingHostTransfer?.targetDeviceId === params.receiverDeviceId) {
      room.pendingHostTransfer = null;
    }
    const terminatedStreams = this.cleanupStreamsForParticipant(room, params.receiverDeviceId);
    const dev = this.devices.get(params.receiverDeviceId);
    if (dev && dev.roomId === room.roomId) {
      dev.roomId = null;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      removedDeviceId: params.receiverDeviceId,
      removedSocket: this.getOpenSocket(params.receiverDeviceId),
      terminatedStreams,
    };
  }

  leaveRoom(params: {
    roomId: string;
    deviceId: string;
    memberToken: string;
  }): LeaveRoomResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    const paired = room.pairedReceivers.get(params.deviceId);
    const pending = room.pendingRequests.get(params.deviceId);

    const tokenHash = paired?.tokenHash ?? pending?.tokenHash;
    if (!tokenHash || !verifyToken(params.memberToken, tokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid receiver token required to leave room',
      };
    }

    room.pairedReceivers.delete(params.deviceId);
    room.pendingRequests.delete(params.deviceId);
    if (room.pendingHostTransfer?.targetDeviceId === params.deviceId) {
      room.pendingHostTransfer = null;
    }
    const terminatedStreams = this.cleanupStreamsForParticipant(room, params.deviceId);

    const dev = this.devices.get(params.deviceId);
    if (dev && dev.roomId === room.roomId) {
      dev.roomId = null;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      terminatedStreams,
    };
  }

  closeRoom(roomId: string, hostToken: string): {
    ok: boolean;
    code?: RoomOperationErrorCode;
    message?: string;
    closedSnapshot?: PublicRoomSnapshot;
    affectedSockets: WebSocket[];
  } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, code: 'ROOM_NOT_FOUND', message: 'Room not found', affectedSockets: [] };
    }
    if (!verifyToken(hostToken, room.hostTokenHash)) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid host token', affectedSockets: [] };
    }

    const closedSnapshot = this.toPublicSnapshot(room, 'closed');
    const affectedSockets = this.getAllRoomSockets(room);

    for (const sock of affectedSockets) {
      const dev = this.getDeviceBySocket(sock);
      if (dev && dev.roomId === roomId) {
        dev.roomId = null;
      }
    }

    this.rooms.delete(roomId);
    return { ok: true, closedSnapshot, affectedSockets };
  }

  renameRoom(params: {
    roomId: string;
    roomName: unknown;
    hostToken: string;
  }): RoomSettingsUpdateResult {
    return this.updateRoomSettings({
      roomId: params.roomId,
      hostToken: params.hostToken,
      roomName: params.roomName,
    });
  }

  updateRoomSettings(params: {
    roomId: string;
    hostToken: string;
    roomName?: unknown;
    privacyMode?: unknown;
    password?: unknown;
  }): RoomSettingsUpdateResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid host Bearer token required to update room settings',
      };
    }

    let nextRoomName = room.roomName;
    if (params.roomName !== undefined) {
      const nameCheck = normalizeAndValidateRoomName(params.roomName);
      if (!nameCheck.ok) return nameCheck;
      nextRoomName = nameCheck.name;
    }

    let nextPrivacy = room.privacyMode;
    if (params.privacyMode !== undefined) {
      const parsedPrivacy = normalizePrivacyMode(params.privacyMode);
      if (!parsedPrivacy) {
        return {
          ok: false,
          code: 'INVALID_PRIVACY_MODE',
          message: 'Privacy mode must be private, approval_required, or open',
        };
      }
      nextPrivacy = parsedPrivacy;
    }

    let nextPasswordHash = room.passwordHash;
    if (params.password !== undefined) {
      if (params.password === null || params.password === '') {
        nextPasswordHash = null;
      } else {
        const pwdCheck = normalizeAndValidateRoomPassword(params.password);
        if (!pwdCheck.ok) {
          return {
            ok: false,
            code: 'INVALID_ROOM_PASSWORD',
            message: pwdCheck.message,
          };
        }
        nextPasswordHash = hashRoomPassword(pwdCheck.password);
      }
    }

    room.roomName = nextRoomName;
    room.privacyMode = nextPrivacy;
    room.passwordHash = nextPasswordHash;
    room.hostLastSeenAt = Date.now();

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
    };
  }

  getRoomInvitation(params: {
    roomId: string;
    hostToken: string;
  }): RoomInvitationResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid host Bearer token required to view room invitation',
      };
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      inviteCode: room.inviteCode,
      privacyMode: room.privacyMode,
      passwordProtected: room.passwordHash !== null,
    };
  }

  rotateRoomInvitation(params: {
    roomId: string;
    hostToken: string;
  }): RoomInvitationResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid host Bearer token required to regenerate invitation link',
      };
    }

    room.inviteCode = generateInviteCode();
    room.hostLastSeenAt = Date.now();

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      inviteCode: room.inviteCode,
      privacyMode: room.privacyMode,
      passwordProtected: room.passwordHash !== null,
    };
  }

  validateInvitation(params: {
    roomId: string;
    inviteCode?: string;
  }): InvitationValidationResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    const supplied = typeof params.inviteCode === 'string' ? params.inviteCode.trim() : '';
    const inviteValid = supplied.length > 0 && verifyConstantTimeSecret(supplied, room.inviteCode);

    if (room.privacyMode === 'private' && !supplied) {
      return {
        ok: false,
        code: 'INVITATION_REQUIRED',
        message: 'This room is Private and requires a valid invitation link.',
      };
    }

    if (supplied && !inviteValid) {
      return {
        ok: false,
        code: 'INVALID_INVITATION',
        message: 'Invalid or revoked room invitation link.',
      };
    }

    const availableSlots = Math.max(0, room.maxReceivers - room.pairedReceivers.size);
    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      inviteValid: supplied ? inviteValid : room.privacyMode !== 'private',
      canRequestJoin: availableSlots > 0,
      availableSlots,
    };
  }

  restoreAuthenticatedSession(params: {
    roomId: string;
    token: string;
  }): SessionRestoreResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (verifyToken(params.token, room.hostTokenHash)) {
      room.hostLastSeenAt = Date.now();
      return {
        ok: true,
        room: this.toPublicSnapshot(room),
        deviceId: room.hostDeviceId,
        role: 'host',
        inviteCode: room.inviteCode,
      };
    }

    for (const paired of room.pairedReceivers.values()) {
      if (verifyToken(params.token, paired.tokenHash)) {
        paired.lastSeenAt = Date.now();
        return {
          ok: true,
          room: this.toPublicSnapshot(room),
          deviceId: paired.deviceId,
          role: 'paired',
        };
      }
    }

    for (const pending of room.pendingRequests.values()) {
      if (verifyToken(params.token, pending.tokenHash)) {
        pending.lastSeenAt = Date.now();
        return {
          ok: true,
          room: this.toPublicSnapshot(room),
          deviceId: pending.deviceId,
          role: 'pending',
        };
      }
    }

    return {
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Session authentication expired or invalid.',
    };
  }

  initiateHostTransfer(params: {
    roomId: string;
    hostToken: string;
    targetDeviceId: string;
  }): InitiateHostTransferResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: only the current room host can initiate host transfer',
      };
    }

    const now = Date.now();
    if (room.pendingHostTransfer && now < room.pendingHostTransfer.expiresAt) {
      return {
        ok: false,
        code: 'HOST_TRANSFER_IN_PROGRESS',
        message: `A host transfer to ${room.pendingHostTransfer.targetDeviceName} is already pending.`,
      };
    }
    room.pendingHostTransfer = null;

    if (params.targetDeviceId === room.hostDeviceId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Device is already the room host.',
      };
    }

    const target = room.pairedReceivers.get(params.targetDeviceId);
    if (!target) {
      return {
        ok: false,
        code: 'RECEIVER_NOT_FOUND',
        message: 'Target participant must be paired in this room before receiving host role.',
      };
    }

    if (!target.connected || !this.hasOpenSocket(target.deviceId)) {
      return {
        ok: false,
        code: 'RECEIVER_DISCONNECTED',
        message: 'Target participant must be connected to accept a host transfer.',
      };
    }

    const transfer = {
      transferId: `xfer-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      fromHostDeviceId: room.hostDeviceId,
      targetDeviceId: target.deviceId,
      targetDeviceName: target.deviceName,
      initiatedAt: now,
      expiresAt: now + HOST_TRANSFER_TTL_MS,
    };
    room.pendingHostTransfer = transfer;
    room.hostLastSeenAt = now;

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      transfer: {
        transferId: transfer.transferId,
        fromHostDeviceId: transfer.fromHostDeviceId,
        targetDeviceId: transfer.targetDeviceId,
        targetDeviceName: transfer.targetDeviceName,
        initiatedAt: new Date(transfer.initiatedAt).toISOString(),
        expiresAt: new Date(transfer.expiresAt).toISOString(),
      },
    };
  }

  cancelHostTransfer(params: {
    roomId: string;
    hostToken: string;
  }): RoomSettingsUpdateResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    if (!verifyToken(params.hostToken, room.hostTokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: only the current room host can cancel a pending transfer',
      };
    }

    room.pendingHostTransfer = null;
    room.hostLastSeenAt = Date.now();
    return {
      ok: true,
      room: this.toPublicSnapshot(room),
    };
  }

  respondHostTransfer(params: {
    roomId: string;
    token: string;
    accept: boolean;
  }): RespondHostTransferResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    const pending = room.pendingHostTransfer;
    if (!pending) {
      return {
        ok: false,
        code: 'TRANSFER_NOT_FOUND',
        message: 'No pending host transfer exists for this room.',
      };
    }

    const now = Date.now();
    if (now >= pending.expiresAt) {
      room.pendingHostTransfer = null;
      return {
        ok: false,
        code: 'TRANSFER_EXPIRED',
        message: 'The host transfer request has expired.',
      };
    }

    const targetMember = room.pairedReceivers.get(pending.targetDeviceId);
    if (!targetMember || !verifyToken(params.token, targetMember.tokenHash)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: only the designated target participant can respond to this host transfer.',
      };
    }

    if (!params.accept) {
      room.pendingHostTransfer = null;
      targetMember.lastSeenAt = now;
      return {
        ok: true,
        room: this.toPublicSnapshot(room),
        accepted: false,
        newHostDeviceId: room.hostDeviceId,
      };
    }

    // Atomic ownership & permission swap preserving receiver slot count & live streams
    const oldHostSnapshot = {
      deviceId: room.hostDeviceId,
      deviceName: room.hostDeviceName,
      platform: room.hostPlatform,
      deviceType: room.hostDeviceType,
      tokenHash: room.hostTokenHash,
      connected: this.hasOpenSocket(room.hostDeviceId),
    };

    room.pairedReceivers.delete(targetMember.deviceId);
    room.pairedReceivers.set(oldHostSnapshot.deviceId, {
      deviceId: oldHostSnapshot.deviceId,
      deviceName: oldHostSnapshot.deviceName,
      platform: oldHostSnapshot.platform,
      deviceType: oldHostSnapshot.deviceType,
      tokenHash: oldHostSnapshot.tokenHash,
      connected: oldHostSnapshot.connected,
      assignedSlotIndex: targetMember.assignedSlotIndex,
      pairedAt: now,
      lastSeenAt: now,
      sessionId: targetMember.sessionId,
    });

    room.hostDeviceId = targetMember.deviceId;
    room.hostDeviceName = targetMember.deviceName;
    room.hostPlatform = targetMember.platform;
    room.hostDeviceType = targetMember.deviceType;
    room.hostTokenHash = targetMember.tokenHash;
    room.hostConnected = this.hasOpenSocket(targetMember.deviceId);
    room.hostLastSeenAt = now;
    room.pendingHostTransfer = null;

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      accepted: true,
      newHostDeviceId: room.hostDeviceId,
    };
  }

  renameRoomDevice(params: {
    roomId: string;
    targetDeviceId: string;
    newName: string;
    token: string;
  }): RenameDeviceResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const nameCheck = normalizeAndValidateDeviceName(params.newName);
    if (!nameCheck.ok) return nameCheck;

    const room = lookup.room;
    const isHostToken = verifyToken(params.token, room.hostTokenHash);
    let actorDeviceId: string | null = isHostToken ? room.hostDeviceId : null;

    if (!actorDeviceId) {
      for (const paired of room.pairedReceivers.values()) {
        if (verifyToken(params.token, paired.tokenHash)) {
          actorDeviceId = paired.deviceId;
          break;
        }
      }
    }
    if (!actorDeviceId) {
      for (const pending of room.pendingRequests.values()) {
        if (verifyToken(params.token, pending.tokenHash)) {
          actorDeviceId = pending.deviceId;
          break;
        }
      }
    }

    if (!actorDeviceId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: valid room session Bearer token required to rename a device',
      };
    }

    if (params.targetDeviceId !== actorDeviceId && !isHostToken) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: only the room host may rename another participant device',
      };
    }

    const isHostTarget = params.targetDeviceId === room.hostDeviceId;
    const pairedTarget = room.pairedReceivers.get(params.targetDeviceId);
    const pendingTarget = room.pendingRequests.get(params.targetDeviceId);

    if (!isHostTarget && !pairedTarget && !pendingTarget) {
      return {
        ok: false,
        code: 'RECEIVER_NOT_FOUND',
        message: 'Target device is not in this room',
      };
    }

    if (this.hasDuplicateDeviceNameInRoom(room, nameCheck.name, params.targetDeviceId)) {
      return {
        ok: false,
        code: 'DUPLICATE_DEVICE_NAME',
        message: `Device name "${nameCheck.name}" is already in use in this room`,
      };
    }

    const now = Date.now();
    if (isHostTarget) {
      room.hostDeviceName = nameCheck.name;
      room.hostLastSeenAt = now;
    } else if (pairedTarget) {
      pairedTarget.deviceName = nameCheck.name;
      pairedTarget.lastSeenAt = now;
    } else if (pendingTarget) {
      pendingTarget.deviceName = nameCheck.name;
      pendingTarget.lastSeenAt = now;
    }

    const registered = this.devices.get(params.targetDeviceId);
    if (registered) {
      registered.deviceName = nameCheck.name;
      registered.lastSeenAt = now;
    }

    for (const stream of room.activeStreams.values()) {
      if (stream.publisherDeviceId === params.targetDeviceId) {
        stream.publisherName = nameCheck.name;
      }
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      targetDeviceId: params.targetDeviceId,
      deviceName: nameCheck.name,
    };
  }

  stopStreamByControl(params: {
    roomId: string;
    publisherDeviceId: string;
    streamTargetDeviceId?: string;
    token: string;
  }): StopStreamControlResult {
    const auth = this.verifyAuthorizedMemberSession({
      roomId: params.roomId,
      token: params.token,
    });
    if (!auth.ok) return auth;

    if (auth.role !== 'host' && auth.deviceId !== params.publisherDeviceId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: only the room host or stream owner may stop this stream',
      };
    }

    const room = this.rooms.get(params.roomId)!;
    if (
      params.publisherDeviceId !== room.hostDeviceId &&
      !room.pairedReceivers.has(params.publisherDeviceId)
    ) {
      return {
        ok: false,
        code: 'RECEIVER_NOT_FOUND',
        message: 'Target device is not an approved member of this room',
      };
    }

    const terminatedStreams: TerminatedStreamNotice[] = [];
    for (const [key, stream] of room.activeStreams.entries()) {
      if (
        stream.publisherDeviceId === params.publisherDeviceId &&
        (!params.streamTargetDeviceId || stream.targetDeviceId === params.streamTargetDeviceId)
      ) {
        room.activeStreams.delete(key);
        terminatedStreams.push({
          streamId: stream.streamId,
          sessionId: stream.sessionId,
          publisherDeviceId: stream.publisherDeviceId,
          targetDeviceId: stream.targetDeviceId,
          targetSocket: this.getOpenSocket(stream.targetDeviceId),
        });
      }
    }

    const now = Date.now();
    if (auth.deviceId === room.hostDeviceId) {
      room.hostLastSeenAt = now;
    } else {
      const actorMember = room.pairedReceivers.get(auth.deviceId);
      if (actorMember) actorMember.lastSeenAt = now;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      publisherDeviceId: params.publisherDeviceId,
      publisherSocket: this.getOpenSocket(params.publisherDeviceId),
      terminatedStreams,
    };
  }

  authorizeDeviceReconnect(params: {
    roomId: string;
    targetDeviceId: string;
    token: string;
  }): ReconnectDeviceControlResult {
    const auth = this.verifyAuthorizedMemberSession({
      roomId: params.roomId,
      token: params.token,
    });
    if (!auth.ok) return auth;

    if (auth.role !== 'host' && auth.deviceId !== params.targetDeviceId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: only the room host may remotely reconnect another device',
      };
    }

    const room = this.rooms.get(params.roomId)!;
    const isMember =
      params.targetDeviceId === room.hostDeviceId ||
      room.pairedReceivers.has(params.targetDeviceId);
    if (!isMember) {
      return {
        ok: false,
        code: 'RECEIVER_NOT_FOUND',
        message: 'Target device is not a member of this room',
      };
    }

    const now = Date.now();
    if (params.targetDeviceId === room.hostDeviceId) {
      room.hostLastSeenAt = now;
    } else {
      const targetMember = room.pairedReceivers.get(params.targetDeviceId);
      if (targetMember) targetMember.lastSeenAt = now;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      targetDeviceId: params.targetDeviceId,
      targetSocket: this.getOpenSocket(params.targetDeviceId),
      requestedByHost: auth.role === 'host' && auth.deviceId !== params.targetDeviceId,
    };
  }

  private getAllRoomSockets(room: CastoraRoom, excludeDeviceId?: string): WebSocket[] {
    const sockets: WebSocket[] = [];
    const seen = new Set<WebSocket>();

    const candidateIds = [
      room.hostDeviceId,
      ...Array.from(room.pendingRequests.keys()),
      ...Array.from(room.pairedReceivers.keys()),
    ];

    for (const id of candidateIds) {
      if (excludeDeviceId && id === excludeDeviceId) continue;
      const sock = this.getOpenSocket(id);
      if (sock && !seen.has(sock)) {
        seen.add(sock);
        sockets.push(sock);
      }
    }

    return sockets;
  }

  getRoomMemberSockets(roomId: string, excludeDeviceId?: string): WebSocket[] {
    const room = this.rooms.get(roomId);
    if (!room || Date.now() >= room.expiresAt) return [];
    return this.getAllRoomSockets(room, excludeDeviceId);
  }

  verifyRoomPeerAccess(roomId: string, senderDeviceId: string, targetDeviceId: string | null): boolean {
    const room = this.rooms.get(roomId);
    if (!room || Date.now() >= room.expiresAt) return false;
    const isSenderInRoom =
      room.hostDeviceId === senderDeviceId || room.pairedReceivers.has(senderDeviceId);
    if (!isSenderInRoom) return false;
    if (targetDeviceId) {
      const isTargetInRoom =
        room.hostDeviceId === targetDeviceId || room.pairedReceivers.has(targetDeviceId);
      if (!isTargetInRoom) return false;
    }
    return true;
  }

  authorizePeerSignaling(params: {
    socket: WebSocket;
    roomId: string | null;
    senderDeviceId: string;
    targetDeviceId: string | null;
    token?: string;
  }): PeerSignalingAuthResult {
    if (!params.roomId || !params.targetDeviceId) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: 'Signaling message requires non-null roomId and receiverDeviceId',
      };
    }

    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: lookup.message,
      };
    }
    const room = lookup.room;

    const senderDev = this.devices.get(params.senderDeviceId);
    if (!senderDev || senderDev.socket !== params.socket || senderDev.roomId !== room.roomId) {
      return {
        ok: false,
        code: 'APPROVAL_DECLINED',
        message: 'Unauthorized: socket is not authenticated in this room',
      };
    }

    if (!params.token) {
      return {
        ok: false,
        code: 'APPROVAL_DECLINED',
        message: 'Unauthorized: missing room session token',
      };
    }

    let senderAuthorized = false;
    if (params.senderDeviceId === room.hostDeviceId) {
      senderAuthorized = verifyToken(params.token, room.hostTokenHash);
    } else {
      const pairedMember = room.pairedReceivers.get(params.senderDeviceId);
      if (pairedMember) {
        senderAuthorized = verifyToken(params.token, pairedMember.tokenHash);
      }
    }

    if (!senderAuthorized) {
      return {
        ok: false,
        code: 'APPROVAL_DECLINED',
        message: 'Unauthorized: approved paired membership or host token required for WebRTC signaling',
      };
    }

    if (params.targetDeviceId === params.senderDeviceId) {
      return {
        ok: false,
        code: 'WEBRTC_NEGOTIATION_FAILED',
        message: 'Target receiver cannot be the same as sender',
      };
    }

    const targetIsHost = params.targetDeviceId === room.hostDeviceId;
    const targetIsPaired = room.pairedReceivers.has(params.targetDeviceId);
    if (!targetIsHost && !targetIsPaired) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: 'Target peer does not belong to this paired room',
      };
    }

    const targetDev = this.devices.get(params.targetDeviceId);
    if (!targetDev || targetDev.roomId !== room.roomId || !this.isSocketOpen(targetDev.socket)) {
      return {
        ok: false,
        code: 'WEBRTC_NEGOTIATION_FAILED',
        message: `Target peer ${params.targetDeviceId} is currently disconnected`,
      };
    }

    const now = Date.now();
    senderDev.lastSeenAt = now;
    if (params.senderDeviceId === room.hostDeviceId) {
      room.hostLastSeenAt = now;
    } else {
      const senderMember = room.pairedReceivers.get(params.senderDeviceId);
      if (senderMember) {
        senderMember.lastSeenAt = now;
      }
    }

    return {
      ok: true,
      targetSocket: targetDev.socket,
    };
  }

  private getAuthorizedMemberSockets(room: CastoraRoom, excludeDeviceId?: string): WebSocket[] {
    const sockets: WebSocket[] = [];
    const seen = new Set<WebSocket>();

    const candidateIds = [room.hostDeviceId, ...Array.from(room.pairedReceivers.keys())];
    for (const id of candidateIds) {
      if (excludeDeviceId && id === excludeDeviceId) continue;
      const sock = this.getOpenSocket(id);
      if (sock && !seen.has(sock)) {
        seen.add(sock);
        sockets.push(sock);
      }
    }
    return sockets;
  }

  private resolveAuthenticatedMemberIdentity(
    room: CastoraRoom,
    deviceId: string
  ): { deviceName: string; platform: CastoraPlatform } | null {
    if (deviceId === room.hostDeviceId) {
      return {
        deviceName: room.hostDeviceName,
        platform: room.hostPlatform,
      };
    }
    const paired = room.pairedReceivers.get(deviceId);
    if (paired) {
      return {
        deviceName: paired.deviceName,
        platform: paired.platform,
      };
    }
    return null;
  }

  private streamLinkKey(publisherDeviceId: string, targetDeviceId: string): string {
    return `${publisherDeviceId}=>${targetDeviceId}`;
  }

  private cleanupStreamsForParticipant(
    room: CastoraRoom,
    deviceId: string
  ): TerminatedStreamNotice[] {
    const notices: TerminatedStreamNotice[] = [];
    for (const [key, stream] of room.activeStreams.entries()) {
      if (stream.publisherDeviceId === deviceId || stream.targetDeviceId === deviceId) {
        room.activeStreams.delete(key);
        if (stream.publisherDeviceId === deviceId) {
          notices.push({
            streamId: stream.streamId,
            sessionId: stream.sessionId,
            publisherDeviceId: stream.publisherDeviceId,
            targetDeviceId: stream.targetDeviceId,
            targetSocket: this.getOpenSocket(stream.targetDeviceId),
          });
        }
      }
    }
    return notices;
  }

  registerStreamStart(params: {
    socket: WebSocket;
    roomId: string | null;
    senderDeviceId: string;
    targetDeviceId: string | null;
    token?: string;
    sessionId: string;
    streamId: string;
    width: number;
    height: number;
    fps: number;
    codec: CastoraVideoCodec;
  }): StreamRegistrationResult {
    const auth = this.authorizePeerSignaling({
      socket: params.socket,
      roomId: params.roomId,
      senderDeviceId: params.senderDeviceId,
      targetDeviceId: params.targetDeviceId,
      token: params.token,
    });
    if (!auth.ok) return auth;

    const room = this.rooms.get(params.roomId!)!;
    const identity = this.resolveAuthenticatedMemberIdentity(room, params.senderDeviceId);
    if (!identity) {
      return {
        ok: false,
        code: 'APPROVAL_DECLINED',
        message: 'Unauthorized: publisher is not an authenticated member of this room',
      };
    }

    for (const existing of room.activeStreams.values()) {
      if (existing.streamId === params.streamId && existing.publisherDeviceId !== params.senderDeviceId) {
        return {
          ok: false,
          code: 'APPROVAL_DECLINED',
          message: 'Unauthorized: streamId is bound to another authenticated publisher',
        };
      }
    }

    const now = Date.now();
    const senderDevice = this.devices.get(params.senderDeviceId);
    if (params.senderDeviceId === room.hostDeviceId) {
      room.hostLastSeenAt = now;
    } else {
      const senderMember = room.pairedReceivers.get(params.senderDeviceId);
      if (senderMember) senderMember.lastSeenAt = now;
    }

    const linkKey = this.streamLinkKey(params.senderDeviceId, params.targetDeviceId!);
    const record: ActiveRoomStream = {
      streamId: params.streamId,
      sessionId: params.sessionId,
      publisherDeviceId: params.senderDeviceId,
      publisherName: identity.deviceName,
      publisherPlatform: identity.platform,
      targetDeviceId: params.targetDeviceId!,
      width: params.width,
      height: params.height,
      fps: params.fps,
      codec: params.codec,
      ...(senderDevice ? { hasAudio: senderDevice.capabilities.supportsAudio } : {}),
      startedAt: now,
    };
    room.activeStreams.set(linkKey, record);
    this.extendActiveRoomExpiration(room, now, 'stream');

    return {
      ok: true,
      targetSocket: auth.targetSocket,
      room: this.toPublicSnapshot(room),
      authorizedSockets: this.getAuthorizedMemberSockets(room),
    };
  }

  registerStreamStop(params: {
    socket: WebSocket;
    roomId: string | null;
    senderDeviceId: string;
    targetDeviceId: string | null;
    token?: string;
    sessionId: string;
    streamId: string;
  }): StreamRegistrationResult {
    const auth = this.authorizePeerSignaling({
      socket: params.socket,
      roomId: params.roomId,
      senderDeviceId: params.senderDeviceId,
      targetDeviceId: params.targetDeviceId,
      token: params.token,
    });
    if (!auth.ok) return auth;

    const room = this.rooms.get(params.roomId!)!;
    for (const existing of room.activeStreams.values()) {
      if (existing.streamId === params.streamId && existing.publisherDeviceId !== params.senderDeviceId) {
        return {
          ok: false,
          code: 'APPROVAL_DECLINED',
          message: 'Unauthorized: only the authenticated stream publisher may stop this stream',
        };
      }
    }

    const linkKey = this.streamLinkKey(params.senderDeviceId, params.targetDeviceId!);
    const current = room.activeStreams.get(linkKey);
    if (current && current.streamId === params.streamId) {
      room.activeStreams.delete(linkKey);
    } else {
      for (const [k, s] of room.activeStreams.entries()) {
        if (
          s.publisherDeviceId === params.senderDeviceId &&
          s.targetDeviceId === params.targetDeviceId &&
          (s.streamId === params.streamId || s.sessionId === params.sessionId)
        ) {
          room.activeStreams.delete(k);
        }
      }
    }

    const now = Date.now();
    if (params.senderDeviceId === room.hostDeviceId) {
      room.hostLastSeenAt = now;
    } else {
      const senderMember = room.pairedReceivers.get(params.senderDeviceId);
      if (senderMember) senderMember.lastSeenAt = now;
    }

    return {
      ok: true,
      targetSocket: auth.targetSocket,
      room: this.toPublicSnapshot(room),
      authorizedSockets: this.getAuthorizedMemberSockets(room),
    };
  }

  beginDisconnectGrace(
    socket: WebSocket,
    onGraceExpired: (cleanup: {
      disconnectedDeviceId: string | null;
      updatedRooms: Array<{
        room: PublicRoomSnapshot;
        peerSockets: WebSocket[];
        wasHost: boolean;
        terminatedStreams: TerminatedStreamNotice[];
      }>;
    }) => void
  ): { deferred: boolean; immediateCleanup?: ReturnType<RoomManager['handleDisconnect']> } {
    const deviceId = this.socketToDeviceId.get(socket) ?? null;
    if (!deviceId) {
      return { deferred: false, immediateCleanup: { disconnectedDeviceId: null, updatedRooms: [] } };
    }

    const device = this.devices.get(deviceId);
    const roomId = device?.roomId ?? null;
    const room = roomId ? this.rooms.get(roomId) : undefined;

    // Only defer cleanup when device is inside an active room (especially with active streams)
    // and grace window is enabled.
    if (!room || this.disconnectGraceMs <= 0) {
      return { deferred: false, immediateCleanup: this.handleDisconnect(socket) };
    }

    this.socketToDeviceId.delete(socket);
    this.cancelDisconnectGrace(deviceId);

    const timer = setTimeout(() => {
      const pending = this.disconnectGraceTimers.get(deviceId);
      if (!pending || pending.socket !== socket) {
        return;
      }
      this.disconnectGraceTimers.delete(deviceId);
      const cleanup = this.finalizeDeviceDisconnect(deviceId, socket);
      if (cleanup.disconnectedDeviceId) {
        onGraceExpired(cleanup);
      }
    }, this.disconnectGraceMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.disconnectGraceTimers.set(deviceId, { timer, socket });
    return { deferred: true };
  }

  handleDisconnect(socket: WebSocket): {
    disconnectedDeviceId: string | null;
    updatedRooms: Array<{
      room: PublicRoomSnapshot;
      peerSockets: WebSocket[];
      wasHost: boolean;
      terminatedStreams: TerminatedStreamNotice[];
    }>;
  } {
    const deviceId = this.socketToDeviceId.get(socket) ?? null;
    this.socketToDeviceId.delete(socket);
    if (!deviceId) {
      return { disconnectedDeviceId: null, updatedRooms: [] };
    }
    this.cancelDisconnectGrace(deviceId);
    return this.finalizeDeviceDisconnect(deviceId, socket);
  }

  private finalizeDeviceDisconnect(
    deviceId: string,
    socket: WebSocket
  ): {
    disconnectedDeviceId: string | null;
    updatedRooms: Array<{
      room: PublicRoomSnapshot;
      peerSockets: WebSocket[];
      wasHost: boolean;
      terminatedStreams: TerminatedStreamNotice[];
    }>;
  } {
    const device = this.devices.get(deviceId);
    if (device && device.socket === socket) {
      this.devices.delete(deviceId);
    } else if (device && this.isSocketOpen(device.socket)) {
      // Device already rebound to a newer live WebSocket; do not mark disconnected
      return { disconnectedDeviceId: null, updatedRooms: [] };
    }

    const now = Date.now();
    const updatedRooms: Array<{
      room: PublicRoomSnapshot;
      peerSockets: WebSocket[];
      wasHost: boolean;
      terminatedStreams: TerminatedStreamNotice[];
    }> = [];

    for (const room of this.rooms.values()) {
      if (room.expiresAt <= now) continue;

      let touched = false;
      let wasHost = false;

      if (room.hostDeviceId === deviceId) {
        room.hostConnected = false;
        touched = true;
        wasHost = true;
      }

      const paired = room.pairedReceivers.get(deviceId);
      if (paired) {
        paired.connected = false;
        touched = true;
      }

      const pending = room.pendingRequests.get(deviceId);
      if (pending) {
        pending.connected = false;
        touched = true;
      }

      if (
        room.pendingHostTransfer &&
        (room.pendingHostTransfer.targetDeviceId === deviceId ||
          room.pendingHostTransfer.fromHostDeviceId === deviceId)
      ) {
        room.pendingHostTransfer = null;
        touched = true;
      }

      const terminatedStreams = this.cleanupStreamsForParticipant(room, deviceId);

      if (touched) {
        updatedRooms.push({
          room: this.toPublicSnapshot(room),
          peerSockets: this.getAllRoomSockets(room, deviceId),
          wasHost,
          terminatedStreams,
        });
      }
    }

    return { disconnectedDeviceId: deviceId, updatedRooms };
  }

  sweepExpiredRooms(now = Date.now()): Array<{
    roomId: string;
    snapshot: PublicRoomSnapshot;
    sockets: WebSocket[];
  }> {
    const expired: Array<{
      roomId: string;
      snapshot: PublicRoomSnapshot;
      sockets: WebSocket[];
    }> = [];

    for (const [roomId, room] of this.rooms.entries()) {
      if (room.expiresAt <= now) {
        // Active casting rooms must never expire due to inactivity while streams/participants are live.
        this.extendActiveRoomExpiration(room, now, 'sweep');
      }
      if (room.expiresAt <= now) {
        const snapshot = this.toPublicSnapshot(room, 'expired');
        const sockets = this.getAllRoomSockets(room);
        this.cancelDisconnectGrace(room.hostDeviceId);
        for (const rx of room.pairedReceivers.values()) {
          this.cancelDisconnectGrace(rx.deviceId);
        }
        for (const pending of room.pendingRequests.values()) {
          this.cancelDisconnectGrace(pending.deviceId);
        }
        for (const sock of sockets) {
          const dev = this.getDeviceBySocket(sock);
          if (dev && dev.roomId === roomId) {
            dev.roomId = null;
          }
        }
        this.rooms.delete(roomId);
        expired.push({ roomId, snapshot, sockets });
      }
    }

    return expired;
  }

  getStats(): {
    activeDevices: number;
    activeRooms: number;
    maxReceiversPerRoom: number;
  } {
    const now = Date.now();
    let activeDevices = 0;
    for (const dev of this.devices.values()) {
      if (this.isSocketOpen(dev.socket)) {
        activeDevices += 1;
      }
    }
    let activeRooms = 0;
    for (const room of this.rooms.values()) {
      if (room.expiresAt > now) {
        activeRooms += 1;
      }
    }
    return {
      activeDevices,
      activeRooms,
      maxReceiversPerRoom: MAX_RECEIVERS_PER_ROOM,
    };
  }
}
