// Held rivers from a river table (round 110 — the user: "The waterfalls don't use the same system as the main game can
// you explain why?"). The atlas's rivers are held at their steady state (?rivers=table, round 84): its river graph's
// nodes (atlas/rivers.ts: where, the water's level, half-width, depth, the speed at the reference wetness) carve each
// column's channel (compose.wgsl riverAt and its cut, columns.wgsl's levee) and say its water and flow (forms.wgsl:
// the depth to the level, a sheet where the bed steps down, atlas.ts landFrom → WorldGpu riverFlow). A fixed map
// (the playground, any authored level) has no river graph; it declares its rivers here instead — a path, a width, a
// discharge — and they become the same nodes, rated by the same functions, carved and filled by the same rules, into
// the same riverFlow contract (sim/world-gpu.ts). From there on nothing knows where a river came from: riverheld.wgsl
// holds it, the pipes run it where woken, sleep and settle-then-freeze freeze it again, the renderer draws its flow
// and its falls (LevelDef.rivers = 'table').
//
// The atlas runs these rules on the GPU over its own fields (compose.wgsl, columns.wgsl, forms.wgsl); this is their
// CPU mirror over a map's columns — keep the two in step (each step names its WGSL side). The numbers they share are
// here, once: the node's rating (atlas/rivers.ts uses it), RIVER_FALL, RIVER_SHEET, RIVER_LEVEE (atlas.ts parts()
// puts them in the atlas's kernels).

import { MAT } from './materials';
import { cellPos, nbr, NDIR } from './lattice';
import type { Interval } from './layout';
import { NODE_WORDS, type Catchments } from '../atlas/rivers';
import type { RiverGraph } from '../weather/catchwet';

/** a step down from a river's column this high or more is a fall: its water a sheet RIVER_SHEET deep, quick (forms.wgsl) */
export const RIVER_FALL = 1.5;
export const RIVER_SHEET = 0.2;
/** a river's banks are raised to a little over its level where the ground beside it lies up to this much under it (columns.wgsl) */
export const RIVER_LEVEE = 12;
/** (authored rivers) the most the ground under a channel may lie below the bed the river would cut (cells) */
export const RIVER_UNDER = 0.5;

/** a water river's channel depth at its line for its half-width (atlas/rivers.ts: the carve's parabola) */
export function riverChannelDepth(width: number): number {
  return Math.min(3.5, Math.max(1.2, width * 0.3));
}

/**
 * (round 84, atlas/rivers.ts) A node's speed at the reference wetness (cells a 60 Hz tick): the discharge Q (cells³ a
 * tick) over the wetted section (the carve's parabola filled to 0.3 under the level), the square root taken so a brook
 * still moves; quicker where the level falls (`fall` over `dist` to the next node, world units).
 */
export function riverSpeed(Q: number, width: number, depth: number, fall: number, dist: number): number {
  const A = 2 * width * Math.max(0.3, (2 / 3) * depth - 0.3);
  const slope = Math.max(0, Math.min(fall, 12)) / dist;
  return Math.min(0.8, Math.min(0.45, Math.max(0.06, 0.5 * Math.sqrt(Q / A))) * (1 + Math.min(slope * 6, 1.5)));
}

/** a river's node (compose.wgsl RiverNode; atlas/rivers.ts NODE_WORDS): world units, the water's level (world z) */
export interface RiverNode {
  x: number;
  y: number;
  level: number;
  width: number;
  /** the node downstream (its own index: the river's end) */
  next: number;
  depth: number;
  speed: number;
}

