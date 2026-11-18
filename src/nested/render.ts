// Nested scales lab: the draw (gpu/draw.wgsl). Every level draws its columns as boxes: one indirect, instanced draw a
// level over the face pages the GPU baked when the columns changed (nest.wgsl faceBake; the arguments and the page list
// are the nest's). A frame runs no compute here: it only draws. Finest first, composed by depth (reverse Z, each level's
// view-projection in its own units). A second target carries per-pixel info for the measurements.
import storeWgsl from './gpu/store.wgsl?raw';
import drawWgsl from './gpu/draw.wgsl?raw';
import { MAX_LEVELS, SEG_BASE, TCAP, TPP, segWgsl, type GpuNest } from './gpu/nest';

const DU = 256;
const DU_SIZE = 144;
/** a grid's model matrix: one root grid at the world origin today (identity); another grid would carry its rigid frame */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export interface DrawLevel {
  depth: number;
  /** (metrics) where the focus wants this level's child, in this level's local units (none: null) */
  want: [number, number, number, number] | null;
}

export class Renderer {
  private pipe: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private module: GPUShaderModule;
  private ubuf: GPUBuffer;
  private bg: GPUBindGroup | null = null;
  private bgFor: GPUBuffer[] = [];
  private depth: GPUTexture | null = null;
  info: GPUTexture | null = null;
  readonly format: GPUTextureFormat;
  tint = false;

