// A town's plan (round 128m, onetown; was the fortress's, fortress slice 1, milestone 1): every structure of the town,
// cell by cell, each cell owned by a structure of a type (build/types.ts) with its levels as runs. One plan a town: the
// town generator fills it from the seed and the player edits the same plan (the user: "Generation needs to use the same
// system as the built town" — "It can do things to add plazas and roads but it should not be a different system").
//  - The player selects what (a type), then paints it: a cell painted next to a structure of the same type joins it
//    (two joined by one cell become one).
//  - The generator places each of its buildings as a structure of its own (`place`): two houses
//    side by side stay two houses.
//  - Its layout passes (streets, plazas, yards, the quay; roads out, piers, fences; props and moored ships) write the
//    plan's layout layer: `use` per cell and `layout`.
// Pure: no GPU, no DOM — the Town (town.ts) keeps what stands of it, the view (view.ts) draws it.
import type { Berth, LinearFeature, Prop, StructureStyleId, TileUse } from '../api/contracts/structures';
import { STRUCTURE_TYPES, type TownPlanApi, type Goods, type PerBlock, type PlanGrid, type PlanTotals, type Structure, type StructureDef, type StructureType, type WallTile } from '../api/contracts/fortress';
import { CellRuns } from '../build/runs';
import { DEFS, POWER_RISE } from './types';
import { layPit, pitOf, PIT_RAMP_CELLS, type Pit } from './pit';

/** a type's index in a run (build/runs.ts Run.type) */
export const typeIndex = (t: StructureType): number => STRUCTURE_TYPES.indexOf(t);

/** The wall tile from which of a cell's four sides join (sides 0..3 in order round the cell; e and e+2 face). */
export function wallTileOf(joins: readonly boolean[]): WallTile {
  const n = joins.filter(Boolean).length;
  if (n === 0) return 'post';
  if (n === 1) return 'end';
  if (n === 3) return 'tee';
  if (n === 4) return 'cross';
  return (joins[0] && joins[2]) || (joins[1] && joins[3]) ? 'straight' : 'corner';
}

/** Whether a wall tile stands a tower (where the run doesn't simply carry on: ends, corners, junctions, a lone post). */
export function towered(tile: WallTile): boolean {
  return tile !== 'straight';
}

function addGoods(into: Goods, g: Goods, k: number): void {
  for (const [key, v] of Object.entries(g) as [keyof Goods, number][]) into[key] = (into[key] ?? 0) + v * k;
}

function addPer(into: PerBlock, p: PerBlock, k: number): void {
  for (const key of ['beds', 'storage', 'jobs', 'posts'] as const) if (p[key]) into[key] = (into[key] ?? 0) + p[key]! * k;
  if (p.makes) addGoods((into.makes ??= {}), p.makes, k);
}

/** (onetown) what a structure is given when the generator places it (Structure's look, floor, district, wear) */
export type StructureAttrs = Partial<Pick<Structure, 'look' | 'floor' | 'district' | 'wear'>>;

/**
 * (onetown) The plan's layout layer: what the generator's layout passes lay down besides the structures — the town's
 * linear features (roads out and their bridges, piers, rails, fences and hedges), its props (log piles, stalls, wagons)
 * and the ships moored in its harbour. Derived from the seed, never edited by the player (nothing of it is saved).
 */
export interface TownLayout {
  linear: LinearFeature[];
  props: Prop[];
  berths: Berth[];
  /** the purpose's work site (a mine's mouth, a sawmill's bank): null none found */
  works: { at: [number, number]; dir: [number, number] } | null;
}

/**
 * (onetown) A plan as numbers and plain data (`TownPlan.toData`): what a worker posts back (a structured clone keeps no
 * class) and what a test compares byte for byte. Runs as CellRuns.encode's.
 */
export interface PlanData {
  style: StructureStyleId;
  nextId: number;
  structures: Omit<Structure, 'cells'>[];
  owner: Int32Array;
  levels: Int32Array;
  gate: Uint8Array;
  tower: Uint8Array;
  passage: Uint8Array;
  ramp: Int8Array;
  pit: Int32Array;
  pits: [number, Pit][];
  use: TileUse[];
  block: Int32Array;
  layout: TownLayout;
}

