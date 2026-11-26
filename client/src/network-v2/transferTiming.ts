export type Measure = (stage: string, ms: number) => void;

export function transferTiming() {
  const stages = new Map<string, { count: number; ms: number; maxMs: number }>();
  const measure: Measure = (stage, ms) => {
    const entry = stages.get(stage) ?? { count: 0, ms: 0, maxMs: 0 };
    entry.count++;
    entry.ms += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
    stages.set(stage, entry);
  };
  return {
    measure,
    snapshot: () => Object.fromEntries(Array.from(stages, ([stage, value]) => [
      stage, { count: value.count, ms: Math.round(value.ms), maxMs: Math.round(value.maxMs) },
    ])),
  };
}
