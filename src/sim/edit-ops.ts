// The edit pass's ops (edit.wgsl: keep the two the same) and how an Edit event carries one (round 83: one
// copy for the world API, the plants and water modules and the integrity system, which reads them back).
// An Edit event's z: op · 32 + material, + STROKE_START (a new press), + tag · 1024 (an exact take or put).

export const OP = {
  BUILD: 1,
  DIG: 2,
  WATER: 3,
  OIL: 4,
  FELL: 5,
  POLLUTE: 6,
  PLANT: 7,
  CLEAN: 8,
  DRAIN: 9,
  POUR: 10,
  BEDROCK: 11,
  SMASH: 12,
  CRATER: 13,
  TAKE: 14,
  PUT: 15,
} as const;

/** a new press (layer tools: a fresh layer) */
export const STROKE_START = 512;

/** the op an Edit event's z carries */
export const editOpOf = (z: number): number => (z & 511) >> 5;

/** ops that take ground away (what they cut may leave rock hanging free) */
export const CUTS: ReadonlySet<number> = new Set([OP.DIG, OP.SMASH, OP.CRATER, OP.TAKE]);
