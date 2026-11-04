// The fortress (fortress slice 1, milestone 1): the plan (plan.ts) kept as Town blocks (build/town.ts: a cell and a
// level each, floors lined up with the neighbours') on the fortress's own world-anchored box. The Town's columns are
// box-local; TownIO maps them to the window through the box's origin and the window's, so a slide only changes that
// offset.
//
// Milestone 1 plans with time stopped: the blocks are the Town's plan (Town.plans), drawn as the towns' pieces
// (pieces.ts) — what they'll look like. Milestone 2's workers build them (Town.add: what stands).
import { STRUCTURE_TYPES, type FortressBox, type Goods, type StructureType } from '../api/contracts/fortress';
import { Town, type Block } from '../build/town';
import { TownGrid } from '../build/towngrid';
import { cellAt, cellPos, nbr } from '../world/lattice';
import { DEFS } from './defs';
import { FortressPlan, typeIndex } from './plan';
import { pickFace, placeFor } from './pick';
import { shapesOf } from './shapes';
import { waysOf, waysNav, type Ways } from './ways';
import type { NavGraph } from '../api/contracts/structures';
import type { TownThing } from '../settle/thing';
import { LEVEL_H } from '../build/town';
import { bedsOf, roomOf, type JobKind } from './economy';
import { DROP, ReachMap, STEP, type ReachColumns } from './reach';
import { solidSpans } from './solid';
import { cutWarnLine, reachWhyLine, variantLine, wouldCutLine, type ReachWhy, type VariantKind } from './words';
import { LANE_DEFAULTS, lanesOf, roadShapesOf, type LaneOpts, type Lanes } from './lanes';
import { packRoadShapes } from '../agents/roads';

/** (milestone 3) A block taken out of the plan: its type, and whether it stood (Erase gives back part of its cost). */
export interface Erased {
  cell: number;
  level: number;
  type: StructureType;
  built: boolean;
}

/**
 * (milestone 3) The economy as FortressLife last left it, for the bar and Inspect: people, their jobs, what each
 * structure's workers brought in, the grain ripe on each farm, and why the haul or the newcomers stopped.
 */
export interface FortressStatus {
  people: number;
  /** per job kind how many work at it; idle: no work */
  jobs: Partial<Record<JobKind | 'idle', number>>;
  /** per structure id: its workers now, what they've brought to the stores, the grain ripe on it (farms) */
  workers: Map<number, number>;
  made: Map<number, Goods>;
  ripe: Map<number, number>;
  /** the stores are too full for another load: the haul stopped */
  full: boolean;
  /** no grain: nobody new comes */
  hungry: boolean;
}

/** (round 128h) the most gates (or ramps) tried for a placement that cut blocks off: the nearest first */
const VARIANT_TRIES = 10;

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** (round 128e) the old town's tallest thing above its ground (m): a ray is asked about it only lower than this */
const TOWN_H = 45;

export interface FortressIO {
  /** the window's origin (world cells: x, row) — the streamer's */
  windowOrigin(): [number, number];
  dims: { w: number; h: number; zMax: number };
  /** the ground's top at window world (x, y) */
  ground(x: number, y: number): number;
  /** the fortress's stores (the pinned settlement's) */
  stores(): Goods;
  /** after a change (window world bounds of what changed): the view draws it again */
  changed(x0: number, y0: number, x1: number, y1: number): void;
  /**
   * (round 128d, FT-26) clear the plants within r of window world (x, y): a planned or built cell's trees go (the world
   * API's plants.clear; done at the sim's next tick)
   */
  clearPlants?(x: number, y: number, r: number): void;
  /** (round 128e, FT-48) what the town that was there before the fortress has at window world (x, y), if it stands up to
   *  window z (null: nothing, or lower) */
  townAt?(x: number, y: number, z: number): TownThing | null;
  /**
   * (round 128f) the window's columns as last read (their solid runs and water: reach.ts), for the check at placement;
   * null: not read yet (nothing is refused)
   */
  columns?(): ReachColumns | null;
  /** (round 128f) the town's stores (window world): where the builders fetch from until a warehouse stands */
  townHeap?(): [number, number];
}

/** (round 128d) inspect: a tap picks the structure under it (inspect.ts) instead of planning */
export type Tool = { type: StructureType; erase: boolean; gate: boolean; tower?: boolean; inspect?: boolean };

/** (round 128d) planning (time stopped, the plan drawn whole) or building (time runs, the builders at work) */
export type FortressMode = 'plan' | 'build';

