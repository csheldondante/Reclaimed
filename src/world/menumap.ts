// The main-menu diorama (design doc §4): a skull and bones on a mound of
// reddish-grey dust. Its state is a pure function of persistent progress p (0..1):
//   0     trash, dust, dirty air, wind
//   ~0.3  less garbage, exposed soil
//   ~0.5  moss and lichen on the bones
//   ~0.7  grass and flowers through the debris
//   1     a tree grows out of the skull and dominates the scene
//
// The figure (DECISIONS round 4): an upright skull facing the camera — domed
// cranium, brow, deep eye sockets, nasal hole, cheekbones, teeth and an open
// jaw — cocked to one side and sunk into the mound; a ribcage lying on its
// back to one side (spine and tall swept-back arcs); two crossed long bones
// in front.
//
// Shapes are defined in "figure units" and sampled MENU_SCALE times finer, so
// the figure has more voxels (user: "use more voxels to make it more readable").

import { ColumnGrid } from './layout';
import { MAT } from './materials';
import type { MapData } from './mapgen';
import { fbm, hash2, smoothstep } from './noise';

/** Voxels per figure unit. The menu scene scales its camera by this. */
export const MENU_SCALE = 1.6;
const K = MENU_SCALE;
const FW = 48; // figure units across (rounded up to whole 16-column chunks)
const W = Math.ceil((FW * K) / 16) * 16;
const H = W;
const ZMAX = 64;
const SQ = Math.SQRT1_2;

