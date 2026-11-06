// A generated settlement's work as the one crowd asks for it (DA-A6, round 128o; town/life.ts TownWork): its trades'
// jobs (each person's its record's trade: farmers, woodcutters, miners, builders), the house going up storey by storey
// (its builders' loads off the heaps), the farms' sheaves, the mines it may work, the woods' trees, the four who move
// in when a house is done. Ported from settle/life.ts's SettlementLife (gone: settle/crowd.ts wires TownLife to the
// agents). The heaps are the town's stores of stone and logs (its record's: what's brought in is counted, what a
// builder takes is taken) and its ground: a builder's load is taken off a heap, a miner's or a woodcutter's put on one
// (the crowd puts it, it knows what was dug).
import type { Good, Goods } from '../api/contracts/fortress';
import type { Settlement } from '../api/contracts/settlement';
import type { V2 } from '../api/contracts/units';
import type { Block } from '../build/town';
import { ECON } from '../fortress/defs';
import type { JobKind, JobSlot, Load } from '../town/jobs';
import type { Crowd, LifeEvent, TownWork } from '../town/life';
import { routineOf, type LiveSite, type LiveSpot } from './live';
import type { SiteSpec } from './plan';

/** the trades' work, as the crowd's structures (a settlement's jobs aren't its plan's structures: one slot a trade) */
export const FARM = 1;
export const QUARRY = 2;
export const LUMBER = 3;
/** cells³ a load (a builder's off the heap; a miner's take); what a storey takes (a lot was ~5 blocks a level) */
export const LOAD = 0.45;
const STOREY_COST = 1.2 * 5;
/** seconds a farmer's reap */
const REAP_S = 5;
/** the trades who move in when a house is done */
const MOVE_IN = ['builder', 'miner', 'woodcutter', 'farmer'];

export interface SettleWorkIO {
  rec: Settlement;
  spots(): LiveSpot[];
  sites(): LiveSite[];
  /** the woodcutters' trees (window world) */
  trees(): V2[];
  take(at: V2, amount: number): Promise<{ material: string; amount: number }>;
  raise(site: SiteSpec, storeys: number): void;
  ready(at: V2): boolean;
  finished(site: SiteSpec): void;
  mayMine(at: V2): boolean;
  /** the settlement's units out now, alive, and how many may be (the tier's budget) */
  out(): number;
  budget: number;
}

export class SettleWork implements TownWork {
  readonly daySec = ECON.daySec;
  readonly drillSec = 0;
  readonly patrolPoints = 0;
  /** loads moved, storeys built, houses finished, mines the town may not work, ground moved (cells³) */
  readonly stats = { trips: 0, blocks: 0, houses: 0, denied: 0, built: 0 };
  /** the trades moving in (a house done), the next first; the door of the house last finished: where they come out */
  private comers: string[] = [];
  doorWas: V2 | null = null;
  private events: LifeEvent[] = [];
  private siteKey = '';

  constructor(private io: SettleWorkIO) {}

  private emit(e: LifeEvent): void {
    const last = this.events[this.events.length - 1];
    if (last && last.type === e.type && (e.type !== 'spot' || (last.type === 'spot' && last.structure === e.structure))) return;
    this.events.push(e);
  }

  /** the town's events since the last call (the house to build changed, goods in, room for a newcomer, work ready) */
  drain(): LifeEvent[] {
    const s = this.site();
    const key = s ? `${s.spec.id}` : '';
    if (key !== this.siteKey) {
      this.siteKey = key;
      this.emit({ type: 'sites' });
    }
    return this.events.splice(0);
  }

  /** the woods' trees found again: the woodcutters waiting are told */
  spotReady(structure: number): void {
    this.emit({ type: 'spot', structure });
  }

  /** the house being built: the first unfinished site */
  site(): LiveSite | null {
    return this.io.sites().find((s) => !s.spec.finished) ?? null;
  }

  /** the heaps (piles), and their middle: where the builders fetch and the hauls go */
  heaps(): { what: string; w: V2 }[] {
    return this.io
      .spots()
      .filter((s) => s.kind === 'pile')
      .map((s) => ({ what: s.what ?? 'stone', w: s.w }));
  }

  /** the farmers' round: the farms, and the purposes' work (the piers, the stalls, the mill, the stables) */
  farms(): V2[] {
    const trading = this.io.rec.purpose?.kind === 'trading';
    return this.io
      .spots()
      .filter((s) => s.kind === 'farm' || s.kind === 'load' || s.kind === 'mill' || s.kind === 'tend' || (trading && s.kind === 'trade'))
      .slice(0, 6)
      .map((s) => s.w);
  }

  /** the mines the town may work (diplomacy's rights) */
  mines(): V2[] {
    const mines = this.io.spots().filter((s) => s.kind === 'mine');
    const ok = mines.filter((m) => this.io.mayMine(m.w)).map((m) => m.w);
    this.stats.denied = mines.length - ok.length;
    return ok;
  }

