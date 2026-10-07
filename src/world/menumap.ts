// The main-menu diorama (design doc §4): a skull and bones in barren soil.
// Its state is a pure function of persistent progress p (0..1):
//   0     trash, dust, dirty air, wind
//   ~0.3  less garbage, exposed soil
//   ~0.5  moss and lichen on the bones
//   ~0.7  grass and flowers through the debris
//   1     a tree grows through the skull and dominates the scene

import { ColumnGrid } from './layout';
import { MAT } from './materials';
import type { MapData } from './mapgen';
import { fbm, hash2, smoothstep } from './noise';

const W = 48;
const H = 48;
const ZMAX = 40;

export function generateMenuMap(p: number): MapData {
  const dims = { w: W, h: H, zMax: ZMAX };
  const N = W * H;
  const grid = new ColumnGrid(dims);
  const ground = new Float32Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) ground[y * W + x] = Math.round(6 + fbm(x / 9, y / 9, 3, 5) * 1.6);

  // Skull frame: u = the way the face points (+x: its face shows on the
  // camera-facing +x side, its length runs across the screen), v sideways, z up.
  const cx = 23;
  const cy = 22;
  const g0 = ground[cy * W + cx] - 2; // half buried
  const skull = (x: number, y: number, z: number): boolean => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const u = dx;
    const v = dy;
    const zz = z + 0.5 - g0;
    // lying low: wider than tall
    const cran = (u + 1.5) ** 2 / 40 + v ** 2 / 26 + (zz - 4.6) ** 2 / 17;
    const inner = (u + 1.5) ** 2 / 26 + v ** 2 / 15 + (zz - 5) ** 2 / 9;
    const face = u > 1 && u < 5.8 && Math.abs(v) < 3.7 - Math.max(0, 2.5 - zz) * 0.6 && zz > 1.6 && zz < 6.2;
    let inside = (cran < 1 && inner > 1) || face;
    // eye sockets, nose, teeth gaps
    for (const sv of [-1.9, 1.9]) if ((u - 4.6) ** 2 + (v - sv) ** 2 + (zz - 4.6) ** 2 < 2.4) inside = false;
    if (u > 4.6 && Math.abs(v) < 0.75 && zz > 2.6 && zz < 3.7) inside = false;
    if (u > 5.1 && zz < 2.5 && Math.abs(Math.round(v) % 2) === 1) inside = false;
    return inside;
  };
  // jaw lying in front, a femur, and a few ribs
  const bones = (x: number, y: number, z: number): boolean => {
    const zz = z + 0.5;
    const px = x + 0.5;
    const py = y + 0.5;
    const seg = (ax: number, ay: number, bx: number, by: number, r: number, z0: number) => {
      const vx = bx - ax;
      const vy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
      const d = Math.hypot(px - ax - vx * t, py - ay - vy * t, zz - z0);
      const knob = (t < 0.08 || t > 0.92) ? 0.5 : 0;
      return d < r + knob;
    };
    const g = (gx: number, gy: number) => ground[Math.min(H - 1, gy | 0) * W + Math.min(W - 1, gx | 0)];
    if (seg(9, 33, 19, 40, 0.75, g(14, 36) + 0.4)) return true; // femur
    if (seg(31, 12, 36, 20, 0.6, g(33, 16) + 0.3)) return true; // arm bone
    for (let k = 0; k < 4; k++) {
      // ribs: shallow arcs
      const ox = 31 + k * 2.2;
      const oy = 30 + k * 1.2;
      const a = Math.atan2(py - oy, px - ox);
      const r = Math.hypot(px - ox, py - oy);
      if (Math.abs(r - 3.5) < 0.6 && a > 0.2 && a < 2.4 && Math.abs(zz - g(ox, oy) - 0.4) < 0.7) return true;
    }
    // jaw: a U lying in front of the skull
    const jx = x + 0.5 - 30;
    const jy = y + 0.5 - 29;
    const jr = Math.hypot(jx, jy);
    if (Math.abs(jr - 2.6) < 0.55 && jx + jy > -0.5 && Math.abs(zz - g(30, 29) - 0.3) < 0.6) return true;
    return false;
  };
  // the tree of the final stage grows up through the left eye socket
  const treeOn = p >= 0.95;
  const tu = 4.6;
  const tv = -1.9;
  const tx = cx + tu;
  const ty = cy + tv;
  const trunkTop = g0 + 15;
  const tree = (x: number, y: number, z: number): number => {
    if (!treeOn) return 0;
    const zz = z + 0.5;
    const d = Math.hypot(x + 0.5 - tx, y + 0.5 - ty);
    if (d < 1.5 && zz > g0 + 2 && zz < trunkTop) return MAT.Wood;
    // branches
    if (zz > trunkTop - 6 && zz < trunkTop && d < 1.2 + (zz - (trunkTop - 6)) * 0.5 && hash2(x, y, z) < 0.35) return MAT.Wood;
    const cr = Math.hypot(x + 0.5 - tx + 1.5, y + 0.5 - ty - 1.5, (zz - (trunkTop + 3)) * 1.35);
    if (cr < 7.5 && hash2(x * 7 + z, y * 3 + z * 5, 11) < 0.78 - cr * 0.04) return MAT.Leaves;
    return 0;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const g = ground[i];
      grid.push(x, y, 0, g - 2, MAT.Stone);
      grid.push(x, y, g - 2, g, MAT.Soil);
      // scan the column for skull, bones, tree
      let run = 0;
      let runStart = 0;
      for (let z = g; z <= ZMAX; z++) {
        let m = 0;
        if (z < ZMAX) {
          m = tree(x, y, z) || (skull(x, y, z) || bones(x, y, z) ? MAT.Bone : 0);
        }
        if (m !== run) {
          if (run) grid.push(x, y, runStart, z, run);
          run = m;
          runStart = z;
        }
      }
      // debris and garbage, fading with progress
      if (grid.top(x, y) === g) {
        const h = hash2(x, y, 31);
        if (h < 0.12 * (1 - p) ** 1.5) grid.push(x, y, g, g + 1, MAT.Trash);
        else if (h > 0.985) grid.push(x, y, g, g + 1, h > 0.993 ? MAT.Concrete : MAT.Rust);
      }
    }
  }

  const water = new Float32Array(N);
  const contam = new Float32Array(N * 2);
  const moisture = new Float32Array(N);
  const vegetation = new Float32Array(N);
  const surface = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = grid.cols[i];
      surface[i] = c[c.length - 1].z1;
      const top = c[c.length - 1].mat;
      const n = fbm(x / 7, y / 7, 2, 77) * 0.5 + 0.5;
      contam[i * 2] = Math.max(0, (1 - p) * (0.45 + n * 0.3));
      moisture[i] = 0.08 + p * 0.55;
      // succession on the diorama as progress grows
      let v = 0;
      if (top === MAT.Bone) v = smoothstep(0.35, 0.6, p) * (0.6 + 0.6 * hash2(x, y, 4)); // moss/lichen on bone
      else if (top === MAT.Soil || top === MAT.Trash) {
        const grassy = smoothstep(0.45, 0.8, p) * (n > 1.1 - p ? 1 : 0);
        v = grassy * (1.3 + 1.6 * hash2(x, y, 9));
        if (p >= 0.7 && hash2(x, y, 13) < (p - 0.6) * 0.25) v = Math.max(v, 2.9); // shrubs
      }
      vegetation[i] = v;
    }
  }

  return {
    grid,
    water,
    contam,
    moisture,
    vegetation,
    waterSource: new Float32Array(N),
    oil: new Float32Array(N),
    oilStored: new Float32Array(N * 2),
    surface,
    poi: { skull: [cx, cy], healthy: [cx, cy], dam: [0, 0], site: [cx, cy], reservoir: [0, 0], landfill: [0, 0] },
  };
}
