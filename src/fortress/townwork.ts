// A town's work as TownLife asks for it (DA-A6, round 128o; townlife.ts TownWork): the plan's job board, the builders'
// loads and sites (BuildBook, the build order, the reach's cut-off cells), the farms' ripe grain, the work spots — over
// the town's one plan (a Fortress on its TownSite). Ported from fortress/life.ts's FortressLife, which it replaces when
// TownLife is wired in (the next commit: until then the game runs FortressLife). No unit is read: where a person is
// comes with its arrival.
import type { Good, Goods } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/units';
import { buildOrder } from '../agents/buildcrew';
import type { Block } from '../build/town';
import { DEFS, ECON } from './defs';
import { builtBlocks, fits, grown, jobSlots, putIn, quarryLoad, workSeconds, type JobKind, type JobSlot } from './economy';
import type { Fortress } from './fortress';
import type { TownWork } from './townlife';
import { BuildBook, type Load } from './work';

/** goods a builder carries a trip */
export const LOAD = 3;
/** blocks given out as sites at once (the builders' field leads to the nearest) */
export const SITES = 6;
/** the most grain a farm holds ripe: this many days of its growth */
const RIPE_DAYS = 3;
/** the job kinds this slice's people do (the smiths' and recruits' come with their slice) */
const KINDS: ReadonlySet<JobKind> = new Set(['build', 'farm', 'quarry', 'lumber']);

export interface FortressWorkIO {
  fort: Fortress;
  stores(): Goods;
  /** goods out of the stores (negative: in) */
  take(good: Good, amount: number): void;
  /** the trees a lumber camp's workers may fell (window world), nearest the camp first */
  trees(structure: number): V2[];
  /** where the builders fetch from (window world): the stores */
  stores_at(): V2;
}

export class FortressWork implements TownWork {
  readonly book: BuildBook;
  /** per farm its ripe grain */
  readonly ripe = new Map<number, number>();
  /** per structure what its workers brought in */
  readonly made = new Map<number, Goods>();

  constructor(private io: FortressWorkIO) {
    this.book = new BuildBook((b) => DEFS[io.fort.plan.typeAt(b.cell) ?? 'house'].cost);
  }

  private built = (c: number, l: number) => this.io.fort.town.has(c, l);

  /** the blocks still to build in the build order (lowest first, nearest the stores), the reach's cut-off ones left out */
  sites(): Block[] {
    const f = this.io.fort;
    const cut = f.cutCells();
    const [hx, hy] = f.toBox(...this.io.stores_at());
    return buildOrder(f.town, [hx, hy])
      .filter((d) => !d.down && !cut.has(d.block.cell))
      .map((d) => d.block)
      .slice(0, SITES);
  }

  slots(): JobSlot[] {
    const f = this.io.fort;
    return jobSlots(f.plan, this.built, this.sites().length > 0).filter((s) => KINDS.has(s.kind));
  }

  nextLoad(): { block: Block; load: Load } | null {
    // (a copy: BuildBook.fetch takes the load out of what it's given; the stores themselves through io.take)
    const st = { ...this.io.stores() };
    for (const block of this.sites()) {
      const load = this.book.fetch(block, st, LOAD);
      if (!load) continue;
      this.io.take(load.good, load.amount);
      return { block, load };
    }
    return null;
  }

  siteAt(at: V2, load: Load, meant: Block): Block | null {
    const f = this.io.fort;
    // (the field led to the nearest site lacking the load's good: the one whose stand is nearest where it arrived)
    let best: Block | null = null;
    let bd = Infinity;
    for (const b of this.sites()) {
      if ((this.book.need(b, false)[load.good] ?? 0) <= 0 && !(b.cell === meant.cell && b.level === meant.level)) continue;
      for (const [x, y] of f.standsOf(b.cell)) {
        const d = Math.hypot(x - at[0], y - at[1]);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
    }
    if (best && (best.cell !== meant.cell || best.level !== meant.level)) this.book.move(meant, best, load);
    return best;
  }

  workIn(block: Block, load: Load): void {
    const f = this.io.fort;
    if (!f.town.planned(block.cell, block.level) || f.town.has(block.cell, block.level)) return this.giveBack(block, load);
    if (this.book.pay(block, load)) f.markBuilt(block.cell, block.level);
    else f.markStarted(block.cell, block.level);
  }

  giveBack(block: Block, load: Load): void {
    this.book.giveBack(block, load, { ...this.io.stores() });
    this.io.take(load.good, -load.amount);
  }

  deliver(goods: Goods, from: number | null): void {
    const went = putIn({ ...this.io.stores() }, this.io.fort.room(), goods);
    for (const [g, v] of Object.entries(went) as [Good, number][]) this.io.take(g, -v);
    if (from === null) return;
    const m = this.made.get(from) ?? {};
    for (const [g, v] of Object.entries(went) as [Good, number][]) m[g] = (m[g] ?? 0) + v;
    this.made.set(from, m);
  }

  workSpot(kind: JobKind, structure: number, at: V2): V2 | null {
    const f = this.io.fort;
    const s = f.plan.structure(structure);
    if (!s) return null;
    if (kind === 'lumber') return nearest(this.io.trees(structure), at);
    // (a farm's, a quarry's built cell nearest where it arrived)
    const cells = [...s.cells.keys()].filter((c) => f.town.has(c, 0)).map((c) => f.centre(c));
    return nearest(cells, at);
  }

  reap(structure: number): { goods: Goods; seconds: number } {
    const ripe = this.ripe.get(structure) ?? 0;
    const n = Math.min(ECON.haul, ripe);
    this.ripe.set(structure, ripe - n);
    return { goods: { grain: n }, seconds: workSeconds(DEFS.farm) };
  }

  dugGoods(amount: number): Goods {
    return quarryLoad(amount);
  }

  /** sim seconds on: grain grows on the farms' built blocks (up to RIPE_DAYS of it) */
  grow(dt: number): void {
    const f = this.io.fort;
    for (const s of f.plan.structures()) {
      if (s.type !== 'farm') continue;
      const n = builtBlocks(f.plan, s, this.built);
      const max = (DEFS.farm.perBlock.makes?.grain ?? 0) * n * RIPE_DAYS;
      this.ripe.set(s.id, Math.min(max, (this.ripe.get(s.id) ?? 0) + grown(n, dt)));
    }
  }

  /** whether a load of `n` fits the stores' room (the haul waits when they're full) */
  fits(n: number): boolean {
    return fits(this.io.stores(), this.io.fort.room(), n);
  }
}

function nearest(pts: readonly V2[], at: V2): V2 | null {
  let best: V2 | null = null;
  let bd = Infinity;
  for (const p of pts) {
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
