// ---- living/dsl.ts ------------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F5) The templates' data language: predicates (loose plausibility checks over the fact
// world), bindings (select real entities), and effects (mutations through the owners: the FactStore, mutations.ts,
// diplomacy). Plain data — a template is JSON-shaped — with a small library of named helpers for the complex cases
// (HELPERS). Not a general rule engine: straightforward code over the indexed collections, as the user's doc asks.
//
// References: '$name' is a bound entity, '$name.controller' its controller, '$name.home' its settlement, '$name.polity'
// its polity; anything else is a literal id. Text: '{name}' is a bound entity's name.

import { CLAIM_BASES, type ClaimBasis, type EntityId, type EntityKind, type RelationType, type ScopedTag, type TagScope, type INTENSITIES } from '../api/contracts/facts';
import { homeOf, lawAt, polityOf } from '../api/contracts/facts-rules';
import type { Agreement } from '../api/contracts/diplomacy';
import { adjustStores, migrate, placeStructure, setCondition, setControl, setRiverInflow, shiftPower } from './mutations';
import { entityTraits } from './traits';
import type { FactWorld } from './world';

export type Ref = string;
export type Value = ScopedTag['value'];
type Intensity = (typeof INTENSITIES)[number];
export type Bind = Record<string, EntityId>;

export type Pred =
  /** carries the tag (with this value, or any value but false) */
  | { tag: [Ref, TagScope, string]; is?: Value }
  /** an intensity in a range (absent: 0) */
  | { intensity: [Ref, Intensity]; gte?: number; lte?: number }
  /** the law in force for it (its settlement's override, else its polity's) */
  | { law: [Ref, string]; is: Value }
  /** a relation holds (stored or derived), its strength at least */
  | { rel: [Ref, RelationType, Ref]; gte?: number }
  /** a claim by (anyone, or this one) on a target (of this what, on this basis) */
  | { claim: { by?: Ref; on: Ref; what?: string; basis?: ClaimBasis } }
  /** a quantity from its owner (stores, people, inflow, power) */
  | { qty: [Ref, string]; gte?: number; lte?: number }
  /** has an intrinsic trait (biology: species or trait — one vocabulary with traits.ts) */
  | { trait: [Ref, string] }
  | { same: [Ref, Ref] }
  | { event: { kind: string; involving?: Ref; within?: number } }
  | { not: Pred }
  | { any: Pred[] }
  | { all: Pred[] }
  | { helper: string; args?: (Ref | number | string)[] };

/** how a binding finds its candidates: an index (kind, tag), or a relation from/to a bound entity */
export interface BindSpec {
  as: string;
  kind: EntityKind | EntityKind[];
  tag?: { scope: TagScope; key: string; value?: Value };
  /** candidates on the far end of a relation: [from, type, to], '$' the candidate */
  via?: [Ref, RelationType, Ref];
  where?: Pred[];
  /** not a subject (a settlement or polity can be in several cards at once); default: subjects unless a settlement or polity */
  shared?: boolean;
}

export type Effect =
  | { setTag: [Ref, TagScope, string, Value] }
  | { dropTag: [Ref, TagScope, string] }
  | { bump: [Ref, Intensity, number] }
  /** relate (strength set, or moved by `add`; a relation moved to 0 or under ends) */
  | { relate: [Ref, RelationType, Ref]; strength?: number; add?: number; symmetric?: boolean }
  | { unrelate: [Ref, RelationType, Ref] }
  | { claim: { by: Ref; on: Ref; what?: string; basis: ClaimBasis; strength: number; recognisedBy?: Ref[]; turns?: number } }
  | { recognise: { on: Ref; by?: Ref; what?: string; recognisedBy: Ref } }
  | { dropClaims: { on: Ref; by?: Ref; what?: string } }
  | { control: [Ref, Ref] }
  | { event: string; by: Ref[]; to: Ref[]; note: string; weight?: number; halfLife?: number }
  /** a diplomacy agreement (relations through MemoryDiplomacy) */
  | { agree: { kind: Agreement['kind']; parties: Ref[]; flows?: { what: string; perDay: number }[] } }
  | { inflow: Ref; factor?: number; delta?: number; note: string }
  | { stores: [Ref, string, number]; rate?: number; note?: string }
  | { power: [Ref, number] }
  | { condition: [Ref, 'thriving' | 'struggling' | 'besieged' | 'abandoned' | 'ruined'] }
  | { migrate: [Ref, Ref, number]; note: string }
  | { place: { at: Ref; id: string; name: string; use: string[]; tags?: Omit<ScopedTag, 'since'>[]; by?: Ref } }
  /** a new entity (an incident, a route); `links`: entities `connected_by` it (a road's ends) */
  | { spawn: { id: string; kind: EntityKind; name: string; at: Ref; tags?: Omit<ScopedTag, 'since'>[]; links?: Ref[] } }
  /** these effects for each entity matching (bound as `as` while they run) */
  | { forEach: { as: string; kind: EntityKind; where: Pred[] }; do: Effect[] }
  /** only when the predicate holds now */
  | { when: Pred; do: Effect[]; else?: Effect[] }
  | { helper: string; args?: (Ref | number | string)[] };

