import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

interface ClientMeta {
  id: string;
  name: string;
  deviceType: 'mobile' | 'desktop';
  roomCode: string;
  isHost: boolean;
  ip: string;
  messageCount: number;
  lastMessageReset: number;
  ws: WebSocket;
}

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

// Configurable origins from environment
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS ?? '';
const customAllowedOrigins = rawAllowedOrigins
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Security & Rate Limiting constants
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_MESSAGES_PER_SEC = 50;
const MAX_JSON_PAYLOAD_BYTES = 64 * 1024; // 64 KB for signaling
const MAX_BINARY_CHUNK_BYTES = 512 * 1024; // 512 KB per relay chunk

const clients = new Map<string, ClientMeta>();
const aliveClients = new WeakMap<WebSocket, boolean>();
const ipConnectionCounts = new Map<string, number>();

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function isOriginAllowed(originHeader?: string): boolean {
  if (!originHeader) return true; // Non-browser clients, tests, or same-origin
  try {
    const originUrl = new URL(originHeader);
    const host = originUrl.hostname.toLowerCase();

    // Local development & LAN
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return true;
    }

    // Vercel production and preview deployments
    if (host === 'vercel.app' || host.endsWith('.vercel.app')) {
      return true;
    }

    // Custom allowed origins from environment variable
    if (customAllowedOrigins.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// 1. Create HTTP server for health checks, zero-downtime Render pings & CORS
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health' || url.pathname === '/') {
    const activeRooms = new Set(
      Array.from(clients.values())
        .map((c) => c.roomCode)
        .filter(Boolean)
    );

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'localdrop-signaling',
        uptime: Math.round(process.uptime()),
        timestamp: Date.now(),
        connections: clients.size,
        activeRooms: activeRooms.size,
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: url.pathname }));
});

// 2. Attach WebSocket server to the shared HTTP server
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024 * 1024, // 16MB absolute max frame size
  verifyClient: (info, callback) => {
    const origin = info.origin;
    if (!isOriginAllowed(origin)) {
      console.warn(`[LocalDrop Server] Blocked connection from unauthorized origin: ${origin}`);
      callback(false, 403, 'Unauthorized Origin');
      return;
    }

    const ip = getClientIp(info.req);
    const count = ipConnectionCounts.get(ip) ?? 0;
    if (count >= MAX_CONNECTIONS_PER_IP) {
      console.warn(`[LocalDrop Server] Rate limit: IP ${ip} exceeded max connections (${count})`);
      callback(false, 429, 'Too Many Connections');
      return;
    }

    callback(true);
  },
});

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

wss.on('connection', (ws, req) => {
  aliveClients.set(ws, true);

  const ip = getClientIp(req);
  ipConnectionCounts.set(ip, (ipConnectionCounts.get(ip) ?? 0) + 1);

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
    ip,
    messageCount: 0,
    lastMessageReset: Date.now(),
    ws,
  };
  clients.set(id, client);

  // Send initial welcome message with client ID
  ws.send(JSON.stringify({ type: 'welcome', id }));

  ws.on('message', (raw, isBinary) => {
    aliveClients.set(ws, true);

    // Rate limiting: check messages per second
    const now = Date.now();
    if (now - client.lastMessageReset > 1000) {
      client.messageCount = 1;
      client.lastMessageReset = now;
    } else {
      client.messageCount++;
      if (client.messageCount > MAX_MESSAGES_PER_SEC) {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many messages sent. Please slow down.',
          })
        );
        return;
      }
    }

    // Forward binary file chunks directly to the paired peer in the same room
    if (isBinary) {
      if (!client.roomCode) return;

      const rawBuffer = raw as Buffer;
      if (rawBuffer.length > MAX_BINARY_CHUNK_BYTES) {
        console.warn(`[LocalDrop Server] Binary chunk exceeded max limit (${rawBuffer.length} bytes)`);
        return;
      }

      const peers = getRoomMembers(client.roomCode);
      for (const peer of peers) {
        if (peer.id !== client.id && peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(raw, { binary: true });
        }
      }
      return;
    }

    // Enforce JSON size limit
    const rawBuffer = raw as Buffer;
    if (rawBuffer.length > MAX_JSON_PAYLOAD_BYTES) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Signaling payload exceeds maximum allowed size (64KB)',
        })
      );
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

    // Decrement IP count
    const curCount = ipConnectionCounts.get(ip) ?? 1;
    if (curCount <= 1) {
      ipConnectionCounts.delete(ip);
    } else {
      ipConnectionCounts.set(ip, curCount - 1);
    }

    if (oldRoom) {
      broadcastRoomPeers(oldRoom);
    }
  });
});

// Periodic heartbeat: 25 seconds interval to prevent Render proxy 55s idle drop
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (aliveClients.get(ws) === false) {
      ws.terminate();
      continue;
    }
    aliveClients.set(ws, false);
    ws.ping();
  }
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Graceful shutdown handling for Render zero-downtime container rotations
function handleShutdown(signal: string) {
  console.log(`[LocalDrop Server] Received ${signal}, shutting down gracefully...`);
  clearInterval(heartbeatInterval);
  for (const ws of wss.clients) {
    ws.close(1001, 'Server shutting down');
  }
  wss.close(() => {
    server.close(() => {
      console.log('[LocalDrop Server] Closed all connections and stopped.');
      process.exit(0);
    });
  });
  // Force exit if graceful close hangs
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log(`LocalDrop signaling & relay server listening on http://${HOST}:${PORT} (WebSocket attached)`);
});
