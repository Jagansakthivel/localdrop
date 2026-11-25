/**
 * LocalDrop Cloudflare Signaling Protocol & Type Definitions
 */

export interface ClientMeta {
  id: string;
  name: string;
  deviceType: 'mobile' | 'desktop';
  roomCode: string;
  isHost: boolean;
  ip: string;
  messageCount: number;
  lastMessageReset: number;
  connectedAt: number;
}

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: 'mobile' | 'desktop';
}

// Client -> Server Messages
export type ClientMessage =
  | { type: 'register'; name?: string; deviceType?: 'mobile' | 'desktop' }
  | { type: 'create-room'; roomCode: string }
  | { type: 'join-room'; roomCode: string; createIfMissing?: boolean }
  | { type: 'leave-room' }
  | { type: 'signal'; to: string; signal: unknown }
  | { type: 'relay'; payload: unknown }
  | { type: 'ping' };

// Server -> Client Messages
export type ServerMessage =
  | { type: 'welcome'; id: string }
  | { type: 'room-created'; roomCode: string }
  | { type: 'room-joined'; roomCode: string; isHost: boolean }
  | { type: 'room-peers'; roomCode: string; peers: PeerInfo[] }
  | { type: 'peer-joined-room'; roomCode: string; peer: PeerInfo }
  | { type: 'room-error'; code: string; message: string }
  | { type: 'signal'; from: string; fromName: string; fromDeviceType: string; signal: unknown }
  | { type: 'relay'; from: string; payload: unknown }
  | { type: 'pong'; timestamp: number }
  | { type: 'error'; code: string; message: string };

// SQLite row types
export interface RoomRow {
  room_code: string;
  host_id: string;
  created_at: number;
  updated_at: number;
}

export interface PinRateLimitRow {
  ip: string;
  failed_attempts: number;
  blocked_until: number;
  last_attempt: number;
}

// Constants
export const SECURITY_LIMITS = {
  MAX_CONNECTIONS_PER_IP: 20,
  MAX_MESSAGES_PER_SEC: 50,
  MAX_JSON_PAYLOAD_BYTES: 64 * 1024,    // 64 KB
  MAX_BINARY_CHUNK_BYTES: 512 * 1024,  // 512 KB
  MAX_PIN_ATTEMPTS: 10,
  PIN_BLOCK_DURATION_MS: 5 * 60 * 1000, // 5 minutes
  ROOM_TTL_MS: 60 * 60 * 1000,          // 1 hour
} as const;

export interface Env {
  SIGNALING_HUB: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
}
