// world.plants (docs/WORLD_API.md; round 63): the plants, read from the CPU
// mirror (the succession field, `veg`), and the trees on it as the draw lays
// them out (vegplan.wgsl, ported: the same hash, the same thresholds). Fell
// a tree: its column cut back to grass, and the logs it makes.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import { cellAt, cellPos } from '../world/lattice';
import { sfZ } from '../world/layout';
import { ELDER_VEG, slotAt, slotRand, TREE_SCALE, treeSize } from '../flora/spacing';
import type { Mirror } from './mirror';
import type { Terrain } from './terrain';

import { OP, STROKE_START } from '../sim/edit-ops';

/** edit.wgsl ops (sim/edit-ops.ts) */
const { FELL: OP_FELL, PLANT: OP_PLANT } = OP;

export type TreeSpecies = 'broadleaf' | 'conifer' | 'birch' | 'giant' | 'willow';

export interface Tree {
  /** its trunk's column (cell) and its centre in world coordinates */
  cx: number;
  cy: number;
  x: number;
  y: number;
  species: TreeSpecies;
  /** trunk and crown heights (cells, as drawn) */
  trunk: number;
  crown: number;
  /** cells³ of logs it makes, felled */
  logs: number;
  /** (round 128) a burned wood's charred snag standing (snag.wgsl): no leaves, black — absent: alive */
  burned?: boolean;
}

// common.wgsl pcg / hash3 / rand3, on u32s
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
// (round 117, flora: the window's origin goes in, as common.wgsl hash3 adds G.org.zw — before, a streamed window's
// trees here were another window's)
let ORG: [number, number] = [0, 0];
function hash3(x: number, y: number, z: number): number {
  return pcg(((x + ORG[0]) ^ pcg(((y + ORG[1]) ^ pcg(z)) >>> 0)) >>> 0);
}
function rand3(x: number, y: number, z: number): number {
  return (hash3(x, y, z) >>> 8) / 16777216;
}
/** vegplan.wgsl floraCorner / birchWood (round 117): the birch woods, a stand-in biome field */
function floraCorner(x: number, y: number): number {
  return (pcg(((x >>> 0) ^ pcg(((y >>> 0) ^ 0x51a7b1) >>> 0)) >>> 0) >>> 8) / 16777216;
}
export function birchWood(cx: number, cy: number, org: [number, number] = ORG): number {
  const px = (cx + org[0]) / 72;
  const py = (cy + org[1]) / 72;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = floraCorner(ix, iy) + (floraCorner(ix + 1, iy) - floraCorner(ix, iy)) * ux;
  const b = floraCorner(ix, iy + 1) + (floraCorner(ix + 1, iy + 1) - floraCorner(ix, iy + 1)) * ux;
  const n = a + (b - a) * uy;
  const t = Math.min(1, Math.max(0, (n - 0.52) / (0.7 - 0.52)));
  return t * t * (3 - 2 * t);
}

/** (round 128) vegplan.wgsl floraCornerS / floraField / coniferStand / gladeAt, exactly */
function floraCornerS(x: number, y: number, salt: number): number {
  return (pcg(((x >>> 0) ^ pcg(((y >>> 0) ^ salt) >>> 0)) >>> 0) >>> 8) / 16777216;
}
function floraField(cx: number, cy: number, scale: number, salt: number, org: [number, number]): number {
  const px = Math.fround((cx + org[0]) / scale);
  const py = Math.fround((cy + org[1]) / scale);
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = floraCornerS(ix, iy, salt) + (floraCornerS(ix + 1, iy, salt) - floraCornerS(ix, iy, salt)) * ux;
  const b = floraCornerS(ix, iy + 1, salt) + (floraCornerS(ix + 1, iy + 1, salt) - floraCornerS(ix, iy + 1, salt)) * ux;
  return a + (b - a) * uy;
}
const smoothT = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export function coniferStand(cx: number, cy: number, org: [number, number] = ORG): number {
  return smoothT(0.3, 0.7, floraField(cx, cy, 60, 0x9c1f3, org));
}
export function gladeAt(cx: number, cy: number, org: [number, number] = ORG): number {
  return smoothT(0.7, 0.82, floraField(cx, cy, 46, 0x6a1d5, org));
}

/** (round 128) a window column's solid top (sfZ of its surface), as the plan reads it */
export type TopFn = (cx: number, cy: number) => number;
/** vegplan.wgsl GROUND_R */
const GROUND_R = 6;
/** (round 128) vegplan.wgsl groundAt: [the slope (the steepest rise to an axis neighbour), the rise over the four tops
 *  GROUND_R out], the offsets clamped to the w × h window */
