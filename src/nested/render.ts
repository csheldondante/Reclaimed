// Nested scales lab: the draw (gpu/draw.wgsl). Every level draws the boundary of solid against air: A, the top sheet
// (an indexed grid pulled from the columns and deformed by their heights); B, everything else (tunnel floors and
// ceilings, overhang undersides, the walls where an air region ends between columns), as one indirect draw over the
// items the GPU baked when the columns changed (nest.wgsl meshBake; the arguments and the page list are the nest's).
// A frame runs no compute here: it only draws. Finest first, composed by depth (reverse Z, each level's
// view-projection in its own units). A second target carries per-pixel info for the measurements.
import storeWgsl from './gpu/store.wgsl?raw';
import drawWgsl from './gpu/draw.wgsl?raw';
import { MAX_LEVELS, SEG_BASE, TCAP, segWgsl, type GpuNest } from './gpu/nest';

const DU = 256;
const DU_SIZE = 112;

export interface DrawLevel {
  depth: number;
  /** the child's footprint in this level's local units (none: null), and where the focus wants it (metrics) */
  cut: [number, number, number, number] | null;
  want: [number, number, number, number] | null;
}

export class Renderer {
  private pipeA: GPURenderPipeline;
  private pipeB: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private module: GPUShaderModule;
  private ubuf: GPUBuffer;
  private bg: GPUBindGroup | null = null;
  private bgFor: GPUBuffer[] = [];
  private depth: GPUTexture | null = null;
  info: GPUTexture | null = null;
  readonly format: GPUTextureFormat;
  tint = false;
  fadeSeconds = 0.4;
  /** (the report) draw B off: only the top sheets */
  sheetsOnly = false;
  /** (measurement) B without its rim morph */
  noMorphB = false;
  /** (diagnostics) B's floors, ceilings and walls in flat blue, green and red */
  diagB = false;

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
    const mk = (entryPoint: string, fs: string) =>
      device.createRenderPipeline({
        label: `nest draw ${entryPoint}`,
        layout: pl,
        vertex: { module, entryPoint },
        fragment: { module, entryPoint: fs, targets: [{ format: this.format }, { format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
    this.pipeA = mk('vs', 'fsA');
    this.pipeB = mk('vsB', 'fs');
    this.ubuf = device.createBuffer({ label: 'nest draw uniforms', size: DU * MAX_LEVELS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  private grids = new Map<number, GPUBuffer>();
  /** the top sheet's index buffer for an n x n grid of vertices (two triangles a quad, diagonal (i, j)-(i + 1, j + 1)) */
  private grid(n: number): GPUBuffer {
    let b = this.grids.get(n);
    if (b) return b;
    const idx = new Uint32Array(6 * (n - 1) * (n - 1));
    let o = 0;
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const v = j * n + i;
        idx.set([v, v + 1, v + n + 1, v, v + n + 1, v + n], o);
        o += 6;
      }
    b = this.device.createBuffer({ label: `nest grid ${n}`, size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(b, 0, idx);
    this.grids.set(n, b);
    return b;
  }

  private targets(w: number, h: number): void {
    if (this.depth && this.depth.width === w && this.depth.height === h) return;
    this.depth?.destroy();
    this.info?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.info = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }

  draw(levels: DrawLevel[]): GPUTexture {
    const tex = this.ctx.getCurrentTexture();
    this.targets(tex.width, tex.height);
    const segs = this.nest.segBuffers();
    const want = [this.nest.dir, ...segs];
    if (want.length !== this.bgFor.length || want.some((b, i) => b !== this.bgFor[i])) {
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
    this.uniforms(levels, this.nest.now());
    const enc = this.device.createCommandEncoder({ label: 'nest draw' });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.62, g: 0.71, b: 0.78, a: 1 } },
        { view: this.info!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      depthStencilAttachment: { view: this.depth!.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 },
    });
    // finest first: the depth test then spares the coarse levels' fragments under it
    for (const lv of [...levels].sort((a, b) => b.depth - a.depth)) {
      const n = this.nest.wins[lv.depth]!.n;
      pass.setBindGroup(0, this.bg!, [lv.depth * DU]);
      pass.setPipeline(this.pipeA);
      pass.setIndexBuffer(this.grid(n), 'uint32');
      pass.drawIndexed(6 * (n - 1) * (n - 1));
      if (!this.sheetsOnly) {
        pass.setPipeline(this.pipeB);
        pass.drawIndirect(this.nest.drawArgs, lv.depth * 16);
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return tex;
  }

  /** the per-level uniforms at time `now` (instB: the capture's instance count a level) */
  private uniforms(levels: DrawLevel[], now: number, instB: number[] = []): void {
    const st = new ArrayBuffer(DU * MAX_LEVELS);
    for (const lv of levels) {
      const w = this.nest.wins[lv.depth]!;
      const p = lv.depth > 0 ? this.nest.wins[lv.depth - 1]! : null;
      const i = new Int32Array(st, lv.depth * DU, 8);
      const f = new Float32Array(st, lv.depth * DU + 32, 16);
      i.set([w.gx, w.gy, w.n, lv.depth, p?.gx ?? 0, p?.gy ?? 0, p?.n ?? 0, p ? 1 : 0]);
      f.set(lv.cut ?? [1, 1, 0, 0], 0);
      f.set([now, this.fadeSeconds, this.tint ? 1 : 0, this.nest.k], 4);
      f.set(lv.want ?? [1, 1, 0, 0], 8);
      f.set([0.45, -0.35, 0.82, 0], 12);
      new Uint32Array(st, lv.depth * DU + 96, 4).set([this.nest.cap, this.noMorphB ? 1 : 0, this.diagB ? 1 : 0, instB[lv.depth] ?? 0]);
    }
    this.device.queue.writeBuffer(this.ubuf, 0, st);
  }

  private capPipes: { a: GPUComputePipeline; b: GPUComputePipeline; layout: GPUBindGroupLayout } | null = null;
  /** (the watertight check, test only: a readback) every vertex the draw places for each level at time `now`, local
   *  units: A's grid (n x n, w = bOwn) and B's items (18 a slot, w = 0 when not drawn) */
  async capture(levels: DrawLevel[], now: number): Promise<{ depth: number; n: number; a: Float32Array; b: Float32Array }[]> {
    if (!this.capPipes) {
      const layout = this.device.createBindGroupLayout({ label: 'nest capture', entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      const pl = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout, layout] });
      const mk = (entryPoint: string) => this.device.createComputePipeline({ label: `nest ${entryPoint}`, layout: pl, compute: { module: this.module, entryPoint } });
      this.capPipes = { a: mk('captureA'), b: mk('captureB'), layout };
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
    const inst = levels.map((lv) => args[lv.depth * 4 + 1]);
    this.draw(levels); // (the bind group current)
    const out = [];
    for (const lv of levels) {
      const n = this.nest.wins[lv.depth]!.n;
      const res = [];
      for (const [pipe, count] of [
        [this.capPipes.a, n * n],
        [this.capPipes.b, inst[lv.depth] * 18],
      ] as const) {
        const size = Math.max(16, count * 16);
        const buf = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const bg1 = this.device.createBindGroup({ layout: this.capPipes.layout, entries: [{ binding: 0, resource: { buffer: buf } }] });
        // (the uniforms again before each dispatch: a frame's draw may have rewritten them while we awaited)
        this.uniforms(levels, now, inst);
        const e = this.device.createCommandEncoder();
        const p = e.beginComputePass();
        p.setPipeline(pipe);
        p.setBindGroup(0, this.bg!, [lv.depth * DU]);
        p.setBindGroup(1, bg1);
        if (count > 0) p.dispatchWorkgroups(Math.ceil(count / 64));
        p.end();
        this.device.queue.submit([e.finish()]);
        res.push(new Float32Array(await read(buf, size)));
        buf.destroy();
      }
      out.push({ depth: lv.depth, n, a: res[0], b: res[1] });
    }
    return out;
  }
}
