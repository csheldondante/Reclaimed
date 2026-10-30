// Terrain track (round 117): the atlas's regions as a graph — the top level of the partition, world-wide, for planning a
// run across the overmap (runplan's RegionGraph stand-in reads this shape: contracts/terrain.ts AtlasRegionGraph). The
// rooms and features under it come from TerrainSystem.graph(rect) where a run's stage is.
//
// The user: "I would make regions recursive with open fully connected spaces 1-3 screens big and that are part of
// larger terrain features." The atlas's regions (Voronoi provinces split along faults, ~25 texels across) are those larger
// features; what stands between two of them is read off the same rules compose.wgsl ground() draws their border by:
// a landform's edge (a plateau's cliff, a massif's flank), a region's own edge (a ravine, a wall), the coast, a river
// running along or across it. CPU, once: the atlas's per-texel arrays are on the CPU already.

import type { Atlas } from '../atlas/atlas';
import type { AtlasRegionEdge, AtlasRegionGraph, AtlasRegionNode, BarrierKind } from '../api/contracts';

/** regions.ts EDGE and the region words (regions.ts makeRegion: 12 its edge, 15 its priority, 16 its coast's edge) */
const EDGE = { smooth: 0, cliff: 1, ravine: 2, wall: 3, terrace: 4, beach: 5, seacliff: 6 } as const;
const W_EDGE = 12;
const W_PRIO = 15;
const W_COAST = 16;
const W_LF = 48;
const TIER = ['lowland', 'upland', 'plateau', 'massif'];

export function atlasGraph(a: Atlas): AtlasRegionGraph {
  const n = a.p.n;
  const N = n * n;
  const R = a.defs.length;
  const f32 = (d: (typeof a.defs)[number], k: number) => new Float32Array(d.words.buffer, d.words.byteOffset, d.words.length)[k];
  // per region: area, ground stats, river and lava texels
  const area = new Int32Array(R);
  const gmin = new Float32Array(R).fill(Infinity);
  const gmax = new Float32Array(R).fill(-Infinity);
  const gsum = new Float64Array(R);
  const rivers = new Int32Array(R);
  const lava = new Int32Array(R);
  // the river nodes' texels (flag 1: lava)
  const nodeFlag = new Uint8Array(N);
  const u = a.riverNodes;
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  for (let k = 0; k < u.length / 8; k++) {
    const tx = Math.floor((f[k * 8] / a.worldW) * n);
    const ty = Math.floor((f[k * 8 + 1] / a.worldH) * n);
    const t = (((ty % n) + n) % n) * n + (((tx % n) + n) % n);
    nodeFlag[t] = (u[k * 8 + 5] & 1) + 1;
  }
  for (let i = 0; i < N; i++) {
    const r = a.regionOf[i];
    area[r]++;
    const h = a.hmac[i];
    if (h < gmin[r]) gmin[r] = h;
    if (h > gmax[r]) gmax[r] = h;
    gsum[r] += h;
    if (nodeFlag[i] === 1) rivers[r]++;
    if (nodeFlag[i] === 2) lava[r]++;
  }
  const nodes: AtlasRegionNode[] = a.defs.map((d, id) => {
    const lf = d.words[W_LF];
    const form = lf !== 0xffffffff ? a.landforms[lf] : undefined;
    return {
      id,
      kind: d.kind,
      land: d.stat.land,
      centre: [+(d.stat.cx * a.worldW).toFixed(0), +(d.stat.cy * a.worldH).toFixed(0)],
      area: area[id],
      tier: form ? TIER[form.tier] ?? null : null,
      ground: { min: +gmin[id].toFixed(1), mean: +(gsum[id] / Math.max(1, area[id])).toFixed(1), max: +gmax[id].toFixed(1) },
      rivers: rivers[id],
      lava: lava[id],
    };
  });
  // the borders: texel pairs of two regions (4 neighbours), a river's node on one of them
  const pairs = new Map<number, { edges: number; river: number; lava: number }>();
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const ra = a.regionOf[i];
      for (const j of [y * n + ((x + 1) % n), ((y + 1) % n) * n + x]) {
        const rb = a.regionOf[j];
        if (ra === rb) continue;
        const key = Math.min(ra, rb) * R + Math.max(ra, rb);
        let p = pairs.get(key);
        if (!p) pairs.set(key, (p = { edges: 0, river: 0, lava: 0 }));
        p.edges++;
        if (nodeFlag[i] === 1 || nodeFlag[j] === 1) p.river++;
        if (nodeFlag[i] === 2 || nodeFlag[j] === 2) p.lava++;
      }
    }
  const edgesOf = new Map<number, AtlasRegionEdge[]>();
  const tex = a.worldW / n;
  const wrap = (d: number, W: number) => d - Math.round(d / W) * W;
  for (const [key, p] of pairs) {
    const ia = Math.floor(key / R);
    const ib = key % R;
    const A = a.defs[ia];
    const B = a.defs[ib];
    const NA = nodes[ia];
    const NB = nodes[ib];
    const causes: BarrierKind[] = [];
    // what compose.wgsl ground() draws the border as
    if (A.stat.land !== B.stat.land) {
      const L = A.stat.land ? A : B;
      causes.push(L.words[W_COAST] === EDGE.seacliff ? 'cliff' : 'sea');
    } else if (A.stat.land && A.words[W_LF] !== B.words[W_LF]) {
      const hi = f32(A, 4) > f32(B, 4) ? NA : NB;
      if (hi.tier === 'plateau') causes.push('cliff');
      else if (hi.tier === 'massif') causes.push('steep');
    } else if (A.stat.land) {
      const E = f32(A, W_PRIO) > f32(B, W_PRIO) || (f32(A, W_PRIO) === f32(B, W_PRIO) && ia < ib) ? A : B;
      const e = E.words[W_EDGE];
      if (e === EDGE.ravine) causes.push('ravine');
      else if (e === EDGE.wall) causes.push('ridge');
    }
    // a river on the border (a fifth of it or more: running along it) or crossing it
    if (p.river > 0) causes.push('river');
    if (p.lava > 0) causes.push('lava');
    const e: AtlasRegionEdge = {
      a: ia,
      b: ib,
      barrier: causes[0] ?? null,
      causes,
      length: p.edges * tex,
      span: +Math.hypot(wrap(NB.centre[0] - NA.centre[0], a.worldW), wrap(NB.centre[1] - NA.centre[1], a.worldH)).toFixed(0),
    };
    for (const r of [ia, ib]) (edgesOf.get(r) ?? edgesOf.set(r, []).get(r)!).push(e);
  }
  return {
    seed: a.p.seed,
    world: { w: a.worldW, h: a.worldH },
    node: (id) => nodes[id],
    edges: (id) => edgesOf.get(id) ?? [],
    nodes: () => nodes,
    regionAt: (p) => {
      const tx = Math.floor((((p[0] % a.worldW) + a.worldW) % a.worldW / a.worldW) * n);
      const ty = Math.floor((((p[1] % a.worldH) + a.worldH) % a.worldH / a.worldH) * n);
      return a.regionOf[ty * n + tx];
    },
  };
}
