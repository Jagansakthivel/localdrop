/** One queue per negotiation generation. Only SDP/ICE messages enter this queue. */
export function createSerialSignals(onError: (error: unknown) => void, maxPending = 128) {
  let tail: Promise<void> = Promise.resolve();
  let epoch = 0;
  let pending = 0;
  return {
    enqueue(work: (stillCurrent: () => boolean) => Promise<void>): boolean {
      if (pending >= maxPending) { onError(new Error('Signaling queue full')); return false; }
      const generation = epoch;
      pending++;
      const current = () => generation === epoch;
      tail = tail.then(async () => {
        if (current()) await work(current);
      }).catch((error: unknown) => { if (current()) onError(error); }).finally(() => { pending--; });
      return true;
    },
    // Running WebRTC operations cannot be cancelled. Guard after every await and close old PC.
    reset() { epoch++; },
    async drain() { await tail; },
  };
}
