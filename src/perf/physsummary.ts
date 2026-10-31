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
  /** the physics passes' GPU ms a frame (solver, voxel lattice, body meshes, rock mesh) */
  gpuPhysics: number | null;
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

export interface PairSummary {
  pair: string;
  /** the worst stage's p95 and p99 (ms) */
  p95: number;
  p99: number;
  /** physics a frame (ms): GPU passes and main-thread steps, the stages' mean */
  physicsGpu: number | null;
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
    const gp = rs.filter((r) => r.gpuPhysics !== null);
    const passes = rs.reduce((a, r) => a + r.judge.passes, 0);
    return {
      pair,
      p95: Math.max(...rs.map((r) => r.p95)),
      p99: Math.max(...rs.map((r) => r.p99)),
      physicsGpu: gp.length ? +(gp.reduce((a, r) => a + (r.gpuPhysics ?? 0), 0) / gp.length).toFixed(2) : null,
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
      `${s.pair}: p95 ${s.p95} / p99 ${s.p99} ms · physics ${s.physicsGpu ?? '–'} GPU + ${s.physicsCpu} CPU ms · judge ${s.judgeMs} ms (worst ${s.judgeWorst}, ${s.judgePasses}×) · slow ${s.slow} in ${s.slowRuns} runs (longest ${s.longestRun})`,
  );
}
