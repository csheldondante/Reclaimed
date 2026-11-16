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
import { grant, lose, newLedger, nextSeason, pools, total, POOLS, POOL_ROLE, type Pool, type Pools, type SeasonLedger } from '../season/ledger';
import { CATALOG } from '../season/catalog';
import { projectTemplate, siteId, SITES, WORLD_TEMPLATES } from '../season/realm-templates';
import type { Pack, PackAbility } from '../packs/check';
import { castAbility, loadPack, packHelpers, packTagsOn, packThings, type LoadedPack, type PackHost } from '../packs/load';
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
  /** outside-authored packs played with the base cards (packs/load.ts); a pack with errors throws its report */
  packs?: Pack[];
  /** a pack's cards score above the base game's with the dealer, so a pack being tried comes up early (default true) */
  boost?: boolean;
}

/** the ids of the base game's cards (a pack's may not clash with them) */
export const baseCards = (): string[] => [...CATALOG.map(projectTemplate).filter((t) => t !== null).map((t) => t!.id), ...WORLD_TEMPLATES.map((t) => t.id)];
/** conditions that take a thing's working tags away (round 6's season/realm-rules.ts RUIN, until it is merged: CT-TEMP) */
const RUIN = ['burned', 'flooded', 'buried', 'melted', 'abandoned', 'destroyed', 'occupied', 'lost'];

/** a thing in play, as a small card */
export interface ThingView {
  id: string;
  name: string;
  /** the place it is grouped under */
  place: string;
  tags: string[];
  /** tags a thing standing on it lends it (in `tags` too): an ability is aimed at the thing itself, not at these */
  lent: string[];
  /** it has lost its working tags */
  ruined: boolean;
  text: string;
}
export interface AbilityView {
  id: string;
  name: string;
  /** Magic a cast costs */
  cost: number;
  text: string;
  /** the things in play it can be cast on now */
  targets: string[];
  /** there is Magic enough */
  can: boolean;
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
  /** every template that was on the board at a season's start, and those taken, in order */
  readonly seen = new Set<string>();
  readonly taken: string[] = [];
  /** synergy rules fired this run: a rule's name → times (filled once the model has rules: BACKLOG CT-5) */
  private fired: Record<string, number> = {};
  ruleCounts(): Record<string, number> {
    return { ...this.fired };
  }
  /** the fight's lines once it is fought */
  result: { title: string; lines: string[] } | null = null;
  /** the run's number in this world (1 the first) */
  run = 1;
  readonly packs: LoadedPack[];
  /** pack abilities the run has unlocked (CT-12: not yet part of the Realm's saved run) */
  readonly unlocked: string[] = [];

