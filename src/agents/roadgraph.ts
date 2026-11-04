// The agents' road graph (round 128i, V128-14; the user: "Can agents transfer from flow field onto paths on the GPU?
// That seems cheaper and also reliable for moving goods around. We only need the flow fields where they go off tracks
// or where the destinations switch such as resources that deplete").
// An owner (the fortress: its lanes and roads, fortress/lanes.ts laneGraph) hands the agents its roads as a graph in
// its own grid's frame, once a change: nodes where pieces meet or cross, edges along them. On the GPU
// (shaders/roadride.wgsl, agents/ride.ts) a next-hop table per destination node is built when the graph or the
// destinations change; a group that rides follows one shared field onto the network (the road columns are its seeds),
// then edge to edge, and gets off at the node nearest its goal for a straight last leg. Nothing read back.
// This file: the graph's shape and the pure rules — building it from segments (per cell: pieces that meet or cross in
// a cell joined there), the CPU's hop table (the GPU's reference), the node nearest a point.

type P = readonly [number, number];

/** a road piece in its owner's frame: the cell it lies in (pieces only meet or cross within a cell) and its cost a metre */
export interface RoadSeg {
  a: P;
  b: P;
  cell: number;
  cost: number;
}

export interface RoadGraph {
  /** x, y per node */
  xy: Float32Array;
  /** per node its first edge in `adj` and its count */
  start: Uint32Array;
  count: Uint32Array;
  /** per edge: the node it leads to, and its cost (f32 bits) — two u32 an edge, both ways listed */
  adj: Uint32Array;
}

export const noGraph = (): RoadGraph => ({ xy: new Float32Array(0), start: new Uint32Array(0), count: new Uint32Array(0), adj: new Uint32Array(0) });

export function nodeCount(g: RoadGraph): number {
  return g.xy.length / 2;
}

/** nodes the GPU's table holds (shaders/roadride.wgsl MAX_NODES) */
export const MAX_NODES = 1024;
/** where two ends count as one (m) */
const SNAP = 0.02;

/**
 * The graph of a set of road pieces: their ends merged where they meet (within SNAP), and within each cell the pieces
 * that cross, or that one ends on, split there and joined — a local rule a cell, as the lanes are made.
 */
export function graphOf(segs: readonly RoadSeg[]): RoadGraph {
  const key = (p: P) => `${Math.round(p[0] / SNAP)},${Math.round(p[1] / SNAP)}`;
  const ids = new Map<string, number>();
  const xy: number[] = [];
  const node = (p: P): number => {
    const k = key(p);
    let i = ids.get(k);
    if (i === undefined) {
      i = xy.length / 2;
      ids.set(k, i);
      xy.push(p[0], p[1]);
    }
    return i;
  };
  // per segment the points along it (t in 0..1) where it's split
  const cuts: number[][] = segs.map(() => [0, 1]);
  const byCell = new Map<number, number[]>();
  segs.forEach((s, i) => byCell.set(s.cell, [...(byCell.get(s.cell) ?? []), i]));
  const along = (s: RoadSeg, p: P): number => {
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    return ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / (dx * dx + dy * dy || 1);
  };
  const off = (s: RoadSeg, p: P): number => {
    const t = Math.max(0, Math.min(1, along(s, p)));
    return Math.hypot(s.a[0] + (s.b[0] - s.a[0]) * t - p[0], s.a[1] + (s.b[1] - s.a[1]) * t - p[1]);
  };
  for (const list of byCell.values()) {
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const s = segs[list[x]];
        const r = segs[list[y]];
        // (an end of one on the other: a T)
        for (const [u, v, iu] of [
          [s, r, list[y]],
          [r, s, list[x]],
        ] as const)
          for (const p of [u.a, u.b]) {
            const t = along(v, p);
            if (t > 1e-4 && t < 1 - 1e-4 && off(v, p) < SNAP * 2) cuts[iu].push(t);
          }
        // (a crossing)
        const d1x = s.b[0] - s.a[0];
        const d1y = s.b[1] - s.a[1];
        const d2x = r.b[0] - r.a[0];
        const d2y = r.b[1] - r.a[1];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-9) continue;
        const ex = r.a[0] - s.a[0];
        const ey = r.a[1] - s.a[1];
        const t = (ex * d2y - ey * d2x) / den;
        const u = (ex * d1y - ey * d1x) / den;
        if (t > 1e-4 && t < 1 - 1e-4 && u > 1e-4 && u < 1 - 1e-4) {
          cuts[list[x]].push(t);
          cuts[list[y]].push(u);
        }
      }
  }
  const edges = new Map<string, [number, number, number]>();
  segs.forEach((s, i) => {
    const ts = [...new Set(cuts[i])].sort((p, q) => p - q);
    const pt = (t: number): P => [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    for (let k = 0; k + 1 < ts.length; k++) {
      const p = pt(ts[k]);
      const q = pt(ts[k + 1]);
      const a = node(p);
      const b = node(q);
      if (a === b) continue;
      const w = Math.hypot(q[0] - p[0], q[1] - p[1]) * s.cost;
      const ek = a < b ? `${a},${b}` : `${b},${a}`;
      const was = edges.get(ek);
      if (!was || was[2] > w) edges.set(ek, [Math.min(a, b), Math.max(a, b), w]);
    }
  });
  const n = xy.length / 2;
  const nb: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [a, b, w] of edges.values()) {
    nb[a].push([b, w]);
    nb[b].push([a, w]);
  }
  const start = new Uint32Array(n);
  const count = new Uint32Array(n);
  const adj = new Uint32Array(edges.size * 4);
  const fw = new Float32Array(1);
  const fu = new Uint32Array(fw.buffer);
  let o = 0;
  for (let v = 0; v < n; v++) {
    start[v] = o;
    count[v] = nb[v].length;
    for (const [u, w] of nb[v]) {
      fw[0] = w;
      adj[o * 2] = u;
      adj[o * 2 + 1] = fu[0];
      o++;
    }
  }
  return { xy: Float32Array.from(xy), start, count, adj };
}

