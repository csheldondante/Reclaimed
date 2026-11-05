// (round 128k) The fortress's roads (lanes.ts): on the grid's cell borders, grown from the town's gate to every door;
// no road round an empty plot; a wall crossed only through a gate's tile; thoroughfare tiles paved whole; the ride graph
// from the same pieces; none under water; drawn as paving by the buildings, earth in the open, steps on steep climbs.
import { describe, expect, it } from 'vitest';
import { library } from '../structures/modules';
import { Fortress } from './fortress';
import { LANE_DRAWN, laneGraph, type LaneSeg } from './lanes';
import { roadBitsCpu } from '../agents/roads';
import { nearestNode, nodeCount, reached } from '../agents/roadgraph';
import { cellPos } from '../world/lattice';
import { fortressPieces } from './pieces';
import { WAY_SQUARE } from './ways';
import { CpuReach, type ReachColumns } from './reach';

const W = 160;
const H = 184;
/** the town's gate: west of the box's middle (window = box frame here) */
const GATE: [number, number] = [14, ((H / 2) * Math.sqrt(3)) / 2];

function fortress(ground: (x: number, y: number) => number = () => 5, columns?: ReachColumns) {
  const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground,
    stores: () => ({}),
    changed: () => {},
    townGates: () => [GATE],
    reach: columns ? new CpuReach(columns, W, H, () => [0, 0]) : undefined,
  });
  f.ready = true;
  return f;
}

/** a walled ring round the box's middle, a gate, the keep, a house and a warehouse inside, a farm and a lumber camp out */
function walled(f: Fortress, r = 22) {
  const [cx, cy] = [W / 2, ((H / 2) * Math.sqrt(3)) / 2];
  const ring = f.ringCells(cx, cy, r);
  for (const c of ring) f.paint(c, 0, 'wall');
  const byX = [...ring].sort((a, b) => f.centre(b)[0] - f.centre(a)[0]);
  const gate = byX.find((c) => f.setGate(c, true))!;
  const keep = f.cellAt(cx, cy);
  f.paint(keep, 0, 'fortress');
  const house = f.cellAt(cx - 10, cy + 6);
  f.paint(house, 0, 'house');
  const store = f.cellAt(cx + 4, cy - 12);
  f.paint(store, 0, 'warehouse');
  const farm = f.cellAt(cx + r + 14, cy);
  f.paint(farm, 0, 'farm');
  const lumber = f.cellAt(cx + 6, cy + r + 20);
  f.paint(lumber, 0, 'lumber');
  return { ring, gate, keep, house, store, farm, lumber };
}

const roadSegs = (segs: LaneSeg[]) => segs.filter((s) => s.kind !== 'plaza' && !s.noRide);

