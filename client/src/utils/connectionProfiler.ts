/** One instance per pairing attempt, not per render. */
export function createConnectionProfiler() {
  const start = performance.now();
  const marks = new Map<string, number>();
  return {
    mark(stage: string) {
      if (!marks.has(stage)) marks.set(stage, performance.now());
    },
    report() {
      let previous = start;
      const rows = [...marks].map(([stage, time]) => {
        const row = {
          stage,
          elapsedMs: Math.round(time - start),
          deltaMs: Math.round(time - previous),
        };
        previous = time;
        return row;
      });
      if (import.meta.env.DEV) console.table(rows);
      return rows;
    },
  };
}
