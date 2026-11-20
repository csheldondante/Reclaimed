// Nested scales lab, round 32 step A: a small CPU renderer of the cliff rule (src/nested/exp/cliffrule.ts). It ray-marches
// the rule directly, hierarchically: a 2D DDA over coarse cells, each skipped when the ray is above its bound; sheets by
// sampling + bisection; split cells by a quadtree descent with the rule's conservative bound per node, down to the level
// whose cell is ~1.5 px at the hit distance or the fine level. Steps = nodes visited (coarse cells + quadtree nodes), the
// number that predicts a shader's cost. A second march toward the sun (same traversal, the primary hit's level) gives
// shadows; a 4-sample solid test near the hit gives a cheap occlusion for recesses. Floats here only place rays; every
// height, up/down and notch comes from the rule. Nothing in the game uses it; test/unit/nested-cliffrule.test.ts drives
// it (RA_PICS=1) and writes the PNGs.
import {
  COARSE_M,
  KIND_SPLIT,
  UPM,
  cellBound,
  cellOf,
  erosion,
  fineTop,
  isUpLod,
  levelOff,
  notchAt,
  scoreRange,
  sheetAtF,
  thetaUsed,
  type Rules,
} from './cliffrule';

export interface View {
  eye: [number, number, number];
  target: [number, number, number];
  fovDeg: number;
  w: number;
  h: number;
  /** a column is drawn at the level whose cell is at least this many pixels (default 1.5) */
  px?: number;
  /** sun shadows (default on) and recess occlusion (default on) */
  shadows?: boolean;
  ao?: boolean;
}

const HIT_TOP = 1;
const HIT_SIDE = 2;
const HIT_FLOOR = 3; // a notch floor
const HIT_CEIL = 4; // a notch ceiling
const HIT_SHEET = 5;

interface Hit {
  kind: number;
  t: number;
  nx: number;
  ny: number;
  nz: number;
  /** the quadtree level the hit was resolved at (split cells), else -1 */
  level: number;
}

export interface Picture {
  rgb: Uint8Array;
  w: number;
  h: number;
  meanSteps: number;
  maxSteps: number;
  /** the shadow rays' steps (per pixel with a hit facing the sun) */
  meanShadowSteps: number;
  maxShadowSteps: number;
  capped: number;
}

const STEP_CAP = 6000;

interface Ctx {
  R: Rules;
  cmax: Float64Array;
  zTop: number;
  pxPerRad: number;
  minPx: number;
  notches: boolean;
}