export interface Ctx {
  w: FactWorld;
  b: Bind;
  /** the cause written on every change (the opportunity, or the arc's stage) */
  cause: string;
}

// ---- references and text ----------------------------------------------------------------------------------------------

export function ref(c: Ctx, r: Ref): EntityId {
  if (!r.startsWith('$')) return r;
  const [name, part] = r.slice(1).split('.');
  const id = c.b[name];
  if (id === undefined) throw new Error(`template: no binding ${name} (in ${r})`);
  if (!part) return id;
  const out = part === 'controller' ? c.w.controllerOf(id) : part === 'home' ? homeOf(c.w.facts, id) : part === 'polity' ? polityOf(c.w.facts, id) : undefined;
  if (out === undefined) throw new Error(`template: ${r} — ${id} has no ${part}`);
  return out;
}

/** a ref that may not resolve (a predicate is false then, not an error) */
function tryRef(c: Ctx, r: Ref): EntityId | undefined {
  try {
    return ref(c, r);
  } catch {
    return undefined;
  }
}

export function text(c: Ctx, s: string): string {
  return s.replace(/\{(\$?[a-z][\w.]*)\}/gi, (_, k: string) => {
    const id = tryRef(c, k.startsWith('$') ? k : `$${k}`);
    return id ? c.w.name(id) : `{${k}}`;
  });
}

// ---- predicates ---------------------------------------------------------------------------------------------------------

const inRange = (v: number | undefined, p: { gte?: number; lte?: number }) => v !== undefined && (p.gte === undefined || v >= p.gte) && (p.lte === undefined || v <= p.lte);

export function holds(c: Ctx, p: Pred): boolean {
  const f = c.w.facts;
  if ('tag' in p) {
    const id = tryRef(c, p.tag[0]);
    const t = id ? f.tag(id, p.tag[1], p.tag[2]) : undefined;
    return !!t && (p.is === undefined ? t.value !== false : t.value === p.is);
  }
  if ('intensity' in p) {
    const id = tryRef(c, p.intensity[0]);
    const t = id ? f.tag(id, 'condition', p.intensity[1]) ?? f.entity(id)?.tags.find((x) => x.key === p.intensity[1]) : undefined;
    return !!id && inRange(typeof t?.value === 'number' ? t.value : 0, p);
  }
  if ('law' in p) {
    const id = tryRef(c, p.law[0]);
    return !!id && lawAt(f, id, p.law[1])?.value === p.is;
  }
  if ('rel' in p) {
    const a = tryRef(c, p.rel[0]);
    const b = tryRef(c, p.rel[2]);
    if (!a || !b) return false;
    return c.w.relations({ type: p.rel[1], from: a, to: b }).some((r) => p.gte === undefined || (r.strength ?? 1) >= p.gte);
  }
  if ('claim' in p) {
    const on = tryRef(c, p.claim.on);
    const by = p.claim.by ? tryRef(c, p.claim.by) : undefined;
    if (!on || (p.claim.by && !by)) return false;
    return f.claims({ target: on, ...(by ? { claimant: by } : {}) }).some((x) => (p.claim.what === undefined || x.what === p.claim.what) && (!p.claim.basis || x.basis === p.claim.basis));
  }
  if ('qty' in p) {
    const id = tryRef(c, p.qty[0]);
    return !!id && inRange(c.w.qty(id, p.qty[1]), p);
  }
  if ('trait' in p) {
    const id = tryRef(c, p.trait[0]);
    return !!id && (entityTraits(f, id) as string[]).includes(p.trait[1]);
  }
  if ('same' in p) return tryRef(c, p.same[0]) === tryRef(c, p.same[1]);
  if ('event' in p) {
    const who = p.event.involving ? tryRef(c, p.event.involving) : undefined;
    return f.events({ kind: p.event.kind, ...(who ? { involving: who } : {}), ...(p.event.within !== undefined ? { since: f.turn - p.event.within } : {}) }).length > 0;
  }
  if ('not' in p) return !holds(c, p.not);
  if ('any' in p) return p.any.some((x) => holds(c, x));
  if ('all' in p) return p.all.every((x) => holds(c, x));
  const h = HELPERS[p.helper];
  if (!h?.pred) throw new Error(`template: no predicate helper ${p.helper}`);
  return h.pred(c, p.args ?? []);
}

