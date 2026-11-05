// The atlas's regions: the pattern pass and the regions found on the CPU (continents, islands, waters, adjacency,
// landforms). API: patterns, regionsCpu.
import { makeBindGroup, makeCompute } from '../../gpu/pipeline';
import { rng } from '../../world/noise';
import patsimW from '../patsim.wgsl?raw';
import { defineRegions, dryness, REGION_WORDS, type RegionStat } from '../regions';
import { landformsOf, tiersOf } from '../landforms';
import type { Atlas } from '../atlas';

/** the simulated tiles: two reaction–diffusion patterns and a cellular-automaton cave map */
export async function patterns(atl: Atlas): Promise<void> {
  const dev = atl.device;
  const T = 256;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const a = dev.createBuffer({ label: 'rd a', size: T * T * 8, usage: S });
  const b = dev.createBuffer({ label: 'rd b', size: T * T * 8, usage: S });
  const u = dev.createBuffer({ label: 'rd params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const spec = { 0: 'uniform', 1: 'read', 2: 'rw', 3: 'rw' } as const;
  const step = makeCompute(dev, 'rd step', [patsimW], spec, 'rdMulti');
  const out = makeCompute(dev, 'rd out', [patsimW], spec, 'rdOut');
  const gAB = makeBindGroup(dev, 'rd ab', step.layout, { 0: u, 1: a, 2: b, 3: atl.pat });
  const gBA = makeBindGroup(dev, 'rd ba', step.layout, { 0: u, 1: b, 2: a, 3: atl.pat });
  const gOut = makeBindGroup(dev, 'rd out', out.layout, { 0: u, 1: a, 2: b, 3: atl.pat });
  const variants = [
    { feed: 0.0545, kill: 0.062 },
    { feed: 0.029, kill: 0.057 },
  ];
  for (let vi = 0; vi < variants.length; vi++) {
    // (simulated only when some region's pattern samples it: PAT coral 10, maze 11)
    if (!atl.defs.some((d) => d.words[1] === 10 + vi)) continue;
    const r = rng(atl.p.seed * 97 + vi);
    const init = new Float32Array(T * T * 2);
    for (let i = 0; i < T * T; i++) init[i * 2] = 1;
    for (let s = 0; s < 60; s++) {
      const cx = Math.floor(r() * T);
      const cy = Math.floor(r() * T);
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) init[(((cy + dy + T) % T) * T + ((cx + dx + T) % T)) * 2 + 1] = 1;
    }
    dev.queue.writeBuffer(a, 0, init);
    const pu = new ArrayBuffer(32);
    new Float32Array(pu).set([variants[vi].feed, variants[vi].kill, 1.0, 0.5]);
    new Uint32Array(pu).set([T, vi], 4);
    dev.queue.writeBuffer(u, 0, pu);
    // (6 steps a dispatch: rdMulti)
    const STEPS = 4800;
    for (let s = 0; s < STEPS; s += 1200) {
      const enc = dev.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(step.pipeline);
      for (let k = 0; k < 1200; k += 12) {
        for (const g of [gAB, gBA]) {
          cp.setBindGroup(0, g);
          cp.dispatchWorkgroups(T / 16, T / 16);
        }
      }
      cp.end();
      dev.queue.submit([enc.finish()]);
    }
    const enc = dev.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(out.pipeline);
    cp.setBindGroup(0, gOut);
    cp.dispatchWorkgroups(T / 8, T / 8);
    cp.end();
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
  }
  // the cave automaton (B5678/S45678 on a wrapping grid), smoothed: small, the CPU's
  const r = rng(atl.p.seed * 101 + 9);
  let g = new Uint8Array(T * T).map(() => (r() < 0.47 ? 1 : 0));
  for (let it = 0; it < 6; it++) {
    const nx = new Uint8Array(T * T);
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[((y + dy + T) % T) * T + ((x + dx + T) % T)];
        nx[y * T + x] = s >= 5 ? 1 : 0;
      }
    g = nx;
  }
  let f = Float32Array.from(g);
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(T * T);
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        let s = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += f[((y + dy + T) % T) * T + ((x + dx + T) % T)];
        o[y * T + x] = s / 25;
      }
    f = o;
  }
  dev.queue.writeBuffer(atl.pat, 2 * T * T * 4, f);
  for (const x of [a, b, u]) x.destroy();
}

