// (round 128m, townlab) The placement bench's points and its report's summary (src/perf/placebench/).
import { describe, expect, it } from 'vitest';
import { placePoints, RING_DISTS } from '../../src/perf/placebench/points';
import { placeSummary, reasonOf } from '../../src/perf/placebench/summary';
import type { PlaceBenchResult, PlaceRow } from '../../src/perf/placebench/run';
import { reachWhyLine, refusedLine } from '../../src/fortress/words';

describe('the placement bench', () => {
  // a river running north-south 20-26 m east of the stores at (100, 100); a hill 60 m west; a town of four gates round it
  const world = {
    stores: [100, 100] as [number, number],
    gates: [
      [120, 100],
      [80, 100],
      [100, 120],
      [100, 80],
    ] as [number, number][],
    inBox: (x: number, y: number) => x > 0 && y > 0 && x < 240 && y < 240,
    wet: (x: number) => x >= 120 && x < 126,
    ground: (x: number, y: number) => 10 + 12 * Math.max(0, 1 - Math.hypot(x - 40, y - 100) / 20),
  };

  it('places points inside the walls, round the stores, across the water and on the hill', () => {
    const pts = placePoints(world);
    expect(pts.filter((p) => p.group === 'inside')).toHaveLength(4);
    expect(pts.filter((p) => p.group === 'ring')).toHaveLength(8 * RING_DISTS.length);
    const across = pts.filter((p) => p.group === 'river');
    expect(across.length).toBeGreaterThanOrEqual(1);
    // (past the water, on dry ground)
    for (const a of across) {
      expect(a.at[0]).toBeGreaterThanOrEqual(126);
      expect(world.wet(a.at[0])).toBe(false);
    }
    const hill = pts.find((p) => p.group === 'hill')!;
    expect(Math.hypot(hill.at[0] - 40, hill.at[1] - 100)).toBeLessThan(6);
    // (inside: half the wall's radius from the gates' middle)
    for (const p of pts.filter((q) => q.group === 'inside')) expect(Math.hypot(p.at[0] - 100, p.at[1] - 100)).toBeCloseTo(10, 5);
  });

  it('finds no hill on flat land and none inside the walls', () => {
    const pts = placePoints({ ...world, ground: (x, y) => (Math.hypot(x - 100, y - 100) < 15 ? 30 : 10) });
    expect(pts.some((p) => p.group === 'hill')).toBe(false);
  });

  it("sums a run up in plain lines: each point's kept count and the main reason, the timings, the arrivals", () => {
    const row = (point: string, outcome: PlaceRow['outcome'], line: string | null, answerMs: number | null = 40): PlaceRow => ({ point, group: 'ring', type: 'house', at: [0, 0], outcome, line, tapMs: 1, answerMs, frames: null, over33: 0 });
    const r: PlaceBenchResult = {
      points: [
        { name: 'E 30 m', group: 'ring', at: [0, 0] },
        { name: 'SE 60 m', group: 'ring', at: [0, 0] },
        { name: 'E 120 m', group: 'ring', at: [0, 0] },
      ],
      stores: [0, 0],
      rows: [row('E 30 m', 'kept', null), row('SE 60 m', 'refused', reachWhyLine('deep')), row('SE 60 m', 'refused', refusedLine(1, 1, 'deep')), row('E 120 m', 'unplaced', "outside the fortress's land", null)],
      arrive: [
        { point: 'E 30 m', arrivedS: 20, builtS: 40, nearestM: 2 },
        { point: 'W 60 m', arrivedS: null, builtS: null, nearestM: 30 },
      ],
      arriveLimitS: 240,
    };
    const lines = placeSummary(r);
    expect(lines[0]).toBe('4 placements at 3 points: 1 kept, 2 refused, 1 not placed, 0 with no answer.');
    expect(lines).toContain('Every type was kept at: E 30 m.');
    expect(lines).toContain('SE 60 m: 0 of 2 kept. Refused: Deep water is in the way.');
    expect(lines).toContain("E 120 m: 0 of 1 kept. Not placed: outside the fortress's land.");
    expect(lines).toContain('Builders reached 1 of 2 house sites within 240 sim seconds. 1 had a block standing.');
    expect(lines).toContain('Not reached: W 60 m (nearest 30 m).');
    expect(reasonOf(reachWhyLine('cliff'))).toBe('A cliff or a building is in the way.');
  });
});
