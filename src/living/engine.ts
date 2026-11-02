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

import { affords, commit as commitOpp, fired, relics, resolve as resolveOpp, type Agent, type AgentKind, type BonusRecord, type Commitment, type Goods, type OppEffect, type Opportunity, type Requirement } from '../api/contracts/opportunity';
import type { EntityId } from '../api/contracts/facts';
import { affectedBy, checkInvariants } from '../api/contracts/facts-rules';
import { deal, type DealReport, type Proposal } from '../opps/dealer';
import { checkTemplates } from '../gm/oppcheck';
import { OPP_TUNE } from '../opps/tune';
import { apply, describe, holds, ref, text, type Bind, type BindSpec, type Ctx, type Effect, type Pred, type Ref } from './dsl';
import { adjustStores } from './mutations';
import { crewRules, crewTurns, pawnTraits, type WorkKind } from './traits';
import { answer, makePresenter, pickPresenter, type PresenterSpec } from './people';
import { attachment, hops, stakes } from './attachment';
import { DAYS_PER_TURN, diffWorld, FactWorld } from './world';

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
  goods?: Goods;
  agents?: { kind: AgentKind; name: string; count: number; tags: string[]; parts?: Agent['parts'] }[];
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
  outcome: Effect[];
  outcomeText: string;
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
  /** what it would change (a dry run when dealt), what it unlocks, the incident its setup made */
  preview: string[];
  unlocks: string[];
  setup: string[];
  because: string[];
  commitment?: Commitment;
  resolvesTurn?: number;
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
const keyOf = (t: TemplateDef, b: Bind) => `${t.id}:${Object.keys(b).sort().map((k) => b[k]).join(',')}`;
const kinds = (s: BindSpec) => (Array.isArray(s.kind) ? s.kind : [s.kind]);
/** a template reads the owners' records (quantities, holders, buildings): world changes make it re-evaluate */
const readsWorld = (t: TemplateDef) => /"qty"|\.controller|noBuilding|notAtWar|"law"/.test(JSON.stringify([t.bind, t.eligible]));

/** a reward's rough worth (the dealer's value part): goods, pawns by head and traits, engine pieces, unlocks */
export function rewardValue(r: RewardSpec): number {
  const goods = Object.values(r.goods ?? {}).reduce((a, n) => a + n, 0) / 4;
  const pawns = (r.agents ?? []).reduce((a, x) => a + 2 + x.count / 2 + pawnTraits(x).filter((t) => t !== 'living').length * 2, 0);
  return goods + pawns + (r.bonuses?.length ?? 0) * 4 + (r.unlocks?.length ?? 0) * 3;
}

/** the reward's goods and pawns as the contract's outcome effects (its resolve adds them to the holdings) */
export function rewardEffects(r: RewardSpec, key: string, home: EntityId): OppEffect[] {
  return [
    ...(r.goods ? [{ kind: 'goods' as const, goods: { ...r.goods } }] : []),
    ...(r.agents ?? []).map((a, i) => ({ kind: 'agent' as const, agent: { id: `${key}:${i}`, kind: a.kind, name: a.name, count: a.count, tags: [...a.tags], statuses: [], at: { settlement: home }, ...(a.parts ? { parts: structuredClone(a.parts) } : {}) } })),
  ];
}