  /** the people of each trade's round (the record's, the guards and the hostile aside) */
  private trades(): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of this.io.rec.people) {
      if (p.hostile) continue;
      const r = routineOf(p.role);
      if (r === 'guard') continue;
      out.set(r, (out.get(r) ?? 0) + p.count);
    }
    return out;
  }

  slots(_crowd: Crowd): JobSlot[] {
    const t = this.trades();
    const out: JobSlot[] = [];
    const add = (key: string, kind: JobKind, structure: number | null, ok: boolean) => {
      if (ok && t.get(key)) out.push({ key, kind, structure, count: t.get(key)! });
    };
    // (the builders while a house is to build and a heap to fetch from; the others while their work's there)
    add('builder', 'build', null, !!this.site() && this.heaps().length > 0);
    add('farmer', 'farm', FARM, this.farms().length > 0);
    add('miner', 'quarry', QUARRY, this.mines().length > 0);
    add('woodcutter', 'lumber', LUMBER, true);
    return out;
  }

  /** a builder at the heaps: a load (the town's stone or logs, taken off a heap's ground), for the house going up */
  nextLoad(): { block: Block; load: Load } | null {
    const s = this.site();
    const heaps = this.heaps();
    if (!s || !heaps.length) return null;
    const st = this.io.rec.stores;
    const good = (['stone', 'log'] as Good[]).find((g) => (st[g]?.stock ?? 0) >= 1);
    if (!good) return null;
    st[good]!.stock -= 1;
    const heap = heaps.find((h) => (good === 'log' ? h.what === 'log' : h.what !== 'log')) ?? heaps[0];
    void this.io.take(heap.w, LOAD);
    return { block: { cell: s.spec.structure, level: s.spec.done ?? 0 }, load: { good, amount: 1 } };
  }

  siteAt(_at: V2, _load: Load, meant: Block): Block | null {
    const s = this.site();
    return s && s.spec.structure === meant.cell ? meant : null;
  }

  /** a load into the house: a storey every STOREY_COST (the settlement's view raises it); done, four move in */
  workIn(_block: Block, _load: Load): void {
    const s = this.site();
    if (!s) return;
    const spec = s.spec;
    this.stats.trips++;
    spec.progress = (spec.progress ?? 0) + LOAD;
    this.stats.built += LOAD;
    // (a storey goes up where the ground's heights are in: none while they're being read again)
    while (spec.progress >= STOREY_COST && (spec.done ?? 0) < spec.storeys && this.io.ready(s.door)) {
      spec.progress -= STOREY_COST;
      spec.done = (spec.done ?? 0) + 1;
      this.io.raise(spec, spec.done);
      this.stats.blocks++;
    }
    if ((spec.done ?? 0) >= spec.storeys && spec.storeys) {
      this.stats.houses++;
      this.io.finished(spec);
      // (four more people: counted in the record, and they come as the budget lets them out)
      for (const role of MOVE_IN) {
        const p = this.io.rec.people.find((x) => x.role === role);
        if (p) p.count++;
        else this.io.rec.people.push({ role, count: 1 });
        this.comers.push(role);
      }
      this.doorWas = s.door;
      this.emit({ type: 'room' });
      this.emit({ type: 'sites' });
    }
  }

  giveBack(_block: Block, load: Load): void {
    const st = (this.io.rec.stores[load.good] ??= { stock: 0, rate: 0 });
    st.stock += load.amount;
    this.emit({ type: 'stores' });
  }

  deliver(goods: Goods, _from: number | null): void {
    for (const [g, v] of Object.entries(goods) as [Good, number][]) {
      if (!(v > 0)) continue;
      const st = (this.io.rec.stores[g] ??= { stock: 0, rate: 0 });
      st.stock += v;
    }
    this.emit({ type: 'stores' });
  }

  workSpot(kind: JobKind, _structure: number, at: V2): V2 | null {
    if (kind === 'farm') return nearest(this.farms(), at);
    if (kind === 'quarry') return nearest(this.mines(), at);
    if (kind === 'lumber') return nearest(this.io.trees(), at);
    return null;
  }

  reap(): { goods: Goods; seconds: number } {
    return { goods: { grain: 1 }, seconds: REAP_S };
  }

  dugGoods(amount: number): Goods {
    return amount > 0 ? { stone: 1 } : {};
  }

  startBatch(): null {
    return null;
  }
  finishBatch(): Goods | 'soldier' {
    throw new Error('settle work: no batches in a settlement');
  }
  dropBatch(): void {}
  pile(): boolean {
    return false;
  }
  pileFor(): number | null {
    return null;
  }
  loadPile(): Goods {
    return {};
  }
  unclaim(): void {}
  wallPoint(): V2 | null {
    return null;
  }

  /** a newcomer while one is moving in (a house done) and the budget lets one more out */
  mayArrive(_crowd: Crowd): boolean {
    return this.comers.length > 0 && this.io.out() < this.io.budget;
  }

  /** the trade of the next to move in */
  nextComer(): string | null {
    return this.comers.shift() ?? null;
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
