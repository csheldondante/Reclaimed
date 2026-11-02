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
  /** (round 117, runplan) a faction's feeling toward another (detail.faction, detail.toward; −1..1, applied once) */
  | 'faction-relation'
  /** (round 117, runplan) a faction's strength in the world (detail.faction; −1..1, applied once): the user's "factions and their relationships and power" */
  | 'faction-power'
  | 'mark'
  /** (round 124, opportunities; RUN_LOOP §8 item 1) a settlement's condition (detail.settlement, detail.condition):
   *  WorldState.apply is its one owner — runsit's finishSituation wrote it directly before */
  | 'settlement-condition'
  /** (round 124) who holds a settlement (detail.settlement, detail.faction: an occupation, a vassal sworn, a town lost) */
  | 'settlement-owner'
  /** (round 124) people moving: refugees fleeing (detail.from, detail.to settlements; magnitude: the share of `from`'s
   *  people who go, 0..1) — they arrive at `to` as 'refugee' */
  | 'migrate'
  /** (round 125, facts) a region's rivers' inflow factor (RegionState.wetness, set to `magnitude`, 0..2): the held steady
   *  rivers' discharge is Q × it (atlas/rivers.ts), so lowering it dries the river the next time the region is realised —
   *  a drought is this mutation, not a simulation (the user, round 125) */
  | 'river-inflow'
  /** (round 125, facts) a settlement's store of a good (detail.settlement, detail.good; magnitude: stock added, may be
   *  negative, floored at 0; detail.rate: the rate a day added) */
  | 'settlement-stores'
  /** (round 125, facts) a structure placed in a settlement directly, no agents building it (detail.settlement,
   *  detail.building: its id, detail.use: its uses, detail.name): the region generator lays it out on arrival */
  | 'settlement-building';

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

/**
 * (round 90) A lake the atlas keeps: a hollow its rivers fill to the height they spill out at (atlas/rivers.ts
 * AtlasLake). Like a flood with a level (RegionState.flooded, AtlasEvent 'flood'), held in its basin: the region
 * generator realises it on arrival, the basin filled to `level` at steady state, its shore a bank over the
 * level. `lakeFlood` is the AtlasEvent that says the same of its regions (a story raising or draining one).
 */
export interface Lake {
  id: number;
  name: string;
  /** its water's level (world z) */
  level: number;
  /** world units: its middle, and where it spills out (its river leaves there) */
  at: [number, number];
  outlet: [number, number];
  /** macro texels, and the deepest water over the macro ground (cells) */
  area: number;
  depth: number;
  regions: RegionId[];
  /** rivers running in; whether one runs out */
  inflow: number;
  outflow: boolean;
}

/** a lake as the flood it is (its regions, its level): for a WorldState that keeps lakes as floods */
export function lakeFlood(l: Lake, run: number): AtlasEvent {
  return { id: `lake-${l.id}`, kind: 'flood', regions: l.regions, area: { at: l.at, radius: Math.sqrt(l.area) * 4 }, magnitude: 1, level: l.level, run, cause: { by: 'world', ref: l.name } };
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
  /** (round 117, runplan) its strength, 0..1 (absent: 0.5): what 'faction-power' moves; the GM reads it for who can take over */
  power?: number;
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
  /** (round 117, runplan) the characters the world remembers: heroes and the people they met (run.ts CharacterRecord); absent in older saves */
  characters?: import('./run').CharacterRecord[];
  /** (round 125, facts) the fact layer: entities, scoped tags, relations (diplomacy's agreements among them), claims and
   *  the event history (diplomacy's interactions among them); absent in older saves (restore migrates them) */
  facts?: import('./facts').FactSnapshot;
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
