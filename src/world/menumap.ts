// The main-menu diorama (design doc §4): a skull and bones on a mound of
// reddish-grey dust. Its state is a pure function of persistent progress p (0..1):
//   0     trash, dust, dirty air, wind
//   ~0.3  less garbage, exposed soil
//   ~0.5  moss and lichen on the bones
//   ~0.7  grass and flowers through the debris
//   1     a tree grows through the skull and dominates the scene
//
// The figure (DECISIONS round 4: "a ribcage or more obvious skull shape"): an
// upright skull facing the camera — domed cranium, brow, deep eye sockets,
// nasal hole, cheekbones, teeth and an open jaw — half sunk in the mound, a
// ribcage lying on its back to one side (spine and open hoops), and two
// crossed long bones in front.

import { ColumnGrid } from './layout';
import { MAT } from './materials';
import type { MapData } from './mapgen';
import { fbm, hash2, smoothstep } from './noise';

const W = 48;
const H = 48;
const ZMAX = 40;
const SQ = Math.SQRT1_2;

export function generateMenuMap(p: number): MapData {
  const dims = { w: W, h: H, zMax: ZMAX };
  const N = W * H;
  const grid = new ColumnGrid(dims);

  // Frame: a = toward the camera (+x+y), s = screen right, z up.
  const cx = 21;
  const cy = 21;
  const toXY = (a: number, s: number): [number, number] => [cx + (a - s) * SQ, cy + (a + s) * SQ];
  const frame = (x: number, y: number): [number, number] => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    return [(dx + dy) * SQ, (dy - dx) * SQ];
  };

  // ground + the dust mound the bones rest on
  const ground = new Float32Array(N);
  const mound = new Float32Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      ground[i] = Math.round(6 + fbm(x / 9, y / 9, 3, 5) * 1.6);
      const [a, s] = frame(x, y);
      // an oval heap, longest along the ribcage, lumpy
      const d = Math.hypot(a / 1.0, (s - 3) / 1.45);
      const lump = fbm(x / 4, y / 4, 2, 23) * 1.2;
      mound[i] = Math.max(0, Math.round(5.2 * smoothstep(17, 3, d) + lump * smoothstep(17, 8, d)));
    }
  const gAt = (x: number, y: number) => {
    const i = Math.max(0, Math.min(H - 1, Math.floor(y))) * W + Math.max(0, Math.min(W - 1, Math.floor(x)));
    return ground[i] + mound[i];
  };

  // ---- skull ----
  const zc = gAt(cx, cy) - 1; // sunk a little into the dust
  /** 1 = bone, 2 = the dark inside (so sockets and nose read as black holes), 0 = empty */
  const skull = (x: number, y: number, z: number): number => {
    const [a, s] = frame(x, y);
    const zz = z + 0.5 - zc;
    const as = Math.abs(s);
    // domed cranium, hollow
    const cran = ((a + 0.6) / 6.2) ** 2 + (s / 5.6) ** 2 + ((zz - 8.4) / 5.8) ** 2;
    const inner = ((a + 0.6) / 4.9) ** 2 + (s / 4.3) ** 2 + ((zz - 8.2) / 4.4) ** 2;
    let solid = cran < 1 && inner > 1 && zz > 2.5;
    const hollow = inner <= 1 && zz > 2.5;
    // face: upper jaw block, its front rounded
    if (zz >= 3 && zz < 8 && a > 0.5 && a < 5.3 - (s / 4.5) ** 2 * 2.2 && as < 4.5 - Math.max(0, 4.5 - zz) * 0.35) solid = true;
    // brow ridge overhanging the eyes
    if (zz >= 8.4 && zz < 9.6 && a > 3 && a < 5.6 - (s / 4.6) ** 2 * 1.8 && as < 4.6) solid = true;
    // cheekbones flaring out under the eyes
    if (zz >= 5 && zz < 6.6 && as > 3.6 && as < 5.2 && a > 0.8 && a < 4) solid = true;
    // upper teeth (one row, gaps between)
    if (zz >= 2 && zz < 3 && a > 3.4 && a < 5.0 - (s / 3.6) ** 2 * 1.8 && as < 3.4 && Math.floor(s + 10) % 2 === 0) solid = true;
    // eye sockets: big, deep, slightly tilted
    let hole = false;
    for (const sv of [-2.3, 2.3]) {
      if (((a - 4.8) / 3.2) ** 2 + ((s - sv) / 1.85) ** 2 + ((zz - 6.8 - (as - 2.3) * 0.12) / 1.75) ** 2 < 1) hole = true;
    }
    // nasal opening: an inverted heart, narrow at the top
    if (a > 2.6 && zz >= 3.4 && zz < 5.8 && as < 1.3 * (6 - zz) / 2.4) hole = true;
    if (hole) return a > 2.6 && a < 3.6 ? 2 : 0;
    if (solid) return 1;
    // the face block is solid bone; fill the cranium with dark so holes show black
    return hollow ? 2 : 0;
  };
  // lower jaw: a U lying open in front, teeth up; the ramus climbs back to the skull
  const jaw = (x: number, y: number, z: number): boolean => {
    const [a, s] = frame(x, y);
    const zz = z + 0.5 - zc;
    const as = Math.abs(s);
    const chin = 4.9 - (s / 4.2) ** 2 * 2.6;
    if (zz >= 0 && zz < 1 && a < chin && a > chin - 1.3 && as < 4.2) return true; // body
    if (zz >= 0 && zz < 1 && as > 3.3 && as < 4.3 && a > -1.2 && a < 3) return true; // sides
    if (zz >= 1 && zz < 3.4 && as > 3.3 && as < 4.3 && a > -1.2 && a < 0.4) return true; // ramus
    if (zz >= 1 && zz < 2 && a < chin && a > chin - 1 && as < 3.2 && Math.floor(s + 11) % 2 === 0) return true; // teeth
    return false;
  };

  // ---- ribcage: lying on its back to the right, ribs arching up, open top ----
  // Laid along the grid's x axis so each rib is one voxel plane (x = const):
  // diagonal hoops broke into disconnected stair-steps.
  const SPINE_Y = 31.5;
  const ribs = (x: number, y: number, z: number): boolean => {
    const zz = z + 0.5;
    const ds = y + 0.5 - SPINE_Y;
    if (x < 7 || x > 21) return false;
    const g = gAt(x, SPINE_Y);
    const dz = zz - (g + 0.6);
    // spine with knobbly vertebrae
    const knob = x % 2 === 1 ? 0.3 : 0;
    if (x >= 8 && Math.hypot(ds, dz) < 0.8 + knob) return true;
    // ribs every other column, longest in the middle
    if (x % 2 !== 1 || x < 9) return false;
    const k = (x - 9) / 2;
    const R = 5.2 - Math.abs(k - 2.6) * 0.55;
    const r = Math.hypot(ds, dz);
    if (dz < -0.2 || Math.abs(r - R) > 0.55) return false;
    // open at the top, where the breastbone has gone
    return Math.atan2(dz, Math.abs(ds)) < 1.3;
  };
  // ---- two long bones crossed in front of the skull, a loose one by the ribs ----
  const longBones = (x: number, y: number, z: number): boolean => {
    const zz = z + 0.5;
    const px = x + 0.5;
    const py = y + 0.5;
    const seg = (a0: number, s0: number, a1: number, s1: number, r: number, lift: number) => {
      const [ax, ay] = toXY(a0, s0);
      const [bx, by] = toXY(a1, s1);
      const vx = bx - ax;
      const vy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
      const g = gAt(ax + vx * t, ay + vy * t);
      const d = Math.hypot(px - ax - vx * t, py - ay - vy * t, zz - g - 0.5 - lift);
      const knob = t < 0.1 || t > 0.9 ? 0.55 : 0;
      return d < r + knob;
    };
    if (seg(11.5, -9.5, 13.5, 1.5, 0.7, 0)) return true;
    if (seg(16.5, -8, 9, 0, 0.7, 0.9)) return true; // lies across the first
    if (seg(8, 15, 12, 19, 0.6, 0)) return true; // arm bone by the ribs
    return false;
  };

  // the tree of the final stage grows out of the cranium ("where the thinking
  // used to be"), clear of the face
  const treeOn = p >= 0.95;
  const [tx, ty] = toXY(-1.5, 0);
  const trunkTop = zc + 18;
  const tree = (x: number, y: number, z: number): number => {
    if (!treeOn) return 0;
    const zz = z + 0.5;
    const d = Math.hypot(x + 0.5 - tx, y + 0.5 - ty);
    if (d < 1.1 && zz > zc + 5 && zz < trunkTop) return MAT.Wood;
    if (zz > trunkTop - 6 && zz < trunkTop && d < 1.2 + (zz - (trunkTop - 6)) * 0.5 && hash2(x, y, z) < 0.35) return MAT.Wood;
    const cr = Math.hypot(x + 0.5 - tx + 1.5, y + 0.5 - ty - 1.5, (zz - (trunkTop + 3)) * 1.35);
    if (cr < 7.5 && hash2(x * 7 + z, y * 3 + z * 5, 11) < 0.78 - cr * 0.04) return MAT.Leaves;
    return 0;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const g = ground[i];
      const top = g + mound[i];
      grid.push(x, y, 0, g - 2, MAT.Stone);
      grid.push(x, y, g - 2, g, MAT.Soil);
      if (top > g) grid.push(x, y, g, top, MAT.Ash);
      // scan the column for skull, bones, tree (bones may sink into the dust)
      let run = 0;
      let runStart = top;
      for (let z = top; z <= ZMAX; z++) {
        let m = 0;
        if (z < ZMAX) {
          const sk = skull(x, y, z);
          m = tree(x, y, z) || (sk === 1 || jaw(x, y, z) || ribs(x, y, z) || longBones(x, y, z) ? MAT.Bone : sk === 2 ? MAT.Asphalt : 0);
        }
        if (m !== run) {
          if (run) grid.push(x, y, runStart, z, run);
          run = m;
          runStart = z;
        }
      }
      // debris and garbage, fading with progress
      if (grid.top(x, y) === top) {
        const h = hash2(x, y, 31);
        if (h < 0.1 * (1 - p) ** 1.5 && mound[i] < 2) grid.push(x, y, top, top + 1, MAT.Trash);
        else if (h > 0.985) grid.push(x, y, top, top + 1, h > 0.993 ? MAT.Concrete : MAT.Rust);
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
      else if (top === MAT.Soil || top === MAT.Trash || top === MAT.Ash) {
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
