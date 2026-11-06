// (round 128k; round 128o: down the ways' cells, not the borders) A town's roads (lanes.ts): the ways' road tree joining
// every entrance; never along a building's face; a wall crossed only through a gate's tile; thoroughfare tiles paved
// whole; the ride graph from the same pieces; none under water; drawn as paving by the buildings, earth in the open,
// steps on steep climbs.
import { fortressOn } from '../fortress/testing';
import { describe, expect, it } from 'vitest';
import { library } from '../structures/modules';
import { Fortress } from '../fortress/fortress';
import { LANE_DRAWN, laneGraph, type LaneSeg } from './lanes';
import { solidSpans } from './solid';
import { cellAt } from '../world/lattice';
import { roadBitsCpu } from '../agents/roads';
import { nearestNode, nodeCount, reached } from '../agents/roadgraph';
import { cellPos } from '../world/lattice';
import { townPieces } from './view';
import { WAY_SQUARE } from './ways';
import { CpuReach, type ReachColumns } from '../fortress/reach';

const W = 160;
const H = 184;
/** the town's gate: west of the box's middle (window = box frame here) */
const GATE: [number, number] = [14, ((H / 2) * Math.sqrt(3)) / 2];

function fortress(ground: (x: number, y: number) => number = () => 5, columns?: ReachColumns) {
  const f = fortressOn({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground,
    stores: () => ({}),
    // (the roads start at the town's gates — the plan's — else its stores: the gate stands in for both here)
    townHeap: () => GATE,
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

const roadSegs = (segs: LaneSeg[]) => segs.filter((s) => s.kind !== 'plaza');

describe('roads off the buildings (round 128l, aw4; BACKLOG AW-4)', () => {
  it("no road runs through a built block's solid columns: houses beside the road from the stores", () => {
    // (the lab's flat plan by its stores: two houses side by side, a third, a quarry and farms far out — the road east
    // ran down the houses' border, half in their claimed columns, and the carts stood against them)
    const heap: [number, number] = [98, 110.85];
    const f = fortressOn({ origin: [-22, -10], w: 240, h: 278 }, { windowOrigin: () => [0, 0], dims: { w: 256, h: 256, zMax: 64 }, ground: () => 10, stores: () => ({}), changed: () => {}, townHeap: () => heap });
    f.ready = true;
    const [hx, hy] = heap;
    const cells: ['house' | 'quarry' | 'farm', number, number][] = [
      ['house', hx + 10, hy + 12], ['house', hx + 16, hy + 12], ['house', hx - 8, hy + 14],
      ...[[70, 4], [70, 10], [76, 4], [76, 10]].map(([dx, dy]): ['quarry', number, number] => ['quarry', hx + dx, hy + dy]),
      ...[[6, -60], [12, -60], [6, -66], [12, -66]].map(([dx, dy]): ['farm', number, number] => ['farm', hx + dx, hy + dy]),
    ];
    for (const [t, x, y] of cells) f.paint(f.cellAt(x, y), 0, t);
    for (const s of f.plan.structures()) for (const c of s.cells.keys()) f.markBuilt(c, 0);
    const solid = new Set<number>();
    for (const spans of solidSpans({ plan: f.plan, town: f.town, grid: f.grid, ground: () => 10, ways: f.ways() }).values()) for (const q of spans) solid.add(q.y * f.box.w + q.x);
    const inSolid = (x: number, y: number) => {
      const [k, r] = cellAt(x, y);
      return solid.has(r * f.box.w + k);
    };
    const L = f.lanes();
    expect(L.unjoined).toEqual([]);
    const hits: string[] = [];
    for (const s of L.segs)
      for (let t = 0; t <= 1 + 1e-9; t += 0.05)
        if (inSolid(s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t)) {
          hits.push(`${s.kind} in cell ${s.cell} at t ${t.toFixed(2)}`);
          break;
        }
    expect(hits).toEqual([]);
    // (and the ride graph stays one network from the stores to every structure)
    expect(nodeCount(laneGraph(L))).toBeGreaterThan(10);
  });
});

describe('roads down the ways, to things', () => {
  it("the roads join every structure's entrance, down the middles of the ways' cells", () => {
    const f = fortress();
    walled(f);
    const L = f.lanes();
    const w = f.ways();
    // (the keep, the house, the warehouse, the lumber camp: doors; the farm: its edge; the wall: its gate)
    expect(w.doors.length).toBeGreaterThanOrEqual(4);
    expect(L.unjoined).toEqual([]);
    expect(L.joined.length).toBe(f.plan.structures().length);
    // (every piece from its cell's middle to the middle of one of its sides, or back)
    const g = f.grid;
    const near = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
    const mids = (c: number) => [0, 1, 2, 3].map((e) => {
      const a = g.corner(c, e);
      const b = g.corner(c, e + 1);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    });
    for (const s of L.segs) {
      const ends = [s.a, s.b];
      expect(ends.some((p) => near(p, g.centre(s.cell))) && ends.some((p) => mids(s.cell).some((m) => near(p, m))), `a ${s.kind} off its cell's middle`).toBe(true);
    }
    // (one network: the ride graph reaches every entrance's way-out cell from the gate's)
    const graph = laneGraph(L);
    const from = nearestNode(graph, ...g.centre(w.entrances[0].out));
    const net = reached(graph, from.node);
    for (const e of w.entrances) {
      const n = nearestNode(graph, ...g.centre(e.out));
      expect(n.d, `the ${e.kind} of the ${f.plan.structure(e.structure)!.type}`).toBeLessThan(1e-3);
      expect(net.has(n.node)).toBe(true);
    }
  });

  it('roads go to things: few of the free cells are roads', () => {
    const f = fortress();
    walled(f);
    const L = f.lanes();
    const g = f.grid;
    let plots = 0;
    for (let c = 0; c < g.count; c++) if (f.plan.owner[c] < 0 && g.columns[c].length) plots++;
    const roads = new Set(L.segs.map((s) => s.cell));
    expect(plots).toBeGreaterThan(100);
    expect(roads.size).toBeLessThan(plots / 4);
  });

  it('a wall is crossed only through a gate: the keep is cut off without the gate tile', () => {
    const f = fortress();
    const { gate, keep, lumber } = walled(f);
    const L = f.lanes();
    expect(L.tiles).toContain(gate);
    const g = f.grid;
    const [gx, gy] = g.centre(gate);
    const at = (p: readonly number[]) => Math.hypot(p[0] - gx, p[1] - gy) < 1e-6;
    const graph = laneGraph({ ...L, segs: L.segs.filter((s) => !at(s.a) && !at(s.b)) });
    // (outside: the lumber camp's door, out past the wall)
    const out = nearestNode(graph, ...g.centre(f.ways().doors.find((d) => d.cell === lumber)!.out));
    const door = f.ways().doors.find((d) => d.cell === keep)!;
    const inner = nearestNode(graph, ...g.centre(door.out));
    expect(inner.d).toBeLessThan(1e-3);
    expect(reached(graph, out.node).has(inner.node)).toBe(false);
  });

  it("a building outside the walls gets a road through the town's gate; the gate a tile", () => {
    const f = fortress();
    const { lumber, gate } = walled(f);
    const L = f.lanes();
    expect(L.joined).toContain(f.plan.owner[lumber]);
    expect(L.tiles).toContain(gate);
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
      const p = townPieces(f.site, { ground: (_x: number, y: number) => 0.4 * y, ways: f.ways(), lanes: lanes ? f.lanes() : undefined });
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
