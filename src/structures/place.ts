// The generator's second half (round 128m, onetown): the draft placed into the town's one plan through the plan's API
// — each building a structure of its type (TownPlan.place), its storeys as levels, what stands of it built (the Town),
// the wall as wall cells with gates, the farm plots as farms, orchards and pastures, the landmarks as types of their
// own — and the layout (the cells' uses, the roads out, the piers, the props, the moored ships) into the plan's layout
// layer. The user: "Generation needs to use the same system as the built town" and "It can do things to add plazas and
// roads but it should not be a different system". After this the draft is dropped: the town is its plan.
import type { BuildingRec, CityPlan, CitySpec, DensityFn, GroundFn, StructurePieces, TileUse, V2 } from '../api/contracts/structures';
import type { StructureType } from '../api/contracts/fortress';
import { QuadGrid } from '../build/quadgrid';
import { typeIndex, type StructureAttrs } from '../build/plan';
import { TownSite, type SiteBox } from '../build/site';
import { LEVEL_H } from '../build/town';
import { townView } from '../build/view';
import { shapesOf } from '../build/shapes';
import { groundSteps, waysNav, waysOf } from '../build/ways';
import type { NavGraph } from '../api/contracts/structures';
import { cellPos, ROW_H } from '../world/lattice';
import { draftCity, shiftPlan, type CityDraft } from './plan';
import { entrancesOf, needsEntrance } from '../build/entrances';
import { finishRoads, mainRoads, type RoadsState, type TownRoadsIO } from '../build/townroads';
import { resample } from './linear';
import { hashf } from './rng';
import { LOOK_FRESH, PIECE_FLOATS } from './pieces';

/** (onetown) a structure's look bit: its plot hedged round, not fenced (a farm's, an orchard's, a pasture's) */
export const LOOK_HEDGE = 1 << 19;

/** a wall's levels (a rampart was WALL_H, 7 m, over the ground: two levels) */
export const WALL_LEVELS = 2;

/** levels for storeys of a height (the plan's are LEVEL_H: a draft's 3 m storeys are fewer, taller levels) */
export const levelsFor = (storeys: number, storeyH: number): number => Math.max(1, Math.round((storeys * storeyH) / LEVEL_H));

/** The type a draft's building is placed as, by its kind and landmark (settle/plan.ts chooses by its use first). */
export function typeOfBuilding(b: BuildingRec): StructureType {
  if (b.mega === 'dome') return 'temple';
  if (b.mega === 'tower') return 'tower';
  switch (b.kind) {
    case 'house':
      return 'house';
    case 'hut':
      return 'hut';
    case 'farmhouse':
      return 'farmhouse';
    case 'barn':
      return 'barn';
    case 'warehouse':
      return 'warehouse';
    case 'sawmill':
      return 'lumber';
    case 'granary':
      return 'granary';
    case 'stable':
      return 'stable';
  }
}

export interface PlaceOpts {
  /** the type each building is placed as (default typeOfBuilding) */
  typeOf?: (b: BuildingRec) => StructureType;
  /**
   * each building's storeys standing now: all of them (default), fewer (a site: the rest planned, the builders' work),
   * 0 (all planned), or null — not placed at all (the town's room to grow: placed when it grows)
   */
  standing?: (b: BuildingRec) => number | null;
  /**
   * (round 128p, DA-A13) the town's roads (build/townroads.ts), laid roads first: the radial relax and the main roads
   * before the buildings (a building keeps none of the cells a road takes), the paths, far roads and terraces after.
   * Absent: none (the lanes' towns, as before)
   */
  roads?: Omit<TownRoadsIO, 'reach'>;
}

/** What placing made: per draft building its structure (-1 none), and what couldn't be placed (counted, not hidden). */
export interface Placed {
  structureOf: Int32Array;
  stats: {
    structures: number;
    blocks: number;
    gatesOpen: number;
    unplaced: number;
    passages: number;
    ms: number;
    /** (round 128p) the roads laid (opts.roads) */
    roads?: { curves: number; verge: number; terraces: number; reached: number; of: number; ms: Record<string, number> };
  };
}

/**
 * Place a draft into a site whose grid is the draft's tiles (`siteOfDraft`): the generator building the town through
 * the plan's API, as the player does.
 */
