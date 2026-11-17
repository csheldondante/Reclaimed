// Terrain rivers, step 1 (docs/design/TERRAIN_RIVERS.md, flag `a.rivers2=1`): the rivers come first. Each river is a
// walk from a source toward the coast (the coast SDF's gradient, downhill on the blurred ground, a smooth jitter),
// walks join into a tree, the catchments are the nodes' Voronoi on land, and the levels are designed along each path:
// the running minimum of the ground beside it (monotone by construction, falls where the ground drops), consistent
// between rivers (no river above another's valley wall). The GPU (terrain/valley.wgsl) then shapes the land round
// them: h = min(G + R(d), Hv). Pure functions over typed arrays (unit tests: walks.test.ts); the atlas build calls
// walkRivers once, off the frame path.
//
// The owner, 2026-11-17: "just use a cheaper trick like walking to the coast with jitter and using SDF to raise terrain.
// I like the walks plus raising give more control over paths since it lets us build dramatic water falls and other cool
// features for water and magma rivers (which I want)".

import { riverChannelDepth, riverSpeed } from '../world/rivertable';
import { incisionFor, upstreamFirst, CASCADE_STEP, CASCADE_SLOPE } from './rivershape';

// ---- the constants the owner will want to change (the design note's names) --------------------------------------
/** the walk: downhill weight (at full slope), the slope (cells a cell) that counts as full, the jitter's turn of the
 *  guide at most (radians, ~63°), its period along the walk (texels), how much of the last step's direction a step
 *  keeps, the ground's blur for the downhill term (texels), the least share of a step toward the coast */
export const WALK = { ALPHA: 1.4, SLOPE_FULL: 0.25, TURN: 1.1, JITTER_PER: 24, MOMENTUM: 0.55, GUIDE_BLUR: 3, PROGRESS: 0.2 };
/** sources: a jittered grid this many texels a side, tries a cell (the highest wins), cells from the coast at least */
export const SOURCES = { SPACING: 36, TRIES: 6, COAST: 120 };
/** steps a lava walk runs at most (the old lava rivers: 40) */
export const LAVA_RUN2 = 160;
/**
 * The valley profile and the raise, per region tier (0 lowland, 1 upland, 2 plateau, 3 massif) — the one table: the
 * GPU's constants are generated from it (valleyWgslConsts, prepended to valley.wgsl), the lateral clamp uses it.
 *  FP_K: the floodplain's half-width in river half-widths; SIGMA: the valley wall's slope (cells a cell);
 *  RAISE: cells the land rises away from the rivers at most; REACH: the raise's e-folding distance (cells)
 */
export const VALLEY = {
  BANK: 0.5,
  FLOOD_SLOPE: 0.015,
  TAU: 4,
  FP_K: [5, 2.5, 0.6, 1],
  SIGMA: [0.12, 0.35, 1.8, 0.7],
  RAISE: [6, 28, 0, 45],
  REACH: [250, 350, 1, 450],
  /** the valley's reach (cells from the river's edge): its profile fades out between VW/2 and VW; beyond it the
   *  landforms stand as they were (peaks, cliffs, stamps keep their height) */
  VW: [260, 180, 70, 150],
  /** the cost JFA's slope (cost = level + VJ · distance): which river's valley a texel looks up */
  VJ: 0.15,
  /** cells a river's valley stands higher where its landform has none of the ground (a river shapes only its own
   *  landform: a lowland river under a mesa leaves the cliff alone) */
  LF_PEN: 400,
};
/** the gentlest row (lowland) */
export const VMIN = { BANK: VALLEY.BANK, FLOOD_SLOPE: VALLEY.FLOOD_SLOPE, FP_K: VALLEY.FP_K[0], SIGMA: VALLEY.SIGMA[0], TAU: VALLEY.TAU };

