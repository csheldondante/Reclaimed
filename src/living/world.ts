// ---- living/world.ts ----------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F4) The fact world: the fact layer (facts.ts) read together with the records other
// systems own — WorldState's settlements, regions and factions, and the player's holdings (opportunity.ts) — so a
// template asks one place. It owns nothing itself:
//   - quantities are read from their owner (a settlement's stores and people, a region's river inflow, a faction's power)
//   - derived relations are computed, never stored: a settlement's holder `controls` it; a character's faction
//   - every change goes to its owner: WorldState.apply for atlas-scale state (mutations.ts), the FactStore for tags,
//     relations, claims and events, the contract's commit/resolve for the holdings.
// Plus the boundary conversions the engine and the inspector need: a full snapshot (for dry runs and diffs) and the diff.

import type { EntityId, FactLocation, Relation, RelQuery } from '../api/contracts/facts';
import { MemoryDiplomacy } from '../api/contracts/diplomacy-memory';
import type { Holdings } from '../api/contracts/opportunity';
import type { Settlement } from '../api/contracts/settlement';
import type { AtlasEvent, WorldSnapshot } from '../api/contracts/world';
import { MemoryWorldState } from '../api/contracts/world-state';

/** days a turn (the user: "turns were on the order of days") */
export const DAYS_PER_TURN = 3;

/** everything a dry run needs to restore, and a diff compares */
export interface FullSnapshot {
  world: WorldSnapshot;
  holdings: Holdings;
  seq: number;
}

export class FactWorld {
  ws: MemoryWorldState;
  holdings: Holdings;
  diplomacy: MemoryDiplomacy;
  private seq = 0;

  constructor(ws: MemoryWorldState, holdings: Holdings) {
    this.ws = ws;
    this.holdings = holdings;
    this.diplomacy = new MemoryDiplomacy(ws.facts);
  }

  get facts() {
    return this.ws.facts;
  }

  get turn() {
    return this.facts.turn;
  }

  // ---- snapshots (dry runs, diffs, saves) ----------------------------------------------------------------------------

  full(): FullSnapshot {
    return { world: this.ws.snapshot(), holdings: structuredClone(this.holdings), seq: this.seq };
  }

  static from(s: FullSnapshot): FactWorld {
    const w = new FactWorld(MemoryWorldState.restore(structuredClone(s.world)), structuredClone(s.holdings));
    w.seq = s.seq;
    w.diplomacy.run = s.world.run;
    return w;
  }

  /** a copy to try things on */
  clone(): FactWorld {
    return FactWorld.from(this.full());
  }

  // ---- reads through the owners --------------------------------------------------------------------------------------

  name(id: EntityId): string {
    if (id === 'player') return 'you';
    const e = this.facts.entity(id);
    if (e?.ref && 'settlement' in e.ref) return this.settlement(e.ref.settlement)?.name ?? e.name;
    if (e?.ref && 'faction' in e.ref) return this.ws.faction(e.ref.faction)?.name ?? e.name;
    if (e?.ref && 'character' in e.ref) return this.ws.character(e.ref.character)?.name ?? e.name;
    return e?.name ?? id;
  }

  settlement(id: EntityId): Settlement | undefined {
    return this.ws.settlements.find((s) => s.id === id);
  }

  /** the settlement an entity is in or is */
  settlementOf(id: EntityId): Settlement | undefined {
    const e = this.facts.entity(id);
    if (!e) return undefined;
    if (e.ref && 'settlement' in e.ref) return this.settlement(e.ref.settlement);
    if (e.ref && 'people' in e.ref) return this.settlement(e.ref.people.settlement);
    if (e.ref && 'building' in e.ref) return this.settlement(e.ref.building.settlement);
    const home = this.facts.relations({ type: 'resident_at', from: id })[0]?.to;
    if (home) return this.settlement(home);
    if (e.at.settlement) return this.settlement(e.at.settlement);
    if (e.at.site) return this.settlementOf(e.at.site);
    return undefined;
  }

  /** where an entity is, resolved to a region and a point (for a card's location) */
  locate(id: EntityId): { region: number; at: [number, number]; settlement?: string } | undefined {
    const s = this.settlementOf(id);
    const e = this.facts.entity(id);
    if (s) return { region: s.region, at: e?.at.at ?? s.at, settlement: s.id };
    const c = e?.ref && 'character' in e.ref ? this.ws.character(e.ref.character) : undefined;
    if (c?.region !== undefined && c.region !== null) return { region: c.region, at: [0, 0] };
    if (e?.at.region !== undefined) return { region: e.at.region, at: e.at.at ?? [0, 0] };
    return undefined;
  }

