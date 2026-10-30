// ---- runplan/route.ts -------------------------------------------------------------------------------------------
// (round 117, runplan) Routes on the region graph for one hero: Dijkstra by the hero's cost of each border
// (heroes.ts crossCost), so a bike goes round the mountains a knight walks through by its cave, and a lich floats
// straight over the sea. The cost is "effort": world units weighted by how hard each border is for this hero.

import type { HeroCapabilities, RegionEdge, RegionGraph } from '../api/contracts/run';
import { crossCost } from './heroes';

export interface Reach {
  /** effort to each region reached (world units, weighted) */
  cost: Map<number, number>;
  /** the edge each region was reached by */
  via: Map<number, RegionEdge>;
}

/** can this hero be in this region at all (the sea only for heroes that cross water) */
export function enters(g: RegionGraph, h: HeroCapabilities, id: number): boolean {
  const n = g.node(id);
  if (!n) return false;
  return n.land || (h.passes.water ?? 0) > 0;
}

/** every region within `max` effort of `from` */
export function reach(g: RegionGraph, h: HeroCapabilities, from: number, max = Infinity): Reach {
  const cost = new Map<number, number>([[from, 0]]);
  const via = new Map<number, RegionEdge>();
  // a binary heap of [cost, id]
  const heap: [number, number][] = [[0, from]];
  const push = (c: number, id: number) => {
    heap.push([c, id]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [c, id] = pop();
    if (c > (cost.get(id) ?? Infinity)) continue;
    for (const e of g.edges(id)) {
      if (!enters(g, h, e.b)) continue;
      const k = crossCost(h, e.barrier, e.crossing);
      if (k <= 0) continue;
      const nc = c + e.length * k;
      if (nc > max || nc >= (cost.get(e.b) ?? Infinity)) continue;
      cost.set(e.b, nc);
      via.set(e.b, e);
      push(nc, e.b);
    }
  }
  return { cost, via };
}

/** the regions from the reach's start to `to`, in order (null: not reached) */
export function routeTo(r: Reach, to: number): number[] | null {
  if (!r.cost.has(to)) return null;
  const out = [to];
  let at = to;
  while (r.via.has(at)) {
    at = r.via.get(at)!.a;
    out.push(at);
  }
  return out.reverse();
}
