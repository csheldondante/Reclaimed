// (card-table; docs/design/CARD_TABLE.md) The card table's driver: a home-town run played with no world, no GPU and no
// DOM. It does what scenes/level/loop.ts does without a scene — makes the Realm (season/realm.ts: the same living
// engine, templates, dealer, fact layer and ledger the 3D loop plays), takes and passes offers, ends a season, and
// starts the next run on the saved world — and gives plain view records to the page (table/main.ts) and the bots
// (table/bots.ts). Nothing of the model is copied here: every number a view carries is read from the Realm.
// Deterministic: same seed, leader and moves, the same run (no clock, no random number).
import type { WorldSnapshot } from '../api/contracts/world';
import { briarWorld } from '../living/briar';
import { text } from '../living/dsl';
import type { Offer } from '../living/engine';
import { newLedger, nextSeason, pools, total, POOLS, POOL_ROLE, type Pool, type Pools, type SeasonLedger } from '../season/ledger';
import { Realm, RUN_SEASONS } from '../season/realm';
import { LEADERS, leader as leaderOf, resultLines, resultTitle, threatText, costText } from '../season/run-words';
import { military, settle, SQUAD } from '../season/war';
import * as W from './words';

/** the test world every table run starts from (living/briar.ts), and its home town.
 *  FIXED-CITY: one home town for the whole run (the Realm's own assumption, BACKLOG LS-40) */
export const HOME = 'briar-hollow';

export interface TableOptions {
  seed: number;
  leader: string;
  seasons?: number;
  /** the world an earlier run left (absent: the test world) and what it built */
  world?: WorldSnapshot;
  built?: string[];
}

/** an opportunity as a card: every number is the model's */
export interface OppCard {
  id: string;
  template: string;
  title: string;
  /** who asks: their name and what they are */
  who: string;
  role: string;
  line: string;
  /** the place it stands at */
  place: string;
  /** what it costs, in the pools' words; and each pool's part (locked people, goods spent) */
  cost: string;
  locks: Partial<Pools>;
  costs: Partial<Pools>;
  turns: number;
  /** what the player gets if it is taken */
  gives: string;
  /** what happens if it runs out (null: nothing, it goes away) */
  lapse: string | null;
  /** seasons it stays (1: this is the last) */
  left: number;
  threat: boolean;
  tags: string[];
  /** what is short (empty: it can be taken) */
  short: Partial<Pools>;
}

/** a thing under way: a project being built, a crew sent */
export interface Working {
  id: string;
  title: string;
  /** seasons until it is done */
  left: number;
}

export interface LogLine {
  season: number;
  kind: 'took' | 'passed' | 'news' | 'pools' | 'built' | 'fight' | 'run';
  text: string;
}

export interface PoolView {
  pool: Pool;
  /** free now; people: of how many */
  have: number;
  of: number | null;
  income: number;
}

export class Table {
  realm: Realm;
  readonly seed: number;
  /** every move made, in order: 'take <template>', 'pass <template>', 'end' — a run replays from them */
  readonly moves: string[] = [];
  readonly log: LogLine[] = [];
  /** the pools at the start of each season (index 0: season 1) */
  readonly curve: Pools[] = [];
  /** offers on the board at the start of each season, and how many were taken in it */
  readonly asked: number[] = [];
  readonly took: number[] = [];
  /** threatening offers that ran out (template ids) */
  readonly lapsed: string[] = [];
  /** the fight's lines once it is fought */
  result: { title: string; lines: string[] } | null = null;
  /** the run's number in this world (1 the first) */
  run = 1;

  constructor(readonly o: TableOptions) {
    this.seed = o.seed;
    const who = leaderOf(o.leader);
    // (a new run: the leader's pools; what earlier runs built is kept — scenes/level/loop.ts `pick` does the same)
    const ledger: SeasonLedger = { ...newLedger(who.pools, who.income), built: [...(o.built ?? [])] };
    // (the land for district cards: the table has no town plan — every district has room)
    this.realm = new Realm({ world: o.world ?? briarWorld().ws.snapshot(), home: HOME, seed: o.seed, leader: who, ledger, land: () => ({ left: 14, open: [] }), seasons: o.seasons ?? RUN_SEASONS });
    this.run = this.realm.history(true).filter((e) => e.kind === 'run-began').length;
    this.say('run', W.runBegan(who.name, this.run, this.realm.seasons));
    this.mark();
  }

  private say(kind: LogLine['kind'], t: string): void {
    this.log.push({ season: this.realm.season, kind, text: t });
  }
  /** the season's start, for the curves */
  private mark(): void {
    this.curve.push(pools(this.realm.ledger));
    this.asked.push(this.offered().length);
    this.took.push(0);
  }

  // ---- what the page shows ---------------------------------------------------------------------------------------------

  get season(): number {
    return this.realm.season;
  }
  get over(): boolean {
    return this.realm.over;
  }
  title(): string {
    return W.header(this.realm.leader.name, Math.min(this.realm.season, this.realm.seasons), this.realm.seasons, this.run);
  }
  threat(): string {
    return threatText(this.realm.threatIn(), this.realm.averted);
  }
  poolViews(): PoolView[] {
    const l = this.realm.ledger;
    const p = pools(l);
    return POOLS.map((k) => ({ pool: k, have: p[k], of: POOL_ROLE[k] === 'people' ? total(l, k) : null, income: l.income[k] ?? 0 }));
  }

  private offered(): Offer[] {
    return this.realm.offers().filter((o) => o.status === 'offered');
  }

