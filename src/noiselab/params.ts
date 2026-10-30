// (round 111, BACKLOG TG1) The noise lab's parameters: a recipe is a stack of LAYERS layer slots and the lab's own
// settings, all numbers in one tuning registry (src/tune/registry.ts) — so the editor shell (ui/tunepanel.ts) gives
// it sliders, presets (saved in this browser, exported and imported as JSON, copied as a ?lab= link) and resets for
// free. A recipe is the registry's preset: the values that differ from the defaults.
//
// The layer contract (docs/ARCHITECTURE.md "The noise lab"): per column a state of eight floats — the height H,
// four masks M1..M4, the cave's floor CF and height CH (and one spare). The layers run in order; each makes a value
// v from its generator (sampled through its domain transform), shapes it, scales it (amp · s + offset) and applies
// it to its target with its op, weighted by its mask. Generators that need the whole map (slope, the JFA
// nearest-feature field) split the stack: the layers before them are evaluated over the map first.
//
// The GPU reads a layer's numbers in LAYER_KEYS order (lab.ts packs them; lab.wgsl gets the indices as consts made
// from this list, so the two can't drift apart).

import { Registry, type GroupSpec, type ParamSpec } from '../tune/registry';
import { MAT } from '../world/materials';

/** layer slots in a recipe */
export const LAYERS = 8;

export const GENS = ['constant', 'fbm (simplex-like)', 'ridge', 'billow', 'voronoi', 'mesas (grouped cells)', 'sdf shape', 'ramp (direction)', 'spires (cells)', 'height so far', 'slope (field)', 'jfa distance (field)', 'jfa ridges (field)', 'mask'] as const;
export const GEN = { constant: 0, fbm: 1, ridge: 2, billow: 3, voronoi: 4, mesas: 5, sdf: 6, ramp: 7, spires: 8, height: 9, slope: 10, jfa: 11, jfaRidge: 12, mask: 13 } as const;
/** generators that need the map evaluated up to them first (lab.ts splits the stack at each) */
export const FIELD_GENS: number[] = [GEN.slope, GEN.jfa, GEN.jfaRidge];
const NOISE_GENS: number[] = [GEN.fbm, GEN.ridge, GEN.billow, GEN.voronoi, GEN.mesas, GEN.spires, GEN.jfaRidge];
const OCT_GENS: number[] = [GEN.fbm, GEN.ridge, GEN.billow, GEN.jfaRidge];
const CELL_GENS: number[] = [GEN.voronoi, GEN.mesas, GEN.spires];

export const SHAPES = ['none', 'threshold', 'band (two thresholds)', 'abs', 'stairs', 'tiers (atlas cliff walls)', 'power', 'clamp 0..1', 'isoline distance (cells)'] as const;
export const SHAPE = { none: 0, threshold: 1, band: 2, abs: 3, stairs: 4, tiers: 5, power: 6, clamp: 7, isoDist: 8 } as const;
export const OPS = ['add', 'subtract', 'multiply', 'max', 'min', 'set (lerp by mask)', 'smooth max (sdf)', 'smooth min (sdf)'] as const;
export const OP = { add: 0, sub: 1, mul: 2, max: 3, min: 4, set: 5, smax: 6, smin: 7 } as const;
export const TARGETS = ['height', 'mask 1', 'mask 2', 'mask 3', 'mask 4', 'cave floor', 'cave height', 'carve (a gap, 2.5d)'] as const;
export const TARGET = { h: 0, m1: 1, m2: 2, m3: 3, m4: 4, cf: 5, ch: 6, carve: 7 } as const;
export const ZREFS = ['below the surface', 'absolute', 'over the sea'] as const;
export const ZREF = { surface: 0, abs: 1, sea: 2 } as const;
export const MASKS = ['none', 'mask 1', 'mask 2', 'mask 3', 'mask 4'] as const;
export const SOURCES = ['height', 'mask 1', 'mask 2', 'mask 3', 'mask 4'] as const;
export const XFORMS = ['none', 'grain (rotate, stretch)', 'radial (polar about the centre)'] as const;
export const XFORM = { none: 0, grain: 1, radial: 2 } as const;
/** a generator's mode: voronoi f1 / f2 / edge / cell value; mesas height / distance; sdf circle / box / ring / segment */
export const MODES = ['0: f1 · height · circle', '1: f2 · distance · box', '2: edge (f2−f1) · ring', '3: cell value · segment'] as const;

