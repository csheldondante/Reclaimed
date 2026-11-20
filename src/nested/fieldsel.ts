// Nested scales lab, round 26 (docs/design/NESTED_SCALES.md "Round 26 plan"): the field mesh's field and its sparse
// cell selection, in plain TypeScript: the reference the GPU's fieldBake (gpu/field.wgsl) follows, and the unit tests'
// subject (test/unit/nested-field.test.ts: every crossed cell selected, against a brute walk of every cube).
//
// The field (level-local units, after fortress fieldmesh.wgsl colDist / terrainField): a column's vertical signed
// distance to its solid runs (negative inside, clamped to +-FAR), blended bilinearly over the 4 nearest column centres
// at the warped lookup point. Samples sit at column centres (x = X + 0.5), one unit apart in z; cell (X, Y, K) is the
// box between sample columns X..X+1, Y..Y+1 and heights K..K+1.
//
// The selection: a cell's corner samples read only its SUPPORT columns (the columns their warped points can touch, and
// the parent's where the fade is under 1). On a z range where every support column is in one state and none has a
// boundary, every sample has that state's sign (a weighted mean of same-sign values), so the cell cannot be crossed.
// One merge sweep over the support's boundaries gives the candidate set (where they disagree, and the boundaries).

export const FAR = 3;
/** a column's partition (bottom up): each record's top and material; the first record is open downward, air above */
export interface PCol {
  top: ArrayLike<number>;
  mat: ArrayLike<number>;
}
/** which records count as inside (round 26: solid; water later is a different test, same mesher) */
export type Inside = (m: number) => boolean;
export const solidInside: Inside = (m) => (m & 0xff) !== 0;

/** a column's runs: whether it is inside at the bottom, and the heights where inside / outside changes (ascending) */
export interface Runs {
  bottomIn: boolean;
  b: number[];
}
export function runsOf(c: PCol | null, inside: Inside): Runs {
  const b: number[] = [];
  if (!c || c.mat.length === 0) return { bottomIn: false, b };
  const bottomIn = inside(c.mat[0]);
  let s = bottomIn;
  for (let j = 0; j < c.mat.length; j++) {
    // (above record j: record j + 1, or air)
    const next = j + 1 < c.mat.length ? inside(c.mat[j + 1]) : false;
    if (next !== s) b.push(c.top[j]);
    s = next;
  }
  return { bottomIn, b };
}
/** vertical signed distance at z (negative inside), clamped to +-FAR; on a boundary 0 (outside) */
export function runDist(r: Runs, z: number): number {
  let s = r.bottomIn;
  let lo = -Infinity;
  for (let i = 0; i <= r.b.length; i++) {
    const hi = i < r.b.length ? r.b[i] : Infinity;
    if (z < hi) {
      const d = Math.min(z - lo, hi - z);
      return s ? -Math.min(d, FAR) : Math.min(d, FAR);
    }
    lo = hi;
    s = !s;
  }
  return FAR;
}

// ---- the warp (fortress meshregion.wgsl terrainWarp, in column units) -------------------------------------------------
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 8) / 16777216;
}
const sstep = (t: number) => t * t * (3 - 2 * t);
export function warpNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = sstep(x - ix);
  const fy = sstep(y - iy);
  const fz = sstep(z - iz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const p = (dx: number, dy: number, dz: number) => hash3(ix + dx, iy + dy, iz + dz);
  return l(l(l(p(0, 0, 0), p(1, 0, 0), fx), l(p(0, 1, 0), p(1, 1, 0), fx), fy), l(l(p(0, 0, 1), p(1, 0, 1), fx), l(p(0, 1, 1), p(1, 1, 1), fx), fy), fz);
}
/** where the field is looked up for point p: moved sideways by up to W columns (W = 0: not moved) */
export function warpXY(x: number, y: number, z: number, W: number): [number, number] {
  if (W <= 0) return [x, y];
  const qx = x * 0.45;
  const qy = y * 0.45;
  const qz = z * 0.6;
  return [x + (warpNoise(qx, qy, qz) - 0.5) * 2 * W, y + (warpNoise(qx + 17.3, qy + 5.1, qz + 9.7) - 0.5) * 2 * W];
}

