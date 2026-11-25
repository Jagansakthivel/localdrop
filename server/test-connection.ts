import WebSocket from 'ws';
import crypto from 'crypto';

const SERVER_URL = 'ws://localhost:8080';

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

function waitMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`Timed out waiting for message matching condition (${timeoutMs}ms)`));
    }, timeoutMs);

    function onMsg(raw: WebSocket.RawData, isBinary: boolean) {
      if (isBinary) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(msg);
        }
      } catch {
        // ignore
      }
    }

    ws.on('message', onMsg);
  });
}

async function runTests() {
  console.log('--- TEST 1: Connect Device A and Host Room ---');
  const wsA = await connectWs();
  const welcomeA = await waitMessage(wsA, (m) => m.type === 'welcome');
  console.log('✓ Device A connected, ID:', welcomeA.id);

  wsA.send(JSON.stringify({ type: 'register', name: 'MacBook Pro', deviceType: 'desktop' }));
  const hostPin = String(Math.floor(1000 + Math.random() * 9000));
  wsA.send(JSON.stringify({ type: 'create-room', roomCode: hostPin }));
  const createdA = await waitMessage(wsA, (m) => m.type === 'room-created');
  console.log('✓ Device A created room:', createdA.roomCode);

  console.log('\n--- TEST 2: Device B tries invalid PIN ---');
  const wsB = await connectWs();
  await waitMessage(wsB, (m) => m.type === 'welcome');
  wsB.send(JSON.stringify({ type: 'join-room', roomCode: '9999', createIfMissing: false }));
  const notFound = await waitMessage(wsB, (m) => m.type === 'room-error');
  console.log('✓ Invalid PIN correctly rejected with code:', notFound.code, '-', notFound.message);

  console.log('\n--- TEST 3: Device B pairs with correct PIN ---');
  wsB.send(JSON.stringify({ type: 'register', name: 'Pixel Phone', deviceType: 'mobile' }));
  wsB.send(JSON.stringify({ type: 'join-room', roomCode: hostPin, createIfMissing: false }));

  const [joinedB, peerJoinedA] = await Promise.all([
    waitMessage(wsB, (m) => m.type === 'room-joined'),
    waitMessage(wsA, (m) => m.type === 'peer-joined-room'),
  ]);
  console.log('✓ Device B room-joined confirmed:', joinedB.roomCode);
  console.log('✓ Device A peer-joined-room confirmed from:', peerJoinedA.peer.name);

  console.log('\n--- TEST 4: Room capacity (Max 2 devices) ---');
  const wsC = await connectWs();
  await waitMessage(wsC, (m) => m.type === 'welcome');
  wsC.send(JSON.stringify({ type: 'join-room', roomCode: hostPin, createIfMissing: false }));
  const roomFull = await waitMessage(wsC, (m) => m.type === 'room-error');
  console.log('✓ Device C correctly rejected when room full:', roomFull.code, '-', roomFull.message);
  wsC.close();

  console.log('\n--- TEST 5: Signaling exchange (SDP & ICE) ---');
  wsA.send(
    JSON.stringify({
      type: 'signal',
      to: peerJoinedA.peer.id,
      signal: { sdp: { type: 'offer', sdp: 'v=0\r\ntest-sdp' } },
    })
  );
  const signalB = await waitMessage(wsB, (m) => m.type === 'signal');
  console.log('✓ Device B received signal from:', signalB.fromName, 'SDP type:', signalB.signal.sdp.type);

  console.log('\n--- TEST 6: File Relay Transfer & SHA-256 Integrity Verification ---');
  // Generate random 256KB test payload
  const testPayload = crypto.randomBytes(256 * 1024);
  const originalSha256 = crypto.createHash('sha256').update(testPayload).digest('hex');
  console.log('Original File SHA-256:', originalSha256);

  // Send metadata
  wsA.send(
    JSON.stringify({
      type: 'relay',
      payload: {
        type: 'file-meta',
        transferId: 'test-transfer-1',
        name: 'test-document.bin',
        size: testPayload.length,
        mime: 'application/octet-stream',
      },
    })
  );

  const receivedChunks: Buffer[] = [];
  const binaryPromise = new Promise<void>((resolve) => {
    wsB.on('message', (data, isBinary) => {
      if (isBinary) {
        receivedChunks.push(Buffer.from(data as ArrayBuffer));
        const total = receivedChunks.reduce((acc, c) => acc + c.length, 0);
        if (total >= testPayload.length) {
          resolve();
        }
      }
    });
  });

  // Stream in 64KB chunks
  const CHUNK_SIZE = 64 * 1024;
  for (let offset = 0; offset < testPayload.length; offset += CHUNK_SIZE) {
    const chunk = testPayload.subarray(offset, offset + CHUNK_SIZE);
    wsA.send(chunk);
  }

  await binaryPromise;
  const assembled = Buffer.concat(receivedChunks);
  const receivedSha256 = crypto.createHash('sha256').update(assembled).digest('hex');
  console.log('Received File SHA-256:', receivedSha256);

  if (receivedSha256 !== originalSha256) {
    throw new Error('SHA-256 checksum MISMATCH!');
  }
  console.log('✓ SHA-256 Checksums MATCH exactly! (100% Data Integrity Verified)');

  // Clean up
  wsA.close();
  wsB.close();

  console.log('\n--- TEST 7: HTTP /health Endpoint & Render Zero-Downtime Check ---');
  const healthRes = await fetch('http://localhost:8080/health');
  if (!healthRes.ok) {
    throw new Error(`/health returned HTTP status ${healthRes.status}`);
  }
  const healthData = await healthRes.json();
  if (healthData.status !== 'ok') {
    throw new Error(`/health payload status was ${healthData.status}, expected "ok"`);
  }
  console.log('✓ /health responded 200 OK with payload:', healthData);

  console.log('\n✅ ALL 7 INTEGRATION TESTS PASSED CLEANLY!\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
