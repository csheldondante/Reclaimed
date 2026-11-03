// ---- play/lab/terrains.ts ---------------------------------------------------------------------------------------
// (round 121, herolab; BACKLOG HL1, CAM1) The hero lab's test terrains, one tap apart on one 256 × 256 map: the foot
// of a tall cliff with turns (one leading on, one a dead end), a canyon, a dense forest, a city street, a cave mouth
// and open hills. Each has a closed ride path for the autopilot (with a speed share per point: it slows into a dead
// end and turns round in it) and points of interest. Pure: the level builds its columns from `labColumn`
// (levels/herolab.ts), and the Node metrics ride the same land without a browser (lab/metrics.test.ts).
//
// World coordinates (x cells, y world units = rows × ROW_H). The camera looks from +x+y at the fixed view, so a cliff
// whose face looks away from it (−y) stands between the eye and the hero riding along its foot: the case to fix.

import type { V2 } from '../../api/contracts/camera';
import { MAT } from '../../world/materials';

/** the ground's height (cells) */
export const G = 10;

export interface LabTerrain {
  id: string;
  name: string;
  /** one line: what to look for */
  hint: string;
  /** the world rect it lies in: x0, y0, x1, y1 */
  rect: [number, number, number, number];
  /** the ride: a closed loop of world points, each with a speed share (0..1 of the throttle) */
  path: { at: V2; speed: number }[];
  /** points the camera should keep readable besides the hero and the way ahead (objectives: a cave's mouth) */
  pois: V2[];
}

/** One column's layers: the ground to `top` (a material skin over stone), and anything over open air (an overhang). */
export interface LabColumn {
  top: number;
  skin: number;
  /** solid hung over air: [z0, z1, mat] (a cave's roof, a canopy) */
  over?: [number, number, number][];
  /** the plants' succession field there (≥3.6 woods: the draw's trees) */
  veg?: number;
}

// ---- small helpers --------------------------------------------------------------------------------------------
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hash = (x: number, y: number) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** a smooth value noise, 0..1 */
function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * u;
  const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * u;
  return a + (b - a) * v;
}
/** a rounded rectangle loop, counter-clockwise from its bottom middle: n points a corner */
function roundRect(cx: number, cy: number, hw: number, hh: number, r: number, n = 6): V2[] {
  const out: V2[] = [];
  const corners: [number, number, number][] = [
    [cx + hw - r, cy - hh + r, -Math.PI / 2],
    [cx + hw - r, cy + hh - r, 0],
    [cx - hw + r, cy + hh - r, Math.PI / 2],
    [cx - hw + r, cy - hh + r, Math.PI],
  ];
  for (const [x, y, a0] of corners) for (let k = 0; k <= n; k++) out.push([x + Math.cos(a0 + (k / n) * (Math.PI / 2)) * r, y + Math.sin(a0 + (k / n) * (Math.PI / 2)) * r]);
  return out;
}
const at = (pts: V2[], speed = 1) => pts.map((p) => ({ at: p, speed }));
/** inside the polygon-free shapes below: a box */
const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

// ---- the stations (world rects: three across, two down) -----------------------------------------------------------
const W3 = 256 / 3;
const HALF = 110;