export class TownPlan implements TownPlanApi {
  /**
   * (onetown) per cell its tile's use from the layout (a street, the plaza, a yard, the quay, outside the town; 'lot'
   * where the generator may build): what a cell no structure holds is drawn as
   */
  readonly use: TileUse[];
  /** (onetown) per cell its block (a plot: the generator's buildings never cross one; -1 none) */
  readonly block: Int32Array;
  /** (onetown) the layout's features */
  readonly layout: TownLayout = { linear: [], props: [], berths: [], works: null };
  /** per cell its structure's id (-1 none) */
  readonly owner: Int32Array;
  /**
   * per cell its levels: runs [lo, hi) owned by the cell's structure, with its type (round 128d: no level cap; gaps
   * allowed — a block over an empty level is held by the block under it or one beside it at its level: `held`)
   */
  readonly levels: CellRuns;
  /** per cell a gate (wall cells' ground level) */
  readonly gate: Uint8Array;
  /** (round 128d) per cell a tower the player put on a wall cell (towers stand by rule where runs end or turn) */
  readonly tower: Uint8Array;
  /**
   * (round 128h, V128-13) per cell a passage through a block's ground floor: an arch each side, open under a lintel — a
   * block placed across the only way to others gets one (Fortress.paint)
   */
  readonly passage: Uint8Array;
  /**
   * (round 128h, V128-13) per free cell a ramp up a drop the agents can walk down but not up: the side (0..3) its high
   * end meets, -1 none — earthworks, solid at once (solid.ts rampSpans), drawn as the wall stairs' steps
   */
  readonly ramp: Int8Array;
  /**
   * (round 128m, quarry; V128-11) per cell the quarries' pits as negative levels (pit.ts: -1 the first tier down; a
   * ramp cell one level more, its run's type PIT_RAMP), owned by the quarry's id — laid again whenever a quarry's
   * footprint changes. Apart from `levels` so nothing that reads the blocks meets them.
   */
  readonly pit: CellRuns;
  /** (round 128m) where a pit's ramp should start: lower first (Fortress: the ring-0 cells nearest the stores) */
  pitPrefer: ((cell: number) => number) | null = null;
  private pits = new Map<number, Pit>();
  private byId = new Map<number, Structure>();
  private nextId = 1;
  /** the cells whose look may have changed since the last `takeChanged` (painted, erased, their neighbours) */
  private changed = new Set<number>();

  /**
   * `style`: the town's own look (its civ's: the types whose look is 'town' are drawn in it); `use`: the cells' layout
   * uses (default: all 'outside')
   */
  constructor(readonly grid: PlanGrid, readonly defs: Record<StructureType, StructureDef> = DEFS, readonly style: StructureStyleId = 'hearth', data?: PlanData) {
    const n = grid.count;
    if (data) {
      // (onetown) a plan made again from its data (toData): a worker's, a test's
      if (data.owner.length !== n) throw new Error(`plan: data for ${data.owner.length} cells, the grid has ${n}`);
      this.use = data.use.slice();
      this.block = Int32Array.from(data.block);
      this.owner = Int32Array.from(data.owner);
      this.levels = CellRuns.decode(n, data.levels);
      this.gate = Uint8Array.from(data.gate);
      this.tower = Uint8Array.from(data.tower);
      this.passage = Uint8Array.from(data.passage);
      this.ramp = Int8Array.from(data.ramp);
      this.pit = CellRuns.decode(n, data.pit);
      this.pits = new Map(data.pits);
      this.nextId = data.nextId;
      this.layout = data.layout;
      for (const st of data.structures) this.byId.set(st.id, { ...st, cells: new Map() });
      for (let c = 0; c < n; c++) {
        const o = this.owner[c];
        if (o < 0) continue;
        const st = this.byId.get(o);
        if (!st) throw new Error(`plan: cell ${c}'s owner ${o} isn't in the data`);
        st.cells.set(c, this.levels.runsOf(c));
      }
      return;
    }
    this.use = new Array<TileUse>(n).fill('outside');
    this.block = new Int32Array(n).fill(-1);
    this.owner = new Int32Array(n).fill(-1);
    this.levels = new CellRuns(n);
    this.gate = new Uint8Array(n);
    this.tower = new Uint8Array(n);
    this.passage = new Uint8Array(n);
    this.ramp = new Int8Array(n).fill(-1);
    this.pit = new CellRuns(n);
  }

