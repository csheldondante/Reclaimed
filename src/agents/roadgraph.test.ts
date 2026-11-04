// (round 128i, V128-14) The agents' road graph (roadgraph.ts): pieces join where they meet, cross or end on another
// within a cell, never across cells they don't share an end in; the hop table leads every node to its destination the
// cheapest way.
import { describe, expect, it } from 'vitest';
import { edgeCost, graphOf, hopsCpu, nearestNode, nodeCount, reached, subgraph, type RoadSeg } from './roadgraph';

const seg = (a: [number, number], b: [number, number], cell = 0, cost = 1): RoadSeg => ({ a, b, cell, cost });

describe('road graph', () => {
  it('joins pieces at shared ends, at crossings and at a T within a cell', () => {
    // a cross in cell 0, a T in cell 1, a piece on from the cross's end into cell 2
    const g = graphOf([seg([0, 0], [4, 0]), seg([2, -2], [2, 2]), seg([10, 0], [14, 0], 1), seg([12, 0], [12, 3], 1), seg([4, 0], [10, 0], 2)]);
    // ends 0,0 4,0 2,-2 2,2 crossing 2,0; 10,0 14,0 12,0 12,3
    expect(nodeCount(g)).toBe(9);
    expect(reached(g, 0).size).toBe(9);
    const cross = nearestNode(g, 2, 0);
    expect(cross.d).toBeLessThan(1e-6);
    expect(g.count[cross.node]).toBe(4);
    expect(g.count[nearestNode(g, 12, 0).node]).toBe(3);
  });

  it("pieces that cross in different cells aren't joined (a bridge over a road)", () => {
    const g = graphOf([seg([0, 0], [4, 0], 0), seg([2, -2], [2, 2], 1)]);
    expect(nodeCount(g)).toBe(4);
    expect(reached(g, 0).size).toBe(2);
    // (the part reached from a node, renumbered: the other piece left out)
    const s = subgraph(g, nearestNode(g, 2, 2).node);
    expect(nodeCount(s)).toBe(2);
    expect(nearestNode(s, 2, -2).d).toBeLessThan(1e-6);
    expect(s.count[0]).toBe(1);
    expect(s.adj[s.start[0] * 2]).toBe(1);
    expect(edgeCost(s, s.start[0])).toBeCloseTo(4, 5);
  });

  it('the hop table leads each node the cheapest way to its destination', () => {
    // a square with a dear side: 0-1 cost 10, 0-3-2-1 cost 3
    const g = graphOf([seg([0, 0], [1, 0], 0, 10), seg([1, 0], [1, 1], 1), seg([1, 1], [0, 1], 2), seg([0, 1], [0, 0], 3)]);
    const n0 = nearestNode(g, 0, 0).node;
    const n1 = nearestNode(g, 1, 0).node;
    const { dist, next } = hopsCpu(g, [n1]);
    expect(dist[0][n0]).toBeCloseTo(3, 4);
    expect(next[0][n0]).toBe(nearestNode(g, 0, 1).node);
    expect(next[0][n1]).toBe(n1);
    // (walking the hops from any node reaches the destination, at the cost the table says)
    for (let v = 0; v < nodeCount(g); v++) {
      let at = v;
      let cost = 0;
      for (let k = 0; k < 10 && at !== n1; k++) {
        const to = next[0][at];
        for (let e = g.start[at]; e < g.start[at] + g.count[at]; e++) if (g.adj[e * 2] === to) cost += edgeCost(g, e);
        at = to;
      }
      expect(at).toBe(n1);
      expect(cost).toBeCloseTo(dist[0][v], 4);
    }
  });
});