// 1. the foot of a tall cliff: a massif with a notch cut into its south face (a dead end), its corners the turns that
// lead on. The ride laps the massif at its foot and goes into the notch and out once a lap.
// (round 121: the loop kept 20 cells in from the map's edges — at the edge the bike flew off into the void)
const CLIFF = { x0: 0, y0: 0, m: [30, 34, 66, 84] as [number, number, number, number], h: 36, notch: [42, 34, 56, 56] as [number, number, number, number] };
function cliffPath(): { at: V2; speed: number }[] {
  const [x0, y0, x1, y1] = CLIFF.m;
  const o = 7;
  const loop = roundRect((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + o, (y1 - y0) / 2 + o, 9);
  // (the detour: off the south side, up into the notch, round, and back out)
  const [nx0, , nx1, ny1] = CLIFF.notch;
  const mid = (nx0 + nx1) / 2;
  const south = y0 - o;
  const detour: { at: V2; speed: number }[] = [
    { at: [nx0 - 6, south], speed: 0.7 },
    { at: [mid - 3.5, south + 4], speed: 0.45 },
    { at: [mid - 3.5, ny1 - 9], speed: 0.4 },
    { at: [mid - 2, ny1 - 5], speed: 0.3 },
    { at: [mid + 2, ny1 - 5], speed: 0.3 },
    { at: [mid + 3.5, ny1 - 9], speed: 0.4 },
    { at: [mid + 3.5, south + 4], speed: 0.5 },
    { at: [nx1 + 6, south], speed: 0.8 },
  ];
  // (the loop starts at its bottom middle, heading +x: the detour goes in where the loop passes the notch)
  const pts = at(loop, 0.75);
  const i = pts.findIndex((p) => p.at[0] > nx1 + 6 && p.at[1] < y0);
  return [...detour, ...pts.slice(i)].filter((p, k, a) => k === 0 || Math.hypot(p.at[0] - a[k - 1].at[0], p.at[1] - a[k - 1].at[1]) > 0.5);
}
function cliffColumn(x: number, y: number): LabColumn {
  const [x0, y0, x1, y1] = CLIFF.m;
  const [nx0, ny0, nx1, ny1] = CLIFF.notch;
  const rough = (noise(x / 6, y / 6) - 0.5) * 3;
  if (inBox(x, y, x0, y0, x1, y1) && !inBox(x, y, nx0, ny0 - 1, nx1, ny1)) return { top: G + CLIFF.h + rough, skin: MAT.Stone };
  return { top: G + noise(x / 9, y / 9) * 0.8, skin: MAT.Soil, veg: 1.4 };
}

// 2. a canyon: a plateau with a winding ring of a canyon cut through it (and a short blind branch), the ride its floor.
const CANYON = { x0: W3, cx: W3 + W3 / 2, cy: 55, hw: 28, hh: 38, r: 14, width: 9, h: 26 };
function canyonRing(): V2[] {
  const base = roundRect(CANYON.cx, CANYON.cy, CANYON.hw, CANYON.hh, CANYON.r, 10);
  // (a wiggle across the way, so the walls turn)
  return base.map(([x, y], k) => {
    const a = Math.atan2(y - CANYON.cy, x - CANYON.cx);
    const w = Math.sin(k * 0.9) * 2.5;
    return [x + Math.cos(a) * w, y + Math.sin(a) * w];
  });
}
const RING = canyonRing();
const BRANCH: [V2, V2] = [
  [CANYON.cx + CANYON.hw, CANYON.cy],
  [CANYON.cx + CANYON.hw + 16, CANYON.cy - 4],
];
function distToPath(p: V2, path: V2[], closed: boolean): number {
  let best = Infinity;
  const n = path.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / Math.max(1e-9, dx * dx + dy * dy), 0, 1);
    best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
  }
  return best;
}
/**
 * (round 120, PL30: small obstacles that stop the bike dead) boulders on the canyon's floor, a little off its middle,
 * every ~22 cells of the ring: 3 cells high (over the bike's 1.2 wall), a cell and a half across
 */
