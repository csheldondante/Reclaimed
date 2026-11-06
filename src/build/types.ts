// The building types: one table for every town (round 128m, onetown; the user: "Why is the fortress not just another
// building type?", "Consolidate them", "Generation needs to use the same system as the built town"). The player's nine
// (round 128c: the user's list, and the keep) and what the town generator places (huts, farmsteads, the purposes'
// buildings, landmarks, orchards and pastures) are rows of the same table: the same plan (build/plan.ts), claims,
// reach, jobs and hauling, damage and repair. A block's cost and what it gives: size sets cost and capacity (blocks x
// these). Untuned: the user tunes once it's playable (FORTRESS_SLICE1 answer 2); the generated types' numbers are a
// first guess on the same scale.
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
  // higher the more. No height cap. (onetown) A hold's keep in the middle of its plaza is one too.
  fortress: {
    type: 'fortress', label: 'Fortress', one: 'fortress', many: 'fortresses', form: 'keep', joins: true, maxLevels: NO_CAP,
    cost: { stone: 8, log: 1 }, perBlock: { power: 1 },
    look: { style: 'bastion', props: ['banner'] },
  },
  house: {
    type: 'house', label: 'Houses', one: 'house', many: 'houses', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { log: 4, stone: 2 }, perBlock: { beds: 4 },
    look: { style: 'town', kind: 'house' },
  },
  farm: {
    type: 'farm', label: 'Farms', one: 'farm', many: 'farms', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 1 }, perBlock: { jobs: 1, makes: { grain: 2 } },
    look: { style: 'town', props: ['haystack'], use: 'field' }, crossed: true,
  },
  lumber: {
    type: 'lumber', label: 'Lumber camp', one: 'lumber camp', many: 'lumber camps', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { log: 3, stone: 1 }, perBlock: { jobs: 2, makes: { log: 3 } },
    look: { style: 'town', kind: 'sawmill', props: ['logpile'] },
  },
  quarry: {
    type: 'quarry', label: 'Quarry', one: 'quarry', many: 'quarries', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 2 }, perBlock: { jobs: 2, makes: { stone: 3 } },
    look: { style: 'bastion', props: ['spoil', 'crane'], use: 'yard' },
  },
  warehouse: {
    type: 'warehouse', label: 'Warehouse', one: 'warehouse', many: 'warehouses', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { log: 4, stone: 4 }, perBlock: { storage: 50 },
    look: { style: 'town', kind: 'warehouse', props: ['crates'] },
  },
  // (onetown) the town's own style: a generated town's wall in its civ's stone, the player's the same
  wall: {
    type: 'wall', label: 'Walls', one: 'wall', many: 'walls', form: 'wall', joins: true, maxLevels: NO_CAP,
    cost: { stone: 6 }, perBlock: { posts: 2 },
    look: { style: 'town' },
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
  // ---- (onetown) what the generator places as well (the player may erase them, add to them, raise them)
  hut: {
    type: 'hut', label: 'Huts', one: 'hut', many: 'huts', form: 'block', joins: true, maxLevels: 2,
    cost: { log: 2 }, perBlock: { beds: 2 },
    look: { style: 'town', kind: 'hut' },
  },
  farmhouse: {
    type: 'farmhouse', label: 'Farmhouse', one: 'farmhouse', many: 'farmhouses', form: 'block', joins: true, maxLevels: 2,
    cost: { log: 3, stone: 1 }, perBlock: { beds: 3 },
    look: { style: 'town', kind: 'farmhouse' },
  },
  barn: {
    type: 'barn', label: 'Barn', one: 'barn', many: 'barns', form: 'block', joins: true, maxLevels: 1,
    cost: { log: 4 }, perBlock: { storage: 30 },
    look: { style: 'town', kind: 'barn', props: ['haystack'] },
  },
  granary: {
    type: 'granary', label: 'Granary', one: 'granary', many: 'granaries', form: 'block', joins: true, maxLevels: 2,
    cost: { log: 3, stone: 2 }, perBlock: { storage: 40 },
    look: { style: 'town', kind: 'granary' },
  },
  stable: {
    type: 'stable', label: 'Stables', one: 'stable', many: 'stables', form: 'block', joins: true, maxLevels: 2,
    cost: { log: 4 }, perBlock: { jobs: 1 },
    look: { style: 'town', kind: 'stable', props: ['wagon'] },
  },
  hall: {
    type: 'hall', label: 'Hall', one: 'hall', many: 'halls', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { log: 4, stone: 4 }, perBlock: { storage: 20, jobs: 1 },
    look: { style: 'town', kind: 'house', chimney: true, props: ['banner'] },
  },
  temple: {
    type: 'temple', label: 'Temple', one: 'temple', many: 'temples', form: 'block', joins: true, maxLevels: NO_CAP,
    cost: { stone: 8 }, perBlock: { power: 0.5 },
    look: { style: 'town', kind: 'house', mega: 'dome' },
  },
  tower: {
    type: 'tower', label: 'Tower', one: 'tower', many: 'towers', form: 'block', joins: false, maxLevels: NO_CAP,
    cost: { stone: 6 }, perBlock: { posts: 1 },
    look: { style: 'town', kind: 'house', mega: 'tower' },
  },
  orchard: {
    type: 'orchard', label: 'Orchards', one: 'orchard', many: 'orchards', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 1 }, perBlock: { jobs: 1, makes: { grain: 1 } },
    look: { style: 'town', use: 'orchard' }, crossed: true,
  },
  pasture: {
    type: 'pasture', label: 'Pastures', one: 'pasture', many: 'pastures', form: 'yard', joins: true, maxLevels: 1,
    cost: { log: 1 }, perBlock: {},
    look: { style: 'town', use: 'pasture' }, crossed: true,
  },
  fountain: {
    type: 'fountain', label: 'Fountain', one: 'fountain', many: 'fountains', form: 'yard', joins: true, maxLevels: 1,
    cost: { stone: 2 }, perBlock: {},
    look: { style: 'town', mega: 'fountain', use: 'plaza' },
  },
  lighthouse: {
    type: 'lighthouse', label: 'Lighthouse', one: 'lighthouse', many: 'lighthouses', form: 'block', joins: false, maxLevels: NO_CAP,
    cost: { stone: 8 }, perBlock: {},
    look: { style: 'town', kind: 'house', mega: 'lighthouse' },
  },
  headframe: {
    type: 'headframe', label: 'Headframe', one: 'headframe', many: 'headframes', form: 'block', joins: false, maxLevels: NO_CAP,
    cost: { log: 6 }, perBlock: { jobs: 2, makes: { stone: 2 } },
    look: { style: 'town', kind: 'house', mega: 'headframe' },
  },
  windmill: {
    type: 'windmill', label: 'Windmill', one: 'windmill', many: 'windmills', form: 'block', joins: false, maxLevels: NO_CAP,
    cost: { log: 4, stone: 2 }, perBlock: { jobs: 1 },
    look: { style: 'town', kind: 'house', mega: 'windmill' },
  },
  // (onetown) townlab's bridges: a road over water as a type in this table (its form, claims and drawing are the bridge
  // work's; nothing paints it yet)
  bridge: {
    type: 'bridge', label: 'Bridge', one: 'bridge', many: 'bridges', form: 'bridge', joins: true, maxLevels: 1,
    cost: { log: 2, stone: 2 }, perBlock: {},
    look: { style: 'town' },
  },
};
