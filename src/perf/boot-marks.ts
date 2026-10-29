// (round 112, testspeed) The page's boot as a timeline: each stage's time since navigation start (ms), on
// `window.__boot` and as `performance.mark('boot:<stage>')`. Read-only instrumentation — nothing waits on it and
// nothing changes because of it; the test runner (scripts/lib/runner.mjs) reads it to say where a check's start
// went and to wait for "level-ready" instead of a fixed sleep.
//
//   stages, in order (atlas level): module, gpu, atlas, window, level, warmup-cpu, warmup, level-ready,
//   first-frame, store (the world store opened and its saved regions restored)

export interface BootMarks {
  /** [stage, ms since navigation start] in the order they came */
  marks: [string, number][];
  /** stage → ms since navigation start (the first time it came) */
  at: Record<string, number>;
}

/**
 * Notes that the page reached `stage` now. `subject` (the world, at 'warmup') goes to a test's hook when one is set
 * (`window.__bootHook(stage, subject)`, set before the page's scripts run): it may read, not change.
 */
export function bootMark(stage: string, subject?: unknown): void {
  const g = globalThis as { __boot?: BootMarks; __bootHook?: (stage: string, subject?: unknown) => void };
  const b = (g.__boot ??= { marks: [], at: {} });
  const t = performance.now();
  b.marks.push([stage, +t.toFixed(1)]);
  if (!(stage in b.at)) b.at[stage] = +t.toFixed(1);
  performance.mark?.(`boot:${stage}`);
  g.__bootHook?.(stage, subject);
}