const BOULDERS: V2[] = (() => {
  const out: V2[] = [];
  let run = 0;
  for (let k = 0; k < RING.length; k++) {
    const a = RING[k];
    const b = RING[(k + 1) % RING.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    run += l;
    if (run > 22) {
      run = 0;
      // (round 128: 2.8 off the middle, was 1.6 — on the middle line a walker, the knight, stood against the first one;
      // the bike's sloppy line still meets them)
      const side = out.length % 2 ? 2.8 : -2.8;
      out.push([a[0] + (-(b[1] - a[1]) / l) * side, a[1] + ((b[0] - a[0]) / l) * side]);
    }
  }
  return out;
})();
const onRock = (x: number, y: number, rocks: V2[], r: number) => rocks.some((p) => Math.hypot(x - p[0], y - p[1]) < r);

function canyonColumn(x: number, y: number): LabColumn {
  if (onRock(x, y, BOULDERS, 1.6)) return { top: G + 3, skin: MAT.Stone };
  const inside = inBox(x, y, CANYON.x0 + 6, 4, CANYON.x0 + W3 - 4, HALF - 4);
  if (!inside) return { top: G + noise(x / 9, y / 9) * 0.8, skin: MAT.Sand };
  const d = Math.min(distToPath([x, y], RING, true), distToPath([x, y], BRANCH, false) + 1);
  const half = CANYON.width / 2 + (noise(x / 4, y / 4) - 0.5) * 1.5;
  if (d < half) return { top: G + noise(x / 7, y / 7) * 0.6, skin: MAT.Sand };
  // (round 128, the user: "Maybe we can make canyons have some taper so it reads?" — the walls taper: 45 deg at the
  // foot steepening to near vertical higher up (u + 0.5 u²: rise over run 1 + u), so a wall run reads and is
  // learnable; was a straight 6 rise over run, 80 deg, from the floor — then the plateau's top, banded)
  const u = d - half;
  const top = G + Math.min(CANYON.h, u + 0.5 * u * u) + (noise(x / 8, y / 8) - 0.5) * 2 * Math.min(1, u / 3);
  return { top, skin: MAT.Sandstone };
}

// 3. a dense forest: gentle ground thick with old woods (the draw's trees, vegplan.wgsl, at their densest), the ride
// weaving through.
const FOREST = { x0: 2 * W3 };
function forestPath(): { at: V2; speed: number }[] {
  const cx = FOREST.x0 + W3 / 2;
  const pts: V2[] = [];
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2 - Math.PI / 2;
    const r = 1 + 0.12 * Math.sin(a * 3);
    pts.push([cx + Math.cos(a) * 30 * r, 52 + Math.sin(a) * 34 * r]);
  }
  return at(pts, 0.7);
}
function forestColumn(x: number, y: number): LabColumn {
  // (round 128: the swell eased in over the forest's first 10 cells, so a walker crosses from the canyon's flat sand: the
  // knight on the tour stood at a 2-cell step there)
  const top = G + noise(x / 12, y / 12) * 3 * clamp((x - FOREST.x0) / 10, 0, 1);
  // (round 128, the tour: a band south of the forest's ride, shrubs in the west to low trees in the east — vegplan.wgsl:
  // shrubs from 2.6, young trees from 3.6 — before the old woods)
  if (inBox(x, y, FOREST.x0 + 3, TOUR_BAND[0], 256 - 3, TOUR_BAND[1])) return { top, skin: MAT.Soil, veg: 2.8 + (1.1 * (x - FOREST.x0)) / (256 - FOREST.x0) };
  return { top, skin: MAT.Soil, veg: inBox(x, y, FOREST.x0 + 3, 3, 256 - 3, HALF - 3) ? 5 : 1.4 };
}
/** (round 128) the tour's band of shrubs and low trees: rows of world y south of the forest's ride (which reaches ~90) */
const TOUR_BAND: V2 = [93, HALF - 3];

