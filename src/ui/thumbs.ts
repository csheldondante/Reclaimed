// Model thumbnails (round 13, F5): each model of the atlas drawn as a little
// isometric picture on a 2D canvas — exposed faces only, painter's order,
// top/side shading from the material colours. Cached as data URLs.

import { MATERIALS } from '../world/materials';
import type { VoxelModel } from '../world/models';

const cache = new Map<string, string>();

export function thumbnail(m: VoxelModel, px = 72): string {
  const hit = cache.get(m.id);
  if (hit) return hit;
  const [w, d, h] = m.size;
  const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= w || y >= d || z >= h ? 0 : m.vox[x + w * (y + d * z)]);
  // iso projection, viewer toward +x +y +z: sees top, +x and +y faces
  const P = (x: number, y: number, z: number): [number, number] => [x - y, (x + y) * 0.5 - z];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y, z] of [[0, 0, 0], [w, 0, 0], [0, d, 0], [w, d, 0], [0, 0, h], [w, 0, h], [0, d, h], [w, d, h]]) {
    const [sx, sy] = P(x, y, z);
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  const pad = 4;
  const s = Math.min((px - pad * 2) / (x1 - x0), (px - pad * 2) / (y1 - y0));
  const ox = pad + ((px - pad * 2) - (x1 - x0) * s) / 2 - x0 * s;
  const oy = pad + ((px - pad * 2) - (y1 - y0) * s) / 2 - y0 * s;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d')!;
  const face = (pts: [number, number, number][], rgb: number[], k: number) => {
    g.beginPath();
    pts.forEach(([x, y, z], i) => {
      const [sx, sy] = P(x, y, z);
      if (i === 0) g.moveTo(ox + sx * s, oy + sy * s);
      else g.lineTo(ox + sx * s, oy + sy * s);
    });
    g.closePath();
    g.fillStyle = `rgb(${rgb.map((c) => Math.round(Math.min(1, c * k) * 255)).join(',')})`;
    g.fill();
  };
  // back to front: increasing x + y, then bottom to top
  for (let sum = 0; sum <= w + d - 2; sum++)
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++) {
        const y = sum - x;
        if (y < 0 || y >= d) continue;
        const v = at(x, y, z);
        if (!v) continue;
        const c = MATERIALS[v].albedo;
        if (!at(x + 1, y, z)) face([[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], c, 0.78);
        if (!at(x, y + 1, z)) face([[x, y + 1, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], c, 0.6);
        if (!at(x, y, z + 1)) face([[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]], c, 1.05);
      }
  const url = cv.toDataURL();
  cache.set(m.id, url);
  return url;
}
