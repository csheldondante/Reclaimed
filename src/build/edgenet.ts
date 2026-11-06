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
/**
 * (round 128p) A door's step out onto its lane: within the lane's inset by a column's reach (a hex column's corner is
 * 1/√3 m from its middle), so the column the step falls in is never a building's (solid.ts leaves the inset open) — a
 * unit put there stands on the ground, not on the roof next door.
 */
export const DOOR_STEP = INSET[PATH_LANE] - 1 / Math.sqrt(3);
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
  /** (step 2) the main roads' cells (build/curveroad.ts adaptToCurve): walkable ground, their edges main streets, paved */
  roads?: readonly number[];
  /** (DECISIONS round 128p: a structure with no other within this many cells grows a road from the nearest major one,
   *  not a lane) the far rule's n; absent: every structure gets a lane */
  far?: number;
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
  /** the main roads' cells (under the road: its verge) and the structures the far rule leaves to a grown road */
  roads: Set<number>;
  /** the main roads' curves (box-local), drawn smooth over their cells (townroads.ts sets them) */
  curves: [number, number][][];
  far: number[];
  /** the stores' and the middle's vertices */
  storesV: number;
  centreV: number;
  reach: ReachReport;
  /** what the next relay (an edit's) starts from */
  carry?: EdgeNetCarry;
}

export interface ReachReport {
  structures: number;
  reached: number;
  /** what isn't, and why (the cut whose lifting reaches it) */
  out: { id: number; type: StructureType; why: Why }[];
  /** structures with no door at grade at all (a terrace: stairs at its door, at generation) */
  noDoorAtGrade: number;
  edges: {
    all: number;
    cut: { wall: number; water: number; cliff: number };
    steep: number;
    main: number;
    lane: number;
  };
  ms: number;
  /** where the time went (ms) */
  phases?: Record<string, number>;
  /** (round 128p) laid again where an edit touched (`edit`) or across the whole town (`whole`) */
  relaid?: 'edit' | 'whole';
  /** the structures reached; per vertex its component's root, and the stores' (a fix looks for what joins them) */
  reachedIds: Set<number>;
  comp: Int32Array;
  storesRoot: number;
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

/** The grid's edges: each cell side once (a neighbour's same side shares it) — its ends, the cells either side (-1 the
 *  rim), and per cell side its edge. */
export function edgesOf(grid: { count: number; verts: ArrayLike<number>; quads: ArrayLike<number> }): { ends: Int32Array; cells: Int32Array; edgeOf: Int32Array } {
  const nv = grid.verts.length / 2;
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
  return { ends: Int32Array.from(ends), cells: Int32Array.from(cells), edgeOf };
}

/** What the view draws of the paths (build/edgeview.ts): the edges, each one's drawn kind, the verge, the curves. */
export type PathsView = Pick<EdgeNet, 'ends' | 'cells' | 'edgeOf' | 'kind' | 'roads' | 'curves'>;

/** The paths a plan's layout carries (`layout.roads`: generation's, an edit's), as the view draws them. */
export function pathsViewOf(grid: { count: number; verts: ArrayLike<number>; quads: ArrayLike<number> }, roads: { verge: number[]; sides: number[]; curves: { pts: [number, number][] }[] }): PathsView {
  const { ends, cells, edgeOf } = edgesOf(grid);
  const kind = new Uint8Array(ends.length / 2);
  for (let i = 0; i < edgeOf.length && i < roads.sides.length; i++) kind[edgeOf[i]] = Math.max(kind[edgeOf[i]], roads.sides[i]);
  return { ends, cells, edgeOf, kind, roads: new Set(roads.verge), curves: roads.curves.map((c) => c.pts) };
}

/**
 * What of the network doesn't change while the grid's vertices and the land stand (an edit's relay keeps it: the
 * cost of a placement is then the structures' part only): the edges, their lengths, the land's cuts (water, a cliff)
 * and stairs, the vertices' ground. Keyed by the grid's `version` (QuadGrid.moveVerts bumps it).
 */
export interface EdgeStatics {
  version: number;
  ends: Int32Array;
  cells: Int32Array;
  edgeOf: Int32Array;
  len: Float32Array;
  /** CUT_WATER | CUT_CLIFF of the land; steep (stairs) */
  land: Uint8Array;
  steep: Uint8Array;
  vg: Float64Array;
}

export function edgeStatics(grid: EdgeNetSite['grid'] & { version?: number }, io: Pick<EdgeNetIO, 'ground' | 'wet'>): EdgeStatics {
  const nv = grid.verts.length / 2;
  const vx = (v: number) => grid.verts[v * 2];
  const vy = (v: number) => grid.verts[v * 2 + 1];
  const vg = new Float64Array(nv);
  for (let v = 0; v < nv; v++) vg[v] = io.ground(vx(v), vy(v));
  const { ends: E, cells, edgeOf } = edgesOf(grid);
  const ne = E.length / 2;
  const len = new Float32Array(ne);
  const land = new Uint8Array(ne);
  const steep = new Uint8Array(ne);
  // (water at a vertex: asked once a vertex)
  const wv = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) wv[v] = io.wet(vx(v), vy(v)) ? 1 : 0;
  for (let e = 0; e < ne; e++) {
    const a = E[e * 2];
    const b = E[e * 2 + 1];
    len[e] = Math.hypot(vx(b) - vx(a), vy(b) - vy(a));
    if (wv[a] || wv[b] || io.wet((vx(a) + vx(b)) / 2, (vy(a) + vy(b)) / 2)) land[e] |= CUT_WATER;
    const rise = Math.abs(vg[b] - vg[a]) / Math.max(len[e], 1e-6);
    if (rise > SLOPE) land[e] |= CUT_CLIFF;
    else if (rise > ROAD_GRADE) steep[e] = 1;
  }
  return { version: grid.version ?? 0, ends: E, cells, edgeOf, len, land, steep, vg };
}

