// Terrain track (round 117): a basin flooded by height — the GPU tool (flood.wgsl) and its CPU reference (the same
// result; unit-tested in flood.test.ts and checked against the GPU in the browser, scripts/terrain/floodcheck.mjs).
//
// The user (DECISIONS round 117): "instead of a global sea level a GPU flood fill based on height would let us easily
// flood areas and would be a nice tool. We can flood with water, sand, magma etc." / "A GPU algorithm we use for
// generative tools. I want to be able to flood a basin and bury things".
//
// What a flood is: the texels joined to a seed through ground under a level — given, or the basin's spill height (the
// level water poured in at the seed would rise to before it ran out: the depression-filled surface there). Applied to
// the atlas (Atlas.addBasin) it is a row of the lakes' table: the lakes the river graph found are basins filled with
// water at their spill height already, so a flood is the same thing with any level and any fluid, and the land is made
// from it the way it is made from a lake (compose.wgsl lakeAt) — no new binding in the kernels that make land (they're
// at the 8-storage-buffer limit).

import type { Atlas } from '../atlas/atlas';
import { makeBindGroup, makeComputeAsync, makeModule, type ComputeKernel } from '../gpu/pipeline';
import type { FloodFluid, FloodRequest, FloodResult, V2 } from '../api/contracts';
import floodW from './flood.wgsl?raw';

export const FLUID_CODE: Record<FloodFluid, number> = { water: 0, sand: 1, magma: 2, ash: 3 };

export interface FloodGrid {
  /** m × m heights (row-major) */
  m: number;
  h: Float32Array;
  /** 1 where water leaves (the window's edge is always one): the standing sea */
  outlet?: Uint8Array;
}

export interface FloodMask {
  level: number;
  /** 1 in the basin */
  mask: Uint8Array;
  count: number;
  /** the lowest ground in it, and the spill texel (the lowest ground on its rim; −1 none) */
  floor: number;
  spill: number;
}

const DX = [1, -1, 0, 0, 1, -1, -1, 1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** the depression-filled surface (priority flood from the outlets: what the GPU's Planchon–Darboux passes converge to) */
export function fillCpu(G: FloodGrid): Float32Array {
  const { m, h } = G;
  const N = m * m;
  const W = new Float32Array(N).fill(Infinity);
  const done = new Uint8Array(N);
  // a binary heap of (level, texel)
  const hk: number[] = [];
  const hv: number[] = [];
  const push = (k: number, v: number) => {
    let i = hk.length;
    hk.push(k);
    hv.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= k) break;
      hk[i] = hk[p];
      hv[i] = hv[p];
      i = p;
    }
    hk[i] = k;
    hv[i] = v;
  };
  const pop = (): number => {
    const top = hv[0];
    const k = hk.pop()!;
    const v = hv.pop()!;
    if (hk.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hk.length) break;
        if (c + 1 < hk.length && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[i] = hk[c];
        hv[i] = hv[c];
        i = c;
      }
      hk[i] = k;
      hv[i] = v;
    }
    return top;
  };
  for (let i = 0; i < N; i++) {
    const x = i % m;
    const y = (i - x) / m;
    if (x === 0 || y === 0 || x === m - 1 || y === m - 1 || G.outlet?.[i]) {
      W[i] = h[i];
      done[i] = 1;
      push(W[i], i);
    }
  }
  while (hk.length) {
    const c = pop();
    const x = c % m;
    const y = (c - x) / m;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= m || ny >= m) continue;
      const j = ny * m + nx;
      if (done[j]) continue;
      done[j] = 1;
      W[j] = Math.max(h[j], W[c]);
      push(W[j], j);
    }
  }
  return W;
}

/** the basin joined to `seed` under `level` (8 neighbours), its floor and its spill point */
export function markCpu(G: FloodGrid, seed: number, level: number): FloodMask {
  const { m, h } = G;
  const mask = new Uint8Array(m * m);
  let count = 0;
  let floor = Infinity;
  if (h[seed] < level) {
    const q = [seed];
    mask[seed] = 1;
    while (q.length) {
      const c = q.pop()!;
      count++;
      floor = Math.min(floor, h[c]);
      const x = c % m;
      const y = (c - x) / m;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= m || ny >= m) continue;
        const j = ny * m + nx;
        if (mask[j] || h[j] >= level) continue;
        mask[j] = 1;
        q.push(j);
      }
    }
  }
  return { level, mask, count, floor, spill: spillOf(G, mask) };
}

/** the lowest texel on a basin's rim (8 neighbours) */
export function spillOf(G: FloodGrid, mask: Uint8Array): number {
  const { m, h } = G;
  let best = -1;
  for (let i = 0; i < m * m; i++) {
    if (mask[i]) continue;
    const x = i % m;
    const y = (i - x) / m;
    let rim = false;
    for (let k = 0; k < 8 && !rim; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx >= 0 && ny >= 0 && nx < m && ny < m && mask[ny * m + nx]) rim = true;
    }
    if (rim && (best < 0 || h[i] < h[best])) best = i;
  }
  return best;
}

