// (card-table; docs/design/CARD_TABLE.md) The card table's driver: a home-town run played with no world, no GPU and no
// DOM. It does what scenes/level/loop.ts does without a scene — makes the Realm (season/realm.ts: the same living
// engine, templates, dealer, fact layer, ledger, synergy rules and live events the 3D loop plays), takes and passes
// offers, casts spells, ends a season, and starts the next run on the saved world — and gives plain view records to
// the page (table/main.ts) and the bots (table/bots.ts). Nothing of the model is copied here: every number a view
// carries is read from the Realm. Deterministic: same seed, leader and moves, the same run (no clock, no random number).
//
// A live event (a raid, a parade, the dead, a fire) is not played in real time here. When it begins the Realm is told
// the state it would end in with nobody playing (living/live.ts mechState: groups do what they were ordered to, every
// logged cast does its SPELL_MECH), and told again after each cast; the season's end resolves it from that state by
// the Realm's own reading (Realm.finishLive: count, rules, derive, tier, the template's outcome).
import type { WorldSnapshot } from '../api/contracts/world';
import { briarWorld } from '../living/briar';
import { text } from '../living/dsl';
import type { Offer } from '../living/engine';
import { mechState, SPELL_MECH, type LiveDef, type LiveState } from '../living/live';
import type { RuleDef, RuleHit, RuleMissing } from '../living/rules';
import { grant, lose, newLedger, nextSeason, pools, total, POOLS, POOL_ROLE, type Pool, type Pools, type SeasonLedger } from '../season/ledger';
import { CATALOG } from '../season/catalog';
import { FIRE_TEMPLATE } from '../season/realm-events';
import { projectTemplate, SITES, WORLD_TEMPLATES, type SiteKey } from '../season/realm-templates';
import type { Pack, PackAbility } from '../packs/check';
import { castAbility, lentTo, loadPack, packHelpers, packThings, withPackThings, type LoadedPack, type PackHost } from '../packs/load';
import { BASIC_SPELLS, Realm, RUN_SEASONS, SPELL_COST, type SpellId } from '../season/realm';
import { LEADERS, leader as leaderOf, resultTitle, SPELL_NAME, threatText, costText } from '../season/run-words';
import { ROW_H } from '../world/lattice';
import * as W from './words';

/** the test world every table run starts from (living/briar.ts), and its home town.
 *  FIXED-CITY: one home town for the whole run (the Realm's own assumption, BACKLOG LS-40) */
export const HOME = 'briar-hollow';
/** (BACKLOG CT-17) The table has no town plan, so it lays the town's sites on a ring this many cells from its centre,
 *  in the order of SITES: two sites two places apart on the list are "next to" each other (74 cells), three apart are
 *  "close" (109). The 3D game gives the real places. */
export const SITE_RING = 120;

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
  /** the market's fire as a live event the player casts Rain into, in place of the instant "pay for fire wards"
   *  hazard (season/realm.ts liveFire). Default true at the table: nothing here needs the 3D fire (off in the 3D game:
   *  BACKLOG LS-63) */
  liveFire?: boolean;
  /** raiders in the last season, to try another number than the game's (BACKLOG CT-18) */
  raiders?: number;
}