export function regionsCpu(atl: Atlas, L: Uint32Array, I: Uint32Array, C: Uint32Array): void {
  const n = atl.p.n;
  const N = n * n;
  // continents and waters: dense, with their areas
  const contArea = new Uint32Array(N);
  for (let i = 0; i < N; i++) contArea[C[i]]++;
  // regions: dense ids by root
  const id = new Int32Array(N).fill(-1);
  const stats: (RegionStat & { sx: number; sy: number; cx2: number; cy2: number; faults: number })[] = [];
  const reg = new Uint32Array(N);
  const TAU = 2 * Math.PI;
  const cs = Float64Array.from({ length: n }, (_, k) => Math.cos((TAU * (k + 0.5)) / n));
  const sn = Float64Array.from({ length: n }, (_, k) => Math.sin((TAU * (k + 0.5)) / n));
  for (let i = 0; i < N; i++) {
    const root = L[i];
    let r = id[root];
    if (r < 0) {
      r = id[root] = stats.length;
      stats.push({ area: 0, land: (I[i] & 1) === 1, fault: false, prov: I[i] >>> 3, cont: C[i], contArea: contArea[C[i]], cx: 0, cy: 0, sx: 0, sy: 0, cx2: 0, cy2: 0, faults: 0 });
    }
    reg[i] = r;
    const s = stats[r];
    s.area++;
    const x = i % n;
    const y = (i - x) / n;
    s.sx += cs[x];
    s.sy += sn[x];
    s.cx2 += cs[y];
    s.cy2 += sn[y];
    if (((I[i] >>> 1) & 3) === 1) s.faults++;
  }
  // shared edges between regions (right and down neighbours, wrapped)
  const adj = (rs: Uint32Array, R: number) => {
    const m = new Map<number, number>();
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = rs[y * n + x];
        for (const j of [y * n + ((x + 1) % n), ((y + 1) % n) * n + x]) {
          const b = rs[j];
          if (a === b) continue;
          const k = Math.min(a, b) * R + Math.max(a, b);
          m.set(k, (m.get(k) ?? 0) + 1);
        }
      }
    return m;
  };
  // tiny regions join the neighbour they share most border with (the same land or water, when there is one)
  const parent = stats.map((_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const pairs = adj(reg, stats.length);
  const nbrs = new Map<number, [number, number][]>();
  const R0 = stats.length;
  for (const [k, c] of pairs) {
    const a = Math.floor(k / R0);
    const b = k % R0;
    (nbrs.get(a) ?? nbrs.set(a, []).get(a)!).push([b, c]);
    (nbrs.get(b) ?? nbrs.set(b, []).get(b)!).push([a, c]);
  }
  const order = stats.map((_, i) => i).sort((a, b) => stats[a].area - stats[b].area);
  const area = stats.map((s) => s.area);
  let merged = 0;
  for (const r of order) {
    if (find(r) !== r || area[r] >= atl.p.minRegion) continue;
    let best = -1;
    let bestScore = -1;
    for (const [b, c] of nbrs.get(r) ?? []) {
      const fb = find(b);
      if (fb === r) continue;
      const score = c + (stats[fb].land === stats[r].land ? 1e6 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = fb;
      }
    }
    if (best < 0) continue;
    parent[r] = best;
    area[best] += area[r];
    const s = stats[best];
    const t = stats[r];
    s.area += t.area;
    s.sx += t.sx;
    s.sy += t.sy;
    s.cx2 += t.cx2;
    s.cy2 += t.cy2;
    s.faults += t.faults;
    merged++;
  }
  const dense = new Int32Array(stats.length).fill(-1);
  const out: RegionStat[] = [];
  for (let r = 0; r < stats.length; r++) {
    if (find(r) !== r) continue;
    const s = stats[r];
    dense[r] = out.length;
    const ang = (a: number, b: number) => (((Math.atan2(b, a) / TAU) % 1) + 1) % 1;
    out.push({ area: s.area, land: s.land, fault: s.faults > s.area * 0.5, prov: s.prov, cont: s.cont, contArea: s.contArea, cx: ang(s.sx, s.sy), cy: ang(s.cx2, s.cy2) });
  }
  for (let i = 0; i < N; i++) reg[i] = dense[find(reg[i])];
  atl.regionOf = reg;
  // (keyed by the dense ids: a · regions + b)
  atl.adjacency = adj(reg, out.length);
  let ocean = 0;
  for (const s of out) if (!s.land) ocean = Math.max(ocean, s.contArea);
  // the landforms: tiers from the elevation noise, adjacent regions of one tier one landform
  const { tier, rift } = tiersOf(out, atl.p.seed, dryness, atl.p.formPer);
  const lf = landformsOf(tier, atl.adjacency, atl.p.seed);
  atl.landforms = lf.forms;
  atl.landformOf = lf.of;
  atl.defs = defineRegions(out, atl.p.seed, atl.p.style, Math.min(ocean, N * 0.02), { tier, rift, of: lf.of, forms: lf.forms });
  const words = new Uint32Array(atl.defs.length * REGION_WORDS);
  atl.defs.forEach((d, i) => words.set(d.words, i * REGION_WORDS));
  atl.regs?.destroy();
  atl.regs = atl.device.createBuffer({ label: 'atlas regions', size: Math.max(words.byteLength, 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  atl.device.queue.writeBuffer(atl.regs, 0, words);
  // the stats
  const conts = new Set<number>();
  let islands = 0;
  const waters = new Set<number>();
  for (let root = 0; root < N; root++) {
    const a = contArea[root];
    if (!a) continue;
    const land = (I[root] & 1) === 1;
    if (land) {
      conts.add(root);
      if (a < N * 0.01) islands++;
    } else waters.add(root);
  }
  atl.stats.continents = conts.size - islands;
  atl.stats.islands = islands;
  atl.stats.waters = waters.size;
  atl.stats.regions = out.length;
  atl.stats.merged = merged;
  atl.stats.kinds = {};
  for (const d of atl.defs) atl.stats.kinds[d.kind] = (atl.stats.kinds[d.kind] ?? 0) + 1;
}
