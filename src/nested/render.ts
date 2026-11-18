// Nested scales lab: the draw (gpu/draw.wgsl). Every level draws the boundary of solid against air from its pages:
// A, the top sheet (one quad, six vertices, pulled from the columns); B, everything else (tunnel floors and ceilings,
// overhang undersides, the walls where an air region ends between columns) for the quads a GPU scan lists, as an
// indirect draw. Finest first, composed by depth (reverse Z, each level's view-projection in its own units). A second
// target carries per-pixel info for the measurements (surface drawn, level, not yet sharp).
import storeWgsl from './gpu/store.wgsl?raw';
import drawWgsl from './gpu/draw.wgsl?raw';
import { MAX_LEVELS, TCAP, type GpuNest } from './gpu/nest';

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
  private scanP: GPUComputePipeline;
  private finishP: GPUComputePipeline;
  private layout: GPUBindGroupLayout;
  private clayout: GPUBindGroupLayout;
  private ubuf: GPUBuffer;
  private qlist: GPUBuffer;
  private dinfo: GPUBuffer;
  private dargs: GPUBuffer;
  private qPer: number;
  private bg: GPUBindGroup | null = null;
  private cbg: GPUBindGroup | null = null;
  private bgFor: GPUBuffer | null = null;
  private depth: GPUTexture | null = null;
  info: GPUTexture | null = null;
  readonly format: GPUTextureFormat;
  tint = false;
  fadeSeconds = 0.4;
  /** (the report) draw B off: only the top sheets, as before this round */
  sheetsOnly = false;

  constructor(
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
    private nest: GpuNest,
    maxN: number,
  ) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const V = GPUShaderStage.VERTEX;
    const ro = { type: 'read-only-storage' as const };
    this.layout = device.createBindGroupLayout({
      label: 'nest draw',
      entries: [
        { binding: 0, visibility: V | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DU_SIZE } },
        ...[1, 2, 3, 4, 5, 6].map((binding) => ({ binding, visibility: V, buffer: ro })),
      ],
    });
    const C = GPUShaderStage.COMPUTE;
    this.clayout = device.createBindGroupLayout({
      label: 'nest draw scan',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DU_SIZE } },
        { binding: 1, visibility: C, buffer: ro },
        { binding: 2, visibility: C, buffer: ro },
        ...[7, 8, 9].map((binding) => ({ binding, visibility: C, buffer: { type: 'storage' as const } })),
      ],
    });
    const module = device.createShaderModule({ label: 'nest draw', code: `const TCAP: u32 = ${TCAP}u;\n${storeWgsl}\n${drawWgsl}` });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const mk = (entryPoint: string) =>
      device.createRenderPipeline({
        label: `nest draw ${entryPoint}`,
        layout: pl,
        vertex: { module, entryPoint },
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }, { format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      });
    this.pipeA = mk('vs');
    this.pipeB = mk('vsB');
    const cpl = device.createPipelineLayout({ bindGroupLayouts: [this.clayout] });
    this.scanP = device.createComputePipeline({ label: 'nest draw scan', layout: cpl, compute: { module, entryPoint: 'scan' } });
    this.finishP = device.createComputePipeline({ label: 'nest draw finish', layout: cpl, compute: { module, entryPoint: 'finish' } });
    this.ubuf = device.createBuffer({ label: 'nest draw uniforms', size: DU * MAX_LEVELS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // the quad list: one slot a quad of each level's window (its size, not a cap on what is drawn)
    this.qPer = (maxN - 1) * (maxN - 1);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.qlist = device.createBuffer({ label: 'nest draw quads', size: this.qPer * MAX_LEVELS * 4, usage: S });
    this.dinfo = device.createBuffer({ label: 'nest draw info', size: MAX_LEVELS * 16, usage: S });
    this.dargs = device.createBuffer({ label: 'nest draw args', size: MAX_LEVELS * 16, usage: S | GPUBufferUsage.INDIRECT });
  }

  private targets(w: number, h: number): void {
    if (this.depth && this.depth.width === w && this.depth.height === h) return;
    this.depth?.destroy();
    this.info?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.info = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  }

  draw(levels: DrawLevel[]): void {
    const tex = this.ctx.getCurrentTexture();
    this.targets(tex.width, tex.height);
    if (this.bgFor !== this.nest.pg) {
      this.bg = this.device.createBindGroup({
        label: 'nest draw',
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.ubuf, size: DU_SIZE } },
          { binding: 1, resource: { buffer: this.nest.tab } },
          { binding: 2, resource: { buffer: this.nest.pg } },
          { binding: 3, resource: { buffer: this.nest.cam } },
          { binding: 4, resource: { buffer: this.nest.reg } },
          { binding: 5, resource: { buffer: this.qlist } },
          { binding: 6, resource: { buffer: this.dinfo } },
        ],
      });
      this.cbg = this.device.createBindGroup({
        label: 'nest draw scan',
        layout: this.clayout,
        entries: [
          { binding: 0, resource: { buffer: this.ubuf, size: DU_SIZE } },
          { binding: 1, resource: { buffer: this.nest.tab } },
          { binding: 2, resource: { buffer: this.nest.pg } },
          { binding: 7, resource: { buffer: this.qlist } },
          { binding: 8, resource: { buffer: this.dinfo } },
          { binding: 9, resource: { buffer: this.dargs } },
        ],
      });
      this.bgFor = this.nest.pg;
    }
    const st = new ArrayBuffer(DU * MAX_LEVELS);
    const now = this.nest.now();
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
      new Uint32Array(st, lv.depth * DU + 96, 4).set([lv.depth * this.qPer, 0, 0, 0]);
    }
    this.device.queue.writeBuffer(this.ubuf, 0, st);
    this.device.queue.writeBuffer(this.dinfo, 0, new Uint32Array(MAX_LEVELS * 4));
    const enc = this.device.createCommandEncoder({ label: 'nest draw' });
    const cp = enc.beginComputePass({ label: 'nest draw scan' });
    for (const lv of levels) {
      const n = this.nest.wins[lv.depth]!.n;
      cp.setBindGroup(0, this.cbg!, [lv.depth * DU]);
      cp.setPipeline(this.scanP);
      cp.dispatchWorkgroups(Math.ceil(((n - 1) * (n - 1)) / 64));
      cp.setPipeline(this.finishP);
      cp.dispatchWorkgroups(1);
    }
    cp.end();
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
      pass.draw(6 * (n - 1) * (n - 1));
      if (!this.sheetsOnly) {
        pass.setPipeline(this.pipeB);
        pass.drawIndirect(this.dargs, lv.depth * 16);
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}
