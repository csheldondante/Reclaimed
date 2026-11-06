// The paths on the grid's edges and reach by construction (round 128p, DA-A13 step 1: build/edgenet.ts, edgeview.ts).
// The four things that cut an edge, each failing on its own; a house shut in by its neighbours reached through them
// (a structure is one node); the insets.
import { describe, expect, it } from 'vitest';
import { QuadGrid } from '../../src/build/quadgrid';
import { TownPlan } from '../../src/build/plan';
import { DEFS } from '../../src/fortress/defs';
import { edgeNetOf, PATH_LANE, type EdgeNetIO } from '../../src/build/edgenet';
import { insetTiles } from '../../src/build/edgeview';

/** an n × n grid of S m squares from (0, 0) (cell i + j n) */
function squares(n: number, S = 4): QuadGrid {
  const verts: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i * S, j * S);
  const quads: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) quads.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return new QuadGrid(Math.ceil(n * S) + 2, Math.ceil((n * S) / 0.866) + 2, verts, quads);
}

const N = 9;
const cell = (i: number, j: number) => i + j * N;

function net(plan: TownPlan, grid: QuadGrid, o: Partial<EdgeNetIO> & { floor?: (c: number) => number } = {}) {
  return edgeNetOf(
    { plan, grid, floor: o.floor ?? (() => 0) },
    { ground: o.ground ?? (() => 0), wet: o.wet ?? (() => false), centre: [2, 2], stores: [1, 1], ...o },
  );
}

describe('reach by construction', () => {
  it('a house shut in on every side by other houses is reached through them (a structure is one node)', () => {
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    for (let j = 3; j <= 5; j++) for (let i = 3; i <= 5; i++) plan.place('house', [[cell(i, j), 0]]);
    const n = net(plan, grid);
    expect(n.reach.out).toEqual([]);
    expect(n.reach.reached).toBe(9);
  });

  it('a building of several cells: its own edges are inside it, not paths', () => {
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    plan.place('house', [
      [cell(3, 3), 0],
      [cell(4, 3), 0],
    ]);
    const n = net(plan, grid);
    const shared = n.edgeOf[cell(3, 3) * 4 + 1];
    expect(n.inner[shared]).toBe(1);
    expect(n.reach.out).toEqual([]);
  });

  it('a wall ring with no gate cuts; its gate joins', () => {
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    const ring: [number, number][] = [];
    for (let i = 3; i <= 7; i++) ring.push([cell(i, 3), 0], [cell(i, 7), 0]);
    for (let j = 4; j <= 6; j++) ring.push([cell(3, j), 0], [cell(7, j), 0]);
    plan.place('wall', ring);
    plan.place('house', [[cell(5, 5), 0]]);
    const shut = net(plan, grid);
    expect(shut.reach.out.map((o) => o.why)).toEqual(['wall']);
    expect(plan.setGate(cell(5, 3), true)).toBe(true);
    expect(net(plan, grid).reach.out).toEqual([]);
  });

  it('water cuts (a bridge, later); a cliff cuts; a door far above its edges is a terrace', () => {
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    plan.place('house', [[cell(7, 7), 0]]);
    expect(net(plan, grid, { wet: (x) => x > 18 && x < 22 }).reach.out.map((o) => o.why)).toEqual(['water']);
    expect(net(plan, grid, { ground: (x) => (x > 20 ? 40 : 0), floor: () => 40 }).reach.out.map((o) => o.why)).toEqual(['cliff']);
    const t = net(plan, grid, { floor: (c) => (c === cell(7, 7) ? 5 : 0) });
    expect(t.reach.out.map((o) => o.why)).toEqual(['terrace']);
    expect(t.reach.noDoorAtGrade).toBe(1);
  });

  it('every structure gets a lane from its door to the network', () => {
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    const h = plan.place('house', [[cell(6, 6), 0]])!;
    const n = net(plan, grid);
    expect(n.door.has(h.id)).toBe(true);
    expect(n.kind[n.door.get(h.id)!]).toBeGreaterThanOrEqual(PATH_LANE);
  });
});

describe('insets', () => {
  it("a building stands back from a lane on its edge by the lane's inset; a corner no path touches stays", () => {
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    const h = plan.place('house', [[cell(6, 6), 0]])!;
    const n = net(plan, grid);
    const t = insetTiles(grid, plan, n);
    const c = cell(6, 6);
    const moved = [0, 1, 2, 3].filter((k) => t.quads[c * 4 + k] !== grid.quads[c * 4 + k]);
    expect(moved.length).toBeGreaterThan(0);
    // the door's edge: both its corners a metre in from it
    const d = n.door.get(h.id)!;
    const side = [0, 1, 2, 3].find((s) => n.edgeOf[c * 4 + s] === d)!;
    const [a0, a1] = [grid.quads[c * 4 + side], grid.quads[c * 4 + ((side + 1) & 3)]];
    const pa = [grid.verts[a0 * 2], grid.verts[a0 * 2 + 1]];
    const pb = [grid.verts[a1 * 2], grid.verts[a1 * 2 + 1]];
    const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    for (const k of [side, (side + 1) & 3]) {
      const v = t.quads[c * 4 + k];
      const q = [t.verts[v * 2], t.verts[v * 2 + 1]];
      const dist = Math.abs((pb[0] - pa[0]) * (q[1] - pa[1]) - (pb[1] - pa[1]) * (q[0] - pa[0])) / L;
      expect(dist).toBeCloseTo(1, 5);
    }
  });
});
