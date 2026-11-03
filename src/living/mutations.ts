// ---- living/mutations.ts ------------------------------------------------------------------------------------------
// (round 125, `facts`; BACKLOG LW-F5) The outcome helpers: each a near-instant, cheap mutation of authoritative state
// through its owner, plus an event in the history. The user (round 125): "Does the river falling or a structure going
// up need simulation? I think we already have steady flows computed so you can just lower the flow factor coming in
// and it will dry up. A building going up can just place the structure instead of simulating agents building them. We
// only need full simulation where the player is looking". So nothing here simulates: a river's inflow factor is set
// (the held steady rivers' discharge is Q × it, recomputed when the region is next realised), a structure is placed
// (Settlement.buildings; the region generator lays it out on arrival), stores and power are set. "Visible" means the
// next time the player looks: the streamed window realises the mutated state when it arrives.

import type { EntityId, ScopedTag } from '../api/contracts/facts';
import type { Settlement } from '../api/contracts/settlement';
import type { FactionId } from '../api/contracts/world';
import type { FactWorld } from './world';

const need = (w: FactWorld, id: EntityId): Settlement => {
  const s = w.settlementOf(id);
  if (!s) throw new Error(`mutation: ${id} is not in a settlement`);
  return s;
};

/** the region whose rivers an entity's water comes from: a settlement's, a river site's own region or its settlement's */
function riverRegion(w: FactWorld, id: EntityId): number {
  const e = w.facts.entity(id);
  if (e?.at.region !== undefined && e.kind !== 'settlement') return e.at.region;
  return need(w, id).region;
}

/** Set (or move by `delta`) the inflow factor of a region's rivers (0..2; 1 the atlas's own): a drought, a diversion. */
export function setRiverInflow(w: FactWorld, at: EntityId, to: { factor: number } | { delta: number }, cause: string, note: string): number {
  const region = riverRegion(w, at);
  const now = w.ws.region(region).wetness;
  const f = Math.max(0, Math.min(2, 'factor' in to ? to.factor : now + to.delta));
  const id = w.apply({ kind: 'river-inflow', regions: [region], magnitude: +f.toFixed(3), cause: { by: 'world', ref: cause } });
  w.facts.record({ kind: 'river-inflow', by: [], to: [at], where: { region }, about: { atlas: [id], opp: cause }, note });
  return f;
}

/** Place a structure in a settlement, directly (no agents building it), with its fact entity (its tags). */
export function placeStructure(
  w: FactWorld,
  at: EntityId,
  b: { id: string; name: string; use: string[]; tags?: Omit<ScopedTag, 'since'>[]; by?: EntityId },
  cause: string,
): EntityId {
  const s = need(w, at);
  const aid = w.apply({ kind: 'settlement-building', regions: [s.region], magnitude: 1, detail: { settlement: s.id, building: b.id, use: b.use, name: b.name }, cause: { by: 'world', ref: cause } });
  const eid = `building:${s.id}:${b.id}`;
  w.facts.add({ id: eid, kind: 'building', name: b.name, ref: { building: { settlement: s.id, id: b.id } }, at: w.placeAt(s.id), tags: (b.tags ?? []).map((t) => ({ ...t, since: w.turn })), cause });
  if (b.by) w.facts.relate({ type: 'owns', from: b.by, to: eid, cause });
  w.facts.record({ kind: 'built', by: b.by ? [b.by] : [], to: [eid, s.id], about: { atlas: [aid], opp: cause }, note: `${b.name} placed at ${s.name}` });
  return eid;
}

/** A settlement's store of a good moved (stock, and the rate a day). */
export function adjustStores(w: FactWorld, at: EntityId, good: string, stock: number, rate: number, cause: string, note?: string): void {
  const s = need(w, at);
  const aid = w.apply({ kind: 'settlement-stores', regions: [s.region], magnitude: stock, detail: { settlement: s.id, good, rate }, cause: { by: 'world', ref: cause } });
  if (note) w.facts.record({ kind: 'stores', by: [], to: [s.id], about: { atlas: [aid], opp: cause }, note });
}

/** A faction's power moved (−1..1, applied once). */
export function shiftPower(w: FactWorld, faction: FactionId, delta: number, cause: string): void {
  const s = w.ws.settlements[0];
  const region = w.locate(faction)?.region ?? s?.region ?? 0;
  w.apply({ kind: 'faction-power', regions: [region], magnitude: delta, detail: { faction }, cause: { by: 'world', ref: cause } });
}

/** A settlement's condition set. */
export function setCondition(w: FactWorld, at: EntityId, condition: Settlement['condition'], cause: string): void {
  const s = need(w, at);
  w.apply({ kind: 'settlement-condition', regions: [s.region], magnitude: 1, detail: { settlement: s.id, condition }, cause: { by: 'world', ref: cause } });
}

/** People leave one settlement for another (a share of each role); they arrive as refugees. */
export function migrate(w: FactWorld, from: EntityId, to: EntityId, share: number, cause: string, note: string): void {
  const a = need(w, from);
  const b = need(w, to);
  const aid = w.apply({ kind: 'migrate', regions: [a.region, b.region], magnitude: share, detail: { from: a.id, to: b.id }, cause: { by: 'world', ref: cause } });
  w.facts.record({ kind: 'migration', by: [a.id], to: [b.id], about: { atlas: [aid], opp: cause }, note });
}

/** Control of a thing changes hands: a settlement through its record (settlement-owner), anything else as the relation. */
export function setControl(w: FactWorld, holder: EntityId, target: EntityId, cause: string): void {
  const e = w.facts.entity(target);
  if (e?.ref && 'settlement' in e.ref) {
    const s = need(w, target);
    w.apply({ kind: 'settlement-owner', regions: [s.region], magnitude: 1, detail: { settlement: s.id, faction: holder }, cause: { by: 'world', ref: cause } });
    return;
  }
  w.facts.unrelate({ type: 'controls', to: target }, cause);
  w.facts.relate({ type: 'controls', from: holder, to: target, cause });
}