// ---- a level as the field reads it ---------------------------------------------------------------------------------
export interface FieldLevel {
  /** the window: global columns [gx, gx + n) x [gy, gy + n) */
  gx: number;
  gy: number;
  n: number;
  /** a column's runs (global column; only asked inside the window) */
  runs(X: number, Y: number): Runs;
}
export interface FieldSpec {
  own: FieldLevel;
  /** the parent (absent for the root): its columns, k, and the own level's z origin in the parent's units */
  parent?: { lv: FieldLevel; k: number; zo: number };
  warp: number;
  /** the fade's width, columns (w = 0 within 1 column of the window edge, 1 from 1 + fade in) */
  fade: number;
}
const clampI = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function bil(lv: FieldLevel, x: number, y: number, z: number): number {
  const i = Math.floor(x - 0.5);
  const j = Math.floor(y - 0.5);
  const fx = x - 0.5 - i;
  const fy = y - 0.5 - j;
  // (columns outside the window clamped to it: the root's edge; a child never reads outside, w = 0 there)
  const c = (X: number, Y: number) => runDist(lv.runs(clampI(X, lv.gx, lv.gx + lv.n - 1), clampI(Y, lv.gy, lv.gy + lv.n - 1)), z);
  let d = 0;
  if (fx < 1 && fy < 1) d += (1 - fx) * (1 - fy) * c(i, j);
  if (fx > 0 && fy < 1) d += fx * (1 - fy) * c(i + 1, j);
  if (fx < 1 && fy > 0) d += (1 - fx) * fy * c(i, j + 1);
  if (fx > 0 && fy > 0) d += fx * fy * c(i + 1, j + 1);
  return d;
}
/** the fade weight of the own level at lookup point (x, y): 0 within 1 column of the window edge, 1 from 1 + fade in */
export function fadeW(s: FieldSpec, x: number, y: number): number {
  if (!s.parent) return 1;
  const o = s.own;
  const d = Math.min(x - o.gx, o.gx + o.n - x, y - o.gy, o.gy + o.n - y);
  const t = clampI((d - 1) / s.fade, 0, 1);
  return t * t * (3 - 2 * t);
}
/** the field at level-local point (x global columns, y, z local units) */
export function fieldAt(s: FieldSpec, x: number, y: number, z: number): number {
  const [qx, qy] = warpXY(x, y, z, s.warp);
  const w = fadeW(s, qx, qy);
  let f = 0;
  if (w > 0) f += w * bil(s.own, qx, qy, z);
  if (w < 1 && s.parent) {
    const P = s.parent;
    const dp = bil(P.lv, qx / P.k, qy / P.k, z / P.k + P.zo) * P.k;
    f += (1 - w) * clampI(dp, -FAR, FAR);
  }
  return f;
}

