// Structures: buildings, districts, cities, linear features (roads, walls, bridges) and the pieces of them the terrain
// can bury (round 117, track `structures`; docs/ARCHITECTURE.md "Structures"). The user, verbatim (DECISIONS round 117):
//   "I want beautiful structures, sprawling fantastic cities"
//   megastructures: "various procedural building assets for various tile systems plus some WFC and mega tile features
//   (features multiple tiles big)"
//   "For buildings we have different types of tile system. Irregular tiles like towscraper, voronoi tilings of isolines
//   to make city streets and plot lots, radial tiles like bulwark. Let's bake paths into the tiles we generate so agents
//   can interact with them. Taking elevators, stairs, walking on ramparts. I would also have linear tile features we can
//   use for bridges, roads, railroads and extrude along splines."
//   "Deep cut quarries and cities built into the earth."
//
// The pipeline, each stage its own representation (converted at the boundaries, never into one nobody needs):
//   CitySpec ─plan→ CityPlan (a planar quad mesh of tiles + occupancy spans per tile: the truth, small, deterministic)
//            ─pieces→ StructurePieces (warped module instances: what is drawn, GPU instanced)
//            ─columns→ ColumnSpan[] (what the sims see: External intervals in the hex columns, solid)
//            ─nav→ NavGraph (what agents walk: surfaces and links — stairs, ramps, lifts, doors, ramparts)
// Why this split: the look wants detail finer than a column (windows, eaves, sharp corners — "structures stay sharp",
// round 39), the sims only need "solid here" per column, and agents need paths, not fields (round 104). Each consumer gets
// the representation it uses; none of them reads another's.

import type { GridStyle } from './settlement';

export type V2 = [number, number];
export type V3 = [number, number, number];

/** The ground the planner stands a city on: world z at a world point (x, y in world units — a cell is a metre). */
export type GroundFn = (x: number, y: number) => number;

/** A look: a family of modules and a palette ('hearth': timber, plaster and tile; 'bastion': stone walls and towers). */
export type StructureStyleId = 'hearth' | 'bastion' | 'terrace';

/** What a city is asked to be. Everything follows from it and the ground: same spec + ground → same plan. */
export interface CitySpec {
  seed: number;
  /** the tile system the districts are cut by (settlement.ts GridStyle: irregular, contour-voronoi, radial, orthogonal) */
  system: GridStyle;
  style: StructureStyleId;
  /** centre (world units) and reach (m) */
  at: V2;
  radius: number;
  /** a tile's size (m): about a room across (default 4) */
  tile?: number;
  /** storeys at the centre and at the rim (default 4 and 1) */
  storeys?: [number, number];
  /** share of building lots built on (0..1, default 0.8) */
  density?: number;
  /** a wall round it (default: radial cities yes, others no) */
  walls?: boolean;
  /** roads out of the town (bridges where they cross a valley or water; default 0) */
  roads?: number;
  /** contour-voronoi: the height step between contour rows of plots (m, default 3) */
  contour?: number;
  /** radial: spokes (default 6) */
  spokes?: number;
  /** built into the earth: buildings cut into the ground below this many metres under it (quarry towns; default 0) */
  sunk?: number;
  /** how far it has grown (0..1, default 1: all of it) — stored progress along the plan's build order */
  progress?: number;
  /** farmland round it out to this far from its centre (m; default 0: none): crop strips, orchards, pastures, farmsteads */
  farmland?: number;
}

/** A tile's use. */
/** A tile's use. The farmland's (round 119: "farms and smaller huts for lower population density"): crop strips, an
 *  orchard's rows, a fenced pasture. */
export type TileUse = 'lot' | 'street' | 'plaza' | 'yard' | 'wall' | 'gate' | 'outside' | 'field' | 'orchard' | 'pasture';