// 4. a city street: blocks of buildings on a grid, the ride lapping a few blocks along the streets, and up a blind
// alley once a lap.
const CITY = { x0: 0, y0: HALF + 1, streets: [4, 25, 46, 67], cross: [4, 27, 50, 73, 96], width: 7 };
function cityPath(): { at: V2; speed: number }[] {
  const y0 = CITY.y0;
  const xa = CITY.streets[1] + 3.5;
  const xb = CITY.streets[3] + 3.5;
  const ya = y0 + CITY.cross[1] + 3.5;
  const yb = y0 + CITY.cross[3] + 3.5;
  const loop = roundRect((xa + xb) / 2, (ya + yb) / 2, (xb - xa) / 2, (yb - ya) / 2, 6, 5);
  const pts = at(loop, 0.5);
  // (the alley: off the bottom street up into the block between, a dead end)
  const ax = CITY.streets[2] + 3.5;
  const detour: { at: V2; speed: number }[] = [
    { at: [ax - 9, ya], speed: 0.6 },
    // (round 128: the turn into the alley from the street's middle — cut from 6.5 cells back, a walker caught the
    // building's corner and stood there)
    { at: [ax - 1.5, ya], speed: 0.4 },
    { at: [ax - 1.5, ya + 4], speed: 0.4 },
    { at: [ax - 1.5, ya + 13], speed: 0.3 },
    { at: [ax, ya + 15.5], speed: 0.25 },
    { at: [ax + 1.5, ya + 13], speed: 0.3 },
    { at: [ax + 1.5, ya + 4], speed: 0.4 },
    { at: [ax + 1.5, ya], speed: 0.4 },
    { at: [ax + 9, ya], speed: 0.6 },
  ];
  const i = pts.findIndex((p) => p.at[0] > ax + 9 && Math.abs(p.at[1] - ya) < 1);
  // (round 128: the ride starts on the open street, the alley at the lap's end — from a standing start the bike met the
  // alley's turn at once and crawled)
  return [...pts.slice(i), ...detour].filter((p, k, a) => k === 0 || Math.hypot(p.at[0] - a[k - 1].at[0], p.at[1] - a[k - 1].at[1]) > 0.5);
}
/** (round 120, PL30) bollards: posts a cell across, 3 high, along the streets the ride laps, a little off their middle */
const POSTS: V2[] = (() => {
  const out: V2[] = [];
  const y0 = CITY.y0;
  const xa = CITY.streets[1] + 3.5;
  const xb = CITY.streets[3] + 3.5;
  const ya = y0 + CITY.cross[1] + 3.5;
  const yb = y0 + CITY.cross[3] + 3.5;
  for (let x = xa + 10; x < xb - 8; x += 13) out.push([x, yb + 1.5]);
  for (let y = ya + 10; y < yb - 8; y += 13) out.push([xa - 1.5, y], [xb + 1.5, y + 6]);
  return out;
})();

function cityColumn(x: number, y: number): LabColumn {
  if (onRock(x, y, POSTS, 0.7)) return { top: G + 3, skin: MAT.Steel };
  const u = x - CITY.x0;
  const v = y - CITY.y0;
  const w = CITY.width;
  const street = CITY.streets.some((s) => u >= s && u < s + w) || CITY.cross.some((s) => v >= s && v < s + w) || u < 2 || v < 2;
  // (the blind alley: 5 wide, from the street at cross[1] up 16 into the block)
  const ax = CITY.streets[2] + 3.5;
  const alley = Math.abs(u - ax) < 3 && v >= CITY.cross[1] && v < CITY.cross[1] + w + 13;
  if (street || alley || u > 84) return { top: G, skin: MAT.Asphalt };
  // (a building a lot: lots 7 cells, set back a cell from the street; heights by hash, a tower now and then)
  const lx = Math.floor(u / 7);
  const ly = Math.floor(v / 7);
  const r = hash(lx * 7 + 3, ly * 13 + 1);
  const h = 8 + Math.floor(r * 16) + (r > 0.85 ? 12 : 0);
  const mat = r < 0.35 ? MAT.Concrete : r < 0.7 ? MAT.Brick : MAT.Plaster;
  return { top: G + h, skin: mat };
}

// 5. a cave mouth: a mountain whose cliff faces away from the eye (−y), a big mouth in it opening on a tunnel that
// runs in and ends; the ride along the foot past the mouth, and back across open ground.
const CAVE = { x0: W3, y0: HALF + 1, face: HALF + 1 + 55, h: 40, mouth: [W3 + 34, W3 + 52] as V2, roof: 11, depth: 30 };
function cavePath(): { at: V2; speed: number }[] {
  const cx = CAVE.x0 + W3 / 2;
  const y1 = CAVE.face - 7;
  const y0 = CAVE.y0 + 14;
  return at(roundRect(cx, (y0 + y1) / 2, 32, (y1 - y0) / 2, 8, 6), 0.7);
}
function caveColumn(x: number, y: number): LabColumn {
  const flat = { top: G + noise(x / 9, y / 9) * 0.8, skin: MAT.Soil, veg: 1.6 };
  // (the face wanders a little)
  const face = CAVE.face + (noise(x / 7, 3) - 0.5) * 5;
  if (y < face) return flat;
  const top = G + Math.min(CAVE.h, (y - face) * 8) + (noise(x / 8, y / 8) - 0.5) * 3;
  const [m0, m1] = CAVE.mouth;
  const mid = (m0 + m1) / 2;
  const half = (m1 - m0) / 2;
  const into = y - face;
  // (the tunnel narrows as it goes in, the mouth arched: a roof over air)
  const w = half * (1 - (0.5 * into) / CAVE.depth);
  if (into < CAVE.depth && Math.abs(x - mid) < w) {
    const arch = CAVE.roof * Math.sqrt(Math.max(0, 1 - ((x - mid) / w) ** 2));
    const floor = G + 0.2;
    if (arch > 2) return { top: floor, skin: MAT.Stone, over: [[floor + arch, Math.max(top, floor + arch + 3), MAT.Stone]] };
  }
  return { top, skin: MAT.Stone };
}

