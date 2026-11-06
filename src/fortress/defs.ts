// The eight first buildings (round 128c, the user's list) and their numbers: a block's cost and what it gives. Size
// sets cost and capacity (blocks × these). Untuned: the user tunes once it's playable (FORTRESS_SLICE1 answer 2).

export { DEFS, POWER_RISE } from '../build/types';

/**
 * What a fortress starts with when its town's stores are empty (a town start mostly means stores and income: the
 * user, FORTRESS_SLICE1 answer 1). Untuned. (milestone 3) No income by rates: goods come in only as people carry them
 * to the warehouse (the quarry's miners, the lumber camp's woodcutters, the farmers).
 */
export const START_STORES: Record<string, { stock: number; rate: number }> = {
  log: { stock: 120, rate: 0 },
  stone: { stock: 80, rate: 0 },
  grain: { stock: 150, rate: 0 },
};

/**
 * (milestone 3) The economy's pace. All untuned (the user tunes once it's playable: FORTRESS_SLICE1 answer 2); the
 * DEVLOG lists them.
 */
export const ECON = {
  /** the economy's day (sim seconds): a type's `makes` and a person's grain are "a day" of this (the day counter and
   *  DayNight's 480 s meet in milestone 5) */
  daySec: 60,
  /** goods a worker carries a trip (miners, woodcutters, farmers) */
  haul: 2,
  /** grain a person eats a day */
  eat: 1,
  /** the share of the quarry's stone that is ore (the user's answer 4: a share now, deposits later) */
  oreShare: 0.2,
  /** room in the town's own stores before any warehouse is built (goods) */
  townRoom: 400,
  /** people at the start (the town's), and the beds in the town's own houses */
  startPeople: 8,
  startBeds: 8,
  /** the most people the fortress has (units on a phone) */
  maxPeople: 40,
  /** builders while there's something to build */
  builders: 4,
  /** a newcomer every this many sim seconds while there are beds and grain */
  arriveSec: 6,
  /** a lumber camp's reach for trees: this, and more a block (world units) */
  reach0: 24,
  reachPerBlock: 6,
  /** a farmer's seconds reaping a load */
  reapSec: 4,
  /**
   * a miner's dig (round 128m, quarry: was 0.35 cells cubed every 4 s, the pit a bowl 6 m deep at most): every this
   * many seconds, this deep (m) off the tops of this many of the pit's columns in the cell they work
   */
  digSec: 0.5,
  dig: 1,
  digCols: 6,
  /**
   * (round 128m, V128-11: replaces pitMax) a quarry's pit goes down a tier (a level, LEVEL_H) a ring of its footprint,
   * each tier reached by a ramp along this many cells of the ring above it: the depth is the tiers whose ramps fit
   * (fortress/pit.ts)
   */
  pitRampCells: 2,
  /** (round 128m) the miners cut a tier down this many metres at a time, every column of it, so its ramp stays walkable */
  pitStep: 1,
  /** (round 128l, m4) the carts: the town's at the start, and one more a warehouse block built, up to cartsMax */
  carts: 2,
  cartsMax: 3,
  /** (m4) goods a cart carries a trip (a walker: haul) */
  cartLoad: 8,
  /** (m4) a haul longer than this (m, a structure's door to the stores, as the crow flies) goes by cart: the workers
   *  leave their goods at their structure's pile and a cart fetches it; shorter, they carry it themselves */
  cartDist: 40,
  /** (m4) the most a structure's pile holds waiting for a cart (more: the workers carry it in) */
  pileMax: 16,
  /** (round 128l, m4) a soldier's health (a villager's is 3) */
  soldierHealth: 5,
  /** (m4: the attack wave) what a soldier's blow takes off (a villager's: 1; a raider's: RAID.raiderDamage) */
  soldierDamage: 2,
  /** (m4) sim seconds a soldier drills at the barracks when it musters */
  drillSec: 8,
  /** (m4) wall-walk points a soldier walks before it musters again */
  patrolPoints: 4,
  /** the share of a built block's cost Erase gives back (a block not yet built: all that was brought to it) */
  refund: 0.5,
};

