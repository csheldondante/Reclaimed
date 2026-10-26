// The land round the window in rings of less detail (round 83, lod.wgsl; drawn by far.ts): each ring a
// grid of the atlas's ground (the same function the streamer's columns are made from), its vertices
// 2, 4, 8, 16 cells apart, centred on the camera. A ring is made again (on the GPU, a dispatch) when the
// camera has moved 8 of its spacings, when the window slides, and one ring every few seconds for the
// coarse world's changes. Each ring's edge melts into the next one out (far.wgsl vsLod), the last into
// the far land: no cracks between them.

import { makeBindGroup, makeComputeAsync, makeModule, type ComputeKernel } from '../gpu/pipeline';
import { MATERIALS } from '../world/materials';
import type { Atlas } from './atlas';
import lodW from './lod.wgsl?raw';

/** far.wgsl LodD: a vec4 a ring (4), then info */
export const LOD_UNI_BYTES = 5 * 16;
const MAX_RINGS = 4;
/** seconds between one ring's refresh and the next's (the coarse world changes slowly) */
const REFRESH_S = 3;

export class LodRings {
  /** each ring's top and colour, rings × n² texels (lod.wgsl lodOut) */
  readonly data: GPUBuffer;
  /** far.wgsl LodD */
  readonly uni: GPUBuffer;
  private kernel?: ComputeKernel;
  private atlasParams: GPUBuffer;
  private ringParams: GPUBuffer[];
  private albedo: GPUBuffer;
  /** each ring's texel (0, 0) as made (window coordinates), null: not yet */
  private made: ([number, number] | null)[];
  /** the window's origin they were made for */
  private madeOrg: [number, number] | null = null;
  private refresh = REFRESH_S;
  private next = 0;
  /** every ring made at least once: drawn from then */
  ready = false;

  constructor(
    private device: GPUDevice,
    private atlas: Atlas,
    /** world units between a ring's vertices, finest first (each twice the last) */
    readonly spacings: number[] = [2, 4, 8, 16],
    /** vertices a side (odd: (n − 1) / 2 a multiple of 4, so a ring's edge is on the next one's lattice) */
    readonly n = 193,
  ) {
    if (spacings.length > MAX_RINGS) throw new Error(`LodRings: at most ${MAX_RINGS} rings`);
    if ((n - 1) % 8 !== 0) throw new Error('LodRings: (n − 1) a multiple of 8');
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.data = device.createBuffer({ label: 'lod rings', size: spacings.length * n * n * 8, usage: S });
    this.uni = device.createBuffer({ label: 'lod draw', size: LOD_UNI_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.atlasParams = device.createBuffer({ label: 'lod atlas params', size: atlas.paramBuf.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    atlas.writeParams({}, this.atlasParams);
    this.ringParams = spacings.map(() => device.createBuffer({ label: 'lod ring', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const alb = new Float32Array(Math.max(1, MATERIALS.length) * 4);
    MATERIALS.forEach((m, i) => alb.set([...m.albedo, 1], i * 4));
    this.albedo = device.createBuffer({ label: 'lod albedo', size: alb.byteLength, usage: S });
    device.queue.writeBuffer(this.albedo, 0, alb);
    this.made = spacings.map(() => null);
    const module = makeModule(device, 'lod', atlas.parts(lodW));
    void makeComputeAsync(device, 'lod', module, { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 50: 'uniform', 51: 'rw', 52: 'read' }, 'lodHeight').then((k) => (this.kernel = k));
  }

  /** a ring's texel (0, 0) for the camera at `mid` (window coordinates): on the lattice of 8 of its spacings */
  private originFor(k: number, mid: readonly number[]): [number, number] {
    const s = this.spacings[k];
    const half = ((this.n - 1) / 2) * s;
    return [Math.round(mid[0] / (8 * s)) * 8 * s - half, Math.round(mid[1] / (8 * s)) * 8 * s - half];
  }

  /**
   * Each frame before drawing: the camera (window coordinates) and the window's origin (world units).
   * Makes the rings that moved (a dispatch each), writes far.wgsl's LodD.
   */
  update(mid: readonly number[], org: readonly number[], dt: number): void {
    const k = this.kernel;
    if (!k) return;
    const a = this.atlas;
    const slid = !this.madeOrg || this.madeOrg[0] !== org[0] || this.madeOrg[1] !== org[1];
    this.refresh -= dt;
    const stale = this.refresh <= 0 && this.ready ? this.next : -1;
    if (stale >= 0) {
      this.refresh = REFRESH_S;
      this.next = (this.next + 1) % this.spacings.length;
    }
    const enc = this.device.createCommandEncoder({ label: 'lod' });
    let any = false;
    const n = this.n;
    this.spacings.forEach((s, i) => {
      const o = this.originFor(i, mid);
      const m = this.made[i];
      if (!slid && m && m[0] === o[0] && m[1] === o[1] && i !== stale) return;
      // (a ring's own parameters: the passes in one encoder each read theirs)
      this.device.queue.writeBuffer(this.ringParams[i], 0, new Float32Array([o[0] + org[0], o[1] + org[1], s, n, ...new Float32Array(new Uint32Array([i * n * n, 0, 0, 0]).buffer)]));
      const cp = enc.beginComputePass({ label: 'lod' });
      cp.setPipeline(k.pipeline);
      cp.setBindGroup(0, makeBindGroup(this.device, 'lod ring', k.layout, { 0: this.atlasParams, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 50: this.ringParams[i], 51: this.data, 52: this.albedo }));
      cp.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8));
      cp.end();
      this.made[i] = o;
      any = true;
    });
    if (any) this.device.queue.submit([enc.finish()]);
    this.madeOrg = [org[0], org[1]];
    this.ready = true;
    const f = new Float32Array(LOD_UNI_BYTES / 4);
    this.made.forEach((m, i) => f.set([m![0], m![1], this.spacings[i], n], i * 4));
    const outer = this.made[this.made.length - 1]!;
    const span = (n - 1) * this.spacings[this.spacings.length - 1];
    f.set([this.spacings.length, outer[0], outer[1], span], MAX_RINGS * 4);
    this.device.queue.writeBuffer(this.uni, 0, f);
  }

  dispose(): void {
    this.data.destroy();
    this.uni.destroy();
    this.atlasParams.destroy();
    this.albedo.destroy();
    for (const b of this.ringParams) b.destroy();
  }
}