export class Fortress {
  readonly town: Town;
  readonly grid: TownGrid;
  readonly plan: FortressPlan;
  tool: Tool = { type: 'house', erase: false, gate: false };
  mode: FortressMode = 'plan';
  /** the structure last painted (the panel's) */
  selected: number | null = null;
  /** (round 128d) the structure Inspect picked: drawn highlighted, its card in the panel (null: none) */
  inspected: number | null = null;
  /** (round 128e, FT-48) or the thing of the old town Inspect picked (its card in the panel) */
  inspectedTown: TownThing | null = null;
  readonly onChange: (() => void)[] = [];
  /** (round 128e, FT-50) a line for the bar: why Skip stopped, or that it finished (null: none) */
  note: string | null = null;
  /** (round 128e, FT-49) what the builders are doing now (FortressLife writes it; null before the first Build) */
  crew: { builders: number; toStores: number; carrying: number; working: number; waiting: number } | null = null;
  /** (milestone 3) blocks taken out of the plan (FortressLife gives back what they cost) */
  readonly onErased: ((e: Erased) => void)[] = [];
  /** (milestone 3) the economy now (FortressLife writes it; before the first Build, the town as it starts) */
  status: FortressStatus;
  /** (round 128d, FT-20) blocks to build that no builder can walk to from the heap (FortressLife: deep water, a cliff) */
  cutOff = 0;
  /** the ground under the box is known (the level's surface read over every column): planning may start */
  ready = false;
  /** (round 128d) the ways baked from the plan (ways.ts), made again after the plan changes */
  private waysMemo: Ways | null = null;
  /** (round 128f) told when planning or building starts */
  readonly onMode: ((m: FortressMode) => void)[] = [];
  /** (round 128f) why the last press planned nothing (a block the stores couldn't reach): the panel says it */
  refusal: string | null = null;
  /**
   * (round 128h, V128-13) after the last press: the way it kept open (a gate, a passage, a ramp — the panel's line) and
   * the cell it went on; or the cells it cut off when nothing could (outlined in red) and the panel's line
   */
  variant: string | null = null;
  variantAt = -1;
  warning: string | null = null;
  warnCells: number[] = [];
  /** (round 128f) the lanes and the roads a lane wide (lanes.ts), made again after the plan changes */
  private lanesMemo: Lanes | null = null;
  private roadShapesMemo: { of: Lanes; shapes: Float32Array } | null = null;
  /** (round 128f) the lanes' spacing per district (the town's, the fields'): the road frequency */
  private laneOptsNow: LaneOpts = { ...LANE_DEFAULTS };
  /** the ground's top at a box column */
  private readonly groundOfCol: (col: number) => number;

  constructor(readonly box: FortressBox, private io: FortressIO, seed = 7) {
    if (box.origin[1] & 1) throw new Error('fortress box: its row origin must be even (the lattice\'s odd-row shift)');
    const grid = new TownGrid(box.w, box.h, { seed });
    // (round 128d) the ground as it was before the fortress stood on it, kept a column the first time it's read: what's
    // built is claimed in the columns (claims.ts), and the surface read after it is the wall's top, not the ground —
    // a block's foot (solid.ts) and a cell planned beside it (Town.base) would stand on the wall
    const kept = new Float32Array(box.w * box.h).fill(NaN);
    this.groundOfCol = (col) => {
      if (!Number.isNaN(kept[col])) return kept[col];
      const [x, y] = this.boxToWindowXY(col);
      return (kept[col] = io.ground(x, y));
    };
    this.town = new Town(box.w, box.h, {
      ground: this.groundOfCol,
      // (the fortress is drawn as pieces, not column matter — pieces.ts: nothing is stamped; so the window's z ceiling
      // doesn't bound it either; and the Town keeps runs a cell, no level cap: round 128d)
      stamp: () => {},
      zMax: Infinity,
    }, { grid });
    this.plan = new FortressPlan(grid);
    this.grid = grid;
    this.status = { people: 0, jobs: {}, workers: new Map(), made: new Map(), ripe: new Map(), full: false, hungry: false };
  }

  /** (milestone 3) beds: the town's own houses' and the house blocks built */
  beds(): number {
    return bedsOf(this.plan, (c, l) => this.town.has(c, l));
  }

  /** (milestone 3) the stores' room: the town's own and the built warehouse blocks' */
  room(): number {
    return roomOf(this.plan, (c, l) => this.town.has(c, l));
  }

  /**
   * (milestone 3, FT-46; round 128f a lane wide; round 128i on the GPU) The road shapes the units prefer, in the box's
   * frame (agents/roads.ts packRoadShapes: each road's and lane's band, each square whole — lanes.ts roadShapesOf): the
   * agents stamp their road bits from them at the box's offset (Agents.setRoads(shapes, ...offset())). The same array
   * until the lanes change.
   */
  roadShapes(): Float32Array {
    const L = this.lanes();
    if (this.roadShapesMemo?.of !== L) this.roadShapesMemo = { of: L, shapes: packRoadShapes(roadShapesOf(L, this.ways(), this.grid)) };
    return this.roadShapesMemo.shapes;
  }

  /** (round 128f) the lanes' spacing per district: the town's and the fields' (m) */
  get laneOpts(): LaneOpts {
    return this.laneOptsNow;
  }
  setLaneOpts(o: Partial<LaneOpts>): void {
    this.laneOptsNow = { ...this.laneOptsNow, ...o };
    this.lanesMemo = null;
    for (const h of this.onChange) h();
  }

  /**
   * (round 128f; the user: "if we want roads smaller than one cell ...") The lanes of a second grid over the tiles, and
   * the main roads a lane wide (lanes.ts). From the plan and the ground as it was; not on the town that was there.
   */
  lanes(): Lanes {
    if (!this.lanesMemo) {
      const { w, h } = this.box;
      const ground = (x: number, y: number) => {
        const [k, r] = cellAt(x, y);
        return this.groundOfCol(Math.max(0, Math.min(h - 1, r)) * w + Math.max(0, Math.min(w - 1, k)));
      };
      const g = this.grid;
      const town = this.io.townAt;
      const blocked = town
        ? (c: number) => [g.centre(c), ...[0, 1, 2, 3].map((k) => g.corner(c, k))].some(([x, y]) => !!town(...this.toWindow(x, y), ground(x, y)))
        : undefined;
      this.lanesMemo = lanesOf(this.plan, g, this.ways(), ground, this.laneOptsNow, blocked);
    }
    return this.lanesMemo;
  }

