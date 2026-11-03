// ---- living/engine.ts ---------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F5, LW-F6) The template engine: opportunity templates as data over the fact world,
// dealt by the existing dealer (opps/dealer.ts), committed and resolved through the opportunity contract
// (contracts/opportunity.ts), their outcomes instant, plausible mutations through the owners. The user's lifecycle
// (OPPORTUNITY_CATALOG.md "Generic template lifecycle"):
//   world state → test broad eligibility + bind concrete entities → optionally seed a plausible incident → show one
//   relevant card at a location → commit resources (the player only if required) → time passes → mutate the world +
//   tags + relations + claims + history → rerun predicates; new opportunities become plausible.
//
// What the engine adds to the dealer's own steps (each rejection says which):
//   eligible   the template's bindings and predicates (the first failing one is the why);
//   dedup      one live card per template and binding;
//   cooldown   a resolved or lapsed card's binding, and its template at its place, rest `cooldown` turns;
//   subjects   finite subjects: an entity is the subject of one live card at a time (settlements and polities shared);
//   place      at most one card per location (a live card holds its place);
//   stores     the real stores it needs, at the settlement that holds them.
// Its score parts (the dealer's weights): theme (fit), foreshadow (the arc's themes, more as it advances), novelty (the
// dealer's variety), capability, unlocks (a dry run of the outcome: how many other templates become eligible),
// urgency, neglect (turns since a card of its theme was taken).
// Setup (an incident) runs only when a card is dealt — shown — and once per binding: a lapsed card's incident stays in
// the history and its binding rests, so incidents never repeat invisibly.
// Templates are evaluated on change: a template is re-evaluated only when an entity of a kind it binds changed, or (for
// one reading quantities) the world's records did; the report counts how many were.

import { affords, commit as commitOpp, fired, relics, resolve as resolveOpp, type Agent, type AgentKind, type BonusRecord, type Challenge, type Commitment, type Goods, type OppEffect, type OppOutcome, type Opportunity, type Requirement, type Resolution, type Tier } from '../api/contracts/opportunity';
import type { EntityId } from '../api/contracts/facts';
import { affectedBy, checkInvariants } from '../api/contracts/facts-rules';
import { deal, type DealReport, type Made, type Proposal, type ScorePart } from '../opps/dealer';
import { checkTemplates } from '../gm/oppcheck';
import { OPP_TUNE, type DealerTune } from '../opps/tune';
import { apply, describe, helper, holds, num, ref, text, type Bind, type BindSpec, type Ctx, type Effect, type Pred, type Ref, type Stage } from './dsl';
import { adjustStores } from './mutations';
import { crewRules, crewTurns, pawnTraits, type WorkKind } from './traits';
import { answer, makePresenter, pickPresenter, type PresenterSpec } from './people';
import { attachment, hops, stakes } from './attachment';
import { DAYS_PER_TURN, diffWorld, type FactWorld } from './world';
import { MemoryDiplomacy } from '../api/contracts/diplomacy-memory';
import { capitalise } from './plain';

export interface StoreNeed {
  at: Ref;
  good: string;
  amount: number;
  /** food carried for the work: not needed by a crew that eats nothing (the trait rules) */
  upkeep?: boolean;
}

/** (round 125) What the player gets besides the world change: the user's "mechanical choices are intrinsically
 *  motivating … resources, pawns, abilities or unlocking things for different modes … engine building or unique units".
 *  Goods and pawns go to the holdings (the contract's resolve), engine pieces are the holdings' own triggered effects
 *  (Bonus), unlocks are the player's capabilities in the fact layer ('city:burrows' — another mode reads them). */
export interface RewardSpec {
  text: string;
  /** goods (an amount may be a var's name: the run's numbers) */
  goods?: Record<string, number | string>;
  /** (merge124) `id` and `character` keep a pawn the world remembers (the hold's levy: 'levy', 'levy:{holdId}'); a count
   *  may be a var's name */
  agents?: { kind: AgentKind; name: string; count: number | string; tags: string[]; parts?: Agent['parts']; id?: string; character?: string }[];
  bonuses?: BonusRecord[];
  unlocks?: { mode: 'city' | 'travel' | 'units'; what: string }[];
}

/** A template: data (the doc's eligibility, bindings, setup, requirements, duration, outcomes, presentation). */
export interface TemplateDef {
  id: string;
  title: string;
  pitch: string;
  themes: string[];
  bind: BindSpec[];
  eligible?: Pred[];
  /** the binding whose place the card is at (one card a location) */
  at: string;
  /** an incident made when the card is shown (never a capability or a relationship: oppcheck) */
  setup?: Effect[];
  requires: { agents: Requirement[]; stores?: StoreNeed[]; goods?: Goods };
  turns: number;
  work: WorkKind;
  /** the outcome (its effects and line) when it comes off: the success's — a tiered card has `outcomes` instead */
  outcome?: Effect[];
  outcomeText?: string;
  // ---- (merge124) a run's cards (living/horde.ts): tiered, rolled or played, reading the run through its stage ----
  /** the player plays it: `area` the bound site whose play it opens (the stage's `challenge` helper says what is played
   *  there, its encounter and minutes); forced (dealt alone), the climax, a way toward the climax */
  play?: { area: Ref; forced?: boolean; climax?: boolean; towardClimax?: boolean };
  /** requirement tiers, smallest first (the dealer deals the largest the holdings meet); default [requires] */
  tiers?: { agents: Requirement[]; goods?: Goods }[];
  /** a crew's odds of each outcome (rolled when committed), or a helper's name giving them for the tier */
  odds?: Partial<Record<Tier, number>> | string;
  /** what each outcome does: its line, its effects (the stage's operations among them), the share lost, tags for the
   *  survivors; `reward`: the template's reward comes with it (default: triumph and success) */
  outcomes?: Partial<Record<Tier, TierOutcome>>;
  /** a var's name: its turns from the run's numbers (the ford's, the harvest's tune) — else `turns` */
  turnsVar?: string;
  /** a helper's name: when it leaves the board ({ turn, minute? }); default `offerTurns` */
  expiry?: string;
  /** a helper's name: where the card stands on the map (the ford: where the levy can meet the host's road) */
  locate?: string;
  /** the offer's word (a way on: '{choice}', its choice's id); default the binding's key */
  offer?: string;
  /** a helper's name: the values its texts and numbers read (the run's names, the tune's numbers) */
  vars?: string;
  /** the dealer's own score parts it brings (0..1: theme, foreshadow, synergy, difficulty, hero) */
  parts?: Partial<Record<ScorePart, number>>;
  /** the conflict it answers or foreshadows (the dealer's "tied to the conflict"); default its themes */
  hooks?: string[];
  /** it reads the run (the clock, where the hero is): re-evaluated every deal */
  live?: boolean;
  /** once a run: its binding rests for good after it resolves */
  once?: boolean;
  /** passing it by is no slight (a way not taken): its presenter isn't answered when it lapses */
  passable?: boolean;
  /** (round 125) who presents it (a named person of a bound group) and what the player gets */
  presenter: PresenterSpec;
  reward: RewardSpec;
  /** the share of each committed group lost (a costly card) */
  losses?: number;
  onExpire?: Effect[];
  expireText?: string;
  /** turns it stays offered (default 2), turns its binding rests after (default 3) */
  offerTurns?: number;
  cooldown?: number;
  /** score parts from the world: urgency rises as a quantity falls from `high` to `low` */
  urgency?: { qty: [Ref, string]; low: number; high: number };
  fit?: Pred[];
  capability?: Pred[];
}

