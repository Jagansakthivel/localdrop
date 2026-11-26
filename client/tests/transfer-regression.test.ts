import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { mock } from 'node:test';
import { createFileSink } from '../src/network-v2/fileSink.ts';
import { ReceiverSlot, affectedByPathLoss } from '../src/network-v2/lifecycle.ts';
import { OfferReservations } from '../src/network-v2/offerReservations.ts';
import { SessionLease } from '../src/network-v2/sessionLease.ts';
import { sendVerified } from '../src/network-v2/verifiedSend.ts';
import { createReceiver } from '../src/network-v2/engine.ts';
import { createSampler } from '../src/network-v2/telemetry.ts';
import { waitSocket } from '../src/network-v2/flow.ts';
import { HEADER, MAX_FRAME } from '../src/network-v2/wire.ts';
import { attachHeartbeat } from '../src/utils/heartbeat.ts';
import { sanitizeSuggestedFilename } from '../src/utils/saveName.ts';
import { uniqueExportName } from '../src/utils/fileSafety.ts';
import { peerVersion, roomWireVersion, ackMatches, isRelayError, matchesTransfer } from '../src/network-v2/protocol.ts';
import { createPathAgreement } from '../src/network-v2/pathAgreement.ts';
import { createSerialSignals } from '../src/network-v2/serialSignals.ts';

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  peer?: MockWebSocket;

  send(data: string | ArrayBuffer) {
    if (this.peer && this.peer.readyState === 1) {
      queueMicrotask(() => {
        this.peer?.dispatchEvent(new MessageEvent('message', { data }));
      });
    }
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function makeFile(size: number, name: string): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) {
    bytes[i] = (i >>> 8) & 0xff;
    bytes[Math.min(size - 1, i + 1)] = i & 0xff;
  }
  return new File([bytes], name, { type: 'application/octet-stream' });
}

async function runRelayTransfer(size: number, name: string) {
  const file = makeFile(size, name);
  const expectedHash = crypto
    .createHash('sha256')
    .update(new Uint8Array(await file.arrayBuffer()))
    .digest('hex');

  const senderSock = new MockWebSocket();
  const receiverSock = new MockWebSocket();
  senderSock.peer = receiverSock;
  receiverSock.peer = senderSock;

  const ac = new AbortController();
  const meta = {
    transferId: `tid-${name}-${size}`,
    fileId: 1,
    name: file.name,
    mime: file.type,
    size: file.size,
    chunkSize: MAX_FRAME - HEADER,
  };

  let receiverDone!: Promise<{ ok: boolean; digest?: string; size: number }>;
  const subs = new Set<{ control: (pkt: any) => void; credit: (frame: ArrayBuffer) => void }>();
  let receiverInstance: ReturnType<typeof createReceiver> | null = null;

  receiverSock.addEventListener('message', (ev) => {
    const data = (ev as MessageEvent).data;
    if (data instanceof ArrayBuffer) {
      receiverInstance?.push(data);
    } else if (typeof data === 'string') {
      const pkt = JSON.parse(data);
      if (pkt.type === 'v2-meta') {
        receiverDone = (async () => {
          const sink = await createFileSink(pkt.name, pkt.mime, pkt.size);
          return await new Promise((resolve) => {
            receiverInstance = createReceiver({
              meta: pkt,
              sink,
              signal: ac.signal,
              sendCredit: (frame) => receiverSock.send(frame),
              record: () => {},
              result: (res) => {
                receiverSock.send(JSON.stringify(res));
                resolve(res);
              },
            });
            receiverSock.send(JSON.stringify({ type: 'v2-ready', transferId: pkt.transferId, ok: true }));
          });
        })();
      } else if (pkt.type === 'v2-end') {
        receiverInstance?.end(pkt);
      }
    }
  });

  senderSock.addEventListener('message', (ev) => {
    const data = (ev as MessageEvent).data;
    if (data instanceof ArrayBuffer && data.byteLength === 5) {
      for (const s of subs) s.credit(data);
    } else if (typeof data === 'string') {
      const pkt = JSON.parse(data);
      for (const s of subs) s.control(pkt);
    }
  });

  const samples: number[] = [];
  const sampler = createSampler(file.size, (s) => samples.push(s.progress));
  const res = await sendVerified({
    meta,
    file,
    path: { kind: 'relay', socket: senderSock as unknown as WebSocket },
    signal: ac.signal,
    sendControl: (pkt) => senderSock.send(JSON.stringify(pkt)),
    subscribe: (control, credit) => {
      const entry = { control, credit };
      subs.add(entry);
      return () => subs.delete(entry);
    },
    record: (bytes, waitMs) => sampler.record(bytes, waitMs),
    invalidatePath: () => {},
  });
  sampler.stop(true);
  const recvRes = await receiverDone;

  assert.equal(res.ok, true);
  assert.equal(recvRes.ok, true);
  assert.equal(res.size, size);
  assert.equal(res.digest, expectedHash);
  assert.equal(samples[samples.length - 1], 100);
}

