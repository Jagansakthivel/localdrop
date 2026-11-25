import { DurableObject } from 'cloudflare:workers';
import {
  ClientMeta,
  PeerInfo,
  ServerMessage,
  SECURITY_LIMITS,
  Env,
} from './types';

/**
 * SignalingHub
 *
 * SQLite-backed Durable Object powering LocalDrop WebRTC signaling and data relay.
 * Uses Cloudflare WebSocket Hibernation API for zero-cost standby and sub-millisecond edge wakeups.
 */
export class SignalingHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initDatabase();
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
    } catch (err) {
      console.error('[SignalingHub SQLite] Database initialization error:', err);
    }
  }

  /**
   * Handle incoming HTTP or WebSocket upgrade requests.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. Health check and telemetry endpoints
    if (url.pathname === '/health' || url.pathname === '/' || url.pathname === '/stats') {
      return this.handleHealthCheck();
    }

    // 2. WebSocket upgrade handling
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
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
    this.sendJson(serverSocket, { type: 'welcome', id: clientId });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }

  /**
   * WebSocket Hibernation API: handle incoming message from client.
   */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    let meta: ClientMeta;
    try {
      meta = ws.deserializeAttachment() as ClientMeta;
      if (!meta || !meta.id) throw new Error('Missing metadata');
    } catch {
      console.error('[SignalingHub] Received message on uninitialized WebSocket attachment');
      return;
    }

    // 1. Message rate limiting (messages per second)
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

    // 2. Binary message handling (direct file chunk relay between paired peers)
    if (message instanceof ArrayBuffer) {
      if (!meta.roomCode) return;

      if (message.byteLength > SECURITY_LIMITS.MAX_BINARY_CHUNK_BYTES) {
        console.warn(`[SignalingHub] Binary chunk exceeded limit (${message.byteLength} bytes)`);
        return;
      }

      // Forward directly to paired peer in same room
      const members = this.getRoomSockets(meta.roomCode);
      for (const peer of members) {
        if (peer.meta.id !== meta.id) {
          peer.ws.send(message);
        }
      }
      ws.serializeAttachment(meta);
      return;
    }

    // 3. String / JSON payload validation
    const rawString = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (rawString.length > SECURITY_LIMITS.MAX_JSON_PAYLOAD_BYTES) {
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

    // 4. Protocol Dispatch
    switch (msg.type) {
      case 'register': {
        if (typeof msg.name === 'string' && msg.name.trim()) {
          meta.name = msg.name.trim().slice(0, 50);
        }
        if (msg.deviceType === 'mobile' || msg.deviceType === 'desktop') {
          meta.deviceType = msg.deviceType;
        }
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

        const prevRoom = meta.roomCode;
        meta.roomCode = roomCode;
        meta.isHost = true;
        ws.serializeAttachment(meta);

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
        meta.roomCode = roomCode;
        meta.isHost = existingMembers.length === 0;
        ws.serializeAttachment(meta);

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

        meta.id = rotated.participantId;
        meta.roomCode = roomCode;
        meta.isHost = rotated.isHost;
        meta.name = rotated.name;
        meta.deviceType = rotated.deviceType;
        ws.serializeAttachment(meta);

        this.saveRoom(roomCode, meta.id);

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
        meta.roomCode = '';
        meta.isHost = false;
        ws.serializeAttachment(meta);

        this.deleteCredential(oldId);

        if (oldRoom) {
          this.broadcastRoomPeers(oldRoom);
          this.cleanUpRoomIfEmpty(oldRoom);
        }
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
          // Security isolation: only relay payloads between paired peers in the same room
          const members = this.getRoomSockets(meta.roomCode);
          for (const peer of members) {
            if (peer.meta.id !== meta.id) {
              this.sendJson(peer.ws, {
                type: 'relay',
                from: meta.id,
                payload: msg.payload,
              });
            }
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

  /**
   * WebSocket Hibernation API: handle socket disconnection.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    let oldRoom = '';
    let participantId = '';
    try {
      const meta = ws.deserializeAttachment() as ClientMeta | null;
      if (meta?.roomCode) {
        oldRoom = meta.roomCode;
        participantId = meta.id;
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
      await this.markCredentialGrace(participantId);
      this.broadcastRoomPeers(oldRoom);
      this.cleanUpRoomIfEmpty(oldRoom);
    }
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
  }

  // --- Helper Methods ---

  private sendJson(ws: WebSocket, data: ServerMessage): void {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.warn('[SignalingHub] Failed to send JSON message:', err);
    }
  }

  private getRoomSockets(roomCode: string): { ws: WebSocket; meta: ClientMeta }[] {
    if (!roomCode) return [];
    const results: { ws: WebSocket; meta: ClientMeta }[] = [];

    for (const ws of this.ctx.getWebSockets()) {
      try {
        const meta = ws.deserializeAttachment() as ClientMeta | null;
        if (meta && meta.roomCode === roomCode) {
          results.push({ ws, meta });
        }
      } catch {
        // Ignore uninitialized or stale socket
      }
    }
    return results;
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
        }));

      this.sendJson(member.ws, {
        type: 'room-peers',
        roomCode,
        peers: others,
      });
    }
  }

  // --- SQLite Storage Operations ---

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
        .exec('SELECT failed_attempts FROM pin_rate_limits WHERE ip = ?', ip)
        .toArray();
      let attempts = rows.length > 0 ? Number((rows[0] as Record<string, unknown>).failed_attempts || 0) : 0;
      attempts++;
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
    try {
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
    } catch {
      return 0;
    }
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
