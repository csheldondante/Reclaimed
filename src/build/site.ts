// A town as one thing (round 128m, onetown): its grid, its plan and what stands of it. The user: "Why is the fortress
// not just another building type?", "It should just be intervals on the map that indicate another grid owns it",
// "Consolidate them". Every town — the generated ones and the player's — is a TownSite: the generator places its
// buildings into the plan (structures/place.ts placeDraft), the player edits the same plan (fortress/fortress.ts), the
// view draws it (view.ts), the claims put it in the world's columns under its grid's id (`gridId`).
//
// Frame: the site's box — its column (0, 0) at world column (x0, row y0), y0 even (the hex lattice's odd-row shift is
// the same in the box and the world) — and everything in it box-local (world units: column (k, r) at cellPos(k, r));
// heights world z.
import type { StructureStyleId } from '../api/contracts/structures';
import { cellAt, cellPos } from '../world/lattice';
import { TownGrid } from './towngrid';
import { QuadGrid } from './quadgrid';
import { TownPlan, type PlanData } from './plan';
import { Town, type TownData } from './town';
import { DEFS } from './types';

/** A box of columns in the world: column (0, 0) at world column x0, row y0 (even). */
export interface SiteBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/**
 * A grid's stable id (the owner word of its claimed intervals, a save's key): FNV-1a 32 of "town:" + the settlement's
 * id. Never under 256: the small ids are the other owners' (sim/external.ts: the resting rock's), 0 none.
 */
export function gridIdOf(townId: string): number {
  let h = 0x811c9dc5;
  const s = `town:${townId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h < 256 ? h + 256 : h;
}

/** A site as data (toData): a worker's post back (a structured clone keeps no class), a test's byte-for-byte compare. */
export interface SiteData {
  id: string;
  seed: number;
  box: SiteBox;
  verts: Float32Array;
  quads: Int32Array;
  ground: Float32Array;
  plan: PlanData;
  town: TownData;
  order: number[];
  placed: [string, number][];
}

export class TownSite {
  readonly plan: TownPlan;
  readonly town: Town;
  readonly gridId: number;
  /** (the generator's) its buildings' structures in the order the town grew: the old core first */
  order: number[] = [];
  /** (the generator's) structures the world placed in it (merge124: a card's outcome): placed id → structure */
  placed = new Map<string, number>();

  /**
   * `groundCols`: the ground's top per box column (world z: the land as it was before the town — what a new cell's
   * floor stands on, Town.groundFloor)
   */
  constructor(
    readonly id: string,
    readonly seed: number,
    readonly box: SiteBox,
    readonly grid: QuadGrid,
    style: StructureStyleId,
    readonly groundCols: Float32Array,
    data?: { plan: PlanData; town: TownData },
  ) {
    if (box.y0 & 1) throw new Error(`town ${id}: its box's row origin must be even (the lattice's odd-row shift)`);
    if (grid.w !== box.w || grid.h !== box.h) throw new Error(`town ${id}: its grid (${grid.w} x ${grid.h}) isn't its box (${box.w} x ${box.h})`);
    if (groundCols.length !== box.w * box.h) throw new Error(`town ${id}: ground for ${groundCols.length} columns, its box has ${box.w * box.h}`);
    this.gridId = gridIdOf(id);
    this.plan = new TownPlan(grid, DEFS, data?.plan.style ?? style, data?.plan);
    // (drawn as pieces, not column matter: nothing is stamped, so the window's z ceiling doesn't bound it — round 128d)
    this.town = new Town(box.w, box.h, { ground: (col) => this.groundCols[col], stamp: null, zMax: Infinity }, { grid });
    if (data) this.town.setData(data.town);
  }

  /** the ground's top at a box column (world z) */
  ground(col: number): number {
    return this.groundCols[col];
  }

  /** the ground's top at a box-local point (its column's; clamped into the box) */
  groundAt(x: number, y: number): number {
    const { w, h } = this.box;
    const [k, r] = cellAt(x, y);
    return this.groundCols[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, k))];
  }

  /**
   * (onetown) A site with nothing on it: Townscaper's grid (towngrid.ts) over a box, its ground a function of world
   * (x, y) — a lab recipe's town, a test's.
   */
  static plain(id: string, box: SiteBox, ground: (x: number, y: number) => number, seed = 7, style: StructureStyleId = 'hearth'): TownSite {
    const { w, h } = box;
    const cols = new Float32Array(w * h);
    for (let i = 0; i < cols.length; i++) cols[i] = ground(...cellPos((i % w) + box.x0, Math.floor(i / w) + box.y0));
    return new TownSite(id, seed, box, new TownGrid(w, h, { seed }), style, cols);
  }

  toData(): SiteData {
    return {
      id: this.id,
      seed: this.seed,
      box: { ...this.box },
      verts: this.grid.verts.slice(),
      quads: this.grid.quads.slice(),
      ground: this.groundCols.slice(),
      plan: this.plan.toData(),
      town: this.town.toData(),
      order: this.order.slice(),
      placed: [...this.placed],
    };
  }

  static fromData(d: SiteData): TownSite {
    const grid = new QuadGrid(d.box.w, d.box.h, d.verts, d.quads);
    const s = new TownSite(d.id, d.seed, d.box, grid, d.plan.style, Float32Array.from(d.ground), { plan: d.plan, town: d.town });
    s.order = d.order.slice();
    s.placed = new Map(d.placed);
    return s;
  }
}

/** (onetown) a site's data as JSON can carry it (a lab fixture's header: lab/townfixture.ts): typed arrays as arrays */
export function siteToJson(d: SiteData): unknown {
  const arr = (a: ArrayLike<number>) => Array.from(a);
  return {
    ...d,
    verts: arr(d.verts),
    quads: arr(d.quads),
    ground: arr(d.ground),
    plan: { ...d.plan, owner: arr(d.plan.owner), levels: arr(d.plan.levels), gate: arr(d.plan.gate), tower: arr(d.plan.tower), passage: arr(d.plan.passage), ramp: arr(d.plan.ramp), pit: arr(d.plan.pit), block: arr(d.plan.block), pits: d.plan.pits.map(([id, p]) => [id, { ...p, ring: [...p.ring] }]) },
    // (a cell with no blocks has no floor: NaN, which JSON can't carry — null)
    town: { built: arr(d.town.built), plans: arr(d.town.plans), base: Array.from(d.town.base, (v) => (Number.isNaN(v) ? null : v)) },
  };
}

/** (onetown) siteToJson's back */
export function siteFromJson(j: unknown): SiteData {
  const o = j as SiteData & { plan: PlanData & { pits: [number, { ring: [number, number][] }][] } };
  return {
    ...o,
    verts: Float32Array.from(o.verts),
    quads: Int32Array.from(o.quads),
    ground: Float32Array.from(o.ground),
    plan: {
      ...o.plan,
      owner: Int32Array.from(o.plan.owner),
      levels: Int32Array.from(o.plan.levels),
      gate: Uint8Array.from(o.plan.gate),
      tower: Uint8Array.from(o.plan.tower),
      passage: Uint8Array.from(o.plan.passage),
      ramp: Int8Array.from(o.plan.ramp),
      pit: Int32Array.from(o.plan.pit),
      block: Int32Array.from(o.plan.block),
      pits: o.plan.pits.map(([id, p]) => [id, { ...(p as unknown as PlanData['pits'][number][1]), ring: new Map(p.ring) }]),
    },
    town: { built: Int32Array.from(o.town.built), plans: Int32Array.from(o.town.plans), base: Float32Array.from(o.town.base as unknown as (number | null)[], (v) => (v === null ? NaN : v)) },
  };
}
