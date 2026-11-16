// (loop-skeleton round 2; docs/design/LOOP_SKELETON.md "Conformance") The realm: a home-town run on the existing
// engine. It joins the living engine (living/engine.ts: templates over the fact world, the one dealer, the one
// contract) to the season ledger (season/ledger.ts: the pools, the projects the season loop builds). It replaces round
// 1's run record, its deck and hand, its effects and its world record:
//   - what is offered: `LivingEngine.deal` (the dealer deals few, by its own tuning; nothing here caps a hand);
//   - committing: `LivingEngine.commit` on the one Holdings record, which is the ledger's (people locked, goods spent);
//     a town project is then adopted by the ledger so the season builds it;
//   - a season: `LivingEngine.advance` (commitments due resolve into the fact layer, offers past their time fire their
//     expiry, the run's arc moves on), then the ledger's own season (income, stages) — the caller runs that between
//     `endSeason` and `afterSeason`, since the season loop owns it;
//   - the world's record: the fact layer (entities, relations, claims, the event history) in the WorldState, saved
//     whole (`snapshot`) and read by the next run.
// The run's own state (its length, the spells unlocked, the raid due, the fight) is small and kept here; each change is
// also an event in the history. Pure: no DOM, no GPU, no clock.
import type { EntityId, FactEvent } from '../api/contracts/facts';
import type { WorldSnapshot } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';
import { text, type Helper, type Stage } from '../living/dsl';
import { LivingEngine, type EngineReport, type Offer, type TemplateDef } from '../living/engine';
import { seedLocus } from '../living/seed';
import { FactWorld } from '../living/world';
import { OPP_TUNE, type DealerTune } from '../opps/tune';
import { CATALOG, card } from './catalog';
import { hasLand, type Land } from './deal';
import { adopt, lose, grant, pools, POOL_ROLE, type Pool, type Pools, type SeasonLedger } from './ledger';
import { cardOfTemplate, projectTemplate, raidArc, siteId, SITES, WORLD_TEMPLATES, type SiteKey } from './realm-templates';

/** seasons to the run's major threat (a knob; 16 is the orchestrator's number, not the user's) */
export const RUN_SEASONS = 16;
/** seasons before the attack from which the raiders can be paid off */
export const TRIBUTE_SEASONS = 3;

export type SpellId = 'heatray';

export interface Leader {
  id: string;
  name: string;
  line: string;
  pools: Partial<Pools>;
  income: Partial<Pools>;
}

/** a physical change an outcome named, for the mutators (a stub until `origin/mutators` is merged): what, and where */
export interface PhysicalAsk {
  kind: string;
  /** a site of the home town, or another place of the world (a fact entity) */
  at: EntityId;
  /** the event that caused it (the fact layer's history) */
  cause: number | string;
  season: number;
}

export interface RealmOptions {
  /** the world as saved, or the atlas's own (never changed: restored into a new WorldState) */
  world: WorldSnapshot;
  /** the home town's settlement id */
  home: EntityId;
  seed: number;
  leader: Leader;
  /** the ledger this run starts with (the leader's pools; what earlier runs built) */
  ledger: SeasonLedger;
  /** the town's land for district cards (the season loop's), read when a deal asks */
  land: () => Land;
  /** the run's length in seasons (default RUN_SEASONS) */
  seasons?: number;
  tune?: () => DealerTune;
}

export class Realm {
  readonly ws: MemoryWorldState;
  readonly w: FactWorld;
  readonly engine: LivingEngine;
  readonly home: EntityId;
  readonly seasons: number;
  readonly leader: Leader;
  /** the season ledger: its holdings are the fact world's (one record) */
  private led: SeasonLedger;
  readonly spells: SpellId[] = [];
  /** the attack due now (its size), once the arc's last stage lands */
  raid: number | null = null;
  /** the threat is over: fought, or paid off */
  fight: { raiders: number; left: number; fallen: number; held: boolean } | null = null;
  averted = false;
  /** physical changes outcomes named, not yet handed to the mutators */
  readonly physical: PhysicalAsk[] = [];
  /** what happened this season, in the player's words (resolved, lapsed, the arc) */
  news: string[] = [];
  last: EngineReport;