/** A river as a level declares it. */
export interface AuthoredRiver {
  /** its line, upstream first: world units (world/lattice.ts cellPos) and its water's level there (world z), which
   *  only falls. A fall: two points close together across the ledge, the line square to it (the level between them
   *  is mixed along the line — off square, the columns beside the line take a level the ground under them is far
   *  below). Where it leaves the map, run the last point past the edge (held there as a river leaving the atlas's
   *  window). The ground under the channel must not lie more than RIVER_UNDER below its bed (holdRivers throws). */
  path: { x: number; y: number; level: number }[];
  /** its half-width (world units: the channel is where the carve's x < 1) */
  width: number;
  /** cells³ a 60 Hz tick at the reference wetness (the atlas's: RIVER_RUNOFF a texel drained; its smallest ~0.3) */
  discharge: number;
  /** (round 109/110, its watershed) the land that drains into it: a world rectangle [x0, y0, x1, y1] — rain there
   *  raises it (weather/catchwet.ts, riverheld.wgsl riverWetAt), each part the nearest point of its line's, so a
   *  rise runs down it at its pace. Without one it follows the climate alone (the season). */
  catchment?: [number, number, number, number];
}

/** a fixed map's catchment samples' spacing (world units); the graph's world is this big (no torus within reach) */
const CATCH_TEXEL = 8;
const CATCH_WORLD = 4096;

/**
 * (round 110) The authored rivers' graph as the watersheds read the atlas's (weather/catchwet.ts RiverGraph): the
 * nodes packed as atlas/rivers.ts's table, and per node its catchment — the samples of its river's rectangle nearest
 * it — with its own runoff and its discharge at the reference wetness (its own and everything upstream: the samples'
 * runoff, 1 each). Rivers don't join: each is its own graph, upstream first.
 */
export function riverGraph(rivers: AuthoredRiver[], nodes: RiverNode[]): RiverGraph {
  const N = nodes.length;
  const packed = new Uint32Array(Math.max(N, 1) * NODE_WORDS);
  const f = new Float32Array(packed.buffer);
  nodes.forEach((d, k) => {
    const o = k * NODE_WORDS;
    f[o] = d.x;
    f[o + 1] = d.y;
    f[o + 2] = d.level;
    f[o + 3] = d.width;
    packed[o + 4] = d.next;
    packed[o + 5] = 0;
    f[o + 6] = d.depth;
    f[o + 7] = d.speed;
  });
  const side = CATCH_WORLD / CATCH_TEXEL;
  const of = new Int32Array(side * side).fill(-1);
  const own = new Float32Array(N);
  let first = 0;
  for (const r of rivers) {
    const n = r.path.length;
    if (r.catchment) {
      const [x0, y0, x1, y1] = r.catchment;
      for (let b = Math.max(0, Math.floor(y0 / CATCH_TEXEL)); b < Math.min(side, Math.ceil(y1 / CATCH_TEXEL)); b++)
        for (let a = Math.max(0, Math.floor(x0 / CATCH_TEXEL)); a < Math.min(side, Math.ceil(x1 / CATCH_TEXEL)); a++) {
          const sx = (a + 0.5) * CATCH_TEXEL;
          const sy = (b + 0.5) * CATCH_TEXEL;
          let best = -1;
          let bd = Infinity;
          for (let k = first; k < first + n; k++) {
            const d = (nodes[k].x - sx) ** 2 + (nodes[k].y - sy) ** 2;
            if (d < bd) {
              bd = d;
              best = k;
            }
          }
          of[b * side + a] = best;
          own[best] += 1;
        }
    }
    first += n;
  }
  // (upstream first: each node's discharge its own and what runs into it)
  const ref = new Float32Array(N);
  const order = Int32Array.from({ length: N }, (_, k) => k);
  for (const k of order) {
    ref[k] += own[k];
    const nx = nodes[k].next;
    if (nx !== k) ref[nx] += ref[k];
  }
  const catchments: Catchments = { step: 1, side, of, rowW: new Float32Array(side).fill(1), own, ref, order };
  return { nodes: packed, catchments, n: side, worldW: CATCH_WORLD, worldH: CATCH_WORLD };
}

