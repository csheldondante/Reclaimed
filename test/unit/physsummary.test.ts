// Round 120 (the user: "the bench does not generate an automated report", then "the tiled rendering on phones makes
// per system unreliable … You need to toggle systems to measure the diff"): the physics bench's card — per solver ×
// judge, frame p95/p99, what physics and the judge add to a frame by toggling them, the judge's ms a pass, slow-frame
// runs (src/perf/physsummary.ts).
import { expect, test } from 'vitest';
import { summarize, summaryLines, TIMESTAMP_NOTE, type PhysRow, type Toggle } from '../../src/perf/physsummary';

const tog = (frameMs: number | null, gpuMs: number | null): Toggle => ({ frameMs, gpuMs, on: { frameMs: 20, gpuMs: 10 }, off: { frameMs: 18, gpuMs: 8 }, windows: 3 });
const row = (pair: string, stage: string, o: Partial<PhysRow> = {}): PhysRow => ({
  pair,
  stage,
  frames: 600,
  fps: 60,
  p50: 10,
  p95: 11,
  p99: 12,
  worst: 20,
  gpu: 10,
  gpuPhysicsPasses: 42,
  physicsToggle: tog(2, 1),
  judgeToggle: tog(0.5, 0.2),
  cpuPhysics: 0.1,
  cpuTop: {},
  judge: { passes: 0, ms: 0, worst: 0, gpuMs: null, readKB: null },
  read: { reads: 0, ms: 0, worst: 0, kb: 0 },
  awake: 3,
  slow: 0,
  clusters: 0,
  longestRun: 0,
  ...o,
});

test('one line a solver × judge, in the order run: the worst stage p95/p99, physics and judge by toggling, slow-frame runs', () => {
  const rows = [
    row('nodes:runs', 'a', { p95: 11, p99: 13, physicsToggle: tog(4, 3), judge: { passes: 4, ms: 1, worst: 3, gpuMs: null, readKB: null }, slow: 2, clusters: 1, longestRun: 2 }),
    row('nodes:runs', 'b', { p95: 14, p99: 30, physicsToggle: tog(8, 5), judge: { passes: 1, ms: 6, worst: 6, gpuMs: null, readKB: null }, slow: 3, clusters: 2, longestRun: 1 }),
    row('hybrid:sections', 'a', { physicsToggle: tog(null, null) }),
  ];
  const s = summarize(rows);
  expect(s.map((x) => x.pair)).toEqual(['nodes:runs', 'hybrid:sections']);
  expect(s[0].p95).toBe(14);
  expect(s[0].p99).toBe(30);
  // (the toggled cost, the stages' mean; the per-pass timestamps' 42 nowhere in it)
  expect(s[0].physicsFrame).toBe(6);
  expect(s[0].physicsGpu).toBe(4);
  expect(s[0].judgeFrame).toBe(0.5);
  // (the judge's mean over all its passes: (4 × 1 + 1 × 6) / 5)
  expect(s[0].judgeMs).toBe(2);
  expect(s[0].judgeWorst).toBe(6);
  expect(s[0].slow).toBe(5);
  expect(s[0].slowRuns).toBe(3);
  expect(s[0].longestRun).toBe(2);
  expect(s[1].physicsFrame).toBeNull();
  expect(s[1].judgePasses).toBe(0);
  const lines = summaryLines(rows);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^nodes:runs: p95 14 \/ p99 30 ms · physics \+6 ms a frame \(GPU \+4\)/);
  expect(lines[0]).toMatch(/slow 5 in 3 runs/);
  expect(lines[1]).toMatch(/physics \+– ms/);
  expect(lines.join(' ')).not.toMatch(/42/);
  expect(TIMESTAMP_NOTE).toMatch(/unreliable on tiler/);
});
