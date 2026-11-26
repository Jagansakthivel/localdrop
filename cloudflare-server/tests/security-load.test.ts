import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { RoomIndex } from '../src/network-v2/roomIndex.ts';
import { SerialQueue, SocketEventQueue } from '../src/network-v2/eventQueue.ts';
import { admitRelayMeta } from '../src/network-v2/relayAdmission.ts';
import { roomWireVersion, peerVersion } from '../src/network-v2/protocol.ts';
import { authorizeTurn } from '../src/network-v2/turnAuth.ts';

test('RoomIndex scales O(room occupancy) across 100 concurrent rooms (200 sockets)', () => {
  const metas = new Map<object, { id: string; roomCode: string }>();
  const index = new RoomIndex<object, { id: string; roomCode: string }>(
    (ws) => metas.get(ws) ?? null,
    () => true
  );

  for (let r = 0; r < 100; r++) {
    const room = String(1000 + r);
    const s1 = {};
    const s2 = {};
    metas.set(s1, { id: `p1-${r}`, roomCode: room });
    metas.set(s2, { id: `p2-${r}`, roomCode: room });
    index.update(s1, room);
    index.update(s2, room);
  }

  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const members = index.members(String(1000 + (i % 100)));
    assert.equal(members.length, 2);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 100, `Expected <100ms for 1000 targeted room lookups, got ${elapsedMs}ms`);
});

test('SerialQueue and SocketEventQueue enforce bounds and serialize async membership', async () => {
  const membership = new SerialQueue(4);
  const order: number[] = [];
  const tasks = [1, 2, 3, 4].map((n) =>
    membership.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
    })
  );
  await assert.rejects(() => membership.run(async () => {}), /overloaded/i);
  await Promise.all(tasks);
  assert.deepEqual(order, [1, 2, 3, 4]);

  const sockQ = new SocketEventQueue<object>(1024, 2);
  const sock = {};
  const p1 = sockQ.run(sock, 512, async () => { await new Promise((r) => setTimeout(r, 5)); });
  const p2 = sockQ.run(sock, 512, async () => {});
  await assert.rejects(() => sockQ.run(sock, 1, async () => {}), /overloaded/i);
  await Promise.all([p1, p2]);
});

test('admitRelayMeta and roomWireVersion enforce two-peer room isolation and metadata bounds', () => {
  assert.equal(roomWireVersion(2, [2]), 2);
  assert.equal(roomWireVersion(2, [1]), 1);
  assert.equal(roomWireVersion(2, [2, 2]), null);
  assert.equal(roomWireVersion(2, []), null);
  assert.equal(peerVersion('a', 2, 'a', undefined), 2);
  assert.equal(peerVersion('a', 2, 'b', undefined), 1);

  const busy = admitRelayMeta({ transferId: 't1', fileId: 1, size: 100, chunkSize: 16384 }, 'peer2', true);
  assert.deepEqual(busy, { ok: false, code: 'RELAY_BUSY' });

  const invalid = admitRelayMeta({ transferId: 't1', fileId: 70000, size: 100, chunkSize: 16384 }, 'peer2', false);
  assert.deepEqual(invalid, { ok: false, code: 'RELAY_INVALID_META' });

  const ok = admitRelayMeta({ transferId: 't1', fileId: 1, size: 20 * 1024 * 1024, chunkSize: 256 * 1024 - 8 }, 'peer2', false);
  assert.equal(ok.ok, true);
});

test('authorizeTurn enforces hashed resume credential, active participant, and hourly quota', async () => {
  const token = 'A'.repeat(43);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const counts = new Map<string, number>();
  const now = 1_700_000_000_000;

  const store = {
    query(sql: string, ...args: (string | number)[]) {
      if (sql.includes('session_credentials')) {
        return args[0] === '1234' && args[1] === hash ? [{ participant_id: 'p1' }] : [];
      }
      if (sql.includes('turn_issuance')) {
        return [{ count: counts.get(`${args[0]}:${args[1]}`) ?? 0 }];
      }
      return [];
    },
    execute(sql: string, ...args: (string | number)[]) {
      if (sql.includes('INSERT INTO turn_issuance')) {
        const k = `${args[0]}:${args[1]}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    },
    transaction<T>(fn: () => T) {
      return fn();
    },
    activeParticipant: (room: string, id: string) => room === '1234' && id === 'p1',
  };

  for (let i = 0; i < 8; i++) {
    assert.equal(await authorizeTurn(store, '1234', token, '203.0.113.1', now), true);
  }
  // 9th request in same hour exceeds per-peer cap of 8
  assert.equal(await authorizeTurn(store, '1234', token, '203.0.113.1', now), false);
  // Wrong token rejected
  assert.equal(await authorizeTurn(store, '1234', 'B'.repeat(43), '203.0.113.1', now), false);
});
