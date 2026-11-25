export function resolveWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim();

  if (configuredUrl) {
    let normalized = configuredUrl;

    // Automatically normalize https:// to wss:// and http:// to ws://
    // for user convenience when copying URLs directly from the Render dashboard.
    if (normalized.startsWith('https://')) {
      normalized = 'wss://' + normalized.slice(8);
    } else if (normalized.startsWith('http://')) {
      normalized = 'ws://' + normalized.slice(7);
    }

    const url = new URL(normalized);

    if (!['ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('Invalid WebSocket protocol. Must be ws:// or wss://');
    }

    if (window.location.protocol === 'https:' && url.protocol !== 'wss:') {
      throw new Error('HTTPS applications require a secure WebSocket endpoint (wss://)');
    }

    return url.toString();
  }

  // Derive /ws on current host (proxied by Vite to localhost:8080 in dev)
  const url = new URL('/ws', window.location.origin);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function getBackendHealthUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim();

  if (configuredUrl) {
    let normalized = configuredUrl;
    if (normalized.startsWith('wss://')) {
      normalized = 'https://' + normalized.slice(6);
    } else if (normalized.startsWith('ws://')) {
      normalized = 'http://' + normalized.slice(5);
    }
    try {
      const url = new URL(normalized);
      url.pathname = '/health';
      url.search = '';
      return url.toString();
    } catch {
      // Fallback
    }
  }

  return new URL('/health', window.location.origin).toString();
}

export async function pingBackendHealth(timeoutMs = 6000): Promise<boolean> {
  try {
    const healthUrl = getBackendHealthUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(healthUrl, {
      method: 'GET',
      mode: 'cors',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
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