export function placeDraft(draft: CityDraft, site: TownSite, opts: PlaceOpts = {}): Placed {
  const t0 = performance.now();
  const { tiles, spec } = draft;
  const { plan, town, grid } = site;
  const nq = tiles.use.length;
  if (grid.count !== nq) throw new Error(`placeDraft: the site's grid (${grid.count} cells) isn't the draft's tiles (${nq})`);
  const typeOf = opts.typeOf ?? typeOfBuilding;
  const standing = opts.standing ?? ((b: BuildingRec) => b.storeys);
  const structureOf = new Int32Array(draft.buildings.length).fill(-1);
  const stats: Placed['stats'] = { structures: 0, blocks: 0, gatesOpen: 0, unplaced: 0, passages: 0, ms: 0 };
  /** a structure's blocks built (each level below `upTo` of its cell) and the rest planned, on the Town */
  const stand = (id: number, type: StructureType, upTo: (c: number) => number, floor?: number) => {
    const s = plan.structure(id)!;
    for (const c of s.cells.keys())
      for (const L of plan.levels.each(c)) {
        stats.blocks++;
        const ok = L < upTo(c) ? town.add(c, L, id, typeIndex(type), floor) : town.plan(c, L, true, id, typeIndex(type), floor);
        if (!ok) throw new Error(`placeDraft: ${type} ${id}'s block ${c}:${L} couldn't stand`);
      }
  };

  // ---- the layout: each cell's use (what's built on is the structures'), its block
  for (let q = 0; q < nq; q++) {
    const u = tiles.use[q];
    plan.use[q] = u === 'wall' || u === 'gate' || u === 'field' || u === 'orchard' || u === 'pasture' ? 'outside' : u;
    plan.block[q] = tiles.block[q];
  }
  plan.layout.linear = draft.linear.filter((f) => f.kind !== 'wall' && f.kind !== 'fence' && f.kind !== 'hedge');
  plan.layout.props = draft.props.slice();
  plan.layout.berths = draft.berths.slice();
  plan.layout.works = draft.works ? { at: [draft.works.at[0], draft.works.at[1]], dir: [draft.works.dir[0], draft.works.dir[1]] } : null;

  // ---- (round 128p, DA-A13) roads first: the radial relax and the main roads out past the town's buildings
  let roads: RoadsState | null = null;
  if (opts.roads) {
    let reach = 0;
    for (const b of draft.buildings)
      for (const q of b.quads) {
        const [x, y] = grid.centre(q);
        reach = Math.max(reach, Math.hypot(x - opts.roads.centre[0], y - opts.roads.centre[1]));
      }
    roads = mainRoads(site, { ...opts.roads, reach });
  }
  const verge = roads?.verge ?? new Set<number>();
  const worldPlaced = new Set(draft.placed.map((p) => p.building));

  // ---- the buildings: each a structure of its own, its tiles' storeys as levels
  for (const b of draft.buildings) {
    if (draft.quadBuilding[b.quads[0]] !== b.id) continue;
    const up = standing(b);
    if (up === null) {
      stats.unplaced++;
      continue;
    }
    const pb = buildingOf(draft, b, typeOf(b));
    // (a building the world placed — a card's outcome — stands whole: the road gives way, its cells off the verge)
    if (worldPlaced.has(b.id)) for (const [c] of pb.blocks) verge.delete(c);
    else if (verge.size) pb.blocks = pb.blocks.filter(([c]) => !verge.has(c));
    const s = pb.blocks.length ? placeBuilding(site, pb, up >= b.storeys ? Infinity : up > 0 ? levelsFor(up, b.storeyH) : 0) : -1;
    if (s < 0) {
      stats.unplaced++;
      continue;
    }
    structureOf[b.id] = s;
    stats.structures++;
    stats.blocks += site.plan.blocks(site.plan.structure(s)!);
  }

  // ---- the wall: the ramparts' tiles (a radial town's) and the wall runs round the others, as wall cells; its gates
  const wallCells = new Set<number>();
  const gateCells: number[] = [];
  for (let q = 0; q < nq; q++) {
    if (tiles.use[q] === 'wall') wallCells.add(q);
    if (tiles.use[q] === 'gate') (wallCells.add(q), gateCells.push(q));
  }
  for (const f of draft.linear) {
    if (f.kind !== 'wall') continue;
    // (a run's cells: those its line crosses, a metre at a time, joined edge to edge — a step to a cell only touching
    // the last at a corner, or past it, takes the shortest way between them over the grid's edges)
    let last = -1;
    for (const smp of resample(f, 1)) {
      const c = grid.cellAtWorld(smp.p[0], smp.p[1]);
      if (c < 0 || c === last || plan.owner[c] >= 0) continue;
      if (last >= 0 && grid.edgeTo(last, c) < 0) for (const v of edgePath(grid, last, c, (k) => plan.owner[k] < 0)) wallCells.add(v);
      wallCells.add(c);
      last = c;
    }
  }
  // (a run one cell wide: a cell whose wall neighbours stay joined without it is taken out — a staircase's inner
  // corners, a bridging cell beside another — so the wall's cells are a path, its towers only where it turns or ends)
  thin(grid, wallCells);
  if (wallCells.size) {
    const fresh = (spec.marks ?? []).some((m) => m.kind === 'newwalls');
    const blocks: [number, number][] = [];
    for (const c of wallCells) if (plan.owner[c] < 0) for (let L = 0; L < WALL_LEVELS; L++) blocks.push([c, L]);
    const s = plan.place('wall', blocks, { look: Math.floor(hashf(spec.seed, 77) * 4096) | (fresh ? LOOK_FRESH : 0) });
    if (s) {
      stats.structures++;
      // (a gate stands on a straight run: one the grid turns at is left open — the way through kept, no wall there)
      // (round 128p: where a main road crosses the wall, a gate — else the wall gives way to the road)
      for (const c of wallCells) if (verge.has(c) && plan.owner[c] === s.id && !gateCells.includes(c)) gateCells.push(c);
      for (const g of gateCells) {
        if (plan.owner[g] !== s.id) continue;
        if (!plan.setGate(g, true)) {
          for (let L = WALL_LEVELS - 1; L >= 0; L--) plan.erase(g, L);
          stats.gatesOpen++;
        }
      }
      if (plan.structure(s.id)) stand(s.id, 'wall', () => Infinity);
    }
  }

  // ---- the farm plots: a farm, an orchard or a pasture each (its tiles' use), fenced or hedged round
  const plots = new Map<number, { use: TileUse; cells: number[] }>();
  for (let q = 0; q < nq; q++) {
    const u = tiles.use[q];
    if (u !== 'field' && u !== 'orchard' && u !== 'pasture') continue;
    const key = tiles.block[q] * 4 + (u === 'field' ? 0 : u === 'orchard' ? 1 : 2);
    const p = plots.get(key) ?? plots.set(key, { use: u, cells: [] }).get(key)!;
    p.cells.push(q);
  }
  for (const [key, p] of plots) {
    const type: StructureType = p.use === 'field' ? 'farm' : p.use === 'orchard' ? 'orchard' : 'pasture';
    const block = Math.floor(key / 4);
    const look = Math.floor(hashf(block, spec.seed, 43) * 4096) | (draft.hedged.has(block) ? LOOK_HEDGE : 0);
    const s = plan.place(type, p.cells.filter((c) => plan.owner[c] < 0 && !verge.has(c)).map((c) => [c, 0] as [number, number]), { look });
    if (!s) continue;
    stats.structures++;
    stand(s.id, type, () => Infinity);
  }

  // ---- the landmarks the draft stood free of the tiles: the plaza's fountain, a hold's keep, a port's lighthouse, a
  // mine's headframe, a farming town's windmill — each a structure on the cells under it
  const near = (x: number, y: number): number => {
    let c = grid.cellAtWorld(x, y);
    if (c >= 0 && plan.owner[c] < 0 && !verge.has(c)) return c;
    // (the nearest free cell: a landmark stood beside a building's tile)
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < grid.count; k++) {
      if (plan.owner[k] >= 0 || verge.has(k)) continue;
      const [cx, cy] = grid.centre(k);
      const d = Math.hypot(cx - x, cy - y);
      if (d < bd) (bd = d), (best = k);
    }
    c = bd < 8 ? best : -1;
    return c;
  };
  for (const m of draft.megas) {
    const cx = (m.frame[0][0] + m.frame[2][0]) / 2;
    const cy = (m.frame[0][1] + m.frame[2][1]) / 2;
    let type: StructureType | null = null;
    let cells: number[] = [];
    let levels = Math.max(1, Math.round((m.z1 - m.z0) / LEVEL_H));
    if (m.kind === 'fountain') {
      // (the plaza's tiles that meet where it stands)
      type = 'fountain';
      levels = 1;
      cells = m.quads.filter((q) => [0, 1, 2, 3].some((k) => Math.hypot(grid.corner(q, k)[0] - cx, grid.corner(q, k)[1] - cy) < 0.05) && plan.owner[q] < 0);
    } else if (m.kind === 'keep') {
      type = 'fortress';
      const h = Math.abs(m.frame[2][0] - m.frame[0][0]) / 2;
      for (let q = 0; q < nq; q++) {
        const [x, y] = grid.centre(q);
        if (Math.abs(x - cx) <= h && Math.abs(y - cy) <= h && plan.owner[q] < 0) cells.push(q);
      }
    } else if (m.kind === 'lighthouse' || m.kind === 'headframe' || m.kind === 'windmill') type = m.kind;
    if (!type) continue;
    if (!cells.length) {
      const c = near(cx, cy);
      if (c >= 0) cells = [c];
    }
    if (!cells.length) {
      stats.unplaced++;
      continue;
    }
    const blocks: [number, number][] = [];
    for (const c of cells) for (let L = 0; L < levels; L++) blocks.push([c, L]);
    const s = plan.place(type, blocks, { look: Math.floor(hashf(spec.seed, 77) * 4096) });
    if (!s) {
      stats.unplaced++;
      continue;
    }
    stats.structures++;
    stand(s.id, type, () => Infinity);
  }

  // ---- what the world placed (merge124) and the order the town grew in
  for (const p of draft.placed) if (structureOf[p.building] >= 0) site.placed.set(p.id, structureOf[p.building]);
  site.order = draft.order.map((b) => structureOf[b]).filter((s) => s >= 0);
  // ---- (AGENT_RULES 3b) every open place in the town joined to the land round it, by passages through ground floors
  stats.passages = keepReach(site);
  assertEntered(site);
  // ---- (round 128p, DA-A13) the paths on the grid's edges, the far structures' roads, the terraces: the plan's layout
  if (roads && opts.roads) {
    const r = finishRoads(site, { ...opts.roads }, roads);
    stats.roads = { curves: r.curves.length, verge: r.net.roads.size, terraces: r.terraces.length, reached: r.net.reach.reached, of: r.net.reach.structures, ms: r.ms };
  }
  plan.takeChanged();
  stats.ms = +(performance.now() - t0).toFixed(2);
  return { structureOf, stats };
}