/** the rim of a mask (texels outside it with a neighbour in it) */
export function rimOf(m: number, mask: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < m * m; i++) {
    if (mask[i]) continue;
    const x = i % m;
    const y = (i - x) / m;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx >= 0 && ny >= 0 && nx < m && ny < m && mask[ny * m + nx]) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/** The flood on the GPU: the fill's and the mark's passes (flood.wgsl), stopped when a batch changes nothing. */
export class FloodGpu {
  private kernels?: Promise<{ fill: ComputeKernel; markI: ComputeKernel; mark: ComputeKernel }>;
  /** passes run by the last flood (fill, mark) */
  passes: [number, number] = [0, 0];
  constructor(readonly device: GPUDevice) {}

  private k() {
    const dev = this.device;
    const mod = makeModule(dev, 'terrain flood', [floodW]);
    const spec = { 0: 'uniform', 1: 'read', 2: 'read', 3: 'rw', 4: 'rw' } as const;
    this.kernels ??= Promise.all([makeComputeAsync(dev, 'terrain fillStep', mod, spec, 'fillStep'), makeComputeAsync(dev, 'terrain markInit', mod, spec, 'markInit'), makeComputeAsync(dev, 'terrain markStep', mod, spec, 'markStep')]).then(([fill, markI, mark]) => ({ fill, markI, mark }));
    return this.kernels;
  }

