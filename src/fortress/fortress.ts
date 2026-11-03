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
import { cellPos } from '../world/lattice';
import { DEFS } from './defs';
import { FortressPlan } from './plan';

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
}

export type Tool = { type: StructureType; erase: boolean; gate: boolean };

export class Fortress {
  readonly town: Town;
  readonly grid: TownGrid;
  readonly plan: FortressPlan;
  tool: Tool = { type: 'house', erase: false, gate: false };
  /** the structure last painted (the panel's) */
  selected: number | null = null;
  readonly onChange: (() => void)[] = [];
  /** the ground under the box is known (the level's surface read over every column): planning may start */
  ready = false;

  constructor(readonly box: FortressBox, private io: FortressIO, seed = 7) {
    if (box.origin[1] & 1) throw new Error('fortress box: its row origin must be even (the lattice\'s odd-row shift)');
    const grid = new TownGrid(box.w, box.h, { seed });
    this.town = new Town(box.w, box.h, {
      ground: (col) => {
        const [x, y] = this.boxToWindowXY(col);
        return io.ground(x, y);
      },
      // (milestone 1 only plans: nothing stands yet, so nothing is stamped — milestone 2's builders stamp)
      stamp: () => {
        throw new Error('fortress: the Town stamps only when blocks stand (milestone 2)');
      },
      zMax: io.dims.zMax,
    }, { grid });
    this.plan = new FortressPlan(grid);
    this.grid = grid;
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

  /** The block a press on window column `col` at height z would act on, with the current tool. */
  pick(col: number, z: number): Block | null {
    const bc = this.windowToBoxCol(col);
    if (bc < 0) return null;
    const erase = this.tool.erase || this.tool.gate;
    const b = this.town.pickBlock(bc, z, erase, true);
    if (!b) return null;
    // (a yard only ever lies on the ground)
    if (!erase && DEFS[this.tool.type].form === 'yard') return { cell: b.cell, level: 0 };
    return b;
  }

  /** A press with the current tool on window column `col` at height z. What happened, for the panel; null: nothing. */
  press(col: number, z: number): boolean {
    const b = this.pick(col, z);
    if (!b) return false;
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
    for (let c = 0; c < this.plan.mask.length; c++) if (this.plan.mask[c]) cells.push(c);
    this.changedOver(cells);
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
    for (const c of changed)
      for (let l = 0; l < 8; l++) {
        const want = this.plan.has(c, l);
        if (want !== this.town.planned(c, l)) this.town.plan(c, l, want);
      }
    this.changedOver(changed);
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
