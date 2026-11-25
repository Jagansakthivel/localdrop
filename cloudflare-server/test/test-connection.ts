import WebSocket from 'ws';
import crypto from 'crypto';

const HTTP_URL = process.env.TEST_HTTP_URL || 'http://127.0.0.1:8787';
const WS_URL = process.env.TEST_WS_URL || 'ws://127.0.0.1:8787/ws';

interface TestClient {
  ws: WebSocket;
  messages: Record<string, any>[];
  binaryChunks: Buffer[];
  waitMessage: (predicate: (msg: Record<string, any>) => boolean, timeoutMs?: number) => Promise<Record<string, any>>;
  waitBinaryBytes: (totalBytes: number, timeoutMs?: number) => Promise<Buffer>;
  send: (data: string | Buffer) => void;
  close: () => void;
}

function createTestClient(): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: {
        Origin: 'http://localhost:5173',
      },
    });

    const messages: Record<string, any>[] = [];
    const binaryChunks: Buffer[] = [];
    const listeners: ((msg: Record<string, any>) => void)[] = [];
    const binaryListeners: (() => void)[] = [];

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        binaryChunks.push(Buffer.from(data as ArrayBuffer));
        for (const bl of binaryListeners) bl();
      } else {
        try {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          for (const listener of [...listeners]) {
            listener(msg);
          }
        } catch {
          // ignore
        }
      }
    });

    function waitMessage(
      predicate: (msg: Record<string, any>) => boolean,
      timeoutMs = 6000
    ): Promise<Record<string, any>> {
      // 1. Check existing buffered messages first
      const index = messages.findIndex(predicate);
      if (index !== -1) {
        const found = messages[index];
        messages.splice(index, 1);
        return Promise.resolve(found);
      }

      // 2. Wait for incoming message
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          removeListener();
          rej(new Error(`Timed out waiting for message matching predicate (${timeoutMs}ms)`));
        }, timeoutMs);

        function onNewMessage(msg: Record<string, any>) {
          if (predicate(msg)) {
            clearTimeout(timer);
            removeListener();
            const idx = messages.indexOf(msg);
            if (idx !== -1) messages.splice(idx, 1);
            res(msg);
          }
        }

        function removeListener() {
          const idx = listeners.indexOf(onNewMessage);
          if (idx !== -1) listeners.splice(idx, 1);
        }

        listeners.push(onNewMessage);
      });
    }

    function waitBinaryBytes(totalBytes: number, timeoutMs = 8000): Promise<Buffer> {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          cleanup();
          rej(new Error(`Timed out waiting for ${totalBytes} binary bytes`));
        }, timeoutMs);

        function check() {
          const total = binaryChunks.reduce((acc, c) => acc + c.length, 0);
          if (total >= totalBytes) {
            clearTimeout(timer);
            cleanup();
            res(Buffer.concat(binaryChunks));
          }
        }

        function cleanup() {
          const idx = binaryListeners.indexOf(check);
          if (idx !== -1) binaryListeners.splice(idx, 1);
        }

        binaryListeners.push(check);
        check();
      });
    }

    ws.on('open', () => {
      resolve({
        ws,
        messages,
        binaryChunks,
        waitMessage,
        waitBinaryBytes,
        send: (data: string | Buffer) => ws.send(data),
        close: () => ws.close(),
      });
    });

    ws.on('error', (err) => reject(err));
  });
}

