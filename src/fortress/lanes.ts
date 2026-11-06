// A town's roads (round 128k; were the lanes of round 128f-i; round 128o, DA-A7's core: from the ways, not the cell
// borders). The user, round 128k: "Realistically I would expect a road to the lumber mill and not around an empty plot.
// It also, just didn't convincingly connect to the city through a gate or anything" — roads go to things.
//  - The roads are the ways' (ways.ts): the road tree over the free cells joining every structure's entrance
//    (build/entrances.ts) and both sides of every gate, through the gates and the blocks' passages. A lane runs from a
//    way cell's middle to the middle of the side it shares with the next way cell, so it lies inside the free cells and
//    enters a claimed cell only through a gate or a passage — never along a building's face. (Round 128k-128n's lanes
//    ran on the cell borders with a free cell on one side; in the generated town's dense streets they ran flush along
//    claimed buildings and riders stuck there: the lab's `town`, round 128o.)
//  - Thoroughfares are whole TILES: the squares, the gates and the passages (paved whole).
//  - A lane by a building is paving (road), in the open trodden earth (track); a ramp's cell its treads (ramp).
// Water: the ways' `blocked` (the reach's wet columns) keeps the roads off it. Pure, from the plan and the ways (tested
// without a GPU: lanes.test.ts). The ride graph (laneGraph) is built from the same pieces.
import type { V2 } from '../api/contracts/structures';
import type { TownPlan } from '../build/plan';
import { WAY_ROAD, WAY_SQUARE, wayStep, type Ways, type WaysGrid } from './ways';
import type { RoadShape } from '../agents/roads';
import { graphOf, type RoadGraph } from '../agents/roadgraph';

/** road: a lane by a building (paving); track: a lane in the open (earth); plaza: a way across a thoroughfare tile (the
 *  tile is paved whole: not drawn); ramp: a road up a ramp (its treads are the road) */
export type LaneKind = 'road' | 'plaza' | 'ramp' | 'track';

export interface LaneSeg {
  cell: number;
  a: V2;
  b: V2;
  kind: LaneKind;
  /** a climb steep enough for steps */
  steps: boolean;
}

/** each kind's width (m): a cell is ~4-6 m across */
export const LANE_WIDTH: Record<LaneKind, number> = { road: 2.6, plaza: 2.6, ramp: 2.6, track: 2.0 };
/** the kinds drawn as bands (a tile is paved whole; a ramp's treads are its road) */
export const LANE_DRAWN: Record<LaneKind, boolean> = { road: true, plaza: false, ramp: false, track: true };
/** a road's rise over its run past which it is stepped */
export const STEEP = 0.3;

export interface Lanes {
  segs: LaneSeg[];
  /** per cell the indices of its segments */
  byCell: number[][];
  /** the thoroughfare tiles on the roads (cells paved whole) */
  tiles: number[];
  /** the structures whose entrance the roads reach, and those they can't (or that have none) */
  joined: number[];
  unjoined: number[];
}

export function noLanes(count: number): Lanes {
  return { segs: [], byCell: Array.from({ length: count }, () => []), tiles: [], joined: [], unjoined: [] };
}

/** The roads of the plan's ways (box frame). `ground`: the ground's top at a point. */
export function lanesOf(plan: TownPlan, g: WaysGrid, ways: Ways, ground: (x: number, y: number) => number): Lanes {
  const n = g.count;
  const through = new Set<number>([...ways.gates, ...ways.passages]);
  const onWay = (c: number) => c >= 0 && (ways.way[c] === WAY_ROAD || ways.way[c] === WAY_SQUARE || through.has(c));
  const kindOf = (c: number): LaneKind => {
    if (through.has(c) || ways.way[c] === WAY_SQUARE) return 'plaza';
    if (plan.ramp && plan.ramp[c] >= 0) return 'ramp';
    // (across a field: a track)
    if (plan.owner[c] >= 0) return 'track';
    for (let e = 0; e < 4; e++) {
      const m = g.nbr[c * 4 + e];
      if (m >= 0 && plan.owner[m] >= 0) return 'road';
    }
    return 'track';
  };
  const segs: LaneSeg[] = [];
  const byCell: number[][] = Array.from({ length: n }, () => []);
  const push = (cell: number, a: V2, b: V2) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) return;
    const kind = kindOf(cell);
    byCell[cell].push(segs.length);
    segs.push({ cell, a, b, kind, steps: kind !== 'plaza' && Math.abs(ground(b[0], b[1]) - ground(a[0], a[1])) / len > STEEP });
  };
  for (let c = 0; c < n; c++) {
    if (!onWay(c)) continue;
    for (let e = 0; e < 4; e++) {
      const m = g.nbr[c * 4 + e];
      if (m <= c || !onWay(m) || !wayStep(plan, g, c, e, m)) continue;
      // (a gate's or a passage's neighbours on the ways are those its way through opens on: a wall cell is never one)
      const p = g.corner(c, e);
      const q = g.corner(c, e + 1);
      const mid: V2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      push(c, g.centre(c), mid);
      push(m, mid, g.centre(m));
    }
  }
  const tiles: number[] = [];
  for (let c = 0; c < n; c++) if (onWay(c) && (through.has(c) || ways.way[c] === WAY_SQUARE) && byCell[c].length) tiles.push(c);
  const cut = new Set(ways.cutOff);
  const all = [...new Set(ways.entrances.map((e) => e.structure))];
  return { segs, byCell, tiles, joined: all.filter((s) => !cut.has(s)), unjoined: [...cut] };
}

/** the window of a segment's band: within half its width (and `pad`) of it */
export function nearSeg(s: LaneSeg, x: number, y: number, pad = 0): boolean {
  const half = LANE_WIDTH[s.kind] / 2 + pad;
  if (half <= 0) return false;
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (y - s.a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - s.a[0] - dx * t, y - s.a[1] - dy * t) <= half;
}

/** (round 128i) the road bit reaches this far past a band's paving: a column whose middle is this near counts */
export const ROAD_PAD = 0.3;

/**
 * (round 128i, FT-58; round 128k) The road shapes the units' fields prefer (Agents.setRoads, stamped on the GPU —
 * agents/roads.ts), in the lanes' frame: each band (and ROAD_PAD), each thoroughfare tile and square whole.
 */
export function roadShapesOf(lanes: Lanes, ways: Ways, g: WaysGrid): RoadShape[] {
  const out: RoadShape[] = [];
  for (const s of lanes.segs) if (LANE_DRAWN[s.kind]) out.push({ a: s.a, b: s.b, half: LANE_WIDTH[s.kind] / 2 + ROAD_PAD });
  const whole = new Set<number>(lanes.tiles);
  for (let c = 0; c < g.count; c++) if (ways.way[c] === WAY_SQUARE) whole.add(c);
  for (const c of whole) out.push({ quad: [g.corner(c, 0), g.corner(c, 1), g.corner(c, 2), g.corner(c, 3)] });
  return out;
}

/** (round 128i, V128-14) each kind's cost a metre in the agents' road graph */
export const LANE_COST: Record<LaneKind, number> = { road: 0.8, plaza: 0.8, ramp: 0.9, track: 1 };

/**
 * (round 128i, V128-14; round 128k) The roads as the agents' road graph (agents/roadgraph.ts), in the lanes' frame:
 * every piece an edge, joined at the cells' middles and their sides' middles; a stepped climb costs more.
 */
export function laneGraph(lanes: Lanes): RoadGraph {
  return graphOf(lanes.segs.map((s) => ({ a: s.a, b: s.b, cell: s.cell, cost: LANE_COST[s.kind] * (s.steps ? 1.3 : 1) })));
}
