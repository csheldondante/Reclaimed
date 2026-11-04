// The fortress's lanes: roads narrower than a cell (round 128f; the user: "if we want roads smaller than one cell we could
// have certain regions fill in tiles that way. Use voronoi or another offset grid too have tiles generate with roads
// within them at some desired road frequency. I think there is also a technique where you make flow field roads that
// follow contours of the terrain ... my reasoning for the grids is that they are cheap and parallel which is great for
// the GPU"). Agreed with the user:
//  - a second grid offset over the tiles, its edges the lanes inside them. The second grid is two families of level
//    lines of fields known at every tile corner: A runs along the contours (streets), B across them (they climb: stairs
//    where steep). Each tile works out its own pieces from only its four corners' values — marching squares on the
//    quad, the crossing on a side taken from that side's two corners alone, in a fixed order — so the pieces of two
//    tiles meet exactly at the side they share, with no search: a local, parallel rule (one tile a GPU thread);
//  - the frequency is the second grid's spacing, set per district: every lane in the town, every k-th one (tracks) out
//    in the fields, none in the wild. The town's lanes that stop at its edge end on a ring lane (the level line of the
//    district field at the town's edge, marched the same way);
//  - on slopes A is the smoothed ground's height over the district's mean slope — its level lines are the contours, so
//    streets run along the slope; on the flat a plain lattice turned to the land;
//  - the main roads of ways.ts (door to door, through gates, to the stairs) laid on top, a lane wide: per road cell its
//    middle to the middle of each side that leads on (a road, a square, a gate, its door, a stair's foot).
// Corner fields (the district's nearness, the smoothed ground) are a pass over the corners before the tiles: on the GPU
// a jump flood and a blur. Pure: tested without a GPU (lanes.test.ts).
import type { V2 } from '../api/contracts/structures';
import type { FortressPlan } from './plan';
import { WAY_ROAD, WAY_SQUARE, WAY_STAIR, type Ways, type WaysGrid } from './ways';
import type { RoadShape } from '../agents/roads';
import { graphOf, type RoadGraph } from '../agents/roadgraph';

export interface LaneGrid extends WaysGrid {
  readonly verts: ArrayLike<number>;
  readonly quads: ArrayLike<number>;
  readonly columns: readonly (readonly number[])[];
}

/** road: ways.ts's main roads; plaza: a road's way across a square (paved whole: not drawn); ramp: a road up a ramp
 *  (round 128i: its treads are the road: not drawn); lane: along the contours in town; cross: across them in town; ring:
 *  the town's edge; track: a lane kept on out in the fields */
export type LaneKind = 'road' | 'plaza' | 'ramp' | 'lane' | 'cross' | 'ring' | 'track';

export interface LaneSeg {
  cell: number;
  a: V2;
  b: V2;
  kind: LaneKind;
  /** 0 along the contours, 1 across them, 2 the ring, -1 a road, -2 a spur from a road to a lane through its cell */
  family: number;
  level: number;
  /** the side of its cell each end lies on (-1: inside the cell — a road's middle, a lane cut at a district's edge) */
  ea: number;
  eb: number;
  /** a climbing lane steep enough for steps */
  steps: boolean;
  /** (round 128i) not ridden (the agents' road graph leaves it out): a road over the town that was there or water */
  noRide?: boolean;
}

export interface LaneOpts {
  /** the lanes' spacing in the town (m): the second grid's */
  town: number;
  /** the tracks' spacing out in the fields (m): every round(fields / town)-th lane goes on */
  fields: number;
  /** the climbing lanes this many times farther apart than the contour lanes */
  cross: number;
  /** how far from the plan's structures the town reaches, and the fields (m); past them the wild: no lanes */
  townReach: number;
  fieldReach: number;
  /** the ground smoothed over this radius (m) before its contours are taken */
  smooth: number;
  /** the lattice's turn on the flat (radians) */
  angle: number;
}

