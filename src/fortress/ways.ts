// The fortress's ways (round 128d; the user: "buildings are supposed to bake their own paths so we probably want roads
// and squares between structures and the stairs up onto the walls"). Baked from the plan by rules, as its shapes are
// (shapes.ts), on the plan's cells — pure, so it's tested without a GPU (ways.test.ts):
//  - doors: each block structure (and the keep) one, on a ground-floor side that opens on a free cell, the side
//    facing the fortress's middle (the keep's; for the keep, its gates or the rest);
//  - roads: a tree over the free cells joining every door and both sides of every gate (gates open the wall's way),
//    grown from the keep's door to the nearest unjoined end each time, cheaper along road already laid so the ways merge;
//  - stairs: each wall run one (another every STAIR_EVERY cells), up from free cells beside a straight stretch of it:
//    a straight flight across as many cells as its height needs (no steeper than SLOPE), from a foot cell to the wall's
//    top — a unit steps up it (the GPU surfaces: solid.ts claims its steps). After the roads, on cells no road or door
//    uses (a flight never cuts a way), its foot on a road if one can be, else the inner side; then its foot joined;
//  - squares: a road cell two doors open on, or one where four ways meet with a door on it; and the courtyards.
// Then the nav graph (NavGraph, structures' contract): road and square nodes, doors into each building's ground floor,
// gates through the wall, the wall-walk along every wall cell's top, stairs from a foot up to it.
//
// What the units walk is the GPU field over the columns (agents.wgsl), not this graph: roads lie on the ground, open to
// it; the stairs' steps and the walls' tops are claimed solid (solid.ts), so the field climbs the stairs and walks the
// wall-walk. The graph is the same ways as data (tests, Inspect, the archers' posts later).
import type { NavGraph, NavLinkKind, NavNode, NavSurface, V2, V3 } from '../api/contracts/structures';
import type { StructureDef, StructureType } from '../api/contracts/fortress';
import { LEVEL_H } from '../build/town';
import { DEFS } from './defs';
import type { FortressPlan } from './plan';
import { WALL_HALF } from './solid';

export interface WaysGrid {
  readonly count: number;
  readonly nbr: Int32Array;
  centre(c: number): [number, number];
  corner(c: number, k: number): [number, number];
}

/** a cell's way: none, a road, a square (a courtyard's too), a stair's flight */
export const WAY_NONE = 0;
export const WAY_ROAD = 1;
export const WAY_SQUARE = 2;
export const WAY_STAIR = 3;
/** the steepest a stair rises (metres up a metre along: a hex column a metre apart, the agents' STEP 1.1) */
export const SLOPE = 0.75;
/** another stair every this many wall cells of a run */
export const STAIR_EVERY = 16;
/** the longest flight (cells) */
const STAIR_MAX = 6;

export interface Door {
  structure: number;
  /** the structure's cell and the side the door is in */
  cell: number;
  side: number;
  /** the free cell it opens on */
  out: number;
}

export interface Stair {
  /** the wall structure, the wall cell it climbs onto, the side it leaves the wall by */
  structure: number;
  wall: number;
  side: number;
  /** the free cells it crosses, from the wall out */
  cells: number[];
  /** the free cell its foot opens on */
  foot: number;
  /** its axis: the wall cell's middle, then the middle of each side it crosses (the last the foot's side) */
  axis: V2[];
}

export interface Ways {
  /** per cell its way (WAY_*) */
  way: Uint8Array;
  doors: Door[];
  stairs: Stair[];
  /** gate cells: their way runs through the wall */
  gates: number[];
  /**
   * (round 128i, FT-65) block cells with a passage (FortressPlan.passage) the roads run through, as through a gate;
   * a ramp's cell (FortressPlan.ramp) is a road's like any free cell, entered and left only along its axis
   */
  passages: number[];
  /** structures whose door (or stair) no road reaches */
  cutOff: number[];
}

/** no ways at all (tests of the shapes' own rules) */
export function noWays(count: number): Ways {
  return { way: new Uint8Array(count), doors: [], stairs: [], gates: [], passages: [], cutOff: [] };
}

