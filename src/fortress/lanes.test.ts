// (round 128f) Roads narrower than a cell (lanes.ts): a second grid's level lines worked out per tile from its corners
// alone — the pieces of neighbouring tiles meet at the side they share; the spacing per district sets the density; on a
// slope the lanes run along the contours; the main roads, a lane wide, still join every door.
import { describe, expect, it } from 'vitest';
import { library } from '../structures/modules';
import { Fortress } from './fortress';
import { LANE_DRAWN, LANE_WIDTH, nearSeg, type LaneOpts, type Lanes } from './lanes';
import { roadBitsCpu } from '../agents/roads';
import { cellPos } from '../world/lattice';
import { fortressPieces } from './pieces';
import { WAY_ROAD, WAY_SQUARE, WAY_STAIR } from './ways';

const W = 160;
const H = 184;

function fortress(ground: (x: number, y: number) => number = () => 5, lanes: Partial<LaneOpts> = {}) {
  const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
    windowOrigin: () => [0, 0],
    dims: { w: W, h: H, zMax: 999 },
    ground,
    stores: () => ({}),
    changed: () => {},
  });
  f.ready = true;
  f.setLaneOpts(lanes);
  return f;
}

/** a walled ring round the box's middle, a gate, the keep, a house and a warehouse inside, a farm outside */
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
  f.paint(f.cellAt(cx + r + 14, cy), 0, 'farm');
  return { ring, gate, keep, house, store };
}

const close = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9;
const len = (L: Lanes, kinds: string[]) => L.segs.filter((s) => kinds.includes(s.kind)).reduce((a, s) => a + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), 0);

