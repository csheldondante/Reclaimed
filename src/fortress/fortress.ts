// The fortress (fortress slice 1, milestone 1): the player editing a town's plan. (Round 128m, onetown; the user: "Why
// is the fortress not just another building type?", "Consolidate them".) The town is its site (build/site.ts): its one
// plan (build/plan.ts) — what the generator placed and what the player paints, the same structures and types — kept as
// Town blocks (build/town.ts: a cell and a level each, floors lined up with the neighbours'), on the town's grid in its
// box. The box's columns are box-local and its heights world z; the fortress talks to the window through the box's
// origin and the window's (x, y) and the window's oz (z), so a slide only changes those offsets.
//
// Planning happens with time stopped: the blocks are the Town's plan (Town.plans), drawn with the town (build/view.ts)
// — what they'll look like. The builders build them (Town.add: what stands).
import { type JobKind } from '../town/jobs';
import { STRUCTURE_TYPES, type FortressBox, type Goods, type StructureType } from '../api/contracts/fortress';
import type { Town, Block } from '../build/town';
import type { QuadGrid } from '../build/quadgrid';
import type { TownSite } from '../build/site';
import { cellAt, cellPos, nbr } from '../world/lattice';
import { DEFS } from './defs';
import { typeIndex, type TownPlan } from '../build/plan';
import { pickFace, placeFor } from './pick';
import { shapesOf } from '../build/shapes';
import { groundSteps, waysOf, waysNav, type Ways } from '../build/ways';
import type { NavGraph } from '../api/contracts/structures';
import { LEVEL_H } from '../build/town';
import { bedsOf, roomOf } from './economy';
import { packSpan, REACH_BITS, type ReachAsk, type ReachEngine, type ReachReply } from './reach';
import { solidSpans } from '../build/solid';
import { refusedLine, variantLine, wouldCutLine, type ReachWhy, type VariantKind } from './words';
import { laneGraph, lanesOf, roadShapesOf, type Lanes } from '../build/lanes';
import { openCell } from '../build/entrances';
import { nearestNode, reached, subgraph, type RoadGraph } from '../agents/roadgraph';
import { packRoadShapes } from '../agents/roads';
import { CellRuns } from '../build/runs';

/** (milestone 3) A block taken out of the plan: its type, and whether it stood (Erase gives back part of its cost). */
export interface Erased {
  cell: number;
  level: number;
  type: StructureType;
  built: boolean;
}

/**
 * (milestone 3) The economy as FortressCrowd last left it, for the bar and Inspect: people, their jobs, what each
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
// (round 128i) water deeper than LANE_WATER (0.8 m: fortreach.wgsl R_LANE_WATER, the reach's wet columns) over a cell's
// middle or a corner: no roads on it. (round 128k: was 0.3 — a river cut the roads off from the sites the builders
// reached by wading; now the agents' own limit, a ford is a way: agents.wgsl DEEP_OFF)

/** (round 128l, m4) a gate shut, judged by the next reach answer: the cells reached before it */
interface GateEdit {
  cell: number;
  before: Set<number>;
}
/** (round 128l) a variant tried on the plan: put in, taken out; `type` the structure it's for (the panel's line) */
interface Try {
  kind: VariantKind;
  at: number;
  type: StructureType;
  on(): boolean;
  off(): void;
}
/**
 * (round 128l; RT-6) the variants for a batch of placed blocks, tried in turn (each judged by an answer), until one
 * reaches every planned block the batch cut off (`cut`) or, when it cut none, one of its own blocks out of reach that a
 * variant may mend (`mend`: below a drop, walled in by the plan). None does: the batch is judged on `base`, the answer
 * for the plan without them.
 */
