import { attachHeartbeat } from './heartbeat';

interface SocketHandlers {
  onOpen: (socket: WebSocket) => void;
  onMessage: (event: MessageEvent) => void;
  onClose: (event: CloseEvent) => void;
  onError: (event: Event) => void;
  onReconnect?: (attempt: number, delay: number) => void;
  onExhausted?: () => void;
  onHeartbeatDiagnostic?: (event: string, detail: Record<string, number | string>) => void;
}

export function createReconnectingSocket(url: string, handlers: SocketHandlers) {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let stopped = false;
  let attempts = 0;
  let generation = 0;
  const MAX_ATTEMPTS = 15;

  function scheduleReconnect() {
    if (stopped) return;
    if (attempts >= MAX_ATTEMPTS) {
      handlers.onExhausted?.();
      return;
    }
    // Bounded exponential backoff with jitter (cap 15s)
    const delay = Math.min(1000 * 1.5 ** attempts, 15000) + Math.floor(Math.random() * 250);
    attempts++;
    handlers.onReconnect?.(attempts, delay);
    if (timer) clearTimeout(timer);
    timer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    // Guard against duplicate concurrent WebSocket creation
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const myGeneration = ++generation;

    try {
      const current = new WebSocket(url);
      socket = current;
      current.binaryType = 'arraybuffer';

      current.onopen = () => {
        if (stopped || myGeneration !== generation || socket !== current) return;
        attempts = 0;
        stopHeartbeat?.();
        stopHeartbeat = attachHeartbeat(
          current,
          () => {
            if (stopped || myGeneration !== generation || socket !== current) return;
            try {
              current.close(4000, 'Heartbeat timeout');
            } catch {
              // ignore
            }
          },
          {
            onDiagnostic: handlers.onHeartbeatDiagnostic,
          }
        );
        handlers.onOpen(current);
      };

      current.onmessage = (event) => {
        if (stopped || myGeneration !== generation || socket !== current) return;
        handlers.onMessage(event);
      };

      current.onerror = (event) => {
        if (stopped || myGeneration !== generation || socket !== current) return;
        handlers.onError(event);
      };

      current.onclose = (event) => {
        if (stopped || myGeneration !== generation || socket !== current) return;
        stopHeartbeat?.();
        stopHeartbeat = null;
        socket = null;
        handlers.onClose(event);
        scheduleReconnect();
      };
    } catch (err) {
      if (!stopped && myGeneration === generation) {
        stopHeartbeat?.();
        stopHeartbeat = null;
        socket = null;
        handlers.onError(err as Event);
        scheduleReconnect();
      }
    }
  }

  // Wake existing reconnect manager only if no OPEN or CONNECTING socket exists
  function wake() {
    if (stopped) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    attempts = 0;
    connect();
  }

  const handleVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      wake();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisible);
  }

  connect();

  return {
    getSocket: () => socket,
    wake,

    send(payload: string | ArrayBuffer): boolean {
      if (socket?.readyState !== WebSocket.OPEN) {
        return false;
      }
      try {
        socket.send(payload);
        return true;
      } catch {
        return false;
      }
    },

    close() {
      stopped = true;
      generation++;
      stopHeartbeat?.();
      stopHeartbeat = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', wake);
        window.removeEventListener('pageshow', wake);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisible);
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const current = socket;
      socket = null;
      if (current) {
        current.onopen = null;
        current.onmessage = null;
        current.onerror = null;
        current.onclose = null;
        try {
          current.close();
        } catch {
          // ignore close errors during teardown
        }
      }
    },
  };
}
