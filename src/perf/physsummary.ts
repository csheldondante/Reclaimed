// The physics phone bench's rows and its readable summary (round 120; src/perf/physbench.ts). Pure: no page, no GPU
// (test/unit/physsummary.test.ts).

export interface PhysRow {
  /** solver:judge */
  pair: string;
  stage: string;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  gpu: number | null;
  /**
   * the physics passes' GPU ms a frame by per-pass timestamps — unreliable on a tiler GPU (passes overlap, sums read
   * past the frame): kept for the record only; the cost is physicsToggle's
   */
  gpuPhysicsPasses: number | null;
  /** the physics (the solvers, the rigid rock's step) off and on in turn: the frame's interval and GPU time it adds */
  physicsToggle: Toggle;
  /** the judge off and on in turn */
  judgeToggle: Toggle;
  /** the main thread's physics steps, ms a frame */
  cpuPhysics: number;
  /** the main thread's steps over the stage, ms a frame, the five biggest */
  cpuTop: Record<string, number>;
  /** the collapse judge: passes, mean and worst ms (A its CPU, B submit to verdict), B's GPU ms and KB read */
  judge: { passes: number; ms: number; worst: number; gpuMs: number | null; readKB: number | null };
  /** the columns' readback for the judge: reads, mean and worst latency, KB a read */
  read: { reads: number; ms: number; worst: number; kb: number };
  awake: number;
  /** frames past twice the median and a 30 fps frame; how many runs of them; the longest */
  slow: number;
  clusters: number;
  longestRun: number;
}

/** a system off and on in turn (physbench.ts toggled): what it adds to the frame's interval and GPU time (ms) */
export interface Toggle {
  frameMs: number | null;
  gpuMs: number | null;
  on: { frameMs: number; gpuMs: number | null };
  off: { frameMs: number; gpuMs: number | null };
  windows: number;
}

/** the card's and the report's word on what the numbers are */
export const TIMESTAMP_NOTE =
  'Physics and judge costs are measured by toggling each off and on (the frame with it, less without it). Per-pass GPU timestamps are kept in the JSON only (gpuPhysicsPasses): unreliable on tiler GPUs (phones), where passes overlap.';

export interface PairSummary {
  pair: string;
  /** the worst stage's p95 and p99 (ms) */
  p95: number;
  p99: number;
  /** what physics adds to a frame (ms), toggled: its interval and its GPU time, the stages' mean */
  physicsFrame: number | null;
  physicsGpu: number | null;
  /** what the judge adds, toggled */
  judgeFrame: number | null;
  judgeGpu: number | null;
  physicsCpu: number;
  /** the judge's mean ms a pass over all its passes, and its worst */
  judgeMs: number;
  judgeWorst: number;
  judgePasses: number;
  /** slow frames and the runs they came in */
  slow: number;
  slowRuns: number;
  longestRun: number;
}

/** per solver × judge, over its stages (in the order first seen) */
export function summarize(rows: readonly PhysRow[]): PairSummary[] {
  const pairs: string[] = [];
  for (const r of rows) if (!pairs.includes(r.pair)) pairs.push(r.pair);
  return pairs.map((pair) => {
    const rs = rows.filter((r) => r.pair === pair);
    const avg = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x !== null);
      return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
    };
    const passes = rs.reduce((a, r) => a + r.judge.passes, 0);
    return {
      pair,
      p95: Math.max(...rs.map((r) => r.p95)),
      p99: Math.max(...rs.map((r) => r.p99)),
      physicsFrame: avg(rs.map((r) => r.physicsToggle.frameMs)),
      physicsGpu: avg(rs.map((r) => r.physicsToggle.gpuMs)),
      judgeFrame: avg(rs.map((r) => r.judgeToggle.frameMs)),
      judgeGpu: avg(rs.map((r) => r.judgeToggle.gpuMs)),
      physicsCpu: +(rs.reduce((a, r) => a + r.cpuPhysics, 0) / rs.length).toFixed(2),
      judgeMs: passes ? +(rs.reduce((a, r) => a + r.judge.ms * r.judge.passes, 0) / passes).toFixed(2) : 0,
      judgeWorst: Math.max(0, ...rs.map((r) => r.judge.worst)),
      judgePasses: passes,
      slow: rs.reduce((a, r) => a + r.slow, 0),
      slowRuns: rs.reduce((a, r) => a + r.clusters, 0),
      longestRun: Math.max(0, ...rs.map((r) => r.longestRun)),
    };
  });
}

/** the card's lines: one a solver × judge */
export function summaryLines(rows: readonly PhysRow[]): string[] {
  return summarize(rows).map(
    (s) =>
      `${s.pair}: p95 ${s.p95} / p99 ${s.p99} ms · physics +${s.physicsFrame ?? '–'} ms a frame (GPU +${s.physicsGpu ?? '–'}) · judge +${s.judgeFrame ?? '–'} ms a frame (GPU +${s.judgeGpu ?? '–'}; ${s.judgeMs} ms a pass, worst ${s.judgeWorst}, ${s.judgePasses}×) · slow ${s.slow} in ${s.slowRuns} runs (longest ${s.longestRun})`,
  );
}