/** march one ray; lodFixed = the level for every split cell (shadow rays), else (-1) from the pixel footprint */
function trace(
  C: Ctx,
  ex: number,
  ey: number,
  ez: number,
  dx: number,
  dy: number,
  dz: number,
  lodFixed: number,
  st: { steps: number },
): Hit | null {
  const R = C.R;
  const f = R.f;
  const Lf = R.p.fineLevel;
  const N = 1 << Lf;
  const W = f.nx * COARSE_M;
  const Hm = f.ny * COARSE_M;
  const c1 = clip(ex, dx, 0, W);
  const c2 = clip(ey, dy, 0, Hm);
  const tmin = Math.max(0, c1[0], c2[0]);
  const tmax = Math.min(1e9, c1[1], c2[1]);
  if (!(tmin < tmax)) return null;
  const t0 = tmin + 1e-6;
  let cx = Math.min(f.nx - 1, Math.max(0, Math.floor((ex + dx * t0) / COARSE_M)));
  let cy = Math.min(f.ny - 1, Math.max(0, Math.floor((ey + dy * t0) / COARSE_M)));
  const stx = dx > 0 ? 1 : -1;
  const sty = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(COARSE_M / dx) : 1e18;
  const tdy = dy !== 0 ? Math.abs(COARSE_M / dy) : 1e18;
  let tnx = dx !== 0 ? ((cx + (dx > 0 ? 1 : 0)) * COARSE_M - ex) / dx : 1e18;
  let tny = dy !== 0 ? ((cy + (dy > 0 ? 1 : 0)) * COARSE_M - ey) / dy : 1e18;
  let ta = tmin;
  let axis = -1;
  while (ta < tmax && cx >= 0 && cy >= 0 && cx < f.nx && cy < f.ny && st.steps < STEP_CAP) {
    const tb = Math.min(tnx, tny, tmax);
    st.steps++;
    const z0 = ez + dz * ta;
    const z1 = ez + dz * tb;
    if (dz > 0 && z0 > C.zTop) return null; // rising above everything
    if (Math.min(z0, z1) <= C.cmax[cy * f.nx + cx]) {
      const r = cellOf(R, cx, cy);
      let hit: Hit | null;
      if (r.kind !== KIND_SPLIT) hit = marchSheet(r, cx, cy, ta, tb, axis);
      else {
        let lmax = lodFixed;
        if (lmax < 0) {
          const distPx = C.pxPerRad / Math.max(ta, 1);
          lmax = 0;
          while (lmax < Lf && (COARSE_M / (1 << (lmax + 1))) * distPx >= C.minPx) lmax++;
        }
        hit = visit(r, cx, cy, 0, 0, 0, ta, tb, axis, 0, lmax);
      }
      if (hit) return hit;
    }
    if (tnx < tny) {
      ta = tnx;
      tnx += tdx;
      cx += stx;
      axis = 0;
    } else {
      ta = tny;
      tny += tdy;
      cy += sty;
      axis = 1;
    }
  }
  return null;

  function sideHit(t: number, ax: number, level: number): Hit {
    return ax === 0
      ? { kind: HIT_SIDE, t, nx: dx > 0 ? -1 : 1, ny: 0, nz: 0, level }
      : { kind: HIT_SIDE, t, nx: 0, ny: dy > 0 ? -1 : 1, nz: 0, level };
  }
  function marchSheet(r: ReturnType<typeof cellOf>, cx: number, cy: number, ta: number, tb: number, ax: number): Hit | null {
    const S = (t: number) => ez + dz * t - sheetM(r, cx, cy, ex + dx * t, ey + dy * t);
    if (S(ta) < 0) return ax >= 0 ? sideHit(ta, ax, -1) : null;
    const n = 8;
    let pa = ta;
    let fa = S(ta);
    for (let i = 1; i <= n; i++) {
      const pb = ta + ((tb - ta) * i) / n;
      const fb = S(pb);
      if (fa >= 0 && fb < 0) {
        let lo = pa;
        let hi = pb;
        for (let k = 0; k < 10; k++) {
          const m = 0.5 * (lo + hi);
          if (S(m) >= 0) lo = m;
          else hi = m;
        }
        const t = lo;
        const x = ex + dx * t;
        const y = ey + dy * t;
        const e = 0.05;
        const hx = sheetM(r, cx, cy, x + e, y) - sheetM(r, cx, cy, x - e, y);
        const hy = sheetM(r, cx, cy, x, y + e) - sheetM(r, cx, cy, x, y - e);
        const nn = norm3(-hx, -hy, 2 * e);
        return { kind: HIT_SHEET, t, nx: nn[0], ny: nn[1], nz: nn[2], level: -1 };
      }
      pa = pb;
      fa = fb;
    }
    return null;
  }
  function visit(
    r: ReturnType<typeof cellOf>,
    cx: number,
    cy: number,
    l: number,
    jx: number,
    jy: number,
    ta: number,
    tb: number,
    ax: number,
    knownIn: number,
    lmax: number,
  ): Hit | null {
    st.steps++;
    if (st.steps > STEP_CAP) return null;
    const known = knownIn + (l >= 1 ? levelOff(r, cx, cy, l, jx, jy, R.p) : 0);
    const th = thetaUsed(r, R.p);
    const z0 = ez + dz * ta;
    const z1 = ez + dz * tb;
    const sr = scoreRange(r, l, jx, jy, known, R.p);
    const maxTop = (sr.hi >= th ? r.H : r.L) / UPM;
    if (Math.min(z0, z1) > maxTop) return null;
    const size = COARSE_M / (1 << l);
    const x0 = cx * COARSE_M + jx * size;
    const y0 = cy * COARSE_M + jy * size;
    if (l === lmax) {
      const up = isUpLod(r, cx, cy, l, jx, jy, known, R.p);
      let topU = up ? r.H : r.L;
      const fineCol = l === Lf;
      const gx = cx * N + jx;
      const gy = cy * N + jy;
      if (fineCol && R.p.erode && up) topU -= erosion(R, gx, gy);
      const top = topU / UPM;
      if (z0 < top) {
        if (up && C.notches) {
          // the leaf's notches: levels 1..l (a coarser leaf at LOD takes its centre column's)
          const s = N >> l;
          const fgx = fineCol ? gx : cx * N + jx * s + (s >> 1);
          const fgy = fineCol ? gy : cy * N + jy * s + (s >> 1);
          const nz = notchAt(R, fgx, fgy, Math.floor(z0 * UPM), l);
          if (nz) {
            const lo = nz[0] / UPM;
            const hi = nz[1] / UPM;
            if (dz < 0 && z1 < lo) return { kind: HIT_FLOOR, t: (lo - ez) / dz, nx: 0, ny: 0, nz: 1, level: l };
            if (dz > 0 && z1 >= hi) return { kind: HIT_CEIL, t: (hi - ez) / dz, nx: 0, ny: 0, nz: -1, level: l };
            return null;
          }
        }
        if (ax < 0) return null; // the ray starts inside (a shadow ray's start): ignore this cell
        return sideHit(ta, ax, l);
      }
      if (z1 < top) return { kind: HIT_TOP, t: (top - ez) / dz, nx: 0, ny: 0, nz: 1, level: l };
      return null;
    }
    const xm = x0 + size / 2;
    const ym = y0 + size / 2;
    let c0t = 1e18;
    let c0a = 0;
    let c1t = 1e18;
    let c1a = 1;
    if (dx !== 0) {
      const t = (xm - ex) / dx;
      if (t > ta && t < tb) c0t = t;
    }
    if (dy !== 0) {
      const t = (ym - ey) / dy;
      if (t > ta && t < tb) c1t = t;
    }
    if (c1t < c0t) {
      const tt = c0t;
      c0t = c1t;
      c1t = tt;
      c0a = 1;
      c1a = 0;
    }
    const cuts = [ta, Math.min(c0t, tb), Math.min(c1t, tb), tb];
    const axes = [ax, c0a, c1a];
    for (let i = 0; i < 3; i++) {
      const sa = cuts[i];
      const sb = cuts[i + 1];
      if (!(sb > sa)) continue;
      const tm = 0.5 * (sa + sb);
      const qx = ex + dx * tm >= xm ? 1 : 0;
      const qy = ey + dy * tm >= ym ? 1 : 0;
      const hit = visit(r, cx, cy, l + 1, 2 * jx + qx, 2 * jy + qy, sa, sb, axes[i], known, lmax);
      if (hit) return hit;
    }
    return null;
  }
}