/**
 * People per area, 0..1, at a world point (round 119: "Is it density driven+grid based now?"): what decides what's built
 * on each tile — dense: town houses, storeys by it; thinner: huts; thinnest: farmland with farmsteads. A settlement's
 * comes from its growth field (settle/field.ts); the viewer makes one from noise.
 */
export type DensityFn = (x: number, y: number) => number;

/** What a building is (its module set, roof and size follow): a town house, a hut, a farmhouse, a barn. */
export type BuildingKind = 'house' | 'hut' | 'farmhouse' | 'barn';

/** The tiles: a planar quad mesh (shared vertices, counter-clockwise quads), every tile system's common output. */
export interface TileMesh {
  /** vertices (x, y world units), 2 a vertex */
  verts: Float64Array;
  /** quads: 4 vertex indices each, counter-clockwise */
  quads: Uint32Array;
  /** per quad its use */
  use: TileUse[];
  /** per quad its block (a Voronoi plot, a radial sector, a lattice block; -1 none): buildings never cross blocks */
  block: Int32Array;
}

/** What fills a tile between two heights. */
export type SpanKind = 'room' | 'tower' | 'rampart' | 'arcade' | 'foundation' | 'hall';

/** Occupancy (the settlement spans design, round 102: "each grid be store intervals like the terrain but for building
 *  types"): a tile filled from z0 to z1 (world z) by a kind, belonging to a building. */
export interface Span {
  quad: number;
  z0: number;
  z1: number;
  kind: SpanKind;
  building: number;
}

export interface BuildingRec {
  id: number;
  kind: BuildingKind;
  quads: number[];
  /** its floor (world z) and storeys */
  base: number;
  storeys: number;
  storeyH: number;
  /** its palette picks */
  look: number;
  /** a landmark (a mega tile: several tiles under one feature) */
  mega?: MegaKind;
  /** its quarter of the city (0 the middle) */
  district?: number;
}

/** Features several tiles big. */
export type MegaKind = 'tower' | 'dome' | 'keep' | 'fountain';

export interface MegaFeature {
  kind: MegaKind;
  /** the tiles under it */
  quads: number[];
  /** its frame: four corners (counter-clockwise), its foot and its top (world z) */
  frame: [V2, V2, V2, V2];
  z0: number;
  z1: number;
}

/** Nav: where agents can stand and how they get between places (baked, round 104: "generate path data on building
 *  tiles that will make agents use stairs or elevators and that will look cool"). */
export type NavSurface = 'street' | 'plaza' | 'floor' | 'roof' | 'rampart' | 'bridge' | 'ground';
export type NavLinkKind = 'walk' | 'stairs' | 'ramp' | 'ladder' | 'lift' | 'door' | 'gate';

export interface NavNode {
  id: number;
  at: V3;
  surface: NavSurface;
  /** the building it's in or on (-1: outdoors) */
  building: number;
}

export interface NavLink {
  a: number;
  b: number;
  kind: NavLinkKind;
  /** metres walked (a lift: its rise; stairs: the slope's length) */
  cost: number;
}

export interface NavGraph {
  nodes: NavNode[];
  links: NavLink[];
}

/** A linear feature: a profile extruded along a spline (roads, rails, walls, bridges, aqueducts). */
export type LinearKind = 'road' | 'rail' | 'wall' | 'bridge';

export interface LinearFeature {
  kind: LinearKind;
  /** the spline's control points (world x, y, z: the deck, the road's or the wall walk's top); Catmull-Rom through them */
  points: V3[];
  /** the ground under each point (world z): what piers, arches and walls stand on */
  ground: number[];
  /** width (m) */
  width: number;
  /** a loop (a town wall) */
  closed?: boolean;
}

/** What a building shows on one storey of one side (chosen by WFC so bays line up and doors face the street). */
export type FacadeKind = 'blank' | 'window' | 'window2' | 'door' | 'shop' | 'balcony';

