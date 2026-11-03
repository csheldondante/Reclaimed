// ---- play/course/course.ts -------------------------------------------------------------------------------------
// (round 128b, `playmodes`; docs/design/PLAY_MODES.md) The hero course: one continuous loop through the world's kinds
// of place, in order — open hills, a forest, a canyon climbing in switchbacks, a cliff with a cave mouth, a river and
// its lake shore, ruins with metal, a small town — and back to the hills. Pure: the level builds its columns from
// `courseColumn` (levels/herocourse.ts) and the Node tests ride the same route.
//
// How the land is made: every column belongs to the route's nearest point (its area, how far along it is, which side
// and how far off). Each area shapes its own columns from that: so the areas meet where the route says, the road runs
// through each, and the loop's middle is shared out among the areas round it (the cliff's massif, the canyon's
// plateau, the lake).
//
// World coordinates: x cells, y world units (rows × ROW_H). The map is 256 × 256 cells (≈ 256 × 222 world).

import type { V2 } from '../../api/contracts/camera';
import { MAT } from '../../world/materials';
import type { LabColumn } from '../lab/terrains';

export const G = 10;

export type AreaId = 'hills' | 'forest' | 'canyon' | 'cliff' | 'river' | 'ruins' | 'town';

export interface CourseArea {
  id: AreaId;
  name: string;
  icon: string;
  /** one line for the player: what's there */
  hint: string;
}

export const AREAS: CourseArea[] = [
  { id: 'hills', name: 'Hills', icon: '⛰', hint: 'Open rolling hills. Jump off the crests.' },
  { id: 'forest', name: 'Forest', icon: '🌲', hint: 'Old woods with tall trees.' },
  { id: 'canyon', name: 'Canyon', icon: '🏜', hint: 'A narrow canyon that climbs in switchbacks.' },
  { id: 'cliff', name: 'Cliff', icon: '🧗', hint: 'A tall cliff with a cave mouth in it.' },
  { id: 'river', name: 'River', icon: '🌊', hint: 'A river to ford and a lake shore.' },
  { id: 'ruins', name: 'Ruins', icon: '🏚', hint: 'Broken walls and rusted steel.' },
  { id: 'town', name: 'Town', icon: '🏘', hint: 'A small town with narrow streets.' },
];

// ---- the route ----------------------------------------------------------------------------------------------------

/** a switchback's half circle (radius 10) round `c`: in along its bottom, out along its top, on the `side` of `c` */
function hairpin(c: V2, side: 'east' | 'west'): { at: V2; area: AreaId }[] {
  const out: { at: V2; area: AreaId }[] = [];
  const k = side === 'east' ? 1 : -1;
  for (const deg of [-90, -45, 0, 45, 90]) {
    const a = (deg * Math.PI) / 180;
    out.push({ at: [c[0] + k * 10 * Math.cos(a), c[1] + 10 * Math.sin(a)], area: 'canyon' });
  }
  return out;
}

/** the route's control points: each starts a stretch of its area (the loop closes back to the first) */
const CONTROL: { at: V2; area: AreaId }[] = [
  // the hills, east along the bottom
  { at: [24, 22], area: 'hills' },
  { at: [60, 26], area: 'hills' },
  { at: [92, 20], area: 'hills' },
  // the forest
  { at: [112, 24], area: 'forest' },
  { at: [140, 32], area: 'forest' },
  { at: [170, 20], area: 'forest' },
  { at: [205, 24], area: 'forest' },
  // the canyon: up the east side in four switchbacks. (round 128b, the canyon run: each hairpin a half circle of
  // radius 10 round the rock it turns on, not two corners — the corners rounded to a radius of 5, tighter than the
  // bike turns at any speed worth riding, and the bike met the hairpin's inside rock)
  { at: [224, 25], area: 'canyon' },
  ...hairpin([232, 35], 'east'),
  ...hairpin([192, 55], 'west'),
  ...hairpin([232, 75], 'east'),
  ...hairpin([192, 95], 'west'),
  { at: [230, 105], area: 'canyon' },
  { at: [237, 108], area: 'canyon' },
  { at: [240, 115], area: 'canyon' },
  { at: [240, 140], area: 'canyon' },
  // the cliff: west along the top, the massif on the inside (south), its face toward the road
  { at: [236, 192], area: 'cliff' },
  { at: [200, 200], area: 'cliff' },
  { at: [160, 196], area: 'cliff' },
  // the river and the lake shore
  { at: [136, 198], area: 'river' },
  { at: [100, 200], area: 'river' },
  { at: [62, 196], area: 'river' },
  // the ruins, south down the west side
  { at: [26, 192], area: 'ruins' },
  { at: [22, 160], area: 'ruins' },
  { at: [28, 130], area: 'ruins' },
  // the town
  { at: [22, 104], area: 'town' },
  { at: [26, 70], area: 'town' },
  { at: [22, 44], area: 'town' },
];

