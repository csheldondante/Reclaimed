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
import type { CrownLook, LeafLook, StemLook } from './mesh';
import type { RootSpec } from './roots';
import { TREE_SCALE } from './spacing';

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
  | 'ivy'
  | 'boulder';

export type PlantForm = 'tree' | 'shrub' | 'grass' | 'reed' | 'fern' | 'flower' | 'moss' | 'vine' | 'rock';

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
  /** (round 125) buttress roots flaring from the trunk's foot and sprawling over the ground (mesh.ts buildPlant) */
  flare?: Flare;
  /** (round 128, treegen) how its stems are extruded: sides, noise, knots (mesh.ts StemLook) — every woody plant */
  stem?: StemLook;
  /** (round 128) a broadleaf crown's sprays (mesh.ts CrownLook) in place of the 'cluster' leaves' blobs */
  crown?: CrownLook;
  /** (round 128) the bark's texture in the look (floralook.wgsl): colours.bark the base, colours.barkMark the marks */
  bark: BarkLook;
  /** (round 125) moss on the wood near the foot, on its upward faces, 0..1 (the accent colour) */
  moss?: number;
  /** (round 128) what grows on it (each 0..1, a density): lichens, moss on the limbs, epiphytic plants, vines, lines */
  epiphytes?: Epiphytes;
  /** (round 128) a deciduous crown's leaves kept through the winter, dead (0..1; an oak's or a beech's marcescent few) */
  winterLeaves?: number;
  /** (round 128) in flower (spring): the share of its leaf clusters that bloom, in colours.flower (0 / absent: none) */
  blossom?: number;
}

/**
 * (round 128, treegen) Epiphytes, each a density 0..1. Lichens and moss are drawn in the bark's look (patches, no
 * triangles); plants, vines and lines are geometry the generator adds (mesh part 9 the green ones, 10 the lines):
 *   lichen  pale grey-green and ochre crusts on the bark, anywhere
 *   moss    moss on the limbs' upper faces, all the way up (`moss` above is the foot's)
 *   plants  small ferns / bromeliad tufts in the forks of the trunk and limbs
 *   vines   climbers spiralling up the trunk, leafy
 *   lines   hanging lines from the limbs: lianas and Spanish-moss / old-man's-beard strands (the reading taken for
 *           "lines"; the other is guy-lines of web or rope — say if that was meant)
 */
export interface Epiphytes {
  lichen: number;
  moss: number;
  plants: number;
  vines: number;
  lines: number;
}

export const NO_EPIPHYTES: Epiphytes = { lichen: 0, moss: 0, plants: 0, vines: 0, lines: 0 };

/** Buttress roots (round 125), in the turtle's units (its trunk radius r): `count` fins, each leaving the trunk `rise`
 *  radii up, reaching the ground `reach` radii out, then sprawling `sprawl` radii further along it, thinning. */
export interface Flare {
  count: number;
  rise: number;
  reach: number;
  sprawl: number;
}

/**
 * (round 128, treegen) The bark's texture, drawn in world space by floralook.wgsl over the base colour (colours.bark)
 * with the mark colour (colours.barkMark). Each 0..1 unless noted; replaces round 125's two styles (lenticels/ridged).
 */
export interface BarkLook {
  /** long vertical furrows (ridged bark: oak, the elder), how deep they read, and how many a cell round */
  furrows: number;
  furrowFreq: number;
  /** plates (a pine's scaly bark): the cracks between them and the plates' own shades; their size (cells) */
  plates: number;
  plateSize: number;
  /** horizontal dashes (a birch's lenticels): their share, and how many a cell up */
  stripes: number;
  stripeFreq: number;
  /** value noise through the bark (streaks, warm patches) */
  roughness: number;
}

export const BARK_PLAIN: BarkLook = { furrows: 0, furrowFreq: 3, plates: 0, plateSize: 0.6, stripes: 0, stripeFreq: 7, roughness: 0.15 };

