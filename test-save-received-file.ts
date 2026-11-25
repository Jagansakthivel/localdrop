import { createHash } from 'node:crypto';
import {
  supportsNativeSavePicker,
  chooseSaveLocation,
  writeReceivedFile,
  downloadReceivedFile,
  saveReceivedFile,
  computeFileSha256,
  type SaveFileHandle,
} from './client/src/utils/saveReceivedFile.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function runTests() {
  console.log('=====================================================');
  console.log('LOCALDROP SAVE-TO-LOCATION & SHA-256 INTEGRITY TESTS');
  console.log('=====================================================\n');

  // Test 1: SHA-256 Checksum Helper
  console.log('--- TEST 1: SHA-256 Checksum Helper ---');
  const testBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const nodeHash = createHash('sha256').update(testBytes).digest('hex');
  const testBlob = new Blob([testBytes]);
  const helperHash = await computeFileSha256(testBlob);
  assert(nodeHash === helperHash, `SHA-256 matches Node crypto (${helperHash.slice(0, 16)}...)`);

  // Test 2: Runtime detection of File System Access API
  console.log('\n--- TEST 2: Runtime Detection of Native File Picker ---');
  // In Node environment without window.showSaveFilePicker
  assert(supportsNativeSavePicker() === false, 'Detects lack of showSaveFilePicker in non-Chromium/headless environment');

  // Setup mock browser window for Chromium
  let chosenName = 'received_video.mp4';
  let shouldAbort = false;
  let throwPickerError: Error | null = null;
  let writtenChunks: Blob[] = [];
  let streamClosed = false;
  let streamAborted = false;

  const mockWritableStream = {
    async write(data: Blob) {
      if (shouldAbort) throw new Error('Disk full / write permission denied');
      writtenChunks.push(data);
    },
    async close() {
      streamClosed = true;
    },
    async abort() {
      streamAborted = true;
    },
  };

  const mockHandle: SaveFileHandle = {
    get name() {
      return chosenName;
    },
    async createWritable() {
      return mockWritableStream;
    },
  };

  (globalThis as any).window = {
    isSecureContext: true,
    showSaveFilePicker: async (options?: any) => {
      if (throwPickerError) throw throwPickerError;
      if (options?.suggestedName) {
        chosenName = options.suggestedName;
      }
      return mockHandle;
    },
  };

  assert(supportsNativeSavePicker() === true, 'Detects showSaveFilePicker in secure Chromium context');

  // Test 3: Write received file and verify byte-for-byte SHA-256 match
  console.log('\n--- TEST 3: Byte-for-Byte Write & SHA-256 Integrity ---');
  const sampleData = new Uint8Array(1024 * 512); // 512 KB test payload
  for (let i = 0; i < sampleData.length; i++) {
    sampleData[i] = (i * 31 + 17) & 0xff;
  }
  const sampleFile = new File([sampleData], 'high_res_render.mov', { type: 'video/quicktime' });
  const sampleSha = await computeFileSha256(sampleFile);

  writtenChunks = [];
  streamClosed = false;
  streamAborted = false;
  const writeRes = await writeReceivedFile(sampleFile, mockHandle);

  assert(writeRes.status === 'saved', 'Write status is "saved"');
  if (writeRes.status === 'saved') {
    assert(writeRes.filename === mockHandle.name, `Filename is preserved (${writeRes.filename})`);
  }
  assert(streamClosed === true, 'Writable stream was properly closed');
  assert(streamAborted === false, 'Writable stream was not aborted');

  const writtenBlob = new Blob(writtenChunks);
  const writtenSha = await computeFileSha256(writtenBlob);
  assert(sampleSha === writtenSha, `SHA-256 checksum matches identically: ${sampleSha.slice(0, 20)}...`);

  // Test 4: Long and Unicode Filenames Preservation
  console.log('\n--- TEST 4: Long & Unicode Filenames ---');
  const unicodeName = '🔥_üñîçødé_日本語_ملف_LocalDrop_Transfer_2026.tar.gz';
  const longFile = new File([new Uint8Array([42, 43, 44])], unicodeName, { type: 'application/gzip' });
  chosenName = unicodeName;
  writtenChunks = [];
  const unicodeRes = await writeReceivedFile(longFile, mockHandle);
  assert(unicodeRes.status === 'saved', 'Unicode file successfully written');
  if (unicodeRes.status === 'saved') {
    assert(unicodeRes.filename === unicodeName, `Preserved full Unicode filename: ${unicodeRes.filename}`);
  }

  // Test 5: Picker Cancellation (DOMException AbortError)
  console.log('\n--- TEST 5: Picker Cancellation ---');
  const abortErr = new DOMException('The user aborted a request.', 'AbortError');
  throwPickerError = abortErr;
  const cancelRes = await chooseSaveLocation('cancel_me.pdf');
  assert(cancelRes === null, 'User cancellation cleanly returns null without crashing');
  throwPickerError = null;

  // Test 6: Permission Denial / Write Failure & Stream Abort
  console.log('\n--- TEST 6: Write Failure Handling ---');
  shouldAbort = true;
  streamClosed = false;
  streamAborted = false;
  const failRes = await writeReceivedFile(sampleFile, mockHandle);
  assert(failRes.status === 'failed', 'Failing write returns status "failed"');
  if (failRes.status === 'failed') {
    assert(failRes.message.includes('permission denied'), `Error message reported: "${failRes.message}"`);
  }
  assert(streamAborted === true, 'Writable stream called abort() on failure');
  shouldAbort = false;

  // Test 7: Retry Saving After Failure
  console.log('\n--- TEST 7: Retry Saving After Failure ---');
  writtenChunks = [];
  streamClosed = false;
  streamAborted = false;
  const retryRes = await writeReceivedFile(sampleFile, mockHandle);
  assert(retryRes.status === 'saved', 'Retry succeeds when error condition is resolved');

  // Test 8: Firefox & Safari Fallback (Standard Browser Download)
  console.log('\n--- TEST 8: Firefox & Safari Download Fallback ---');
  let clickedUrl = '';
  let clickedDownload = '';
  let linkRemoved = false;
  (globalThis as any).document = {
    createElement: (tag: string) => {
      const el: any = {
        style: {},
        click: () => {
          clickedUrl = el.href;
          clickedDownload = el.download;
        },
        remove: () => {
          linkRemoved = true;
        },
      };
      return el;
    },
    body: {
      appendChild: (el: any) => {},
    },
  };
  (globalThis as any).URL.createObjectURL = (blob: any) => `blob:mock-url-${Date.now()}`;
  (globalThis as any).URL.revokeObjectURL = (url: any) => {};

  // Emulate Firefox (no showSaveFilePicker)
  delete (globalThis as any).window.showSaveFilePicker;
  assert(supportsNativeSavePicker() === false, 'Firefox detected as lacking native picker');

  const fallbackFile = new File([new Uint8Array([1, 2, 3])], 'firefox_report.pdf', { type: 'application/pdf' });
  const fallbackRes = downloadReceivedFile(fallbackFile);
  assert(fallbackRes.status === 'download-started', 'Fallback returns status "download-started"');
  assert(clickedDownload === 'firefox_report.pdf', `Link download attribute matches: ${clickedDownload}`);
  assert(clickedUrl.startsWith('blob:mock-url-'), 'Blob URL created for download');
  assert(linkRemoved === true, 'Anchor link removed from document body');

  // Summary
  console.log('\n=====================================================');
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