export interface RoutePoint {
  at: V2;
  area: AreaId;
}

/** the loop: the control points rounded (Chaikin, twice) and resampled about every 2 cells */
function buildRoute(): RoutePoint[] {
  let pts = CONTROL.map((c) => ({ at: [c.at[0], c.at[1]] as V2, area: c.area }));
  for (let it = 0; it < 2; it++) {
    const out: typeof pts = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      out.push({ at: [a.at[0] * 0.75 + b.at[0] * 0.25, a.at[1] * 0.75 + b.at[1] * 0.25], area: a.area });
      out.push({ at: [a.at[0] * 0.25 + b.at[0] * 0.75, a.at[1] * 0.25 + b.at[1] * 0.75], area: a.area });
    }
    pts = out;
  }
  const res: RoutePoint[] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    const l = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
    const n = Math.max(1, Math.round(l / 2));
    for (let j = 0; j < n; j++) res.push({ at: [a.at[0] + ((b.at[0] - a.at[0]) * j) / n, a.at[1] + ((b.at[1] - a.at[1]) * j) / n], area: a.area });
  }
  return res;
}

/** A closed polyline with its length along: the nearest point, the tangent and the side. */
export class Route {
  readonly cum: number[] = [];
  readonly length: number;
  private spans = new Map<AreaId, [number, number]>();
  constructor(readonly pts: RoutePoint[]) {
    let s = 0;
    for (let k = 0; k < pts.length; k++) {
      this.cum.push(s);
      const a = pts[k].at;
      const b = pts[(k + 1) % pts.length].at;
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    this.length = s;
  }

  /**
   * The nearest point of the route to p: `s` along the loop, the unit tangent and left normal there, the signed
   * offset (+ left of the way), the distance, the area. `hint` (an index) and `span` search only near it.
   */
  nearest(p: V2, hint = -1, span = 0): RouteHit {
    const n = this.pts.length;
    let best = 0;
    let bestT = 0;
    let bestD = Infinity;
    const from = hint < 0 ? 0 : hint - span;
    const count = hint < 0 ? n : 2 * span + 1;
    for (let j = 0; j < count; j++) {
      const k = (((from + j) % n) + n) % n;
      const a = this.pts[k].at;
      const b = this.pts[(k + 1) % n].at;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
      const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
      if (d < bestD) {
        bestD = d;
        best = k;
        bestT = t;
      }
    }
    const a = this.pts[best].at;
    const b = this.pts[(best + 1) % n].at;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tan: V2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const nrm: V2 = [-tan[1], tan[0]];
    const c: V2 = [a[0] + (b[0] - a[0]) * bestT, a[1] + (b[1] - a[1]) * bestT];
    const off = (p[0] - c[0]) * nrm[0] + (p[1] - c[1]) * nrm[1];
    return { index: best, s: this.cum[best] + bestT * l, tan, nrm, off, d: bestD, at: c, area: this.pts[best].area };
  }

  /** the point at a distance along the loop */
  pointAt(s: number): RoutePoint & { tan: V2 } {
    const n = this.pts.length;
    const q = ((s % this.length) + this.length) % this.length;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= q) lo = mid;
      else hi = mid - 1;
    }
    const a = this.pts[lo].at;
    const b = this.pts[(lo + 1) % n].at;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const f = (q - this.cum[lo]) / l;
    return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], area: this.pts[lo].area, tan: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] };
  }

  /** where an area's stretch starts and ends along the loop */
  span(area: AreaId): [number, number] {
    const kept = this.spans.get(area);
    if (kept) return kept;
    let s0 = -1;
    let s1 = -1;
    for (let k = 0; k < this.pts.length; k++)
      if (this.pts[k].area === area) {
        if (s0 < 0) s0 = this.cum[k];
        s1 = this.cum[k];
      }
    if (s0 < 0) throw new Error(`course: no area ${area}`);
    this.spans.set(area, [s0, s1]);
    return [s0, s1];
  }
}