const C = (r: number, g: number, b: number): RGB => [r, g, b];
/** (round 128) a tree's height range: round 125's × TREE_SCALE (flora/spacing.ts) */
const tall = (a: number, b: number): [number, number] => [a * TREE_SCALE, b * TREE_SCALE];

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  // Silver birch (Betula pendula): a tall, slender white trunk with dark marks, bare low down, fine weeping twigs
  // carrying small diamond leaves; butter-yellow in the fall. Shallow, spreading roots. The showcase tree.
  birch: {
    id: 'birch',
    name: 'Silver birch',
    form: 'tree',
    // (round 125, forest: x1.5 — "trees much bigger relative to the player"; the trunk ~0.9 across, a villager's
    // width and a half, the lich's about)
    // (round 128, treegen: × TREE_SCALE — every tree twice as tall and its trunk twice as wide, a quarter as many)
    height: tall(17, 25),
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
      taperVar: 0.2,
      spacing: 1,
      stepVar: 0.1,
      twist: 0,
      kinkChance: 0.08,
      kinkAngle: 6,
    },
    leaf: { style: 'drop', size: 0.55, per: 3, minDepth: 1 },
    roots: { half: 8, depth: 4, res: 0.3, generations: 12, growth: 0.5, down: 0.15, maxCells: 160, trunkRadius: 0.3 },
    stem: { sides: 6, noise: 0.07, noiseFreq: 0.5, knots: 1.5, knotSize: 0.22, ring: 1.8 },
    bark: { furrows: 0, furrowFreq: 3, plates: 0, plateSize: 0.6, stripes: 0.2, stripeFreq: 7, roughness: 0.15 },
    epiphytes: { lichen: 0.2, moss: 0, plants: 0, vines: 0, lines: 0 },
    // (catkins: hanging ochre tassels before the leaves)
    blossom: 0.35,
    colours: {
      bark: C(0.86, 0.85, 0.8),
      barkMark: C(0.16, 0.15, 0.14),
      leafDark: C(0.3, 0.47, 0.15),
      leafLight: C(0.6, 0.72, 0.3),
      autumn: C(0.92, 0.76, 0.22),
      flower: C(0.86, 0.74, 0.3),
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
    height: tall(9, 15),
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
      taperVar: 0.25,
      spacing: 1,
      stepVar: 0.2,
      twist: 7,
      kinkChance: 0.3,
      kinkAngle: 16,
    },
    leaf: { style: 'cluster', size: 0.95, per: 1, minDepth: 1 },
    roots: { half: 7, depth: 5, res: 0.35, generations: 10, growth: 0.5, down: 0.4, maxCells: 140, trunkRadius: 0.38 },
    stem: { sides: 7, noise: 0.14, noiseFreq: 0.45, knots: 3, knotSize: 0.35, ring: 1.4 },
    crown: { size: 3, perTwig: 3, spacing: 1.1, fill: 0.8, leaves: 9, droop: 0.25 },
    bark: { furrows: 0.55, furrowFreq: 3.5, plates: 0.25, plateSize: 0.45, stripes: 0, stripeFreq: 7, roughness: 0.45 },
    epiphytes: { lichen: 0.35, moss: 0.3, plants: 0.2, vines: 0.25, lines: 0.1 },
    winterLeaves: 0.06,
    colours: {
      bark: C(0.36, 0.27, 0.18),
      barkMark: C(0.17, 0.12, 0.08),
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
    height: tall(12, 20),
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
      taperVar: 0.1,
      spacing: 1,
      stepVar: 0.1,
      twist: 0,
      kinkChance: 0.04,
      kinkAngle: 6,
    },
    leaf: { style: 'needles', size: 0.55, per: 1, minDepth: 1 },
    roots: { half: 6, depth: 6, res: 0.35, generations: 10, growth: 0.5, down: 0.6, maxCells: 120, trunkRadius: 0.3 },
    stem: { sides: 6, noise: 0.06, noiseFreq: 0.6, knots: 2, knotSize: 0.25, ring: 1.8 },
    bark: { furrows: 0.2, furrowFreq: 3, plates: 0.7, plateSize: 0.5, stripes: 0, stripeFreq: 7, roughness: 0.3 },
    epiphytes: { lichen: 0.3, moss: 0.1, plants: 0, vines: 0, lines: 0.25 },
    colours: {
      bark: C(0.42, 0.25, 0.16),
      barkMark: C(0.16, 0.1, 0.07),
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
  // The elder (round 125, forest; was "the old giant"): the reference's tree (docs/design/ref/forest-floor.png) — a
  // massive pale trunk, grey-white and ridged, on flaring buttress roots that sprawl over the floor, mossy at its foot;
  // a few great limbs forking into a broad, high crown of copper-red leaves that go orange in the fall. Its own woods
  // (flora/spacing.ts: the elder woods, one a 14 x 16 super-block) and, rarely, alone in old woods. Its trunk is
  // ~2.5 cells across: the lich (1 wide) is 0.4 of it, a villager a quarter — the user's "0.25-1 trunk width".
  giant: {
    id: 'giant',
    name: 'Elder',
    form: 'tree',
    height: tall(24, 32),
    lsystem: {
      // (a massive bole to the fork; three or four great limbs leaving it wide — near level — forking twice into a
      // broad, flat-topped crown, a leader carrying on up the middle)
      axiom: 'FFFFA',
      rules: {
        A: [
          { s: 'F[&&&B]//[&&&B]//[&&&B]', w: 0.5 },
          { s: 'F[&&&B]/[&&&B]//[&&B]//[&&&B]F[&L]L', w: 0.5 },
        ],
        B: [
          { s: 'FF[+C][-C]C', w: 0.5 },
          { s: 'F[-C]F[+C]C', w: 0.5 },
        ],
        // (round 128: the crown's twigs fork more often — a broad, full crown of many small sprays, main's review: "the
        // elder's crowns are flat red slabs")
        C: [
          { s: 'F[+C][-C][&L]L', w: 0.4 },
          { s: 'F[+C][&L]L', w: 0.3 },
          { s: 'F[-C][^L]L', w: 0.3 },
        ],
      },
      finals: { A: 'L', B: 'F[&L]L', C: 'L' },
      iterations: 5,
    },
    turtle: {
      step: 2.2,
      // (round 128: 0.72 → 0.84 and 26° → 32°: the crown's twigs longer and wider apart, so its sprays spread into a
      // broad crown instead of a ball at each limb's end)
      stepDecay: 0.84,
      radius: 1.55,
      radiusDecay: 0.55,
      taper: 0.95,
      angle: 32,
      roll: 115,
      jitter: 14,
      tropism: [0, 0, 1],
      tropismStrength: [0, 0.02, 0.06],
      minRadius: 0.05,
      taperVar: 0.2,
      spacing: 1,
      stepVar: 0.15,
      twist: 4,
      kinkChance: 0.2,
      kinkAngle: 12,
    },
    // (smaller clusters and more of them than the other trees': close up under the canopy a cluster is a few leaves'
    // worth of pixels, not a slab)
    leaf: { style: 'cluster', size: 1.3, per: 5, minDepth: 1 },
    roots: { half: 4, depth: 4, res: 0.45, generations: 10, growth: 0.6, down: 0.3, maxCells: 90, trunkRadius: 1.55 },
    // (hugging the bole's foot and tapering within a few cells — main's review: long sprawls read as logs on the floor)
    flare: { count: 6, rise: 1.8, reach: 1.7, sprawl: 0.7 },
    stem: { sides: 8, noise: 0.16, noiseFreq: 0.3, knots: 2.5, knotSize: 0.3, ring: 3.2 },
    crown: { size: 3.6, perTwig: 3, spacing: 1.3, fill: 0.85, leaves: 8, droop: 0.2 },
    bark: { furrows: 0.8, furrowFreq: 3, plates: 0, plateSize: 0.6, stripes: 0, stripeFreq: 7, roughness: 0.8 },
    epiphytes: { lichen: 0.3, moss: 0.3, plants: 0.35, vines: 0.3, lines: 0.15 },
    winterLeaves: 0.08,
    colours: {
      // (warm pale, the reference's beech: a grey-white with ochre in it)
      bark: C(0.84, 0.8, 0.72),
      barkMark: C(0.5, 0.47, 0.44),
      leafDark: C(0.42, 0.06, 0.05),
      leafLight: C(0.86, 0.24, 0.1),
      // (the fall: a deeper red-orange, so the wood stays the reference's red and orange, not all orange)
      autumn: C(0.93, 0.34, 0.09),
      accent: C(0.42, 0.46, 0.13),
      deciduous: true,
    },
    moss: 0.85,
    niche: { veg: [3.9, 6], moisture: [0.3, 0.9], light: [0.3, 1], altitude: [0, 80], slopeMax: 0.5, hosts: ['ground'], weight: 0.15 },
    barrier: { fill: 0.4, cuttable: false, slow: 0.8, breakMass: 4 },
    sway: 0.4,
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
      taperVar: 0.25,
      spacing: 1,
      stepVar: 0.25,
      twist: 0,
      kinkChance: 0.3,
      kinkAngle: 20,
    },
    leaf: { style: 'cluster', size: 0.42, per: 1, minDepth: 0 },
    stem: { sides: 4, noise: 0.1, noiseFreq: 1, knots: 0, knotSize: 0, ring: 1 },
    crown: { size: 0.55, perTwig: 2, spacing: 0.35, fill: 0.8, leaves: 4, droop: 0.15 },
    bark: BARK_PLAIN,
    epiphytes: { lichen: 0.1, moss: 0, plants: 0, vines: 0, lines: 0 },
    blossom: 0.45,
    colours: {
      bark: C(0.3, 0.22, 0.15),
      // (lighter than the trees': a thicket under the sun reads as bushes, not a dark carpet)
      leafDark: C(0.17, 0.33, 0.12),
      leafLight: C(0.38, 0.56, 0.2),
      autumn: C(0.72, 0.3, 0.12),
      flower: C(0.96, 0.9, 0.93),
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
    bark: BARK_PLAIN,
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
    bark: BARK_PLAIN,
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
    stem: { sides: 3, noise: 0, noiseFreq: 1, knots: 0, knotSize: 0, ring: 1 },
    bark: BARK_PLAIN,
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
    bark: BARK_PLAIN,
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
    bark: BARK_PLAIN,
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
  // (round 125, forest) A mossy boulder on the elder woods' floor — the reference's "mossy rocks": a few faceted lumps of
  // grey stone, moss on their tops (the accent colour). Not a plant, but dressed by the same placement and draw as the
  // floor's plants (vegprep.wgsl floraSmall), and a hard barrier where it stands.
  boulder: {
    id: 'boulder',
    name: 'Mossy boulder',
    form: 'rock',
    height: [0.7, 1.6],
    bark: { furrows: 0.8, furrowFreq: 3, plates: 0, plateSize: 0.6, stripes: 0, stripeFreq: 7, roughness: 0.8 },
    colours: {
      bark: C(0.5, 0.5, 0.5),
      barkMark: C(0.38, 0.38, 0.4),
      leafDark: C(0.3, 0.33, 0.12),
      leafLight: C(0.45, 0.5, 0.18),
      autumn: C(0.45, 0.5, 0.18),
      accent: C(0.4, 0.47, 0.14),
      deciduous: false,
    },
    moss: 1,
    niche: { veg: [3.6, 6], moisture: [0.2, 1], light: [0, 1], altitude: [-50, 300], slopeMax: 1, hosts: ['ground'], weight: 0.1 },
    barrier: { fill: 0.7, cuttable: false, slow: 0.3, breakMass: 4 },
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
    bark: BARK_PLAIN,
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
