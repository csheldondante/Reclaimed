// (round 128d) Occupancy as runs per cell: the levels a cell holds, as sorted half-open runs [lo, hi), each with an owner
// (a structure's id) and a type (its kind, a small integer). The round-102 settlement-spans design's "occupancy
// intervals per grid cell" (DECISIONS round 102), here for the Town's blocks and the fortress's plan. No level cap: a
// cell holds any levels; gaps are runs apart. Touching runs of one owner and type are one; taking a level out of the
// middle of a run splits it. Pure: no GPU, no DOM.
// (round 128m, quarry) Levels may be negative: a quarry's pit is its levels under the ground (level -1 the first 4 m
// down, fortress/pit.ts), kept in a CellRuns of its own (TownPlan.pit, Fortress.dug) so nothing that reads the
// blocks' runs meets them. top() and bottom() say -1 for an empty cell: with negative levels, ask any() first, or use
// highest() / lowest() (null: none).

export interface Run {
  /** the lowest level in it */
  lo: number;
  /** one past the highest */
  hi: number;
  owner: number;
  type: number;
}

const NONE: readonly Run[] = [];

export class CellRuns {
  /** per cell its runs, sorted by lo, none touching with the same owner and type (null: none yet) */
  private runs: (Run[] | null)[];

  constructor(readonly count: number) {
    this.runs = new Array<Run[] | null>(count).fill(null);
  }

  /** c's runs, bottom up (a live view: the same array while the cell has any; don't change it). */
  runsOf(c: number): readonly Run[] {
    return (c >= 0 && c < this.count && this.runs[c]) || NONE;
  }

  /** The run holding level L of c (null: none). */
  at(c: number, L: number): Run | null {
    const rs = this.runsOf(c);
    for (const r of rs) {
      if (L < r.lo) return null;
      if (L < r.hi) return r;
    }
    return null;
  }

  has(c: number, L: number): boolean {
    return this.at(c, L) !== null;
  }

  /** Whether c holds any level. */
  any(c: number): boolean {
    return this.runsOf(c).length > 0;
  }

  /** c's highest level (-1: none). */
  top(c: number): number {
    const rs = this.runsOf(c);
    return rs.length ? rs[rs.length - 1].hi - 1 : -1;
  }

  /** c's highest level (null: none) — for runs that may hold negative levels */
  highest(c: number): number | null {
    const rs = this.runsOf(c);
    return rs.length ? rs[rs.length - 1].hi - 1 : null;
  }

  /** c's lowest level (null: none) — for runs that may hold negative levels */
  lowest(c: number): number | null {
    const rs = this.runsOf(c);
    return rs.length ? rs[0].lo : null;
  }

  /** c's lowest level (-1: none). */
  bottom(c: number): number {
    const rs = this.runsOf(c);
    return rs.length ? rs[0].lo : -1;
  }

  /** How many levels c holds. */
  levels(c: number): number {
    let n = 0;
    for (const r of this.runsOf(c)) n += r.hi - r.lo;
    return n;
  }

  /** c's levels, bottom up. */
  *each(c: number): Generator<number> {
    for (const r of this.runsOf(c)) for (let L = r.lo; L < r.hi; L++) yield L;
  }

  /** Whether c holds the same levels as d (owners and types aside). */
  sameLevels(c: number, d: number): boolean {
    const a = this.runsOf(c);
    const b = this.runsOf(d);
    // (runs of one owner and type touching are merged, but runs of different ones may touch: compare the levels)
    const flat = (rs: readonly Run[]) => {
      const out: number[] = [];
      for (const r of rs) {
        if (out.length && out[out.length - 1] === r.lo) out[out.length - 1] = r.hi;
        else out.push(r.lo, r.hi);
      }
      return out;
    };
    const fa = flat(a);
    const fb = flat(b);
    return fa.length === fb.length && fa.every((v, i) => v === fb[i]);
  }

