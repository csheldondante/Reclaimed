// Terrain — the map's partition into regions and the terrain's generative tools (round 117, the `terrain` track;
// docs/ARCHITECTURE.md "Terrain: the region graph"). Other tracks (runplan, play, structures, flora) use only this.
//
// The user, verbatim (DECISIONS round 117):
//   "We want to partition our map. We want high frequency and low frequency regions of our partion and we may
//   subpartition those. We want natural barriers like rivers, magma flows, ravines, dense vegetation, tar pits, steep
//   mountains and cliffs that let us steer player traversal during runs. We also want transient soft barriers like
//   hostile agents, severe storms or weather or occasionally just long distances that are not fun to traverse without
//   a vehicle." / "Barriers let us control play. An impassible mountain can have a cave through it. A ravine can
//   require the player to build a bridge. A desert with dust storms may require a vehicle."
//   "We don't need hard barriers always but we should know by character controller what they can and can't pass
//   easily. I would make regions recursive with open fully connected spaces 1-3 screens big and that are part of larger
//   terrain features."
//   "Terrain makes the barriers initially but the run manager should be able to get. The graph and request obstacles or
//   otherwise request a certain number of exits."
//   "parameterize it so we can reason about it during generation and make not only obstacles but fun ones."
//
// What it is: a graph over a rectangle of the world. Its nodes are regions at two levels — FEATURES (level 0: the land
// one body can reach without crossing a barrier: a plateau's top, a valley floor between cliffs, an island) and ROOMS
// (level 1: open, fully connected spaces 1-3 screens big, a feature split at its narrow points). Its edges are BORDERS
// between rooms: 'open' between rooms of one feature (a door: the narrows they meet at), or a barrier of some kind.
// What a body can cross is asked per controller (play's ControllerProfile): the graph holds the physical measures (heights, water,
// lava, vegetation along every crossing), not a verdict, so a new controller needs no new generation.
//
// Coordinates: world units of the atlas (x along a row, y = row × 0.866 — atlas/compose.wgsl's p), z the world's z.
//
//   const g = await terrain.graph({ x0, y0, x1, y1 })
//   g.rooms()  ·  g.borders(roomId)  ·  g.cost(borderId, caps, from)  ·  g.exits(roomId, caps)  ·  g.reach(roomId, caps)
//   terrain.request({ kind: 'exits', room, count: 2, caps })    // → edits (ramps, fords, walls…) + needs for other tracks
//   terrain.flood({ at, level?, fluid: 'water' })                // a basin flooded to its spill height (or a level)

import type { V2 } from './units';
import type { ControllerProfile } from './play';

// (runplay, round 119 — the consolidation) What a body can get over is play's ControllerProfile (contracts/play.ts),
// the one controller description every generator reads; terrain's own stand-in (PassCaps, CAPS_PRESETS) is gone.
// Every `caps` below is a profile: library.get(id).profile(params), or WALKER_PROFILE (the default body rooms are
// made for). Inside, terrain asks play's crossCost of each step between samples (src/terrain/partition.ts stepCost),
// so the graph's costs and play's agree.

/** What stands in the way along a border (the dominant cause; a border may have several — `causes`). */
export type BarrierKind =
  | 'open' // no barrier: two rooms of one feature meet at a narrows
  | 'cliff' // a sheer step up from one side to the other
  | 'steep' // a slope too steep (a mountain's flank)
  | 'ravine' // a cut lower than both sides (a gorge, a chasm)
  | 'ridge' // ground higher than both sides (a wall of rock, a spine)
  | 'river'
  | 'lake'
  | 'sea'
  | 'lava'
  | 'vegetation'
  | 'tar'
  // soft and transient: laid on a border by other systems (the run manager, weather, inhabitants)
  | 'hostile'
  | 'storm'
  | 'distance';

export interface TerrainRegion {
  id: number;
  /** 0: a feature (what one body reaches without crossing a barrier); 1: a room in it */
  level: 0 | 1;
  /** a room's feature (−1 for a feature) */
  parent: number;
  /** a feature's rooms */
  children: number[];
  /** world units² and in screens (TerrainGraph.screen) */
  area: number;
  screens: number;
  /** its middle (the sample deepest inside it: farthest from its edges), world units */
  centre: V2;
  /** [x0, y0, x1, y1] world units */
  bounds: [number, number, number, number];
  /** its ground's lowest, median and highest z */
  floor: [number, number, number];
  /** how open it is: the widest clear disc in it (world units, radius) */
  openness: number;
}