/**
 * (AGENT_RULES 3b; the user: "if they keep getting stuck in walls an obvious fix is to modify things along their path to
 * be passable ... The expectation is that they can get anywhere in or around the city") Every open cell of the town —
 * a yard shut in by houses, the door a house opens on — joined to the open land round it (yards — fields, orchards,
 * pastures — are walked across): a pocket is joined by a
 * passage (an arch through the ground floor: TownPlan.setPassage) through the fewest buildings between it and the land
 * already joined, nearest first. A wall is crossed only at its gates; the keep and the landmarks are never cut through.
 * The world changed, not a walker's rule. How many passages were made.
 */
export function keepReach(site: TownSite): number {
  const { plan, grid } = site;
  const n = grid.count;
  const nb = (c: number, e: number) => grid.nbr[c * 4 + e];
  // (open: no structure, a gate, a passage, or a field — a yard walked across, StructureDef.crossed)
  const open = (c: number) => {
    const t = plan.typeAt(c);
    return !t || !!plan.defs[t].crossed || !!plan.gate[c] || !!plan.passage[c];
  };
  /** a cell a passage may cut: a block's ground floor (not a landmark drawn whole) */
  const cuttable = (c: number) => {
    const t = plan.typeAt(c);
    return !!t && plan.defs[t].form === 'block' && !plan.defs[t].look.mega && plan.has(c, 0) && !plan.passage[c];
  };
  // the joined land: the open cells reached from the grid's rim
  const joined = new Uint8Array(n);
  const flood = (seeds: number[]) => {
    const q = seeds.filter((c) => !joined[c]);
    for (const c of q) joined[c] = 1;
    while (q.length) {
      const u = q.pop()!;
      for (let e = 0; e < 4; e++) {
        const m = nb(u, e);
        if (m >= 0 && !joined[m] && open(m)) {
          joined[m] = 1;
          q.push(m);
        }
      }
    }
  };
  const rim: number[] = [];
  for (let c = 0; c < n; c++) if (open(c) && [0, 1, 2, 3].some((e) => nb(c, e) < 0)) rim.push(c);
  flood(rim);
  let made = 0;
  for (let c0 = 0; c0 < n; c0++) {
    if (joined[c0] || !open(c0)) continue;
    // a pocket: the fewest buildings to cut through to the joined land (0-1 search: open cells free, a block cell one)
    const cost = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const dq: number[] = [];
    // (the whole pocket the start)
    const pocket: number[] = [c0];
    const inPocket = new Uint8Array(n);
    inPocket[c0] = 1;
    for (let i = 0; i < pocket.length; i++)
      for (let e = 0; e < 4; e++) {
        const m = nb(pocket[i], e);
        if (m >= 0 && !inPocket[m] && open(m) && !joined[m]) (inPocket[m] = 1), pocket.push(m);
      }
    for (const c of pocket) (cost[c] = 0), dq.push(c);
    let end = -1;
    for (let head = 0; head < dq.length && end < 0; head++) {
      const u = dq[head];
      for (let e = 0; e < 4; e++) {
        const m = nb(u, e);
        if (m < 0) continue;
        const step = open(m) ? 0 : cuttable(m) ? 1 : Infinity;
        if (cost[u] + step >= cost[m]) continue;
        cost[m] = cost[u] + step;
        prev[m] = u;
        if (joined[m]) {
          end = m;
          break;
        }
        // (a breadth-first queue kept in cost order: free steps first)
        if (step === 0) dq.splice(head + 1, 0, m);
        else dq.push(m);
      }
    }
    if (end < 0) {
      // (no way through anything but walls and landmarks: left — the rest of the pocket marked so it's asked once)
      for (const c of pocket) joined[c] = 2;
      continue;
    }
    for (let c = prev[end]; c >= 0 && !inPocket[c]; c = prev[c])
      if (!open(c)) {
        plan.setPassage(c, true);
        made++;
      }
    flood(pocket);
  }
  // (round 128o) every structure entered (build/entrances.ts): one with none — a house with houses all round it, cell
  // 1188 of the user's start town — gets a passage through the fewest blocks between it and the joined land
  for (const s of plan.structures()) {
    if (!needsEntrance(s.type, plan.defs) || entrancesOf(plan, grid, [], () => false, plan.defs).some((e) => e.structure === s.id)) continue;
    const cost = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const own = (c: number) => plan.owner[c] === s.id;
    const dq: number[] = [];
    for (const c of s.cells.keys()) (cost[c] = 0), dq.push(c);
    let end = -1;
    for (let head = 0; head < dq.length && end < 0; head++) {
      const u = dq[head];
      for (let e = 0; e < 4; e++) {
        const m = nb(u, e);
        if (m < 0 || own(m)) continue;
        const step = joined[m] === 1 ? 0 : cuttable(m) ? 1 : Infinity;
        if (cost[u] + step >= cost[m]) continue;
        cost[m] = cost[u] + step;
        prev[m] = u;
        if (joined[m] === 1) {
          end = m;
          break;
        }
        dq.push(m);
      }
    }
    if (end < 0) continue;
    const cut: number[] = [];
    for (let c = prev[end]; c >= 0 && !own(c); c = prev[c]) cut.push(c);
    for (const c of cut) {
      plan.setPassage(c, true);
      made++;
    }
    flood(cut);
  }
  return made;
}

