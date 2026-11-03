// The fortress's plan (fortress slice 1, milestone 1): what the player painted, cell by cell, each cell owned by a
// structure. Select what (a type), then paint it: a cell painted next to a structure of the same type joins it (two
// joined by one cell become one). Pure: no GPU, no DOM — the view (fortress.ts) makes Town blocks of it.
import type { FortressPlanApi, Goods, PerBlock, PlanGrid, PlanTotals, Structure, StructureDef, StructureType, WallTile } from '../api/contracts/fortress';
import { DEFS } from './defs';

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

export class FortressPlan implements FortressPlanApi {
  /** per cell its structure's id (-1 none) */
  readonly owner: Int32Array;
  /** per cell its levels (bit L: level L) */
  readonly mask: Uint8Array;
  /** per cell a gate (wall cells' ground level) */
  readonly gate: Uint8Array;
  private byId = new Map<number, Structure>();
  private nextId = 1;
  /** the cells whose look may have changed since the last `takeChanged` (painted, erased, their neighbours) */
  private changed = new Set<number>();

  constructor(readonly grid: PlanGrid, readonly defs: Record<StructureType, StructureDef> = DEFS) {
    this.owner = new Int32Array(grid.count).fill(-1);
    this.mask = new Uint8Array(grid.count);
    this.gate = new Uint8Array(grid.count);
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
    return cell >= 0 && ((this.mask[cell] >> level) & 1) === 1;
  }

  paint(cell: number, level: number, type: StructureType): boolean {
    if (cell < 0 || cell >= this.grid.count || level < 0) return false;
    const def = this.defs[type];
    if (level >= def.maxLevels || this.has(cell, level)) return false;
    const here = this.typeAt(cell);
    if (here && here !== type) return false;
    if (!here) {
      // join the same type's structures beside it (the lowest id keeps; the others fold into it)
      const ids = new Set<number>();
      for (let e = 0; e < 4; e++) {
        const n = this.grid.nbr[cell * 4 + e];
        if (n >= 0 && this.typeAt(n) === type) ids.add(this.owner[n]);
      }
      const sorted = [...ids].sort((a, b) => a - b);
      let s: Structure;
      if (!sorted.length) {
        s = { id: this.nextId++, type, cells: new Map() };
        this.byId.set(s.id, s);
      } else {
        s = this.byId.get(sorted[0])!;
        for (const other of sorted.slice(1)) {
          const o = this.byId.get(other)!;
          for (const [c, m] of o.cells) {
            s.cells.set(c, m);
            this.owner[c] = s.id;
          }
          this.byId.delete(other);
        }
      }
      this.owner[cell] = s.id;
      s.cells.set(cell, 0);
    }
    this.mask[cell] |= 1 << level;
    this.byId.get(this.owner[cell])!.cells.set(cell, this.mask[cell]);
    this.touch(cell);
    return true;
  }

  erase(cell: number, level: number): boolean {
    if (!this.has(cell, level)) return false;
    const s = this.byId.get(this.owner[cell])!;
    this.mask[cell] &= ~(1 << level);
    if (this.mask[cell]) s.cells.set(cell, this.mask[cell]);
    else {
      s.cells.delete(cell);
      this.owner[cell] = -1;
      this.gate[cell] = 0;
      if (!s.cells.size) this.byId.delete(s.id);
    }
    // (a gate stands on a straight run: a neighbour's run may have just broken)
    for (let e = 0; e < 4; e++) {
      const n = this.grid.nbr[cell * 4 + e];
      if (n >= 0 && this.gate[n] && this.wallTile(n, 0) !== 'straight') this.gate[n] = 0;
    }
    this.touch(cell);
    return true;
  }

  setGate(cell: number, on: boolean): boolean {
    if (on && this.wallTile(cell, 0) !== 'straight') return false;
    if (!on && !this.gate[cell]) return false;
    this.gate[cell] = on ? 1 : 0;
    this.touch(cell);
    return true;
  }

  /** Which of a wall cell's sides join a wall at level L (sides 0..3). */
  wallJoins(cell: number, level: number): boolean[] {
    const out = [false, false, false, false];
    for (let e = 0; e < 4; e++) {
      const n = this.grid.nbr[cell * 4 + e];
      out[e] = n >= 0 && this.typeAt(n) === 'wall' && this.has(n, level);
    }
    return out;
  }

  wallTile(cell: number, level: number): WallTile | null {
    if (this.typeAt(cell) !== 'wall' || !this.has(cell, level)) return null;
    return wallTileOf(this.wallJoins(cell, level));
  }

  blocks(s: Structure): number {
    let n = 0;
    for (const m of s.cells.values()) {
      let v = m;
      while (v) {
        n += v & 1;
        v >>= 1;
      }
    }
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
    return out;
  }

  totals(stores: Goods): PlanTotals {
    const cost: Goods = {};
    const gives: PerBlock = {};
    let blocks = 0;
    for (const s of this.byId.values()) {
      const b = this.blocks(s);
      blocks += b;
      addGoods(cost, this.defs[s.type].cost, b);
      addPer(gives, this.defs[s.type].perBlock, b);
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