describe('roads on the cell borders, to things', () => {
  it("the roads join the town's gate to every door, along the cell borders", () => {
    const f = fortress();
    walled(f);
    const L = f.lanes();
    const w = f.ways();
    // (the keep, the house, the warehouse, the lumber camp: a yard — the farm — has none)
    expect(w.doors.length).toBeGreaterThanOrEqual(4);
    expect(L.unjoined).toEqual([]);
    // (every structure: those with doors, and the yards — the farm — at a corner)
    expect(L.joined.length).toBe(f.plan.structures().filter((s) => s.type !== 'wall').length);
    // (every road piece a border: its ends two corners of its cell)
    const g = f.grid;
    const corners = (c: number) => [0, 1, 2, 3].map((k) => g.corner(c, k));
    const isCorner = (c: number, p: readonly number[]) => corners(c).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6);
    for (const s of roadSegs(L.segs)) expect(isCorner(s.cell, s.a) && isCorner(s.cell, s.b), `a ${s.kind} off the borders`).toBe(true);
    // (one network: the ride graph reaches every door from the gate's tile)
    const graph = laneGraph(L);
    const from = nearestNode(graph, ...g.centre(f.cellAt(GATE[0] + 4, GATE[1])));
    const net = reached(graph, from.node);
    expect(net.size).toBe(nodeCount(graph));
    for (const d of w.doors) {
      const e = [0, 1, 2, 3].find((k) => g.nbr[d.out * 4 + k] === d.cell)!;
      const near = Math.min(nearestNode(graph, ...g.corner(d.out, e)).d, nearestNode(graph, ...g.corner(d.out, e + 1)).d, nearestNode(graph, ...g.centre(d.out)).d);
      expect(near, `the door of the ${f.plan.structure(d.structure)!.type}`).toBeLessThan(1e-3);
    }
  });

  it('no road round an empty plot: a free cell off the roads has at most two road borders', () => {
    const f = fortress();
    walled(f);
    const L = f.lanes();
    const g = f.grid;
    const tiles = new Set(L.tiles);
    const key = (p: readonly number[]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    const roadEdges = new Set(roadSegs(L.segs).map((s) => [key(s.a), key(s.b)].sort().join('|')));
    let rings = 0;
    let plots = 0;
    for (let c = 0; c < g.count; c++) {
      if (f.plan.owner[c] >= 0 || tiles.has(c) || !g.columns[c].length) continue;
      plots++;
      const n = [0, 1, 2, 3].filter((e) => roadEdges.has([key(g.corner(c, e)), key(g.corner(c, e + 1))].sort().join('|'))).length;
      if (n >= 3) rings++;
    }
    expect(plots).toBeGreaterThan(100);
    // (a trunk turning round a cell's corner takes two of its sides; three or four is a ring round it)
    expect(rings).toBeLessThanOrEqual(2);
    // (and the roads are few: the borders of a few dozen cells, not the town's every plot)
    expect(roadEdges.size).toBeLessThan(plots / 2);
  });

  it('a wall is crossed only through a gate: the keep is cut off without the gate tile', () => {
    const f = fortress();
    const { gate, keep } = walled(f);
    const L = f.lanes();
    expect(L.tiles).toContain(gate);
    const g = f.grid;
    const [gx, gy] = g.centre(gate);
    const at = (p: readonly number[]) => Math.hypot(p[0] - gx, p[1] - gy) < 1e-6;
    const graph = laneGraph({ ...L, segs: L.segs.filter((s) => !at(s.a) && !at(s.b)) });
    const out = nearestNode(graph, ...g.centre(f.cellAt(GATE[0] + 4, GATE[1])));
    const door = f.ways().doors.find((d) => d.cell === keep)!;
    const inner = nearestNode(graph, ...g.centre(door.out));
    expect(inner.d).toBeLessThan(1e-3);
    expect(reached(graph, out.node).has(inner.node)).toBe(false);
  });

  it("a building outside the walls gets a road from the town's gate; the big ones' door cells are tiles", () => {
    const f = fortress();
    const { lumber, store, keep } = walled(f);
    const L = f.lanes();
    expect(L.joined).toContain(f.plan.owner[lumber]);
    const w = f.ways();
    for (const big of [store, keep]) expect(L.tiles).toContain(w.doors.find((d) => d.cell === big)!.out);
    // (the road bits: every column of a thoroughfare tile, and some along a road)
    const bits = roadBitsCpu(f.roadShapes(), 0, 0, W, H);
    const bit = (k: number) => (bits[k >> 5] >>> (k & 31)) & 1;
    for (const c of L.tiles) for (const col of f.grid.columns[c]) expect(bit(col)).toBe(1);
    const s = roadSegs(L.segs)[0];
    const [x, y] = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    let near = 0;
    const r0 = Math.floor(y / (Math.sqrt(3) / 2));
    for (let r = r0 - 2; r <= r0 + 2; r++)
      for (let k = Math.floor(x) - 2; k <= Math.floor(x) + 2; k++) {
        const [px, py] = cellPos(k, r);
        if (Math.hypot(px - x, py - y) < 0.8) near += bit(r * W + k);
      }
    expect(near).toBeGreaterThan(0);
  });

  it('no roads under water: a lake over part of the box', async () => {
    const lake = (x: number) => x < 40;
    const f = fortress(() => 5, { w: W, h: H, runs: () => [[0, 5]], water: (x: number) => (lake(x) ? 1 : 0) });
    // (the water known: the reach's wet columns)
    f.requestReach(true);
    await f.settled();
    walled(f);
    const L = f.lanes();
    expect(L.unjoined).toEqual([]);
    for (const s of roadSegs(L.segs)) expect(lake(Math.max(s.a[0], s.b[0]) - 3), `a ${s.kind} at x ${s.a[0].toFixed(1)}`).toBe(false);
  });

  it('drawn as paving by the buildings, earth in the open, steps on the steep climbs; the tiles paved whole', () => {
    const f = fortress((x, y) => 0.4 * y);
    walled(f);
    const lib = library();
    const count = (name: string, lanes: boolean) => {
      const p = fortressPieces({ plan: f.plan, town: f.town, grid: f.grid, ground: (x, y) => 0.4 * y, zOff: 0, ways: f.ways(), lanes: lanes ? f.lanes() : undefined });
      let n = 0;
      for (let i = 0; i < p.count; i++) if (lib.modules[p.module[i]].name === name) n++;
      return n;
    };
    const L = f.lanes();
    const drawn = L.segs.filter((s) => LANE_DRAWN[s.kind]).length;
    const tiles = L.tiles.filter((c) => f.ways().way[c] !== WAY_SQUARE).length;
    expect(count('pave', true) + count('earth', true) - count('pave', false)).toBe(drawn + tiles);
    expect(count('earth', true)).toBe(L.segs.filter((s) => s.kind === 'track').length);
    expect(L.segs.some((s) => s.steps)).toBe(true);
    expect(count('kerb', true)).toBeGreaterThan(count('kerb', false));
  });
});