/**
 * (round 128o) Generation's check: every structure that needs an entrance has one (build/entrances.ts) — a structure
 * with no way in is the generator's bug, a loud error here, never a building the builders can't reach.
 */
export function assertEntered(site: TownSite): void {
  const { plan, grid } = site;
  const has = new Set(entrancesOf(plan, grid, [], () => false, plan.defs).map((e) => e.structure));
  const without = plan.structures().filter((s) => needsEntrance(s.type, plan.defs) && !has.has(s.id));
  if (without.length) throw new Error(`town ${site.id}: no way into ${without.map((s) => `the ${s.type} ${s.id} (cells ${[...s.cells.keys()].join(', ')})`).join('; ')}`);
}

/** the cells between a and b (not a, b) on a shortest way over the grid's edges, through cells `free` allows (≤ 4 steps) */
function edgePath(grid: QuadGrid, a: number, b: number, free: (c: number) => boolean): number[] {
  const prev = new Map<number, number>([[a, -1]]);
  let front = [a];
  for (let d = 0; d < 4 && !prev.has(b); d++) {
    const next: number[] = [];
    for (const c of front)
      for (let e = 0; e < 4; e++) {
        const n = grid.nbr[c * 4 + e];
        if (n < 0 || prev.has(n) || (n !== b && !free(n))) continue;
        prev.set(n, c);
        next.push(n);
      }
    front = next;
  }
  if (!prev.has(b)) return [];
  const out: number[] = [];
  for (let c = prev.get(b)!; c !== a && c >= 0; c = prev.get(c)!) out.push(c);
  return out;
}