export function groundOf(cx: number, cy: number, w: number, h: number, top: TopFn): [number, number] {
  const t = (x: number, y: number) => top(Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y)));
  const t0 = t(cx, cy);
  const s = Math.max(Math.abs(t(cx + 1, cy) - t0), Math.abs(t(cx - 1, cy) - t0), Math.abs(t(cx, cy + 1) - t0), Math.abs(t(cx, cy - 1) - t0));
  const m = (t(cx + GROUND_R, cy) + t(cx - GROUND_R, cy) + t(cx, cy + GROUND_R) + t(cx, cy - GROUND_R)) * 0.25;
  return [s, t0 - m];
}
/** vegplan.wgsl uplands */
export function uplands(g: [number, number]): number {
  return Math.max(smoothT(0.7, 1.6, g[0]), smoothT(2.0, 6.0, g[1]));
}

/**
 * (round 128) vegplan.wgsl treeSpecies: the species on a tree slot (the elder's, or a block's), or 'glade' — the
 * conifers in stands and on the slopes and high ground (`ground`: groundOf), glades in the canopy. `org` must be set
 * (planTree sets it).
 */
export function treeSpeciesAt(cx: number, cy: number, v: number, slot: 'tree' | 'elder', org: [number, number], ground: [number, number]): TreeSpecies | 'glade' {
  ORG = org;
  if (slot === 'elder' && v >= ELDER_VEG) return 'giant';
  if (rand3(cx, cy, 334) < gladeAt(cx, cy, org)) return 'glade';
  const hs = rand3(cx, cy, 321);
  const inBirch = rand3(cx, cy, 333) < birchWood(cx, cy, org) * 0.85;
  if (v > 4.7 && hs < 0.12 && !inBirch) return 'giant';
  // (the birch woods keep their birches on the flat; the slopes and the high ground go to the conifers anyway)
  const cs = inBirch ? 0 : coniferStand(cx, cy, org);
  if (rand3(cx, cy, 335) < (inBirch ? 0 : 0.08) + 0.85 * Math.max(cs, uplands(ground))) return 'conifer';
  if (inBirch || hs > 0.72) return 'birch';
  return 'broadleaf';
}

/** (round 128) is window column (cx, cy) a tree slot left empty by a glade? (vegPlan: a thicket's chance there) */
export function inGlade(cx: number, cy: number, v: number, w: number, h: number, org: [number, number]): boolean {
  const edge = cx < 2 || cy < 2 || cx + 3 >= w || cy + 3 >= h;
  const slot = slotAt(cx + org[0], cy + org[1]);
  if (!(v >= 3.6) || edge || slot === 'none') return false;
  // (the glade is decided before the ground is read)
  return treeSpeciesAt(cx, cy, v, slot, org, [0, 0]) === 'glade';
}

/** Logs a tree makes: its trunk's wood and some of its crown's limbs (cells³). */
function logsOf(trunk: number, crown: number): number {
  return Math.round((0.3 * trunk + 0.15 * crown) * 100) / 100;
}

/**
 * vegplan.wgsl vegPlan's tree at window column (cx, cy) with succession v, or null — the same hashes and thresholds
 * (round 117: a pure function, so a Dawn test checks it against the kernel: test/gpu/flora-plan.test.ts). `org`: the
 * window's world origin (Globals.origin), w × h its size.
 */
