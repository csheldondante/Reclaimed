// The fortress's roads (round 128k; were the lanes of round 128f-i). The user, on the lanes of an offset grid that
// ringed empty plots: "They just don't make sense as roads ... Realistically I would expect a road to the lumber mill and
// not around an empty plot. It also, just didn't convincingly connect to the city through a gate or anything"; on how:
// "I wonder if we can make some cells roads or else make the border between some cells roads at some frequency?",
// "testing roads between grid cells sounds reasonable and making thoroughfairs hole tiles for bug structures. It's ok if
// it doesn't look quite right for now but we want roads for the trade".
//  - Roads run on the town grid's cell BORDERS (its edges: thin, no grid of their own), chosen by purpose: a tree grown
//    from the town's gates (`roots`: the old town's gate posts, else its stores) to every door, each time to the nearest
//    door not yet joined, along the cheapest borders (a border's length, dearer climbing, cheap along road already laid
//    so the roads merge into trunks). Nothing else: no road round an empty plot.
//  - Thoroughfares are whole TILES: the fortress's gates and passages (the only way through a wall: a border between
//    two wall cells is no way, nor a corner on one), the cells either side of a gate, squares, the door cells of the big
//    buildings (the keep, warehouses, barracks), the cell a root opens on. A tile's middle joins its corners (a gate's
//    only its way through: middle to the middle of the side it opens by, to the tile beyond).
//  - A border is a way if a free cell lies on one side of it (not the town that was there, not water, inside the box);
//    a road beside a building is paving, out in the open trodden earth (a track).
// Pure, from the plan alone (tested without a GPU: lanes.test.ts). The ride graph (laneGraph) is built from the same
// pieces. Deferred (BACKLOG FT-73): lanes between built cells at a frequency, the grid nudged along the contours.
import type { V2 } from '../api/contracts/structures';
import type { TownPlan } from '../build/plan';
import { DEFS } from './defs';
import { WAY_SQUARE, type Ways, type WaysGrid } from './ways';
import type { RoadShape } from '../agents/roads';
import { graphOf, type RoadGraph } from '../agents/roadgraph';

export interface LaneGrid extends WaysGrid {
  readonly verts: ArrayLike<number>;
  readonly quads: ArrayLike<number>;
  readonly columns: readonly (readonly number[])[];
}

/** road: a border road by a building (paving); track: a border road in the open (earth); plaza: a way across a
 *  thoroughfare tile (the tile is paved whole: not drawn); ramp: a road up a ramp (its treads are the road) */
export type LaneKind = 'road' | 'plaza' | 'ramp' | 'track';

export interface LaneSeg {
  cell: number;
  a: V2;
  b: V2;
  kind: LaneKind;
  /** a climb steep enough for steps */
  steps: boolean;
  /** not ridden (the agents' road graph leaves it out): the last stretch into the town that was there, to its gate */
  noRide?: boolean;
}

export interface LaneOpts {
  /** a border's cost: × (1 + this × its rise over its run) */
  climb: number;
  /** a border already a road costs this much of a new one (the roads merge into trunks) */
  reuse: number;
}

export const LANE_DEFAULTS: LaneOpts = { climb: 4, reuse: 0.25 };
/** each kind's width (m): a cell is ~6 m across */
export const LANE_WIDTH: Record<LaneKind, number> = { road: 2.6, plaza: 2.6, ramp: 2.6, track: 2.0 };
/** the kinds drawn as bands (a tile is paved whole; a ramp's treads are its road) */
export const LANE_DRAWN: Record<LaneKind, boolean> = { road: true, plaza: false, ramp: false, track: true };
/** a road's rise over its run past which it is stepped */
export const STEEP = 0.3;
/** big buildings: their door's cell is a thoroughfare tile */
const BIG = new Set<string>(['fortress', 'warehouse', 'barracks']);
/** (aw4) how far a road vertex beside a building is moved off it (m): past the band of columns on the border */
export const OFF_BUILDING = 1.6;
/** a root farther than this (m) from any free cell is left out */
const ROOT_REACH = 45;

export interface Lanes {
  segs: LaneSeg[];
  /** per cell the indices of its segments */
  byCell: number[][];
  /** the thoroughfare tiles on the roads (cells paved whole) */
  tiles: number[];
  /** the structures whose door the roads reach, and those they can't */
  joined: number[];
  unjoined: number[];
}

export function noLanes(count: number): Lanes {
  return { segs: [], byCell: Array.from({ length: count }, () => []), tiles: [], joined: [], unjoined: [] };
}

type Link = { to: number; cost: number; cell: number; kind: LaneKind };