/** the materials a recipe paints with (index → MAT id) */
export const MATS: [string, number][] = [
  ['soil', MAT.Soil],
  ['sand', MAT.Sand],
  ['stone', MAT.Stone],
  ['sandstone', MAT.Sandstone],
  ['basalt', MAT.Basalt],
  ['snow', MAT.Snow],
  ['silt', MAT.Silt],
  ['rubble', MAT.Rubble],
  ['obsidian', MAT.Obsidian],
  ['quartz', MAT.Quartz],
  ['ice', MAT.Ice],
];
const MAT_NAMES = MATS.map((m) => m[0]);
const matIdx = (name: string) => MAT_NAMES.indexOf(name);

/** a layer's numbers, in the order the GPU reads them */
export const LAYER_KEYS = [
  'on', 'gen', 'mode', 'xform', 'scale', 'oct', 'angle', 'stretch', 'warp', 'cx', 'cy', 'size', 'size2', 'spokes',
  'jitter', 'share', 'share2', 'blend', 'radius', 'cellQ', 'src', 'level', 'shape', 'lo', 'hi', 'soft', 'steps',
  'amp', 'offset', 'op', 'k', 'target', 'mask', 'maskInv', 'seed',
  // (round 112) a carve layer's gap profile; `mute` is the stack's enable (packLayers turns a muted layer off)
  'kq', 'up', 'down', 'roofN', 'floorN', 'nScale', 'zRef', 'zOff', 'coast', 'seaZ', 'wob', 'open', 'mute',
] as const;
export type LayerKey = (typeof LAYER_KEYS)[number];
/** floats a layer (LAYER_KEYS padded to a vec4) */
export const LAYER_FLOATS = Math.ceil(LAYER_KEYS.length / 4) * 4;

/** the map is 256 × 256 cells: 256 × 222 world units (rows ROW_H apart) */
const CX = 128;
const CY = 111;

