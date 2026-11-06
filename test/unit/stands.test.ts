// (round 128p, DA-A13) Where a builder stands to build a cell (build/stands.ts): beside each side that opens on ground —
// and beside a side a lane is drawn on, though a block stands beyond it: the lane between the two is ground (solid.ts
// leaves the inset open). The start town's cell 1188 (a house with houses on three sides, the wall on the fourth) had no
// stand and was never built (fortressallbuilt).
import { describe, expect, it } from 'vitest';
import { QuadGrid } from '../../src/build/quadgrid';
import { TownPlan } from '../../src/build/plan';
import { DEFS } from '../../src/fortress/defs';
import { standsOfCell } from '../../src/build/stands';
import { DOOR_STEP } from '../../src/build/edgenet';

function squares(n: number, S = 4): QuadGrid {
  const verts: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i * S, j * S);
  const quads: number[] = [];
  const v = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) quads.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
  return new QuadGrid(Math.ceil(n * S) + 2, Math.ceil((n * S) / 0.866) + 2, verts, quads);
}
const N = 7;
const cell = (i: number, j: number) => i + j * N;

describe('stands', () => {
  it('a cell shut in by other blocks: a stand on the lane drawn on one of its sides, none on the others', () => {
    const grid = squares(N);
    const plan = new TownPlan(grid, DEFS);
    const mid = cell(3, 3);
    plan.place('house', [[mid, 0]]);
    const ring = [0, 1, 2, 3].map((e) => grid.nbr[mid * 4 + e]);
    for (const n of ring) plan.place('warehouse', [[n, 0]]);
    const none = standsOfCell(plan, grid, () => false, mid);
    expect(none).toEqual([]);
    // (a lane drawn on its side 0)
    const sides = new Array(grid.count * 4).fill(0);
    sides[mid * 4 + 0] = 1;
    plan.layout.roads = { curves: [], verge: [], sides, centre: [0, 0], stores: [0, 0], water: [], deep: [], doors: [] };
    const st = standsOfCell(plan, grid, () => false, mid);
    expect(st.length).toBe(1);
    const [ax, ay] = grid.corner(mid, 0);
    const [bx, by] = grid.corner(mid, 1);
    expect(Math.hypot(st[0][0] - (ax + bx) / 2, st[0][1] - (ay + by) / 2)).toBeCloseTo(DOOR_STEP, 5);
  });
});
