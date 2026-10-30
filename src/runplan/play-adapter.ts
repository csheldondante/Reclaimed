// ---- runplan/play-adapter.ts ------------------------------------------------------------------------------------
// (round 117, runplan; RP6) The play track's controller profile (contracts/play.ts ControllerProfile, on branch `play`
// 6c3947f) as the run manager's HeroCapabilities — the adapter that retires the HEROES stand-in table when play lands
// on places. Why an adapter and not the planner reading the profile directly: the planner reasons in barriers between
// regions (a ravine, a mountain wall, the sea), play reasons in crossings of ground (a gap of so many cells, a step, a
// slope, water so deep); this is the one place the two meet, so either side can change its terms.
// Until play is on places the profile and crossCost come in as a structural type and a function (no import of
// contracts/play.ts, which isn't on this branch's base); at the merge, `ProfileLike` becomes `ControllerProfile` and
// `cost` play's `crossCost` (main consolidates).

import type { BarrierKind, EncounterKind, HeroCapabilities } from '../api/contracts/run';

/** the fields of play's ControllerProfile the adapter reads (same names and units: cells, cells/s) */
export interface ProfileLike {
  speed: { cruise: number; top: number };
  climb: { slope: number; step: number; rate: number };
  jump: { height: number; gap: number; ramp: boolean };
  fly: { ceiling: number };
  water: { wade: number; over: boolean };
  vegetation: { through: number; cuts: boolean };
  bridge: number;
  destruction: number;
  encounters: { race: number; chase: number; fight: number; spectacle: number; delve: number; tricks: number };
}

/** play's Crossing (all optional, absent easy) */
export interface CrossingLike {
  slope?: number;
  step?: number;
  gap?: number;
  ramp?: boolean;
  water?: number;
  vegetation?: number;
}

/**
 * Each barrier as the ground it is, in play's terms (cells). The sizes are the region generator's typical ones (a
 * cliff band 12 cells, a ravine 10 across, a river 3 deep, the sea deeper than anything wades); terrain's graph will
 * carry the real sizes per border (RP6), and then this table goes. A planned fun obstacle is built for its hero (a
 * ravine with a ramp for a bike: `fun` true).
 */
export function barrierGround(b: BarrierKind, fun = false): CrossingLike {
  switch (b) {
    case 'cliff': return { step: 12 };
    case 'mountain': return { slope: 1.2, step: 4 };
    case 'ravine': return { gap: 10, ramp: fun };
    case 'river': return { water: 3 };
    case 'water': return { water: 30 };
    case 'lava': return { gap: 8, ramp: fun };
    case 'thicket': return { vegetation: 0.8 };
    case 'tar': return { water: 1, vegetation: 0.3 };
    case 'ice': return { slope: 0.5 };
    case 'dunes': return { slope: 0.4, ramp: true };
    case 'storm': case 'hostiles': case 'distance': return {};
  }
}

const BARRIERS: BarrierKind[] = ['cliff', 'mountain', 'ravine', 'river', 'water', 'lava', 'thicket', 'tar', 'ice', 'dunes', 'storm', 'hostiles', 'distance'];

/** a profile as the planner's capabilities; `cost` is play's crossCost (1 open ground, Infinity can't) */
export function capsFromProfile(role: string, p: ProfileLike, cost: (p: ProfileLike, c: CrossingLike) => number): HeroCapabilities {
  const passes: HeroCapabilities['passes'] = {};
  const flies = p.fly.ceiling > 0;
  for (const b of BARRIERS) {
    let k = cost(p, barrierGround(b));
    // (the soft barriers aren't ground: a storm slows what doesn't fly, a host what doesn't break things, distance what's slow)
    if (b === 'storm') k = flies ? 1 : 1.6;
    if (b === 'hostiles') k = 1 + Math.max(0, 0.6 - p.destruction);
    if (b === 'distance') k = Math.max(1, 20 / Math.max(p.speed.cruise, 1));
    passes[b] = Number.isFinite(k) ? +k.toFixed(2) : 0;
  }
  const e = p.encounters;
  const likes: Partial<Record<EncounterKind, number>> = {
    race: Math.max(e.race, e.tricks * 0.9),
    chase: e.chase,
    fight: e.fight,
    horde: Math.max(e.fight, e.spectacle) * 0.8,
    spectacle: e.spectacle,
    destruction: Math.max(e.spectacle * 0.8, p.destruction),
    delve: e.delve,
    // (play's profile has no talk or exploring: a little of each for everyone, and rescue for fighters)
    talk: 0.2,
    explore: 0.3,
    rescue: 0.3 + 0.4 * e.fight,
  };
  // the crossings that are fun for it: where its abilities show (a ramp to jump, a face to float up, a wood to break)
  const fun: HeroCapabilities['funCrossings'] = {};
  if (p.jump.gap > 0 && Number.isFinite(cost(p, barrierGround('ravine', true)))) fun.ravine = `a ramp to jump the gap (${p.jump.gap.toFixed(0)} cells at top speed)`;
  if (p.water.over) fun.river = 'skim the water';
  if (flies || p.climb.step === Infinity) fun.cliff = 'float up the face';
  if (p.destruction >= 0.5) fun.thicket = 'a wood to tear through';
  if (p.destruction >= 0.5) fun.hostiles = 'a host to scatter';
  if (e.delve > 0.2) fun.mountain = 'a cave through the mountain';
  if (p.bridge > 0) fun.ravine ??= 'a bridge to build';
  return { role, speed: p.speed.cruise, passes, likes, funCrossings: fun };
}
