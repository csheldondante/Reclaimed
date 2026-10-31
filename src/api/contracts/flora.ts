// The flora contract (round 117, track `flora`; docs/ARCHITECTURE.md "Flora"). What other tracks may ask of the
// plants: the species and their meshes, where plants grow, and how a stand of them stops or slows a controller.
//
// The user, verbatim (DECISIONS round 117): "For plants, L systems are great for branches and then cellular autonoma
// for roots. I am ok with stylized or low fidelity but I just want it to be readable and pretty and look integrated
// with the world. Plants growing on fields and being instances that way into other geometry is key." And: "plants
// making a barrier (even a soft barrier like slowing you down or requiring you to cut through) is a good thing" /
// "we should know by character controller what they can and can't pass easily".
//
// Representations (why each): a species is parameters (an L-system, a turtle, a leaf look, a root automaton —
// src/flora/species.ts) so variants are seeds; a plant's look is a low-poly mesh in the instanced renderer (one draw
// a variant for thousands of plants); its roots are cells (what terrain, erosion and excavation speak); where plants
// stand is the succession field plus hashes (vegplan.wgsl, the GPU's, with a CPU port) so nothing is stored per
// plant; passability is a number per region computed from the same plan, never a second copy of the plants.
//
// Coordinates: the level's window, as the world API's (x in cells, y in world units).
//
//   const lib = flora.library;
//   lib.species().map((s) => s.id)                 // 'birch', 'oak', 'pine', 'giant', 'shrub', 'tallgrass', 'reed', …
//   const m = lib.mesh('birch', 7)                 // the 7th seed's silver birch: vertices, indices, height
//   flora.placement.fit({ veg: 4, moisture: 0.5, light: 0.8, altitude: 20, slope: 0.1, host: 'ground' })
//   flora.placement.plantsIn({ x0, y0, x1, y1 })   // the trees (and thickets) standing there, as the GPU draws them
//   flora.passability.passage(rect, library.get('hoverbike')!.profile())   // play's profile (contracts/play.ts)
//     // → { density: 0.6, speed: 0.55, mustCut: true, blocked: false, cost: 1.8 }

import type { ControllerProfile } from './play';

/** A species' id (src/flora/species.ts SpeciesId; open-ended so new species need no contract change). */
export type FloraSpeciesId = string;

export type FloraForm = 'tree' | 'shrub' | 'grass' | 'reed' | 'fern' | 'flower' | 'moss' | 'vine';

/** What a plant grows on: terrain, or instanced onto other geometry (rock, a wall or ruin, a cave's floor). */
export type FloraHost = 'ground' | 'bank' | 'rock' | 'wall' | 'cave';

export interface FloraBarrier {
  /** 0..1 how much of a cell a mature plant fills where a walker moves */
  fill: number;
  cuttable: boolean;
  /** walking speed multiplier through a full stand (1 = none) */
  slow: number;
  /** a controller of at least this mass class (0..4) breaks through instead of cutting */
  breakMass: number;
}

export interface FloraSpeciesInfo {
  id: FloraSpeciesId;
  name: string;
  form: FloraForm;
  /** mature height range (cells) */
  height: [number, number];
  hosts: FloraHost[];
  deciduous: boolean;
  barrier: FloraBarrier;
}

/**
 * A plant's mesh: 4 floats a vertex (x, y, z in cells about its foot, z up; w = part + sway: part 3 wood, 4 leaf,
 * 5 blade, 6 petal, 7 root, 8 accent; sway 0..0.99 how much the wind moves it) and triangle indices (counter-clockwise
 * from outside). The instanced mesh renderer's format (render/meshinst.ts).
 */
export interface FloraMeshData {
  verts: Float32Array;
  index: Uint32Array;
  height: number;
  radius: number;
  tris: number;
}

export interface FloraLibraryApi {
  species(): FloraSpeciesInfo[];
  /** a plant of the species from a seed (deterministic) */
  mesh(id: FloraSpeciesId, seed: number): FloraMeshData;
  /** the variants the game draws of it (0 when it isn't in the game's library) */
  variants(id: FloraSpeciesId): number;
}

/** The fields a site is judged by (each 0..1 unless noted). */
export interface FloraSite {
  /** the succession field (ecology.wgsl: 0 bare … 1.2 grass, 2.6 shrubs, 3.6+ woods) */
  veg: number;
  moisture: number;
  /** light at the ground: 1 open sky, low under canopy or in a cave */
  light: number;
  /** cells above the region's water */
  altitude: number;
  /** rise per run */
  slope: number;
  host: FloraHost;
}

export interface FloraRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A plant standing in the world (as the GPU draws it). */
export interface FloraPlant {
  species: FloraSpeciesId;
  /** its foot (window: x cells, y world units) and its column */
  x: number;
  y: number;
  cx: number;
  cy: number;
  /** its height (cells) */
  height: number;
}

export interface FloraPlacementApi {
  /** the species that grow on such a site, with relative weights (empty: nothing grows) */
  fit(site: FloraSite): { id: FloraSpeciesId; weight: number }[];
  /** the trees and thickets standing in the rectangle (the succession field as last read), nearest-first not implied */
  plantsIn(r: FloraRect): FloraPlant[];
}

// What a controller can do about plants is play's ControllerProfile (contracts/play.ts): `body.mass` and `body.height`,
// `vegetation.cuts`, and `fly.ceiling` > 0 flies over it. (merge122: flora's own FloraCaps stand-in is gone — one
// controller description, as terrain's PassCaps went in runplay.)

export interface FloraPassage {
  /** plant fill over the rectangle, at the controller's height (0 open … 1 solid) */
  density: number;
  /** its speed multiplier through it (1 open … ~0.2 dense brush) */
  speed: number;
  /** it has to cut (or burn) a way */
  mustCut: boolean;
  /** it cannot pass at all (too dense, can't cut, too light to break through) */
  blocked: boolean;
  /** time multiplier for a path across it (1 / speed, cutting time added; Infinity when blocked) */
  cost: number;
}

export interface FloraPassabilityApi {
  /** plant fill over the rectangle for a walker of this height (default 2 cells) */
  density(r: FloraRect, height?: number): number;
  passage(r: FloraRect, body: ControllerProfile): FloraPassage;
}

export interface Flora {
  /** read the world's fields again (the queries answer from the last read; a slide or a while makes it stale) */
  refresh(): Promise<void>;
  library: FloraLibraryApi;
  placement: FloraPlacementApi;
  passability: FloraPassabilityApi;
}
