import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createReceiver, type EndMessage } from '../src/network-v2/engine.ts';
import { transferTiming } from '../src/network-v2/transferTiming.ts';
import { sendVerified, type SenderControl } from '../src/network-v2/verifiedSend.ts';
import { creditFrame, encode, EOF, HEADER, MAX_FRAME, type FileMeta } from '../src/network-v2/wire.ts';

const url = process.env.TEST_WS_URL ?? 'ws://127.0.0.1:8787/ws';
const verifyLimits = process.env.LOCALDROP_TEST_CREDIT_LIMITS === '1';
if (verifyLimits) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname),
    'Credit limit tests require a loopback Worker');
}

// Room traffic and payload go over real WebSockets to a locally running Worker.
function connect() {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const wait = (type: string, match = (_packet: Record<string, any>) => true) => new Promise<Record<string, unknown>>((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener('message', message);
      ws.removeEventListener('error', failed);
    }
    function failed() {
      cleanup();
      reject(new Error(`Socket failed while waiting for ${type}`));
    }
    function message(event: MessageEvent) {
      if (typeof event.data !== 'string') return;
      const packet = JSON.parse(event.data);
      if (packet.type === type && match(packet)) { cleanup(); resolve(packet); }
      if (packet.type === 'room-error') { cleanup(); reject(new Error(packet.code)); }
    }
    const timer = setTimeout(failed, 5000);
    ws.addEventListener('message', message);
    ws.addEventListener('error', failed);
  });
  const welcome = wait('welcome');
  const send = (packet: object) => ws.send(JSON.stringify(packet));
  const relay = (payload: object) => send({ type: 'relay', payload });
  return { ws, send, relay, wait, welcome };
}

type Peer = ReturnType<typeof connect>;
async function verifiedTransfer(sender: Peer, receiver: Peer, size: number) {
  const block = new Uint8Array(randomBytes(Math.min(size, 1024 * 1024)));
  const expected = createHash('sha256');
  const blocks: Blob[] = [];
  const blob = new Blob([block]);
  for (let remaining = size; remaining > 0; remaining -= block.length) {
    const bytes = Math.min(remaining, block.length);
    blocks.push(bytes === block.length ? blob : blob.slice(0, bytes));
    expected.update(block.subarray(0, bytes));
  }
  const expectedDigest = expected.digest('hex');
  const file = new File(blocks, 'relay-test.bin');
  const meta: FileMeta = {
    transferId: randomUUID(), fileId: 1, size, name: 'relay-test.bin',
    mime: 'application/octet-stream', chunkSize: MAX_FRAME - HEADER,
  };
  const controller = new AbortController();
  const signal = controller.signal;
  const timing = transferTiming();
  const received = createHash('sha256');
  let receivedBytes = 0;
  let confirmedBytes = 0;
  let download: ReturnType<typeof createReceiver> | undefined;
  let receiverDigest: string | undefined;
  const receiverMessage = ({ data }: MessageEvent) => {
    if (data instanceof ArrayBuffer) { download?.push(data); return; }
    if (typeof data !== 'string') return;
    const packet = JSON.parse(data);
    const payload = packet.payload;
    if (payload?.transferId !== meta.transferId) return;
    if (payload.type === 'v2-meta') {
      download = createReceiver({
        meta: payload, signal,
        sendCredit: (frame) => receiver.ws.send(frame),
        record: (bytes) => { receivedBytes += bytes; },
        sink: {
          async write(bytes) { received.update(bytes); },
          async finish() { receiverDigest = received.digest('hex'); return new File([], file.name); },
          async abort() {},
          async dispose() {},
        },
        result: (result) => { receiver.relay(result); },
      });
      receiver.relay({ type: 'v2-ready', transferId: meta.transferId, ok: true });
    } else if (payload.type === 'v2-end') download?.end(payload as EndMessage);
    else if (payload.type === 'v2-cancel') controller.abort(new Error(payload.reason ?? 'Peer cancelled'));
  };
  receiver.ws.addEventListener('message', receiverMessage);
  const start = performance.now();
  try {
    const final = await sendVerified({
      meta, file, signal, path: { kind: 'relay', socket: sender.ws },
      sendControl: sender.relay,
      subscribe: (control, credit) => {
        const handler = ({ data }: MessageEvent) => {
          if (data instanceof ArrayBuffer) credit(data);
          else if (typeof data === 'string') {
            const packet = JSON.parse(data);
            if (packet.type === 'relay') control(packet.payload as SenderControl);
            if (packet.type === 'error') controller.abort(new Error(packet.message));
          }
        };
        sender.ws.addEventListener('message', handler);
        return () => sender.ws.removeEventListener('message', handler);
      },
      record: (bytes) => { confirmedBytes += bytes; },
      measure: timing.measure,
      invalidatePath: () => {},
    });
    assert.equal(final.digest, expectedDigest);
    assert.equal(receiverDigest, expectedDigest);
    assert.equal(receivedBytes, size);
    assert.equal(confirmedBytes, size);
    console.log(JSON.stringify({ verifiedBytes: size, elapsedMs: Math.round(performance.now() - start), stages: timing.snapshot() }));
  } finally {
    receiver.ws.removeEventListener('message', receiverMessage);
    await download?.abort();
  }
}