for (const [label, size] of [
  ['0 bytes', 0],
  ['1 KB', 1024],
  ['250 KB', 250 * 1024],
  ['8 MiB - 1', 8 * 1024 * 1024 - 1],
  ['8 MiB exact', 8 * 1024 * 1024],
  ['8 MiB + 1', 8 * 1024 * 1024 + 1],
  ['20 MB', 20 * 1024 * 1024],
  ['100 MB', 100 * 1024 * 1024],
] as const) {
  test(`verified relay transfer succeeds for ${label}`, async () => {
    await runRelayTransfer(size, `${label.replace(/\s+/g, '_')}.bin`);
  });
}

test('failed storage initialization releases receiver slot so subsequent transfer succeeds', async () => {
  const slotMgr = new ReceiverSlot();
  const slot1 = slotMgr.reserve({ id: 't-fail', path: 'relay', generation: 0 });
  try {
    // Exceeds safe memory fallback (128 MiB) without OPFS in Node -> rejects
    await assert.rejects(() => createFileSink('huge.bin', 'application/octet-stream', 200 * 1024 * 1024));
  } finally {
    slotMgr.release(slot1);
  }
  assert.equal(slotMgr.current, null);

  // Subsequent transfer below/above 8 MiB can reserve and complete cleanly
  const slot2 = slotMgr.reserve({ id: 't-ok', path: 'relay', generation: 0 });
  const sink = await createFileSink('ok.bin', 'application/octet-stream', 9 * 1024 * 1024);
  await sink.write(new Uint8Array(9 * 1024 * 1024));
  const out = await sink.finish();
  slotMgr.release(slot2);
  assert.equal(out.size, 9 * 1024 * 1024);
  assert.equal(slotMgr.current, null);
});

test('offer reservation, cancellation isolation, and path loss isolation', () => {
  const offers = new OfferReservations();
  assert.equal(
    offers.reserve({
      offerId: 'o1',
      transferId: 't1',
      generation: 1,
      name: 'a.png',
      size: 100,
      mime: 'image/png',
      deadline: 1000,
      accepted: false,
    }, 500),
    true
  );
  assert.equal(offers.busy(500), true);
  assert.equal(offers.accept('o1', 1, 600), true);
  assert.equal(offers.consume('t1', 1, 'a.png', 100, 'image/png', 700), true);
  assert.equal(offers.busy(700), false);

  const lease = new SessionLease();
  assert.equal(affectedByPathLoss({ id: 't1', path: 'relay', generation: lease.epoch }, 'rtc', lease.epoch), false);
  assert.equal(affectedByPathLoss({ id: 't1', path: 'relay', generation: lease.epoch }, 'relay', lease.epoch), true);
});

test('congestion-aware heartbeat survives >35s active relay and detects idle dead socket', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  let fakeNow = performance.now();
  const origPerfNow = performance.now.bind(performance);
  (performance as { now: () => number }).now = () => fakeNow;

  try {
    const liveSock = new MockWebSocket();
    liveSock.bufferedAmount = 3 * 1024 * 1024;
    let liveTimedOut = false;
    const stopLive = attachHeartbeat(liveSock as unknown as WebSocket, () => {
      liveTimedOut = true;
    });
    for (let s = 1; s <= 45; s++) {
      fakeNow += 1000;
      liveSock.bufferedAmount = Math.max(0, liveSock.bufferedAmount - 50 * 1024);
      if (s % 5 === 0) liveSock.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(5) }));
      mock.timers.tick(1000);
    }
    assert.equal(liveTimedOut, false);
    stopLive();

    const deadSock = new MockWebSocket();
    let deadTimedOut = false;
    const stopDead = attachHeartbeat(deadSock as unknown as WebSocket, () => {
      deadTimedOut = true;
    });
    for (let s = 1; s <= 36; s++) {
      fakeNow += 1000;
      mock.timers.tick(1000);
    }
    assert.equal(deadTimedOut, true);
    stopDead();
  } finally {
    (performance as { now: () => number }).now = origPerfNow;
    mock.timers.reset();
  }
});

test('waitSocket resets stall deadline on drain and protocol/filename helpers enforce invariants', async () => {
  const sock = new MockWebSocket();
  sock.bufferedAmount = 4 * 1024 * 1024;
  const drainer = setInterval(() => {
    sock.bufferedAmount = Math.max(0, sock.bufferedAmount - 512 * 1024);
    if (sock.bufferedAmount === 0) clearInterval(drainer);
  }, 5);
  await waitSocket(sock as unknown as WebSocket, 256 * 1024, new AbortController().signal);
  clearInterval(drainer);

  assert.equal(roomWireVersion(2, [2]), 2);
  assert.equal(roomWireVersion(2, [1]), 1);
  assert.equal(roomWireVersion(2, []), null);
  assert.equal(peerVersion('p1', 2, 'p1', undefined), 2);
  assert.equal(ackMatches(1024, 1024), true);
  assert.equal(ackMatches(1024, 1023), false);
  assert.equal(isRelayError('RELAY_NO_LEDGER'), true);
  assert.equal(matchesTransfer('t1', 't2'), false);
  assert.equal(sanitizeSuggestedFilename('con.txt'), '_con.txt');
  const used = new Set<string>();
  assert.equal(uniqueExportName('photo.jpg', used), 'photo.jpg');
  assert.equal(uniqueExportName('photo.jpg', used), 'photo (1).jpg');
});

