// Nested scales lab, round 32 step C0 (docs/handoff/nested/CLIFF_COLUMNS.md, the owner's "fractal of column subtraction"):
// cliff rule v2 on the CPU. cliffrule.ts stays THE v1 definition; v2 reuses its kinds, H / L, direction (a, b), sheets
// and hashes, and replaces "which columns are up" (ragged nested offsets + notches) with:
//
//  1. BASE: a split 16 m cell is cut into 8 x 8 blocks of 2 m. A block is up (top H) when its score
//     (a * wc(bx) + b * wc(by)) * TIE + tie(block) is among the `want` highest of the 64, want = round(64 (h-L)/(H-L)),
//     else down (top L): a clean straight boundary in 2 m steps, no per-level offsets, the block share nearest the
//     mean (v1's w at wLevel 3; the exact count replaces v1's closed-form theta + dTheta). Sheet cells keep v1's smooth
//     surface for drawing; for the subtraction their 2 m blocks count with the sheet height at the block centre.
//     Solid at level 0 = z < baseTop(block).
//  2. SUBTRACTION, level l = 1..maxLevel, cell size s_l = 16 m / 2^(l qPer) (variant A: qPer 3, 16 -> 2 -> 0.25 ->
//     1/32 m ...; B: qPer 1, 16 -> 8 -> 4 ...). Plan cells at depth q(l) = max(l qPer, 3) (never coarser than the 2 m
//     base blocks, so a level-l "column" is constant in plan); z in slabs of s_l on a global grid. A point p in a split
//     cell, in level-l slab k (mid-height zm), is REMOVED at level l when
//       - its slab is not in the top layer: (k + 1) s_l <= baseTop(p) - s_l (tops are never cut; the layer is s_l..2 s_l),
//       - p is solid at level l-1 at zm,
//       - for some plan direction n (E, W, N, S) and j in 1..dMax: the points p + i s_l n (i = 1..j-1) are solid at
//         level l-1 at zm, p + j s_l n is air at level l-1 at zm, and d(f, zm) >= j, where f = the level-l cell of
//         p + (j-1) s_l n (the FACE cell) and d is hashed per face cell and per z span: zm's block of zBlock slabs (the
//         block grid shifted per face cell by a hashed 0..zBlock-1 slabs) is cut at a hashed slab (or not), and each
//         span hashes d uniformly in 0..dMax.
//     Solid at level l = solid at level l-1 and not removed at level l. Removal is horizontal only, from faces (air
//     beside stone at the same height); tops and floors are never sources.
//  The "half-cell" rule: dMax s_l < s_(l-1) / 2 for A (3/8); for B dMax s_l = s_(l-1) / 2 exactly (not less).
//
// EVALUATION COST of one point (the brief's question): stateAt(l, p, z) needs removed(m, anc_m(p), slab) for m = 1..l;
// removed(m) needs solid at level m-1 at up to 1 + 4 dMax points, which recursively need levels < m-1 at the same
// slab-mid heights. Unmemoised that is ~(1 + 4 dMax)^(l-1) evaluations (13^(l-1) for A); here a memo per (level, cell,
// slab) makes it cheap on the CPU. A GPU cannot memoise; the same answer comes from a fixed window pass per level
// (cliffrule2.ts header, "local form" in the report): at each level only the 3 x 3 cells around anc_m(p) are needed at
// level m (offsets <= dMax s_m stay within one neighbour of the parent), so one point costs about
// levels x 9 cells x (1 + 4 dMax) lookups, evaluated coarse to fine at the one slab-mid height per level.
//
// THE BOUND (per node at level l >= the base level, at height z): finer levels remove only within
// sum_{m>l} dMax s_m < s_l horizontally (A: 3/7 s_l, B: < s_l) and drift at most sum_{m>l} s_m / 2 in z (slab mids) of
// air of level l. So: AIR at every finer level where level l is air (monotone); SOLID at every finer level where the
// node and its 8 neighbours are solid at level l over [z - rz, z + rz], rz = sum_{m>l} s_m / 2; else MIXED.
import { COARSE_M, KIND_SPLIT, NBX, NBY, TIE, UPM, cellOf, fdiv, hash3, mix, sheetAtF, tieOf, wCentre, type Rules } from './cliffrule';

/** v2 height units per metre (1/4096 m: the finest cell used, 1/2048 m, is 2 units, so slab mids are integers) */
export const ZU = 4096;
const U2 = ZU / UPM;
/** the base boundary's block depth: 2 m */
export const BASE_Q = 3;
const SIZE0 = COARSE_M * ZU; // 16 m in v2 units

