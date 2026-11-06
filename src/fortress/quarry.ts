// The miners grow a quarry's pit down, tier by tier (round 128m, `quarry`, BACKLOG V128-11; pit.ts: the plan's tiers
// and ramps). The user: "let the units just naturally grow it"; "Units working, really digging the map".
//
// Per quarry (once every cell of its footprint is built): the tier being dug (k), cut down ECON.pitStep metres at a
// time over every column of it — its shelf cells (ring k and in) and ramp k's cells — so the ramp from the shelf
// above to the floor going down stays walkable the whole way (a tier dug cell by cell left miners in a hole 4 m deep
// with the ramp still to cut). A column's goal: the pit's reference (the lowest ground of the footprint as first seen)
// less its depth (pit.ts depthAt: its ring's tier, or along a ramp) — but no lower than the cut. A tier is done when
// every column is down to its goal: its levels go into Fortress.dug, the pit's ground is woken so its walls go
// through the stability check (they may slump: the miners dig the spill out again), and the next tier starts.
//
// The miners dig through the world API's terrain take (exact, one column, a quiet edit: life.ts io.dig); a column the
// take can't lower (a claim, the window's floor) is left. The tops are the surface as last read (io.ground), less
// what this module has taken since (the read lags a frame or more). The heights here are the fortress's z (window z
// plus Fortress.zShift: they keep through a slide of the window in z).
import type { V2 } from '../api/contracts/units';
import { LEVEL_H } from '../build/town';
import { ECON } from './defs';
import type { Fortress } from './fortress';
import { depthAt, type Pit } from '../build/pit';

export interface QuarryIO {
  fort: Fortress;
  /** the ground's top now at window world (x, y), loose ground on it too (null: not read yet — the miners wait) */
  ground(x: number, y: number): number | null;
  /** ground taken off the top of the column at window world (x, y): how much came */
  dig(at: V2, amount: number): Promise<number>;
  /** the surface read `ground` answers from: a new object each read (none: every answer is fresh — tests) */
  groundRead?(): unknown;
  /** wake the ground round window world (x, y) within r: its slumping and the stability check (none: tests) */
  settle?(x: number, y: number, r: number): void;
}

/** how near its goal a column counts as dug (m) */
const TOL = 0.3;
/** how far from where a miner stands it digs (m) */
const DIG_REACH = 7;
/** a take is remembered until it's answered and this many surface reads came after (round 128o: the ground's pages
 *  are read when asked, a frame or two apart while the pit's chunks run — the one read under way when the take was
 *  answered may have been made before the take's tick) */
const PENDING_READS = 2;
/** takes in a row that brought nothing before a column is left */
const STUCK = 3;
/** this module's takes in flight at most (the world API holds 64 in all: sim/world-gpu.ts EDIT_TAGS; m4 capped its
 *  miners at 16 for the same reason — 40 leaves 24 for the builders and the rest, and 16 slowed the pit by a quarter) */
const IN_FLIGHT = 40;

interface PitState {
  pit: Pit;
  /** the fortress z the tiers are measured from: the lowest top of the footprint as the miners found it */
  ref: number;
  /** the ground at the ramp's top (fortress z): ramp 1 runs down from it, however the land lies */
  top0: number;
  /** the tier being dug (pit.tiers + 1: done) */
  tier: number;
  /** metres cut into it */
  cut: number;
}

export class QuarryDig {
  private pits = new Map<number, PitState>();
  /** the miners' spots as the last update found them */
  private spotsNow: { at: V2; left: number }[] = [];
  /** per box column key: the top after this module's last take, and the surface reads seen when it was answered (Infinity: in flight) */
  private pending = new Map<string, { z: number; read: number }>();
  /** surface reads seen (io.groundRead) */
  private reads = 0;
  private lastRead: unknown = null;
  private stuck = new Map<string, number>();
  /** takes sent and not answered yet */
  private inFlight = 0;
  readonly stats = { taken: 0, takes: 0, tiers: 0 };

  constructor(private io: QuarryIO) {}

  /** (scripted checks, Inspect) a quarry's dig: the tier being dug, of how many, and the cut into it (m) */
  stateOf(id: number): { tier: number; tiers: number; cut: number; ref: number } | null {
    const s = this.pits.get(id);
    return s ? { tier: s.tier, tiers: s.pit.tiers, cut: s.cut, ref: s.ref } : null;
  }

  /** (scripted checks) the cells of a quarry's tier with ground still over the cut: how many, the most over (m) */
  workLeft(id: number): { cells: number; most: number; columns: number; at: V2[] } {
    const st = this.pits.get(id);
    if (!st || st.tier > st.pit.tiers) return { cells: 0, most: 0, columns: 0, at: [] };
    const f = this.io.fort;
    let most = 0;
    let columns = 0;
    const w = this.workIn(st);
    for (const { cell } of w)
      for (const col of f.grid.columns[cell]) {
        const [x, y] = f.colXY(col);
        const o = this.over(st, cell, col, x, y);
        if (o > TOL) columns++;
        most = Math.max(most, o);
      }
    return { cells: w.length, most: +most.toFixed(2), columns, at: w.slice(0, 4).map((x) => f.centre(x.cell).map((v) => +v.toFixed(1)) as V2) };
  }

