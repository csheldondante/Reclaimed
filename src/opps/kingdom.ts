// ---- opps/kingdom.ts ----------------------------------------------------------------------------------------------
// (round 124, `opportunities`; BACKLOG RN3-1) The card lab's kingdoms, after Dominion: each run the world picks a set
// of opportunity stacks, and every card of a stack is made at a real place with that place's specifics. The user:
// "Dominion each round has decks that you can purchase and permuting them changes what strategy is viable each time you
// play. Here the opportunities are like the cards you can purchase in Dominion but they are not all uniform within a
// stack and the world state is what generates them and permutes what is available for each run."
//
// A stack (data/cards/lab.json `stacks`) is a template: where it can be (a settlement's owner — the player's, an
// enemy's, no one's — its purpose, or a place with no settlement), its tiers, work, reward, expiry. Each place that
// fits makes one card of it: titled with the place, its goods scaled by the settlement's size, its world consequences
// aimed at that place ('@here') or the player's home ('@home') or the nearest enemy settlement ('@enemy'). The kingdom
// is the core stacks (always in) and `size` more drawn without replacement, weighted by how many places fit each, from
// the seed: the same world deals another kingdom with another seed. Stacks are unlocked by id (an unlock names a
// stack: all its cards can be dealt). A stack that needs an unlock no stack in the kingdom gives starts open.

import type { Goods } from '../api/contracts/opportunity';
import type { Settlement } from '../api/contracts/settlement';
import { hashStr, rng } from '../runplan/rng';
import type { CardDef, CardOutcome, LabDeck, LabPlace, WorldOp } from './deck';

export type Purpose = 'hold' | 'farming' | 'trading' | 'mining' | 'port';
export type Owner = 'player' | 'enemy' | 'neutral' | 'none';

/** a place of the library's world: a LabPlace with what the stacks read */
export type KPlace = LabPlace & { purpose?: Purpose };

/** a world op as a stack writes it: '@here', '@home', '@enemy' in place of ids */
export type StackWorldOp = WorldOp;

export interface StackDef extends Omit<CardDef, 'id' | 'place' | 'stack'> {
  id: string;
  /** where its cards are made */
  at: { owner?: Owner[]; purpose?: Purpose[]; settlement?: boolean };
  /** at most this many cards (the nearest to the player's home first) */
  max?: number;
  /** always in the kingdom (the forage, the climax) */
  core?: boolean;
  /** goods gains × the settlement's size (camp 0.5, hamlet 0.75, village 1, town 1.5, city 2) */
  scale?: boolean;
}

export interface LabLibrary {
  world: { places: KPlace[]; factions: LabDeck['world']['factions']; player: string };
  start: LabDeck['start'];
  stacks: StackDef[];
}

export interface Kingdom {
  seed: number;
  stacks: { id: string; title: string; cards: string[] }[];
}

const SIZE: Record<Settlement['size'], number> = { camp: 0.5, hamlet: 0.75, village: 1, town: 1.5, city: 2 };

function ownerOf(p: KPlace, player: string): Owner {
  if (!p.settlement) return 'none';
  if (p.settlement.faction === player) return 'player';
  if (p.settlement.faction === null) return 'neutral';
  return 'enemy';
}

/** the places a stack can be made at */
export function placesFor(s: StackDef, lib: LabLibrary): KPlace[] {
  const home = lib.world.places.find((p) => p.id === lib.start.at)!;
  const fit = lib.world.places.filter((p) => {
    if (s.at.settlement === true && !p.settlement) return false;
    if (s.at.settlement === false && p.settlement) return false;
    if (s.at.owner && !s.at.owner.includes(ownerOf(p, lib.world.player))) return false;
    if (s.at.purpose && (!p.purpose || !s.at.purpose.includes(p.purpose))) return false;
    return true;
  });
  fit.sort((a, b) => Math.hypot(a.at[0] - home.at[0], a.at[1] - home.at[1]) - Math.hypot(b.at[0] - home.at[0], b.at[1] - home.at[1]));
  return fit.slice(0, s.max ?? fit.length);
}

const fill = (t: string, p: KPlace) => t.replaceAll('{place}', p.name).replaceAll('{town}', p.settlement?.name ?? p.name);