  cards(): OppCard[] {
    const r = this.realm;
    return this.offered().map((o) => {
      const t = r.engine.template(o.template);
      const locks: Partial<Pools> = {};
      for (const q of o.opp.requires) if (q.kind === 'workers' || q.kind === 'army') locks[q.kind === 'workers' ? 'labor' : 'might'] = q.count;
      const costs = { ...(o.opp.costs ?? {}) } as Partial<Pools>;
      const turns = 'turns' in o.opp.duration ? o.opp.duration.turns : 1;
      const person = r.w.facts.entity(o.presenter);
      return {
        id: o.id,
        template: o.template,
        title: o.opp.title,
        who: person?.name ?? r.w.name(o.presenter),
        role: t.presenter.role,
        line: o.line,
        place: r.w.name(o.place),
        cost: costText(locks, costs, turns),
        locks,
        costs,
        turns,
        gives: o.reward,
        lapse: t.expireText ? text(r.engine.ctx(t, o.bind, o.id), t.expireText) : null,
        left: r.left(o),
        threat: !!t.threat,
        tags: [...t.themes],
        short: r.short(o),
      };
    });
  }

  working(): Working[] {
    const r = this.realm;
    const projects = r.ledger.projects.map((p) => ({ id: p.id, title: p.card.title, left: p.commitment.resolvesTurn! - r.ledger.season }));
    const mine = new Set(r.ledger.projects.map((p) => p.id));
    const sent = r.engine.running().filter((o) => !mine.has(o.id)).map((o) => ({ id: o.id, title: o.opp.title, left: Math.max(1, (o.resolvesTurn ?? r.w.turn + 1) - r.w.turn) }));
    return [...projects, ...sent];
  }

  built(): string[] {
    return [...this.realm.ledger.built];
  }

  // ---- the player's moves ----------------------------------------------------------------------------------------------

  private find(id: string): Offer {
    const o = this.offered().find((x) => x.id === id || x.template === id);
    if (!o) throw new Error(`table: nothing offered as ${id}`);
    return o;
  }

  /** take an offer (by its id or its template's): its cost paid through the Realm. False: something is short */
  take(id: string): boolean {
    const o = this.find(id);
    if (Object.keys(this.realm.short(o)).length) return false;
    this.realm.commit(o.id);
    this.moves.push(`take ${o.template}`);
    this.took[this.took.length - 1]++;
    this.say('took', W.took(o.opp.title));
    return true;
  }

  pass(id: string): void {
    const o = this.find(id);
    this.realm.refuse(o.id);
    this.moves.push(`pass ${o.template}`);
    this.say('passed', W.passed(o.opp.title));
  }

  /** the season ends: the Realm's (commitments resolve, offers run out, the arc), the ledger's (income, building), the
   *  deal again; then the attack, if this was the season it came */
  endSeason(): void {
    const r = this.realm;
    if (r.over) return;
    this.moves.push('end');
    const past = r.engine.past.length;
    const before = pools(r.ledger);
    const news = r.endSeason();
    this.lapsed.push(...r.engine.past.slice(past).filter((o) => o.status === 'expired' && r.engine.template(o.template).threat).map((o) => o.template));
    const res = nextSeason(r.ledger);
    r.afterSeason(res.ledger);
    for (const n of news) this.say('news', n);
    for (const c of res.finished) this.say('built', W.builtLine(r.ledger.projects.find((p) => p.card.id === c)?.card.name ?? c));
    const after = pools(r.ledger);
    const d = W.deltaLine(before, after);
    if (d) this.say('pools', d);
    if (r.raid !== null) this.fightNow();
    if (!r.over) this.mark();
    else this.say('run', W.RUN_OVER);
  }

  /**
   * CT-TEMP (BACKLOG CT-1): the raid's result with no fight played, until round 6's live events are merged
   * (`Realm.finishLive`: the raid as a template read by rules). A stand-in so a run can end: with somewhere to gather
   * (walls or a keep: season/war.ts `military`), each soldier stops one raider and one soldier falls for every two
   * raiders stopped; with nowhere to gather, nobody fights. The losses are the model's own (`war.ts: settle`).
   */
  private fightNow(): void {
    const r = this.realm;
    const n = r.raid ?? 0;
    const soldiers = military(r.ledger) ? pools(r.ledger).might * SQUAD : 0;
    const stopped = Math.min(n, soldiers);
    const fight = { raiders: n, left: n - stopped, fallen: Math.min(soldiers, Math.floor(stopped / 2)) };
    const s = settle(r.ledger, fight);
    r.ledger = s.ledger;
    r.fought(fight);
    this.result = { title: resultTitle(r.fight!), lines: resultLines(r.fight!, s.lost) };
    this.say('fight', `${this.result.title}. ${this.result.lines.join(' ')}`);
  }

  /** the next run in the world this one left: what was built stays, the history stays */
  next(leader: string): Table {
    return new Table({ seed: this.seed, leader, seasons: this.realm.seasons, world: this.realm.snapshot(), built: this.built() });
  }

  /** what this run did to the world, for its end: the history's lines, oldest first */
  story(): string[] {
    return this.realm.history().filter((e) => e.note && e.kind !== 'run-began').map((e) => W.storyLine(e.turn - (this.realm.w.turn - this.realm.season), e.note!));
  }
}

/** a run replayed from its moves (a test; the page's seed box makes the same run when the same cards are tapped) */
export function replay(o: TableOptions, moves: readonly string[]): Table {
  const t = new Table(o);
  for (const m of moves) {
    const [verb, id] = m.split(' ');
    if (verb === 'end') t.endSeason();
    else if (verb === 'take') t.take(id);
    else if (verb === 'pass') t.pass(id);
    else throw new Error(`table: no move ${m}`);
  }
  return t;
}

export { LEADERS };