  /**
   * (milestone 3) Where a built structure's door opens (window world): the middle of the free cell its door gives on
   * (ways.ts), else its first cell's middle. Null: none of its blocks stands.
   */
  doorOf(id: number): [number, number] | null {
    const s = this.plan.structure(id);
    if (!s || ![...s.cells.keys()].some((c) => this.town.built.any(c))) return null;
    const d = this.ways().doors.find((x) => x.structure === id);
    return this.centre(d ? d.out : [...s.cells.keys()][0]);
  }

  /**
   * (round 128d; the user: "buildings are supposed to bake their own paths") The plan's ways: roads and squares between
   * its doors, stairs up onto its walls, gates through them (ways.ts). From the plan, built or not.
   */
  ways(): Ways {
    if (!this.waysMemo) {
      const courts = shapesOf(this.plan, this.grid, (c) => this.town.base[c]).courtyards.flatMap((ct) => ct.cells);
      this.waysMemo = waysOf(this.plan, this.grid, courts);
    }
    return this.waysMemo;
  }

  /** (round 128d) The ways as a nav graph (box frame; z the window's): roads, doors, gates, stairs, the wall-walk. */
  nav(): NavGraph {
    const t = this.town;
    const groundOf = (c: number) => {
      const cols = this.grid.columns[c];
      let z = 0;
      for (const col of cols) z += this.groundOfCol(col) / cols.length;
      return cols.length ? z : t.base[c];
    };
    return waysNav(this.ways(), this.plan, this.grid, {
      ground: groundOf,
      top: (c) => t.floorZ(c, Math.max(0, this.plan.top(c))) + LEVEL_H,
      floor: (c) => t.floorZ(c, 0),
    });
  }

  /** the ground's top at a box column (window z) */
  groundAt(col: number): number {
    return this.groundOfCol(col);
  }

  /** box column → its window column (-1: outside the window) */
  boxToWindowCol(col: number): number {
    const [ox, oy] = this.offset();
    const x = (col % this.box.w) + ox;
    const y = Math.floor(col / this.box.w) + oy;
    if (x < 0 || y < 0 || x >= this.io.dims.w || y >= this.io.dims.h) return -1;
    return y * this.io.dims.w + x;
  }

  /** window column → its box column (-1: outside the box) */
  windowToBoxCol(col: number): number {
    const [ox, oy] = this.offset();
    const x = (col % this.io.dims.w) - ox;
    const y = Math.floor(col / this.io.dims.w) - oy;
    if (x < 0 || y < 0 || x >= this.box.w || y >= this.box.h) return -1;
    return y * this.box.w + x;
  }

  /** window world (x, y) → box world */
  toBox(x: number, y: number): [number, number] {
    const [ox, oy] = this.offset();
    const [bx, by] = cellPos(ox, oy);
    const [zx, zy] = cellPos(0, 0);
    return [x - (bx - zx), y - (by - zy)];
  }

  /** box world (x, y) → window world */
  toWindow(x: number, y: number): [number, number] {
    const [ox, oy] = this.offset();
    const [bx, by] = cellPos(ox, oy);
    const [zx, zy] = cellPos(0, 0);
    return [x + (bx - zx), y + (by - zy)];
  }

  private boxToWindowXY(col: number): [number, number] {
    const [ox, oy] = this.offset();
    return cellPos((col % this.box.w) + ox, Math.floor(col / this.box.w) + oy);
  }

  /** the box's origin in the window (cells, rows: the row offset even) */
  offset(): [number, number] {
    const [wx, wy] = this.io.windowOrigin();
    return [this.box.origin[0] - wx, this.box.origin[1] - wy];
  }

  /**
   * The block a press acts on, with the current tool: the ray through it (window frame) marched through the plan's
   * blocks (pick.ts) — a top face stacks, a side face puts one beside it at the same level; missing every block, the
   * ground's cell under `groundCol` (the GPU pick's window column), level 0.
   */
  pick(ray: { o: readonly number[]; d: readonly number[] }, groundCol: number): Block | null {
    const erase = this.tool.erase || this.tool.gate || !!this.tool.tower || !!this.tool.inspect;
    const [bx, by] = this.toBox(ray.o[0], ray.o[1]);
    const t = this.town;
    const hit = pickFace(t.grid, (c, L) => t.occupied(c, L), (c) => t.built.any(c) || t.plans.any(c), (c) => t.base[c], [bx, by, ray.o[2]], ray.d, 1200);
    const yard = !erase && DEFS[this.tool.type].form === 'yard';
    if (hit) {
      if (erase) return { cell: hit.cell, level: hit.level };
      const b = placeFor(hit);
      if (!b) return null;
      // (a yard only ever lies on the ground)
      return yard ? { cell: b.cell, level: 0 } : b;
    }
    if (erase) return null;
    // (round 128d) the ground the ray meets, in the plan's own frame — the same ray the blocks were picked along. The GPU
    // pick's column landed a column or two off it at 412x915 (12 px at zoom 6), so a tap beside a block could land in
    // the block's own cell and do nothing; the GPU pick stays the fallback (the ray meets no ground in the box)
    const c0 = this.groundCellAlong([bx, by, ray.o[2]], ray.d, 1200);
    if (c0 >= 0) return { cell: c0, level: 0 };
    if (groundCol < 0) return null;
    const bc = this.windowToBoxCol(groundCol);
    const c = bc >= 0 ? t.grid.cellOf[bc] : -1;
    return c >= 0 ? { cell: c, level: 0 } : null;
  }

