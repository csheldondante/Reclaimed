// Where trees stand (round 125, `forest`; BACKLOG FLO31). The user: "Let's make the trees bigger and further spaced
// appart in the main map if need be to get the look we want. I want forests to be impressive like the cliffs. They
// should be seas of leaves". Before this, a tree stood on any wooded column whose hash fell under 0.045 — a Poisson
// scatter: clumps of trunks two cells apart beside empty holes, too busy under the canopy and too thin from above.
//
// Now a jittered grid in world columns (blue noise; the window's origin added, so a tree stays with the land as the
// window slides): every SLOT_W × SLOT_H block of columns has one candidate column, at least SLOT_M columns in from its
// block's edges — so two trees are never closer than 2·SLOT_M + 1 columns across (≈3 cells) and are ~7 cells apart on
// average. The candidate is a tree when its column is woods (succession ≥ 3.6); its species and size are vegPlan's.
//
// Elder woods (the reference's "huge pale trunks"): a second stand-in biome field like the birch woods. A super-block
// of ELDER_K × ELDER_K blocks in an elder wood holds one elder, on its own jittered candidate (at least ELDER_M columns
// in from the super-block's edges: elders ≥ ~7 cells apart, ~14 on average) and no other tree: the open, carpeted floor
// between the massive trunks is the scene.
//
// One pure function of world columns, mirrored exactly in vegplan.wgsl (test/gpu/flora-plan.test.ts runs both); the
// numbers are here and there, kept the same by that test.

/** a block of columns (x) by rows (y) holding one tree: 7 columns × 8 rows ≈ 7 × 6.9 cells */
export const SLOT_W = 7;
export const SLOT_H = 8;
/** the candidate's margin inside its block (columns / rows) */
export const SLOT_M = 1;
/** an elder super-block: K × K blocks */
export const ELDER_K = 2;
/** the elder's margin inside its super-block (columns / rows) */
export const ELDER_M = 3;
/** the elder woods' noise: its scale (world columns) and the band it rises through */
export const ELDER_SCALE = 96;
export const ELDER_LO = 0.6;
export const ELDER_HI = 0.74;
/** an elder needs old woods (succession) */
export const ELDER_VEG = 3.9;

// common.wgsl pcg
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
/** a block's random 0..1 (vegplan.wgsl slotRand): world block ints, a salt */
export function slotRand(bx: number, by: number, salt: number): number {
  return (pcg(((bx >>> 0) ^ pcg(((by >>> 0) ^ pcg(salt >>> 0)) >>> 0)) >>> 0) >>> 8) / 16777216;
}

function corner(x: number, y: number): number {
  return (pcg(((x >>> 0) ^ pcg(((y >>> 0) ^ 0xe1de4) >>> 0)) >>> 0) >>> 8) / 16777216;
}
/** The elder woods at world column (wx, wy): 0 outside, rising to 1 in a wood's heart (vegplan.wgsl elderWood). */
export function elderWood(wx: number, wy: number): number {
  const px = wx / ELDER_SCALE;
  const py = wy / ELDER_SCALE;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = corner(ix, iy) + (corner(ix + 1, iy) - corner(ix, iy)) * ux;
  const b = corner(ix, iy + 1) + (corner(ix + 1, iy + 1) - corner(ix, iy + 1)) * ux;
  const n = a + (b - a) * uy;
  const t = Math.min(1, Math.max(0, (n - ELDER_LO) / (ELDER_HI - ELDER_LO)));
  return t * t * (3 - 2 * t);
}

export type Slot = 'none' | 'tree' | 'elder';

/**
 * What world column (wx, wy) holds, before its succession is asked: 'elder' (the elder of its super-block), 'tree' (its
 * block's candidate, outside an elder super-block) or 'none'. Only the column's own succession decides the rest
 * (vegPlan reads no other column): an elder's column too young for an elder (under ELDER_VEG) grows an ordinary tree.
 */
export function slotAt(wx: number, wy: number): Slot {
  const bx = Math.floor(wx / SLOT_W);
  const by = Math.floor(wy / SLOT_H);
  const ex = Math.floor(bx / ELDER_K);
  const ey = Math.floor(by / ELDER_K);
  // the super-block's elder: its candidate and whether the super-block is an elder one (the wood at the candidate)
  const EW = SLOT_W * ELDER_K;
  const EH = SLOT_H * ELDER_K;
  const ecx = ex * EW + ELDER_M + Math.floor(slotRand(ex, ey, 0xe1d1) * (EW - 2 * ELDER_M));
  const ecy = ey * EH + ELDER_M + Math.floor(slotRand(ex, ey, 0xe1d2) * (EH - 2 * ELDER_M));
  const elderBlock = slotRand(ex, ey, 0xe1d3) < elderWood(ecx, ecy);
  if (elderBlock) return wx === ecx && wy === ecy ? 'elder' : 'none';
  const cx = bx * SLOT_W + SLOT_M + Math.floor(slotRand(bx, by, 0x51d1) * (SLOT_W - 2 * SLOT_M));
  const cy = by * SLOT_H + SLOT_M + Math.floor(slotRand(bx, by, 0x51d2) * (SLOT_H - 2 * SLOT_M));
  return wx === cx && wy === cy ? 'tree' : 'none';
}
