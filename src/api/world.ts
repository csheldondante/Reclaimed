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
import { Agents, type KindSpec } from '../agents/agents';
import { installAgents } from '../agents/install';
import { Fx } from './fx';
import { Plants } from './plants';
import { Crew, type CrewDef } from '../agents/crew';
import { Mirror } from './mirror';
import { Terrain } from './terrain';
import { Town } from '../build/town';
import { BuildCrew, type BuildCrewDef } from '../agents/buildcrew';
import type { TownGridOpts } from '../build/towngrid';
import { cellPos } from '../world/lattice';
import { Water } from './water';
import { Wind } from './wind';

export interface SimModules {
  terrain?: boolean;
  water?: boolean;
  fire?: boolean;
  wind?: boolean;
  fx?: boolean;
  /** the plants and the trees on them; fell (round 63; needs terrain) */
  plants?: boolean;
  /** units walking the surfaces by shared fields, and fighting (docs/AGENTS.md) */
  agents?: boolean;
  /** ms between mirror reads (default 250); 0: never on a timer (call refresh()) */
  refreshMs?: number;
}

const ALL: SimModules = { terrain: true, water: true, fire: true, wind: true, fx: true, plants: true, agents: true };

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
  /** draw with the field mesh (default true; round 61) */
  fieldMesh?: boolean;
  /** the kinds of agent (index = kind id; default worker, raider, ogre: agents.ts) */
  agents?: { kinds?: KindSpec[] };
  /**
   * intervals every column can hold, at least (default: 4, or what the
   * map's busiest column in each 16×16 chunk needs + 2; at most 16). Caves,
   * bores and overhangs each take one; a full column can't open another
   * (round 62)
   */
  slots?: number;
  /** modules to install (default all of them) */
  modules?: SimModules;
  /** settle the world before it's shown (Sim.warmup; sim.ready resolves when it's done) */
  warmup?: WarmupOpts;
}

export interface WarmupOpts {
  /** ticks of simulation (60 a second; the levels run 1800, ~30 s: rivers reach equilibrium) */
  ticks: number;
  /**
   * how much faster loose debris (dust, litter) gathers on the ground while
   * it runs, so the world opens with some lying about for the wind to lift
   * (the levels use 10; 1 none extra)
   */
  debris?: number;
  /** systems left out while it runs (default ['ecology']: plants don't grow through it) */
  skip?: string[];
}

export interface Sim {
  readonly core: WorldCore;
  readonly terrain?: Terrain;
  readonly water?: Water;
  readonly fire?: Fire;
  readonly wind?: Wind;
  readonly fx?: Fx;
  readonly agents?: Agents;
  /**
   * The town (round 65, build/town.ts): blocks on Townscaper's irregular
   * grid that stand as real matter. One a world: made on the first call
   * (its grid from `opts`), the same one after. Needs terrain.
   */
  town(opts?: TownGridOpts): Town;
  /** A building crew (round 65, agents/buildcrew.ts): workers build the town's plan from a pile. Call `update(units)` each frame after a sync. */
  buildCrew(def: BuildCrewDef): BuildCrew;
  /** Read every module's mirror now (resolves when it's in). */
  refresh(): Promise<void>;
  /** performance.now() of the last mirror read (0: never). */
  readonly readAt: number;
  /** the last read is of the window as it is now (round 80: after a streamed window's slide, false — queries return null — until a new read lands) */
  readonly fresh: boolean;
  /** Settle the world: `ticks` of simulation at once, debris gathering faster; resolves when the GPU is done. */
  warmup(opts: WarmupOpts): Promise<void>;
  /** resolves once the warmup asked for at creation is done (at once without one) */
  readonly ready: Promise<void>;
  /** Stop the mirror's timer (attachSim), or that and the world too (createSim). */
  dispose(): void;
}

async function warmup(core: WorldCore, mirror: Mirror, opts: WarmupOpts): Promise<void> {
  const g = core.globals;
  const skip = new Set(opts.skip ?? ['ecology']);
  g.debrisBoost = opts.debris ?? 1;
  try {
    await core.warmup(opts.ticks, (sys) => !skip.has(sys.name));
  } finally {
    g.debrisBoost = 1;
  }
  await mirror.refresh();
}