/** the WGSL constants of the table (terrain/valley.wgsl reads these) */
export function valleyWgslConsts(): string {
  const arr = (a: number[]) => `array<f32, 4>(${a.map((v) => v.toFixed(4)).join(', ')})`;
  return `const VAL_BANK: f32 = ${VALLEY.BANK.toFixed(4)};
const VAL_FLOOD_SLOPE: f32 = ${VALLEY.FLOOD_SLOPE.toFixed(4)};
const VAL_TAU: f32 = ${VALLEY.TAU.toFixed(4)};
const VAL_FP_K = ${arr(VALLEY.FP_K)};
const VAL_SIGMA = ${arr(VALLEY.SIGMA)};
const VAL_VW = ${arr(VALLEY.VW)};
const VAL_RAISE = ${arr(VALLEY.RAISE)};
const VAL_REACH = ${arr(VALLEY.REACH)};
const VAL_VJ: f32 = ${VALLEY.VJ.toFixed(4)};
const VAL_LF_PEN: f32 = ${VALLEY.LF_PEN.toFixed(4)};
`;
}
/** texels round a node whose segments the lateral clamp checks */
export const CLAMP_RADIUS = 36;
/** cells a river may stand over another's valley wall (the clamp's tolerance: under the levee's 0.2) */
const CLAMP_TOL = 0.05;
/** a lava channel's incision (rivers.ts: lava depth) */
const LAVA_INC = 1.4;
export const RIVER_LAVA = 1;
const NODE_WORDS = 8;
const RIVER_RUNOFF = 0.002;
const CATCH_STEP = 2;
/** a cascade step's span (river.wgsl segLevel: CASCADE_MIN..CASCADE_MAX) */
const CASCADE_MIN = 2.9;
const CASCADE_MAX = 8.5;

export interface WalkInput {
  n: number;
  seed: number;
  sea: number;
  worldW: number;
  worldH: number;
  /** per texel: the macro ground without rivers (the first macro pass) */
  G: Float32Array;
  /** per texel: the signed distance to the coast (world units, + land) */
  coast: Float32Array;
  /** per texel: 1 water */
  water: Uint8Array;
  /** more sources (texel coordinates, a texel's centre at its integer index): volcano flanks and vents */
  extra?: { tx: number; ty: number; lava: boolean }[];
  /** texels lava walks start from (volcanic regions' tops) */
  lavaTops?: number[];
  /** per texel: its region's tier (0 lowland .. 3 massif; default all lowland) — the clamp's valley profile */
  tier?: Uint8Array;
  /** per texel: its landform (−1 water; default all one). A river shapes only its own landform's ground (valley.wgsl),
   *  so the clamp compares only rivers of one landform */
  landform?: Int32Array;
  /** fewer sources for tests (default SOURCES.SPACING) */
  spacing?: number;
}

export interface WalkStats {
  walks: number;
  lavaWalks: number;
  merged: number;
  toSea: number;
  stranded: number;
  /** nodes the lateral clamp lowered, its rounds, the largest drop it made (cells) */
  clamped: number;
  clampRounds: number;
  clampMax: number;
  /** nodes whose next is higher (should be 0) */
  rises: number;
  ms: number;
  /** ms in the walks, the levels (with the clamp) */
  msWalk?: number;
  msLevels?: number;
  /** the clamp hit its round limit before settling (rivers may stand over another's valley wall there) */
  clampUnsettled?: boolean;
}

/** the raw tree: positions in texel units (a texel's centre at its integer index) */
export interface Tree {
  x: Float32Array;
  y: Float32Array;
  next: Int32Array;
  flags: Uint8Array;
  still: Uint8Array;
  walk: Int32Array;
  count: number;
}

const dryness = (cy: number) => 0.5 - 0.5 * Math.cos((1 - (0.5 - 0.5 * Math.cos(2 * Math.PI * cy))) * 3 * Math.PI);

const wrap = (v: number, n: number) => ((v % n) + n) % n;
const wrapD = (d: number, n: number) => d - Math.round(d / n) * n;

/** a 32-bit hash to [0, 1) */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** a smooth value noise in [−1, 1] along a walk (two octaves) */
export function noise1(seed: number, s: number): number {
  let v = 0;
  let amp = 1;
  let tot = 0;
  for (let o = 0; o < 2; o++) {
    const x = s * (1 << o);
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    const a = hash01(seed + o * 7919, i) * 2 - 1;
    const b = hash01(seed + o * 7919, i + 1) * 2 - 1;
    v += amp * (a + (b - a) * u);
    tot += amp;
    amp *= 0.5;
  }
  return v / tot;
}

/** a field bilinear at texel coordinates (a texel's centre at its integer index), wrapped */
export function bilinear(f: Float32Array, n: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = (yy: number, xx: number) => f[wrap(yy, n) * n + wrap(xx, n)];
  return (i(y0, x0) * (1 - fx) + i(y0, x0 + 1) * fx) * (1 - fy) + (i(y0 + 1, x0) * (1 - fx) + i(y0 + 1, x0 + 1) * fx) * fy;
}