  /** (inspect) the ground's cell the ray meets, level 0 (null: none in the box) */
  private groundPick(ray: { o: readonly number[]; d: readonly number[] }, groundCol: number): Block | null {
    const [bx, by] = this.toBox(ray.o[0], ray.o[1]);
    const c0 = this.groundCellAlong([bx, by, ray.o[2]], ray.d, 1200);
    if (c0 >= 0) return { cell: c0, level: 0 };
    const bc = groundCol >= 0 ? this.windowToBoxCol(groundCol) : -1;
    const c = bc >= 0 ? this.town.grid.cellOf[bc] : -1;
    return c >= 0 ? { cell: c, level: 0 } : null;
  }

  /** (round 128d) Inspect a structure (null: close the card): it's drawn highlighted. */
  inspect(id: number | null): void {
    if (id !== null) this.inspectedTown = null;
    if (id !== null && !this.plan.structure(id)) id = null;
    if (id === this.inspected) return;
    const cells = [this.inspected, id].flatMap((s) => (s === null ? [] : [...(this.plan.structure(s)?.cells.keys() ?? [])]));
    this.inspected = id;
    this.changedOver(cells);
    for (const h of this.onChange) h();
  }

  /**
   * (round 128e, FT-48) The old town's thing the ray (box frame) first meets: a building or wall it goes under the top of,
   * before it goes under the ground (null: none). Asked only within TOWN_H of the ground (the town's tallest is lower).
   */
  private townAlong(o: readonly number[], d: readonly number[], tMax: number, step = 0.4): TownThing | null {
    for (let t = 0; t <= tMax; t += step) {
      const x = o[0] + d[0] * t;
      const y = o[1] + d[1] * t;
      const z = o[2] + d[2] * t;
      const [k, r] = cellAt(x, y);
      if (k < 0 || r < 0 || k >= this.box.w || r >= this.box.h) continue;
      const g = this.groundOfCol(r * this.box.w + k);
      if (z > g + TOWN_H) continue;
      const th = this.io.townAt!(...this.toWindow(x, y), z);
      if (th) return th;
      if (z <= g) return null;
    }
    return null;
  }

  /** The cell where the ray (box frame) first goes under the ground (-1: it doesn't, in the box). */
  private groundCellAlong(o: readonly number[], d: readonly number[], tMax: number, step = 0.25): number {
    for (let t = 0; t <= tMax; t += step) {
      const x = o[0] + d[0] * t;
      const y = o[1] + d[1] * t;
      const z = o[2] + d[2] * t;
      const [k, r] = cellAt(x, y);
      if (k < 0 || r < 0 || k >= this.box.w || r >= this.box.h) continue;
      // (the cell as the blocks are picked: the quad the point is in — pick.ts)
      if (z <= this.groundOfCol(r * this.box.w + k)) return this.town.grid.cellAtWorld(x, y);
    }
    return -1;
  }

  /** A press with the current tool (see pick). What happened, for the panel; false: nothing. */
  press(ray: { o: readonly number[]; d: readonly number[] }, groundCol: number): boolean {
    if (this.tool.inspect) {
      // (a block's face along the ray; else the ground's cell — a yard lies on it; a tap on nothing closes the card)
      const b = this.pick(ray, groundCol) ?? this.groundPick(ray, groundCol);
      const id = b && this.plan.owner[b.cell] >= 0 ? this.plan.owner[b.cell] : null;
      // (round 128e, FT-48: no structure of the plan there — the old town's building or wall where the tap's ray first
      // meets the surface: its roofs and walls are in the columns, so the surface read is their top)
      let town: TownThing | null = null;
      if (id === null && this.io.townAt) {
        const [bx, by] = this.toBox(ray.o[0], ray.o[1]);
        town = this.townAlong([bx, by, ray.o[2]], ray.d, 1200);
      }
      this.inspectedTown = town;
      this.inspect(id);
      if (id === null) for (const h of this.onChange) h();
      return id !== null || town !== null;
    }
    const b = this.pick(ray, groundCol);
    if (!b) return false;
    if (this.tool.tower) {
      const on = !this.plan.tower[b.cell];
      return this.apply(() => this.plan.setTower(b.cell, on), b.cell);
    }
    if (this.tool.gate) {
      const on = !this.plan.gate[b.cell];
      return this.apply(() => this.plan.setGate(b.cell, on), b.cell);
    }
    if (this.tool.erase) return this.apply(() => this.plan.erase(b.cell, b.level), b.cell);
    return this.paint(b.cell, b.level, this.tool.type);
  }

  paint(cell: number, level: number, type: StructureType): boolean {
    this.warnCells = [];
    this.variant = null;
    // (round 128f: the check at placement) a block the stores can't reach isn't planned — (round 128h, V128-13) unless a
    // ramp up the drop in the way lets them
    if (this.plan.has(cell, level) || (level > 0 && this.plan.has(cell, level - 1))) return this.apply(() => this.plan.paint(cell, level, type), cell);
    const solid = DEFS[type].form !== 'yard';
    const after = this.reachMap(solid ? [cell] : []);
    if (!after) return this.apply(() => this.plan.paint(cell, level, type), cell);
    let ramped = false;
    if (!this.reachedIn(after, cell)) {
      const why = this.whyNot(cell);
      if (why !== 'cliff' || !this.rampTo([cell], () => this.reachMap(solid ? [cell] : []), cell)) return this.refuse(reachWhyLine(why));
      ramped = true;
    }
    // (round 128h, V128-13; the user: "Yeah I would indicate that those will block or introduce block variants so they
    // don't") a block that would shut planned blocks off is placed as a variant that keeps the way open — a gate in the
    // wall, a passage through the block, a ramp up a drop — or, when none does, placed with the cut-off cells outlined
    // (judged with the block painted: a wall cell joins its neighbours' bands — painted, not a solid cell, is what stands)
    const before = solid ? this.reachMap() : null;
    const was = before ? this.todoCells().filter((c) => c !== cell && this.reachedIn(before, c)) : [];
    if (!this.apply(() => this.plan.paint(cell, level, type), cell)) return false;
    const now = was.length ? this.reachMap()! : null;
    const cut = now ? was.filter((c) => !this.reachedIn(now, c)) : [];
    if (ramped) this.variant = variantLine('ramp', type);
    if (cut.length) this.keepOpen(cell, type, cut);
    for (const h of this.onChange) h();
    return true;
  }

