// The fortress (fortress slice 1, milestone 1): the plan (plan.ts) kept as Town blocks (build/town.ts: a cell and a
// level each, floors lined up with the neighbours') on the fortress's own world-anchored box. The Town's columns are
// box-local; TownIO maps them to the window through the box's origin and the window's, so a slide only changes that
// offset.
//
// Milestone 1 plans with time stopped: the blocks are the Town's plan (Town.plans), drawn as the towns' pieces
// (pieces.ts) — what they'll look like. Milestone 2's workers build them (Town.add: what stands).
import type { FortressBox, Goods, StructureType } from '../api/contracts/fortress';
import { Town, type Block } from '../build/town';
import { TownGrid } from '../build/towngrid';
import { cellAt, cellPos } from '../world/lattice';
import { DEFS } from './defs';
import { FortressPlan, typeIndex } from './plan';
import { pickFace, placeFor } from './pick';
import { shapesOf } from './shapes';
import { waysOf, waysNav, type Ways } from './ways';
import type { NavGraph } from '../api/contracts/structures';
import type { TownThing } from '../settle/thing';
import { LEVEL_H } from '../build/town';

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
  /** (round 128d, FT-20) blocks to build that no builder can walk to from the heap (FortressLife: deep water, a cliff) */
  cutOff = 0;
  /** the ground under the box is known (the level's surface read over every column): planning may start */
  ready = false;
  /** (round 128d) the ways baked from the plan (ways.ts), made again after the plan changes */
  private waysMemo: Ways | null = null;
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
    return this.apply(() => this.plan.paint(cell, level, type), cell);
  }

  erase(cell: number, level: number): boolean {
    return this.apply(() => this.plan.erase(cell, level), cell);
  }

  setGate(cell: number, on: boolean): boolean {
    return this.apply(() => this.plan.setGate(cell, on), cell);
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
    const nb = (a: number, b: number) => [0, 1, 2, 3].some((e) => g.nbr[a * 4 + e] === b);
    const out: number[] = [];
    for (let i = 0; i < seq.length; i++) {
      const a = seq[i];
      const b = seq[(i + 1) % seq.length];
      if (!out.includes(a)) out.push(a);
      if (a === b || nb(a, b)) continue;
      // (corner to corner: a cell beside both joins them)
      for (let e = 0; e < 4; e++) {
        const m = g.nbr[a * 4 + e];
        if (m >= 0 && nb(m, b)) {
          if (!out.includes(m)) out.push(m);
          break;
        }
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
    for (const c of changed) {
      const s = this.plan.structureAt(c);
      const owner = s ? s.id : 0;
      const type = s ? typeIndex(s.type) : 0;
      // (the levels either side has: the plan's and the Town's, built or planned)
      const levels = new Set([...this.plan.levels.each(c), ...this.town.plans.each(c), ...this.town.built.each(c)]);
      for (const l of levels) {
        const want = this.plan.has(c, l);
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
