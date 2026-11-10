// (trackA-opps, the season loop; docs/design/SEASON_LOOP.md "The catalog") The town's cards, as data. Small counting
// numbers (the user: "Seasons and buildings go up in some smallish counting number and then effect the world and
// future opportunities"). A district card claims a district of the town for its purpose (citygen claimDistrict) and
// builds it over its seasons; a stub card changes the pools only, until its world effect has an owner (BACKLOG SL2).
import type { Pools, SeasonCard } from './ledger';

export const CATALOG: readonly SeasonCard[] = [
  {
    id: 'houses',
    repeat: true,
    title: 'Build houses',
    name: 'the houses',
    pitch: 'More homes bring more workers.',
    cost: { labor: 2, resources: 1 },
    seasons: 2,
    work: { kind: 'district', district: 'housing' },
    income: { labor: 1 },
  },
  {
    id: 'farms',
    repeat: true,
    title: 'Clear land for farms',
    name: 'the farms',
    pitch: 'Full bellies keep the town calm.',
    cost: { labor: 1, resources: 1 },
    seasons: 1,
    work: { kind: 'district', district: 'farms' },
    income: { labor: 1 },
    unrestOnDone: -1,
  },
  {
    id: 'market',
    title: 'Open a market',
    name: 'the market',
    pitch: 'Traders bring goods and news.',
    cost: { labor: 2, resources: 2 },
    seasons: 2,
    work: { kind: 'district', district: 'market' },
    income: { resources: 1, intel: 1 },
    needs: ['houses'],
  },
  {
    id: 'workshops',
    repeat: true,
    title: 'Build workshops',
    name: 'the workshops',
    pitch: 'Smiths and carpenters turn raw stuff into tools.',
    cost: { labor: 2, resources: 3 },
    seasons: 3,
    work: { kind: 'district', district: 'workshops' },
    income: { resources: 2 },
    needs: ['houses'],
  },
  {
    id: 'harbour',
    title: 'Build a harbour',
    name: 'the harbour',
    pitch: 'Boats bring trade from down the river.',
    cost: { labor: 3, resources: 2, intel: 1 },
    seasons: 3,
    work: { kind: 'district', district: 'harbour' },
    income: { resources: 2, intel: 1 },
    needs: ['market'],
  },
  {
    id: 'keep',
    title: 'Raise the keep',
    name: 'the keep',
    pitch: 'A stone keep guards the town.',
    cost: { labor: 3, resources: 3, magic: 1 },
    seasons: 4,
    work: { kind: 'district', district: 'keep' },
    income: { might: 2 },
    unrestOnDone: -1,
    needs: ['workshops'],
  },
  {
    id: 'quarry',
    title: 'Open a quarry',
    name: 'the quarry',
    pitch: 'Cut stone from the hills.',
    cost: { labor: 2 },
    seasons: 1,
    work: { kind: 'stub', waits: 'trackA-haul: the quarry and its haulers' },
    income: { resources: 1 },
  },
  {
    id: 'lumber',
    title: 'Start a lumber camp',
    name: 'the lumber camp',
    pitch: 'Fell trees at the forest edge.',
    cost: { labor: 1 },
    seasons: 1,
    work: { kind: 'stub', waits: 'trackA-haul: forest clearing and its haulers' },
    income: { resources: 1 },
  },
  {
    id: 'bridge',
    title: 'Bridge the river',
    name: 'the bridge',
    pitch: 'A bridge brings travellers and their news.',
    cost: { labor: 2, resources: 2 },
    seasons: 2,
    work: { kind: 'stub', waits: 'a bridge builder: citygen bridges its arterials on its own' },
    income: { intel: 1 },
  },
  {
    id: 'walls',
    title: 'Build town walls',
    name: 'the walls',
    pitch: 'Walls keep raiders out. The hard work angers people.',
    cost: { labor: 3, resources: 3 },
    seasons: 3,
    work: { kind: 'stub', waits: 'a wall builder on the town limit' },
    income: { might: 2 },
    unrestOnStart: 1,
  },
];

export function card(id: string): SeasonCard {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) throw new Error(`season: no card ${id} in the catalog`);
  return c;
}

/** the town's start: its pools and its income each season (the tower's Magic) */
export const START_POOLS: Partial<Pools> = { magic: 1, might: 1, labor: 4, resources: 3, intel: 1, unrest: 0 };
export const START_INCOME: Partial<Pools> = { labor: 3, resources: 2, magic: 1 };
