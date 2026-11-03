// ---- living/seed.ts -----------------------------------------------------------------------------------------------
// (merge124) The fact layer seeded from the atlas world, not only the Briar Hollow test world. The user (DECISIONS,
// round 125): "Please proceed with getting it ready to merge into our run structure for now"; (earlier) "grow our focus
// out from a single locus and cast of characters and places we establish to the world at large".
//
// A run builds (or, from a save, loads) its fact layer from the WorldSnapshot: WorldState.restore already makes an
// entity of each faction, settlement and character (facts-store.ts migrateFacts) and diplomacy's agreements live in it.
// What this adds, once a world, and never over what a save already holds:
//   - the factions' standing toward each other (Faction.relations, −1..1) as relations: rival_of below −0.4, friend_of
//     above 0.4 (war and alliance are explicit facts, never read off a score: facts.ts);
//   - the locus (the run's starting settlement): its people as cohorts (a role each, Settlement.people) resident there;
//   - a cast of named people at the locus when the save has none there: 5-8 real characters (CharacterRecords the world
//     remembers, fact entities with their membership and home) — the people who present the run's cards first.
// Everything rides in WorldSnapshot.facts and .characters: the next run meets the same people.

import type { EntityId } from '../api/contracts/facts';
import { hashStr, rng } from '../runplan/rng';
import { makePresenter, membersOf } from './people';
import type { FactWorld } from './world';

/** the roles a cast is drawn from (the locus's own voice first) */
const ROLES = ['reeve', 'captain', 'elder', 'herbalist', 'smith', 'trader', 'scout', 'priest'];

/** the factions' standing as relations, once a world (an event marks it done) */
export function seedStanding(w: FactWorld): void {
  const f = w.facts;
  if (f.events({ kind: 'seeded-standing' }).length) return;
  for (const a of w.ws.snapshot().factions) {
    if (!f.entity(a.id)) continue;
    for (const [b, v] of Object.entries(a.relations ?? {})) {
      if (v === undefined || !f.entity(b) || b === a.id) continue;
      if (v <= -0.4) f.relate({ type: 'rival_of', from: a.id, to: b, strength: +Math.min(1, -v).toFixed(2), cause: 'atlas' });
      else if (v >= 0.4) f.relate({ type: 'friend_of', from: a.id, to: b, strength: +Math.min(1, v).toFixed(2), cause: 'atlas' });
    }
  }
  f.record({ kind: 'seeded-standing', by: [], to: [], note: "the factions' standing toward each other, from the atlas" });
}

/** a settlement's people as cohorts (a role each), resident there; their ids */
export function seedCohorts(w: FactWorld, settlement: EntityId): EntityId[] {
  const s = w.settlement(settlement);
  if (!s) throw new Error(`seed: no settlement ${settlement}`);
  const f = w.facts;
  if (!f.entity(s.id)) f.add({ id: s.id, kind: 'settlement', name: s.name, ref: { settlement: s.id }, at: { region: s.region } });
  const out: EntityId[] = [];
  for (const p of s.people) {
    if (p.hostile || p.count <= 0) continue;
    const id = `cohort:${s.id}:${p.role}`;
    if (!f.entity(id)) {
      f.add({ id, kind: 'cohort', name: `the ${p.role}s of ${s.name}`, ref: { people: { settlement: s.id, role: p.role } }, at: { region: s.region, settlement: s.id }, cause: 'atlas' });
      f.relate({ type: 'resident_at', from: id, to: s.id, cause: 'atlas' });
    }
    out.push(id);
  }
  return out;
}

/** who speaks for a place: its holder (when it has one), else its largest cohort, else the place itself */
export function voiceOf(w: FactWorld, settlement: EntityId): EntityId {
  const s = w.settlement(settlement);
  if (s?.faction && w.facts.entity(s.faction)) return s.faction;
  const big = [...(s?.people ?? [])].filter((p) => !p.hostile && p.count > 0).sort((a, b) => b.count - a.count)[0];
  const id = big ? `cohort:${settlement}:${big.role}` : undefined;
  return id && w.facts.entity(id) ? id : settlement;
}

/** the people living at a settlement (the cast), alive */
export function castAt(w: FactWorld, settlement: EntityId): EntityId[] {
  return w.facts
    .relations({ type: 'resident_at', to: settlement })
    .map((r) => r.from)
    .filter((id) => w.facts.entity(id)?.kind === 'person' && w.ws.character(id)?.alive !== false)
    .sort();
}

/**
 * Seed a run's locus: the standing, the locus's cohorts, and — when the save has nobody living there — a cast of 5-8
 * named people (deterministic from the seed): the voice's (the holder's, else the largest cohort's) first, the cohorts'
 * after. Returns the cast and the voice.
 */
export function seedLocus(w: FactWorld, locus: EntityId, seed: number): { cast: EntityId[]; voice: EntityId; made: number } {
  seedStanding(w);
  const cohorts = seedCohorts(w, locus);
  const voice = voiceOf(w, locus);
  let cast = castAt(w, locus);
  let made = 0;
  if (!cast.length) {
    const r = rng(hashStr(`cast:${seed}:${locus}`));
    const n = 5 + Math.floor(r() * 4);
    const roles = [...ROLES].sort(() => r() - 0.5).slice(0, n);
    const groups = [voice, ...cohorts.filter((c) => c !== voice)];
    roles.forEach((role, i) => {
      // (half the cast speaks for the voice, the rest for the cohorts in turn)
      const g = i < Math.ceil(n / 2) || groups.length === 1 ? groups[0] : groups[1 + ((i - Math.ceil(n / 2)) % (groups.length - 1))];
      makePresenter(w, g, role, `cast:${locus}`, { home: locus, met: false });
      made++;
    });
    cast = castAt(w, locus);
  }
  // (the voice must have someone to present its cards: membership is derived from the records for a faction)
  if (!membersOf(w, voice).length && w.facts.entity(voice)?.kind !== 'settlement') makePresenter(w, voice, 'reeve', `cast:${locus}`, { home: locus, met: false });
  return { cast, voice, made };
}