/** a box blur of radius r texels, wrapped (separable running sums) */
export function boxBlur(f: Float32Array, n: number, r: number): Float32Array {
  if (r <= 0) return Float32Array.from(f);
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const k = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    let s = 0;
    for (let d = -r; d <= r; d++) s += f[y * n + wrap(d, n)];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = s / k;
      s += f[y * n + wrap(x + r + 1, n)] - f[y * n + wrap(x - r, n)];
    }
  }
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let d = -r; d <= r; d++) s += tmp[wrap(d, n) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = s / k;
      s += tmp[wrap(y + r + 1, n) * n + x] - tmp[wrap(y - r, n) * n + x];
    }
  }
  return out;
}

/** the gentlest valley profile (valley.wgsl V with the lowland row): cells over the river at e cells from its edge */
export function vmin(e: number, w: number): number {
  return vprof(e, w, 0);
}

/** the valley profile of a tier (valley.wgsl valleyV): cells over the river at e cells from its edge */
export function vprof(e: number, w: number, tier: number): number {
  const F = VALLEY.FP_K[tier] * w;
  const t = VALLEY.TAU;
  const sp = (x: number) => (x > 30 ? x : Math.log1p(Math.exp(x)));
  return VALLEY.BANK * (1 - Math.exp(-e / 1.5)) + VALLEY.FLOOD_SLOPE * e + VALLEY.SIGMA[tier] * t * (sp((e - F) / t) - sp(-F / t));
}

/** river.wgsl segLevel: linear, or a cascade's step at the middle */
export function segLevel(la: number, lb: number, lava: boolean, s: number, len: number): number {
  const f = la - lb;
  if (f >= CASCADE_MIN && f <= CASCADE_MAX && !lava) {
    const hw = 0.6 / Math.max(len, 1);
    const e0 = 0.5 - hw;
    const e1 = 0.5 + hw;
    const t = Math.min(1, Math.max(0, (s - e0) / (e1 - e0)));
    return la + (lb - la) * t * t * (3 - 2 * t);
  }
  return la + (lb - la) * s;
}

/**
 * The walks and their tree (§1). Sources from a jittered grid (the highest of a few tries a cell, far enough from the
 * coast, fewer where it's dry) plus `extra`; water walks in order of decreasing coast distance, then lava walks.
 */
