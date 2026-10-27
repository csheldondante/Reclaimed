// The recipe model's reference implementation (round 85): matching tags, deriving capabilities, checking what a
// people can make. Plain functions over recipe.ts's data, so units, items, vehicles and buildings share them;
// a faster or richer one replaces the insides, not the API.

import type { Capabilities, CapabilityRule, CivProfile, Instance, InstanceId, Kind, KindId, Mastery, Recipe, Slot, Tag, TagQuery } from './recipe';

/** The data a composition is read against. */
export interface Catalogue {
  kinds: Map<KindId, Kind>;
  things: Map<InstanceId, Instance>;
  rules: CapabilityRule[];
}

export function matches(q: TagQuery, tags: Iterable<Tag>): boolean {
  const s = tags instanceof Set ? (tags as Set<Tag>) : new Set(tags);
  if (q.all && !q.all.every((t) => s.has(t))) return false;
  if (q.any && q.any.length && !q.any.some((t) => s.has(t))) return false;
  if (q.none && q.none.some((t) => s.has(t))) return false;
  return true;
}

function kindOf(cat: Catalogue, id: KindId): Kind {
  const k = cat.kinds.get(id);
  if (!k) throw new Error(`no kind ${id}`);
  return k;
}

function thingOf(cat: Catalogue, id: InstanceId): Instance {
  const t = cat.things.get(id);
  if (!t) throw new Error(`no thing ${id}`);
  return t;
}

/** A thing's own tags: its kind's, its material's tags as `material:…`, and what it gained. */
export function ownTags(cat: Catalogue, t: Instance): Set<Tag> {
  const k = kindOf(cat, t.kind);
  const s = new Set<Tag>([...k.tags, ...(t.gained ?? [])]);
  const m = t.material ?? k.material;
  if (m) s.add(`material:${m}`);
  if (t.condition <= 0) s.add('broken');
  return s;
}

/** Derive what a thing can do: its parts' capabilities first, then the rules over the whole composition. */
export function derive(cat: Catalogue, id: InstanceId, seen = new Set<InstanceId>()): Capabilities {
  if (seen.has(id)) throw new Error(`thing ${id} contains itself`);
  seen.add(id);
  const t = thingOf(cat, id);
  const k = kindOf(cat, t.kind);
  const parts = t.parts.map((p) => ({ slot: p.slot, caps: derive(cat, p.thing, seen) }));
  // the composition's tags: its own, and each part's as `slot:tag` (a knight's `mount:powered`)
  const tags = ownTags(cat, t);
  for (const p of parts) {
    tags.add(`has:${p.slot}`);
    for (const tag of p.caps.tags) tags.add(`${p.slot}:${tag}`);
  }
  const stats: Record<string, number> = { ...(k.base ?? {}) };
  const abilities = new Set<string>();
  const unmet: string[] = [];
  const gained = new Set<Tag>();
  const mul: Record<string, number> = {};
  for (const r of cat.rules) {
    if (!matches(r.when, tags)) continue;
    for (const [s, v] of Object.entries(r.add ?? {})) stats[s] = (stats[s] ?? 0) + v;
    for (const [s, v] of Object.entries(r.mul ?? {})) mul[s] = (mul[s] ?? 1) * v;
    for (const f of r.from ?? []) {
      const p = parts.find((q) => q.slot === f.slot);
      if (p && p.caps.stats[f.stat] !== undefined) stats[f.as ?? f.stat] = p.caps.stats[f.stat];
    }
    for (const a of r.abilities ?? []) abilities.add(a);
    for (const g of r.tags ?? []) gained.add(g);
    if (r.unmet) unmet.push(r.unmet);
  }
  for (const [s, v] of Object.entries(mul)) stats[s] = (stats[s] ?? 0) * v;
  // a worn thing does less (condition scales what it adds; broken does nothing)
  for (const s of Object.keys(stats)) stats[s] *= t.condition <= 0 ? 0 : 0.5 + 0.5 * t.condition;
  for (const p of parts) for (const u of p.caps.unmet) unmet.push(`${p.slot}: ${u}`);
  seen.delete(id);
  return { tags: [...ownTags(cat, t), ...gained], stats, abilities: [...abilities], unmet };
}

const RANK: Record<Mastery, number> = { uses: 0, repairs: 1, makes: 2, understands: 3 };

/** How well a people knows a recipe (undefined: not at all). */
export function mastery(civ: CivProfile, r: Recipe): Mastery | undefined {
  return civ.knowledge[r.knowledge ?? r.id];
}

export function knows(civ: CivProfile, r: Recipe, need: Mastery): boolean {
  const m = mastery(civ, r);
  return m !== undefined && RANK[m] >= RANK[need];
}

/** Which things can fill a slot (count of them), from those at hand. */
export function fill(cat: Catalogue, slot: Slot, at: InstanceId[], taken: Set<InstanceId>): InstanceId[] | null {
  const n = slot.count ?? 1;
  const got: InstanceId[] = [];
  for (const id of at) {
    if (got.length === n) break;
    if (taken.has(id)) continue;
    if (matches(slot.accepts, derive(cat, id).tags)) got.push(id);
  }
  if (got.length < n && !slot.optional) return null;
  for (const id of got) taken.add(id);
  return got;
}

/**
 * Can this people carry out this recipe with what's at hand, and with what? Returns the slots' fillings, or why
 * not. Making (craft, assemble a new kind) needs `makes`; adapting needs `understands` unless they know the
 * recipe itself; training and salvage need `repairs` (they take a thing apart or teach what's known).
 */
export function plan(
  cat: Catalogue,
  civ: CivProfile,
  r: Recipe,
  at: InstanceId[],
  facilities: Tag[],
): { ok: true; fill: Record<string, InstanceId[]> } | { ok: false; why: string } {
  const need: Mastery = r.how === 'craft' || r.how === 'assemble' ? 'makes' : r.how === 'adapt' ? 'makes' : 'repairs';
  if (!knows(civ, r, need)) return { ok: false, why: `doesn't know how (${r.knowledge ?? r.id}: needs ${need})` };
  for (const k of r.needs?.knowledge ?? []) if (!civ.knowledge[k]) return { ok: false, why: `doesn't know ${k}` };
  for (const f of r.needs?.facilities ?? []) if (!matches(f, facilities)) return { ok: false, why: `no facility ${JSON.stringify(f)}` };
  const taken = new Set<InstanceId>();
  const out: Record<string, InstanceId[]> = {};
  for (const s of r.slots) {
    const got = fill(cat, s, at, taken);
    if (!got) return { ok: false, why: `nothing for ${s.id}` };
    out[s.id] = got;
  }
  return { ok: true, fill: out };
}
