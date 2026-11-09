// The town's route graph as the GPU walks it (DA-A22, docs/design/ROUTES_ON_GPU.md; build/routegpu.ts,
// shaders/townroute.wgsl). Pure, the CPU's small half — nothing here reads the land:
//  - RouteGraph: the grid's vertices and edges (each cell side once: edgesOf), each vertex's box column and each edge's
//    middle's, the edges' lengths, per vertex its edges (CSR). Static while the grid's vertices stand
//    (QuadGrid.version): uploaded once.
//  - RoutePlan: the authored part — per edge whether a wall stands across it (two wall cells, neither a gate), whether
//    it's inside a block (not a path), whether a main road's verge is beside it (a main street; it spans water: its
//    bridge), whether a structure stands beside it; each structure's perimeter edges (its door candidates) with its
//    floor (world z; a yard none) and whether they open onto open ground; the far rule's structures (a road grown to
//    them, no lane); the gates' far corners (main streets go out to them); the wall cells (where a gate could go); the
//    stores' and the middle's vertices. Made again on a plan edit; bytes per edge and per candidate.
// What the land says — the ground at each end and the middle, water over it, a drop past SLOPE, a door at grade, which
// paths are laid where — is the GPU's.
import type { TownPlan } from './plan';
import { cellAt } from '../world/lattice';

type V2 = [number, number];

/** the plan's bits per edge (townroute.wgsl RB_*) */
export const PLAN_WALL = 1;
export const PLAN_INNER = 2;
export const PLAN_SPAN = 4;
export const PLAN_BUILT = 8;

/** a box column (its lattice k, row) packed for the kernel (townroute.wgsl groundCol): biased so a rim vertex just
 *  outside the box still packs */