/** (merge124) one outcome of a tiered card */
export interface TierOutcome {
  text: string;
  effects?: Effect[];
  /** the share of each committed group lost (a number, or a var's name) */
  losses?: number | string;
  /** tags (and effects held) for the committed agents that come back */
  tag?: { add: string[]; bonuses?: BonusRecord[] };
  /** goods it brings (an amount may be a var's name), besides the reward */
  goods?: Record<string, number | string>;
  /** the template's reward comes with it (default: triumph and success) */
  reward?: boolean;
}

/** (merge124) What a world's engine is told: the run's stage, the dealer's numbers, where the player is. */
export interface EngineOptions {
  /** the run's conflict: its helpers (living/horde.ts); absent, the world alone (the inspector's) */
  stage?: Stage;
  /** the dealer's numbers, read each deal (the live tuning panel); default the inspector's */
  tune?: () => DealerTune;
  /** at most one card a place (the user's doc); false: one offer of a template a place (the run's ways on: warn and
   *  lead out both at the town). Default true */
  onePerPlace?: boolean;
  /** the stores move by their rates each turn (default true; a run's turns are minutes on the road, not days: false) */
  economy?: boolean;
  /** a uniform in [0, 1) for a commitment's roll (deterministic from the run's seed); default Math.random */
  rng?: (key: string) => number;
  /** where the player is and the distance between two points (resource reach); default everywhere is here */
  at?: () => [number, number];
  dist?: (a: [number, number], b: [number, number]) => number;
  /** what the conflict is about (default the arc's themes) */
  hooks?: string[];
  /** the run's clock (minutes): a commitment's start */
  clock?: () => number;
}

/** One major arc: stages at turns, each an instant mutation (and a per-turn one while it holds). */
export interface ArcDef {
  id: string;
  name: string;
  themes: string[];
  bind: Bind;
  stages: { name: string; turn: number; text: string; effects: Effect[]; each?: Effect[] }[];
}

export interface Offer {
  id: string;
  key: string;
  template: string;
  bind: Bind;
  place: EntityId;
  subjects: EntityId[];
  dealt: number;
  expires: number;
  opp: Opportunity;
  status: 'offered' | 'committed' | 'resolved' | 'expired' | 'refused';
  /** (round 125) who presents it, and what they say */
  presenter: EntityId;
  line: string;
  /** (dialog2) the group they speak for (their answer moves its relation too), and their other lines, filled: the
   *  answer to "What's in it for me?" and to "What if I say no?" (absent: the petition says the reward and the
   *  consequence plainly) */
  group: EntityId;
  gain?: string;
  refuseLine?: string;
  /** a way not taken: saying no is no slight */
  passable: boolean;
  /** (dialog2) what asking for more would add, and what a yes did add (given when it's committed) */
  haggle?: Goods;
  extra?: Goods;
  /** (merge124) what the player gets, in words (its reward's line, its names filled) */
  reward: string;
  /** what it would change (a dry run when dealt), what it unlocks, the incident its setup made */
  preview: string[];
  unlocks: string[];
  setup: string[];
  because: string[];
  commitment?: Commitment;
  resolvesTurn?: number;
  /** (merge124) how it came out */
  resolution?: Resolution;
  crew?: string[];
  /** what committing changed (the stores spent, the pawns locked) */
  spent?: string[];
  /** what it changed (resolved or lapsed) */
  result?: string[];
}

export interface NotProposed {
  template: string;
  title: string;
  step: 'eligible' | 'dedup' | 'cooldown' | 'subjects' | 'place' | 'stores';
  why: string;
}

export interface EngineReport {
  turn: number;
  dealt: Offer[];
  kept: Offer[];
  notProposed: NotProposed[];
  dealer: DealReport | null;
  evaluated: { templates: number; of: number; changed: number };
  ms: number;
}

