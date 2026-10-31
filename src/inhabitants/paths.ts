// Walk paths for townsfolk (round 117). The user (r117): "Let's bake paths into the tiles we generate so agents can
// interact with them. Taking elevators, stairs, walking on ramparts." The structures track bakes them; this file
// packs a WalkPaths (api/contracts/inhabitants.ts) for the GPU and stands in a small set until structures give one.
//
// GPU layout (inhabitants.wgsl, after the groups' orders): nodes [PATH_NODES] vec4 (x, y, z; z < -1e8 on the
// ground), adjacency [PATH_NODES] vec4 (up to 4 edge ids, -1 none), edges [PATH_EDGES] vec4 (a, b, kind, length).

import type { WalkPaths } from '../api/contracts/inhabitants';

export const PATH_NODES = 512;
export const PATH_EDGES = 1024;
export const EDGE_KIND = { walk: 0, stairs: 1, rampart: 2, elevator: 3, ladder: 4 } as const;
const GROUND = -1e9;

/** write `paths` into `out` from float offset `at`; returns the counts. Throws past the room or a node with > 4 edges. */
export function packPaths(paths: WalkPaths, out: Float32Array, at: number): { nodes: number; edges: number } {
  const { nodes, edges } = paths;
  if (nodes.length > PATH_NODES) throw new Error(`paths: ${nodes.length} nodes (max ${PATH_NODES})`);
  if (edges.length > PATH_EDGES) throw new Error(`paths: ${edges.length} edges (max ${PATH_EDGES})`);
  const adj = nodes.map(() => [] as number[]);
  edges.forEach((e, i) => {
    if (e.a < 0 || e.b < 0 || e.a >= nodes.length || e.b >= nodes.length || e.a === e.b) throw new Error(`paths: edge ${i} (${e.a}-${e.b})`);
    adj[e.a].push(i);
    adj[e.b].push(i);
  });
  out.fill(0, at, at + (PATH_NODES * 2 + PATH_EDGES) * 4);
  nodes.forEach((n, i) => {
    if (adj[i].length > 4) throw new Error(`paths: node ${i} has ${adj[i].length} edges (max 4)`);
    out.set([n.at[0], n.at[1], n.at[2] ?? GROUND, 0], at + i * 4);
    const a = [-1, -1, -1, -1];
    adj[i].forEach((e, k) => (a[k] = e));
    out.set(a, at + (PATH_NODES + i) * 4);
  });
  edges.forEach((e, i) => {
    const A = nodes[e.a].at;
    const B = nodes[e.b].at;
    const dz = A[2] !== null && B[2] !== null ? B[2] - A[2] : 0;
    out.set([e.a, e.b, EDGE_KIND[e.kind], Math.hypot(B[0] - A[0], B[1] - A[1], dz)], at + (PATH_NODES * 2 + i) * 4);
  });
  return { nodes: nodes.length, edges: edges.length };
}

/**
 * A stand-in for the structures track's baked paths round `c`: a ground loop (a lane round a yard), a stair
 * spiralling up a tower `towerH` tall to a rampart walk round its top, and an elevator back down. `ground(x, y)`
 * gives the ground's height (the stair and the rampart are set from the tower's foot).
 */
export function standInPaths(c: [number, number], ground: (x: number, y: number) => number, opts: { radius?: number; towerH?: number } = {}): WalkPaths {
  const R = opts.radius ?? 14;
  const H = opts.towerH ?? 9;
  const nodes: WalkPaths['nodes'] = [];
  const edges: WalkPaths['edges'] = [];
  const add = (x: number, y: number, z: number | null) => nodes.push({ at: [x, y, z] }) - 1;
  // the lane: 12 nodes round the yard, on the ground
  const lane: number[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    lane.push(add(c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R, null));
  }
  lane.forEach((n, k) => edges.push({ a: n, b: lane[(k + 1) % 12], kind: 'walk' }));
  // the tower at the yard's middle: a stair round it from the lane's node 0 up to its top
  const z0 = ground(c[0], c[1]);
  const tr = 3.2;
  let last = lane[0];
  const turns = 10;
  for (let k = 0; k <= turns; k++) {
    const a = (k / turns) * Math.PI * 2 * 1.25;
    const n = add(c[0] + Math.cos(a) * tr, c[1] + Math.sin(a) * tr, z0 + (H * k) / turns);
    edges.push({ a: last, b: n, kind: k === 0 ? 'walk' : 'stairs' });
    last = n;
  }
  // the rampart round the top
  const ramp: number[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    ramp.push(add(c[0] + Math.cos(a) * (tr + 1.4), c[1] + Math.sin(a) * (tr + 1.4), z0 + H));
  }
  ramp.forEach((n, k) => edges.push({ a: n, b: ramp[(k + 1) % 8], kind: 'rampart' }));
  edges.push({ a: last, b: ramp[2], kind: 'walk' });
  // an elevator down from the rampart to the lane on the far side
  const foot = add(c[0] - tr - 1.4, c[1], null);
  edges.push({ a: ramp[4], b: foot, kind: 'elevator' });
  edges.push({ a: foot, b: lane[6], kind: 'walk' });
  return { nodes, edges };
}