export function generateMenuMap(p: number): MapData {
  const dims = { w: W, h: H, zMax: ZMAX };
  const N = W * H;
  const grid = new ColumnGrid(dims);

  // Frame (figure units): a = toward the camera (+x+y), s = screen right, z up.
  const cx = 21;
  const cy = 21;
  const toXY = (a: number, s: number): [number, number] => [cx + (a - s) * SQ, cy + (a + s) * SQ];
  const frame = (px: number, py: number): [number, number] => {
    const dx = px - cx;
    const dy = py - cy;
    return [(dx + dy) * SQ, (dy - dx) * SQ];
  };

  // ground + the dust mound the bones rest on (figure units)
  const heightF = (px: number, py: number): number => {
    const [a, s] = frame(px, py);
    // an oval heap, longest toward the ribcage, lumpy
    const d = Math.hypot(a, (s - 3) / 1.45);
    const lump = fbm(px / 4, py / 4, 2, 23) * 1.2;
    return 6 + fbm(px / 9, py / 9, 3, 5) * 1.6 + Math.max(0, 5.2 * smoothstep(17, 3, d) + lump * smoothstep(17, 8, d));
  };
  const baseF = (px: number, py: number) => 6 + fbm(px / 9, py / 9, 3, 5) * 1.6;
  const gAt = heightF;

  // ---- skull: cocked to one side, chin a little up, sunk into the dust ----
  const zc = gAt(cx, cy) - 2.6;
  const YAW = 0.18; // turned a little toward screen left
  const ROLL = 0.24; // head cocked
  const PITCH = 0.1; // chin up
  const cyw = Math.cos(YAW), syw = Math.sin(YAW);
  const cr = Math.cos(ROLL), sr = Math.sin(ROLL);
  const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  /** world (figure units) → the skull's own upright frame (a, s, zz) */
  const skullFrame = (px: number, py: number, pz: number): [number, number, number] => {
    const [a0, s0] = frame(px, py);
    const z0 = pz - zc - 4;
    const a1 = a0 * cyw + s0 * syw;
    const s1 = -a0 * syw + s0 * cyw;
    const s2 = s1 * cr + z0 * sr;
    const z2 = -s1 * sr + z0 * cr;
    const a3 = a1 * cp + z2 * sp;
    const z3 = -a1 * sp + z2 * cp;
    return [a3, s2, z3 + 4];
  };
  /** 1 = bone, 2 = the dark inside (so sockets and nose read as black holes), 0 = empty */
  const skull = (px: number, py: number, pz: number): number => {
    const [a, s, zz] = skullFrame(px, py, pz);
    const as = Math.abs(s);
    // domed cranium, hollow
    const cran = ((a + 0.6) / 6.2) ** 2 + (s / 5.6) ** 2 + ((zz - 8.4) / 5.8) ** 2;
    const inner = ((a + 0.6) / 5.0) ** 2 + (s / 4.4) ** 2 + ((zz - 8.2) / 4.6) ** 2;
    // (a bone floor at the base, or the tilt shows the dark inside from below)
    let solid = cran < 1 && zz > 2.5 && (inner > 1 || zz <= 3.4);
    const hollow = inner <= 1 && cran < 1 && zz > 3.4;
    // face: upper jaw block, its front rounded
    if (zz >= 3 && zz < 8 && a > 0.5 && a < 5.3 - (s / 4.5) ** 2 * 2.2 && as < 4.5 - Math.max(0, 4.5 - zz) * 0.35) solid = true;
    // brow ridge overhanging the eyes
    if (zz >= 8.4 && zz < 9.4 && a > 3 && a < 5.7 - (s / 4.6) ** 2 * 1.8 && as < 4.6) solid = true;
    // cheekbones flaring out under the eyes
    if (zz >= 5 && zz < 6.4 && as > 3.6 && as < 5.2 && a > 0.8 && a < 4) solid = true;
    // upper teeth (one row, gaps between)
    if (zz >= 2.1 && zz < 3 && a > 3.4 && a < 5.0 - (s / 3.6) ** 2 * 1.8 && as < 3.4 && Math.floor(s * 1.6 + 20) % 2 === 0) solid = true;
    // eye sockets: big, deep, slightly tilted
    let hole = false;
    for (const sv of [-2.3, 2.3]) {
      if (((a - 4.8) / 3.2) ** 2 + ((s - sv) / 1.8) ** 2 + ((zz - 6.8 - (as - 2.3) * 0.12) / 1.7) ** 2 < 1) hole = true;
    }
    // nasal opening: an inverted heart, narrow at the top
    if (a > 2.6 && zz >= 3.4 && zz < 5.8 && as < 1.2 * (6 - zz) / 2.4 + (zz < 4 ? 0.15 : 0)) hole = true;
    if (hole) return a > 2.6 && a < 3.6 ? 2 : 0;
    if (solid) return 1;
    // the face block is solid bone; fill the cranium with dark so holes show black
    return hollow ? 2 : 0;
  };
  // lower jaw: a U, teeth up, mouth hanging open; the ramus climbs back to the skull
  const jaw = (px: number, py: number, pz: number): boolean => {
    const [a, s, zz] = skullFrame(px, py, pz);
    const as = Math.abs(s);
    const chin = 4.9 - (s / 4.2) ** 2 * 2.6;
    if (zz >= -0.2 && zz < 0.9 && a < chin && a > chin - 1.3 && as < 4.2) return true; // body
    if (zz >= -0.2 && zz < 0.9 && as > 3.3 && as < 4.3 && a > -1.2 && a < 3) return true; // sides
    if (zz >= 0.9 && zz < 3.4 && as > 3.3 && as < 4.3 && a > -1.2 && a < 0.4) return true; // ramus
    if (zz >= 0.9 && zz < 1.6 && a < chin && a > chin - 1 && as < 3.2 && Math.floor(s * 1.6 + 21) % 2 === 0) return true; // teeth
    return false;
  };

  // ---- ribcage: lying on its back to the right ----
  // Along the grid's x axis so each rib stays (nearly) in voxel planes —
  // diagonal hoops broke into disconnected stair-steps. Ribs are tall arcs
  // sweeping back toward the pelvis end as they rise, open at the very top.
  const SPINE_Y = 31.5;
  const ribs = (px: number, py: number, pz: number): boolean => {
    if (px < 7 || px > 22.5) return false;
    const ds = py - SPINE_Y;
    const g = gAt(px, SPINE_Y);
    const dz = pz - (g + 0.4);
    // spine with knobbly vertebrae
    const knob = Math.abs((px % 1.4) - 0.7) < 0.35 ? 0.3 : 0;
    if (px >= 8 && Math.hypot(ds, dz) < 0.75 + knob) return true;
    for (let k = 0; k < 7; k++) {
      const rx = 9.2 + k * 1.9;
      // the arc's plane leans back (toward smaller x) as it climbs
      const lean = Math.max(0, dz) * 0.16;
      if (Math.abs(px - (rx - lean)) > 0.36) continue;
      const R = 4.6 - Math.abs(k - 2.6) * 0.45;
      const Rz = R * 1.3;
      const e = Math.hypot(ds / R, dz / Rz);
      if (dz < -0.2 || Math.abs(e - 1) * R > 0.42) continue;
      // open at the top, where the breastbone has gone
      if (dz > Rz * 0.93 && Math.abs(ds) < R * 0.28) continue;
      return true;
    }
    return false;
  };
  // ---- two long bones crossed in front of the skull, a loose one by the ribs ----
  const longBones = (px: number, py: number, pz: number): boolean => {
    const seg = (a0: number, s0: number, a1: number, s1: number, r: number, lift: number) => {
      const [ax, ay] = toXY(a0, s0);
      const [bx, by] = toXY(a1, s1);
      const vx = bx - ax;
      const vy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
      const g = gAt(ax + vx * t, ay + vy * t);
      const d = Math.hypot(px - ax - vx * t, py - ay - vy * t, pz - g - 0.4 - lift);
      const knob = t < 0.1 || t > 0.9 ? 0.5 : 0;
      return d < r + knob;
    };
    if (seg(11.5, -9.5, 13.5, 1.5, 0.6, 0)) return true;
    if (seg(16.5, -8, 9, 0, 0.6, 0.9)) return true; // lies across the first
    if (seg(8, 15, 12, 19, 0.5, 0)) return true; // arm bone by the ribs
    return false;
  };

  // the tree of the final stage grows out of the cranium ("where the thinking
  // used to be"), clear of the face
  const treeOn = p >= 0.95;
  const [tx, ty] = toXY(-1.5, 0);
  const trunkTop = zc + 15;
  // canopy: a solid, lumpy crown (per-voxel random leaves made too many
  // layers per column at this resolution); a few branches reach into it
  const tree = (px: number, py: number, pz: number): number => {
    if (!treeOn) return 0;
    const d = Math.hypot(px - tx, py - ty);
    if (d < 1.0 && pz > zc + 5 && pz < trunkTop) return MAT.Wood;
    for (const [bx, by] of [[2.5, 1], [-2, 2], [0.5, -2.5]]) {
      const t = (pz - (trunkTop - 5)) / 5;
      if (t > 0 && t < 1 && Math.hypot(px - tx - bx * t, py - ty - by * t) < 0.6) return MAT.Wood;
    }
    const lump = fbm(px / 2.2, py / 2.2 + pz / 3, 2, 91) * 2.2;
    const c = Math.hypot(px - tx + 1, py - ty - 1, (pz - (trunkTop + 2.5)) * 1.3);
    if (c < 6.3 + lump) return MAT.Leaves;
    return 0;
  };

  const mound = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const px = (x + 0.5) / K;
      const py = (y + 0.5) / K;
      const g = Math.round(baseF(px, py) * K);
      const top = Math.max(g, Math.round(heightF(px, py) * K));
      mound[i] = top - g;
      grid.push(x, y, 0, g - 3, MAT.Stone);
      grid.push(x, y, g - 3, g, MAT.Soil);
      if (top > g) grid.push(x, y, g, top, MAT.Ash);
      // scan the column for skull, bones, tree (bones may sink into the dust)
      let run = 0;
      let runStart = top;
      for (let z = top; z <= ZMAX; z++) {
        let m = 0;
        if (z < ZMAX) {
          const pz = (z + 0.5) / K;
          const sk = skull(px, py, pz);
          m = tree(px, py, pz) || (sk === 1 || jaw(px, py, pz) || ribs(px, py, pz) || longBones(px, py, pz) ? MAT.Bone : sk === 2 ? MAT.Asphalt : 0);
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
        if (h < 0.05 * (1 - p) ** 1.5 && mound[i] < 3) grid.push(x, y, top, top + 1, MAT.Litter);
        else if (h > 0.99) grid.push(x, y, top, top + 1, h > 0.995 ? MAT.Concrete : MAT.Rust);
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
      const n = fbm(x / (7 * K), y / (7 * K), 2, 77) * 0.5 + 0.5;
      // the dust is foul; old bone is clean (grime would speckle the skull)
      contam[i * 2] = top === MAT.Bone || top === MAT.Asphalt ? 0 : Math.max(0, (1 - p) * (0.45 + n * 0.3));
      moisture[i] = 0.08 + p * 0.55;
      // succession on the diorama as progress grows
      let v = 0;
      if (top === MAT.Bone) v = smoothstep(0.35, 0.6, p) * (0.6 + 0.6 * hash2(x, y, 4)); // moss/lichen on bone
      else if (top === MAT.Soil || top === MAT.Litter || top === MAT.Ash) {
        const grassy = smoothstep(0.45, 0.8, p) * (n > 1.1 - p ? 1 : 0);
        v = grassy * (1.3 + 1.6 * hash2(x, y, 9));
        if (p >= 0.7 && hash2(x, y, 13) < (p - 0.6) * 0.12) v = Math.max(v, 2.9); // shrubs
      }
      vegetation[i] = v;
    }
  }

  const sk: [number, number] = [cx * K, cy * K];
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
    poi: { skull: sk, healthy: sk, dam: [0, 0], site: sk, reservoir: [0, 0], landfill: [0, 0] },
  };
}
