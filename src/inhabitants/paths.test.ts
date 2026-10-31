import { describe, expect, it } from 'vitest';
import { EDGE_KIND, packPaths, PATH_EDGES, PATH_NODES, standInPaths } from './paths';

describe('paths', () => {
  it('the stand-in is a connected graph with stairs, a rampart and an elevator; every node at most 4 edges', () => {
    const p = standInPaths([50, 50], () => 10);
    const kinds = new Set(p.edges.map((e) => e.kind));
    for (const k of ['walk', 'stairs', 'rampart', 'elevator'] as const) expect(kinds.has(k)).toBe(true);
    const adj = p.nodes.map(() => [] as number[]);
    for (const e of p.edges) {
      adj[e.a].push(e.b);
      adj[e.b].push(e.a);
    }
    const seen = new Set([0]);
    const todo = [0];
    while (todo.length)
      for (const n of adj[todo.pop()!])
        if (!seen.has(n)) {
          seen.add(n);
          todo.push(n);
        }
    expect(seen.size).toBe(p.nodes.length);
    for (const a of adj) expect(a.length).toBeLessThanOrEqual(4);
  });
  it('packs nodes, adjacency and edges where the kernel reads them', () => {
    const p = standInPaths([50, 50], () => 10);
    const out = new Float32Array(8 + (PATH_NODES * 2 + PATH_EDGES) * 4);
    const n = packPaths(p, out, 8);
    expect(n).toEqual({ nodes: p.nodes.length, edges: p.edges.length });
    // a ground node's z is the "on the ground" mark
    expect(out[8 + 2]).toBeLessThan(-1e8);
    const e0 = 8 + PATH_NODES * 2 * 4;
    expect(out[e0 + 2]).toBe(EDGE_KIND.walk);
    expect(out[e0 + 3]).toBeGreaterThan(0);
    // node 0's first adjacency entry is an edge touching it
    const a0 = out[8 + PATH_NODES * 4];
    expect(p.edges[a0].a === 0 || p.edges[a0].b === 0).toBe(true);
  });
  it('a bad edge is loud', () => {
    expect(() => packPaths({ nodes: [{ at: [0, 0, null] }], edges: [{ a: 0, b: 3, kind: 'walk' }] }, new Float32Array(1e5), 0)).toThrow();
  });
});