// ---- the selection ----------------------------------------------------------------------------------------------------
/** the support of cell column (X, Y): the own and parent columns any corner sample can read */
export function support(s: FieldSpec, X: number, Y: number): { own: [number, number][]; parent: [number, number][] } {
  const W = s.warp;
  const a = [X + 0.5 - W, Y + 0.5 - W];
  const b = [X + 1.5 + W, Y + 1.5 + W];
  const o = s.own;
  let wantOwn = true;
  let wantPar = false;
  if (s.parent) {
    // (the fade over the box of warped sample points: max and min of min(dx, dy), separable)
    const dmax = (lo: number, hi: number, g: number, n: number) => {
      const c = clampI(g + n / 2, lo, hi);
      return Math.min(c - g, g + n - c);
    };
    const dmin = (lo: number, hi: number, g: number, n: number) => Math.min(lo - g, g + n - lo, hi - g, g + n - hi);
    const hi = Math.min(dmax(a[0], b[0], o.gx, o.n), dmax(a[1], b[1], o.gy, o.n));
    const lo = Math.min(dmin(a[0], b[0], o.gx, o.n), dmin(a[1], b[1], o.gy, o.n));
    wantOwn = hi > 1;
    wantPar = lo < 1 + s.fade;
  }
  const cols = (x0: number, x1: number, y0: number, y1: number, lv: FieldLevel, clamp: boolean) => {
    const out = new Map<string, [number, number]>();
    // (the columns whose bilinear weight can be non-zero for a lookup point in [x0, x1]: |c + 0.5 - x| < 1)
    for (let y = Math.floor(y0 - 0.5); y <= Math.ceil(y1 - 0.5); y++)
      for (let x = Math.floor(x0 - 0.5); x <= Math.ceil(x1 - 0.5); x++) {
        let cx = x;
        let cy = y;
        if (clamp) {
          cx = clampI(x, lv.gx, lv.gx + lv.n - 1);
          cy = clampI(y, lv.gy, lv.gy + lv.n - 1);
        } else if (x < lv.gx || y < lv.gy || x >= lv.gx + lv.n || y >= lv.gy + lv.n) continue;
        out.set(`${cx},${cy}`, [cx, cy]);
      }
    return [...out.values()];
  };
  const own = wantOwn ? cols(a[0], b[0], a[1], b[1], o, !s.parent) : [];
  const parent = wantPar && s.parent ? cols(a[0] / s.parent.k, b[0] / s.parent.k, a[1] / s.parent.k, b[1] / s.parent.k, s.parent.lv, true) : [];
  return { own, parent };
}
/** the candidate cells of cell column (X, Y): ranges [k0, k1] (inclusive, ascending, disjoint), with `margin` cells more
 *  each side of every candidate interval */
export function candidates(s: FieldSpec, X: number, Y: number, margin = 1): [number, number][] {
  const sp = support(s, X, Y);
  const rs: Runs[] = sp.own.map(([x, y]) => s.own.runs(x, y));
  if (s.parent) {
    const P = s.parent;
    for (const [x, y] of sp.parent) {
      const r = P.lv.runs(x, y);
      rs.push({ bottomIn: r.bottomIn, b: r.b.map((z) => (z - P.zo) * P.k) });
    }
  }
  return sweep(rs, margin);
}
/** the merge sweep over the support's runs: the closed candidate intervals as cell ranges */
export function sweep(rs: Runs[], margin: number): [number, number][] {
  const n = rs.length;
  if (n === 0) return [];
  const cur = rs.map(() => 0);
  let inside = 0;
  let low = Infinity;
  for (const r of rs) {
    if (r.bottomIn) inside++;
    if (r.b.length) low = Math.min(low, r.b[0]);
  }
  if (low === Infinity) return [];
  // (a column inside at the bottom beside one that is not: a wall with no foot; cut FAR + 1 under the lowest boundary)
  let prev = low - FAR - 1;
  const out: [number, number][] = [];
  const add = (a: number, b: number) => {
    const k0 = Math.ceil(a) - 1 - margin;
    const k1 = Math.floor(b) + margin;
    const last = out[out.length - 1];
    if (last && k0 <= last[1] + 1) last[1] = Math.max(last[1], k1);
    else out.push([k0, k1]);
  };
  for (;;) {
    let zb = Infinity;
    for (let i = 0; i < n; i++) if (cur[i] < rs[i].b.length) zb = Math.min(zb, rs[i].b[cur[i]]);
    if (zb === Infinity) break;
    if (inside > 0 && inside < n) add(prev, zb);
    else add(zb, zb);
    for (let i = 0; i < n; i++)
      while (cur[i] < rs[i].b.length && rs[i].b[cur[i]] === zb) {
        const wasIn = (rs[i].bottomIn ? 1 : 0) ^ (cur[i] & 1);
        inside += wasIn ? -1 : 1;
        cur[i]++;
      }
    prev = zb;
  }
  return out;
}
/** whether cell (X, Y, K) is crossed: its 8 corner samples not all one sign (inside: < 0) */
export function crossed(s: FieldSpec, X: number, Y: number, K: number): boolean {
  let inside = 0;
  for (let c = 0; c < 8; c++) if (fieldAt(s, X + 0.5 + (c & 1), Y + 0.5 + ((c >> 1) & 1), K + (c >> 2)) < 0) inside++;
  return inside > 0 && inside < 8;
}