  /** The quarries with a pit and every cell built: their state kept, a tier's end checked (each JobBoard turn). */
  update(): void {
    const f = this.io.fort;
    this.seeRead();
    const live = new Set<number>();
    for (const s of f.plan.structures()) {
      if (s.type !== 'quarry') continue;
      const pit = f.plan.pitOf(s.id);
      if (!pit || !pit.tiers || ![...s.cells.keys()].every((c) => f.town.has(c, 0))) continue;
      live.add(s.id);
      // (round 128o: the ground as the mirror has it — api/mirror.ts reads a page again once its chunk has run, and a
      // slide leaves every page unread (null: begun again next turn); the wait for two timed reads after it was found
      // ready went with the timer — nothing would ask for them)
      let st = this.pits.get(s.id);
      if (!st || st.pit !== pit) st = this.begin(s.id, pit, st);
      // (the ground not read yet: begun again next turn)
      if (!Number.isFinite(st.ref) || !Number.isFinite(st.top0)) continue;
      this.pits.set(s.id, st);
      if (st.tier <= pit.tiers && this.allRead(st) && !this.workIn(st).length) this.advance(s.id, st);
    }
    for (const id of [...this.pits.keys()]) if (!live.has(id)) this.pits.delete(id);
    const out: { at: V2; left: number }[] = [];
    for (const st of this.pits.values()) {
      if (st.tier > st.pit.tiers) continue;
      // (in a fixed order — the nearest the ramp's foot first — so the miners' goals stay put while they last: ranked
      // by the ground left they changed every turn, the fields with them, and a miner never arrived at one)
      const foot = st.pit.ramps[st.tier - 1].cells.at(-1)!.cell;
      const [fx, fy] = f.centre(foot);
      const w = this.workIn(st).map((x) => ({ at: f.centre(x.cell), left: x.left }));
      w.sort((a, b) => Math.hypot(a.at[0] - fx, a.at[1] - fy) - Math.hypot(b.at[0] - fx, b.at[1] - fy));
      out.push(...w);
    }
    this.spotsNow = out;
  }

  /** where the miners dig now (window world: the middles of the cells with ground still to take, the nearest the ramp's foot first; at most n) */
  spots(n = 6): V2[] {
    return this.spotsNow.slice(0, n).map((o) => o.at);
  }

  /** whether any quarry has a pit being dug (the miners' spots come from it; else from the quarries' cells) */
  digging(): boolean {
    for (const st of this.pits.values()) if (st.tier <= st.pit.tiers) return true;
    return false;
  }

  /**
   * A miner's dig at window world `at`: ECON.digCols of the columns within DIG_REACH still over their goal, the
   * highest over it first, each lowered by ECON.dig at most. False: nothing to dig in reach.
   */
  dig(at: V2): boolean {
    const f = this.io.fort;
    const cands: { x: number; y: number; over: number; key: string }[] = [];
    for (const st of this.pits.values()) {
      if (st.tier > st.pit.tiers) continue;
      for (const c of this.cellsOf(st)) {
        const [cx, cy] = f.centre(c);
        if (Math.hypot(cx - at[0], cy - at[1]) > DIG_REACH + 6) continue;
        for (const col of f.grid.columns[c]) {
          const [x, y] = f.colXY(col);
          if (Math.hypot(x - at[0], y - at[1]) > DIG_REACH) continue;
          const over = this.over(st, c, col, x, y);
          if (over > TOL) cands.push({ x, y, over, key: `${col}` });
        }
      }
    }
    if (!cands.length) return false;
    cands.sort((a, b) => b.over - a.over);
    this.seeRead();
    for (const c of cands.slice(0, Math.max(0, Math.min(ECON.digCols, IN_FLIGHT - this.inFlight)))) {
      const amt = Math.min(ECON.dig, c.over);
      const top = this.topAt(c.key, c.x, c.y);
      const p = { z: top - amt, read: Infinity };
      this.pending.set(c.key, p);
      this.stats.takes++;
      this.inFlight++;
      void this.io.dig([c.x, c.y], amt).then((got) => {
        this.inFlight--;
        this.seeRead();
        p.read = this.reads;
        this.stats.taken += got;
        if (got > 1e-3) this.stuck.delete(c.key);
        else {
          this.stuck.set(c.key, (this.stuck.get(c.key) ?? 0) + 1);
          this.pending.delete(c.key);
        }
      });
    }
    return true;
  }

  // ---- inside