/** a predicate in words (why a card was or wasn't dealt) */
export function describe(c: Ctx, p: Pred): string {
  const n = (r: Ref) => {
    const id = tryRef(c, r);
    return id ? c.w.name(id) : r;
  };
  const range = (q: { gte?: number; lte?: number }) => [q.gte !== undefined ? `≥ ${q.gte}` : '', q.lte !== undefined ? `≤ ${q.lte}` : ''].filter(Boolean).join(' and ');
  if ('tag' in p) return `${n(p.tag[0])} has ${p.tag[1]} ${p.tag[2]}${p.is !== undefined ? ` = ${p.is}` : ''}`;
  if ('intensity' in p) return `${n(p.intensity[0])}'s ${p.intensity[1]} ${range(p)}`;
  if ('law' in p) return `${p.law[1]} is ${p.is} for ${n(p.law[0])}`;
  if ('rel' in p) return `${n(p.rel[0])} ${p.rel[1]} ${n(p.rel[2])}${p.gte !== undefined ? ` (≥ ${p.gte})` : ''}`;
  if ('claim' in p) return `${p.claim.by ? n(p.claim.by) : 'someone'} claims ${n(p.claim.on)}${p.claim.what ? ` (${p.claim.what})` : ''}`;
  if ('qty' in p) {
    const id = tryRef(c, p.qty[0]);
    const v = id ? c.w.qty(id, p.qty[1]) : undefined;
    return `${n(p.qty[0])}'s ${p.qty[1]} ${range(p)} (now ${v === undefined ? '—' : +v.toFixed(2)})`;
  }
  if ('trait' in p) return `${n(p.trait[0])} is ${p.trait[1]}`;
  if ('same' in p) return `${n(p.same[0])} is ${n(p.same[1])}`;
  if ('event' in p) return `a ${p.event.kind}${p.event.involving ? ` involving ${n(p.event.involving)}` : ''}${p.event.within !== undefined ? ` in the last ${p.event.within} turns` : ''}`;
  if ('not' in p) return `not (${describe(c, p.not)})`;
  if ('any' in p) return p.any.map((x) => describe(c, x)).join(' or ');
  if ('all' in p) return p.all.map((x) => describe(c, x)).join(' and ');
  return HELPERS[p.helper]?.text?.(c, p.args ?? []) ?? `${p.helper}(${(p.args ?? []).join(', ')})`;
}

// ---- effects ------------------------------------------------------------------------------------------------------------

export function apply(c: Ctx, effects: Effect[]): void {
  for (const e of effects) applyOne(c, e);
}

