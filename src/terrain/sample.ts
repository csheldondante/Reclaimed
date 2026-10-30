// Terrain track (round 117): the land on a grid, sampled on the GPU from the atlas's ground() (terrain/sample.wgsl),
// read back once for the region graph (partition.ts). Not on the streaming path: a graph is made when a run is planned
// or the viewer asks (the rule against readbacks is the streamer's, round 106b).

import type { Atlas } from '../atlas/atlas';
import { makeBindGroup, makeComputeAsync, makeModule, type ComputeKernel } from '../gpu/pipeline';
import type { TerrainSamples } from './partition';
import sampleW from './sample.wgsl?raw';

/** the most samples a side one call takes (a 2048-cell square at 4 cells a sample) */
export const MAX_SIDE = 1024;

export class LandSampler {
  private kernel?: Promise<ComputeKernel>;
  constructor(readonly atlas: Atlas) {}

  private k(): Promise<ComputeKernel> {
    const dev = this.atlas.device;
    this.kernel ??= makeComputeAsync(dev, 'terrain sampleLand', makeModule(dev, 'terrain sample', this.atlas.parts(sampleW)), { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 40: 'uniform', 41: 'rw' }, 'sampleLand');
    return this.kernel;
  }

  /** w × h samples `step` world units apart from (x0, y0) (world units) */
  async sample(x0: number, y0: number, w: number, h: number, step: number): Promise<TerrainSamples> {
    if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) throw new Error(`terrain sample: ${w}×${h} samples (1..${MAX_SIDE} a side)`);
    const a = this.atlas;
    const dev = a.device;
    const k = await this.k();
    const N = w * h;
    const pb = dev.createBuffer({ label: 'terrain sample params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ab = new ArrayBuffer(32);
    const f = new Float32Array(ab);
    const u = new Uint32Array(ab);
    f[0] = x0;
    f[1] = y0;
    f[2] = step;
    u[3] = w;
    u[4] = h;
    f[5] = a.p.sea;
    dev.queue.writeBuffer(pb, 0, ab);
    const out = dev.createBuffer({ label: 'terrain samples', size: N * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rd = dev.createBuffer({ label: 'terrain samples read', size: N * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    // (the atlas's params as the ground reads them, in a buffer of our own: the atlas's is the build's and the views')
    const ap = dev.createBuffer({ label: 'terrain sample atlas params', size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    a.writeParams({}, ap);
    const enc = dev.createCommandEncoder({ label: 'terrain sample' });
    const cp = enc.beginComputePass();
    cp.setPipeline(k.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'terrain sample', k.layout, { 0: ap, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 40: pb, 41: out }));
    cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    cp.end();
    enc.copyBufferToBuffer(out, 0, rd, 0, N * 32);
    dev.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    const v = new Float32Array(rd.getMappedRange().slice(0));
    rd.unmap();
    for (const b of [pb, ap, out, rd]) b.destroy();
    const S: TerrainSamples = {
      w,
      h,
      x0,
      y0,
      step,
      ground: new Float32Array(N),
      water: new Float32Array(N),
      wet: new Uint8Array(N),
      lava: new Uint8Array(N),
      veg: new Float32Array(N),
      seed: a.p.seed,
    };
    for (let i = 0; i < N; i++) {
      const o = i * 8;
      S.ground[i] = v[o];
      S.water[i] = v[o + 1] > -1e8 ? v[o + 1] : NaN;
      S.wet[i] = v[o + 2];
      S.lava[i] = v[o + 3];
      S.veg[i] = v[o + 4];
    }
    return S;
  }
}
