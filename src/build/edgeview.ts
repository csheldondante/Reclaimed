// How the edge paths show (round 128p, DA-A13 step 1; build/edgenet.ts): the buildings stand back from the paths on
// their edges, and the paths are drawn by kind. Pure.
//  - Insets (DECISIONS round 128p: "inset by path kind"): a block's or the keep's cell's corners move inward from each of
//    its structure's perimeter edges that carries a drawn path, by the path's INSET — the corner where two such edges
//    meet to where their inset lines cross (a mitre). A corner is moved per structure (cells of one structure share it,
//    so the building stays whole); other structures' and open cells' corners stay. So the old border lanes' fault (riders
//    flush against buildings drawn to the full cell, round 128k–n) can't arise: a path always has its clearance.
//  - Paths: the drawn edges joined into chains (a chain ends where three or more drawn edges meet or one ends), each a
//    road feature (the structures draw's linear roads) of its kind's width, on the ground.
import type { LinearFeature } from '../api/contracts/structures';
import type { TownPlan } from './plan';
import type { EdgeNet } from './edgenet';
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
export function insetTiles(grid: Grid, plan: TownPlan, net: EdgeNet): { verts: Float64Array; quads: Uint32Array } {
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

/** The drawn paths as road features: chains of drawn edges, each its kind's width, laid on the ground. */
export function pathFeatures(grid: Grid, net: EdgeNet, ground: (x: number, y: number) => number): LinearFeature[] {
  const nv = grid.verts.length / 2;
  const ne = net.kind.length;
  const at: number[][] = Array.from({ length: nv }, () => []);
  for (let e = 0; e < ne; e++) if (net.kind[e]) (at[net.ends[e * 2]].push(e), at[net.ends[e * 2 + 1]].push(e));
  const used = new Uint8Array(ne);
  const out: LinearFeature[] = [];
  const P = (v: number): V2 => [grid.verts[v * 2], grid.verts[v * 2 + 1]];
  const other = (e: number, v: number) => (net.ends[e * 2] === v ? net.ends[e * 2 + 1] : net.ends[e * 2]);
  const chain = (e0: number, v0: number) => {
    const k = net.kind[e0];
    const vs = [v0];
    let e = e0;
    let v = v0;
    for (;;) {
      used[e] = 1;
      v = other(e, v);
      vs.push(v);
      const next = at[v].filter((x) => !used[x] && net.kind[x] === k);
      if (at[v].length !== 2 || next.length !== 1) break;
      e = next[0];
    }
    const pts = vs.map(P);
    out.push({ kind: 'road', points: pts.map((q) => [q[0], q[1], ground(q[0], q[1]) + 0.12]), ground: pts.map((q) => ground(q[0], q[1])), width: PATH_WIDTH[k] });
  };
  // chains from their ends first (a vertex not of degree 2), then what's left (loops)
  for (let v = 0; v < nv; v++) if (at[v].length && at[v].length !== 2) for (const e of at[v]) if (!used[e]) chain(e, v);
  for (let e = 0; e < ne; e++) if (net.kind[e] && !used[e]) chain(e, net.ends[e * 2]);
  return out;
}