  /** (onetown) The plan as data (TownPlan's constructor makes it again from this). */
  toData(): PlanData {
    return {
      style: this.style,
      nextId: this.nextId,
      structures: [...this.byId.values()].sort((a, b) => a.id - b.id).map(({ cells: _cells, ...rest }) => rest),
      owner: this.owner.slice(),
      levels: this.levels.encode(),
      gate: this.gate.slice(),
      tower: this.tower.slice(),
      passage: this.passage.slice(),
      ramp: this.ramp.slice(),
      pit: this.pit.encode(),
      pits: [...this.pits].sort((a, b) => a[0] - b[0]),
      use: this.use.slice(),
      block: this.block.slice(),
      layout: this.layout,
    };
  }

  /** (round 128m) a quarry's pit as laid (null: not a quarry, or none yet) */
  pitOf(id: number): Pit | null {
    return this.pits.get(id) ?? null;
  }

  /**
   * (round 128m) Lay a quarry's pit again from its footprint (pit.ts: the tiers whose ramps fit); the cells whose pit
   * changed are marked changed. A structure gone (or not a quarry): its pit is taken out.
   */
  layPitOf(id: number): void {
    const was = this.pits.get(id);
    const cells = new Set<number>();
    if (was) for (const c of was.ring.keys()) cells.add(c);
    for (const c of cells) this.pit.clearCell(c);
    this.pits.delete(id);
    const s = this.byId.get(id);
    if (s && s.type === 'quarry') {
      const prefer = this.pitPrefer ?? undefined;
      const p = pitOf(this.grid, s.cells.keys(), { rampCells: PIT_RAMP_CELLS, prefer });
      this.pits.set(id, p);
      layPit(this.pit, p, id);
      for (const c of p.ring.keys()) cells.add(c);
    }
    for (const c of cells) this.changed.add(c);
  }
  typeAt(cell: number): StructureType | null {
    const id = cell >= 0 ? this.owner[cell] : -1;
    return id >= 0 ? this.byId.get(id)!.type : null;
  }

  structureAt(cell: number): Structure | null {
    const id = cell >= 0 ? this.owner[cell] : -1;
    return id >= 0 ? this.byId.get(id)! : null;
  }

  structure(id: number): Structure | null {
    return this.byId.get(id) ?? null;
  }

  structures(): Structure[] {
    return [...this.byId.values()];
  }

  has(cell: number, level: number): boolean {
    return this.levels.has(cell, level);
  }

  /** c's highest level (-1: none). */
  top(cell: number): number {
    return this.levels.top(cell);
  }

  /**
   * (round 128d) Whether a block at level L of c would be held: on the ground (level 0), on the block under it, or
   * beside a block at its level (any structure's) — so a wall can span an empty level between two towers, a bridge.
   * Nothing floats yet (a later rule may let crystals and floating stones).
   */
  held(cell: number, level: number): boolean {
    if (level === 0 || this.has(cell, level - 1)) return true;
    for (let e = 0; e < 4; e++) if (this.has(this.grid.nbr[cell * 4 + e], level)) return true;
    return false;
  }

  /**
   * (onetown) The generator's way to place one building: a structure of its own of these blocks (cell, level), joined
   * to no other of its type beside it (two houses side by side stay two). Painted bottom up, each as the player's paint
   * (held, not over another structure); the blocks that can't be are left out. Null if none could be.
   */
  place(type: StructureType, blocks: readonly (readonly [number, number])[], attrs: StructureAttrs = {}): Structure | null {
    const s: Structure = { id: this.nextId++, type, cells: new Map(), ...attrs };
    this.byId.set(s.id, s);
    let n = 0;
    for (const [c, l] of [...blocks].sort((a, b) => a[1] - b[1])) if (this.paint(c, l, type, s.id)) n++;
    if (n) return s;
    this.byId.delete(s.id);
    return null;
  }

