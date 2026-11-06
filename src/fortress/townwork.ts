// A town's work as TownLife asks for it (DA-A6, round 128o; townlife.ts TownWork): the plan's job board, the builders'
// loads and sites (BuildBook, the build order, the reach's cut-off cells), the farms' ripe grain, the work spots — over
// the town's one plan (a Fortress on its TownSite). Ported from fortress/life.ts's FortressLife, which it replaces when
// TownLife is wired in (the next commit: until then the game runs FortressLife). No unit is read: where a person is
// comes with its arrival.
import { type JobKind, type JobSlot, type Load } from '../town/jobs';
import type { Good, Goods } from '../api/contracts/fortress';
import type { V2 } from '../api/contracts/units';
import { buildOrder } from '../agents/buildcrew';
import type { Block } from '../build/town';
import { DEFS, ECON } from './defs';
import { bedsOf, builtBlocks, fits, grown, haulBy, jobSlots, mayArrive, putIn, quarryLoad, workSeconds } from './economy';
import type { Fortress } from './fortress';
import type { Crowd, LifeEvent, TownWork } from '../town/life';
import { RecipeRunner, type TrainRoom } from './recipes';
import { BuildBook } from './work';

/** goods a builder carries a trip */
export const LOAD = 3;
/** blocks given out as sites at once (the builders' field leads to the nearest) */
export const SITES = 6;
/** the most grain a farm holds ripe: this many days of its growth */
const RIPE_DAYS = 3;
/** a farm's ripe grain worth a reap (a load's share: less isn't worth the walk home) */
export const RIPE_LOAD = 0.5;
/** a pile worth a cart's ride: half its load (FortressLife's) */
const PILE_WORTH = ECON.cartLoad / 2;
/** a soldier's next wall point at least this far along from the last (m): a walk, not a hop (FortressLife's) */
const WALL_STEP = 8;
/** the structures whose hauls a cart may take */
const HAULED: ReadonlySet<string> = new Set(['quarry', 'lumber', 'farm']);

export interface FortressWorkIO {
  fort: Fortress;
  stores(): Goods;
  /** goods out of the stores (negative: in) */
  take(good: Good, amount: number): void;
  /** the trees a lumber camp's workers may fell (window world), nearest the camp first */
  trees(structure: number): V2[];
  /** where the builders fetch from (window world): the stores */
  stores_at(): V2;
  /** where a cart loads a structure's pile (window world: the road's node by its door); null: no road reaches it — its
   *  workers walk their hauls */
  pileAt(structure: number): V2 | null;
}

export class FortressWork implements TownWork {
  readonly daySec = ECON.daySec;
  readonly drillSec = ECON.drillSec;
  readonly patrolPoints = ECON.patrolPoints;
  /** the smiths' and recruits' batches */
  readonly recipes = new RecipeRunner();
  /** per structure the goods on its pile, waiting for a cart; per cart the pile it rides for */
  readonly piles = new Map<number, Goods>();
  private claims = new Map<number, number>();
  readonly book: BuildBook;
  /** per farm its ripe grain */
  readonly ripe = new Map<number, number>();
  /** per structure what its workers brought in */
  readonly made = new Map<number, Goods>();

  /** the town's events since the last drain (TownLife.on takes them): goods in, the sites changed, work ready */
  private events: LifeEvent[] = [];

  constructor(private io: FortressWorkIO) {
    this.book = new BuildBook((b) => DEFS[io.fort.plan.typeAt(b.cell) ?? 'house'].cost);
    // (the plan edited, a block built, the reach answered: the sites may have changed)
    // (beds too: a newcomer may come)
    io.fort.onChange.push(() => {
      this.emit({ type: 'sites' });
      this.emit({ type: 'room' });
    });
  }

  private emit(e: LifeEvent): void {
    const last = this.events[this.events.length - 1];
    // (one of a kind in a row is enough)
    if (last && last.type === e.type && (e.type !== 'spot' || (last.type === 'spot' && last.structure === e.structure))) return;
    this.events.push(e);
  }

