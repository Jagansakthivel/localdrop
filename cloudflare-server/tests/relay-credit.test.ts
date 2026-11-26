import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTROL_RATE, MAX_RELAY_FRAME, consume, consumeRelayCredit, openLedger, chargeFrame, applyCredit, type Bucket,
} from '../src/network-v2/relayBudget.ts';

test('reproduces credit starvation at the configured client relay pace', () => {
  // The receiver credits every two full relay frames at a 256 KiB threshold.
  const interval = (2 * MAX_RELAY_FRAME * 1000) / (28 * 1024 * 1024);
  let bucket: Bucket | undefined;
  let creditBucket: Bucket | undefined;
  let dropped = 0;
  for (let i = 0; i < 400; i++) {
    const result = consume(bucket, 1, CONTROL_RATE, CONTROL_RATE, i * interval);
    bucket = result.state;
    if (!result.allowed) dropped++;
    const credit = consumeRelayCredit(creditBucket, i * interval);
    creditBucket = credit.state;
    assert.equal(credit.allowed, true);
  }
  assert.ok(dropped > 0);
});

test('relay credits remain rate limited and cannot acknowledge unwritten bytes', () => {
  let bucket: Bucket | undefined;
  for (let i = 0; i < 80; i++) {
    const result = consumeRelayCredit(bucket, 0);
    bucket = result.state;
    assert.equal(result.allowed, true);
  }
  assert.equal(consumeRelayCredit(bucket, 0).allowed, false);

  const frame = new ArrayBuffer(12);
  const header = new DataView(frame);
  header.setUint16(0, 7, true);
  header.setUint8(6, 2);
  const ledger = chargeFrame(openLedger(7, 4, 4), frame);
  const credit = new ArrayBuffer(5);
  const view = new DataView(credit);
  view.setUint8(0, 6);
  assert.throws(() => applyCredit(ledger, credit), /exceeds outstanding/);
  assert.throws(() => applyCredit(ledger, credit.slice(0, 4)), /Invalid credit frame/);
  view.setUint8(0, 255);
  assert.throws(() => applyCredit(ledger, credit), /Invalid credit frame/);
  view.setUint8(0, 6);
  view.setUint32(1, 5, true);
  assert.throws(() => applyCredit(ledger, credit), /exceeds outstanding/);
  view.setUint32(1, 4, true);
  assert.equal(applyCredit(ledger, credit).outstanding, 0);
});
