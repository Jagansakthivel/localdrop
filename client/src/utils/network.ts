export function resolveWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim();

  if (configuredUrl) {
    const url = new URL(configuredUrl);

    if (!['ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('Invalid WebSocket protocol. Must be ws:// or wss://');
    }

    if (window.location.protocol === 'https:' && url.protocol !== 'wss:') {
      throw new Error('HTTPS applications require a secure WebSocket endpoint (wss://)');
    }

    return url.toString();
  }

  // Derive /ws on current host
  const url = new URL('/ws', window.location.origin);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function isSocketOpen(socket: WebSocket | null): socket is WebSocket {
  return socket?.readyState === WebSocket.OPEN;
}

export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin.trim());
}

export function networkLog(event: string, details?: unknown): void {
  if (import.meta.env.DEV) {
    console.info(`[LocalDrop Network] ${event}`, details ?? '');
  }
}