const layerSpec = (n: number): Record<LayerKey, ParamSpec> => ({
  on: { label: 'on', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['off', 'on'] },
  gen: { label: 'generator', units: '', min: 0, max: GENS.length - 1, step: 1, def: GEN.fbm, choices: [...GENS] },
  mode: { label: 'mode', units: '', min: 0, max: 3, step: 1, def: 0, choices: [...MODES], help: 'voronoi: f1 / f2 / edge / cell value; mesas: height (edges blended) / distance into the group; sdf: circle / box / ring / segment' },
  xform: { label: 'domain', units: '', min: 0, max: XFORMS.length - 1, step: 1, def: 0, choices: [...XFORMS], help: 'grain: rotate and stretch (bumps become ridges along a grain); radial: noise in polar coordinates about the centre' },
  scale: { label: 'scale', units: 'cells', min: 2, max: 1024, step: 1, def: 64, help: 'feature size (a voronoi cell, a noise lattice cell)' },
  oct: { label: 'octaves', units: '', min: 1, max: 8, step: 1, def: 4 },
  angle: { label: 'angle', units: '°', min: -180, max: 180, step: 1, def: 0, help: 'the grain\'s, the ramp\'s or the shape\'s direction' },
  stretch: { label: 'stretch', units: '×', min: 1, max: 16, step: 0.1, def: 1, help: 'grain: features this many times longer along the angle; jfa ridges: how much less they vary across the isolines' },
  warp: { label: 'warp', units: '× scale', min: 0, max: 2, step: 0.01, def: 0, help: 'domain warp by a low noise, a share of the scale' },
  cx: { label: 'centre x', units: 'world', min: -256, max: 512, step: 1, def: CX },
  cy: { label: 'centre y', units: 'world', min: -256, max: 512, step: 1, def: CY },
  size: { label: 'size', units: 'cells', min: 1, max: 512, step: 1, def: 48, help: 'sdf: radius / half width; mesas: the grouping noise\'s scale' },
  size2: { label: 'size 2', units: 'cells', min: 0, max: 512, step: 1, def: 24, help: 'sdf: box half height / ring thickness / segment length' },
  spokes: { label: 'spokes', units: '', min: 1, max: 64, step: 1, def: 8, help: 'radial: lattice cells round a turn' },
  jitter: { label: 'jitter', units: '', min: 0, max: 1, step: 0.01, def: 0.9 },
  share: { label: 'share', units: '', min: 0, max: 1, step: 0.01, def: 0.4, help: 'mesas: share of cells in a group; spires: share of cells with a spire' },
  share2: { label: 'ramp share', units: '', min: 0, max: 1, step: 0.01, def: 0.35, help: 'mesas: share of a group\'s outer edges that blend down to the ground (the rest are walls)' },
  blend: { label: 'blend', units: 'cells', min: 0, max: 256, step: 1, def: 40, help: 'mesas: how far in from a ramp edge the height reaches the top' },
  radius: { label: 'radius', units: '× cell', min: 0.02, max: 0.7, step: 0.01, def: 0.3, help: 'spires: a spire\'s radius, a share of the cell' },
  cellQ: { label: 'cells (quantize)', units: 'cells', min: 0, max: 128, step: 1, def: 0, help: 'sample at the nearest voronoi site this far apart: flat blocks (0: off)' },
  src: { label: 'source', units: '', min: 0, max: SOURCES.length - 1, step: 1, def: 0, choices: [...SOURCES], help: 'jfa: the field whose contour is the feature; mask: the slot read' },
  level: { label: 'contour', units: '', min: -64, max: 256, step: 0.1, def: 0.5, help: 'jfa: the source\'s level the feature lies at' },
  shape: { label: 'shape', units: '', min: 0, max: SHAPES.length - 1, step: 1, def: 0, choices: [...SHAPES] },
  lo: { label: 'lo', units: '', min: -256, max: 256, step: 0.01, def: 0, help: 'threshold / band low / stairs from / tiers: where the walls start (cells) / power: the exponent / isoline distance: the level' },
  hi: { label: 'hi', units: '', min: -256, max: 256, step: 0.01, def: 1, help: 'band high / stairs to / tiers: the ledges\' width (cells)' },
  soft: { label: 'soft', units: '', min: 0, max: 64, step: 0.01, def: 0.05, help: 'thresholds\' half width; tiers: the walls\' half width (cells)' },
  steps: { label: 'steps', units: '', min: 1, max: 16, step: 1, def: 4, help: 'stairs: steps; tiers: walls (up to 6)' },
  amp: { label: 'amplitude', units: 'cells', min: -256, max: 256, step: 0.1, def: 16, help: 'the shaped value times this (a carve: its distance from the axis, so 1 for a distance in cells)' },
  offset: { label: 'offset', units: 'cells', min: -256, max: 256, step: 0.1, def: 0 },
  op: { label: 'op', units: '', min: 0, max: OPS.length - 1, step: 1, def: 0, choices: [...OPS] },
  k: { label: 'smooth k', units: 'cells', min: 0.01, max: 64, step: 0.01, def: 6, help: 'smooth max / min: the blend\'s width' },
  target: { label: 'target', units: '', min: 0, max: TARGETS.length - 1, step: 1, def: 0, choices: [...TARGETS] },
  mask: { label: 'mask', units: '', min: 0, max: MASKS.length - 1, step: 1, def: 0, choices: [...MASKS], help: 'the op weighted by this slot (clamped 0..1)' },
  maskInv: { label: 'invert mask', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['no', 'yes'] },
  seed: { label: 'seed', units: '', min: 0, max: 999, step: 1, def: n * 7 },
  // (round 112, TG10; the user: "Take a simplex fractal noise in 2d and set a threshold so that they are windy ... For
  // the cave shape just use JFA and take distance form the edge squared or something with noise and make noise lower
  // on the floor so it is walkable") a carve: the layer's value (amp · shape + offset) is the column's distance d into
  // the passage from its edge (cells; a JFA distance off a band mask; none where d <= 0). The column gets a gap about
  // a base height: floor = base - floor depth + floor noise, roof = base + min(curve · d², vault) + roof noise. The base:
  // from its reference, brought to the sea where the mouths mask is 1, plus the base noise.
  kq: { label: 'roof curve', units: '1/cell', min: 0, max: 4, step: 0.01, def: 0.35, help: 'carve: the roof rises curve · d² over the base, d the distance in from the passage edge' },
  up: { label: 'vault', units: 'cells', min: 0, max: 48, step: 0.5, def: 6, help: 'carve: the roof at most this far over the base' },
  down: { label: 'floor depth', units: 'cells', min: 0, max: 24, step: 0.5, def: 0.5, help: 'carve: the floor this far under the base' },
  roofN: { label: 'roof noise', units: 'cells', min: 0, max: 16, step: 0.1, def: 1.5, help: 'carve: the roof moved up and down by a noise this much' },
  floorN: { label: 'floor noise', units: 'cells', min: 0, max: 8, step: 0.1, def: 0.3, help: 'carve: the floor by a noise this much (keep it small: walkable)' },
  nScale: { label: 'noise scale', units: 'cells', min: 2, max: 128, step: 1, def: 12, help: 'carve: the feature size of the roof, floor and base noises' },
  zRef: { label: 'base from', units: '', min: 0, max: ZREFS.length - 1, step: 1, def: ZREF.surface, choices: [...ZREFS], help: 'carve: the height the base is measured from (inland)' },
  zOff: { label: 'base', units: 'cells', min: -128, max: 128, step: 0.5, def: -8, help: 'carve: the base this far over its reference (below the surface: negative)' },
  coast: { label: 'sea mouths by', units: '', min: 0, max: MASKS.length - 1, step: 1, def: 0, choices: [...MASKS], help: 'carve: where this mask is 1 the base is brought to the sea (blended by it): the cliff foot at the beach' },
  seaZ: { label: 'mouth over sea', units: 'cells', min: -16, max: 32, step: 0.5, def: 0, help: 'carve: the base this far over the sea where the mouths mask is 1' },
  wob: { label: 'base noise', units: 'cells', min: 0, max: 16, step: 0.1, def: 1.5, help: 'carve: a noise moves the base up and down by this much' },
  open: { label: 'thin roof', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['cut through (mouths, skylights)', 'keep the ground (no gap)'], help: 'carve: a gap whose roof is thinner than the lab cave roof either opens to the sky or is not cut' },
  mute: { label: 'muted', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['no', 'yes'], help: 'the stack keeps the layer but skips it' },
});

