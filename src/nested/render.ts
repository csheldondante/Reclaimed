// Nested scales lab: the draw. Each live level is drawn as one grid whose vertex shader pulls its columns from the pages
// (gpu/draw.wgsl); finest first, composed by depth (reverse Z, each level with its own view-projection in its own
// units from the camera pass). A second target carries per-pixel info for the measurements (surface drawn, level, not
// yet sharp).
import storeWgsl from './gpu/store.wgsl?raw';
import drawWgsl from './gpu/draw.wgsl?raw';
import { MAX_LEVELS, TCAP, type GpuNest } from './gpu/nest';

const DU = 256;

export interface DrawLevel {
  depth: number;
  /** the child's footprint in this level's local units (none: null), and where the focus wants it (metrics) */
  cut: [number, number, number, number] | null;
  want: [number, number, number, number] | null;
}

export class Renderer {
  private pipe: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private ubuf: GPUBuffer;
  private bg: GPUBindGroup | null = null;
  private bgFor: GPUBuffer | null = null;
  private index = new Map<number, { buf: GPUBuffer; count: number }>();
  private depth: GPUTexture | null = null;
  info: GPUTexture | null = null;
  readonly format: GPUTextureFormat;
  tint = false;
  fadeSeconds = 0.4;

  constructor(
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
    private nest: GpuNest,
  ) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'nest draw',
      entries: [
        { binding: 0, visibility: vf, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const module = device.createShaderModule({ label: 'nest draw', code: `const TCAP: u32 = ${TCAP}u;\n${storeWgsl}\n${drawWgsl}` });
    this.pipe = device.createRenderPipeline({
      label: 'nest draw',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    this.ubuf = device.createBuffer({ label: 'nest draw uniforms', size: DU * MAX_LEVELS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private indexFor(n: number): { buf: GPUBuffer; count: number } {
    let e = this.index.get(n);
    if (!e) {
      const q = new Uint32Array((n - 1) * (n - 1) * 6);
      let o = 0;
      for (let j = 0; j < n - 1; j++)
        for (let i = 0; i < n - 1; i++) {
          const a = j * n + i;
          // the diagonal from (i, j) to (i + 1, j + 1): the child's rim blend evaluates the same triangles
          q.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], o);
          o += 6;
        }
      const buf = this.device.createBuffer({ label: `nest grid ${n}`, size: q.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buf, 0, q);
      e = { buf, count: q.length };
      this.index.set(n, e);
    }
    return e;
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
          { binding: 0, resource: { buffer: this.ubuf, size: 96 } },
          { binding: 1, resource: { buffer: this.nest.tab } },
          { binding: 2, resource: { buffer: this.nest.pg } },
          { binding: 3, resource: { buffer: this.nest.cam } },
          { binding: 4, resource: { buffer: this.nest.reg } },
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
    }
    this.device.queue.writeBuffer(this.ubuf, 0, st);
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
      const w = this.nest.wins[lv.depth]!;
      const ix = this.indexFor(w.n);
      pass.setBindGroup(0, this.bg!, [lv.depth * DU]);
      pass.setIndexBuffer(ix.buf, 'uint32');
      pass.drawIndexed(ix.count);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}
