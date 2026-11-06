// A town's roads laid (round 128p, DA-A13 step 2): the hybrid — the user: "a hybrid with roads that can intersect our
// irregular grid and the procedural tiles adapt to those intersections. With the default rules we discussed above
// handling all the side streets"; "When the tile is placed far from the other tiles … grow an organic road to them from
// the nearest major road". On a site, in place (its grid's vertices, its plan, its Town's floors), in two phases so
// generation lays its main roads before its buildings (roads first: nothing clipped):
//  mainRoads   1. the radial relax round the town's middle (curveroad.ts radialRelax): the grid rings the centre;
//              2. the main roads as curves: spokes grown over the land from the middle out past the town (curveroad.ts
//                 growRoad) and the roads drawn; each adapts the grid (adaptToCurve) — its cells become the road's
//                 verge; a structure loses the cells a road takes (a wall's cell becomes a gate instead, where it can);
//  finishRoads 3. the edge network (edgenet.ts) with the verge cells, the far rule's structures left out of the lanes;
//              4. each far structure's road grown from the nearest major road to it, adapting the grid the same;
//              5. the terraces levelled (terrace.ts); the network again — its reach the answer;
//              6. the result into the plan's layout (`layout.roads`: the curves, the verge, each cell side's drawn path —
//                 what the view draws, across a worker's post) and the bridges over water as decks in its linear features.
// Generation runs both; an edit (a placement, a drawn road) runs finishRoads again from the layout (roadsOfLayout), a
// drawn road mainRoads' drawing first.
import type { TownSite } from './site';
import type { TownRoadsLayout } from './plan';
import { cellPos, ROW_H } from '../world/lattice';
import { adaptToCurve, chaikin, growRoad, radialRelax, type LandIO } from './curveroad';
import { edgeNetOf, PATH_WIDTH, type EdgeNet } from './edgenet';
import { fixTerraces, type TerraceFix } from './terrace';
import { curvePieces, MAIN_ROAD_WIDTH } from './edgeview';

type V2 = [number, number];

export interface TownRoadsIO {
  ground(x: number, y: number): number;
  /** deep water: no way for a walker (the edge network's) */
  wet(x: number, y: number): boolean;
  /** any water over the ground (a road under it is a bridge); absent: `wet` */
  water?(x: number, y: number): boolean;
  centre: V2;
  stores: V2;
  /** the radial relax (absent: none) */
  radial?: { radius: number; strength?: number; iters?: number };
  /** spokes grown from the middle, evenly round from `spokeAngle` */
  spokes: number;
  spokeAngle?: number;
  /** roads drawn (box-local polylines) */
  drawn?: V2[][];
  /** a main road's width (m: DECISIONS round 128p, a main road the whole cell) and the far rule's n */
  width?: number;
  far?: number;
  /** the town's reach (m from its middle): where the spokes start past; absent, its last structure's */
  reach?: number;
}

export type CurveKind = 'spoke' | 'drawn' | 'far';

/** what the phases carry: the curves laid, the verge, what the roads took */
export interface RoadsState {
  curves: { kind: CurveKind; pts: V2[] }[];
  verge: Set<number>;
  clipped: Set<number>;
  removed: number[];
  gates: number;
  keepWhole: Set<number>;
  /** a road takes the structures' cells it crosses (generation, the lab); an edit's never does: it goes past them */
  clip: boolean;
  ms: Record<string, number>;
}

export interface TownRoads {
  net: EdgeNet;
  curves: { kind: CurveKind; pts: V2[] }[];
  /** structures that lost cells to a road, and those it took whole; wall cells made gates */
  clipped: number[];
  removed: number[];
  gates: number;
  terraces: TerraceFix[];
  ms: Record<string, number>;
}

/** the growing raster's step (m): a road's walk over the land (4: a cell's size; 2 m doubled the cost for nothing seen) */
const GROW_STEP = 4;

function landOf(site: TownSite, io: TownRoadsIO): LandIO {
  const { plan, grid } = site;
  return {
    ground: io.ground,
    wet: io.water ?? io.wet,
    W: site.box.w - 1,
    H: (site.box.h - 1) * ROW_H,
    occupied: (x, y) => {
      const c = grid.cellAtWorld(x, y);
      const st = c >= 0 ? plan.structureAt(c) : null;
      const f = st ? plan.defs[st.type].form : null;
      return f === 'block' || f === 'keep';
    },
  };
}