  /**
   * (round 128h, V128-13) After a block was placed that cut `cut` (cells still to build) off from the stores: the first
   * variant by rule that reaches them all again — a gate in the wall it closed (the straight wall cell nearest the
   * stores), a passage through the block's ground floor, a ramp up a drop left in the way. None: the cells still cut off
   * are outlined (warnCells) and the panel says which.
   */
  private keepOpen(cell: number, type: StructureType, cut: number[]): void {
    const left = () => {
      const m = this.reachMap();
      return m ? [...cut, cell].filter((c) => !this.reachedIn(m, c)) : [];
    };
    const form = DEFS[type].form;
    if (form === 'wall') {
      const s = this.plan.structureAt(cell)!;
      const at = this.storesAt()!;
      const tries = [...s.cells.keys()]
        .filter((c) => !this.plan.gate[c] && this.plan.levels.bottom(c) === 0 && this.plan.wallTile(c, 0) === 'straight')
        .sort((a, b) => dist(this.centre(a), at) - dist(this.centre(b), at))
        .slice(0, VARIANT_TRIES);
      for (const c of tries) {
        this.plan.setGate(c, true);
        this.waysMemo = null;
        if (!left().length) return this.kept('gate', type, c);
        this.plan.setGate(c, false);
        this.waysMemo = null;
      }
    } else if (form === 'block') {
      this.plan.setPassage(cell, true);
      this.waysMemo = null;
      if (!left().length) return this.kept('passage', type, cell);
      this.plan.setPassage(cell, false);
      this.waysMemo = null;
    }
    const still = left();
    if (still.length && this.rampTo(still, () => this.reachMap(), cell)) {
      const rest = left();
      if (!rest.length) return this.kept('ramp', type, cell);
    }
    this.sync();
    this.warnCells = left();
    const types = [...new Set(this.warnCells.map((c) => this.plan.typeAt(c)!))];
    this.warning = this.warnCells.length ? cutWarnLine(types) : null;
  }

  private kept(kind: VariantKind, type: StructureType, at: number): void {
    this.variant = variantLine(kind, type);
    this.variantAt = at;
    this.sync();
  }