  /** Put level L in c (owner, type); false if it's already there. (Round 128m: L may be negative — a pit's.) */
  set(c: number, L: number, owner = 0, type = 0): boolean {
    if (c < 0 || c >= this.count || !Number.isInteger(L)) return false;
    let rs = this.runs[c];
    if (!rs) rs = this.runs[c] = [];
    let i = 0;
    while (i < rs.length && rs[i].hi <= L) i++;
    if (i < rs.length && rs[i].lo <= L) return false;
    // rs[i] (if any) starts above L; rs[i - 1] (if any) ends at or below L
    const prev = i > 0 ? rs[i - 1] : null;
    const next = i < rs.length ? rs[i] : null;
    const joinPrev = !!prev && prev.hi === L && prev.owner === owner && prev.type === type;
    const joinNext = !!next && next.lo === L + 1 && next.owner === owner && next.type === type;
    if (joinPrev && joinNext) {
      prev!.hi = next!.hi;
      rs.splice(i, 1);
    } else if (joinPrev) prev!.hi = L + 1;
    else if (joinNext) next!.lo = L;
    else rs.splice(i, 0, { lo: L, hi: L + 1, owner, type });
    return true;
  }

  /** Take level L out of c; false if it isn't there. A level out of a run's middle splits it. */
  clear(c: number, L: number): boolean {
    const rs = c >= 0 && c < this.count ? this.runs[c] : null;
    if (!rs) return false;
    const i = rs.findIndex((r) => r.lo <= L && L < r.hi);
    if (i < 0) return false;
    const r = rs[i];
    if (r.hi - r.lo === 1) rs.splice(i, 1);
    else if (L === r.lo) r.lo++;
    else if (L === r.hi - 1) r.hi--;
    else {
      rs.splice(i + 1, 0, { lo: L + 1, hi: r.hi, owner: r.owner, type: r.type });
      r.hi = L;
    }
    if (!rs.length) this.runs[c] = null;
    return true;
  }

  /** Every level of c gone. */
  clearCell(c: number): void {
    if (c >= 0 && c < this.count) this.runs[c] = null;
  }

  /** c's runs owned by `from` given to `to` (structures folding into one); touching runs merged. */
  reown(c: number, from: number, to: number): void {
    const rs = c >= 0 && c < this.count ? this.runs[c] : null;
    if (!rs) return;
    for (const r of rs) if (r.owner === from) r.owner = to;
    this.mergeTouching(rs);
  }

  /** Every run of c given one owner and type; touching runs merged. */
  ownAll(c: number, owner: number, type: number): void {
    const rs = c >= 0 && c < this.count ? this.runs[c] : null;
    if (!rs) return;
    for (const r of rs) {
      r.owner = owner;
      r.type = type;
    }
    this.mergeTouching(rs);
  }

  private mergeTouching(rs: Run[]): void {
    for (let i = rs.length - 1; i > 0; i--) {
      const a = rs[i - 1];
      const b = rs[i];
      if (a.hi === b.lo && a.owner === b.owner && a.type === b.type) {
        a.hi = b.hi;
        rs.splice(i, 1);
      }
    }
  }

  /**
   * (onetown) The runs as numbers, cell by cell: its run count, then each run's lo, hi, owner, type. What a worker posts
   * (a structured clone keeps no class) and what a test compares (byte for byte).
   */
  encode(): Int32Array {
    const out: number[] = [];
    for (let c = 0; c < this.count; c++) {
      const rs = this.runs[c];
      out.push(rs ? rs.length : 0);
      if (rs) for (const r of rs) out.push(r.lo, r.hi, r.owner, r.type);
    }
    return Int32Array.from(out);
  }

  /** (onetown) Runs from `encode`'s numbers. */
  static decode(count: number, data: ArrayLike<number>): CellRuns {
    const out = new CellRuns(count);
    let i = 0;
    for (let c = 0; c < count; c++) {
      const n = data[i++];
      if (!n) continue;
      const rs: Run[] = [];
      for (let k = 0; k < n; k++, i += 4) rs.push({ lo: data[i], hi: data[i + 1], owner: data[i + 2], type: data[i + 3] });
      out.runs[c] = rs;
    }
    if (i !== data.length) throw new Error(`CellRuns.decode: ${data.length} numbers for ${count} cells, ${i} read`);
    return out;
  }

  /** The levels in `a` not in `b` at c (bottom up). */
  static minus(a: CellRuns, b: CellRuns, c: number): number[] {
    const out: number[] = [];
    for (const L of a.each(c)) if (!b.has(c, L)) out.push(L);
    return out;
  }
}
