// ---- api/contracts/facts-store.ts ---------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F1) The fact layer's store (facts.ts FactStore): in memory, indexed by kind, tag,
// place and relation type, every write checked against the scope rules, the entities changed since the last drain
// tracked (the template engine evaluates on those). Kept in the world snapshot (WorldSnapshot.facts); `migrateFacts`
// builds one from a save that has none (its factions, settlements and characters as entities).
// Cross-entity invariants (no legal serfdom where it's abolished …) are facts-rules.ts's: a batch of writes may pass
// through an inconsistent middle, so they are checked on the batch, by whoever applies it (the template engine).

import {
  HISTORIC,
  INTENSITIES,
  RELATION_TYPES,
  holds,
  tagRefusal,
  type Claim,
  type Entity,
  type EntityId,
  type FactEvent,
  type FactQuery,
  type FactSnapshot,
  type FactStore,
  type Relation,
  type RelQuery,
  type ScopedTag,
  type TagScope,
} from './facts.ts';
import type { WorldSnapshot } from './world';

const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
};
const del = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => m.get(k)?.delete(v);
const tkey = (scope: TagScope, key: string) => `${scope}:${key}`;

export class MemoryFacts implements FactStore {
  turn = 0;
  run = 0;
  private ents = new Map<EntityId, Entity>();
  private rels = new Map<string, Relation>();
  private cls = new Map<string, Claim>();
  private evs: FactEvent[] = [];
  private seq = 0;
  private changed = new Set<EntityId>();
  // indexes
  private byKind = new Map<string, Set<EntityId>>();
  private byTag = new Map<string, Set<EntityId>>();
  private byRegion = new Map<number, Set<EntityId>>();
  private bySettlement = new Map<string, Set<EntityId>>();
  private relByType = new Map<string, Set<string>>();
  private relByEnd = new Map<EntityId, Set<string>>();

  static restore(s: FactSnapshot): MemoryFacts {
    const f = new MemoryFacts();
    f.turn = s.turn;
    f.run = s.run;
    f.seq = s.seq;
    for (const e of structuredClone(s.entities)) f.index(e);
    for (const r of structuredClone(s.relations)) f.indexRel(r);
    for (const c of structuredClone(s.claims)) f.cls.set(c.id, c);
    f.evs = structuredClone(s.events);
    return f;
  }

