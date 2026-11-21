import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  generateRoomCode,
  generateSessionToken,
  hashToken,
  verifyToken,
} from './security.ts';
import type {
  CastoraDeviceRole,
  CastoraPlatform,
  CastoraRoom,
  DeviceCapabilities,
  PairedReceiverMember,
  PairingMethod,
  PendingPairRequest,
  PublicRoomSnapshot,
  RegisteredDevice,
} from './types.ts';

export const MAX_RECEIVERS_PER_ROOM = 6;
const DEFAULT_ROOM_TTL_MS = 15 * 60 * 1000;
const MIN_ROOM_TTL_MS = 200;
const MAX_ROOM_TTL_MS = 60 * 60 * 1000;

export type RoomOperationErrorCode =
  | 'INVALID_ROOM_ID'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_EXPIRED'
  | 'ROOM_FULL'
  | 'ALREADY_PAIRED'
  | 'DUPLICATE_PAIR_REQUEST'
  | 'REQUEST_NOT_FOUND'
  | 'RECEIVER_NOT_FOUND'
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
      requestStatus: 'pending_approval';
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

export type RemoveReceiverResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      removedDeviceId: string;
      removedSocket: WebSocket | null;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export type LeaveRoomResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
    }
  | { ok: false; code: RoomOperationErrorCode; message: string };

export function toRoomStatePayload(snapshot: PublicRoomSnapshot): Record<string, unknown> {
  return {
    status: snapshot.status,
    hostDeviceId: snapshot.hostDeviceId,
    hostDeviceName: snapshot.hostDeviceName,
    hostPlatform: snapshot.hostPlatform,
    hostConnected: snapshot.hostConnected,
    expiresAt: snapshot.expiresAt,
    maxReceivers: snapshot.maxReceivers,
    pendingRequests: snapshot.pendingRequests,
    pairedReceivers: snapshot.pairedReceivers,
  };
}