export function planTree(cx: number, cy: number, v: number, w: number, h: number, org: [number, number], top: TopFn): Tree | null {
  ORG = org;
  const edge = cx < 2 || cy < 2 || cx + 3 >= w || cy + 3 >= h;
  // (round 125, forest: a jittered grid of slots in world columns — flora/spacing.ts — not a hash under 0.045 a column)
  const slot = slotAt(cx + org[0], cy + org[1]);
  if (!(v >= 3.6) || edge || slot === 'none') return null;
  const hv = rand3(cx, cy, 7);
  const age = Math.min(Math.max(v - 3.6, 0), 1.4);
  let trunk: number;
  let crown: number;
  // (round 128: the species from treeSpeciesAt — conifer stands, glades)
  const pick = treeSpeciesAt(cx, cy, v, slot, org, groundOf(cx, cy, w, h, top));
  if (pick === 'glade') return null;
  const species: TreeSpecies = pick;
  // (round 125, forest: bigger trees, as drawn — the flora library's heights: birch 17-25, broadleaf 9-15, conifer
  // 12-20, the elder 24-32; trunk the bare stem to the crown, crown the rest)
  if (species === 'giant' && slot === 'elder' && v >= ELDER_VEG) {
    trunk = 10 + Math.floor(hv * 4);
    crown = 14 + Math.floor(hv * 4);
  } else if (species === 'giant') {
    trunk = 9 + Math.floor(hv * 4);
    crown = 12 + Math.floor(hv * 4);
  } else if (species === 'conifer') {
    trunk = 2 + Math.floor(hv * 2);
    crown = 9 + Math.floor(age * 3) + Math.floor(hv * 4);
  } else if (species === 'birch') {
    trunk = 12 + Math.floor(age * 3) + Math.floor(hv * 3);
    crown = 7;
  } else {
    trunk = 4 + Math.floor(age * 3) + Math.floor(hv * 3);
    crown = 5 + Math.floor(hv * 2.99) + (v > 4.5 ? 1 : 0);
  }
  const [x, y] = cellPos(cx, cy);
  // (round 128, treegen: every tree TREE_SCALE × round 125's heights and a TREE_SCALE² share of the land — its logs ×
  // TREE_SCALE², so a wood holds the wood it held)
  // (and its own size: spacing.ts treeSize, as vegplan.wgsl — its logs by its volume's share, size³)
  const sz = treeSize(cx + org[0], cy + org[1]);
  return { cx, cy, x, y, species, trunk: trunk * TREE_SCALE * sz, crown: crown * TREE_SCALE * sz, logs: logsOf(trunk, crown) * TREE_SCALE * TREE_SCALE * sz * sz * sz };
}

/**
 * (round 128) florafield.wgsl willowAt, on the CPU: a willow on a bank at window column (cx, cy) — the candidate column
 * of its 9 × 10 block of world columns, dry and moist, open water within ~3-7 cells (`water`, `moisture` the mirror's,
 * window order through `idx`). The GPU's also asks the ground's material and the sea's level; this doesn't (a willow
 * there is rare: the understory's and passability's count may differ by one at a sea cliff's foot).
 */
export function planWillow(cx: number, cy: number, w: number, h: number, org: [number, number], water: Float32Array, moisture: Float32Array, idx: (x: number, y: number) => number): Tree | null {
  if (cx < 2 || cy < 2 || cx + 2 >= w || cy + 2 >= h) return null;
  const i = idx(cx, cy);
  if (water[i] > 0.02 || moisture[i] < 0.5) return null;
  const wx = cx + org[0];
  const wy = cy + org[1];
  const bx = Math.floor(wx / 9);
  const by = Math.floor(wy / 10);
  if (wx !== bx * 9 + 1 + Math.floor(slotRand(bx, by, 0x3111) * 7) || wy !== by * 10 + 1 + Math.floor(slotRand(bx, by, 0x3112) * 8)) return null;
  let near = 0;
  for (let k = 0; k < 8; k++) {
    const a = k * 0.785398;
    for (let r = 3; r <= 7; r += 2) {
      const x = cx + Math.round(Math.cos(a) * r);
      const y = cy + Math.round(Math.sin(a) * r);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      near = Math.max(near, water[idx(x, y)]);
    }
  }
  if (near < 0.35) return null;
  const sz = 0.7 + 0.45 * slotRand(wx, wy, 0x3113);
  const [x, y] = cellPos(cx, cy);
  // (the willow's mesh is ~26 cells tall at size 1: a short trunk under its arching crown)
  return { cx, cy, x, y, species: 'willow', trunk: 26 * sz * 0.3, crown: 26 * sz * 0.7, logs: logsOf(26 * sz * 0.3, 26 * sz * 0.7) };
}

export class Plants {
  constructor(
    private core: WorldCore,
    private mirror: Mirror,
    private terrain: Terrain,
  ) {
    mirror.addBuffer('veg', core.world.veg);
    // (round 128: the willows by the water — planWillow reads the water and the moisture)
    mirror.addBuffer('moisture', core.world.moisture);
    mirror.addBuffer('water', core.world.water);
    // (round 128: the fire's standing burned trees — a snag keeps its tree standing, charred)
    mirror.addTexture('snag', core.world.snag);
    // (round 128: the ground's shape — the plan's conifers on the slopes and the high ground, vegplan.wgsl groundAt)
    mirror.addBuffer('surface', core.world.surface);
  }

  /** (round 128) window column (cx, cy)'s solid top (sfZ of its surface, as the mirror last read it; 0 before) */
  topCol(cx: number, cy: number): number {
    const s = this.mirror.u32('surface');
    if (!s) return 0;
    return sfZ(s[this.core.ring.idx(cx, cy)]);
  }

