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
  PublicRoomSnapshot,
  RegisteredDevice,
  RoomMember,
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
  | 'UNAUTHORIZED';

export type RoomJoinResult =
  | {
      ok: true;
      room: PublicRoomSnapshot;
      memberToken: string;
      assignedSlotIndex: number;
    }
  | {
      ok: false;
      code: RoomOperationErrorCode;
      message: string;
    };

export type RoomLookupResult =
  | { ok: true; room: PublicRoomSnapshot }
  | { ok: false; code: RoomOperationErrorCode; message: string };

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

  private toPublicSnapshot(room: CastoraRoom): PublicRoomSnapshot {
    const members = Array.from(room.members.values()).map((member) => ({
      deviceId: member.deviceId,
      deviceName: member.deviceName,
      platform: member.platform,
      role: member.role,
      connected: member.connected && this.hasOpenSocket(member.deviceId),
      assignedSlotIndex: member.assignedSlotIndex,
    }));

    const activeReceiverCount = members.filter(
      (member) => member.role === 'receiver' && member.connected
    ).length;

    return {
      roomId: room.roomId,
      hostDeviceId: room.hostDeviceId,
      hostDeviceName: room.hostDeviceName,
      hostPlatform: room.hostPlatform,
      createdAt: new Date(room.createdAt).toISOString(),
      expiresAt: new Date(room.expiresAt).toISOString(),
      maxReceivers: room.maxReceivers,
      activeReceiverCount,
      members,
    };
  }

  private findNextSlotIndex(room: CastoraRoom): number | null {
    const used = new Set<number>();
    for (const member of room.members.values()) {
      if (member.role === 'receiver' && member.assignedSlotIndex !== null) {
        used.add(member.assignedSlotIndex);
      }
    }
    for (let idx = 0; idx < room.maxReceivers; idx += 1) {
      if (!used.has(idx)) {
        return idx;
      }
    }
    return null;
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
  }): RegisteredDevice {
    const now = Date.now();
    const existing = this.devices.get(params.deviceId);
    if (existing && existing.socket !== params.socket) {
      this.socketToDeviceId.delete(existing.socket);
    }

    let verifiedRoomId: string | null = null;
    if (params.roomId) {
      const room = this.rooms.get(params.roomId);
      if (room && room.expiresAt > now) {
        const member = room.members.get(params.deviceId);
        if (member && (!params.token || verifyToken(params.token, member.tokenHash))) {
          member.connected = true;
          member.lastSeenAt = now;
          verifiedRoomId = room.roomId;
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
    return record;
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
        const member = room.members.get(device.deviceId);
        if (member) {
          member.lastSeenAt = now;
          member.connected = true;
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

    const hostMember: RoomMember = {
      deviceId: params.hostDeviceId,
      deviceName: params.hostDeviceName,
      platform: params.hostPlatform,
      role: 'host',
      tokenHash: hostTokenHash,
      connected: hostSocketConnected,
      joinedAt: now,
      lastSeenAt: now,
      assignedSlotIndex: null,
    };

    const room: CastoraRoom = {
      roomId,
      hostDeviceId: params.hostDeviceId,
      hostDeviceName: params.hostDeviceName,
      hostPlatform: params.hostPlatform,
      hostTokenHash,
      createdAt: now,
      expiresAt: now + ttl,
      ttlMs: ttl,
      maxReceivers: MAX_RECEIVERS_PER_ROOM,
      members: new Map([[params.hostDeviceId, hostMember]]),
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
        message: 'Room not found',
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

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
    };
  }

  joinRoom(params: {
    roomId: string;
    receiverDeviceId: string;
    deviceName: string;
    platform: CastoraPlatform;
  }): RoomJoinResult {
    if (!/^[A-Z0-9]{6}$/.test(params.roomId)) {
      return {
        ok: false,
        code: 'INVALID_ROOM_ID',
        message: 'Room ID must be 6 uppercase alphanumeric characters',
      };
    }

    const now = Date.now();
    const room = this.rooms.get(params.roomId);
    if (!room) {
      return {
        ok: false,
        code: 'ROOM_NOT_FOUND',
        message: 'Room does not exist',
      };
    }

    if (now >= room.expiresAt) {
      this.rooms.delete(params.roomId);
      return {
        ok: false,
        code: 'ROOM_EXPIRED',
        message: 'Room has expired',
      };
    }

    const existingMember = room.members.get(params.receiverDeviceId);
    if (existingMember && existingMember.role === 'host') {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: 'Host device cannot join its own room as a receiver',
      };
    }

    const slotIndex =
      existingMember?.assignedSlotIndex ?? this.findNextSlotIndex(room);
    if (slotIndex === null) {
      return {
        ok: false,
        code: 'ROOM_FULL',
        message: `Room already has the maximum of ${room.maxReceivers} receivers`,
      };
    }

    const memberToken = generateSessionToken();
    const member: RoomMember = {
      deviceId: params.receiverDeviceId,
      deviceName: params.deviceName,
      platform: params.platform,
      role: 'receiver',
      tokenHash: hashToken(memberToken),
      connected: this.hasOpenSocket(params.receiverDeviceId),
      joinedAt: existingMember?.joinedAt ?? now,
      lastSeenAt: now,
      assignedSlotIndex: slotIndex,
    };

    room.members.set(params.receiverDeviceId, member);

    const dev = this.devices.get(params.receiverDeviceId);
    if (dev && this.isSocketOpen(dev.socket)) {
      dev.roomId = room.roomId;
    }

    return {
      ok: true,
      room: this.toPublicSnapshot(room),
      memberToken,
      assignedSlotIndex: slotIndex,
    };
  }

  closeRoom(roomId: string, hostToken: string): {
    ok: boolean;
    code?: RoomOperationErrorCode;
    message?: string;
    affectedSockets: WebSocket[];
  } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, code: 'ROOM_NOT_FOUND', message: 'Room not found', affectedSockets: [] };
    }
    if (!verifyToken(hostToken, room.hostTokenHash)) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Invalid host token', affectedSockets: [] };
    }

    const affectedSockets: WebSocket[] = [];
    for (const member of room.members.values()) {
      const dev = this.devices.get(member.deviceId);
      if (dev) {
        if (dev.roomId === roomId) {
          dev.roomId = null;
        }
        if (this.isSocketOpen(dev.socket)) {
          affectedSockets.push(dev.socket);
        }
      }
    }
    this.rooms.delete(roomId);
    return { ok: true, affectedSockets };
  }

  getRoomMemberSockets(roomId: string, excludeDeviceId?: string): WebSocket[] {
    const room = this.rooms.get(roomId);
    if (!room || Date.now() >= room.expiresAt) return [];
    const sockets: WebSocket[] = [];
    for (const member of room.members.values()) {
      if (excludeDeviceId && member.deviceId === excludeDeviceId) continue;
      const dev = this.devices.get(member.deviceId);
      if (dev && this.isSocketOpen(dev.socket)) {
        sockets.push(dev.socket);
      }
    }
    return sockets;
  }

  verifyRoomPeerAccess(roomId: string, senderDeviceId: string, targetDeviceId: string | null): boolean {
    const room = this.rooms.get(roomId);
    if (!room || Date.now() >= room.expiresAt) return false;
    if (!room.members.has(senderDeviceId)) return false;
    if (targetDeviceId && !room.members.has(targetDeviceId)) return false;
    return true;
  }

  handleDisconnect(socket: WebSocket): {
    disconnectedDeviceId: string | null;
    roomId: string | null;
    peerSockets: WebSocket[];
  } {
    const deviceId = this.socketToDeviceId.get(socket) ?? null;
    this.socketToDeviceId.delete(socket);
    if (!deviceId) {
      return { disconnectedDeviceId: null, roomId: null, peerSockets: [] };
    }

    const device = this.devices.get(deviceId);
    if (device && device.socket === socket) {
      this.devices.delete(deviceId);
    }

    const roomId = device?.roomId ?? null;
    const peerSockets: WebSocket[] = [];

    for (const room of this.rooms.values()) {
      const member = room.members.get(deviceId);
      if (!member) continue;
      if (member.role === 'receiver') {
        room.members.delete(deviceId);
      } else {
        member.connected = false;
      }
      for (const peer of room.members.values()) {
        if (peer.deviceId === deviceId) continue;
        const peerDev = this.devices.get(peer.deviceId);
        if (peerDev && this.isSocketOpen(peerDev.socket)) {
          peerSockets.push(peerDev.socket);
        }
      }
    }

    return { disconnectedDeviceId: deviceId, roomId, peerSockets };
  }

  sweepExpiredRooms(now = Date.now()): Array<{
    roomId: string;
    sockets: WebSocket[];
  }> {
    const expired: Array<{ roomId: string; sockets: WebSocket[] }> = [];
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.expiresAt <= now) {
        const sockets: WebSocket[] = [];
        for (const member of room.members.values()) {
          const dev = this.devices.get(member.deviceId);
          if (dev) {
            if (dev.roomId === roomId) {
              dev.roomId = null;
            }
            if (this.isSocketOpen(dev.socket)) {
              sockets.push(dev.socket);
            }
          }
        }
        this.rooms.delete(roomId);
        expired.push({ roomId, sockets });
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
