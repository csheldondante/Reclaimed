// ---- runplan/graph.ts -------------------------------------------------------------------------------------------
// (round 117, runplan; runplay round 119: the consolidation) The region graph the run manager plans on: TERRAIN's
// (Terrain.atlasGraph(), contracts/terrain.ts AtlasRegionGraph — which regions touch and what stands between them,
// read off the rules the atlas draws each border by) joined at the boundary with what the run also needs of a region:
// its name and settlements (the world wiki's), its stamps, and the roads' crossings (a road from one region into the
// next is a way through; a bridge where the atlas built one). The user (round 117, part 3): "Terrain makes the
// barriers initially but the run manager should be able to get. The graph and request obstacles or otherwise request a
// certain number of exits."
// Why a join and not terrain carrying names and roads: one concern each — terrain knows the land's barriers, the wiki
// knows names, the atlas's road planner knows roads; the run reads all three and owns none of them.
// (Runplan's guessed stand-in — barriers from the regions' kinds — is gone: terrain's are the real ones.)

import type { AtlasRegionEdge, AtlasRegionGraph, AtlasRegionNode, BarrierKind } from '../api/contracts/terrain';
import type { RegionEdge, RegionGraph, RegionNode } from '../api/contracts/run';
import type { AtlasFacts } from '../gm/atlas-facts';

/** what the graph needs of the world wiki: names, and which settlements are where */
export interface GraphNames {
  regions: { id: number; name: string }[];
  settlements?: { id: string; region: number }[];
}

/** what the join reads of terrain's graph (AtlasRegionGraph without regionAt: a saved graph has no atlas to ask) */
export type AtlasGraphLike = Pick<AtlasRegionGraph, 'seed' | 'world' | 'node' | 'edges' | 'nodes'>;

/** how hard each barrier is to cross on foot (the order the planner ranks barriers by: soft ones under a ravine) */
export const BARRIER_RANK: Record<BarrierKind, number> = {
  open: 0,
  distance: 1,
  storm: 2,
  hostile: 2,
  vegetation: 3,
  tar: 4,
  river: 4,
  steep: 5,
  ridge: 6,
  ravine: 6,
  cliff: 6,
  lava: 7,
  lake: 8,
  sea: 9,
};

export function torusDelta(a: [number, number], b: [number, number], w: number, h: number): [number, number] {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  dx -= Math.round(dx / w) * w;
  dy -= Math.round(dy / h) * h;
  return [dx, dy];
}

/** an edge turned to face out of region `id` (terrain's edges are unordered pairs) */
function facing(e: AtlasRegionEdge, id: number): AtlasRegionEdge {
  return e.a === id ? e : { ...e, a: e.b, b: e.a };
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** the roads' ways through: consecutive regions on a road ('road'), or 'bridge' where it built one */
function roadCrossings(roads: AtlasFacts['roads'] | undefined): Map<string, string> {
  const crossing = new Map<string, string>();
  for (const road of roads ?? []) {
    const bridges = new Set(road.crossings.map((c) => c.region));
    for (let i = 1; i < road.via.length; i++) {
      const a = road.via[i - 1];
      const b = road.via[i];
      if (a === b) continue;
      const k = pairKey(a, b);
      const kind = bridges.has(a) || bridges.has(b) ? 'bridge' : 'road';
      if (crossing.get(k) !== 'bridge') crossing.set(k, kind);
    }
  }
  return crossing;
}

/**
 * The run's region graph: terrain's atlas graph, each region named (the wiki) with its settlements and stamps (the
 * atlas facts), each border with the road crossing on it if any (the atlas facts' roads).
 */
export function runGraph(t: AtlasGraphLike, extra: { names: GraphNames; facts?: Pick<AtlasFacts, 'regions' | 'roads'> }): RegionGraph {
  const name = new Map(extra.names.regions.map((r) => [r.id, r.name]));
  const sett = new Map<number, string[]>();
  for (const s of extra.names.settlements ?? []) sett.set(s.region, [...(sett.get(s.region) ?? []), s.id]);
  const stamps = new Map((extra.facts?.regions ?? []).map((r) => [r.id, r.stamps]));
  const crossing = roadCrossings(extra.facts?.roads);
  const byId = new Map<number, RegionNode>();
  for (const n of t.nodes()) byId.set(n.id, { ...n, stamps: stamps.get(n.id) ?? [], settlements: sett.get(n.id) ?? [], name: name.get(n.id) ?? `region ${n.id}` });
  const out = new Map<number, RegionEdge[]>();
  const edges = (id: number): RegionEdge[] => {
    let es = out.get(id);
    if (!es) {
      es = t.edges(id).map((e) => ({ ...facing(e, id), crossing: crossing.get(pairKey(e.a, e.b)) ?? null }));
      out.set(id, es);
    }
    return es;
  };
  return { seed: t.seed, world: t.world, node: (id) => byId.get(id), edges, nodes: () => byId.values() };
}

/** terrain's atlas graph as plain JSON (a fixture: data/atlas/seed1-graph.json, written by test/gpu/atlasgraph.test.ts) */
export interface SavedAtlasGraph {
  seed: number;
  world: { w: number; h: number };
  nodes: AtlasRegionNode[];
  edges: AtlasRegionEdge[];
}

export function saveAtlasGraph(t: AtlasGraphLike): SavedAtlasGraph {
  const nodes = [...t.nodes()];
  const seen = new Set<AtlasRegionEdge>();
  const edges: AtlasRegionEdge[] = [];
  for (const n of nodes) for (const e of t.edges(n.id)) if (!seen.has(e)) seen.add(e), edges.push(e);
  return { seed: t.seed, world: t.world, nodes, edges };
}

export function loadAtlasGraph(s: SavedAtlasGraph): AtlasGraphLike {
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const out = new Map<number, AtlasRegionEdge[]>();
  for (const e of s.edges) for (const r of [e.a, e.b]) (out.get(r) ?? out.set(r, []).get(r)!).push(e);
  return { seed: s.seed, world: s.world, node: (id) => byId.get(id), edges: (id) => out.get(id) ?? [], nodes: () => byId.values() };
}

/** a graph from plain nodes and undirected edges (tests, hand-made worlds) */
export function plainGraph(nodes: RegionNode[], edges: { a: number; b: number; barrier: BarrierKind | null; crossing: string | null }[], world = { w: 1e9, h: 1e9 }, seed = 0): RegionGraph {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<number, RegionEdge[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    const a = byId.get(e.a)!;
    const b = byId.get(e.b)!;
    const [dx, dy] = torusDelta(a.centre, b.centre, world.w, world.h);
    const span = Math.hypot(dx, dy);
    const causes = e.barrier ? [e.barrier] : [];
    out.get(e.a)!.push({ ...e, causes, length: span / 2, span });
    out.get(e.b)!.push({ ...e, a: e.b, b: e.a, causes, length: span / 2, span });
  }
  return { seed, world, node: (id) => byId.get(id), edges: (id) => out.get(id) ?? [], nodes: () => byId.values() };
}
