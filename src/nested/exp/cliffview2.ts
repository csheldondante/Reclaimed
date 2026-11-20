// Nested scales lab, round 32 step C0: a CPU ray march of cliff rule v2 (cliffrule2.ts), modelled on cliffview.ts (same
// camera, sun, shading, shadows, recess terms). A 2D DDA over coarse cells; sheets as in v1; split cells by a descent
// over the rule's own levels (8 x 8 children per node for A, 2 x 2 for B, walked by a DDA inside the node). Per node:
// skip when the ray is above the node's base top or when the node is air at its level over the ray's z range (finer
// levels only remove); stop with a side hit when the node is SURE SOLID at the entry (cliffrule2 sureSolid: the node
// and its 8 neighbours solid at its level within the finer levels' z reach); else descend. At the pixel's level (cell
// about `px` pixels) the leaf walks its column in z coarse-first: an air slab removed at level m is crossed in one
// step to the end of that level's slab. Counters: nodes (coarse cells + nodes visited) and slab queries.
import { COARSE_M, KIND_SPLIT, UPM, cellOf, fdiv as fdivF, sheetAtF } from './cliffrule';
import { BASE_Q, ZU, anySolid, baseLevel, baseTop, sizeL, solidAtM, stateAt, sureSolid, type Rules2 } from './cliffrule2';
import type { View } from './cliffview';

const HIT_TOP = 1;
const HIT_SIDE = 2;
const HIT_FLOOR = 3;
const HIT_CEIL = 4;
const HIT_SHEET = 5;

export interface Hit {
  kind: number;
  t: number;
  nx: number;
  ny: number;
  nz: number;
  level: number;
}

export interface Picture2 {
  rgb: Uint8Array;
  w: number;
  h: number;
  meanNodes: number;
  maxNodes: number;
  meanSlabs: number;
  maxSlabs: number;
  meanShadowNodes: number;
  maxShadowNodes: number;
  capped: number;
  /** pixels per leaf level (index = level) */
  levelHist: number[];
}

const NODE_CAP = 4000;

interface St {
  nodes: number;
  slabs: number;
}

