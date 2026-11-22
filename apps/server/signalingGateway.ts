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
import {
  normalizeDeviceType,
  toRoomStatePayload,
  type RoomManager,
  type TerminatedStreamNotice,
} from './roomManager.ts';
import type { SlidingWindowRateLimiter } from './security.ts';
import type {
  CastoraDeviceRole,
  CastoraPlatform,
  CastoraVideoCodec,
  DetectedDeviceType,
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

function extractDeviceTypeFromQuery(req: IncomingMessage): DetectedDeviceType | undefined {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const raw = url.searchParams.get('deviceType');
    if (raw) {
      return normalizeDeviceType(raw);
    }
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

export function emitTerminatedStreams(
  roomId: string,
  terminatedStreams: TerminatedStreamNotice[],
  reason: 'network_lost' | 'receiver_closed'
): void {
  for (const item of terminatedStreams) {
    if (!item.targetSocket || item.targetSocket.readyState !== WebSocket.OPEN) continue;
    sendJson(
      item.targetSocket,
      createServerEnvelope({
        messageType: 'stream_stop',
        senderDeviceId: item.publisherDeviceId,
        receiverDeviceId: item.targetDeviceId,
        roomId,
        payload: {
          sessionId: item.sessionId,
          streamId: item.streamId,
          reason,
        },
      })
    );
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
      deviceType?: DetectedDeviceType;
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
        deviceType: extractDeviceTypeFromQuery(req),
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
          emitTerminatedStreams(item.room.roomId, item.terminatedStreams, 'network_lost');
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
      const cleanup = roomManager.handleDisconnect(ws);
      if (cleanup.disconnectedDeviceId) {
        for (const item of cleanup.updatedRooms) {
          emitTerminatedStreams(item.room.roomId, item.terminatedStreams, 'network_lost');
          broadcastRoomState(roomManager, item.room, item.peerSockets);
        }
      }
    });
  });

  function handleValidatedEnvelope(
    ws: WebSocket,
    meta: {
      remoteAddress: string;
      token?: string;
      deviceType?: DetectedDeviceType;
      boundDeviceId?: string;
    },
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

        const result = roomManager.registerDevice({
          socket: ws,
          remoteAddress: meta.remoteAddress,
          deviceId: envelope.senderDeviceId,
          deviceName: payload.deviceName,
          platform: payload.platform,
          deviceType: meta.deviceType,
          role: payload.role,
          wsPort: payload.wsPort,
          capabilities: payload.capabilities,
          roomId: envelope.roomId,
          token: meta.token,
        });

        if (result.rejected || !result.device) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: 'APPROVAL_DECLINED',
              message: result.message ?? 'Device identity is already bound to an active session',
              recoverable: false,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        meta.boundDeviceId = envelope.senderDeviceId;

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
          deviceType: meta.deviceType,
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
                      submitResult.code === 'ALREADY_PAIRED' ||
                      submitResult.code === 'INVALID_DEVICE_NAME' ||
                      submitResult.code === 'DUPLICATE_DEVICE_NAME'
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
          emitTerminatedStreams(envelope.roomId, removed.terminatedStreams, 'receiver_closed');
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
            emitTerminatedStreams(envelope.roomId, left.terminatedStreams, 'receiver_closed');
            broadcastRoomState(roomManager, left.room, [ws]);
            return;
          }
        }

        const cleanup = roomManager.handleDisconnect(ws);
        for (const item of cleanup.updatedRooms) {
          emitTerminatedStreams(item.room.roomId, item.terminatedStreams, 'network_lost');
          for (const peerSocket of item.peerSockets) {
            sendJson(peerSocket, envelope);
          }
          broadcastRoomState(roomManager, item.room, item.peerSockets);
        }
        return;
      }

      case 'session_offer':
      case 'session_answer': {
        const sdpPayload = envelope.payload as { sdp?: string };
        if (typeof sdpPayload.sdp !== 'string' || !sdpPayload.sdp.startsWith('v=0') || !sdpPayload.sdp.includes('m=')) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: 'INVALID_MESSAGE',
              message: 'Malformed SDP description: must contain valid v=0 header and m= media section',
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        const auth = roomManager.authorizePeerSignaling({
          socket: ws,
          roomId: envelope.roomId,
          senderDeviceId: envelope.senderDeviceId,
          targetDeviceId: envelope.receiverDeviceId,
          token: meta.token,
        });
        if (!auth.ok) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: auth.code,
              message: auth.message,
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }
        sendJson(auth.targetSocket, envelope);
        return;
      }

      case 'ice_candidate': {
        const icePayload = envelope.payload as { candidate?: string };
        if (typeof icePayload.candidate !== 'string' || icePayload.candidate.trim().length === 0) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: 'INVALID_MESSAGE',
              message: 'ICE candidate string must be non-empty',
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }

        const auth = roomManager.authorizePeerSignaling({
          socket: ws,
          roomId: envelope.roomId,
          senderDeviceId: envelope.senderDeviceId,
          targetDeviceId: envelope.receiverDeviceId,
          token: meta.token,
        });
        if (!auth.ok) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: auth.code,
              message: auth.message,
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }
        sendJson(auth.targetSocket, envelope);
        return;
      }

      case 'stream_start': {
        const p = envelope.payload as {
          sessionId: string;
          streamId: string;
          width: number;
          height: number;
          fps: number;
          codec: CastoraVideoCodec;
        };
        const reg = roomManager.registerStreamStart({
          socket: ws,
          roomId: envelope.roomId,
          senderDeviceId: envelope.senderDeviceId,
          targetDeviceId: envelope.receiverDeviceId,
          token: meta.token,
          sessionId: p.sessionId,
          streamId: p.streamId,
          width: p.width,
          height: p.height,
          fps: p.fps,
          codec: p.codec,
        });
        if (!reg.ok) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: reg.code,
              message: reg.message,
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }
        sendJson(reg.targetSocket, envelope);
        broadcastRoomState(roomManager, reg.room, reg.authorizedSockets);
        return;
      }

      case 'stream_stop': {
        const p = envelope.payload as {
          sessionId: string;
          streamId: string;
        };
        const reg = roomManager.registerStreamStop({
          socket: ws,
          roomId: envelope.roomId,
          senderDeviceId: envelope.senderDeviceId,
          targetDeviceId: envelope.receiverDeviceId,
          token: meta.token,
          sessionId: p.sessionId,
          streamId: p.streamId,
        });
        if (!reg.ok) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: reg.code,
              message: reg.message,
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }
        sendJson(reg.targetSocket, envelope);
        broadcastRoomState(roomManager, reg.room, reg.authorizedSockets);
        return;
      }

      case 'stream_status': {
        const auth = roomManager.authorizePeerSignaling({
          socket: ws,
          roomId: envelope.roomId,
          senderDeviceId: envelope.senderDeviceId,
          targetDeviceId: envelope.receiverDeviceId,
          token: meta.token,
        });
        if (!auth.ok) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: auth.code,
              message: auth.message,
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }
        sendJson(auth.targetSocket, envelope);
        return;
      }

      default: {
        const auth = roomManager.authorizePeerSignaling({
          socket: ws,
          roomId: envelope.roomId,
          senderDeviceId: envelope.senderDeviceId,
          targetDeviceId: envelope.receiverDeviceId,
          token: meta.token,
        });
        if (!auth.ok) {
          sendJson(
            ws,
            createErrorEnvelope({
              receiverDeviceId: envelope.senderDeviceId,
              roomId: envelope.roomId,
              code: auth.code,
              message: auth.message,
              recoverable: true,
              relatedMessageId: envelope.messageId,
            })
          );
          return;
        }
        sendJson(auth.targetSocket, envelope);
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