/** Take out of a set of wall cells those whose wall neighbours stay joined (within a few cells) without them. */
function thin(grid: QuadGrid, cells: Set<number>): void {
  const nbrs = (c: number) => [0, 1, 2, 3].map((e) => grid.nbr[c * 4 + e]).filter((n) => n >= 0 && cells.has(n));
  const joined = (from: number, to: number[], without: number) => {
    const seen = new Set([from, without]);
    let front = [from];
    for (let d = 0; d < 6 && front.length; d++) {
      const next: number[] = [];
      for (const c of front) for (const n of nbrs(c)) if (!seen.has(n)) (seen.add(n), next.push(n));
      front = next;
    }
    return to.every((t) => seen.has(t));
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of [...cells].sort((a, b) => a - b)) {
      const ns = nbrs(c);
      if (ns.length < 2) continue;
      if (!joined(ns[0], ns.slice(1), c)) continue;
      cells.delete(c);
      changed = true;
    }
  }
}

/** A building as the plan takes it: its type, its blocks (cell, level), what it's given. */
export interface PlannedBuilding {
  type: StructureType;
  blocks: [number, number][];
  attrs: StructureAttrs;
}

/** A draft's building as the plan takes it: its tiles' storeys as levels (a landmark's all one height). */
export function buildingOf(draft: CityDraft, b: BuildingRec, type: StructureType): PlannedBuilding {
  const blocks: [number, number][] = [];
  for (const q of b.quads) {
    const n = b.mega ? levelsFor(b.storeys, b.storeyH) : levelsFor(draft.quadStoreys[q], b.storeyH);
    for (let L = 0; L < n; L++) blocks.push([q, L]);
  }
  // (its floor the generator's: on its lot's high side, or dug into the hill — what a flood's level was judged by)
  return { type, blocks, attrs: { look: b.look, district: b.district, ...(b.wear ? { wear: b.wear } : {}), floor: b.base } };
}