interface Cand {
  t: TemplateDef;
  b: Bind;
  key: string;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** (dialog2) a player-facing text filled: its sentences start with a capital (a filled name may not) */
const say = (c: Ctx, s: string) => capitalise(text(c, s));
const keyOf = (t: TemplateDef, b: Bind) => `${t.id}:${Object.keys(b).sort().map((k) => b[k]).join(',')}`;
const kinds = (s: BindSpec) => (Array.isArray(s.kind) ? s.kind : [s.kind]);
/** a template reads the owners' records (quantities, holders, buildings): world changes make it re-evaluate */
const readsWorld = (t: TemplateDef) => /"qty"|\.controller|noBuilding|notAtWar|"law"/.test(JSON.stringify([t.bind, t.eligible]));

/** a reward's rough worth (the dealer's value part): goods, pawns by head and traits, engine pieces, unlocks */
export function rewardValue(r: RewardSpec): number {
  const n = (x: number | string) => (typeof x === 'number' ? x : 4);
  const goods = Object.values(r.goods ?? {}).reduce((a: number, x) => a + n(x), 0) / 4;
  const pawns = (r.agents ?? []).reduce((a, x) => a + 2 + n(x.count) / 2 + pawnTraits(x).filter((t) => t !== 'living').length * 2, 0);
  return goods + pawns + (r.bonuses?.length ?? 0) * 4 + (r.unlocks?.length ?? 0) * 3;
}

/** the reward's goods and pawns as the contract's outcome effects (its resolve adds them to the holdings); with no home
 *  a pawn is with the player */
export function rewardEffects(r: RewardSpec, key: string, home: EntityId, c?: Ctx): OppEffect[] {
  const n = (x: number | string) => (c ? num(c, x) : Number(x));
  const tx = (x: string) => (c ? text(c, x) : x);
  const goods: Goods = {};
  for (const [g, x] of Object.entries(r.goods ?? {})) goods[g] = n(x);
  return [
    ...(r.goods ? [{ kind: 'goods' as const, goods }] : []),
    ...(r.agents ?? []).map((a, i) => ({
      kind: 'agent' as const,
      agent: { id: a.id ? tx(a.id) : `${key}:${i}`, kind: a.kind, name: tx(a.name), ...(a.character ? { character: tx(a.character) } : {}), count: n(a.count), tags: [...a.tags], statuses: [], at: home ? { settlement: home } : { with: 'player' as const }, ...(a.parts ? { parts: structuredClone(a.parts) } : {}) },
    })),
  ];
}

/** a card's outcomes: a tiered card's, else its one (the success, with the reward) */
export function outcomesOf(t: TemplateDef): Partial<Record<Tier, TierOutcome>> {
  return t.outcomes ?? { success: { text: t.outcomeText ?? '', effects: t.outcome ?? [], reward: true, ...(t.losses ? { losses: t.losses } : {}) } };
}
const rewarded = (tier: Tier, o: TierOutcome) => o.reward ?? (tier === 'triumph' || tier === 'success');

/** Every binding of a template, and why the others fail (first few). */
export function enumerate(w: FactWorld, t: TemplateDef, limit = 4, stage?: Stage): { ok: Bind[]; fails: string[] } {
  const ok: Bind[] = [];
  const fails: string[] = [];
  const f = w.facts;
  const walk = (i: number, b: Bind) => {
    const c: Ctx = { w, b, cause: t.id, stage };
    if (i === t.bind.length) {
      const bad = (t.eligible ?? []).find((p) => !holds(c, p));
      if (bad) {
        if (fails.length < limit) fails.push(`${Object.values(b).map((id) => w.name(id)).join(', ')}: not ${describe(c, bad)}`);
      } else ok.push({ ...b });
      return;
    }
    const s = t.bind[i];
    let ids: EntityId[];
    if (s.via) {
      const [a, type, z] = s.via;
      const other = a === '$' ? ref(c, z) : ref(c, a);
      ids = w.relations(a === '$' ? { type, to: other } : { type, from: other }).map((r) => (a === '$' ? (r.to === other ? r.from : r.to) : r.from === other ? r.to : r.from));
    } else ids = kinds(s).flatMap((k) => f.find({ kind: k, ...(s.tag ? { tag: s.tag } : {}) }).map((e) => e.id));
    const used = new Set(Object.values(b));
    let any = false;
    for (const id of [...new Set(ids)].sort()) {
      const e = f.entity(id);
      if (!e || !kinds(s).includes(e.kind) || used.has(id)) continue;
      if (s.tag && !e.tags.some((x) => x.scope === s.tag!.scope && x.key === s.tag!.key && (s.tag!.value === undefined || x.value === s.tag!.value))) continue;
      any = true;
      const nb = { ...b, [s.as]: id };
      const bad = (s.where ?? []).find((p) => !holds({ w, b: nb, cause: t.id, stage }, p));
      if (bad) {
        if (fails.length < limit) fails.push(`${s.as} ${w.name(id)}: not ${describe({ w, b: nb, cause: t.id, stage }, bad)}`);
        continue;
      }
      walk(i + 1, nb);
    }
    if (!any && fails.length < limit) fails.push(`no ${s.as}: no ${kinds(s).join('/')}${s.tag ? ` with ${s.tag.scope} ${s.tag.key}${s.tag.value !== undefined ? ` = ${s.tag.value}` : ''}` : ''}${s.via ? ` ${s.via.join(' ')}` : ''}${i ? ` for ${Object.values(b).map((id) => w.name(id)).join(', ')}` : ''}`);
  };
  walk(0, {});
  return { ok, fails };
}

/** Apply effects as one batch: the invariants of everything it touched checked after, the world restored and an error
 *  thrown on a break (never a silent fix). Returns the diff. */
export function applyBatch(w: FactWorld, effects: Effect[], b: Bind, cause: string, changed?: Set<EntityId>, more: Partial<Ctx> = {}): string[] {
  const before = w.full();
  const undo = w.ws.fork();
  w.facts.drainChanged();
  const c: Ctx = { w, b, cause, ...more };
  apply(c, effects);
  const drained = w.facts.drainChanged();
  for (const id of drained) changed?.add(id);
  const touched = [...drained].flatMap((id) => affectedBy(w.facts, id));
  const broken = checkInvariants(w.facts, new Set(touched));
  if (broken.length) {
    // (the world as it was: the fork taken before; the caller sees the error)
    w.ws = undo;
    w.diplomacy = new MemoryDiplomacy(undo.facts);
    throw new Error(`${cause}: breaks ${broken.map((v) => `${v.rule} (${v.why})`).join('; ')}`);
  }
  return diffWorld(before, w.full(), (id) => w.name(id));
}

export class LivingEngine {
  w: FactWorld;
  readonly templates: TemplateDef[];
  arc?: ArcDef;
  offers: Offer[] = [];
  /** resolved and lapsed cards, newest last */
  past: Offer[] = [];
  /** (merge124) every resolution, in order (a run's report reads them) */
  readonly resolutions: Resolution[] = [];
  /** binding key → the turn it may be dealt again */
  rest = new Map<string, number>();
  /** bindings whose setup ran (an incident is made once) */
  setupDone = new Set<string>();
  /** theme → the last turn a card of it was taken */
  taken = new Map<string, number>();
  recent: { template: string; place: string; turn: number }[] = [];
  /** regenerating pawns' losses, back next turn */
  recovering: Agent[] = [];
  log: string[] = [];
  /** what changed, by turn: each resolution, lapse and arc stage with its diff (the inspector's) */
  changes: { turn: number; what: string; lines: string[] }[] = [];
  report: EngineReport | null = null;
  /** the template evaluation cache (evaluated on change) */
  private cache = new Map<string, { ok: Bind[]; fails: string[] }>();
  private worldVersion = -1;
  /** the dry runs of this deal (cleared when the world can have moved: each deal, commit, resolution, lapse) */
  private dryCache = new Map<string, { diff: string[]; unlocks: string[] }>();
  readonly opts: EngineOptions;

  /** (round 125) the run's locus: focus grows outward from it and its cast */
  locus: EntityId;

  constructor(w: FactWorld, templates: TemplateDef[], arc?: ArcDef, locus?: EntityId, opts: EngineOptions = {}) {
    this.w = w;
    this.locus = locus ?? w.holdings.rules[0] ?? w.ws.settlements[0]?.id ?? '';
    this.templates = templates;
    this.arc = arc;
    this.opts = opts;
    // (templates with problems are refused where they're used: never patched)
    const bad = checkTemplates(templates);
    if (bad.length) throw new Error(`templates: ${bad.join('; ')}`);
    if (arc && !w.facts.entity(`arc:${arc.id}`)) w.facts.add({ id: `arc:${arc.id}`, kind: 'arc', name: arc.name, attrs: { stage: -1 } });
  }

  template(id: string): TemplateDef {
    const t = this.templates.find((x) => x.id === id);
    if (!t) throw new Error(`no template ${id}`);
    return t;
  }

  get turn() {
    return this.w.turn;
  }

  /** the arc's stage (−1 before its first) */
  arcStage(): number {
    return this.arc ? Number(this.w.facts.entity(`arc:${this.arc.id}`)?.attrs.stage ?? -1) : -1;
  }

  /** a template's context on a binding: its stage, its vars */
  ctx(t: TemplateDef, b: Bind, cause: string = t.id, tier?: number, w: FactWorld = this.w): Ctx {
    const c: Ctx = { w, b, cause, stage: this.opts.stage, ...(tier ? { tier } : {}) };
    if (t.vars) {
      const h = helper(c, t.vars);
      if (!h?.vars) throw new Error(`template ${t.id}: no vars helper ${t.vars}`);
      c.vars = h.vars(c, []);
    }
    return c;
  }