export interface Facade {
  quad: number;
  /** the tile's side (corners side → side+1) */
  side: number;
  /** storey (0 the ground floor) and its z range */
  level: number;
  z0: number;
  z1: number;
  kind: FacadeKind;
  building: number;
}

export interface CityPlan {
  spec: CitySpec;
  tiles: TileMesh;
  /** per vertex the ground under it (world z) */
  ground: Float64Array;
  spans: Span[];
  buildings: BuildingRec[];
  /** every outside wall's storey and what it shows */
  facades: Facade[];
  /** per quad: its building (-1 none), its top (world z of the roof's foot; NaN unbuilt) */
  quadBuilding: Int32Array;
  quadTop: Float64Array;
  /** the build order (building ids, the old core first): a town grows along it (stored progress: a share of it) */
  order: number[];
  /** buildings going up (a grown plan's: storeys so far, no roof yet) */
  sites?: Set<number>;
  /** the roof's rise a unit of the tile (m), per building */
  roofRise: number[];
  megas: MegaFeature[];
  linear: LinearFeature[];
  nav: NavGraph;
  /** counts and ms, for the viewer and the perf test */
  stats: Record<string, number>;
}

/**
 * Warped module instances: every drawn piece is a module (made in code, in a unit frame u, v, w ∈ [0, 1]) warped into a
 * frame — four corners in x, y (counter-clockwise from u0 v0), a foot height per corner and a top — so modules fit the
 * irregular tiles as Townscaper's do. 16 floats a piece (render/structmesh.ts packs them for the GPU).
 */
export interface StructurePieces {
  /** module ids, one a piece */
  module: Uint16Array;
  /** per piece: x0 y0 x1 y1 x2 y2 x3 y3 | foot z0 z1 z2 z3 | top, look, seed, flags */
  data: Float32Array;
  /** per piece its building (-1: streets, walls, the plaza's) */
  building: Int32Array;
  count: number;
}

/** What the sims see: a column (window or world cell x, y of the hex lattice) solid from z0 to z1 (an External interval). */
export interface ColumnSpan {
  x: number;
  y: number;
  z0: number;
  z1: number;
  building: number;
}

/** Things the terrain track may bury (round 117: "buried statues and fallen structures and stones … skew add visual
 *  interest"): a mesh in its own frame plus what it occupies, so it can be an External owner's instance. */
export type BuriableKind = 'statue' | 'column' | 'fallen-tower' | 'arch' | 'bell';

export interface BuriableAsset {
  kind: BuriableKind;
  seed: number;
  /** its mesh in its local frame (metres, z up from its foot): xyz + part a vertex, triangles */
  verts: Float32Array;
  index: Uint32Array;
  /** its local bounds (min, max) */
  bounds: [V3, V3];
  /** the cells it fills under a transform (local → world: 3 affine rows, translation last): what an External claim needs */
  cells(transform: Float32Array): ColumnSpan[];
}

/** A buriable asset laid in the world: its kind and seed (its shape) and where (local → world, 3 affine rows, translation
 *  last: any turn, tilt or skew — "These being skew add visual interest"). */
export interface PlacedAsset {
  kind: BuriableKind;
  seed: number;
  transform: Float32Array;
}

/** The system's API (src/structures/index.ts implements it). Pure functions of their inputs: no GPU, no world state. */
export interface Structures {
  /** `water`: the depth of standing water at a point (none built or paved where it's over 0.3 m) */
  plan(spec: CitySpec, ground: GroundFn, water?: GroundFn, density?: DensityFn): CityPlan;
  pieces(plan: CityPlan): StructurePieces;
  /** the columns its buildings fill, on the hex lattice (world cells) */
  columns(plan: CityPlan): ColumnSpan[];
  /** a buriable piece */
  asset(kind: BuriableKind, seed: number): BuriableAsset;
  /** placed assets as pieces (drawn by any StructureGpu host with the city's look) */
  assetPieces(placed: PlacedAsset[]): StructurePieces;
}