export const LANE_DEFAULTS: LaneOpts = { town: 14, fields: 42, cross: 2, townReach: 18, fieldReach: 54, smooth: 4, angle: 0.35 };
/** each kind's width (m): a cell is ~6 m across */
// (round 128i: widened from road 2.4, lanes 1.6, ring 1.8, tracks 1.1 — at play zoom (3.2 px a metre) the lanes read
// as faint threads; a road still under half a cell)
export const LANE_WIDTH: Record<LaneKind, number> = { road: 2.6, plaza: 2.6, ramp: 2.6, lane: 2.0, cross: 2.0, ring: 2.2, track: 1.5 };
/** (round 128i) the kinds drawn as paving (a square is paved whole; a ramp's treads are its road) */
export const LANE_DRAWN: Record<LaneKind, boolean> = { road: true, plaza: false, ramp: false, lane: true, cross: true, ring: true, track: true };
/** (round 128i) a spur from a road to a lane is at most this long (m): a cell is ~6 m across */
export const SPUR_MAX = 5;
/** a climbing lane's rise over its run past which it is stepped */
export const STEEP = 0.3;

export interface Lanes {
  segs: LaneSeg[];
  /** per cell the indices of its segments */
  byCell: number[][];
  /** the district's uphill direction, its mean slope, and how far the lanes follow the contours (0 a lattice, 1 contours) */
  uphill: V2;
  slope: number;
  contour: number;
}

export function noLanes(count: number): Lanes {
  return { segs: [], byCell: Array.from({ length: count }, () => []), uphill: [1, 0], slope: 0, contour: 0 };
}

/**
 * The lanes and roads of the plan's ground (box frame). `ground`: the ground's top at a point; `blocked`: a cell
 * something else stands on (the town that was there before the fortress): no lanes on it.
 */
