// ---- runplan/heroes.ts ------------------------------------------------------------------------------------------
// (round 117, runplan) What each hero's controller can do, as the run manager reasons about it — STAND-INS for the
// play track's controller contract (contracts/run.ts HeroCapabilities). Read off what the controllers do today
// (GameplayGM runtimes/hoverbike/src/units, Reclaimed hero/walker.ts; docs/design prior/heroes.md) and the user's
// words for each (round 117, part 2/3): "The lich is a floating wrecking ball power fantasy, the hoverbike we want
// races and tricks and mounted fights, the knight delving and quests etc." / "A fast bike need races and chases. A
// combat soldier needs fun fights. A force of nature needs spectacle and power fantasy."
// When play's contract lands, an adapter maps its controller parameters to HeroCapabilities and this table goes.
// Numbers: speed in world units a second (the walker 8 c/s, ×1.7 running; the bike's boost about 4× that).

import type { BarrierKind, HeroCapabilities } from '../api/contracts/run';
import { BARRIER_RANK } from './graph';

export const HEROES: Record<string, HeroCapabilities> = {
  // the hoverbike: fast, floats over water and lava for a moment, launches off crests; walls stop it
  bike: {
    role: 'bike',
    speed: 34,
    passes: { distance: 1, dunes: 1, river: 1, water: 1.6, tar: 1, thicket: 3, ice: 1.2, ravine: 1.5, storm: 1.5, hostiles: 1, lava: 2.5 },
    likes: { race: 1, chase: 0.9, fight: 0.5, spectacle: 0.4, explore: 0.3, rescue: 0.4 },
    funCrossings: { ravine: 'a ramp to jump the gap', river: 'skim the water at speed', dunes: 'crest the dunes for air' },
  },
  // the lich: floats over everything, immune to wind and storms, breaks what it touches
  lich: {
    role: 'lich',
    speed: 14,
    passes: { distance: 1.5, dunes: 1, river: 1, water: 1, tar: 1, thicket: 1, ice: 1, ravine: 1, cliff: 1.3, lava: 1, storm: 1, hostiles: 1, mountain: 2 },
    likes: { destruction: 1, spectacle: 1, horde: 0.8, fight: 0.5, talk: 0.2, rescue: 0.3 },
    funCrossings: { thicket: 'a wood to tear through', cliff: 'a wall to smash open', hostiles: 'a host to scatter' },
  },
  // the knight: on foot (or mounted), sword, bow, a hook to vault; delves and quests
  knight: {
    role: 'knight',
    speed: 11,
    passes: { distance: 2.5, dunes: 2, river: 1.5, tar: 2.5, thicket: 1.6, ice: 2, ravine: 1.8, cliff: 2.2, mountain: 3, storm: 1.8, hostiles: 1.2 },
    likes: { delve: 1, fight: 0.9, talk: 0.7, rescue: 0.8, explore: 0.6 },
    funCrossings: { mountain: 'a cave through the mountain', ravine: 'a bridge to build or a hook to swing', cliff: 'a ledge path up the face' },
  },
  // the walker: Reclaimed's own on-foot hero (hero/walker.ts, role 'wanderer')
  wanderer: {
    role: 'wanderer',
    speed: 9,
    passes: { distance: 3, dunes: 2.5, river: 2, tar: 3, thicket: 2, ice: 2.5, storm: 2, hostiles: 1.5 },
    likes: { talk: 1, explore: 1, fight: 0.5, delve: 0.5, rescue: 0.6 },
    funCrossings: { river: 'a ford or a ferry', ravine: 'a rope bridge' },
  },
  // the gorilla, the tank, the mech (GameplayGM experiments): fights and smashing
  gorilla: {
    role: 'gorilla',
    speed: 13,
    passes: { distance: 2, dunes: 2, river: 1.5, thicket: 1, cliff: 1.4, ravine: 2, hostiles: 1, storm: 1.5, ice: 2 },
    likes: { fight: 1, destruction: 0.8, chase: 0.6, horde: 0.6 },
    funCrossings: { cliff: 'ledges to climb', thicket: 'vines to swing through' },
  },
  tank: {
    role: 'tank',
    speed: 12,
    passes: { distance: 1.5, dunes: 1.6, river: 2.5, thicket: 1, tar: 2, hostiles: 1, storm: 1, ice: 1.5 },
    likes: { fight: 1, destruction: 1, horde: 0.8, spectacle: 0.5 },
    funCrossings: { thicket: 'a wood to flatten', hostiles: 'a line to break' },
  },
  mech: {
    role: 'mech',
    speed: 13,
    passes: { distance: 1.5, dunes: 1.4, river: 1.5, thicket: 1, tar: 1.5, cliff: 2, hostiles: 1, storm: 1, ice: 1.4 },
    likes: { fight: 1, horde: 0.9, destruction: 0.7, spectacle: 0.6 },
    funCrossings: { cliff: 'a jump-jet hop', hostiles: 'a gauntlet of turrets' },
  },
};

/** a hero's capabilities by role (an unknown role is the caller's bug: no silent fallback) */
export function heroCaps(role: string): HeroCapabilities {
  const h = HEROES[role];
  if (!h) throw new Error(`runplan: no capabilities for hero "${role}" (have ${Object.keys(HEROES).join(', ')})`);
  return h;
}

/**
 * How much a border costs this hero: a multiplier on the travel time (1 easy), or 0 when it can't pass. A road's
 * crossing makes any barrier easy (a bridge, a pass). A barrier the hero's table doesn't name: soft ones (ranked
 * under a ravine) cost 2, hard ones stop it — the controller didn't say it can.
 */
export function crossCost(h: HeroCapabilities, barrier: BarrierKind | null, crossing: string | null): number {
  if (!barrier) return 1;
  if (crossing && barrier !== 'water') return 1;
  if (crossing === 'bridge') return 1;
  const p = h.passes[barrier];
  if (p !== undefined) return p;
  return BARRIER_RANK[barrier] < BARRIER_RANK.ravine ? 2 : 0;
}