  // ---- evaluation ------------------------------------------------------------------------------------------------------

  /** every template's eligible bindings on a world (all evaluated: dry runs use this) */
  static eligibleKeys(w: FactWorld, templates: TemplateDef[], stage?: Stage): Set<string> {
    const out = new Set<string>();
    for (const t of templates) for (const b of enumerate(w, t, 4, stage).ok) out.add(keyOf(t, b));
    return out;
  }

  private evaluate(): { cands: Cand[]; fails: NotProposed[]; evaluated: number; changed: number } {
    const changed = this.w.facts.drainChanged();
    const changedKinds = new Set([...changed].map((id) => this.w.facts.entity(id)?.kind).filter(Boolean));
    const worldMoved = this.w.ws.version !== this.worldVersion;
    this.worldVersion = this.w.ws.version;
    let evaluated = 0;
    const cands: Cand[] = [];
    const fails: NotProposed[] = [];
    for (const t of this.templates) {
      const dirty = t.live || !this.cache.has(t.id) || t.bind.some((s) => kinds(s).some((k) => changedKinds.has(k))) || (worldMoved && readsWorld(t)) || (changed.size > 0 && JSON.stringify(t).includes('"event"'));
      if (dirty) {
        this.cache.set(t.id, enumerate(this.w, t, 4, this.opts.stage));
        evaluated++;
      }
      const r = this.cache.get(t.id)!;
      for (const b of r.ok) cands.push({ t, b, key: keyOf(t, b) });
      for (const why of r.fails) fails.push({ template: t.id, title: t.title.replace(/\{[^}]*\}/g, '…'), step: 'eligible', why });
    }
    return { cands, fails, evaluated, changed: changed.size };
  }

  /** what a candidate would do: the dry run (its setup, its success) on a copy — the diff, the templates it unlocks. The
   *  stage's operations aren't applied in a dry run: they change the run, not the world */
  dryRun(t: TemplateDef, b: Bind, before?: Set<string>): { diff: string[]; unlocks: string[] } {
    // (a run's card changes the run — its stage's operations, which a dry run doesn't apply — and maybe a mark or two of
    // its own: no copy of the world when it touches nothing of it, and no search for what it unlocks — the run's cards
    // follow the run, not each other; merge124, measured: a turn's deal on seed 1's atlas world 144 ms → see DEVLOG)
    const world = (es: Effect[] = []): boolean => es.some((e) => !('helper' in e) || !this.opts.stage?.helpers[e.helper]);
    if (t.live && !world(t.setup) && !Object.values(outcomesOf(t)).some((o) => world(o.effects))) return { diff: [], unlocks: [] };
    // (once a deal: the deal's preview and oppcheck's realisability ask the same of the same world)
    const ck = keyOf(t, b);
    const hit = this.dryCache.get(ck);
    if (hit) return hit;
    const stage = this.opts.stage;
    if (t.live) {
      // (a run's card: realised on the copy to know it can be — its world change is shown in its outcome's line, not
      // diffed: two light snapshots a card were most of a deal's time on the atlas world)
      const o = outcomesOf(t);
      const best = o.success ?? o.triumph;
      if (world(t.setup) || world(best?.effects)) {
        const copy = this.w.clone();
        const bb = { ...b };
        const c = { ...this.ctx(t, bb, `${t.id}:dry`, 1, copy), dry: true };
        if (t.setup && !this.setupDone.has(keyOf(t, b))) apply(c, t.setup);
        applyBatch(copy, best?.effects ?? [], bb, `${t.id}:dry`, undefined, { stage, vars: c.vars, tier: 1, dry: true });
      }
      const out = { diff: [], unlocks: [] };
      this.dryCache.set(ck, out);
      return out;
    }
    const copy = this.w.clone();
    const was = before ?? LivingEngine.eligibleKeys(this.w, this.templates, stage);
    const cause = `${t.id}:dry`;
    const pre = copy.full();
    const bb = { ...b };
    const c = { ...this.ctx(t, bb, cause, 1, copy), dry: true };
    if (t.setup && !this.setupDone.has(keyOf(t, b))) apply(c, t.setup);
    const o = outcomesOf(t);
    const best = o.success ?? o.triumph;
    applyBatch(copy, best?.effects ?? [], bb, cause, undefined, { stage, vars: c.vars, tier: 1, dry: true });
    const diff = diffWorld(pre, copy.full(), (id) => copy.name(id));
    const after = LivingEngine.eligibleKeys(copy, this.templates, stage);
    const had = new Set([...was].map((k) => k.split(':')[0]));
    const unlocks = [...new Set([...after].filter((k) => !was.has(k)).map((k) => k.split(':')[0]))].filter((id) => id !== t.id && !had.has(id));
    this.dryCache.set(ck, { diff, unlocks });
    return { diff, unlocks };
  }

  /** the dealer's numbers this deal */
  dealerTune(): DealerTune {
    return this.opts.tune ? this.opts.tune() : { ...OPP_TUNE.dealer, reach: 1e9, playerMax: 2, resourceMax: 4, unaffordable: 1, nextTier: 0 };
  }

  /** an opportunity of a template at a tier: what the map shows and the contract commits */
  private made(t: TemplateDef, b: Bind, key: string, place: EntityId, title: string, tier: number): Made {
    const c = this.ctx(t, b, t.id, tier);
    const loc: { region: number; at: [number, number]; settlement?: string; name?: string } | null | undefined = t.locate ? (helper(c, t.locate)?.locate?.(c, []) ?? null) : this.w.locate(place);
    if (!loc) throw new Error(`${t.id}: ${place} has no place on the map`);
    const outcomes: Partial<Record<Tier, OppOutcome>> = {};
    for (const [tr, o] of Object.entries(outcomesOf(t)) as [Tier, TierOutcome][]) {
      outcomes[tr] = {
        text: say(c, o.text),
        effects: [...(rewarded(tr, o) ? rewardEffects(t.reward, key, t.play ? '' : this.locus, c) : []), ...(o.goods ? rewardEffects({ text: '', goods: o.goods }, key, '', c) : []), ...(o.tag ? [{ kind: 'tag' as const, add: [...o.tag.add], ...(o.tag.bonuses ? { bonuses: structuredClone(o.tag.bonuses) } : {}) }] : [])],
        ...(o.losses !== undefined ? { losses: num(c, o.losses) } : {}),
      };
    }
    let odds: Partial<Record<Tier, number>> | undefined;
    if (typeof t.odds === 'string') {
      const h = helper(c, t.odds);
      if (!h?.odds) throw new Error(`template ${t.id}: no odds helper ${t.odds}`);
      odds = h.odds(c, []);
    } else odds = t.odds;
    let challenge: Challenge | undefined;
    let minutes = 0;
    if (t.play) {
      const h = helper(c, 'challenge');
      if (!h?.challenge) throw new Error(`template ${t.id}: a played card needs the stage's challenge helper`);
      ({ challenge, minutes } = h.challenge(c, [t.play.area]));
    }
    const expires = t.expiry ? helper(c, t.expiry)?.expiry?.(c, []) : undefined;
    if (t.expiry && !expires) throw new Error(`template ${t.id}: no expiry helper ${t.expiry}`);
    return {
      template: t.id,
      offer: t.offer ? text(c, t.offer) : key,
      title,
      pitch: say(c, t.pitch),
      location: { region: loc.region, ...(loc.settlement ? { settlement: loc.settlement } : {}), at: loc.at, name: loc.name ?? this.w.name(place) },
      duration: t.play ? { minutes: +minutes.toFixed(2) } : { turns: t.turnsVar ? num(c, t.turnsVar) : t.turns },
      ...(challenge ? { challenge } : {}),
      ...(odds ? { odds } : {}),
      outcomes,
      visibility: 'known',
      expires: expires ?? { turn: this.turn + (t.offerTurns ?? 2) - 1 },
      ...(t.onExpire ? { onExpire: { text: say(c, t.expireText ?? 'It lapses.'), effects: [] } } : {}),
      ...(t.play?.forced ? { forced: true } : {}),
      ...(t.play?.climax ? { climax: true } : {}),
      themes: t.themes,
      hooks: t.hooks ?? t.themes,
    };
  }