/** solid at a point (the rule's fine column top, less notch air; sheets by their fine column too) */
function solidAt(R: Rules, x: number, y: number, z: number): boolean {
  const N = 1 << R.p.fineLevel;
  const fm = COARSE_M / N;
  const gx = Math.floor(x / fm);
  const gy = Math.floor(y / fm);
  if (gx < 0 || gy < 0 || gx >= R.f.nx * N || gy >= R.f.ny * N) return false;
  const zu = Math.floor(z * UPM);
  if (zu >= fineTop(R, gx, gy)) return false;
  return !notchAt(R, gx, gy, zu);
}

export function render(R: Rules, v: View): Picture {
  const { w, h } = v;
  const rgb = new Uint8Array(w * h * 3);
  const f = R.f;
  const cmax = new Float64Array(f.nx * f.ny);
  let zTop = -1e9;
  for (let cy = 0; cy < f.ny; cy++)
    for (let cx = 0; cx < f.nx; cx++) {
      cmax[cy * f.nx + cx] = cellBound(R, cx, cy, 0, 0, 0).max / UPM;
      zTop = Math.max(zTop, cmax[cy * f.nx + cx]);
    }
  const [ex, ey, ez] = v.eye;
  let fx = v.target[0] - ex;
  let fy = v.target[1] - ey;
  let fz = v.target[2] - ez;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let rx = fy;
  let ry = -fx;
  const rl = Math.hypot(rx, ry);
  rx /= rl;
  ry /= rl;
  const ux = -ry * fz;
  const uy = rx * fz;
  const uz = rx * fy - ry * fx;
  const tanH = Math.tan((v.fovDeg * Math.PI) / 360);
  const C: Ctx = { R, cmax, zTop, pxPerRad: h / (2 * tanH), minPx: v.px ?? 1.5, notches: R.p.notchPctL.some((x) => x > 0) };
  const sun = norm3(-0.45, -0.75, 0.6);
  const doShadow = v.shadows ?? true;
  const doAo = v.ao ?? true;
  let stepsSum = 0;
  let stepsMax = 0;
  let shSum = 0;
  let shMax = 0;
  let shN = 0;
  let capped = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const sx = ((2 * (px + 0.5)) / w - 1) * tanH * (w / h);
      const sy = (1 - (2 * (py + 0.5)) / h) * tanH;
      let dx = fx + rx * sx + ux * sy;
      let dy = fy + ry * sx + uy * sy;
      let dz = fz + uz * sy;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const st = { steps: 0 };
      const hit = trace(C, ex, ey, ez, dx, dy, dz, -1, st);
      if (st.steps >= STEP_CAP) capped++;
      stepsSum += st.steps;
      stepsMax = Math.max(stepsMax, st.steps);
      let lit = 1;
      let ao = 1;
      if (hit) {
        const hx = ex + dx * hit.t;
        const hy = ey + dy * hit.t;
        const hz = ez + dz * hit.t;
        const ndl = hit.nx * sun[0] + hit.ny * sun[1] + hit.nz * sun[2];
        if (doShadow && ndl > 0) {
          const e = 0.02;
          const ss = { steps: 0 };
          const lod = hit.level >= 0 ? hit.level : levelFor(C, hit.t, R.p.fineLevel);
          const sh = trace(C, hx + hit.nx * e + sun[0] * e, hy + hit.ny * e + sun[1] * e, hz + hit.nz * e + sun[2] * e, sun[0], sun[1], sun[2], lod, ss);
          if (sh) lit = 0;
          shSum += ss.steps;
          shMax = Math.max(shMax, ss.steps);
          shN++;
        }
        if (doAo) ao = occlusion(R, hit, hx, hy, hz) * (C.notches ? hollow(R, hit, hx, hy, hz) : 1);
      }
      const o = (py * w + px) * 3;
      const col = shade(hit, dz, sun, lit, ao);
      rgb[o] = col[0];
      rgb[o + 1] = col[1];
      rgb[o + 2] = col[2];
    }
  }
  return {
    rgb,
    w,
    h,
    meanSteps: stepsSum / (w * h),
    maxSteps: stepsMax,
    meanShadowSteps: shN ? shSum / shN : 0,
    maxShadowSteps: shMax,
    capped,
  };
}

