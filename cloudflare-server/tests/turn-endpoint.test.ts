import assert from 'node:assert/strict';
import test from 'node:test';
import { iceServersResponse } from '../src/network-v2/turn.ts';

const origin = 'https://staging.example.com';
const provider = { TURN_KEY_ID: 'fixture', TURN_API_TOKEN: 'provider-fixture' };
const claim = 'a'.repeat(43);
const url = 'http://localhost/api/ice-servers';
const request = (token?: string) => new Request(url, {
  method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: JSON.stringify({ roomCode: '1234' }),
});

test('TURN endpoint checks room authorization before issuing bounded credentials', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.headers && new Headers(init.headers).get('authorization'), 'Bearer provider-fixture');
    assert.equal(JSON.parse(String(init.body)).ttl, 3600);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ iceServers: [{ urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'mock', credential: 'mock' }] });
  });
  const unavailable = await iceServersResponse(request(), {}, async () => false, origin);
  assert.equal((await unavailable.json()).turnStatus, 'not-configured');
  assert.equal((await iceServersResponse(request(), provider, async () => true, origin)).status, 401);
  assert.equal((await iceServersResponse(request(claim), provider, async () => false, origin)).status, 403);
  assert.equal(upstream.mock.callCount(), 0);

  const start = Date.now();
  const issued = await iceServersResponse(request(claim), provider, async (room, token, ip) => {
    assert.deepEqual([room, token, ip], ['1234', claim, '127.0.0.1']);
    return true;
  }, origin);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  assert.equal(issued.headers.get('access-control-allow-origin'), origin);
  const body = await issued.json();
  assert.equal(body.iceServers.length, 1);
  assert.ok(body.expiresAt >= start + 3600_000 && body.expiresAt <= Date.now() + 3600_000);
  assert.equal(upstream.mock.callCount(), 1);

  upstream.mock.mockImplementationOnce(async () => new Response(null, { status: 503 }));
  const failed = await iceServersResponse(request(claim), provider, async () => true, origin);
  assert.equal((await failed.json()).turnStatus, 'upstream-unavailable');
});