export class RoomManager {
  private readonly devices = new Map<string, RegisteredDevice>();
  private readonly socketToDeviceId = new Map<WebSocket, string>();
  private readonly rooms = new Map<string, CastoraRoom>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs?: number) {
    const envTtl = Number(process.env.CASTORA_ROOM_TTL_MS);
    if (typeof defaultTtlMs === 'number' && Number.isFinite(defaultTtlMs)) {
      this.defaultTtlMs = this.clampTtl(defaultTtlMs);
    } else if (Number.isFinite(envTtl) && envTtl >= MIN_ROOM_TTL_MS) {
      this.defaultTtlMs = this.clampTtl(envTtl);
    } else {
      this.defaultTtlMs = DEFAULT_ROOM_TTL_MS;
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

  private getOpenSocket(deviceId: string): WebSocket | null {
    const dev = this.devices.get(deviceId);
    return dev && this.isSocketOpen(dev.socket) ? dev.socket : null;
  }

  private toPublicSnapshot(
    room: CastoraRoom,
    status: 'active' | 'closed' | 'expired' = 'active'
  ): PublicRoomSnapshot {
    const hostConnected =
      status === 'active' && room.hostConnected && this.hasOpenSocket(room.hostDeviceId);

    const pendingRequests = Array.from(room.pendingRequests.values()).map((req) => ({
      deviceId: req.deviceId,
      deviceName: req.deviceName,
      platform: req.platform,
      pairingMethod: req.pairingMethod,
      connected: status === 'active' && req.connected && this.hasOpenSocket(req.deviceId),
      requestedAt: new Date(req.requestedAt).toISOString(),
      sessionId: req.sessionId,
    }));

    const pairedReceivers = Array.from(room.pairedReceivers.values())
      .sort((a, b) => a.assignedSlotIndex - b.assignedSlotIndex)
      .map((member) => ({
        deviceId: member.deviceId,
        deviceName: member.deviceName,
        platform: member.platform,
        connected: status === 'active' && member.connected && this.hasOpenSocket(member.deviceId),
        assignedSlotIndex: member.assignedSlotIndex,
        pairedAt: new Date(member.pairedAt).toISOString(),
        sessionId: member.sessionId,
      }));

    const activeReceiverCount = pairedReceivers.filter((r) => r.connected).length;

    return {
      roomId: room.roomId,
      status,
      hostDeviceId: room.hostDeviceId,
      hostDeviceName: room.hostDeviceName,
      hostPlatform: room.hostPlatform,
      hostConnected,
      createdAt: new Date(room.createdAt).toISOString(),
      expiresAt: new Date(room.expiresAt).toISOString(),
      maxReceivers: room.maxReceivers,
      activeReceiverCount,
      pairedReceiverCount: pairedReceivers.length,
      pendingCount: pendingRequests.length,
      pendingRequests,
      pairedReceivers,
    };
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
    role: CastoraDeviceRole;
    wsPort: number;
    capabilities: DeviceCapabilities;
    roomId: string | null;
    token?: string;
  }): {
    device: RegisteredDevice;
    authenticatedRoom: PublicRoomSnapshot | null;
    authenticatedRole: 'host' | 'pending' | 'paired' | null;
  } {
    const now = Date.now();
    const existing = this.devices.get(params.deviceId);
    if (existing && existing.socket !== params.socket) {
      this.socketToDeviceId.delete(existing.socket);
    }

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
          verifiedRoomId = room.roomId;
          authenticatedRole = 'host';
        } else {
          const paired = room.pairedReceivers.get(params.deviceId);
          if (paired && verifyToken(params.token, paired.tokenHash)) {
            paired.connected = true;
            paired.lastSeenAt = now;
            verifiedRoomId = room.roomId;
            authenticatedRole = 'paired';
          } else {
            const pending = room.pendingRequests.get(params.deviceId);
            if (pending && verifyToken(params.token, pending.tokenHash)) {
              pending.connected = true;
              verifiedRoomId = room.roomId;
              authenticatedRole = 'pending';
            }
          }
        }
      }
    }

    const record: RegisteredDevice = {
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      platform: params.platform,
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

  touchHeartbeat(socket: WebSocket): RegisteredDevice | undefined {
    const device = this.getDeviceBySocket(socket);
    if (!device) return undefined;
    const now = Date.now();
    device.lastSeenAt = now;

    if (device.roomId) {
      const room = this.rooms.get(device.roomId);
      if (room && room.expiresAt > now) {
        if (room.hostDeviceId === device.deviceId) {
          room.hostConnected = true;
        } else {
          const paired = room.pairedReceivers.get(device.deviceId);
          if (paired) {
            paired.lastSeenAt = now;
            paired.connected = true;
          }
          const pending = room.pendingRequests.get(device.deviceId);
          if (pending) {
            pending.connected = true;
          }
        }
      }
    }
    return device;
  }

  createRoom(params: {
    hostDeviceId: string;
    hostDeviceName: string;
    hostPlatform: CastoraPlatform;
    ttlMs?: number;
  }): { room: PublicRoomSnapshot; hostToken: string } {
    const now = Date.now();
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
    const hostSocketConnected = this.hasOpenSocket(params.hostDeviceId);

    const room: CastoraRoom = {
      roomId,
      hostDeviceId: params.hostDeviceId,
      hostDeviceName: params.hostDeviceName,
      hostPlatform: params.hostPlatform,
      hostTokenHash,
      hostConnected: hostSocketConnected,
      createdAt: now,
      expiresAt: now + ttl,
      ttlMs: ttl,
      maxReceivers: MAX_RECEIVERS_PER_ROOM,
      pendingRequests: new Map(),
      pairedReceivers: new Map(),
    };

    this.rooms.set(roomId, room);

    const hostDevice = this.devices.get(params.hostDeviceId);
    if (hostDevice && this.isSocketOpen(hostDevice.socket)) {
      hostDevice.roomId = roomId;
    }

    return {
      room: this.toPublicSnapshot(room),
      hostToken,
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
    pairingMethod?: PairingMethod;
  }): SubmitPairRequestResult {
    const lookup = this.getActiveRoomOrError(params.roomId);
    if (!lookup.ok) return lookup;

    const room = lookup.room;
    const now = Date.now();

    if (params.receiverDeviceId === room.hostDeviceId) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Host device cannot submit a receiver pairing request to its own room',
      };
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

    if (room.pairedReceivers.size >= room.maxReceivers) {
      return {
        ok: false,
        code: 'ROOM_FULL',
        message: `Room already has the maximum of ${room.maxReceivers} paired receivers`,
      };
    }

    const memberToken = generateSessionToken();
    const sessionId = `sess-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const pending: PendingPairRequest = {
      deviceId: params.receiverDeviceId,
      deviceName: params.deviceName,
      platform: params.platform,
      pairingMethod: params.pairingMethod ?? 'room_code',
      tokenHash: hashToken(memberToken),
      connected: this.hasOpenSocket(params.receiverDeviceId),
      requestedAt: now,
      sessionId,
    };

    room.pendingRequests.set(params.receiverDeviceId, pending);

    const dev = this.devices.get(params.receiverDeviceId);
    if (dev && this.isSocketOpen(dev.socket)) {
      dev.roomId = room.roomId;
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
        code: 'ROOM_FULL',
        message: `Room capacity reached (${room.maxReceivers} paired receivers maximum)`,
      };
    }

    const slotIndex = this.findNextSlotIndex(room);
    if (slotIndex === null) {
      return {
        ok: false,
        code: 'ROOM_FULL',
        message: `Room capacity reached (${room.maxReceivers} paired receivers maximum)`,
      };
    }

    const now = Date.now();
    room.pendingRequests.delete(params.receiverDeviceId);

    const paired: PairedReceiverMember = {
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      platform: pending.platform,
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
    const dev = this.devices.get(params.receiverDeviceId);
    if (dev && dev.roomId === room.roomId) {
      dev.roomId = null;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      removedDeviceId: params.receiverDeviceId,
      removedSocket: this.getOpenSocket(params.receiverDeviceId),
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

    const dev = this.devices.get(params.deviceId);
    if (dev && dev.roomId === room.roomId) {
      dev.roomId = null;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
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

  handleDisconnect(socket: WebSocket): {
    disconnectedDeviceId: string | null;
    updatedRooms: Array<{
      room: PublicRoomSnapshot;
      peerSockets: WebSocket[];
      wasHost: boolean;
    }>;
  } {
    const deviceId = this.socketToDeviceId.get(socket) ?? null;
    this.socketToDeviceId.delete(socket);
    if (!deviceId) {
      return { disconnectedDeviceId: null, updatedRooms: [] };
    }

    const device = this.devices.get(deviceId);
    if (device && device.socket === socket) {
      this.devices.delete(deviceId);
    }

    const now = Date.now();
    const updatedRooms: Array<{
      room: PublicRoomSnapshot;
      peerSockets: WebSocket[];
      wasHost: boolean;
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

      if (touched) {
        updatedRooms.push({
          room: this.toPublicSnapshot(room),
          peerSockets: this.getAllRoomSockets(room, deviceId),
          wasHost,
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
        const snapshot = this.toPublicSnapshot(room, 'expired');
        const sockets = this.getAllRoomSockets(room);
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