export interface V2Params {
  name: string;
  /** plan subdivision per level as a power of two: 3 = 8x (A), 1 = 2x (B) */
  qPer: number;
  /** the deepest subtraction, in that level's cells (d is hashed in 0..dMax) */
  dMax: number;
  /** the deepest level (cell 2 units = 1/2048 m at most) */
  maxLevel: number;
  /** a span block in slabs; cut once at a hashed slab 1..zBlock-1 (or not: hash 0) */
  zBlock: number;
  seed: number;
}
export function variantA(): V2Params {
  return { name: 'A', qPer: 3, dMax: 3, maxLevel: 5, zBlock: 4, seed: 1 };
}
export function variantB(): V2Params {
  return { name: 'B', qPer: 1, dMax: 1, maxLevel: 15, zBlock: 4, seed: 1 };
}

export interface Rules2 {
  R: Rules;
  v: V2Params;
  /** base tops per 2 m block of the whole map (row-major, 8 nx by 8 ny), v2 units */
  top: Int32Array;
  bnx: number;
  bny: number;
  /** split flag per coarse cell */
  split: Uint8Array;
  /** removed(level, cell, slab) memo: outer key level/cell, inner key slab, value 0/1 */
  memo: Map<number, Map<number, number>>;
  /** counters */
  removedCalls: number;
}

export function qOf(v: V2Params, l: number): number {
  return Math.max(l * v.qPer, BASE_Q);
}
/** level l's cell size, v2 units */
export function sizeL(v: V2Params, l: number): number {
  return SIZE0 >> (l * v.qPer);
}
/** the first level whose cells are no larger than a base block */
export function baseLevel(v: V2Params): number {
  return Math.ceil(BASE_Q / v.qPer);
}

const SALT_V2 = 0x700;

export function deriveRules2(R: Rules, v: V2Params): Rules2 {
  const f = R.f;
  const bnx = f.nx * 8;
  const bny = f.ny * 8;
  const top = new Int32Array(bnx * bny);
  const split = new Uint8Array(f.nx * f.ny);
  const p = R.p;
  // w at 2 m block centres: wCentre with wLevel 3 / fineLevel 6 gives the block centre in 0.25 m half-cells
  const pw = { ...p, wLevel: 3, fineLevel: 6 };
  for (let cy = 0; cy < f.ny; cy++)
    for (let cx = 0; cx < f.nx; cx++) {
      const r = cellOf(R, cx, cy);
      if (r.kind === KIND_SPLIT) {
        split[cy * f.nx + cx] = 1;
        const sc: number[] = [];
        for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) sc.push((r.a * wCentre(bx, pw) + r.b * wCentre(by, pw)) * TIE + tieOf(cx * 8 + bx, cy * 8 + by, pw));
        const sorted = sc.slice().sort((x, y) => y - x);
        const want = Math.round((64 * (r.h - r.L)) / (r.H - r.L));
        const th = want <= 0 ? sorted[0] + 1 : sorted[want - 1];
        for (let by = 0; by < 8; by++)
          for (let bx = 0; bx < 8; bx++) top[(cy * 8 + by) * bnx + cx * 8 + bx] = (sc[by * 8 + bx] >= th ? r.H : r.L) * U2;
      } else {
        for (let by = 0; by < 8; by++)
          for (let bx = 0; bx < 8; bx++) top[(cy * 8 + by) * bnx + cx * 8 + bx] = Math.round(sheetAtF(r, (2 * bx + 1) / 8 - 1, (2 * by + 1) / 8 - 1) * ZU);
      }
    }
  return { R, v, top, bnx, bny, split, memo: new Map(), removedCalls: 0 };
}

/** the base top of a depth-q cell (q >= 3), v2 units; outside the map the nearest block's */
export function baseTop(T: Rules2, gx: number, gy: number, q: number): number {
  let bx = gx >> (q - BASE_Q);
  let by = gy >> (q - BASE_Q);
  bx = bx < 0 ? 0 : bx >= T.bnx ? T.bnx - 1 : bx;
  by = by < 0 ? 0 : by >= T.bny ? T.bny - 1 : by;
  return T.top[by * T.bnx + bx];
}
export function isSplitQ(T: Rules2, gx: number, gy: number, q: number): boolean {
  const cx = gx >> q;
  const cy = gy >> q;
  const f = T.R.f;
  if (cx < 0 || cy < 0 || cx >= f.nx || cy >= f.ny) return false;
  return T.split[cy * f.nx + cx] === 1;
}

function saltV(T: Rules2, s: number): number {
  return (s + Math.imul(T.v.seed, 0x10001)) | 0;
}
/** the hashed depth 0..dMax of level-l face cell (fx, fy) (level-l plan indices) at height z (v2 units) */
export function depthOf(T: Rules2, l: number, fx: number, fy: number, z: number): number {
  const v = T.v;
  const s = sizeL(v, l);
  const B = v.zBlock * s;
  // each face cell's block grid is shifted by a hashed phase of whole slabs, so block ends do not line up across the
  // face (on one global grid every face cell changed depth at the same heights: a straight seam every zBlock slabs)
  const zp = z + (hash3(fx, fy, saltV(T, SALT_V2 + 0x40 + l)) % v.zBlock) * s;
  const zb = fdiv(zp, B);
  const h = hash3(fx, fy, saltV(T, SALT_V2 + l) ^ Math.imul(zb, 0x27d4eb2d));
  const cut = h % v.zBlock; // 0: the block is one span
  const span = cut > 0 && zp - zb * B >= cut * s ? 1 : 0;
  const h2 = mix(h ^ (span ? 0x5bd1e995 : 0x1b873593));
  return (h2 >>> 8) % (v.dMax + 1);
}

