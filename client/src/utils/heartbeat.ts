/**
 * Congestion-aware JSON ping/pong heartbeat compatible with SignalingHub.
 * Recognizes any valid inbound traffic and active outbound buffer drain as liveness
 * while preserving bounded dead-connection detection on idle or stalled sockets.
 */
export interface HeartbeatOptions {
  intervalMs?: number;
  timeoutMs?: number;
  visible?: () => boolean;
  onDiagnostic?: (event: string, detail: Record<string, number | string>) => void;
}

export function attachHeartbeat(
  socket: WebSocket,
  onTimeout: () => void,
  options: HeartbeatOptions = {}
): () => void {
  const intervalMs = options.intervalMs ?? 25000;
  const timeoutMs = options.timeoutMs ?? 10000;
  const visible =
    options.visible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');

  let pendingAt: number | null = null;
  let lastInboundAt = performance.now();
  let lastDrainAt = performance.now();
  let lastBuffered = socket.bufferedAmount;
  let stopped = false;

  const observeDrain = (now: number) => {
    const buf = socket.bufferedAmount;
    if (buf === 0 || buf < lastBuffered) {
      lastDrainAt = now;
    }
    lastBuffered = buf;
  };

  const message = (event: MessageEvent) => {
    const now = performance.now();
    // Any valid inbound WebSocket frame (binary credit/data or JSON) proves socket liveness.
    lastInboundAt = now;
    if (typeof event.data === 'string') {
      try {
        const msg: unknown = JSON.parse(event.data);
        if (msg && typeof msg === 'object' && 'type' in msg && msg.type === 'pong') {
          pendingAt = null;
          return;
        }
      } catch {
        // Non-JSON string ignored
      }
    }
    if (pendingAt !== null) {
      options.onDiagnostic?.('heartbeat-inbound-liveness', {
        bufferedAmount: socket.bufferedAmount,
        pendingMs: Math.round(now - pendingAt),
      });
      pendingAt = null;
    }
  };

  function tick() {
    if (stopped || socket.readyState !== 1) return;
    if (!visible()) {
      pendingAt = null;
      return;
    }
    const now = performance.now();
    observeDrain(now);

    if (pendingAt !== null) {
      if (now - lastInboundAt < timeoutMs) {
        pendingAt = null;
        return;
      }
      if (socket.bufferedAmount > 0 && now - lastDrainAt < timeoutMs) {
        options.onDiagnostic?.('heartbeat-extended-draining', {
          bufferedAmount: socket.bufferedAmount,
          sinceDrainMs: Math.round(now - lastDrainAt),
        });
        return;
      }
      if (now - pendingAt >= timeoutMs) {
        options.onDiagnostic?.('heartbeat-timeout', {
          bufferedAmount: socket.bufferedAmount,
          sinceInboundMs: Math.round(now - lastInboundAt),
          sinceDrainMs: Math.round(now - lastDrainAt),
          pendingMs: Math.round(now - pendingAt),
        });
        stop();
        onTimeout();
      }
      return;
    }

    // Recent inbound traffic already proves liveness; avoid queuing ping behind relay data.
    if (now - lastInboundAt < intervalMs) {
      return;
    }
    if (socket.bufferedAmount > 0 && now - lastDrainAt < timeoutMs) {
      options.onDiagnostic?.('heartbeat-deferred-congested', {
        bufferedAmount: socket.bufferedAmount,
        sinceDrainMs: Math.round(now - lastDrainAt),
      });
      return;
    }

    try {
      socket.send(JSON.stringify({ type: 'ping' }));
      pendingAt = now;
    } catch {
      stop();
      onTimeout();
    }
  }

  let lastPing = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (!visible()) {
      pendingAt = null;
      lastPing = now;
      lastInboundAt = now;
      lastDrainAt = now;
      return;
    }
    observeDrain(now);
    if (pendingAt !== null || now - lastPing >= intervalMs) {
      if (pendingAt === null) lastPing = now;
      tick();
    }
  }, Math.min(1000, timeoutMs, intervalMs));

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.removeEventListener('message', message);
    socket.removeEventListener('close', stop);
  }

  socket.addEventListener('message', message);
  socket.addEventListener('close', stop, { once: true });
  return stop;
}