/** an authored river's nodes, rated as the atlas's (atlas/rivers.ts findRivers' table) */
export function riverNodes(r: AuthoredRiver, first = 0): RiverNode[] {
  const P = r.path;
  if (P.length < 2) throw new Error('rivertable: a river needs two points or more');
  if (!(r.width > 0) || !(r.discharge > 0)) throw new Error(`rivertable: width ${r.width}, discharge ${r.discharge}: both over 0`);
  const depth = riverChannelDepth(r.width);
  return P.map((p, k) => {
    const last = k === P.length - 1;
    const d = last ? p : P[k + 1];
    if (d.level > p.level + 1e-6) throw new Error(`rivertable: the level rises from point ${k} to ${k + 1} (${p.level} → ${d.level}): a river only falls`);
    const fall = last ? 0 : p.level - d.level;
    const dist = last ? 1 : Math.hypot(d.x - p.x, d.y - p.y) || 1;
    return { x: p.x, y: p.y, level: p.level, width: r.width, next: first + (last ? k : k + 1), depth, speed: riverSpeed(r.discharge, r.width, depth, fall, dist) };
  });
}

interface RiverHere {
  on: boolean;
  /** across: the distance to its line over its width (< 1: in the channel) */
  x: number;
  level: number;
  w: number;
  depth: number;
  vel: [number, number];
}

/** the nearest river at world p: of the segments from each node to its next (compose.wgsl riverAt — there, of the
 *  nodes nearest the texels round p by the JFA; here every segment, as few as an authored map has) */
