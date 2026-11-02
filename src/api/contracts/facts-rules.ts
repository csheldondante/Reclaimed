// ---- api/contracts/facts-rules.ts ---------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F2) The fact layer's centralised rules: where an entity's laws come from (its
// jurisdiction, with a settlement's local override), and the invariants every batch of writes must keep. The user's
// doc §7: "Centralize invariant enforcement: no ordinary legal slave revolt where slavery is abolished; no hereditary
// court succession in a polity without noble offices; avoid mutually exclusive governing policies in the same
// jurisdiction. Exceptions (illegal slavery, pretenders, foreign courts) must be represented explicitly."
// Pure functions over the FactStore API.

import { EXCLUSIVE, type Entity, type EntityId, type FactStore, type ScopedTag, type Violation } from './facts.ts';

/** the settlement an entity lives in or is (a cohort's or person's `resident_at`, else its place's) */
export function homeOf(f: FactStore, id: EntityId): EntityId | undefined {
  const e = f.entity(id);
  if (!e) return undefined;
  if (e.kind === 'settlement') return e.id;
  const r = f.relations({ type: 'resident_at', from: id })[0];
  if (r) return r.to;
  if ('ref' in e && e.ref && 'people' in e.ref) return e.ref.people.settlement;
  if ('ref' in e && e.ref && 'building' in e.ref) return e.ref.building.settlement;
  return e.at.settlement;
}

/** the polity whose laws hold for an entity: a polity itself; else its home settlement's `part_of_polity` */
export function polityOf(f: FactStore, id: EntityId): EntityId | undefined {
  const e = f.entity(id);
  if (!e) return undefined;
  if (e.kind === 'polity') return e.id;
  const home = homeOf(f, id);
  const r = home ? f.relations({ type: 'part_of_polity', from: home })[0] : undefined;
  if (r) return r.to;
  return f.relations({ type: 'part_of_polity', from: id })[0]?.to;
}

/** The law in force for an entity: its home settlement's local override, else its polity's. `from` says which. */
export function lawAt(f: FactStore, id: EntityId, key: string): { value: ScopedTag['value']; from: EntityId } | undefined {
  const home = homeOf(f, id);
  const local = home ? f.tag(home, 'law', key) : undefined;
  if (local) return { value: local.value, from: home! };
  const p = polityOf(f, id);
  const t = p ? f.tag(p, 'law', key) : undefined;
  return t ? { value: t.value, from: p! } : undefined;
}

/** an explicit violation on an entity or its home (illegal bondage, a pretender): the exception the doc requires */
const violation = (f: FactStore, id: EntityId, key: string) => {
  const t = f.tag(id, 'condition', key);
  return !!t && t.value !== false;
};

export interface Invariant {
  id: string;
  /** what it keeps, in a sentence */
  text: string;
  check(f: FactStore, e: Entity): string | null;
}

/** bound labour: which law permits each, and the condition tag that marks it as an explicit (illegal) exception */
const BONDAGE: Record<string, { law: string; illegal: string }> = {
  serf: { law: 'serfdom', illegal: 'illegal_serfdom' },
  slave: { law: 'slavery', illegal: 'illegal_slavery' },
};

export const INVARIANTS: Invariant[] = [
  {
    id: 'bondage-legal',
    text: 'bound labour (serfs, slaves) exists only where its law permits it, or as an explicit illegal exception',
    check(f, e) {
      const labor = f.tag(e.id, 'economy', 'labor')?.value;
      const b = typeof labor === 'string' ? BONDAGE[labor] : undefined;
      if (!b) return null;
      const law = lawAt(f, e.id, b.law);
      if (law?.value === 'legal') return null;
      if (violation(f, e.id, b.illegal)) return null;
      return `${e.name} are bound as ${labor}s but ${b.law} is ${law ? `${law.value} (${law.from})` : 'not law'} there, and no ${b.illegal} marks it as an exception`;
    },
  },
  {
    id: 'exclusive-policies',
    text: 'no mutually exclusive governing policies in one jurisdiction',
    check(f, e) {
      if (e.kind !== 'polity' && e.kind !== 'settlement') return null;
      for (const x of EXCLUSIVE) {
        const [a, b] = x.keys.map((k) => f.tag(e.id, x.scope, k));
        if (a && b && a.value !== false && b.value !== false) return `${e.name} holds both ${x.keys[0]} and ${x.keys[1]} (${x.scope})`;
      }
      return null;
    },
  },
  {
    id: 'law-on-jurisdiction',
    text: 'laws are set on jurisdictions only (a polity, or a settlement overriding its polity)',
    check(f, e) {
      if (e.kind === 'polity' || e.kind === 'settlement') return null;
      const t = e.tags.find((x) => x.scope === 'law');
      return t ? `${e.name} is a ${e.kind}: it can't hold law ${t.key}` : null;
    },
  },
  {
    id: 'court-needs-nobility',
    text: 'hereditary court offices only in a polity with hereditary nobility (a pretender is explicit)',
    check(f, e) {
      if (!f.tag(e.id, 'government', 'hereditary_court')) return null;
      const p = polityOf(f, e.id);
      if (p && f.tag(p, 'government', 'hereditary_nobility')?.value === true) return null;
      if (violation(f, e.id, 'pretender')) return null;
      return `${e.name} keeps a hereditary court but its polity has no hereditary nobility`;
    },
  },
  {
    id: 'war-is-explicit',
    text: 'war and alliance are explicit relations, and two parties are never at war and allied at once',
    check(f, e) {
      for (const r of f.relations({ type: 'at_war_with', from: e.id })) {
        const other = r.from === e.id ? r.to : r.from;
        if (f.relations({ type: 'allied_with', from: e.id, to: other }).length) return `${e.name} is at war with and allied to ${other}`;
      }
      return null;
    },
  },
  {
    id: 'claim-not-control',
    text: 'a claim is not control: no one claims what they already control, and every claim names real ends',
    check(f, e) {
      for (const c of f.claims({ claimant: e.id })) {
        if (!f.entity(c.target)) return `${e.name} claims ${c.target}, which doesn't exist`;
        if (!c.what && f.relations({ type: 'controls', from: e.id, to: c.target }).length) return `${e.name} claims ${c.target}, which it already controls`;
      }
      return null;
    },
  },
];

/** the invariants broken among these entities (all of them when none are named) */
export function checkInvariants(f: FactStore, ids?: Iterable<EntityId>): Violation[] {
  const out: Violation[] = [];
  const list = ids ? [...ids].map((id) => f.entity(id)).filter((e): e is Entity => !!e) : f.find({});
  for (const e of list)
    for (const inv of INVARIANTS) {
      const why = inv.check(f, e);
      if (why) out.push({ rule: inv.id, entity: e.id, why });
    }
  return out;
}

/** the entities whose invariants a change to `id` can touch: itself, and for a jurisdiction everyone under it */
export function affectedBy(f: FactStore, id: EntityId): EntityId[] {
  const e = f.entity(id);
  if (!e) return [];
  const out = new Set<EntityId>([id]);
  if (e.kind === 'polity') for (const r of f.relations({ type: 'part_of_polity', to: id })) out.add(r.from);
  for (const s of [...out]) {
    const se = f.entity(s);
    if (se?.kind !== 'settlement') continue;
    for (const r of f.relations({ type: 'resident_at', to: s })) out.add(r.from);
    for (const x of f.find({ settlement: s })) out.add(x.id);
  }
  return [...out];
}