  /**
   * (round 128h, V128-13) A ramp that lets the stores reach every one of `cells` (with `map` the reach as it would be):
   * the drops the agents walk down but not up (a column reached one way beside one reached both, a rise over a step
   * and no more than a drop) on free cells, nearest the cells first; each tried in turn. False (and no ramp): none does.
   */
  private rampTo(cells: number[], map: () => ReachMap | null, also = -1): boolean {
    const m = map();
    if (!m) return false;
    const g = this.grid;
    const [ox, oy] = this.offset();
    const [x0, y0, x1, y1] = m.box;
    const tried = new Set<number>();
    const tries: { cell: number; side: number; d: number }[] = [];
    const targets = cells.map((c) => this.centre(c));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (!m.oneWay(x, y)) continue;
        const zLow = m.topZ(x, y);
        for (let d = 0; d < 6; d++) {
          const [qx, qy] = nbr(x, y, d);
          if (!m.reached(qx, qy)) continue;
          const rise = m.topZ(qx, qy) - zLow;
          if (!(rise > STEP && rise <= DROP)) continue;
          const c = g.cellOf[(y - oy) * this.box.w + (x - ox)];
          const n = g.cellOf[(qy - oy) * this.box.w + (qx - ox)];
          if (c < 0 || n < 0 || c === n || c === also || this.plan.owner[c] >= 0 || this.plan.ramp[c] >= 0) continue;
          const side = [0, 1, 2, 3].find((e) => g.nbr[c * 4 + e] === n);
          if (side === undefined || tried.has(c * 4 + side)) continue;
          tried.add(c * 4 + side);
          const [wx, wy] = cellPos(x, y);
          tries.push({ cell: c, side, d: Math.min(...targets.map((t) => dist([wx, wy], t))) });
        }
      }
    tries.sort((a, b) => a.d - b.d);
    for (const t of tries.slice(0, VARIANT_TRIES)) {
      this.plan.setRamp(t.cell, t.side);
      const after = map();
      if (after && cells.every((c) => this.reachedIn(after, c, also))) {
        this.sync();
        return true;
      }
      this.plan.setRamp(t.cell, -1);
    }
    this.plan.takeChanged();
    return false;
  }

  private refuse(why: string): boolean {
    this.refusal = why;
    for (const h of this.onChange) h();
    return false;
  }

  erase(cell: number, level: number): boolean {
    return this.apply(() => this.plan.erase(cell, level), cell);
  }

  setGate(cell: number, on: boolean): boolean {
    // (round 128f) a gate shut that would shut blocks off from the stores stays open
    if (!on && this.plan.gate[cell]) {
      const why = this.gateWhy(cell);
      if (why) return this.refuse(why);
    }
    return this.apply(() => this.plan.setGate(cell, on), cell);
  }

  /** (round 128f) the window's columns as last read (a new object each read): null, not read yet */
  columnsNow(): ReachColumns | null {
    return this.io.columns?.() ?? null;
  }

  /** (round 128f) where the builders fetch from (window world): the first built warehouse's door, else the town's heap */
  storesAt(): [number, number] | null {
    for (const s of this.plan.structures().sort((a, b) => a.id - b.id)) {
      if (s.type !== 'warehouse') continue;
      const d = this.doorOf(s.id);
      if (d) return d;
    }
    return this.io.townHeap?.() ?? null;
  }

  /**
   * (round 128f) Where a builder stands to work on a cell (window world): a little out from the middle of each side that
   * no planned or built block's ground level covers (a yard's is open ground) (FortressLife's stands, the same). `also`: a cell about to be planned.
   */
  standsOf(cell: number, also = -1): [number, number][] {
    const g = this.grid;
    const [cx, cy] = g.centre(cell);
    const out: [number, number][] = [];
    for (let e = 0; e < 4; e++) {
      const n = g.nbr[cell * 4 + e];
      if (n < 0 || n === also) continue;
      // (a yard beside it — a farm, the quarry — is open ground a builder stands on)
      const t = this.plan.typeAt(n);
      if ((this.plan.has(n, 0) || this.town.has(n, 0)) && !(t && DEFS[t].form === 'yard')) continue;
      const [ax, ay] = g.corner(cell, e);
      const [bx, by] = g.corner(cell, e + 1);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const d = Math.hypot(mx - cx, my - cy) || 1;
      out.push(this.toWindow(mx + ((mx - cx) / d) * 1.4, my + ((my - cy) / d) * 1.4));
    }
    return out;
  }

  /**
   * (round 128f) The reach from the stores over the window's columns as last read (reach.ts), the plan's blocks solid as
   * if built (solid.ts: a block its cell, a wall its band, a gate open under its lintel, the stairs), and `extra` cells'
   * columns solid too (a block about to be planned). Null: the columns aren't read yet, or there are no stores.
   */
  reachMap(extra: number[] = [], opts: { deep?: boolean; fortress?: boolean } = {}): ReachMap | null {
    const cols = this.io.columns?.();
    const at = this.storesAt();
    if (!cols || !at) return null;
    const [ox, oy] = this.offset();
    const W = cols.w;
    const add = new Map<number, [number, number][]>();
    const put = (bx: number, by: number, z0: number, z1: number) => {
      const x = bx + ox;
      const y = by + oy;
      if (x < 0 || y < 0 || x >= W || y >= cols.h) return;
      const k = y * W + x;
      const l = add.get(k);
      if (l) l.push([z0, z1]);
      else add.set(k, [[z0, z1]]);
    };
    if (opts.fortress !== false) {
      // (the plan as if built: what builders will have to walk round)
      const plan = this.plan;
      const town: Town = Object.create(this.town);
      Object.defineProperty(town, 'built', { value: { each: (c: number) => plan.levels.each(c) } });
      for (const spans of solidSpans({ plan, town, grid: this.grid, ground: this.groundOfCol, ways: this.ways() }).values())
        for (const q of spans) put(q.x, q.y, q.z0, q.z1);
      for (const c of extra)
        for (const col of this.grid.columns[c]) {
          const g = this.groundOfCol(col);
          put(col % this.box.w, Math.floor(col / this.box.w), g - 0.6, g + LEVEL_H);
        }
    }
    const [hx, hy] = cellAt(at[0], at[1]);
    const box: [number, number, number, number] = [Math.max(0, ox), Math.max(0, oy), Math.min(W, ox + this.box.w), Math.min(cols.h, oy + this.box.h)];
    return new ReachMap(cols, [hx, hy], { box, extra: add, deep: opts.deep });
  }

  /** (round 128f) whether any of a cell's stands is reached in `m` */
  reachedIn(m: ReachMap, cell: number, also = -1): boolean {
    return this.standsOf(cell, also).some(([x, y]) => {
      const [cx, cy] = cellAt(x, y);
      return m.reached(cx, cy);
    });
  }

  /** (round 128f) the cells with blocks still to build (their ground: a builder works from beside it) */
  todoCells(): number[] {
    const out: number[] = [];
    for (const s of this.plan.structures()) for (const c of s.cells.keys()) if ([...this.plan.levels.each(c)].some((l) => !this.town.has(c, l))) out.push(c);
    return out;
  }

  /** (round 128f) why shutting a gate is refused: the blocks it would shut off (null: none) */
  private gateWhy(cell: number): string | null {
    const before = this.reachMap();
    if (!before) return null;
    this.plan.gate[cell] = 0;
    this.waysMemo = null;
    let after: ReachMap | null;
    try {
      after = this.reachMap();
    } finally {
      this.plan.gate[cell] = 1;
      this.waysMemo = null;
    }
    const cut = new Set<StructureType>();
    for (const c of this.todoCells()) if (this.reachedIn(before, c) && !this.reachedIn(after!, c)) cut.add(this.plan.typeAt(c)!);
    return cut.size ? wouldCutLine([...cut]) : null;
  }

  /** (round 128f) why the stores don't reach a cell: what, taken away, lets them */
  whyNot(cell: number): ReachWhy {
    const ok = (m: ReachMap | null) => !!m && this.reachedIn(m, cell);
    if (!this.standsOf(cell).length) return 'walled';
    const m = this.reachMap();
    // (out of the box the agents' fields cover)
    if (m && this.standsOf(cell).every(([x, y]) => {
      const [cx, cy] = cellAt(x, y);
      return cx < m.box[0] || cy < m.box[1] || cx >= m.box[2] || cy >= m.box[3];
    }))
      return 'far';
    if (ok(this.reachMap([cell], { deep: false }))) return 'deep';
    if (ok(this.reachMap([], { fortress: false }))) return 'walled';
    return 'cliff';
  }

  /** The box cell under window world (x, y) (-1: none). */
  cellAt(x: number, y: number): number {
    const [bx, by] = this.toBox(x, y);
    return this.town.grid.cellAtWorld(bx, by);
  }

  /** A cell's middle in window world. */
  centre(cell: number): [number, number] {
    const [x, y] = this.town.grid.centre(cell);
    return this.toWindow(x, y);
  }

  /**
   * The cells round a circle (window world centre, radius), each sharing a side with the next: a ring of wall cells
   * when painted (scripted checks and a quick start).
   */
  ringCells(x: number, y: number, r: number): number[] {
    const g = this.town.grid;
    const seq: number[] = [];
    const n = Math.ceil(r * 2 * Math.PI * 3);
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      const c = this.cellAt(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (c >= 0 && seq[seq.length - 1] !== c) seq.push(c);
    }
    while (seq.length > 1 && seq[seq.length - 1] === seq[0]) seq.pop();
    const nb = (a: number, b: number) => [0, 1, 2, 3].some((e) => g.nbr[a * 4 + e] === b);
    // (round 128h, FT-57: the old join — one cell beside both, a cell seen twice skipped — left the ring open where the
    // circle met its start: two cells a corner apart, a 12-column gap in a radius-18 ring. Now every two cells in turn,
    // the last and the first too, are joined by the cheapest way along the circle, side to side; a loop the walk makes
    // back onto itself is cut out)
    const [bx, by] = this.toBox(x, y);
    const off = (c: number) => {
      const [cx, cy] = g.centre(c);
      return Math.abs(Math.hypot(cx - bx, cy - by) - r);
    };
    const join = (a: number, b: number): number[] => {
      // (Dijkstra over sides, a step costing 1 and how far off the circle it lands: the cells between a and b)
      const cost = new Map<number, number>([[a, 0]]);
      const from = new Map<number, number>();
      const open = [a];
      while (open.length) {
        open.sort((p, q) => cost.get(q)! - cost.get(p)!);
        const c = open.pop()!;
        if (c === b) break;
        if (cost.get(c)! > 40) continue;
        for (let e = 0; e < 4; e++) {
          const m = g.nbr[c * 4 + e];
          if (m < 0) continue;
          const k = cost.get(c)! + 1 + off(m) * 0.5;
          if (k < (cost.get(m) ?? Infinity)) {
            cost.set(m, k);
            from.set(m, c);
            open.push(m);
          }
        }
      }
      if (!from.has(b)) throw new Error(`fortress: ringCells couldn't join cells ${a} and ${b}`);
      const path: number[] = [];
      for (let c = from.get(b)!; c !== a; c = from.get(c)!) path.push(c);
      return path.reverse();
    };
    let out: number[] = [];
    for (let i = 0; i < seq.length; i++) {
      const a = seq[i];
      const b = seq[(i + 1) % seq.length];
      out.push(a);
      if (a !== b && !nb(a, b)) out.push(...join(a, b));
    }
    // (a cell the walk comes back to: the shorter way round between the two visits is a loop off the ring, cut out)
    for (let again = true; again; ) {
      again = false;
      const at = new Map<number, number>();
      for (let j = 0; j < out.length && !again; j++) {
        const i = at.get(out[j]);
        if (i === undefined) {
          at.set(out[j], j);
          continue;
        }
        out = j - i <= out.length / 2 ? [...out.slice(0, i), ...out.slice(j)] : out.slice(i, j);
        again = true;
      }
    }
    // (a cell whose two neighbours in the loop touch each other is a kink: dropped, so the loop runs one cell wide)
    for (let again = true; again && out.length > 4; ) {
      again = false;
      for (let i = 0; i < out.length; i++) {
        const a = out[(i + out.length - 1) % out.length];
        const b = out[(i + 1) % out.length];
        if (nb(a, b)) {
          out.splice(i, 1);
          again = true;
          break;
        }
      }
    }
    for (let i = 0; i < out.length; i++)
      if (!nb(out[i], out[(i + 1) % out.length])) throw new Error(`fortress: ringCells left the ring open at ${out[i]}`);
    return out;
  }

  /** The window slid: the box sits elsewhere in it (the view moves its pieces). */
  slid(): void {
    const cells: number[] = [];
    for (let c = 0; c < this.grid.count; c++) if (this.plan.levels.any(c)) cells.push(c);
    this.changedOver(cells);
  }

  /** (round 128d) Planning or building: what the view draws (see-through blocks still to build only while building). */
  setMode(m: FortressMode): void {
    if (this.mode === m) return;
    this.mode = m;
    for (const h of this.onMode) h(m);
    this.changedOver([...this.plan.structures().flatMap((s) => [...s.cells.keys()])]);
    for (const h of this.onChange) h();
  }

  /** While building: whether a block of the plan is still to build (null while planning: the plan drawn whole). */
  ghost(): ((cell: number, level: number) => boolean) | undefined {
    if (this.mode !== 'build') return undefined;
    return (c, l) => !this.town.has(c, l);
  }

  /** (round 128e, FT-51) blocks still to build that work has begun on (something brought to them) */
  private begun = new Set<string>();

  /** (FT-51) whether work on a block has begun (scaffolding round it) */
  started(): (cell: number, level: number) => boolean {
    return (c, l) => this.begun.has(`${c}:${l}`);
  }

  /** (FT-51) the first load brought to a block: scaffolding goes up round it */
  markStarted(cell: number, level: number): void {
    const k = `${cell}:${level}`;
    if (this.begun.has(k) || this.town.has(cell, level)) return;
    this.begun.add(k);
    this.changedOver([cell]);
    for (const h of this.onChange) h();
  }

  /** A block's cost is in: it stands (milestone 2's builders, life.ts). */
  markBuilt(cell: number, level: number): void {
    const s = this.plan.structureAt(cell);
    if (!s || !this.town.add(cell, level, s.id, typeIndex(s.type))) throw new Error(`fortress: block ${cell}:${level} couldn't stand`);
    this.begun.delete(`${cell}:${level}`);
    // (what grew back on it since it was planned goes as it stands)
    this.clearPlants([cell]);
    this.changedOver([cell]);
    for (const h of this.onChange) h();
  }

  /** (FT-20) How many blocks the builders can't reach now (FortressLife): the bar says so. */
  setCutOff(n: number): void {
    this.cutOff = n;
    for (const h of this.onChange) h();
  }

  /** Blocks built and planned (built ones counted in both). */
  progress(): { built: number; total: number } {
    let built = 0;
    let total = 0;
    for (const s of this.plan.structures())
      for (const c of s.cells.keys())
        for (const l of this.plan.levels.each(c)) {
          total++;
          if (this.town.has(c, l)) built++;
        }
    return { built, total };
  }

  /** (round 128d) Power a day from the fortress's built blocks (bigger and higher give more: FortressPlan.power). */
  powerPerDay(): number {
    let p = 0;
    for (const s of this.plan.structures()) p += this.plan.power(s, (c, l) => this.town.has(c, l));
    return p;
  }

  stores(): Goods {
    return this.io.stores();
  }

  private apply(f: () => boolean, cell: number): boolean {
    if (!this.ready || !f()) return false;
    this.refusal = null;
    this.variant = null;
    this.variantAt = -1;
    this.warning = null;
    this.warnCells = [];
    this.selected = this.plan.owner[cell] >= 0 ? this.plan.owner[cell] : this.selected;
    if (this.selected !== null && !this.plan.structure(this.selected)) this.selected = null;
    this.sync();
    for (const h of this.onChange) h();
    return true;
  }

  /** The Town's plan follows the painted plan (the blocks' floors: Town.plan lines them up with the neighbours'). */
  private sync(): void {
    const changed = this.plan.takeChanged();
    this.waysMemo = null;
    this.lanesMemo = null;
    const erased: Erased[] = [];
    for (const c of changed) {
      const s = this.plan.structureAt(c);
      const owner = s ? s.id : 0;
      const type = s ? typeIndex(s.type) : 0;
      // (the levels either side has: the plan's and the Town's, built or planned)
      const levels = new Set([...this.plan.levels.each(c), ...this.town.plans.each(c), ...this.town.built.each(c)]);
      for (const l of levels) {
        const want = this.plan.has(c, l);
        // (milestone 3: a block leaving the plan, built or not: what it cost goes back, in part — FortressLife)
        if (!want && (this.town.has(c, l) || this.town.planned(c, l))) {
          const run = this.town.built.at(c, l) ?? this.town.plans.at(c, l);
          if (run) erased.push({ cell: c, level: l, type: STRUCTURE_TYPES[run.type], built: this.town.has(c, l) });
        }
        if (want !== this.town.planned(c, l)) this.town.plan(c, l, want, owner, type);
        if (!want) this.begun.delete(`${c}:${l}`);
        // (a built block erased from the plan comes down at once: taking down is a later milestone's work)
        if (!want && this.town.has(c, l)) this.town.remove(c, l);
      }
      // (structures folded into one: the Town's runs take the plan's owner)
      this.town.plans.ownAll(c, owner, type);
      this.town.built.ownAll(c, owner, type);
    }
    // (FT-26) the trees go from the cells painted and the cells round them (a courtyard among them)
    this.clearPlants(changed);
    this.changedOver(changed);
    for (const e of erased) for (const h of this.onErased) h(e);
  }

  /** The plants on these cells cleared (each cell's quad: a disc round its middle to its farthest corner). */
  private clearPlants(cells: number[]): void {
    if (!this.io.clearPlants) return;
    const g = this.town.grid;
    for (const c of cells) {
      const [x, y] = g.centre(c);
      let r = 0;
      for (let k = 0; k < 4; k++) {
        const [cx, cy] = g.corner(c, k);
        r = Math.max(r, Math.hypot(cx - x, cy - y));
      }
      this.io.clearPlants(...this.toWindow(x, y), r + 0.5);
    }
  }

  /** tell the IO what changed: the window world bounds of these cells and their neighbours */
  private changedOver(cells: number[]): void {
    if (!cells.length) return;
    const g = this.town.grid;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of cells)
      for (let k = 0; k < 4; k++) {
        const [x, y] = this.toWindow(...g.corner(c, k));
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    // (the neighbours restamped with them: a cell across)
    this.io.changed(x0 - 8, y0 - 8, x1 + 8, y1 + 8);
  }
}