  constructor(readonly o: TableOptions) {
    this.seed = o.seed;
    const who = leaderOf(o.leader);
    // (a new run: the leader's pools; what earlier runs built is kept — scenes/level/loop.ts `pick` does the same)
    const ledger: SeasonLedger = { ...newLedger(who.pools, who.income), built: [...(o.built ?? [])] };
    // (the land for district cards: the table has no town plan — every district has room)
    const base = baseCards();
    this.packs = (o.packs ?? []).map((p) => loadPack(p, { cards: base, boost: o.boost ?? true }));
    // (the helpers a pack's cards name read the run through this; the Realm deals once while it is being made, before
    // there is a run to read: that deal sees the leader's pools and no tags, and the deal is made again below)
    let made: Realm | null = null;
    const host: PackHost = {
      season: () => made?.season ?? 1,
      pool: (k) => pools(made?.ledger ?? ledger)[k as Pool] ?? 0,
      leader: () => who.id,
      home: () => HOME,
      tags: (where) => (made ? this.things().filter((t) => (where === 'town') === (t.id === HOME)).map((t) => t.tags) : []),
      unlock: (id) => void (this.unlocked.includes(id) || this.unlocked.push(id)),
    };
    this.realm = new Realm({ world: o.world ?? briarWorld().ws.snapshot(), home: HOME, seed: o.seed, leader: who, ledger, land: () => ({ left: 14, open: [] }), seasons: o.seasons ?? RUN_SEASONS, ...(this.packs.length ? { extra: { templates: this.packs.flatMap((p) => p.templates), helpers: packHelpers(this.packs, host) } } : {}) });
    made = this.realm;
    if (this.packs.length) this.realm.afterSeason(this.realm.ledger);
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
    for (const o of this.offered()) this.seen.add(o.template);
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

  /**
   * The persistent things of the run with their tags, grouped by place. CT-TEMP (BACKLOG CT-6): until round 6's
   * `Realm.things()` is merged this lists the town, each site that has a state, and the packs' things; a ruined site
   * shows 'ruined' and what ruined it, and a pack's thing standing on it loses its tags.
   */
  // FIXED-CITY: every thing is the home town's, grouped under its sites
  things(): ThingView[] {
    const r = this.realm;
    const f = r.w.facts;
    const out: ThingView[] = [];
    const ruinOf = (id: string) => RUIN.filter((k) => !!f.tag(id, 'condition', k)?.value);
    const p = pools(r.ledger);
    // (a thing's tags are also carried by the place it stands at, while that place is not ruined: a rule or a card
    // can ask for a field with a granary)
    const mine = packThings(r.w, this.packs);
    const lent = (site: string | null) => mine.filter((t) => t.site === site).flatMap((t) => [...t.def.tags, ...packTagsOn(r.w, t.id, this.packs)]);
    out.push({ id: HOME, name: r.w.name(HOME), place: W.TOWN, tags: [...new Set(['town', 'home', ...(p.unrest > 0 ? ['unrest'] : []), ...packTagsOn(r.w, HOME, this.packs), ...lent(null)])], lent: lent(null), ruined: false, text: '' });
    for (const s of SITES) {
      const id = siteId(HOME, s.key);
      const ruin = ruinOf(id);
      const tags = ruin.length ? ['ruined', ...ruin] : [...new Set([...packTagsOn(r.w, id, this.packs), ...lent(id)])];
      if (tags.length) out.push({ id, name: s.name, place: s.name, tags, lent: ruin.length ? [] : lent(id), ruined: ruin.length > 0, text: '' });
    }
    for (const t of mine) {
      const ruin = t.site ? ruinOf(t.site) : [];
      out.push({ id: t.id, name: t.def.name, place: t.site ? r.w.name(t.site) : W.TOWN, tags: ruin.length ? ['ruined', ...ruin] : [...t.def.tags, ...packTagsOn(r.w, t.id, this.packs)], lent: [], ruined: ruin.length > 0, text: t.def.text });
    }
    return out;
  }

  private ability(id: string): PackAbility {
    const a = this.packs.flatMap((p) => p.abilities).find((x) => x.id === id);
    if (!a) throw new Error(`table: no ability ${id}`);
    return a;
  }

  /** the abilities the player has now, each with what it can be cast on */
  abilities(): AbilityView[] {
    const things = this.things();
    const magic = pools(this.realm.ledger).magic;
    return this.unlocked.map((id) => {
      const a = this.ability(id);
      const cost = a.cost.magic ?? 0;
      return { id, name: a.name, cost, text: a.text, targets: things.filter((t) => !t.ruined && a.target!.tags.every((x) => t.tags.includes(x) && !t.lent.includes(x))).map((t) => t.id), can: magic >= cost };
    });
  }

  /** cast an ability on a thing in play: its Magic spent, its effect applied. False: not a target, or no Magic */
  cast(id: string, target: string): boolean {
    const v = this.abilities().find((a) => a.id === id);
    if (!v || !v.can || !v.targets.includes(target)) return false;
    const r = this.realm;
    const on = this.things().find((t) => t.id === target)?.name ?? target;
    let l = lose(r.ledger, { magic: v.cost });
    const gains = castAbility(r.w, this.ability(id), target, this.packs);
    for (const [k, n] of Object.entries(gains) as [Pool, number][]) l = k === 'unrest' ? lose(l, { unrest: n }) : n > 0 ? grant(l, { [k]: n }) : lose(l, { [k]: -n });
    r.ledger = l;
    r.w.facts.record({ kind: 'ability-cast', by: ['player'], to: [target], note: W.castNote(v.name, on) });
    this.moves.push(`cast ${id} ${target}`);
    this.say('took', W.castLine(v.name, on, v.cost));
    return true;
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
    this.taken.push(o.template);
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
    return new Table({ seed: this.seed, leader, seasons: this.realm.seasons, world: this.realm.snapshot(), built: this.built(), ...(this.o.packs ? { packs: this.o.packs } : {}) });
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
    else if (verb === 'cast') t.cast(id, m.split(' ')[2]);
    else throw new Error(`table: no move ${m}`);
  }
  return t;
}

export { LEADERS };