  /** the town's events since the last call */
  drain(): LifeEvent[] {
    return this.events.splice(0);
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

  /**
   * The jobs open: the plan's (economy.ts jobSlots) — the smiths only while the stores hold a batch of ore and wood, the
   * recruits while there's a weapon and a bed in the barracks; those with a batch on its way keep their place.
   */
  slots(crowd: Crowd): JobSlot[] {
    const f = this.io.fort;
    const st = this.io.stores();
    const room = this.trainRoom(crowd);
    const cap = (s: { id: number; type: string }, n: number): number => {
      if (s.type !== 'blacksmith' && s.type !== 'barracks') return n;
      return this.recipes.canStart(s.type, st, room) ? n : this.recipes.inProgressAt(s.id);
    };
    return jobSlots(f.plan, this.built, this.sites().length > 0, undefined, undefined, cap);
  }

  /** the barracks' room: soldiers there are and in training, against the barracks' built beds */
  private trainRoom(crowd: Crowd): TrainRoom {
    const f = this.io.fort;
    let beds = 0;
    for (const s of f.plan.structures()) if (s.type === 'barracks') beds += (DEFS.barracks.perBlock.beds ?? 0) * builtBlocks(f.plan, s, this.built);
    return { units: crowd.soldiers + this.recipes.inProgress('train'), beds };
  }

  startBatch(unit: number, kind: JobKind, structure: number, crowd: Crowd): { goods: Goods; seconds: number } | null {
    if (kind !== 'blacksmith' && kind !== 'barracks') throw new Error(`town work: no batch at a ${kind}`);
    const goods = this.recipes.start(unit, kind, structure, this.io.stores(), this.trainRoom(crowd));
    if (!goods) return null;
    for (const [g, v] of Object.entries(goods) as [Good, number][]) this.io.take(g, v);
    return { goods, seconds: this.recipes.batchOf(unit)!.recipe.seconds };
  }

  finishBatch(unit: number): Goods | 'soldier' {
    const b = this.recipes.batchOf(unit);
    if (!b) throw new Error(`town work: unit ${unit} finished a batch it never started`);
    const out = this.recipes.work(unit, b.recipe.seconds - b.done)!;
    return b.recipe.kind === 'train' ? 'soldier' : out;
  }

  dropBatch(unit: number): void {
    const g = this.recipes.giveBack(unit);
    if (!g) return;
    for (const [k, v] of Object.entries(g) as [Good, number][]) this.io.take(k, -v);
    this.emit({ type: 'stores' });
  }

  /** a long haul (door to stores over ECON.cartDist, a cart to take it, room on the pile, a road to it) left on the pile */
  pile(structure: number, goods: Goods, crowd: Crowd): boolean {
    const f = this.io.fort;
    const s = f.plan.structure(structure);
    const door = f.doorOf(structure);
    if (!s || !HAULED.has(s.type) || !door) return false;
    const h = this.io.stores_at();
    const pile = this.piles.get(structure) ?? {};
    const by = haulBy(Math.hypot(door[0] - h[0], door[1] - h[1]), { carts: crowd.carts, pile: total(pile), road: this.io.pileAt(structure) !== null });
    if (by !== 'cart') return false;
    const was = total(pile);
    for (const [g, v] of Object.entries(goods) as [Good, number][]) pile[g] = (pile[g] ?? 0) + v;
    this.piles.set(structure, pile);
    if (was < PILE_WORTH && total(pile) >= PILE_WORTH) this.emit({ type: 'pile' });
    return true;
  }

  /** the fullest pile no other cart rides for, with a ride's worth on it */
  pileFor(cart: number): number | null {
    const taken = new Set(this.claims.values());
    let best: number | null = null;
    let most = PILE_WORTH - 1e-6;
    for (const [id, g] of this.piles) {
      if (taken.has(id) || this.io.pileAt(id) === null) continue;
      const n = total(g);
      if (n > most) {
        most = n;
        best = id;
      }
    }
    if (best !== null) this.claims.set(cart, best);
    return best;
  }

  loadPile(cart: number, structure: number): Goods {
    this.claims.delete(cart);
    const g = this.piles.get(structure) ?? {};
    const out: Goods = {};
    let room = ECON.cartLoad;
    for (const [k, v] of Object.entries(g) as [Good, number][]) {
      const n = Math.min(room, v ?? 0);
      if (n <= 0) continue;
      out[k] = n;
      g[k] = (v ?? 0) - n;
      room -= n;
    }
    // (what's left still worth a ride: another cart may come)
    if (total(g) >= PILE_WORTH) this.emit({ type: 'pile' });
    return out;
  }

  unclaim(cart: number): void {
    const id = this.claims.get(cart);
    this.claims.delete(cart);
    if (id !== undefined && total(this.piles.get(id) ?? {}) >= PILE_WORTH) this.emit({ type: 'pile' });
  }

  /** the built wall cells (not its gates), window world: the wall-walk's points */
  wallPoints(): V2[] {
    const f = this.io.fort;
    const out: V2[] = [];
    for (const s of f.plan.structures()) if (s.type === 'wall') for (const c of s.cells.keys()) if (f.town.has(c, 0) && !f.plan.gate[c]) out.push(f.centre(c));
    return out;
  }

  wallPoint(at: V2, from: V2 | null): V2 | null {
    const walls = this.wallPoints();
    if (!from) return nearest(walls, at);
    return nearest(walls.filter((q) => Math.hypot(q[0] - from[0], q[1] - from[1]) > WALL_STEP), from);
  }

  mayArrive(crowd: Crowd): boolean {
    return mayArrive(crowd.people, bedsOf(this.io.fort.plan, this.built), this.io.stores().grain ?? 0);
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
    this.emit({ type: 'stores' });
  }

  deliver(goods: Goods, from: number | null): void {
    const went = putIn({ ...this.io.stores() }, this.io.fort.room(), goods);
    for (const [g, v] of Object.entries(went) as [Good, number][]) this.io.take(g, -v);
    if (Object.values(went).some((v) => (v ?? 0) > 0)) this.emit({ type: 'stores' });
    // (grain in: a newcomer may come)
    if ((went.grain ?? 0) > 0) this.emit({ type: 'room' });
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
    // (a farm with nothing ripe enough: no spot — its 'spot' event comes when there is: grow)
    if (kind === 'farm' && (this.ripe.get(structure) ?? 0) < RIPE_LOAD) return null;
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
      const was = this.ripe.get(s.id) ?? 0;
      const now = Math.min(max, was + grown(n, dt));
      this.ripe.set(s.id, now);
      if (was < RIPE_LOAD && now >= RIPE_LOAD) this.emit({ type: 'spot', structure: s.id });
    }
  }

  /** whether a load of `n` fits the stores' room (the haul waits when they're full) */
  fits(n: number): boolean {
    return fits(this.io.stores(), this.io.fort.room(), n);
  }
}

function total(g: Goods): number {
  return Object.values(g).reduce((a, b) => a + (b ?? 0), 0);
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