/** a road along `pts` laid: the grid adapted, its cells the verge (a structure's taken, a wall's a gate) */
function adapt(site: TownSite, st: RoadsState, pts: V2[], width: number): void {
  const { plan, grid, town } = site;
  const a = adaptToCurve(grid, pts, width);
  grid.moveVerts(a.verts);
  for (const c of a.road) {
    const s = plan.structureAt(c);
    if (s && (st.keepWhole.has(s.id) || !st.clip)) continue;
    if (s && plan.defs[s.type].form === 'wall') {
      if (plan.gate[c] || plan.setGate(c, true)) {
        st.gates++;
        continue;
      }
    }
    if (s) {
      st.clipped.add(s.id);
      for (const L of [...plan.levels.each(c)]) (plan.erase(c, L), town.remove(c, L));
      if (!plan.structure(s.id)) st.removed.push(s.id);
    }
    st.verge.add(c);
  }
}

function lapper(ms: Record<string, number>): (k: string) => void {
  let t = performance.now();
  return (k) => {
    const n = performance.now();
    ms[k] = +(n - t).toFixed(1);
    t = n;
  };
}

/** Phase 1: the radial relax and the main roads (spokes, drawn), on a site (structures or none yet). */
export function mainRoads(site: TownSite, io: TownRoadsIO, from?: RoadsState): RoadsState {
  const st: RoadsState = from ?? { curves: [], verge: new Set(), clipped: new Set(), removed: [], gates: 0, keepWhole: new Set(), clip: true, ms: {} };
  const lap = lapper(st.ms);
  const { plan, grid } = site;
  const width = io.width ?? 4;
  const land = landOf(site, io);
  if (io.radial) grid.moveVerts(radialRelax(grid, io.centre, io.radial.radius, io.radial.strength, io.radial.iters));
  lap('radial');
  let R = io.reach ?? 0;
  if (io.reach === undefined)
    for (const s of plan.structures())
      for (const c of s.cells.keys()) {
        const [x, y] = grid.centre(c);
        R = Math.max(R, Math.hypot(x - io.centre[0], y - io.centre[1]));
      }
  for (let k = 0; k < io.spokes; k++) {
    const a = (io.spokeAngle ?? 0) + (2 * Math.PI * k) / io.spokes;
    // its far end: past the town on dry land in the box, walked out along the ray
    let to: V2 | null = null;
    for (let r = R + 10; r < R + 60; r += 2) {
      const p: V2 = [io.centre[0] + Math.cos(a) * r, io.centre[1] + Math.sin(a) * r];
      if (p[0] < 2 || p[1] < 2 || p[0] > land.W - 2 || p[1] > land.H - 2) break;
      if (!land.wet(p[0], p[1])) to = p;
      if (to && r > R + 20) break;
    }
    if (!to) continue;
    const pts = growRoad(land, [io.centre], to, GROW_STEP);
    if (!pts) continue;
    st.curves.push({ kind: 'spoke', pts });
    adapt(site, st, pts, width);
  }
  for (const d of io.drawn ?? []) {
    const pts = chaikin(d, 2);
    st.curves.push({ kind: 'drawn', pts });
    adapt(site, st, pts, width);
  }
  lap('mains');
  return st;
}

/** Phase 2: the edge network, the far structures' roads, the terraces; the result into the plan's layout. */
export function finishRoads(site: TownSite, io: TownRoadsIO, st: RoadsState): TownRoads {
  const lap = lapper(st.ms);
  const { plan, grid, town } = site;
  const width = io.width ?? 4;
  const land = landOf(site, io);
  const netOf = () =>
    edgeNetOf(
      { plan, grid, floor: (c) => town.base[c] },
      { ground: io.ground, wet: io.wet, centre: io.centre, stores: io.stores, roads: [...st.verge], far: io.far ?? 4 },
    );
  let net = netOf();
  lap('net');
  // the far structures' roads: from the nearest major road (the verge's middles; the middle if none)
  if (net.far.length) {
    const from: V2[] = [];
    for (const c of st.verge) from.push(grid.centre(c));
    if (!from.length) from.push(io.centre);
    for (const id of net.far) {
      const s = plan.structure(id);
      if (!s) continue;
      st.keepWhole.add(id);
      // to its side nearest the town's middle
      let to: V2 = grid.centre(s.cells.keys().next().value as number);
      let bd = Infinity;
      for (const c of s.cells.keys())
        for (let k = 0; k < 4; k++) {
          const v0 = grid.quads[c * 4 + k];
          const v1 = grid.quads[c * 4 + ((k + 1) & 3)];
          const m: V2 = [(grid.verts[v0 * 2] + grid.verts[v1 * 2]) / 2, (grid.verts[v0 * 2 + 1] + grid.verts[v1 * 2 + 1]) / 2];
          const d = Math.hypot(m[0] - io.centre[0], m[1] - io.centre[1]);
          if (d < bd) ((bd = d), (to = m));
        }
      const pts = growRoad(land, from, to, GROW_STEP);
      if (!pts) continue;
      st.curves.push({ kind: 'far', pts });
      adapt(site, st, pts, width);
    }
    net = netOf();
    lap('far');
  }
  const terraces = fixTerraces({ plan, grid, town }, net, io.ground);
  if (terraces.length) net = netOf();
  lap('terraces');
  net.curves = st.curves.map((c) => c.pts);
  // into the plan's layout: what the view draws; the bridges over water as decks (claimed as matter: build/claims.ts)
  const sides: number[] = new Array(grid.count * 4).fill(0);
  for (let i = 0; i < sides.length; i++) sides[i] = net.kind[net.edgeOf[i]];
  const water: number[] = [];
  const deep: number[] = [];
  for (let c = 0; c < grid.count; c++) {
    const [x, y] = grid.centre(c);
    if (land.wet(x, y)) water.push(c);
    if (io.wet(x, y)) deep.push(c);
  }
  plan.layout.roads = {
    curves: st.curves.map((c) => ({ kind: c.kind, pts: c.pts.map((p) => [p[0], p[1]] as V2) })),
    verge: [...st.verge],
    sides,
    centre: [io.centre[0], io.centre[1]],
    stores: [io.stores[0], io.stores[1]],
    water,
    deep,
  };
  plan.layout.linear = plan.layout.linear.filter((f) => f.of !== 'mainroad');
  for (const c of net.curves) for (const b of curvePieces([c], io.ground, land.wet).bridges) plan.layout.linear.push({ ...b, of: 'mainroad' });
  lap('layout');
  return { net, curves: st.curves, clipped: [...st.clipped], removed: st.removed, gates: st.gates, terraces, ms: st.ms };
}

