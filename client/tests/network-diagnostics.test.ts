import assert from 'node:assert/strict';
import test from 'node:test';
import { createSampler, type Sample } from '../src/network-v2/telemetry.ts';
import { filterTurnServers, parseTurnResponse, turnNeedsRefresh } from '../src/network-v2/turnCredentials.ts';
import { classifyCandidatePair, rtcConfiguration, STUN } from '../src/network-v2/transportRace.ts';
import { inspectPeerStats } from '../src/utils/rtcDiagnostics.ts';
import { getTransportCopy } from '../src/utils/transportCopy.ts';

test('TURN selection filters by requested transport and respects expiry', () => {
  const urls = ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:80?transport=tcp',
    'turns:turn.cloudflare.com:443?transport=tcp', 'turn:turn.cloudflare.com:53?transport=udp'];
  const response = { expiresAt: 1_000_000, iceServers: [{ urls, username: 'fixture', credential: 'fixture' }] };
  const valid = parseTurnResponse(response, 0);
  for (const [i, protocol] of (['udp', 'tcp', 'tls'] as const).entries()) {
    assert.deepEqual(filterTurnServers([...STUN, ...valid.iceServers], protocol, false)[0].urls, [urls[i]]);
  }
  assert.equal(parseTurnResponse(response, response.expiresAt).iceServers.length, 0);
  assert.equal(turnNeedsRefresh(valid.expiresAt, 700_000), true);
  assert.equal(turnNeedsRefresh(valid.expiresAt, 699_999), false);
  assert.equal(rtcConfiguration(valid.iceServers).iceTransportPolicy, 'all');
});

test('an actually selected relay candidate is classified as TURN and never labelled direct', async () => {
  const pc = { getStats: async () => new Map([
    ['selected', { id: 'selected', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['failed', { id: 'failed', type: 'candidate-pair', nominated: true, state: 'failed' }],
    ['l', { id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' }],
    ['r', { id: 'r', type: 'remote-candidate', candidateType: 'host' }],
  ]) } as unknown as RTCPeerConnection;
  const { selectedPair } = await inspectPeerStats(pc);
  assert.equal(selectedPair?.relayProtocol, 'tls');
  const path = classifyCandidatePair(selectedPair);
  assert.equal(path.kind, 'webrtc-turn');
  assert.equal(getTransportCopy('direct', 'webrtc', true, path.kind).isDirect, false);
  assert.equal(getTransportCopy('direct', 'webrtc', true, 'webrtc-unknown').isDirect, false);
});

test('throughput reports waiting, resumes, and reserves 100% for verified completion', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const samples: Sample[] = [];
  const sampler = createSampler(1000, sample => samples.push(sample), Date.now);
  t.mock.timers.tick(900);
  sampler.record(500);
  t.mock.timers.tick(150);
  assert.ok(samples.at(-1)!.speedBps > 0);
  t.mock.timers.tick(2100);
  assert.equal(samples.at(-1)!.phase, 'waiting');
  assert.equal(samples.at(-1)!.speedBps, 0);
  sampler.record(500);
  t.mock.timers.tick(150);
  assert.equal(samples.at(-1)!.phase, 'verifying');
  assert.equal(samples.at(-1)!.progress, 99);
  sampler.stop(true);
  assert.equal(samples.at(-1)!.progress, 100);
});

test('receiver emits the storage quota cause and releases the failed sink', async () => {
  const { createReceiver } = await import('../src/network-v2/engine.ts');
  const { encode, EOF } = await import('../src/network-v2/wire.ts');
  let aborted = false;
  const result = await new Promise<string | undefined>((resolve) => {
    const receiver = createReceiver({
      meta: { transferId: 'fixture', fileId: 1, name: 'fixture', mime: '', size: 1, chunkSize: 1 },
      signal: new AbortController().signal,
      sink: {
        async write() { throw new DOMException('browser-private test location', 'QuotaExceededError'); },
        async abort() { aborted = true; },
        async dispose() {},
        async finish() { throw new Error('Should never finalize'); },
      },
      sendCredit: () => assert.fail('Must not credit a failed write'),
      record: () => assert.fail('Must not report progress for a failed write'),
      result: (response) => resolve(response.reason),
    });
    receiver.push(encode(1, 0, EOF, Uint8Array.of(1)));
  });
  assert.equal(result, 'Receiver storage quota exceeded');
  assert.equal(aborted, true);
});

test('ICE traces distinguish queued candidates from application and rejection', async () => {
  const { IceCandidateQueue } = await import('../src/utils/iceCandidateQueue.ts');
  const queue = new IceCandidateQueue();
  const peer = {
    signalingState: 'stable',
    remoteDescription: null as object | null,
    async addIceCandidate(candidate: RTCIceCandidateInit) {
      if (candidate.candidate === 'bad') throw new Error('fixture');
    },
  };
  const pc = peer as unknown as RTCPeerConnection;
  assert.equal(await queue.add(pc, { candidate: 'good', sdpMid: '0' }), 'queued');
  assert.equal(await queue.add(pc, { candidate: 'bad', sdpMid: '0' }), 'queued');
  peer.remoteDescription = {};
  assert.deepEqual(await queue.flush(pc), { applied: 1, rejected: 1 });
  assert.equal(await queue.add(pc, { candidate: 'bad', sdpMid: '0' }), 'rejected');
  assert.equal(await queue.add(pc, { candidate: 'good', sdpMid: '0' }), 'applied');
});

test('a user-selected destination streams above the fallback cap and yields a file only after commit', async () => {
  const { createFileSink } = await import('../src/network-v2/fileSink.ts');
  const size = 500 * 1024 * 1024;
  let bytesWritten = 0;
  let committed = false;
  const handle = {
    async createWritable() {
      return {
        async write(bytes: Uint8Array) { bytesWritten += bytes.byteLength; },
        async close() { committed = true; },
        async abort() { assert.fail('successful sink must not abort'); },
      };
    },
    async getFile() {
      assert.equal(committed, true);
      return new File([], 'destination.bin');
    },
  } as unknown as FileSystemFileHandle;
  const sink = await createFileSink('original.bin', 'application/octet-stream', size, handle);
  const chunk = new Uint8Array(256 * 1024);
  for (let offset = 0; offset < size; offset += chunk.length) await sink.write(chunk);
  assert.equal(bytesWritten, size);
  assert.equal(committed, false);
  assert.equal((await sink.finish()).name, 'original.bin');
  assert.equal(committed, true);
});
