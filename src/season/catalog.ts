// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md "The catalog") The town's cards, as data. Small counting
// numbers (the user: "Seasons and buildings go up in some smallish counting number and then effect the world and
// future opportunities"). A card ties up people (Labor, Might) for its seasons and spends goods (Materials, Magic,
// Intel) when it starts — the opportunity contract's commit and resolve (season/ledger.ts). A district card builds its
// parts of a district over its seasons (a district is DISTRICT_PARTS parts; the next card of the kind goes on in it);
// a stub card changes the pools only, until its world effect has an owner (BACKLOG SL2).
import type { Pools, SeasonCard } from './ledger';

export const CATALOG: readonly SeasonCard[] = [
  {
    id: 'houses',
    repeat: true,
    title: 'Build houses',
    name: 'the houses',
    pitch: 'More homes bring more workers. Crowding angers people.',
    locks: { labor: 2 },
    costs: { materials: 2 },
    seasons: 2,
    work: { kind: 'district', district: 'housing', parts: 2 },
    gives: { labor: 2 },
    unrestOnDone: 1,
  },
  {
    id: 'farms',
    repeat: true,
    title: 'Clear land for farms',
    name: 'the farms',
    pitch: 'Grain feeds the town and keeps it calm.',
    locks: { labor: 1 },
    costs: { materials: 1 },
    seasons: 2,
    work: { kind: 'district', district: 'farms', parts: 2 },
    unrestOnDone: -1,
  },
  {
    id: 'market',
    title: 'Open a market',
    name: 'the market',
    pitch: 'Traders bring goods and news.',
    locks: { labor: 2 },
    costs: { materials: 3 },
    seasons: 2,
    work: { kind: 'district', district: 'market', parts: 3 },
    income: { materials: 1, intel: 1 },
    needs: ['houses'],
  },
  {
    id: 'workshops',
    repeat: true,
    title: 'Build workshops',
    name: 'the workshops',
    pitch: 'Smiths and carpenters turn timber and stone into tools.',
    locks: { labor: 3 },
    costs: { materials: 3 },
    seasons: 3,
    work: { kind: 'district', district: 'workshops', parts: 3 },
    income: { materials: 2 },
    needs: ['houses'],
  },
  {
    id: 'harbour',
    title: 'Build a harbour',
    name: 'the harbour',
    pitch: 'Boats bring trade from down the river.',
    locks: { labor: 3 },
    costs: { materials: 4, intel: 1 },
    seasons: 3,
    work: { kind: 'district', district: 'harbour', parts: 3 },
    income: { materials: 2, intel: 1 },
    needs: ['market'],
  },
  {
    id: 'keep',
    title: 'Raise the keep',
    name: 'the keep',
    pitch: 'A stone keep guards the town.',
    locks: { labor: 4, might: 1 },
    costs: { materials: 4, magic: 1 },
    seasons: 4,
    work: { kind: 'district', district: 'keep', parts: 6 },
    gives: { might: 2 },
    unrestOnDone: -1,
    needs: ['workshops'],
  },
  {
    id: 'quarry',
    title: 'Open a quarry',
    name: 'the quarry',
    pitch: 'Cut stone from the hills.',
    locks: { labor: 1 },
    costs: {},
    seasons: 1,
    work: { kind: 'works', site: 'quarry' },
    income: { materials: 1 },
  },
  {
    id: 'lumber',
    title: 'Start a lumber camp',
    name: 'the lumber camp',
    pitch: 'Fell trees at the forest edge.',
    locks: { labor: 1 },
    costs: {},
    seasons: 1,
    work: { kind: 'works', site: 'camp' },
    income: { materials: 1 },
  },
  {
    id: 'bridge',
    title: 'Bridge the river',
    name: 'the bridge',
    pitch: 'A bridge brings travellers and their news.',
    locks: { labor: 2 },
    costs: { materials: 2 },
    seasons: 2,
    work: { kind: 'stub', waits: 'a bridge builder: citygen bridges its arterials on its own' },
    income: { intel: 1 },
  },
  {
    id: 'trade',
    title: 'Open a trade route',
    name: 'the trade route',
    pitch: 'Wagons bring goods in by road. Ships come too if you have a harbour.',
    locks: { labor: 1 },
    costs: { materials: 2, intel: 1 },
    seasons: 2,
    work: { kind: 'route' },
    income: { materials: 1, intel: 1 },
    needs: ['market'],
  },
  {
    id: 'walls',
    title: 'Build town walls',
    name: 'the walls',
    pitch: 'Walls keep raiders out. The hard work angers people.',
    locks: { labor: 2, might: 1 },
    costs: { materials: 3 },
    seasons: 3,
    work: { kind: 'walls' },
    gives: { might: 1 },
    unrestOnStart: 1,
  },
];

export function card(id: string): SeasonCard {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) throw new Error(`season: no card ${id} in the catalog`);
  return c;
}

/** the town's start: its people, its goods, and the goods each season brings (the tower's Magic) */
export const START_POOLS: Partial<Pools> = { magic: 1, might: 1, labor: 4, materials: 4, intel: 1, unrest: 0 };
export const START_INCOME: Partial<Pools> = { materials: 2, magic: 1 };