  // ---- the deal ----------------------------------------------------------------------------------------------------------

  deal(): EngineReport {
    const t0 = now();
    this.dryCache.clear();
    const turn = this.turn;
    const onePerPlace = this.opts.onePerPlace ?? true;
    const live = this.offers.filter((o) => o.status === 'offered' || o.status === 'committed');
    const liveKeys = new Set(live.map((o) => o.key));
    const busy = new Set(live.flatMap((o) => o.subjects));
    const placesHeld = new Map(this.offers.filter((o) => o.status === 'offered').map((o) => [o.place, o]));
    const ev = this.evaluate();
    const notProposed = [...ev.fails];
    const was = ev.cands.some((c) => !c.t.live) ? LivingEngine.eligibleKeys(this.w, this.templates, this.opts.stage) : new Set<string>();
    // (what the player cares about: their stakes, and the distance from the run's locus and its cast)
    const st = stakes(this.w);
    const dist = hops(this.w, this.locus, st.keys());
    const props: Proposal[] = [];
    const meta = new Map<string, { c: Cand; preview: string[]; unlocks: string[]; subjects: string[]; place: string; presenter: EntityId | null; group: EntityId }>();
    const presenting = new Set(live.map((o) => o.presenter));
    const pAt = (this.opts.at ?? (() => [0, 0] as [number, number]))();
    for (const c of ev.cands) {
      const { t, b, key } = c;
      const ctx = this.ctx(t, b);
      const title = say(ctx, t.title);
      const np = (step: NotProposed['step'], why: string) => notProposed.push({ template: t.id, title, step, why });
      if (liveKeys.has(key)) {
        np('dedup', 'already on the board or under way');
        continue;
      }
      const restUntil = Math.max(this.rest.get(key) ?? -Infinity, this.rest.get(`${t.id}@${b[t.at]}`) ?? -Infinity);
      if (restUntil > turn) {
        np('cooldown', restUntil === Infinity ? 'done this run' : `resting until turn ${restUntil} (this binding, or this template at ${this.w.name(b[t.at])})`);
        continue;
      }
      const subjects = t.bind.filter((s) => !s.shared && !kinds(s).some((k) => k === 'settlement' || k === 'polity')).map((s) => b[s.as]);
      const clash = subjects.find((s) => busy.has(s));
      if (clash) {
        np('subjects', `${this.w.name(clash)} is already the subject of a live card`);
        continue;
      }
      const place = b[t.at];
      const held = onePerPlace ? placesHeld.get(place) : undefined;
      if (held) {
        np('place', `one card a location: "${held.opp.title}" is offered at ${this.w.name(place)}`);
        continue;
      }
      // (its presenter: a free member of the group from the cast, else one is made when it is shown)
      const group = ref(ctx, t.presenter.of);
      const presenter = pickPresenter(this.w, group, new Set([...busy, ...presenting]));
      if (presenter) subjects.push(presenter);
      const stores = (t.requires.stores ?? []).map((s) => {
        const at = ref(ctx, s.at);
        const have = this.w.qty(at, s.good) ?? 0;
        return { ok: have >= s.amount, why: `${this.w.name(at)} holds ${+have.toFixed(1)} ${s.good} of the ${s.amount} it needs` };
      });
      const short = stores.find((s) => !s.ok);
      if (short) {
        np('stores', short.why);
        continue;
      }
      // (a run's card is dry-run only once dealt: what it would do isn't a score part of it, and most aren't dealt)
      const { diff, unlocks } = t.live ? { diff: [] as string[], unlocks: [] as string[] } : this.dryRun(t, b, was);
      const stage = this.arcStage();
      const arcThemed = this.arc && stage >= 0 && t.themes.some((x) => this.arc!.themes.includes(x));
      const frac = (ps?: Pred[]) => (ps?.length ? ps.filter((p) => holds(ctx, p)).length / ps.length : 0.5);
      let urgency = 0;
      if (t.urgency) {
        const v = this.w.qty(ref(ctx, t.urgency.qty[0]), t.urgency.qty[1]) ?? t.urgency.high;
        urgency = Math.max(0, Math.min(1, (t.urgency.high - v) / (t.urgency.high - t.urgency.low)));
      }
      const lastTaken = Math.max(0, ...t.themes.map((x) => this.taken.get(x) ?? 0));
      const parts = {
        theme: frac(t.fit),
        foreshadow: arcThemed ? 0.5 + (0.5 * stage) / Math.max(1, this.arc!.stages.length - 1) : 0,
        difficulty: 0.5,
        capability: frac(t.capability),
        unlocks: Math.min(1, unlocks.length / 2),
        urgency,
        neglect: Math.min(1, (turn - lastTaken) / 6),
        ev: Math.min(1, rewardValue(t.reward) / 12),
        ...attachment([...Object.values(b), ...(presenter ? [presenter] : [])], st, dist),
        ...(t.parts ?? {}),
      };
      const elig = (t.eligible ?? []).map((p) => describe(ctx, p));
      const tiers = (t.tiers ?? [{ agents: t.requires.agents, goods: t.requires.goods }]).map((x) => ({ requires: x.agents, costs: x.goods ?? {} }));
      const first = this.made(t, b, key, place, title, 1);
      props.push({
        template: t.id,
        offer: first.offer,
        place,
        title,
        tiers,
        make: (tier) => (tier === 1 ? first : this.made(t, b, key, place, title, tier)),
        sense: [...t.bind.map((s) => ({ ok: true, why: `${s.as}: ${this.w.name(b[s.as])}` })), ...elig.map((why) => ({ ok: true, why })), ...stores],
        parts,
        at: first.location.at,
        ...(t.play?.forced ? { forced: true } : {}),
        ...(t.play?.towardClimax ? { towardClimax: true } : {}),
        hooks: t.hooks ?? t.themes,
      });
      meta.set(`${t.id}|${first.offer}`, { c, preview: diff, unlocks, subjects, place, presenter, group });
    }
    const tune = this.dealerTune();
    const dealer = props.length ? deal(props, { holdings: this.w.holdings, turn, at: pAt, dist: this.opts.dist ?? (() => 0), conflictHooks: this.opts.hooks ?? this.arc?.themes ?? [], recent: this.recent, tune, onePerPlace }) : null;
    const dealt: Offer[] = [];
    for (const d of dealer?.dealt ?? []) {
      const m = meta.get(`${d.opp.template}|${d.opp.offer}`);
      if (!m) throw new Error(`the dealer dealt ${d.opp.template} (${d.opp.offer}) that wasn't proposed`);
      const { t, b, key } = m.c;
      const id = `${key}@${turn}`;
      if (t.live) m.preview = this.dryRun(t, b).diff;
      // (its presenter: made now it's shown, when the cast had no one free — a real person the world remembers)
      let setup: string[] = [];
      let presenter = m.presenter;
      // (two cards may have picked the same free member: the second asks the group again before anyone is made)
      if (!presenter || presenting.has(presenter)) presenter = pickPresenter(this.w, m.group, new Set([...busy, ...presenting]));
      if (!presenter) {
        const before = this.w.full();
        presenter = makePresenter(this.w, m.group, t.presenter.role, id);
        setup = diffWorld(before, this.w.full(), (x) => this.w.name(x));
      }
      presenting.add(presenter);
      const bind = { ...b, presenter };
      const pctx = { ...this.ctx(t, bind, id), b: bind };
      const line = say(pctx, t.presenter.line);
      // (dialog2: the pitch is the card's own plain words; the presenter's line is said in the dialog, not glued on)
      const opp: Opportunity = { ...d.opp, id };
      const hg = t.presenter.haggle ? Object.fromEntries(Object.entries(t.presenter.haggle.goods).map(([g, x]) => [g, num(pctx, x)])) : undefined;
      const o: Offer = {
        id, key, template: t.id, bind, place: m.place, subjects: [...m.subjects.filter((x) => x !== m.presenter), presenter], dealt: turn, expires: d.opp.expires.turn, opp, status: 'offered', presenter, line, reward: say(pctx, t.reward.text), preview: m.preview, unlocks: m.unlocks, setup, because: d.opp.because,
        group: m.group, passable: !!t.passable,
        ...(t.presenter.gain ? { gain: say(pctx, t.presenter.gain) } : {}),
        ...(t.presenter.refuse ? { refuseLine: say(pctx, t.presenter.refuse) } : {}),
        ...(hg ? { haggle: hg } : {}),
      };
      // (the incident, made now it's shown — once per binding)
      if (t.setup && !this.setupDone.has(key)) {
        o.setup = [...setup, ...applyBatch(this.w, t.setup, o.bind, o.id, undefined, { stage: this.opts.stage, vars: pctx.vars })];
        this.setupDone.add(key);
      }
      this.offers.push(o);
      this.recent.push({ template: t.id, place: m.place, turn });
      dealt.push(o);
    }
    this.report = { turn, dealt, kept: live.filter((o) => o.status === 'offered'), notProposed, dealer, evaluated: { templates: ev.evaluated, of: this.templates.length, changed: ev.changed }, ms: +(now() - t0).toFixed(1) };
    return this.report;
  }