  constructor(private o: RealmOptions) {
    this.ws = MemoryWorldState.restore(structuredClone(o.world));
    this.w = new FactWorld(this.ws);
    this.home = o.home;
    this.seasons = o.seasons ?? RUN_SEASONS;
    this.leader = o.leader;
    this.led = o.ledger;
    this.w.holdings = o.ledger.holdings;
    const f = this.w.facts;
    if (!this.w.settlement(o.home)) throw new Error(`realm: no settlement ${o.home} in the world`);
    seedLocus(this.w, o.home, o.seed);
    this.w.diplomacy.idOf({ player: true });
    // (the home town's sites: named buildings and districts a card stands at — once a world)
    const region = this.w.settlement(o.home)!.region;
    for (const s of SITES) if (!f.entity(siteId(o.home, s.key))) f.add({ id: siteId(o.home, s.key), kind: 'site', name: s.name, at: { region, settlement: o.home }, attrs: { site: s.key, what: s.kind }, cause: 'realm' });
    // (a run's turn is its season; the history's turns run on across runs)
    const start = Math.max(f.turn, 0) + 1;
    f.turn = start;
    this.t0 = start - 1;
    f.record({ kind: 'run-began', by: ['player'], to: [o.home], note: `${o.leader.name} took the town` });
    f.drainChanged();
    const templates: TemplateDef[] = [...CATALOG.map(projectTemplate).filter((t): t is TemplateDef => t !== null), ...WORLD_TEMPLATES];
    // (the arc's turns are the history's: this run's seasons after the turn it began at)
    const rel = raidArc(o.home, this.seasons);
    const arc = { ...rel, stages: rel.stages.map((s) => ({ ...s, turn: this.t0 + s.turn })) };
    // (the arc's entity is the world's: a new run's arc starts from its first stage)
    const old = f.entity(`arc:${arc.id}`);
    if (old) old.attrs.stage = -1;
    this.engine = new LivingEngine(this.w, templates, arc, o.home, {
      stage: this.stage(),
      tune: o.tune ?? (() => ({ ...OPP_TUNE.dealer, reach: Number.MAX_VALUE })),
      economy: false,
      limitBoard: true,
      rng: () => 0,
    });
    this.last = this.engine.deal();
    this.sync();
  }
  /** the history's turn before this run's first season */
  private t0: number;

  /** the run's season (1 the first) */
  get season(): number {
    return this.w.turn - this.t0;
  }

  get ledger(): SeasonLedger {
    return this.led;
  }
  /** the ledger as the season loop left it (income added, a fight's losses): its holdings are the world's again */
  set ledger(l: SeasonLedger) {
    this.led = l;
    this.w.holdings = l.holdings;
  }
  private sync(): void {
    this.led = { ...this.led, holdings: this.w.holdings };
  }

  // ---- what the templates ask of the run (living/dsl.ts Stage) -------------------------------------------------------

  private stage(): Stage {
    const pool = (k: Pool, n: number) => {
      const l = { ...this.led, holdings: this.w.holdings };
      const next = k === 'unrest' ? lose(l, { unrest: n }) : n >= 0 ? grant(l, { [k]: n }) : lose(l, { [k]: -n });
      this.w.holdings = next.holdings;
      this.led = { ...this.led, holdings: next.holdings };
    };
    const helpers: Record<string, Helper> = {
      isHome: { pred: (c, a) => refOf(c.b, a[0]) === this.home },
      siteIs: { pred: (c, a) => this.w.facts.entity(refOf(c.b, a[0]))?.attrs?.site === a[1] && this.w.facts.entity(refOf(c.b, a[0]))?.at?.settlement === this.home },
      exists: { pred: (_c, a) => !!this.w.facts.entity(String(a[0])) },
      neighbour: { pred: (c, a) => refOf(c.b, a[0]) === this.neighbour() },
      canBuild: {
        pred: (_c, a) => {
          const c = card(String(a[0]));
          const l = this.led;
          const started = l.built.includes(c.id) || l.projects.some((p) => p.card.id === c.id);
          return (c.needs ?? []).every((n) => l.built.includes(n)) && (c.repeat || !started) && hasLand(l, this.o.land(), c);
        },
      },
      hasSpell: { pred: (_c, a) => this.spells.includes(a[0] as SpellId) },
      threatComing: { pred: () => !this.averted && !this.fight && this.raid === null },
      threatNear: { pred: () => this.seasons - this.season < TRIBUTE_SEASONS },
      pool: { effect: (c, a) => void (c.dry || pool(a[0] as Pool, Number(a[1]))) },
      income: {
        effect: (c, a) => {
          if (c.dry) return;
          const k = a[0] as Pool;
          this.led = { ...this.led, income: { ...this.led.income, [k]: (this.led.income[k] ?? 0) + Number(a[1]) } };
        },
      },
      spell: { effect: (c, a) => void (c.dry || this.spells.includes(a[0] as SpellId) || this.spells.push(a[0] as SpellId)) },
      raid: { effect: (c, a) => void (c.dry || this.averted || (this.raid = Number(a[0]))) },
      avert: { effect: (c) => void (c.dry || (this.averted = true)) },
      physical: { effect: (c, a) => void (c.dry || this.physical.push({ kind: String(a[0]), at: refOf(c.b, a[1]), cause: c.cause, season: this.season })) },
    };
    return { helpers };
  }

  /** the standing settlement nearest the home town (the neighbour its cards are about); null: none */
  neighbour(): EntityId | null {
    const h = this.w.settlement(this.home)!;
    let best: EntityId | null = null;
    let d = Infinity;
    for (const s of this.ws.settlements) {
      if (s.id === this.home || s.condition === 'ruined' || s.condition === 'abandoned' || !this.w.facts.entity(s.id) || s.size === 'camp') continue;
      const x = Math.hypot(s.at[0] - h.at[0], s.at[1] - h.at[1]);
      if (x < d) [d, best] = [x, s.id];
    }
    return best;
  }

