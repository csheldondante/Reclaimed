// (round 128d) What of the fortress is solid to the world (solid.ts; the user: "Does the flow field around the city
// path around structures?"): only what's built; a block's whole cell; a wall's thin band, not its cell; a gate's
// passage open under its lintel; on a slope a block's foot goes down to each column's own ground.
import { describe, expect, it } from 'vitest';
import { LEVEL_H, Town } from './town';
import { TownGrid } from './towngrid';
import { cellPos } from '../world/lattice';
import { TownPlan, typeIndex } from './plan';
import { solidSpans, WALL_HALF, WALL_LINTEL } from './solid';

const grid = new TownGrid(80, 92, { seed: 7 });
const nbr = (c: number, e: number) => grid.nbr[c * 4 + e];
const inner = (() => {
  for (let c = 0; c < grid.count; c++) {
    const ok = [0, 1, 2, 3].every((e) => nbr(c, e) >= 0 && [0, 1, 2, 3].every((f) => nbr(nbr(c, e), f) >= 0));
    const [x, y] = grid.centre(c);
    if (ok && x > 30 && y > 30) return c;
  }
  throw new Error('no inner cell');
})();
const GROUND = 5;

function setup(ground: (col: number) => number = () => GROUND) {
  const plan = new TownPlan(grid);
  const town = new Town(80, 92, { ground, stamp: null, zMax: Infinity }, { grid });
  const build = (c: number, L: number) => {
    const s = plan.structureAt(c)!;
    expect(town.plan(c, L, true, s.id, typeIndex(s.type))).toBe(true);
    expect(town.add(c, L, s.id, typeIndex(s.type))).toBe(true);
  };
  return { plan, town, build, spans: () => solidSpans({ plan, town, grid, ground }), floor: (c: number) => town.floorZ(c, 0) };
}

/** a span's column middle in the box's frame */
const at = (s: { x: number; y: number }) => cellPos(s.x, s.y);

describe('the fortress solid', () => {
  it('a planned block is no obstacle; a built one fills its cell from under the ground to under its top', () => {
    const { plan, build, spans, floor } = setup();
    plan.paint(inner, 0, 'house');
    plan.paint(inner, 1, 'house');
    expect(spans().size).toBe(0);
    build(inner, 0);
    const one = [...spans().values()][0];
    expect(new Set(one.map((s) => s.y * grid.w + s.x))).toEqual(new Set(grid.columns[inner]));
    for (const s of one) {
      expect(s.z0).toBeLessThan(GROUND);
      expect(s.z1).toBeCloseTo(floor(inner) + LEVEL_H - 1, 5);
    }
    build(inner, 1);
    for (const s of [...spans().values()][0]) expect(s.z1).toBeCloseTo(floor(inner) + 2 * LEVEL_H - 1, 5);
  });

  it('a wall is its thin band, not its cell; a gate is open under its lintel', () => {
    const { plan, build, spans, floor } = setup();
    const a = nbr(inner, 0);
    const b = nbr(inner, 2);
    for (const c of [a, inner, b]) plan.paint(c, 0, 'wall');
    for (const c of [a, inner, b]) build(c, 0);
    const inMiddle = (s: { x: number; y: number }) => grid.cellOf[s.y * grid.w + s.x] === inner;
    const solid = [...spans().values()][0].filter(inMiddle);
    // fewer columns than the cell's: the band (about 2.2 wide) through a cell ~5 across
    expect(solid.length).toBeGreaterThan(4);
    expect(solid.length).toBeLessThan(grid.columns[inner].length * 0.75);
    // each within the band's half width (and a column's) of the line from a's side through the middle to b's
    const [cx, cy] = grid.centre(inner);
    const mid = (e: number): [number, number] => {
      const p = grid.corner(inner, e);
      const q = grid.corner(inner, e + 1);
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    };
    const segDist = (p: [number, number], s: [number, number], e: [number, number]) => {
      const dx = e[0] - s[0];
      const dy = e[1] - s[1];
      const t = Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p[0] - s[0] - t * dx, p[1] - s[1] - t * dy);
    };
    for (const s of solid) {
      const p = at(s);
      const d = Math.min(segDist(p, [cx, cy], mid(0)), segDist(p, [cx, cy], mid(2)), Math.hypot(p[0] - cx, p[1] - cy));
      expect(d).toBeLessThan(WALL_HALF * Math.SQRT2 + 0.01);
      expect(s.z0).toBeLessThan(GROUND);
      expect(s.z1).toBeCloseTo(floor(inner) + LEVEL_H, 5);
    }
    // the gate: only the lintel over the passage
    expect(plan.setGate(inner, true)).toBe(true);
    // (round its middle: the neighbours' bands reach the shared sides, a column or so into its cell)
    const gate = [...spans().values()][0].filter((q) => inMiddle(q) && Math.hypot(at(q)[0] - cx, at(q)[1] - cy) < 1.5);
    expect(gate.length).toBeGreaterThan(0);
    for (const s of gate) {
      expect(s.z0).toBeCloseTo(floor(inner) + LEVEL_H - WALL_LINTEL, 5);
      expect(s.z1).toBeCloseTo(floor(inner) + LEVEL_H, 5);
    }
  });

  it('on a slope a block\'s foot goes down to each column\'s own ground (no gap to walk under)', () => {
    // the ground falls along x: the cell's floor (its highest column's) is above its lower columns
    const ground = (col: number) => GROUND + (col % grid.w) * 0.5;
    const { plan, build, spans } = setup(ground);
    plan.paint(inner, 0, 'house');
    build(inner, 0);
    for (const s of [...spans().values()][0]) expect(s.z0).toBeLessThan(ground(s.y * grid.w + s.x));
  });
});