  /** a quantity, from its owner: a settlement's stock of a good (`grain`, `grain_rate`), its `people` or a role's count
   *  (`refugee`), the `inflow` of its region's rivers; a faction's `power`; a cohort's `population` */
  qty(id: EntityId, what: string): number | undefined {
    const e = this.facts.entity(id);
    if (!e) return undefined;
    if (e.ref && 'faction' in e.ref) {
      const f = this.ws.faction(e.ref.faction);
      if (what === 'power') return f ? (f.power ?? 0.5) : undefined;
      return undefined;
    }
    if (e.ref && 'people' in e.ref) {
      const { settlement, role } = e.ref.people;
      if (what === 'population') return this.settlement(settlement)?.people.filter((p) => p.role === role).reduce((n, p) => n + p.count, 0);
      return undefined;
    }
    const s = e.kind === 'settlement' ? this.settlementOf(id) : undefined;
    if (s) {
      if (what === 'people') return s.people.reduce((n, p) => n + p.count, 0);
      if (what === 'inflow') return this.ws.region(s.region).wetness;
      if (what.endsWith('_rate')) return s.stores[what.slice(0, -5)]?.rate ?? 0;
      if (s.stores[what]) return s.stores[what].stock;
      const role = s.people.filter((p) => p.role === what);
      if (role.length) return role.reduce((n, p) => n + p.count, 0);
      return 0;
    }
    if (what === 'inflow' && e.at.region !== undefined) return this.ws.region(e.at.region).wetness;
    return undefined;
  }

  /** who controls a thing: a settlement's holder (its record), else the `controls` relation */
  controllerOf(id: EntityId): EntityId | undefined {
    const e = this.facts.entity(id);
    if (e?.ref && 'settlement' in e.ref) return this.settlement(e.ref.settlement)?.faction ?? undefined;
    return this.facts.relations({ type: 'controls', to: id })[0]?.from;
  }

  /** the relations, stored and derived (a settlement's holder controls it; a character is a member of its faction) */
  relations(q: RelQuery): Relation[] {
    const out = this.facts.relations(q);
    if (!q.type || q.type === 'controls')
      for (const s of this.ws.settlements) {
        if (!s.faction || !this.facts.entity(s.id) || !this.facts.entity(s.faction)) continue;
        if ((q.from && q.from !== s.faction) || (q.to && q.to !== s.id)) continue;
        out.push({ id: `d:controls:${s.id}`, type: 'controls', from: s.faction, to: s.id, since: 0, derived: true });
      }
    if (!q.type || q.type === 'member_of')
      for (const c of this.ws.characters()) {
        if (!c.faction || !this.facts.entity(c.id) || !this.facts.entity(c.faction)) continue;
        if ((q.from && q.from !== c.id) || (q.to && q.to !== c.faction)) continue;
        if (out.some((r) => r.type === 'member_of' && r.from === c.id && r.to === c.faction)) continue;
        out.push({ id: `d:member:${c.id}`, type: 'member_of', from: c.id, to: c.faction, since: 0, derived: true });
      }
    return out;
  }

  // ---- writes to the owners ------------------------------------------------------------------------------------------

  /** an atlas-scale change, through WorldState.apply (its one owner); returns the event's id */
  apply(e: Omit<AtlasEvent, 'id' | 'run'>): string {
    const id = `a${this.turn}-${++this.seq}`;
    this.ws.apply({ ...e, id, run: this.ws.run } as AtlasEvent);
    return id;
  }

  /** a fact location for an entity placed at a settlement */
  placeAt(settlement: EntityId): FactLocation {
    const s = this.settlement(settlement);
    return s ? { region: s.region, settlement: s.id } : { settlement };
  }
}

// ---- the diff (what a card did, or would do) ---------------------------------------------------------------------------

const fmt = (v: unknown) => (typeof v === 'number' ? String(+v.toFixed(2)) : String(v));