/** A place a body crosses a border: a door between rooms, a ford, the cheapest climb, a pass found for a controller. */
export interface TerrainPass {
  id: number;
  border: number;
  at: V2;
  /** world units across (a door's width; 0 for a point) */
  width: number;
  kind: 'opening' | 'ford' | 'ramp' | 'drop' | 'jump' | 'cave' | 'bridge' | 'cleared' | 'found';
  /** made by a request (TerrainEdit id), or found in the land as generated (−1) */
  edit: number;
}

/** The physical measures along a border (the worst and the easiest across its crossing samples). */
export interface BorderMeasure {
  /** the height difference between the rooms' floors where they face each other (b's minus a's: + is up from a) */
  rise: number;
  /** the least sheer climb a crossing needs (cells), and the least drop */
  minClimb: number;
  minDrop: number;
  /** the shallowest water a crossing wades, and the narrowest water (world units across) */
  minDeep: number;
  minWaterSpan: number;
  /** lava on every crossing */
  lava: boolean;
  /** the thinnest vegetation a crossing must push through (0..1) */
  minVeg: number;
  /** the narrowest gap (a ravine's span, world units) */
  minGap: number;
}

export interface TerrainBorder {
  id: number;
  a: number;
  b: number;
  kind: BarrierKind;
  /** every cause found along it, most first */
  causes: BarrierKind[];
  /** world units it runs along */
  length: number;
  measure: BorderMeasure;
  passes: number[];
  /** soft barriers laid on it (TerrainGraph.soften), their strength 0..1 */
  soft: { kind: BarrierKind; strength: number }[];
}

export interface TerrainGraph {
  /** the rectangle it covers (world units), its sample spacing, the screen it sizes rooms by (world units²) */
  readonly rect: [number, number, number, number];
  readonly step: number;
  readonly screen: number;
  readonly seed: number;
  regions(): TerrainRegion[];
  rooms(): TerrainRegion[];
  features(): TerrainRegion[];
  region(id: number): TerrainRegion;
  /** the room at a world point (−1: none — water, a barrier's middle) */
  roomAt(at: V2): number;
  borders(room?: number): TerrainBorder[];
  border(id: number): TerrainBorder;
  pass(id: number): TerrainPass;
  /**
   * What crossing a border costs a body (cells of walking-equivalent from room `from`'s floor to the other's), Infinity
   * when it can't; soft barriers add to it by their strength. Cached per caps.id.
   */
  cost(border: number, caps: ControllerProfile, from?: number): number;
  /** the borders out of a room a body can cross (finite cost from it), each with its cost */
  exits(room: number, caps: ControllerProfile): { border: number; to: number; cost: number }[];
  /** the rooms a body reaches from a room (crossing whatever it can) */
  reach(room: number, caps: ControllerProfile): number[];
  /** lay a soft barrier on a border (hostiles, a storm, distance): it adds strength × SOFT_COST to its cost */
  soften(border: number, kind: BarrierKind, strength: number): void;
}

/** an edit the terrain makes to its own generation (stamped into the land as it streams in: atlas stampHooks) */
export interface TerrainEdit {
  id: number;
  kind: 'ramp' | 'ford' | 'wall' | 'tunnel' | 'cut';
  /** its line, world units, and the ground's z it runs between */
  a: V2;
  b: V2;
  za: number;
  zb: number;
  /** half its width (world units), its height (a wall's) */
  half: number;
  height?: number;
  /** the border it was made for */
  border: number;
}

/** something another track must build or place for a request (the run manager passes it on through their contracts) */
export interface TerrainNeed {
  kind: 'bridge' | 'vegetation' | 'hostiles' | 'storm' | 'rubble';
  border: number;
  at: V2;
  /** a bridge's ends (world) and their z */
  a?: V2;
  b?: V2;
  za?: number;
  zb?: number;
  /** world units across */
  width: number;
}

export type TerrainRequest =
  /** have `count` exits from a room a body with `caps` can cross: opens the cheapest barriers (ramps, fords, a
   *  tunnel; a bridge as a need) or closes doors (a wall of rubble, dense vegetation as a need) to make it so */
  | { kind: 'exits'; room: number; count: number; caps: ControllerProfile }
  /** put an obstacle on a border (closing its doors to `caps`; default: every body) */
  | { kind: 'obstacle'; border: number; barrier: 'wall' | 'vegetation' | 'rubble' | 'ravine'; caps?: ControllerProfile }
  /** open a border to `caps` (its cheapest crossing made passable) */
  | { kind: 'open'; border: number; caps: ControllerProfile };

export interface TerrainResult {
  ok: boolean;
  /** why not (no candidate border, a room with no neighbours) */
  reason?: string;
  edits: TerrainEdit[];
  needs: TerrainNeed[];
  /** the graph after (its costs with the edits counted) */
  graph: TerrainGraph;
}