/** dbg: called per pixel with its hit (diagnostics only) */
export function render2(T: Rules2, v: View, dbg?: (px: number, py: number, hit: Hit | null, lit: number, nodes: number) => void): Picture2 {
  const R = T.R;
  const f = R.f;
  const V = T.v;
  const cmax = new Float64Array(f.nx * f.ny);
  let zTop = -1e9;
  for (let cy = 0; cy < f.ny; cy++)
    for (let cx = 0; cx < f.nx; cx++) {
      const r = cellOf(R, cx, cy);
      let m = r.kind === KIND_SPLIT ? r.H : -1e9;
      if (r.kind !== KIND_SPLIT) for (let i = 0; i < 9; i++) m = Math.max(m, r.ctrl[i]);
      cmax[cy * f.nx + cx] = m / UPM;
      zTop = Math.max(zTop, m / UPM);
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
  const pxPerRad = v.h / (2 * tanH);
  const minPx = v.px ?? 1;
  const lBase = baseLevel(V);
  const k = 1 << V.qPer;
  const aoLevel = Math.min(V.maxLevel, Math.round(6 / V.qPer)); // 0.25 m

  function levelAt(t: number): number {
    const distPx = pxPerRad / Math.max(t, 0.01);
    let l = 0;
    while (l < V.maxLevel && (sizeL(V, l + 1) / ZU) * distPx >= minPx) l++;
    return Math.max(l, lBase);
  }

  function trace(ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, lodFixed: number, st: St): Hit | null {
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
    while (ta < tmax && cx >= 0 && cy >= 0 && cx < f.nx && cy < f.ny && st.nodes < NODE_CAP) {
      const tb = Math.min(tnx, tny, tmax);
      st.nodes++;
      const z0 = ez + dz * ta;
      const z1 = ez + dz * tb;
      if (dz > 0 && z0 > zTop) return null;
      if (Math.min(z0, z1) <= cmax[cy * f.nx + cx]) {
        const r = cellOf(R, cx, cy);
        let hit: Hit | null;
        if (r.kind !== KIND_SPLIT) hit = marchSheet(r, cx, cy, ta, tb, axis);
        else hit = visit(0, cx, cy, ta, tb, axis, lodFixed);
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
          for (let q = 0; q < 10; q++) {
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
    /** the highest base top inside a node coarser than a base block, v2 units */
    function nodeTopMax(l: number, gx: number, gy: number): number {
      const ql = l * V.qPer;
      const n = 1 << (BASE_Q - ql);
      let m = -2147483647;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) m = Math.max(m, baseTop(T, gx * n + i, gy * n + j, BASE_Q));
      return m;
    }
    /** lodFixed >= 0: that level (shadow rays); else the node's own entry distance picks it (a camera inside a coarse
     *  cell must not take the coarse cell's entry, ~0 m) */
    function visit(l: number, gx: number, gy: number, ta: number, tb: number, ax: number, lodFixed: number): Hit | null {
      st.nodes++;
      const lmax = lodFixed >= 0 ? lodFixed : levelAt(ta);
      if (st.nodes > NODE_CAP) return null;
      const z0 = ez + dz * ta;
      const z1 = ez + dz * tb;
      const zlo = Math.min(z0, z1) * ZU;
      const zhi = Math.max(z0, z1) * ZU;
      const ql = l * V.qPer;
      if (ql < BASE_Q) {
        if (zlo >= nodeTopMax(l, gx, gy)) return null;
      } else {
        const top = baseTop(T, gx, gy, ql);
        if (zlo >= top) return null;
        if (l >= lmax) return leaf(l, gx, gy, ta, tb, ax, top);
        if (!anySolid(T, l, gx, gy, zlo, Math.min(zhi, top - 1), st)) return null;
        if (ax >= 0 && sureSolid(T, l, gx, gy, Math.floor(z0 * ZU), st)) return sideHit(ta, ax, l);
      }
      // the children, in ray order
      const size = sizeL(V, l) / ZU;
      const cs = size / k;
      const x0 = gx * size;
      const y0 = gy * size;
      const te = ta + (tb - ta) * 1e-4;
      let ix = Math.min(k - 1, Math.max(0, Math.floor((ex + dx * te - x0) / cs)));
      let iy = Math.min(k - 1, Math.max(0, Math.floor((ey + dy * te - y0) / cs)));
      const stx = dx > 0 ? 1 : -1;
      const sty = dy > 0 ? 1 : -1;
      const tdx = dx !== 0 ? Math.abs(cs / dx) : 1e18;
      const tdy = dy !== 0 ? Math.abs(cs / dy) : 1e18;
      let tnx = dx !== 0 ? (x0 + (ix + (dx > 0 ? 1 : 0)) * cs - ex) / dx : 1e18;
      let tny = dy !== 0 ? (y0 + (iy + (dy > 0 ? 1 : 0)) * cs - ey) / dy : 1e18;
      let t = ta;
      let axis = ax;
      while (t < tb) {
        const tEnd = Math.min(tnx, tny, tb);
        if (tEnd > t) {
          const hit = visit(l + 1, gx * k + ix, gy * k + iy, t, tEnd, axis, lodFixed);
          if (hit) return hit;
        }
        if (tnx < tny) {
          t = tnx;
          tnx += tdx;
          ix += stx;
          axis = 0;
        } else {
          t = tny;
          tny += tdy;
          iy += sty;
          axis = 1;
        }
        if (ix < 0 || iy < 0 || ix >= k || iy >= k) break;
        if (st.nodes > NODE_CAP) return null;
      }
      return null;
    }
    /** the leaf's column in z, coarse-first: the first solid the ray meets in [ta, tb] */
    function leaf(l: number, gx: number, gy: number, ta: number, tb: number, ax: number, top: number): Hit | null {
      const zA = (ez + dz * ta) * ZU;
      const zB = (ez + dz * tb) * ZU;
      const tAt = (zu: number) => Math.min(tb, Math.max(ta, (zu / ZU - ez) / dz));
      const s0 = zA < top ? stateAt(T, l, gx, gy, Math.floor(zA)) : -1;
      st.slabs++;
      if (s0 === 0) return ax >= 0 ? sideHit(ta, ax, l) : null;
      if (dz <= 0) {
        let zq: number;
        if (s0 < 0) {
          if (zB >= top) return null;
          st.slabs++;
          const s1 = stateAt(T, l, gx, gy, top - 1);
          if (s1 === 0) return { kind: HIT_TOP, t: tAt(top), nx: 0, ny: 0, nz: 1, level: l };
          zq = fdivF(top - 1, sizeL(V, s1)) * sizeL(V, s1);
        } else zq = fdivF(Math.floor(zA), sizeL(V, s0)) * sizeL(V, s0);
        while (zq > zB) {
          st.slabs++;
          const s1 = stateAt(T, l, gx, gy, zq - 1);
          if (s1 === 0) return { kind: HIT_FLOOR, t: tAt(zq), nx: 0, ny: 0, nz: 1, level: l };
          const sm = sizeL(V, s1);
          zq = fdivF(zq - 1, sm) * sm;
        }
        return null;
      }
      if (s0 < 0) return null;
      let zq = (fdivF(Math.floor(zA), sizeL(V, s0)) + 1) * sizeL(V, s0);
      while (zq < zB) {
        if (zq >= top) return null;
        st.slabs++;
        const s1 = stateAt(T, l, gx, gy, zq);
        if (s1 === 0) return { kind: HIT_CEIL, t: tAt(zq), nx: 0, ny: 0, nz: -1, level: l };
        const sm = sizeL(V, s1);
        zq = (fdivF(zq, sm) + 1) * sm;
      }
      return null;
    }
  }

  const solid = (x: number, y: number, z: number) => {
    const N = f.nx * COARSE_M;
    const M = f.ny * COARSE_M;
    if (x < 0 || y < 0 || x >= N || y >= M) return false;
    const r = cellOf(R, Math.floor(x / COARSE_M), Math.floor(y / COARSE_M));
    if (r.kind !== KIND_SPLIT) return z < sheetM(r, Math.floor(x / COARSE_M), Math.floor(y / COARSE_M), x, y);
    return solidAtM(T, aoLevel, x, y, z);
  };

  const rgb = new Uint8Array(v.w * v.h * 3);
  const sun = norm3(-0.45, -0.75, 0.6);
  const doShadow = v.shadows ?? true;
  const doAo = v.ao ?? true;
  let nSum = 0;
  let nMax = 0;
  let sSum = 0;
  let sMax = 0;
  let shSum = 0;
  let shMax = 0;
  let shN = 0;
  let capped = 0;
  const levelHist: number[] = new Array(V.maxLevel + 1).fill(0);
  for (let py = 0; py < v.h; py++) {
    for (let px = 0; px < v.w; px++) {
      const sx = ((2 * (px + 0.5)) / v.w - 1) * tanH * (v.w / v.h);
      const sy = (1 - (2 * (py + 0.5)) / v.h) * tanH;
      let dx = fx + rx * sx + ux * sy;
      let dy = fy + ry * sx + uy * sy;
      let dz = fz + uz * sy;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const st: St = { nodes: 0, slabs: 0 };
      const hit = trace(ex, ey, ez, dx, dy, dz, -1, st);
      if (st.nodes >= NODE_CAP) capped++;
      nSum += st.nodes;
      nMax = Math.max(nMax, st.nodes);
      sSum += st.slabs;
      sMax = Math.max(sMax, st.slabs);
      let lit = 1;
      let ao = 1;
      if (hit) {
        if (hit.level >= 0) levelHist[hit.level]++;
        const hx = ex + dx * hit.t;
        const hy = ey + dy * hit.t;
        const hz = ez + dz * hit.t;
        const ndl = hit.nx * sun[0] + hit.ny * sun[1] + hit.nz * sun[2];
        if (doShadow && ndl > 0) {
          // the offset scales with the hit level's cell (fine cells are far smaller than v1's 2 cm)
          const e = hit.level >= 0 ? Math.min(0.02, (0.05 * sizeL(V, hit.level)) / ZU) : 0.02;
          const ss: St = { nodes: 0, slabs: 0 };
          const lod = hit.level >= 0 ? hit.level : levelAt(hit.t);
          const sh = trace(hx + hit.nx * e + sun[0] * e, hy + hit.ny * e + sun[1] * e, hz + hit.nz * e + sun[2] * e, sun[0], sun[1], sun[2], lod, ss);
          if (sh) lit = 0;
          shSum += ss.nodes;
          shMax = Math.max(shMax, ss.nodes);
          shN++;
        }
        if (doAo) ao = occlusion(solid, hit, hx, hy, hz) * hollow(solid, hit, hx, hy, hz);
      }
      if (dbg) dbg(px, py, hit, lit, st.nodes);
      const o = (py * v.w + px) * 3;
      const col = shade(hit, dz, sun, lit, ao);
      rgb[o] = col[0];
      rgb[o + 1] = col[1];
      rgb[o + 2] = col[2];
    }
    // the memo grows with the picture; drop it when large (it is a cache, not state)
    if (T.memo.size > 4_000_000) T.memo.clear();
  }
  const n = v.w * v.h;
  return {
    rgb,
    w: v.w,
    h: v.h,
    meanNodes: nSum / n,
    maxNodes: nMax,
    meanSlabs: sSum / n,
    maxSlabs: sMax,
    meanShadowNodes: shN ? shSum / shN : 0,
    maxShadowNodes: shMax,
    capped,
    levelHist,
  };
}

type Solid = (x: number, y: number, z: number) => boolean;
/** as cliffview.ts hollow(): points 1, 3, 8 m out with rock 1.5 or 5 m above them darken a face, floor or ceiling */
function hollow(solid: Solid, hit: Hit, x: number, y: number, z: number): number {
  if (hit.kind !== HIT_SIDE && hit.kind !== HIT_FLOOR && hit.kind !== HIT_CEIL) return 1;
  const dirs = hit.kind === HIT_SIDE ? [[hit.nx, hit.ny]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let n = 0;
  for (const [ux, uy] of dirs)
    for (const d of [1, 3, 8]) {
      const qx = x + ux * (d + 0.1);
      const qy = y + uy * (d + 0.1);
      if (solid(qx, qy, z + 1.5) || solid(qx, qy, z + 5)) n += 1 / dirs.length;
    }
  return 1 - 0.2 * n;
}
/** as cliffview.ts occlusion(): 4 solid tests 0.75 m around the hit */
function occlusion(solid: Solid, hit: Hit, x: number, y: number, z: number): number {
  const d = 0.75;
  let n = 0;
  if (hit.kind === HIT_SIDE) {
    const tx = -hit.ny;
    const ty = hit.nx;
    const fx = x + hit.nx * 0.5;
    const fy = y + hit.ny * 0.5;
    if (solid(fx + tx * d, fy + ty * d, z)) n++;
    if (solid(fx - tx * d, fy - ty * d, z)) n++;
    if (solid(fx, fy, z + d)) n++;
    if (solid(fx, fy, z - d)) n++;
  } else if (hit.kind === HIT_CEIL) {
    return 0.6;
  } else {
    const zz = z + 0.3;
    if (solid(x + d, y, zz)) n++;
    if (solid(x - d, y, zz)) n++;
    if (solid(x, y + d, zz)) n++;
    if (solid(x, y - d, zz)) n++;
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
/** as cliffview.ts shade() */
function shade(hit: Hit | null, dz: number, sun: [number, number, number], lit: number, ao: number): [number, number, number] {
  if (!hit) {
    const s = Math.max(0, Math.min(1, 0.5 + dz));
    return toByte([0.62 + 0.2 * s, 0.72 + 0.15 * s, 0.85 + 0.1 * s]);
  }
  const ndl = Math.max(0, hit.nx * sun[0] + hit.ny * sun[1] + hit.nz * sun[2]) * lit;
  const hemi = 0.5 + 0.5 * hit.nz;
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
