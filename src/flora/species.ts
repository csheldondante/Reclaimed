// The species: each a set of parameters, nothing hand-modelled (round 117). A tree is an L-system (its trunk and
// branches), a turtle (how the rules become wood), a leaf look and a root automaton; the small plants (grass, reeds,
// flowers, moss, vines) are their own little generators. Colours, the season's turn, wind stiffness, where it grows
// (its niche, read from the world's fields) and how hard it is to get through (a soft barrier) are all here, so a
// new species is one entry.
//
// Why parameters and not meshes: one generator, many plants — variants are seeds, a biome is a weighted list of
// species, and the viewer page can show any of them by a slider. Heights are in world cells (a column's width; the
// hero is about two cells tall), chosen for the scene the user asked for: "silver birches towering above".

import type { LSystemSpec, TurtleSpec } from './lsystem';
import type { LeafLook } from './mesh';
import type { RootSpec } from './roots';

export type RGB = [number, number, number];

export type SpeciesId =
  | 'birch'
  | 'oak'
  | 'pine'
  | 'giant'
  | 'shrub'
  | 'tallgrass'
  | 'reed'
  | 'fern'
  | 'flower'
  | 'moss'
  | 'ivy';

export type PlantForm = 'tree' | 'shrub' | 'grass' | 'reed' | 'fern' | 'flower' | 'moss' | 'vine';

/** What a plant can grow on (its host). Ground plants stand on terrain; the others are instanced onto other geometry. */
export type Host = 'ground' | 'bank' | 'rock' | 'wall' | 'cave';

/** Where a species grows, as ranges over the world's fields (each 0..1 unless noted). */
export interface Niche {
  /** the succession field (ecology.wgsl: 0 bare … 1.2 grass, 2.6 shrubs, 3.6+ woods) */
  veg: [number, number];
  moisture: [number, number];
  /** light at the ground: 1 open sky, low under canopy or in a cave */
  light: [number, number];
  /** altitude above the region's water (cells) */
  altitude: [number, number];
  /** steepest ground (rise per run) */
  slopeMax: number;
  hosts: Host[];
  /** its share where several fit (relative) */
  weight: number;
}

/** How a stand of it stops or slows things (the play track reads this through the contract: passability). */
export interface Barrier {
  /** 0..1 how much of a cell a mature plant fills at the height a walker moves through */
  fill: number;
  /** can it be cut through (a blade, fire, a heavy body)? */
  cuttable: boolean;
  /** at full density: the walking speed multiplier through it (1 = no effect) */
  slow: number;
  /** a heavy/fast controller (a charging knight, a wrecking ball) breaks through above this mass class (0..3) */
  breakMass: number;
}

export interface Colours {
  bark: RGB;
  /** birch: the dark marks on the white bark */
  barkMark?: RGB;
  leafDark: RGB;
  leafLight: RGB;
  /** the fall colour (deciduous) */
  autumn: RGB;
  flower?: RGB;
  accent?: RGB;
  deciduous: boolean;
}

export interface SpeciesDef {
  id: SpeciesId;
  name: string;
  form: PlantForm;
  /** height range of a mature plant (cells): variants are scaled into it */
  height: [number, number];
  lsystem?: LSystemSpec;
  turtle?: TurtleSpec;
  leaf?: LeafLook;
  roots?: RootSpec;
  colours: Colours;
  niche: Niche;
  barrier: Barrier;
  /** how far it bends in a wind relative to the others (grass 1.6, a giant 0.5) */
  sway: number;
  /** it lets its leaves go all year (a few), more in the fall and in a wind (falling leaves) */
  shedsLeaves: boolean;
}

