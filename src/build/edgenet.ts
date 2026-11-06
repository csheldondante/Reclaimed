// The town's paths on its grid's edges (round 128p, DA-A13 step 1; DEVLOG round 128p, DECISIONS round 128p). The user:
// "The between tile roads then allows every other place to be reachable since you can always walk along an edge to any
// point". Pure: a site's plan and grid in, the edge network out (tested without a GPU: test/unit/edgenet.test.ts).
//  - Every edge of the grid (a side between two cells, or a cell and the rim) is a walkable path unless cut: a wall
//    across it (two wall cells, neither a gate), water on it (deep at its middle or either end), or a drop along it steeper than stairs
//    (the stair pitch, SLOPE). A rise past a road's grade (1 in 3) is stairs: walkable, flagged `steep`.
//  - A structure is one node (DECISIONS round 128p): its edges between its own cells aren't paths (a block's are inside
//    it); it joins every edge of its perimeter where a door stands at grade — its floor within a walker's step (STEP) of
//    the ground at the edge (a yard's: everywhere: it has no floor).
//  - Drawn paths (the user: "main streets + lanes only where a door uses them"): main streets the shortest edge paths
//    from the town's middle to its gates' far sides, to its roads out and out past its last structure on spokes; lanes from each structure's nearest door to
//    the network, in order of nearness, so they merge.
//  - Reach is a union-find over the edges' vertices with the structures' nodes: a structure is reached when one of its
//    doors lies in the stores' component. What isn't, says why — the same solve with one cut lifted at a time: a wall,
//    water, a cliff, no door at grade (a terrace).
import type { StructureType } from '../api/contracts/fortress';
import type { TownPlan } from './plan';
import type { CellGrid } from './quadgrid';
import { ROAD_GRADE } from './grade';
import { SLOPE } from './ways';
import { STEP } from '../agents/rules';

type V2 = [number, number];

/** what a drawn path is: 1 a lane, 2 a main street */
export const PATH_LANE = 1;
export const PATH_MAIN = 2;
/** why an edge is cut */
export const CUT_WALL = 1;
export const CUT_WATER = 2;
export const CUT_CLIFF = 4;

/** (DECISIONS round 128p: inset by path kind — lanes ~1 m, main streets more) how far a building stands back from a
 *  path on its edge, and the path's drawn width */
export const INSET = { [PATH_LANE]: 1, [PATH_MAIN]: 1.6 } as Record<number, number>;
export const PATH_WIDTH = { [PATH_LANE]: 2, [PATH_MAIN]: 3.2 } as Record<number, number>;

export interface EdgeNetSite {
  plan: TownPlan;
  grid: CellGrid & { verts: ArrayLike<number>; quads: ArrayLike<number> };
  /** per cell its ground floor (Town.base: NaN no block) */
  floor(c: number): number;
}

export interface EdgeNetIO {
  /** the land's top (the site's ground: world z) and deep water, box-local */
  ground(x: number, y: number): number;
  wet(x: number, y: number): boolean;
  /** the town's middle and its stores (box-local) */
  centre: V2;
  stores: V2;
  /** the roads out (box-local polylines): main streets reach them */
  roadsOut?: V2[][];
  /** main streets out from the middle to past the town's last structure, this many, evenly round (the first at
   *  `spokeAngle`): the radial centre's spokes on the grid's edges (step 2 makes them curves the tiles adapt to) */
  spokes?: number;
  spokeAngle?: number;
}

export type Why = 'wall' | 'water' | 'cliff' | 'terrace' | 'apart';

export interface EdgeNet {
  /** per edge its two vertices, and the cells either side (-1 the rim) */
  ends: Int32Array;
  cells: Int32Array;
  /** per cell side (c × 4 + side) its edge */
  edgeOf: Int32Array;
  length: Float32Array;
  /** per edge: CUT_* bits; steep (stairs); interior to a block (not a path); the drawn kind (0 none) */
  cut: Uint8Array;
  steep: Uint8Array;
  inner: Uint8Array;
  kind: Uint8Array;
  /** per structure its doors at grade (edges) and the one its lane leaves by */
  doors: Map<number, number[]>;
  door: Map<number, number>;
  /** the stores' and the middle's vertices */
  storesV: number;
  centreV: number;
  reach: ReachReport;
}

export interface ReachReport {
  structures: number;
  reached: number;
  /** what isn't, and why (the cut whose lifting reaches it) */
  out: { id: number; type: StructureType; why: Why }[];
  /** structures with no door at grade at all (a terrace: stairs at its door, at generation) */
  noDoorAtGrade: number;
  edges: { all: number; cut: { wall: number; water: number; cliff: number }; steep: number; main: number; lane: number };
  ms: number;
}

