// ---- play/camera/sight.ts ---------------------------------------------------------------------------------------
// (round 121, herolab) What hides a point from the eye, and whether the view's cut opens it — the camera modes' one
// probe and the metrics' one judge. It mirrors the renderer (render.wgsl): the orthographic eye at (azimuth,
// elevation); `cutAway` (the slice over its height, within its radius on screen; a kept-seen point's hole: in front
// of the point by over a cell and a half, over its base, within ~0.85 of its radius on screen) — so what the probe
// calls open is what the draw leaves out. api/cutaway.ts's Sight marches the same ray over Terrain; this one takes the
// narrow SightWorld so it runs in Node. Pure.

import type { CamCut, CamView, Prop, SightWorld, V3 } from '../../api/contracts/camera';

/** toward the eye (unit) */
export function eyeDir(azimuth: number, elevation: number): V3 {
  const c = Math.cos(elevation);
  return [Math.cos(azimuth) * c, Math.sin(azimuth) * c, Math.sin(elevation)];
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** the distance of q from c across the eye's line (on the screen, world units) */
export function acrossEye(q: V3, c: V3, e: V3): number {
  const v0 = q[0] - c[0];
  const v1 = q[1] - c[1];
  const v2 = q[2] - c[2];
  const a = v0 * e[0] + v1 * e[1] + v2 * e[2];
  return Math.hypot(v0 - a * e[0], v1 - a * e[1], v2 - a * e[2]);
}

/** render.wgsl sliceReach: how far into the slice's cut q is, 0..1 (hard: 0 or 1; thinned by the dither over `fade` cells and `fadeR` of the radius) */
export function sliceReach(s: NonNullable<CamCut['slice']>, q: V3, e: V3, w?: SightWorld): number {
  // (the bowl: h0 at the hero, rising bowl·d² away from it)
  const dg = Math.hypot(q[0] - s.at[0], q[1] - s.at[1]);
  const z0 = s.z + (s.bowl ?? 0) * dg * dg;
  const fz = s.fade ?? 0;
  // (the fade under the cut's height: whole over it, thinning out over `fade` cells under it)
  let k = fz > 0 ? sstep(z0 - fz, z0, q[2]) : q[2] > z0 ? 1 : 0;
  if (k <= 0) return 0;
  const c: V3 = [s.at[0], s.at[1], s.z];
  if (s.radius > 0) {
    const d = acrossEye(q, c, e);
    const fr = s.fadeR ?? 0;
    k *= fr > 0 ? 1 - sstep(s.radius * (1 - fr), s.radius, d) : d < s.radius ? 1 : 0;
    if (k <= 0) return 0;
  }
  if (s.nearOnly) {
    const along = (q[0] - c[0]) * e[0] + (q[1] - c[1]) * e[1] + (q[2] - c[2]) * e[2];
    k *= sstep(0, 1.5, along);
    if (k <= 0) return 0;
  }
  if (s.occluders) {
    if (!w) throw new Error('sliceReach: the occluders-only cut needs the world (its land behind the point)');
    if (!occludes(w, q, e)) return 0;
  }
  return k;
}

/** the steps along the eye's line render.wgsl `occludes` looks behind a point at (cells) */
export const OCCLUDE_T = [1.5, 3, 5, 8, 12, 17, 24, 32, 44, 60];

/**
 * render.wgsl occludes: walked on from p away from the eye, the line is out in the open air (0.75 over the land)
 * somewhere behind it — p hides what's there. A slope gentler than the eye's line never does.
 */
export function occludes(w: SightWorld, p: V3, e: V3): boolean {
  for (const t of OCCLUDE_T) {
    const x = p[0] - e[0] * t;
    const y = p[1] - e[1] * t;
    if (p[2] - e[2] * t > w.top(x, y) + 0.75) return true;
  }
  return false;
}

/** render.wgsl seeReach for one point: 0..1 */
export function seeReach(q: V3, s: V3, r: number, e: V3): number {
  const v0 = q[0] - s[0];
  const v1 = q[1] - s[1];
  const v2 = q[2] - s[2];
  const along = v0 * e[0] + v1 * e[1] + v2 * e[2];
  const perp = Math.hypot(v0 - along * e[0], v1 - along * e[1], v2 - along * e[2]);
  return (1 - sstep(r * 0.7, r, perp)) * sstep(1, 2, along) * sstep(0, 0.8, q[2] - s[2]);
}

/** Is the solid at q left out of the draw by the cut (render.wgsl cutAway; a hole counts from half its reach)? */
export function cutOpens(cut: CamCut | null, q: V3, e: V3, w?: SightWorld): boolean {
  if (!cut) return false;
  const s = cut.slice;
  if (s && sliceReach(s, q, e, w) >= 0.5) return true;
  for (const p of cut.see) if (seeReach(q, p.at, p.r, e) > 0.5) return true;
  return false;
}

export interface Hidden {
  /** how high over the point's base the highest thing that hides it rises (cells) */
  height: number;
  /** cells along the eye's line to the first thing that hides it */
  near: number;
}

/**
 * What hides p from the eye e (unit, toward the eye), or null if nothing does: the columns' solid and the props along
 * the ray from p, what the cut opens left out. Steps of `step` along the ray, out to `reach` or over the world's
 * ceiling.
 */
export function hiddenBy(w: SightWorld, p: V3, e: V3, cut: CamCut | null = null, reach = 80, step = 0.5): Hidden | null {
  let best: Hidden | null = null;
  // (the props near the ray, looked up once: the ray's horizontal run is at most reach·cos(el))
  const run = reach * Math.hypot(e[0], e[1]);
  let props: readonly Prop[] = w.props ? w.props(p[0] + (e[0] * reach) / 2, p[1] + (e[1] * reach) / 2, run / 2 + 4) : [];
  // (only those the ray passes over: within their radius of its line on the ground, on its side of p)
  if (props.length) {
    const hl = Math.hypot(e[0], e[1]);
    if (hl > 1e-6) {
      const ux = e[0] / hl;
      const uy = e[1] / hl;
      props = props.filter((pr) => {
        const dx = pr.x - p[0];
        const dy = pr.y - p[1];
        const a = dx * ux + dy * uy;
        return a > -pr.r && a < run + pr.r && Math.abs(dx * uy - dy * ux) <= pr.r;
      });
    }
  }
  for (let t = 1; t <= reach; t += step) {
    const q: V3 = [p[0] + e[0] * t, p[1] + e[1] * t, p[2] + e[2] * t];
    if (q[2] > w.ceiling) break;
    let hit = false;
    let top = 0;
    const col = w.solid(q[0], q[1]);
    if (col)
      for (const iv of col)
        if (q[2] >= iv.z0 && q[2] < iv.z1) {
          hit = true;
          top = col[col.length - 1].z1;
          break;
        }
    if (!hit)
      for (const pr of props)
        if (q[2] >= pr.z0 && q[2] < pr.z1 && Math.hypot(q[0] - pr.x, q[1] - pr.y) <= pr.r) {
          hit = true;
          top = pr.z1;
          break;
        }
    if (!hit || cutOpens(cut, q, e, w)) continue;
    const h = top - p[2];
    if (!best) best = { height: h, near: t };
    else best.height = Math.max(best.height, h);
  }
  return best;
}

/** p's place on the screen (CSS px, y down) for this view — the orthographic Camera's projection (render/camera.ts) */
export function screenOf(v: CamView, p: V3): [number, number] {
  const az = v.azimuth;
  const el = v.elevation;
  // (the camera's basis: right = (-sin az, cos az, 0); up' = right × forward)
  const rx = -Math.sin(az);
  const ry = Math.cos(az);
  const e = eyeDir(az, el);
  const fx = -e[0];
  const fy = -e[1];
  const fz = -e[2];
  const ux = ry * fz;
  const uy = -rx * fz;
  const uz = rx * fy - ry * fx;
  const dx = p[0] - v.target[0];
  const dy = p[1] - v.target[1];
  const dz = p[2] - v.target[2];
  return [v.w / 2 + (dx * rx + dy * ry) * v.zoom, v.h / 2 - (dx * ux + dy * uy + dz * uz) * v.zoom];
}

/** on the screen, inside the margin */
export function onScreen(v: CamView, p: V3, margin = v.margin): boolean {
  const [x, y] = screenOf(v, p);
  return x >= margin && x <= v.w - margin && y >= margin && y <= v.h - margin;
}

/** half the screen's shorter side, in world units on screen (what a share of the screen is, as a hole's radius) */
export function halfScreen(v: CamView): number {
  return Math.min(v.w, v.h) / 2 / Math.max(v.zoom, 1e-3);
}

/** a ground step (dx, dy) as it moves on the screen at zoom 1 (px): the chase framing's screenOf */
export function groundOnScreen(az: number, el: number, dx: number, dy: number): [number, number] {
  const rx = -Math.sin(az);
  const ry = Math.cos(az);
  const hx = -Math.cos(az);
  const hy = -Math.sin(az);
  return [dx * rx + dy * ry, -(dx * hx + dy * hy) * Math.sin(el)];
}

export const wrap = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
