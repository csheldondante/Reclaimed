// The engine's outward API (docs/WORLD_API.md; DECISIONS round 52). Reclaimed
// is the engine; the world is the game's: a game hands in a world definition
// (its map, places, climate…) and gets a sim of it, as modules it builds its
// controls and abilities on. Each module installs on its own and is absent
// unless asked for; queries answer from a CPU mirror in world coordinates
// with formats decoded here; commands queue inside (no caps a game sees);
// buffers and Globals stay private, so the engine can change them freely.
// Reclaimed's own game (Nature, the score, the story rules, powers, levels)
// is one client of this, not part of it.
//
//   const sim = createSim(host, { map, places: { plan }, climate: { temp: 4, lapse: 0.1 } });
//   sim.terrain?.heightAt(x, y); sim.wind?.wake('tank', { at, vel }); sim.fx?.burst('dust', x, y, z)
//   // or over a WorldCore a scene already made (the level): attachSim(core)

import type { Host } from '../scenes/world-core';
import { WorldCore } from '../scenes/world-core';
import type { Plan } from '../world/places';
import type { MapData } from '../world/mapgen';
import { Fire } from './fire';
import { Fx } from './fx';
import { Mirror } from './mirror';
import { Terrain } from './terrain';
import { Water } from './water';
import { Wind } from './wind';

export interface SimModules {
  terrain?: boolean;
  water?: boolean;
  fire?: boolean;
  wind?: boolean;
  fx?: boolean;
  /** ms between mirror reads (default 250); 0: never on a timer (call refresh()) */
  refreshMs?: number;
}

const ALL: SimModules = { terrain: true, water: true, fire: true, wind: true, fx: true };

/**
 * A world, as data (docs/WORLD_API.md "Content"): what the game supplies;
 * the engine's defaults fill what it leaves out.
 */
export interface WorldDef {
  /** the terrain: a column grid with its layers, water, plants (world/mapgen.ts MapData; generation recipes later, W1) */
  map: MapData;
  /** regions and rooms: a plan (world/places.ts) and its seed */
  places?: { plan: Plan; seed?: number };
  /** air temperature at height 0 (°C) and how much colder per cell up; default 15, 0 */
  climate?: { temp: number; lapse: number };
  /** 0..1 through the year from midsummer (default 0), and seconds a year takes (0: stays put) */
  season?: number;
  yearLength?: number;
  /** particle capacity (default the host's quality tier) */
  particles?: number;
  /** draw with the field mesh (default false) */
  fieldMesh?: boolean;
  /** modules to install (default all of them) */
  modules?: SimModules;
}

export interface Sim {
  readonly core: WorldCore;
  readonly terrain?: Terrain;
  readonly water?: Water;
  readonly fire?: Fire;
  readonly wind?: Wind;
  readonly fx?: Fx;
  /** Read every module's mirror now (resolves when it's in). */
  refresh(): Promise<void>;
  /** performance.now() of the last mirror read (0: never). */
  readonly readAt: number;
  /** Stop the mirror's timer (attachSim), or that and the world too (createSim). */
  dispose(): void;
}

/** A sim of the world `def` describes. */
export function createSim(host: Host, def: WorldDef): Sim {
  const core = new WorldCore(host, def.map, def.particles ?? host.quality.particles, undefined, def.fieldMesh ?? false);
  if (def.climate) core.globals.climate = { ...def.climate };
  if (def.season !== undefined) core.globals.season = def.season;
  if (def.yearLength !== undefined) core.yearLength = def.yearLength;
  if (def.places) core.places.load(def.places.plan, def.places.seed ?? 1);
  const sim = attachSim(core, def.modules ?? ALL);
  const stop = sim.dispose;
  // (this sim made the world: it goes with it)
  return Object.assign(sim, { dispose: () => (stop(), core.destroy()) });
}

/** The modules over a WorldCore a scene already runs (the level). */
export function attachSim(core: WorldCore, mods: SimModules = ALL): Sim {
  const mirror = new Mirror(core.host.gpu.device);
  const sim = {
    core,
    terrain: mods.terrain ? new Terrain(core, mirror) : undefined,
    water: mods.water ? new Water(core, mirror) : undefined,
    fire: mods.fire ? new Fire(core, mirror) : undefined,
    wind: mods.wind ? new Wind(core, mirror) : undefined,
    fx: mods.fx ? new Fx(core) : undefined,
    refresh: () => mirror.refresh(),
    get readAt() {
      return mirror.readAt;
    },
    dispose: () => mirror.stop(),
  };
  const ms = mods.refreshMs ?? 250;
  if (ms > 0) mirror.start(ms);
  return sim;
}