/**
 * Place one building into a site's plan (TownPlan.place) and its blocks on the Town: each level under `built` standing,
 * the rest planned (a site: the builders' work). The structure's id; -1 if none of it could be painted.
 */
export function placeBuilding(site: TownSite, pb: PlannedBuilding, built: number): number {
  const s = site.plan.place(pb.type, pb.blocks, pb.attrs);
  if (!s) return -1;
  const t = typeIndex(pb.type);
  for (const c of s.cells.keys())
    for (const L of site.plan.levels.each(c)) {
      const ok = L < built ? site.town.add(c, L, s.id, t, pb.attrs.floor) : site.town.plan(c, L, true, s.id, t, pb.attrs.floor);
      if (!ok) throw new Error(`placeBuilding: ${pb.type} ${s.id}'s block ${c}:${L} couldn't stand`);
    }
  site.plan.takeChanged();
  return s.id;
}

/** A site on a draft's tiles: its grid the tiles over the box (the draft made in the box's frame). */
export function siteOfDraft(id: string, draft: CityDraft, box: SiteBox, ground: Float32Array): TownSite {
  const grid = new QuadGrid(box.w, box.h, draft.tiles.verts, draft.tiles.quads);
  return new TownSite(id, draft.spec.seed, box, grid, draft.spec.style, ground);
}

