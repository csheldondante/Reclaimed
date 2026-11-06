// A town's roads laid (round 128p, DA-A13 step 2): the hybrid — the user: "a hybrid with roads that can intersect our
// irregular grid and the procedural tiles adapt to those intersections. With the default rules we discussed above
// handling all the side streets"; "When the tile is placed far from the other tiles … grow an organic road to them from
// the nearest major road". In order, on a site (in place: its grid's vertices, its plan, its Town's floors):
//  1. the radial relax round the town's middle (curveroad.ts radialRelax): the grid rings the centre;
//  2. the main roads as curves: spokes grown over the land from the middle out past the town (curveroad.ts growRoad),
//     and the roads drawn; each adapts the grid (adaptToCurve) — its cells become road cells; a structure loses the
//     cells a road takes (a wall's cell becomes a gate instead, where it can);
//  3. the edge network (edgenet.ts) with the road cells, the far rule's structures left out of the lanes;
//  4. each far structure's road grown from the nearest major road to it, adapting the grid the same; the network again;
//  5. the terraces levelled (terrace.ts); the network again — its reach the answer.
// Generation and play run the same function (a drawn road, a far placement: steps 2-5 again).
import type { TownSite } from './site';
import { ROW_H } from '../world/lattice';
import { adaptToCurve, chaikin, growRoad, radialRelax, type LandIO } from './curveroad';
import { edgeNetOf, type EdgeNet } from './edgenet';
import { fixTerraces, type TerraceFix } from './terrace';

type V2 = [number, number];

export interface TownRoadsIO {
  ground(x: number, y: number): number;
  wet(x: number, y: number): boolean;
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
}

export interface TownRoads {
  net: EdgeNet;
  curves: { kind: 'spoke' | 'drawn' | 'far'; pts: V2[] }[];
  /** structures that lost cells to a road, and those it took whole; wall cells made gates */
  clipped: number[];
  removed: number[];
  gates: number;
  terraces: TerraceFix[];
  ms: Record<string, number>;
}

export function layoutTownRoads(site: TownSite, io: TownRoadsIO): TownRoads {
  const ms: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => {
    const n = performance.now();
    ms[k] = +(n - t).toFixed(1);
    t = n;
  };
  const { plan, grid, town } = site;
  const width = io.width ?? 4;
  const solidAt = (x: number, y: number) => {
    const c = grid.cellAtWorld(x, y);
    const st = c >= 0 ? plan.structureAt(c) : null;
    const f = st ? plan.defs[st.type].form : null;
    return f === 'block' || f === 'keep';
  };
  const land: LandIO = {
    ground: io.ground,
    wet: io.wet,
    W: site.box.w - 1,
    H: (site.box.h - 1) * ROW_H,
    occupied: solidAt,
  };
  if (io.radial) grid.moveVerts(radialRelax(grid, io.centre, io.radial.radius, io.radial.strength, io.radial.iters));
  lap('radial');
  // the town's reach: its last structure's distance from the middle
  let R = 0;
  for (const st of plan.structures())
    for (const c of st.cells.keys()) {
      const [x, y] = grid.centre(c);
      R = Math.max(R, Math.hypot(x - io.centre[0], y - io.centre[1]));
    }
  const curves: TownRoads['curves'] = [];
  const road = new Set<number>();
  const clipped = new Set<number>();
  const removed: number[] = [];
  let gates = 0;
  const keepWhole = new Set<number>();
  const adapt = (pts: V2[]) => {
    const a = adaptToCurve(grid, pts, width);
    grid.moveVerts(a.verts);
    for (const c of a.road) {
      const st = plan.structureAt(c);
      if (st && keepWhole.has(st.id)) continue;
      if (st && plan.defs[st.type].form === 'wall') {
        if (plan.gate[c] || plan.setGate(c, true)) {
          gates++;
          continue;
        }
      }
      if (st) {
        clipped.add(st.id);
        for (const L of [...plan.levels.each(c)]) (plan.erase(c, L), town.remove(c, L));
        if (!plan.structure(st.id)) removed.push(st.id);
      }
      road.add(c);
    }
  };
  for (let k = 0; k < io.spokes; k++) {
    const a = (io.spokeAngle ?? 0) + (2 * Math.PI * k) / io.spokes;
    // its far end: past the town on dry land in the box, walked out along the ray
    let to: V2 | null = null;
    for (let r = R + 10; r < R + 60; r += 2) {
      const p: V2 = [io.centre[0] + Math.cos(a) * r, io.centre[1] + Math.sin(a) * r];
      if (p[0] < 2 || p[1] < 2 || p[0] > land.W - 2 || p[1] > land.H - 2) break;
      if (!io.wet(p[0], p[1])) to = p;
      if (to && r > R + 20) break;
    }
    if (!to) continue;
    const pts = growRoad(land, [io.centre], to);
    if (!pts) continue;
    curves.push({ kind: 'spoke', pts });
    adapt(pts);
  }
  for (const d of io.drawn ?? []) {
    const pts = chaikin(d, 2);
    curves.push({ kind: 'drawn', pts });
    adapt(pts);
  }
  lap('mains');
  const netOf = () =>
    edgeNetOf(
      { plan, grid, floor: (c) => town.base[c] },
      {
        ground: io.ground,
        wet: io.wet,
        centre: io.centre,
        stores: io.stores,
        roads: [...road],
        far: io.far ?? 4,
      },
    );
  let net = netOf();
  lap('net');
  // the far structures' roads: from the nearest major road (the road cells' middles, the main streets' vertices)
  if (net.far.length) {
    const from: V2[] = [];
    for (const c of road) from.push(grid.centre(c));
    if (!from.length) from.push(io.centre);
    for (const id of net.far) {
      const st = plan.structure(id);
      if (!st) continue;
      keepWhole.add(id);
      // to its side nearest the town's middle
      let to: V2 = grid.centre(st.cells.keys().next().value as number);
      let bd = Infinity;
      for (const c of st.cells.keys())
        for (let s = 0; s < 4; s++) {
          const v0 = grid.quads[c * 4 + s];
          const v1 = grid.quads[c * 4 + ((s + 1) & 3)];
          const m: V2 = [
            (grid.verts[v0 * 2] + grid.verts[v1 * 2]) / 2,
            (grid.verts[v0 * 2 + 1] + grid.verts[v1 * 2 + 1]) / 2,
          ];
          const d = Math.hypot(m[0] - io.centre[0], m[1] - io.centre[1]);
          if (d < bd) ((bd = d), (to = m));
        }
      const pts = growRoad(land, from, to);
      if (!pts) continue;
      curves.push({ kind: 'far', pts });
      adapt(pts);
    }
    net = netOf();
    lap('far');
  }
  const terraces = fixTerraces({ plan, grid, town }, net, io.ground);
  if (terraces.length) net = netOf();
  lap('terraces');
  net.curves = curves.map((c) => c.pts);
  return { net, curves, clipped: [...clipped], removed, gates, terraces, ms };
}