  private id(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  private index(e: Entity): void {
    this.ents.set(e.id, e);
    add(this.byKind, e.kind, e.id);
    for (const t of e.tags) add(this.byTag, tkey(t.scope, t.key), e.id);
    if (e.at.region !== undefined) add(this.byRegion, e.at.region, e.id);
    if (e.at.settlement) add(this.bySettlement, e.at.settlement, e.id);
  }

  private indexRel(r: Relation): void {
    this.rels.set(r.id, r);
    add(this.relByType, r.type, r.id);
    add(this.relByEnd, r.from, r.id);
    add(this.relByEnd, r.to, r.id);
  }

  private dropRel(r: Relation): void {
    this.rels.delete(r.id);
    del(this.relByType, r.type, r.id);
    del(this.relByEnd, r.from, r.id);
    del(this.relByEnd, r.to, r.id);
  }

  private need(id: EntityId): Entity {
    const e = this.ents.get(id);
    if (!e) throw new Error(`facts: no entity ${id}`);
    return e;
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  entity(id: EntityId): Entity | undefined {
    return this.ents.get(id);
  }

  find(q: FactQuery): Entity[] {
    // (the narrowest index first, the rest filtered)
    const sets: Set<EntityId>[] = [];
    if (q.kind) sets.push(this.byKind.get(q.kind) ?? new Set());
    if (q.tag) sets.push(this.byTag.get(tkey(q.tag.scope, q.tag.key)) ?? new Set());
    if (q.region !== undefined) sets.push(this.byRegion.get(q.region) ?? new Set());
    if (q.settlement) sets.push(this.bySettlement.get(q.settlement) ?? new Set());
    const base = sets.length ? [...sets.sort((a, b) => a.size - b.size)[0]] : [...this.ents.keys()];
    return base
      .map((id) => this.ents.get(id)!)
      .filter(
        (e) =>
          (!q.kind || e.kind === q.kind) &&
          (!q.tag || e.tags.some((t) => t.scope === q.tag!.scope && t.key === q.tag!.key && (q.tag!.value === undefined || t.value === q.tag!.value))) &&
          (q.region === undefined || e.at.region === q.region) &&
          (!q.settlement || e.at.settlement === q.settlement),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  tag(id: EntityId, scope: TagScope, key: string): ScopedTag | undefined {
    return this.ents.get(id)?.tags.find((t) => t.scope === scope && t.key === key);
  }

  relations(q: RelQuery): Relation[] {
    let ids: Iterable<string>;
    if (q.id) ids = this.rels.has(q.id) ? [q.id] : [];
    else if (q.from || q.to) ids = this.relByEnd.get((q.from ?? q.to)!) ?? [];
    else if (q.type) ids = this.relByType.get(q.type) ?? [];
    else ids = this.rels.keys();
    const out: Relation[] = [];
    for (const id of ids) {
      const r = this.rels.get(id)!;
      if (q.type && r.type !== q.type) continue;
      if (q.historic === false && r.type.startsWith('former_')) continue;
      if (q.from && q.to) {
        if (!holds(r, q.from, q.to)) continue;
      } else if (q.from) {
        if (r.from !== q.from && !(r.symmetric && r.to === q.from)) continue;
      } else if (q.to) {
        if (r.to !== q.to && !(r.symmetric && r.from === q.to)) continue;
      }
      out.push(r);
    }
    return out.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1));
  }

  claims(q: { claimant?: EntityId; target?: EntityId } = {}): Claim[] {
    return [...this.cls.values()].filter((c) => (!q.claimant || c.claimant === q.claimant) && (!q.target || c.target === q.target));
  }

  events(q: { kind?: string; involving?: EntityId; since?: number } = {}): FactEvent[] {
    return this.evs.filter(
      (e) =>
        (!q.kind || e.kind === q.kind) &&
        (q.since === undefined || e.turn >= q.since) &&
        (!q.involving || e.by.includes(q.involving) || e.to.includes(q.involving) || !!e.witnesses?.includes(q.involving)),
    );
  }

  // ---- writes --------------------------------------------------------------------------------------------------------

  add(x: Omit<Entity, 'since' | 'tags' | 'attrs' | 'at'> & Partial<Pick<Entity, 'tags' | 'attrs' | 'at' | 'since'>>): Entity {
    if (this.ents.has(x.id)) throw new Error(`facts: entity ${x.id} already exists`);
    const e: Entity = { at: {}, attrs: {}, ...structuredClone(x), tags: [], since: x.since ?? this.turn };
    for (const t of x.tags ?? []) {
      const why = tagRefusal(e, t.scope, t.key, t.value);
      if (why) throw new Error(`facts: ${why}`);
      e.tags.push({ ...t, since: t.since ?? this.turn });
    }
    this.index(e);
    this.changed.add(e.id);
    return e;
  }

  remove(id: EntityId, cause?: string): void {
    const e = this.need(id);
    for (const r of this.relations({ from: id }).concat(this.relations({ to: id }))) this.dropRel(r);
    for (const c of this.claims()) if (c.claimant === id || c.target === id) this.cls.delete(c.id);
    this.ents.delete(id);
    del(this.byKind, e.kind, id);
    for (const t of e.tags) del(this.byTag, tkey(t.scope, t.key), id);
    if (e.at.region !== undefined) del(this.byRegion, e.at.region, id);
    if (e.at.settlement) del(this.bySettlement, e.at.settlement, id);
    this.changed.add(id);
    void cause;
  }

  setTag(id: EntityId, scope: TagScope, key: string, value: ScopedTag['value'], cause?: string): void {
    const e = this.need(id);
    const why = tagRefusal(e, scope, key, value);
    if (why) throw new Error(`facts: ${why}`);
    const t = e.tags.find((x) => x.scope === scope && x.key === key);
    if (t) {
      if (t.value === value) return;
      t.value = value;
      t.since = this.turn;
      t.cause = cause;
    } else {
      e.tags.push({ scope, key, value, since: this.turn, ...(cause ? { cause } : {}) });
      add(this.byTag, tkey(scope, key), id);
    }
    this.changed.add(id);
  }

  dropTag(id: EntityId, scope: TagScope, key: string): void {
    const e = this.need(id);
    const i = e.tags.findIndex((x) => x.scope === scope && x.key === key);
    if (i < 0) return;
    e.tags.splice(i, 1);
    del(this.byTag, tkey(scope, key), id);
    this.changed.add(id);
  }

  bump(id: EntityId, key: (typeof INTENSITIES)[number], delta: number, cause?: string): number {
    const e = this.need(id);
    const t = e.tags.find((x) => x.key === key && typeof x.value === 'number');
    const v = Math.max(0, Math.min(1, ((t?.value as number | undefined) ?? 0) + delta));
    this.setTag(id, t?.scope ?? 'condition', key, v, cause);
    return v;
  }

  relate(r: Omit<Relation, 'id' | 'since' | 'derived'> & { since?: number }): Relation {
    if (!(r.type in RELATION_TYPES)) throw new Error(`facts: no relation type ${r.type}`);
    this.need(r.from);
    this.need(r.to);
    if (r.strength !== undefined && !(r.strength >= 0 && r.strength <= 1)) throw new Error(`facts: ${r.type} strength ${r.strength} outside 0..1`);
    // (one record a pair and type: relating again updates it)
    const had = this.relations({ type: r.type, from: r.from, to: r.to }).find((x) => !x.agreement || x.agreement.id === r.agreement?.id);
    if (had) {
      Object.assign(had, structuredClone(r), { since: had.since });
      this.changed.add(r.from).add(r.to);
      return had;
    }
    const rel: Relation = { ...structuredClone(r), id: this.id('r'), since: r.since ?? this.turn };
    this.indexRel(rel);
    this.changed.add(r.from).add(r.to);
    return rel;
  }

  unrelate(q: RelQuery & { type: Relation['type'] }, cause?: string): Relation[] {
    const gone = this.relations(q);
    for (const r of gone) {
      this.dropRel(r);
      this.changed.add(r.from).add(r.to);
      const h = HISTORIC[r.type];
      if (h) this.relate({ type: h, from: r.from, to: r.to, symmetric: r.symmetric, ...(cause ? { cause } : {}) });
    }
    return gone;
  }

  claim(c: Omit<Claim, 'id' | 'since' | 'recognisedBy'> & { recognisedBy?: EntityId[] }): Claim {
    this.need(c.claimant);
    this.need(c.target);
    if (!(c.strength >= 0 && c.strength <= 1)) throw new Error(`facts: claim strength ${c.strength} outside 0..1`);
    const had = this.claims({ claimant: c.claimant, target: c.target }).find((x) => x.what === c.what);
    if (had) {
      Object.assign(had, structuredClone(c), { recognisedBy: [...new Set([...had.recognisedBy, ...(c.recognisedBy ?? [])])] });
      this.changed.add(c.claimant).add(c.target);
      return had;
    }
    const cl: Claim = { recognisedBy: [], ...structuredClone(c), id: this.id('c'), since: this.turn };
    this.cls.set(cl.id, cl);
    this.changed.add(c.claimant).add(c.target);
    return cl;
  }

  dropClaim(id: string): void {
    const c = this.cls.get(id);
    if (!c) throw new Error(`facts: no claim ${id}`);
    this.cls.delete(id);
    this.changed.add(c.claimant).add(c.target);
  }

  record(e: Omit<FactEvent, 'id' | 'turn' | 'run'> & { turn?: number; run?: number; id?: string }): FactEvent {
    const ev: FactEvent = { ...structuredClone(e), id: e.id ?? this.id('e'), turn: e.turn ?? this.turn, run: e.run ?? this.run };
    if (e.id && this.evs.some((x) => x.id === e.id)) throw new Error(`facts: event ${e.id} already recorded`);
    this.evs.push(ev);
    for (const p of [...ev.by, ...ev.to]) if (this.ents.has(p)) this.changed.add(p);
    return ev;
  }

  drainChanged(): Set<EntityId> {
    const c = this.changed;
    this.changed = new Set();
    return c;
  }

  snapshot(): FactSnapshot {
    return {
      version: 1,
      turn: this.turn,
      run: this.run,
      seq: this.seq,
      entities: structuredClone([...this.ents.values()].sort((a, b) => (a.id < b.id ? -1 : 1))),
      relations: structuredClone([...this.rels.values()].sort((a, b) => (a.id < b.id ? -1 : 1))),
      claims: structuredClone([...this.cls.values()]),
      events: structuredClone(this.evs),
    };
  }
}

/**
 * A fact layer for a save that has none (round 125): the factions, settlements and characters it already holds become
 * entities that refer to their records (nothing copied: names and places are read through the ref). Diplomacy's
 * records join with `importDiplomacy` (diplomacy-memory.ts).
 */
export function migrateFacts(s: WorldSnapshot): MemoryFacts {
  const f = new MemoryFacts();
  f.run = s.run;
  for (const x of s.factions) f.add({ id: x.id, kind: 'faction', name: x.name, ref: { faction: x.id } });
  for (const x of s.settlements) f.add({ id: x.id, kind: 'settlement', name: x.name, ref: { settlement: x.id }, at: { region: x.region } });
  for (const c of s.characters ?? []) if (!f.entity(c.id)) f.add({ id: c.id, kind: 'person', name: c.name, ref: { character: c.id } });
  f.drainChanged();
  return f;
}