/** the ids of the base game's cards (a pack's may not clash with them) */
export const baseCards = (): string[] => [...CATALOG.map(projectTemplate).filter((t) => t !== null).map((t) => t!.id), ...WORLD_TEMPLATES.map((t) => t.id), FIRE_TEMPLATE.id];

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
  /** a place of the town with nothing built or changed on it yet */
  plain: boolean;
  text: string;
}
export interface AbilityView {
  id: string;
  name: string;
  /** Magic a cast costs */
  cost: number;
  text: string;
  /** the things in play and the live events it can be cast on now */
  targets: string[];
  /** there is Magic enough */
  can: boolean;
}
/** a live event under way, as a card */
export interface EventView {
  id: string;
  template: string;
  title: string;
  how: string;
  place: string;
  /** who takes part: how many of what, as it would end now */
  groups: { who: string; n: number; alive: number; side: 'town' | 'foe' | 'folk' }[];
  /** a fire: its points, and how many would burn now */
  hazard: { points: number; burned: number } | null;
  /** the spells that can be cast into it, and the casts made */
  spells: string[];
  casts: { name: string; n: number }[];
  /** the rules that would apply if it ended now, each with its reason */
  rules: string[];
  /** how it would come out if it ended now */
  tier: string;
  outcome: string;
}
/** a synergy rule, for the rules list: fired, ready, or what it lacks */
export interface RuleView {
  id: string;
  name: string;
  /** what it reads and gives, in words */
  says: string;
  /** when it is looked at */
  when: string;
  /** its reasons from the last season's end (and since) */
  fired: string[];
  /** everything it needs is there: it fires when its trigger next happens */
  ready: boolean;
  /** what it is about, or the one thing it lacks */
  why: string;
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
  /** taking it starts a live event */
  live: boolean;
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
  kind: 'took' | 'passed' | 'news' | 'pools' | 'built' | 'fight' | 'run' | 'rule' | 'event';
  text: string;
}

export interface PoolView {
  pool: Pool;
  /** free now; people: of how many */
  have: number;
  of: number | null;
  income: number;
}

const SPELL_ID = 'spell:';
const TIER_RANK = ['disaster', 'failure', 'cost', 'success', 'triumph'];

