// (diagnostic, Track A: the user — "Can we identify noise in terrain that makes portions unwalkable near cities and mark
// it in debug so we can see if it is visually something that appears walkable and then tune it to make it much less
// restrictive?") What the edge network (edgenet.ts) treats as not walkable, and why, per edge — for the ?routedebug=1
// overlay (fortress/routedebug.ts) and for a script's numbers. Pure: it reads a laid net and changes no rule. The
// reasons are the net's own bits (CUT_WALL, CUT_WATER, CUT_CLIFF, steep) plus "terrace": a solid structure's perimeter
// edge the net didn't take as a door (its floor off the ground there by more than STEP) — derived from `net.doors`, not
// judged again. A cliff's rise is measured as edgenet.ts measures it: |ground(b) − ground(a)| / the edge's length, the
// ground the caller's (the site's: the same sampler the net was laid with).
import type { EdgeNet } from './edgenet';
import { CUT_CLIFF, CUT_WALL, CUT_WATER } from './edgenet';
import type { TownPlan } from './plan';
import { SLOPE } from './ways';

/** what an edge shows as (one each; a cut with several bits shows its first: wall, water, cliff) */
export const SHOW_NONE = 0;
export const SHOW_WALL = 1;
export const SHOW_WATER = 2;
export const SHOW_CLIFF = 3;
export const SHOW_TERRACE = 4;
export const SHOW_STEEP = 5;

export interface EdgeCutsGrid {
  count: number;
  verts: ArrayLike<number>;
  nbr: ArrayLike<number>;
}

export interface EdgeCuts {
  /** per edge its SHOW_* */
  show: Uint8Array;
  /** per edge its rise over its length (the slope edgenet.ts compares with SLOPE) */
  rise: Float32Array;
  /** per edge the ground's difference between its ends (m) */
  dz: Float32Array;
  /** per edge 1 if either cell beside it is within `near` cells of a structure (not a wall) */
  near: Uint8Array;
}

export interface EdgeCutSummary {
  edges: number;
  /** edges by bit (an edge with two bits counts in both); terrace: perimeter edges no door at grade */
  cut: { wall: number; water: number; cliff: number; terrace: number };
  steep: number;
  /** cliff cuts that are also water or wall cuts (they show as those: a bank, a wall on a drop) — the rest stand alone */
  cliffAlso: number;
  /** cliff cuts by how far their rise is over SLOPE: within 10 %, 10–25 %, 25–50 %, past 50 % */
  cliffOver: { within10: number; within25: number; within50: number; beyond50: number };
  /** cliff cuts: their rise's and their drop's (m) and their length's quartiles (min, 25 %, median, 75 %, max) */
  cliffRise: number[];
  cliffDz: number[];
  cliffLength: number[];
  /** cliff cuts whose drop is under a metre (a column's step or less: what reads as a bump) */
  cliffUnder1m: number;
  /** the cut edges (and the cliff cuts alone) within `nearCells` cells of a structure */
  nearCells: number;
  nearCut: number;
  nearCliff: number;
  /** grid vertices not on the route network's connected part (RouteNet.main), of those with any edge */
  offMain: number;
  slope: number;
}

/**
 * Per edge what it shows as and its rise, and whether it lies near a structure. `ground` box-local (x, y) → z, the
 * sampler the net was laid with (TownSite.groundAt).
 */
