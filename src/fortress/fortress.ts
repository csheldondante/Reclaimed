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
import { cellAt, cellPos } from '../world/lattice';
import { DEFS } from './defs';
import { typeIndex, type TownPlan } from '../build/plan';
import { pickFace, placeFor } from './pick';
import { shapesOf } from '../build/shapes';
import { groundSteps, waysOf, waysNav, type Ways } from '../build/ways';
import type { NavGraph } from '../api/contracts/structures';
import { LEVEL_H } from '../build/town';
import { bedsOf, roomOf } from './economy';
import { REACH_BITS, type ReachAsk, type ReachEngine, type ReachFix, type ReachReply } from '../build/reach';
import { applyReachFixes, realiseTown, siteRampRise, siteSpans, standsOfCell } from '../build/sitereach';
import { assertEntered } from '../structures/place';
import { refusedLine, variantLine, wouldCutLine, type ReachWhy, type VariantKind } from './words';
import { laneGraph, lanesOf, roadShapesOf, type Lanes } from '../build/lanes';
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

// (round 128i) water deeper than LANE_WATER (0.8 m: fortreach.wgsl R_LANE_WATER, the reach's wet columns) over a cell's
// middle or a corner: no roads on it. (round 128k: was 0.3 — a river cut the roads off from the sites the builders
// reached by wading; now the agents' own limit, a ford is a way: agents.wgsl DEEP_OFF)