/** what a basin is flooded with (a fluid's column material; sand and ash bury what's under) */
export type FloodFluid = 'water' | 'sand' | 'magma' | 'ash' | 'silt';

export interface FloodRequest {
  /** a world point in the basin */
  at: V2;
  /** the level (world z); default: the basin's spill height (the lowest rim it would overflow) */
  level?: number;
  fluid: FloodFluid;
  /** world units round `at` the fill may reach (default 2048) */
  reach?: number;
}

export interface FloodResult {
  level: number;
  /** world units² flooded, and the deepest point */
  area: number;
  depth: number;
  /** the spill point (world) — where it would overflow next */
  spill: V2 | null;
  ms: number;
}

/**
 * Something buried in the land, skew (the user, round 117: "buried statues and fallen structures and stones. These
 * being skew add visual interest and they make great props for telekenisis or excavation sites"). Terrain places them
 * (where, how deep, how tilted); structures supplies what a statue or a ruin looks like (`asset`: its contract's id,
 * by `kind`); the owner that draws them as instanced meshes holds their cells as External intervals (sim/external.ts).
 */
export interface BuriedProp {
  id: number;
  kind: 'stone' | 'statue' | 'column' | 'slab' | 'ruin';
  /** world units, and the ground's z there */
  at: V2;
  z: number;
  /** its size (cells: its longest extent) */
  size: number;
  /** turned about z (radians), then tipped `tilt` radians about a horizontal axis at `tiltAxis` radians */
  yaw: number;
  tilt: number;
  tiltAxis: number;
  /** how much of it is under the ground (0..1 of its height) */
  buried: number;
  /** the excavation site it belongs to (−1: on its own) */
  site: number;
}

/** A place where things lie buried together (a dig the hero or agents may work). */
export interface ExcavationSite {
  id: number;
  at: V2;
  /** world units */
  radius: number;
  props: number[];
}

/**
 * The partition's top level, world-wide: the atlas's regions (provinces ~25 macro texels across — the "larger terrain
 * features") and what stands between neighbours, read off the rules the border is drawn by (a plateau's cliff, a
 * massif's flank, a ravine, a wall, the coast, a river along or across it). For planning a run on the overmap (runplan's
 * RegionGraph stand-in has this shape); the rooms where a stage is played come from Terrain.graph(rect).
 */
export interface AtlasRegionNode {
  id: number;
  /** the atlas region's kind (plains, mesa, dunes …) */
  kind: string;
  land: boolean;
  /** world units */
  centre: V2;
  /** macro texels */
  area: number;
  /** its landform's tier (lowland, upland, plateau, massif; null water) */
  tier: string | null;
  ground: { min: number; mean: number; max: number };
  /** river and lava node texels in it */
  rivers: number;
  lava: number;
}

export interface AtlasRegionEdge {
  a: number;
  b: number;
  /** the first of `causes` (null: open ground) */
  barrier: BarrierKind | null;
  causes: BarrierKind[];
  /** world units of shared border, and between the centres (on the torus) */
  length: number;
  span: number;
}

export interface AtlasRegionGraph {
  readonly seed: number;
  readonly world: { w: number; h: number };
  node(id: number): AtlasRegionNode | undefined;
  edges(id: number): AtlasRegionEdge[];
  nodes(): Iterable<AtlasRegionNode>;
  /** the region at a world point */
  regionAt(at: V2): number;
}

/** The terrain system's API (src/terrain/terrain.ts `TerrainSystem` implements it over the atlas). */
export interface Terrain {
  /** the atlas's regions as a graph (the partition's top level, world-wide; made once) */
  atlasGraph(): AtlasRegionGraph;
  /** what lies buried in a rectangle (deterministic from the seed): props and the excavation sites they cluster in */
  buried(rect: { x0: number; y0: number; x1: number; y1: number }): Promise<{ props: BuriedProp[]; sites: ExcavationSite[] }>;
  /** the region graph over a rectangle (world units); caps: the controller rooms are made for (default the walker) */
  graph(rect: { x0: number; y0: number; x1: number; y1: number }, opts?: { caps?: ControllerProfile; step?: number; screen?: number }): Promise<TerrainGraph>;
  request(graph: TerrainGraph, req: TerrainRequest): TerrainResult;
  /** the edits in force (stamped into land made from now on) */
  edits(): TerrainEdit[];
  /** flood a basin (a GPU height flood fill): replaces the global sea level where it's used */
  flood(req: FloodRequest): Promise<FloodResult>;
}
