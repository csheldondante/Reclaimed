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
import { finishRoads, mainRoads, relayRoads, type TownRoads } from '../build/townroads';
import { DEEP } from '../agents/rules';
import { pickFace, placeFor } from './pick';
import { shapesOf } from '../build/shapes';
import { waysOf, type Ways } from '../build/ways';
import type { NavGraph } from '../api/contracts/structures';
import { bedsOf, roomOf } from './economy';
import { standsOfCell } from '../build/stands';
import { refusedLine, variantLine, wouldCutLine, type ReachWhy, type VariantKind } from './words';
import { DOOR_STEP, PATH_WIDTH } from '../build/edgenet';
import { MAIN_ROAD_WIDTH } from '../build/edgeview';
import { navOfRoutes, townRouteNet, type RouteNet } from '../agents/routes';
import { packRoadShapes, type RoadShape } from '../agents/roads';
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
   * (round 128p) the water's depth at window world (x, y): a town whose roads weren't laid with it (a lab recipe's) has
   * them laid with this (build/townroads.ts); absent: dry
   */
  water?(x: number, y: number): number;
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
  /** (round 128p, DA-A13) the town's roads as last laid (build/townroads.ts relayRoads): the reach is theirs */
  roads: TownRoads | null = null;
  /** a drag's blocks put in together: the roads laid again once, after */
  private batching = false;
  /** the roads have been laid (the lab waits for it) */
  reachKnown = false;
  readonly reachStats = { checks: 0, cpuMs: 0 };
  /** (round 128l) told after each answer (FortressCrowd: the cut-off blocks) */
  readonly onReach: (() => void)[] = [];
  private roadShapesMemo: { of: TownRoads | null; shapes: Float32Array } | null = null;
  private routeNetMemo: { of: TownRoads; net: RouteNet } | null = null;
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
   * (milestone 3, FT-46; round 128p) The road shapes the units' fields prefer, in the box's frame (agents/roads.ts
   * packRoadShapes): each drawn path a band its kind's width along its edge, each main road a band along its curve. The
   * same array until the roads are laid again.
   */
  roadShapes(): Float32Array {
    const r = this.roads;
    if (this.roadShapesMemo?.of !== r) {
      const out: RoadShape[] = [];
      const g = this.grid;
      const net = r?.net;
      if (net)
        for (let e = 0; e < net.kind.length; e++) {
          if (!net.kind[e]) continue;
          const a = net.ends[e * 2];
          const b = net.ends[e * 2 + 1];
          out.push({ a: [g.verts[a * 2], g.verts[a * 2 + 1]], b: [g.verts[b * 2], g.verts[b * 2 + 1]], half: PATH_WIDTH[net.kind[e]] / 2 });
        }
      for (const c of net?.curves ?? []) for (let k = 1; k < c.length; k++) out.push({ a: c[k - 1], b: c[k], half: MAIN_ROAD_WIDTH / 2 });
      this.roadShapesMemo = { of: r, shapes: packRoadShapes(out) };
    }
    return this.roadShapesMemo.shapes;
  }

  /**
   * (round 128p, DA-A13) The town's route net (agents/routes.ts): its paths, its main roads (a bridge's points at its
   * deck), its structures through their doors, in the box's frame, heights world z — the units ride routes over it. The
   * same object until the roads are laid again.
   */
  routeNet(): RouteNet | null {
    const r = this.roads;
    if (!r) return null;
    if (this.routeNetMemo?.of !== r) {
      this.routeNetMemo = { of: r, net: townRouteNet(this.site, r.net) };
    }
    return this.routeNetMemo.net;
  }

  /**
   * (milestone 3; round 128o) Where a built structure is entered (window world): the middle of the cell its entrance
   * opens from (build/entrances.ts). Null: none of its blocks stands, or it has no entrance (cut off: the ways say so).
   */
  doorOf(id: number): [number, number] | null {
    const s = this.plan.structure(id);
    if (!s || ![...s.cells.keys()].some((c) => this.town.built.any(c))) return null;
    // (round 128p: its door the roads' — the edge its lane leaves by: DOOR_STEP out from that side's middle, on its lane)
    const d = this.ways().doors.find((x) => x.structure === id);
    if (!d) return null;
    const g = this.grid;
    const a = g.corner(d.cell, d.side);
    const b = g.corner(d.cell, d.side + 1);
    const [cx, cy] = g.centre(d.cell);
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const L = Math.hypot(mx - cx, my - cy) || 1;
    return this.toWindow(mx + ((mx - cx) / L) * DOOR_STEP, my + ((my - cy) / L) * DOOR_STEP);
  }

  /**
   * (round 128d; the user: "buildings are supposed to bake their own paths") The plan's ways: roads and squares between
   * its doors, stairs up onto its walls, gates through them (ways.ts). From the plan, built or not.
   */
  ways(): Ways {
    if (!this.waysMemo) {
      const courts = shapesOf(this.plan, this.grid, (c) => this.town.base[c]).courtyards.flatMap((ct) => ct.cells);
      // (round 128i, 128o: no road under water — the deep cells as the roads' layout has them)
      const g = this.grid;
      const deep = new Set(this.plan.layout.roads?.deep ?? []);
      const blocked = (c: number) => deep.has(c);
      this.waysMemo = waysOf(this.plan, g, { courtyards: courts, blocked });
    }
    return this.waysMemo;
  }

  /** (round 128p) The roads as a nav graph (box frame; world z): the drawn paths, the doors to the ground floors. */
  nav(): NavGraph {
    const n = this.routeNet();
    return n ? navOfRoutes(this.site, n, this.ways()) : { nodes: [], links: [] };
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
    const r = this.plan.layout.roads;
    if (!r) return null;
    const c = this.grid.cellAtWorld(...this.toBox(x, y));
    return c >= 0 && r.deep.includes(c);
  }

  /** the box column under box world (x, y) (-1: none) */
  private boxColOf(x: number, y: number): number {
    const [k, r] = cellAt(x, y);
    return k < 0 || r < 0 || k >= this.box.w || r >= this.box.h ? -1 : r * this.box.w + k;
  }

  /** A stand's floor (window z): the land's ground at window world (x, y) as the town has it (the builders' field seed). */
  standFloor(x: number, y: number): number {
    const b = this.boxColOf(...this.toBox(x, y));
    return b >= 0 ? this.groundOfCol(b) - this.io.oz() : 1e4;
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
    // (round 128p, DA-A13: the reach is the town's roads' — build/townroads.ts relayRoads, a union-find over the paths on
    // the grid's edges: answered as the block goes in, no GPU, no waiting. The user: "in general we should not have
    // blocks that agents can't reach" — what nothing reaches is fixed if a gate can (a wall shut round it), else refused
    // and the panel says why in plain words)
    return this.paintMany([cell], level, type) > 0;
  }

  /** Many blocks placed at once (a drag): put in together, the roads laid again once, judged together. How many stayed. */
  paintMany(cells: readonly number[], level: number, type: StructureType): number {
    if (!this.ready) return 0;
    const before = this.reachedIds();
    const placed: number[] = [];
    this.batching = true;
    try {
      for (const c of cells) if (this.apply(() => this.plan.paint(c, level, type), c)) placed.push(c);
    } finally {
      this.batching = false;
    }
    if (!placed.length) return 0;
    this.sync();
    if (level === 0) this.judge(placed, before);
    for (const h of this.onChange) h();
    return placed.filter((c) => this.plan.has(c, level)).length;
  }

  // ---- the reach (round 128p, DA-A13: the roads' union-find — build/edgenet.ts) ----

  /** the structures the stores reach now */
  private reachedIds(): Set<number> {
    return new Set(this.roads?.net.reach.reachedIds ?? []);
  }

  /** whether the stores reach a cell's structure (a cell no structure holds: true) */
  reachedNow(cell: number): boolean {
    const s = this.plan.structureAt(cell);
    return !s || !this.roads || this.roads.net.reach.reachedIds.has(s.id) || this.plan.defs[s.type].form === 'wall';
  }

  /** the cells still to build whose structure the stores don't reach: FortressCrowd leaves them out of the sites */
  cutCells(): Set<number> {
    const out = new Set<number>();
    for (const c of this.todoCells()) if (!this.reachedNow(c)) out.add(c);
    return out;
  }

  /** The roads laid again (an edit's — sync does it — or a look after a slide): the reach told to whoever listens. */
  requestReach(): void {
    if (!this.roads) this.relay();
    for (const h of this.onReach) h();
  }

  /** (tests, the lab) the reach is answered as the plan changes: nothing to wait for */
  async settled(): Promise<void> {}

  /**
   * (scripted checks, the lab) Whether the stores reach each of these cells now: a structure's cell by its structure, an
   * open cell by its corners' component.
   */
  async probeReach(cells: number[]): Promise<boolean[]> {
    const r = this.roads?.net;
    if (!r) return cells.map(() => true);
    const { comp, storesRoot } = r.reach;
    return cells.map((c) => {
      if (this.plan.structureAt(c)) return this.reachedNow(c);
      return [0, 1, 2, 3].some((k) => comp[this.grid.quads[c * 4 + k]] === storesRoot);
    });
  }

  /** (the start town) what its generation left out of reach: its roads say (they were laid with it) */
  async joinTown(): Promise<{ out: number; fixes: number; asks: number }> {
    if (!this.roads) this.relay();
    return { out: this.roads?.net.reach.out.length ?? 0, fixes: 0, asks: 0 };
  }

  /** why the stores don't reach a cell's structure (the union-find again with each cut lifted: edgenet.ts reachOf) */
  whyNot(cell: number): ReachWhy {
    const s = this.plan.structureAt(cell);
    const why = s ? this.roads?.net.reach.out.find((o) => o.id === s.id)?.why : undefined;
    return why === 'wall' ? 'walled' : why === 'water' ? 'deep' : why === 'cliff' || why === 'terrace' ? 'cliff' : 'far';
  }

  /**
   * The blocks just placed (their cells): each one's structure the stores reach — else a gate in a wall shut round it, if
   * one joins it (the cheapest fix: a wall cell between its component and the stores', nearest it) — else refused, the
   * panel's line the commonest reason. Nor may they cut off what the stores reached before: then the lot is refused.
   */
  private judge(cells: number[], before: Set<number>): void {
    const net = () => this.roads?.net;
    if (!net()) return;
    // (nothing stands in deep water: a block there is refused — a bridge is a road's, not a block's)
    const deep = new Set(this.plan.layout.roads?.deep ?? []);
    const wet = cells.filter((c) => deep.has(c) && this.plan.typeAt(c) !== 'bridge');
    if (wet.length) {
      this.refusal = refusedLine(wet.length, cells.length, 'deep');
      this.refuse(wet);
      cells = cells.filter((c) => !wet.includes(c));
      if (!cells.length) return;
    }
    const ids = () => [...new Set(cells.map((c) => this.plan.structureAt(c)?.id).filter((x): x is number => x !== undefined))];
    const cut = () => [...before].filter((id) => this.plan.structure(id) && !net()!.reach.reachedIds.has(id));
    const out = () => ids().filter((id) => !net()!.reach.reachedIds.has(id) && this.plan.defs[this.plan.structure(id)!.type].form !== 'wall');
    // (a wall shut round them: a gate where it joins them to the stores — one at a time, the reach asked again after each)
    for (let tries = 0; tries < cells.length + 1 && (out().length || cut().length); tries++) {
      // (the nearest wall cell that joins them a gate can stand on: a straight stretch)
      const gate = this.gatesFor([...out(), ...cut()]).find((c) => this.plan.setGate(c, true));
      if (gate === undefined) break;
      this.noteFix('gate', this.plan.typeAt(gate) ?? 'wall', gate);
      this.sync();
    }
    const cutNow = cut();
    if (cutNow.length) {
      this.refusal = wouldCutLine([...new Set(cutNow.map((id) => this.plan.structure(id)!.type))]);
      return this.refuse(cells);
    }
    const left = out();
    if (!left.length) return;
    const outCells = cells.filter((c) => left.includes(this.plan.structureAt(c)?.id ?? -1));
    const count = new Map<ReachWhy, number>();
    for (const c of outCells) count.set(this.whyNot(c), (count.get(this.whyNot(c)) ?? 0) + 1);
    const why = [...count].sort((a, b) => b[1] - a[1])[0][0];
    this.refusal = refusedLine(outCells.length, cells.length, why);
    this.refuse(outCells);
  }

  /**
   * The wall cells (not gates yet) whose corners join a component these structures are in to the stores' one, nearest
   * them first.
   */
  private gatesFor(ids: number[]): number[] {
    const net = this.roads?.net;
    if (!net) return [];
    const { comp, storesRoot } = net.reach;
    const theirs = new Set<number>();
    const g = this.grid;
    let mx = 0;
    let my = 0;
    let n = 0;
    for (const id of ids) {
      const st = this.plan.structure(id);
      if (!st) continue;
      for (const c of st.cells.keys()) {
        for (let k = 0; k < 4; k++) theirs.add(comp[g.quads[c * 4 + k]]);
        const [x, y] = g.centre(c);
        mx += x;
        my += y;
        n++;
      }
    }
    if (!n) return [];
    mx /= n;
    my /= n;
    const found: { c: number; d: number }[] = [];
    for (let c = 0; c < g.count; c++) {
      if (this.plan.gate[c] || this.plan.typeAt(c) !== 'wall') continue;
      let mine = false;
      let stores = false;
      for (let k = 0; k < 4; k++) {
        const r = comp[g.quads[c * 4 + k]];
        if (r === storesRoot) stores = true;
        else if (theirs.has(r)) mine = true;
      }
      if (!mine || !stores) continue;
      const [x, y] = g.centre(c);
      found.push({ c, d: Math.hypot(x - mx, y - my) });
    }
    return found.sort((a, b) => a.d - b.d).map((f) => f.c);
  }

  /** the panel's line for the first fix of a press, and its cell */
  private noteFix(kind: VariantKind, type: StructureType, at: number): void {
    if (this.variant) return;
    this.variant = variantLine(kind, type);
    this.variantAt = at;
  }

  /** blocks taken out of the plan again (every level of their cells) */
  private refuse(cells: number[]): void {
    for (const c of cells) for (const l of [...this.plan.levels.each(c)].sort((a, b) => b - a)) this.plan.erase(c, l);
    if (!cells.length) return;
    if (this.selected !== null && !this.plan.structure(this.selected)) this.selected = null;
    this.waysMemo = null;
    this.sync();
  }

  erase(cell: number, level: number): boolean {
    // (erasing takes solid away: it cuts nothing off — a structure is a node, open on every side)
    return this.apply(() => this.plan.erase(cell, level), cell);
  }

  setGate(cell: number, on: boolean): boolean {
    // (a gate shut that shuts structures off from the stores opens again, the panel says what it would cut off)
    const before = !on && this.plan.gate[cell] ? this.reachedIds() : null;
    if (!this.apply(() => this.plan.setGate(cell, on), cell)) return false;
    if (before) {
      const cut = [...before].filter((id) => this.plan.structure(id) && !this.roads?.net.reach.reachedIds.has(id));
      if (cut.length) {
        this.plan.setGate(cell, true);
        this.sync();
        this.refusal = wouldCutLine([...new Set(cut.map((id) => this.plan.structure(id)!.type))]);
      }
    }
    return true;
  }
  /**
   * (round 128f) where the builders fetch from (window world): the first warehouse's door, else the town's heap. (Round
   * 128p: the first whose door opens on open ground — one shut in by other buildings is reached through them, but its
   * door's step lies in the next house; the first with a door at all if none does.)
   */
  storesAt(): [number, number] | null {
    const ws = this.plan.structures().filter((s) => s.type === 'warehouse').sort((a, b) => a.id - b.id);
    const doors = this.ways().doors;
    const open = (id: number) => {
      const d = doors.find((x) => x.structure === id);
      const n = d ? this.grid.nbr[d.cell * 4 + d.side] : -1;
      return !!d && !(n >= 0 && this.plan.structureAt(n));
    };
    for (const s of [...ws.filter((w) => open(w.id)), ...ws]) {
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
    const own = standsOfCell(this.plan, this.grid, (n) => this.town.has(n, 0), cell, also);
    if (own.length) return own.map(([x, y]) => this.toWindow(x, y));
    // (round 128p: a cell shut in by its own structure's — a structure is one place, open where any of it is)
    const s = this.plan.structureAt(cell);
    const out: [number, number][] = [];
    for (const c of s?.cells.keys() ?? []) if (c !== cell) out.push(...standsOfCell(this.plan, this.grid, (n) => this.town.has(n, 0), c, also));
    return out.map(([x, y]) => this.toWindow(x, y));
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
    if (this.batching) return true;
    this.sync();
    for (const h of this.onChange) h();
    return true;
  }

  /** The Town's plan follows the painted plan (the blocks' floors: Town.plan lines them up with the neighbours'). */
  private sync(): void {
    const changed = this.plan.takeChanged();
    this.waysMemo = null;
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
    // (round 128p, DA-A13: a town with its roads laid lays them again — the paths to what was placed, a far structure's
    // road, the terraces — through the generator's own function)
    let verge: number[] = [];
    if (changed.length || !this.roads) {
      const before = new Set(this.plan.layout.roads?.verge ?? []);
      this.relay(changed);
      verge = (this.plan.layout.roads?.verge ?? []).filter((c) => !before.has(c));
    }
    // (FT-26) the trees go from the cells painted and the cells round them (a courtyard among them); a new road's too
    this.clearPlants([...changed, ...verge]);
    // (what stands may have come down; the ways' stairs moved: claimed again)
    if (changed.length) this.io.changed(true);
    for (const e of erased) for (const h of this.onErased) h(e);
    if (changed.length) for (const h of this.onReach) h();
  }

  /**
   * (round 128p, DA-A13) The town's roads laid again through the generator's own function (relayRoads: the paths to
   * what was placed, a far structure's road, the terraces) — a town without them (a lab recipe's) gets them laid now,
   * its water from the io.
   */
  private relay(changed?: readonly number[]): void {
    const t0 = performance.now();
    if (!this.plan.layout.roads) {
      const water = (x: number, y: number) => this.io.water?.(...this.toWindow(x, y)) ?? 0;
      const st = this.storesAt();
      const stores = st ? this.toBox(st[0], st[1]) : this.grid.centre(0);
      const io = { ground: (x: number, y: number) => this.site.groundAt(x, y), wet: (x: number, y: number) => water(x, y) > DEEP, water: (x: number, y: number) => water(x, y) > 0, centre: stores, stores, spokes: 0, far: 4 };
      this.roads = finishRoads(this.site, io, mainRoads(this.site, io));
    } else this.roads = relayRoads(this.site, changed);
    // (the ways' doors are the roads' layout's: laid again, read again)
    this.waysMemo = null;
    this.reachKnown = true;
    this.reachStats.checks++;
    this.reachStats.cpuMs = +(performance.now() - t0).toFixed(1);
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
