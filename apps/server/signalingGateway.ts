import type { IncomingMessage } from 'node:http';
import type http from 'node:http';
import type https from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createErrorEnvelope,
  createServerEnvelope,
  validateCastoraEnvelope,
  type CastoraEnvelope,
} from './protocolValidator.ts';
import { toRoomStatePayload, type RoomManager } from './roomManager.ts';
import type { SlidingWindowRateLimiter } from './security.ts';
import type {
  CastoraDeviceRole,
  CastoraPlatform,
  DeviceCapabilities,
  PairingMethod,
  PublicRoomSnapshot,
} from './types.ts';

const WS_PATH = '/castora';
const MAX_CONTROL_PAYLOAD_BYTES = 64 * 1024;
const HEARTBEAT_PING_INTERVAL_MS = 30_000;

interface SignalingGatewayOptions {
  server: http.Server | https.Server;
  roomManager: RoomManager;
  roomRateLimiter: SlidingWindowRateLimiter;
  wsPort: number;
}

function extractClientAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function extractBearerOrQueryToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token')?.trim();
    if (token) return token;
  } catch {
    // Ignore malformed query
  }
  return undefined;
}

export function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function broadcastRoomState(
  roomManager: RoomManager,
  snapshot: PublicRoomSnapshot,
  extraSockets: WebSocket[] = []
): void {
  const targets = new Set<WebSocket>([
    ...roomManager.getRoomMemberSockets(snapshot.roomId),
    ...extraSockets,
  ]);
  const envelope = createServerEnvelope({
    messageType: 'room_state',
    receiverDeviceId: null,
    roomId: snapshot.roomId,
    payload: toRoomStatePayload(snapshot),
  });
  const encoded = JSON.stringify(envelope);
  for (const sock of targets) {
    if (sock.readyState === WebSocket.OPEN) {
      sock.send(encoded);
    }
  }
}