  /** the flood of grid G from `seed` (a texel): to `level`, or to the basin's spill height */
  async flood(G: FloodGrid, seed: number, level?: number): Promise<FloodMask & { filled?: Float32Array }> {
    const dev = this.device;
    const K = await this.k();
    const { m } = G;
    const N = m * m;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const uni = dev.createBuffer({ label: 'flood params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const hB = dev.createBuffer({ label: 'flood h', size: N * 4, usage: S });
    const A = dev.createBuffer({ label: 'flood a', size: N * 4, usage: S });
    const B = dev.createBuffer({ label: 'flood b', size: N * 4, usage: S });
    const ch = dev.createBuffer({ label: 'flood changed', size: 4, usage: S });
    const rd = dev.createBuffer({ label: 'flood read', size: N * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const chR = dev.createBuffer({ label: 'flood changed read', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const params = (lv: number) => {
      const ab = new ArrayBuffer(16);
      new Uint32Array(ab).set([m, seed]);
      new Float32Array(ab)[2] = lv;
      dev.queue.writeBuffer(uni, 0, ab);
    };
    dev.queue.writeBuffer(hB, 0, G.h);
    const groups = Math.ceil(m / 8);
    const bgAB = (k: ComputeKernel, src: GPUBuffer, dst: GPUBuffer) => makeBindGroup(dev, 'flood', k.layout, { 0: uni, 1: hB, 2: src, 3: dst, 4: ch });
    /** passes in batches of `batch`, ping-pong A↔B; until a batch changes nothing; the result's buffer */
    const iterate = async (k: ComputeKernel, batch: number, max: number): Promise<[GPUBuffer, number]> => {
      const g1 = bgAB(k, A, B);
      const g2 = bgAB(k, B, A);
      let n = 0;
      for (;;) {
        dev.queue.writeBuffer(ch, 0, new Uint32Array([0]));
        const enc = dev.createCommandEncoder({ label: 'flood passes' });
        for (let b = 0; b < batch; b++) {
          const cp = enc.beginComputePass();
          cp.setPipeline(k.pipeline);
          cp.setBindGroup(0, n % 2 === 0 ? g1 : g2);
          cp.dispatchWorkgroups(groups, groups);
          cp.end();
          n++;
        }
        enc.copyBufferToBuffer(ch, 0, chR, 0, 4);
        dev.queue.submit([enc.finish()]);
        await chR.mapAsync(GPUMapMode.READ);
        const c = new Uint32Array(chR.getMappedRange().slice(0))[0];
        chR.unmap();
        if (c === 0 || n >= max) return [n % 2 === 0 ? A : B, n];
      }
    };
    const read = async (b: GPUBuffer) => {
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(b, 0, rd, 0, N * 4);
      dev.queue.submit([enc.finish()]);
      await rd.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(rd.getMappedRange().slice(0));
      rd.unmap();
      return out;
    };
    try {
      let filled: Float32Array | undefined;
      let L = level;
      if (L === undefined) {
        // the fill: W0 the ground at the outlets, +inf elsewhere
        const W0 = new Float32Array(N).fill(1e30);
        for (let i = 0; i < N; i++) {
          const x = i % m;
          const y = (i - x) / m;
          if (x === 0 || y === 0 || x === m - 1 || y === m - 1 || G.outlet?.[i]) W0[i] = G.h[i];
        }
        dev.queue.writeBuffer(A, 0, W0);
        params(0);
        const [out, n] = await iterate(K.fill, 32, 8 * m);
        this.passes[0] = n;
        filled = await read(out);
        L = filled[seed];
      }
      // the mark: from the seed under the level (strictly: at the spill height the spill point itself stays dry, or the
      // water would run out through it into the next basin)
      params(L);
      {
        const enc = dev.createCommandEncoder();
        const cp = enc.beginComputePass();
        cp.setPipeline(K.markI.pipeline);
        cp.setBindGroup(0, bgAB(K.markI, B, A));
        cp.dispatchWorkgroups(groups, groups);
        cp.end();
        dev.queue.submit([enc.finish()]);
      }
      const [out, n] = await iterate(K.mark, 32, 8 * m);
      this.passes[1] = n;
      const mk = await read(out);
      const mask = new Uint8Array(N);
      let count = 0;
      let floor = Infinity;
      for (let i = 0; i < N; i++)
        if (mk[i] > 0.5) {
          mask[i] = 1;
          count++;
          floor = Math.min(floor, G.h[i]);
        }
      return { level: L, mask, count, floor, spill: spillOf(G, mask), filled };
    } finally {
      for (const b of [uni, hB, A, B, ch, rd, chR]) b.destroy();
    }
  }
}

/**
 * The flood tool over the atlas: a window of the macro ground round the seed (the standing sea its outlets), flooded
 * on the GPU, written into the atlas as a basin (Atlas.addBasin).
 */
export class FloodField {
  private gpu: FloodGpu;
  constructor(readonly atlas: Atlas) {
    this.gpu = new FloodGpu(atlas.device);
  }

  /** the window of macro ground round a point a flood works in */
  grid(at: V2, reach = 2048): { G: FloodGrid; seed: number; idx: Int32Array; ox: number; oy: number } {
    const a = this.atlas;
    const n = a.p.n;
    const tex = a.worldW / n;
    // the window: `reach` world units round the seed, a power-of-two-ish side in texels (≤ 1024)
    const m = Math.min(1024, Math.max(16, Math.ceil((reach * 2) / tex)));
    const tx = Math.floor((at[0] / a.worldW) * n);
    const ty = Math.floor((at[1] / a.worldH) * n);
    const ox = tx - (m >> 1);
    const oy = ty - (m >> 1);
    const h = new Float32Array(m * m);
    const outlet = new Uint8Array(m * m);
    const idx = new Int32Array(m * m);
    for (let y = 0; y < m; y++)
      for (let x = 0; x < m; x++) {
        const gx = (((ox + x) % n) + n) % n;
        const gy = (((oy + y) % n) + n) % n;
        const gi = gy * n + gx;
        const i = y * m + x;
        idx[i] = gi;
        const sea = !a.defs[a.regionOf[gi]].stat.land;
        // (the standing sea is an outlet at its level, the datum: water poured in a basin that reaches it runs out)
        h[i] = sea ? Math.max(a.hmac[gi], a.p.sea) : a.hmac[gi];
        outlet[i] = sea ? 1 : 0;
      }
    return { G: { m, h, outlet }, seed: (m >> 1) * m + (m >> 1), idx, ox, oy };
  }

  /** the GPU's flood against the CPU's reference on the same window: the levels and the texels that differ */
  async check(at: V2, reach = 1024): Promise<{ gpuLevel: number; cpuLevel: number; gpuCount: number; cpuCount: number; differ: number; passes: [number, number]; gpuMs: number; cpuMs: number }> {
    const { G, seed } = this.grid(at, reach);
    const t0 = performance.now();
    const g = await this.gpu.flood(G, seed);
    const t1 = performance.now();
    const W = fillCpu(G);
    const c = markCpu(G, seed, W[seed]);
    const t2 = performance.now();
    let differ = 0;
    for (let i = 0; i < G.m * G.m; i++) if (g.mask[i] !== c.mask[i]) differ++;
    return { gpuLevel: g.level, cpuLevel: W[seed], gpuCount: g.count, cpuCount: c.count, differ, passes: [...this.gpu.passes], gpuMs: +(t1 - t0).toFixed(1), cpuMs: +(t2 - t1).toFixed(1) };
  }

  async flood(req: FloodRequest): Promise<FloodResult> {
    const t0 = performance.now();
    const a = this.atlas;
    const n = a.p.n;
    const tex = a.worldW / n;
    const { G, seed, idx, ox, oy } = this.grid(req.at, req.reach ?? 2048);
    const m = G.m;
    const r = await this.gpu.flood(G, seed, req.level);
    if (r.count) {
      const inside: number[] = [];
      for (let i = 0; i < m * m; i++) if (r.mask[i]) inside.push(idx[i]);
      a.addBasin(inside, rimOf(m, r.mask).map((i) => idx[i]), r.level, FLUID_CODE[req.fluid]);
    }
    const at = (i: number): V2 => [((ox + (i % m) + 0.5) / n) * a.worldW, ((oy + Math.floor(i / m) + 0.5) / n) * a.worldH];
    return {
      level: +r.level.toFixed(2),
      area: r.count * tex * tex,
      depth: r.count ? +(r.level - r.floor).toFixed(2) : 0,
      spill: r.spill >= 0 ? at(r.spill) : null,
      ms: +(performance.now() - t0).toFixed(1),
    };
  }
}
