import { resolveWebSocketUrl } from '../utils/network';

const roomErrors = new Set(['ROOM_NOT_FOUND', 'ROOM_TAKEN', 'ROOM_FULL', 'INVALID_PIN', 'TOO_MANY_ATTEMPTS']);
const transferErrors = new Set([
  'Relay credit rate exceeded', 'Invalid credit frame', 'Credit exceeds outstanding data',
  'Relay bandwidth quota exceeded', 'Invalid relay ledger', 'Relay requires exactly one paired peer',
]);

interface RelayEvents {
  admitted: () => void;
  paired: () => void;
  message: (packet: unknown) => void;
  binary: (frame: ArrayBuffer) => void;
  failure: (reason: string) => void;
}

export function connectDiagnosticRelay(room: string, host: boolean, events: RelayEvents) {
  const socket = new WebSocket(resolveWebSocketUrl());
  socket.binaryType = 'arraybuffer';
  let authenticated = false;
  let peerId: string | undefined;
  let ready = false;
  let welcomed = false;

  function send(packet: object) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Relay closed');
    socket.send(JSON.stringify(packet));
  }
  function sendControl(payload: object) {
    if (!ready) throw new Error('Diagnostic peer not ready');
    send({ type: 'relay', payload });
  }

  socket.onmessage = ({ data }) => {
    if (data instanceof ArrayBuffer) {
      if (ready) events.binary(data);
      return;
    }
    if (typeof data !== 'string' || data.length > 4096) return;
    try {
      const packet = JSON.parse(data);
      if (!welcomed && packet.type === 'welcome') {
        welcomed = true;
        if (packet.networkVersion !== 2) {
          events.failure('Relay requires Network V2');
          return;
        }
        send({ type: 'register', networkVersion: 2, name: 'LocalDrop diagnostics' });
        send({ type: host ? 'create-room' : 'join-room', roomCode: room, createIfMissing: false });
      } else if (packet.type === (host ? 'room-created' : 'room-joined') && packet.roomCode === room &&
        typeof packet.resumeToken === 'string' && packet.resumeToken.length > 0) {
        authenticated = true;
        events.admitted();
      } else if (authenticated && packet.type === 'room-peers' && packet.roomCode === room && Array.isArray(packet.peers)) {
        const peer = packet.peers.length === 1 ? packet.peers[0] : undefined;
        const id = peer?.networkVersion === 2 && typeof peer.id === 'string' ? peer.id : undefined;
        if (peerId && peerId !== id) {
          events.failure('Diagnostic peer left');
        } else if (id && !peerId) {
          peerId = id;
          send({ type: 'relay', payload: { type: 'diagnostic-hello', version: 1 } });
        }
      } else if (authenticated && peerId && packet.type === 'relay' && packet.from === peerId) {
        const payload = packet.payload;
        if (payload?.type === 'diagnostic-hello' && payload.version === 1 && !ready) {
          ready = true;
          events.paired();
        } else if (ready) {
          events.message(payload);
        }
      } else if (packet.type === 'room-error') {
        events.failure(roomErrors.has(packet.code) ? packet.code : 'Diagnostic room unavailable');
      } else if (ready && packet.type === 'peer-reconnecting') {
        events.failure('Diagnostic peer left');
      } else if (ready && packet.type === 'error' && (packet.code?.startsWith('RELAY_') ||
        packet.code === 'RATE_LIMIT_EXCEEDED' || packet.code === 'CONTROL_RATE_LIMIT')) {
        events.failure(transferErrors.has(packet.message) ? packet.message : 'Diagnostic relay rejected traffic');
      }
    } catch {
      events.failure('Invalid relay control message');
    }
  };
  socket.onclose = () => events.failure('Relay closed');
  socket.onerror = () => events.failure('Relay socket error');
  return { socket, sendControl };
}
