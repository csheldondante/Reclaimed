// world.plants (docs/WORLD_API.md; round 63): the plants, read from the CPU
// mirror (the succession field, `veg`), and the trees on it as the draw lays
// them out (vegplan.wgsl, ported: the same hash, the same thresholds). Fell
// a tree: its column cut back to grass, and the logs it makes.

import type { WorldCore } from '../scenes/world-core';
import { EventKind } from '../sim/globals';
import { cellAt, cellPos } from '../world/lattice';
import type { Mirror } from './mirror';
import type { Terrain } from './terrain';

import { OP, STROKE_START } from '../sim/edit-ops';

/** edit.wgsl ops (sim/edit-ops.ts) */
const { FELL: OP_FELL, PLANT: OP_PLANT } = OP;

export type TreeSpecies = 'broadleaf' | 'conifer' | 'birch' | 'giant';

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
}

// common.wgsl pcg / hash3 / rand3, on u32s
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
function hash3(x: number, y: number, z: number): number {
  return pcg((x ^ pcg((y ^ pcg(z)) >>> 0)) >>> 0);
}
function rand3(x: number, y: number, z: number): number {
  return (hash3(x, y, z) >>> 8) / 16777216;
}

/** Logs a tree makes: its trunk's wood and some of its crown's limbs (cells³). */
function logsOf(trunk: number, crown: number): number {
  return Math.round((0.3 * trunk + 0.15 * crown) * 100) / 100;
}

export class Plants {
  constructor(
    private core: WorldCore,
    private mirror: Mirror,
    private terrain: Terrain,
  ) {
    mirror.addBuffer('veg', core.world.veg);
  }

  /** The succession field at (x, y): 0 bare … ~1.2 grass, 2.6 shrubs, 3.6+ woods (null before the first read). */
  vegAt(x: number, y: number): number | null {
    const v = this.mirror.f32('veg');
    const [cx, cy] = cellAt(x, y);
    const { w, h } = this.core.dims;
    if (!v || cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    return v[cy * w + cx];
  }

  /** vegplan.wgsl's tree at column (cx, cy) with veg v, or null. */
  private planAt(cx: number, cy: number, v: number): Tree | null {
    const { w, h } = this.core.dims;
    const edge = cx < 2 || cy < 2 || cx + 3 >= w || cy + 3 >= h;
    if (!(v >= 3.6) || edge || rand3(cx, cy, 4242) >= 0.045) return null;
    const hs = rand3(cx, cy, 321);
    const hv = rand3(cx, cy, 7);
    const age = Math.min(Math.max(v - 3.6, 0), 1.4);
    let species: TreeSpecies;
    let trunk: number;
    let crown: number;
    if (v > 4.7 && hs < 0.12) {
      species = 'giant';
      trunk = 5 + Math.floor(hv * 4);
      crown = 3 + Math.floor(hv * 2);
    } else if (hs < 0.42) {
      species = 'conifer';
      trunk = 1 + Math.floor(hv * 2);
      crown = 4 + Math.floor(age * 2) + Math.floor(hv * 3);
    } else if (hs < 0.58) {
      species = 'birch';
      trunk = 3 + Math.floor(age * 2) + Math.floor(hv * 2);
      crown = 2;
    } else {
      species = 'broadleaf';
      trunk = 2 + Math.floor(age * 2.5) + Math.floor(hv * 3);
      crown = 2 + Math.floor(hv * 1.99) + (v > 4.5 ? 1 : 0);
    }
    const [x, y] = cellPos(cx, cy);
    return { cx, cy, x, y, species, trunk, crown, logs: logsOf(trunk, crown) };
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
        const t = this.planAt(cx, cy, v[cy * w + cx]);
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