  /** (merge124) this turn dealt again (a tuning slider moved, a held agent changed): what was dealt this turn and not
   *  taken leaves the board unanswered (it was never really passed by), then the deal */
  redeal(): EngineReport {
    const gone = new Set(this.offers.filter((o) => o.status === 'offered' && o.dealt === this.turn));
    this.offers = this.offers.filter((o) => !gone.has(o));
    this.recent = this.recent.filter((r) => r.turn !== this.turn || ![...gone].some((o) => o.template === r.template && o.place === r.place));
    return this.deal();
  }

  /** (merge124) offers that no longer stand where the player is (a detour from an area left behind) leave the board
   *  unanswered and without their lapse: they were passed by, not let go */
  withdraw(due: (o: Offer) => boolean): Offer[] {
    const gone = this.offers.filter((o) => o.status === 'offered' && due(o));
    this.offers = this.offers.filter((o) => !gone.includes(o));
    return gone;
  }

    /** what's on the board now (offered, not committed) */
  get offered(): Offer[] {
    return this.offers.filter((o) => o.status === 'offered');
  }

  /** the board's offers dealt this turn — an earlier turn's left on it are dropped: a run deals afresh each turn */
  offer(id: string): Offer {
    const o = this.offers.find((x) => x.id === id && x.status === 'offered');
    if (!o) throw new Error(`no offer ${id} on the board`);
    return o;
  }

  // ---- commit and resolve ------------------------------------------------------------------------------------------------

