// A tile's unit frame (contracts/interiors.ts): (u, v) in [0, 1]², u along side 0 (corner 0 → 1), v toward side 2;
// a point in it is the corners' bilinear mix — as the structures' modules are warped (structmesh.wgsl spVertex).
import type { V2 } from '../api/contracts/interiors';

export type Quad = [V2, V2, V2, V2];

export function bilinear(c: Quad, u: number, v: number): V2 {
  const a = (1 - u) * (1 - v), b = u * (1 - v), d = u * v, e = (1 - u) * v;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

/** (u, v) of the point `t` along side s (its own direction) and `d` across the tile from it (0 on the side, 1 opposite) */
export function sideUV(s: number, t: number, d: number): V2 {
  switch (s & 3) {
    case 0: return [t, d];
    case 1: return [1 - d, t];
    case 2: return [1 - t, 1 - d];
    default: return [d, 1 - t];
  }
}

export function sidePoint(c: Quad, s: number, t: number, d: number): V2 {
  const [u, v] = sideUV(s, t, d);
  return bilinear(c, u, v);
}

export function sideLength(c: Quad, s: number): number {
  const a = c[s & 3], b = c[(s + 1) & 3];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** how far across the tile from side s to the opposite side (between their middles, m) */
export function across(c: Quad, s: number): number {
  const m0 = sidePoint(c, s, 0.5, 0), m1 = sidePoint(c, s, 0.5, 1);
  return Math.hypot(m1[0] - m0[0], m1[1] - m0[1]);
}

/** the side's direction (unit) and its inward normal (the tile's inside: left of the side, corners counter-clockwise) */
export function sideAxes(c: Quad, s: number): { dir: V2; inward: V2 } {
  const a = c[s & 3], b = c[(s + 1) & 3];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const dir: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  // (toward the tile's middle: counter-clockwise tiles have it on the left; a clockwise one — a mirrored lattice — the right)
  const m = centre(c);
  const left: V2 = [-dir[1], dir[0]];
  const inward: V2 = (m[0] - a[0]) * left[0] + (m[1] - a[1]) * left[1] >= 0 ? left : [dir[1], -dir[0]];
  return { dir, inward };
}

export function centre(c: Quad): V2 {
  return [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
}

/** Is p inside the (convex-ish) quad, by `margin` from its sides? */
export function inQuad(c: Quad, p: V2, margin = 0): boolean {
  for (let s = 0; s < 4; s++) {
    const { inward } = sideAxes(c, s);
    const a = c[s];
    if (inward[0] * (p[0] - a[0]) + inward[1] * (p[1] - a[1]) < margin) return false;
  }
  return true;
}
