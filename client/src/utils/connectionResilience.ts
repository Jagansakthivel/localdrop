/** Browser-side recovery controller. Own one instance per mounted session. */
export interface RecoveryAdapter {
  socketState(): number | undefined;
  peer(): RTCPeerConnection | null;
  channel(): RTCDataChannel | null;
  hasSession(): boolean;
  transferActive(): boolean;
  ensureSignaling(): void;
  // Must serialize negotiation, authenticate the session and reject stale generations.
  recoverPeer(signal: AbortSignal): Promise<void>;
  report(state: 'healthy' | 'degraded' | 'recovering' | 'unavailable'): void;
}

export function createConnectionResilience(a: RecoveryAdapter) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let running = false;
  let disconnectedAt: number | undefined;
  let controller: AbortController | undefined;

  const schedule = (ms: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void inspect(), ms);
  };

  async function inspect() {
    if (stopped || running) return;
    if (!a.hasSession()) {
      attempt = 0;
      disconnectedAt = undefined;
      return;
    }

    const socketReady = a.socketState() === WebSocket.OPEN;
    if (!socketReady && a.socketState() !== WebSocket.CONNECTING) {
      a.ensureSignaling();
    }

    const pc = a.peer();
    const dc = a.channel();
    const direct = dc?.readyState === 'open' && pc?.connectionState === 'connected';
    if (direct) {
      attempt = 0;
      disconnectedAt = undefined;
      a.report(socketReady ? 'healthy' : 'degraded');
      schedule(2000);
      return;
    }

    // A healthy relay is determined by the adapter/UI's authenticated relay readiness,
    // not merely by WebSocket.OPEN. Do not use this controller for relay-only sessions.
    disconnectedAt ??= performance.now();
    a.report('degraded');

    if (a.transferActive() || !socketReady || document.visibilityState === 'hidden') {
      schedule(2000);
      return;
    }
    if (pc?.connectionState !== 'failed' && performance.now() - disconnectedAt < 5000) {
      schedule(1000);
      return;
    }
    if (attempt >= 5) {
      a.report('unavailable');
      return;
    }

    running = true;
    attempt++;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 12000);
    try {
      a.report('recovering');
      await a.recoverPeer(controller.signal);
    } catch {
      /* Adapter reports actionable errors without logging secrets. */
    } finally {
      clearTimeout(timeout);
      running = false;
      controller = undefined;
      schedule(Math.min(15000, 1000 * 2 ** attempt) + Math.random() * 300);
    }
  }

  const wake = () => {
    if (!stopped) schedule(0);
  };
  const visible = () => {
    if (document.visibilityState === 'visible') wake();
  };

  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', visible);

  return {
    notify: wake,
    retry() {
      attempt = 0;
      wake();
    },
    dispose() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', visible);
    },
  };
}
