import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Sha256 } from '../src/network-v2/sha256.ts';

test('incremental SHA-256 matches native crypto across block and padding boundaries', () => {
  const bytes = Uint8Array.from({ length: 16385 }, (_, index) => (index * 31 + (index >> 3)) & 255);
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, bytes.length]) {
    const input = bytes.subarray(0, length);
    const expected = createHash('sha256').update(input).digest('hex');
    for (const step of [1, 17, 64, 129, input.length || 1]) {
      const hash = new Sha256();
      for (let offset = 0; offset < input.length; offset += step) {
        hash.update(input.subarray(offset, offset + step));
      }
      assert.equal(hash.digest(), expected, `length ${length}, update size ${step}`);
    }
  }
});
