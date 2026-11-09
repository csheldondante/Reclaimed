// The town's route graph as the GPU walks it (DA-A22, docs/design/ROUTES_ON_GPU.md; build/routegpu.ts,
// shaders/townroute.wgsl). Pure, the CPU's small half — nothing here reads the land:
//  - RouteGraph: the grid's vertices and edges (each cell side once: edgenet.ts edgesOf), each vertex's box column and
//    each edge's middle's, the edges' lengths. Static while the grid's vertices stand (QuadGrid.version): uploaded once.
//  - RoutePlan: the authored part — per edge whether a wall stands across it (two wall cells, neither a gate), whether
//    it's inside a block (not a path), whether a road spans water there (a verge cell beside it: its bridge); each
//    structure's perimeter edges (its door candidates) with its floor (world z; a yard none); the stores' vertex.
//    Made again on a plan edit; bytes per edge and per candidate.
// What the land says — the ground at each end and the middle, water over it, a drop past SLOPE, a door at grade — is the
// GPU's, from the live columns.
import type { TownPlan } from './plan';
import { edgesOf } from './edgenet';
import { cellAt } from '../world/lattice';

type V2 = [number, number];

/** the plan's bits per edge (townroute.wgsl RB_*) */
export const PLAN_WALL = 1;
export const PLAN_INNER = 2;
export const PLAN_SPAN = 4;

/** a box column (its lattice k, row) packed for the kernel (townroute.wgsl winCol): biased so a rim vertex just
 *  outside the box still packs */
export function packCol(k: number, r: number): number {
  return ((k + 32768) & 0xffff) | (((r + 32768) & 0xffff) << 16);
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
  /** per vertex box-local x, y */
  verts: ArrayLike<number>;
}

export function routeGraphOf(grid: { count: number; verts: ArrayLike<number>; quads: ArrayLike<number>; version?: number }): RouteGraph {
  const { ends, cells, edgeOf } = edgesOf(grid);
  const nv = grid.verts.length / 2;
  const ne = ends.length / 2;
  const V = grid.verts;
  const colOf = new Uint32Array(nv + ne);
  const len = new Float32Array(ne);
  for (let v = 0; v < nv; v++) colOf[v] = packCol(...cellAt(V[v * 2], V[v * 2 + 1]));
  for (let e = 0; e < ne; e++) {
    const a = ends[e * 2];
    const b = ends[e * 2 + 1];
    len[e] = Math.hypot(V[b * 2] - V[a * 2], V[b * 2 + 1] - V[a * 2 + 1]);
    colOf[nv + e] = packCol(...cellAt((V[a * 2] + V[b * 2]) / 2, (V[a * 2 + 1] + V[b * 2 + 1]) / 2));
  }
  return { version: grid.version ?? 0, nv, ne, ends, cells, edgeOf, len, colOf, verts: V };
}

export interface RoutePlan {
  /** per edge PLAN_* bits */
  edgeBits: Uint32Array;
  /** per door candidate four words: the edge, the structure's index (in `ids`), its floor (world z, f32 bits; NaN a
   *  yard), 0 */
  doors: Uint32Array;
  /** the structures (not walls) in answer order */
  ids: number[];
  storesV: number;
}

export interface RoutePlanSite {
  plan: TownPlan;
  /** per cell its ground floor (world z; NaN no block): Town.base */
  floor(c: number): number;
}

/**
 * The authored part of the graph from the plan as it stands. `roads` the main roads' verge cells (a road's edge spans
 * water: its bridge); `stores` box-local — the stores' vertex is the nearest one with an edge not inside a structure.
 */
export function routePlanOf(site: RoutePlanSite, g: RouteGraph, roads: ReadonlySet<number>, stores: V2): RoutePlan {
  const { plan } = site;
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
    edgeBits[e] = b;
  }
  const ids: number[] = [];
  const words: number[] = [];
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (const st of plan.structures()) {
    if (plan.defs[st.type].form === 'wall') continue;
    const si = ids.length;
    ids.push(st.id);
    for (const c of st.cells.keys())
      for (let s = 0; s < 4; s++) {
        const e = g.edgeOf[c * 4 + s];
        if (edgeBits[e] & PLAN_INNER) continue;
        const other = g.cells[e * 2] === c ? g.cells[e * 2 + 1] : g.cells[e * 2];
        if (other >= 0 && sid(other) === st.id) continue;
        const fl = solid(c) ? site.floor(c) : NaN;
        f32[0] = Number.isFinite(fl) ? fl : NaN;
        words.push(e, si, u32[0], 0);
      }
  }
  // (the stores on the ground between things: the nearest vertex with an edge not inside a structure)
  const open = new Uint8Array(g.nv);
  for (let e = 0; e < g.ne; e++) if (!(edgeBits[e] & PLAN_INNER)) open[g.ends[e * 2]] = open[g.ends[e * 2 + 1]] = 1;
  let storesV = 0;
  let bd = Infinity;
  for (let v = 0; v < g.nv; v++) {
    if (!open[v]) continue;
    const d = (g.verts[v * 2] - stores[0]) ** 2 + (g.verts[v * 2 + 1] - stores[1]) ** 2;
    if (d < bd) ((bd = d), (storesV = v));
  }
  return { edgeBits, doors: Uint32Array.from(words), ids, storesV };
}
