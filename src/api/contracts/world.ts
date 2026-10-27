// The world between runs — its contract (round 83, docs/SYSTEMS.md systems 1 and 2).
// Types only, plus a reference implementation of WorldState in world-state.ts. Everything that changes the
// world at the atlas scale goes through AtlasEvent; everything that reads it (the overmap, the region
// generator, the GM) reads RegionState and the history.

/** A region of the atlas (the atlas's dense region id). */
export type RegionId = number;
export type FactionId = string;

/** What a region is like now, as play and story left it: what every generator realises when land arrives. */
export interface RegionState {
  /** 0 dry land .. 1 under the sea (sunk) */
  sunk: number;
  /** cells of ash (or sand) laid over it */
  buried: { depth: number; material: 'ash' | 'sand' | 'silt' };
  /** 0 bare .. 1 overgrown (ruins under forest) */
  overgrowth: number;
  /** 0 .. 1 frozen over */
  frozen: number;
  /** a storm that doesn't leave; none when strength is 0 */
  storm: { kind: 'rain' | 'dust' | 'snow' | 'ash' | 'arcane'; strength: number };
  /** 0 .. 1 eternal shadow (light, colour, what grows) */
  shadow: number;
  /** 0 .. 1 how much of the dead walk */
  undead: number;
  /** 0 intact .. 1 in ruins */
  ruin: number;
  /** water standing over the ground (a level, world z); null none */
  flooded: number | null;
  /** 0 parched .. 2 sodden (rivers' flow, plants): 1 the atlas's own */
  wetness: number;
  /** which factions hold or roam it, and how strongly (0..1) */
  presence: Partial<Record<FactionId, number>>;
  /** named things the story left (a grave, a statue, a crater named for someone) */
  marks: Mark[];
}

export interface Mark {
  id: string;
  name: string;
  /** what it is, for the generator: a monument, a grave, a wreck, a shrine, a crater … */
  kind: string;
  /** where, in world cells; the region's choosing when absent */
  at?: [number, number];
  /** which event left it */
  cause: string;
}

/** The kinds of change the atlas takes. Each applies to RegionState (and the coarse world, where it has a shape). */
export type AtlasEventKind =
  | 'sink'
  | 'raise'
  | 'bury'
  | 'overgrow'
  | 'freeze'
  | 'thaw'
  | 'storm'
  | 'clear-storm'
  | 'shadow'
  | 'light'
  | 'raise-dead'
  | 'lay-dead'
  | 'flood'
  | 'drain'
  | 'burn'
  | 'ruin'
  | 'rebuild'
  | 'faction-presence'
  | 'faction-attitude'
  | 'mark';

export interface AtlasEvent {
  id: string;
  kind: AtlasEventKind;
  /** the regions it touches (or an area, world cells, for a shaped event: a crater, a lava field) */
  regions: RegionId[];
  area?: { at: [number, number]; radius: number };
  /** how strong: 0..1 (a bury: cells; faction-presence: −1..1, a faction can lose ground) */
  magnitude: number;
  /** a flood's water level (world z); a flood needs it, the rest ignore it */
  level?: number;
  /** where in its region it shows: a story location's id (the GM knows places, not cells) */
  location?: string;
  /** extra for the kind: the storm's kind, the burying material, the faction, the mark */
  detail?: Record<string, unknown>;
  /** which run it happened in, and why */
  run: number;
  cause: { by: 'story' | 'player' | 'world'; ref?: string };
}

/** A faction: who it is, what it wants, how it feels about the player and the others (−1 hostile .. 1 allied). */
export interface Faction {
  id: FactionId;
  name: string;
  /** a line or two for the GM and dialog: its ethos and manner */
  ethos: string;
  era: 'ancient' | 'medieval' | 'industrial' | 'modern' | 'post-apocalyptic' | 'sci-fi' | 'magical';
  attitude: number;
  relations: Partial<Record<FactionId, number>>;
  /** its civilization's profile (recipe.ts CivProfile: knowledge, tastes, how it builds) */
  civ?: string;
}

/** The world's state as the GM and the overmap read it: the world wiki's facts. */
export interface WorldSnapshot {
  version: number;
  /** the atlas's seed (a story's `from.seed` is checked against it) */
  seed: number;
  /** the run to come (the first is 0; WorldState.record moves it on) */
  run: number;
  regions: { id: RegionId; name: string; kind: string; state: RegionState; settlements: string[] }[];
  factions: Faction[];
  /** the settlements the regions' `settlements` name (settlement.ts) */
  settlements: import('./settlement').Settlement[];
  history: AtlasEvent[];
  /** what past runs did and how they ended (run.ts RunRecord) */
  runs: import('./run').RunRecord[];
}

/** The world between runs: the one place AtlasEvents are applied. */
export interface WorldState {
  region(id: RegionId): RegionState;
  faction(id: FactionId): Faction | undefined;
  apply(e: AtlasEvent): void;
  history(region?: RegionId): AtlasEvent[];
  snapshot(): WorldSnapshot;
  /** keep a finished run (what the GM and the overmap read in the snapshot's `runs`) */
  record(run: import('./run').RunRecord): void;
  /** told after each change: the overmap and the generators listen */
  onChange: ((region: RegionId, before: RegionState, after: RegionState) => void)[];
}

/** A region nothing has happened to. */
export function freshRegion(): RegionState {
  return {
    sunk: 0,
    buried: { depth: 0, material: 'ash' },
    overgrowth: 0,
    frozen: 0,
    storm: { kind: 'rain', strength: 0 },
    shadow: 0,
    undead: 0,
    ruin: 0,
    flooded: null,
    wetness: 1,
    presence: {},
    marks: [],
  };
}
