// (diagnostic) build/edgecuts.ts: the edge net's cuts by reason, a cliff's rise against SLOPE, terraces from the doors.
import { describe, expect, it } from 'vitest';
import { QuadGrid } from '../../src/build/quadgrid';
import { TownPlan } from '../../src/build/plan';
import { DEFS } from '../../src/fortress/defs';
import { edgeNetOf } from '../../src/build/edgenet';
import { edgeCutsOf, summariseEdgeCuts, SHOW_CLIFF, SHOW_TERRACE } from '../../src/build/edgecuts';
import { SLOPE } from '../../src/build/ways';

function squares(n: number, S = 4): QuadGrid {
  const verts: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i * S, j * S);
  const quads: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) quads.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return new QuadGrid(Math.ceil(n * S) + 2, Math.ceil((n * S) / 0.866) + 2, verts, quads);
}

describe('edge cuts summary', () => {
  it('a step 5 % over SLOPE across x = 16..20 (each of the N + 1 rows of vertices) is a cliff within 10 %; one 40 % over within 50 %', () => {
    const N = 9;
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    // a step at x = 20 (vertices at x ≤ 16 low, ≥ 20 high, rising over the 4 m edges from 16 to 20)
    const step = (y: number) => (y < 18 ? SLOPE * 4 * 1.05 : SLOPE * 4 * 1.4);
    const ground = (x: number, y: number) => (x >= 19 ? step(y) : 0);
    const net = edgeNetOf({ plan, grid, floor: () => 0 }, { ground, wet: () => false, centre: [2, 2], stores: [1, 1] });
    const cuts = edgeCutsOf(net, grid, plan, ground, 3);
    const s = summariseEdgeCuts(net, cuts, 3);
    expect(s.cut.cliff).toBe(N + 1);
    expect(cuts.show.filter((k) => k === SHOW_CLIFF).length).toBe(N + 1);
    expect(s.cliffOver.within10 + s.cliffOver.within50).toBe(N + 1);
    expect(s.cliffOver.within10).toBeGreaterThan(0);
    expect(s.cliffOver.within50).toBeGreaterThan(0);
    expect(s.cliffOver.within25 + s.cliffOver.beyond50).toBe(0);
  });

  it("a block whose floor stands off the ground has its sides as terraces (no door at grade), counted near it", () => {
    const grid = squares(9);
    const plan = new TownPlan(grid, DEFS);
    const c = 4 + 4 * 9;
    plan.place('house', [[c, 0]]);
    const ground = () => 0;
    const net = edgeNetOf({ plan, grid, floor: (k) => (k === c ? 3 : 0) }, { ground, wet: () => false, centre: [2, 2], stores: [1, 1] });
    const cuts = edgeCutsOf(net, grid, plan, ground, 1);
    const s = summariseEdgeCuts(net, cuts, 1);
    expect(s.cut.terrace).toBe(4);
    expect([0, 1, 2, 3].every((k) => cuts.show[net.edgeOf[c * 4 + k]] === SHOW_TERRACE)).toBe(true);
    expect(s.nearCut).toBe(4);
  });
});