/** a binary min-heap of cells by cost (stale entries skipped by the caller) */
class MinHeap {
  private c: number[] = [];
  private k: number[] = [];
  push(cell: number, key: number): void {
    const { c, k } = this;
    let i = c.length;
    c.push(cell);
    k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [c[p], c[i]] = [c[i], c[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  /** the cheapest cell (-1: empty) */
  pop(): number {
    const { c, k } = this;
    if (!c.length) return -1;
    const top = c[0];
    const lc = c.pop()!;
    const lk = k.pop()!;
    if (c.length) {
      c[0] = lc;
      k[0] = lk;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < c.length && k[l] < k[m]) m = l;
        if (r < c.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

/** a cell's side e: its middle */
function sideMid(g: WaysGrid, c: number, e: number): V2 {
  const a = g.corner(c, e);
  const b = g.corner(c, e + 1);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** the side of n that faces c (-1: none) */
function sideTo(g: WaysGrid, n: number, c: number): number {
  for (let e = 0; e < 4; e++) if (g.nbr[n * 4 + e] === c) return e;
  return -1;
}

/** The ways baked from the plan (courtyards: cells shut in by structures — shapes.ts). */
export function waysOf(plan: FortressPlan, g: WaysGrid, courtyards: readonly number[] = [], defs: Record<StructureType, StructureDef> = DEFS): Ways {
  const n = g.count;
  const way = new Uint8Array(n);
  const nb = (c: number, e: number) => g.nbr[c * 4 + (((e % 4) + 4) % 4)];
  const free = (c: number) => c >= 0 && plan.owner[c] < 0;
  const court = new Set(courtyards);
  const structures = plan.structures();
  const formOf = (c: number) => {
    const t = plan.typeAt(c);
    return t ? defs[t].form : null;
  };
  const mean = (cells: number[]): V2 | null => {
    if (!cells.length) return null;
    let x = 0;
    let y = 0;
    for (const c of cells) {
      const [cx, cy] = g.centre(c);
      x += cx / cells.length;
      y += cy / cells.length;
    }
    return [x, y];
  };
  const keepCells = structures.filter((s) => defs[s.type].form === 'keep').flatMap((s) => [...s.cells.keys()]);
  const allCells = structures.flatMap((s) => [...s.cells.keys()]);
  const gates = allCells.filter((c) => formOf(c) === 'wall' && plan.gate[c] && plan.has(c, 0));
  // the fortress's middle: its keep's, else everything's
  const middle = mean(keepCells) ?? mean(allCells) ?? [0, 0];
  const d2 = (c: number, p: V2) => {
    const [x, y] = g.centre(c);
    return (x - p[0]) ** 2 + (y - p[1]) ** 2;
  };

  // ---- doors
  const doors: Door[] = [];
  const gateMid = mean(gates);
  for (const s of structures) {
    const form = defs[s.type].form;
    if (form !== 'block' && form !== 'keep') continue;
    // (the keep faces its gates, else the rest of the fortress; the others face the keep)
    const toward: V2 = form === 'keep' ? (gateMid ?? mean(allCells.filter((c) => plan.owner[c] !== s.id)) ?? middle) : middle;
    let best: Door | null = null;
    let bd = Infinity;
    for (const c of s.cells.keys()) {
      if (!plan.has(c, 0)) continue;
      for (let e = 0; e < 4; e++) {
        const o = nb(c, e);
        if (!free(o)) continue;
        // (a courtyard last: a door should open on the way out)
        const d = d2(o, toward) + (court.has(o) ? 1e6 : 0);
        if (d < bd) {
          bd = d;
          best = { structure: s.id, cell: c, side: e, out: o };
        }
      }
    }
    if (best) doors.push(best);
  }

  // ---- roads: a tree joining the ends, grown from the keep's door (else the first end) to the nearest unjoined end
  const isGate = new Uint8Array(n);
  for (const c of gates) isGate[c] = 1;
  const taken = new Uint8Array(n);
  // (round 128i, FT-65: a block's passage is a way through it, as a gate is the wall's)
  const isPassage = new Uint8Array(n);
  for (const c of allCells) if (plan.passage?.[c] && formOf(c) === 'block' && plan.has(c, 0)) isPassage[c] = 1;
  const passable = (c: number) => c >= 0 && ((free(c) && !taken[c]) || isGate[c] === 1 || isPassage[c] === 1);
  // (a ramp's cell entered and left only along its axis: its high end's side and the side opposite)
  const rampOf = (c: number) => (plan.ramp ? plan.ramp[c] : -1);
  const alongRamp = (c: number, e: number) => rampOf(c) < 0 || e === rampOf(c) || e === (rampOf(c) + 2) % 4;
  const step = (u: number, e: number, m: number) => alongRamp(u, e) && alongRamp(m, sideTo(g, m, u));
  const net = new Uint8Array(n);
  const cutOff = new Set<number>();
  const dist = new Float64Array(n);
  const prev = new Int32Array(n);
  /** the net grown to each end in turn, the nearest first (the ends no way reaches: their structures cut off) */
  const grow = (ends: { cell: number; structure: number }[]) => {
    if (!ends.length) return;
    if (!net.some((x) => x === 1)) net[ends[0].cell] = 1;
    const joined = new Uint8Array(ends.length);
    for (let i = 0; i < ends.length; i++) if (net[ends[i].cell]) joined[i] = 1;
    for (;;) {
      // multi-source from the net (Dijkstra)
      dist.fill(Infinity);
      prev.fill(-1);
      const heap = new MinHeap();
      for (let c = 0; c < n; c++)
        if (net[c]) {
          dist[c] = 0;
          heap.push(c, 0);
        }
      const done = new Uint8Array(n);
      for (let u = heap.pop(); u >= 0; u = heap.pop()) {
        if (done[u]) continue;
        done[u] = 1;
        const [ux, uy] = g.centre(u);
        for (let e = 0; e < 4; e++) {
          const m = nb(u, e);
          if (!passable(m) || done[m] || !step(u, e, m)) continue;
          const [mx, my] = g.centre(m);
          // (along road already laid it's cheap: the ways merge rather than run side by side)
          const w = Math.hypot(mx - ux, my - uy) * (net[m] ? 0.3 : 1);
          if (dist[u] + w < dist[m]) {
            dist[m] = dist[u] + w;
            prev[m] = u;
            heap.push(m, dist[m]);
          }
        }
      }
      let next = -1;
      for (let i = 0; i < ends.length; i++) if (!joined[i] && isFinite(dist[ends[i].cell]) && (next < 0 || dist[ends[i].cell] < dist[ends[next].cell])) next = i;
      if (next < 0) break;
      joined[next] = 1;
      for (let c = ends[next].cell; c >= 0 && !net[c]; c = prev[c]) net[c] = 1;
      // (ends already on the net: joined)
      for (let i = 0; i < ends.length; i++) if (!joined[i] && net[ends[i].cell]) joined[i] = 1;
    }
    for (let i = 0; i < ends.length; i++) if (!joined[i]) cutOff.add(ends[i].structure);
  };
  const ends: { cell: number; structure: number }[] = [];
  const keepDoor = doors.find((d) => defs[plan.structure(d.structure)!.type].form === 'keep');
  if (keepDoor) ends.push({ cell: keepDoor.out, structure: keepDoor.structure });
  for (const d of doors) if (d !== keepDoor) ends.push({ cell: d.out, structure: d.structure });
  for (const c of gates)
    for (let e = 0; e < 4; e++) {
      const m = nb(c, e);
      if (free(m)) ends.push({ cell: m, structure: plan.owner[c] });
    }
  grow(ends);
  const doorsAt = new Int32Array(n);
  for (const d of doors) doorsAt[d.out]++;

  // ---- stairs (after the doors' roads: a flight never cuts a way already laid, its foot on it if it can be)
  const stairs: Stair[] = [];
  const flight = (c: number, e: number): { cells: number[]; foot: number; axis: V2[] } | null => {
    // straight on through each cell (in by one side, out by the opposite) until the flight is long enough
    const levels = plan.top(c) + 1;
    const need = (levels * LEVEL_H) / SLOPE + WALL_HALF;
    const axis: V2[] = [g.centre(c), sideMid(g, c, e)];
    let len = Math.hypot(axis[1][0] - axis[0][0], axis[1][1] - axis[0][1]);
    const cells: number[] = [];
    let prev = c;
    let cur = nb(c, e);
    while (cells.length < STAIR_MAX) {
      if (!free(cur) || court.has(cur) || taken[cur] || net[cur] || doorsAt[cur]) return null;
      const into = sideTo(g, cur, prev);
      const outSide = (into + 2) % 4;
      const m = sideMid(g, cur, outSide);
      const last = axis[axis.length - 1];
      len += Math.hypot(m[0] - last[0], m[1] - last[1]);
      axis.push(m);
      cells.push(cur);
      prev = cur;
      cur = nb(cur, outSide);
      if (len >= need) break;
    }
    if (len < need || !free(cur) || court.has(cur) || taken[cur]) return null;
    return { cells, foot: cur, axis };
  };
  // the wall runs (wall cells that touch, gates among them)
  const runOf = new Int32Array(n).fill(-1);
  const runs: number[][] = [];
  for (const c0 of allCells) {
    if (formOf(c0) !== 'wall' || runOf[c0] >= 0) continue;
    const run = [c0];
    runOf[c0] = runs.length;
    for (let i = 0; i < run.length; i++)
      for (let e = 0; e < 4; e++) {
        const m = nb(run[i], e);
        if (m >= 0 && runOf[m] < 0 && formOf(m) === 'wall') {
          runOf[m] = runs.length;
          run.push(m);
        }
      }
    runs.push(run);
  }
  // (a cell's size: stairs of one run kept a few cells apart)
  const cellSize = (() => {
    const c = allCells[0];
    if (c === undefined) return 5;
    const a = g.corner(c, 0);
    const b = g.corner(c, 1);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) || 5;
  })();
  for (const run of runs) {
    const cands: { wall: number; side: number; f: NonNullable<ReturnType<typeof flight>>; score: number }[] = [];
    for (const c of run) {
      // (a straight stretch on the ground, not a gate: the wall joins on two opposite sides and on neither other side)
      if (plan.gate[c] || plan.levels.bottom(c) !== 0) continue;
      const wallAt = (e: number) => {
        const m = nb(c, e);
        return m >= 0 && (formOf(m) === 'wall' || formOf(m) === 'keep');
      };
      for (let e = 0; e < 4; e++) {
        if (wallAt(e) || wallAt(e + 2) || !wallAt(e + 1) || !wallAt(e + 3)) continue;
        const f = flight(c, e);
        if (!f) continue;
        // (its foot on a road first, then the inner side: its foot nearest the middle)
        cands.push({ wall: c, side: e, f, score: d2(f.foot, middle) + (net[f.foot] ? 0 : 1e9) });
      }
    }
    cands.sort((a, b) => a.score - b.score || a.wall - b.wall || a.side - b.side);
    const want = Math.max(1, Math.round(run.length / STAIR_EVERY));
    const chosen: Stair[] = [];
    while (chosen.length < want) {
      // the first the best; each next the one farthest from those chosen (along the run, by straight distance)
      let best: (typeof cands)[number] | null = null;
      let bd = -1;
      for (const k of cands) {
        if (k.f.cells.some((c) => taken[c]) || taken[k.f.foot]) continue;
        const d = chosen.length ? Math.min(...chosen.map((s) => d2(k.wall, g.centre(s.wall)))) : 0;
        if (!best || d > bd) {
          best = k;
          bd = d;
        }
        if (!chosen.length) break;
      }
      if (!best || (chosen.length && bd < ((cellSize * STAIR_EVERY) / 2) ** 2)) break;
      const s = plan.structureAt(best.wall)!;
      const st: Stair = { structure: s.id, wall: best.wall, side: best.side, cells: best.f.cells, foot: best.f.foot, axis: best.f.axis };
      chosen.push(st);
      for (const c of st.cells) taken[c] = 1;
    }
    stairs.push(...chosen);
  }


  // (the stairs' feet joined to the net, their flights no way)
  for (const s of stairs) for (const c of s.cells) way[c] = WAY_STAIR;
  grow(stairs.map((s) => ({ cell: s.foot, structure: s.structure })));
  for (let c = 0; c < n; c++) if (net[c] && !isGate[c] && !isPassage[c]) way[c] = WAY_ROAD;
  const passages: number[] = [];
  for (let c = 0; c < n; c++) if (net[c] && isPassage[c]) passages.push(c);


  // ---- squares: where doors meet
  for (let c = 0; c < n; c++) {
    if (way[c] !== WAY_ROAD || rampOf(c) >= 0) continue;
    let ways = doorsAt[c];
    for (let e = 0; e < 4; e++) if (net[nb(c, e)]) ways++;
    if (doorsAt[c] >= 2 || (doorsAt[c] >= 1 && ways >= 4)) way[c] = WAY_SQUARE;
  }
  for (const c of court) if (free(c)) way[c] = WAY_SQUARE;
  return { way, doors, stairs, gates, passages, cutOff: [...cutOff] };
}

export interface NavHeights {
  /** the ground's top at a cell's middle */
  ground(c: number): number;
  /** a cell's top: a wall's walk, a block's floor-to-roof top (its highest level's floor + LEVEL_H) */
  top(c: number): number;
  /** a block's ground floor */
  floor(c: number): number;
}

/**
 * The nav graph of the ways (structures' NavGraph): a node a road or square cell, a building's ground floor (its door
 * links it to the road), a gate's passage, the wall-walk a node a wall cell, and stairs from a foot up to the walk.
 */
export function waysNav(ways: Ways, plan: FortressPlan, g: WaysGrid, z: NavHeights): NavGraph {
  const nodes: NavNode[] = [];
  const links: { a: number; b: number; kind: NavLinkKind; cost: number }[] = [];
  const node = (at: V3, surface: NavSurface, building: number) => {
    nodes.push({ id: nodes.length, at, surface, building });
    return nodes.length - 1;
  };
  const link = (a: number, b: number, kind: NavLinkKind) => {
    const p = nodes[a].at;
    const q = nodes[b].at;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    links.push({ a, b, kind, cost: kind === 'stairs' ? d + Math.abs(p[2] - q[2]) : d });
  };
  const n = g.count;
  const at = new Int32Array(n).fill(-1);
  for (let c = 0; c < n; c++) {
    const w = ways.way[c];
    if (w !== WAY_ROAD && w !== WAY_SQUARE) continue;
    const [x, y] = g.centre(c);
    at[c] = node([x, y, z.ground(c) + 0.12], w === WAY_SQUARE ? 'plaza' : 'street', -1);
  }
  for (const c of [...ways.gates, ...(ways.passages ?? [])]) {
    const [x, y] = g.centre(c);
    at[c] = node([x, y, z.ground(c)], 'street', -1);
  }
  const isGate = new Set([...ways.gates, ...(ways.passages ?? [])]);
  for (let c = 0; c < n; c++) {
    if (at[c] < 0) continue;
    for (let e = 0; e < 4; e++) {
      const m = g.nbr[c * 4 + e];
      if (m > c && at[m] >= 0) link(at[c], at[m], isGate.has(c) || isGate.has(m) ? 'gate' : 'walk');
    }
  }
  // buildings' ground floors, through their doors
  for (const d of ways.doors) {
    const [x, y] = g.centre(d.cell);
    const inside = node([x, y, z.floor(d.cell) + 0.05], 'floor', d.structure);
    if (at[d.out] >= 0) link(inside, at[d.out], 'door');
  }
  // the wall-walk: a node a wall cell at its top, joined along the wall
  const walk = new Int32Array(n).fill(-1);
  for (const s of plan.structures()) {
    if (plan.defs[s.type].form !== 'wall') continue;
    for (const c of s.cells.keys()) {
      const [x, y] = g.centre(c);
      walk[c] = node([x, y, z.top(c)], 'rampart', -1);
    }
  }
  for (let c = 0; c < n; c++) {
    if (walk[c] < 0) continue;
    for (let e = 0; e < 4; e++) {
      const m = g.nbr[c * 4 + e];
      if (m > c && walk[m] >= 0) link(walk[c], walk[m], 'walk');
    }
  }
  // stairs: the foot's road up to the walk
  for (const s of ways.stairs) {
    if (walk[s.wall] < 0 || at[s.foot] < 0) continue;
    link(at[s.foot], walk[s.wall], 'stairs');
  }
  return { nodes, links };
}

/** a point along a stair's axis at distance t from the wall's middle, and the axis's direction there */
export function alongAxis(axis: readonly V2[], t: number): { p: V2; d: V2 } {
  let left = t;
  for (let i = 0; i + 1 < axis.length; i++) {
    const a = axis[i];
    const b = axis[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: V2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    if (left <= l || i + 2 === axis.length) return { p: [a[0] + d[0] * left, a[1] + d[1] * left], d };
    left -= l;
  }
  return { p: axis[0], d: [1, 0] };
}

/** a stair's axis length */
export function axisLength(axis: readonly V2[]): number {
  let l = 0;
  for (let i = 0; i + 1 < axis.length; i++) l += Math.hypot(axis[i + 1][0] - axis[i][0], axis[i + 1][1] - axis[i][1]);
  return l;
}

/** where (x, y) lies along a stair's axis: t the distance along it, off the distance from it */
export function onAxis(axis: readonly V2[], x: number, y: number): { t: number; off: number } {
  let best = { t: 0, off: Infinity };
  let t0 = 0;
  for (let i = 0; i + 1 < axis.length; i++) {
    const a = axis[i];
    const b = axis[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const px = a[0] + dx * u;
    const py = a[1] + dy * u;
    const off = Math.hypot(x - px, y - py);
    if (off < best.off) best = { t: t0 + u * Math.sqrt(l2), off };
    t0 += Math.sqrt(l2);
  }
  return best;
}
