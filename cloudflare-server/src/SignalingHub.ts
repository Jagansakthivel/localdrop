import { roomWireVersion } from './network-v2/protocol';
import { SerialQueue, SocketEventQueue } from './network-v2/eventQueue';
import { admitRelayMeta } from './network-v2/relayAdmission';
import { RoomIndex } from './network-v2/roomIndex';
import { DurableObject } from 'cloudflare:workers';
import {
  ClientMeta,
  PeerInfo,
  ServerMessage,
  SECURITY_LIMITS,
  Env,
} from './types';
import {
  consume,
  openLedger,
  chargeFrame,
  applyCredit,
  RELAY_RATE,
  consumeRelayCredit,
  RELAY_BURST,
  CONTROL_RATE,
  MAX_RELAY_FRAME,
} from './network-v2/relayBudget';
import { iceServersResponse } from './network-v2/turn';
import { authorizeTurn, TURN_QUOTA_DDL } from './network-v2/turnAuth';
import { resolveTurnOrigin } from './index';

/**
 * SignalingHub
 *
 * SQLite-backed Durable Object powering LocalDrop WebRTC signaling and data relay.
 * Uses Cloudflare WebSocket Hibernation API for zero-cost standby and sub-millisecond edge wakeups.
 */
export class SignalingHub extends DurableObject<Env> {
  private readonly socketEvents = new SocketEventQueue<WebSocket>();
  private readonly membershipEvents = new SerialQueue();
  private readonly roomsIndex = new RoomIndex<WebSocket, ClientMeta>(
    (ws) => ws.deserializeAttachment() as ClientMeta | null,
    (ws) => ws.readyState === WebSocket.OPEN && !this.terminatedSockets.has(ws)
  );

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initDatabase();
    this.roomsIndex.hydrate(this.ctx.getWebSockets());
  }

  /**
   * Initialize SQLite tables for rooms, audit, and brute-force protection.
   */
  private initDatabase(): void {
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          room_code TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pin_rate_limits (
          ip TEXT PRIMARY KEY,
          failed_attempts INTEGER NOT NULL,
          blocked_until INTEGER NOT NULL,
          last_attempt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_credentials (
          participant_id TEXT PRIMARY KEY,
          room_code TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          device_type TEXT NOT NULL,
          is_host INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          grace_until INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(TURN_QUOTA_DDL);
    } catch (err) {
      console.error('[SignalingHub SQLite] Database initialization error:', err);
    }
  }

  /**
   * Handle incoming HTTP or WebSocket upgrade requests.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 0. Authenticated TURN credential endpoint (exact origin check)
    if (url.pathname === '/api/ice-servers') {
      const origin = resolveTurnOrigin(request.headers.get('Origin'), this.env.TURN_ALLOWED_ORIGINS);
      if (!origin) {
        return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      return iceServersResponse(
        request,
        this.env,
        (room, token, ip) =>
          authorizeTurn(
            {
              query: (sql, ...args) => this.ctx.storage.sql.exec(sql, ...args).toArray(),
              execute: (sql, ...args) => {
                this.ctx.storage.sql.exec(sql, ...args);
              },
              transaction: (fn) => this.ctx.storage.transactionSync(fn),
              activeParticipant: (roomCode, id, _clientIp) =>
                this.getRoomSockets(roomCode).some(
                  (p) => p.meta.id === id && p.ws.readyState === WebSocket.OPEN
                ),
            },
            room,
            token,
            ip
          ),
        origin
      );
    }

    // WebSocket upgrades must precede HTTP health routing.
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === '/health' || url.pathname === '/' || url.pathname === '/stats') {
      return this.handleHealthCheck();
    }

    return new Response(JSON.stringify({ error: 'Not Found', path: url.pathname }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Health check reporting active connections and rooms.
   */
  private handleHealthCheck(): Response {
    const activeSockets = this.ctx.getWebSockets();
    const activeRooms = new Set<string>();

    for (const ws of activeSockets) {
      try {
        const meta = ws.deserializeAttachment() as ClientMeta | null;
        if (meta?.roomCode) {
          activeRooms.add(meta.roomCode);
        }
      } catch {
        // Ignore stale socket attachments
      }
    }

    return new Response(
      JSON.stringify({
        status: 'ok',
        service: 'localdrop-signaling',
        platform: 'cloudflare-workers-durable-objects',
        storage: 'sqlite',
        connections: activeSockets.length,
        activeRooms: activeRooms.size,
        timestamp: Date.now(),
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      }
    );
  }

  /**
   * Establish WebSocket connection and register with hibernation API.
   */
  private handleWebSocketUpgrade(request: Request): Response {
    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      '127.0.0.1';

    // Connection rate limit check per IP
    const currentIpConnections = this.countConnectionsForIp(clientIp);
    if (currentIpConnections >= SECURITY_LIMITS.MAX_CONNECTIONS_PER_IP) {
      console.warn(`[SignalingHub] Blocked IP ${clientIp}: exceeded max connections`);
      return new Response('Too Many Connections', {
        status: 429,
        headers: { 'Retry-After': '60' },
      });
    }

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);

    const clientId = crypto.randomUUID();
    const now = Date.now();
    const meta: ClientMeta = {
      id: clientId,
      name: 'Device',
      deviceType: 'desktop',
      roomCode: '',
      isHost: false,
      ip: clientIp,
      messageCount: 0,
      lastMessageReset: now,
      connectedAt: now,
    };

    // Accept server side of WebSocket into hibernation with client ID tag
    this.ctx.acceptWebSocket(serverSocket, [`client:${clientId}`]);
    serverSocket.serializeAttachment(meta);

    // Send immediate welcome handshake
    this.sendJson(serverSocket, {
      type: 'welcome',
      id: clientId,
      networkVersion: 2,
      v2Supported: true,
    });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }

  /**
   * WebSocket Hibernation API: serialize incoming socket events & membership transitions.
   */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const bytes =
      typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
    try {
      await this.socketEvents.run(ws, bytes, async () => {
        if (ws.readyState !== WebSocket.OPEN || this.terminatedSockets.has(ws)) return;
        let isMembership = false;
        if (typeof message === 'string' && message.length <= SECURITY_LIMITS.MAX_JSON_PAYLOAD_BYTES) {
          try {
            const parsed = JSON.parse(message) as { type?: unknown };
            if (
              parsed &&
              typeof parsed === 'object' &&
              (parsed.type === 'register' ||
                parsed.type === 'create-room' ||
                parsed.type === 'join-room' ||
                parsed.type === 'resume-session' ||
                parsed.type === 'leave-room')
            ) {
              isMembership = true;
            }
          } catch {
            // Validation handled inside dispatchMessage
          }
        }
        if (isMembership) {
          await this.membershipEvents.run(() => this.dispatchMessage(ws, message));
        } else {
          await this.dispatchMessage(ws, message);
        }
      });
    } catch (err) {
      this.sendJson(ws, {
        type: 'error',
        code: 'RATE_LIMIT_EXCEEDED',
        message: err instanceof Error ? err.message : 'Signaling queue overloaded',
      });
      await this.handleSocketTermination(ws, 1008, 'Signaling queue overloaded');
    }
  }

  private async dispatchMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN || this.terminatedSockets.has(ws)) return;
    let meta: ClientMeta;
    try {
      meta = ws.deserializeAttachment() as ClientMeta;
      if (!meta || !meta.id) throw new Error('Missing metadata');
    } catch {
      console.error('[SignalingHub] Received message on uninitialized WebSocket attachment');
      return;
    }

    // 1. Binary message handling BEFORE legacy JSON limiter
    if (message instanceof ArrayBuffer) {
      if (!meta.roomCode) return;

      const paired = this.getRoomSockets(meta.roomCode).filter((m) => m.meta.id !== meta.id);
      const wireVersion = roomWireVersion(meta.networkVersion, paired.map((p) => p.meta.networkVersion));
      if (wireVersion === null) {
        console.warn('[SignalingHub] Relay rejected: invalid peer count', {
          peerCount: paired.length,
          bytes: message.byteLength,
          hasLedger: Boolean(meta.relayLedger),
          hasPending: Boolean(meta.relayPending),
        });
        this.abortRelayTransfer(ws, meta, 'Relay requires exactly one paired peer');
        return;
      }
      if (wireVersion === 2) {
        if (message.byteLength > MAX_RELAY_FRAME) {
          this.abortRelayTransfer(ws, meta, 'Relay frame exceeds 256 KiB limit');
          return;
        }

        // 5-byte credit ACK from receiver -> opposite sender's ledger
        if (message.byteLength === 5) {
          const creditCheck = consumeRelayCredit(meta.relayCreditBucket);
          const sender = paired.find((m) => m.meta.relayLedger?.targetId === meta.id);
          if (!creditCheck.allowed) {
            // A rejected attempt spends no tokens. Retaining the last accepted bucket
            // computes the same refill without persisting each rejected frame.
            if (sender) this.abortRelayTransfer(sender.ws, sender.meta, 'Relay credit rate exceeded');
            return;
          }
          meta.relayCreditBucket = creditCheck.state;
          ws.serializeAttachment(meta);
          // Late credits after cancellation cannot be associated with a transfer.
          if (!sender || !sender.meta.relayLedger) return;

          try {
            const updatedLedger = applyCredit(sender.meta.relayLedger, message);
            sender.meta.relayLedger = {
              ...sender.meta.relayLedger,
              ...updatedLedger,
            };
            sender.ws.serializeAttachment(sender.meta);
            sender.ws.send(message);
          } catch (err) {
            this.abortRelayTransfer(
              sender.ws,
              sender.meta,
              err instanceof Error ? err.message : 'Invalid relay credit'
            );
          }
          return;
        }

        // >=8-byte binary data frame from sender -> paired recipient
        const binCheck = consume(meta.binaryBucket, message.byteLength, RELAY_RATE, RELAY_BURST);
        meta.binaryBucket = binCheck.state;
        if (!binCheck.allowed) {
          ws.serializeAttachment(meta);
          this.abortRelayTransfer(ws, meta, 'Relay bandwidth quota exceeded');
          return;
        }

        const ledger = meta.relayLedger;
        if (!ledger) {
          ws.serializeAttachment(meta);
          this.sendJson(ws, {
            type: 'error',
            code: 'RELAY_NO_LEDGER',
            message: 'No active relay transfer ledger',
          });
          return;
        }

        try {
          const nextLedger = chargeFrame(ledger, message);
          meta.relayLedger = { ...ledger, ...nextLedger };
        } catch (err) {
          ws.serializeAttachment(meta);
          this.abortRelayTransfer(
            ws,
            meta,
            err instanceof Error ? err.message : 'Invalid relay frame'
          );
          return;
        }

        const target = paired.find((m) => m.meta.id === ledger.targetId);
        if (!target) {
          ws.serializeAttachment(meta);
          this.abortRelayTransfer(ws, meta, 'Paired peer disconnected');
          return;
        }

        ws.serializeAttachment(meta);
        target.ws.send(message);
        return;
      }

      // Mixed/v1 sessions retain compatibility but must also be bandwidth limited.
      const legacyBudget = consume(meta.binaryBucket, message.byteLength, RELAY_RATE, RELAY_BURST);
      meta.binaryBucket = legacyBudget.state;
      if (!legacyBudget.allowed) {
        ws.serializeAttachment(meta);
        this.abortRelayTransfer(ws, meta, 'Legacy relay bandwidth quota exceeded');
        return;
      }
      // Legacy v1 binary forwarding
      if (message.byteLength > SECURITY_LIMITS.MAX_BINARY_CHUNK_BYTES) {
        this.abortRelayTransfer(ws, meta, 'Legacy relay frame exceeds size limit');
        return;
      }

      const members = this.getRoomSockets(meta.roomCode);
      for (const peer of members) {
        if (peer.meta.id !== meta.id) {
          peer.ws.send(message);
        }
      }
      ws.serializeAttachment(meta);
      return;
    }

    // 2. Legacy per-second message rate limit + token-bucket control limiter for JSON
    const now = Date.now();
    if (now - meta.lastMessageReset > 1000) {
      meta.messageCount = 1;
      meta.lastMessageReset = now;
    } else {
      meta.messageCount++;
      if (meta.messageCount > SECURITY_LIMITS.MAX_MESSAGES_PER_SEC) {
        this.sendJson(ws, {
          type: 'error',
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many messages sent. Please slow down.',
        });
        ws.serializeAttachment(meta);
        return;
      }
    }

    // 3. String / UTF-8 byte size validation & JSON parsing
    const rawString = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(rawString).byteLength > SECURITY_LIMITS.MAX_JSON_PAYLOAD_BYTES) {
      this.sendJson(ws, {
        type: 'error',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Signaling payload exceeds maximum allowed size (64KB)',
      });
      ws.serializeAttachment(meta);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(rawString);
    } catch {
      this.sendJson(ws, {
        type: 'error',
        code: 'INVALID_JSON',
        message: 'Malformed JSON signaling payload',
      });
      ws.serializeAttachment(meta);
      return;
    }

    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      ws.serializeAttachment(meta);
      return;
    }

    // Control token bucket check (bypass for initial register / join-room / ping which have own guards)
    if (msg.type !== 'register' && msg.type !== 'join-room' && msg.type !== 'ping' && msg.type !== 'signal') {
      const ctrlCheck = consume(meta.controlBucket, 1, CONTROL_RATE, CONTROL_RATE, now);
      meta.controlBucket = ctrlCheck.state;
      if (!ctrlCheck.allowed) {
        this.sendJson(ws, {
          type: 'error',
          code: 'CONTROL_RATE_LIMIT',
          message: 'Control message rate exceeded.',
        });
        ws.serializeAttachment(meta);
        return;
      }
    }

    // 4. Protocol Dispatch
    switch (msg.type) {
      case 'register': {
        if (typeof msg.name === 'string' && msg.name.trim()) {
          meta.name = msg.name.trim().slice(0, 50);
        }
        if (msg.deviceType === 'mobile' || msg.deviceType === 'desktop') {
          meta.deviceType = msg.deviceType;
        }
        meta.networkVersion = msg.networkVersion === 2 ? 2 : 1;
        ws.serializeAttachment(meta);
        if (meta.roomCode) {
          this.broadcastRoomPeers(meta.roomCode);
        }
        break;
      }

      case 'create-room': {
        const roomCode = String(msg.roomCode || '').trim();
        if (!/^\d{4}$/.test(roomCode)) {
          this.sendJson(ws, {
            type: 'room-error',
            code: 'INVALID_PIN',
            message: 'Room code must be a 4-digit PIN',
          });
          ws.serializeAttachment(meta);
          return;
        }

        // Reject occupied PINs before modifying membership or credentials.
        let occupied = false;
        try {
          const occupants = this.getRoomSockets(roomCode).filter((m) => m.ws !== ws);
          occupied = occupants.length > 0 || this.countReservedGraceSlots(roomCode, meta.id) > 0;
        } catch {
          occupied = true;
        }
        if (occupied) {
          this.sendJson(ws, { type: 'room-error', code: 'ROOM_TAKEN', message: 'PIN already in use' });
          ws.serializeAttachment(meta);
          return;
        }
        const prevRoom = meta.roomCode;
        const prevTransferId = meta.relayLedger?.transferId ?? meta.relayPending?.transferId;
        if (prevRoom && prevRoom !== roomCode) {
          if (prevTransferId) {
            this.notifyRoomTransferAborted(prevRoom, meta.id, prevTransferId, 'Peer left room');
          }
          meta.relayLedger = undefined;
          meta.relayPending = undefined;
        }
        meta.roomCode = roomCode;
        meta.isHost = true;
        this.persistMeta(ws, meta);

        this.saveRoom(roomCode, meta.id);

        if (prevRoom && prevRoom !== roomCode) {
          this.deleteCredential(meta.id);
          this.broadcastRoomPeers(prevRoom);
          this.cleanUpRoomIfEmpty(prevRoom);
        }

        const resumeToken = await this.issueCredential(meta);

        this.sendJson(ws, {
          type: 'room-created',
          roomCode,
          resumeToken,
        });
        this.broadcastRoomPeers(roomCode);
        break;
      }

      case 'join-room': {
        const roomCode = String(msg.roomCode || '').trim();
        const createIfMissing = Boolean(msg.createIfMissing);

        if (!/^\d{4}$/.test(roomCode)) {
          this.sendJson(ws, {
            type: 'room-error',
            code: 'INVALID_PIN',
            message: 'PIN must be exactly 4 digits',
          });
          ws.serializeAttachment(meta);
          return;
        }

        // Check PIN brute-force lockout
        if (this.isIpPinBlocked(meta.ip)) {
          this.sendJson(ws, {
            type: 'room-error',
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many incorrect PIN attempts. Please wait 5 minutes before trying again.',
          });
          ws.serializeAttachment(meta);
          return;
        }

        const existingMembers = this.getRoomSockets(roomCode);

        // Room not found check
        if (existingMembers.length === 0 && !createIfMissing) {
          this.recordFailedPinAttempt(meta.ip);
          this.sendJson(ws, {
            type: 'room-error',
            code: 'ROOM_NOT_FOUND',
            message: `PIN ${roomCode} was not found. Check the code on the other device.`,
          });
          ws.serializeAttachment(meta);
          return;
        }

        // Capacity check: max 2 devices per session (including reserved grace slots)
        const others = existingMembers.filter((m) => m.meta.id !== meta.id);
        const reservedGraceCount = this.countReservedGraceSlots(roomCode, meta.id);
        if (others.length + reservedGraceCount >= 2) {
          this.sendJson(ws, {
            type: 'room-error',
            code: 'ROOM_FULL',
            message: `Room ${roomCode} is already full (max 2 devices per session).`,
          });
          ws.serializeAttachment(meta);
          return;
        }

        // Successful match: clear any prior PIN brute force counter
        this.resetFailedPinAttempts(meta.ip);

        const prevRoom = meta.roomCode;
        const prevTransferId = meta.relayLedger?.transferId ?? meta.relayPending?.transferId;
        if (prevRoom && prevRoom !== roomCode) {
          if (prevTransferId) {
            this.notifyRoomTransferAborted(prevRoom, meta.id, prevTransferId, 'Peer left room');
          }
          meta.relayLedger = undefined;
          meta.relayPending = undefined;
        }
        meta.roomCode = roomCode;
        meta.isHost = existingMembers.length === 0;
        this.persistMeta(ws, meta);

        this.saveRoom(roomCode, meta.isHost ? meta.id : existingMembers[0].meta.id);

        if (prevRoom && prevRoom !== roomCode) {
          this.deleteCredential(meta.id);
          this.broadcastRoomPeers(prevRoom);
          this.cleanUpRoomIfEmpty(prevRoom);
        }

        const resumeToken = await this.issueCredential(meta);

        this.sendJson(ws, {
          type: 'room-joined',
          roomCode,
          isHost: meta.isHost,
          resumeToken,
        });

        this.broadcastRoomPeers(roomCode);

        // Notify other room peer that this device joined
        for (const peer of others) {
          this.sendJson(peer.ws, {
            type: 'peer-joined-room',
            roomCode,
            peer: {
              id: meta.id,
              name: meta.name,
              deviceType: meta.deviceType,
              networkVersion: meta.networkVersion ?? 1,
            },
          });
        }
        break;
      }

      case 'resume-session': {
        const roomCode = String(msg.roomCode || '').trim();
        const resumeToken = typeof msg.resumeToken === 'string' ? msg.resumeToken : '';

        if (this.isIpPinBlocked(meta.ip)) {
          this.sendJson(ws, {
            type: 'room-error',
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many failed resume attempts. Please pair again.',
          });
          ws.serializeAttachment(meta);
          return;
        }

        if (!/^\d{4}$/.test(roomCode) || resumeToken.length < 32) {
          this.recordFailedPinAttempt(meta.ip);
          this.sendJson(ws, {
            type: 'room-error',
            code: 'RESUME_FAILED',
            message: 'Invalid session credentials. Please pair again.',
          });
          ws.serializeAttachment(meta);
          return;
        }

        const rotated = await this.validateAndRotateCredential(roomCode, resumeToken);
        if (!rotated) {
          this.recordFailedPinAttempt(meta.ip);
          this.sendJson(ws, {
            type: 'room-error',
            code: 'RESUME_FAILED',
            message: 'Session expired or invalid. Please pair again.',
          });
          ws.serializeAttachment(meta);
          return;
        }

        this.resetFailedPinAttempts(meta.ip);

        // Close any stale half-open socket still carrying the same participantId (HIGH-09)
        for (const existingWs of this.ctx.getWebSockets()) {
          if (existingWs === ws) continue;
          try {
            const existingMeta = existingWs.deserializeAttachment() as ClientMeta | null;
            if (existingMeta && existingMeta.id === rotated.participantId) {
              existingMeta.roomCode = '';
              existingMeta.relayPending = undefined;
              existingMeta.relayLedger = undefined;
              existingWs.serializeAttachment(existingMeta);
              this.terminatedSockets.add(existingWs);
              existingWs.close(1000, 'Replaced by resumed session');
            }
          } catch {
            // ignore
          }
        }

        meta.id = rotated.participantId;
        meta.roomCode = roomCode;
        meta.isHost = rotated.isHost;
        meta.name = rotated.name;
        meta.deviceType = rotated.deviceType;
        meta.relayPending = undefined;
        meta.relayLedger = undefined;
        this.persistMeta(ws, meta);

        if (meta.isHost) {
          this.saveRoom(roomCode, meta.id);
        } else {
          this.touchRoom(roomCode);
        }

        this.sendJson(ws, {
          type: 'session-resumed',
          roomCode,
          participantId: meta.id,
          isHost: meta.isHost,
          resumeToken: rotated.newResumeToken,
        });

        this.broadcastRoomPeers(roomCode);
        break;
      }

      case 'leave-room': {
        const oldRoom = meta.roomCode;
        const oldId = meta.id;
        const activeTransferId = meta.relayLedger?.transferId ?? meta.relayPending?.transferId;
        meta.roomCode = '';
        meta.isHost = false;
        meta.relayPending = undefined;
        meta.relayLedger = undefined;
        this.persistMeta(ws, meta);

        this.deleteCredential(oldId);

        if (oldRoom) {
          if (activeTransferId) {
            this.notifyRoomTransferAborted(oldRoom, oldId, activeTransferId, 'Peer left room');
          }
          this.broadcastRoomPeers(oldRoom);
          this.cleanUpRoomIfEmpty(oldRoom);
        }
        break;
      }

      case 'v2-path': {
        if (
          meta.roomCode &&
          typeof msg.epoch === 'string' &&
          msg.epoch.length <= 64 &&
          (msg.path === 'rtc' || msg.path === 'relay') &&
          typeof msg.stage === 'string'
        ) {
          const members = this.getRoomSockets(meta.roomCode);
          const target =
            typeof msg.to === 'string'
              ? members.find((m) => m.meta.id === msg.to && m.meta.id !== meta.id)
              : members.find((m) => m.meta.id !== meta.id);
          if (target) {
            this.sendJson(target.ws, {
              type: 'v2-path',
              from: meta.id,
              epoch: msg.epoch,
              path: msg.path,
              stage: msg.stage,
            });
          }
        }
        ws.serializeAttachment(meta);
        break;
      }

      case 'signal': {
        if (typeof msg.to === 'string' && meta.roomCode) {
          // Security isolation: only route signals between members of the same room
          const members = this.getRoomSockets(meta.roomCode);
          const target = members.find((m) => m.meta.id === msg.to);
          if (target) {
            this.sendJson(target.ws, {
              type: 'signal',
              from: meta.id,
              fromName: meta.name,
              fromDeviceType: meta.deviceType,
              signal: msg.signal,
            });
          }
        }
        ws.serializeAttachment(meta);
        break;
      }

      case 'relay': {
        if (meta.roomCode) {
          const members = this.getRoomSockets(meta.roomCode);
          const peers = members.filter((m) => m.meta.id !== meta.id);
          const payload = msg.payload as Record<string, unknown> | undefined;

          if (payload && typeof payload === 'object' && typeof payload.type === 'string') {
            if (payload.type === 'v2-meta') {
              if (roomWireVersion(meta.networkVersion, peers.map((p) => p.meta.networkVersion)) !== 2) {
                this.sendJson(ws, { type: 'error', code: 'RELAY_PROTOCOL_MISMATCH', message: 'Both peers must support v2', ...(typeof payload.transferId === 'string' ? { transferId: payload.transferId } : {}) });
                ws.serializeAttachment(meta);
                return;
              }
              const target = peers[0];
              const admission = admitRelayMeta(
                payload,
                target?.meta.id,
                Boolean(
                  meta.relayLedger || meta.relayPending ||
                  (typeof payload.transferId === 'string' &&
                    (target?.meta.relayLedger?.transferId === payload.transferId ||
                      target?.meta.relayPending?.transferId === payload.transferId))
                )
              );
              if (!admission.ok) {
                this.sendJson(ws, {
                  type: 'error',
                  code: admission.code,
                  message: admission.code === 'RELAY_BUSY' ? 'Relay transfer already active' : 'Invalid v2 relay metadata',
                  ...(typeof payload.transferId === 'string' && payload.transferId.length <= 128
                    ? { transferId: payload.transferId }
                    : {}),
                });
                ws.serializeAttachment(meta);
                return;
              }
              meta.relayPending = admission.meta;
              ws.serializeAttachment(meta);
              this.sendJson(target.ws, {
                type: 'relay',
                from: meta.id,
                payload: msg.payload,
              });
              return;
            }

            if (payload.type === 'v2-ready') {
              const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
              const sender = peers.find(
                (p) => p.meta.relayPending?.transferId === transferId && p.meta.relayPending.targetId === meta.id
              );
              if (!sender || !sender.meta.relayPending || typeof payload.ok !== 'boolean') {
                this.sendJson(ws, {
                  type: 'error',
                  code: 'RELAY_INVALID_META',
                  message: 'Mismatched or unsolicited v2-ready',
                  ...(transferId ? { transferId } : {}),
                });
                return;
              }
              const pend = sender.meta.relayPending;
              if (payload.ok === true) {
                try {
                  const ledger = openLedger(pend.fileId, pend.size, pend.chunkSize);
                  sender.meta.relayPending = undefined;
                  sender.meta.relayLedger = {
                    ...ledger,
                    transferId: pend.transferId,
                    targetId: meta.id,
                    totalSize: pend.size,
                  };
                } catch (err) {
                  this.abortRelayTransfer(
                    sender.ws,
                    sender.meta,
                    err instanceof Error ? err.message : 'Failed to open relay ledger'
                  );
                  return;
                }
              } else {
                sender.meta.relayPending = undefined;
                sender.meta.relayLedger = undefined;
              }
              sender.ws.serializeAttachment(sender.meta);
              ws.serializeAttachment(meta);
              this.sendJson(sender.ws, {
                type: 'relay',
                from: meta.id,
                payload: msg.payload,
              });
              return;
            }

            if (payload.type === 'v2-end') {
              const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
              if (meta.relayLedger && meta.relayLedger.transferId === transferId) {
                if (meta.relayLedger.remaining !== 0) {
                  this.abortRelayTransfer(ws, meta, 'Premature v2-end before all bytes sent');
                  return;
                }
              }
            }

            if (payload.type === 'v2-result') {
              const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
              const sender = peers.find((p) => p.meta.relayLedger?.transferId === transferId);
              if (sender && sender.meta.relayLedger) {
                const led = sender.meta.relayLedger;
                if (payload.ok === true) {
                  const validDigest =
                    typeof payload.digest === 'string' && /^[0-9a-fA-F]{64}$/.test(payload.digest);
                  if (
                    led.remaining !== 0 ||
                    led.outstanding !== 0 ||
                    Number(payload.size) !== led.totalSize ||
                    !validDigest
                  ) {
                    sender.meta.relayLedger = undefined;
                    sender.ws.serializeAttachment(sender.meta);
                    this.sendJson(ws, {
                      type: 'error',
                      code: 'RELAY_RESULT_INVALID',
                      message: 'Result rejected: ledger not settled',
                      transferId,
                    });
                    ws.serializeAttachment(meta);
                    return;
                  }
                }
                sender.meta.relayLedger = undefined;
                sender.ws.serializeAttachment(sender.meta);
              }
            }

            if (payload.type === 'v2-cancel') {
              const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
              if (meta.relayLedger?.transferId === transferId) meta.relayLedger = undefined;
              if (meta.relayPending?.transferId === transferId) meta.relayPending = undefined;
              for (const p of peers) {
                if (p.meta.relayLedger?.transferId === transferId || p.meta.relayPending?.transferId === transferId) {
                  p.meta.relayLedger = undefined;
                  p.meta.relayPending = undefined;
                  p.ws.serializeAttachment(p.meta);
                }
              }
            }
          }

          // Forward relay payload exclusively to paired peer(s) in the same room
          for (const peer of peers) {
            this.sendJson(peer.ws, {
              type: 'relay',
              from: meta.id,
              payload: msg.payload,
            });
          }
        }
        ws.serializeAttachment(meta);
        break;
      }

      case 'ping': {
        this.sendJson(ws, {
          type: 'pong',
          timestamp: Date.now(),
        });
        ws.serializeAttachment(meta);
        break;
      }

      default:
        ws.serializeAttachment(meta);
        break;
    }
  }

  private terminatedSockets = new WeakSet<WebSocket>();

  private async handleSocketTermination(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (this.terminatedSockets.has(ws)) return;
    this.terminatedSockets.add(ws);
    this.roomsIndex.remove(ws);

    const runCleanup = async () => {
      let oldRoom = '';
      let participantId = '';
      let activeTransferId: string | undefined;
      try {
        const meta = ws.deserializeAttachment() as ClientMeta | null;
        if (meta?.roomCode) {
          oldRoom = meta.roomCode;
          participantId = meta.id;
          activeTransferId = meta.relayLedger?.transferId ?? meta.relayPending?.transferId;
          meta.relayLedger = undefined;
          meta.relayPending = undefined;
          ws.serializeAttachment(meta);
        }
      } catch {
        // Ignore
      }

      try {
        ws.close(code, reason);
      } catch {
        // Ignore
      }

      if (oldRoom && participantId) {
        if (activeTransferId) {
          this.notifyRoomTransferAborted(oldRoom, participantId, activeTransferId, 'Peer disconnected');
        }
        await this.markCredentialGrace(participantId);
        const remaining = this.getRoomSockets(oldRoom);
        console.info('[SignalingHub] Socket terminated', {
          code,
          remainingPeers: remaining.length,
          hadActiveTransfer: Boolean(activeTransferId),
        });
        for (const m of remaining) {
          this.sendJson(m.ws, {
            type: 'peer-reconnecting',
            roomCode: oldRoom,
            peerId: participantId,
            graceMs: 60000,
          });
        }
        this.cleanUpRoomIfEmpty(oldRoom);
      }
    };

    try {
      await this.membershipEvents.run(runCleanup);
    } catch {
      await runCleanup();
    }
  }

  /**
   * WebSocket Hibernation API: handle socket disconnection.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.handleSocketTermination(ws, code, reason);
  }

  /**
   * Durable Object alarm: purge expired grace credentials and empty rooms across hibernation.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    try {
      this.ctx.storage.sql.exec(
        'DELETE FROM session_credentials WHERE (grace_until > 0 AND grace_until <= ?) OR expires_at <= ?',
        now,
        now
      );

      this.ctx.storage.sql.exec(
        'DELETE FROM pin_rate_limits WHERE (blocked_until > 0 AND blocked_until <= ?) AND last_attempt <= ?',
        now,
        now - SECURITY_LIMITS.PIN_BLOCK_DURATION_MS
      );

      // Clean up any rooms that have neither active sockets nor active grace credentials
      const roomRows = this.ctx.storage.sql.exec('SELECT room_code FROM rooms').toArray();
      for (const row of roomRows) {
        const roomCode = String((row as Record<string, unknown>).room_code || '');
        if (roomCode) {
          this.cleanUpRoomIfEmpty(roomCode);
        }
      }

      // Schedule next alarm if any credentials are still in grace
      const nextRows = this.ctx.storage.sql
        .exec('SELECT MIN(grace_until) AS next_grace FROM session_credentials WHERE grace_until > 0')
        .toArray();
      const nextGrace = Number((nextRows[0] as Record<string, unknown> | undefined)?.next_grace || 0);
      if (nextGrace > now) {
        await this.ctx.storage.setAlarm(nextGrace);
      }
    } catch (err) {
      console.error('[SignalingHub Alarm] Error purging expired sessions:', err);
    }
  }

  /**
   * WebSocket Hibernation API: handle socket error.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn('[SignalingHub] WebSocket error event:', error);
    await this.handleSocketTermination(ws, 1011, 'WebSocket transport error');
  }

  // --- Helper Methods ---

  private notifyRoomTransferAborted(
    roomCode: string,
    fromId: string,
    transferId: string,
    reason: string
  ): void {
    const members = this.getRoomSockets(roomCode);
    for (const m of members) {
      if (m.meta.id !== fromId) {
        this.sendJson(m.ws, {
          type: 'relay',
          from: fromId,
          payload: { type: 'v2-cancel', transferId, reason },
        });
      }
    }
  }

  private abortRelayTransfer(ws: WebSocket, meta: ClientMeta, reason: string): void {
    const transferId = meta.relayLedger?.transferId ?? meta.relayPending?.transferId;
    meta.relayLedger = undefined;
    meta.relayPending = undefined;
    ws.serializeAttachment(meta);

    this.sendJson(ws, {
      type: 'error',
      code: 'RELAY_ABORTED',
      message: reason,
      ...(transferId ? { transferId } : {}),
    });

    if (meta.roomCode && transferId) {
      this.notifyRoomTransferAborted(meta.roomCode, meta.id, transferId, reason);
    }
  }

  private sendJson(ws: WebSocket, data: ServerMessage): void {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.warn('[SignalingHub] Failed to send JSON message:', err);
    }
  }

  private persistMeta(ws: WebSocket, meta: ClientMeta): void {
    ws.serializeAttachment(meta);
    this.roomsIndex.update(ws, meta.roomCode);
  }

  private getRoomSockets(roomCode: string): { ws: WebSocket; meta: ClientMeta }[] {
    if (!roomCode) return [];
    return this.roomsIndex.members(roomCode);
  }

  private countConnectionsForIp(ip: string): number {
    let count = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const meta = ws.deserializeAttachment() as ClientMeta | null;
        if (meta?.ip === ip) {
          count++;
        }
      } catch {
        // Ignore
      }
    }
    return count;
  }

  private broadcastRoomPeers(roomCode: string): void {
    if (!roomCode) return;
    const members = this.getRoomSockets(roomCode);

    for (const member of members) {
      const others: PeerInfo[] = members
        .filter((m) => m.meta.id !== member.meta.id)
        .map((m) => ({
          id: m.meta.id,
          name: m.meta.name,
          deviceType: m.meta.deviceType,
          networkVersion: m.meta.networkVersion ?? 1,
        }));

      this.sendJson(member.ws, {
        type: 'room-peers',
        roomCode,
        peers: others,
      });
    }
  }

  // --- SQLite Storage Operations ---

  private touchRoom(roomCode: string): void {
    try {
      this.ctx.storage.sql.exec(
        'UPDATE rooms SET updated_at = ? WHERE room_code = ?',
        Date.now(),
        roomCode
      );
    } catch (err) {
      console.error('[SignalingHub SQLite] Error updating room timestamp:', err);
    }
  }

  private saveRoom(roomCode: string, hostId: string): void {
    try {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO rooms (room_code, host_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_code) DO UPDATE SET updated_at = ?`,
        roomCode,
        hostId,
        now,
        now,
        now
      );
    } catch (err) {
      console.error('[SignalingHub SQLite] Error saving room:', err);
    }
  }

  private isIpPinBlocked(ip: string): boolean {
    try {
      const now = Date.now();
      const rows = this.ctx.storage.sql
        .exec('SELECT blocked_until FROM pin_rate_limits WHERE ip = ?', ip)
        .toArray();
      for (const row of rows) {
        const blockedUntil = Number((row as Record<string, unknown>).blocked_until || 0);
        if (blockedUntil > now) {
          return true;
        }
      }
    } catch (err) {
      console.error('[SignalingHub SQLite] Error checking PIN block status:', err);
    }
    return false;
  }

  private recordFailedPinAttempt(ip: string): void {
    try {
      const now = Date.now();
      const rows = this.ctx.storage.sql
        .exec('SELECT failed_attempts, blocked_until, last_attempt FROM pin_rate_limits WHERE ip = ?', ip)
        .toArray();
      const row = rows[0] as Record<string, unknown> | undefined;
      const blocked = Number(row?.blocked_until || 0);
      const last = Number(row?.last_attempt || 0);
      if (blocked > now) return;
      const expired = (blocked > 0 && blocked <= now) || now - last >= SECURITY_LIMITS.PIN_BLOCK_DURATION_MS;
      const attempts = (expired ? 0 : Number(row?.failed_attempts || 0)) + 1;
      const blockedUntil =
        attempts >= SECURITY_LIMITS.MAX_PIN_ATTEMPTS
          ? now + SECURITY_LIMITS.PIN_BLOCK_DURATION_MS
          : 0;

      this.ctx.storage.sql.exec(
        `INSERT INTO pin_rate_limits (ip, failed_attempts, blocked_until, last_attempt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           failed_attempts = ?,
           blocked_until = ?,
           last_attempt = ?`,
        ip,
        attempts,
        blockedUntil,
        now,
        attempts,
        blockedUntil,
        now
      );
    } catch (err) {
      console.error('[SignalingHub SQLite] Error recording failed PIN attempt:', err);
    }
  }

  private resetFailedPinAttempts(ip: string): void {
    try {
      this.ctx.storage.sql.exec('DELETE FROM pin_rate_limits WHERE ip = ?', ip);
    } catch (err) {
      console.error('[SignalingHub SQLite] Error resetting PIN attempts:', err);
    }
  }

  private cleanUpRoomIfEmpty(roomCode: string): void {
    const remaining = this.getRoomSockets(roomCode);
    const reserved = this.countReservedGraceSlots(roomCode);
    if (remaining.length === 0 && reserved === 0) {
      try {
        this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_code = ?', roomCode);
        this.ctx.storage.sql.exec('DELETE FROM session_credentials WHERE room_code = ?', roomCode);
      } catch {
        // Ignore
      }
    }
  }

  // --- Resume Credential Helpers (256-bit random + SHA-256) ---

  private generateResumeToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private async hashToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async issueCredential(meta: ClientMeta): Promise<string> {
    const token = this.generateResumeToken();
    const tokenHash = await this.hashToken(token);
    const now = Date.now();
    const expiresAt = now + SECURITY_LIMITS.ROOM_TTL_MS;

    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO session_credentials
           (participant_id, room_code, token_hash, name, device_type, is_host, generation, grace_until, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
         ON CONFLICT(participant_id) DO UPDATE SET
           room_code = ?,
           token_hash = ?,
           name = ?,
           device_type = ?,
           is_host = ?,
           generation = generation + 1,
           grace_until = 0,
           expires_at = ?`,
        meta.id,
        meta.roomCode,
        tokenHash,
        meta.name,
        meta.deviceType,
        meta.isHost ? 1 : 0,
        expiresAt,
        meta.roomCode,
        tokenHash,
        meta.name,
        meta.deviceType,
        meta.isHost ? 1 : 0,
        expiresAt
      );
    } catch (err) {
      console.error('[SignalingHub SQLite] Error issuing credential:', err);
    }
    return token;
  }

  private async markCredentialGrace(participantId: string): Promise<void> {
    const now = Date.now();
    const graceUntil = now + SECURITY_LIMITS.RESUME_GRACE_MS;
    try {
      this.ctx.storage.sql.exec(
        'UPDATE session_credentials SET grace_until = ? WHERE participant_id = ?',
        graceUntil,
        participantId
      );
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm || currentAlarm > graceUntil) {
        await this.ctx.storage.setAlarm(graceUntil);
      }
    } catch (err) {
      console.error('[SignalingHub SQLite] Error marking grace period:', err);
    }
  }

  private deleteCredential(participantId: string): void {
    try {
      this.ctx.storage.sql.exec('DELETE FROM session_credentials WHERE participant_id = ?', participantId);
    } catch {
      // Ignore
    }
  }

  private countReservedGraceSlots(roomCode: string, excludeParticipantId?: string): number {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT participant_id FROM session_credentials WHERE room_code = ? AND grace_until > ? AND expires_at > ?',
        roomCode,
        now,
        now
      )
      .toArray();
    let count = 0;
    for (const row of rows) {
      const pid = String((row as Record<string, unknown>).participant_id || '');
      if (pid && pid !== excludeParticipantId) {
        count++;
      }
    }
    return count;
  }

  private async validateAndRotateCredential(
    roomCode: string,
    presentedToken: string
  ): Promise<{
    participantId: string;
    name: string;
    deviceType: 'mobile' | 'desktop';
    isHost: boolean;
    newResumeToken: string;
  } | null> {
    const presentedHash = await this.hashToken(presentedToken);
    const now = Date.now();

    try {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT participant_id, name, device_type, is_host, generation, grace_until, expires_at
           FROM session_credentials
           WHERE room_code = ? AND token_hash = ?`,
          roomCode,
          presentedHash
        )
        .toArray();

      if (rows.length === 0) return null;

      const row = rows[0] as Record<string, unknown>;
      const participantId = String(row.participant_id || '');
      const graceUntil = Number(row.grace_until || 0);
      const expiresAt = Number(row.expires_at || 0);
      const currentGen = Number(row.generation || 1);

      if ((graceUntil > 0 && now > graceUntil) || now > expiresAt) {
        this.deleteCredential(participantId);
        return null;
      }

      const newResumeToken = this.generateResumeToken();
      const newHash = await this.hashToken(newResumeToken);
      const newExpiresAt = now + SECURITY_LIMITS.ROOM_TTL_MS;

      // Atomic conditional update by generation + old hash to prevent replay races
      const res = this.ctx.storage.sql.exec(
        `UPDATE session_credentials
         SET token_hash = ?, generation = ?, grace_until = 0, expires_at = ?
         WHERE participant_id = ? AND token_hash = ? AND generation = ?`,
        newHash,
        currentGen + 1,
        newExpiresAt,
        participantId,
        presentedHash,
        currentGen
      );

      if (res.rowsWritten === 0) {
        return null;
      }

      return {
        participantId,
        name: String(row.name || 'Device'),
        deviceType: row.device_type === 'mobile' ? 'mobile' : 'desktop',
        isHost: Number(row.is_host || 0) === 1,
        newResumeToken,
      };
    } catch (err) {
      console.error('[SignalingHub SQLite] Error validating resume credential:', err);
      return null;
    }
  }
}