  commit(offerId: string): Offer {
    this.dryCache.clear();
    const o = this.offer(offerId);
    const t = this.template(o.template);
    const ctx: Ctx = { ...this.ctx(t, o.bind, o.id), tier: o.opp.tier };
    const a = affords(o.opp, this.w.holdings);
    if (!a.ok) throw new Error(`commit ${o.opp.title}: ${a.missing.join('; ')}`);
    const before = this.w.full();
    const u = o.opp.odds ? (this.opts.rng ?? (() => Math.random()))(o.id) : undefined;
    const { holdings, commitment } = commitOpp(this.w.holdings, o.opp, { id: o.id, now: this.opts.clock?.() ?? 0, turn: this.turn, ...(u !== undefined ? { u } : {}) });
    const notes: string[] = [];
    let resolvesTurn: number | undefined;
    if (!t.play) {
      const crewAgents = holdings.agents.filter((x) => commitment.agents.includes(x.id) && x.kind !== 'player');
      const labour = crewAgents.filter((x) => x.kind === 'workers' || x.kind === 'army');
      const crew = t.work === 'labour' ? labour : crewAgents;
      const rules = crewRules(crew);
      // (the contract's own commit effects first — an engine piece that shortens or makes it instant — then the crew's traits)
      const due = (commitment.resolvesTurn ?? this.turn + ('turns' in o.opp.duration ? o.opp.duration.turns : t.turns)) - this.turn;
      const timing = due <= 0 ? { turns: 0, why: [] as string[] } : crewTurns(due, t.work, crew);
      if (commitment.fired?.length) timing.why.unshift(...commitment.fired.map((f) => `${f}: fewer turns`));
      // (the real stores, spent at the settlement that holds them; upkeep waived for a crew that eats nothing)
      for (const s of t.requires.stores ?? []) {
        const at = ref(ctx, s.at);
        if (s.upkeep && rules.some((r) => r.rule.noUpkeep)) continue;
        if ((this.w.qty(at, s.good) ?? 0) < s.amount) throw new Error(`commit ${o.opp.title}: ${this.w.name(at)} hasn't ${s.amount} ${s.good}`);
      }
      this.w.holdings = holdings;
      notes.push(...timing.why);
      for (const s of t.requires.stores ?? []) {
        if (s.upkeep && rules.some((r) => r.rule.noUpkeep)) {
          notes.push(`${rules.find((r) => r.rule.noUpkeep)!.rule.noUpkeep}: no ${s.good} carried`);
          continue;
        }
        adjustStores(this.w, ref(ctx, s.at), s.good, -s.amount, 0, o.id);
      }
      // (the living object to the dead at work among them: unrest on the living cohorts there)
      for (const { rule } of rules)
        if (rule.objection) {
          const home = this.w.settlementOf(o.place)?.id;
          if (!home) continue;
          const living = this.w.facts.find({ kind: 'cohort' }).filter((c) => this.w.settlementOf(c.id)?.id === home && holds({ w: this.w, b: { c: c.id }, cause: o.id }, { trait: ['$c', 'living'] }));
          for (const c of living) this.w.facts.bump(c.id, 'unrest', rule.objection.unrest, o.id);
          if (living.length) this.w.facts.record({ kind: 'objection', by: living.map((c) => c.id), to: ['player'], about: { opp: o.id }, note: `${rule.objection.why} (${living.map((c) => c.name).join(', ')})` });
          notes.push(rule.objection.why);
        }
      resolvesTurn = this.turn + timing.turns;
    } else this.w.holdings = holdings;
    // (the world model keeps what the agents are committed to: where, what, when — a later run finds them there)
    (this.w.holdings.commitments ??= []).push({ id: o.id, template: o.template, title: o.opp.title, agents: [...commitment.agents], location: structuredClone(o.opp.location), turn: this.turn, ...(resolvesTurn !== undefined ? { resolvesTurn } : {}), ...(commitment.rolled ? { rolled: commitment.rolled } : {}) });
    // (dialog2: what asking for more won comes with the commitment)
    for (const [g, n] of Object.entries(o.extra ?? {})) this.w.holdings.goods[g] = (this.w.holdings.goods[g] ?? 0) + n;
    answer(this.w, o.presenter, 'committed', o.opp.title, o.id, o.group);
    this.w.facts.record({ kind: 'committed', by: ['player'], to: [o.place], about: { opp: o.id }, note: `${o.opp.title}: ${commitment.agents.map((id) => holdings.agents.find((x) => x.id === id)?.name ?? id).join(', ')} committed` });
    o.status = 'committed';
    o.commitment = commitment;
    o.resolvesTurn = resolvesTurn;
    o.crew = notes;
    o.spent = diffWorld(before, this.w.full(), (id) => this.w.name(id));
    this.changes.push({ turn: this.turn, what: `committed: ${o.opp.title}`, lines: o.spent });
    for (const th of t.themes) this.taken.set(th, this.turn);
    this.log.push(`turn ${this.turn}: committed to "${o.opp.title}"${resolvesTurn !== undefined ? ` — resolves turn ${resolvesTurn}` : ' — played'}${notes.length ? ` (${notes.join('; ')})` : ''}`);
    // (an 'instant' engine piece: it comes off now)
    if (resolvesTurn !== undefined && resolvesTurn <= this.turn && commitment.fired?.length) this.resolve(o.id);
    return o;
  }

  /** (round 125) the player turns a card down: its presenter remembers it, its binding rests */
  refuse(offerId: string): Offer {
    const o = this.offer(offerId);
    const t = this.template(o.template);
    const before = this.w.full();
    // (a way not taken is no slight: refusing it only takes it off the board)
    if (!t.passable) answer(this.w, o.presenter, 'refused', o.opp.title, o.id, o.group);
    // (dialog2: saying no lets it go — what happens when it lapses happens now: the grain rots, the captives are taken)
    if (t.onExpire) {
      const c = this.ctx(t, o.bind, `${o.id}:refused`, o.opp.tier);
      applyBatch(this.w, t.onExpire, o.bind, `${o.id}:refused`, undefined, { stage: this.opts.stage, vars: c.vars, tier: o.opp.tier });
    }
    o.status = 'refused';
    o.result = diffWorld(before, this.w.full(), (id) => this.w.name(id));
    this.rest.set(o.key, this.turn + (t.cooldown ?? 3));
    this.rest.set(`${o.template}@${o.place}`, this.turn + (t.cooldown ?? 3));
    this.offers = this.offers.filter((x) => x !== o);
    this.past.push(o);
    this.changes.push({ turn: this.turn, what: `refused: ${o.opp.title}`, lines: o.result });
    this.log.push(`turn ${this.turn}: refused "${o.opp.title}" — ${this.w.name(o.presenter)} remembers`);
    return o;
  }

  /** (dialog2) the player asked the presenter for more: agreed, what the template allows is added to the reward when
   *  the card is committed, and the presenter thinks a little less of the player for pushing; refused, nothing
   *  changes. Once a card. */
  haggle(offerId: string, agreed: boolean): Offer {
    const o = this.offer(offerId);
    if (!o.haggle) throw new Error(`haggle ${o.opp.title}: its template allows no haggling`);
    if (o.extra) throw new Error(`haggle ${o.opp.title}: already agreed`);
    if (agreed) {
      o.extra = { ...o.haggle };
      answer(this.w, o.presenter, 'haggled', o.opp.title, o.id);
    }
    this.log.push(`turn ${this.turn}: asked ${this.w.name(o.presenter)} for more on "${o.opp.title}": ${agreed ? 'agreed' : 'refused'}`);
    return o;
  }

  /** (merge124) a committed card comes off now: the player's at the tier its challenge came out at, a crew's at its roll */
  resolve(offerId: string, tier?: Tier): Offer {
    const o = this.offers.find((x) => x.id === offerId && x.status === 'committed');
    if (!o) throw new Error(`no commitment ${offerId} under way`);
    this.resolveOffer(o, tier);
    return o;
  }

  /** the commitments under way (a crew's, with the turns it has left) */
  running(): Offer[] {
    return this.offers.filter((o) => o.status === 'committed');
  }

