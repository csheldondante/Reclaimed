// How the edge paths show (round 128p, DA-A13 step 1; build/edgenet.ts): the buildings stand back from the paths on
// their edges, and the paths are drawn by kind. Pure.
//  - Insets (DECISIONS round 128p: "inset by path kind"): a block's or the keep's cell's corners move inward from each of
//    its structure's perimeter edges that carries a drawn path, by the path's INSET — the corner where two such edges
//    meet to where their inset lines cross (a mitre). A corner is moved per structure (cells of one structure share it,
//    so the building stays whole); other structures' and open cells' corners stay. So the old border lanes' fault (riders
//    flush against buildings drawn to the full cell, round 128k–n) can't arise: a path always has its clearance.
//  - Paths: paving — each drawn edge a strip of its kind's width, each join a square (pathPaving), draped on the ground.
import type { LinearFeature } from '../api/contracts/structures';
import type { TownPlan } from './plan';
import type { PathsView } from './edgenet';
import { INSET, PATH_WIDTH } from './edgenet';

type V2 = [number, number];

interface Grid {
  count: number;
  verts: ArrayLike<number>;
  quads: ArrayLike<number>;
  centre(c: number): [number, number];
}

/** a mitre: v moved inward from the edges at it (each a unit inward normal and its inset) */
function mitre(v: V2, ns: { n: V2; d: number }[]): V2 {
  if (!ns.some((x) => x.d > 0)) return v;
  if (ns.length === 1) return [v[0] + ns[0].n[0] * ns[0].d, v[1] + ns[0].n[1] * ns[0].d];
  // the two lines n·(p − v) = d: solve for p − v (a pinch, four edges at v: its first two)
  const [a, b] = [ns[0], ns[1]];
  const det = a.n[0] * b.n[1] - a.n[1] * b.n[0];
  const dmax = Math.max(a.d, b.d);
  if (Math.abs(det) < 1e-3) {
    const m = a.d >= b.d ? a : b;
    return [v[0] + m.n[0] * m.d, v[1] + m.n[1] * m.d];
  }
  let x = (a.d * b.n[1] - b.d * a.n[1]) / det;
  let y = (a.n[0] * b.d - b.n[0] * a.d) / det;
  // (a sharp corner's mitre runs far: held to twice the inset)
  const L = Math.hypot(x, y);
  if (L > 2 * dmax) ((x *= (2 * dmax) / L), (y *= (2 * dmax) / L));
  return [v[0] + x, v[1] + y];
}

/**
 * The tiles' corners with the buildings inset: the grid's vertices first (unchanged), then a moved copy per (vertex,
 * structure) that an inset moves; `quads` the cells' corners (a building's cells pointing at their structure's copies).
 */
export function insetTiles(grid: Grid, plan: TownPlan, net: PathsView): { verts: Float64Array; quads: Uint32Array } {
  const verts: number[] = Array.from(grid.verts);
  const quads = Uint32Array.from(grid.quads);
  const P = (v: number): V2 => [grid.verts[v * 2], grid.verts[v * 2 + 1]];
  const copies = new Map<string, number>();
  for (let c = 0; c < grid.count; c++) {
    const st = plan.structureAt(c);
    if (!st) continue;
    const form = plan.defs[st.type].form;
    if (form !== 'block' && form !== 'keep') continue;
    for (let k = 0; k < 4; k++) {
      const v = grid.quads[c * 4 + k];
      const key = `${v}:${st.id}`;
      if (copies.has(key)) {
        quads[c * 4 + k] = copies.get(key)!;
        continue;
      }
      // the structure's perimeter edges at v: each with its normal into the structure's cell and its inset
      const ns: { n: V2; d: number }[] = [];
      for (const sc of st.cells.keys())
        for (let s = 0; s < 4; s++) {
          const a = grid.quads[sc * 4 + s];
          const b = grid.quads[sc * 4 + ((s + 1) & 3)];
          if (a !== v && b !== v) continue;
          const e = net.edgeOf[sc * 4 + s];
          const other = net.cells[e * 2] === sc ? net.cells[e * 2 + 1] : net.cells[e * 2];
          if (other >= 0 && plan.structureAt(other)?.id === st.id) continue;
          const pa = P(a);
          const pb = P(b);
          const L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
          let n: V2 = [-(pb[1] - pa[1]) / L, (pb[0] - pa[0]) / L];
          const [cx, cy] = grid.centre(sc);
          if ((cx - pa[0]) * n[0] + (cy - pa[1]) * n[1] < 0) n = [-n[0], -n[1]];
          ns.push({ n, d: INSET[net.kind[e]] ?? 0 });
        }
      const p = mitre(P(v), ns);
      if (p[0] === P(v)[0] && p[1] === P(v)[1]) {
        copies.set(key, v);
        continue;
      }
      const id = verts.length / 2;
      verts.push(p[0], p[1]);
      copies.set(key, id);
      quads[c * 4 + k] = id;
    }
  }
  return { verts: Float64Array.from(verts), quads };
}