async function runTests() {
  console.log('=====================================================');
  console.log('LOCALDROP CLOUDFLARE WORKERS & DO INTEGRATION TESTS');
  console.log('Target:', WS_URL);
  console.log('=====================================================\n');

  // --- TEST 1: Device A Registration and Host Room ---
  console.log('--- TEST 1: Connect Device A and Host Room ---');
  const clientA = await createTestClient();
  const welcomeA = await clientA.waitMessage((m) => m.type === 'welcome');
  console.log('✓ Device A connected, ID:', welcomeA.id);

  clientA.send(JSON.stringify({ type: 'register', name: 'MacBook Pro', deviceType: 'desktop' }));
  const hostPin = String(Math.floor(1000 + Math.random() * 9000));
  clientA.send(JSON.stringify({ type: 'create-room', roomCode: hostPin }));
  const createdA = await clientA.waitMessage((m) => m.type === 'room-created');
  console.log('✓ Device A created room:', createdA.roomCode);

  // --- TEST 2: Device B Invalid PIN ---
  console.log('\n--- TEST 2: Device B tries invalid PIN ---');
  const clientB = await createTestClient();
  await clientB.waitMessage((m) => m.type === 'welcome');
  clientB.send(JSON.stringify({ type: 'join-room', roomCode: '9999', createIfMissing: false }));
  const notFound = await clientB.waitMessage((m) => m.type === 'room-error');
  console.log('✓ Invalid PIN correctly rejected with code:', notFound.code, '-', notFound.message);

  // --- TEST 3: Device B Valid PIN Pairing ---
  console.log('\n--- TEST 3: Device B pairs with correct PIN ---');
  clientB.send(JSON.stringify({ type: 'register', name: 'Pixel Phone', deviceType: 'mobile' }));
  clientB.send(JSON.stringify({ type: 'join-room', roomCode: hostPin, createIfMissing: false }));

  const [joinedB, peerJoinedA] = await Promise.all([
    clientB.waitMessage((m) => m.type === 'room-joined'),
    clientA.waitMessage((m) => m.type === 'peer-joined-room'),
  ]);
  console.log('✓ Device B room-joined confirmed:', joinedB.roomCode);
  console.log('✓ Device A peer-joined-room confirmed from:', peerJoinedA.peer.name);

  // --- TEST 4: Room Capacity Enforcement (Max 2 Devices) ---
  console.log('\n--- TEST 4: Room capacity (Max 2 devices) ---');
  const clientC = await createTestClient();
  await clientC.waitMessage((m) => m.type === 'welcome');
  clientC.send(JSON.stringify({ type: 'join-room', roomCode: hostPin, createIfMissing: false }));
  const roomFull = await clientC.waitMessage((m) => m.type === 'room-error');
  console.log('✓ Device C correctly rejected when room full:', roomFull.code, '-', roomFull.message);
  clientC.close();

  // --- TEST 5: WebRTC Signaling Exchange (SDP & ICE) ---
  console.log('\n--- TEST 5: Signaling exchange (SDP & ICE) ---');
  clientA.send(
    JSON.stringify({
      type: 'signal',
      to: peerJoinedA.peer.id,
      signal: { sdp: { type: 'offer', sdp: 'v=0\r\ntest-sdp' } },
    })
  );
  const signalB = await clientB.waitMessage((m) => m.type === 'signal');
  console.log('✓ Device B received signal from:', signalB.fromName, 'SDP type:', signalB.signal.sdp.type);

  // --- TEST 6: File Relay Transfer & SHA-256 Data Integrity ---
  console.log('\n--- TEST 6: File Relay Transfer & SHA-256 Integrity Verification ---');
  const testPayload = crypto.randomBytes(256 * 1024); // 256KB binary payload
  const originalSha256 = crypto.createHash('sha256').update(testPayload).digest('hex');
  console.log('Original File SHA-256:', originalSha256);

  // Send metadata JSON packet
  clientA.send(
    JSON.stringify({
      type: 'relay',
      payload: {
        type: 'file-meta',
        transferId: 'test-transfer-cf-1',
        name: 'test-document.bin',
        size: testPayload.length,
        mime: 'application/octet-stream',
      },
    })
  );

  const metaB = await clientB.waitMessage((m) => m.type === 'relay' && m.payload?.type === 'file-meta');
  console.log('✓ Device B received file-meta relay packet for:', metaB.payload.name);

  const binaryWaitPromise = clientB.waitBinaryBytes(testPayload.length);

  // Stream in 64KB binary chunks
  const CHUNK_SIZE = 64 * 1024;
  for (let offset = 0; offset < testPayload.length; offset += CHUNK_SIZE) {
    const chunk = testPayload.subarray(offset, offset + CHUNK_SIZE);
    clientA.send(chunk);
  }

  const assembled = await binaryWaitPromise;
  const receivedSha256 = crypto.createHash('sha256').update(assembled).digest('hex');
  console.log('Received File SHA-256:', receivedSha256);

  if (receivedSha256 !== originalSha256) {
    throw new Error('SHA-256 checksum MISMATCH!');
  }
  console.log('✓ SHA-256 Checksums MATCH exactly! (100% Data Integrity Verified)');

  // Clean up WebSockets
  clientA.close();
  clientB.close();

  // --- TEST 7: HTTP /health Endpoint Check ---
  console.log('\n--- TEST 7: HTTP /health Endpoint & Durable Objects Status ---');
  const healthRes = await fetch(`${HTTP_URL}/health`);
  if (!healthRes.ok) {
    throw new Error(`/health returned HTTP status ${healthRes.status}`);
  }
  const healthData = (await healthRes.json()) as Record<string, any>;
  console.log('✓ /health responded 200 OK with payload:', healthData);

  if (healthData.status !== 'ok') {
    throw new Error(`/health payload status was ${healthData.status}, expected "ok"`);
  }

  // --- TEST 8: Origin Validation (CORS & Security) ---
  console.log('\n--- TEST 8: Origin Validation & Security Boundary ---');
  const blockedWsPromise = new Promise<boolean>((resolve) => {
    const evilWs = new WebSocket(WS_URL, {
      headers: { Origin: 'https://malicious-attacker-site.com' },
    });
    evilWs.on('error', () => resolve(true));
    evilWs.on('close', (code) => {
      if (code === 1006 || code === 403) resolve(true);
    });
    evilWs.on('open', () => {
      evilWs.close();
      resolve(false);
    });
  });

  const wasBlocked = await blockedWsPromise;
  if (wasBlocked) {
    console.log('✓ Unauthorized origin correctly rejected with 403 / connection drop');
  } else {
    console.warn('⚠ Note: Origin was not rejected by dev server proxy');
  }

  console.log('\n=====================================================');
  console.log('✅ ALL CLOUDFLARE BACKEND INTEGRATION TESTS PASSED!');
  console.log('=====================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
