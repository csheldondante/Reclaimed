// The eight first buildings (round 128c, the user's list) and their numbers: a block's cost and what it gives. Size
// sets cost and capacity (blocks × these). Untuned: the user tunes once it's playable (FORTRESS_SLICE1 answer 2).
import type { StructureDef, StructureType } from '../api/contracts/fortress';

/**
 * (round 128d) A block type stacks as high as the player likes (the user: "I want the player fortress to be something
 * that can grow huge and impressive"): the Town keeps runs per cell, no cap. The caps the block types had (houses 4,
 * warehouses and barracks 3, lumber camps and blacksmiths 2) were picked under the old 8-level cap, not by design. Yards
 * (farms, the quarry) lie flat: 1, by design.
 */
const NO_CAP = Infinity;

/** How much more power a level up gives: a block at level L gives power x (1 + POWER_RISE x L) (round 128d). Untuned. */
export const POWER_RISE = 0.5;

export const DEFS: Record<StructureType, StructureDef> = {
  // (round 128d) the player's keep: solid stone, crenellated, a tower at each outer corner; its blocks give power, the
  // higher the more. No height cap.
  fortress: {
    type: 'fortress', label: 'Fortress', one: 'fortress', many: 'fortresses', form: 'keep', joins: true, maxLevels: NO_CAP,
    cost: { stone: 8, log: 1 }, perBlock: { power: 1 },
    look: { style: 'bastion', props: ['banner'] },
  },
  house: {
    type: 'house', label: 'Houses', one: 'house', many: 'houses', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { log: 4, stone: 2 }, perBlock: { beds: 4 },
    look: { style: 'hearth', kind: 'house' },
  },
  farm: {
    type: 'farm', label: 'Farms', one: 'farm', many: 'farms', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 1 }, perBlock: { jobs: 1, makes: { grain: 2 } },
    look: { style: 'hearth', props: ['haystack'] },
  },
  lumber: {
    type: 'lumber', label: 'Lumber camp', one: 'lumber camp', many: 'lumber camps', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { log: 3, stone: 1 }, perBlock: { jobs: 2, makes: { log: 3 } },
    look: { style: 'hearth', kind: 'sawmill', props: ['logpile'] },
  },
  quarry: {
    type: 'quarry', label: 'Quarry', one: 'quarry', many: 'quarries', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 2 }, perBlock: { jobs: 2, makes: { stone: 3 } },
    look: { style: 'bastion', props: ['spoil', 'crane'] },
  },
  warehouse: {
    type: 'warehouse', label: 'Warehouse', one: 'warehouse', many: 'warehouses', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { log: 4, stone: 4 }, perBlock: { storage: 50 },
    look: { style: 'hearth', kind: 'warehouse', props: ['crates'] },
  },
  wall: {
    type: 'wall', label: 'Walls', one: 'wall', many: 'walls', form: 'wall', joins: true, maxLevels: NO_CAP,
    cost: { stone: 6 }, perBlock: { posts: 2 },
    look: { style: 'bastion' },
  },
  blacksmith: {
    type: 'blacksmith', label: 'Blacksmith', one: 'blacksmith', many: 'blacksmiths', form: 'block', joins: true, maxLevels: NO_CAP,
    // (round 128l, m4: its smiths run the recipe — data/recipes/fortress.json 'forge', a weapon every 20 s of work: 3 a
    // day a smith, 2 smiths a block)
    cost: { log: 3, stone: 5 }, perBlock: { jobs: 2, makes: { weapons: 6 } },
    look: { style: 'bastion', kind: 'house', chimney: true, props: ['cart'] },
  },
  barracks: {
    type: 'barracks', label: 'Barracks', one: 'barracks', many: 'barracks', form: 'block', joins: true, maxLevels: NO_CAP,
    // (round 128l, m4: a recruit a block trains — 'drill', 30 s: 2 soldiers a day — while its beds have room)
    cost: { log: 4, stone: 6 }, perBlock: { beds: 4, jobs: 1, makes: { soldiers: 2 } },
    look: { style: 'bastion', kind: 'warehouse', props: ['banner'] },
  },
};

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
  /** a miner's dig: every this many seconds, this much ground (cells cubed), within this of the spot */
  digSec: 4,
  dig: 0.35,
  digR: 2.2,
  /** the deepest a quarry's pit is dug below the ground it had (world units) */
  pitMax: 6,
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

/**
 * (milestone 3) Which jobs people take first when there aren't enough for all (the JobBoard's priority): food, then the
 * builders, then stone, then wood; (round 128l, milestone 4) then the smiths, then the recruits.
 */
export const JOB_ORDER = ['farm', 'build', 'quarry', 'lumber', 'blacksmith', 'barracks'] as const;
