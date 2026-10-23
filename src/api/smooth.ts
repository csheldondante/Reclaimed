// Sampling the ground the way the field mesh draws it (fieldmesh.wgsl
// terrainField, meshregion.wgsl terrainWarp): each column's top, blended
// over the three nearest cell centres (the triangle lattice of centres,
// barycentric weights) at a point warped a little sideways by smooth noise.
// A CPU port of common.wgsl triAt and meshregion.wgsl's warp, hash for hash,
// so a rider on the CPU stands on the surface the player sees.

import { ROW_H } from '../world/lattice';

export interface Tri {
  /** the three cells (x, y) and their weights */
  cx: [number, number, number];
  cy: [number, number, number];
  w: [number, number, number];
}

/** common.wgsl pcg (u32 arithmetic) */
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** common.wgsl randv: 0..1 from an integer lattice point */
function randv(x: number, y: number, z: number): number {
  const h = pcg((x >>> 0) ^ pcg((y >>> 0) ^ pcg(z >>> 0)));
  return (h >>> 8) / 16777216;
}

const sstep = (f: number) => f * f * (3 - 2 * f);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** meshregion.wgsl warpNoise */
function warpNoise(px: number, py: number, pz: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = sstep(px - ix);
  const fy = sstep(py - iy);
  const fz = sstep(pz - iz);
  const a = mix(randv(ix, iy, iz), randv(ix + 1, iy, iz), fx);
  const b = mix(randv(ix, iy + 1, iz), randv(ix + 1, iy + 1, iz), fx);
  const c = mix(randv(ix, iy, iz + 1), randv(ix + 1, iy, iz + 1), fx);
  const d = mix(randv(ix, iy + 1, iz + 1), randv(ix + 1, iy + 1, iz + 1), fx);
  return mix(mix(a, b, fy), mix(c, d, fy), fz);
}

/** meshregion.wgsl terrainWarp: where the terrain field is looked up for world point (x, y, z) */
export function terrainWarp(x: number, y: number, z: number): [number, number] {
  const qx = x * 0.45;
  const qy = y * 0.45;
  const qz = z * 0.6;
  return [x + (warpNoise(qx, qy, qz) - 0.5) * 0.9, y + (warpNoise(qx + 17.3, qy + 5.1, qz + 9.7) - 0.5) * 0.9];
}

/** integer axial (q, r) → storage cell (common.wgsl axialCell) */
function axialCell(q: number, r: number): [number, number] {
  return [q + (r - (r & 1)) / 2, r];
}

/** common.wgsl triAt: the three cell centres round world point (x, y) and their weights */
export function triAt(x: number, y: number): Tri {
  const r = (y - 0.5 * ROW_H) / ROW_H;
  const q = x - 0.5 - 0.5 * r;
  const bq = Math.floor(q);
  const br = Math.floor(r);
  const fq = q - bq;
  const fr = r - br;
  let c: [number, number][];
  let w: [number, number, number];
  if (fq + fr < 1) {
    c = [axialCell(bq, br), axialCell(bq + 1, br), axialCell(bq, br + 1)];
    w = [1 - fq - fr, fq, fr];
  } else {
    c = [axialCell(bq + 1, br + 1), axialCell(bq, br + 1), axialCell(bq + 1, br)];
    w = [fq + fr - 1, 1 - fq, 1 - fr];
  }
  return { cx: [c[0][0], c[1][0], c[2][0]], cy: [c[0][1], c[1][1], c[2][1]], w };
}

/**
 * The blended surface at (x, y): `top(cx, cy)` each column's top (null off
 * the map: it drops out, the rest renormalised), looked up at the point the
 * field mesh warps (x, y) to — the warp depends on height, so it's found in
 * two steps from the unwarped blend.
 */
export function blendedTop(x: number, y: number, top: (cx: number, cy: number) => number | null, warp = true): number | null {
  const at = (px: number, py: number): number | null => {
    const t = triAt(px, py);
    let s = 0;
    let ws = 0;
    for (let k = 0; k < 3; k++) {
      const v = top(t.cx[k], t.cy[k]);
      if (v === null) continue;
      s += t.w[k] * v;
      ws += t.w[k];
    }
    return ws > 1e-6 ? s / ws : null;
  };
  let z = at(x, y);
  if (!warp || z === null) return z;
  for (let i = 0; i < 2; i++) {
    const [wx, wy] = terrainWarp(x, y, z!);
    z = at(wx, wy) ?? z;
  }
  return z;
}