function levelFor(C: Ctx, t: number, Lf: number): number {
  const distPx = C.pxPerRad / Math.max(t, 1);
  let l = 0;
  while (l < Lf && (COARSE_M / (1 << (l + 1))) * distPx >= C.minPx) l++;
  return l;
}

/** (round 32 B2) a hollow's shadow, larger and deeper hollows darker: points 1, 3 and 8 m out from the hit (along a
 *  face's normal; for a notch floor or ceiling, the 4 plan directions) that have solid rock 1.5 or 5 m above them are
 *  overhung; up to 3 of them darken the hit to 0.4 */
function hollow(R: Rules, hit: Hit, x: number, y: number, z: number): number {
  if (hit.kind !== HIT_SIDE && hit.kind !== HIT_FLOOR && hit.kind !== HIT_CEIL) return 1;
  const dirs = hit.kind === HIT_SIDE ? [[hit.nx, hit.ny]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let n = 0;
  for (const [ux, uy] of dirs)
    for (const d of [1, 3, 8]) {
      const qx = x + ux * (d + 0.1);
      const qy = y + uy * (d + 0.1);
      if (solidAt(R, qx, qy, z + 1.5) || solidAt(R, qx, qy, z + 5)) n += 1 / dirs.length;
    }
  return 1 - 0.2 * n;
}
/** a cheap recess term: 4 solid tests 0.75 m around the hit, in front of a face (or above a top) */
function occlusion(R: Rules, hit: Hit, x: number, y: number, z: number): number {
  const d = 0.75;
  let n = 0;
  if (hit.kind === HIT_SIDE) {
    const tx = -hit.ny;
    const ty = hit.nx;
    const fx = x + hit.nx * 0.5;
    const fy = y + hit.ny * 0.5;
    if (solidAt(R, fx + tx * d, fy + ty * d, z)) n++;
    if (solidAt(R, fx - tx * d, fy - ty * d, z)) n++;
    if (solidAt(R, fx, fy, z + d)) n++;
    if (solidAt(R, fx, fy, z - d)) n++;
  } else if (hit.kind === HIT_CEIL) {
    return 0.6;
  } else {
    const zz = z + 0.3;
    if (solidAt(R, x + d, y, zz)) n++;
    if (solidAt(R, x - d, y, zz)) n++;
    if (solidAt(R, x, y + d, zz)) n++;
    if (solidAt(R, x, y - d, zz)) n++;
  }
  return 1 - 0.14 * n;
}

function sheetM(r: ReturnType<typeof cellOf>, cx: number, cy: number, x: number, y: number): number {
  const u = ((x - cx * COARSE_M) / COARSE_M) * 2 - 1;
  const v = ((y - cy * COARSE_M) / COARSE_M) * 2 - 1;
  return sheetAtF(r, clamp1(u), clamp1(v));
}
function clamp1(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}
function clip(o: number, d: number, lo: number, hi: number): [number, number] {
  if (Math.abs(d) < 1e-12) return o >= lo && o <= hi ? [-1e18, 1e18] : [1, 0];
  const a = (lo - o) / d;
  const b = (hi - o) / d;
  return a < b ? [a, b] : [b, a];
}
function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

const STONE = [0.6, 0.57, 0.52];
const GROUND = [0.44, 0.5, 0.36];

/** tops (columns' and sheets') are ground; vertical faces, notch floors and ceilings are stone */
function shade(hit: Hit | null, dz: number, sun: [number, number, number], lit: number, ao: number): [number, number, number] {
  if (!hit) {
    const s = Math.max(0, Math.min(1, 0.5 + dz));
    return toByte([0.62 + 0.2 * s, 0.72 + 0.15 * s, 0.85 + 0.1 * s]);
  }
  const ndl = Math.max(0, hit.nx * sun[0] + hit.ny * sun[1] + hit.nz * sun[2]) * lit;
  const hemi = 0.5 + 0.5 * hit.nz; // sky fill: more from above
  let li: number;
  let base = STONE;
  switch (hit.kind) {
    case HIT_SHEET:
    case HIT_TOP:
      base = GROUND;
      li = (0.22 + 0.12 * hemi) * ao + 0.68 * ndl;
      break;
    case HIT_SIDE:
      li = (0.2 + 0.12 * hemi) * ao + 0.62 * ndl;
      break;
    case HIT_FLOOR:
      li = (0.2 + 0.12 * hemi) * ao + 0.6 * ndl;
      break;
    case HIT_CEIL:
      li = 0.12 * ao;
      break;
    default:
      li = 1;
  }
  const haze = 1 - Math.exp(-hit.t / 2500);
  const sky = [0.78, 0.84, 0.9];
  return toByte([0, 1, 2].map((i) => base[i] * li * (1 - haze) + sky[i] * haze));
}
function toByte(c: number[]): [number, number, number] {
  const g = (x: number) => Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.max(0, x), 1 / 1.6))));
  return [g(c[0]), g(c[1]), g(c[2])];
}