const C = (r: number, g: number, b: number): RGB => [r, g, b];

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  // Silver birch (Betula pendula): a tall, slender white trunk with dark marks, bare low down, fine weeping twigs
  // carrying small diamond leaves; butter-yellow in the fall. Shallow, spreading roots. The showcase tree.
  birch: {
    id: 'birch',
    name: 'Silver birch',
    form: 'tree',
    height: [11, 17],
    lsystem: {
      axiom: 'FFFFA',
      rules: {
        A: [
          { s: 'F/[&&B]F/[&B]A', w: 0.6 },
          { s: 'F//[&&B]A', w: 0.4 },
        ],
        B: [
          { s: 'F[-C]F[+C]B', w: 0.45 },
          { s: 'F[+C]FB', w: 0.35 },
          { s: 'FC', w: 0.2 },
        ],
        C: [
          { s: 'F[&L][^L]L', w: 0.6 },
          { s: 'F[&L]L', w: 0.4 },
        ],
      },
      finals: { A: 'F[&C][^C]L', B: 'F[&L]L', C: 'L' },
      iterations: 7,
    },
    turtle: {
      step: 1.25,
      stepDecay: 0.6,
      radius: 0.3,
      radiusDecay: 0.42,
      taper: 0.93,
      angle: 34,
      roll: 137.5,
      jitter: 12,
      tropism: [0, 0, -1],
      tropismStrength: [0, 0.1, 0.42],
      minRadius: 0.012,
    },
    leaf: { style: 'drop', size: 0.46, per: 2, minDepth: 1 },
    roots: { half: 8, depth: 4, res: 0.3, generations: 12, growth: 0.5, down: 0.15, maxCells: 160, trunkRadius: 0.3 },
    colours: {
      bark: C(0.86, 0.85, 0.8),
      barkMark: C(0.16, 0.15, 0.14),
      leafDark: C(0.3, 0.47, 0.15),
      leafLight: C(0.6, 0.72, 0.3),
      autumn: C(0.92, 0.76, 0.22),
      deciduous: true,
    },
    niche: { veg: [3.2, 6], moisture: [0.25, 0.9], light: [0.5, 1], altitude: [1, 120], slopeMax: 0.9, hosts: ['ground'], weight: 1 },
    barrier: { fill: 0.08, cuttable: true, slow: 0.95, breakMass: 3 },
    sway: 1.1,
    shedsLeaves: true,
  },
  // A broadleaf (oak-like): a short stout trunk forking into a wide crown of leaf masses.
  oak: {
    id: 'oak',
    name: 'Broadleaf',
    form: 'tree',
    height: [6, 10],
    lsystem: {
      axiom: 'FFA',
      rules: {
        A: [
          { s: 'F[&&B]/[&&B]///[&&B]', w: 0.5 },
          { s: 'F[&&B]//[&&B]F[&B]', w: 0.5 },
        ],
        B: [
          { s: 'F[+B]F[-B]', w: 0.5 },
          { s: 'F[-B]/[+B]L', w: 0.3 },
          { s: 'FB', w: 0.2 },
        ],
      },
      finals: { A: 'L', B: 'FL' },
      iterations: 4,
    },
    turtle: {
      step: 1.4,
      stepDecay: 0.72,
      radius: 0.38,
      radiusDecay: 0.6,
      taper: 0.9,
      angle: 28,
      roll: 120,
      jitter: 14,
      tropism: [0, 0, 1],
      tropismStrength: [0, 0.06, 0.1],
      minRadius: 0.03,
    },
    leaf: { style: 'cluster', size: 0.95, per: 1, minDepth: 1 },
    roots: { half: 7, depth: 5, res: 0.35, generations: 10, growth: 0.5, down: 0.4, maxCells: 140, trunkRadius: 0.38 },
    colours: {
      bark: C(0.36, 0.27, 0.18),
      leafDark: C(0.13, 0.3, 0.1),
      leafLight: C(0.32, 0.53, 0.18),
      autumn: C(0.8, 0.36, 0.1),
      deciduous: true,
    },
    niche: { veg: [3.6, 6], moisture: [0.3, 0.85], light: [0.4, 1], altitude: [0, 80], slopeMax: 0.7, hosts: ['ground'], weight: 1 },
    barrier: { fill: 0.15, cuttable: true, slow: 0.9, breakMass: 3 },
    sway: 0.8,
    shedsLeaves: true,
  },
  // A conifer: a straight trunk with whorls of near-level branches, longest at the bottom (apical growth: the lower
  // whorls have been rewritten more often), drooping needle tufts.
  pine: {
    id: 'pine',
    name: 'Conifer',
    form: 'tree',
    height: [8, 14],
    lsystem: {
      axiom: 'FA',
      rules: {
        A: [
          { s: 'F[&&&W]/[&&&W]/[&&&W]/[&&&W]F/A', w: 0.7 },
          { s: 'F[&&&W]//[&&&W]//[&&&W]FA', w: 0.3 },
        ],
        W: [
          { s: 'F[L]W', w: 0.75 },
          { s: 'F[-L][+L]W', w: 0.25 },
        ],
      },
      finals: { A: 'FL', W: 'L' },
      iterations: 7,
    },
    turtle: {
      step: 0.75,
      stepDecay: 0.7,
      radius: 0.3,
      radiusDecay: 0.32,
      taper: 0.94,
      angle: 27,
      roll: 88,
      jitter: 8,
      tropism: [0, 0, -1],
      tropismStrength: [0, 0.08, 0.08],
      minRadius: 0.012,
    },
    leaf: { style: 'needles', size: 0.55, per: 1, minDepth: 1 },
    roots: { half: 6, depth: 6, res: 0.35, generations: 10, growth: 0.5, down: 0.6, maxCells: 120, trunkRadius: 0.3 },
    colours: {
      bark: C(0.3, 0.2, 0.14),
      leafDark: C(0.06, 0.18, 0.11),
      leafLight: C(0.16, 0.34, 0.2),
      autumn: C(0.16, 0.34, 0.2),
      deciduous: false,
    },
    niche: { veg: [3.6, 6], moisture: [0.1, 0.7], light: [0.3, 1], altitude: [10, 400], slopeMax: 1.3, hosts: ['ground'], weight: 1 },
    barrier: { fill: 0.25, cuttable: true, slow: 0.85, breakMass: 3 },
    sway: 0.7,
    shedsLeaves: false,
  },
  // The old giant: a thick, flaring trunk on buttress roots (the root automaton's surface roots shown), a broad,
  // high crown. Rare, in old woods.
  giant: {
    id: 'giant',
    name: 'Old giant',
    form: 'tree',
    height: [14, 20],
    lsystem: {
      axiom: 'FFFA',
      rules: {
        A: [
          { s: 'F[&&B]/[&&B]//[&&B]/[&B]', w: 0.6 },
          { s: 'F[&&B]///[&&B]F[&&B]', w: 0.4 },
        ],
        B: [
          { s: 'F[+B]F[-B]B', w: 0.4 },
          { s: 'F[-B]/[+B]L', w: 0.4 },
          { s: 'FFL', w: 0.2 },
        ],
      },
      finals: { A: 'L', B: 'FL' },
      iterations: 4,
    },
    turtle: {
      step: 2.2,
      stepDecay: 0.66,
      radius: 0.8,
      radiusDecay: 0.55,
      taper: 0.88,
      angle: 30,
      roll: 115,
      jitter: 15,
      tropism: [0, 0, 1],
      tropismStrength: [0, 0.04, 0.06],
      minRadius: 0.05,
    },
    leaf: { style: 'cluster', size: 1.5, per: 1, minDepth: 1 },
    roots: { half: 10, depth: 6, res: 0.45, generations: 14, growth: 0.55, down: 0.25, maxCells: 260, trunkRadius: 0.8 },
    colours: {
      bark: C(0.3, 0.25, 0.2),
      leafDark: C(0.1, 0.24, 0.09),
      leafLight: C(0.25, 0.43, 0.15),
      autumn: C(0.75, 0.45, 0.12),
      deciduous: true,
    },
    niche: { veg: [4.7, 6], moisture: [0.3, 0.9], light: [0.3, 1], altitude: [0, 60], slopeMax: 0.5, hosts: ['ground'], weight: 0.15 },
    barrier: { fill: 0.4, cuttable: false, slow: 0.8, breakMass: 4 },
    sway: 0.45,
    shedsLeaves: true,
  },
  // Understorey shrub: a dense, low dome of twigs and leaf clusters — the thicket that makes a soft barrier.
  shrub: {
    id: 'shrub',
    name: 'Thicket shrub',
    form: 'shrub',
    height: [1.4, 2.4],
    lsystem: {
      axiom: 'A',
      rules: {
        A: [{ s: '[&B]/[&B]/[&B]//[&B]', w: 1 }],
        B: [
          { s: 'F[+B][-B]L', w: 0.6 },
          { s: 'F[+B]L', w: 0.4 },
        ],
      },
      finals: { B: 'L' },
      iterations: 3,
    },
    turtle: {
      step: 0.55,
      stepDecay: 0.85,
      radius: 0.06,
      radiusDecay: 0.75,
      taper: 0.85,
      angle: 32,
      roll: 90,
      jitter: 18,
      tropism: [0, 0, 1],
      tropismStrength: [0.2, 0.12, 0.05],
      minRadius: 0.01,
    },
    leaf: { style: 'cluster', size: 0.42, per: 1, minDepth: 0 },
    colours: {
      bark: C(0.3, 0.22, 0.15),
      leafDark: C(0.12, 0.27, 0.1),
      leafLight: C(0.28, 0.46, 0.16),
      autumn: C(0.72, 0.3, 0.12),
      deciduous: true,
    },
    niche: { veg: [2.6, 4.6], moisture: [0.2, 0.9], light: [0.2, 1], altitude: [0, 200], slopeMax: 1.0, hosts: ['ground', 'bank'], weight: 1 },
    barrier: { fill: 0.7, cuttable: true, slow: 0.45, breakMass: 2 },
    sway: 1.0,
    shedsLeaves: false,
  },
  // Tall grass: a clump of long blades that bow and ripple in the wind ("Make tall grass that blows in the wind").
  tallgrass: {
    id: 'tallgrass',
    name: 'Tall grass',
    form: 'grass',
    height: [1.1, 1.8],
    colours: {
      bark: C(0.3, 0.4, 0.15),
      leafDark: C(0.22, 0.4, 0.12),
      leafLight: C(0.55, 0.7, 0.25),
      autumn: C(0.78, 0.66, 0.3),
      accent: C(0.75, 0.68, 0.45),
      deciduous: true,
    },
    niche: { veg: [1.4, 3.6], moisture: [0.15, 0.85], light: [0.5, 1], altitude: [0, 200], slopeMax: 0.8, hosts: ['ground', 'bank'], weight: 1 },
    barrier: { fill: 0.5, cuttable: true, slow: 0.8, breakMass: 1 },
    sway: 1.6,
    shedsLeaves: false,
  },
  // Reeds on the riverbanks (the user: "Add reeds"): tall straight stalks with cattail heads.
  reed: {
    id: 'reed',
    name: 'Reeds',
    form: 'reed',
    height: [2.0, 3.2],
    colours: {
      bark: C(0.4, 0.45, 0.2),
      leafDark: C(0.3, 0.42, 0.18),
      leafLight: C(0.55, 0.62, 0.3),
      autumn: C(0.72, 0.62, 0.36),
      accent: C(0.36, 0.22, 0.12),
      deciduous: true,
    },
    niche: { veg: [0.6, 4], moisture: [0.7, 1], light: [0.5, 1], altitude: [-1, 3], slopeMax: 0.6, hosts: ['bank'], weight: 1 },
    barrier: { fill: 0.6, cuttable: true, slow: 0.6, breakMass: 1 },
    sway: 1.3,
    shedsLeaves: false,
  },
  // Ferns: arching fronds — the shade plant, under canopy and in caves under light beams ("shade plants growing in
  // the borrowed light").
  fern: {
    id: 'fern',
    name: 'Fern',
    form: 'fern',
    height: [0.8, 1.4],
    lsystem: {
      axiom: '[&P]/[&P]/[&P]/[&P]/[&P]',
      rules: { P: [{ s: 'F[+L][-L]P', w: 1 }] },
      finals: { P: 'L' },
      iterations: 5,
    },
    turtle: {
      step: 0.22,
      stepDecay: 1,
      radius: 0.02,
      radiusDecay: 1,
      taper: 0.97,
      angle: 40,
      roll: 60,
      jitter: 10,
      tropism: [0, 0, -1],
      tropismStrength: [0.14, 0.14, 0.14],
      minRadius: 0.005,
    },
    leaf: { style: 'leaflet', size: 0.32, per: 1, minDepth: 0 },
    colours: {
      bark: C(0.2, 0.32, 0.1),
      leafDark: C(0.1, 0.3, 0.1),
      leafLight: C(0.3, 0.55, 0.2),
      autumn: C(0.6, 0.42, 0.16),
      deciduous: true,
    },
    niche: { veg: [2.0, 6], moisture: [0.4, 1], light: [0.05, 0.55], altitude: [-50, 200], slopeMax: 1.2, hosts: ['ground', 'cave', 'bank'], weight: 1 },
    barrier: { fill: 0.3, cuttable: true, slow: 0.9, breakMass: 0 },
    sway: 1.2,
    shedsLeaves: false,
  },
  // Wildflowers in the meadows.
  flower: {
    id: 'flower',
    name: 'Wildflower',
    form: 'flower',
    height: [0.5, 0.9],
    colours: {
      bark: C(0.25, 0.4, 0.15),
      leafDark: C(0.2, 0.38, 0.12),
      leafLight: C(0.4, 0.6, 0.2),
      autumn: C(0.6, 0.5, 0.25),
      flower: C(0.9, 0.85, 0.95),
      accent: C(0.95, 0.8, 0.2),
      deciduous: true,
    },
    niche: { veg: [1.6, 3.4], moisture: [0.2, 0.8], light: [0.6, 1], altitude: [0, 200], slopeMax: 0.8, hosts: ['ground'], weight: 0.3 },
    barrier: { fill: 0.05, cuttable: true, slow: 1, breakMass: 0 },
    sway: 1.4,
    shedsLeaves: false,
  },
  // Moss cushions on rock and ruins (instanced onto other geometry: "moss on rock").
  moss: {
    id: 'moss',
    name: 'Moss',
    form: 'moss',
    height: [0.15, 0.35],
    colours: {
      bark: C(0.2, 0.3, 0.1),
      leafDark: C(0.18, 0.32, 0.08),
      leafLight: C(0.42, 0.56, 0.16),
      autumn: C(0.42, 0.5, 0.16),
      deciduous: false,
    },
    niche: { veg: [0.5, 6], moisture: [0.35, 1], light: [0.05, 0.8], altitude: [-50, 300], slopeMax: 99, hosts: ['rock', 'wall', 'cave'], weight: 1 },
    barrier: { fill: 0, cuttable: true, slow: 1, breakMass: 0 },
    sway: 0,
    shedsLeaves: false,
  },
  // Ivy climbing walls and ruins (instanced onto other geometry: "vines on ruins"). Grows in the wall's plane (y, z),
  // its leaves standing off it (+x: the wall's outward normal).
  ivy: {
    id: 'ivy',
    name: 'Ivy',
    form: 'vine',
    height: [2.5, 5],
    lsystem: {
      axiom: 'A',
      rules: {
        A: [
          { s: 'F[+B]F[-B]A', w: 0.5 },
          { s: 'FL[-B]FA', w: 0.3 },
          { s: 'F[+B]LA', w: 0.2 },
        ],
        B: [
          { s: 'FL[+B]', w: 0.4 },
          { s: 'F[-L]FL', w: 0.6 },
        ],
      },
      finals: { A: 'L', B: 'L' },
      iterations: 6,
    },
    turtle: {
      step: 0.4,
      stepDecay: 0.9,
      radius: 0.05,
      radiusDecay: 0.8,
      taper: 0.97,
      angle: 40,
      roll: 0,
      jitter: 14,
      tropism: [0, 0, 1],
      tropismStrength: [0.05, 0.02, 0],
      minRadius: 0.01,
      planar: true,
    },
    leaf: { style: 'cluster', size: 0.32, per: 1, minDepth: 0 },
    colours: {
      bark: C(0.25, 0.2, 0.13),
      leafDark: C(0.08, 0.22, 0.08),
      leafLight: C(0.2, 0.4, 0.14),
      autumn: C(0.55, 0.15, 0.12),
      deciduous: false,
    },
    niche: { veg: [1.5, 6], moisture: [0.2, 1], light: [0.15, 1], altitude: [-10, 200], slopeMax: 99, hosts: ['wall', 'rock'], weight: 1 },
    barrier: { fill: 0, cuttable: true, slow: 1, breakMass: 0 },
    sway: 0.3,
    shedsLeaves: false,
  },
};

export const SPECIES_IDS = Object.keys(SPECIES) as SpeciesId[];