export interface RouteHit {
  index: number;
  s: number;
  tan: V2;
  nrm: V2;
  /** + left of the way, − right */
  off: number;
  d: number;
  at: V2;
  area: AreaId;
}

export const ROUTE = new Route(buildRoute());

/** the inside of the loop is on the route's left (the loop runs counter-clockwise) */
const INSIDE = 1;

// ---- the land -----------------------------------------------------------------------------------------------------

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hash = (x: number, y: number) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
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
/** 0 → 1 smoothly over [a, b] */
const ramp = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** a column of the course, with the water standing on it (cells) */
export interface CourseColumn extends LabColumn {
  water?: number;
}

/** the canyon's floor climbs this many cells from its start to its end (the switchbacks) */
const CANYON_RISE = 14;
/** the walls' height over the floor (the plateau between the switchbacks; taller hid the forest and the road from the iso eye) */
const CANYON_WALL = 14;
const CANYON_HALF = 4.2;
/** the lake's and the river's water level */
const WATER = G - 0.6;

/** boulders on the canyon floor: every ~18 cells along it, off the middle by turns (the obstacles coming down the screen) */
export const BOULDERS: V2[] = (() => {
  const [s0, s1] = ROUTE.span('canyon');
  const out: V2[] = [];
  let k = 0;
  for (let s = s0 + 20; s < s1 - 10; s += 18) {
    // (on the straights only: one in a hairpin was met blind, mid-turn, on the line the bend forces)
    const a = ROUTE.pointAt(s - 8).tan;
    const c = ROUTE.pointAt(s + 8).tan;
    if (a[0] * c[0] + a[1] * c[1] < 0.97) continue;
    k++;
    const p = ROUTE.pointAt(s);
    const side = k % 2 ? 2 : -2;
    out.push([p.at[0] - p.tan[1] * side, p.at[1] + p.tan[0] * side]);
  }
  return out;
})();

/** the cave mouth: where along the cliff's stretch, and how wide and deep into the massif */
export const CAVE = (() => {
  const [s0, s1] = ROUTE.span('cliff');
  const s = s0 + (s1 - s0) * 0.55;
  const p = ROUTE.pointAt(s);
  return { s, at: p.at, tan: p.tan, half: 5, depth: 26, roof: 8 };
})();

/** the river: from the map's top edge, across the road, into the lake */
const RIVER_X = 96;

function hillsColumn(x: number, y: number, h: RouteHit): CourseColumn {
  const swell = 5 * (0.5 + 0.5 * Math.sin(x / 9.5) * Math.cos(y / 11)) + noise(x / 10, y / 10) * 3;
  // (the road a little gentler, its crests still there to jump off)
  // (eased in and out at the stretch's ends, so the road meets the town's street and the forest floor level)
  const [s0, s1] = ROUTE.span('hills');
  const ends = ramp(s0, s0 + 24, h.s) * (1 - ramp(s1 - 16, s1, h.s));
  return { top: G + swell * (0.6 + 0.4 * ramp(2, 8, h.d)) * ends, skin: MAT.Soil, veg: 1.2 };
}

function forestColumn(x: number, y: number, h: RouteHit): CourseColumn {
  // (eased to the land's height at the stretch's end, so the road meets the canyon's floor level)
  const [, e1] = ROUTE.span('forest');
  const top = G + noise(x / 12, y / 12) * 2.5 * (1 - ramp(e1 - 16, e1, h.s));
  // (the first half: old woods all round the road, kept to shrubs on the road itself — under the trees. The second half
  // is laid out for a side view from the loop's inside: grass on the road and the near side, the old woods from 4 cells
  // behind the road (the backdrop) — a tall tree on the near side would stand in front of the hero)
  const [s0, s1] = ROUTE.span('forest');
  if (h.s < (s0 + s1) / 2) return { top, skin: MAT.Soil, veg: h.d < 2.5 ? 2.4 : 5 };
  // (the road clear — shrubs on it hid the hero side-on — and the near side grass; the woods from 4 cells behind)
  const inside = h.off * INSIDE;
  if (inside > -4) return { top, skin: MAT.Soil, veg: 1.4 };
  return { top, skin: MAT.Soil, veg: 5 };
}