interface Trial {
  tries: Try[];
  i: number;
  cut: number[];
  mend: number[];
  /** the batch's blocks (level-0 cells, pending) */
  batch: number[];
  base: Map<number, number>;
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export interface FortressIO {
  /** the window's origin (world cells: x, row) — the streamer's */
  windowOrigin(): [number, number];
  /** (onetown) the window's oz: window z = world z − oz (the town's heights are world z) */
  oz(): number;
  dims: { w: number; h: number; zMax: number };
  /** the fortress's stores (the pinned settlement's) */
  stores(): Goods;
  /**
   * after a change: the town drawn again — and (`solid`) claimed again: what stands, the gates, the ways' stairs
   * changed (onetown: the town's view and claims, settle/view.ts)
   */
  changed(solid: boolean): void;
  /**
   * (round 128d, FT-26) clear the plants within r of window world (x, y): a planned or built cell's trees go (the world
   * API's plants.clear; done at the sim's next tick)
   */
  clearPlants?(x: number, y: number, r: number): void;
  /**
   * (round 128l, m4) what answers the reach: the GPU's connected components over the box (reachgpu.ts; tests: the CPU
   * reference, reach.ts CpuReach). None: nothing is judged
   */
  reach?: ReachEngine;
  /** (round 128f) the town's stores (window world): where the builders fetch from until a warehouse stands */
  townHeap?(): [number, number];
}

/** (round 128d) inspect: a tap picks the structure under it (inspect.ts) instead of planning */
export type Tool = { type: StructureType; erase: boolean; gate: boolean; tower?: boolean; inspect?: boolean };

/** (round 128d) planning (time stopped, the plan drawn whole) or building (time runs, the builders at work) */
export type FortressMode = 'plan' | 'build';

export class Fortress {
  readonly town: Town;
  readonly grid: QuadGrid;
  readonly plan: TownPlan;
  /** the town's box in the world (its column (0, 0) at origin: x, row) */
  readonly box: FortressBox;
  tool: Tool = { type: 'house', erase: false, gate: false };
  mode: FortressMode = 'plan';
  /** the structure last painted (the panel's) */
  selected: number | null = null;
  /** (round 128d) the structure Inspect picked: drawn highlighted, its card in the panel (null: none) */
  inspected: number | null = null;
  readonly onChange: (() => void)[] = [];
  /** (round 128e, FT-50) a line for the bar: why Skip stopped, or that it finished (null: none) */
  note: string | null = null;
  /** (round 128e, FT-49) what the builders are doing now (FortressCrowd writes it; null before the first Build) */
  crew: { builders: number; toStores: number; carrying: number; working: number; waiting: number } | null = null;
  /** (milestone 3) blocks taken out of the plan (FortressCrowd gives back what they cost) */
  readonly onErased: ((e: Erased) => void)[] = [];
  /** (milestone 3) the economy now (FortressCrowd writes it; before the first Build, the town as it starts) */
  status: FortressStatus;
  /** (round 128d, FT-20) blocks to build that no builder can walk to from the heap (FortressCrowd: deep water, a cliff) */
  cutOff = 0;
  /** the ground under the box is known (the level's surface read over every column): planning may start */
  ready = false;
  /** (round 128d) the ways baked from the plan (ways.ts), made again after the plan changes */
  private waysMemo: Ways | null = null;
  /** (round 128f) told when planning or building starts */
  readonly onMode: ((m: FortressMode) => void)[] = [];
  /**
   * (round 128f; RT-6) why the last press's blocks (some or all) were taken out of the plan again: the stores couldn't
   * reach them, or they shut planned blocks off. The panel says it
   */
  refusal: string | null = null;
  /** (round 128h, V128-13) after the last press: the way it kept open (a gate, a passage, a ramp — the panel's line) and the cell it went on */
  variant: string | null = null;
  variantAt = -1;
  /** (round 128f) the lanes and the roads a lane wide (lanes.ts), made again after the plan changes */
  private lanesMemo: { of: Ways; lanes: Lanes } | null = null;
  /** (round 128l, m4) the reach: the last answer per cell still to build (reach.ts ReachReply bits), its ramp spots,
   *  the box's wet columns (a bit each: the lanes keep off them), the asks folded while a check is in flight */
  private reachBits = new Map<number, number>();
  private reachRamps: { col: number; dir: number }[] = [];
  private wetBits: Uint32Array | null = null;
  private reachBusy = false;
  private reachWant = false;
  private reachWet = false;
  private edit: GateEdit | null = null;
  private trial: Trial | null = null;
  /**
   * (RT-6, round 128m: "we should not have blocks that agents can't reach") blocks placed (their level-0 cells, in the
   * order placed) that the reach hasn't judged yet: drawn as the plan's ghost (plots) and no site for the builders
   * until an answer keeps them (reached, or reached by a variant) or takes them out (refused, the panel says why)
   */
  private pending = new Set<number>();
  /** the cells still to build the stores reached before the pending blocks went in (what they may not cut off) */
  private pendingBefore: Set<number> | null = null;
  /** an answer has come back (the lab waits for it) */
  reachKnown = false;
  readonly reachStats = { checks: 0, rounds: 0, cpuMs: 0 };
  /** (round 128l) told after each answer (FortressCrowd: the cut-off blocks) */
  readonly onReach: (() => void)[] = [];
  private roadShapesMemo: { of: Lanes; shapes: Float32Array } | null = null;
  private roadGraphMemo: { of: Lanes; graph: RoadGraph } | null = null;
  /** the ground's top at a box column (world z: the land as it was before the town — the site's) */
  private readonly groundOfCol: (col: number) => number;
  /** (round 128m, quarry; V128-11) the quarries' pits as dug: whole tiers' levels (negative: TownPlan.pit's) */
  readonly dug: CellRuns;