// 6. open hills: rolling ground, the ride a loop over the crests (the baseline: little to hide anything).
const HILLS = { x0: 2 * W3, y0: HALF + 1 };
function hillsPath(): { at: V2; speed: number }[] {
  const cx = HILLS.x0 + W3 / 2;
  const cy = HILLS.y0 + 55;
  const pts: V2[] = [];
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 2 - Math.PI / 2;
    pts.push([cx + Math.cos(a) * 30, cy + Math.sin(a) * 38]);
  }
  return at(pts, 0.85);
}
/**
 * (round 128, the physical drive) the hill station, in the hills' south strip: a flat run-up, then a ramp rising
 * `height` at `slope` rise over run, then a flat top; the ride climbs it on one lane and comes down the other. 0.8 a
 * cell: under the knight's stride (0.9), so the cells read as a slope, not a wall — the knight crawls up it from
 * standing (the slope's pull nearly matches its push) and carries up with a run-up; the brute can't from standing.
 * (Steeper, the lab's one-cell columns make it a sheer step — core/drive.test.ts checks the knight's limit smooth.)
 */
export const HILL = { x0: 176, x1: 252, y0: 206, y1: 219, foot: 222, slope: 0.8, height: 2.4, base: G + 1 };
export const hillAt = (x: number) => HILL.base + Math.max(0, Math.min(HILL.height, (x - HILL.foot) * HILL.slope));
function hillsColumn(x: number, y: number): LabColumn {
  if (inBox(x, y, HILL.x0, HILL.y0, HILL.x1, HILL.y1)) return { top: hillAt(x), skin: MAT.Soil, veg: 0 };
  const h = 7 * (0.5 + 0.5 * Math.sin(x / 9.5) * Math.cos(y / 11)) + noise(x / 10, y / 10) * 3;
  // (a soil skin: grass is a plant layer, not ground — the agents stood on the stone under it, out of sight)
  return { top: G + h, skin: MAT.Soil, veg: 0 };
}

export const LAB_TERRAINS: LabTerrain[] = [
  { id: 'cliff', name: 'Cliff foot', hint: 'a massif whose corners lead on and whose notch is a dead end', rect: [0, 0, W3, HALF], path: cliffPath(), pois: [] },
  { id: 'canyon', name: 'Canyon', hint: 'a winding ring canyon through a plateau, a blind branch off it', rect: [W3, 0, 2 * W3, HALF], path: at(RING, 0.5), pois: [] },
  { id: 'forest', name: 'Forest', hint: 'old woods at their densest, the ride weaving through', rect: [2 * W3, 0, 256, HALF], path: forestPath(), pois: [] },
  { id: 'city', name: 'City street', hint: 'blocks of buildings, the ride round a few, up a blind alley once a lap', rect: [0, HALF + 1, W3, 2 * HALF], path: cityPath(), pois: [] },
  { id: 'cave', name: 'Cave mouth', hint: 'a mountain facing away, a cave mouth in its face; the ride along its foot', rect: [W3, HALF + 1, 2 * W3, 2 * HALF], path: cavePath(), pois: [[(CAVE.mouth[0] + CAVE.mouth[1]) / 2, CAVE.face + 2]] },
  { id: 'hills', name: 'Open hills', hint: 'rolling hills: the baseline, little to hide anything', rect: [2 * W3, HALF + 1, 256, 2 * HALF], path: hillsPath(), pois: [] },
];