function canyonColumn(x: number, y: number, h: RouteHit): CourseColumn {
  if (BOULDERS.some((b) => Math.hypot(x - b[0], y - b[1]) < 1.4)) {
    const [s0, s1] = ROUTE.span('canyon');
    // (7 over the floor, sheer: too steep to ride even wall riding (core/bike.ts wallClimb: 8 rise over run) — at 3
    // the wall-riding bike rode over them as bumps)
    return { top: G + CANYON_RISE * Math.sin(Math.PI * clamp((h.s - s0) / (s1 - s0), 0, 1)) + 7, skin: MAT.Stone };
  }
  const [s0, s1] = ROUTE.span('canyon');
  const u = clamp((h.s - s0) / (s1 - s0), 0, 1);
  // (up the switchbacks, down the straight run out: back to the land's height where the cliff begins)
  const floor = G + CANYON_RISE * Math.sin(Math.PI * u);
  const half = CANYON_HALF + (noise(x / 4, y / 4) - 0.5) * 1.2;
  if (h.d < half) return { top: floor + noise(x / 7, y / 7) * 0.5, skin: MAT.Sand };
  // (the plateau only round the switchbacks: past 14 cells it falls away to the land's height — the whole loop's
  // inside as plateau stood between the iso eye and the forest)
  if (h.d > 20) return { top: G + noise(x / 9, y / 9) * 0.8, skin: MAT.Soil, veg: 1.4 };
  const w = h.d - half;
  // (round 128b, the canyon run: a U for wall riding — 30° at the foot, steepening toward the rim (0.6 + 0.5 w rise
  // over run: 63° three cells out, 72° at six), the herolab canyon's tapered profile (PL43, TER20); the bike rides the
  // flank at speed, banked with it. Was sheer from the floor, a 4-cell step the bike crashed into)
  const top = Math.min(floor + CANYON_WALL, floor + 0.6 * w + 0.25 * w * w) + (noise(x / 8, y / 8) - 0.5) * 1.5 * ramp(2, 5, w);
  return { top: Math.max(G, top - Math.max(0, h.d - 14) * 3), skin: MAT.Sandstone };
}

function cliffColumn(x: number, y: number, h: RouteHit): CourseColumn {
  const ground = { top: G + noise(x / 9, y / 9) * 0.8, skin: MAT.Soil, veg: 1.6 };
  const inside = h.off * INSIDE;
  // (the face a few cells in from the road, wandering)
  const face = 6 + (noise(x / 7, y / 7) - 0.5) * 4;
  if (inside < face) return ground;
  const into = inside - face;
  const top = G + Math.min(38, into * 9) + (noise(x / 8, y / 8) - 0.5) * 3;
  // (the cave: a mouth in the face at CAVE, a tunnel narrowing into the massif, an arched roof over air)
  const along = (x - CAVE.at[0]) * CAVE.tan[0] + (y - CAVE.at[1]) * CAVE.tan[1];
  const w = CAVE.half * (1 - (0.5 * into) / CAVE.depth);
  if (into < CAVE.depth && Math.abs(along) < w) {
    const arch = CAVE.roof * Math.sqrt(Math.max(0, 1 - (along / w) ** 2));
    const floor = G + 0.2;
    if (arch > 2) return { top: floor, skin: MAT.Stone, over: [[floor + arch, Math.max(top, floor + arch + 3), MAT.Stone]] };
  }
  return { top, skin: MAT.Stone };
}

function riverColumn(x: number, y: number, h: RouteHit): CourseColumn {
  const inside = h.off * INSIDE;
  // (the river: across the road from the map's top edge into the lake; a ford where the road crosses it)
  const rw = 3.5 + (noise(x / 5, y / 5) - 0.5);
  const inRiver = Math.abs(x - RIVER_X - Math.sin(y / 9) * 3) < rw && inside < 8;
  if (inRiver) {
    const bed = h.d < 3 ? WATER - 0.35 : WATER - 1.8;
    return { top: bed, skin: MAT.Sand, water: WATER - bed, veg: 0 };
  }
  // (the lake: on the inside past a sandy shore)
  if (inside > 7) {
    const deep = ramp(7, 16, inside);
    const bed = G - 0.3 - deep * 3.5 + noise(x / 6, y / 6) * 0.4;
    if (bed < WATER) return { top: bed, skin: inside < 10 ? MAT.Sand : MAT.Sand, water: WATER - bed, veg: 0 };
    return { top: bed, skin: MAT.Sand, veg: 0 };
  }
  const shore = inside > 3;
  // (the road level, so it meets the ford's bed in a step the heroes take)
  return { top: G + noise(x / 9, y / 9) * 0.6 * ramp(2, 6, h.d), skin: shore ? MAT.Sand : MAT.Soil, veg: shore ? 0.4 : 1.6 };
}