/** The roads a plan's layout carries, as the phases' state (an edit's: finishRoads again from them). */
export function roadsOfLayout(layout: { roads?: TownRoadsLayout }): RoadsState {
  const r = layout.roads;
  return {
    curves: (r?.curves ?? []).map((c) => ({ kind: c.kind, pts: c.pts.map((p) => [p[0], p[1]] as V2) })),
    verge: new Set(r?.verge ?? []),
    clipped: new Set(),
    removed: [],
    gates: 0,
    keepWhole: new Set(),
    clip: false,
    ms: {},
  };
}

/**
 * An edit's roads (a placement, an erase): the paths, far roads and terraces again from what the plan's layout carries,
 * the water as generation saw it (per cell). Null: the town has no roads laid (a lanes' town).
 */
export function relayRoads(site: TownSite): TownRoads | null {
  const r = site.plan.layout.roads;
  if (!r) return null;
  const water = new Set(r.water);
  const deep = new Set(r.deep);
  const at = (set: Set<number>) => (x: number, y: number) => set.has(site.grid.cellAtWorld(x, y));
  const io: TownRoadsIO = { ground: (x, y) => site.groundAt(x, y), wet: at(deep), water: at(water), centre: r.centre, stores: r.stores, spokes: 0, far: 4 };
  return finishRoads(site, io, roadsOfLayout(site.plan.layout));
}

/** Both phases (the lab's; generation splits them round its buildings). */
export function layoutTownRoads(site: TownSite, io: TownRoadsIO): TownRoads {
  return finishRoads(site, io, mainRoads(site, io));
}

/**
 * The box columns the roads lie on (their ground bare: plants cleared — the user's "roads clear plants"): within half a
 * main road (and a pad) of each curve, within half a path's width of each drawn edge.
 */
export function roadColumns(site: TownSite): number[] {
  const r = site.plan.layout.roads;
  if (!r) return [];
  const { box, grid } = site;
  const out = new Set<number>();
  const band = (a: V2, b: V2, half: number) => {
    const x0 = Math.min(a[0], b[0]) - half;
    const x1 = Math.max(a[0], b[0]) + half;
    const r0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - half) / ROW_H) - 1);
    const r1 = Math.min(box.h - 1, Math.ceil((Math.max(a[1], b[1]) + half) / ROW_H) + 1);
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const L2 = ex * ex + ey * ey;
    for (let row = r0; row <= r1; row++)
      for (let k = Math.max(0, Math.floor(x0) - 1); k <= Math.min(box.w - 1, Math.ceil(x1) + 1); k++) {
        const [x, y] = cellPos(k, row);
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / L2)) : 0;
        if (Math.hypot(x - a[0] - ex * t, y - a[1] - ey * t) <= half) out.add(row * box.w + k);
      }
  };
  for (const c of r.curves) for (let k = 1; k < c.pts.length; k++) band(c.pts[k - 1], c.pts[k], MAIN_ROAD_WIDTH / 2 + 0.5);
  for (let i = 0; i < r.sides.length; i++) {
    if (!r.sides[i]) continue;
    const c = i >> 2;
    const s = i & 3;
    const a = grid.quads[c * 4 + s];
    const b = grid.quads[c * 4 + ((s + 1) & 3)];
    band([grid.verts[a * 2], grid.verts[a * 2 + 1]], [grid.verts[b * 2], grid.verts[b * 2 + 1]], PATH_WIDTH[r.sides[i]] / 2);
  }
  return [...out];
}