/**
 * (round 128, the user's camera intent: "zoom in when going into forests ... not low trees or shrubs. On fields I like
 * the pulled back view") The tour: one loop through what the auto camera should tell apart — a field (the open flat
 * by the cave), shrubs, low trees, the old woods, along the canyon plateau's wall (a cliff), past the massif, down a
 * city street and back across the field. Its own station, over the other stations' land.
 */
export const TOUR: LabTerrain = {
  id: 'tour',
  name: 'The tour',
  hint: 'a field, shrubs, low trees, tall woods, a cliff and a town in one loop',
  rect: [0, 0, 256, 2 * HALF],
  path: [
    { at: [120, 136], speed: 0.8 },
    { at: [150, 132], speed: 0.8 },
    { at: [160, 120], speed: 0.6 },
    { at: [167, 110], speed: 0.5 },
    { at: [176, 103], speed: 0.5 },
    { at: [190, 99], speed: 0.5 },
    { at: [208, 99], speed: 0.45 },
    { at: [220, 95], speed: 0.4 },
    { at: [227, 86], speed: 0.4 },
    { at: [226, 75], speed: 0.4 },
    { at: [218, 66], speed: 0.4 },
    { at: [205, 64], speed: 0.45 },
    { at: [190, 74], speed: 0.5 },
    { at: [180, 92], speed: 0.55 },
    { at: [172, 108.5], speed: 0.6 },
    { at: [150, 109], speed: 0.7 },
    { at: [120, 109], speed: 0.7 },
    { at: [92, 109], speed: 0.65 },
    { at: [76, 98], speed: 0.5 },
    { at: [70.5, 104], speed: 0.45 },
    { at: [70.5, 116], speed: 0.45 },
    { at: [70.5, 130], speed: 0.45 },
    { at: [74, 141.5], speed: 0.5 },
    { at: [86, 141.5], speed: 0.6 },
    { at: [100, 139], speed: 0.7 },
  ],
  pois: [],
};

/** (round 128) the hill station's ride: up the ramp on the north lane from a run-up, back down on the south lane */
export const HILL_RIDE: { at: V2; speed: number }[] = [
  { at: [182, 209.5], speed: 1 },
  { at: [215, 209.5], speed: 1 },
  { at: [240, 209.5], speed: 1 },
  { at: [247, 212.5], speed: 0.5 },
  { at: [240, 215.5], speed: 0.6 },
  { at: [210, 215.5], speed: 0.8 },
  { at: [183, 215.5], speed: 0.6 },
  { at: [178, 212.5], speed: 0.5 },
];

/** the station a world point lies in, or null */
export function labTerrainAt(x: number, y: number): LabTerrain | null {
  return LAB_TERRAINS.find((t) => x >= t.rect[0] && x < t.rect[2] && y >= t.rect[1] && y < t.rect[3]) ?? null;
}

/** The column at world (x, y). */
export function labColumn(x: number, y: number): LabColumn {
  const t = labTerrainAt(x, y);
  switch (t?.id) {
    case 'cliff':
      return cliffColumn(x, y);
    case 'canyon':
      return canyonColumn(x, y);
    case 'forest':
      return forestColumn(x, y);
    case 'city':
      return cityColumn(x, y);
    case 'cave':
      return caveColumn(x, y);
    case 'hills':
      return hillsColumn(x, y);
    default:
      return { top: G, skin: MAT.Soil };
  }
}

/** the column's solid, bottom up (world z): stone to 2 under the top, the skin over it, then what's hung over air */
export function labLayers(c: LabColumn): { z0: number; z1: number; mat: number }[] {
  const out: { z0: number; z1: number; mat: number }[] = [];
  const t = Math.max(0.5, c.top);
  if (t > 2) out.push({ z0: 0, z1: t - 2, mat: MAT.Stone });
  out.push({ z0: t > 2 ? t - 2 : 0, z1: t, mat: c.skin });
  for (const [z0, z1, mat] of c.over ?? []) if (z1 > z0 && z0 >= t) out.push({ z0, z1, mat });
  return out;
}