function ruinsColumn(x: number, y: number, h: RouteHit): CourseColumn {
  const ground: CourseColumn = { top: G + noise(x / 8, y / 8) * 0.8, skin: MAT.Soil, veg: 1.8 };
  if (h.d < 4) return ground;
  // (broken walls on a 9-cell grid: a wall a lot, standing to a broken height; steel girders bridging some)
  const gx = Math.floor(x / 9);
  const gy = Math.floor(y / 9);
  const r = hash(gx * 3 + 1, gy * 5 + 7);
  const lx = x - gx * 9;
  const ly = y - gy * 9;
  const wallX = lx < 1.2 && r < 0.75;
  const wallY = ly < 1.2 && hash(gx, gy) < 0.6;
  if (wallX || wallY) {
    const along = wallX ? ly : lx;
    const broken = 2 + Math.floor(hash(Math.floor(x), Math.floor(y * 0.5)) * 2) + (r > 0.4 ? 6 * (0.5 + 0.5 * Math.sin(along * 0.7 + r * 9)) : 0);
    return { top: G + broken, skin: r < 0.5 ? MAT.Concrete : MAT.Brick };
  }
  // (rusted steel: posts and a beam over the gap between them)
  if (r > 0.82 && Math.abs(lx - 4.5) < 0.8 && Math.abs(ly - 4.5) < 3.5) {
    const post = Math.abs(ly - 4.5) > 2.6;
    if (post) return { top: G + 9, skin: MAT.Rust };
    return { ...ground, over: [[G + 7, G + 8.2, MAT.Steel]] };
  }
  return ground;
}

function townColumn(x: number, y: number, h: RouteHit): CourseColumn {
  const street = { top: G, skin: MAT.Asphalt };
  if (h.d < 3.5) return street;
  // (houses on 8-cell lots off the road, a cell of yard round each; side streets every third lot)
  const lot = 8;
  const gx = Math.floor(x / lot);
  const gy = Math.floor(y / lot);
  const lx = x - gx * lot;
  const ly = y - gy * lot;
  if (gy % 3 === 0 && ly < 3) return street;
  const r = hash(gx * 7 + 3, gy * 13 + 1);
  if (lx < 1.2 || ly < 1.2 || lx > lot - 1.2 || ly > lot - 1.2 || r < 0.15) return { top: G + 0.1, skin: MAT.Soil, veg: 1.4 };
  const hgt = 4 + Math.floor(r * 5);
  // (a roof ridge: a cell higher along the lot's middle)
  const ridge = Math.abs(ly - lot / 2) < 1.2 ? 1.5 : 0;
  return { top: G + hgt + ridge, skin: ridge ? MAT.Brick : r < 0.5 ? MAT.Plaster : MAT.Wood };
}

/** The column at world (x, y). */
export function courseColumn(x: number, y: number): CourseColumn {
  const h = ROUTE.nearest([x, y]);
  // (the river's channel runs from the map's top edge, nearest the road or not)
  switch (h.area) {
    case 'hills':
      return hillsColumn(x, y, h);
    case 'forest':
      return forestColumn(x, y, h);
    case 'canyon':
      return canyonColumn(x, y, h);
    case 'cliff':
      return cliffColumn(x, y, h);
    case 'river':
      return riverColumn(x, y, h);
    case 'ruins':
      return ruinsColumn(x, y, h);
    case 'town':
      return townColumn(x, y, h);
  }
}

/** the area a world point is in (its nearest stretch of road) */
export const areaAt = (x: number, y: number): AreaId => ROUTE.nearest([x, y]).area;

/** where to drop the hero for an area: a little into its stretch (or `share` of the way along it), on the road */
export function areaStart(area: AreaId, share = 0): { at: V2; s: number } {
  const [s0, s1] = ROUTE.span(area);
  const s = s0 + 6 + (s1 - s0 - 6) * share;
  return { at: ROUTE.pointAt(s).at, s };
}
