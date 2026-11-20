// Nested scales lab (round 25): the terrain generator, ported, not written. The atlas the game makes (src/atlas: the
// same Atlas.build, its GPU passes and the CPU steps that are part of it) over a larger torus, and the lab's kernel
// genFill (gpu/gen.wgsl) appended to Atlas.parts() like terrain/sample.wgsl, evaluating the atlas's ground(p) at a
// level's column centres into the generator field that nest.wgsl derive and rootGen read (GpuNest.gen).
// docs/design/NESTED_SCALES.md "Round 25 plan" and "As built (round 25)".
import { Atlas, DEFAULT_ATLAS, atlasParamsFrom, type AtlasParams } from '../atlas/atlas';
import { makeBindGroup, makeModule, type ComputeKernel } from '../gpu/pipeline';
import type { GenHook } from './gpu/nest';
import genWgsl from './gpu/gen.wgsl?raw';

/** the field's header (vec4s) before the levels' slots (gen.wgsl GEN_HDR, nest.wgsl GEN_HDR) */
const GEN_HDR = 8;
/** uniform slots a submit (fills encoded between two submits) */
const GU_SLOTS = 32;
const GU_B = 256;

/** the lab's atlas: the game's defaults over a 65.5 x 65.6 km torus (round 25 plan b: the root window is 32.8 km);
 *  zTop raised so nothing is clamped. `?a.<key>=` still sets any of them. */
export function labAtlasParams(q: URLSearchParams): AtlasParams {
  return atlasParamsFrom(q, { ...DEFAULT_ATLAS, cols: 65536, rows: 75712, zTop: 2000 });
}

/** the WGSL of the generator's module (the atlas's parts, then gen.wgsl): no atlas instance is needed for the text
 *  (Atlas.parts reads no field of the atlas), so the compile gate can build it without building an atlas */
export function genModuleParts(): string[] {
  return Atlas.prototype.parts.call(undefined as unknown as Atlas, genWgsl);
}

/** the fill kernel (its own layout: the fill's uniform at 40 takes a dynamic offset, a slot a fill) */
export async function genKernel(device: GPUDevice): Promise<ComputeKernel> {
  const C = GPUShaderStage.COMPUTE;
  const buf = (binding: number, type: GPUBufferBindingType, dyn = false): GPUBindGroupLayoutEntry => ({ binding, visibility: C, buffer: { type, hasDynamicOffset: dyn } });
  const layout = device.createBindGroupLayout({
    label: 'nest genFill',
    entries: [buf(0, 'uniform'), ...[20, 21, 22, 23, 25, 26].map((b) => buf(b, 'read-only-storage')), buf(40, 'uniform', true), buf(41, 'storage')],
  });
  const module = makeModule(device, 'nest gen', genModuleParts());
  const pipeline = await device.createComputePipelineAsync({ label: 'nest genFill', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: 'genFill' } });
  return { pipeline, layout };
}

export class NestGen implements GenHook {
  readonly field: GPUBuffer;
  private ubuf: GPUBuffer;
  private stage = new ArrayBuffer(GU_B * GU_SLOTS);
  private used = 0;
  private bg: GPUBindGroup;
  private ap: GPUBuffer;
  /** ms: the atlas's build (its own timings in atlas.timings) and the fill kernel's compile */
  readonly ms: { atlas: number; compile: number };

  private constructor(
    readonly atlas: Atlas,
    private kernel: ComputeKernel,
    /** a level's slot side (the widest window: root or ?n) */
    readonly slotN: number,
    /** levels with a slot (the root and every finer level the page may open) */
    readonly levels: number,
    /** metres a root column; a level's column is rootM / k^L */
    readonly rootM: number,
    readonly k: number,
    ms: { atlas: number; compile: number },
  ) {
    const dev = atlas.device;
    this.ms = ms;
    this.field = dev.createBuffer({ label: 'nest gen field', size: (GEN_HDR + levels * slotN * slotN) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const hdr = new Float32Array(GEN_HDR * 4);
    for (let L = 0; L < levels; L++) hdr.set([rootM / k ** L, slotN, 1, 0], L * 4);
    dev.queue.writeBuffer(this.field, 0, hdr);
    this.ubuf = dev.createBuffer({ label: 'nest gen uniforms', size: GU_B * GU_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // (the atlas's params as ground() reads them, in a buffer of our own: the atlas's is the build's; terrain/sample.ts)
    this.ap = dev.createBuffer({ label: 'nest gen atlas params', size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    atlas.writeParams({}, this.ap);
    const a = atlas;
    this.bg = makeBindGroup(dev, 'nest gen', kernel.layout, { 0: this.ap, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 40: { buffer: this.ubuf, size: 48 }, 41: this.field });
  }

  /** the atlas built and the fill kernel made (both asynchronous; the kernel compiles while the atlas builds) */
  static async create(device: GPUDevice, p: AtlasParams, o: { slotN: number; levels: number; rootM: number; k: number }): Promise<NestGen> {
    const t0 = performance.now();
    const kp = genKernel(device);
    let compile = 0;
    void kp.then(() => (compile = performance.now() - t0));
    const atlas = await Atlas.build(device, p);
    const atlasMs = performance.now() - t0;
    const kernel = await kp;
    if ((o.rootM / o.k ** (o.levels - 1)) * 2 ** 24 < p.cols) throw new Error('nest gen: a column too small for exact positions');
    return new NestGen(atlas, kernel, o.slotN, o.levels, o.rootM, o.k, { atlas: atlasMs, compile });
  }

  fill(pass: GPUComputePassEncoder, L: number, x0: number, y0: number, w: number, h: number): void {
    if (L >= this.levels) throw new Error(`nest gen: level ${L} has no slot (${this.levels} levels)`);
    if (w > this.slotN || h > this.slotN) throw new Error(`nest gen: a fill of ${w} x ${h} is wider than the slot (${this.slotN})`);
    if (this.used >= GU_SLOTS) throw new Error('nest gen: more fills in one submit than uniform slots');
    const off = this.used++ * GU_B;
    new Int32Array(this.stage, off, 8).set([L, x0, y0, w, h, this.slotN, 0, 0]);
    new Float32Array(this.stage, off + 32, 4).set([this.rootM / this.k ** L, 0, 0, 0]);
    // (written before the submit that holds this pass: queue writes go ahead of later submits)
    this.atlas.device.queue.writeBuffer(this.ubuf, off, this.stage, off, 48);
    pass.setPipeline(this.kernel.pipeline);
    pass.setBindGroup(0, this.bg, [off]);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  }

  submitted(): void {
    this.used = 0;
  }
}
