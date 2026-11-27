export type TransferPhase = 'transferring' | 'waiting' | 'verifying' | 'complete';
export interface Sample {
  bytes: number;
  total: number;
  speedBps: number;
  etaSeconds: number;
  progress: number;
  bufferWaitRatio: number;
  elapsedMs: number;
  phase: TransferPhase;
}

export function createSampler(total: number, emit: (sample: Sample) => void, clock = () => performance.now()) {
  const start = clock();
  const points = [{ at: start, bytes: 0 }];
  let lastProgress = start;
  let bytes = 0;
  let wait = 0;
  let stopped = false;

  function flush(complete = false) {
    const now = clock();
    points.push({ at: now, bytes });
    while (points.length > 2 && points[1].at <= now - 3000) points.shift();
    const oldest = points[0];
    const elapsed = now - oldest.at;
    const phase: TransferPhase = complete ? 'complete' : bytes >= total ? 'verifying'
      : now - lastProgress >= 2000 ? 'waiting' : 'transferring';
    const speedBps = phase === 'waiting' || elapsed < 500 ? 0 : (bytes - oldest.bytes) * 1000 / elapsed;
    emit({
      bytes, total, speedBps, phase,
      etaSeconds: complete ? 0 : speedBps > 0 ? Math.ceil(Math.max(0, total - bytes) / speedBps) : Infinity,
      progress: complete ? 100 : Math.min(99, total ? Math.floor(100 * bytes / total) : 0),
      bufferWaitRatio: Math.min(1, wait / Math.max(1, now - start)),
      elapsedMs: now - start,
    });
  }
  const timer = setInterval(flush, 150);
  return {
    record(delta: number, waitMs = 0) {
      if (stopped) return;
      bytes += delta;
      wait += waitMs;
      if (delta > 0) lastProgress = clock();
    },
    stop(complete = false) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      flush(complete);
    },
  };
}