const LAB: Record<string, ParamSpec> = {
  seed: { label: 'seed', units: '', min: 0, max: 9999, step: 1, def: 1, help: 'added to every layer\'s seed' },
  base: { label: 'base height', units: 'cells', min: 0, max: 120, step: 0.5, def: 8, help: 'the height before the first layer' },
  sea: { label: 'sea level', units: 'cells', min: 0, max: 100, step: 0.5, def: 12, help: 'water stands to here (0: no sea)' },
  soil: { label: 'soil depth', units: 'cells', min: 0, max: 6, step: 1, def: 2, help: 'the top material this deep over the rock' },
  topMat: { label: 'top', units: '', min: 0, max: MATS.length - 1, step: 1, def: matIdx('soil'), choices: MAT_NAMES },
  rockMat: { label: 'rock', units: '', min: 0, max: MATS.length - 1, step: 1, def: matIdx('stone'), choices: MAT_NAMES },
  cliffMat: { label: 'cliff face', units: '', min: 0, max: MATS.length - 1, step: 1, def: matIdx('stone'), choices: MAT_NAMES, help: 'where the slope is steeper than the cliff slope: rock to the top' },
  bandMat: { label: 'band', units: '', min: 0, max: MATS.length - 1, step: 1, def: matIdx('sandstone'), choices: MAT_NAMES, help: 'the rock\'s strata alternate with this' },
  bandH: { label: 'band height', units: 'cells', min: 0, max: 16, step: 1, def: 0, help: 'strata this thick (0: none)' },
  cliffSlope: { label: 'cliff slope', units: 'rise/run', min: 0.2, max: 6, step: 0.05, def: 1.4 },
  beachMat: { label: 'shore', units: '', min: 0, max: MATS.length - 1, step: 1, def: matIdx('sand'), choices: MAT_NAMES },
  beachH: { label: 'shore height', units: 'cells', min: 0, max: 8, step: 0.1, def: 1.5, help: 'land this little over the sea is shore' },
  snowZ: { label: 'snow line', units: 'cells', min: 10, max: 128, step: 1, def: 128, help: 'tops above it snow (128: none)' },
  paintMat: { label: 'mask 4 paints', units: '', min: 0, max: MATS.length - 1, step: 1, def: matIdx('rubble'), choices: MAT_NAMES, help: 'where mask 4 is over ½, the top is this' },
  paint: { label: 'paint by mask 4', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['off', 'on'] },
  caveRoof: { label: 'cave roof', units: 'cells', min: 1, max: 16, step: 0.5, def: 3, help: 'rock kept over a cave (or it isn\'t cut)' },
  caveMin: { label: 'cave min', units: 'cells', min: 1, max: 8, step: 0.5, def: 2, help: 'a cave lower than this isn\'t cut' },
  view: { label: 'view scale', units: '×', min: 0.25, max: 8, step: 0.05, def: 1, help: 'sample the recipe this many times wider (heights unscaled): see more of it' },
  live: { label: 'world follows', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['on release', 'live'], help: 'when the world is rewritten: when a slider is let go, or while it moves' },
};

const SPEC: Record<string, GroupSpec> = { lab: { title: 'Lab (materials, sea, caves)', owner: 'noiselab/lab.wgsl labFinish + noiselab/columns.ts', params: LAB } };
for (let i = 0; i < LAYERS; i++) SPEC[`L${i + 1}`] = { title: `Layer ${i + 1}`, owner: 'noiselab/lab.wgsl labEval', params: layerSpec(i + 1) };

