// (DA-A10) A road's grade: the slope kept, cut and fill balanced, the too-steep stretches declared.
import { describe, expect, it } from 'vitest';
import { gradeLane, gradeProfile } from './grade';

const steps = (v: readonly number[]) => v.slice(1).map((x, i) => Math.abs(x - v[i]));

describe("a road's grade", () => {
  it('keeps every step within the slope and leaves gentle ground as it is', () => {
    const flat = [0, 0.1, 0.2, 0.2, 0.3];
    expect(gradeProfile(flat, 0.5)).toEqual(flat);
    const g = [0, 0, 0, 2, 2, 2];
    const r = gradeProfile(g, 0.5);
    expect(Math.max(...steps(r))).toBeLessThanOrEqual(0.5 + 1e-9);
    // (a terrace's edge: cut above it and filled below, about as much of each)
    const cut = g.reduce((a, v, i) => a + Math.max(0, v - r[i]), 0);
    const fill = g.reduce((a, v, i) => a + Math.max(0, r[i] - v), 0);
    expect(Math.abs(cut - fill)).toBeLessThan(0.3);
  });

  it('grades a lane over a 2 m terrace edge into a ramp of the slope asked', () => {
    const ground = (x: number) => (x < 10 ? 5 : 7);
    const lane = gradeLane([0, 0], [20, 0], ground, { maxGrade: 1 / 3, maxCut: 2, steep: 'stairs' });
    expect(lane.steep).toEqual([]);
    expect(Math.max(...steps(lane.road))).toBeLessThanOrEqual(1 / 3 + 1e-9);
    expect(lane.cut).toBeGreaterThan(0);
    expect(lane.fill).toBeGreaterThan(0);
  });

  it('declares a cliff past the deepest cut steep (stairs or a switchback, as asked), its ground kept', () => {
    const ground = (x: number) => (x < 10 ? 0 : 12);
    for (const steep of ['stairs', 'switchback'] as const) {
      const lane = gradeLane([0, 0], [20, 0], ground, { maxGrade: 1 / 3, maxCut: 1.5, steep });
      expect(lane.steep.length).toBe(1);
      expect(lane.steep[0].kind).toBe(steep);
      expect(lane.steep[0].rise).toBeCloseTo(12, 0);
      for (let i = lane.steep[0].from + 1; i < lane.steep[0].to; i++) expect(lane.road[i]).toBe(lane.ground[i]);
    }
  });
});