  // ---- the player's moves ---------------------------------------------------------------------------------------------

  /** what is offered now (the dealer's deal), each over its site */
  offers(): Offer[] {
    return this.engine.offered;
  }
  /** the site of the home town an offer stands at */
  siteOf(o: Offer): SiteKey | null {
    return (this.w.facts.entity(o.place)?.attrs?.site as SiteKey | undefined) ?? null;
  }
  /** seasons an offer stays (1: this is the last) */
  left(o: Offer): number {
    return o.expires - this.w.turn + 1;
  }

  /** what an offer needs that isn't free now (empty: it can be committed) */
  short(o: Offer): Partial<Pools> {
    const have = pools(this.led);
    const out: Partial<Pools> = {};
    for (const r of o.opp.requires) {
      const k: Pool | null = r.kind === 'workers' ? 'labor' : r.kind === 'army' ? 'might' : null;
      if (k && have[k] < r.count) out[k] = r.count - have[k];
    }
    for (const [g, n] of Object.entries(o.opp.costs ?? {})) if (POOL_ROLE[g as Pool] === 'goods' && have[g as Pool] < n) out[g as Pool] = n - have[g as Pool];
    return out;
  }

  /** Commit to an offer: its people locked and goods spent by the contract; a town project adopted by the ledger. */
  commit(id: string): Offer {
    this.w.holdings = this.led.holdings;
    const o = this.engine.commit(id);
    this.sync();
    const c = cardOfTemplate(o.template);
    if (c) this.led = adopt(this.led, card(c), o.commitment!, o.id, this.season + (o.resolvesTurn! - this.w.turn));
    this.w.holdings = this.led.holdings;
    return o;
  }

  refuse(id: string): Offer {
    const o = this.engine.refuse(id);
    this.sync();
    return o;
  }

  /**
   * The season ends for the opportunities (before the ledger's own season): commitments due resolve into the fact
   * layer, offers past their time fire their expiry, the arc moves on, the next deal is made. Returns the season's news.
   */
  endSeason(): string[] {
    this.w.holdings = this.led.holdings;
    const before = this.engine.changes.length;
    const past = this.engine.past.length;
    this.last = this.engine.advance();
    this.sync();
    // (the season's news in the cards' own words: what was done, what was left too long; then the arc's stage)
    const told = this.engine.past.slice(past).flatMap((o) => {
      const t = this.engine.template(o.template);
      const line = o.status === 'resolved' ? t.outcomeText : o.status === 'expired' ? t.expireText : undefined;
      return line ? [text(this.engine.ctx(t, o.bind, o.id), line)] : [];
    });
    const arc = this.engine.changes.slice(before).filter((c) => !/^(resolved|lapsed|committed): /.test(c.what)).map((c) => arcLine(c.what));
    this.news = [...told, ...arc];
    return this.news;
  }

  /** after the ledger's season (income in, people back from the fight): the deal again over what is free now */
  afterSeason(l: SeasonLedger): void {
    this.ledger = l;
    this.last = this.engine.redeal();
    this.sync();
  }

  /** the attack fought: written to the history; broken through, the district the raiders came by is burned */
  fought(f: { raiders: number; left: number; fallen: number }): void {
    const held = f.raiders > 0 && f.left === 0;
    this.fight = { ...f, held };
    this.raid = null;
    const e = this.w.facts.record({ kind: held ? 'raid-held' : 'raid-broke', by: [], to: [this.home], note: held ? `the town held against ${f.raiders} raiders; ${f.fallen} soldiers died` : `${f.left} of ${f.raiders} raiders broke into the town; ${f.fallen} soldiers died`, weight: held ? 0.5 : -0.6 });
    if (!held && f.raiders > 0) {
      const at = siteId(this.home, 'gate');
      this.w.facts.setTag(at, 'condition', 'burned', true, 'raid');
      this.physical.push({ kind: 'burned', at, cause: e.id, season: this.season });
    }
  }

  /** the run is over: the threat fought or paid off */
  get over(): boolean {
    return this.fight !== null || (this.averted && this.season >= this.seasons);
  }

  // ---- the record -----------------------------------------------------------------------------------------------------

  /** this run's events, oldest first (the end-of-run screen reads it; nothing else is kept of "what you caused") */
  history(all = false): FactEvent[] {
    return this.w.facts.events().filter((e) => all || e.turn > this.t0);
  }

  /** the world to save: the fact layer, the characters, the holdings (WorldState's own snapshot) */
  snapshot(): WorldSnapshot {
    return this.ws.snapshot();
  }
}

/** a bound name ('$site') or an id, as an id */
function refOf(b: Record<string, EntityId>, r: string | number | undefined): EntityId {
  const s = String(r ?? '');
  return s.startsWith('$') ? (b[s.slice(1)] ?? s) : s;
}

/** the arc's change line ("The raiders on the road: Scouts on the road — its text") as its text */
function arcLine(what: string): string {
  const i = what.indexOf(' — ');
  const t = i >= 0 ? what.slice(i + 3) : what;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
