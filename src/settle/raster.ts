// A settlement's plan as the land past the window draws it (round 94; atlas/bake.ts SurfaceStamp): its columns'
// tops seen from above, a texel a world unit — the roofs in the civ's colours, the walls, the plaza, the fields, the
// quarry's pit — with the shading that makes it read from far away (a building's edge darker: its walls and eaves; the
// ground round it a little shaded), and their 4-unit average. Pure: the worker (plan-worker.ts) and the main thread
// (the exact plan, when its land has come in) make the same thing.
import { MATERIALS } from '../world/materials';
import { cellAt, cellPos } from '../world/lattice';
import type { ColumnPlan } from './plan';
import type { SurfaceStamp } from '../atlas/bake';

/** a column's top over the ground this much (world units) or more: a building's */
const TALL = 1.2;

export function rasterPlan(
  id: string,
  columns: Map<number, ColumnPlan>,
  box: { x0: number; y0: number; w: number; h: number },
  /** per box column: the ground's top (world z), its material */
  ground: Float32Array,
  top: Uint8Array,
): SurfaceStamp {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const k of columns.keys()) {
    const [x, y] = cellPos(box.x0 + (k % box.w), box.y0 + Math.floor(k / box.w));
    minx = Math.min(minx, x);
    miny = Math.min(miny, y);
    maxx = Math.max(maxx, x);
    maxy = Math.max(maxy, y);
  }
  if (!columns.size) return { id, x0: 0, y0: 0, w: 0, h: 0, px: new Uint32Array(0), w4: 0, h4: 0, px4: new Uint32Array(0) };
  const X0 = Math.floor(minx) - 3;
  const Y0 = Math.floor(miny) - 3;
  const W = Math.ceil((Math.ceil(maxx) + 3 - X0) / 4) * 4;
  const H = Math.ceil((Math.ceil(maxy) + 3 - Y0) / 4) * 4;
  const above = new Float32Array(W * H).fill(NaN);
  const rgb = new Float32Array(W * H * 3);
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const [cx, cy] = cellAt(X0 + u + 0.5, Y0 + v + 0.5);
      const lx = cx - box.x0;
      const ly = cy - box.y0;
      if (lx < 0 || ly < 0 || lx >= box.w || ly >= box.h) continue;
      const key = ly * box.w + lx;
      const cp = columns.get(key);
      if (!cp) continue;
      let mat = top[key];
      let up = -(cp.cut ?? 0);
      if (cp.ivs.length) {
        let t = cp.ivs[0];
        for (const iv of cp.ivs) if (iv.z1 > t.z1) t = iv;
        mat = t.mat;
        up = t.z1 - ground[key];
      }
      const i = v * W + u;
      above[i] = up;
      const a = MATERIALS[mat]?.albedo ?? [0.5, 0.5, 0.5];
      rgb.set(a, i * 3);
    }
  // the shading: a building's edge (where its neighbour is lower by a storey's part) darker; the ground by a building
  // shaded a little; a pit darker by its depth
  const px = new Uint32Array(W * H);
  const at = (u: number, v: number) => (u < 0 || v < 0 || u >= W || v >= H ? NaN : above[v * W + u]);
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const h = above[i];
      if (Number.isNaN(h)) continue;
      let k = 1;
      if (h >= TALL) {
        let edge = false;
        for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = at(u + du, v + dv);
          if (Number.isNaN(n) ? h > 1 : n < h - 1) edge = true;
        }
        k = edge ? 0.68 : 1.06;
      } else {
        let near = 0;
        for (let dv = -2; dv <= 2; dv++) for (let du = -2; du <= 2; du++) if (at(u + du, v + dv) >= TALL + 1) near++;
        k = 1 - Math.min(0.22, near * 0.025);
        if (h < 0) k *= 1 - Math.min(6, -h) * 0.06;
      }
      const c = (j: number) => Math.max(0, Math.min(255, Math.round(rgb[i * 3 + j] * k * 255)));
      px[i] = (c(0) | (c(1) << 8) | (c(2) << 16) | (255 << 24)) >>> 0;
    }
  // the 4-unit average (its colour where covered, its cover)
  const w4 = W / 4;
  const h4 = H / 4;
  const px4 = new Uint32Array(w4 * h4);
  for (let v = 0; v < h4; v++)
    for (let u = 0; u < w4; u++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const p = px[(v * 4 + j) * W + u * 4 + i];
          if (!p) continue;
          r += p & 255;
          g += (p >> 8) & 255;
          b += (p >> 16) & 255;
          n++;
        }
      if (n) px4[v * w4 + u] = (Math.round(r / n) | (Math.round(g / n) << 8) | (Math.round(b / n) << 16) | (Math.round((n / 16) * 255) << 24)) >>> 0;
    }
  return { id, x0: X0, y0: Y0, w: W, h: H, px, w4, h4, px4 };
}

/** How alike two stamps of a place are: the share of the texels either covers that both cover (IoU, 1-unit texels) */
export function stampMatch(a: SurfaceStamp, b: SurfaceStamp): number {
  const x0 = Math.min(a.x0, b.x0);
  const y0 = Math.min(a.y0, b.y0);
  const x1 = Math.max(a.x0 + a.w, b.x0 + b.w);
  const y1 = Math.max(a.y0 + a.h, b.y0 + b.h);
  const get = (s: SurfaceStamp, x: number, y: number) => {
    const u = x - s.x0;
    const v = y - s.y0;
    return u < 0 || v < 0 || u >= s.w || v >= s.h ? 0 : s.px[v * s.w + u];
  };
  let both = 0;
  let either = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = get(a, x, y) !== 0;
      const q = get(b, x, y) !== 0;
      if (p || q) either++;
      if (p && q) both++;
    }
  return either ? both / either : 1;
}