export function edgeCutsOf(net: EdgeNet, grid: EdgeCutsGrid, plan: TownPlan, ground: (x: number, y: number) => number, nearCells = 3): EdgeCuts {
  const ne = net.cut.length;
  const nv = grid.verts.length / 2;
  const vg = new Float64Array(nv);
  for (let v = 0; v < nv; v++) vg[v] = ground(grid.verts[v * 2], grid.verts[v * 2 + 1]);
  const show = new Uint8Array(ne);
  const rise = new Float32Array(ne);
  const dz = new Float32Array(ne);
  for (let e = 0; e < ne; e++) {
    const a = net.ends[e * 2];
    const b = net.ends[e * 2 + 1];
    dz[e] = Math.abs(vg[b] - vg[a]);
    rise[e] = dz[e] / Math.max(net.length[e], 1e-6);
    const k = net.cut[e];
    show[e] = k & CUT_WALL ? SHOW_WALL : k & CUT_WATER ? SHOW_WATER : k & CUT_CLIFF ? SHOW_CLIFF : net.steep[e] ? SHOW_STEEP : SHOW_NONE;
  }
  // terraces: a structure's perimeter edge (not inside it, not to its own cell) that isn't one of its doors
  for (const st of plan.structures()) {
    const form = plan.defs[st.type].form;
    if (form !== 'block' && form !== 'keep') continue;
    const doors = new Set(net.doors.get(st.id) ?? []);
    for (const c of st.cells.keys())
      for (let s = 0; s < 4; s++) {
        const e = net.edgeOf[c * 4 + s];
        if (net.inner[e] || doors.has(e)) continue;
        const other = net.cells[e * 2] === c ? net.cells[e * 2 + 1] : net.cells[e * 2];
        if (other >= 0 && plan.structureAt(other)?.id === st.id) continue;
        if (show[e] === SHOW_NONE || show[e] === SHOW_STEEP) show[e] = SHOW_TERRACE;
      }
  }
  // near: a breadth-first walk over the cells from every structure's (not a wall's), `nearCells` deep
  const dist = new Int32Array(grid.count).fill(-1);
  const q: number[] = [];
  for (const st of plan.structures()) {
    if (plan.defs[st.type].form === 'wall') continue;
    for (const c of st.cells.keys()) if (dist[c] < 0) ((dist[c] = 0), q.push(c));
  }
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (dist[c] >= nearCells) continue;
    for (let s = 0; s < 4; s++) {
      const n = grid.nbr[c * 4 + s];
      if (n >= 0 && dist[n] < 0) ((dist[n] = dist[c] + 1), q.push(n));
    }
  }
  const near = new Uint8Array(ne);
  for (let e = 0; e < ne; e++) near[e] = [net.cells[e * 2], net.cells[e * 2 + 1]].some((c) => c >= 0 && dist[c] >= 0) ? 1 : 0;
  return { show, rise, dz, near };
}

function quartiles(xs: number[]): number[] {
  if (!xs.length) return [];
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => +s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))].toFixed(3);
  return [at(0), at(0.25), at(0.5), at(0.75), at(1)];
}

/** The counts a script or test reads. `main`: per grid vertex 1 if on the route network's connected part (RouteNet.main). */
export function summariseEdgeCuts(net: EdgeNet, cuts: EdgeCuts, nearCells: number, main?: ArrayLike<number>): EdgeCutSummary {
  const ne = net.cut.length;
  const out: EdgeCutSummary = {
    edges: ne,
    cut: { wall: 0, water: 0, cliff: 0, terrace: 0 },
    steep: 0,
    cliffAlso: 0,
    cliffOver: { within10: 0, within25: 0, within50: 0, beyond50: 0 },
    cliffRise: [],
    cliffDz: [],
    cliffLength: [],
    cliffUnder1m: 0,
    nearCells,
    nearCut: 0,
    nearCliff: 0,
    offMain: 0,
    slope: SLOPE,
  };
  const rises: number[] = [];
  const dzs: number[] = [];
  const lens: number[] = [];
  for (let e = 0; e < ne; e++) {
    const k = net.cut[e];
    if (k & CUT_WALL) out.cut.wall++;
    if (k & CUT_WATER) out.cut.water++;
    if (cuts.show[e] === SHOW_TERRACE) out.cut.terrace++;
    out.steep += net.steep[e];
    if ((k || cuts.show[e] === SHOW_TERRACE) && cuts.near[e]) out.nearCut++;
    if (!(k & CUT_CLIFF)) continue;
    out.cut.cliff++;
    if (k & (CUT_WATER | CUT_WALL)) out.cliffAlso++;
    if (cuts.near[e]) out.nearCliff++;
    const over = cuts.rise[e] / SLOPE - 1;
    if (over <= 0.1) out.cliffOver.within10++;
    else if (over <= 0.25) out.cliffOver.within25++;
    else if (over <= 0.5) out.cliffOver.within50++;
    else out.cliffOver.beyond50++;
    if (cuts.dz[e] < 1) out.cliffUnder1m++;
    rises.push(cuts.rise[e]);
    dzs.push(cuts.dz[e]);
    lens.push(net.length[e]);
  }
  out.cliffRise = quartiles(rises);
  out.cliffDz = quartiles(dzs);
  out.cliffLength = quartiles(lens);
  if (main) {
    const any = new Uint8Array(main.length);
    for (let e = 0; e < ne; e++) for (const v of [net.ends[e * 2], net.ends[e * 2 + 1]]) if (v < any.length && !net.inner[e]) any[v] = 1;
    for (let v = 0; v < any.length; v++) if (any[v] && !main[v]) out.offMain++;
  }
  return out;
}