function applyOne(c: Ctx, e: Effect): void {
  const { w, cause } = c;
  const f = w.facts;
  if ('setTag' in e) return f.setTag(ref(c, e.setTag[0]), e.setTag[1], e.setTag[2], e.setTag[3], cause);
  if ('dropTag' in e) return f.dropTag(ref(c, e.dropTag[0]), e.dropTag[1], e.dropTag[2]);
  if ('bump' in e) return void f.bump(ref(c, e.bump[0]), e.bump[1], e.bump[2], cause);
  if ('relate' in e) {
    const [a, type, b] = [ref(c, e.relate[0]), e.relate[1], ref(c, e.relate[2])];
    const had = f.relations({ type, from: a, to: b })[0];
    const s = e.add !== undefined ? (had?.strength ?? 0) + e.add : e.strength;
    if (s !== undefined && s <= 0) {
      if (had) f.unrelate({ id: had.id, type }, cause);
      return;
    }
    f.relate({ type, from: a, to: b, ...(s !== undefined ? { strength: Math.min(1, +s.toFixed(3)) } : {}), ...(e.symmetric ? { symmetric: true } : {}), cause });
    return;
  }
  if ('unrelate' in e) return void f.unrelate({ type: e.unrelate[1], from: ref(c, e.unrelate[0]), to: ref(c, e.unrelate[2]) }, cause);
  if ('claim' in e) {
    const x = e.claim;
    if (!CLAIM_BASES.includes(x.basis)) throw new Error(`template: no claim basis ${x.basis}`);
    f.claim({ claimant: ref(c, x.by), target: ref(c, x.on), ...(x.what ? { what: x.what } : {}), basis: x.basis, strength: x.strength, recognisedBy: (x.recognisedBy ?? []).map((r) => ref(c, r)), ...(x.turns ? { expires: f.turn + x.turns } : {}), cause });
    return;
  }
  if ('recognise' in e) {
    const on = ref(c, e.recognise.on);
    const by = e.recognise.by ? ref(c, e.recognise.by) : undefined;
    const r = ref(c, e.recognise.recognisedBy);
    for (const cl of f.claims({ target: on, ...(by ? { claimant: by } : {}) })) if (e.recognise.what === undefined || cl.what === e.recognise.what) f.claim({ ...cl, recognisedBy: [r] });
    return;
  }
  if ('dropClaims' in e) {
    const on = ref(c, e.dropClaims.on);
    const by = e.dropClaims.by ? ref(c, e.dropClaims.by) : undefined;
    for (const cl of f.claims({ target: on, ...(by ? { claimant: by } : {}) })) if (e.dropClaims.what === undefined || cl.what === e.dropClaims.what) f.dropClaim(cl.id);
    return;
  }
  if ('control' in e) return setControl(w, ref(c, e.control[0]), ref(c, e.control[1]), cause);
  if ('event' in e)
    return void f.record({ kind: e.event, by: e.by.map((r) => ref(c, r)), to: e.to.map((r) => ref(c, r)), note: text(c, e.note), about: { opp: cause }, ...(e.weight !== undefined ? { weight: e.weight } : {}), ...(e.halfLife !== undefined ? { halfLife: e.halfLife } : {}) });
  if ('agree' in e) {
    const ids = e.agree.parties.map((r) => ref(c, r));
    w.diplomacy.agree({
      id: `${cause}:${e.agree.kind}`,
      kind: e.agree.kind,
      parties: ids.map((id) => w.diplomacy.partyOf(id)),
      ...(e.agree.flows ? { flows: e.agree.flows.map((x) => ({ from: 0, to: 1, what: x.what, perDay: x.perDay })) } : {}),
      since: { run: w.ws.run, t: f.turn },
      status: 'active',
      cause: { by: 'player', ref: cause },
    });
    return;
  }
  if ('inflow' in e) return void setRiverInflow(w, ref(c, e.inflow), e.factor !== undefined ? { factor: e.factor } : { delta: e.delta ?? 0 }, cause, text(c, e.note));
  if ('stores' in e) return adjustStores(w, ref(c, e.stores[0]), e.stores[1], e.stores[2], e.rate ?? 0, cause, e.note ? text(c, e.note) : undefined);
  if ('power' in e) return shiftPower(w, ref(c, e.power[0]), e.power[1], cause);
  if ('condition' in e) return setCondition(w, ref(c, e.condition[0]), e.condition[1], cause);
  if ('migrate' in e) return migrate(w, ref(c, e.migrate[0]), ref(c, e.migrate[1]), e.migrate[2], cause, text(c, e.note));
  if ('place' in e) {
    const x = e.place;
    const at = ref(c, x.at);
    const id = placeStructure(w, at, { id: x.id, name: text(c, x.name), use: x.use, ...(x.tags ? { tags: x.tags } : {}), ...(x.by ? { by: ref(c, x.by) } : {}) }, cause);
    c.b[x.id] = id;
    return;
  }
  if ('spawn' in e) {
    const x = e.spawn;
    const id = text(c, x.id).replace(/\s+/g, '-').toLowerCase();
    const at = ref(c, x.at);
    const s = w.settlementOf(at);
    f.add({ id, kind: x.kind, name: text(c, x.name), at: s ? w.placeAt(s.id) : {}, tags: (x.tags ?? []).map((t) => ({ ...t, since: f.turn })), cause });
    for (const l of x.links ?? []) f.relate({ type: 'connected_by', from: ref(c, l), to: id, cause });
    c.b[x.kind] = id;
    return;
  }
  if ('forEach' in e) {
    const all = f.find({ kind: e.forEach.kind });
    for (const x of all) {
      const sub: Ctx = { ...c, b: { ...c.b, [e.forEach.as]: x.id } };
      if (e.forEach.where.every((p) => holds(sub, p))) apply(sub, e.do);
    }
    return;
  }
  if ('when' in e) return apply(c, holds(c, e.when) ? e.do : (e.else ?? []));
  const h = HELPERS[e.helper];
  if (!h?.effect) throw new Error(`template: no effect helper ${e.helper}`);
  h.effect(c, e.args ?? []);
}