/** A sim of the world `def` describes. */
export function createSim(host: Host, def: WorldDef): Sim {
  const core = new WorldCore(host, def.map, def.particles ?? host.quality.particles, def.slots, def.fieldMesh ?? true);
  if (def.climate) core.globals.climate = { ...def.climate };
  if (def.season !== undefined) core.globals.season = def.season;
  if (def.yearLength !== undefined) core.yearLength = def.yearLength;
  if (def.places) core.places.load(def.places.plan, def.places.seed ?? 1);
  const sim = attachSim(core, def.modules ?? ALL, def.warmup);
  def.agents?.kinds?.forEach((k, i) => {
    if (!sim.agents) throw new Error('WorldDef: agent kinds given, but the agents module is off');
    sim.agents.defineKind(i, k);
  });
  const stop = sim.dispose;
  // (this sim made the world: it goes with it)
  return Object.assign(sim, { dispose: () => (stop(), core.destroy()) });
}

/** The modules over a WorldCore a scene already runs (the level); `warm` settles it first (sim.ready). */
export function attachSim(core: WorldCore, mods: SimModules = ALL, warm?: WarmupOpts): Sim {
  // (round 80: a streamed window's slides make a read stale — WorldCore.windowEpoch)
  const mirror = new Mirror(core.host.gpu.device, () => core.windowEpoch);
  const terrain = mods.terrain ? new Terrain(core, mirror) : undefined;
  if (mods.plants && !terrain) throw new Error('world: the plants module needs terrain');
  const plants = mods.plants && terrain ? new Plants(core, mirror, terrain) : undefined;
  const agents = mods.agents ? (core.sim.systems.find((s): s is Agents => s instanceof Agents) ?? installAgents(core)) : undefined;
  let town: Town | undefined;
  const sim = {
    warmup: (opts: WarmupOpts) => warmup(core, mirror, opts),
    ready: warm ? warmup(core, mirror, warm) : Promise.resolve(),
    core,
    terrain,
    plants,
    water: mods.water ? new Water(core, mirror) : undefined,
    fire: mods.fire ? new Fire(core, mirror) : undefined,
    wind: mods.wind ? new Wind(core, mirror) : undefined,
    fx: mods.fx ? new Fx(core) : undefined,
    // (a scene may have installed them already: the level does)
    agents,
    /** A work crew (round 63, docs/AGENTS.md "Crews"): workers dig or fell and carry it to a pile. Call `update(units)` each frame after a sync. */
    crew: (def: CrewDef): Crew => {
      if (!agents || !terrain) throw new Error('world.crew: needs the agents and terrain modules');
      return new Crew(agents, terrain, plants, def);
    },
    town: (opts?: TownGridOpts): Town => {
      if (!terrain) throw new Error('world.town: needs the terrain module');
      return (town ??= new Town(core.dims.w, core.dims.h, {
        ground: (col) => terrain.heightAt(...cellPos(col % core.dims.w, Math.floor(col / core.dims.w))) ?? 0,
        stamp: (s) => core.sim.town.stamp(s),
        zMax: core.dims.zMax,
      }, opts));
    },
    buildCrew: (def: BuildCrewDef): BuildCrew => {
      if (!agents || !terrain) throw new Error('world.buildCrew: needs the agents and terrain modules');
      return new BuildCrew(agents, terrain, def);
    },
    refresh: () => mirror.refresh(),
    get readAt() {
      return mirror.readAt;
    },
    /** the last read is of the window as it is now (round 80: a streamed window's slide makes it stale; queries return null until a new read lands) */
    get fresh() {
      return mirror.fresh();
    },
    dispose: () => mirror.destroy(),
  };
  // (what units carry comes from the ground and goes back to it)
  if (sim.agents && sim.terrain) sim.agents.useTerrain(sim.terrain);
  const ms = mods.refreshMs ?? 250;
  if (ms > 0) mirror.start(ms);
  return sim;
}
