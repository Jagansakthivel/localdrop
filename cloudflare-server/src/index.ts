import { Env } from './types';
export { SignalingHub } from './SignalingHub';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://client-taupe-one-79.vercel.app',
];

function isLocalDevHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Origin validation for browser security.
 * Enforces exact normalized origin allowlist (plus local dev/LAN origins).
 */
function isOriginAllowed(originHeader: string | null, customOrigins?: string, strict = false): boolean {
  if (!originHeader) return true; // Non-browser clients, automated curl/pings, or same-origin

  try {
    const originUrl = new URL(originHeader);
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return false;
    }
    const normalizedOrigin = originUrl.origin.toLowerCase();
    const host = originUrl.hostname.toLowerCase();

    if (!strict && isLocalDevHost(host)) {
      return true;
    }

    const configuredList = customOrigins
      ? customOrigins
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : DEFAULT_ALLOWED_ORIGINS;

    return configuredList.some((allowed) => {
      if (allowed.startsWith('http://') || allowed.startsWith('https://')) {
        try {
          return new URL(allowed).origin.toLowerCase() === normalizedOrigin;
        } catch {
          return false;
        }
      }
      return host === allowed;
    });
  } catch {
    return false;
  }
}

const DEFAULT_TURN_ORIGINS = [
  'https://client-taupe-one-79.vercel.app',
  'http://localhost:5173',
  'https://localhost:5173',
  'http://127.0.0.1:5173',
];

export function resolveTurnOrigin(originHeader: string | null, configured?: string): string | null {
  if (!originHeader) return null;
  const list = configured
    ? configured.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TURN_ORIGINS;
  return list.includes(originHeader) ? originHeader : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 0. Exact-origin CORS & routing for authenticated TURN credential endpoint
    if (url.pathname === '/api/ice-servers') {
      const origin = resolveTurnOrigin(request.headers.get('Origin'), env.TURN_ALLOWED_ORIGINS);
      if (!origin) {
        return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin',
          },
        });
      }
      const id = env.SIGNALING_HUB.idFromName('global');
      return env.SIGNALING_HUB.get(id).fetch(request);
    }

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
    if (origin && !isOriginAllowed(origin, env.ALLOWED_ORIGINS, env.STRICT_BROWSER_ORIGINS === '1')) {
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
