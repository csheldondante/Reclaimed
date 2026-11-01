// The viewer's renderer: the ground, the pieces, a sun shadow map, lines for the overlays. Small on purpose (the
// viewer opens in a second on a phone); the light is close to the game's: sun, sky, warm bounce, fog.
import { StructureGpu } from '../gpu';
import structWgsl from '../../shaders/structmesh.wgsl?raw';
import viewerWgsl from './viewer.wgsl?raw';
import { type Mat4, mul, ortho, lookAt } from './mat';

const SHADOW = 2048;
const DEPTH: GPUTextureFormat = 'depth24plus';

export interface FrameView {
  viewProj: Mat4;
  eye: [number, number, number];
  /** toward the sun, the scene's middle and reach (for the shadow's box) */
  sun: [number, number, number];
  centre: [number, number, number];
  reach: number;
  night: number;
  sunCol: [number, number, number];
  skyCol: [number, number, number];
  fog: number;
  /** (round 120) seconds (flutter, flicker, turning wheels) and the wind's strength (0 calm .. 2 a gale) */
  time: number;
  wind: number;
}

export class ViewerRenderer {
  readonly sg: StructureGpu;
  private uni: GPUBuffer;
  private group!: GPUBindGroup;
  /** (the shadow pass's: the shadow map can't be bound while it's drawn into — a 1×1 stand-in at binding 2) */
  private shadowGroup!: GPUBindGroup;
  private dummyDepth: GPUTexture;
  private groupVersion = -1;
  private layout: GPUBindGroupLayout;
  private piecePipe: GPURenderPipeline;
  private pieceShadow: GPURenderPipeline;
  private groundPipe: GPURenderPipeline;
  private groundShadow: GPURenderPipeline;
  private linePipe: GPURenderPipeline;
  /** (round 120) the lights' pools: blended over the scene at night */
  private poolPipe: GPURenderPipeline;
  private shadowTex: GPUTexture;
  private sampler: GPUSampler;
  private depth?: GPUTexture;
  private msaaTex?: GPUTexture;
  private ground?: { buf: GPUBuffer; index: GPUBuffer; count: number };
  private lines?: { buf: GPUBuffer; count: number };
  showLines = false;
  /** draw the pieces' far look (STR10) */
  lod = false;
  /** (?gputime=1, the perf test) the GPU's time for the last frames' passes (ms), when timestamps are there */
  gpuMs: number[] = [];
  private ts?: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer[]; busy: boolean[]; frame: number };

  constructor(
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
    private format: GPUTextureFormat,
    readonly samples: number,
  ) {
    this.sg = new StructureGpu(device);
    if (device.features.has('timestamp-query')) {
      const read = [0, 1, 2].map(() => device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
      this.ts = { set: device.createQuerySet({ type: 'timestamp', count: 4 }), resolve: device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }), read, busy: [false, false, false], frame: 0 };
    }
    this.uni = device.createBuffer({ label: 'viewer view', size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.shadowTex = device.createTexture({ label: 'viewer shadow', size: [SHADOW, SHADOW], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.sampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.dummyDepth = device.createTexture({ label: 'viewer no shadow', size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'viewer',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    const module = device.createShaderModule({ label: 'viewer', code: this.sg.wgsl() + structWgsl + viewerWgsl });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const ms = { count: samples };
    const depthState: GPUDepthStencilState = { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' };
    const shadowState: GPUDepthStencilState = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 };
    const v4 = (): GPUVertexBufferLayout => ({ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] });
    this.piecePipe = device.createRenderPipeline({
      label: 'viewer pieces',
      layout: pl,
      vertex: { module, entryPoint: 'vsPiece', buffers: [StructureGpu.vertexLayout()] },
      fragment: { module, entryPoint: 'fsPiece', targets: [{ format }] },
      // (the modules are wound outward, counter-clockwise, and every frame is counter-clockwise: back faces culled —
      // ?cull=0 draws them, to look for a module wound the wrong way)
      primitive: { topology: 'triangle-list', cullMode: new URLSearchParams(location.search).get('cull') === '0' ? 'none' : 'back' },
      depthStencil: depthState,
      multisample: ms,
    });
    this.pieceShadow = device.createRenderPipeline({
      label: 'viewer pieces shadow',
      layout: pl,
      vertex: { module, entryPoint: 'vsPieceShadow', buffers: [StructureGpu.vertexLayout()] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: shadowState,
    });
    this.groundPipe = device.createRenderPipeline({
      label: 'viewer ground',
      layout: pl,
      vertex: { module, entryPoint: 'vsGround', buffers: [v4()] },
      fragment: { module, entryPoint: 'fsGround', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthState,
      multisample: ms,
    });
    this.groundShadow = device.createRenderPipeline({
      label: 'viewer ground shadow',
      layout: pl,
      vertex: { module, entryPoint: 'vsGroundShadow', buffers: [v4()] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: shadowState,
    });
    this.poolPipe = device.createRenderPipeline({
      label: 'viewer pools',
      layout: pl,
      vertex: { module, entryPoint: 'vsPool', buffers: [StructureGpu.vertexLayout()] },
      fragment: { module, entryPoint: 'fsPool', targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'less-equal' },
      multisample: ms,
    });
    this.linePipe = device.createRenderPipeline({
      label: 'viewer lines',
      layout: pl,
      vertex: { module, entryPoint: 'vsLine', buffers: [v4()] },
      fragment: { module, entryPoint: 'fsLine', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: 'less-equal' },
      multisample: ms,
    });
  }

  /** the ground: a grid of (x, y, z, tint) and its triangles */
  setGround(verts: Float32Array, index: Uint32Array): void {
    this.ground?.buf.destroy();
    this.ground?.index.destroy();
    const buf = this.device.createBuffer({ label: 'viewer ground', size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, verts);
    const index2 = this.device.createBuffer({ label: 'viewer ground index', size: index.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(index2, 0, index);
    this.ground = { buf, index: index2, count: index.length };
  }

  /** overlay lines: pairs of (x, y, z, colour) */
  setLines(verts: Float32Array): void {
    this.lines?.buf.destroy();
    if (!verts.length) {
      this.lines = undefined;
      return;
    }
    const buf = this.device.createBuffer({ label: 'viewer lines', size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, verts);
    this.lines = { buf, count: verts.length / 4 };
  }

  private bind(): GPUBindGroup {
    if (this.groupVersion !== this.sg.version) {
      const make = (depth: GPUTexture) =>
        this.device.createBindGroup({
          layout: this.layout,
          entries: [
            { binding: 0, resource: { buffer: this.uni } },
            { binding: 1, resource: { buffer: this.sg.data } },
            { binding: 2, resource: depth.createView() },
            { binding: 3, resource: this.sampler },
          ],
        });
      this.group = make(this.shadowTex);
      this.shadowGroup = make(this.dummyDepth);
      this.groupVersion = this.sg.version;
    }
    return this.group;
  }

  frame(v: FrameView, w: number, h: number): void {
    const dev = this.device;
    if (!this.depth || this.depth.width !== w || this.depth.height !== h) {
      this.depth?.destroy();
      this.msaaTex?.destroy();
      this.depth = dev.createTexture({ size: [w, h], format: DEPTH, sampleCount: this.samples, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.msaaTex = this.samples > 1 ? dev.createTexture({ size: [w, h], format: this.format, sampleCount: this.samples, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : undefined;
    }
    // the sun's box: an ortho view down the sun onto the scene's middle
    const R = v.reach;
    const s = v.sun;
    const c = v.centre;
    const lview = lookAt([c[0] + s[0] * R * 2, c[1] + s[1] * R * 2, c[2] + s[2] * R * 2], c, Math.abs(s[2]) > 0.98 ? [0, 1, 0] : [0, 0, 1]);
    const lproj = mul(ortho(-R, R, -R, R, 0.1, R * 4), lview);
    const u = new Float32Array(64);
    u.set(v.viewProj, 0);
    u.set(lproj, 16);
    u.set([s[0], s[1], s[2], v.night], 32);
    u.set([v.eye[0], v.eye[1], v.eye[2], v.fog], 36);
    u.set([...v.sunCol, 0], 40);
    u.set([...v.skyCol, 0], 44);
    u.set([1.2 / SHADOW, 0, v.time, v.wind], 48);
    dev.queue.writeBuffer(this.uni, 0, u);
    const group = this.bind();
    const enc = dev.createCommandEncoder();
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
        timestampWrites: this.ts ? { querySet: this.ts.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined,
      });
      pass.setBindGroup(0, this.shadowGroup);
      if (this.ground) {
        pass.setPipeline(this.groundShadow);
        pass.setVertexBuffer(0, this.ground.buf);
        pass.setIndexBuffer(this.ground.index, 'uint32');
        pass.drawIndexed(this.ground.count);
      }
      pass.setPipeline(this.pieceShadow);
      this.sg.draw(pass, true);
      pass.end();
    }
    {
      const sky = v.skyCol;
      const target = this.ctx.getCurrentTexture().createView();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.msaaTex ? this.msaaTex.createView() : target,
            resolveTarget: this.msaaTex ? target : undefined,
            clearValue: { r: Math.pow(sky[0] * 1.6, 1 / 2.2), g: Math.pow(sky[1] * 1.6, 1 / 2.2), b: Math.pow(sky[2] * 1.6, 1 / 2.2), a: 1 },
            loadOp: 'clear',
            storeOp: this.msaaTex ? 'discard' : 'store',
          },
        ],
        depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        timestampWrites: this.ts ? { querySet: this.ts.set, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } : undefined,
      });
      pass.setBindGroup(0, group);
      if (this.ground) {
        pass.setPipeline(this.groundPipe);
        pass.setVertexBuffer(0, this.ground.buf);
        pass.setIndexBuffer(this.ground.index, 'uint32');
        pass.drawIndexed(this.ground.count);
      }
      pass.setPipeline(this.piecePipe);
      this.sg.draw(pass, this.lod);
      if (v.night > 0.01) {
        pass.setPipeline(this.poolPipe);
        this.sg.drawGlow(pass);
      }
      if (this.showLines && this.lines) {
        pass.setPipeline(this.linePipe);
        pass.setVertexBuffer(0, this.lines.buf);
        pass.draw(this.lines.count);
      }
      pass.end();
    }
    const ts = this.ts;
    const slot = ts ? ts.frame++ % 3 : -1;
    const take = ts && !ts.busy[slot];
    if (ts && take) {
      enc.resolveQuerySet(ts.set, 0, 4, ts.resolve, 0);
      enc.copyBufferToBuffer(ts.resolve, 0, ts.read[slot], 0, 32);
    }
    dev.queue.submit([enc.finish()]);
    if (ts && take) {
      ts.busy[slot] = true;
      const buf = ts.read[slot];
      buf.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(buf.getMappedRange().slice(0));
        buf.unmap();
        ts.busy[slot] = false;
        const ms = (Number(t[1] - t[0]) + Number(t[3] - t[2])) / 1e6;
        if (ms > 0 && ms < 1000) {
          this.gpuMs.push(ms);
          if (this.gpuMs.length > 240) this.gpuMs.shift();
        }
      }, () => {});
    }
  }
}