export function lanesOf(
  plan: FortressPlan,
  g: LaneGrid,
  ways: Ways,
  ground: (x: number, y: number) => number,
  opts: Partial<LaneOpts> = {},
  blocked: (c: number) => boolean = () => false,
): Lanes {
  const o: LaneOpts = { ...LANE_DEFAULTS, ...opts };
  const n = g.count;
  const nv = g.verts.length / 2;
  const vx = (v: number) => g.verts[v * 2];
  const vy = (v: number) => g.verts[v * 2 + 1];
  const segs: LaneSeg[] = [];
  const byCell: number[][] = Array.from({ length: n }, () => []);
  const push = (s: LaneSeg) => {
    byCell[s.cell].push(segs.length);
    segs.push(s);
  };

  // ---- the corners' fields (a pass before the tiles)
  const live = new Uint8Array(nv);
  for (let c = 0; c < n; c++) if (g.columns[c].length) for (let k = 0; k < 4; k++) live[g.quads[c * 4 + k]] = 1;
  const sites: V2[] = [];
  for (let c = 0; c < n; c++) if (plan.owner[c] >= 0) sites.push(g.centre(c));
  // the district: 1 at a structure, 0 at the fields' reach (the town's edge at tT)
  const rho = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    if (!live[v]) continue;
    let d2 = Infinity;
    for (const s of sites) d2 = Math.min(d2, (s[0] - vx(v)) ** 2 + (s[1] - vy(v)) ** 2);
    rho[v] = Math.max(0, 1 - Math.sqrt(d2) / o.fieldReach);
  }
  const tT = 1 - o.townReach / o.fieldReach;
  const tF = 1e-3;
  // the ground smoothed (a centre and eight round it)
  const hs = new Float64Array(nv);
  const smooth = (x: number, y: number) => {
    let h = ground(x, y);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      h += ground(x + Math.cos(a) * o.smooth, y + Math.sin(a) * o.smooth);
    }
    return h / 9;
  };
  for (let v = 0; v < nv; v++) if (live[v]) hs[v] = smooth(vx(v), vy(v));
  // the district's slope: per tile a plane through its corners; the mean steepness and the mean way up
  let sg = 0;
  let mx = 0;
  let my = 0;
  let nt = 0;
  for (let c = 0; c < n; c++) {
    const vs = [0, 1, 2, 3].map((k) => g.quads[c * 4 + k]);
    if (!g.columns[c].length || vs.some((v) => rho[v] <= 0)) continue;
    const cx = vs.reduce((s, v) => s + vx(v), 0) / 4;
    const cy = vs.reduce((s, v) => s + vy(v), 0) / 4;
    const ch = vs.reduce((s, v) => s + hs[v], 0) / 4;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let sxh = 0;
    let syh = 0;
    for (const v of vs) {
      const dx = vx(v) - cx;
      const dy = vy(v) - cy;
      const dh = hs[v] - ch;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
      sxh += dx * dh;
      syh += dy * dh;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-9) continue;
    const gx = (syy * sxh - sxy * syh) / det;
    const gy = (sxx * syh - sxy * sxh) / det;
    sg += Math.hypot(gx, gy);
    mx += gx;
    my += gy;
    nt++;
  }
  const slope = nt ? sg / nt : 0;
  const ml = Math.hypot(mx, my) / Math.max(1, nt);
  const up: V2 = ml > 0.01 ? [mx / Math.hypot(mx, my), my / Math.hypot(mx, my)] : [Math.cos(o.angle), Math.sin(o.angle)];
  const along: V2 = [-up[1], up[0]];
  // (how far the contour lanes follow the land: none on the flat, wholly from a slope of 1 in 10)
  const w = Math.max(0, Math.min(1, (slope - 0.03) / 0.07));
  const fA = new Float64Array(nv);
  const fB = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    if (!live[v]) continue;
    const p = vx(v) * up[0] + vy(v) * up[1];
    fA[v] = (w * (hs[v] / Math.max(slope, 1e-3)) + (1 - w) * p) / o.town;
    fB[v] = (vx(v) * along[0] + vy(v) * along[1]) / (o.town * o.cross);
  }
  const ratio = Math.max(1, Math.round(o.fields / o.town));
  const major = (k: number) => ((k % ratio) + ratio) % ratio === 0;

  // ---- per tile (the GPU's thread): its corners only
  /** where level L crosses side e of cell c (from the side's two corners, the lower id first: the same both sides) */
  const cross = (c: number, e: number, f: Float64Array, L: number): { p: V2; lo: number; hi: number; t: number } => {
    const va = g.quads[c * 4 + e];
    const vb = g.quads[c * 4 + ((e + 1) & 3)];
    const lo = Math.min(va, vb);
    const hi = Math.max(va, vb);
    const t = (L - f[lo]) / (f[hi] - f[lo]);
    return { p: [vx(lo) + (vx(hi) - vx(lo)) * t, vy(lo) + (vy(hi) - vy(lo)) * t], lo, hi, t };
  };
  /** marching squares on the quad: the pieces of level L, each its two sides */
  const march = (c: number, f: Float64Array, L: number): [number, number][] => {
    const s = [0, 1, 2, 3].map((k) => f[g.quads[c * 4 + k]] >= L);
    const es: number[] = [];
    for (let e = 0; e < 4; e++) if (s[e] !== s[(e + 1) & 3]) es.push(e);
    if (es.length === 2) return [[es[0], es[1]]];
    if (es.length !== 4) return [];
    // (a saddle: the middle's side decides which corners join)
    const mid = [0, 1, 2, 3].reduce((a, k) => a + f[g.quads[c * 4 + k]], 0) / 4 >= L;
    return mid === s[0] ? [[0, 1], [2, 3]] : [[1, 2], [3, 0]];
  };
  const rampOf = (c: number) => (plan.ramp ? plan.ramp[c] : -1);
  const laneTile = (c: number) => g.columns[c].length > 0 && plan.owner[c] < 0 && ways.way[c] !== WAY_SQUARE && ways.way[c] !== WAY_STAIR && rampOf(c) < 0 && !blocked(c);
  const near = (q: V2, a: V2, b: V2): V2 => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return [a[0] + dx * t, a[1] + dy * t];
  };
  for (let c = 0; c < n; c++) {
    if (!laneTile(c)) continue;
    const vs = [0, 1, 2, 3].map((k) => g.quads[c * 4 + k]);
    if (vs.every((v) => rho[v] <= 0)) continue;
    // the ring: the town's edge
    const ring: LaneSeg[] = [];
    if (tT > 0)
      for (const [e0, e1] of march(c, rho, tT)) {
        const s: LaneSeg = { cell: c, a: cross(c, e0, rho, tT).p, b: cross(c, e1, rho, tT).p, kind: 'ring', family: 2, level: 0, ea: e0, eb: e1, steps: false };
        ring.push(s);
        push(s);
      }
    for (const [fam, f] of [[0, fA], [1, fB]] as const) {
      const lo = Math.min(...vs.map((v) => f[v]));
      const hi = Math.max(...vs.map((v) => f[v]));
      for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
        const big = major(k);
        const keep = big ? tF : tT;
        for (const [e0, e1] of march(c, f, k)) {
          const A = cross(c, e0, f, k);
          const B = cross(c, e1, f, k);
          // (the district along it: from each end's side, as the crossing)
          const ra = rho[A.lo] + (rho[A.hi] - rho[A.lo]) * A.t;
          const rb = rho[B.lo] + (rho[B.hi] - rho[B.lo]) * B.t;
          if (ra < keep && rb < keep) continue;
          let a = A.p;
          let b = B.p;
          let ea = e0;
          let eb = e1;
          if (ra < keep || rb < keep) {
            // cut where the district ends; a town lane's cut end on the ring
            const u = (keep - ra) / (rb - ra);
            let q: V2 = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
            if (!big && ring.length) {
              let best: V2 = q;
              let bd = Infinity;
              for (const r of ring) {
                const p = near(q, r.a, r.b);
                const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
                if (d < bd) {
                  bd = d;
                  best = p;
                }
              }
              q = best;
            }
            if (ra < keep) {
              a = q;
              ea = -1;
            } else {
              b = q;
              eb = -1;
            }
          }
          const town = (ra + rb) / 2 >= tT || !big;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1e-6) continue;
          const steps = fam === 1 && Math.abs(ground(b[0], b[1]) - ground(a[0], a[1])) / len > STEEP;
          push({ cell: c, a, b, kind: town ? (fam === 0 ? 'lane' : 'cross') : 'track', family: fam, level: k, ea, eb, steps });
        }
      }
    }
  }

  // ---- the main roads (ways.ts) on top: per road cell its middle to each side that leads on
  // (round 128i, FT-65: a block's passage as a gate; a ramp entered and left along its axis only)
  const isGate = new Uint8Array(n);
  for (const c of [...ways.gates, ...(ways.passages ?? [])]) isGate[c] = 1;
  const alongRamp = (c: number, e: number) => rampOf(c) < 0 || e === rampOf(c) || e === (rampOf(c) + 2) % 4;
  const doorSide = new Map<number, number[]>();
  const sideTo = (a: number, b: number) => [0, 1, 2, 3].find((e) => g.nbr[a * 4 + e] === b) ?? -1;
  const lead = (c: number, e: number) => doorSide.set(c, [...(doorSide.get(c) ?? []), e]);
  for (const d of ways.doors) lead(d.out, sideTo(d.out, d.cell));
  for (const s of ways.stairs) lead(s.foot, sideTo(s.foot, s.cells[s.cells.length - 1]));
  const onNet = (m: number) => m >= 0 && (ways.way[m] === WAY_ROAD || ways.way[m] === WAY_SQUARE || isGate[m] === 1);
  for (let c = 0; c < n; c++) {
    const w0 = ways.way[c];
    if (w0 !== WAY_ROAD && w0 !== WAY_SQUARE && !isGate[c]) continue;
    const m0 = g.centre(c);
    const sides = new Set(doorSide.get(c) ?? []);
    for (let e = 0; e < 4; e++) {
      const m = g.nbr[c * 4 + e];
      // (a gate leads on only to the net; the net into a gate only where the gate's way runs)
      if (onNet(m) && (!isGate[m] || ways.way[c] !== 0) && (!isGate[c] || ways.way[m] !== 0) && alongRamp(c, e) && alongRamp(m, sideTo(m, c))) sides.add(e);
    }
    for (const e of sides) {
      if (e < 0) continue;
      const a = g.corner(c, e);
      const b = g.corner(c, e + 1);
      push({ cell: c, a: m0, b: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind: w0 === WAY_SQUARE ? 'plaza' : rampOf(c) >= 0 ? 'ramp' : 'road', family: -1, level: 0, ea: -1, eb: e, steps: false, noRide: blocked(c) });
    }
  }
  // (round 128i, V128-14: the agents ride lanes and roads as one network) the roads meet the lanes: from a road cell's
  // middle a spur to each lane line through it or through a cell beside it (across a shared side, both free) that misses
  // the road there — to the line's nearest point, within SPUR_MAX, one a line, of the line's kind, in the lane's cell
  // (so the graph joins it there). Again a rule of a tile and its neighbours. Without them the roads (door to door,
  // through the gate) were an island in the lanes (a flat site by the old town: 35 road nodes, 133 lane nodes apart).
  const hits = (p: LaneSeg, q: LaneSeg) => {
    const d1x = p.b[0] - p.a[0];
    const d1y = p.b[1] - p.a[1];
    const d2x = q.b[0] - q.a[0];
    const d2y = q.b[1] - q.a[1];
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9) return false;
    const ex = q.a[0] - p.a[0];
    const ey = q.a[1] - p.a[1];
    const t = (ex * d2y - ey * d2x) / den;
    const u = (ex * d1y - ey * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  const lanesIn = (c: number) => byCell[c].map((i) => segs[i]).filter((s) => s.family >= 0);
  const roadsIn = (c: number) => byCell[c].map((i) => segs[i]).filter((s) => s.family === -1);
  const spurs: LaneSeg[] = [];
  for (let c = 0; c < n; c++) {
    const roads = roadsIn(c);
    if (!roads.length) continue;
    const m0 = g.centre(c);
    const best = new Map<string, { s: LaneSeg; q: V2; d: number }>();
    const cells = [c, ...[0, 1, 2, 3].map((e) => g.nbr[c * 4 + e]).filter((m) => m >= 0 && laneTile(m))];
    // (a line that meets this road, or the road of the cell beside, needs no spur)
    const met = new Set<string>();
    for (const m of cells) for (const s of lanesIn(m)) if ([...roads, ...roadsIn(m)].some((r) => hits(r, s))) met.add(`${s.family}:${s.level}`);
    for (const m of cells)
      for (const s of lanesIn(m)) {
        const key = `${s.family}:${s.level}`;
        if (met.has(key)) continue;
        const q = near(m0, s.a, s.b);
        const d = Math.hypot(q[0] - m0[0], q[1] - m0[1]);
        if (d < 1e-6 || d > SPUR_MAX) continue;
        if ((best.get(key)?.d ?? Infinity) > d) best.set(key, { s, q, d });
      }
    for (const { s, q } of best.values()) spurs.push({ cell: s.cell, a: m0, b: q, kind: s.kind, family: -2, level: 0, ea: -1, eb: -1, steps: false, noRide: blocked(c) });
  }
  for (const s of spurs) push(s);
  return { segs, byCell, uphill: up, slope, contour: w };
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
 * (round 128i, FT-58) The road shapes the units' fields prefer (Agents.setRoads, stamped on the GPU — agents/roads.ts),
 * in the lanes' frame: each band a lane wide (and ROAD_PAD), each square's cell whole.
 */
export function roadShapesOf(lanes: Lanes, ways: Ways, g: WaysGrid): RoadShape[] {
  const out: RoadShape[] = [];
  for (const s of lanes.segs) if (LANE_WIDTH[s.kind] > 0) out.push({ a: s.a, b: s.b, half: LANE_WIDTH[s.kind] / 2 + ROAD_PAD });
  for (let c = 0; c < g.count; c++) if (ways.way[c] === WAY_SQUARE) out.push({ quad: [g.corner(c, 0), g.corner(c, 1), g.corner(c, 2), g.corner(c, 3)] });
  return out;
}

/** (round 128i, V128-14) each kind's cost a metre in the agents' road graph: the main roads preferred, tracks least */
export const LANE_COST: Record<LaneKind, number> = { road: 0.8, plaza: 0.8, ramp: 0.9, lane: 1, cross: 1, ring: 1, track: 1.15 };

/**
 * (round 128i, V128-14) The lanes and roads as the agents' road graph (agents/roadgraph.ts), in the lanes' frame: every
 * piece an edge, joined where pieces meet at a tile's side or cross within a tile; a stepped climb costs more; a road
 * over the town that was there or water (`noRide`: ways.ts lays roads by the plan alone) left out.
 */
export function laneGraph(lanes: Lanes): RoadGraph {
  return graphOf(lanes.segs.filter((s) => !s.noRide).map((s) => ({ a: s.a, b: s.b, cell: s.cell, cost: LANE_COST[s.kind] * (s.steps ? 1.3 : 1) })));
}
