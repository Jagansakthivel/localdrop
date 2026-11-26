import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { firefox, chromium } = await import(process.env.LOCALDROP_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.LOCALDROP_PLAYWRIGHT_MODULE).href
  : 'playwright');
const pageUrl = process.env.LOCALDROP_DIAGNOSTICS_URL ?? 'http://127.0.0.1:4174/diagnostics.html';
const temp = await mkdtemp(join(tmpdir(), 'localdrop-fixtures-'));
const browsers = [];

async function waitForOutput(page) {
  await page.waitForFunction(() => document.querySelector('#local').value.length > 0, null, { timeout: 25000 });
  return page.locator('#local').inputValue();
}

async function connect(left, right, topology) {
  await Promise.all([left, right].map(async (page) => {
    await page.goto(pageUrl);
    await page.locator('#topology').selectOption(topology);
    if (topology !== 'relay') await page.locator('#ice').selectOption('host');
  }));
  if (topology === 'relay') {
    await left.getByRole('button', { name: 'Create relay room' }).click();
    const code = await left.waitForFunction(() => document.querySelector('#relay-room').textContent.match(/Room (\d{4})/)?.[1]);
    await right.locator('#room-code').fill(await code.jsonValue());
    await right.getByRole('button', { name: 'Join relay room' }).click();
    await Promise.all([left, right].map((page) => page.waitForFunction(() => !document.querySelector('#arm').disabled)));
    const path = await reports(left, 'selected-path');
    assert.equal(path.at(-1)?.kind, 'ws-relay');
    return;
  }
  await right.locator('#signal-delay').fill('400');
  await left.locator('#offer').click();
  await right.locator('#remote').fill(await waitForOutput(left));
  await right.locator('#answer').click();
  await left.locator('#remote').fill(await waitForOutput(right));
  await left.locator('#apply').click();
  await Promise.all([left, right].map((page) => page.waitForFunction(
    () => !document.querySelector('#arm').disabled, null, { timeout: 30000 },
  )));
}

async function reports(page, event) {
  return (await page.locator('#report').textContent()).split('\n')
    .map((line) => JSON.parse(line)).filter((entry) => entry.event === event);
}

async function waitResult(page, event, previous) {
  await page.waitForFunction(({ event, previous }) => document.querySelector('#report').textContent
    .split('\n').filter((line) => JSON.parse(line).event === event).length > previous,
  { event, previous }, { timeout: 45000 });
  return (await reports(page, event)).at(-1);
}

async function transfer(sender, receiver, size, file, sink, writeDelay = 0) {
  const sentCount = (await reports(sender, 'send-result')).length;
  const receivedCount = (await reports(receiver, 'receive-result')).length;
  await receiver.locator('#sink').selectOption(sink);
  await receiver.locator('#write-delay').fill(String(writeDelay));
  await receiver.locator('#arm').click();
  await sender.locator('#file').setInputFiles(file);
  await sender.locator('#send').click();
  const [sent, received] = await Promise.all([
    waitResult(sender, 'send-result', sentCount),
    waitResult(receiver, 'receive-result', receivedCount),
  ]);
  assert.equal(sent.ok, true, sent.reason);
  assert.equal(received.ok, true, received.reason);
  assert.equal(sent.bytes, size);
  assert.equal(received.bytes, size);
  assert.ok(sent.timing['final-ack']);
  for (const stage of ['file-read', 'send-hash', 'credit-wait', 'send-buffer-wait']) {
    assert.ok(sent.timing[stage], stage);
  }
  assert.ok(received.timing['sink-commit']);
  return { sender: sent, receiver: received };
}

try {
  const ff = await firefox.launch({ executablePath: process.env.LOCALDROP_FIREFOX });
  browsers.push(ff);
  const cr = await chromium.launch({ executablePath: process.env.LOCALDROP_CHROMIUM });
  browsers.push(cr);
  const left = await ff.newPage();
  const right = await cr.newPage();

  const small = { name: 'probe.bin', mimeType: 'application/octet-stream', buffer: randomBytes(700000) };
  const large = join(temp, 'large.bin');
  const handle = await open(large, 'wx');
  try {
    for (let remaining = 100000000; remaining > 0;) {
      const bytes = randomBytes(Math.min(remaining, 1024 * 1024));
      await handle.writeFile(bytes);
      remaining -= bytes.length;
    }
  } finally {
    await handle.close();
  }

  const topologies = process.env.LOCALDROP_RTC_TOPOLOGY
    ? [process.env.LOCALDROP_RTC_TOPOLOGY] : ['single', 'striped'];
  for (const topology of topologies) {
    assert.ok(['single', 'striped', 'relay'].includes(topology));
    await connect(left, right, topology);
    const expectedChannels = topology === 'single' ? 1 : topology === 'striped' ? 5 : 0;
    for (const page of [left, right]) {
      assert.equal((await reports(page, 'channel-open')).length, expectedChannels);
    }
    if (topology === 'relay' && !process.env.LOCALDROP_DIAGNOSTICS_SMOKE) {
      // The receiver stays unarmed. A metadata rejection must precede any payload.
      await left.locator('#file').setInputFiles(small);
      await left.locator('#send').click();
      const rejected = await waitResult(left, 'send-result', 0);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.bytes, 0);
      assert.equal((await reports(left, 'payload-start')).length, 0);
      assert.equal((await reports(right, 'first-chunk-written')).length, 0);
      await connect(left, right, topology);
    }
    const forward = await transfer(left, right, small.buffer.length, small, 'discard');
    const smoke = process.env.LOCALDROP_DIAGNOSTICS_SMOKE === '1';
    const delayed = smoke ? null : await transfer(left, right, 100000000, large, 'opfs', 2);
    const reverse = await transfer(right, left, small.buffer.length, small, 'discard');
    const downloadEvent = left.waitForEvent('download');
    await left.getByRole('button', { name: 'Download diagnostic report' }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'localdrop-diagnostics.json');
    const raw = await readFile(await download.path(), 'utf8');
    const exported = JSON.parse(raw);
    assert.equal(exported.schemaVersion, 1);
    assert.ok(exported.events.some((entry) => entry.event === 'send-result' && entry.ok));
    assert.doesNotMatch(raw, /probe\.bin|large\.bin|ice-pwd|ice-ufrag|candidate:|sessionToken|resumeToken|127\.0\.0\.1|Mozilla\/5/);
    console.log(JSON.stringify({ topology, forward, delayed, reverse }));
    if (smoke) continue;

    const previous = (await reports(left, 'send-result')).length;
    const writes = (await reports(right, 'first-chunk-written')).length;
    await right.locator('#write-delay').fill('40');
    await right.locator('#arm').click();
    await left.locator('#file').setInputFiles(large);
    await left.locator('#send').click();
    await right.waitForFunction((count) => document.querySelector('#report').textContent
      .split('\n').filter((line) => JSON.parse(line).event === 'first-chunk-written').length > count, writes);
    await left.locator('#reset').click();
    const cancelled = await waitResult(left, 'send-result', previous);
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.reason, 'Cancelled locally');
    await connect(left, right, topology);
    await transfer(left, right, small.buffer.length, small, 'discard');
    if (topology === 'relay') {
      for (let sequence = 1; sequence < 4; sequence++) {
        await transfer(left, right, small.buffer.length, small, 'discard');
      }
      assert.equal(await left.locator('#send').isDisabled(), true);
      assert.equal(await right.locator('#arm').isDisabled(), true);
    }
  }
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  await rm(temp, { recursive: true, force: true });
}
