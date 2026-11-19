// Nested scales lab: the draw (gpu/draw.wgsl). Every level draws its columns as boxes: one indirect, instanced draw a
// level over the face pages the GPU baked when the columns changed (nest.wgsl faceBake; the arguments and the page list
// are the nest's). A frame runs no compute here: it only draws. Finest first, composed by depth (reverse Z, each level's
// view-projection in its own units). A second target carries per-pixel info for the measurements.
import storeWgsl from './gpu/store.wgsl?raw';
import drawWgsl from './gpu/draw.wgsl?raw';
import { MAX_LEVELS, SEG_BASE, TCAP, TPP, segWgsl, type GpuNest } from './gpu/nest';

const DU = 256;
const DU_SIZE = 160;
/** a grid's model matrix: one root grid at the world origin today (identity); another grid would carry its rigid frame */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export interface DrawLevel {
  depth: number;
  /** (metrics) the distance from the eye, in this level's units, within which its child is wanted (0: none) */
  want: number;
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
  /** (diagnostics) 0 off, 1 colour by triangle parity, 2 by face kind */
  diag = 0;
  /** (round 14) the smooth draw's crease angle, degrees: shaded flat where vertex and face normals differ by more */
  crease = 50;

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
    this.pl = pl;
  }
  private pl: GPUPipelineLayout;
  /** (round 14, NS-107) the smooth draw's two pipelines: the exceptions (the face pages, placed) and the template over
   *  the cache pages; made when it is first switched on */
  private smoothPipe: { sheet: GPURenderPipeline } | null = null;
  private smoothPipes(): { sheet: GPURenderPipeline } {
    if (!this.smoothPipe) {
      const mk = (label: string, vs: string) =>
        this.device.createRenderPipeline({
          label,
          layout: this.pl,
          vertex: { module: this.module, entryPoint: vs },
          fragment: { module: this.module, entryPoint: 'fsS', targets: [{ format: this.format }, { format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        });
      // (round 16) the owner's sheets: one draw a level, an instance a sheet of a chunk (nest.wgsl dirBuild)
      this.smoothPipe = { sheet: mk('nest draw sheets', 'vsSheet') };
    }
    return this.smoothPipe;
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
    // finest first: the depth test then spares the coarse levels' fragments under it
    const order = [...levels].sort((a, b) => b.depth - a.depth);
    if (this.nest.smooth) {
      // (round 16) per level the sheets
      const sp = this.smoothPipes();
      pass.setPipeline(sp.sheet);
      for (const lv of order) {
        pass.setBindGroup(0, this.bg!, [lv.depth * DU]);
        pass.drawIndirect(this.nest.drawArgs, (3 * MAX_LEVELS + lv.depth) * 16);
      }
    } else {
      pass.setPipeline(this.pipe);
      for (const lv of order) {
        pass.setBindGroup(0, this.bg!, [lv.depth * DU]);
        pass.drawIndirect(this.nest.drawArgs, lv.depth * 16);
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return tex;
  }

  /** the per-level uniforms (pages: the capture's face pages a level) */
  private uniforms(levels: DrawLevel[], pages: number[] = [], tpages: number[] = [], wblocks: number[] = []): void {
    const st = new ArrayBuffer(DU * MAX_LEVELS);
    for (const lv of levels) {
      const w = this.nest.wins[lv.depth];
      if (!w) continue;
      new Int32Array(st, lv.depth * DU, 4).set([w.gx, w.gy, w.n, lv.depth]);
      const f = new Float32Array(st, lv.depth * DU + 16, 12);
      f.set([this.diag, 0, this.tint ? 1 : 0, this.nest.k], 0);
      // (want.w: 1 / k, exact on the CPU, for the rim vertices: round 11)
      f.set([lv.want, 0, 0, 1 / this.nest.k], 4);
      // (sun.w, round 14: the smooth draw's crease angle as its cosine)
      f.set([0.45, -0.35, 0.82, Math.cos((this.crease * Math.PI) / 180)], 8);
      new Uint32Array(st, lv.depth * DU + 64, 4).set([this.nest.cap, tpages[lv.depth] ?? 0, wblocks[lv.depth] ?? 0, pages[lv.depth] ?? 0]);
      new Float32Array(st, lv.depth * DU + 80, 16).set(IDENTITY);
      // (round 11, NS-97) the live child's window: the parent's rim vertices are placed in its units
      const c = this.nest.wins[lv.depth + 1];
      new Int32Array(st, lv.depth * DU + 144, 4).set(c ? [c.gx, c.gy, c.n, 1] : [0, 0, 0, 0]);
    }
    this.device.queue.writeBuffer(this.ubuf, 0, st);
  }

  private capPipe: { p: GPUComputePipeline; t: GPUComputePipeline; sb: GPUComputePipeline; layout: GPUBindGroupLayout } | null = null;
  /** (the watertight check, test only: a readback) every triangle the draw places for each level, local units: three
   *  vec4 a triangle slot (w = 0 for an empty slot). With the smooth draw on (round 14) the template's triangles follow
   *  the exceptions' (`ex`: how many slots are the exceptions'; template slots that are degenerate have w = 0). */
  async capture(levels: DrawLevel[]): Promise<{ depth: number; n: number; tris: Float32Array; ex: number }[]> {
    if (!this.capPipe) {
      const layout = this.device.createBindGroupLayout({ label: 'nest capture', entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      const pl = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout, layout] });
      this.capPipe = {
        p: this.device.createComputePipeline({ label: 'nest capture', layout: pl, compute: { module: this.module, entryPoint: 'capture' } }),
        t: this.device.createComputePipeline({ label: 'nest capture (template)', layout: pl, compute: { module: this.module, entryPoint: 'captureT' } }),
        sb: this.device.createComputePipeline({ label: 'nest capture (sheets)', layout: pl, compute: { module: this.module, entryPoint: 'captureSheet' } }),
        layout,
      };
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
    const args = new Uint32Array(await read(this.nest.drawArgs, 4 * MAX_LEVELS * 16));
    const pages = levels.map(() => 0);
    const tpages = levels.map(() => 0);
    const wblocks = levels.map(() => 0);
    const smooth = this.nest.smooth;
    for (const lv of levels) {
      // (round 15) with the smooth draw on, the exceptions as it draws them: blocks of 128 face triangles (vsSB)
      pages[lv.depth] = args[((smooth ? 3 * MAX_LEVELS : 0) + lv.depth) * 4 + 1];
      if (smooth) tpages[lv.depth] = args[(MAX_LEVELS + lv.depth) * 4 + 1];
      if (smooth) wblocks[lv.depth] = args[(2 * MAX_LEVELS + lv.depth) * 4 + 1];
    }
    this.bind();
    const out = [];
    const one = async (pipe: GPUComputePipeline, depth: number, slots: number) => {
      const size = Math.max(16, slots * 48);
      const buf = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const bg1 = this.device.createBindGroup({ layout: this.capPipe!.layout, entries: [{ binding: 0, resource: { buffer: buf } }] });
      this.uniforms(levels, pages, tpages, wblocks);
      const e = this.device.createCommandEncoder();
      const p = e.beginComputePass();
      p.setPipeline(pipe);
      p.setBindGroup(0, this.bg!, [depth * DU]);
      p.setBindGroup(1, bg1);
      // (two dimensions: a level's slots can need more than 65,535 workgroups)
      const groups = Math.ceil(slots / 64);
      const gx = Math.min(groups, 65535);
      if (slots > 0) p.dispatchWorkgroups(gx, Math.ceil(groups / gx));
      p.end();
      this.device.queue.submit([e.finish()]);
      const r = new Float32Array(await read(buf, size));
      buf.destroy();
      return r.subarray(0, slots * 12);
    };
    for (const lv of levels) {
      // (a level demoted while this awaited: skipped)
      if (!this.nest.wins[lv.depth]) continue;
      // (round 16) with the smooth draw on: the sheets as vsSheet places them (544 slots an instance)
      const ex = smooth ? await one(this.capPipe.sb, lv.depth, pages[lv.depth] * 544) : await one(this.capPipe.p, lv.depth, pages[lv.depth] * TPP);
      const tris = ex;
      if (!this.nest.wins[lv.depth]) continue;
      out.push({ depth: lv.depth, n: this.nest.wins[lv.depth]!.n, tris, ex: ex.length / 12 });
    }
    return out;
  }
}
