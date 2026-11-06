// The road generator's map preview (round 128p, DA-A13 step 0: the human pass — the user judges the layout from it):
// a top view of a run on its site as RGBA pixels, `scale` pixels a metre. The ground shaded by its slope and height,
// the water, the base lattice's cells (a block's open cells in its pastel, a road's grey) with their edges as they bent,
// the houses, the roads (main black, major red, minor orange, steep stretches purple). Pure.
import type { RoadGenInput, V2 } from './roadgen';
import { groundAt, wetAt } from './roadgen';
import type { RoadGenResult } from './gpu';
import { blocksOf, hash3, isRoad, LATTICE_CELL, latticeCellAt } from './lattice';
import { steepOf } from './site';

export function previewRgba(inp: RoadGenInput, res: RoadGenResult, houses: Set<number>, scale = 3): { w: number; h: number; data: Uint8Array } {
  const p = inp.params;
  const w = Math.ceil(p.W * scale);
  const h = Math.ceil(p.H * scale);
  const data = new Uint8Array(w * h * 4);
  const n = res.latN;
  const N1 = n + 1;
  const { block } = blocksOf(res.claims, n);
  const vert = (i: number, j: number): V2 => {
    const half = n / 2;
    const a = (i - half) * LATTICE_CELL;
    const b = (j - half) * LATTICE_CELL;
    const c = Math.cos(p.theta);
    const s = Math.sin(p.theta);
    const o = (j * N1 + i) * 2;
    return [p.centre[0] + c * a - s * b + res.offsets[o], p.centre[1] + s * a + c * b + res.offsets[o + 1]];
  };
  const inQuad = (i: number, j: number, x: number, y: number): number => {
    // >= 0 inside: the least edge distance (signed)
    const q = [vert(i, j), vert(i + 1, j), vert(i + 1, j + 1), vert(i, j + 1)];
    let m = Infinity;
    for (let e = 0; e < 4; e++) {
      const a = q[e];
      const b = q[(e + 1) & 3];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      m = Math.min(m, ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / L);
    }
    return m;
  };
  const put = (px: number, py: number, r: number, g: number, b: number) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    // (y up in the town's frame: the image's rows top down)
    const o = ((h - 1 - py) * w + px) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  };
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      const x = (px + 0.5) / scale;
      const y = (py + 0.5) / scale;
      const z = groundAt(p, inp.ground, x, y);
      const zx = groundAt(p, inp.ground, x + 1, y) - z;
      const zy = groundAt(p, inp.ground, x, y + 1) - z;
      const shade = Math.max(0.35, Math.min(1.15, 0.85 + (-zx + zy) * 0.35));
      let col: [number, number, number] = [150 + ((z * 3) % 40), 160, 120].map((v) => v * shade) as [number, number, number];
      if (wetAt(p, inp.wet, x, y)) col = [70, 110, 170];
      const [ci, cj] = latticeCellAt(p, n, x, y);
      let cell = -1;
      let edge = Infinity;
      for (let dj = -1; dj <= 1 && cell < 0; dj++)
        for (let di = -1; di <= 1; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const m = inQuad(i, j, x, y);
          if (m >= 0) {
            cell = j * n + i;
            edge = m;
            break;
          }
        }
      if (cell >= 0 && res.claims[cell] < 3 && !wetAt(p, inp.wet, x, y)) {
        const k = res.claims[cell];
        if (isRoad(k)) col = col.map((v) => v * 0.55 + 70) as [number, number, number];
        else {
          const hb = hash3(block[cell], 3, 9);
          const tint: [number, number, number] = [180 + (hb & 63), 170 + ((hb >> 6) & 63), 150 + ((hb >> 12) & 63)];
          col = col.map((v, q) => v * 0.6 + tint[q] * 0.4) as [number, number, number];
          if (houses.has(cell)) col = [120, 80, 60];
        }
        if (edge < 0.18) col = col.map((v) => v * 0.7) as [number, number, number];
      }
      put(px, py, ...col);
    }
  const line = (a: V2, b: V2, rgb: [number, number, number], thick: number) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(L * scale * 2));
    for (let s = 0; s <= steps; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / steps;
      const y = a[1] + ((b[1] - a[1]) * s) / steps;
      for (let dy = -thick; dy <= thick; dy++) for (let dx = -thick; dx <= thick; dx++) put(Math.floor(x * scale) + dx, Math.floor(y * scale) + dy, ...rgb);
    }
  };
  for (const r of res.roads) {
    const st = steepOf(p, (x, y) => groundAt(p, inp.ground, x, y), r.pts);
    const rgb: [number, number, number] = r.fixed ? [20, 20, 20] : r.family === 0 ? [200, 40, 30] : [235, 140, 30];
    for (let k = 1; k < r.pts.length; k++) line(r.pts[k - 1], r.pts[k], st[k] ? [140, 40, 170] : rgb, r.family === 0 ? 1 : 0);
  }
  return { w, h, data };
}