class Union {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(a: number): number {
    while (this.p[a] !== a) a = this.p[a] = this.p[this.p[a]];
    return a;
  }
  union(a: number, b: number): void {
    const x = this.find(a);
    const y = this.find(b);
    if (x !== y) this.p[Math.max(x, y)] = Math.min(x, y);
  }
}

export function edgeNetOf(site: EdgeNetSite, io: EdgeNetIO): EdgeNet {
  const t0 = performance.now();
  const { plan, grid } = site;
  const nv = grid.verts.length / 2;
  const vx = (v: number) => grid.verts[v * 2];
  const vy = (v: number) => grid.verts[v * 2 + 1];
  const vg = new Float64Array(nv);
  for (let v = 0; v < nv; v++) vg[v] = io.ground(vx(v), vy(v));
  // the edges: each cell side once (a neighbour's same side shares it)
  const edgeOf = new Int32Array(grid.count * 4).fill(-1);
  const ends: number[] = [];
  const cells: number[] = [];
  const byPair = new Map<number, number>();
  for (let c = 0; c < grid.count; c++)
    for (let s = 0; s < 4; s++) {
      const a = grid.quads[c * 4 + s];
      const b = grid.quads[c * 4 + ((s + 1) & 3)];
      const key = Math.min(a, b) * nv + Math.max(a, b);
      let e = byPair.get(key);
      if (e === undefined) {
        e = ends.length / 2;
        byPair.set(key, e);
        ends.push(a, b);
        cells.push(c, -1);
      } else cells[e * 2 + 1] = c;
      edgeOf[c * 4 + s] = e;
    }
  const ne = ends.length / 2;
  const E = Int32Array.from(ends);
  const C = Int32Array.from(cells);
  const len = new Float32Array(ne);
  const cut = new Uint8Array(ne);
  const steep = new Uint8Array(ne);
  const inner = new Uint8Array(ne);
  const kind = new Uint8Array(ne);
  const sid = (c: number) => (c < 0 ? 0 : (plan.structureAt(c)?.id ?? 0));
  const formOf = (c: number) => {
    const t = c < 0 ? null : plan.typeAt(c);
    return t ? plan.defs[t].form : null;
  };
  const isWall = (c: number) => c >= 0 && formOf(c) === 'wall' && !plan.gate[c];
  const solid = (c: number) => {
    const f = formOf(c);
    return f === 'block' || f === 'keep';
  };
  for (let e = 0; e < ne; e++) {
    const a = E[e * 2];
    const b = E[e * 2 + 1];
    len[e] = Math.hypot(vx(b) - vx(a), vy(b) - vy(a));
    const c0 = C[e * 2];
    const c1 = C[e * 2 + 1];
    if (isWall(c0) && isWall(c1)) cut[e] |= CUT_WALL;
    if (io.wet((vx(a) + vx(b)) / 2, (vy(a) + vy(b)) / 2) || io.wet(vx(a), vy(a)) || io.wet(vx(b), vy(b))) cut[e] |= CUT_WATER;
    const rise = Math.abs(vg[b] - vg[a]) / Math.max(len[e], 1e-6);
    if (rise > SLOPE) cut[e] |= CUT_CLIFF;
    else if (rise > ROAD_GRADE) steep[e] = 1;
    const s0 = sid(c0);
    if (s0 && s0 === sid(c1) && solid(c0)) inner[e] = 1;
  }
  // the structures' doors at grade: a perimeter edge whose ground lies within a step of its cell's floor (a yard: any)
  const doors = new Map<number, number[]>();
  for (const st of plan.structures()) {
    if (plan.defs[st.type].form === 'wall') continue;
    const out: number[] = [];
    for (const c of st.cells.keys())
      for (let s = 0; s < 4; s++) {
        const e = edgeOf[c * 4 + s];
        if (inner[e]) continue;
        const other = C[e * 2] === c ? C[e * 2 + 1] : C[e * 2];
        if (other >= 0 && sid(other) === st.id) continue;
        if (solid(c)) {
          const f = site.floor(c);
          const g = (vg[E[e * 2]] + vg[E[e * 2 + 1]]) / 2;
          if (Number.isFinite(f) && Math.abs(f - g) > STEP) continue;
        }
        out.push(e);
      }
    doors.set(st.id, out);
  }
  const nearestV = (p: V2) => {
    let best = 0;
    let bd = Infinity;
    for (let v = 0; v < nv; v++) {
      const d = (vx(v) - p[0]) ** 2 + (vy(v) - p[1]) ** 2;
      if (d < bd) ((bd = d), (best = v));
    }
    return best;
  };
  const storesV = nearestV(io.stores);
  const centreV = nearestV(io.centre);
  // ---- the drawn paths: Dijkstra over the walkable edges
  const adj: number[][] = Array.from({ length: nv }, () => []);
  for (let e = 0; e < ne; e++) {
    if (cut[e] || inner[e]) continue;
    adj[E[e * 2]].push(e);
    adj[E[e * 2 + 1]].push(e);
  }
  const cost = (e: number) => len[e] * (steep[e] ? 3 : 1) * (kind[e] ? 0.5 : 1);
  /** the shortest walk from `from` to any vertex `stop` accepts: the edges, from its end back (null: none) */
  const walk = (from: number[], stop: (v: number) => boolean): number[] | null => {
    const dist = new Float64Array(nv).fill(Infinity);
    const prev = new Int32Array(nv).fill(-1);
    const heap: [number, number][] = [];
    const push = (d: number, v: number) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (const v of from) ((dist[v] = 0), push(0, v));
    while (heap.length) {
      const [d, v] = pop();
      if (d > dist[v]) continue;
      if (stop(v)) {
        const path: number[] = [];
        let u = v;
        while (prev[u] >= 0) {
          const e = prev[u];
          path.push(e);
          u = E[e * 2] === u ? E[e * 2 + 1] : E[e * 2];
        }
        return path;
      }
      for (const e of adj[v]) {
        const w = E[e * 2] === v ? E[e * 2 + 1] : E[e * 2];
        const nd = d + cost(e);
        if (nd < dist[w]) ((dist[w] = nd), (prev[w] = e), push(nd, w));
      }
    }
    return null;
  };
  const onNet = new Uint8Array(nv);
  onNet[centreV] = 1;
  const lay = (path: number[] | null, k: number) => {
    for (const e of path ?? []) {
      kind[e] = Math.max(kind[e], k);
      onNet[E[e * 2]] = onNet[E[e * 2 + 1]] = 1;
    }
  };
  // main streets: the middle to each gate's far side and to each road out
  const targets: number[] = [];
  for (let c = 0; c < grid.count; c++) {
    if (!plan.gate[c]) continue;
    let far = -1;
    let fd = -1;
    for (let k = 0; k < 4; k++) {
      const v = grid.quads[c * 4 + k];
      const d = Math.hypot(vx(v) - io.centre[0], vy(v) - io.centre[1]);
      if (d > fd) ((fd = d), (far = v));
    }
    targets.push(far);
  }
  for (const r of io.roadsOut ?? []) {
    let best: V2 | null = null;
    let bd = Infinity;
    for (const q of r) {
      const d = Math.hypot(q[0] - io.centre[0], q[1] - io.centre[1]);
      if (d < bd && q[0] >= 0 && q[1] >= 0) ((bd = d), (best = q));
    }
    if (best) targets.push(nearestV(best));
  }
  // the spokes: to a vertex a cell past the town's last structure, in each direction (dry ground)
  if (io.spokes) {
    let R = 0;
    for (const st of plan.structures())
      for (const c of st.cells.keys()) {
        const [x, y] = grid.centre(c);
        R = Math.max(R, Math.hypot(x - io.centre[0], y - io.centre[1]));
      }
    R += 8;
    for (let k = 0; k < io.spokes; k++) {
      const a = (io.spokeAngle ?? 0) + (2 * Math.PI * k) / io.spokes;
      const p: V2 = [io.centre[0] + Math.cos(a) * R, io.centre[1] + Math.sin(a) * R];
      let best = -1;
      let bd = Infinity;
      for (let v = 0; v < nv; v++) {
        if (!adj[v].length || io.wet(vx(v), vy(v))) continue;
        const d = (vx(v) - p[0]) ** 2 + (vy(v) - p[1]) ** 2;
        if (d < bd) ((bd = d), (best = v));
      }
      if (best >= 0) targets.push(best);
    }
  }
  for (const t of targets) lay(walk([t], (v) => onNet[v] === 1), PATH_MAIN);
  // lanes: each structure's nearest door to the network, nearest first
  const door = new Map<number, number>();
  const order = [...doors.entries()].filter(([, ds]) => ds.length).map(([id, ds]) => {
    const st = plan.structure(id)!;
    const [x, y] = grid.centre(st.cells.keys().next().value as number);
    return { id, ds, d: Math.hypot(x - io.centre[0], y - io.centre[1]) };
  });
  order.sort((a, b) => a.d - b.d);
  for (const { id, ds } of order) {
    const starts = new Set<number>();
    for (const e of ds) if (!cut[e]) (starts.add(E[e * 2]), starts.add(E[e * 2 + 1]));
    if (!starts.size) continue;
    const path = walk([...starts], (v) => onNet[v] === 1);
    if (!path) continue;
    // its door: the door edge at the walk's start
    const startV = path.length ? (() => {
      const e = path[path.length - 1];
      // (the walk's first vertex: the end of its last-listed edge not shared with the edge before it)
      const prevE = path.length > 1 ? path[path.length - 2] : -1;
      const a = E[e * 2];
      const b = E[e * 2 + 1];
      if (prevE < 0) return starts.has(a) ? a : b;
      return a === E[prevE * 2] || a === E[prevE * 2 + 1] ? b : a;
    })() : [...starts].find((v) => onNet[v])!;
    const d = ds.find((e) => !cut[e] && (E[e * 2] === startV || E[e * 2 + 1] === startV)) ?? ds[0];
    door.set(id, d);
    kind[d] = Math.max(kind[d], PATH_LANE);
    onNet[E[d * 2]] = onNet[E[d * 2 + 1]] = 1;
    lay(path, PATH_LANE);
  }
  const reach = reachOf(site, { E, C, cut, inner, doors, storesV, nv, edgeOf }, 0);
  const counts = { wall: 0, water: 0, cliff: 0 };
  for (let e = 0; e < ne; e++) {
    if (cut[e] & CUT_WALL) counts.wall++;
    if (cut[e] & CUT_WATER) counts.water++;
    if (cut[e] & CUT_CLIFF) counts.cliff++;
  }
  reach.edges = { all: ne, cut: counts, steep: steep.reduce((s, x) => s + x, 0), main: kind.reduce((s, k) => s + (k === PATH_MAIN ? 1 : 0), 0), lane: kind.reduce((s, k) => s + (k === PATH_LANE ? 1 : 0), 0) };
  reach.ms = performance.now() - t0;
  return { ends: E, cells: C, edgeOf, length: len, cut, steep, inner, kind, doors, door, storesV, centreV, reach };
}