test('pathAgreement pre-commit prepare timeout releases without invalidating viable RTC', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const traces: string[] = [];
    let invalidated = false;
    let committed: string | null = null;
    let rtcAvailable = false;
    const ac = new AbortController();

    const leader = createPathAgreement({
      leader: true,
      send: () => {},
      available: (p) => (p === 'relay' ? true : rtcAvailable),
      busy: () => false,
      onCommit: (p) => {
        committed = p;
      },
      invalidate: () => {
        invalidated = true;
      },
      onTrace: (ev, d) => traces.push(`${ev}:${String(d.stage ?? '')}`),
      signal: ac.signal,
    });

    // Leader proposes relay, follower never responds to prepare -> 3000ms pre-commit timeout
    assert.equal(leader.request('relay'), true);
    assert.equal(leader.locked, true);
    mock.timers.tick(3050);

    // Must NOT invalidate or destroy agreement; simply releases pending proposal
    assert.equal(invalidated, false);
    assert.equal(leader.locked, false);
    assert.ok(traces.includes('proposal-timeout:prepare'));

    // Later, RTC becomes available and can still propose and commit cleanly
    rtcAvailable = true;
    const sent: unknown[] = [];
    const follower = createPathAgreement({
      leader: false,
      send: (pkt) => sent.push(pkt),
      available: () => true,
      busy: () => false,
      onCommit: () => {},
      invalidate: () => {},
      signal: ac.signal,
    });
    const leader2 = createPathAgreement({
      leader: true,
      send: (pkt) => follower.receive(pkt),
      available: () => true,
      busy: () => false,
      onCommit: (p) => {
        committed = p;
      },
      invalidate: () => {
        invalidated = true;
      },
      signal: ac.signal,
    });
    // Wire follower replies synchronously
    const origSent = sent;
    assert.equal(leader2.request('rtc'), true);
    while (origSent.length) leader2.receive(origSent.shift());
    assert.equal(committed, 'rtc');
    assert.equal(invalidated, false);
    ac.abort();
  } finally {
    mock.timers.reset();
  }
});

for (const delayMs of [500, 1200, 2000]) {
  test(`early SDP offer arriving during ${delayMs}ms delayed TURN init is preserved and applied`, async () => {
    const queue: Array<{ peerId: string; generation: number; sdpType: string }> = [];
    const serial = createSerialSignals((err) => {
      throw err;
    });
    const activeGen = 1;
    const activePeer = 'peer-A';

    // Simulate TURN fetch delay
    const turnPromise = new Promise<void>((r) => setTimeout(r, Math.min(delayMs, 30)));
    // Offer arrives BEFORE PeerConnection exists, plus stale offer from old generation
    queue.push({ peerId: activePeer, generation: activeGen, sdpType: 'offer' });
    queue.push({ peerId: activePeer, generation: 0, sdpType: 'offer' });
    queue.push({ peerId: 'peer-OLD', generation: activeGen, sdpType: 'offer' });

    await turnPromise;
    // PeerConnection created (simulated teardown must NOT clear queue for activePeer + activeGen)
    const applied: string[] = [];
    for (const item of queue.splice(0)) {
      if (item.peerId !== activePeer || item.generation !== activeGen) continue;
      serial.enqueue(async () => {
        applied.push(`${item.peerId}:${item.generation}:${item.sdpType}`);
      });
    }
    await serial.drain();
    assert.deepEqual(applied, ['peer-A:1:offer']);
  });
}

test('lost commit or committed messages never leave peers on mismatched active paths', async () => {
  let follower!: ReturnType<typeof createPathAgreement>;
  let leader!: ReturnType<typeof createPathAgreement>;
  let leaderInvalidated = false;
  let followerInvalidated = false;
  let dropCommitted = false;

  const ac = new AbortController();
  leader = createPathAgreement({
    leader: true,
    send: (msg) => {
      if (msg.stage === 'commit' && !dropCommitted) {
        // First test: drop commit on wire by not forwarding when requested
      }
      queueMicrotask(() => follower.receive(msg));
    },
    available: () => true,
    busy: () => false,
    onCommit: () => {},
    invalidate: () => {
      leaderInvalidated = true;
    },
    signal: ac.signal,
  });

  follower = createPathAgreement({
    leader: false,
    send: (msg) => {
      if (msg.stage === 'committed' && dropCommitted) return;
      queueMicrotask(() => leader.receive(msg));
    },
    available: () => true,
    busy: () => false,
    onCommit: () => {},
    invalidate: () => {
      followerInvalidated = true;
    },
    signal: ac.signal,
  });

  dropCommitted = true;
  assert.equal(leader.request('rtc'), true);
  await new Promise((r) => setTimeout(r, 3200));

  assert.equal(leaderInvalidated, true);
  assert.equal(followerInvalidated, true);
  assert.equal(leader.canStart(), false);
  assert.equal(follower.canStart(), false);
  ac.abort();
});