export function attachSignalingGateway(options: SignalingGatewayOptions): {
  wss: WebSocketServer;
  shutdown: () => void;
} {
  const { server, roomManager, roomRateLimiter, wsPort } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CONTROL_PAYLOAD_BYTES,
  });

  const socketMeta = new WeakMap<
    WebSocket,
    {
      remoteAddress: string;
      token?: string;
      boundDeviceId?: string;
      isAlive: boolean;
    }
  >();

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== WS_PATH) {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      socketMeta.set(ws, {
        remoteAddress: extractClientAddress(req),
        token: extractBearerOrQueryToken(req),
        isAlive: true,
      });
      wss.emit('connection', ws, req);
    });
  });

  const pingInterval = setInterval(() => {
    for (const client of wss.clients) {
      const meta = socketMeta.get(client);
      if (meta && !meta.isAlive) {
        client.terminate();
        continue;
      }
      if (meta) {
        meta.isAlive = false;
      }
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, HEARTBEAT_PING_INTERVAL_MS);
  pingInterval.unref();

  wss.on('connection', (ws: WebSocket) => {
    const meta = socketMeta.get(ws) ?? {
      remoteAddress: 'unknown',
      isAlive: true,
    };

    ws.on('pong', () => {
      const current = socketMeta.get(ws);
      if (current) current.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      const currentMeta = socketMeta.get(ws) ?? meta;
      currentMeta.isAlive = true;

      if (isBinary) {
        sendJson(
          ws,
          createErrorEnvelope({
            receiverDeviceId: currentMeta.boundDeviceId ?? null,
            roomId: null,
            code: 'INVALID_MESSAGE',
            message: 'Binary media frames are forbidden on /castora signaling channel',
            recoverable: true,
            relatedMessageId: null,
          })
        );
        return;
      }

      let parsed: unknown;
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        parsed = JSON.parse(text);
      } catch {
        sendJson(
          ws,
          createErrorEnvelope({
            receiverDeviceId: currentMeta.boundDeviceId ?? null,
            roomId: null,
            code: 'INVALID_MESSAGE',
            message: 'Malformed JSON signaling frame',
            recoverable: true,
            relatedMessageId: null,
          })
        );
        return;
      }

      const validation = validateCastoraEnvelope(parsed);
      if (!validation.valid) {
        const maybeId =
          parsed &&
          typeof parsed === 'object' &&
          'messageId' in parsed &&
          typeof (parsed as { messageId?: unknown }).messageId === 'string'
            ? (parsed as { messageId: string }).messageId
            : null;
        sendJson(
          ws,
          createErrorEnvelope({
            receiverDeviceId: currentMeta.boundDeviceId ?? null,
            roomId: null,
            code: validation.errorCode,
            message: validation.summary,
            recoverable: true,
            relatedMessageId: maybeId,
          })
        );
        return;
      }

      const envelope = validation.envelope;

      if (
        currentMeta.boundDeviceId &&
        envelope.senderDeviceId !== currentMeta.boundDeviceId
      ) {
        sendJson(
          ws,
          createErrorEnvelope({
            receiverDeviceId: currentMeta.boundDeviceId,
            roomId: envelope.roomId,
            code: 'INVALID_MESSAGE',
            message: 'senderDeviceId does not match announced socket identity',
            recoverable: true,
            relatedMessageId: envelope.messageId,
          })
        );
        return;
      }

      handleValidatedEnvelope(ws, currentMeta, envelope);
    });

    ws.on('close', () => {
      const cleanup = roomManager.handleDisconnect(ws);
      if (cleanup.disconnectedDeviceId) {
        for (const item of cleanup.updatedRooms) {
          const notice = createServerEnvelope({
            messageType: 'disconnect',
            receiverDeviceId: null,
            roomId: item.room.roomId,
            payload: {
              sessionId: null,
              streamId: null,
              reason: item.wasHost
                ? 'Host disconnected'
                : `Peer ${cleanup.disconnectedDeviceId} disconnected`,
            },
          });
          for (const peerSocket of item.peerSockets) {
            sendJson(peerSocket, notice);
          }
          broadcastRoomState(roomManager, item.room, item.peerSockets);
        }
      }
    });

    ws.on('error', () => {
      roomManager.handleDisconnect(ws);
    });
  });

  function handleValidatedEnvelope(
    ws: WebSocket,
    meta: { remoteAddress: string; token?: string; boundDeviceId?: string },
    envelope: CastoraEnvelope
  ): void {
    switch (envelope.messageType) {
      case 'device_announce': {
        const payload = envelope.payload as {
          deviceName: string;
          platform: CastoraPlatform;
          role: CastoraDeviceRole;
          wsPort: number;
          capabilities: DeviceCapabilities;
        };

        meta.boundDeviceId = envelope.senderDeviceId;
        const result = roomManager.registerDevice({
          socket: ws,
          remoteAddress: meta.remoteAddress,
          deviceId: envelope.senderDeviceId,
          deviceName: payload.deviceName,
          platform: payload.platform,
          role: payload.role,
          wsPort: payload.wsPort,
          capabilities: payload.capabilities,
          roomId: envelope.roomId,
          token: meta.token,
        });

        sendJson(
          ws,
          createServerEnvelope({
            messageType: 'device_announce',
            receiverDeviceId: result.device.deviceId,
            roomId: result.device.roomId,
            payload: {
              deviceName: 'Castora Signaling Server',
              platform: 'macos',
              role: 'both',
              wsPort,
              capabilities: {
                maxWidth: 3840,
                maxHeight: 2160,
                maxFps: 60,
                codecs: ['H264', 'VP8', 'VP9'],
                supportsAudio: true,
              },
            },
          })
        );

        if (result.authenticatedRoom) {
          broadcastRoomState(roomManager, result.authenticatedRoom, [ws]);
        }
        return;
      }

      case 'device_discover': {
        const payload = envelope.payload as {
          requestedRole: 'sender' | 'receiver' | 'any';
          filterPlatform?: CastoraPlatform | null;
        };
        const matches = roomManager.discoverDevices({
          requestedRole: payload.requestedRole,
          filterPlatform: payload.filterPlatform ?? null,
          excludeDeviceId: envelope.senderDeviceId,
        });

        for (const peer of matches) {
          sendJson(
            ws,
            createServerEnvelope({
              messageType: 'device_announce',
              senderDeviceId: peer.deviceId,
              receiverDeviceId: envelope.senderDeviceId,
              roomId: peer.roomId,
              payload: {
                deviceName: peer.deviceName,
                platform: peer.platform,
                role: peer.role,
                wsPort: peer.wsPort,
                capabilities: peer.capabilities,
              },
            })
          );
        }

        sendJson(
          ws,
          createServerEnvelope({
            messageType: 'heartbeat',
            receiverDeviceId: envelope.senderDeviceId,
            roomId: envelope.roomId,
            payload: {
              sequence: matches.length,
              role: 'receiver',
            },
          })
        );
        return;
      }

      case 'pair_request': {
        const rateCheck = roomRateLimiter.consume(`ws-pair:${meta.remoteAddress}`);
        if (!rateCheck.allowed) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: 'INTERNAL_ERROR',
              message: 'Too many room pairing attempts. Retry shortly.',
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        if (!envelope.roomId) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: null,
              code: 'INVALID_ROOM_ID',
              message: 'pair_request requires a valid 6-character roomId',
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        const payload = envelope.payload as {
          pairingMethod: PairingMethod;
          deviceName: string;
          platform: CastoraPlatform;
        };

        const submitResult = roomManager.submitPairRequest({
          roomId: envelope.roomId,
          receiverDeviceId: envelope.senderDeviceId,
          deviceName: payload.deviceName,
          platform: payload.platform,
          pairingMethod: payload.pairingMethod,
        });

        if (!submitResult.ok) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code:
                submitResult.code === 'ROOM_FULL'
                  ? 'SESSION_FULL'
                  : submitResult.code === 'DUPLICATE_PAIR_REQUEST' ||
                      submitResult.code === 'ALREADY_PAIRED'
                    ? 'INVALID_MESSAGE'
                    : 'INVALID_ROOM_ID',
              message: submitResult.message,
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        meta.boundDeviceId = envelope.senderDeviceId;
        meta.token = submitResult.memberToken;

        const hostDev = roomManager.getDeviceById(submitResult.room.hostDeviceId);
        if (hostDev && hostDev.socket.readyState === WebSocket.OPEN) {
          sendJson(hostDev.socket, envelope);
        }

        broadcastRoomState(roomManager, submitResult.room, [ws]);
        return;
      }

      case 'pair_response': {
        if (!envelope.roomId || !envelope.receiverDeviceId) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: 'INVALID_MESSAGE',
              message: 'pair_response requires roomId and target receiverDeviceId',
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        if (!meta.token || !roomManager.isAuthorizedHost(envelope.roomId, envelope.senderDeviceId, meta.token)) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: 'APPROVAL_DECLINED',
              message: 'Unauthorized: valid host token required for pairing approval or rejection',
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        const payload = envelope.payload as {
          paired: boolean;
          reason: string | null;
        };

        if (payload.paired) {
          const approval = roomManager.approvePairRequest({
            roomId: envelope.roomId,
            receiverDeviceId: envelope.receiverDeviceId,
            hostToken: meta.token,
          });
          if (!approval.ok) {
            sendJson(
              ws,
              createErrorEnvelope({
                receiverDeviceId: envelope.senderDeviceId,
                roomId: envelope.roomId,
                code: approval.code === 'ROOM_FULL' ? 'SESSION_FULL' : 'INVALID_MESSAGE',
                message: approval.message,
                recoverable: true,
                relatedMessageId: envelope.messageId,
              })
            );
            return;
          }
          if (approval.receiverSocket) {
            sendJson(approval.receiverSocket, envelope);
          }
          broadcastRoomState(roomManager, approval.room, [ws]);
        } else {
          const rejection = roomManager.rejectPairRequest({
            roomId: envelope.roomId,
            receiverDeviceId: envelope.receiverDeviceId,
            hostToken: meta.token,
            reason: payload.reason ?? undefined,
          });
          if (!rejection.ok) {
            sendJson(
              ws,
              createErrorEnvelope({
                receiverDeviceId: envelope.senderDeviceId,
                roomId: envelope.roomId,
                code: 'INVALID_MESSAGE',
                message: rejection.message,
                recoverable: true,
                relatedMessageId: envelope.messageId,
              })
            );
            return;
          }
          if (rejection.receiverSocket) {
            sendJson(rejection.receiverSocket, envelope);
          }
          broadcastRoomState(roomManager, rejection.room, [ws]);
        }
        return;
      }

      case 'heartbeat': {
        roomManager.touchHeartbeat(ws);
        const payload = envelope.payload as { sequence: number; role: 'sender' | 'receiver' };
        sendJson(
          ws,
          createServerEnvelope({
            messageType: 'heartbeat',
            receiverDeviceId: envelope.senderDeviceId,
            roomId: envelope.roomId,
            payload: {
              sequence: payload.sequence,
              role: payload.role,
            },
          })
        );
        return;
      }

      case 'disconnect': {
        // Host removing a specific receiver via WS disconnect frame
        if (
          envelope.roomId &&
          envelope.receiverDeviceId &&
          envelope.receiverDeviceId !== envelope.senderDeviceId
        ) {
          if (!meta.token || !roomManager.isAuthorizedHost(envelope.roomId, envelope.senderDeviceId, meta.token)) {
            sendJson(
              ws,
              createErrorEnvelope({
                receiverDeviceId: envelope.senderDeviceId,
                roomId: envelope.roomId,
                code: 'APPROVAL_DECLINED',
                message: 'Unauthorized: only the room host may remove paired receivers',
                recoverable: true,
                relatedMessageId: envelope.messageId,
              })
            );
            return;
          }
          const removed = roomManager.removePairedReceiver({
            roomId: envelope.roomId,
            receiverDeviceId: envelope.receiverDeviceId,
            hostToken: meta.token,
          });
          if (!removed.ok) {
            sendJson(
              ws,
              createErrorEnvelope({
                receiverDeviceId: envelope.senderDeviceId,
                roomId: envelope.roomId,
                code: 'INVALID_MESSAGE',
                message: removed.message,
                recoverable: true,
                relatedMessageId: envelope.messageId,
              })
            );
            return;
          }
          if (removed.removedSocket) {
            sendJson(
              removed.removedSocket,
              createServerEnvelope({
                messageType: 'disconnect',
                receiverDeviceId: removed.removedDeviceId,
                roomId: envelope.roomId,
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
            removed.removedSocket ? [removed.removedSocket, ws] : [ws]
          );
          return;
        }

        // Member explicitly leaving their room via WS disconnect
        if (envelope.roomId && meta.token) {
          const left = roomManager.leaveRoom({
            roomId: envelope.roomId,
            deviceId: envelope.senderDeviceId,
            memberToken: meta.token,
          });
          if (left.ok) {
            broadcastRoomState(roomManager, left.room, [ws]);
            return;
          }
        }

        const cleanup = roomManager.handleDisconnect(ws);
        for (const item of cleanup.updatedRooms) {
          for (const peerSocket of item.peerSockets) {
            sendJson(peerSocket, envelope);
          }
          broadcastRoomState(roomManager, item.room, item.peerSockets);
        }
        return;
      }

      case 'session_offer':
      case 'session_answer':
      case 'ice_candidate': {
        sendJson(
          ws,
          createErrorEnvelope({
            receiverDeviceId: envelope.senderDeviceId,
            roomId: envelope.roomId,
            code: 'WEBRTC_NEGOTIATION_FAILED',
            message: 'WebRTC SDP/ICE negotiation activates in Stage 4',
            recoverable: true,
            relatedMessageId: envelope.messageId,
          })
        );
        return;
      }

      default: {
        if (
          !envelope.roomId ||
          !roomManager.verifyRoomPeerAccess(
            envelope.roomId,
            envelope.senderDeviceId,
            envelope.receiverDeviceId
          )
        ) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: 'INVALID_ROOM_ID',
              message: 'Sender and receiver must belong to an active paired room',
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        if (envelope.receiverDeviceId) {
          const target = roomManager.getDeviceById(envelope.receiverDeviceId);
          if (target && target.socket.readyState === WebSocket.OPEN) {
            sendJson(target.socket, envelope);
          }
        } else {
          const sockets = roomManager.getRoomMemberSockets(
            envelope.roomId,
            envelope.senderDeviceId
          );
          for (const peerSocket of sockets) {
            sendJson(peerSocket, envelope);
          }
        }
      }
    }
  }

  return {
    wss,
    shutdown: () => {
      clearInterval(pingInterval);
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down');
      }
      wss.close();
    },
  };
}
