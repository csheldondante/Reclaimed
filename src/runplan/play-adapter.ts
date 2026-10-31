// ---- runplan/play-adapter.ts ------------------------------------------------------------------------------------
// (round 117, runplan; RP6 — runplay round 119: on play's real contract) Play's controller profile (contracts/play.ts
// ControllerProfile, the one controller description) as the run manager's HeroCapabilities. Why an adapter and not the
// planner reading the profile directly: the planner reasons in barriers between atlas regions (a ravine, a cliff band,
// the sea), play reasons in crossings of ground (a gap of so many cells, a step, a slope, water so deep); this is the
// one place the two meet, and every number in it comes through play's crossCost, so they can't disagree.

import { crossCost, type ControllerProfile, type Crossing } from '../api/contracts/play';
import type { BarrierKind } from '../api/contracts/terrain';
import type { EncounterKind, HeroCapabilities } from '../api/contracts/run';

/**
 * Each of terrain's barriers as the ground it typically is, in play's terms (cells): terrain's atlas graph names a
 * border's barrier but doesn't measure it (its stage graphs do: Terrain.graph(rect) BorderMeasure), so the planner
 * uses the atlas's typical sizes — a cliff band 12 cells, a ravine 10 across, a river 3 deep, the sea deeper than
 * anything wades. A planned fun obstacle is built for its hero (a ravine with a ramp for a bike: `fun` true).
 */
export function barrierGround(b: BarrierKind, fun = false): Crossing {
  switch (b) {
    case 'cliff': return { step: 12 };
    case 'steep': return { slope: 1.2, step: 4 };
    case 'ridge': return { step: 8 };
    case 'ravine': return { gap: 10, ramp: fun };
    case 'river': return { water: 3 };
    case 'lake': return { water: 8 };
    case 'sea': return { water: 30 };
    case 'lava': return { gap: 8, ramp: fun };
    case 'vegetation': return { vegetation: 0.8 };
    case 'tar': return { water: 1, vegetation: 0.3 };
    case 'open': case 'storm': case 'hostile': case 'distance': return {};
  }
}

const BARRIERS: BarrierKind[] = ['cliff', 'steep', 'ridge', 'ravine', 'river', 'lake', 'sea', 'lava', 'vegetation', 'tar', 'storm', 'hostile', 'distance'];

/** a profile as the planner's capabilities (play's crossCost: 1 open ground, Infinity can't → 0 here) */
export function capsFromProfile(role: string, p: ControllerProfile): HeroCapabilities {
  const passes: HeroCapabilities['passes'] = {};
  const flies = p.fly.ceiling > 0;
  for (const b of BARRIERS) {
    let k = crossCost(p, barrierGround(b));
    // (the soft barriers aren't ground: a storm slows what doesn't fly, a host what doesn't break things, distance what's slow)
    if (b === 'storm') k = flies ? 1 : 1.6;
    if (b === 'hostile') k = 1 + Math.max(0, 0.6 - p.destruction);
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
  if (p.jump.gap > 0 && Number.isFinite(crossCost(p, barrierGround('ravine', true)))) fun.ravine = `a ramp to jump the gap (${p.jump.gap.toFixed(0)} cells at top speed)`;
  if (p.water.over) fun.river = 'skim the water';
  if (flies || p.climb.step === Infinity) fun.cliff = 'float up the face';
  if (p.destruction >= 0.5) fun.vegetation = 'a wood to tear through';
  if (p.destruction >= 0.5) fun.hostile = 'a host to scatter';
  if (e.delve > 0.2) fun.steep = 'a cave through the mountain';
  if (p.bridge > 0) fun.ravine ??= 'a bridge to build';
  return { role, speed: p.speed.cruise, passes, likes, funCrossings: fun };
}
