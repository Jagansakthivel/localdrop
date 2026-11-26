import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Sha256 as Optimized } from '../src/network-v2/sha256.ts';

assert.ok(process.argv[2], 'Pass a path to the original sha256.ts');
const { Sha256: Original } = await import(pathToFileURL(resolve(process.argv[2])).href);
const bytes = 100_000_000;
const chunk = Uint8Array.from({ length: 262_136 }, (_, i) => ((i * 31) ^ (i >> 4)) & 255);
const native = createHash('sha256');

function feed(hash, size) {
  for (let offset = 0; offset < size; offset += chunk.length) {
    hash.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
  }
}

feed(native, bytes);
const expected = native.digest('hex');
for (const Hash of [Original, Optimized]) feed(new Hash(), 2 * chunk.length);

const times = { original: [], optimized: [] };
for (const variant of ['original', 'optimized', 'optimized', 'original', 'original', 'optimized']) {
  const Hash = variant === 'original' ? Original : Optimized;
  const start = performance.now();
  const hash = new Hash();
  feed(hash, bytes);
  assert.equal(hash.digest(), expected);
  times[variant].push(Math.round(performance.now() - start));
}
const middle = (trials) => [...trials].sort((a, b) => a - b)[1];
console.log(JSON.stringify({
  bytes,
  runtime: process.version,
  milliseconds: times,
  medianSpeedup: Number((middle(times.original) / middle(times.optimized)).toFixed(2)),
}));