/** a binary heap of (cost, node) */
class Heap {
  private h: [number, number][] = [];
  get size(): number {
    return this.h.length;
  }
  push(d: number, v: number): void {
    const h = this.h;
    h.push([d, v]);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const h = this.h;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l][0] < h[m][0]) m = l;
        if (r < h.length && h[r][0] < h[m][0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The roads of the plan's ground (box frame). `ground`: the ground's top at a point; `blocked`: a cell the town that was
 * there stands on, or water (no way); `roots`: where the roads start (box frame: the town's gates).
 */
/** a grid's own (plan-free) parts of the border graph: its vertices merged where they meet, the cells round each, each border once */
interface GridGeom {
  canon: Int32Array;
  round: number[][];
  borders: [number, number, number, number][];
}

const geoms = new WeakMap<LaneGrid, GridGeom>();

function gridGeom(g: LaneGrid): GridGeom {
  const had = geoms.get(g);
  if (had) return had;
  const n = g.count;
  const nv = g.verts.length / 2;
  const inBox = (c: number) => c >= 0 && g.columns[c].length > 0;
  const canon = new Int32Array(nv);
  const byPos = new Map<number, number>();
  for (let v = 0; v < nv; v++) {
    // (a centimetre's grid: the box is under 10 km)
    const k = Math.round(g.verts[v * 2] * 100) * 1e6 + Math.round(g.verts[v * 2 + 1] * 100);
    const was = byPos.get(k);
    canon[v] = was ?? v;
    if (was === undefined) byPos.set(k, v);
  }
  const Q = (i: number) => canon[g.quads[i]];
  const round = Array.from({ length: nv }, () => [] as number[]);
  for (let c = 0; c < n; c++) if (inBox(c)) for (let k = 0; k < 4; k++) round[Q(c * 4 + k)].push(c);
  const borders: [number, number, number, number][] = [];
  const seen = new Set<number>();
  for (let c = 0; c < n; c++) {
    if (!inBox(c)) continue;
    for (let e = 0; e < 4; e++) {
      const va = Q(c * 4 + e);
      const vb = Q(c * 4 + ((e + 1) & 3));
      const key = Math.min(va, vb) * nv + Math.max(va, vb);
      if (seen.has(key)) continue;
      seen.add(key);
      borders.push([va, vb, c, g.nbr[c * 4 + e]]);
    }
  }
  const out = { canon, round, borders };
  geoms.set(g, out);
  return out;
}

export function lanesOf(
  plan: TownPlan,
  g: LaneGrid,
  ways: Ways,
  ground: (x: number, y: number) => number,
  opts: Partial<LaneOpts> = {},
  blocked: (c: number) => boolean = () => false,
  roots: readonly V2[] = [],
  /** (round 128m, quarry) where a yard's road comes in: a cell's side (a quarry's pit: its ramp's top) — none: its first cell's corners */
  entries: (structure: number) => { cell: number; side: number } | null = () => null,
): Lanes {
  const o: LaneOpts = { ...LANE_DEFAULTS, ...opts };
  const n = g.count;
  const nv = g.verts.length / 2;
  const inBox = (c: number) => c >= 0 && g.columns[c].length > 0;
  const free = (c: number) => inBox(c) && plan.owner[c] < 0 && !blocked(c);
  const typeOf = (c: number) => (c >= 0 ? plan.typeAt(c) : null);
  const wallish = (c: number) => {
    const t = typeOf(c);
    return t !== null && DEFS[t].form === 'wall';
  };
  const owned = (c: number) => c >= 0 && plan.owner[c] >= 0;
  const gateSet = new Set<number>([...ways.gates, ...(ways.passages ?? [])]);

  // the grid's vertices merged where they meet, the cells round each, the borders: the grid's own (made once a grid:
  // gridGeom — onetown, a town's thousands of cells)
  const geo = gridGeom(g);
  const canon = geo.canon;
  const Q = (i: number) => canon[g.quads[i]];
  // ---- the border graph: nodes are the grid's vertices, then the tiles' middles and their sides' middles
  const adj: Link[][] = Array.from({ length: nv }, () => []);
  const pos: V2[] = [];
  for (let v = 0; v < nv; v++) pos.push([g.verts[v * 2], g.verts[v * 2 + 1]]);
  // (round 128l, aw4; BACKLOG AW-4) a vertex beside a building is moved off it, toward the free cells round it: a road
  // on a border by a building ran down the line between the two cells, half its band in the building's columns — solid
  // once the fortress is claimed (solid.ts: a block is its cell's columns), so a cart steering along it from node to node
  // drove into the wall and stood there (the lab's stores, boxed in by the houses beside its road). Every piece meeting
  // at a vertex uses the same moved vertex: the roads stay joined
  const round = geo.round;
  const standing = (c: number) => {
    const t = typeOf(c);
    return t !== null && (DEFS[t].form === 'block' || DEFS[t].form === 'keep');
  };
  for (let v = 0; v < nv; v++) {
    if (canon[v] !== v) continue;
    const cs = round[v];
    if (!cs.some(standing)) continue;
    const open = cs.filter((c) => free(c));
    if (!open.length) continue;
    let mx = 0;
    let my = 0;
    for (const c of open) {
      const [x, y] = g.centre(c);
      mx += x / open.length;
      my += y / open.length;
    }
    const [x, y] = pos[v];
    const d = Math.hypot(mx - x, my - y);
    if (d < 1e-6) continue;
    const s = Math.min(OFF_BUILDING, d * 0.45) / d;
    pos[v] = [x + (mx - x) * s, y + (my - y) * s];
  }
  const node = (p: V2) => {
    pos.push(p);
    adj.push([]);
    return pos.length - 1;
  };
  const z = (p: V2) => ground(p[0], p[1]);
  // (each node's ground read once: a vertex has four borders or more — onetown, a town's thousands of cells)
  const zn: number[] = [];
  const zOf = (v: number) => (zn[v] ??= z(pos[v]));
  const link = (a: number, b: number, cell: number, kind: LaneKind) => {
    const l = Math.hypot(pos[b][0] - pos[a][0], pos[b][1] - pos[a][1]);
    // (a ground not read yet — NaN — counts flat: a NaN cost would never relax, the roads stopping short there)
    const dz = Math.abs(zOf(b) - zOf(a));
    const cost = l * (1 + (o.climb * (Number.isFinite(dz) ? dz : 0)) / Math.max(l, 1e-6));
    adj[a].push({ to: b, cost, cell, kind });
    adj[b].push({ to: a, cost, cell, kind });
  };
  // a vertex on the line between two wall cells (a wall and a gate too) is no way: a wall is crossed at a gate's middle
  const wallVert = new Uint8Array(nv);
  const borders = geo.borders;
  for (let c = 0; c < n; c++) {
    if (!wallish(c)) continue;
    for (let e = 0; e < 4; e++)
      if (wallish(g.nbr[c * 4 + e])) {
        wallVert[Q(c * 4 + e)] = 1;
        wallVert[Q(c * 4 + ((e + 1) & 3))] = 1;
      }
  }
  for (const [va, vb, c, m] of borders) {
    if (wallVert[va] || wallVert[vb] || (!free(c) && !free(m))) continue;
    link(va, vb, free(c) ? c : m, owned(c) || owned(m) ? 'road' : 'track');
  }

  // the pieces of the border graph (the land the river, the old town's walls or the fortress's cut apart)
  const comp = new Int32Array(nv).fill(-1);
  let pieces = 0;
  for (let v = 0; v < nv; v++) {
    if (comp[v] >= 0 || !adj[v].length) continue;
    const id = pieces++;
    const todo = [v];
    comp[v] = id;
    while (todo.length) {
      const x = todo.pop()!;
      for (const l of adj[x])
        if (comp[l.to] < 0) {
          comp[l.to] = id;
          todo.push(l.to);
        }
    }
  }
  const pieceOf = (c: number) => {
    for (let k = 0; k < 4; k++) {
      const p = comp[Q(c * 4 + k)];
      if (p >= 0) return p;
    }
    return -1;
  };

  // ---- the tiles
  const tileNode = new Map<number, number>();
  const sideTo = (c: number, m: number) => [0, 1, 2, 3].find((e) => g.nbr[c * 4 + e] === m) ?? -1;
  const mid = (c: number, e: number): V2 => {
    const a = g.corner(c, e);
    const b = g.corner(c, e + 1);
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const tileOf = (c: number): number => {
    const had = tileNode.get(c);
    if (had !== undefined) return had;
    const t = node(g.centre(c));
    tileNode.set(c, t);
    if (!gateSet.has(c))
      for (let k = 0; k < 4; k++) {
        const v = Q(c * 4 + k);
        if (!wallVert[v]) link(t, v, c, 'plaza');
      }
    return t;
  };
  // gates and passages: through the middle, out by the sides their way runs, to the free cells beyond (tiles too)
  for (const c of gateSet) {
    if (!inBox(c)) continue;
    const t = tileOf(c);
    for (let e = 0; e < 4; e++) {
      const m = g.nbr[c * 4 + e];
      if (!free(m)) continue;
      const s = node(mid(c, e));
      link(t, s, c, 'plaza');
      link(s, tileOf(m), m, 'plaza');
    }
  }
  for (let c = 0; c < n; c++) if (ways.way[c] === WAY_SQUARE && free(c)) tileOf(c);
  // the doors: their side's ends; a big building's door cell a tile
  // (a door opening on no way — water, the old town — is reached at its cell's corners; a yard, which has no door —
  // a farm, the quarry — at its first cell's)
  const corners = (c: number) => [0, 1, 2, 3].map((k) => Q(c * 4 + k)).filter((v) => !wallVert[v]);
  const doorEnds: { d: { structure: number }; ends: number[] }[] = ways.doors.map((d) => {
    const t = typeOf(d.cell);
    if (t && BIG.has(t) && free(d.out)) return { d, ends: [tileOf(d.out)] };
    const e = sideTo(d.cell, d.out);
    const ends = e < 0 || !free(d.out) ? corners(d.cell) : [Q(d.cell * 4 + e), Q(d.cell * 4 + ((e + 1) & 3))].filter((v) => !wallVert[v]);
    return { d, ends };
  });
  const withDoor = new Set(ways.doors.map((d) => d.structure));
  for (const st of plan.structures()) {
    if (withDoor.has(st.id) || DEFS[st.type].form !== 'yard') continue;
    // (round 128m: a quarry's pit at its ramp's top — the miners haul up the ramps onto the roads there)
    const en = entries(st.id);
    if (en) {
      const ends = [Q(en.cell * 4 + en.side), Q(en.cell * 4 + ((en.side + 1) & 3))].filter((v) => !wallVert[v]);
      if (ends.length) {
        doorEnds.push({ d: { structure: st.id }, ends });
        continue;
      }
    }
    const c = [...st.cells.keys()].sort((a, b) => a - b)[0];
    if (c !== undefined) doorEnds.push({ d: { structure: st.id }, ends: corners(c) });
  }
  // the roots: the free cell nearest each (a tile), and a road from it to the root (into the town that was there:
  // drawn, not ridden)
  const rootSegs: { node: number; seg: LaneSeg }[] = [];
  const rootNodes: number[] = [];
  for (const r of roots) {
    // (a gate opens on both sides of its town's wall: on every piece of land within reach of it, its nearest free cell —
    // the street inside, the land outside, across a ford)
    const best = new Map<number, { c: number; d: number }>();
    for (let c = 0; c < n; c++) {
      if (!free(c)) continue;
      const p = pieceOf(c);
      if (p < 0) continue;
      const [x, y] = g.centre(c);
      const d = Math.hypot(x - r[0], y - r[1]);
      if (d <= ROOT_REACH && (best.get(p)?.d ?? Infinity) > d) best.set(p, { c, d });
    }
    for (const { c, d } of best.values()) {
      const t = tileOf(c);
      rootNodes.push(t);
      if (d > 1) rootSegs.push({ node: t, seg: { cell: c, a: g.centre(c), b: [r[0], r[1]], kind: 'road', steps: false, noRide: true } });
    }
  }

  // ---- the tree: from the roots (else the first door), each time to the nearest door not yet joined
  const N = pos.length;
  const inTree = new Uint8Array(N);
  const used = new Map<string, Link & { from: number }>();
  const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const starts = rootNodes.length ? rootNodes : (doorEnds.find((x) => x.ends.length)?.ends ?? []);
  for (const s of starts) inTree[s] = 1;
  const joined = new Set<number>();
  let pending = doorEnds.filter((x) => {
    if (x.ends.some((v) => inTree[v])) {
      joined.add(x.d.structure);
      return false;
    }
    return x.ends.length > 0;
  });
  // (onetown: incrementally — the distance to the tree kept, and after each join only what the new road brings nearer
  // relaxed, from the new road's nodes: a town's hundred doors cost a few passes over the border graph, not one a door.
  // A used border's discount (o.reuse) doesn't change a distance to the tree: both its ends are in it)
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const prevLink: (Link | null)[] = new Array(N).fill(null);
  const heap = new Heap();
  const relax = () => {
    while (heap.size) {
      const [d, v] = heap.pop();
      if (d > dist[v]) continue;
      for (const l of adj[v]) {
        const nd = d + l.cost;
        if (nd < dist[l.to] - 1e-9) {
          dist[l.to] = nd;
          prev[l.to] = v;
          prevLink[l.to] = l;
          heap.push(nd, l.to);
        }
      }
    }
  };
  const seed = (v: number) => {
    if (dist[v] === 0) return;
    dist[v] = 0;
    prev[v] = -1;
    prevLink[v] = null;
    heap.push(0, v);
  };
  if (starts.length) {
    for (let v = 0; v < N; v++) if (inTree[v]) seed(v);
    relax();
  }
  while (pending.length && starts.length) {
    // the nearest door not yet joined (its nearest end)
    let hit = -1;
    for (const x of pending) for (const v of x.ends) if (isFinite(dist[v]) && (hit < 0 || dist[v] < dist[hit])) hit = v;
    if (hit < 0) break;
    const path: number[] = [];
    for (let v = hit; !inTree[v]; v = prev[v]) path.push(v);
    for (const v of path) {
      used.set(ekey(prev[v], v), { ...prevLink[v]!, from: prev[v] });
      inTree[v] = 1;
    }
    for (const v of path) seed(v);
    relax();
    // (that door, and any whose ends the new road passed)
    pending = pending.filter((x) => {
      if (x.ends.some((v) => inTree[v])) {
        joined.add(x.d.structure);
        return false;
      }
      return true;
    });
  }

  // ---- the pieces
  const segs: LaneSeg[] = [];
  const byCell: number[][] = Array.from({ length: n }, () => []);
  const push = (s: LaneSeg) => {
    byCell[s.cell].push(segs.length);
    segs.push(s);
  };
  for (const l of used.values()) {
    const a = pos[l.from];
    const b = pos[l.to];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const kind: LaneKind = l.kind !== 'plaza' && plan.ramp && plan.ramp[l.cell] >= 0 ? 'ramp' : l.kind;
    push({ cell: l.cell, a, b, kind, steps: kind !== 'plaza' && Math.abs(z(b) - z(a)) / len > STEEP });
  }
  // (a root no road left from: its tile and its way to the gate not drawn)
  const usedNode = new Set<number>();
  for (const l of used.values()) {
    usedNode.add(l.from);
    usedNode.add(l.to);
  }
  const idle = new Set(rootNodes.filter((t) => !usedNode.has(t)));
  for (const r of rootSegs) if (!idle.has(r.node)) push(r.seg);
  const tiles = [...tileNode.entries()].filter(([, t]) => inTree[t] && !idle.has(t)).map(([c]) => c);
  return { segs, byCell, tiles, joined: [...joined], unjoined: pending.map((x) => x.d.structure) };
}

/** the window of a segment's band: within half its width (and `pad`) of it */
export function nearSeg(s: LaneSeg, x: number, y: number, pad = 0): boolean {
  const half = LANE_WIDTH[s.kind] / 2 + pad;
  if (half <= 0) return false;
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (y - s.a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - s.a[0] - dx * t, y - s.a[1] - dy * t) <= half;
}

/** (round 128i) the road bit reaches this far past a band's paving: a column whose middle is this near counts */
export const ROAD_PAD = 0.3;

/**
 * (round 128i, FT-58; round 128k) The road shapes the units' fields prefer (Agents.setRoads, stamped on the GPU —
 * agents/roads.ts), in the lanes' frame: each band (and ROAD_PAD), each thoroughfare tile and square whole.
 */
export function roadShapesOf(lanes: Lanes, ways: Ways, g: WaysGrid): RoadShape[] {
  const out: RoadShape[] = [];
  for (const s of lanes.segs) if (LANE_DRAWN[s.kind] && !s.noRide) out.push({ a: s.a, b: s.b, half: LANE_WIDTH[s.kind] / 2 + ROAD_PAD });
  const whole = new Set<number>(lanes.tiles);
  for (let c = 0; c < g.count; c++) if (ways.way[c] === WAY_SQUARE) whole.add(c);
  for (const c of whole) out.push({ quad: [g.corner(c, 0), g.corner(c, 1), g.corner(c, 2), g.corner(c, 3)] });
  return out;
}

/** (round 128i, V128-14) each kind's cost a metre in the agents' road graph */
export const LANE_COST: Record<LaneKind, number> = { road: 0.8, plaza: 0.8, ramp: 0.9, track: 1 };

/**
 * (round 128i, V128-14; round 128k) The roads as the agents' road graph (agents/roadgraph.ts), in the lanes' frame:
 * every piece an edge, joined at the grid's vertices and the tiles' middles; a stepped climb costs more; the stretch
 * into the town that was there (`noRide`) left out.
 */
export function laneGraph(lanes: Lanes): RoadGraph {
  return graphOf(lanes.segs.filter((s) => !s.noRide).map((s) => ({ a: s.a, b: s.b, cell: s.cell, cost: LANE_COST[s.kind] * (s.steps ? 1.3 : 1) })));
}
