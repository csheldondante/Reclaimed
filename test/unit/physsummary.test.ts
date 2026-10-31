// Round 120 (the user: "the bench does not generate an automated report"): the physics bench's card — per solver ×
// judge, frame p95/p99, physics ms, judge ms, slow-frame runs (src/perf/physsummary.ts).
import { expect, test } from 'vitest';
import { summarize, summaryLines, type PhysRow } from '../../src/perf/physsummary';

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
  gpuPhysics: 2,
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

test('one line a solver × judge, in the order run: the worst stage p95/p99, physics, judge, slow-frame runs', () => {
  const rows = [
    row('nodes:runs', 'a', { p95: 11, p99: 13, gpuPhysics: 2, judge: { passes: 4, ms: 1, worst: 3, gpuMs: null, readKB: null }, slow: 2, clusters: 1, longestRun: 2 }),
    row('nodes:runs', 'b', { p95: 14, p99: 30, gpuPhysics: 4, judge: { passes: 1, ms: 6, worst: 6, gpuMs: null, readKB: null }, slow: 3, clusters: 2, longestRun: 1 }),
    row('hybrid:sections', 'a', { gpuPhysics: null }),
  ];
  const s = summarize(rows);
  expect(s.map((x) => x.pair)).toEqual(['nodes:runs', 'hybrid:sections']);
  expect(s[0].p95).toBe(14);
  expect(s[0].p99).toBe(30);
  expect(s[0].physicsGpu).toBe(3);
  // (the judge's mean over all its passes: (4 × 1 + 1 × 6) / 5)
  expect(s[0].judgeMs).toBe(2);
  expect(s[0].judgeWorst).toBe(6);
  expect(s[0].slow).toBe(5);
  expect(s[0].slowRuns).toBe(3);
  expect(s[0].longestRun).toBe(2);
  expect(s[1].physicsGpu).toBeNull();
  expect(s[1].judgePasses).toBe(0);
  const lines = summaryLines(rows);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^nodes:runs: p95 14 \/ p99 30 ms/);
  expect(lines[0]).toMatch(/slow 5 in 3 runs/);
  expect(lines[1]).toMatch(/physics – GPU/);
});