/**
 * Reach: a union-find over the edges' vertices — every walkable edge joins its ends; a structure joins its doors at
 * grade — with `lift` cuts lifted (and, 8, every perimeter edge a door): a structure is reached when a door's vertex is
 * in the stores' component. Without lifts, what isn't reached is asked again with each lifted in turn: the first that
 * reaches it is why.
 */
function reachOf(site: EdgeNetSite, n: { E: Int32Array; C: Int32Array; cut: Uint8Array; inner: Uint8Array; doors: Map<number, number[]>; storesV: number; nv: number; edgeOf: Int32Array }, lift: number): ReachReport {
  const { plan } = site;
  const solve = (lift: number) => {
    const u = new Union(n.nv);
    for (let e = 0; e < n.cut.length; e++) if (!n.inner[e] && !(n.cut[e] & ~lift)) u.union(n.E[e * 2], n.E[e * 2 + 1]);
    const doorsOf = (id: number): number[] => {
      if (!(lift & 8)) return n.doors.get(id) ?? [];
      const st = plan.structure(id)!;
      const out: number[] = [];
      for (const c of st.cells.keys()) for (let s = 0; s < 4; s++) if (!n.inner[n.edgeOf[c * 4 + s]]) out.push(n.edgeOf[c * 4 + s]);
      return out;
    };
    for (const [id] of n.doors) {
      const ds = doorsOf(id);
      for (let k = 1; k < ds.length; k++) u.union(n.E[ds[0] * 2], n.E[ds[k] * 2]);
      for (const e of ds) u.union(n.E[e * 2], n.E[e * 2 + 1]);
    }
    const root = u.find(n.storesV);
    const reached = new Set<number>();
    for (const [id] of n.doors) if (doorsOf(id).some((e) => u.find(n.E[e * 2]) === root)) reached.add(id);
    return reached;
  };
  const base = solve(lift);
  const ids = [...n.doors.keys()];
  const out: ReachReport['out'] = [];
  const lifts: [number, Why][] = [
    [CUT_WALL, 'wall'],
    [CUT_WATER, 'water'],
    [CUT_CLIFF, 'cliff'],
    [8, 'terrace'],
  ];
  const tried = new Map<number, Set<number>>();
  for (const id of ids) {
    if (base.has(id)) continue;
    let why: Why = 'apart';
    for (const [l, w] of lifts) {
      if (!tried.has(l)) tried.set(l, solve(lift | l));
      if (tried.get(l)!.has(id)) {
        why = w;
        break;
      }
    }
    out.push({ id, type: plan.structure(id)!.type, why });
  }
  return {
    structures: ids.length,
    reached: base.size,
    out,
    noDoorAtGrade: ids.filter((id) => !(n.doors.get(id) ?? []).length).length,
    edges: { all: 0, cut: { wall: 0, water: 0, cliff: 0 }, steep: 0, main: 0, lane: 0 },
    ms: 0,
  };
}