  /** (round 128) the snag at window column (cx, cy): > 0 a burned wood's tree stands there charred */
  private snagAt(cx: number, cy: number): number {
    const t = this.mirror.f32('snag');
    if (!t) return 0;
    return t[this.core.ring.t(cx, cy) * 4] ?? 0;
  }

  /** (round 128) the willow at window column (cx, cy), or null (as of the mirror's last read) */
  private willowAt(cx: number, cy: number): Tree | null {
    const wa = this.mirror.f32('water');
    const mo = this.mirror.f32('moisture');
    if (!wa || !mo) return null;
    return planWillow(cx, cy, this.core.dims.w, this.core.dims.h, this.core.globals.origin ?? [0, 0], wa, mo, (x, y) => this.core.ring.idx(x, y));
  }

  /** The succession field at (x, y): 0 bare … ~1.2 grass, 2.6 shrubs, 3.6+ woods (null before the first read). */
  vegAt(x: number, y: number): number | null {
    const v = this.mirror.f32('veg');
    const [cx, cy] = cellAt(x, y);
    const { w, h } = this.core.dims;
    if (!v || cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    return v[this.core.ring.idx(cx, cy)];
  }

  /** (round 117, flora) the succession field at window column (cx, cy), null before the first read or off the window */
  vegCol(cx: number, cy: number): number | null {
    const v = this.mirror.f32('veg');
    const { w, h } = this.core.dims;
    if (!v || cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    return v[this.core.ring.idx(cx, cy)];
  }

  /** vegplan.wgsl's tree at column (cx, cy) with veg v, or null. */
  private planAt(cx: number, cy: number, v: number): Tree | null {
    const burned = this.snagAt(cx, cy) > 0;
    const t = planTree(cx, cy, burned ? Math.max(v, 3.6) : v, this.core.dims.w, this.core.dims.h, this.core.globals.origin ?? [0, 0], (x, y) => this.topCol(x, y));
    // (a charred snag makes no logs worth the felling: a third)
    return t && burned ? { ...t, burned: true, logs: t.logs / 3 } : t;
  }

  /** The tree standing at (x, y)'s column, or null. */
  treeAt(x: number, y: number): Tree | null {
    const v = this.vegAt(x, y);
    if (v === null) return null;
    const [cx, cy] = cellAt(x, y);
    return this.planAt(cx, cy, v);
  }

  /** The trees within `radius` of (x, y), nearest first (as of the mirror's last read). */
  treesNear(x: number, y: number, radius: number): Tree[] {
    const v = this.mirror.f32('veg');
    if (!v) return [];
    const { w, h } = this.core.dims;
    const [c0x, c0y] = cellAt(x, y);
    const r = Math.ceil(radius * 1.2) + 1;
    const out: (Tree & { d: number })[] = [];
    for (let cy = Math.max(0, c0y - r); cy <= Math.min(h - 1, c0y + r); cy++) {
      for (let cx = Math.max(0, c0x - r); cx <= Math.min(w - 1, c0x + r); cx++) {
        const t = this.planAt(cx, cy, v[this.core.ring.idx(cx, cy)]) ?? this.willowAt(cx, cy);
        if (!t) continue;
        const d = Math.hypot(t.x - x, t.y - y);
        if (d <= radius) out.push({ ...t, d });
      }
    }
    return out.sort((a, b) => a.d - b.d).map(({ d: _d, ...t }) => t);
  }

  /**
   * Grow the plants within `radius` of (x, y) on (edit.wgsl OP_PLANT, the
   * sandbox's brush): the succession field rises by up to `strength` × 0.08
   * at the middle, less toward the rim (at most 4.6: old woods). 60 makes a
   * wood in one go; trees stand where the layout puts them (one column in
   * about 22) once it passes 3.6.
   */
  grow(x: number, y: number, opts: { radius?: number; strength?: number } = {}): void {
    this.core.globals.events.push({ kind: EventKind.Edit, x, y, z: OP_PLANT * 32 + STROKE_START, radius: opts.radius ?? 4, strength: opts.strength ?? 60 });
  }

  /**
   * Fell the tree at (x, y)'s column: the column is cut back to grass (it
   * regrows by succession). Resolves with the tree as it stood (its `logs`
   * what it makes), or null when no tree stood there by then.
   */
  async fell(x: number, y: number): Promise<Tree | null> {
    const [cx, cy] = cellAt(x, y);
    const [had] = await this.terrain.exactOp(OP_FELL, 0, x, y, 0);
    return this.planAt(cx, cy, had);
  }
}
