// Nested scales lab (round 27): the tiling material textures (gpu/texgen.wgsl), generated once on the GPU after the
// first frame, a material a frame (staged: no frame waits for more than one layer and its mips), and drawn by ?tex=2
// (gpu/tex.wgsl). No image files. Two texture arrays, a layer a material (id - 1), mipmapped:
//   A rgba8unorm: albedo (sRGB values) and roughness;  N rgba8unorm: normal x, y, height, cavity.
import texgenWgsl from './gpu/texgen.wgsl?raw';

/** the tile's side, texels (mip 0) */
export const TEX_N = 512;
/** layers: stone, soil, sand, clay, plants (material ids 1-5) */
export const TEX_LAYERS = 5;
export const TEX_MIPS = Math.log2(TEX_N) + 1;
/** the fine tile's world size, metres (the coarse one is 16 x: tex.wgsl TX_COARSE) */
export const TEX_TILE_M = 2;

export class TexGen {
  readonly a: GPUTexture;
  readonly n: GPUTexture;
  readonly viewA: GPUTextureView;
  readonly viewN: GPUTextureView;
  readonly sampler: GPUSampler;
  /** layers generated (mip chain included) */
  done = 0;
  /** ms: the generator's pipelines made; each layer's frame (CPU encode); all layers done on the GPU after the start */
  readonly ms = { compile: 0, layers: [] as number[], total: 0 };
  private pipes: { gen: GPUComputePipeline; mip: GPUComputePipeline; lGen: GPUBindGroupLayout; lMip: GPUBindGroupLayout } | null = null;
  private making: Promise<void> | null = null;
  private ubuf: GPUBuffer;
  private t0 = 0;
  /** bytes the two arrays hold, mips included */
  readonly bytes: number;

  constructor(private device: GPUDevice) {
    const desc = (label: string): GPUTextureDescriptor => ({
      label,
      size: [TEX_N, TEX_N, TEX_LAYERS],
      format: 'rgba8unorm',
      mipLevelCount: TEX_MIPS,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.a = device.createTexture(desc('nest tex albedo'));
    this.n = device.createTexture(desc('nest tex normal'));
    this.viewA = this.a.createView({ dimension: '2d-array' });
    this.viewN = this.n.createView({ dimension: '2d-array' });
    // (repeat: the tiles wrap; trilinear and anisotropic: the draw passes the gradients)
    this.sampler = device.createSampler({ label: 'nest tex', addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16 });
    this.ubuf = device.createBuffer({ label: 'nest texgen uniforms', size: 256 * TEX_MIPS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    let b = 0;
    for (let m = 0; m < TEX_MIPS; m++) b += (TEX_N >> m) ** 2 * 4 * TEX_LAYERS * 2;
    this.bytes = b;
  }

  get ready(): boolean {
    return this.done >= TEX_LAYERS;
  }
  /** one frame's step: the pipelines made (asynchronously), then a layer and its mips a call; false while not finished */
  step(): boolean {
    if (this.ready) return true;
    if (!this.pipes) {
      if (!this.making) {
        const t = performance.now();
        this.t0 = t;
        const dev = this.device;
        const C = GPUShaderStage.COMPUTE;
        const st = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } });
        const uni: GPUBindGroupLayoutEntry = { binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } };
        const lGen = dev.createBindGroupLayout({ label: 'nest texGen', entries: [uni, st(1), st(2)] });
        const tx = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } });
        const lMip = dev.createBindGroupLayout({ label: 'nest texMip', entries: [uni, st(1), st(2), tx(3), tx(4)] });
        const module = dev.createShaderModule({ label: 'nest texgen', code: texgenWgsl });
        this.making = Promise.all([
          dev.createComputePipelineAsync({ label: 'nest texGen', layout: dev.createPipelineLayout({ bindGroupLayouts: [lGen] }), compute: { module, entryPoint: 'texGen' } }),
          dev.createComputePipelineAsync({ label: 'nest texMip', layout: dev.createPipelineLayout({ bindGroupLayouts: [lMip] }), compute: { module, entryPoint: 'texMip' } }),
        ]).then(([gen, mip]) => {
          this.pipes = { gen, mip, lGen, lMip };
          this.ms.compile = performance.now() - t;
        });
      }
      return false;
    }
    this.layer(this.done);
    this.done++;
    if (this.ready) {
      const t = this.t0;
      void this.device.queue.onSubmittedWorkDone().then(() => (this.ms.total = performance.now() - t));
    }
    return this.ready;
  }
  /** layer L's mip 0 and its mip chain, one submit */
  private layer(L: number): void {
    const t = performance.now();
    const dev = this.device;
    const p = this.pipes!;
    const u = new Uint32Array(64 * TEX_MIPS);
    // (w: the generator's samples a texel, 5: texgen.wgsl's loop bound, from here so the compiler cannot unroll it)
    for (let m = 0; m < TEX_MIPS; m++) u.set([L, TEX_N >> m, Math.max(0, m - 1), 5], m * 64);
    dev.queue.writeBuffer(this.ubuf, 0, u);
    const enc = dev.createCommandEncoder({ label: 'nest texgen' });
    const view = (t: GPUTexture, m: number) => t.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1, baseArrayLayer: L, arrayLayerCount: 1 });
    const pass = enc.beginComputePass({ label: 'nest texgen' });
    // (a view of the one layer: the kernels address layer 0 of it)
    for (let m = 0; m < TEX_MIPS; m++) {
      const side = TEX_N >> m;
      const bg =
        m === 0
          ? dev.createBindGroup({ layout: p.lGen, entries: [{ binding: 0, resource: { buffer: this.ubuf, size: 16 } }, { binding: 1, resource: view(this.a, 0) }, { binding: 2, resource: view(this.n, 0) }] })
          : dev.createBindGroup({
              layout: p.lMip,
              entries: [
                { binding: 0, resource: { buffer: this.ubuf, size: 16 } },
                { binding: 1, resource: view(this.a, m) },
                { binding: 2, resource: view(this.n, m) },
                { binding: 3, resource: view(this.a, m - 1) },
                { binding: 4, resource: view(this.n, m - 1) },
              ],
            });
      pass.setPipeline(m === 0 ? p.gen : p.mip);
      pass.setBindGroup(0, bg, [m * 256]);
      pass.dispatchWorkgroups(Math.ceil(side / 8), Math.ceil(side / 8));
    }
    pass.end();
    dev.queue.submit([enc.finish()]);
    this.ms.layers.push(performance.now() - t);
  }
  destroy(): void {
    this.a.destroy();
    this.n.destroy();
    this.ubuf.destroy();
  }
}
