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
import type { Basin } from './lakes';

// ---- the constants the owner will want to change (the design note's names) --------------------------------------
/** the walk: downhill weight (at full slope), the slope (cells a cell) that counts as full, the jitter's turn of the
 *  guide at most (radians, ~63°), its period along the walk (texels), how much of the last step's direction a step
 *  keeps, the ground's blur for the downhill term (texels), the least share of a step toward the coast */
export const WALK = { ALPHA: 1.4, SLOPE_FULL: 0.25, TURN: 1.1, JITTER_PER: 24, MOMENTUM: 0.55, GUIDE_BLUR: 3, PROGRESS: 0.2 };
/** sources: a jittered grid this many texels a side, tries a cell (the highest wins), cells from the coast at least */
export const SOURCES = { SPACING: 36, TRIES: 6, COAST: 120 };
/** (step 2) creeks feeding a head on high ground: heads at least MIN_H over the sea; PER creeks a head, each from the
 *  highest of TRIES points R texels round it standing RISE over it; a creek steps toward the head and downhill (DOWN
 *  its weight) for at most MAX steps, and is kept only if it meets a river */
export const CREEK = { MIN_H: 40, PER: 4, R: 10, TRIES: 8, RISE: 6, MAX: 30, DOWN: 1.0 };
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
  /** cells a river's valley stands higher where its landform has none of the ground (a river shapes only its own
   *  landform: a lowland river under a mesa leaves the cliff alone) */
  LF_PEN: 400,
  /** (step 2) …reached at LF_SLOPE cells a cell into the other landform from its border (the landforms' JFA distance):
   *  a fixed LF_PEN made a step wall where two landforms meet at one height (the continuity probe's largest seams) */
  LF_SLOPE: 4,
  /** (step 2, §9.2) the valley's bound: past half its reach (m = e − VW/2 cells) its surface climbs
   *  PHI_SLOPE · m + PHI_CURV · m² — steepening, but never so fast that a texel (8 cells) can't hold it: a quadratic
   *  reaching 600 at VW was 9–34 cells a cell at the rim, and its bilinear samples crossed the land as steps (§9.7) */
  PHI_SLOPE: 1,
  PHI_CURV: 0.01,
  /** (§9.5) the smooth minimum's width (cells) where a valley's wall meets the land: the valley's shoulder */
  SMIN_K: 4,
  /** (§9.4) the fine profile at the channel: exact for FINE_E cells past the bank, then climbing FINE_K · (e − FINE_E)² */
  FINE_E: 6,
  FINE_K: 1,
};
/** (step 2, §9.5) a source's valley head: its length (cells), the floor's curve, its least rise over the spring */
export const HEAD = { LEN: 56, POW: 2.5, MIN: 4 };
/** (§9.5) the spring pool at a source: its radius (half-widths) and how much deeper (cells) */
export const SPRING = { R: 1.3, D: 1.2 };
/** a head level meaning "no head" (not a source) */
export const NO_HEAD = -1e30;
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
const VAL_LF_PEN: f32 = ${VALLEY.LF_PEN.toFixed(4)};
const VAL_LF_SLOPE: f32 = ${VALLEY.LF_SLOPE.toFixed(4)};
const VAL_PHI_SLOPE: f32 = ${VALLEY.PHI_SLOPE.toFixed(4)};
const VAL_PHI_CURV: f32 = ${VALLEY.PHI_CURV.toFixed(4)};
const VAL_SMIN_K: f32 = ${VALLEY.SMIN_K.toFixed(4)};
const VAL_FINE_E: f32 = ${VALLEY.FINE_E.toFixed(4)};
const VAL_FINE_K: f32 = ${VALLEY.FINE_K.toFixed(4)};
const VAL_HEAD_LEN: f32 = ${HEAD.LEN.toFixed(4)};
const VAL_HEAD_POW: f32 = ${HEAD.POW.toFixed(4)};
const VAL_SPRING_R: f32 = ${SPRING.R.toFixed(4)};
const VAL_SPRING_D: f32 = ${SPRING.D.toFixed(4)};
`;
}

/** (§9.2) the valley's bound past half its reach (cells over the profile) */
export function phi(e: number, tier: number): number {
  const m = Math.max(0, e - VALLEY.VW[tier] * 0.5);
  return VALLEY.PHI_SLOPE * m + VALLEY.PHI_CURV * m * m;
}

/** (§9.5) the polynomial smooth minimum: ≤ min(a, b), equal to it once |a − b| ≥ k */
export function smin(a: number, b: number, k: number): number {
  const m = Math.max(0, 1 - Math.abs(a - b) / k);
  return Math.min(a, b) - (k / 4) * m * m;
}

/** (§9.5) a source's head floor at t (0 the spring .. 1 the head's end): near the spring's level, then up to the land */
export function headLevel(ls: number, lh: number, t: number): number {
  return ls + (lh - ls) * Math.pow(Math.min(1, Math.max(0, t)), HEAD.POW);
}

/** (§9.5) the channel's half-width: a 1.2-wide spring, widening fast, then with the catchment (hops: nodes from the
 *  farthest source) */
export function riverWidth(acc: number, hops: number): number {
  return Math.min(12, 1.2 + (0.8 + 0.3 * Math.sqrt(acc)) * Math.sqrt(Math.min(1, hops / WIDTH_TAPER)));
}
/** texels round a node whose segments the lateral clamp checks */
export const CLAMP_RADIUS = 36;
/** nodes from its farthest source over which a river's width grows in */
const WIDTH_TAPER = 16;
/** (step 2) the clamp leaves a node's own reach this many nodes up and down alone */
const CHAIN_HOPS = 4;
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
  /** (step 2) creeks feeding the heads on high ground (default on) */
  creeks?: boolean;
  /** (step 3, terrain/lakes.ts) the basins of the filled ground: a water walk that reaches one (no lower on its way than
   *  the basin's level) ends in it as a lake and a new walk leaves from its outlet */
  basins?: { basinOf: Int32Array; basins: Basin[] };
  /** (step 3) texels of placed lakes (a crater's middle): the basin there is a lake whether a walk reaches it or not */
  lakeSeeds?: number[];
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
  /** (step 2) ms in the catchments' BFS, the widths and the ground beside each node */
  msBfs?: number;
  /** (step 2) nodes the clamp moved each round */
  clampMoved?: number[];
  /** (step 2) creeks tried and kept (they met a river) */
  creeksTried?: number;
  creeks?: number;
  /** the clamp hit its round limit before settling (rivers may stand over another's valley wall there) */
  clampUnsettled?: boolean;
  /** (step 3) lakes: found by walks, placed (craters), walks that joined a lake, joins refused (they would have made a
   *  cycle through a lake's outlet, or the river would have had to rise to a lake downstream), nodes the lakes' floor
   *  raised over their own ground less the incision */
  lakesFound?: number;
  lakesPlaced?: number;
  lakeJoins?: number;
  cyclesRefused?: number;
  lakeFloated?: number;
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
  /** (step 3) per node: the basin it is the lake of (−1: none) — the lake's node stands at its outlet */
  lakeOf: Int32Array;
}

const dryness = (cy: number) => 0.5 - 0.5 * Math.cos((1 - (0.5 - 0.5 * Math.cos(2 * Math.PI * cy))) * 3 * Math.PI);

const wrap = (v: number, n: number) => ((v % n) + n) % n;
/** (step 2) an integer wrapped (the hot loops': one remainder, not two — `wrap` was 40% of the build's CPU) */
const wi = (v: number, n: number) => {
  const r = v % n;
  return r < 0 ? r + n : r;
};
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
  const i = (yy: number, xx: number) => f[wi(yy, n) * n + wi(xx, n)];
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
    for (let d = -r; d <= r; d++) s += f[y * n + wi(d, n)];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = s / k;
      s += f[y * n + wi(x + r + 1, n)] - f[y * n + wi(x - r, n)];
    }
  }
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let d = -r; d <= r; d++) s += tmp[wi(d, n) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = s / k;
      s += tmp[wi(y + r + 1, n) * n + x] - tmp[wi(y - r, n) * n + x];
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
  for (const e of inp.extra ?? []) src.push({ tx: e.tx, ty: e.ty, c: coast[wi(Math.round(e.ty), n) * n + wi(Math.round(e.tx), n)], lava: e.lava });
  for (const t of inp.lavaTops ?? []) src.push({ tx: t % n, ty: Math.floor(t / n), c: coast[t], lava: true });
  const waterSrc = src.filter((s) => !s.lava).sort((a, b) => b.c - a.c);
  const lavaSrc = src.filter((s) => s.lava);

  const xs: number[] = [];
  const ys: number[] = [];
  const nx: number[] = [];
  const fl: number[] = [];
  const st: number[] = [];
  const wk: number[] = [];
  const lk: number[] = [];
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
    lk.push(-1);
    const t = wi(Math.round(y), n) * n + wi(Math.round(x), n);
    (f & RIVER_LAVA ? ownL : ownW)[t] = k;
    return k;
  };
  const tex = (x: number, y: number) => wi(Math.round(y), n) * n + wi(Math.round(x), n);
  /** another walk's node within a texel (8 neighbours) of (x, y): the nearest; −1 none */
  const near = (own: Int32Array, x: number, y: number, walk: number): number => {
    const cx = Math.round(x);
    const cy = Math.round(y);
    let best = -1;
    let bd = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const k = own[wi(cy + dy, n) * n + wi(cx + dx, n)];
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
  /** each water walk's first node (its head): the creeks' targets */
  const heads: number[] = [];
  // (step 3) the lakes: each basin's node once a walk reached it (−1: not a lake yet)
  const bs = inp.basins;
  const lakeNode = new Int32Array(bs ? bs.basins.length : 0).fill(-1);
  /** joining j would close a cycle: j's chain runs into `head`, the walk still being laid (a lake's outlet walk
   *  meeting a river that flows into that lake) */
  const cycles = (j: number, head: number): boolean => {
    let c = j;
    for (;;) {
      if (c === head) return true;
      const d = nx[c];
      if (d === c) return false;
      c = d;
    }
  };
  /** the level of the first lake downstream of j (−∞ none): a walk that crossed lower ground may not join above it — its
   *  river would have to rise to the lake (the one rise of the first build: an outlet walk joined a river into a higher
   *  lake) */
  const lakeBelow = (j: number): number => {
    let c = j;
    for (;;) {
      if (lk[c] >= 0) return bs!.basins[lk[c]].level;
      const d = nx[c];
      if (d === c) return -Infinity;
      c = d;
    }
  };
  /** a basin becomes a lake: its node at the outlet, the walk on from there (an outlet walk) */
  const makeLake = (b: number): number => {
    const o = bs!.basins[b].outlet;
    const k = add(o % n, Math.floor(o / n), 0, 0, id++);
    lk[k] = b;
    lakeNode[b] = k;
    walkOne({ tx: o % n, ty: Math.floor(o / n) }, false, wk[k], { node: k, lake: b });
    return k;
  };
  function walkOne(s: { tx: number; ty: number }, lava: boolean, id: number, from?: { node: number; lake: number }) {
    let x = s.tx;
    let y = s.ty;
    let prev: number;
    if (from) {
      prev = from.node;
    } else {
      if (water[tex(x, y)]) return;
      if (!lava && near(ownW, x, y, -2) >= 0) return;
      if (lava && near(ownL, x, y, -2) >= 0) return;
      prev = add(x, y, lava ? RIVER_LAVA : 0, 0, id);
    }
    // (step 3) the least ground the walk has crossed: it can fill a basin no higher than that
    // (an outlet walk starts at its lake's level: its rim's lowest texel can stand a little over it, and a basin between
    // the two would have been a lake higher than the one it drains)
    let runMin = from ? Math.min(G[tex(x, y)], bs!.basins[from.lake].level) : G[tex(x, y)];
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
      // (step 3) a basin no higher than the least ground on the way: the walk ends in it, a lake (made now, its outlet
      // walk laid at once, or joined) — unless that would close a cycle; past its own lake an outlet walk walks on
      if (!lava && bs) {
        const b = bs.basinOf[t];
        if (b >= 0 && (!from || b !== from.lake) && bs.basins[b].level <= runMin) {
          if (lakeNode[b] >= 0) {
            if (!cycles(lakeNode[b], prev)) {
              nx[prev] = lakeNode[b];
              stats.lakeJoins = (stats.lakeJoins ?? 0) + 1;
              return;
            }
            stats.cyclesRefused = (stats.cyclesRefused ?? 0) + 1;
          } else {
            stats.lakesFound = (stats.lakesFound ?? 0) + 1;
            stats.lakeJoins = (stats.lakeJoins ?? 0) + 1;
            // (linked before the outlet walk is laid, so that walk sees this one's chain as its own: cycles())
            const before = xs.length;
            nx[prev] = before;
            makeLake(b);
            return;
          }
        }
        runMin = Math.min(runMin, G[t]);
      }
      // lava stops at a water river; water joins another walk's water node; lava joins lava
      if (lava && near(ownW, x, y, -2) >= 0) return;
      const j = near(lava ? ownL : ownW, x, y, id);
      if (j >= 0) {
        if (!lava && (cycles(j, prev) || (bs && lakeBelow(j) > runMin))) {
          stats.cyclesRefused = (stats.cyclesRefused ?? 0) + 1;
        } else {
          nx[prev] = j;
          if (!lava) stats.merged++;
          return;
        }
      }
      const k = add(x, y, lava ? RIVER_LAVA : 0, 0, id);
      nx[prev] = k;
      prev = k;
    }
  }
  let id = 0;
  for (const s of waterSrc) {
    const before = xs.length;
    walkOne(s, false, id++);
    stats.walks++;
    if (xs.length > before) heads.push(before);
  }
  // (step 3) placed lakes: a crater's basin is a lake whether a walk reached it or not (its outlet walk laid now)
  if (bs && inp.lakeSeeds)
    for (const t of inp.lakeSeeds) {
      const b = bs.basinOf[t];
      if (b < 0 || lakeNode[b] >= 0) continue;
      makeLake(b);
      stats.lakesPlaced = (stats.lakesPlaced ?? 0) + 1;
    }
  // (step 2, §9.5 — the owner: "mountains with either cloud runoff or glacial melt that sends many little creaks down to
  // feed the head of the river") creeks: on high ground, short steep walks from higher points round each head, toward
  // it and downhill, kept only if they reach a river (they join the head's first nodes or a neighbour's)
  if (inp.creeks !== false)
    for (const h of heads) {
      const hx = xs[h];
      const hy = ys[h];
      const gH = G[tex(hx, hy)];
      if (gH - inp.sea < CREEK.MIN_H) continue;
      for (let c = 0; c < CREEK.PER; c++) {
        let best = -1;
        let bx = 0;
        let by = 0;
        for (let k = 0; k < CREEK.TRIES; k++) {
          const a = r() * 2 * Math.PI;
          const rr = CREEK.R * (0.4 + 0.6 * Math.sqrt(r()));
          const tx = wrap(hx + Math.cos(a) * rr, n);
          const ty = wrap(hy + Math.sin(a) * rr, n);
          const t = tex(tx, ty);
          if (water[t] || G[t] < gH + CREEK.RISE || near(ownW, tx, ty, -2) >= 0) continue;
          if (best < 0 || G[t] > G[best]) {
            best = t;
            bx = tx;
            by = ty;
          }
        }
        if (best < 0) continue;
        stats.creeksTried = (stats.creeksTried ?? 0) + 1;
        const cid = id++;
        const seedC = inp.seed * 7919 + cid * 104729;
        const px: number[] = [bx];
        const py: number[] = [by];
        let x = bx;
        let y = by;
        let dx = 0;
        let dy = 0;
        let join = -1;
        for (let step = 0; step < CREEK.MAX && join < 0; step++) {
          const tox = wrapD(hx - x, n);
          const toy = wrapD(hy - y, n);
          const tl = Math.hypot(tox, toy) || 1;
          const gx = bilinear(Gs, n, x + 1, y) - bilinear(Gs, n, x - 1, y);
          const gy = bilinear(Gs, n, x, y + 1) - bilinear(Gs, n, x, y - 1);
          const gl = Math.hypot(gx, gy) || 1;
          let ax = tox / tl - (CREEK.DOWN * gx) / gl;
          let ay = toy / tl - (CREEK.DOWN * gy) / gl;
          const th = 0.5 * WALK.TURN * noise1(seedC, step / 8);
          const al = Math.hypot(ax, ay) || 1;
          const cx = Math.cos(th);
          const sx = Math.sin(th);
          [ax, ay] = [(ax * cx - ay * sx) / al, (ax * sx + ay * cx) / al];
          if (step > 0) {
            ax = 0.5 * dx + 0.5 * ax;
            ay = 0.5 * dy + 0.5 * ay;
            const l2 = Math.hypot(ax, ay) || 1;
            ax /= l2;
            ay /= l2;
          }
          dx = ax;
          dy = ay;
          x = wrap(x + dx, n);
          y = wrap(y + dy, n);
          if (water[tex(x, y)]) break;
          join = near(ownW, x, y, cid);
          if (join < 0) {
            px.push(x);
            py.push(y);
          }
        }
        if (join < 0) continue;
        // (kept: its nodes, each to the next, the last into the river it met)
        let prev = -1;
        for (let i = 0; i < px.length; i++) {
          const k = add(px[i], py[i], 0, 0, cid);
          if (prev >= 0) nx[prev] = k;
          prev = k;
        }
        nx[prev] = join;
        stats.creeks = (stats.creeks ?? 0) + 1;
      }
    }
  for (const s of lavaSrc) {
    walkOne(s, true, id++);
    stats.lavaWalks++;
  }
  const count = xs.length;
  return { x: Float32Array.from(xs), y: Float32Array.from(ys), next: Int32Array.from(nx), flags: Uint8Array.from(fl), still: Uint8Array.from(st), walk: Int32Array.from(wk), count, lakeOf: Int32Array.from(lk) };
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
  /** (step 3) per node: a fixed level (a lake's: its spill level), NaN none — never lowered; every node upstream of it
   *  stands at least at it (the river into a lake comes down to its water, not under it) */
  fixed?: Float32Array;
}): { cascaded: number } {
  const { x, y, next, still, lava, width, gmin, level } = o;
  const n = next.length;
  const order = upstreamFirst(next);
  const floorL = o.sea - 0.3;
  const fixed = o.fixed;
  const isFixed = (k: number) => !!fixed && !Number.isNaN(fixed[k]);
  for (let k = 0; k < n; k++) level[k] = still[k] ? o.sea - 0.4 : isFixed(k) ? fixed![k] : Math.max(floorL, gmin[k] - (lava[k] ? LAVA_INC : incisionFor(width[k])));
  // (step 3) each node's floor: the level of the first lake downstream of it (−∞ none) — non-increasing downstream
  const floorAt = new Float32Array(n).fill(-Infinity);
  if (fixed)
    for (let i = n - 1; i >= 0; i--) {
      const k = order[i];
      const j = next[k];
      floorAt[k] = isFixed(k) ? fixed[k] : j !== k ? floorAt[j] : -Infinity;
    }
  const monotone = () => {
    for (const k of order) {
      const j = next[k];
      if (j !== k && !still[j] && !isFixed(j) && level[j] > level[k]) level[j] = level[k];
    }
    if (fixed) for (let k = 0; k < n; k++) if (level[k] < floorAt[k]) level[k] = floorAt[k];
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
  /** b is within CHAIN_HOPS nodes downstream of a */
  const nearChain = (a: number, b: number) => {
    let c = a;
    for (let h = 0; h < CHAIN_HOPS; h++) {
      const nx = next[c];
      if (nx === c) return false;
      c = nx;
      if (c === b) return true;
    }
    return false;
  };
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
      if (still[i] || isFixed(i)) continue;
      const bx = Math.floor(x[i] / B);
      const by = Math.floor(y[i] / B);
      if (rounds > 0) {
        let near = false;
        for (let dy = -R; dy <= R && !near; dy++) for (let dx = -R; dx <= R && !near; dx++) near = dirty[wi(by + dy, bh) * bw + wi(bx + dx, bw)] === 1;
        if (!near) continue;
      }
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const list = buckets[wi(by + dy, bh) * bw + wi(bx + dx, bw)];
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
            // (step 2: no cut-off at VW — the surface's own bound Φ, in the lower bound below, says when it can't reach)
            if (eLo > 0) {
              const F = VALLEY.FP_K[ti] * Math.max(width[j], width[k]);
              if (lo + VALLEY.FLOOD_SLOPE * eLo + VALLEY.SIGMA[ti] * Math.max(0, eLo - F - VALLEY.TAU * 0.7) + phi(eLo, ti) >= level[i]) continue;
            }
            const t = l2 > 1e-9 ? (px * abx + py * aby) / l2 : 0;
            // (no cap behind a segment's upstream end, but at a source: the segment above covers it)
            if (t < 0 && o.up[j] !== j) continue;
            const s = Math.min(1, Math.max(0, t));
            const d = Math.hypot(px - abx * s, py - aby * s);
            if (d > o.radius) continue;
            // (step 2: nor its own reach a few nodes up or down — a creek running beside the node it joins lowered it to
            // its interpolated level and back, a cycle of 13 nodes creeping down every round; 41 rounds, unsettled)
            if (nearChain(i, j) || nearChain(j, i)) continue;
            const w = width[j] + (width[k] - width[j]) * s;
            const e = Math.max(d - w, 0);
            const len = Math.sqrt(l2);
            // (the ground river j's valley leaves here — valley.wgsl's h = smin(G', S_j) (§9.5) with this node's least
            // ground for G': this river may not stand over it. A plain min, not the smin: smin(a, a) = a − k/4, so two
            // rivers at one level lowered each other by a cell a round and the clamp never settled)
            const sj = segLevel(level[j], level[k], !!(lava[j] && lava[k]), s, len) + vprof(e, w, ti) + phi(e, ti);
            const bound = Math.max(floorL, Math.min(gmin[i], sj));
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
    (o.stats.clampMoved ??= []).push(moved);
    if (!changed || !moved) break;
  }
  if (rounds >= MAX_ROUNDS) o.stats.clampUnsettled = true;
  o.stats.clamped = dropped.reduce((a, b) => a + b, 0);
  o.stats.clampRounds = rounds + 1;
  o.stats.clampMax = +maxDrop.toFixed(1);
  let rises = 0;
  for (let k = 0; k < n; k++) if (next[k] !== k && !still[next[k]] && level[next[k]] > level[k] + 1e-4) rises++;
  o.stats.rises = rises;
  if (fixed) {
    let fl = 0;
    for (let k = 0; k < n; k++) if (!isFixed(k) && floorAt[k] > -Infinity && level[k] > gmin[k] - 0.5 && level[k] <= floorAt[k] + 1e-4) fl++;
    o.stats.lakeFloated = fl;
  }
  return { cascaded };
}

export interface Rivers2 {
  nodes: Uint32Array;
  nodeAt: Uint32Array;
  /** per node: its main upstream node (itself: a source) — valley.wgsl's segments a node */
  up: Uint32Array;
  /** (step 2) per node: its valley head's far level (a water source's; NO_HEAD otherwise) — valley.wgsl's head segment */
  head: Float32Array;
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
  /** (step 3) the lakes: the basin (terrain/lakes.ts), its node (at the outlet), its level */
  lakes: { basin: number; node: number; level: number }[];
}

/** The whole of §1–§3: the tree, catchments, widths, levels, the node table (rivers.ts NODE_WORDS layout). */
export function walkRivers(inp: WalkInput): Rivers2 {
  const t0 = performance.now();
  const { n, G, water } = inp;
  const N = n * n;
  const stats: WalkStats = { walks: 0, lavaWalks: 0, merged: 0, toSea: 0, stranded: 0, clamped: 0, clampRounds: 0, clampMax: 0, rises: 0, ms: 0 };
  const tr = walkTree(inp, stats);
  stats.msWalk = +(performance.now() - t0).toFixed(0);
  const tb = performance.now();
  const count = tr.count;
  const lava = new Uint8Array(count);
  for (let k = 0; k < count; k++) lava[k] = tr.flags[k] & RIVER_LAVA;
  const tex = (k: number) => wi(Math.round(tr.y[k]), n) * n + wi(Math.round(tr.x[k]), n);
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
        const u = wi(ty + dy, n) * n + wi(tx + dx, n);
        if (owner[u] >= 0 || water[u]) continue;
        owner[u] = owner[t];
        queue[qt++] = u;
      }
  }
  const acc = new Float32Array(count);
  const rowRun = new Float64Array(n);
  for (let y = 0; y < n; y++) rowRun[y] = 1 - 0.85 * dryness((y + 0.5) / n);
  for (let y = 0, t = 0; y < n; y++) for (let x = 0; x < n; x++, t++) if (owner[t] >= 0 && !water[t]) acc[owner[t]] += rowRun[y];
  const order = upstreamFirst(tr.next);
  for (const k of order) {
    const j = tr.next[k];
    if (j !== k && !lava[k]) acc[j] += acc[k];
  }
  const width = new Float32Array(count);
  // (a source's Voronoi cell holds all the land behind it, so a head came out 9 wide from nowhere — the first stills:
  // the width grows in over WIDTH_TAPER nodes from the farthest source)
  const hopsUp = new Int32Array(count);
  for (const k of order) {
    const j = tr.next[k];
    if (j !== k) hopsUp[j] = Math.max(hopsUp[j], hopsUp[k] + 1);
  }
  // (step 2: a spring, not a blade — §9.5 riverWidth)
  for (let k = 0; k < count; k++) width[k] = lava[k] ? 3 : riverWidth(acc[k], hopsUp[k]);
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
    // (step 3: the land beside it — the sea's floor beside a river's last node held every river at the sea's level up
    // to its mouth, so none could fall into the sea from a raised coast: 7 mouths of 297 stood over the sea by 3)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const t = wi(cy + dy, n) * n + wi(cx + dx, n);
        if (!water[t]) m = Math.min(m, G[t]);
      }
    gmin[k] = m === Infinity ? G[wi(cy, n) * n + wi(cx, n)] : m;
  }
  const wx = new Float32Array(count);
  const wy = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    wx[k] = ((tr.x[k] + 0.5) / n) * inp.worldW;
    wy[k] = ((tr.y[k] + 0.5) / n) * inp.worldH;
  }
  const level = new Float32Array(count);
  stats.msBfs = +(performance.now() - tb).toFixed(0);
  const texW = 0.5 * (inp.worldW + inp.worldH) / n;
  const tierN = new Uint8Array(count);
  if (inp.tier) for (let k = 0; k < count; k++) tierN[k] = Math.min(3, inp.tier[tex(k)]);
  const lfN = new Int32Array(count);
  if (inp.landform) for (let k = 0; k < count; k++) lfN[k] = inp.landform[tex(k)];
  const tl = performance.now();
  // (step 3) the lakes' nodes stand at their basins' spill levels
  const fixed = new Float32Array(count).fill(NaN);
  const lakes: { basin: number; node: number; level: number }[] = [];
  for (let k = 0; k < count; k++) {
    const b = tr.lakeOf[k];
    if (b < 0) continue;
    fixed[k] = inp.basins!.basins[b].level;
    lakes.push({ basin: b, node: k, level: fixed[k] });
  }
  const { cascaded } = designLevels({ x: wx, y: wy, next: tr.next, still: tr.still, lava, width, gmin, tier: tierN, lf: lfN, up, sea: inp.sea, worldW: inp.worldW, worldH: inp.worldH, radius: CLAMP_RADIUS * texW, level, stats, fixed: lakes.length ? fixed : undefined });
  stats.msLevels = +(performance.now() - tl).toFixed(0);
  // (step 2, §9.5) each water source's valley head: the land's level HEAD.LEN cells on, straight up the valley
  const head = new Float32Array(Math.max(count, 1)).fill(NO_HEAD);
  for (let k = 0; k < count; k++) {
    const j = tr.next[k];
    if (lava[k] || tr.still[k] || up[k] !== k || j === k || tr.lakeOf[k] >= 0) continue;
    const dx = wrapD(wx[k] - wx[j], inp.worldW);
    const dy = wrapD(wy[k] - wy[j], inp.worldH);
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) continue;
    const hx = wx[k] + (dx / l) * HEAD.LEN;
    const hy = wy[k] + (dy / l) * HEAD.LEN;
    const gH = bilinear(G, n, (hx / inp.worldW) * n - 0.5, (hy / inp.worldH) * n - 0.5);
    head[k] = Math.max(gH, level[k] + HEAD.MIN);
  }
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
    head,
    count,
    lava: lava.reduce((a, b) => a + b, 0),
    waterfalls,
    catchments: { step, side, of, rowW, own, ref, order },
    shaped: { cascaded, falls, incision: +(incSum / Math.max(1, count)).toFixed(2) },
    speed: [r3(sp[0] ?? 0), r3(med(sp)), r3(sp[sp.length - 1] ?? 0)],
    discharge: r3(med(qs)),
    stats,
    lakes,
  };
}
