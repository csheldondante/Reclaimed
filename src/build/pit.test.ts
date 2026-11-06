// (round 128m, quarry) The pit's rule (pit.ts): rings in from the footprint's edge, a ramp of `rampCells` along each
// ring down to the next, depth = the tiers whose ramps fit; its levels as negative runs.
import { describe, expect, it } from 'vitest';
import { CellRuns } from '../build/runs';
import { depthAt, layPit, pitOf, PIT_RAMP, PIT_SHELF, ringsOf, type PitGeo, type PitTopo } from './pit';

/** a W × H square grid: corners k0 (i, j), k1 (i+1, j), k2 (i+1, j+1), k3 (i, j+1); edge e from corner e to e + 1 */
function square(W: number, H: number): PitTopo & PitGeo & { at(i: number, j: number): number } {
  const nbr = new Int32Array(W * H * 4).fill(-1);
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < W && j < H ? j * W + i : -1);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const c = at(i, j);
      nbr[c * 4] = at(i, j - 1);
      nbr[c * 4 + 1] = at(i + 1, j);
      nbr[c * 4 + 2] = at(i, j + 1);
      nbr[c * 4 + 3] = at(i - 1, j);
    }
  const corner = (c: number, k: number): [number, number] => {
    const i = c % W;
    const j = Math.floor(c / W);
    const kk = ((k % 4) + 4) % 4;
    return [i + (kk === 1 || kk === 2 ? 1 : 0), j + (kk >= 2 ? 1 : 0)];
  };
  return { count: W * H, nbr, at, corner, centre: (c) => [(c % W) + 0.5, Math.floor(c / W) + 0.5] };
}

/** an n × n footprint at (x0, y0) */
function block(g: ReturnType<typeof square>, x0: number, y0: number, w: number, h = w): number[] {
  const out: number[] = [];
  for (let j = y0; j < y0 + h; j++) for (let i = x0; i < x0 + w; i++) out.push(g.at(i, j));
  return out;
}

describe('the pit: tiers and ramps', () => {
  it('rings count in from the footprint edge', () => {
    const g = square(12, 12);
    const r = ringsOf(g, block(g, 2, 2, 5));
    expect(r.get(g.at(2, 2))).toBe(0);
    expect(r.get(g.at(3, 3))).toBe(1);
    expect(r.get(g.at(4, 4))).toBe(2);
    expect(r.get(g.at(4, 2))).toBe(0);
  });

  it('a 3 × 3 footprint holds one tier: a ramp of two ring-0 cells down to the middle', () => {
    const g = square(10, 10);
    const pit = pitOf(g, block(g, 3, 3, 3));
    expect(pit.tiers).toBe(1);
    expect(pit.ramps).toHaveLength(1);
    const cells = pit.ramps[0].cells;
    expect(cells).toHaveLength(2);
    for (const rc of cells) expect(pit.ring.get(rc.cell)).toBe(0);
    // (its low end opens on the middle cell)
    expect(g.nbr[cells[1].cell * 4 + cells[1].outSide]).toBe(g.at(4, 4));
    // (the top is on the footprint's edge: its outer side faces out)
    expect(pit.top).toBe(cells[0].cell);
    const out = g.nbr[pit.top * 4 + pit.topSide];
    expect(out < 0 || !pit.ring.has(out)).toBe(true);
  });

  it('the depth is the tiers whose ramps fit: wider footprints go deeper', () => {
    const g = square(24, 24);
    const tiers = [3, 5, 7, 9, 11].map((n) => pitOf(g, block(g, 1, 1, n)).tiers);
    expect(tiers).toEqual([1, 2, 3, 4, 5]);
  });

  it('a footprint too narrow for a ramp has no pit', () => {
    const g = square(10, 10);
    expect(pitOf(g, block(g, 1, 1, 6, 2)).tiers).toBe(0);
    expect(pitOf(g, block(g, 1, 1, 6, 2)).top).toBe(-1);
    // (a longer ramp needs more of the ring: a 3 × 3 footprint's ring has 8 cells)
    expect(pitOf(g, block(g, 1, 1, 3), { rampCells: 8 }).tiers).toBe(1);
    expect(pitOf(g, block(g, 1, 1, 3), { rampCells: 9 }).tiers).toBe(0);
  });

  it('the cap: maxTiers', () => {
    const g = square(24, 24);
    expect(pitOf(g, block(g, 1, 1, 11), { maxTiers: 2 }).tiers).toBe(2);
  });

  it('the ramps make one road down: each starts where the last ends, its cells on the ring above its tier', () => {
    const g = square(24, 24);
    const pit = pitOf(g, block(g, 2, 2, 9));
    expect(pit.tiers).toBe(4);
    for (const r of pit.ramps) {
      for (const rc of r.cells) expect(pit.ring.get(rc.cell)).toBe(r.tier - 1);
      // (each cell's low end is the next one's high end, in cells and depth)
      for (let j = 0; j + 1 < r.cells.length; j++) {
        expect(g.nbr[r.cells[j].cell * 4 + r.cells[j].outSide]).toBe(r.cells[j + 1].cell);
        expect(r.cells[j].d1).toBeCloseTo(r.cells[j + 1].d0);
      }
      expect(r.cells[0].d0).toBe(r.tier - 1);
      expect(r.cells[r.cells.length - 1].d1).toBe(r.tier);
    }
    for (let i = 0; i + 1 < pit.ramps.length; i++) {
      const last = pit.ramps[i].cells[pit.ramps[i].cells.length - 1];
      expect(g.nbr[last.cell * 4 + last.outSide]).toBe(pit.ramps[i + 1].cells[0].cell);
    }
  });

  it('depthAt: shelves flat at their tier, a ramp sloping from its high side to its low side', () => {
    const g = square(24, 24);
    const pit = pitOf(g, block(g, 2, 2, 9));
    const [cx, cy] = g.centre(g.at(6, 6));
    expect(depthAt(pit, g, g.at(6, 6), cx, cy)).toBe(4);
    const rc = pit.ramps[1].cells[0];
    const mid = (e: number) => {
      const a = g.corner(rc.cell, e);
      const b = g.corner(rc.cell, e + 1);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    };
    const [ax, ay] = mid(rc.inSide);
    const [bx, by] = mid(rc.outSide);
    expect(depthAt(pit, g, rc.cell, ax, ay)).toBeCloseTo(rc.d0);
    expect(depthAt(pit, g, rc.cell, bx, by)).toBeCloseTo(rc.d1);
    // (a shelf cell beside the ramp, on the same ring: its tier, flat)
    const shelf = [...pit.ring].find(([c, d]) => d === 1 && !pit.ramps.some((r) => r.cells.some((x) => x.cell === c)))![0];
    const [sx, sy] = g.centre(shelf);
    expect(depthAt(pit, g, shelf, sx, sy)).toBe(1);
  });

  it('the start the caller prefers wins among the deepest', () => {
    const g = square(24, 24);
    const cells = block(g, 2, 2, 7);
    const far = g.at(8, 8);
    const pit = pitOf(g, cells, { prefer: (c) => Math.hypot((c % 24) - 8, Math.floor(c / 24) - 8) });
    expect(pit.tiers).toBe(3);
    expect(Math.hypot((pit.top % 24) - 8, Math.floor(pit.top / 24) - 8)).toBeLessThanOrEqual(1.5);
    void far;
  });
});