/** (round 128l, m4) a gate shut, judged by the next reach answer: the cells reached before it */
interface GateEdit {
  cell: number;
  before: Set<number>;
}


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
  private wetBits: Uint32Array | null = null;
  private reachBusy = false;
  private reachWant = false;
  private reachWet = false;
  private edit: GateEdit | null = null;
  /**
   * (round 128o, B) a batch whose fixes went into the plan (passages, gates, ramps: the answer's cheapest way): the next
   * answer judges it for good — reached, it stays; still out, it's refused (never fixed again)
   */
  private fixed: { batch: number[]; cut: number[]; left: number } | null = null;
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
    while (this.reachBusy || this.reachWant) await new Promise((r) => setTimeout(r, 0));
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
      R.setSpans(this.spansNow(), siteRampRise(this));
      const reply = await R.check(this.reachAsk(cells, false, false));
      return cells.map((_, i) => (reply.bits[i] & 1) === 1);
    } finally {
      this.reachBusy = false;
      if (this.reachWant) this.requestReach();
    }
  }

  /**
   * (round 128o, B: generation through the one reach) The town's own places — each structure's way out of its entrance —
   * joined to its stores: what the generated town left out of reach gets its cheapest fix in the plan (a passage, a
   * gate, a ramp: the town as generated, built). Once its land is in the window (startFortress). Null: no reach engine.
   */
  async joinTown(): Promise<{ out: number; fixes: number; asks: number; dropped: number; graded: number; steep: number } | null> {
    const R = this.io.reach;
    const at = this.storesAt();
    if (!R || !at) return null;
    await this.settled();
    this.reachBusy = true;
    try {
      const oz = this.io.oz();
      const sc = this.boxColOf(...this.toBox(at[0], at[1]));
      if (sc < 0) return null;
      // (round 128o, DA-A11: the town as generated realised — every structure's way in joined to the stores, what nothing
      // reaches dropped from the plan and logged; keepReach is gone)
      const res = await realiseTown({
        engine: R,
        solid: () => ({ plan: this.plan, town: this.town, grid: this.grid, box: this.box, ground: this.groundOfCol, ways: this.ways(), oz }),
        origin: () => this.offset(),
        colAt: ([x, y]) => this.boxColOf(x, y),
        floorAt: (b) => this.groundOfCol(b) - oz,
        stores: sc,
        storesZ: this.groundOfCol(sc) - oz,
        changed: () => {
          this.waysMemo = null;
          this.sync();
        },
      });
      assertEntered(this.site);
      return { out: res.out, fixes: res.fixes, asks: res.asks, dropped: res.dropped, graded: res.graded, steep: res.steep };
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
        // (the pending blocks this answer judges)
        const batch = this.pending.size ? { cells: [...this.pending], before: this.pendingBefore ?? new Set<number>() } : null;
        const t0 = performance.now();
        R.setSpans(this.spansNow(), siteRampRise(this));
        const cells = this.todoCells();
        const ask = { ...this.reachAsk(cells, wet, !!edit || !!batch), fix: !!batch };
        this.reachStats.cpuMs = performance.now() - t0;
        let reply: ReachReply;
        try {
          reply = await R.check(ask);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          throw e;
        }
        this.answer(cells, reply, edit, batch);
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
    // (round 128o, B: a cell with no side open is asked by the sides a passage would open — not reached till one is)
    const open = new Uint8Array(cells.length);
    cells.forEach((c, i) => {
      if (c < 0) return;
      if (!this.standsOf(c).length) open[i] = 1;
      this.standCols(c).forEach((b, k) => {
        queries[i * 4 + k] = b;
        floors[i * 4 + k] = this.groundOfCol(b) - oz;
      });
    });
    const at = this.storesAt();
    const sc = at ? this.boxColOf(...this.toBox(at[0], at[1])) : -1;
    return { stores: sc >= 0 ? [sc % this.box.w, Math.floor(sc / this.box.w)] : null, storesZ: sc >= 0 ? this.groundOfCol(sc) - oz : 0, queries, floors, wet, why, open };
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
    // (round 128o, B: a cell with no side open — blocks all round it — is asked by the sides a passage would open: the
    // fix field cuts through to them, and the passage made, they're its stands)
    const stands = this.standsOf(cell);
    return (stands.length ? stands : this.standsOf(cell, -1, true))
      .map(([x, y]) => this.boxColOf(...this.toBox(x, y)))
      .filter((b) => b >= 0)
      .slice(0, 4);
  }

  /**
   * The plan's solid as if built (solid.ts: a block its cell, a wall its band, a gate open under its lintel, the stairs,
   * the ramps): two spans a box column, packed for the reach (more than two in a column: the last two merged).
   */
  private spansNow(): Uint32Array {
    return siteSpans({ plan: this.plan, town: this.town, grid: this.grid, box: this.box, ground: this.groundOfCol, ways: this.ways(), oz: this.io.oz() });
  }

  /** an answer come back: the cells' bits; the gate shut or the pending blocks it judges (with the fixes it found) */
  private answer(cells: number[], reply: ReachReply, edit: GateEdit | null, batch: { cells: number[]; before: Set<number> } | null): void {
    this.reachBits = new Map(cells.map((c, i) => [c, reply.bits[i]]));
    this.reachStats.rounds = reply.rounds;
    this.reachStats.checks++;
    this.reachKnown = true;
    if (reply.wet) {
      const was = this.wetBits;
      this.wetBits = reply.wet;
      if (!was || was.some((v, i) => v !== reply.wet![i])) this.waysMemo = null;
    }
    if (edit) this.judgeGate(edit);
    if (batch) this.judgeBatch(cells, reply, batch.cells, batch.before);
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
   * (RT-6; round 128o, B) The pending blocks an answer judges: all reached and nothing cut off — they stay. Else the
   * answer's fixes (the cheapest way the GPU found from each place out of reach to the stores: passages, gates, ramps)
   * go into the plan, and the next answer judges the batch for good. A batch already fixed is judged for good now.
   */
  private judgeBatch(cells: number[], reply: ReachReply, batchCells: number[], before: Set<number>): void {
    const fixed = this.fixed;
    this.fixed = null;
    // (a batch fixed: the places still out of reach — fewer than before each fix, or it's judged as it is)
    if (fixed) {
      batchCells = batchCells.filter((c) => !fixed.batch.includes(c));
      const batch = fixed.batch.filter((c) => this.pending.has(c));
      const cut = fixed.cut.filter((c) => this.reachBits.has(c) && !this.reachedNow(c));
      const out = batch.filter((c) => !this.reachedNow(c));
      if ((cut.length || out.length) && cut.length + out.length < fixed.left && this.fixOne(cells, reply, [...out, ...cut])) this.fixed = { batch, cut: fixed.cut, left: cut.length + out.length };
      else this.judged(batch, cut);
    }
    const batch = batchCells.filter((c) => this.pending.has(c));
    if (!batch.length) return this.fixed ? void this.sync() : undefined;
    const cut = [...before].filter((c) => !this.pending.has(c) && this.reachBits.has(c) && !this.reachedNow(c));
    const out = batch.filter((c) => !this.reachedNow(c));
    if (!cut.length && !out.length) return this.judged(batch, []);
    if (this.fixed || !this.fixOne(cells, reply, [...out, ...cut])) return this.judged(batch, cut);
    this.fixed = { batch, cut, left: cut.length + out.length };
    this.sync();
  }

  /**
   * The fixes on the way from one place out of reach (the first the answer has fixes for) into the plan: one way opened
   * at a time — a pocket's gate reaches every place in it, the next answer says which are still out. Whether any went in.
   */
  private fixOne(cells: number[], reply: ReachReply, places: number[]): boolean {
    const want = new Set(places);
    for (let q = 0; q < cells.length; q++) {
      if (!want.has(cells[q])) continue;
      const mine = reply.fixes.filter((f) => f.query === q);
      if (mine.length && this.applyFixes(mine)) {
        this.waysMemo = null;
        return true;
      }
    }
    return false;
  }

  /** the fixes into the plan (each once); the first's line on the panel. How many went in. */
  private applyFixes(fixes: ReachFix[]): number {
    return applyReachFixes(this.plan, this.grid, this.box, this.offset(), fixes, (kind, type, cell) => this.noteFix(kind, type, cell));
  }

  /** the panel's line for the first fix of a press, and its cell */
  private noteFix(kind: VariantKind, type: StructureType, at: number): void {
    if (this.variant) return;
    this.variant = variantLine(kind, type);
    this.variantAt = at;
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
  standsOf(cell: number, also = -1, cut = false): [number, number][] {
    // (sitereach.ts standsOfCell: a yard beside it, a block's passage under its arch are open ground; `cut`: a side whose
    // neighbour the reach's fix may cut)
    return standsOfCell(this.plan, this.grid, (n) => this.town.has(n, 0), cell, also, cut).map(([x, y]) => this.toWindow(x, y));
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