export class Table {
  realm: Realm;
  readonly seed: number;
  /** every move made, in order: 'take <template>', 'pass <template>', 'cast <ability> <target>', 'end' */
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
  /** every synergy rule firing of the run, with the season it was in */
  readonly hits: { season: number; hit: RuleHit }[] = [];
  /** the firings since the last season's end began (the rules list shows them) */
  private recent: RuleHit[] = [];
  /** how each live event came out: its template and tier */
  readonly events: { season: number; template: string; tier: string }[] = [];
  /** the casts made into each live event under way: spell → times */
  private casts = new Map<string, Record<string, number>>();
  /** the Magic spent on casts this run */
  spent = 0;
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
    const base = baseCards();
    this.packs = (o.packs ?? []).map((p) => loadPack(p, { cards: base, boost: o.boost ?? true }));
    const world = o.world ?? briarWorld().ws.snapshot();
    const centre = world.settlements.find((s) => s.id === HOME)!.at;
    // (the helpers a pack's cards name read the run through this; the Realm deals once while it is being made, before
    // there is a run to read: that deal sees the leader's pools and no tags, and the deal is made again below)
    let made: Realm | null = null;
    const host: PackHost = {
      season: () => made?.season ?? 1,
      pool: (k) => pools(made?.ledger ?? ledger)[k as Pool] ?? 0,
      leader: () => who.id,
      home: () => HOME,
      tags: (where) => (made ? made.things().filter((t) => t.town === HOME && (where === 'town') === (t.id === HOME)).map((t) => [...t.tags]) : []),
      unlock: (id) => void (this.unlocked.includes(id) || this.unlocked.push(id)),
    };
    this.realm = new Realm({
      world,
      home: HOME,
      seed: o.seed,
      leader: who,
      ledger,
      // (the land for district cards: the table has no town plan — every district has room, BACKLOG CT-2)
      land: () => ({ left: 14, open: [] }),
      seasons: o.seasons ?? RUN_SEASONS,
      liveFire: o.liveFire ?? true,
      ...(o.raiders !== undefined ? { raiders: o.raiders } : {}),
      // (CT-17: the sites on a ring round the town's centre, so "next to" and "close" mean something here)
      where: (spot) => {
        const i = SITES.findIndex((s) => s.key === spot);
        if (i < 0) return null;
        const a = (2 * Math.PI * i) / SITES.length;
        return [centre[0] + SITE_RING * Math.cos(a), (centre[1] + SITE_RING * Math.sin(a)) / ROW_H];
      },
      onRules: (hits) => {
        for (const hit of hits) this.hits.push({ season: made?.season ?? 1, hit });
        this.recent.push(...hits);
      },
      extra: {
        templates: this.packs.flatMap((p) => p.templates),
        helpers: packHelpers(this.packs, host),
        rules: this.packs.flatMap((p) => p.rules),
        things: (things) => (made ? withPackThings(made.w, this.packs, things, HOME) : things),
      },
    });
    made = this.realm;
    if (this.packs.length) this.realm.afterSeason(this.realm.ledger);
    this.run = this.realm.history(true).filter((e) => e.kind === 'run-began').length;
    this.say('run', W.runBegan(who.name, this.run, this.realm.seasons));
    this.begin();
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
        live: !!r.liveOf(o),
        tags: [...t.themes],
        short: r.short(o),
      };
    });
  }

  working(): Working[] {
    const r = this.realm;
    const projects = r.ledger.projects.map((p) => ({ id: p.id, title: p.card.title, left: p.commitment.resolvesTurn! - r.ledger.season }));
    const mine = new Set(r.ledger.projects.map((p) => p.id));
    const sent = r.engine.running().filter((o) => !mine.has(o.id) && !r.liveOf(o)).map((o) => ({ id: o.id, title: o.opp.title, left: Math.max(1, (o.resolvesTurn ?? r.w.turn + 1) - r.w.turn) }));
    return [...projects, ...sent];
  }

  /** the persistent things of the run with their tags (the Realm's own list: `Realm.things`, the packs' things added),
   *  each under the place it is grouped by */
  // FIXED-CITY: a thing is the home town's (grouped under its sites) or a far place
  things(): ThingView[] {
    const r = this.realm;
    const mine = new Map(packThings(r.w, this.packs).map((t) => [t.id, t]));
    return r.things().map((t) => {
      const pack = mine.get(t.id);
      const lent = t.tags.includes('ruined') ? [] : lentTo(r.w, this.packs, t.id === HOME ? null : t.id);
      const site = SITES.find((s) => t.id.endsWith(`:${s.key}`) && r.w.facts.entity(t.id)?.kind === 'site');
      const place = t.id === HOME ? W.TOWN : t.town !== HOME ? W.FAR : pack ? (pack.site ? r.w.name(pack.site) : W.TOWN) : t.name;
      // (a place with nothing on it: what it is, and standing)
      const plain = !!site && !pack && !t.tags.some((x) => !['standing', ...(site ? siteIs(r, t.id) : [])].includes(x));
      return { id: t.id, name: t.name, place, tags: [...t.tags], lent, ruined: t.tags.includes('ruined'), plain, text: pack?.def.text ?? '' };
    });
  }

  private ability(id: string): PackAbility {
    const a = this.packs.flatMap((p) => p.abilities).find((x) => x.id === id);
    if (!a) throw new Error(`table: no ability ${id}`);
    return a;
  }
  /** the spells the run has: the three every leader has, and those unlocked */
  private spells(): SpellId[] {
    return [...new Set([...BASIC_SPELLS, ...this.realm.spells])];
  }
  /** a live event's state as it would end now: what the Realm was last told */
  private stateOf(o: Offer): LiveState {
    return mechState(this.realm.liveOf(o)!, this.realm.runNumbers(), this.casts.get(o.id) ?? {});
  }
  private tell(o: Offer): void {
    this.realm.tellLive(o.id, { state: this.stateOf(o) });
  }

  /** the abilities the player has now, each with what it can be cast on: the run's spells (a growth rune on a field,
   *  the others into a live event that allows them) and the packs' abilities (on things in play) */
  abilities(): AbilityView[] {
    const things = this.things();
    const r = this.realm;
    const magic = pools(r.ledger).magic;
    const live = r.liveRunning();
    const known = this.spells();
    const base = known.map((s): AbilityView => {
      const targets = s === 'growth' ? things.filter((t) => !t.ruined && t.tags.includes('field') && !t.tags.includes('growth-active') && !!siteKey(r, t.id)).map((t) => t.id) : live.filter((o) => fits(r.liveOf(o)!, s)).map((o) => o.id);
      return { id: SPELL_ID + s, name: SPELL_NAME[s], cost: SPELL_COST[s], text: W.SPELL_TEXT[s], targets, can: magic >= SPELL_COST[s] };
    });
    const mine = this.unlocked.map((id): AbilityView => {
      const a = this.ability(id);
      const cost = a.cost.magic ?? 0;
      return { id, name: a.name, cost, text: a.text, targets: things.filter((t) => !t.ruined && a.target!.tags.every((x) => t.tags.includes(x) && !t.lent.includes(x))).map((t) => t.id), can: magic >= cost };
    });
    return [...base, ...mine];
  }

  /** a cast into this live event would change how it stands (a foe still up for a spell that puts foes down, a point
   *  still burning for one that puts fire out) */
  useful(ability: string, event: string): boolean {
    const o = this.realm.liveRunning().find((x) => x.id === event);
    const m = SPELL_MECH[ability.slice(SPELL_ID.length)];
    if (!o || !m) return false;
    const s = this.stateOf(o);
    const def = this.realm.liveOf(o)!;
    const foes = def.groups.filter((g) => g.side === 'foe').reduce((n, g) => n + s.groups[g.id].alive, 0);
    return (!!m.kills && foes > 0) || (!!m.douses && s.burned > 0);
  }

  /** the live events under way, each as it would come out now */
  liveEvents(): EventView[] {
    const r = this.realm;
    return r.liveRunning().map((o) => {
      const def = r.liveOf(o)!;
      const s = this.stateOf(o);
      const p = r.predictLive(o.id, s);
      const casts = this.casts.get(o.id) ?? {};
      const known = this.spells();
      return {
        id: o.id,
        template: o.template,
        title: def.title,
        how: W.eventHow(known.filter((x) => fits(def, x)).map((x) => SPELL_NAME[x])),
        place: r.w.name(o.place),
        groups: def.groups.map((g) => ({ who: W.UNIT_NAME[g.kind] ?? g.kind, n: s.groups[g.id].made, alive: s.groups[g.id].alive, side: g.side })),
        hazard: def.hazard ? { points: s.points, burned: s.burned } : null,
        spells: known.filter((x) => fits(def, x)).map((x) => SPELL_NAME[x]),
        casts: Object.entries(casts).map(([k, n]) => ({ name: SPELL_NAME[k as SpellId] ?? k, n })),
        rules: p.hits.map((h) => `${h.name}. ${h.text}.`),
        tier: p.tier,
        outcome: p.text,
      };
    });
  }

  /** every synergy rule: what fired at the last season's end, what is ready, and for the rest the one thing missing */
  rules(): RuleView[] {
    const book = this.realm.rules;
    return book.rules.map((r) => {
      const c = book.check(r);
      const fired = this.recent.filter((h) => h.rule === r.id).map((h) => `${h.text}.`);
      const ready = c.ok || (c.missing?.kind === 'spent' && fired.length > 0);
      return { id: r.id, name: r.name, says: W.ruleSays(r), when: W.ruleWhen(r.on), fired, ready: c.ok, why: c.ok ? W.ruleReady(r.on, c.things ?? []) : ready ? W.RULE_SPENT : W.whyNot(c.missing as RuleMissing) };
    });
  }
  /** the tags on things in play now, each with how many things carry it */
  tagsInPlay(): { tag: string; n: number }[] {
    const count = new Map<string, number>();
    for (const t of this.realm.things()) for (const x of t.tags) count.set(x, (count.get(x) ?? 0) + 1);
    return [...count].map(([tag, n]) => ({ tag, n })).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  }
  /** synergy rules fired this run: a rule's name → times */
  ruleCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { hit } of this.hits) out[hit.name] = (out[hit.name] ?? 0) + 1;
    return out;
  }
  ruleDefs(): readonly RuleDef[] {
    return this.realm.rules.rules;
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

  /** the live events nobody asks about (the raid, refugees on the road) begin; each is told to the Realm as it stands */
  private begin(): void {
    const r = this.realm;
    for (let o = r.forcedLive(); o; o = r.forcedLive()) {
      r.commit(o.id);
      this.seen.add(o.template);
      this.tell(o);
      this.say('event', W.eventBegan(r.liveOf(o)!.title));
    }
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
    if (this.realm.liveOf(o)) {
      this.tell(o);
      this.say('event', W.eventBegan(this.realm.liveOf(o)!.title));
    }
    this.flushRules();
    return true;
  }

  pass(id: string): void {
    const o = this.find(id);
    this.realm.refuse(o.id);
    this.moves.push(`pass ${o.template}`);
    this.say('passed', W.passed(o.opp.title));
  }

  /** rule firings not yet in the log, as lines */
  private logged = 0;
  private flushRules(): void {
    for (const { hit } of this.hits.slice(this.logged)) this.say('rule', W.ruleLine(hit.name, hit.text));
    this.logged = this.hits.length;
  }

  /**
   * Cast an ability on a thing in play or into a live event: its Magic spent, its effect applied. A run's spell goes
   * through the Realm (`Realm.cast`: the Magic, the record, a growth rune's mark); into a live event the cast is logged
   * and the Realm is told how the event stands now. False: not a target, or no Magic.
   */
  cast(id: string, target: string): boolean {
    const v = this.abilities().find((a) => a.id === id);
    if (!v || !v.can || !v.targets.includes(target)) return false;
    const r = this.realm;
    const event = r.liveRunning().find((o) => o.id === target);
    const on = event ? r.liveOf(event)!.title : (this.things().find((t) => t.id === target)?.name ?? target);
    if (id.startsWith(SPELL_ID)) {
      const spell = id.slice(SPELL_ID.length) as SpellId;
      const site = siteKey(r, event ? event.place : target);
      if (!r.cast(spell, site ?? undefined)) return false;
      if (event) {
        const c = this.casts.get(event.id) ?? {};
        c[spell] = (c[spell] ?? 0) + 1;
        this.casts.set(event.id, c);
        this.tell(event);
      }
    } else {
      let l = lose(r.ledger, { magic: v.cost });
      const gains = castAbility(r.w, this.ability(id), target, this.packs);
      for (const [k, n] of Object.entries(gains) as [Pool, number][]) l = k === 'unrest' ? lose(l, { unrest: n }) : n > 0 ? grant(l, { [k]: n }) : lose(l, { [k]: -n });
      r.ledger = l;
      r.w.facts.record({ kind: 'ability-cast', by: ['player'], to: [event ? event.place : target], note: W.castNote(v.name, on) });
    }
    this.spent += v.cost;
    this.moves.push(`cast ${id} ${event ? event.template : target}`);
    this.say('took', W.castLine(v.name, on, v.cost));
    this.flushRules();
    return true;
  }

  /** the season ends: the live events under way resolve from the state they are in (the Realm's reading), then the
   *  Realm's season (commitments resolve, offers run out, the arc, the rules), the ledger's (income, building), the
   *  deal again; and what begins by itself begins */
  endSeason(): void {
    const r = this.realm;
    if (r.over) return;
    this.moves.push('end');
    this.recent = [];
    const past = r.engine.past.length;
    const before = pools(r.ledger);
    for (const o of r.liveRunning()) {
      this.tell(o);
      const rep = r.finishLive(o.id);
      this.casts.delete(o.id);
      this.events.push({ season: r.season, template: rep.template, tier: rep.tier });
      const own = rep.lines.filter((l) => !rep.hits.some((h) => `${h.text}.` === l));
      this.say(rep.template === 'raid' ? 'fight' : 'event', W.eventEnded(rep.title, own.join(' ')));
      if (rep.template === 'raid' && r.fight) this.result = { title: resultTitle(r.fight), lines: [...own, ...rep.hits.map((h) => `${h.text}.`)] };
      this.flushRules();
    }
    if (r.over) {
      const d = W.deltaLine(before, pools(r.ledger));
      if (d) this.say('pools', d);
      this.say('run', W.RUN_OVER);
      return;
    }
    const mark = this.hits.length;
    const news = r.endSeason();
    this.lapsed.push(...r.engine.past.slice(past).filter((o) => o.status === 'expired' && r.engine.template(o.template).threat).map((o) => o.template));
    const res = nextSeason(r.ledger);
    r.afterSeason(res.ledger);
    // (the Realm's news carries each rule's reason too: the log has them as rule lines)
    const ruled = new Set(this.hits.slice(mark).map((h) => `${h.hit.text}.`));
    for (const n of news) if (!ruled.has(n)) this.say('news', n);
    this.flushRules();
    for (const c of res.finished) this.say('built', W.builtLine(CATALOG.find((x) => x.id === c)?.name ?? c));
    const d = W.deltaLine(before, pools(r.ledger));
    if (d) this.say('pools', d);
    this.begin();
    if (!r.over) this.mark();
    else this.say('run', W.RUN_OVER);
  }

  /** the next run in the world this one left: what was built stays, the history stays */
  next(leader: string): Table {
    return new Table({ seed: this.seed, leader, seasons: this.realm.seasons, world: this.realm.snapshot(), built: this.built(), ...(this.o.packs ? { packs: this.o.packs } : {}) });
  }

  /** what this run did to the world, for its end: the history's lines, oldest first */
  story(): string[] {
    return this.realm.history().filter((e) => e.note && e.kind !== 'run-began' && e.kind !== 'rule-fired').map((e) => W.storyLine(e.turn - (this.realm.w.turn - this.realm.season), e.note!));
  }
}

