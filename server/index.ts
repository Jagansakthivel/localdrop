import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

interface ClientMeta {
  id: string;
  name: string;
  deviceType: 'mobile' | 'desktop';
  roomCode: string;
  isHost: boolean;
  ws: WebSocket;
}

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const wss = new WebSocketServer({
  port: PORT,
  host: HOST,
  maxPayload: 16 * 1024 * 1024, // 16MB max message payload for binary relay
});

const clients = new Map<string, ClientMeta>();
const aliveClients = new WeakMap<WebSocket, boolean>();

function getRoomMembers(roomCode: string): ClientMeta[] {
  if (!roomCode) return [];
  return Array.from(clients.values()).filter((c) => c.roomCode === roomCode);
}

function broadcastRoomPeers(roomCode: string) {
  if (!roomCode) return;
  const members = getRoomMembers(roomCode);
  for (const member of members) {
    const others = members
      .filter((m) => m.id !== member.id)
      .map(({ id, name, deviceType }) => ({ id, name, deviceType }));

    if (member.ws.readyState === WebSocket.OPEN) {
      member.ws.send(
        JSON.stringify({
          type: 'room-peers',
          roomCode,
          peers: others,
        })
      );
    }
  }
}

wss.on('connection', (ws) => {
  aliveClients.set(ws, true);

  ws.on('pong', () => {
    aliveClients.set(ws, true);
  });

  ws.on('error', (err) => {
    console.warn('[LocalDrop Server] Socket error:', err.message);
  });

  const id = crypto.randomUUID();
  const client: ClientMeta = {
    id,
    name: 'Device',
    deviceType: 'desktop',
    roomCode: '',
    isHost: false,
    ws,
  };
  clients.set(id, client);

  // Send initial welcome message with client ID
  ws.send(JSON.stringify({ type: 'welcome', id }));

  ws.on('message', (raw, isBinary) => {
    aliveClients.set(ws, true);

    // Forward binary file chunks directly to the paired peer in the same room
    if (isBinary) {
      if (!client.roomCode) return;
      const peers = getRoomMembers(client.roomCode);
      for (const peer of peers) {
        if (peer.id !== client.id && peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(raw, { binary: true });
        }
      }
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'INVALID_JSON',
          message: 'Malformed JSON signaling payload',
        })
      );
      return;
    }

    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'register') {
      if (typeof msg.name === 'string' && msg.name.trim()) {
        client.name = msg.name.trim().slice(0, 50);
      }
      if (msg.deviceType === 'mobile' || msg.deviceType === 'desktop') {
        client.deviceType = msg.deviceType;
      }
      if (client.roomCode) {
        broadcastRoomPeers(client.roomCode);
      }
    } else if (msg.type === 'create-room') {
      const roomCode = String(msg.roomCode || '').trim();
      if (!/^\d{4}$/.test(roomCode)) {
        ws.send(
          JSON.stringify({
            type: 'room-error',
            code: 'INVALID_PIN',
            message: 'Room code must be a 4-digit PIN',
          })
        );
        return;
      }

      const prevRoom = client.roomCode;
      client.roomCode = roomCode;
      client.isHost = true;

      if (prevRoom && prevRoom !== roomCode) {
        broadcastRoomPeers(prevRoom);
      }

      ws.send(
        JSON.stringify({
          type: 'room-created',
          roomCode,
        })
      );
      broadcastRoomPeers(roomCode);
    } else if (msg.type === 'join-room') {
      const roomCode = String(msg.roomCode || '').trim();
      const createIfMissing = Boolean(msg.createIfMissing);

      if (!/^\d{4}$/.test(roomCode)) {
        ws.send(
          JSON.stringify({
            type: 'room-error',
            code: 'INVALID_PIN',
            message: 'PIN must be exactly 4 digits',
          })
        );
        return;
      }

      const existingMembers = getRoomMembers(roomCode);

      if (existingMembers.length === 0 && !createIfMissing) {
        ws.send(
          JSON.stringify({
            type: 'room-error',
            code: 'ROOM_NOT_FOUND',
            message: `PIN ${roomCode} was not found. Check the code on the other device.`,
          })
        );
        return;
      }

      // Check room capacity (max 2 devices per session)
      const others = existingMembers.filter((m) => m.id !== client.id);
      if (others.length >= 2) {
        ws.send(
          JSON.stringify({
            type: 'room-error',
            code: 'ROOM_FULL',
            message: `Room ${roomCode} is already full (max 2 devices per session).`,
          })
        );
        return;
      }

      const prevRoom = client.roomCode;
      client.roomCode = roomCode;
      client.isHost = existingMembers.length === 0;

      if (prevRoom && prevRoom !== roomCode) {
        broadcastRoomPeers(prevRoom);
      }

      ws.send(
        JSON.stringify({
          type: 'room-joined',
          roomCode,
          isHost: client.isHost,
        })
      );

      broadcastRoomPeers(roomCode);

      // Notify host that peer has joined
      for (const peer of others) {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(
            JSON.stringify({
              type: 'peer-joined-room',
              roomCode,
              peer: {
                id: client.id,
                name: client.name,
                deviceType: client.deviceType,
              },
            })
          );
        }
      }
    } else if (msg.type === 'leave-room') {
      const oldRoom = client.roomCode;
      client.roomCode = '';
      client.isHost = false;
      if (oldRoom) {
        broadcastRoomPeers(oldRoom);
      }
    } else if (msg.type === 'signal' && typeof msg.to === 'string') {
      // Security check: only allow signaling between peers in the same room
      const target = clients.get(msg.to);
      if (
        target &&
        target.roomCode === client.roomCode &&
        target.ws.readyState === WebSocket.OPEN
      ) {
        target.ws.send(
          JSON.stringify({
            type: 'signal',
            from: client.id,
            fromName: client.name,
            fromDeviceType: client.deviceType,
            signal: msg.signal,
          })
        );
      }
    } else if (msg.type === 'relay' && client.roomCode) {
      // Forward relay message exclusively to the paired peer in the same room
      const peers = getRoomMembers(client.roomCode);
      for (const peer of peers) {
        if (peer.id !== client.id && peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(
            JSON.stringify({
              type: 'relay',
              from: client.id,
              payload: msg.payload,
            })
          );
        }
      }
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
    }
  });

  ws.on('close', () => {
    const oldRoom = client.roomCode;
    clients.delete(id);
    if (oldRoom) {
      broadcastRoomPeers(oldRoom);
    }
  });
});

// Periodic heartbeat to terminate abandoned or zombie sockets
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (aliveClients.get(ws) === false) {
      ws.terminate();
      continue;
    }
    aliveClients.set(ws, false);
    ws.ping();
  }
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

console.log(`LocalDrop signaling & relay server listening on ${HOST}:${PORT}`);
