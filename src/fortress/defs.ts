// The eight first buildings (round 128c, the user's list) and their numbers: a block's cost and what it gives. Size
// sets cost and capacity (blocks × these). Untuned: the user tunes once it's playable (FORTRESS_SLICE1 answer 2).
import type { StructureDef, StructureType } from '../api/contracts/fortress';

export const DEFS: Record<StructureType, StructureDef> = {
  house: {
    type: 'house', label: 'Houses', one: 'house', many: 'houses', form: 'block', joins: true, maxLevels: 4,
    cost: { log: 4, stone: 2 }, perBlock: { beds: 4 },
    look: { style: 'hearth', kind: 'house' },
  },
  farm: {
    type: 'farm', label: 'Farms', one: 'farm', many: 'farms', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 1 }, perBlock: { jobs: 1, makes: { grain: 2 } },
    look: { style: 'hearth', props: ['haystack'] },
  },
  lumber: {
    type: 'lumber', label: 'Lumber camp', one: 'lumber camp', many: 'lumber camps', form: 'block', joins: true, maxLevels: 2,
    cost: { log: 3, stone: 1 }, perBlock: { jobs: 2, makes: { log: 3 } },
    look: { style: 'hearth', kind: 'sawmill', props: ['logpile'] },
  },
  quarry: {
    type: 'quarry', label: 'Quarry', one: 'quarry', many: 'quarries', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 2 }, perBlock: { jobs: 2, makes: { stone: 3 } },
    look: { style: 'bastion', props: ['spoil', 'crane'] },
  },
  warehouse: {
    type: 'warehouse', label: 'Warehouse', one: 'warehouse', many: 'warehouses', form: 'block', joins: true, maxLevels: 3,
    cost: { log: 4, stone: 4 }, perBlock: { storage: 50 },
    look: { style: 'hearth', kind: 'warehouse', props: ['crates'] },
  },
  wall: {
    type: 'wall', label: 'Walls', one: 'wall', many: 'walls', form: 'wall', joins: true, maxLevels: 3,
    cost: { stone: 6 }, perBlock: { posts: 2 },
    look: { style: 'bastion' },
  },
  blacksmith: {
    type: 'blacksmith', label: 'Blacksmith', one: 'blacksmith', many: 'blacksmiths', form: 'block', joins: true, maxLevels: 2,
    cost: { log: 3, stone: 5 }, perBlock: { jobs: 2, makes: { weapons: 1 } },
    look: { style: 'bastion', kind: 'house', chimney: true, props: ['cart'] },
  },
  barracks: {
    type: 'barracks', label: 'Barracks', one: 'barracks', many: 'barracks', form: 'block', joins: true, maxLevels: 3,
    cost: { log: 4, stone: 6 }, perBlock: { beds: 4, makes: { soldiers: 1 } },
    look: { style: 'bastion', kind: 'warehouse', props: ['banner'] },
  },
};

/**
 * What a fortress starts with when its town's stores are empty (a town start mostly means stores and income: the
 * user, FORTRESS_SLICE1 answer 1). Untuned.
 */
export const START_STORES: Record<string, { stock: number; rate: number }> = {
  log: { stock: 120, rate: 20 },
  stone: { stock: 80, rate: 10 },
  grain: { stock: 150, rate: 30 },
};