  /**
   * Paint level L of a cell with a type. Without `into` (the player's way) a cell painted next to a structure of the
   * same type joins it (two joined by one cell become one); with `into`, it goes into that structure, joined to
   * no other (`place`). False if it can't be (another structure there, too high, not held).
   */
  paint(cell: number, level: number, type: StructureType, into?: number): boolean {
    if (cell < 0 || cell >= this.grid.count || !(level >= 0)) return false;
    const def = this.defs[type];
    if (level >= def.maxLevels || this.has(cell, level) || !this.held(cell, level)) return false;
    const here = this.typeAt(cell);
    if (here && here !== type) return false;
    if (into !== undefined) {
      const t = this.byId.get(into);
      if (!t || t.type !== type) throw new Error(`plan: no ${type} structure ${into} to paint into`);
      if (here && this.owner[cell] !== into) return false;
    }
    // (a block painted on a ramp's cell takes its place)
    if (this.ramp[cell] >= 0) this.ramp[cell] = -1;
    if (!here) {
      let s: Structure;
      if (into !== undefined) s = this.byId.get(into)!;
      else {
        // join the same type's structures beside it (the lowest id keeps; the others fold into it)
        const ids = new Set<number>();
        for (let e = 0; e < 4; e++) {
          const n = this.grid.nbr[cell * 4 + e];
          if (n >= 0 && this.typeAt(n) === type) ids.add(this.owner[n]);
        }
        const sorted = [...ids].sort((a, b) => a - b);
        if (!sorted.length) {
          s = { id: this.nextId++, type, cells: new Map() };
          this.byId.set(s.id, s);
        } else {
          s = this.byId.get(sorted[0])!;
          for (const other of sorted.slice(1)) {
            const o = this.byId.get(other)!;
            for (const c of o.cells.keys()) {
              this.levels.reown(c, other, s.id);
              s.cells.set(c, this.levels.runsOf(c));
              this.owner[c] = s.id;
              // (its owner changed: the view's Town follows)
              this.changed.add(c);
            }
            this.byId.delete(other);
          }
        }
      }
      this.owner[cell] = s.id;
    }
    this.levels.set(cell, level, this.owner[cell], typeIndex(type));
    this.byId.get(this.owner[cell])!.cells.set(cell, this.levels.runsOf(cell));
    this.touch(cell);
    // (round 128m: a quarry's footprint changed — its pit laid again; one folded into it has gone)
    if (type === 'quarry') {
      for (const id of [...this.pits.keys()]) if (!this.byId.has(id)) this.layPitOf(id);
      this.layPitOf(this.owner[cell]);
    }
    return true;
  }

  erase(cell: number, level: number): boolean {
    if (!this.has(cell, level)) return false;
    const s = this.byId.get(this.owner[cell])!;
    this.levels.clear(cell, level);
    const quarry = s.type === 'quarry';
    if (this.levels.any(cell)) s.cells.set(cell, this.levels.runsOf(cell));
    else {
      s.cells.delete(cell);
      this.owner[cell] = -1;
      this.gate[cell] = 0;
      this.tower[cell] = 0;
      this.passage[cell] = 0;
      if (!s.cells.size) this.byId.delete(s.id);
    }
    // (a gate stands on a straight run: a neighbour's run may have just broken)
    for (let e = 0; e < 4; e++) {
      const n = this.grid.nbr[cell * 4 + e];
      if (n >= 0 && this.gate[n] && this.wallTile(n, 0) !== 'straight') this.gate[n] = 0;
    }
    this.touch(cell);
    if (quarry) this.layPitOf(s.id);
    return true;
  }

  setGate(cell: number, on: boolean): boolean {
    if (on && this.wallTile(cell, 0) !== 'straight') return false;
    if (!on && !this.gate[cell]) return false;
    this.gate[cell] = on ? 1 : 0;
    this.touch(cell);
    return true;
  }

  /** (round 128h) a passage through a block cell's ground floor, or none; false if it isn't a block's ground floor */
  setPassage(cell: number, on: boolean): boolean {
    const t = this.typeAt(cell);
    if (!t || this.defs[t].form !== 'block' || !this.has(cell, 0) || !!this.passage[cell] === on) return false;
    this.passage[cell] = on ? 1 : 0;
    this.touch(cell);
    return true;
  }