/** is level-l slab k of depth-q(l) cell (gx, gy) removed at level l (only level l's own removal) */
export function removedL(T: Rules2, l: number, gx: number, gy: number, k: number): boolean {
  const v = T.v;
  const q = qOf(v, l);
  if (!isSplitQ(T, gx, gy, q)) return false;
  const s = sizeL(v, l);
  const top = baseTop(T, gx, gy, q);
  if ((k + 1) * s > top - s) return false; // the top layer
  const key = (l * 4194304 + gx) * 4194304 + gy;
  let inner = T.memo.get(key);
  if (inner) {
    const m = inner.get(k);
    if (m !== undefined) return m === 1;
  } else {
    inner = new Map();
    T.memo.set(key, inner);
  }
  T.removedCalls++;
  const zm = k * s + (s >> 1);
  let out = false;
  const q1 = qOf(v, l - 1);
  const sh = q - q1;
  if (stateAt(T, l - 1, gx >> sh, gy >> sh, zm) === 0) {
    const o = 1 << (q - l * v.qPer); // a level-l cell in depth-q cells
    const fsh = q - l * v.qPer;
    for (let n = 0; n < 4 && !out; n++) {
      for (let j = 1; j <= v.dMax; j++) {
        const nx = gx + j * o * NBX[n];
        const ny = gy + j * o * NBY[n];
        if (stateAt(T, l - 1, nx >> sh, ny >> sh, zm) !== 0) {
          const fx = (gx + (j - 1) * o * NBX[n]) >> fsh;
          const fy = (gy + (j - 1) * o * NBY[n]) >> fsh;
          if (depthOf(T, l, fx, fy, zm) >= j) out = true;
          break;
        }
      }
    }
  }
  inner.set(k, out ? 1 : 0);
  return out;
}

/** the state at level m of depth-q(m) cell (gx, gy) at height z (v2 units): 0 solid, -1 air above the base top, else
 *  the coarsest level 1..m whose subtraction removed it (its whole slab is air: the march may skip to its boundary) */
export function stateAt(T: Rules2, m: number, gx: number, gy: number, z: number): number {
  const v = T.v;
  const q = qOf(v, m);
  if (z >= baseTop(T, gx, gy, q)) return -1;
  for (let l = 1; l <= m; l++) {
    const sh = q - qOf(v, l);
    if (removedL(T, l, gx >> sh, gy >> sh, fdiv(z, sizeL(v, l)))) return l;
  }
  return 0;
}

/** solid at a point in metres at level m */
export function solidAtM(T: Rules2, m: number, x: number, y: number, z: number): boolean {
  const q = qOf(T.v, m);
  const c = (COARSE_M / (1 << q));
  return stateAt(T, m, Math.floor(x / c), Math.floor(y / c), Math.floor(z * ZU)) === 0;
}

/** any solid at level l in [za, zb] (v2 units) in cell (gx, gy) at depth q(l); counts queries in st */
export function anySolid(T: Rules2, l: number, gx: number, gy: number, za: number, zb: number, st: { slabs: number }): boolean {
  let z = Math.floor(za);
  while (z <= zb) {
    st.slabs++;
    const s = stateAt(T, l, gx, gy, z);
    if (s === 0) return true;
    if (s < 0) return false;
    const sm = sizeL(T.v, s);
    z = (fdiv(z, sm) + 1) * sm;
  }
  return false;
}
/** solid everywhere in [za, zb] at level l (state is constant on level-l slabs below the base top) */
export function allSolid(T: Rules2, l: number, gx: number, gy: number, za: number, zb: number, st: { slabs: number }): boolean {
  const q = qOf(T.v, l);
  if (zb >= baseTop(T, gx, gy, q)) return false;
  const s = sizeL(T.v, l);
  let z = Math.floor(za);
  while (z <= zb) {
    st.slabs++;
    if (stateAt(T, l, gx, gy, z) !== 0) return false;
    z = (fdiv(z, s) + 1) * s;
  }
  return true;
}
/** the z reach of finer levels' slab mids, v2 units */
export function zReach(v: V2Params, l: number): number {
  let r = 0;
  for (let m = l + 1; m <= v.maxLevel; m++) r += sizeL(v, m) >> 1;
  return r + 1;
}
/** THE BOUND, solid side: level-l node (gx, gy) is solid at height z at every finer level */
export function sureSolid(T: Rules2, l: number, gx: number, gy: number, z: number, st: { slabs: number }): boolean {
  const rz = zReach(T.v, l);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if (!allSolid(T, l, gx + dx, gy + dy, z - rz, z + rz, st)) return false;
  return true;
}
