// ---- runsit/items.ts --------------------------------------------------------------------------------------------
// (round 120, `runsit`; BACKLOG IT1) A hero's loadout: an item a slot, what taking one gives up, the uses left, and what
// the worn items add up to. Pure (unit-tested in Node: test/unit/runsit.test.ts); the area play reads the totals and
// spends the uses (area.ts), the template filler and the GM pick from ITEMS (contracts/items.ts ItemDef).
// The user (round 120): "Having items along the run with interesting mechanical choices" — so a slot holds one thing,
// and the card says what a find would replace.

import type { ItemDef, ItemEffect, ItemSlot, Loadout } from '../api/contracts/items';

/** The items the template offers (a GM's situation brings its own, the same shapes). */
export const ITEMS: Record<string, ItemDef> = {
  'war-horn': { id: 'war-horn', name: 'War horn', slot: 'held', text: 'Blow it and four of the levy come running', effects: [{ kind: 'call-allies', count: 4, uses: 1 }] },
  'lure-bell': { id: 'lure-bell', name: 'Lure bell', slot: 'held', text: 'Ring it: the dead within 40 cells turn to it for 25 s (twice)', effects: [{ kind: 'lure', radius: 40, seconds: 25, uses: 2 }] },
  'ash-cloak': { id: 'ash-cloak', name: 'Ash-ward cloak', slot: 'cape', text: 'No fire takes within 30 cells of you', effects: [{ kind: 'fire-ward', radius: 30 }] },
  'fresh-mount': { id: 'fresh-mount', name: 'Fresh mount', slot: 'mount', text: 'The roads take a third less time; pursuers close slower', effects: [{ kind: 'pace', mult: 0.67 }] },
  'iron-cap': { id: 'iron-cap', name: 'Iron cap', slot: 'helmet', text: 'Blows take off a third less', effects: [{ kind: 'guard', mult: 0.67 }] },
  // (asymmetric: held, and it hangs down the back where a cloak would)
  'levy-banner': { id: 'levy-banner', name: 'Levy banner', slot: 'held', also: ['cape'], text: 'Raise it: six of the levy rally to you (fills the hand and the back)', effects: [{ kind: 'call-allies', count: 6, uses: 1 }] },
};

export function emptyLoadout(): Loadout {
  return { slots: {}, uses: {} };
}

/** every slot an item fills */
export function slotsOf(d: ItemDef): ItemSlot[] {
  return [d.slot, ...(d.also ?? [])];
}

/** What taking `d` would put down (the ids now in the slots it fills). */
export function displaced(l: Loadout, d: ItemDef): string[] {
  const out = new Set<string>();
  for (const s of slotsOf(d)) {
    const have = l.slots[s];
    if (have && have !== d.id) out.add(have);
  }
  return [...out];
}

/** Take `d`: what it displaces is put down (every slot that item filled is emptied). Returns the new loadout. */
export function equip(l: Loadout, d: ItemDef, defs: (id: string) => ItemDef): Loadout {
  const n: Loadout = { slots: { ...l.slots }, uses: { ...l.uses } };
  for (const gone of displaced(l, d)) {
    for (const s of slotsOf(defs(gone))) if (n.slots[s] === gone) delete n.slots[s];
    delete n.uses[gone];
  }
  for (const s of slotsOf(d)) n.slots[s] = d.id;
  const used = d.effects.find((e) => 'uses' in e) as Extract<ItemEffect, { uses: number }> | undefined;
  if (used) n.uses[d.id] = used.uses;
  return n;
}

/** the ids carried (each once, however many slots it fills) */
export function carried(l: Loadout): string[] {
  return [...new Set(Object.values(l.slots).filter((x): x is string => !!x))];
}

/** Use an item that's spent (a horn, a bell): its effect, or null when it's not carried or has no uses left. */
export function use(l: Loadout, id: string, defs: (id: string) => ItemDef): { loadout: Loadout; effect: ItemEffect } | null {
  if (!carried(l).includes(id)) return null;
  const left = l.uses[id] ?? 0;
  if (left <= 0) return null;
  const effect = defs(id).effects.find((e) => 'uses' in e);
  if (!effect) return null;
  return { loadout: { slots: { ...l.slots }, uses: { ...l.uses, [id]: left - 1 } }, effect };
}

/** What the worn items add up to (the passive effects; a slot's absent item adds nothing). */
export interface ItemTotals {
  /** travel time multiplier (1: none) */
  pace: number;
  /** damage taken multiplier (1: none) */
  guard: number;
  /** cells round the hero no fire takes (0: none) */
  ward: number;
  /** what can be used now: id, name, uses left */
  usable: { id: string; name: string; uses: number; kind: ItemEffect['kind'] }[];
}

export function totals(l: Loadout, defs: (id: string) => ItemDef): ItemTotals {
  const t: ItemTotals = { pace: 1, guard: 1, ward: 0, usable: [] };
  for (const id of carried(l)) {
    const d = defs(id);
    for (const e of d.effects) {
      if (e.kind === 'pace') t.pace *= e.mult;
      else if (e.kind === 'guard') t.guard *= e.mult;
      else if (e.kind === 'fire-ward') t.ward = Math.max(t.ward, e.radius);
      else t.usable.push({ id, name: d.name, uses: l.uses[id] ?? 0, kind: e.kind });
    }
  }
  return t;
}
