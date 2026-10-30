// ---- runplan/graph.ts -------------------------------------------------------------------------------------------
// (round 117, runplan) The region graph the run manager plans on — a STAND-IN for the terrain track's contract
// (contracts/run.ts RegionGraph says so). The user (round 117, part 3): "Terrain makes the barriers initially but the
// run manager should be able to get. The graph and request obstacles or otherwise request a certain number of exits."
// Until terrain publishes its own graph (with the barriers it actually made), this reads them off the atlas's facts
// (gm/atlas-facts.ts, cached for seed 1 in data/atlas/seed1.json, or made from a live Atlas for any seed):
// - which regions touch (RegionFacts.neighbours);
// - what stands between them, guessed from the two regions' kinds and their ground (a range is a mountain wall, a rift
//   a ravine, a lava field lava, a big step in ground a cliff, land to sea water …);
// - the crossings already there: the atlas's roads (a road from one region into the next is a way through, its
//   bridges where the atlas built them).
// Why a guess is fine here: the planner only needs "can this hero get from A to B, how hard, and is it fun"; when
// terrain's graph lands it replaces this function behind the same RegionGraph interface, and the planner's tests
// (which use tiny hand-made graphs) don't change.

import type { BarrierKind, RegionEdge, RegionGraph, RegionNode } from '../api/contracts/run';
import type { AtlasFacts, RegionFacts } from '../gm/atlas-facts';

/** what the graph needs of the world wiki: names, and which settlements are where */
export interface GraphNames {
  regions: { id: number; name: string }[];
  settlements?: { id: string; region: number }[];
}

/** the barrier a region's kind makes at its border (its own side) */
const KIND_BARRIER: Partial<Record<string, BarrierKind>> = {
  range: 'mountain',
  glacier: 'ice',
  rift: 'ravine',
  escarpment: 'cliff',
  mesa: 'cliff',
  spires: 'cliff',
  lavafield: 'lava',
  marsh: 'tar',
  dunes: 'dunes',
  karst: 'thicket',
};

/** how hard each barrier is to cross on foot (the order a border shows the worst of its two sides) */
export const BARRIER_RANK: Record<BarrierKind, number> = {
  distance: 1,
  storm: 2,
  hostiles: 2,
  dunes: 3,
  thicket: 3,
  tar: 4,
  river: 4,
  ice: 5,
  ravine: 6,
  cliff: 6,
  lava: 7,
  mountain: 8,
  water: 9,
};

/** a step in mean ground between neighbours past this (world z) is a cliff */
const CLIFF_STEP = 40;
/** river nodes in both regions past this: a river runs on the border */
const RIVER_NODES = 12;

export function torusDelta(a: [number, number], b: [number, number], w: number, h: number): [number, number] {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  dx -= Math.round(dx / w) * w;
  dy -= Math.round(dy / h) * h;
  return [dx, dy];
}

/** what stands between two neighbouring regions, guessed from their facts */
export function borderBarrier(a: RegionFacts, b: RegionFacts): BarrierKind | null {
  if (a.land !== b.land) return 'water';
  if (!a.land && !b.land) return 'water';
  const cands: BarrierKind[] = [];
  const ka = KIND_BARRIER[a.kind];
  const kb = KIND_BARRIER[b.kind];
  if (ka) cands.push(ka);
  if (kb) cands.push(kb);
  if (Math.abs(a.ground.mean - b.ground.mean) > CLIFF_STEP) cands.push('cliff');
  if (a.rivers > RIVER_NODES && b.rivers > RIVER_NODES) cands.push('river');
  if (!cands.length) return null;
  // (the worst; a tie by name, so a border reads the same from both sides)
  return cands.reduce((w, c) => (BARRIER_RANK[c] > BARRIER_RANK[w] || (BARRIER_RANK[c] === BARRIER_RANK[w] && c < w) ? c : w));
}

class FactsGraph implements RegionGraph {
  readonly seed: number;
  readonly world: { w: number; h: number };
  private byId = new Map<number, RegionNode>();
  private out = new Map<number, RegionEdge[]>();

  constructor(f: AtlasFacts, names: GraphNames) {
    this.seed = f.params.seed;
    this.world = { w: f.params.worldW, h: f.params.worldH };
    const name = new Map(names.regions.map((r) => [r.id, r.name]));
    const sett = new Map<number, string[]>();
    for (const s of names.settlements ?? []) sett.set(s.region, [...(sett.get(s.region) ?? []), s.id]);
    const facts = new Map(f.regions.map((r) => [r.id, r]));
    for (const r of f.regions)
      this.byId.set(r.id, {
        id: r.id,
        kind: r.kind,
        land: r.land,
        centre: r.centre,
        area: r.area,
        tier: r.tier,
        ground: r.ground,
        rivers: r.rivers,
        lava: r.lava,
        stamps: r.stamps,
        settlements: sett.get(r.id) ?? [],
        name: name.get(r.id) ?? `region ${r.id}`,
      });
    // the roads' ways through: consecutive regions on a road, and the bridges it built
    const crossing = new Map<string, string>();
    const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    for (const road of f.roads) {
      const bridges = new Set(road.crossings.map((c) => c.region));
      for (let i = 1; i < road.via.length; i++) {
        const a = road.via[i - 1];
        const b = road.via[i];
        if (a === b) continue;
        const k = key(a, b);
        const kind = bridges.has(a) || bridges.has(b) ? 'bridge' : 'road';
        if (crossing.get(k) !== 'bridge') crossing.set(k, kind);
      }
    }
    for (const r of f.regions) {
      const es: RegionEdge[] = [];
      for (const n of r.neighbours) {
        const o = facts.get(n);
        if (!o || n === r.id) continue;
        const [dx, dy] = torusDelta(r.centre, o.centre, this.world.w, this.world.h);
        es.push({ a: r.id, b: n, barrier: borderBarrier(r, o), crossing: crossing.get(key(r.id, n)) ?? null, length: Math.hypot(dx, dy) });
      }
      this.out.set(r.id, es);
    }
  }

  node(id: number): RegionNode | undefined {
    return this.byId.get(id);
  }

  edges(id: number): RegionEdge[] {
    return this.out.get(id) ?? [];
  }

  nodes(): Iterable<RegionNode> {
    return this.byId.values();
  }
}

/** the region graph of an atlas's facts (and the wiki's names and settlements) */
export function factsGraph(f: AtlasFacts, names: GraphNames): RegionGraph {
  return new FactsGraph(f, names);
}

/** a graph from plain nodes and undirected edges (tests, hand-made worlds) */
export function plainGraph(nodes: RegionNode[], edges: Omit<RegionEdge, 'length'>[], world = { w: 1e9, h: 1e9 }, seed = 0): RegionGraph {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<number, RegionEdge[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    const a = byId.get(e.a)!;
    const b = byId.get(e.b)!;
    const [dx, dy] = torusDelta(a.centre, b.centre, world.w, world.h);
    const length = Math.hypot(dx, dy);
    out.get(e.a)!.push({ ...e, length });
    out.get(e.b)!.push({ ...e, a: e.b, b: e.a, length });
  }
  return { seed, world, node: (id) => byId.get(id), edges: (id) => out.get(id) ?? [], nodes: () => byId.values() };
}