// ---- helpers for the complex cases --------------------------------------------------------------------------------------

export interface Helper {
  pred?(c: Ctx, args: (Ref | number | string)[]): boolean;
  effect?(c: Ctx, args: (Ref | number | string)[]): void;
  text?(c: Ctx, args: (Ref | number | string)[]): string;
}

/** a holder's standing on what it controls, against a rival's claim (a recognised control stands stronger) */
function standing(c: Ctx, holder: EntityId, target: EntityId): number {
  const p = polityOf(c.w.facts, target);
  const recognised = c.w.facts.claims({ claimant: holder, target }).some((x) => p && x.recognisedBy.includes(p));
  return 0.5 + (recognised ? 0.2 : 0);
}

export const HELPERS: Record<string, Helper> = {
  /** lives in a settlement: livesIn($cohort, $town) */
  livesIn: {
    pred: (c, [x, t]) => c.w.settlementOf(ref(c, x as string))?.id === ref(c, t as string),
    text: (c, [x, t]) => `${c.w.name(ref(c, x as string))} lives in ${c.w.name(ref(c, t as string))}`,
  },
  /** the refugees of a town become a cohort of it (their people are the settlement's 'refugee' role), befriended by
   *  their hosts: refugeeCohort($town, $hosts) */
  refugeeCohort: {
    effect: (c, [t, h]) => {
      const town = ref(c, t as string);
      const hosts = ref(c, h as string);
      const id = `cohort:${town}:refugee`;
      if (!c.w.facts.entity(id)) {
        c.w.facts.add({ id, kind: 'cohort', name: `the refugees at ${c.w.name(town)}`, ref: { people: { settlement: town, role: 'refugee' } }, at: c.w.placeAt(town), cause: c.cause });
        c.w.facts.relate({ type: 'resident_at', from: id, to: town, cause: c.cause });
      }
      c.w.facts.relate({ type: 'friend_of', from: id, to: hosts, cause: c.cause });
    },
  },
  /** no building with this use at a settlement: noBuilding($town, 'burrows') */
  noBuilding: {
    pred: (c, [at, use]) => !(c.w.settlementOf(ref(c, at as string))?.buildings.some((b) => b.use.includes(use as string)) ?? false),
    text: (c, [at, use]) => `${c.w.name(ref(c, at as string))} has no ${use} yet`,
  },
  /** two settlements' holders are not at war: notAtWar($a, $b) */
  notAtWar: {
    pred: (c, [a, b]) => {
      const x = c.w.controllerOf(ref(c, a as string));
      const y = c.w.controllerOf(ref(c, b as string));
      return !x || !y || !c.w.facts.relations({ type: 'at_war_with', from: x, to: y }).length;
    },
    text: (c, [a, b]) => `${c.w.name(ref(c, a as string))} and ${c.w.name(ref(c, b as string))} are not at war`,
  },
  /** under this polity's jurisdiction: inPolity($x, $polity) */
  inPolity: {
    pred: (c, [x, p]) => polityOf(c.w.facts, ref(c, x as string)) === ref(c, p as string),
    text: (c, [x, p]) => `${c.w.name(ref(c, x as string))} is under ${c.w.name(ref(c, p as string))}`,
  },
  /** a rival with a plausible basis for claiming what another holds: a past founding, a debt, or a claim already
   *  pressed — never invented from nothing: plausibleClaim($rival, $site) */
  plausibleClaim: {
    pred: (c, [r, s]) => {
      const rival = ref(c, r as string);
      const site = ref(c, s as string);
      return c.w.facts.claims({ claimant: rival, target: site }).length > 0 || c.w.facts.events({ involving: rival }).some((e) => e.to.includes(site) && (e.kind === 'founding' || e.kind === 'loan'));
    },
    text: (c, [r, s]) => `${c.w.name(ref(c, r as string))} has a past with ${c.w.name(ref(c, s as string))} (a founding, a debt or a claim)`,
  },
  /** press the rival's claim if not pressed yet, its basis from the history (setup): pressClaim($rival, $site) */
  pressClaim: {
    effect: (c, [r, s]) => {
      const rival = ref(c, r as string);
      const site = ref(c, s as string);
      if (c.w.facts.claims({ claimant: rival, target: site }).length) return;
      const past = c.w.facts.events({ involving: rival }).find((e) => e.to.includes(site) && (e.kind === 'founding' || e.kind === 'loan'));
      const basis: ClaimBasis = past?.kind === 'loan' ? 'debt' : 'ancestral';
      c.w.facts.claim({ claimant: rival, target: site, basis, strength: basis === 'ancestral' ? 0.6 : 0.4, cause: c.cause });
      c.w.facts.record({ kind: 'claim-pressed', by: [rival], to: [site], about: { opp: c.cause }, note: `${c.w.name(rival)} presses an ${basis} claim to ${c.w.name(site)}` });
    },
  },
  /** the arbiter's ruling: the stronger of the holder's standing and the rival's claim wins: awardHolding($site, $holder, $rival, $arbiter) */
  awardHolding: {
    effect: (c, [s, h, r, a]) => {
      const [site, holder, rival, arbiter] = [s, h, r, a].map((x) => ref(c, x as string));
      const f = c.w.facts;
      const claim = f.claims({ claimant: rival, target: site })[0];
      const strong = (claim?.strength ?? 0) > standing(c, holder, site);
      const [win, lose] = strong ? [rival, holder] : [holder, rival];
      if (strong) {
        setControl(c.w, rival, site, c.cause);
        if (claim) f.dropClaim(claim.id);
        f.claim({ claimant: holder, target: site, basis: 'ancestral', strength: 0.3, cause: c.cause });
      } else if (claim) f.dropClaim(claim.id);
      f.relate({ type: 'grievance_against', from: lose, to: win, strength: Math.min(1, (f.relations({ type: 'grievance_against', from: lose, to: win })[0]?.strength ?? 0) + 0.3), cause: c.cause });
      f.record({ kind: 'arbitration', by: [arbiter], to: [win, lose], about: { opp: c.cause }, note: `${c.w.name(site)} awarded to ${c.w.name(win)} over ${c.w.name(lose)}` });
      // (the loser remembers who ruled against them: a diplomacy interaction, the same history)
      f.record({ kind: 'ruled-against', by: [c.w.diplomacy.idOf({ player: true })], to: [lose], weight: -0.3, halfLife: 3, about: { opp: c.cause }, note: `ruled ${c.w.name(site)} away from them` });
    },
  },
};