export const LAB_TUNING = new Registry(SPEC);
export type LabValues = Record<string, Record<string, number>>;
export const labValues = () => LAB_TUNING.values as unknown as LabValues;

const CARVE_KEYS: LayerKey[] = ['kq', 'up', 'down', 'roofN', 'floorN', 'nScale', 'zRef', 'zOff', 'coast', 'seaZ', 'wob', 'open'];

/** which parameters the editor shows for a layer's current generator, shape, op and mask (the rest have no effect) */
export function labVisible(group: string, key: string): boolean {
  if (group === 'lab') return true;
  const L = labValues()[group];
  if (key === 'on') return true;
  if (!L.on) return key === 'gen';
  const g = L.gen;
  const noise = NOISE_GENS.includes(g);
  const carve = L.target === TARGET.carve;
  if (key === 'mute') return false;
  if (CARVE_KEYS.includes(key as LayerKey)) return carve && (key !== 'seaZ' || L.coast > 0);
  if (carve && key === 'op') return false;
  switch (key as LayerKey) {
    case 'gen':
    case 'shape':
    case 'amp':
    case 'offset':
    case 'op':
    case 'target':
    case 'mask':
      return true;
    case 'mode':
      return g === GEN.voronoi || g === GEN.mesas || g === GEN.sdf;
    case 'xform':
    case 'seed':
      return noise;
    case 'scale':
      return noise || g === GEN.ramp || (g === GEN.sdf && L.warp > 0);
    case 'oct':
      return OCT_GENS.includes(g);
    case 'angle':
      return (noise && L.xform === XFORM.grain) || g === GEN.ramp || g === GEN.sdf;
    case 'stretch':
      return (noise && L.xform === XFORM.grain) || g === GEN.jfaRidge;
    case 'warp':
      return noise || g === GEN.sdf;
    case 'cx':
    case 'cy':
      return (noise && L.xform === XFORM.radial) || g === GEN.ramp || g === GEN.sdf;
    case 'spokes':
      return noise && L.xform === XFORM.radial;
    case 'size':
      return g === GEN.sdf || g === GEN.mesas;
    case 'size2':
      return g === GEN.sdf && L.mode > 0;
    case 'jitter':
      return CELL_GENS.includes(g);
    case 'share':
      return g === GEN.mesas || g === GEN.spires;
    case 'share2':
    case 'blend':
      return g === GEN.mesas && L.mode === 0;
    case 'radius':
      return g === GEN.spires;
    case 'cellQ':
      return g !== GEN.height && g !== GEN.mask && !FIELD_GENS.includes(g) && g !== GEN.constant;
    case 'src':
      return g === GEN.mask || g === GEN.jfa || g === GEN.jfaRidge;
    case 'level':
      return g === GEN.jfa || g === GEN.jfaRidge;
    case 'lo':
      return L.shape !== SHAPE.none && L.shape !== SHAPE.abs && L.shape !== SHAPE.clamp;
    case 'hi':
      return L.shape === SHAPE.band || L.shape === SHAPE.stairs || L.shape === SHAPE.tiers;
    case 'soft':
      return L.shape === SHAPE.threshold || L.shape === SHAPE.band || L.shape === SHAPE.tiers;
    case 'steps':
      return L.shape === SHAPE.stairs || L.shape === SHAPE.tiers;
    case 'k':
      return L.op === OP.smax || L.op === OP.smin;
    case 'maskInv':
      return L.mask > 0;
  }
  return true;
}

/** the WGSL consts of the layer's float indices (prepended to lab.wgsl) */
export function layerWgsl(): string {
  const lines = LAYER_KEYS.map((k, i) => `const LK_${k.toUpperCase()}: u32 = ${i}u;`);
  lines.push(`const LAYER_FLOATS: u32 = ${LAYER_FLOATS}u;`, `const LAYERS: u32 = ${LAYERS}u;`);
  return lines.join('\n') + '\n';
}

/** the recipe's layers, packed for the GPU (LAYER_FLOATS a layer, LAYER_KEYS order) */
export function packLayers(v: LabValues = labValues()): Float32Array {
  const f = new Float32Array(LAYERS * LAYER_FLOATS);
  for (let i = 0; i < LAYERS; i++) {
    const L = v[`L${i + 1}`];
    LAYER_KEYS.forEach((k, j) => (f[i * LAYER_FLOATS + j] = L[k]));
    if (L.mute) f[i * LAYER_FLOATS] = 0;
  }
  return f;
}

export const matOf = (i: number) => MATS[Math.max(0, Math.min(MATS.length - 1, Math.round(i)))][1];
