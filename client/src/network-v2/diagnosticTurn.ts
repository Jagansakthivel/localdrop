import { resolveWebSocketUrl } from '../utils/network';
import { connectDiagnosticRelay } from './diagnosticRelay';
import { fetchIceServersWithExpiry } from './transportRace';

export async function fetchDiagnosticTurn(room: string, signal: AbortSignal) {
  // Keep the socket admitted during issuance. The short-lived TURN credential
  // is usable after the temporary matchmaking room is closed.
  let admitted!: (token: string) => void;
  let rejected!: (reason: Error) => void;
  const token = new Promise<string>((resolve, reject) => { admitted = resolve; rejected = reject; });
  const { socket } = connectDiagnosticRelay(room, true, {
    admitted: admitted,
    paired: () => {},
    binary: () => {},
    message: () => {},
    failure: () => rejected(new Error('Diagnostic room unavailable')),
  }, true);
  const fail = () => rejected(new Error('Probe disconnected'));
  const timer = setTimeout(() => rejected(new Error('Diagnostic room unavailable')), 5000);
  signal.addEventListener('abort', fail, { once: true });
  try {
    if (signal.aborted) fail();
    const credential = await token;
    const requested = performance.now();
    const result = await fetchIceServersWithExpiry(resolveWebSocketUrl(), credential, room, signal);
    return { ...result, requestMs: Math.round(performance.now() - requested) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', fail);
    socket.close();
  }
}