/** a live event's spell list allows a spell ('known': every spell the run has) */
const allows = (list: readonly string[], spell: string): boolean => list.includes(spell) || list.includes('known');
/** a spell is allowed in a live event and has something there to act on: foes to put down, or a fire to put out */
function fits(def: LiveDef, spell: string): boolean {
  const m = SPELL_MECH[spell];
  return !!m && allows(def.spells ?? [], spell) && ((!!m.kills && def.groups.some((g) => g.side === 'foe')) || (!!m.douses && !!def.hazard));
}
/** the site of the home town an entity is (null: none) */
function siteKey(r: Realm, id: string): SiteKey | null {
  const e = r.w.facts.entity(id);
  return e?.kind === 'site' && e.at?.settlement === HOME ? ((e.attrs?.site as SiteKey | undefined) ?? null) : null;
}
/** the tags that say what a site is (they are the first of its tags, before 'standing') */
function siteIs(r: Realm, id: string): string[] {
  const t = r.things().find((x) => x.id === id);
  const i = t ? t.tags.indexOf('standing') : -1;
  return t && i > 0 ? t.tags.slice(0, i) : [];
}

/** a run replayed from its moves (a test; the page's seed box makes the same run when the same cards are tapped) */
export function replay(o: TableOptions, moves: readonly string[]): Table {
  const t = new Table(o);
  for (const m of moves) {
    const [verb, id, target] = m.split(' ');
    if (verb === 'end') t.endSeason();
    else if (verb === 'take') t.take(id);
    else if (verb === 'pass') t.pass(id);
    else if (verb === 'cast') t.cast(id, t.realm.liveRunning().find((o) => o.template === target)?.id ?? target);
    else throw new Error(`table: no move ${m}`);
  }
  return t;
}

export { LEADERS, TIER_RANK };