export function walkTree(inp: WalkInput, stats: WalkStats): Tree {
  const { n, G, coast, water } = inp;
  const N = n * n;
  const texW = 0.5 * (inp.worldW + inp.worldH) / n;
  const Gs = boxBlur(G, n, WALK.GUIDE_BLUR);
  const r = (() => {
    let a = (inp.seed * 7477 + 13) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  // sources
  const S = inp.spacing ?? SOURCES.SPACING;
  const src: { tx: number; ty: number; c: number; lava: boolean }[] = [];
  for (let cy = 0; cy < n; cy += S)
    for (let cx = 0; cx < n; cx += S) {
      let best = -1;
      for (let k = 0; k < SOURCES.TRIES; k++) {
        const tx = Math.min(n - 1, cx + Math.floor(r() * S));
        const ty = Math.min(n - 1, cy + Math.floor(r() * S));
        const t = ty * n + tx;
        if (water[t] || coast[t] < SOURCES.COAST) continue;
        if (best < 0 || G[t] > G[best]) best = t;
      }
      const keep = r();
      if (best < 0) continue;
      const by = Math.floor(best / n);
      if (keep > 1 - 0.85 * dryness((by + 0.5) / n)) continue;
      src.push({ tx: best % n, ty: by, c: coast[best], lava: false });
    }
  for (const e of inp.extra ?? []) src.push({ tx: e.tx, ty: e.ty, c: coast[wrap(Math.round(e.ty), n) * n + wrap(Math.round(e.tx), n)], lava: e.lava });
  for (const t of inp.lavaTops ?? []) src.push({ tx: t % n, ty: Math.floor(t / n), c: coast[t], lava: true });
  const waterSrc = src.filter((s) => !s.lava).sort((a, b) => b.c - a.c);
  const lavaSrc = src.filter((s) => s.lava);

  const xs: number[] = [];
  const ys: number[] = [];
  const nx: number[] = [];
  const fl: number[] = [];
  const st: number[] = [];
  const wk: number[] = [];
  const ownW = new Int32Array(N).fill(-1);
  const ownL = new Int32Array(N).fill(-1);
  const add = (x: number, y: number, f: number, still: number, walk: number): number => {
    const k = xs.length;
    xs.push(x);
    ys.push(y);
    nx.push(k);
    fl.push(f);
    st.push(still);
    wk.push(walk);
    const t = wrap(Math.round(y), n) * n + wrap(Math.round(x), n);
    (f & RIVER_LAVA ? ownL : ownW)[t] = k;
    return k;
  };
  const tex = (x: number, y: number) => wrap(Math.round(y), n) * n + wrap(Math.round(x), n);
  /** another walk's node within a texel (8 neighbours) of (x, y): the nearest; −1 none */
  const near = (own: Int32Array, x: number, y: number, walk: number): number => {
    const cx = Math.round(x);
    const cy = Math.round(y);
    let best = -1;
    let bd = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const k = own[wrap(cy + dy, n) * n + wrap(cx + dx, n)];
        if (k < 0 || wk[k] === walk) continue;
        const d = Math.hypot(wrapD(xs[k] - x, n), wrapD(ys[k] - y, n));
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
    return best;
  };
  const MAX_STEPS = 4 * n;
  const walkOne = (s: { tx: number; ty: number }, lava: boolean, id: number) => {
    let x = s.tx;
    let y = s.ty;
    if (water[tex(x, y)]) return;
    if (!lava && near(ownW, x, y, -2) >= 0) return;
    if (lava && near(ownL, x, y, -2) >= 0) return;
    let prev = add(x, y, lava ? RIVER_LAVA : 0, 0, id);
    let dx = 0;
    let dy = 0;
    let arc = 0;
    const seedW = inp.seed * 104729 + id * 7919 + (lava ? 31 : 0);
    for (let step = 0; ; step++) {
      if (step >= (lava ? LAVA_RUN2 : MAX_STEPS)) {
        if (!lava) stats.stranded++;
        return;
      }
      // the guide: to the coast, downhill on the blurred ground (by how steep), a smooth jitter
      const cxp = bilinear(coast, n, x + 1, y) - bilinear(coast, n, x - 1, y);
      const cyp = bilinear(coast, n, x, y + 1) - bilinear(coast, n, x, y - 1);
      const cl = Math.hypot(cxp, cyp) || 1;
      const gx = (bilinear(Gs, n, x + 1, y) - bilinear(Gs, n, x - 1, y)) / (2 * texW);
      const gy = (bilinear(Gs, n, x, y + 1) - bilinear(Gs, n, x, y - 1)) / (2 * texW);
      const gl = Math.hypot(gx, gy);
      const down = gl > 1e-6 ? (WALK.ALPHA * Math.min(1, gl / WALK.SLOPE_FULL)) / gl : 0;
      // (the jitter turns the guide by up to TURN either way, not added to it: added, it won where the coast and the
      // downhill terms cancelled, and the walks curled into loops — the first stills)
      let gxx = -cxp / cl - gx * down;
      let gyy = -cyp / cl - gy * down;
      if (Math.hypot(gxx, gyy) < 0.25) {
        gxx = -cxp / cl;
        gyy = -cyp / cl;
      }
      // (no guide at all — the coast's medial point on a flat: the jitter alone picks a way, the momentum keeps it)
      if (Math.hypot(gxx, gyy) < 1e-3) {
        const a = 2 * Math.PI * noise1(seedW + 17, arc / WALK.JITTER_PER);
        gxx = step > 0 ? dx : Math.cos(a);
        gyy = step > 0 ? dy : Math.sin(a);
      }
      const gn = Math.hypot(gxx, gyy) || 1;
      const th = WALK.TURN * noise1(seedW, arc / WALK.JITTER_PER);
      const c = Math.cos(th);
      const sn = Math.sin(th);
      let ax = (gxx * c - gyy * sn) / gn;
      let ay = (gxx * sn + gyy * c) / gn;
      if (step > 0) {
        ax = WALK.MOMENTUM * dx + (1 - WALK.MOMENTUM) * ax;
        ay = WALK.MOMENTUM * dy + (1 - WALK.MOMENTUM) * ay;
        const l2 = Math.hypot(ax, ay) || 1;
        ax /= l2;
        ay /= l2;
      }
      // (always some way toward the coast: the downhill term reversed the guide in hollows — a crater's bowl — and walks
      // circled there until MAX_STEPS, millions of nodes; with PROGRESS every step lowers the coast distance, so every
      // walk reaches the sea or another walk)
      const ux = -cxp / cl;
      const uy = -cyp / cl;
      const pr = ax * ux + ay * uy;
      if (pr < WALK.PROGRESS && Math.hypot(cxp, cyp) > 1e-6) {
        ax += (WALK.PROGRESS - pr) * ux;
        ay += (WALK.PROGRESS - pr) * uy;
        const l3 = Math.hypot(ax, ay) || 1;
        ax /= l3;
        ay /= l3;
      }
      dx = ax;
      dy = ay;
      x = wrap(x + dx, n);
      y = wrap(y + dy, n);
      arc += 1;
      const t = tex(x, y);
      if (water[t]) {
        const m = add(x, y, lava ? RIVER_LAVA : 0, 1, id);
        nx[prev] = m;
        if (!lava) stats.toSea++;
        return;
      }
      // lava stops at a water river; water joins another walk's water node; lava joins lava
      if (lava && near(ownW, x, y, -2) >= 0) return;
      const j = near(lava ? ownL : ownW, x, y, id);
      if (j >= 0) {
        nx[prev] = j;
        if (!lava) stats.merged++;
        return;
      }
      const k = add(x, y, lava ? RIVER_LAVA : 0, 0, id);
      nx[prev] = k;
      prev = k;
    }
  };
  let id = 0;
  for (const s of waterSrc) {
    walkOne(s, false, id++);
    stats.walks++;
  }
  for (const s of lavaSrc) {
    walkOne(s, true, id++);
    stats.lavaWalks++;
  }
  const count = xs.length;
  return { x: Float32Array.from(xs), y: Float32Array.from(ys), next: Int32Array.from(nx), flags: Uint8Array.from(fl), still: Uint8Array.from(st), walk: Int32Array.from(wk), count };
}

/** each node's main upstream node (the one draining most into it; itself: a source) */
export function mainUp(next: Int32Array, acc: Float32Array): Int32Array {
  const n = next.length;
  const up = new Int32Array(n);
  for (let k = 0; k < n; k++) up[k] = k;
  for (let k = 0; k < n; k++) {
    const j = next[k];
    if (j === k) continue;
    if (up[j] === j || acc[k] > acc[up[j]]) up[j] = k;
  }
  return up;
}

/**
 * Levels (§3): the running minimum of the ground beside each node less its incision, staircased on steep reaches,
 * then the lateral clamp (no river above another's valley wall, Vmin) and the monotone pass again, to a fixed point.
 * `gmin`: per node, the least ground over its 3×3 texels. Positions in world units. In place in `level`.
 */
export function designLevels(o: {
  x: Float32Array;
  y: Float32Array;
  next: Int32Array;
  still: Uint8Array;
  lava: Uint8Array;
  width: Float32Array;
  gmin: Float32Array;
  /** per node: the tier of the ground it runs on (the valley profile another river's wall has there; default 0) */
  tier?: Uint8Array;
  /** per node: its landform (only rivers of one landform are compared; default all one) */
  lf?: Int32Array;
  up: Int32Array;
  sea: number;
  worldW: number;
  worldH: number;
  /** clamp neighbourhood (world units) */
  radius: number;
  level: Float32Array;
  stats: WalkStats;
}): { cascaded: number } {
  const { x, y, next, still, lava, width, gmin, level } = o;
  const n = next.length;
  const order = upstreamFirst(next);
  const floorL = o.sea - 0.3;
  for (let k = 0; k < n; k++) level[k] = still[k] ? o.sea - 0.4 : Math.max(floorL, gmin[k] - (lava[k] ? LAVA_INC : incisionFor(width[k])));
  const monotone = () => {
    for (const k of order) {
      const j = next[k];
      if (j !== k && !still[j] && level[j] > level[k]) level[j] = level[k];
    }
  };
  monotone();
  // staircases on steep reaches (the existing rule: floored to whole steps; still monotone, still under the ground)
  const base = Float32Array.from(level);
  let cascaded = 0;
  for (let k = 0; k < n; k++) {
    if (still[k] || lava[k]) continue;
    const j = next[k];
    const jj = next[j];
    if (j === k || still[j] || still[jj]) continue;
    if ((base[k] - base[jj]) / (jj === j ? 1 : 2) >= CASCADE_SLOPE) {
      level[k] = Math.max(floorL, Math.floor(level[k] / CASCADE_STEP) * CASCADE_STEP);
      cascaded++;
    }
  }
  monotone();
  // the lateral clamp: buckets of nodes (world units)
  const B = Math.max(o.radius / 3, 32);
  const bw = Math.ceil(o.worldW / B);
  const bh = Math.ceil(o.worldH / B);
  const buckets: number[][] = Array.from({ length: bw * bh }, () => []);
  for (let k = 0; k < n; k++) {
    if (lava[k] || next[k] === k) continue;
    buckets[(Math.floor(y[k] / B) % bh) * bw + (Math.floor(x[k] / B) % bw)].push(k);
  }
  const R = Math.ceil(o.radius / B);
  const dropped = new Uint8Array(n);
  let rounds = 0;
  let maxDrop = 0;
  // (after the first round only nodes near a node that moved: a bucket is dirty when a node in it was lowered)
  const bucketOf = (k: number) => (Math.floor(y[k] / B) % bh) * bw + (Math.floor(x[k] / B) % bw);
  let dirty = new Uint8Array(bw * bh).fill(1);
  const MAX_ROUNDS = 40;
  for (; rounds < MAX_ROUNDS; rounds++) {
    let changed = 0;
    const before = Float32Array.from(level);
    for (let i = 0; i < n; i++) {
      if (still[i]) continue;
      const bx = Math.floor(x[i] / B);
      const by = Math.floor(y[i] / B);
      if (rounds > 0) {
        let near = false;
        for (let dy = -R; dy <= R && !near; dy++) for (let dx = -R; dx <= R && !near; dx++) near = dirty[wrap(by + dy, bh) * bw + wrap(bx + dx, bw)] === 1;
        if (!near) continue;
      }
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const list = buckets[wrap(by + dy, bh) * bw + wrap(bx + dx, bw)];
          for (const j of list) {
            const k = next[j];
            if (j === i || k === i) continue;
            if (o.lf && o.lf[j] !== o.lf[i]) continue;
            const ax = x[j];
            const ay = y[j];
            const px = wrapD(x[i] - ax, o.worldW);
            const py = wrapD(y[i] - ay, o.worldH);
            // (a quick reject: the segment's lower end plus a lower bound of the wall at the least distance it can be)
            const lo = Math.min(level[j], level[k]);
            if (lo >= level[i]) continue;
            const abx = wrapD(x[k] - ax, o.worldW);
            const aby = wrapD(y[k] - ay, o.worldH);
            const l2 = abx * abx + aby * aby;
            const ti = o.tier ? o.tier[i] : 0;
            const eLo = Math.sqrt(px * px + py * py) - Math.sqrt(l2) - Math.max(width[j], width[k]);
            // (beyond the valley's reach it doesn't touch this river's ground)
            if (eLo >= VALLEY.VW[ti]) continue;
            if (eLo > 0) {
              const F = VALLEY.FP_K[ti] * Math.max(width[j], width[k]);
              if (lo + VALLEY.FLOOD_SLOPE * eLo + VALLEY.SIGMA[ti] * Math.max(0, eLo - F - VALLEY.TAU * 0.7) >= level[i]) continue;
            }
            const t = l2 > 1e-9 ? (px * abx + py * aby) / l2 : 0;
            // (no cap behind a segment's upstream end, but at a source: the segment above covers it)
            if (t < 0 && o.up[j] !== j) continue;
            const s = Math.min(1, Math.max(0, t));
            const d = Math.hypot(px - abx * s, py - aby * s);
            if (d > o.radius) continue;
            const w = width[j] + (width[k] - width[j]) * s;
            const e = Math.max(d - w, 0);
            const len = Math.sqrt(l2);
            // (the ground river j's valley leaves here — valley.wgsl's h with this node's least ground for G, a lower
            // bound of the GPU's: G' − fade (G' − Hv) grows with G'): this river may not stand over it
            const hv = segLevel(level[j], level[k], !!(lava[j] && lava[k]), s, len) + vprof(e, w, ti);
            const vw = VALLEY.VW[ti];
            const u = Math.min(1, Math.max(0, (e - vw * 0.5) / (vw * 0.5)));
            const fade = 1 - u * u * (3 - 2 * u);
            const bound = Math.max(floorL, gmin[i] - fade * Math.max(0, gmin[i] - hv));
            // (a tolerance: rivers lowering each other through their segments' interpolation creep down by ever less)
            if (bound < level[i] - CLAMP_TOL) {
              maxDrop = Math.max(maxDrop, level[i] - bound);
              level[i] = bound;
              dropped[i] = 1;
              changed++;
            }
          }
        }
    }
    monotone();
    dirty = new Uint8Array(bw * bh);
    let moved = 0;
    for (let k = 0; k < n; k++)
      if (level[k] < before[k] - CLAMP_TOL) {
        dirty[bucketOf(k)] = 1;
        moved++;
      }
    if (!changed || !moved) break;
  }
  if (rounds >= MAX_ROUNDS) o.stats.clampUnsettled = true;
  o.stats.clamped = dropped.reduce((a, b) => a + b, 0);
  o.stats.clampRounds = rounds + 1;
  o.stats.clampMax = +maxDrop.toFixed(1);
  let rises = 0;
  for (let k = 0; k < n; k++) if (next[k] !== k && !still[next[k]] && level[next[k]] > level[k] + 1e-4) rises++;
  o.stats.rises = rises;
  return { cascaded };
}

export interface Rivers2 {
  nodes: Uint32Array;
  nodeAt: Uint32Array;
  /** per node: its main upstream node (itself: a source) — valley.wgsl's segments a node */
  up: Uint32Array;
  count: number;
  lava: number;
  waterfalls: number;
  catchments: {
    step: number;
    side: number;
    of: Int32Array;
    rowW: Float32Array;
    own: Float32Array;
    ref: Float32Array;
    order: Int32Array;
  };
  shaped: { cascaded: number; falls: number; incision: number };
  speed: [number, number, number];
  discharge: number;
  stats: WalkStats;
}

/** The whole of §1–§3: the tree, catchments, widths, levels, the node table (rivers.ts NODE_WORDS layout). */
export function walkRivers(inp: WalkInput): Rivers2 {
  const t0 = performance.now();
  const { n, G, water } = inp;
  const N = n * n;
  const stats: WalkStats = { walks: 0, lavaWalks: 0, merged: 0, toSea: 0, stranded: 0, clamped: 0, clampRounds: 0, clampMax: 0, rises: 0, ms: 0 };
  const tr = walkTree(inp, stats);
  stats.msWalk = +(performance.now() - t0).toFixed(0);
  const count = tr.count;
  const lava = new Uint8Array(count);
  for (let k = 0; k < count; k++) lava[k] = tr.flags[k] & RIVER_LAVA;
  const tex = (k: number) => wrap(Math.round(tr.y[k]), n) * n + wrap(Math.round(tr.x[k]), n);
  // catchments: the water nodes' Voronoi on land (a BFS, 8 neighbours)
  const owner = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  for (let k = 0; k < count; k++) {
    if (lava[k]) continue;
    const t = tex(k);
    if (owner[t] < 0) {
      owner[t] = k;
      queue[qt++] = t;
    }
  }
  while (qh < qt) {
    const t = queue[qh++];
    const tx = t % n;
    const ty = (t - tx) / n;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const u = wrap(ty + dy, n) * n + wrap(tx + dx, n);
        if (owner[u] >= 0 || water[u]) continue;
        owner[u] = owner[t];
        queue[qt++] = u;
      }
  }
  const acc = new Float32Array(count);
  for (let t = 0; t < N; t++) if (owner[t] >= 0 && !water[t]) acc[owner[t]] += 1 - 0.85 * dryness((Math.floor(t / n) + 0.5) / n);
  const order = upstreamFirst(tr.next);
  for (const k of order) {
    const j = tr.next[k];
    if (j !== k && !lava[k]) acc[j] += acc[k];
  }
  const width = new Float32Array(count);
  for (let k = 0; k < count; k++) width[k] = lava[k] ? 3 : Math.min(12, 2 + Math.sqrt(acc[k]) * 0.3);
  const up = mainUp(tr.next, acc);
  // (the lava walks' own upstream: by order along the walk — acc is 0 on lava)
  for (let k = 0; k < count; k++) {
    const j = tr.next[k];
    if (j !== k && lava[k] && lava[j] && up[j] === j) up[j] = k;
  }
  // the ground beside each node
  const gmin = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const cx = Math.round(tr.x[k]);
    const cy = Math.round(tr.y[k]);
    let m = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m = Math.min(m, G[wrap(cy + dy, n) * n + wrap(cx + dx, n)]);
    gmin[k] = m;
  }
  const wx = new Float32Array(count);
  const wy = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    wx[k] = ((tr.x[k] + 0.5) / n) * inp.worldW;
    wy[k] = ((tr.y[k] + 0.5) / n) * inp.worldH;
  }
  const level = new Float32Array(count);
  const texW = 0.5 * (inp.worldW + inp.worldH) / n;
  const tierN = new Uint8Array(count);
  if (inp.tier) for (let k = 0; k < count; k++) tierN[k] = Math.min(3, inp.tier[tex(k)]);
  const lfN = new Int32Array(count);
  if (inp.landform) for (let k = 0; k < count; k++) lfN[k] = inp.landform[tex(k)];
  const tl = performance.now();
  const { cascaded } = designLevels({ x: wx, y: wy, next: tr.next, still: tr.still, lava, width, gmin, tier: tierN, lf: lfN, up, sea: inp.sea, worldW: inp.worldW, worldH: inp.worldH, radius: CLAMP_RADIUS * texW, level, stats });
  stats.msLevels = +(performance.now() - tl).toFixed(0);
  // the node table
  const nodes = new Uint32Array(Math.max(count, 1) * NODE_WORDS);
  const f = new Float32Array(nodes.buffer);
  const nodeAt = new Uint32Array(N);
  let waterfalls = 0;
  let falls = 0;
  let incSum = 0;
  const speeds: number[] = [];
  const qs: number[] = [];
  for (let k = 0; k < count; k++) {
    const j = tr.next[k];
    const o = k * NODE_WORDS;
    f[o] = wx[k];
    f[o + 1] = wy[k];
    f[o + 2] = level[k];
    f[o + 3] = width[k];
    nodes[o + 4] = j;
    nodes[o + 5] = lava[k];
    f[o + 6] = lava[k] ? 1.4 : riverChannelDepth(width[k]);
    const fall = j !== k ? Math.max(0, level[k] - level[j]) : 0;
    if (!lava[k] && fall > 12) waterfalls++;
    if (!lava[k] && fall >= CASCADE_STEP - 0.01) falls++;
    if (!tr.still[k]) incSum += gmin[k] - level[k];
    if (!lava[k]) {
      const Q = RIVER_RUNOFF * acc[k];
      const dist = j !== k ? Math.hypot(wrapD(wx[k] - wx[j], inp.worldW), wrapD(wy[k] - wy[j], inp.worldH)) || texW : texW;
      const v = riverSpeed(Q, width[k], f[o + 6], fall, dist);
      f[o + 7] = v;
      speeds.push(v);
      qs.push(Q);
    }
  }
  // the JFA's seeds: lava first, water over it (a texel with both is the water's)
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < count; k++) if ((pass === 0) === !!lava[k]) nodeAt[tex(k)] = k + 1;
  // the catchments (rivers.ts Catchments): sampled every CATCH_STEP texels
  const step = CATCH_STEP;
  const side = Math.floor(n / step);
  const of = new Int32Array(side * side);
  const rowW = new Float32Array(side);
  const own = new Float32Array(Math.max(count, 1));
  for (let sy = 0; sy < side; sy++) {
    rowW[sy] = step * step * (1 - 0.85 * dryness((sy * step + 0.5) / n));
    for (let sx = 0; sx < side; sx++) {
      const i = sy * step * n + sx * step;
      const b = water[i] ? -1 : owner[i];
      of[sy * side + sx] = b;
      if (b >= 0) own[b] += rowW[sy];
    }
  }
  const ref = new Float32Array(own);
  for (const k of order) {
    const j = tr.next[k];
    if (j !== k && !lava[k]) ref[j] += ref[k];
  }
  const sp = speeds.slice().sort((a, b) => a - b);
  const med = (a: number[]) => (a.length ? a.slice().sort((p, q) => p - q)[a.length >> 1] : 0);
  const r3 = (v: number) => +v.toFixed(3);
  const upU = new Uint32Array(Math.max(count, 1));
  upU.set(up);
  stats.ms = +(performance.now() - t0).toFixed(0);
  return {
    nodes,
    nodeAt,
    up: upU,
    count,
    lava: lava.reduce((a, b) => a + b, 0),
    waterfalls,
    catchments: { step, side, of, rowW, own, ref, order },
    shaped: { cascaded, falls, incision: +(incSum / Math.max(1, count)).toFixed(2) },
    speed: [r3(sp[0] ?? 0), r3(med(sp)), r3(sp[sp.length - 1] ?? 0)],
    discharge: r3(med(qs)),
    stats,
  };
}
