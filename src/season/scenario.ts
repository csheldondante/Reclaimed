// (round 128r, Track A "Next season") The start town's first seasons, a fixed list standing in for the dealer (the
// dealer feeds cards next slice): the fortress tower raised two storeys a season, a quarter raided, ruined and
// overgrown, and the low ground flooded to its spill height, held a season, then drained. Where each goes is chosen
// from the plan and the land the same way every time (an authored scenario, not a rule of the game).
import type { V2 } from '../api/contracts/structures';
import type { SeasonCard } from './ledger';

/** what the scenario reads to place its cards */
export interface ScenarioSite {
  /** the stores (window world) */
  heap: V2;
  /** the plan's structures: id, centre, type */
  structures(): { id: number; centre: V2; district?: number; type: string }[];
  /** footprints of `n` cells free to plan on open ground near a point, nearest first (the tower tries them in turn) */
  footprints(at: V2, n: number, most: number): number[][];
  /** plant the tower: its cells, `levels` high; its structure id (null: refused) */
  planTower(cells: number[], levels: number): Promise<number | null>;
  /** a flood's depth at a seed (its spill height over the seed's ground) */
  probeFlood(at: V2): Promise<number>;
}

export const TOWER_LEVELS = 6;
export const TOWER_STOREYS_A_SEASON = 2;
/** the quarter's reach (world units): its marks wear what lies within about this of its middle */
export const QUARTER_R = 14;
const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The start town's cards: the tower, a quarter, a flood. */
export async function startTownCards(site: ScenarioSite): Promise<SeasonCard[]> {
  const cards: SeasonCard[] = [];
  const all = site.structures();
  // the tower: three cells on open ground, as near the stores as the reach lets it stand (a footprint that would shut
  // something off is refused: the next is tried)
  const feet = site.footprints(site.heap, 3, 12);
  let tower: number | null = null;
  for (const cells of feet) if ((tower = await site.planTower(cells, TOWER_LEVELS)) !== null) break;
  if (tower === null) throw new Error(`season scenario: the tower was refused on all ${feet.length} footprints near the stores`);
  cards.push({ id: 'tower', name: 'the fortress tower', cost: { labor: 3, resources: 2 }, work: { kind: 'raise', structure: tower, storeys: TOWER_STOREYS_A_SEASON } });
  // the quarter: in the outer third of the town (by distance from the stores), the densest knot of buildings
  const houses = all.filter((s) => s.type !== 'wall' && s.type !== 'fortress' && s.id !== tower);
  const far = [...houses].sort((a, b) => dist(b.centre, site.heap) - dist(a.centre, site.heap) || a.id - b.id).slice(0, Math.max(1, Math.ceil(houses.length / 3)));
  const knot = (p: V2) => houses.filter((s) => dist(s.centre, p) < QUARTER_R).length;
  const core = [...far].sort((a, b) => knot(b.centre) - knot(a.centre) || a.id - b.id)[0];
  if (!core) throw new Error('season scenario: the town has no buildings for a quarter');
  const pts = houses.filter((s) => dist(s.centre, core.centre) < QUARTER_R).map((s) => s.centre);
  const mid: V2 = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  cards.push({ id: 'quarter', name: 'the outer quarter', cost: { might: 1 }, work: { kind: 'decay', at: mid, r: QUARTER_R, marks: ['raided', 'ruined', 'overgrown'] } });
  // the flood: of the places in and round the town, the deepest basin that holds water. On the start town that is the
  // walled town's own low streets (the walls and the buildings' columns close it; the open land round it has no hollow
  // deeper than 1 m within 100 m: docs/design/NEXT_SEASON.md)
  const seeds = floodSeeds(site.heap);
  let best: { at: V2; depth: number } | null = null;
  for (const at of seeds) {
    const depth = await site.probeFlood(at);
    if (depth >= 1 && (!best || depth > best.depth)) best = { at, depth };
  }
  if (!best) throw new Error(`season scenario: no basin that holds water near the town (${seeds.length} seeds tried)`);
  cards.push({ id: 'flood', name: 'the low ground', cost: { magic: 2 }, work: { kind: 'flood', at: best.at, hold: 1 } });
  return cards;
}

/** seeds to try: a grid of points over the town and round it (the probe finds each one's basin, if it has one) */
export function floodSeeds(heap: V2, r = 64, step = 12): V2[] {
  const out: V2[] = [];
  for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) if (Math.hypot(dx, dy) <= r) out.push([heap[0] + dx, heap[1] + dy]);
  return out;
}