/**
 * A city planned on its own (the structures viewer, the tests): a box round it, the draft made in the box's frame,
 * placed into a site, everything standing, its view moved back to the spec's frame. Same spec + ground → same plan.
 */
export function planTown(spec: CitySpec, ground: GroundFn, water?: GroundFn, densityIn?: DensityFn): { site: TownSite; city: CityPlan; extra: StructurePieces; draft: CityDraft; placed: Placed; dx: number; dy: number } {
  const R = spec.radius;
  const E = Math.max(spec.farmland ?? 0, spec.walls ? R * 1.25 + 8 : R + 4);
  const x0 = Math.floor(spec.at[0] - E - 6);
  const y0 = 2 * Math.floor((spec.at[1] - E - 6) / ROW_H / 2);
  const w = Math.ceil(2 * E + 12) + 2;
  const h = 2 * Math.ceil((2 * E + 12) / ROW_H / 2) + 2;
  const dx = x0;
  const dy = y0 * ROW_H;
  const sh = (p: V2): V2 => [p[0] - dx, p[1] - dy];
  const local: CitySpec = {
    ...spec,
    at: sh(spec.at),
    ...(spec.works ? { works: { at: sh(spec.works.at), dir: spec.works.dir } } : {}),
    ...(spec.keepOut ? { keepOut: spec.keepOut.map((k) => ({ at: sh(k.at), r: k.r })) } : {}),
    ...(spec.marks ? { marks: spec.marks.map((m) => (m.at ? { ...m, at: sh(m.at) } : m)) } : {}),
  };
  const g = (x: number, y: number) => ground(x + dx, y + dy);
  const wl = water ? (x: number, y: number) => water(x + dx, y + dy) : undefined;
  const dl = densityIn ? (x: number, y: number) => densityIn(x + dx, y + dy) : undefined;
  const draft = draftCity(local, g, wl, dl, E);
  const box: SiteBox = { x0, y0, w, h };
  const cols = new Float32Array(w * h);
  for (let col = 0; col < cols.length; col++) cols[col] = g(...cellPos(col % w, Math.floor(col / w)));
  const site = siteOfDraft(`city:${spec.seed}`, draft, box, cols);
  const placed = placeDraft(draft, site);
  const { city, extra } = townView(site, { ground: g });
  // (the town's nav: its ways' — roads and squares, doors, gates, stairs onto the wall-walk: fortress/ways.ts)
  city.nav = townNav(site);
  shiftPlan(city, -dx, -dy);
  for (let i = 0; i < extra.count; i++)
    for (let k = 0; k < 4; k++) {
      extra.data[i * PIECE_FLOATS + k * 2] += dx;
      extra.data[i * PIECE_FLOATS + k * 2 + 1] += dy;
    }
  city.spec = { ...spec };
  const { roads: _roads, ...counts } = placed.stats;
  void _roads;
  city.stats = { ...draft.stats, ...counts };
  return { site, city, extra, draft, placed, dx, dy };
}

/** A town's nav graph (box frame; world z): its ways' (fortress/ways.ts waysNav) — the one path rule of every town. */
export function townNav(site: TownSite): NavGraph {
  const { plan, town, grid } = site;
  const courts = shapesOf(plan, grid, (c) => town.base[c]).courtyards.flatMap((ct) => ct.cells);
  const ways = waysOf(plan, grid, { courtyards: courts, walk: groundSteps(grid, (x, y) => site.groundAt(x, y)) });
  const groundOf = (c: number) => {
    const cols = grid.columns[c];
    let z = 0;
    for (const col of cols) z += site.ground(col) / cols.length;
    return cols.length ? z : town.base[c];
  };
  return waysNav(ways, plan, grid, { ground: groundOf, top: (c) => town.floorZ(c, Math.max(0, plan.top(c))) + LEVEL_H, floor: (c) => town.floorZ(c, 0) });
}

/** A city planned on its own, as the plan's view (planTown's city). */
export function planCity(spec: CitySpec, ground: GroundFn, water?: GroundFn, densityIn?: DensityFn): CityPlan {
  return planTown(spec, ground, water, densityIn).city;
}