  /** (onetown) the player editing a town: its site (its plan, what stands, its grid, its box) */
  constructor(readonly site: TownSite, private io: FortressIO) {
    const grid = site.grid;
    this.box = { origin: [site.box.x0, site.box.y0], w: site.box.w, h: site.box.h };
    this.groundOfCol = (col) => site.ground(col);
    this.town = site.town;
    this.plan = site.plan;
    this.grid = grid;
    this.dug = new CellRuns(grid.count);
    // (round 128m) a quarry's ramp starts on its edge nearest the stores (the roads come in there)
    this.plan.pitPrefer = (c) => {
      const s = this.storesAt();
      if (!s) return c;
      const [sx, sy] = this.toBox(s[0], s[1]);
      const [x, y] = grid.centre(c);
      return Math.hypot(x - sx, y - sy);
    };
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

  /**
   * (round 128i, V128-14) The lanes and roads as the agents' road graph (lanes.ts laneGraph), in the box's frame: the
   * people ride it to the stores, the houses and the farms (Agents.ride). Only the network the doors are on — the part
   * of the graph that reaches the most doors (lanes cut off from it by the old town, water or the walls are drawn, not
   * ridden: a walker led onto one could never get off at its goal). The same object until the lanes change.
   */
  roadGraph(): RoadGraph {
    const L = this.lanes();
    if (this.roadGraphMemo?.of !== L) {
      const all = laneGraph(L);
      const g = this.grid;
      // (round 128o: every entrance's way-out cell is a lane node: its middle)
      const doors = this.ways().entrances.map((d) => nearestNode(all, ...g.centre(d.out)).node);
      let from = -1;
      let most = 0;
      for (const v of doors) {
        if (v < 0) continue;
        const net = reached(all, v);
        const k = doors.filter((u) => net.has(u)).length;
        if (k > most) {
          most = k;
          from = v;
        }
      }
      this.roadGraphMemo = { of: L, graph: subgraph(all, from) };
    }
    return this.roadGraphMemo.graph;
  }

  /**
   * The roads (lanes.ts, round 128o: down the ways' cells, from every entrance — never along a building's face). The same
   * object until the ways change.
   */
  lanes(): Lanes {
    const ways = this.ways();
    if (this.lanesMemo?.of !== ways) {
      const { w, h } = this.box;
      const ground = (x: number, y: number) => {
        const [k, r] = cellAt(x, y);
        return this.groundOfCol(Math.max(0, Math.min(h - 1, r)) * w + Math.max(0, Math.min(w - 1, k)));
      };
      this.lanesMemo = { of: ways, lanes: lanesOf(this.plan, this.grid, ways, ground) };
    }
    return this.lanesMemo.lanes;
  }

  /**
   * (milestone 3; round 128o) Where a built structure is entered (window world): the middle of the cell its entrance
   * opens from (build/entrances.ts). Null: none of its blocks stands, or it has no entrance (cut off: the ways say so).
   */
  doorOf(id: number): [number, number] | null {
    const s = this.plan.structure(id);
    if (!s || ![...s.cells.keys()].some((c) => this.town.built.any(c))) return null;
    const d = this.ways().entrances.find((x) => x.structure === id);
    return d ? this.centre(d.out) : null;
  }

  /**
   * (round 128d; the user: "buildings are supposed to bake their own paths") The plan's ways: roads and squares between
   * its doors, stairs up onto its walls, gates through them (ways.ts). From the plan, built or not.
   */
  ways(): Ways {
    if (!this.waysMemo) {
      const courts = shapesOf(this.plan, this.grid, (c) => this.town.base[c]).courtyards.flatMap((ct) => ct.cells);
      // (round 128i, 128o: no road under water — a cell with water over LANE_WATER at its middle or a corner: the box's
      // wet columns, the reach's answer, fortreach.wgsl reachWet; none yet: dry)
      const g = this.grid;
      const wb = this.wetBits;
      const wet = (x: number, y: number) => {
        if (!wb) return false;
        const b = this.boxColOf(x, y);
        return b >= 0 && ((wb[b >> 5] >>> (b & 31)) & 1) === 1;
      };
      const blocked = (c: number) => !!wb && [g.centre(c), ...[0, 1, 2, 3].map((k) => g.corner(c, k))].some(([x, y]) => wet(x, y));
      // (round 128o: and never across a terrace's edge a walker can't step — the land as the town has it)
      const { w, h } = this.box;
      const ground = (x: number, y: number) => {
        const [k, r] = cellAt(x, y);
        return this.groundOfCol(Math.max(0, Math.min(h - 1, r)) * w + Math.max(0, Math.min(w - 1, k)));
      };
      this.waysMemo = waysOf(this.plan, g, { courtyards: courts, blocked, walk: groundSteps(g, ground) });
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

  /** (round 128l, m4) the window's size (columns, rows) */
  windowDims(): { w: number; h: number } {
    return { w: this.io.dims.w, h: this.io.dims.h };
  }

  /** the ground's top at a box column (window z) */
  groundAt(col: number): number {
    return this.groundOfCol(col) - this.io.oz();
  }

  /**
   * (round 128m, quarry) a height in the town's own z is its window z plus this (onetown: the town's z is the world's —
   * this is the window's oz): what must keep through a slide (a pit's reference: quarry.ts) is kept so
   */
  get zShift(): number {
    return this.io.oz();
  }

  /**
   * (round 128m, townlab: the placement bench) whether the last reach answer read water over the lanes' limit at window
   * world (x, y) — the bits the reach already reads (null: none read yet; false outside the box)
   */
  wetAt(x: number, y: number): boolean | null {
    const wb = this.wetBits;
    if (!wb) return null;
    const b = this.boxColOf(...this.toBox(x, y));
    return b >= 0 && ((wb[b >> 5] >>> (b & 31)) & 1) === 1;
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

  /** (round 128m) a box column's middle in window world */
  colXY(col: number): [number, number] {
    return this.boxToWindowXY(col);
  }

  /**
   * (round 128m, quarry) Where a quarry's pit meets the roads (box frame): the outer side of the cell its ramp starts
   * on — the cell and the side; null: no pit.
   */
  pitEntry(id: number): { cell: number; side: number } | null {
    const p = this.plan.pitOf(id);
    return p && p.tiers ? { cell: p.top, side: p.topSide } : null;
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
    // (the ray in the town's frame: box x, y; world z)
    const bz = ray.o[2] + this.io.oz();
    const t = this.town;
    const hit = pickFace(t.grid, (c, L) => t.occupied(c, L), (c) => t.built.any(c) || t.plans.any(c), (c) => t.base[c], [bx, by, bz], ray.d, 1200);
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
    const c0 = this.groundCellAlong([bx, by, bz], ray.d, 1200);
    if (c0 >= 0) return { cell: c0, level: 0 };
    if (groundCol < 0) return null;
    const bc = this.windowToBoxCol(groundCol);
    const c = bc >= 0 ? t.grid.cellOf[bc] : -1;
    return c >= 0 ? { cell: c, level: 0 } : null;
  }

  /** (inspect) the ground's cell the ray meets, level 0 (null: none in the box) */
  private groundPick(ray: { o: readonly number[]; d: readonly number[] }, groundCol: number): Block | null {
    const [bx, by] = this.toBox(ray.o[0], ray.o[1]);
    const c0 = this.groundCellAlong([bx, by, ray.o[2] + this.io.oz()], ray.d, 1200);
    if (c0 >= 0) return { cell: c0, level: 0 };
    const bc = groundCol >= 0 ? this.windowToBoxCol(groundCol) : -1;
    const c = bc >= 0 ? this.town.grid.cellOf[bc] : -1;
    return c >= 0 ? { cell: c, level: 0 } : null;
  }

  /** (round 128d) Inspect a structure (null: close the card): it's drawn highlighted. */
  inspect(id: number | null): void {
    if (id !== null && !this.plan.structure(id)) id = null;
    if (id === this.inspected) return;
    this.inspected = id;
    this.io.changed(false);
    for (const h of this.onChange) h();
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
      // (onetown: the town's own buildings are the plan's structures — Inspect reads them as the player's)
      const b = this.pick(ray, groundCol) ?? this.groundPick(ray, groundCol);
      const id = b && this.plan.owner[b.cell] >= 0 ? this.plan.owner[b.cell] : null;
      this.inspect(id);
      if (id === null) for (const h of this.onChange) h();
      return id !== null;
    }
    const b = this.pick(ray, groundCol);
    if (!b) return false;
    if (this.tool.tower) {
      const on = !this.plan.tower[b.cell];
      return this.apply(() => this.plan.setTower(b.cell, on), b.cell);
    }
    if (this.tool.gate) {
      const on = !this.plan.gate[b.cell];
      return this.setGate(b.cell, on);
    }
    if (this.tool.erase) return this.erase(b.cell, b.level);
    return this.paint(b.cell, b.level, this.tool.type);
  }

  paint(cell: number, level: number, type: StructureType): boolean {
    // (round 128l, m4; the user: "Why do fortress blocks take so long? They seem like they should be as fast as any other
    // block") a tap puts the block in at once: nothing waits on the reach. (RT-6, round 128m: "I would refuse it but in
    // general we should not have blocks that agents can't reach") It's pending — drawn as the plan's ghost — until the
    // GPU's answer a few frames later (reachgpu.ts) judges it: reached, or reached once a variant keeps the way open (a
    // gate, a passage, a ramp — V128-13), it stays; else it's taken out and the panel says why (judgeBatch). Taps while
    // a check is in flight, and placements of many blocks at once, are judged together: only the blocks out of reach go
    const before = this.pending.size ? null : this.reachedSet();
    if (!this.apply(() => this.plan.paint(cell, level, type), cell)) return false;
    // (a block stacked on one already planned changes nobody's reach; on a pending one it goes with it)
    if (level === 0 && this.io.reach) {
      if (before) this.pendingBefore = before;
      this.pending.add(cell);
    }
    return true;
  }

  /** (RT-6) Many blocks placed at once (a drag): each as a tap, judged together. How many went in (before the judging). */
  paintMany(cells: readonly number[], level: number, type: StructureType): number {
    let n = 0;
    for (const c of cells) if (this.paint(c, level, type)) n++;
    return n;
  }

  /** (RT-6) whether a block is still waiting for the reach's judgement (drawn as a ghost) */
  isPending(cell: number): boolean {
    return this.pending.has(cell);
  }

  // ---- the reach (round 128l, m4: connected components on the GPU — reachgpu.ts, shaders/fortreach.wgsl) ----

  /** the cells still to build the last answer had reached */
  private reachedSet(): Set<number> {
    const out = new Set<number>();
    for (const [c, b] of this.reachBits) if (b & 1) out.add(c);
    return out;
  }

  /** whether the last answer reached a cell still to build (true: not asked, or no answer yet) */
  reachedNow(cell: number): boolean {
    const b = this.reachBits.get(cell);
    return b === undefined || (b & 1) === 1;
  }

  /**
   * (round 128l) the cells still to build the last answer didn't reach, and (RT-6) the blocks not judged yet:
   * FortressCrowd leaves them out of the sites
   */
  cutCells(): Set<number> {
    const out = new Set<number>(this.pending);
    for (const [c, b] of this.reachBits) if (!(b & 1)) out.add(c);
    return out;
  }

  /**
   * Ask for the reach again (the plan changed, a few seconds of building, a slide, planning started): one check in
   * flight at a time, the asks meanwhile folded into the next. `wet`: the water's columns too (the lanes).
   */
  requestReach(wet = false): void {
    this.reachWet ||= wet;
    this.reachWant = true;
    if (!this.reachBusy && this.io.reach) {
      this.reachBusy = true;
      void this.pumpReach();
    }
  }

  /** resolves when no check is in flight or wanted and no variant is being tried (tests, the lab) */
  async settled(): Promise<void> {
    while (this.reachBusy || this.reachWant || this.trial) await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * (scripted checks, the lab) Whether the stores reach each of these cells now (any cell, planned or not: its stands), by
   * a check of its own once the pending ones are done. Null: no reach engine.
   */
  async probeReach(cells: number[]): Promise<boolean[] | null> {
    const R = this.io.reach;
    if (!R) return null;
    await this.settled();
    this.reachBusy = true;
    try {
      R.setSpans(this.spansNow());
      const reply = await R.check(this.reachAsk(cells, false, false));
      return cells.map((_, i) => (reply.bits[i] & 1) === 1);
    } finally {
      this.reachBusy = false;
      if (this.reachWant) this.requestReach();
    }
  }

  private async pumpReach(): Promise<void> {
    const R = this.io.reach!;
    try {
      // (the asks of this frame folded into one: the press that asked has set its edit by now)
      await Promise.resolve();
      while (this.reachWant) {
        this.reachWant = false;
        const wet = this.reachWet;
        this.reachWet = false;
        const edit = this.edit;
        this.edit = null;
        const trial = this.trial;
        // (the pending blocks this answer judges: none while a variant is on trial — the plan has the variant in it)
        const batch = trial ? null : this.pending.size ? { cells: [...this.pending], before: this.pendingBefore ?? new Set<number>() } : null;
        const t0 = performance.now();
        R.setSpans(this.spansNow());
        const cells = this.todoCells();
        const ask = this.reachAsk(cells, wet, !!edit || !!batch);
        this.reachStats.cpuMs = performance.now() - t0;
        let reply: ReachReply;
        try {
          reply = await R.check(ask);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          throw e;
        }
        this.answer(cells, reply, edit, trial, batch);
      }
    } finally {
      this.reachBusy = false;
    }
  }

  /** the box column under box world (x, y) (-1: none) */
  private boxColOf(x: number, y: number): number {
    const [k, r] = cellAt(x, y);
    return k < 0 || r < 0 || k >= this.box.w || r >= this.box.h ? -1 : r * this.box.w + k;
  }

  /**
   * (round 128o) The reach's question for these cells: each one's stands (up to four box columns) with their floors —
   * the land's ground there as the town has it, window z — and the stores' column and floor.
   */
  reachAsk(cells: readonly number[], wet: boolean, why: boolean): ReachAsk {
    const oz = this.io.oz();
    const queries = new Int32Array(cells.length * 4).fill(-1);
    const floors = new Float32Array(cells.length * 4);
    cells.forEach((c, i) =>
      (c >= 0 ? this.standCols(c) : []).forEach((b, k) => {
        queries[i * 4 + k] = b;
        floors[i * 4 + k] = this.groundOfCol(b) - oz;
      }),
    );
    const at = this.storesAt();
    const sc = at ? this.boxColOf(...this.toBox(at[0], at[1])) : -1;
    return { stores: sc >= 0 ? [sc % this.box.w, Math.floor(sc / this.box.w)] : null, storesZ: sc >= 0 ? this.groundOfCol(sc) - oz : 0, queries, floors, wet, why };
  }

  /**
   * (round 128o) A stand's floor (window z): the land's ground at window world (x, y) as the town has it — what a
   * builder stands on there, under a passage's arch too (the reach's query and the builders' field seed alike)
   */
  standFloor(x: number, y: number): number {
    const b = this.boxColOf(...this.toBox(x, y));
    return b >= 0 ? this.groundOfCol(b) - this.io.oz() : 1e4;
  }

  /** a cell's stands' box columns (up to four) */
  private standCols(cell: number): number[] {
    return this.standsOf(cell)
      .map(([x, y]) => this.boxColOf(...this.toBox(x, y)))
      .filter((b) => b >= 0)
      .slice(0, 4);
  }

  /**
   * The plan's solid as if built (solid.ts: a block its cell, a wall its band, a gate open under its lintel, the stairs,
   * the ramps): two spans a box column, packed for the reach (more than two in a column: the last two merged).
   */
  private spansNow(): Uint32Array {
    const plan = this.plan;
    const town: Town = Object.create(this.town);
    Object.defineProperty(town, 'built', { value: { each: (c: number) => plan.levels.each(c) } });
    const { w, h } = this.box;
    const out = new Uint32Array(w * h * 2);
    // (the town's z is the world's; the reach's columns are the window's)
    const oz = this.io.oz();
    for (const spans of solidSpans({ plan, town, grid: this.grid, ground: this.groundOfCol, ways: this.ways() }).values())
      for (const q of spans) {
        if (q.x < 0 || q.y < 0 || q.x >= w || q.y >= h) continue;
        const i = 2 * (q.y * w + q.x);
        const p = packSpan(q.z0 - oz, q.z1 - oz);
        if (!out[i]) out[i] = p;
        else if (!out[i + 1]) out[i + 1] = p;
        else {
          const o = out[i + 1];
          out[i + 1] = (Math.min(o & 0xffff, p & 0xffff) | (Math.max(o >>> 16, p >>> 16) << 16)) >>> 0;
        }
      }
    return out;
  }

  /** an answer come back: the cells' bits; the variant on trial, the gate shut or the pending blocks it judges */
  private answer(cells: number[], reply: ReachReply, edit: GateEdit | null, trial: Trial | null, batch: { cells: number[]; before: Set<number> } | null): void {
    this.reachBits = new Map(cells.map((c, i) => [c, reply.bits[i]]));
    this.reachRamps = reply.ramps;
    this.reachStats.rounds = reply.rounds;
    this.reachStats.checks++;
    this.reachKnown = true;
    if (reply.wet) {
      const was = this.wetBits;
      this.wetBits = reply.wet;
      if (!was || was.some((v, i) => v !== reply.wet![i])) this.waysMemo = null;
    }
    if (trial && trial === this.trial) this.judgeTrial();
    else if (!this.trial) {
      if (edit) this.judgeGate(edit);
      if (batch) this.judgeBatch(batch.cells, batch.before);
    }
    for (const h of this.onReach) h();
    for (const h of this.onChange) h();
  }

  /** why the stores don't reach a cell (the last answer's bits: the solve again with deep water, then the plan, lifted) */
  whyNot(cell: number): ReachWhy {
    if (!this.standsOf(cell).length) return 'walled';
    const b = this.reachBits.get(cell) ?? 0;
    if (b & REACH_BITS.none) return 'far';
    if (b & REACH_BITS.dry) return 'deep';
    if (b & REACH_BITS.unplanned) return 'walled';
    return 'cliff';
  }

  /** (round 128f) a gate shut that shuts blocks off from the stores opens again */
  private judgeGate(e: GateEdit): void {
    const cut = [...e.before].filter((c) => !this.pending.has(c) && !this.reachedNow(c));
    if (!cut.length) return;
    this.plan.setGate(e.cell, true);
    this.sync();
    this.refusal = wouldCutLine([...new Set(cut.map((c) => this.plan.typeAt(c)!))]);
  }

  /**
   * (RT-6; V128-13) The pending blocks an answer judges: all reached and nothing cut off — they stay. Else the variants
   * that keep the way open are tried (a gate in a wall the batch closed, a passage through a block of it, a ramp up a
   * drop to a block below it or to what it cut off); then what's still out of reach is refused (judged).
   */
  private judgeBatch(cells: number[], before: Set<number>): void {
    const batch = cells.filter((c) => this.pending.has(c));
    if (!batch.length) return;
    const cut = [...before].filter((c) => !this.pending.has(c) && this.reachBits.has(c) && !this.reachedNow(c));
    const out = batch.filter((c) => !this.reachedNow(c));
    if (!cut.length && !out.length) return this.judged(batch, []);
    // (a block of the batch below a drop: a ramp up it. Walled in by the plan — a ring of wall the batch closed, with
    // cells a builder can only stand inside of: a gate in it, or a passage)
    const why = new Map(out.map((c) => [c, this.whyNot(c)]));
    const cliff = out.filter((c) => why.get(c) === 'cliff');
    const walled = out.filter((c) => why.get(c) === 'walled');
    const tries = this.rampTries(cliff);
    if (cut.length || walled.length) tries.push(...this.wayTries(batch), ...this.rampTries(cut));
    if (!tries.length) return this.judged(batch, cut);
    this.trial = { tries, i: 0, cut, mend: [...cliff, ...walled], batch, base: new Map(this.reachBits) };
    this.nextTry();
  }

  /**
   * The batch judged on the last answer (the plan as it is): it cut planned blocks off — the whole batch is refused
   * (the edit that cut them off); else its blocks out of reach are refused and the rest stay. The panel says why.
   */
  private judged(batch: number[], cut: number[]): void {
    const live = batch.filter((c) => this.pending.has(c));
    if (cut.length) {
      this.refusal = wouldCutLine([...new Set(cut.map((c) => this.plan.typeAt(c)).filter((t): t is StructureType => !!t))]);
      return this.refuse(live);
    }
    const out = live.filter((c) => !this.reachedNow(c));
    if (out.length) {
      // (the most common reason among them)
      const count = new Map<ReachWhy, number>();
      for (const c of out) count.set(this.whyNot(c), (count.get(this.whyNot(c)) ?? 0) + 1);
      const why = [...count].sort((a, b) => b[1] - a[1])[0][0];
      this.refusal = refusedLine(out.length, live.length, why);
    }
    const kept = live.filter((c) => this.reachedNow(c));
    for (const c of kept) this.pending.delete(c);
    // (blocks placed since, judged by a later answer, may not cut these off either)
    if (this.pending.size) for (const c of kept) this.pendingBefore?.add(c);
    this.refuse(out);
  }

  /** blocks taken out of the plan again (every level of their cells), no longer pending */
  private refuse(cells: number[]): void {
    for (const c of cells) {
      this.pending.delete(c);
      for (const l of [...this.plan.levels.each(c)].sort((a, b) => b - a)) this.plan.erase(c, l);
    }
    if (!this.pending.size) this.pendingBefore = null;
    if (!cells.length) return;
    if (this.selected !== null && !this.plan.structure(this.selected)) this.selected = null;
    this.waysMemo = null;
    this.sync();
  }

  /** the gates in the walls the batch closed (their straight cells nearest the stores first), passages through its blocks */
  private wayTries(batch: number[]): Try[] {
    const out: Try[] = [];
    const at = this.storesAt();
    const walls = new Set<number>();
    for (const cell of batch) {
      const type = this.plan.typeAt(cell);
      if (!type) continue;
      const form = DEFS[type].form;
      if (form === 'wall') {
        const s = this.plan.structureAt(cell);
        if (!s || !at || walls.has(s.id)) continue;
        walls.add(s.id);
        const cs = [...s.cells.keys()]
          .filter((c) => !this.plan.gate[c] && this.plan.levels.bottom(c) === 0 && this.plan.wallTile(c, 0) === 'straight')
          .sort((a, b) => dist(this.centre(a), at) - dist(this.centre(b), at))
          .slice(0, VARIANT_TRIES);
        for (const c of cs) out.push({ kind: 'gate', at: c, type, on: () => this.plan.setGate(c, true), off: () => void this.plan.setGate(c, false) });
      } else if (form === 'block') out.push({ kind: 'passage', at: cell, type, on: () => this.plan.setPassage(cell, true), off: () => void this.plan.setPassage(cell, false) });
    }
    return out;
  }

  /**
   * (round 128h, V128-13) Ramps up the drops in the way: the free cells under a drop of STEP to DROP up to the stores'
   * ground (the last answer's ramp spots), nearest the cells first.
   */
  private rampTries(cells: number[]): Try[] {
    if (!cells.length) return [];
    const g = this.grid;
    const { w } = this.box;
    const [ox, oy] = this.offset();
    const targets = cells.map((c) => this.centre(c));
    const seen = new Set<number>();
    const tries: { cell: number; side: number; d: number }[] = [];
    for (const { col, dir } of this.reachRamps) {
      const x = (col % w) + ox;
      const y = Math.floor(col / w) + oy;
      const [qx, qy] = nbr(x, y, dir);
      const c = g.cellOf[col];
      const qb = (qy - oy) * w + (qx - ox);
      const n = qx - ox >= 0 && qx - ox < w && qy - oy >= 0 && qy - oy < this.box.h ? g.cellOf[qb] : -1;
      // (on a free cell: not a planned one — the batch's own are planned)
      if (c < 0 || n < 0 || c === n || this.plan.owner[c] >= 0 || this.plan.ramp[c] >= 0) continue;
      const side = [0, 1, 2, 3].find((e) => g.nbr[c * 4 + e] === n);
      if (side === undefined || seen.has(c * 4 + side)) continue;
      seen.add(c * 4 + side);
      const [wx, wy] = cellPos(x, y);
      tries.push({ cell: c, side, d: Math.min(...targets.map((t) => dist([wx, wy], t))) });
    }
    tries.sort((a, b) => a.d - b.d);
    return tries.slice(0, VARIANT_TRIES).map((t) => ({ kind: 'ramp' as const, at: t.cell, type: 'house' as const /* (a ramp's line names no structure) */, on: () => this.plan.setRamp(t.cell, t.side), off: () => void this.plan.setRamp(t.cell, -1) }));
  }

  /** the variant on trial put in the plan and checked (none left: the batch judged as the plan is without them) */
  private nextTry(): void {
    const t = this.trial!;
    while (t.i < t.tries.length && !t.tries[t.i].on()) t.i++;
    if (t.i >= t.tries.length) {
      this.trial = null;
      // (every variant taken out again: the plan is as the batch's own answer judged it)
      this.reachBits = t.base;
      this.waysMemo = null;
      this.sync();
      this.judged(t.batch, t.cut);
      return;
    }
    this.waysMemo = null;
    this.sync();
  }

  private judgeTrial(): void {
    const t = this.trial!;
    const tr = t.tries[t.i];
    // (kept: everything the batch cut off reached again, and — when it cut nothing — one of its own blocks out of reach
    // reached; the rest of those are refused)
    if (t.cut.every((c) => this.reachedNow(c)) && (t.cut.length > 0 || t.mend.some((c) => this.reachedNow(c)))) {
      this.trial = null;
      this.kept(tr.kind, tr.type, tr.at);
      // (the way kept open: the batch's blocks still out of reach — not below a drop — are refused)
      this.judged(t.batch, []);
      return;
    }
    tr.off();
    this.waysMemo = null;
    t.i++;
    this.nextTry();
  }

  /** a press while a variant is on trial: the trial's variant taken out, the trial dropped (its batch still pending) */
  private abortTrial(): void {
    const t = this.trial;
    if (!t) return;
    this.trial = null;
    if (t.i < t.tries.length) t.tries[t.i].off();
    this.waysMemo = null;
    this.sync();
  }

  private kept(kind: VariantKind, type: StructureType, at: number): void {
    this.variant = variantLine(kind, type);
    this.variantAt = at;
    this.sync();
  }

  erase(cell: number, level: number): boolean {
    // (RT-6: erasing takes solid away and frees the sides builders stand at — it cuts nothing off; a pending block
    // erased is forgotten)
    if (!this.apply(() => this.plan.erase(cell, level), cell)) return false;
    if (!this.plan.has(cell, 0) && this.pending.delete(cell) && !this.pending.size) this.pendingBefore = null;
    return true;
  }

  setGate(cell: number, on: boolean): boolean {
    // (round 128f) a gate shut that shuts blocks off from the stores opens again (judged on the answer: judgeGate)
    const before = !on && this.plan.gate[cell] ? this.reachedSet() : null;
    if (!this.apply(() => this.plan.setGate(cell, on), cell)) return false;
    if (before) this.edit = { cell, before };
    return true;
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
   * no planned or built block's ground level covers (a yard's is open ground) (FortressCrowd's stands, the same). `also`: a cell about to be planned.
   */
  standsOf(cell: number, also = -1): [number, number][] {
    const g = this.grid;
    const [cx, cy] = g.centre(cell);
    const out: [number, number][] = [];
    for (let e = 0; e < 4; e++) {
      const n = g.nbr[cell * 4 + e];
      if (n < 0 || n === also) continue;
      // (a yard beside it — a farm, the quarry — is open ground a builder stands on; round 128o: and a block's passage,
      // under its arch — build/entrances.ts openCell, the rule a structure is entered by)
      const t = this.plan.typeAt(n);
      if ((this.plan.has(n, 0) || this.town.has(n, 0)) && !(t && DEFS[t].form === 'yard') && !openCell(this.plan, n)) continue;
      const [ax, ay] = g.corner(cell, e);
      const [bx, by] = g.corner(cell, e + 1);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const d = Math.hypot(mx - cx, my - cy) || 1;
      out.push(this.toWindow(mx + ((mx - cx) / d) * 1.4, my + ((my - cy) / d) * 1.4));
    }
    return out;
  }

  /** (round 128f) the cells with blocks still to build (their ground: a builder works from beside it) */
  todoCells(): number[] {
    const out: number[] = [];
    for (const s of this.plan.structures()) for (const c of s.cells.keys()) if ([...this.plan.levels.each(c)].some((l) => !this.town.has(c, l))) out.push(c);
    return out;
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

  /** (round 128d) Planning or building: what the view draws (see-through blocks still to build only while building). */
  setMode(m: FortressMode): void {
    if (this.mode === m) return;
    this.mode = m;
    for (const h of this.onMode) h(m);
    this.io.changed(false);
    for (const h of this.onChange) h();
  }

  /** While building: whether a block of the plan is still to build (null while planning: the plan drawn whole). */
  ghost(): ((cell: number, level: number) => boolean) | undefined {
    // (RT-6: while planning, the blocks the reach hasn't judged yet)
    if (this.mode !== 'build') return this.pending.size ? (c) => this.pending.has(c) : undefined;
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
    this.io.changed(false);
    for (const h of this.onChange) h();
  }

  /** A block's cost is in: it stands (milestone 2's builders, townwork.ts). */
  markBuilt(cell: number, level: number): void {
    const s = this.plan.structureAt(cell);
    if (!s || !this.town.add(cell, level, s.id, typeIndex(s.type))) throw new Error(`fortress: block ${cell}:${level} couldn't stand`);
    this.begun.delete(`${cell}:${level}`);
    // (what grew back on it since it was planned goes as it stands)
    this.clearPlants([cell]);
    this.io.changed(true);
    for (const h of this.onChange) h();
  }

  /**
   * (round 128l, m4: the attack wave) A built block broken (bashed by raiders, burned): it and every built level over it
   * come down, and stay in the plan — planned blocks again, so the builders repair them as they build anything (the job
   * board; the stores pay their cost again). Returns the levels that came down (none: nothing stood there).
   */
  breakBlock(cell: number, level = 0): number[] {
    const s = this.plan.structureAt(cell);
    const down = [...this.town.built.each(cell)].filter((l) => l >= level).sort((a, b) => b - a);
    for (const l of down) {
      this.town.remove(cell, l);
      // (Town.remove takes it out of the Town's plan too: the painted plan still has it — planned again)
      if (s && this.plan.has(cell, l)) this.town.plan(cell, l, true, s.id, typeIndex(s.type));
      this.begun.delete(`${cell}:${l}`);
    }
    if (!down.length) return down;
    this.io.changed(true);
    for (const h of this.onBroken) h(cell, down);
    for (const h of this.onChange) h();
    return down;
  }

  /**
   * (onetown) A structure's claim was cut (dug out, smashed, hanging free — build/claims.ts): it comes down, its blocks
   * planned again, as a raid's breach — the builders mend it.
   */
  lose(id: number): void {
    const s = this.plan.structure(id);
    if (s) for (const c of s.cells.keys()) this.breakBlock(c, 0);
  }

  /** (m4) told when blocks are broken (the cell, the levels) */
  readonly onBroken: ((cell: number, levels: number[]) => void)[] = [];

  /**
   * (m4: the attack wave) The gates shut: each gate cell is solid wall to the ground (claims.ts, solid.ts) and drawn
   * shut (pieces.ts) — nobody walks through until they open again.
   */
  gatesShut = false;
  setGatesShut(on: boolean): void {
    if (this.gatesShut === on) return;
    this.gatesShut = on;
    this.io.changed(true);
    for (const h of this.onChange) h();
  }

  /** (FT-20) How many blocks the builders can't reach now (FortressCrowd): the bar says so. */
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

  /** (round 128d) Power a day from the fortress's built blocks (bigger and higher give more: TownPlan.power). */
  powerPerDay(): number {
    let p = 0;
    for (const s of this.plan.structures()) p += this.plan.power(s, (c, l) => this.town.has(c, l));
    return p;
  }

  stores(): Goods {
    return this.io.stores();
  }

  private apply(f: () => boolean, cell: number): boolean {
    if (!this.ready) return false;
    this.abortTrial();
    if (!f()) return false;
    this.refusal = null;
    this.variant = null;
    this.variantAt = -1;
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
        // (milestone 3: a block leaving the plan, built or not: what it cost goes back, in part — FortressCrowd)
        if (!want && (this.town.has(c, l) || this.town.planned(c, l))) {
          const run = this.town.built.at(c, l) ?? this.town.plans.at(c, l);
          if (run) erased.push({ cell: c, level: l, type: STRUCTURE_TYPES[run.type], built: this.town.has(c, l) });
        }
        if (want !== this.town.planned(c, l)) this.town.plan(c, l, want, owner, type);
        if (!want) this.begun.delete(`${c}:${l}`);
        // (a built block erased from the plan comes down at once: taking down is a later milestone's work)
        if (!want && this.town.has(c, l)) this.town.remove(c, l);
      }
      // (round 128m: a cell no pit holds any more keeps no dug tiers — its quarry erased; the ground stays as dug)
      if (!this.plan.pit.any(c)) this.dug.clearCell(c);
      // (structures folded into one: the Town's runs take the plan's owner)
      this.town.plans.ownAll(c, owner, type);
      this.town.built.ownAll(c, owner, type);
    }
    // (FT-26) the trees go from the cells painted and the cells round them (a courtyard among them)
    this.clearPlants(changed);
    // (what stands may have come down; the ways' stairs moved: claimed again)
    if (changed.length) this.io.changed(true);
    for (const e of erased) for (const h of this.onErased) h(e);
    // (round 128l) the reach asked again: answered a few frames later
    if (changed.length) this.requestReach();
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
}