export function packCol(k: number, r: number): number {
  return ((k + 32768) & 0xffff) | (((r + 32768) & 0xffff) << 16);
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

export interface RouteGraph {
  version: number;
  nv: number;
  ne: number;
  /** per edge its two vertices, and the cells either side (-1 the rim); per cell side its edge */
  ends: Int32Array;
  cells: Int32Array;
  edgeOf: Int32Array;
  len: Float32Array;
  /** per vertex its box column (packCol), then per edge its middle's */
  colOf: Uint32Array;
  /** per vertex its first edge in the list after (nv + 1 words), then the edges */
  csr: Uint32Array;
  /** per vertex box-local x, y */
  verts: ArrayLike<number>;
  quads: ArrayLike<number>;
}

export function routeGraphOf(grid: { count: number; verts: ArrayLike<number>; quads: ArrayLike<number>; version?: number }): RouteGraph {
  const { ends, cells, edgeOf } = edgesOf(grid);
  const nv = grid.verts.length / 2;
  const ne = ends.length / 2;
  const V = grid.verts;
  const colOf = new Uint32Array(nv + ne);
  const len = new Float32Array(ne);
  for (let v = 0; v < nv; v++) colOf[v] = packCol(...cellAt(V[v * 2], V[v * 2 + 1]));
  const deg = new Uint32Array(nv);
  for (let e = 0; e < ne; e++) {
    const a = ends[e * 2];
    const b = ends[e * 2 + 1];
    deg[a]++;
    deg[b]++;
    len[e] = Math.hypot(V[b * 2] - V[a * 2], V[b * 2 + 1] - V[a * 2 + 1]);
    colOf[nv + e] = packCol(...cellAt((V[a * 2] + V[b * 2]) / 2, (V[a * 2 + 1] + V[b * 2 + 1]) / 2));
  }
  const csr = new Uint32Array(nv + 1 + ne * 2);
  for (let v = 0; v < nv; v++) csr[v + 1] = csr[v] + deg[v];
  const at = csr.slice(0, nv);
  for (let e = 0; e < ne; e++) {
    csr[nv + 1 + at[ends[e * 2]]++] = e;
    csr[nv + 1 + at[ends[e * 2 + 1]]++] = e;
  }
  return { version: grid.version ?? 0, nv, ne, ends, cells, edgeOf, len, colOf, csr, verts: V, quads: grid.quads };
}

export interface RoutePlan {
  /** per edge PLAN_* bits */
  edgeBits: Uint32Array;
  /** per door candidate four words: the edge, the structure's index (in `ids`), its floor (world z, f32 bits; NaN a
   *  yard), 1 when it opens onto open ground */
  doors: Uint32Array;
  /** per structure four words: its first door candidate, how many, bit 0 far, bit 1 solid; its floor (f32 bits) */
  info: Uint32Array;
  /** the gates' far corners (a vertex each), then per wall cell its cell and four corners */
  jobs: Uint32Array;
  targets: number;
  walls: number;
  /** the structures (not walls) in answer order, and the far rule's */
  ids: number[];
  far: number[];
  storesV: number;
  centreV: number;
}

export interface RoutePlanSite {
  plan: TownPlan;
  grid: { count: number; nbr: ArrayLike<number>; centre(c: number): [number, number] };
  /** per cell its ground floor (world z; NaN no block): Town.base */
  floor(c: number): number;
}

export interface RoutePlanIO {
  /** the main roads' verge cells */
  roads: ReadonlySet<number>;
  /** box-local: the stores and the town's middle */
  stores: V2;
  centre: V2;
  /** the far rule's n (DECISIONS round 128p: a structure with no other within this many cells gets a road grown from
   *  the nearest major one, not a lane); absent: every structure gets a lane */
  far?: number;
}

/** The authored part of the graph from the plan as it stands. */
export function routePlanOf(site: RoutePlanSite, g: RouteGraph, io: RoutePlanIO): RoutePlan {
  const { plan, grid } = site;
  const { roads } = io;
  const formOf = (c: number) => {
    const t = c < 0 ? null : plan.typeAt(c);
    return t ? plan.defs[t].form : null;
  };
  const sid = (c: number) => (c < 0 ? 0 : (plan.structureAt(c)?.id ?? 0));
  const isWall = (c: number) => c >= 0 && formOf(c) === 'wall' && !plan.gate[c];
  const solid = (c: number) => {
    const f = formOf(c);
    return f === 'block' || f === 'keep';
  };
  const edgeBits = new Uint32Array(g.ne);
  for (let e = 0; e < g.ne; e++) {
    const c0 = g.cells[e * 2];
    const c1 = g.cells[e * 2 + 1];
    let b = 0;
    if (isWall(c0) && isWall(c1)) b |= PLAN_WALL;
    const s0 = sid(c0);
    if (s0 && s0 === sid(c1) && solid(c0)) b |= PLAN_INNER;
    if (roads.has(c0) || roads.has(c1)) b |= PLAN_SPAN;
    if (s0 || sid(c1)) b |= PLAN_BUILT;
    edgeBits[e] = b;
  }
  /** the far rule for one structure: no other (not a wall) within io.far cells, and not beside a road */
  const isFar = (st: { id: number; cells: Map<number, unknown> }): boolean => {
    if (io.far === undefined) return false;
    const start = [...st.cells.keys()];
    if (start.some((c) => [0, 1, 2, 3].some((s) => roads.has(grid.nbr[c * 4 + s])))) return false;
    const seen = new Map<number, number>(start.map((c) => [c, 0]));
    const q = [...start];
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
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
  const ids: number[] = [];
  const far: number[] = [];
  const words: number[] = [];
  const info: number[] = [];
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const bits = (x: number) => ((f32[0] = x), u32[0]);
  for (const st of plan.structures()) {
    if (plan.defs[st.type].form === 'wall') continue;
    const si = ids.length;
    ids.push(st.id);
    const first = words.length / 4;
    let floor = NaN;
    for (const c of st.cells.keys()) {
      if (solid(c) && Number.isFinite(site.floor(c))) floor = Number.isNaN(floor) ? site.floor(c) : Math.max(floor, site.floor(c));
      for (let s = 0; s < 4; s++) {
        const e = g.edgeOf[c * 4 + s];
        if (edgeBits[e] & PLAN_INNER) continue;
        const other = g.cells[e * 2] === c ? g.cells[e * 2 + 1] : g.cells[e * 2];
        if (other >= 0 && sid(other) === st.id) continue;
        const fl = solid(c) ? site.floor(c) : NaN;
        const open = other < 0 || !plan.structureAt(other) ? 1 : 0;
        words.push(e, si, bits(Number.isFinite(fl) ? fl : NaN), open);
      }
    }
    const isfar = isFar(st);
    if (isfar) far.push(st.id);
    const solidSt = plan.defs[st.type].form === 'block' || plan.defs[st.type].form === 'keep';
    info.push(first, words.length / 4 - first, (isfar ? 1 : 0) | (solidSt ? 2 : 0), bits(floor));
  }
  const V = g.verts;
  const nearestV = (p: V2, ok: (v: number) => boolean) => {
    let best = 0;
    let bd = Infinity;
    for (let v = 0; v < g.nv; v++) {
      if (!ok(v)) continue;
      const d = (V[v * 2] - p[0]) ** 2 + (V[v * 2 + 1] - p[1]) ** 2;
      if (d < bd) ((bd = d), (best = v));
    }
    return best;
  };
  // (the stores and the middle on the ground between things: the nearest vertex with an edge not inside a structure)
  const open = new Uint8Array(g.nv);
  for (let e = 0; e < g.ne; e++) if (!(edgeBits[e] & PLAN_INNER)) open[g.ends[e * 2]] = open[g.ends[e * 2 + 1]] = 1;
  const storesV = nearestV(io.stores, (v) => !!open[v]);
  const centreV = nearestV(io.centre, (v) => !!open[v]);
  // the gates' far corners (main streets reach them), then the wall cells
  const jobs: number[] = [];
  for (let c = 0; c < cellCount(g); c++) {
    if (!plan.gate[c]) continue;
    let fv = -1;
    let fd = -1;
    for (let k = 0; k < 4; k++) {
      const v = g.quads[c * 4 + k];
      const d = Math.hypot(V[v * 2] - io.centre[0], V[v * 2 + 1] - io.centre[1]);
      if (d > fd) ((fd = d), (fv = v));
    }
    jobs.push(fv);
  }
  const targets = jobs.length;
  let walls = 0;
  for (let c = 0; c < cellCount(g); c++) {
    if (plan.gate[c] || plan.typeAt(c) !== 'wall') continue;
    jobs.push(c, g.quads[c * 4], g.quads[c * 4 + 1], g.quads[c * 4 + 2], g.quads[c * 4 + 3]);
    walls++;
  }
  return { edgeBits, doors: Uint32Array.from(words), info: Uint32Array.from(info), jobs: Uint32Array.from(jobs), targets, walls, ids, far, storesV, centreV };
}

function cellCount(g: RouteGraph): number {
  return g.edgeOf.length / 4;
}