  constructor(
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
    private nest: GpuNest,
  ) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    // (compute too: the watertight check's capture runs the vertex code in a compute pass)
    const V = GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE;
    const ro = { type: 'read-only-storage' as const };
    this.layout = device.createBindGroupLayout({
      label: 'nest draw',
      entries: [
        { binding: 0, visibility: V | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DU_SIZE } },
        ...[1, 3, 4, 5, ...Array.from({ length: nest.S }, (_, j) => SEG_BASE + j)].map((binding) => ({ binding, visibility: V, buffer: ro })),
      ],
    });
    const module = (this.module = device.createShaderModule({ label: 'nest draw', code: `const TCAP: u32 = ${TCAP}u;\n${segWgsl(nest.S, nest.segP, true)}\n${storeWgsl}\n${drawWgsl}` }));
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipe = device.createRenderPipeline({
      label: 'nest draw boxes',
      layout: pl,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    this.ubuf = device.createBuffer({ label: 'nest draw uniforms', size: DU * MAX_LEVELS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private targets(w: number, h: number): void {
    if (this.depth && this.depth.width === w && this.depth.height === h) return;
    this.depth?.destroy();
    this.info?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.info = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }
  private bind(): void {
    const segs = this.nest.segBuffers();
    const want = [this.nest.dir, ...segs];
    if (want.length === this.bgFor.length && want.every((b, i) => b === this.bgFor[i])) return;
    this.bg = this.device.createBindGroup({
      label: 'nest draw',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.ubuf, size: DU_SIZE } },
        { binding: 1, resource: { buffer: this.nest.tab } },
        { binding: 3, resource: { buffer: this.nest.cam } },
        { binding: 4, resource: { buffer: this.nest.reg } },
        { binding: 5, resource: { buffer: this.nest.dir } },
        ...segs.map((buffer, j) => ({ binding: SEG_BASE + j, resource: { buffer } })),
      ],
    });
    this.bgFor = want;
  }

  draw(levels: DrawLevel[]): GPUTexture {
    const tex = this.ctx.getCurrentTexture();
    this.targets(tex.width, tex.height);
    this.bind();
    this.uniforms(levels);
    const enc = this.device.createCommandEncoder({ label: 'nest draw' });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.62, g: 0.71, b: 0.78, a: 1 } },
        { view: this.info!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      depthStencilAttachment: { view: this.depth!.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
    });
    pass.setPipeline(this.pipe);
    // finest first: the depth test then spares the coarse levels' fragments under it
    for (const lv of [...levels].sort((a, b) => b.depth - a.depth)) {
      pass.setBindGroup(0, this.bg!, [lv.depth * DU]);
      pass.drawIndirect(this.nest.drawArgs, lv.depth * 16);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return tex;
  }

  /** the per-level uniforms (pages: the capture's face pages a level) */
  private uniforms(levels: DrawLevel[], pages: number[] = []): void {
    const st = new ArrayBuffer(DU * MAX_LEVELS);
    for (const lv of levels) {
      const w = this.nest.wins[lv.depth];
      if (!w) continue;
      new Int32Array(st, lv.depth * DU, 4).set([w.gx, w.gy, w.n, lv.depth]);
      const f = new Float32Array(st, lv.depth * DU + 16, 12);
      f.set([0, 0, this.tint ? 1 : 0, this.nest.k], 0);
      f.set(lv.want ?? [1, 1, 0, 0], 4);
      f.set([0.45, -0.35, 0.82, 0], 8);
      new Uint32Array(st, lv.depth * DU + 64, 4).set([this.nest.cap, 0, 0, pages[lv.depth] ?? 0]);
      new Float32Array(st, lv.depth * DU + 80, 16).set(IDENTITY);
    }
    this.device.queue.writeBuffer(this.ubuf, 0, st);
  }

  private capPipe: { p: GPUComputePipeline; layout: GPUBindGroupLayout } | null = null;
  /** (the watertight check, test only: a readback) every triangle the draw places for each level, local units: three
   *  vec4 a triangle slot (w = 0 for an empty slot) */
  async capture(levels: DrawLevel[]): Promise<{ depth: number; n: number; tris: Float32Array }[]> {
    if (!this.capPipe) {
      const layout = this.device.createBindGroupLayout({ label: 'nest capture', entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      const pl = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout, layout] });
      this.capPipe = { p: this.device.createComputePipeline({ label: 'nest capture', layout: pl, compute: { module: this.module, entryPoint: 'capture' } }), layout };
    }
    const read = async (src: GPUBuffer, size: number) => {
      const tmp = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const e = this.device.createCommandEncoder();
      e.copyBufferToBuffer(src, 0, tmp, 0, size);
      this.device.queue.submit([e.finish()]);
      await tmp.mapAsync(GPUMapMode.READ);
      const out = tmp.getMappedRange().slice(0);
      tmp.destroy();
      return out;
    };
    const args = new Uint32Array(await read(this.nest.drawArgs, MAX_LEVELS * 16));
    const pages = levels.map(() => 0);
    for (const lv of levels) pages[lv.depth] = args[lv.depth * 4 + 1];
    this.bind();
    const out = [];
    for (const lv of levels) {
      // (a level demoted while this awaited: skipped)
      if (!this.nest.wins[lv.depth]) continue;
      const slots = pages[lv.depth] * TPP;
      const size = Math.max(16, slots * 48);
      const buf = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const bg1 = this.device.createBindGroup({ layout: this.capPipe.layout, entries: [{ binding: 0, resource: { buffer: buf } }] });
      this.uniforms(levels, pages);
      const e = this.device.createCommandEncoder();
      const p = e.beginComputePass();
      p.setPipeline(this.capPipe.p);
      p.setBindGroup(0, this.bg!, [lv.depth * DU]);
      p.setBindGroup(1, bg1);
      // (two dimensions: a level's slots can need more than 65,535 workgroups)
      const groups = Math.ceil(slots / 64);
      const gx = Math.min(groups, 65535);
      if (slots > 0) p.dispatchWorkgroups(gx, Math.ceil(groups / gx));
      p.end();
      this.device.queue.submit([e.finish()]);
      out.push({ depth: lv.depth, n: this.nest.wins[lv.depth]!.n, tris: new Float32Array(await read(buf, size)) });
      buf.destroy();
    }
    return out;
  }
}
