// (citygen M4a) The town generator's parameters — one table, the street lab's panel and the game's towns: what each
// is, its range and default, and the stage a change reruns from (citygen/gpu.ts STAGES). The lab's panel adds its own
// controls (the site, the camera, taps); the game takes the defaults with the town's own inputs (its radius, seed).
import type { ParamSpec } from '../tune/registry';
import { AUTO, BAD, CROSS, FIELDS, LANDMARKS, MAJORS, MIN_BLOCK, SHAPES, type Stage, type StreetParams } from './gpu';

export type CitySpec = ParamSpec & { stage: Stage | 'camera' | 'point' | 'site' | 'arterials' | 'none' };
export const CITY_PARAMS: Record<string, CitySpec> = {
  majors: { label: 'major lines', units: '', min: 0, max: MAJORS.length - 1, step: 1, def: 1, choices: [...MAJORS], stage: 'phi' },
  cross: { label: 'cross streets', units: '', min: 0, max: CROSS.length - 1, step: 1, def: 0, choices: [...CROSS], stage: 'phi' },
  field: { label: 'distance field', units: '', min: 0, max: FIELDS.length - 1, step: 1, def: 1, choices: [...FIELDS], help: 'blurring the mask, not the distance, keeps the contours evenly spaced at the creases', stage: 'field' },
  maskR: { label: 'mask smoothing', units: 'cells', min: 1, max: 10, step: 1, def: 3, help: 'the water/cliff mask’s blur radius (two passes) before the threshold', stage: 'field' },
  grown: { label: 'cross streets made', units: '', min: 0, max: 1, step: 1, def: 1, choices: ['paired per strip (old)', 'grown line by line'], help: 'grown: each street climbs on across the lines; too near another it ends at a T; where they spread, a new one starts', stage: 'trace' },
  lmTopK: { label: 'landmark sites kept', units: '', min: 1, max: 16, step: 1, def: 2, help: 'only the busiest, most acute junctions', stage: 'trace' },
  city: { label: 'supercells', units: '', min: 0, max: 1, step: 1, def: 1, choices: ['off (m3g)', 'on'], help: 'large cells that decide the city’s limit (whole blocks), its empty districts and its growth', stage: 'trace' },
  limit: { label: 'growth budget', units: '× radius', min: 0.2, max: 2, step: 0.05, def: 0.9, help: 'a supercell is in while its cost distance from the centres (slopes and water dear, roads and shores cheap, each cell its own factor) is under this', stage: 'trace' },
  limitNoise: { label: 'budget noise', units: '±', min: 0, max: 0.8, step: 0.05, def: 0.35, help: 'low-frequency noise on each supercell’s budget', stage: 'trace' },
  scSize: { label: 'supercell size', units: 'blocks', min: 2, max: 8, step: 0.25, def: 3, stage: 'trace' },
  emptyFrac: { label: 'empty districts', units: 'share', min: 0, max: 0.8, step: 0.05, def: 0.2, help: 'supercells left empty (their major roads and arterials stay); never at a centre or the edge', stage: 'trace' },
  citySeed: { label: 'city seed', units: '', min: 0, max: 99, step: 1, def: 1, stage: 'trace' },
  growth: { label: 'city growth', units: '0–1', min: 0, max: 1, step: 0.01, def: 1, help: 'blocks show out from the centres as this grows (each block’s key kept on the GPU)', stage: 'lots' },
  tint: { label: 'district tint', units: '', min: 0, max: 1, step: 1, def: 0, choices: ['off', 'on'], stage: 'mesh' },
  scale: { label: 'city scale', units: '×', min: 0.5, max: 2.5, step: 0.05, def: 1, help: 'contour spacing and block length × this, lot areas × its square: bigger reads bigger', stage: 'phi' },
  bad: { label: 'bad cells →', units: '', min: 0, max: BAD.length - 1, step: 1, def: 0, choices: [...BAD], help: 'a sliver or thin triangle (an angle under 25°, too thin, under the merge area): joined to its neighbour across its longer cross street, or paved', stage: 'trace' },
  lmMult: { label: 'landmark sites', units: '×', min: 0, max: 2, step: 0.05, def: 1, help: 'round plots at the busy junctions (their radius ×; 0 none): the fans’ streets end at a ring road round them', stage: 'trace' },
  lmKind: { label: 'landmark sites →', units: '', min: 0, max: LANDMARKS.length - 1, step: 1, def: 0, choices: [...LANDMARKS], stage: 'trace' },
  lmN: { label: 'busy junction: streets', units: '', min: 2, max: 8, step: 1, def: 4, help: 'cross streets ending at one point that make it busy (or two meeting under 30°)', stage: 'trace' },
  lmRmin: { label: 'landmark radius min', units: 'cells', min: 2, max: 40, step: 0.5, def: 7, stage: 'trace' },
  lmRmax: { label: 'landmark radius max', units: 'cells', min: 4, max: 60, step: 0.5, def: 16, help: 'r = block length / the smallest angle between its streets, between these', stage: 'trace' },
  artWidth: { label: 'arterial width', units: 'cells', min: 1, max: 12, step: 0.1, def: 3.2, help: 'the approach roads, centre to edge', stage: 'mesh' },
  hRatio: { label: 'height to plot', units: '× side', min: 0, max: 2, step: 0.05, def: 0.7, help: 'a building no taller than this × its plot’s shortest side (a storey at least, the storeys’ most at most), so the streets stay in sight at 60°; 0: storeys × 0.7–1.3', stage: 'mesh' },
  deckClear: { label: 'deck clearance', units: 'cells', min: 0, max: 8, step: 0.25, def: 1, help: 'a bridge deck’s height over each bank (it slopes between them): at most a walker’s step (1.1) so the deck is walkable', stage: 'field' },
  maxSpan: { label: 'longest bridge', units: 'cells', min: 8, max: 240, step: 2, def: 120, help: 'a crossing longer than this ends the approach road at the shore', stage: 'field' },
  roadTone: { label: 'road tone', units: '', min: 0, max: 2, step: 1, def: 1, choices: ['white (old)', 'dirt', 'stone'], help: 'dirt or stone, a little lighter than the ground (the game: dirt for small towns, stone for big)', stage: 'mesh' },
  marks: { label: 'point markers', units: '', min: 0, max: 1, step: 1, def: 1, choices: ['hidden', 'shown'], help: 'the φ points as red markers (the game hides them)', stage: 'mesh' },
  majorSpacing: { label: 'contour spacing', units: 'cells', min: 12, max: 120, step: 1, def: 28, help: 'between the major lines (φ’s level sets)', stage: 'phi' },
  blend: { label: 'blend width', units: 'cells', min: 0, max: 40, step: 1, def: 12, help: 'the smooth min’s k: how softly a point’s rings join the contours', stage: 'phi' },
  pointR: { label: 'point radius', units: 'cells', min: 8, max: 120, step: 1, def: 40, help: 'beyond this (× the point’s intensity) a point has no effect', stage: 'phi' },
  strength: { label: 'point strength', units: '×', min: 0, max: 2, step: 0.05, def: 1, help: 'how deep a point bends the contours (× its intensity): its rings reach strength × radius', stage: 'phi' },
  autoPts: { label: 'auto points', units: '', min: 0, max: AUTO, step: 1, def: 3, help: 'the town’s middle moved inland, then a knoll, a shore point, another knoll', stage: 'phi' },
  shape: { label: 'shape the ground', units: '', min: 0, max: SHAPES.length - 1, step: 1, def: 0, choices: [...SHAPES], help: 'the lab’s heights only: terraces, or a cart road up the slope (spiral round the selected point or the knoll)', stage: 'field' },
  band: { label: 'band height', units: 'cells', min: 1, max: 16, step: 0.5, def: 4, help: 'a terrace’s step; the spiral climbs one a turn, the switchbacks one a leg', stage: 'field' },
  grade: { label: 'cart grade', units: 'rise/run', min: 0.03, max: 0.5, step: 0.01, def: 0.12, help: 'the carts’ steepest climb: the spiral’s smallest radius (stairs inside it), the switchbacks’ leg length', stage: 'mesh' },
  ringSpacing: { label: 'ring spacing (radial)', units: 'cells', min: 12, max: 120, step: 1, def: 38, help: 'between the rings (and so the spokes)', stage: 'phi' },
  townR: { label: 'town radius', units: 'cells', min: 32, max: 200, step: 1, def: 120, stage: 'phi' },
  cliff: { label: 'cliff slope', units: 'rise/run', min: 0.3, max: 4, step: 0.05, def: 1.2, help: 'smoothed ground steeper than this is a cliff: a barrier, like the water', stage: 'field' },
  blockLen: { label: 'block length', units: 'cells', min: MIN_BLOCK, max: 64, step: 1, def: 18, help: 'cross streets this far apart along a line', stage: 'trace' },
  gap: { label: 'gap fill', units: '', min: 0, max: 1, step: 1, def: 1, choices: ['off', 'on'], help: 'the town’s empty land (no block, no landmark) split into blocks along minor roads', stage: 'lots' },
  bigBlock: { label: 'big block', units: 'cells²', min: 0, max: 4000, step: 50, def: 900, help: 'a block this big gets a minor road at its first two splits (0 none)', stage: 'lots' },
  maxLot: { label: 'max lot area', units: 'cells²', min: 16, max: 600, step: 4, def: 90, stage: 'lots' },
  minLot: { label: 'merge (min lot area)', units: 'cells²', min: 4, max: 300, step: 2, def: 30, help: 'a split that would leave a lot under this is not made', stage: 'lots' },
  majorWidth: { label: 'major street width', units: 'cells', min: 0.5, max: 12, step: 0.1, def: 2.4, stage: 'mesh' },
  minorWidth: { label: 'minor street width', units: 'cells', min: 0.5, max: 8, step: 0.1, def: 1.5, stage: 'mesh' },
  setback: { label: 'setback', units: 'cells', min: 0, max: 6, step: 0.25, def: 0.75, stage: 'mesh' },
  height: { label: 'height', units: 'storeys', min: 0.5, max: 12, step: 0.5, def: 2, help: 'three cells a storey, each lot a little more or less', stage: 'mesh' },
  stairs: { label: 'stairs slope', units: 'rise/run', min: 0.05, max: 1.5, step: 0.05, def: 0.35, help: 'a street rising more than this along itself is orange', stage: 'mesh' },
};

/** the defaults as a run's parameters, with the town's own (its radius, seed …) over them */
export function cityParams(over: Partial<StreetParams> = {}): StreetParams & { scale: number } {
  const v = Object.fromEntries(Object.entries(CITY_PARAMS).map(([k, p]) => [k, p.def])) as unknown as StreetParams & { scale: number };
  return { ...v, ...over };
}

/** the city's scale applied: the spacings × it, the lot areas × its square (the lab's slider; the game's 1) */
export function scaled(v: StreetParams & { scale: number }): StreetParams {
  const k = v.scale;
  return { ...v, majorSpacing: v.majorSpacing * k, ringSpacing: v.ringSpacing * k, blockLen: Math.max(MIN_BLOCK, v.blockLen * k), maxLot: v.maxLot * k * k, minLot: v.minLot * k * k };
}