/**
 * The drawn paths as paving (DECISIONS round 128p: "Paving fill"): each drawn edge a strip its kind's width along it, and
 * each vertex a drawn edge reaches a square as wide as its widest path (the joins), laid on the ground as it is (the
 * streets' paving: draped). Townscaper's look: the inset strips between the buildings paved.
 */
export function pathPaving(
  grid: Grid,
  net: PathsView,
  ground: (x: number, y: number) => number,
): { frame: [V2, V2, V2, V2]; foot: number }[] {
  const out: { frame: [V2, V2, V2, V2]; foot: number }[] = [];
  const P = (v: number): V2 => [grid.verts[v * 2], grid.verts[v * 2 + 1]];
  const joinW = new Map<number, { w: number; d: V2 }>();
  for (let e = 0; e < net.kind.length; e++) {
    const k = net.kind[e];
    if (!k) continue;
    // (a main road's cells are its verge: the curve is the road, drawn over them — curveFeatures)
    if (net.roads.has(net.cells[e * 2]) || net.roads.has(net.cells[e * 2 + 1])) continue;
    const a = P(net.ends[e * 2]);
    const b = P(net.ends[e * 2 + 1]);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const h = PATH_WIDTH[k] / 2;
    const n: V2 = [-d[1] * h, d[0] * h];
    out.push({
      frame: [
        [a[0] - n[0], a[1] - n[1]],
        [b[0] - n[0], b[1] - n[1]],
        [b[0] + n[0], b[1] + n[1]],
        [a[0] + n[0], a[1] + n[1]],
      ],
      foot: Math.min(ground(a[0], a[1]), ground(b[0], b[1])),
    });
    for (const v of [net.ends[e * 2], net.ends[e * 2 + 1]]) if ((joinW.get(v)?.w ?? 0) < h) joinW.set(v, { w: h, d });
  }
  for (const [v, { w, d }] of joinW) {
    const p = P(v);
    const u: V2 = [d[0] * w, d[1] * w];
    const n: V2 = [-d[1] * w, d[0] * w];
    out.push({
      frame: [
        [p[0] - u[0] - n[0], p[1] - u[1] - n[1]],
        [p[0] + u[0] - n[0], p[1] + u[1] - n[1]],
        [p[0] + u[0] + n[0], p[1] + u[1] + n[1]],
        [p[0] - u[0] + n[0], p[1] - u[1] + n[1]],
      ],
      foot: ground(p[0], p[1]),
    });
  }
  return out;
}

/** a main road's drawn width (DECISIONS round 128p: a main road the whole cell) */
export const MAIN_ROAD_WIDTH = 4;

/**
 * The main roads' curves drawn smooth (the user: "the smoother roads will make this even better"): each curve's dry runs
 * paved — a quad a 2 m step, its kind's width, overlapping the next a little so the bends close — draped on the ground as
 * it is (as the paths' paving); its wet runs a bridge (its deck at the higher bank's ground and a little).
 */
export function curvePieces(
  curves: V2[][],
  ground: (x: number, y: number) => number,
  wet: (x: number, y: number) => boolean,
): { paves: { frame: [V2, V2, V2, V2]; foot: number }[]; bridges: LinearFeature[] } {
  const paves: { frame: [V2, V2, V2, V2]; foot: number }[] = [];
  const bridges: LinearFeature[] = [];
  const h = MAIN_ROAD_WIDTH / 2;
  for (const c of curves) {
    const pts: V2[] = [c[0]];
    for (let k = 1; k < c.length; k++) {
      const a = c[k - 1];
      const b = c[k];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / 2));
      for (let i = 1; i <= n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
    }
    let bridge: V2[] = [];
    const flush = () => {
      if (bridge.length >= 2) {
        const g = bridge.map((q) => ground(q[0], q[1]));
        const deck = Math.max(g[0], g[g.length - 1]) + 0.6;
        bridges.push({
          kind: 'bridge',
          points: bridge.filter((_, i) => i % 2 === 0 || i === bridge.length - 1).map((q) => [q[0], q[1], deck]),
          ground: g.filter((_, i) => i % 2 === 0 || i === bridge.length - 1),
          width: MAIN_ROAD_WIDTH,
        });
      }
      bridge = [];
    };
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (wet(mid[0], mid[1])) {
        if (!bridge.length) bridge.push(a);
        bridge.push(b);
        continue;
      }
      flush();
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const d: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      const e = 0.3;
      const p0: V2 = [a[0] - d[0] * e, a[1] - d[1] * e];
      const p1: V2 = [b[0] + d[0] * e, b[1] + d[1] * e];
      const n: V2 = [-d[1] * h, d[0] * h];
      paves.push({
        frame: [
          [p0[0] - n[0], p0[1] - n[1]],
          [p1[0] - n[0], p1[1] - n[1]],
          [p1[0] + n[0], p1[1] + n[1]],
          [p0[0] + n[0], p0[1] + n[1]],
        ],
        foot: Math.min(ground(a[0], a[1]), ground(b[0], b[1])),
      });
    }
    flush();
  }
  return { paves, bridges };
}
