import { Env } from './types';
export { SignalingHub } from './SignalingHub';

/**
 * Origin validation for browser security.
 * Permits local development, LAN testing, Vercel deployments, and configured domains.
 */
function isOriginAllowed(originHeader: string | null, customOrigins?: string): boolean {
  if (!originHeader) return true; // Non-browser clients, automated curl/pings, or same-origin

  try {
    const originUrl = new URL(originHeader);
    const host = originUrl.hostname.toLowerCase();

    // Localhost & LAN
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return true;
    }

    // Vercel production and preview domains
    if (host === 'vercel.app' || host.endsWith('.vercel.app')) {
      return true;
    }

    // Custom allowed origins from Wrangler vars / environment
    if (customOrigins) {
      const allowedList = customOrigins
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      if (allowedList.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 2. Validate Origin for WebSocket and HTTP requests
    const origin = request.headers.get('Origin');
    if (origin && !isOriginAllowed(origin, env.ALLOWED_ORIGINS)) {
      console.warn(`[LocalDrop Worker] Blocked unauthorized origin: ${origin}`);
      return new Response(JSON.stringify({ error: 'Unauthorized Origin', origin }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Route to the global SignalingHub Durable Object instance
    // Uses named singleton 'global' for zero-latency local matchmaking
    const id = env.SIGNALING_HUB.idFromName('global');
    const hub = env.SIGNALING_HUB.get(id);

    return hub.fetch(request);
  },
};