/**
 * (round 128p: an edit relays only what it touched) What a net carries to the next, so an edit pays for the area it
 * touched: the walkable edges at each vertex, the main streets' kinds (the verge's, the gates' streets'), each
 * structure's lane (its edges and the vertex it joined the network at) and how many lanes use each edge, the walks'
 * scratch arrays.
 */
export interface EdgeNetCarry {
  adj: number[][];
  mainKind: Uint8Array;
  laneUse: Uint16Array;
  lanes: Map<number, { edges: number[]; join: number }>;
  dist: Float64Array;
  prev: Int32Array;
  seen: Uint32Array;
  walkNo: number;
}

/** an edit's relay: the net as last laid and the cells the edit changed (TownPlan.takeChanged: painted, erased, their
 *  neighbours) */
export interface EdgeNetPrev {
  net: EdgeNet;
  changed: readonly number[];
}

export function edgeNetOf(site: EdgeNetSite, io: EdgeNetIO, statics?: EdgeStatics, prev?: EdgeNetPrev): EdgeNet {
  const t0 = performance.now();
  const { plan, grid } = site;
  const nv = grid.verts.length / 2;
  const vx = (v: number) => grid.verts[v * 2];
  const vy = (v: number) => grid.verts[v * 2 + 1];
  const lapT: Record<string, number> = {};
  let lapAt = performance.now();
  const lap = (k: string) => {
    const n = performance.now();
    lapT[k] = +(n - lapAt).toFixed(2);
    lapAt = n;
  };
  const S = statics && statics.version === ((grid as { version?: number }).version ?? 0) && statics.ends.length / 2 > 0 ? statics : edgeStatics(grid, io);
  lap('statics');
  const { ends: E, cells: C, edgeOf, len, vg } = S;
  const ne = E.length / 2;
  const steep = S.steep;
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
  const roads = new Set(io.roads ?? []);
  /** an edge's cut and whether it's inside a block, from the plan as it is (the land's cuts kept; a road spans water) */
  const cutOf = (e: number): number => {
    const c0 = C[e * 2];
    const c1 = C[e * 2 + 1];
    let k = S.land[e];
    if (isWall(c0) && isWall(c1)) k |= CUT_WALL;
    if (roads.has(c0) || roads.has(c1)) k &= ~CUT_WATER;
    return k;
  };
  const innerOf = (e: number): number => {
    const c0 = C[e * 2];
    const s0 = sid(c0);
    return s0 && s0 === sid(C[e * 2 + 1]) && solid(c0) ? 1 : 0;
  };
  // (the stores and the middle on the ground between things: a vertex with an edge not inside a structure — one inside a
  // building's cells, a dome's middle, joins nothing)
  let openOf: Uint8Array | null = null;
  let openFor: Uint8Array | null = null;
  const nearestOpenV = (p: V2, inner: Uint8Array) => {
    if (openFor !== inner) {
      openFor = inner;
      openOf = new Uint8Array(nv);
      for (let e = 0; e < ne; e++) if (!inner[e]) openOf[E[e * 2]] = openOf[E[e * 2 + 1]] = 1;
    }
    const open = openOf!;
    let best = 0;
    let bd = Infinity;
    for (let v = 0; v < nv; v++) {
      if (!open[v]) continue;
      const d = (vx(v) - p[0]) ** 2 + (vy(v) - p[1]) ** 2;
      if (d < bd) ((bd = d), (best = v));
    }
    return best;
  };
  /** a structure's doors at grade: a perimeter edge whose ground lies within a step of its cell's floor (a yard: any) */
  const doorsOfStructure = (st: { id: number; cells: Map<number, unknown> }, inner: Uint8Array): number[] => {
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
    return out;
  };
  /** the far rule for one structure: no other (not a wall) within io.far cells, and not beside a road */
  const isFar = (st: { id: number; cells: Map<number, unknown> }): boolean => {
    if (io.far === undefined) return false;
    const start = [...st.cells.keys()];
    if (start.some((c) => [0, 1, 2, 3].some((s) => roads.has(grid.nbr[c * 4 + s])))) return false;
    const seen = new Map<number, number>(start.map((c) => [c, 0]));
    const q = [...start];
    while (q.length) {
      const c = q.shift()!;
      const d = seen.get(c)!;
      if (d >= io.far) continue;
      for (let s = 0; s < 4; s++) {
        const n = grid.nbr[c * 4 + s];
        if (n < 0 || seen.has(n)) continue;
        seen.set(n, d + 1);
        const o = sid(n);
        if (o && o !== st.id && plan.defs[plan.structure(o)!.type].form !== 'wall') return false;
        q.push(n);
      }
    }
    return true;
  };

  // ---- an edit's relay where it can be one: the same land and verge, the same stores and middle, no wall or gate and
  // no main street among what it touched — else the whole town again
  const P = prev?.net;
  const carry0 = P?.carry;
  let inc = !!(P && carry0 && P.ends === E && P.roads.size === roads.size && [...roads].every((c) => P.roads.has(c)));
  const touchedEdges = new Set<number>();
  if (inc)
    for (const c of prev!.changed) {
      if (c < 0 || c >= grid.count) continue;
      for (let s = 0; s < 4; s++) touchedEdges.add(edgeOf[c * 4 + s]);
    }
  if (inc)
    for (const e of touchedEdges) {
      const k = cutOf(e);
      if ((k | P!.cut[e]) & CUT_WALL || [C[e * 2], C[e * 2 + 1]].some((c) => c >= 0 && formOf(c) === 'wall')) inc = false;
      else if (carry0!.mainKind[e] && (k || innerOf(e))) inc = false;
      if (!inc) break;
    }

  let cut: Uint8Array;
  let inner: Uint8Array;
  let kind: Uint8Array;
  let doors: Map<number, number[]>;
  let storesV: number;
  let centreV: number;
  let far: number[];
  let carry: EdgeNetCarry;
  const door = new Map<number, number>();
  if (inc) {
    cut = Uint8Array.from(P!.cut);
    inner = Uint8Array.from(P!.inner);
    const adj = carry0!.adj;
    for (const e of touchedEdges) {
      const was = !P!.cut[e] && !P!.inner[e];
      cut[e] = cutOf(e);
      inner[e] = innerOf(e);
      const now = !cut[e] && !inner[e];
      if (was === now) continue;
      for (const v of [E[e * 2], E[e * 2 + 1]]) {
        if (now) adj[v].push(e);
        else adj[v].splice(adj[v].indexOf(e), 1);
      }
    }
    storesV = nearestOpenV(io.stores, inner);
    centreV = nearestOpenV(io.centre, inner);
    if (storesV !== P!.storesV || centreV !== P!.centreV) inc = false;
    carry = carry0!;
  } else {
    cut = new Uint8Array(ne);
    inner = new Uint8Array(ne);
    for (let e = 0; e < ne; e++) {
      cut[e] = cutOf(e);
      inner[e] = innerOf(e);
    }
    storesV = nearestOpenV(io.stores, inner);
    centreV = nearestOpenV(io.centre, inner);
    const adj: number[][] = Array.from({ length: nv }, () => []);
    for (let e = 0; e < ne; e++) {
      if (cut[e] || inner[e]) continue;
      adj[E[e * 2]].push(e);
      adj[E[e * 2 + 1]].push(e);
    }
    carry = { adj, mainKind: new Uint8Array(ne), laneUse: new Uint16Array(ne), lanes: new Map(), dist: new Float64Array(nv), prev: new Int32Array(nv), seen: new Uint32Array(nv), walkNo: 0 };
  }
  // (the stores or the middle moved by the edit — a building over its vertex: the whole town again)
  if (!inc && P && carry === carry0) return edgeNetOf(site, io, S);
  lap('plan');

  // ---- the walks: Dijkstra over the walkable edges (one set of arrays for every walk: a vertex's distance counts only if
  // it was touched this walk — `seen`)
  const { adj } = carry;
  const cost = (e: number) => len[e] * (steep[e] ? 3 : 1) * (kind[e] ? 0.5 : 1);
  /** the shortest walk from `from` to any vertex `stop` accepts: the edges, from its end back, and that end (null: none) */
  const walk = (from: number[], stop: (v: number) => boolean): { path: number[]; at: number } | null => {
    const { dist, prev: pv, seen } = carry;
    const no = ++carry.walkNo;
    const D = (v: number) => (seen[v] === no ? dist[v] : Infinity);
    const setD = (v: number, d: number, p: number) => {
      seen[v] = no;
      dist[v] = d;
      pv[v] = p;
    };
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
    for (const v of from) (setD(v, 0, -1), push(0, v));
    while (heap.length) {
      const [d, v] = pop();
      if (d > D(v)) continue;
      if (stop(v)) {
        const path: number[] = [];
        let u = v;
        while (seen[u] === no && pv[u] >= 0) {
          const e = pv[u];
          path.push(e);
          u = E[e * 2] === u ? E[e * 2 + 1] : E[e * 2];
        }
        return { path, at: v };
      }
      for (const e of adj[v]) {
        const w = E[e * 2] === v ? E[e * 2 + 1] : E[e * 2];
        const nd = d + cost(e);
        if (nd < D(w)) (setD(w, nd, e), push(nd, w));
      }
    }
    return null;
  };
  const onNet = new Uint8Array(nv);
  const { mainKind, laneUse, lanes } = carry;

  if (inc) {
    // ---- the doors and the far rule again for the structures the edit touched (on the changed cells, or beside them:
    // a door's way out may have changed); the rest kept
    const touched = new Set<number>();
    for (const c of prev!.changed) {
      if (c < 0 || c >= grid.count) continue;
      const s = sid(c);
      if (s) touched.add(s);
      for (let k = 0; k < 4; k++) {
        const n = sid(grid.nbr[c * 4 + k]);
        if (n) touched.add(n);
      }
    }
    doors = new Map();
    for (const st of plan.structures()) {
      if (plan.defs[st.type].form === 'wall') continue;
      doors.set(st.id, touched.has(st.id) || !P!.doors.has(st.id) ? doorsOfStructure(st, inner) : P!.doors.get(st.id)!);
    }
    far = P!.far.filter((id) => doors.has(id) && !touched.has(id));
    for (const id of touched) {
      const st = plan.structure(id);
      if (st && doors.has(id) && isFar(st)) far.push(id);
    }
    // ---- the lanes the edit broke: the touched structures', those gone, those over an edge now shut — and, again until
    // none, those whose lane joined the network where it no longer is
    const drop = (id: number) => {
      const l = lanes.get(id);
      if (!l) return;
      for (const e of l.edges) laneUse[e]--;
      lanes.delete(id);
    };
    for (const id of [...lanes.keys()]) {
      const l = lanes.get(id)!;
      if (touched.has(id) || !doors.has(id) || l.edges.some((e) => cut[e] || inner[e])) drop(id);
    }
    const mainAt = new Uint8Array(nv);
    mainAt[centreV] = 1;
    for (let e = 0; e < ne; e++) if (mainKind[e]) mainAt[E[e * 2]] = mainAt[E[e * 2 + 1]] = 1;
    for (let again = true; again; ) {
      again = false;
      for (const [id, l] of lanes) {
        if (mainAt[l.join]) continue;
        const own = new Set(l.edges);
        if (adj[l.join].some((e) => laneUse[e] > (own.has(e) ? 1 : 0))) continue;
        drop(id);
        again = true;
      }
    }
    kind = Uint8Array.from(mainKind);
    for (let e = 0; e < ne; e++) {
      if (laneUse[e]) kind[e] = Math.max(kind[e], PATH_LANE);
      if (kind[e]) onNet[E[e * 2]] = onNet[E[e * 2 + 1]] = 1;
    }
    onNet[centreV] = 1;
    for (const [id, l] of lanes) door.set(id, l.edges[0]);
    lap('kept');
  } else {
    doors = new Map();
    for (const st of plan.structures()) {
      if (plan.defs[st.type].form === 'wall') continue;
      doors.set(st.id, doorsOfStructure(st, inner));
    }
    lap('doors');
    kind = new Uint8Array(ne);
    for (const c of roads)
      for (let s = 0; s < 4; s++) {
        const e = edgeOf[c * 4 + s];
        if (!cut[e]) kind[e] = PATH_MAIN;
      }
    onNet[centreV] = 1;
    for (let e = 0; e < ne; e++) if (kind[e]) onNet[E[e * 2]] = onNet[E[e * 2 + 1]] = 1;
    const lay = (path: number[] | undefined) => {
      for (const e of path ?? []) {
        kind[e] = PATH_MAIN;
        onNet[E[e * 2]] = onNet[E[e * 2 + 1]] = 1;
      }
    };
    // main streets: the middle to each gate's far side and to each road out
    const targets: number[] = [];
    for (let c = 0; c < grid.count; c++) {
      if (!plan.gate[c]) continue;
      let fv = -1;
      let fd = -1;
      for (let k = 0; k < 4; k++) {
        const v = grid.quads[c * 4 + k];
        const d = Math.hypot(vx(v) - io.centre[0], vy(v) - io.centre[1]);
        if (d > fd) ((fd = d), (fv = v));
      }
      targets.push(fv);
    }
    for (const r of io.roadsOut ?? []) {
      let best: V2 | null = null;
      let bd = Infinity;
      for (const q of r) {
        const d = Math.hypot(q[0] - io.centre[0], q[1] - io.centre[1]);
        if (d < bd && q[0] >= 0 && q[1] >= 0) ((bd = d), (best = q));
      }
      if (best) targets.push(nearestOpenV(best, inner));
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
    for (const t of targets) lay(walk([t], (v) => onNet[v] === 1)?.path);
    mainKind.set(kind);
    lap('mains');
    // the far rule: a structure with no other within n cells (and not on a road yet) gets a grown road, not a lane
    far = [];
    for (const st of plan.structures()) if (plan.defs[st.type].form !== 'wall' && isFar(st)) far.push(st.id);
    lap('far');
  }

  // ---- lanes: each structure without one, its nearest door to the network, nearest the middle first
  const farSet = new Set(far);
  const order = [...doors.entries()]
    .filter(([id, ds]) => ds.length && !lanes.has(id) && !farSet.has(id))
    .map(([id, ds]) => {
      const st = plan.structure(id)!;
      const [x, y] = grid.centre(st.cells.keys().next().value as number);
      return { id, ds, d: Math.hypot(x - io.centre[0], y - io.centre[1]) };
    });
  order.sort((a, b) => a.d - b.d);
  for (const { id, ds } of order) {
    // (its doorway onto open ground where it has one — a door into the next house only when it's shut in by them)
    const outside = (e: number) => [C[e * 2], C[e * 2 + 1]].every((c) => c < 0 || !plan.structureAt(c) || plan.structureAt(c)!.id === id);
    const free = ds.filter((e) => !cut[e]);
    const ways = free.some(outside) ? free.filter(outside) : free;
    const starts = new Set<number>();
    for (const e of ways) (starts.add(E[e * 2]), starts.add(E[e * 2 + 1]));
    if (!starts.size) continue;
    const w = walk([...starts], (v) => onNet[v] === 1);
    if (!w) continue;
    const { path } = w;
    // its door: the door edge at the walk's start
    const startV = path.length
      ? (() => {
          const e = path[path.length - 1];
          // (the walk's first vertex: the end of its last-listed edge not shared with the edge before it)
          const prevE = path.length > 1 ? path[path.length - 2] : -1;
          const a = E[e * 2];
          const b = E[e * 2 + 1];
          if (prevE < 0) return starts.has(a) ? a : b;
          return a === E[prevE * 2] || a === E[prevE * 2 + 1] ? b : a;
        })()
      : w.at;
    const d = ways.find((e) => E[e * 2] === startV || E[e * 2 + 1] === startV) ?? ways[0];
    door.set(id, d);
    const edges = [d, ...path.filter((e) => e !== d)];
    for (const e of edges) {
      laneUse[e]++;
      kind[e] = Math.max(kind[e], PATH_LANE);
      onNet[E[e * 2]] = onNet[E[e * 2 + 1]] = 1;
    }
    lanes.set(id, { edges, join: w.at });
  }
  lap('lanes');
  const reach = reachOf(site, { E, C, cut, inner, doors, storesV, nv, edgeOf }, 0);
  const counts = { wall: 0, water: 0, cliff: 0 };
  let nSteep = 0;
  let nMain = 0;
  let nLane = 0;
  for (let e = 0; e < ne; e++) {
    if (cut[e] & CUT_WALL) counts.wall++;
    if (cut[e] & CUT_WATER) counts.water++;
    if (cut[e] & CUT_CLIFF) counts.cliff++;
    nSteep += steep[e];
    if (kind[e] === PATH_MAIN) nMain++;
    else if (kind[e] === PATH_LANE) nLane++;
  }
  reach.edges = { all: ne, cut: counts, steep: nSteep, main: nMain, lane: nLane };
  lap('reach');
  reach.ms = performance.now() - t0;
  reach.phases = lapT;
  reach.relaid = inc ? 'edit' : 'whole';
  return {
    ends: E,
    cells: C,
    edgeOf,
    length: len,
    cut,
    steep,
    inner,
    kind,
    doors,
    door,
    roads,
    curves: [],
    far,
    storesV,
    centreV,
    reach,
    carry,
  };
}

/**
 * Reach: a union-find over the edges' vertices — every walkable edge joins its ends; a structure joins its doors at
 * grade — with `lift` cuts lifted (and, 8, every perimeter edge a door): a structure is reached when a door's vertex is
 * in the stores' component. Without lifts, what isn't reached is asked again with each lifted in turn: the first that
 * reaches it is why.
 */
function reachOf(
  site: EdgeNetSite,
  n: {
    E: Int32Array;
    C: Int32Array;
    cut: Uint8Array;
    inner: Uint8Array;
    doors: Map<number, number[]>;
    storesV: number;
    nv: number;
    edgeOf: Int32Array;
  },
  lift: number,
): ReachReport {
  const { plan } = site;
  const solve = (lift: number) => {
    const u = new Union(n.nv);
    for (let e = 0; e < n.cut.length; e++) if (!n.inner[e] && !(n.cut[e] & ~lift)) u.union(n.E[e * 2], n.E[e * 2 + 1]);
    const doorsOf = (id: number): number[] => {
      if (!(lift & 8)) return n.doors.get(id) ?? [];
      const st = plan.structure(id)!;
      const out: number[] = [];
      for (const c of st.cells.keys())
        for (let s = 0; s < 4; s++) if (!n.inner[n.edgeOf[c * 4 + s]]) out.push(n.edgeOf[c * 4 + s]);
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
    return Object.assign(reached, { u, root });
  };
  const base = solve(lift);
  const comp = new Int32Array(n.nv);
  for (let v = 0; v < n.nv; v++) comp[v] = base.u.find(v);
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
    reachedIds: new Set(base),
    comp,
    storesRoot: base.root,
    out,
    noDoorAtGrade: ids.filter((id) => !(n.doors.get(id) ?? []).length).length,
    edges: {
      all: 0,
      cut: { wall: 0, water: 0, cliff: 0 },
      steep: 0,
      main: 0,
      lane: 0,
    },
    ms: 0,
  };
}