  private begin(id: number, pit: Pit, was: PitState | undefined): PitState {
    const f = this.io.fort;
    // (the reference: the lowest ground of the footprint as first seen — kept once digging began)
    // (round 128m: the tops as they are — loose ground on them too — not the fortress's ground as first read, the
    // solid's: the ramp's top a soil's depth under the rim was a step the miners couldn't climb out by)
    let ref = was?.ref ?? Infinity;
    let top0 = was?.top0 ?? Infinity;
    if (!was || (was.tier === 1 && was.cut === 0)) {
      ref = Infinity;
      for (const c of pit.ring.keys())
        for (const col of f.grid.columns[c]) {
          const [x, y] = f.colXY(col);
          ref = Math.min(ref, (this.io.ground(x, y) ?? NaN) + f.zShift);
        }
      const a = f.grid.corner(pit.top, pit.topSide);
      const b = f.grid.corner(pit.top, pit.topSide + 1);
      const [x, y] = f.toWindow((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      top0 = Math.max(ref, (this.io.ground(x, y) ?? NaN) + f.zShift);
    }
    // (the first tier not wholly dug: a footprint painted wider after some were)
    let tier = 1;
    while (tier <= pit.tiers && this.tierCells(pit, tier).every((c) => f.dug.has(c, -tier))) tier++;
    void id;
    return { pit, ref, top0, tier, cut: 0 };
  }

  /** the cut deepened, or the tier done: its levels dug, its ground woken, the next begun */
  private advance(id: number, st: PitState): void {
    st.cut += ECON.pitStep;
    if (st.cut < LEVEL_H - 1e-6) return;
    const f = this.io.fort;
    for (const c of this.tierCells(st.pit, st.tier)) f.dug.set(c, -st.tier, id, f.plan.pit.at(c, -st.tier)?.type ?? 0);
    this.stats.tiers++;
    if (this.io.settle) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of st.pit.ring.keys()) {
        const [x, y] = f.centre(c);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      this.io.settle((x0 + x1) / 2, (y0 + y1) / 2, Math.hypot(x1 - x0, y1 - y0) / 2 + 6);
    }
    st.tier++;
    st.cut = 0;
  }

  /** tier k's cells: its shelves (ring k and in) and ramp k's */
  private tierCells(pit: Pit, k: number): number[] {
    const out: number[] = [];
    for (const [c, d] of pit.ring) if (d >= k) out.push(c);
    for (const rc of pit.ramps[k - 1]?.cells ?? []) out.push(rc.cell);
    return out;
  }

  private cellsOf(st: PitState): number[] {
    return this.tierCells(st.pit, st.tier);
  }

  /** (round 128o) every column of the tier has its ground read: an unread one isn't dug (it's asked for) */
  private allRead(st: PitState): boolean {
    const f = this.io.fort;
    let all = true;
    for (const c of this.cellsOf(st))
      for (const col of f.grid.columns[c]) {
        const [x, y] = f.colXY(col);
        if (this.io.ground(x, y) === null) all = false;
      }
    return all;
  }

  /** the cells with ground still over the cut, and how much (m, summed over their columns; a column not read yet counts none) */
  private workIn(st: PitState): { cell: number; left: number }[] {
    const f = this.io.fort;
    const out: { cell: number; left: number }[] = [];
    for (const c of this.cellsOf(st)) {
      let left = 0;
      for (const col of f.grid.columns[c]) {
        const [x, y] = f.colXY(col);
        const o = this.over(st, c, col, x, y);
        if (o > TOL) left += o;
      }
      if (left > 0) out.push({ cell: c, left });
    }
    return out;
  }

  /** how far a column's top is over its goal now (m; 0 if it's left: stuck) */
  private over(st: PitState, cell: number, col: number, x: number, y: number): number {
    const key = `${col}`;
    if ((this.stuck.get(key) ?? 0) >= STUCK) return 0;
    const f = this.io.fort;
    const [bx, by] = f.toBox(x, y);
    const d = depthAt(st.pit, f.grid, cell, bx, by);
    // (ramp 1 from the ground at its top down to tier 1: on sloping land its top is over the pit's reference)
    const full = st.pit.ramps[0].cells.some((rc) => rc.cell === cell) ? st.top0 + (st.ref - LEVEL_H - st.top0) * d : st.ref - d * LEVEL_H;
    const goal = Math.max(full, st.ref - (st.tier - 1 + (st.cut + ECON.pitStep) / LEVEL_H) * LEVEL_H) - f.zShift;
    return this.topAt(key, x, y) - goal;
  }

  private seeRead(): void {
    const r = this.io.groundRead?.();
    if (r === undefined) {
      this.pending.clear();
      return;
    }
    if (r !== this.lastRead) {
      this.lastRead = r;
      this.reads++;
    }
  }

  private topAt(key: string, x: number, y: number): number {
    // (not read yet: NaN — neither over its goal nor dug; round 128o)
    const read = this.io.ground(x, y) ?? NaN;
    const p = this.pending.get(key);
    if (!p) return read;
    if (this.reads - p.read >= PENDING_READS) {
      this.pending.delete(key);
      return read;
    }
    return Math.min(read, p.z);
  }
}
