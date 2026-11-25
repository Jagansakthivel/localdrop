interface SocketHandlers {
  onOpen: (socket: WebSocket) => void;
  onMessage: (event: MessageEvent) => void;
  onClose: (event: CloseEvent) => void;
  onError: (event: Event) => void;
  onReconnect?: (attempt: number, delay: number) => void;
  onExhausted?: () => void;
}

export function createReconnectingSocket(url: string, handlers: SocketHandlers) {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let attempts = 0;
  const MAX_ATTEMPTS = 15;

  function connect() {
    if (stopped) return;
    // Guard against duplicate concurrent WebSocket creation
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const current = new WebSocket(url);
      socket = current;
      current.binaryType = 'arraybuffer';

      current.onopen = () => {
        if (stopped || socket !== current) return;
        attempts = 0;
        handlers.onOpen(current);
      };

      current.onmessage = (event) => {
        if (stopped || socket !== current) return;
        handlers.onMessage(event);
      };

      current.onerror = (event) => {
        if (stopped || socket !== current) return;
        handlers.onError(event);
      };

      current.onclose = (event) => {
        if (stopped || socket !== current) return;
        socket = null;
        handlers.onClose(event);

        if (attempts >= MAX_ATTEMPTS) {
          handlers.onExhausted?.();
          return;
        }

        // Bounded exponential backoff with jitter (max 10s)
        const delay = Math.min(1000 * 1.5 ** attempts, 10000) + Math.floor(Math.random() * 250);
        attempts++;
        handlers.onReconnect?.(attempts, delay);
        timer = setTimeout(connect, delay);
      };
    } catch (err) {
      handlers.onError(err as Event);
    }
  }

  // Instant reconnection when network comes back online
  const handleOnline = () => {
    if (stopped || (socket && socket.readyState === WebSocket.OPEN)) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    attempts = 0;
    connect();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
  }

  connect();

  return {
    getSocket: () => socket,

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
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
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