describe('lanes: roads narrower than a cell', () => {
  it("each tile's pieces meet its neighbours' at the side they share (no dead ends at seams)", () => {
    for (const ground of [() => 5, (x: number, y: number) => 0.25 * y + 3 * Math.sin(x / 25)]) {
      const f = fortress(ground);
      walled(f);
      const L = f.lanes();
      const w = f.ways().way;
      const g = f.grid;
      const laneTile = (c: number) => c >= 0 && g.columns[c].length > 0 && f.plan.owner[c] < 0 && w[c] !== WAY_SQUARE && w[c] !== WAY_STAIR;
      let joined = 0;
      for (const s of L.segs) {
        if (s.family < 0) continue;
        for (const [p, e] of [[s.a, s.ea], [s.b, s.eb]] as const) {
          if (e < 0) continue;
          const m = g.nbr[s.cell * 4 + e];
          if (!laneTile(m)) continue;
          const other = L.byCell[m].map((i) => L.segs[i]).find((t) => t.family === s.family && t.level === s.level && (close(t.a, p) || close(t.b, p)));
          expect(other, `cell ${s.cell} side ${e} family ${s.family} level ${s.level}`).toBeTruthy();
          joined++;
        }
      }
      expect(joined).toBeGreaterThan(200);
      // a town lane cut at the town's edge ends on the ring
      const ratio = Math.round(f.laneOpts.fields / f.laneOpts.town);
      for (const s of L.segs) {
        if (s.family < 0 || s.family > 1 || s.level % ratio === 0) continue;
        for (const [p, e] of [[s.a, s.ea], [s.b, s.eb]] as const) {
          if (e >= 0) continue;
          const ring = L.byCell[s.cell].map((i) => L.segs[i]).filter((t) => t.kind === 'ring');
          const on = ring.some((r) => {
            const dx = r.b[0] - r.a[0];
            const dy = r.b[1] - r.a[1];
            const t = Math.max(0, Math.min(1, ((p[0] - r.a[0]) * dx + (p[1] - r.a[1]) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(p[0] - r.a[0] - dx * t, p[1] - r.a[1] - dy * t) < 1e-6;
          });
          expect(on).toBe(true);
        }
      }
    }
  });

  it('the spacing per district sets the density: lanes in town, sparser tracks in the fields', () => {
    const dense = fortress(() => 5, { town: 10, fields: 30 });
    walled(dense);
    const sparse = fortress(() => 5, { town: 20, fields: 60 });
    walled(sparse);
    const a = len(dense.lanes(), ['lane', 'cross']);
    const b = len(sparse.lanes(), ['lane', 'cross']);
    expect(a / b).toBeGreaterThan(1.6);
    // the fields: every third lane goes on as a track, so less of it a square metre than in town
    const L = dense.lanes();
    expect(L.segs.some((s) => s.kind === 'track')).toBe(true);
    expect(L.segs.some((s) => s.kind === 'ring')).toBe(true);
    // nothing on a structure, a square or a stair
    for (const s of L.segs) {
      if (s.family < 0) continue;
      expect(dense.plan.owner[s.cell]).toBe(-1);
      expect([WAY_SQUARE, WAY_STAIR]).not.toContain(dense.ways().way[s.cell]);
    }
  });

  it('on a slope the lanes run along the contours (within 15 degrees) and the climbing lanes get steps', () => {
    const h = (x: number, y: number) => 0.25 * y + 3 * Math.sin(x / 25);
    const f = fortress(h);
    walled(f);
    const L = f.lanes();
    expect(L.contour).toBe(1);
    let n = 0;
    let worst = 0;
    for (const s of L.segs) {
      if (s.family !== 0) continue;
      const dx = s.b[0] - s.a[0];
      const dy = s.b[1] - s.a[1];
      const l = Math.hypot(dx, dy);
      if (l < 1) continue;
      const mx = (s.a[0] + s.b[0]) / 2;
      // the contour: across the ground's gradient
      const gx = (3 / 25) * Math.cos(mx / 25);
      const gy = 0.25;
      const cos = Math.abs(dx * -gy + dy * gx) / (l * Math.hypot(gx, gy));
      worst = Math.max(worst, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
      n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(worst).toBeLessThan(15);
    expect(L.segs.some((s) => s.family === 1 && s.steps)).toBe(true);
    expect(L.segs.some((s) => s.family === 0 && s.steps)).toBe(false);
  });

  it('the main roads, a lane wide, still join every door and run through the gate', () => {
    const f = fortress();
    const { gate } = walled(f);
    const L = f.lanes();
    const w = f.ways();
    const roads = L.segs.filter((s) => s.kind === 'road' || s.kind === 'plaza');
    const key = (p: [number, number]) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      if (!parent.has(k)) parent.set(k, k);
      const p = parent.get(k)!;
      if (p === k) return k;
      const r = find(p);
      parent.set(k, r);
      return r;
    };
    for (const s of roads) parent.set(find(key(s.a)), find(key(s.b)));
    // (a square is paved whole: its ways out join through it)
    const doorPt = (out: number, cell: number): [number, number] => {
      const e = [0, 1, 2, 3].find((k) => f.grid.nbr[out * 4 + k] === cell)!;
      const a = f.grid.corner(out, e);
      const b = f.grid.corner(out, e + 1);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    };
    expect(w.doors.length).toBeGreaterThanOrEqual(3);
    const root = find(key(doorPt(w.doors[0].out, w.doors[0].cell)));
    for (const d of w.doors) expect(find(key(doorPt(d.out, d.cell))), `door of ${f.plan.structure(d.structure)!.type}`).toBe(root);
    expect(L.byCell[gate].some((i) => L.segs[i].kind === 'road')).toBe(true);
    expect(find(key(f.grid.centre(gate)))).toBe(root);
    // narrower than a cell: of a road cell's columns only those on the road's band are road
    let cellCols = 0;
    let onRoad = 0;
    for (let c = 0; c < f.grid.count; c++) {
      if (w.way[c] !== WAY_ROAD) continue;
      for (const col of f.grid.columns[c]) {
        cellCols++;
        const [x, y] = cellPos(col % W, Math.floor(col / W));
        if (L.byCell[c].some((i) => L.segs[i].kind === 'road' && nearSeg(L.segs[i], x, y, 0.3))) onRoad++;
      }
    }
    expect(onRoad).toBeGreaterThan(0);
    expect(onRoad / cellCols).toBeLessThan(0.7);
    // (round 128i) the road bits the agents stamp from the fortress's shapes (the GPU's rule, agents/roads.ts): every
    // column on a road's band, and of a road cell's columns only part
    const bits = roadBitsCpu(f.roadShapes(), 0, 0, W, H);
    const bit = (k: number) => (bits[k >> 5] >>> (k & 31)) & 1;
    let bitCols = 0;
    for (let c = 0; c < f.grid.count; c++) {
      if (w.way[c] !== WAY_ROAD) continue;
      for (const col of f.grid.columns[c]) {
        const [x, y] = cellPos(col % W, Math.floor(col / W));
        if (L.byCell[c].some((i) => L.segs[i].kind === 'road' && nearSeg(L.segs[i], x, y, 0))) expect(bit(col)).toBe(1);
        bitCols += bit(col);
      }
    }
    expect(bitCols).toBeGreaterThanOrEqual(onRoad);
    expect(bitCols / cellCols).toBeLessThan(0.75);
    // a square's every column
    for (let c = 0; c < f.grid.count; c++) if (w.way[c] === WAY_SQUARE) for (const col of f.grid.columns[c]) expect(bit(col)).toBe(1);
    // the same shapes until the plan changes
    expect(f.roadShapes()).toBe(f.roadShapes());
  });

  it('(round 128i) no lanes under water: a lake over part of the box', () => {
    // (the lake: every column west of x = 40 under a metre of water)
    const lake = (x: number) => x < 40;
    const f = new Fortress({ origin: [0, 0], w: W, h: H }, {
      windowOrigin: () => [0, 0],
      dims: { w: W, h: H, zMax: 999 },
      ground: () => 5,
      stores: () => ({}),
      changed: () => {},
      columns: () => ({ w: W, h: H, runs: () => [[0, 5]], water: (x: number) => (lake(x) ? 1 : 0) }),
    });
    f.ready = true;
    walled(f);
    const L = f.lanes();
    expect(L.segs.length).toBeGreaterThan(50);
    const lanes = L.segs.filter((s) => s.family >= 0);
    // (none in a cell the lake covers; some ran there without it)
    for (const s of lanes) {
      const [cx] = f.grid.centre(s.cell);
      expect(lake(cx - 1), `a ${s.kind} at x ${cx.toFixed(1)}`).toBe(false);
    }
    const dry = fortress();
    walled(dry);
    expect(dry.lanes().segs.some((s) => s.family >= 0 && dry.grid.centre(s.cell)[0] < 39)).toBe(true);
  });

  it('the roads run through a passage and up a ramp along its axis (FT-65)', () => {
    const f = fortress();
    const { gate } = walled(f);
    // the cell inside the gate built on: a block across the gate's way
    const [cx, cy] = [W / 2, ((H / 2) * Math.sqrt(3)) / 2];
    const inner = [0, 1, 2, 3].map((e) => f.grid.nbr[gate * 4 + e]).filter((m) => m >= 0 && f.plan.owner[m] < 0).sort((a, b) => Math.hypot(f.centre(a)[0] - cx, f.centre(a)[1] - cy) - Math.hypot(f.centre(b)[0] - cx, f.centre(b)[1] - cy))[0];
    f.paint(inner, 0, 'house');
    const sync = () => (f as unknown as { sync(): void }).sync();
    sync();
    const shut = f.ways();
    expect(shut.passages).toEqual([]);
    expect(f.plan.setPassage(inner, true)).toBe(true);
    sync();
    const w = f.ways();
    expect(w.passages).toContain(inner);
    const L = f.lanes();
    expect(L.byCell[inner].some((i) => L.segs[i].kind === 'road')).toBe(true);
    // a ramp on a road cell: the roads in it only along its axis, as a ramp (not paved: its treads are the road)
    const road = [...Array(f.grid.count).keys()].find((c) => w.way[c] === WAY_ROAD && L.byCell[c].filter((i) => L.segs[i].kind === 'road').length === 2)!;
    const sides = L.byCell[road].filter((i) => L.segs[i].kind === 'road').map((i) => L.segs[i].eb);
    expect(f.plan.setRamp(road, sides[0])).toBe(true);
    sync();
    const L2 = f.lanes();
    const inRamp = L2.byCell[road].map((i) => L2.segs[i]);
    expect(inRamp.length).toBeGreaterThan(0);
    for (const s of inRamp) {
      expect(s.kind).toBe('ramp');
      expect([sides[0], (sides[0] + 2) % 4]).toContain(s.eb);
    }
    expect(LANE_DRAWN.ramp).toBe(false);
  });

  it('drawn as paving a lane wide (and steps on the steep climbs)', () => {
    const f = fortress((x, y) => 0.25 * y);
    walled(f);
    const lib = library();
    const count = (name: string, lanes: boolean) => {
      const p = fortressPieces({ plan: f.plan, town: f.town, grid: f.grid, ground: (x, y) => 0.25 * y, zOff: 0, ways: f.ways(), lanes: lanes ? f.lanes() : undefined });
      let n = 0;
      for (let i = 0; i < p.count; i++) if (lib.modules[p.module[i]].name === name) n++;
      return n;
    };
    const drawn = f.lanes().segs.filter((s) => LANE_DRAWN[s.kind] && LANE_WIDTH[s.kind] > 0).length;
    // (round 128i: the tracks are trodden earth, the rest paving)
    expect(count('pave', true) + count('earth', true) - count('pave', false)).toBe(drawn);
    expect(count('earth', true)).toBe(f.lanes().segs.filter((s) => s.kind === 'track').length);
    expect(count('kerb', true)).toBeGreaterThan(count('kerb', false));
  });
});
