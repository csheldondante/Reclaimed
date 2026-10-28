// The main thread's longest steps (round 80, the hitches): each named step's last and worst ms, the perf
// overlay shows the worst few. A phone's CPU is several times a desktop's: what's 10 ms here is a hitch there.

export interface CpuStat {
  last: number;
  max: number;
  n: number;
  /** (round 98) the sum, for a mean */
  sum: number;
}

export const cpuStats = new Map<string, CpuStat>();
/** the steps run since the frame began (the level keeps them for a long frame) */
export const frameSteps: string[] = [];

/**
 * (round 100, hitchrec) every step of half a millisecond or more since the hitch recorder last took them (src/perf/hitch.ts):
 * labels and ms in two arrays, reused (nothing allocated a step); `on` only while it records
 */
export const spans = { on: false, label: [] as string[], ms: [] as number[] };

function span(label: string, ms: number): void {
  if (!spans.on || ms < 0.5 || spans.ms.length >= 512) return;
  spans.label.push(label);
  spans.ms.push(ms);
}

/** a step's ms, measured by its caller */
export function record(label: string, ms: number): void {
  span(label, ms);
  if (ms >= 1) frameSteps.push(`${label} ${ms.toFixed(0)}`);
  const s = cpuStats.get(label) ?? { last: 0, max: 0, n: 0, sum: 0 };
  s.last = ms;
  s.max = Math.max(s.max, ms);
  s.n++;
  s.sum += ms;
  cpuStats.set(label, s);
}

/** f run and timed under `label` */
export function timed<T>(label: string, f: () => T): T {
  const t0 = performance.now();
  try {
    return f();
  } finally {
    const ms = performance.now() - t0;
    span(label, ms);
    if (ms >= 1) frameSteps.push(`${label} ${ms.toFixed(0)}`);
    const s = cpuStats.get(label) ?? { last: 0, max: 0, n: 0, sum: 0 };
    s.last = ms;
    s.max = Math.max(s.max, ms);
    s.n++;
    s.sum += ms;
    cpuStats.set(label, s);
  }
}

/** the worst steps, as one line */
export function cpuLine(k = 5): string {
  const e = [...cpuStats.entries()].sort((a, b) => b[1].max - a[1].max).slice(0, k);
  return e.map(([n, s]) => `${n} ${s.max.toFixed(0)}`).join('  ');
}
