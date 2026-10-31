// Settlements (round 83, first pass round 85; docs/SYSTEMS.md systems 6 and 12). The user: settlements should
// "use the same data structure we plan to expose to the city management game", with agents that are workers
// or hostile. It's what the region generator places, what agents work in, what the GM's stories name, and what
// a city game would edit.
//
// Round 85: buildings are things (recipe.ts Instances: a structure with rooms, facilities and fittings as
// parts), so a house, a hospital or a commune is a composition and its function is derived from it, and a
// ruin can be adapted rather than rebuilt ("a primitive civilization might convert an ancient ruined
// megastructure into apartments"). The ground is laid out by overlay grids — "irregular grids like townscaper
// or build voronoi on height contours for modern or use radial sets like the game bulwark" — several to a
// settlement, each its own district, chosen by the civilization's profile (CivProfile.builds.grids).

import type { FactionId, RegionId } from './world';
import type { InstanceId, MaterialId, Tag } from './recipe';

/** How a district's ground is cut into building cells. */
export type GridStyle =
  /** Townscaper's: triangles merged into quads and relaxed (build/towngrid.ts) */
  | 'irregular'
  /** Voronoi cells seeded along the height's contours: terraces that follow the land (modern, hill towns) */
  | 'contour-voronoi'
  /** Bulwark's: rings and spokes about a centre (a keep, a well, a plaza), cells between them */
  | 'radial'
  /** a planned square lattice, turned to the land (a camp, a colony, a grid city) */
  | 'orthogonal';

/** One grid laid over the land: a district. Grids may overlap; a cell belongs to the grid listed first. */
export interface SettlementGrid {
  id: string;
  style: GridStyle;
  seed: number;
  /** its centre and reach (world cells), the cells' size, the turn of a lattice (radians) */
  at: [number, number];
  radius: number;
  spacing: number;
  angle?: number;
  /** radial: the rings and spokes; contour-voronoi: the contour step (cells of height) */
  rings?: number;
  spokes?: number;
  contour?: number;
  /** what the district is for, for the generator and the city game: market, homes, works, temple, keep, fields */
  purpose?: Tag;
  /** who laid it out (a later people building in an older people's grid keeps it: legacy) */
  civ?: string;
}

export interface Settlement {
  id: string;
  name: string;
  region: RegionId;
  faction: FactionId | null;
  /** where it stands (world cells) and how far it reaches */
  at: [number, number];
  radius: number;
  /** small camp .. city */
  size: 'camp' | 'hamlet' | 'village' | 'town' | 'city';
  /** its state: thriving, struggling, besieged, abandoned, ruined (the region's ruin, the story's doing) */
  condition: 'thriving' | 'struggling' | 'besieged' | 'abandoned' | 'ruined';
  /** its districts' grids (the generator makes them from the civ profile when empty) */
  grids: SettlementGrid[];
  buildings: Building[];
  /** who lives and works there, by role (the unit generator's roles) */
  people: { role: string; count: number; hostile?: boolean }[];
  /** bulk goods by resource (a material id or a tag: grain, copper, cloth): stock and its rate a day; the
   *  notable things (a relic, a hoverbike in the garage) are Instances owned by the settlement */
  stores: Record<MaterialId | Tag, { stock: number; rate: number }>;
  /** what work it needs done (agents take these as jobs) */
  needs: Job[];
  /** who built it before its people, if they took it over (adaptive reuse: a ruin lived in) */
  founded?: { civ: string; run?: number; over?: string };
  /** (round 120, `cities`) what it's for, read from the land and the world state (settle/purpose.ts): it shapes the
   *  layout, the buildings and the jobs. The GM and the wiki read it. */
  purpose?: SettlementPurposeRec;
  /** (round 120) its story: why it was founded, who holds it, what happened to it (shown in its fabric: a burned
   *  quarter, newer walls, a flooded lower town). The GM and the wiki read it. */
  story?: SettlementStory;
}

/** What a settlement is for (round 120, the user: "different settlements have different purposes like trading posts,
 *  mines, lumber camps, etc."). */
export type SettlementPurpose = 'mining' | 'port' | 'lumber' | 'farming' | 'trading' | 'hold';

export interface SettlementPurposeRec {
  kind: SettlementPurpose;
  /** why the land made it this, in a sentence (the GM's and the wiki's) */
  why: string;
  /** every purpose's score from the land (the highest won) */
  scores: Record<SettlementPurpose, number>;
  /** what its people do (roles), the purpose's first */
  trades: string[];
}

/** One thing that happened to a settlement (round 120: "towns should have stories"). */
export interface SettlementStoryEvent {
  what: 'founded' | 'raided' | 'walled' | 'burned' | 'flooded' | 'adapted' | 'grew' | 'ruined';
  /** the run it happened in (negative: before the first run — the deep past) */
  run: number;
  note: string;
  /** where its mark is in the fabric (world units: a burned quarter's middle and reach; a flood's level is `level`) */
  at?: [number, number];
  radius?: number;
  level?: number;
  /** a world-state event's id, when it came from one (WorldState.history) */
  cause?: string;
}

export interface SettlementStory {
  /** why it was founded, in a sentence */
  founding: string;
  /** who holds it (its realm, or a world faction that took it) */
  owner: FactionId | null;
  /** what happened, oldest first */
  events: SettlementStoryEvent[];
}

/** A building: placed on cells of a grid; what it is and does is its thing's composition (recipe.ts). */
export interface Building {
  id: string;
  /** the structure (an Instance: its kind, rooms, facilities, fittings as parts, its condition and history) */
  thing: InstanceId;
  /** its cells on its grid and its storeys */
  grid: string;
  cells: number[];
  storeys: number;
  /** what it's used as now, derived from its thing (house, hospital, smithy, university, commune …) and kept
   *  here for the city game's lists; the derivation is the truth */
  use: Tag[];
  /** who works there (roles) */
  workers?: string[];
}

/** Work for agents (docs/AGENTS.md: jobs are fields): build, repair, haul, farm, mine, fell, guard, raid. */
export interface Job {
  kind: 'build' | 'repair' | 'adapt' | 'haul' | 'farm' | 'mine' | 'dig' | 'salvage' | 'fell' | 'make' | 'trade' | 'guard' | 'raid' | 'flee'
    /** (round 120, purposes) a sawmill's, a mill's, the docks' and the stables' work */
    | 'saw' | 'mill' | 'load' | 'sail' | 'tend';
  at: [number, number];
  /** a building, a thing, a resource, a recipe, a target */
  ref?: string;
  priority: number;
  /** the rights it needs (diplomacy.ts): a mine on another's land needs mineral rights there */
  needs?: 'land-rights' | 'mineral-rights' | 'passage';
}