function riverAt(nodes: RiverNode[], px: number, py: number): RiverHere {
  const r: RiverHere = { on: false, x: 1e9, level: 0, w: 0, depth: 0, vel: [0, 0] };
  for (const a of nodes) {
    const b = nodes[a.next];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    let s = 0;
    if (l2 > 1e-6) s = Math.min(1, Math.max(0, ((px - a.x) * abx + (py - a.y) * aby) / l2));
    const w = a.width + (b.width - a.width) * s;
    const x = Math.hypot(px - (a.x + abx * s), py - (a.y + aby * s)) / w;
    if (x < r.x) {
      const l = Math.sqrt(Math.max(l2, 1e-12));
      const sp = a.speed + (b.speed - a.speed) * s;
      r.on = true;
      r.x = x;
      r.level = a.level + (b.level - a.level) * s;
      r.w = w;
      r.depth = a.depth + (b.depth - a.depth) * s;
      r.vel = l2 > 1e-6 ? [(abx / l) * sp, (aby / l) * sp] : [0, 0];
    }
  }
  return r;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** column `col`'s top set to z (cut down, or its top run raised), the top `cover` cells of `bed` if given */
function setTop(col: Interval[], z: number, bed: number, cover: number): Interval[] {
  z = Math.max(0.5, z);
  let out = col.filter((iv) => iv.z0 < z).map((iv) => ({ ...iv, z1: Math.min(iv.z1, z) }));
  if (!out.length) out = [{ z0: 0, z1: z, mat: MAT.Stone }];
  out[out.length - 1].z1 = z;
  if (bed >= 0) {
    const z0 = Math.max(0, z - cover);
    const keep = out.filter((iv) => iv.z0 < z0).map((iv) => ({ ...iv, z1: Math.min(iv.z1, z0) }));
    keep.push({ z0, z1: z, mat: bed });
    out = keep;
  }
  return out;
}

/** What a map's rivers come to (WorldGpu riverFlow and the water they start with). */
export interface HeldRivers {
  /** four a column (sim/world-gpu.ts riverFlow): the flow at the reference wetness, the column's depth, the river's
   *  depth at its line — 0 off the rivers */
  riverFlow: Float32Array;
  /** the rivers' columns, held, and the falls among them (counts) */
  columns: number;
  falls: number;
  /** their watersheds (riverGraph) */
  graph: RiverGraph;
}

/**
 * Carve a fixed map's rivers into its columns and fill them, as the atlas carves and fills its own: `cols` (w × h,
 * storage order) cut and raised in place, `water` and `moisture` raised where a river runs. The map's ground is the
 * land before the rivers (the atlas's macro ground); a path's levels are where its water stands on it.
 */
export function holdRivers(rivers: AuthoredRiver[], m: { w: number; h: number; cols: Interval[][]; water: Float32Array; moisture: Float32Array }): HeldRivers {
  const { w, h, cols } = m;
  const N = w * h;
  const nodes: RiverNode[] = [];
  for (const r of rivers) nodes.push(...riverNodes(r, nodes.length));
  const here: RiverHere[] = new Array(N);
  const top = new Float32Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = cols[i];
      let t = c[c.length - 1].z1;
      const [px, py] = cellPos(x, y);
      const rv = riverAt(nodes, px, py);
      here[i] = rv;
      // (compose.wgsl: the channel — a parabola under the level across it — and the valley's sides out to 4 widths)
      if (rv.on && rv.x < 4) {
        let cut = rv.level + (rv.x - 1) * rv.w * 2.5;
        if (rv.x < 1) cut = rv.level - rv.depth * (1 - rv.x * rv.x);
        // (an authored map's ground under the line is the author's: lower than the channel's bed, the river would
        // stand over it as a column of water — the atlas's level is its filled ground's, never over it)
        if (rv.x < 1 && t < cut - RIVER_UNDER)
          throw new Error(`rivertable: column ${x},${y}'s ground (${t.toFixed(2)}) lies ${(cut - t).toFixed(2)} under the river's bed there (its level ${rv.level.toFixed(2)}): lower the path's level, or raise the ground`);
        t = Math.min(t, cut);
        // (columns.wgsl: the banks a little over the level where the ground beside lies lower — a levee)
        if (rv.level > 0 && rv.x >= 0.95 && rv.x < 1.9 && t < rv.level + 0.2 && t > rv.level - RIVER_LEVEE) t = rv.level + 0.2 * smoothstep(1.9, 1.3, rv.x);
      }
      top[i] = t;
    }
  const riverFlow = new Float32Array(N * 4);
  let columns = 0;
  let falls = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const rv = here[i];
      if (!rv.on || rv.x >= 4) continue;
      const river = rv.x < 1;
      // (forms.wgsl: a river's bed sand, silt along its middle, a cell of it)
      cols[i] = setTop(cols[i], top[i], river ? (rv.x < 0.5 ? MAT.Silt : MAT.Sand) : -1, 1);
      if (!river) continue;
      // (forms.wgsl: the steepest step down the way the river runs — not across, its channel's sides)
      const [px, py] = cellPos(x, y);
      const vl = Math.hypot(rv.vel[0], rv.vel[1]);
      const dx = rv.vel[0] / Math.max(vl, 1e-6);
      const dy = rv.vel[1] / Math.max(vl, 1e-6);
      let drop = 0;
      for (let k = 0; k < NDIR; k++) {
        const [nx, ny] = nbr(x, y, k);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const [qx, qy] = cellPos(nx, ny);
        const ql = Math.hypot(qx - px, qy - py);
        if (((qx - px) * dx + (qy - py) * dy) / ql > 0.4) drop = Math.max(drop, top[i] - top[ny * w + nx]);
      }
      // (forms.wgsl: filled to 0.3 under its level; where the bed steps down, a sheet pouring over, quick)
      let d = Math.max(rv.level - 0.3 - top[i], 0);
      let fall = 1;
      if (drop > RIVER_FALL) {
        d = Math.min(d, RIVER_SHEET);
        fall = 2;
        falls++;
      }
      m.water[i] = Math.max(m.water[i], d);
      m.moisture[i] = Math.max(m.moisture[i], 0.8);
      if (d > 0.02) {
        riverFlow.set([rv.vel[0] * fall, rv.vel[1] * fall, d, Math.max(rv.depth, 0.05)], i * 4);
        columns++;
      }
    }
  return { riverFlow, columns, falls, graph: riverGraph(rivers, nodes) };
}
