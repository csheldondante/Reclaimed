// Fortress mode's contract (round 128c, docs/design/FORTRESS_MODE.md, FORTRESS_SLICE1.md). The building rule (the
// user's): select WHAT — a structure type — then plan its shape with Townscaper-like stacking tiles. A structure is
// the cells painted with one type that touch: painting next to the same type adds to it. Its size sets its cost and
// its capacity: blocks × the type's per-block numbers.
//
// Milestone 1 (this file's first users): the plan, its cost and capacity against the stores, the per-type look (the
// Town's style hook) and the wall tiles that fit together. Workers, jobs, recipes, the clock and the army come in
// milestones 2-5 (the slice plan's StructureDef already names their numbers so the plan can show them).

/**
 * The first buildings (the user's list, round 128c) and the fortress itself (round 128d: the player's keep, whose size
 * and height give power — "building your fortress should add to your magic power so that players are incentivised to
 * build ever bigger and elaborate fortresses").
 */
export type StructureType = 'fortress' | 'house' | 'farm' | 'lumber' | 'quarry' | 'warehouse' | 'wall' | 'blacksmith' | 'barracks';

export const STRUCTURE_TYPES: readonly StructureType[] = ['fortress', 'house', 'farm', 'lumber', 'quarry', 'warehouse', 'wall', 'blacksmith', 'barracks'];

/** A good in the stores (settlement stores' keys: 'log' is wood). */
/** (milestone 3) ore: a share of what the quarry brings in (the user's answer 4; deposits later) */
export type Good = 'log' | 'stone' | 'ore' | 'grain' | 'weapons' | 'soldiers' | 'power';

export type Goods = Partial<Record<Good, number>>;

/**
 * How a type's cells stand:
 *  - block: the Town's rooms (walls, windows, a door, a roof), stacking;
 *  - wall: wall tiles that join their neighbours (runs, corners, ends, towers, gates), crenellated on top, stacking;
 *  - yard: on the ground, no block (fields, the quarry's floor); one level;
 *  - keep: the fortress's solid stone blocks, crenellated on top, a tower at each outer corner; walls run into it.
 * (Blocks are the Town's (build/town.ts): a cell and a level each, its floor lined up with its neighbours'; a cell's
 * levels are runs, any height, gaps allowed where a block is held — FortressPlan.held.)
 */
export type StructureForm = 'block' | 'wall' | 'yard' | 'keep';

/** What one block of a type gives (a structure gives blocks × these). */
export interface PerBlock {
  /** people it houses */
  beds?: number;
  /** goods it holds */
  storage?: number;
  /** people it employs */
  jobs?: number;
  /** archers that can stand on it */
  posts?: number;
  /**
   * power a day a built block gives (the fortress: round 128d); a block at level L gives power × (1 + POWER_RISE × L):
   * higher is worth more
   */
  power?: number;
  /** what it makes a day, once worked (milestones 3-4) */
  makes?: Goods;
}

/**
 * The look of a type's cells: drawn with the structures module library (the towns' pieces, structures/pieces.ts) —
 * the fortress plan made into a CityPlan per style (fortress/pieces.ts). Data, per type: tech-dependent block sets
 * (the user, round 128c: later) swap these per structure.
 *  - style: the towns' style (walls, roofs, palette): hearth (plaster, tile), bastion (stone, slate), terrace;
 *  - kind: a block's building kind (its walls' set: house, warehouse's dressed stone, sawmill's planks, hut's);
 *  - props: things set down on it (log piles, a crane, spoil, crates, banners, haystacks);
 *  - chimney: a chimney on each top block.
 */
export interface StructureLook {
  style: 'hearth' | 'bastion' | 'terrace';
  kind?: 'house' | 'hut' | 'farmhouse' | 'barn' | 'warehouse' | 'sawmill' | 'granary' | 'stable';
  props?: ('logpile' | 'crates' | 'crane' | 'spoil' | 'banner' | 'haystack' | 'cart' | 'wagon')[];
  chimney?: boolean;
}

export interface StructureDef {
  type: StructureType;
  /** the picker's label (plain, plural where it reads better) */
  label: string;
  /** one of it, for sentences ("a house") */
  one: string;
  /** more than one ("houses") */
  many: string;
  form: StructureForm;
  /**
   * Whether its cells join their neighbours of the same structure (open to each other, one roof; walls: one run).
   * false: each cell stands as its own unit side by side (medieval row homes). The user, round 128c.
   */
  joins: boolean;
  /** levels a cell may stack to (yards: 1; Infinity: no cap — round 128d) */
  maxLevels: number;
  cost: Goods;
  perBlock: PerBlock;
  look: StructureLook;
}

/** A structure: the cells of one type that touch, each with its levels. */
export interface Structure {
  id: number;
  type: StructureType;
  /**
   * cell → its levels as runs [lo, hi), bottom up (round 128d: no level cap; a gap is two runs — build/runs.ts, the
   * plan's own runs, read only)
   */
  cells: Map<number, readonly LevelRun[]>;
}

/** Levels lo .. hi - 1 of a cell (build/runs.ts Run). */
export interface LevelRun {
  readonly lo: number;
  readonly hi: number;
}

/** What the plan reads of the grid: cells with four neighbours each (build/towngrid.ts CellGrid). */
export interface PlanGrid {
  readonly count: number;
  /** per cell its neighbour across edge e (0..3), -1 none */
  readonly nbr: Int32Array;
}

/** The wall tile a wall cell is at a level, from which of its four sides join another wall there. */
export type WallTile = 'post' | 'end' | 'straight' | 'corner' | 'tee' | 'cross';

/** A plan's totals against the stores: what it costs, what it gives, what's short. */
export interface PlanTotals {
  blocks: number;
  cost: Goods;
  gives: PerBlock;
  /** cost − stores, where positive */
  short: Goods;
}

/**
 * The fortress's plan: what the player painted. Pure (no GPU, no DOM): the view (src/fortress/fortress.ts) turns it
 * into Town blocks, the UI reads its numbers.
 */
export interface FortressPlanApi {
  /** paint level L of a cell with a type; false if it can't be (another type there, too high, a yard stacked) */
  paint(cell: number, level: number, type: StructureType): boolean;
  /** take level L of a cell away; false if nothing's there */
  erase(cell: number, level: number): boolean;
  /** a wall cell's gate on or off (a straight run's ground level only); false if it can't be */
  setGate(cell: number, on: boolean): boolean;
  typeAt(cell: number): StructureType | null;
  structureAt(cell: number): Structure | null;
  structures(): Structure[];
  blocks(s: Structure): number;
  cost(s: Structure): Goods;
  gives(s: Structure): PerBlock;
  totals(stores: Goods): PlanTotals;
  /** power a day these blocks give (all of the structure's, or those `only` lets through: the built ones) */
  power(s: Structure, only?: (cell: number, level: number) => boolean): number;
  wallTile(cell: number, level: number): WallTile | null;
}

/**
 * The fortress Town's own world-anchored box (TownIO's origin): its columns are box-local; a window slide only
 * changes the offset from the box to the window. Its row origin is even, so the hex lattice's odd-row shift is the
 * same in the box as in the window.
 */
export interface FortressBox {
  /** world cell of the box's (0, 0) column (x, row) */
  origin: [number, number];
  w: number;
  h: number;
}