  private resolveOffer(o: Offer, tier?: Tier): void {
    this.dryCache.clear();
    const t = this.template(o.template);
    const before = this.w.full();
    const out = resolveOpp(this.w.holdings, o.commitment!, { now: this.opts.clock?.() ?? 0, turn: this.turn, ...(tier ? { tier } : {}) });
    // (regenerating pawns: what they lost comes back by the next turn)
    for (const l of out.resolution.lost) {
      const had = before.holdings.agents.find((a) => a.id === l.agent)!;
      const rules = crewRules([had]);
      if (rules.some((r) => r.rule.recovers)) this.recovering.push({ ...structuredClone(had), committed: undefined });
    }
    this.w.holdings = out.holdings;
    this.w.holdings.commitments = (this.w.holdings.commitments ?? []).filter((c) => c.id !== o.id);
    this.resolutions.push(out.resolution);
    o.resolution = out.resolution;
    const made = new Set<EntityId>();
    const oc = outcomesOf(t)[out.resolution.tier] ?? outcomesOf(t).success;
    const ctx = this.ctx(t, o.bind, o.id, o.opp.tier);
    if (oc?.effects?.length) applyBatch(this.w, oc.effects, o.bind, o.id, made, { stage: this.opts.stage, vars: ctx.vars, tier: o.opp.tier });
    // (what the player gets: engine pieces and unlocks — the goods and pawns came with the contract's resolve)
    const player = this.w.diplomacy.idOf({ player: true });
    if (oc && rewarded(out.resolution.tier, oc)) {
      for (const b of t.reward.bonuses ?? []) if (!this.w.holdings.bonuses.some((x) => x.why === b.why && !x.holder)) this.w.holdings.bonuses.push(structuredClone(b));
      for (const u of t.reward.unlocks ?? []) {
        this.w.facts.setTag(player, 'capability', `${u.mode}:${u.what}`, true, o.id);
        this.w.facts.record({ kind: 'unlocked', by: [player], to: [player], about: { opp: o.id }, note: `unlocked for the ${u.mode === 'city' ? 'city builder' : u.mode}: ${u.what}` });
      }
    }
    // (provenance: what the player's card made or changed is theirs — the dealer's stakes read it)
    made.delete(player);
    if (made.size) this.w.facts.record({ kind: 'player-made', by: [player], to: [...made].sort(), about: { opp: o.id }, note: `made by your hand: ${o.opp.title}` });
    o.status = 'resolved';
    o.result = diffWorld(before, this.w.full(), (id) => this.w.name(id));
    const until = t.once ? Infinity : this.turn + (t.cooldown ?? 3);
    this.rest.set(o.key, until);
    this.rest.set(`${o.template}@${o.place}`, until);
    this.offers = this.offers.filter((x) => x !== o);
    this.past.push(o);
    this.log.push(`turn ${this.turn}: "${o.opp.title}" resolved ${out.resolution.tier}${out.resolution.rolled !== out.resolution.tier ? ` (rolled ${out.resolution.rolled})` : ''} — ${o.result.length} changes`);
    this.changes.push({ turn: this.turn, what: `resolved: ${o.opp.title}`, lines: o.result });
  }

  /** (merge124) what's offered and due leaves the board: its lapse (onExpire) happens, its presenter remembers being let
   *  down (not for a way not taken), its binding rests */
  expire(due: (o: Offer) => boolean): Offer[] {
    this.dryCache.clear();
    const w = this.w;
    const gone: Offer[] = [];
    for (const o of this.offers.filter((x) => x.status === 'offered' && due(x))) {
      const t = this.template(o.template);
      const before = w.full();
      if (t.onExpire) {
        const c = this.ctx(t, o.bind, `${o.id}:lapsed`, o.opp.tier);
        applyBatch(w, t.onExpire, o.bind, `${o.id}:lapsed`, undefined, { stage: this.opts.stage, vars: c.vars, tier: o.opp.tier });
      }
      if (!t.passable) answer(w, o.presenter, 'ignored', o.opp.title, o.id, o.group);
      o.result = diffWorld(before, w.full(), (id) => w.name(id));
      o.status = 'expired';
      this.rest.set(o.key, this.turn + (t.cooldown ?? 3));
      this.rest.set(`${o.template}@${o.place}`, this.turn + (t.cooldown ?? 3));
      this.offers = this.offers.filter((x) => x !== o);
      this.past.push(o);
      gone.push(o);
      this.changes.push({ turn: this.turn, what: `lapsed: ${o.opp.title}`, lines: o.result });
      this.log.push(`turn ${this.turn}: "${o.opp.title}" lapsed${o.result.length ? ` — ${o.result.length} changes` : ''}`);
    }
    return gone;
  }

  // ---- the turn ----------------------------------------------------------------------------------------------------------

  /** a turn passes: stores move by their rates, losses recover, cards resolve or lapse, the arc advances, claims lapse;
   *  then the next deal */
  advance(): EngineReport {
    const w = this.w;
    w.facts.turn++;
    // (the turn's economy: each settlement's stores move by their rates over the turn's days — an instant step)
    if (this.opts.economy ?? true)
      for (const s of w.ws.settlements)
        for (const [g, st] of Object.entries(s.stores)) if (st.rate) adjustStores(w, s.id, g, st.rate * DAYS_PER_TURN, 0, `turn ${this.turn}`);
    // (the holdings' engine pieces that fire each turn: a toll charter's coin)
    for (const b of relics(w.holdings, 'turn', undefined, undefined, this.turn))
      if (b.effect.kind === 'gain') {
        for (const [g, n] of Object.entries(b.effect.goods)) w.holdings.goods[g] = (w.holdings.goods[g] ?? 0) + n;
        fired(w.holdings, b, this.turn);
        this.log.push(`turn ${this.turn}: ${b.why}: ${Object.entries(b.effect.goods).map(([g, n]) => `+${n} ${g}`).join(', ')}`);
      }
    // (regenerating pawns back at full strength)
    for (const a of this.recovering.splice(0)) {
      const h = w.holdings.agents.find((x) => x.id === a.id);
      if (h) h.count = a.count;
      else w.holdings.agents.push(a);
      this.log.push(`turn ${this.turn}: ${a.name} regenerated: back at full strength (${a.count})`);
    }
    for (const o of this.offers.filter((x) => x.status === 'committed' && x.resolvesTurn !== undefined && x.resolvesTurn <= this.turn)) this.resolveOffer(o);
    this.expire((o) => o.expires < this.turn);
    this.advanceArc();
    for (const c of w.facts.claims()) if (c.expires !== undefined && c.expires <= this.turn) {
      w.facts.dropClaim(c.id);
      w.facts.record({ kind: 'claim-lapsed', by: [c.claimant], to: [c.target], note: `${w.name(c.claimant)}'s claim to ${w.name(c.target)} lapsed` });
    }
    return this.deal();
  }

  private advanceArc(): void {
    if (!this.arc) return;
    const id = `arc:${this.arc.id}`;
    let stage = this.arcStage();
    const next = this.arc.stages[stage + 1];
    if (next && this.turn >= next.turn) {
      stage++;
      const diff = applyBatch(this.w, next.effects, { ...this.arc.bind }, `${id}:${stage}`);
      this.w.facts.entity(id)!.attrs.stage = stage;
      this.w.facts.record({ kind: 'arc-stage', by: [id], to: Object.values(this.arc.bind), note: `${this.arc.name}: ${next.name} — ${next.text}` });
      this.log.push(`turn ${this.turn}: ${this.arc.name} — ${next.name} (${diff.length} changes)`);
      this.changes.push({ turn: this.turn, what: `${this.arc.name}: ${next.name} — ${next.text}`, lines: diff });
    } else if (stage >= 0 && this.arc.stages[stage].each) applyBatch(this.w, this.arc.stages[stage].each!, { ...this.arc.bind }, `${id}:${stage}:turn`);
  }
}
