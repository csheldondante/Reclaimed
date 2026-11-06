// (round 128o, DA-B28) Chunk pages written into the window's layers on the GPU, compared slot by slot before written
// (shaders/pagewrite.wgsl): what a region brings moves a chunk's versions (sim/chunkver.ts: its columns', its blocks'
// shape) only where it differs from what the storage holds. The streamer's region writes go through it (from the
// region pool, or the CPU's pages staged) in place of copying the pages over. API: PageWrite.encode.
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import pagewriteWgsl from '../shaders/pagewrite.wgsl?raw';
import { CHUNK } from '../world/layout';
import type { WorldGpu } from './world-gpu';

/** pagewrite.wgsl PW_MAX */
const PW_MAX = 64;

export class PageWrite {
  private k: ComputeKernel;
  private params: GPUBuffer;
  private groups = new WeakMap<GPUBuffer, GPUBindGroup>();
  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
  ) {
    this.k = makeCompute(device, 'pagewrite', [commonWgsl, layersWgsl, materialsWgsl, pagewriteWgsl], { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'rw', 4: 'read', 5: 'uniform' });
    this.params = device.createBuffer({ label: 'pagewrite jobs', size: 16 + PW_MAX * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /**
   * Pages from `src` into the window's layers: each job a page at byte `off` in `src` (its columns' slots, as the
   * chunk's own page) for window chunk `ci`. Encoded into `enc`; its jobs written now (one call a submit).
   */
  encode(enc: GPUCommandEncoder, src: GPUBuffer, jobs: { off: number; ci: number }[]): void {
    if (!jobs.length) return;
    if (jobs.length > PW_MAX) throw new Error(`pagewrite: ${jobs.length} pages in one call, ${PW_MAX} at most`);
    const p = new Uint32Array(4 + PW_MAX * 4);
    p[0] = jobs.length;
    jobs.forEach((j, i) => {
      if (j.off % 16) throw new Error('pagewrite: a page starts on a slot');
      p.set([j.off / 16, j.ci, 0, 0], 4 + i * 4);
    });
    this.device.queue.writeBuffer(this.params, 0, p, 0, 4 + jobs.length * 4);
    let g = this.groups.get(src);
    if (!g) {
      const w = this.world;
      g = makeBindGroup(this.device, 'pagewrite', this.k.layout, { 0: w.globals, 1: w.chunks, 2: w.materials, 3: w.layers, 4: src, 5: this.params });
      this.groups.set(src, g);
    }
    const pass = enc.beginComputePass({ label: 'pagewrite', timestampWrites: this.prof.timestamps('pagewrite') });
    pass.setPipeline(this.k.pipeline);
    pass.setBindGroup(0, g);
    pass.dispatchWorkgroups((CHUNK * CHUNK) / 64, jobs.length);
    pass.end();
    this.prof.dispatches++;
  }
}