describe('the pit as negative runs', () => {
  it('each cell holds its ring’s levels under the ground; a ramp cell one more, a ramp run', () => {
    const g = square(24, 24);
    const pit = pitOf(g, block(g, 2, 2, 9));
    const runs = new CellRuns(g.count);
    layPit(runs, pit, 5);
    expect(runs.highest(g.at(6, 6))).toBe(-1);
    expect(runs.lowest(g.at(6, 6))).toBe(-4);
    expect(runs.levels(g.at(6, 6))).toBe(4);
    // (ring 0, not a ramp: nothing dug)
    const rim = [...pit.ring].find(([c, d]) => d === 0 && !pit.ramps[0].cells.some((x) => x.cell === c))![0];
    expect(runs.any(rim)).toBe(false);
    const rc = pit.ramps[2].cells[1].cell;
    expect(runs.lowest(rc)).toBe(-3);
    expect(runs.at(rc, -3)!.type).toBe(PIT_RAMP);
    expect(runs.at(rc, -2)!.type).toBe(PIT_SHELF);
    expect(runs.at(rc, -1)!.owner).toBe(5);
  });

  it('negative levels round-trip: set, merge, split, clear', () => {
    const r = new CellRuns(2);
    expect(r.set(0, -1, 1, 0)).toBe(true);
    expect(r.set(0, -3, 1, 0)).toBe(true);
    expect(r.set(0, -2, 1, 0)).toBe(true);
    expect(r.runsOf(0).map((x) => [x.lo, x.hi])).toEqual([[-3, 0]]);
    expect([...r.each(0)]).toEqual([-3, -2, -1]);
    expect(r.has(0, 0)).toBe(false);
    expect(r.clear(0, -2)).toBe(true);
    expect(r.runsOf(0).map((x) => [x.lo, x.hi])).toEqual([[-3, -2], [-1, 0]]);
    // (a pit's levels and a block's beside them in one cell: apart at the ground)
    r.set(0, 0, 2, 3);
    expect(r.highest(0)).toBe(0);
    expect(r.lowest(0)).toBe(-3);
    r.clear(0, -3);
    r.clear(0, -1);
    r.clear(0, 0);
    expect(r.any(0)).toBe(false);
    expect(r.highest(0)).toBe(null);
  });
});