/** the changes from one full snapshot to another, as lines (+ added, − removed, ~ changed), the fact layer's first */
export function diffWorld(a: FullSnapshot, b: FullSnapshot, name: (id: string) => string): string[] {
  const out: string[] = [];
  const fa = a.world.facts!;
  const fb = b.world.facts!;
  const ea = new Map(fa.entities.map((e) => [e.id, e]));
  const eb = new Map(fb.entities.map((e) => [e.id, e]));
  for (const [id, e] of eb) if (!ea.has(id)) out.push(`+ ${e.kind} ${e.name}${e.tags.length ? ` [${e.tags.map((t) => `${t.scope}.${t.key}=${fmt(t.value)}`).join(', ')}]` : ''}`);
  for (const [id, e] of ea) if (!eb.has(id)) out.push(`− ${e.kind} ${e.name}`);
  for (const [id, e] of eb) {
    const o = ea.get(id);
    if (!o) continue;
    for (const t of e.tags) {
      const p = o.tags.find((x) => x.scope === t.scope && x.key === t.key);
      if (!p) out.push(`+ ${name(id)}: ${t.scope}.${t.key} = ${fmt(t.value)}`);
      else if (p.value !== t.value) out.push(`~ ${name(id)}: ${t.scope}.${t.key} ${fmt(p.value)} → ${fmt(t.value)}`);
    }
    for (const p of o.tags) if (!e.tags.some((x) => x.scope === p.scope && x.key === p.key)) out.push(`− ${name(id)}: ${p.scope}.${p.key}`);
  }
  const rk = (r: Relation) => `${r.from} ${r.type} ${r.to}${r.agreement ? ` (${r.agreement.id})` : ''}`;
  const ra = new Map(fa.relations.map((r) => [rk(r), r]));
  const rb = new Map(fb.relations.map((r) => [rk(r), r]));
  const rl = (r: Relation) => `${name(r.from)} ${r.type}${r.symmetric ? ' ⇄' : ''} ${name(r.to)}${r.strength !== undefined ? ` (${fmt(r.strength)})` : ''}`;
  for (const [k, r] of rb) {
    const o = ra.get(k);
    if (!o) out.push(`+ relation: ${rl(r)}`);
    else if (o.strength !== r.strength) out.push(`~ relation: ${name(r.from)} ${r.type} ${name(r.to)} ${fmt(o.strength ?? '—')} → ${fmt(r.strength ?? '—')}`);
  }
  for (const [k, r] of ra) if (!rb.has(k)) out.push(`− relation: ${rl(r)}`);
  const ca = new Map(fa.claims.map((c) => [c.id, c]));
  for (const c of fb.claims) {
    const o = ca.get(c.id);
    const line = `${name(c.claimant)} claims ${name(c.target)}${c.what ? ` (${c.what})` : ''}, ${c.basis}, ${fmt(c.strength)}`;
    if (!o) out.push(`+ claim: ${line}${c.recognisedBy.length ? `, recognised by ${c.recognisedBy.map(name).join(', ')}` : ''}`);
    else if (o.recognisedBy.length !== c.recognisedBy.length) out.push(`~ claim: ${line} now recognised by ${c.recognisedBy.map(name).join(', ')}`);
  }
  for (const c of fa.claims) if (!fb.claims.some((x) => x.id === c.id)) out.push(`− claim: ${name(c.claimant)} on ${name(c.target)}`);
  const known = new Set(fa.events.map((e) => e.id));
  for (const e of fb.events) if (!known.has(e.id)) out.push(`+ event ${e.kind}: ${e.note}`);
  // (the owners' records)
  for (const r of b.world.regions) {
    const o = a.world.regions.find((x) => x.id === r.id);
    if (o && o.state.wetness !== r.state.wetness) out.push(`~ ${r.name}: rivers' inflow ${fmt(o.state.wetness)} → ${fmt(r.state.wetness)}`);
  }
  for (const s of b.world.settlements) {
    const o = a.world.settlements.find((x) => x.id === s.id);
    if (!o) continue;
    if (o.faction !== s.faction) out.push(`~ ${s.name}: held by ${name(o.faction ?? '—')} → ${name(s.faction ?? '—')}`);
    if (o.condition !== s.condition) out.push(`~ ${s.name}: ${o.condition} → ${s.condition}`);
    for (const [g, st] of Object.entries(s.stores)) {
      const p = o.stores[g];
      if (!p || p.stock !== st.stock) out.push(`~ ${s.name}: ${g} ${fmt(p?.stock ?? 0)} → ${fmt(st.stock)}`);
      if (!p || p.rate !== st.rate) out.push(`~ ${s.name}: ${g} a day ${fmt(p?.rate ?? 0)} → ${fmt(st.rate)}`);
    }
    for (const x of s.buildings) if (!o.buildings.some((y) => y.id === x.id)) out.push(`+ ${s.name}: building ${x.id} (${x.use.join(', ')}) placed`);
    const pa = new Map(o.people.map((p) => [p.role, p.count]));
    for (const p of s.people) if (pa.get(p.role) !== p.count) out.push(`~ ${s.name}: ${p.role} ${pa.get(p.role) ?? 0} → ${p.count}`);
  }
  for (const f of b.world.factions) {
    const o = a.world.factions.find((x) => x.id === f.id);
    if (o && (o.power ?? 0.5) !== (f.power ?? 0.5)) out.push(`~ ${f.name}: power ${fmt(o.power ?? 0.5)} → ${fmt(f.power ?? 0.5)}`);
  }
  for (const [g, n] of Object.entries(b.holdings.goods)) if ((a.holdings.goods[g] ?? 0) !== n) out.push(`~ your ${g}: ${a.holdings.goods[g] ?? 0} → ${n}`);
  for (const ag of b.holdings.agents) {
    const o = a.holdings.agents.find((x) => x.id === ag.id);
    if (!o) out.push(`+ your ${ag.kind}: ${ag.name}`);
    else if (o.count !== ag.count) out.push(`~ ${ag.name}: ${o.count} → ${ag.count}`);
  }
  for (const ag of a.holdings.agents) if (!b.holdings.agents.some((x) => x.id === ag.id)) out.push(`− your ${ag.kind}: ${ag.name}`);
  return out;
}