function aim(op: StackWorldOp, here: KPlace, lib: LabLibrary): WorldOp | null {
  const home = lib.start.at;
  const enemy = lib.world.places
    .filter((p) => p.settlement && p.settlement.faction && p.settlement.faction !== lib.world.player && p.id !== here.id)
    .sort((a, b) => Math.hypot(a.at[0] - here.at[0], a.at[1] - here.at[1]) - Math.hypot(b.at[0] - here.at[0], b.at[1] - here.at[1]))[0]?.id;
  const id = (x: string) => (x === '@here' ? here.id : x === '@home' ? home : x === '@enemy' ? enemy : x);
  const settled = (x: string | undefined) => !!x && !!lib.world.places.find((p) => p.id === x)?.settlement;
  switch (op.kind) {
    case 'condition':
    case 'owner': {
      const s = id(op.settlement);
      return settled(s) ? { ...op, settlement: s! } : null;
    }
    case 'refugees': {
      const f = id(op.from);
      const t = id(op.to);
      return settled(f) && settled(t) && f !== t ? { ...op, from: f!, to: t! } : null;
    }
    case 'region': {
      const pl = id(op.place);
      return pl ? { ...op, place: pl } : null;
    }
    case 'power':
      return op;
  }
}

function make(o: CardOutcome, p: KPlace, lib: LabLibrary, scale: boolean): CardOutcome {
  const k = scale && p.settlement ? SIZE[p.settlement.size] : 1;
  const goods: Goods | undefined = o.goods ? Object.fromEntries(Object.entries(o.goods).map(([g, n]) => [g, n > 0 ? Math.max(1, Math.round(n * k)) : n])) : undefined;
  return {
    ...structuredClone(o),
    text: fill(o.text, p),
    ...(o.agents ? { agents: o.agents.map((a) => ({ ...structuredClone(a), name: fill(a.name, p) })) } : {}),
    ...(goods ? { goods } : {}),
    world: (o.world ?? []).map((w) => aim(w, p, lib)).filter((w): w is WorldOp => !!w),
  };
}

/** the cards a stack makes in this world */
export function stackCards(s: StackDef, lib: LabLibrary): CardDef[] {
  return placesFor(s, lib).map((p) => {
    const { at: _a, max: _m, core: _c, scale, id: _i, ...rest } = s;
    return {
      ...structuredClone(rest),
      id: `${s.id}@${p.id}`,
      stack: s.id,
      place: p.id,
      title: fill(s.title, p),
      ...(s.text ? { text: fill(s.text, p) } : {}),
      reward: make(s.reward, p, lib, !!scale),
      ...(s.onExpire ? { onExpire: make(s.onExpire, p, lib, false) } : {}),
    } as CardDef;
  });
}

/** this run's kingdom: the core stacks and `size` more, drawn from the seed and weighted by how many places fit */
export function generateKingdom(lib: LabLibrary, seed: number, size = 10): { deck: LabDeck; kingdom: Kingdom } {
  const r = rng(hashStr(`kingdom:${seed}`));
  const made = lib.stacks.map((s) => ({ s, cards: stackCards(s, lib) })).filter((x) => x.cards.length > 0);
  const core = made.filter((x) => x.s.core);
  const pool = made.filter((x) => !x.s.core);
  const chosen: typeof made = [];
  while (chosen.length < size && pool.length) {
    const total = pool.reduce((t, x) => t + Math.sqrt(x.cards.length), 0);
    let u = r() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      u -= Math.sqrt(pool[i].cards.length);
      if (u <= 0) break;
    }
    chosen.push(...pool.splice(i, 1));
  }
  const all = [...core, ...chosen];
  const ids = new Set(all.map((x) => x.s.id));
  // (a stack that needs unlocking by a stack not in this kingdom starts open; unlocks of stacks not in it are dropped)
  const unlocked = new Set(all.flatMap((x) => [...(x.s.reward.unlock ?? []), ...(x.s.reward.relics ?? []).flatMap((b) => (b.effect.kind === 'unlock' ? b.effect.cards : []))]).filter((u) => ids.has(u)));
  const cards = all.flatMap((x) =>
    x.cards.map((c) => ({
      ...c,
      start: c.start || c.climax ? c.start : !unlocked.has(x.s.id),
      reward: { ...c.reward, ...(c.reward.unlock ? { unlock: c.reward.unlock.filter((u) => ids.has(u)) } : {}) },
    })),
  );
  const deck: LabDeck = { world: { places: lib.world.places, factions: lib.world.factions, player: lib.world.player }, start: lib.start, cards };
  return { deck, kingdom: { seed, stacks: all.map((x) => ({ id: x.s.id, title: x.s.title, cards: x.cards.map((c) => c.id) })) } };
}