// Protocol-integrity checks use the local Worker only.
async function beginLedger(sender: Peer, receiver: Peer, transferId: string, fileId: number, size: number) {
  const offered = receiver.wait('relay', (p) => p.payload?.type === 'v2-meta' && p.payload.transferId === transferId);
  sender.relay({ type: 'v2-meta', transferId, fileId, size, chunkSize: size });
  await offered;
  const ready = sender.wait('relay', (p) => p.payload?.type === 'v2-ready' && p.payload.transferId === transferId);
  receiver.relay({ type: 'v2-ready', ok: true, transferId });
  await ready;
}

function waitBinary(peer: Peer, length: number, count = 1) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.ws.removeEventListener('message', message);
      reject(new Error('Timed out waiting for relay binary frames'));
    }, 5000);
    function message({ data }: MessageEvent) {
      if (!(data instanceof ArrayBuffer) || data.byteLength !== length || --count !== 0) return;
      clearTimeout(timeout);
      peer.ws.removeEventListener('message', message);
      resolve();
    }
    peer.ws.addEventListener('message', message);
  });
}

async function verifyCreditIsolation(a: Peer, b: Peer) {
  const forward = randomUUID();
  const reverse = randomUUID();
  await beginLedger(a, b, forward, 20, 240);

  const duplicate = b.wait('error', (p) => p.code === 'RELAY_BUSY');
  b.relay({ type: 'v2-meta', transferId: forward, fileId: 21, size: 4, chunkSize: 4 });
  assert.equal((await duplicate).transferId, forward);
  await beginLedger(b, a, reverse, 21, 4);

  const delivered = waitBinary(b, 248);
  a.ws.send(encode(20, 0, EOF, new Uint8Array(240)));
  await delivered;

  const credits = waitBinary(a, 5, 55);
  for (let i = 0; i < 55; i++) b.ws.send(creditFrame(1));
  await credits;
  const control = a.wait('relay', (p) => p.payload?.type === 'shared-text');
  b.relay({ type: 'shared-text', text: 'quota isolation check' });
  await control;

  const aborted = a.wait('error', (p) => p.code === 'RELAY_ABORTED');
  const cancelled = b.wait('relay', (p) => p.payload?.type === 'v2-cancel');
  for (let i = 0; i < 120; i++) b.ws.send(creditFrame(1));
  assert.equal((await aborted).transferId, forward);
  const notice = await cancelled;
  assert.deepEqual(notice.payload, { type: 'v2-cancel', transferId: forward, reason: 'Relay credit rate exceeded' });

  // The receiver's separately active outgoing transfer remains usable.
  const survivingFrame = waitBinary(a, 12);
  b.ws.send(encode(21, 0, EOF, new Uint8Array(4)));
  await survivingFrame;
  const survivingCredit = waitBinary(b, 5);
  a.ws.send(creditFrame(4));
  await survivingCredit;
  const reverseCancelled = a.wait('relay', (p) => p.payload?.type === 'v2-cancel' && p.payload.transferId === reverse);
  b.relay({ type: 'v2-cancel', transferId: reverse });
  await reverseCancelled;

  for (const fixture of [
    { frame: new ArrayBuffer(5), reason: 'Invalid credit frame' },
    { frame: creditFrame(5), reason: 'Credit exceeds outstanding data' },
  ]) {
    const transferId = randomUUID();
    await beginLedger(b, a, transferId, 22, 4);
    const frame = waitBinary(a, 12);
    b.ws.send(encode(22, 0, EOF, new Uint8Array(4)));
    await frame;
    const error = b.wait('error', (p) => p.code === 'RELAY_ABORTED');
    const notice = a.wait('relay', (p) => p.payload?.type === 'v2-cancel');
    a.ws.send(fixture.frame);
    assert.equal((await error).transferId, transferId);
    assert.deepEqual((await notice).payload, { type: 'v2-cancel', transferId, reason: fixture.reason });
  }
  console.log('Relay credit isolation, validation, bounded burst and directional cancellation passed');
}

const a = connect();
const b = connect();
try {
  await Promise.all([a.welcome, b.welcome]);
  a.send({ type: 'register', name: 'Relay test A', networkVersion: 2 });
  b.send({ type: 'register', name: 'Relay test B', networkVersion: 2 });
  const roomCode = String(randomInt(1000, 10000));
  const created = a.wait('room-created');
  a.send({ type: 'create-room', roomCode });
  await created;
  const joined = b.wait('room-joined');
  b.send({ type: 'join-room', roomCode, createIfMissing: false });
  await joined;
  await verifiedTransfer(a, b, 700000);
  await verifiedTransfer(a, b, 100000000);
  await verifiedTransfer(b, a, 700000);
  if (verifyLimits) {
    // Refill after the throughput run so the valid burst starts with its full budget.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await verifyCreditIsolation(a, b);
    await verifiedTransfer(a, b, 700000);
  }
} finally {
  a.ws.close();
  b.ws.close();
}