  /** (round 128h) a ramp on a free cell, its high end at side `side` (-1: none); false if the cell isn't free */
  setRamp(cell: number, side: number): boolean {
    if (cell < 0 || cell >= this.grid.count || this.owner[cell] >= 0 || this.ramp[cell] === side) return false;
    this.ramp[cell] = side;
    this.touch(cell);
    return true;
  }

  /** the cells with a ramp */
  ramps(): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.ramp.length; c++) if (this.ramp[c] >= 0) out.push(c);
    return out;
  }

  /** (round 128d) a tower on a wall cell, or none; false if it isn't a wall */
  setTower(cell: number, on: boolean): boolean {
    if (this.typeAt(cell) !== 'wall' || !!this.tower[cell] === on) return false;
    this.tower[cell] = on ? 1 : 0;
    this.touch(cell);
    return true;
  }

  /** Which of a wall cell's sides join a wall at level L (sides 0..3). */
  wallJoins(cell: number, level: number): boolean[] {
    const out = [false, false, false, false];
    for (let e = 0; e < 4; e++) {
      const n = this.grid.nbr[cell * 4 + e];
      // (a wall runs into the fortress's keep: round 128d)
      const t = this.typeAt(n);
      out[e] = n >= 0 && (t === 'wall' || t === 'fortress') && this.has(n, level);
    }
    return out;
  }

  wallTile(cell: number, level: number): WallTile | null {
    if (this.typeAt(cell) !== 'wall' || !this.has(cell, level)) return null;
    return wallTileOf(this.wallJoins(cell, level));
  }

  blocks(s: Structure): number {
    let n = 0;
    for (const c of s.cells.keys()) n += this.levels.levels(c);
    return n;
  }

  cost(s: Structure): Goods {
    const out: Goods = {};
    addGoods(out, this.defs[s.type].cost, this.blocks(s));
    return out;
  }

  gives(s: Structure): PerBlock {
    const out: PerBlock = {};
    addPer(out, this.defs[s.type].perBlock, this.blocks(s));
    const p = this.power(s);
    if (p) out.power = p;
    return out;
  }

  /** Power a day: each block power x (1 + POWER_RISE x its level) — bigger and higher give more (round 128d). */
  power(s: Structure, only?: (cell: number, level: number) => boolean): number {
    const per = this.defs[s.type].perBlock.power ?? 0;
    if (!per) return 0;
    let p = 0;
    for (const c of s.cells.keys()) for (const L of this.levels.each(c)) if (!only || only(c, L)) p += per * (1 + POWER_RISE * L);
    return p;
  }

  /**
   * The plan's totals against the stores: what its blocks cost and what they give. (onetown) `built`: which blocks stand
   * already — they cost nothing more (a town's generated buildings stand from the start); what's given counts them all.
   */
  totals(stores: Goods, built?: (cell: number, level: number) => boolean): PlanTotals {
    const cost: Goods = {};
    const gives: PerBlock = {};
    let blocks = 0;
    for (const s of this.byId.values()) {
      const b = this.blocks(s);
      let todo = b;
      if (built) for (const c of s.cells.keys()) for (const L of this.levels.each(c)) if (built(c, L)) todo--;
      blocks += todo;
      addGoods(cost, this.defs[s.type].cost, todo);
      addPer(gives, this.defs[s.type].perBlock, b);
      const p = this.power(s);
      if (p) gives.power = (gives.power ?? 0) + p;
    }
    const short: Goods = {};
    for (const [k, v] of Object.entries(cost) as [keyof Goods, number][]) {
      const d = v - (stores[k] ?? 0);
      if (d > 0) short[k] = d;
    }
    return { blocks, cost, gives, short };
  }

  /** The cells whose look may have changed since the last call (and clears them). */
  takeChanged(): number[] {
    const out = [...this.changed];
    this.changed.clear();
    return out;
  }

  private touch(cell: number): void {
    this.changed.add(cell);
    for (let e = 0; e < 4; e++) {
      const n = this.grid.nbr[cell * 4 + e];
      if (n >= 0) this.changed.add(n);
    }
  }
}