/** the cost of edge k (adj's f32 bits) */
export function edgeCost(g: RoadGraph, k: number): number {
  return new Float32Array(g.adj.buffer, g.adj.byteOffset + (k * 2 + 1) * 4, 1)[0];
}

export const FAR = 1e9;

/**
 * The CPU's hop table (the GPU's reference): per destination node, every node's cost to it along the roads and the
 * next node on the way (itself at the destination; -1 none). Bellman-Ford, as the GPU's.
 */
export function hopsCpu(g: RoadGraph, dests: readonly number[]): { dist: Float32Array[]; next: Int32Array[] } {
  const n = nodeCount(g);
  const dist: Float32Array[] = [];
  const next: Int32Array[] = [];
  for (const d of dests) {
    const D = new Float32Array(n).fill(FAR);
    const N = new Int32Array(n).fill(-1);
    if (d >= 0 && d < n) {
      D[d] = 0;
      N[d] = d;
    }
    for (let it = 0; it < n; it++) {
      let changed = false;
      const was = D.slice();
      for (let v = 0; v < n; v++)
        for (let k = g.start[v]; k < g.start[v] + g.count[v]; k++) {
          const u = g.adj[k * 2];
          const c = was[u] + edgeCost(g, k);
          if (was[u] < FAR && c < D[v] - 1e-4) {
            D[v] = c;
            N[v] = u;
            changed = true;
          }
        }
      if (!changed) break;
    }
    dist.push(D);
    next.push(N);
  }
  return { dist, next };
}

/** the node nearest (x, y), and how far (none: -1) */
export function nearestNode(g: RoadGraph, x: number, y: number): { node: number; d: number } {
  let best = -1;
  let bd = Infinity;
  for (let v = 0; v < nodeCount(g); v++) {
    const d = Math.hypot(g.xy[v * 2] - x, g.xy[v * 2 + 1] - y);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return { node: best, d: bd };
}

/** the nodes reached from `from` along the roads (a flood: the tests' check that the network is one) */
export function reached(g: RoadGraph, from: number): Set<number> {
  const seen = new Set<number>([from]);
  const todo = [from];
  while (todo.length) {
    const v = todo.pop()!;
    for (let k = g.start[v]; k < g.start[v] + g.count[v]; k++) {
      const u = g.adj[k * 2];
      if (!seen.has(u)) {
        seen.add(u);
        todo.push(u);
      }
    }
  }
  return seen;
}

/** The part of the graph reached from `from` (its nodes renumbered in order): the network a walker can ride. */
export function subgraph(g: RoadGraph, from: number): RoadGraph {
  if (from < 0 || from >= nodeCount(g)) return noGraph();
  const keep = [...reached(g, from)].sort((a, b) => a - b);
  const id = new Map<number, number>();
  keep.forEach((v, i) => id.set(v, i));
  const xy = new Float32Array(keep.length * 2);
  const start = new Uint32Array(keep.length);
  const count = new Uint32Array(keep.length);
  const adj: number[] = [];
  keep.forEach((v, i) => {
    xy[i * 2] = g.xy[v * 2];
    xy[i * 2 + 1] = g.xy[v * 2 + 1];
    start[i] = adj.length / 2;
    count[i] = g.count[v];
    for (let k = g.start[v]; k < g.start[v] + g.count[v]; k++) adj.push(id.get(g.adj[k * 2])!, g.adj[k * 2 + 1]);
  });
  return { xy, start, count, adj: Uint32Array.from(adj) };
}