/** Every binding of a template, and why the others fail (first few). */
export function enumerate(w: FactWorld, t: TemplateDef, limit = 4): { ok: Bind[]; fails: string[] } {
  const ok: Bind[] = [];
  const fails: string[] = [];
  const f = w.facts;
  const walk = (i: number, b: Bind) => {
    const c: Ctx = { w, b, cause: t.id };
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
      const bad = (s.where ?? []).find((p) => !holds({ w, b: nb, cause: t.id }, p));
      if (bad) {
        if (fails.length < limit) fails.push(`${s.as} ${w.name(id)}: not ${describe({ w, b: nb, cause: t.id }, bad)}`);
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
export function applyBatch(w: FactWorld, effects: Effect[], b: Bind, cause: string, changed?: Set<EntityId>): string[] {
  const before = w.full();
  w.facts.drainChanged();
  const c: Ctx = { w, b, cause };
  apply(c, effects);
  const drained = w.facts.drainChanged();
  for (const id of drained) changed?.add(id);
  const touched = [...drained].flatMap((id) => affectedBy(w.facts, id));
  const broken = checkInvariants(w.facts, new Set(touched));
  if (broken.length) {
    const back = FactWorld.from(before);
    w.ws = back.ws;
    w.holdings = back.holdings;
    w.diplomacy = back.diplomacy;
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

  /** (round 125) the run's locus: focus grows outward from it and its cast */
  locus: EntityId;

  constructor(w: FactWorld, templates: TemplateDef[], arc?: ArcDef, locus?: EntityId) {
    this.w = w;
    this.locus = locus ?? w.holdings.rules[0] ?? w.ws.settlements[0]?.id ?? '';
    this.templates = templates;
    this.arc = arc;
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

  // ---- evaluation ------------------------------------------------------------------------------------------------------

  /** every template's eligible bindings on a world (all evaluated: dry runs use this) */
  static eligibleKeys(w: FactWorld, templates: TemplateDef[]): Set<string> {
    const out = new Set<string>();
    for (const t of templates) for (const b of enumerate(w, t).ok) out.add(keyOf(t, b));
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
      const dirty = !this.cache.has(t.id) || t.bind.some((s) => kinds(s).some((k) => changedKinds.has(k))) || (worldMoved && readsWorld(t)) || changed.size > 0 && JSON.stringify(t).includes('"event"');
      if (dirty) {
        this.cache.set(t.id, enumerate(this.w, t));
        evaluated++;
      }
      const r = this.cache.get(t.id)!;
      for (const b of r.ok) cands.push({ t, b, key: keyOf(t, b) });
      for (const why of r.fails) fails.push({ template: t.id, title: t.title.replace(/\{[^}]*\}/g, '…'), step: 'eligible', why });
    }
    return { cands, fails, evaluated, changed: changed.size };
  }

  /** what a candidate would do: the dry run (its setup, its outcome) on a copy — the diff, the templates it unlocks */
  dryRun(t: TemplateDef, b: Bind, before?: Set<string>): { diff: string[]; unlocks: string[] } {
    const copy = this.w.clone();
    const was = before ?? LivingEngine.eligibleKeys(this.w, this.templates);
    const cause = `${t.id}:dry`;
    const pre = copy.full();
    const bb = { ...b };
    if (t.setup && !this.setupDone.has(keyOf(t, b))) apply({ w: copy, b: bb, cause }, t.setup);
    applyBatch(copy, t.outcome, bb, cause);
    const diff = diffWorld(pre, copy.full(), (id) => copy.name(id));
    const after = LivingEngine.eligibleKeys(copy, this.templates);
    const had = new Set([...was].map((k) => k.split(':')[0]));
    const unlocks = [...new Set([...after].filter((k) => !was.has(k)).map((k) => k.split(':')[0]))].filter((id) => id !== t.id && !had.has(id));
    return { diff, unlocks };
  }

  // ---- the deal ----------------------------------------------------------------------------------------------------------

  deal(): EngineReport {
    const t0 = now();
    const turn = this.turn;
    const live = this.offers.filter((o) => o.status === 'offered' || o.status === 'committed');
    const liveKeys = new Set(live.map((o) => o.key));
    const busy = new Set(live.flatMap((o) => o.subjects));
    const placesHeld = new Map(this.offers.filter((o) => o.status === 'offered').map((o) => [o.place, o]));
    const ev = this.evaluate();
    const notProposed = [...ev.fails];
    const was = LivingEngine.eligibleKeys(this.w, this.templates);
    // (what the player cares about: their stakes, and the distance from the run's locus and its cast)
    const st = stakes(this.w);
    const dist = hops(this.w, this.locus, st.keys());
    const props: Proposal[] = [];
    const meta = new Map<string, { c: Cand; preview: string[]; unlocks: string[]; subjects: string[]; place: string; presenter: EntityId | null; group: EntityId }>();
    const presenting = new Set(live.map((o) => o.presenter));
    for (const c of ev.cands) {
      const { t, b, key } = c;
      const title = text({ w: this.w, b, cause: t.id }, t.title);
      const np = (step: NotProposed['step'], why: string) => notProposed.push({ template: t.id, title, step, why });
      if (liveKeys.has(key)) {
        np('dedup', 'already on the board or under way');
        continue;
      }
      const restUntil = Math.max(this.rest.get(key) ?? -Infinity, this.rest.get(`${t.id}@${b[t.at]}`) ?? -Infinity);
      if (restUntil > turn) {
        np('cooldown', `resting until turn ${restUntil} (this binding, or this template at ${this.w.name(b[t.at])})`);
        continue;
      }
      const subjects = t.bind.filter((s) => !s.shared && !kinds(s).some((k) => k === 'settlement' || k === 'polity')).map((s) => b[s.as]);
      const clash = subjects.find((s) => busy.has(s));
      if (clash) {
        np('subjects', `${this.w.name(clash)} is already the subject of a live card`);
        continue;
      }
      const place = b[t.at];
      const held = placesHeld.get(place);
      if (held) {
        np('place', `one card a location: "${held.opp.title}" is offered at ${this.w.name(place)}`);
        continue;
      }
      const ctx: Ctx = { w: this.w, b, cause: t.id };
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
      const { diff, unlocks } = this.dryRun(t, b, was);
      const loc = this.w.locate(place);
      if (!loc) throw new Error(`${t.id}: ${place} has no place on the map`);
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
      };
      const expires = turn + (t.offerTurns ?? 2) - 1;
      const elig = (t.eligible ?? []).map((p) => describe(ctx, p));
      props.push({
        template: t.id,
        offer: key,
        place,
        title,
        tiers: [{ requires: t.requires.agents, costs: t.requires.goods ?? {} }],
        make: () => ({
          template: t.id,
          offer: key,
          title,
          pitch: text(ctx, t.pitch),
          location: { region: loc.region, ...(loc.settlement ? { settlement: loc.settlement } : {}), at: loc.at, name: this.w.name(place) },
          duration: { turns: t.turns },
          outcomes: { success: { text: text(ctx, t.outcomeText), effects: rewardEffects(t.reward, key, this.locus), ...(t.losses ? { losses: t.losses } : {}) } },
          visibility: 'known',
          expires: { turn: expires },
          ...(t.onExpire ? { onExpire: { text: text(ctx, t.expireText ?? 'it lapses'), effects: [] } } : {}),
          themes: t.themes,
          hooks: t.themes,
        }),
        sense: [...t.bind.map((s) => ({ ok: true, why: `${s.as}: ${this.w.name(b[s.as])}` })), ...elig.map((why) => ({ ok: true, why })), ...stores],
        parts,
        at: loc.at,
        hooks: t.themes,
      });
      meta.set(key, { c, preview: diff, unlocks, subjects, place, presenter, group });
    }
    const tune = { ...OPP_TUNE.dealer, reach: 1e9, playerMax: 2, resourceMax: 4, unaffordable: 1, nextTier: 0 };
    const dealer = props.length ? deal(props, { holdings: this.w.holdings, turn, at: [0, 0], dist: () => 0, conflictHooks: this.arc?.themes ?? [], recent: this.recent, tune, onePerPlace: true }) : null;
    const dealt: Offer[] = [];
    for (const d of dealer?.dealt ?? []) {
      const m = meta.get(d.opp.offer)!;
      const { t, b, key } = m.c;
      const id = `${key}@${turn}`;
      // (its presenter: made now it's shown, when the cast had no one free — a real person the world remembers)
      let setup: string[] = [];
      let presenter = m.presenter;
      if (!presenter || presenting.has(presenter)) {
        const before = this.w.full();
        presenter = makePresenter(this.w, m.group, t.presenter.role, id);
        setup = diffWorld(before, this.w.full(), (x) => this.w.name(x));
      }
      presenting.add(presenter);
      const bind = { ...b, presenter };
      const pctx: Ctx = { w: this.w, b: bind, cause: id };
      const line = text(pctx, t.presenter.line);
      const opp = { ...d.opp, pitch: `${this.w.name(presenter)} ${t.presenter.verb}: “${line}” ${d.opp.pitch}` };
      const o: Offer = { id, key, template: t.id, bind, place: m.place, subjects: [...m.subjects.filter((x) => x !== m.presenter), presenter], dealt: turn, expires: d.opp.expires.turn, opp, status: 'offered', presenter, line, preview: m.preview, unlocks: m.unlocks, setup, because: d.opp.because };
      // (the incident, made now it's shown — once per binding)
      if (t.setup && !this.setupDone.has(key)) {
        o.setup = [...setup, ...applyBatch(this.w, t.setup, o.bind, o.id)];
        this.setupDone.add(key);
      }
      this.offers.push(o);
      this.recent.push({ template: t.id, place: m.place, turn });
      dealt.push(o);
    }
    this.report = { turn, dealt, kept: live.filter((o) => o.status === 'offered'), notProposed, dealer, evaluated: { templates: ev.evaluated, of: this.templates.length, changed: ev.changed }, ms: +(now() - t0).toFixed(1) };
    return this.report;
  }

  // ---- commit and resolve ------------------------------------------------------------------------------------------------

  commit(offerId: string): Offer {
    const o = this.offers.find((x) => x.id === offerId && x.status === 'offered');
    if (!o) throw new Error(`no offer ${offerId} on the board`);
    const t = this.template(o.template);
    const ctx: Ctx = { w: this.w, b: o.bind, cause: o.id };
    const a = affords(o.opp, this.w.holdings);
    if (!a.ok) throw new Error(`commit ${o.opp.title}: ${a.missing.join('; ')}`);
    const before = this.w.full();
    const { holdings, commitment } = commitOpp(this.w.holdings, o.opp, { id: o.id, now: 0, turn: this.turn });
    const crewAgents = holdings.agents.filter((x) => commitment.agents.includes(x.id) && x.kind !== 'player');
    const labour = crewAgents.filter((x) => x.kind === 'workers' || x.kind === 'army');
    const crew = t.work === 'labour' ? labour : crewAgents;
    const rules = crewRules(crew);
    // (the contract's own commit effects first — an engine piece that shortens — then the crew's traits)
    const timing = crewTurns(Math.max(1, (commitment.resolvesTurn ?? this.turn + t.turns) - this.turn), t.work, crew);
    if (commitment.fired?.length) timing.why.unshift(...commitment.fired.map((f) => `${f}: fewer turns`));
    // (the real stores, spent at the settlement that holds them; upkeep waived for a crew that eats nothing)
    for (const s of t.requires.stores ?? []) {
      const at = ref(ctx, s.at);
      if (s.upkeep && rules.some((r) => r.rule.noUpkeep)) continue;
      if ((this.w.qty(at, s.good) ?? 0) < s.amount) throw new Error(`commit ${o.opp.title}: ${this.w.name(at)} hasn't ${s.amount} ${s.good}`);
    }
    this.w.holdings = holdings;
    const notes: string[] = [...timing.why];
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
    answer(this.w, o.presenter, 'committed', o.opp.title, o.id);
    this.w.facts.record({ kind: 'committed', by: ['player'], to: [o.place], about: { opp: o.id }, note: `${o.opp.title}: ${commitment.agents.map((id) => holdings.agents.find((x) => x.id === id)?.name ?? id).join(', ')} committed` });
    o.status = 'committed';
    o.commitment = commitment;
    o.resolvesTurn = this.turn + timing.turns;
    o.crew = notes;
    o.spent = diffWorld(before, this.w.full(), (id) => this.w.name(id));
    this.changes.push({ turn: this.turn, what: `committed: ${o.opp.title}`, lines: o.spent });
    for (const th of t.themes) this.taken.set(th, this.turn);
    this.log.push(`turn ${this.turn}: committed to "${o.opp.title}" — resolves turn ${o.resolvesTurn}${notes.length ? ` (${notes.join('; ')})` : ''}`);
    return o;
  }

  /** (round 125) the player turns a card down: its presenter remembers it, its binding rests */
  refuse(offerId: string): Offer {
    const o = this.offers.find((x) => x.id === offerId && x.status === 'offered');
    if (!o) throw new Error(`no offer ${offerId} on the board`);
    const t = this.template(o.template);
    const before = this.w.full();
    answer(this.w, o.presenter, 'refused', o.opp.title, o.id);
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

  private resolveOffer(o: Offer): void {
    const t = this.template(o.template);
    const before = this.w.full();
    const out = resolveOpp(this.w.holdings, o.commitment!, { now: 0, turn: this.turn });
    // (regenerating pawns: what they lost comes back by the next turn)
    for (const l of out.resolution.lost) {
      const had = before.holdings.agents.find((a) => a.id === l.agent)!;
      const rules = crewRules([had]);
      if (rules.some((r) => r.rule.recovers)) this.recovering.push({ ...structuredClone(had), committed: undefined });
    }
    this.w.holdings = out.holdings;
    const made = new Set<EntityId>();
    applyBatch(this.w, t.outcome, o.bind, o.id, made);
    // (what the player gets: engine pieces and unlocks — the goods and pawns came with the contract's resolve)
    for (const b of t.reward.bonuses ?? []) if (!this.w.holdings.bonuses.some((x) => x.why === b.why && !x.holder)) this.w.holdings.bonuses.push(structuredClone(b));
    const player = this.w.diplomacy.idOf({ player: true });
    for (const u of t.reward.unlocks ?? []) {
      this.w.facts.setTag(player, 'capability', `${u.mode}:${u.what}`, true, o.id);
      this.w.facts.record({ kind: 'unlocked', by: [player], to: [player], about: { opp: o.id }, note: `unlocked for the ${u.mode === 'city' ? 'city builder' : u.mode}: ${u.what}` });
    }
    // (provenance: what the player's card made or changed is theirs — the dealer's stakes read it)
    made.delete(player);
    if (made.size) this.w.facts.record({ kind: 'player-made', by: [player], to: [...made].sort(), about: { opp: o.id }, note: `made by your hand: ${o.opp.title}` });
    o.status = 'resolved';
    o.result = diffWorld(before, this.w.full(), (id) => this.w.name(id));
    this.rest.set(o.key, this.turn + (t.cooldown ?? 3));
    this.rest.set(`${o.template}@${o.place}`, this.turn + (t.cooldown ?? 3));
    this.offers = this.offers.filter((x) => x !== o);
    this.past.push(o);
    this.log.push(`turn ${this.turn}: "${o.opp.title}" resolved — ${o.result.length} changes`);
    this.changes.push({ turn: this.turn, what: `resolved: ${o.opp.title}`, lines: o.result });
  }

  // ---- the turn ----------------------------------------------------------------------------------------------------------

  /** a turn passes: stores move by their rates, losses recover, cards resolve or lapse, the arc advances, claims lapse;
   *  then the next deal */
  advance(): EngineReport {
    const w = this.w;
    w.facts.turn++;
    // (the turn's economy: each settlement's stores move by their rates over the turn's days — an instant step)
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
    for (const o of this.offers.filter((x) => x.status === 'committed' && (x.resolvesTurn ?? Infinity) <= this.turn)) this.resolveOffer(o);
    for (const o of this.offers.filter((x) => x.status === 'offered' && x.expires < this.turn)) {
      const t = this.template(o.template);
      const before = w.full();
      if (t.onExpire) applyBatch(w, t.onExpire, o.bind, `${o.id}:lapsed`);
      answer(w, o.presenter, 'ignored', o.opp.title, o.id);
      o.result = diffWorld(before, w.full(), (id) => w.name(id));
      o.status = 'expired';
      this.rest.set(o.key, this.turn + (t.cooldown ?? 3));
      this.rest.set(`${o.template}@${o.place}`, this.turn + (t.cooldown ?? 3));
      this.offers = this.offers.filter((x) => x !== o);
      this.past.push(o);
      this.changes.push({ turn: this.turn, what: `lapsed: ${o.opp.title}`, lines: o.result });
      this.log.push(`turn ${this.turn}: "${o.opp.title}" lapsed${o.result.length ? ` — ${o.result.length} changes` : ''}`);
    }
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
