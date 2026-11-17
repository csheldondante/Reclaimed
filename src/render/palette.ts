// (loop round 17, LS-151; DECISIONS 2026-11-17 "tuning colors and brightness so certain layers reserve some colors and
// are more visible") Colours by layer: the one table.
//
// Two layers share the screen. The town and the ground (walls, roofs, paving, parks) are calm: muted, a little dark,
// nothing in them as bright as a figure. The figures (townsfolk, soldiers, foes, the messenger and named people, carts,
// wagons, ships, horses) draw from paints of their own — hues the town does not use and the brightest values in the
// scene, lifted a little in shade (render/bodies.wgsl fsBody).
//
// A figure paint is a body voxel's material byte at FIG_BASE + k: past the material table (world/materials.ts, under
// 64), so every figure path that writes a material (routes.wgsl riders, units.wgsl units and kind models) writes a
// paint the same way. Reserved: the foes' red (FOE) is used by nothing else; the mark (MARK) only by the messenger and
// the named people of a petition.
//
// WGSL: figureWgsl() (consts P_* and the paints' colours, fsBody's FIG_PAINT) is put in front of the draw shader, the
// living town's figures and the units' draw; townWgsl() (the town's tones) in front of citygen's streets.

/** the first figure paint's material byte */
export const FIG_BASE = 224;

/** the figure paints, sRGB 0–1, in order (their byte FIG_BASE + index) */
const PAINTS = [
  // townsfolk: a few warm cloths, one per person (by the person's index)
  ['CLOTH0', [1.0, 0.8, 0.16]], // saffron
  ['CLOTH1', [1.0, 0.5, 0.1]], // orange
  ['CLOTH2', [0.98, 0.44, 0.68]], // rose
  ['CLOTH3', [0.66, 0.5, 1.0]], // violet
  ['SKIN', [1.0, 0.8, 0.64]],
  ['DARK', [0.15, 0.13, 0.12]], // legs, wheels, a mane
  ['STEEL', [0.76, 0.88, 1.0]], // soldiers and guards
  ['FOE', [1.0, 0.08, 0.04]], // foes only
  ['MARK', [0.1, 1.0, 0.92]], // the messenger, named people
  ['CART', [0.72, 0.46, 0.22]], // a cart's or wagon's bed
  ['LOAD', [1.0, 0.95, 0.82]], // a wagon's canvas
  ['HULL', [0.5, 0.3, 0.14]],
  ['SAIL', [1.0, 1.0, 0.97]],
  ['HORSE', [0.58, 0.33, 0.15]],
] as const;

export type Paint = (typeof PAINTS)[number][0];
/** a paint's material byte: FIG.FOE, FIG.CLOTH0 … */
export const FIG = Object.fromEntries(PAINTS.map(([n], i) => [n, FIG_BASE + i])) as Record<Paint, number>;
/** the townsfolk's cloths: CLOTH0 .. CLOTH0 + CLOTHS − 1 */
export const CLOTHS = 4;
/** a figure's light: its lit colour × GAIN plus its albedo × LIFT (a figure in shade still reads) */
export const FIGURE_LIGHT = { gain: 1.15, lift: 0.3 } as const;

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** the figure paints for WGSL: P_<name> material bytes, FIG_BASE, FIG_N, CLOTHS, and fsBody's colour table */
export function figureWgsl(): string {
  const consts = PAINTS.map(([n], i) => `const FP_${n}: u32 = ${FIG_BASE + i}u;`).join('\n');
  const cols = PAINTS.map(([, c]) => `vec3<f32>(${c.map(f).join(', ')})`).join(', ');
  return `// (render/palette.ts, generated) the figure paints
const FIG_BASE: u32 = ${FIG_BASE}u;
const FIG_N: u32 = ${PAINTS.length}u;
const CLOTHS: u32 = ${CLOTHS}u;
${consts}
const FIG_PAINT = array<vec3<f32>, ${PAINTS.length}>(${cols});
const FIG_GAIN: f32 = ${f(FIGURE_LIGHT.gain)};
const FIG_LIFT: f32 = ${f(FIGURE_LIGHT.lift)};
`;
}

/** the town's tones (citygen's colour words 0xrrggbb): calm, a little dark, unsaturated — under every figure paint */
export const TOWN = {
  /** walls (was a near-white plaster 0xf3eee6) */
  wall: 0xbdb3a3,
  /** roofs by a lot's seed: muted earths and slates (were pastels 0xf6c6a8 …) — no red near the foes' */
  roofs: [0x9a6e5c, 0x9a8c62, 0x66758a, 0x84697a, 0x6f7f62, 0x7a7290],
  park: 0x76935c,
  landmark: 0x9a8cae,
  /** the roads' tones (ROAD_TONES: 1 dirt, 2 stone, 3 paving — the game's) */
  roadTones: { 1: [0.55, 0.47, 0.38], 2: [0.52, 0.5, 0.47], 3: [0.58, 0.55, 0.49] } as Record<number, [number, number, number]>,
} as const;

const hex = (c: number): string => `0x${c.toString(16).padStart(6, '0')}u`;

/** the town's tones for citygen's streets.wgsl: C_WALL, C_PARK, C_LANDMARK, roofColour */
export function townWgsl(): string {
  const cases = TOWN.roofs
    .slice(0, -1)
    .map((c, i) => `    case ${i}u: { return ${hex(c)}; }`)
    .join('\n');
  return `// (render/palette.ts, generated) the town's tones
const C_WALL: u32 = ${hex(TOWN.wall)};
const C_PARK: u32 = ${hex(TOWN.park)};
const C_LANDMARK: u32 = ${hex(TOWN.landmark)};
fn roofColour(k: u32) -> u32 {
  switch (k) {
${cases}
    default: { return ${hex(TOWN.roofs[TOWN.roofs.length - 1])}; }
  }
}
`;
}
