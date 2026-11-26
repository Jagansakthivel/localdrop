/**
 * LocalDrop Cloudflare Signaling Protocol & Type Definitions
 */
import type { Bucket, RelayLedger } from './network-v2/relayBudget';

export interface RelayPendingMeta {
  transferId: string;
  fileId: number;
  size: number;
  chunkSize: number;
  targetId: string;
}

export interface ActiveRelayLedger extends RelayLedger {
  transferId: string;
  targetId: string;
  totalSize: number;
}

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
  networkVersion?: number;
  controlBucket?: Bucket;
  binaryBucket?: Bucket;
  relayPending?: RelayPendingMeta;
  relayLedger?: ActiveRelayLedger;
}

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: 'mobile' | 'desktop';
  networkVersion?: number;
}

// Client -> Server Messages
export type ClientMessage =
  | { type: 'register'; name?: string; deviceType?: 'mobile' | 'desktop'; networkVersion?: number }
  | { type: 'create-room'; roomCode: string }
  | { type: 'join-room'; roomCode: string; createIfMissing?: boolean }
  | { type: 'resume-session'; roomCode: string; resumeToken: string }
  | { type: 'leave-room' }
  | { type: 'signal'; to: string; signal: unknown }
  | { type: 'v2-path'; to?: string; epoch: string; path: 'rtc' | 'relay'; stage: string }
  | { type: 'relay'; payload: unknown }
  | { type: 'ping' };

// Server -> Client Messages
export type ServerMessage =
  | { type: 'welcome'; id: string; networkVersion?: number; v2Supported?: boolean }
  | { type: 'room-created'; roomCode: string; resumeToken?: string }
  | { type: 'room-joined'; roomCode: string; isHost: boolean; resumeToken?: string }
  | { type: 'session-resumed'; roomCode: string; participantId: string; isHost: boolean; resumeToken: string }
  | { type: 'room-peers'; roomCode: string; peers: PeerInfo[] }
  | { type: 'peer-joined-room'; roomCode: string; peer: PeerInfo }
  | { type: 'room-error'; code: string; message: string }
  | { type: 'signal'; from: string; fromName: string; fromDeviceType: string; signal: unknown }
  | { type: 'v2-path'; from: string; epoch: string; path: 'rtc' | 'relay'; stage: string }
  | { type: 'relay'; from: string; payload: unknown }
  | { type: 'pong'; timestamp: number }
  | { type: 'error'; code: string; message: string; transferId?: string };

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
  RESUME_GRACE_MS: 60 * 1000,           // 60 seconds
} as const;

export interface Env {
  SIGNALING_HUB: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  TURN_ALLOWED_ORIGINS?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}
