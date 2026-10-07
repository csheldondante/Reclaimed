// Renderer: render-preparation compute pass (world → box instances) followed
// by one render pass (opaque boxes, translucent water, rain streaks).
// Renders directly from the canonical representation; no meshing/LOD yet
// (design doc §14: one straightforward path until profiling says otherwise).

import { ignoreTeardown, makeBindGroup, makeCompute, makeLayout, makeModule, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import renderprepWgsl from '../shaders/renderprep.wgsl?raw';
import vegplanWgsl from '../shaders/vegplan.wgsl?raw';
import vegprepWgsl from '../shaders/vegprep.wgsl?raw';
import renderWgsl from '../shaders/render.wgsl?raw';
import rainWgsl from '../shaders/rain.wgsl?raw';
import particlesDrawWgsl from '../shaders/particles_draw.wgsl?raw';
import type { WorldGpu } from '../sim/world-gpu';
import { CAMERA_BYTES, type Camera } from './camera';

const VERTS_PER_BOX = 18;
/** Extra instances a column may emit beyond its slots (shrub/trunk+crown, tufts, flower). */
const VEG_INSTANCES = 6;
const PICK_FORMAT: GPUTextureFormat = 'rg32uint';

/** What the pick target says is under a pixel. */
export interface PickHit {
  cell: number;
  mat: number;
  z: number;
  /** instance flags (2 = vegetation, …) */
  flags: number;
}
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

export interface RenderOptions {
  rainParticles: number;
  /** sRGB background */
  clear: [number, number, number];
}

export class Renderer {
  private prep: ComputeKernel;
  private prepGroup: GPUBindGroup;
  private vegPrep: ComputeKernel;
  private vegPrepGroup: GPUBindGroup;
  private opaquePipe: GPURenderPipeline;
  private waterPipe: GPURenderPipeline;
  private rainPipe: GPURenderPipeline;
  private partPipe: GPURenderPipeline;
  private partGroup: GPUBindGroup;
  private opaqueGroup: GPUBindGroup;
  private waterGroup: GPUBindGroup;
  private rainGroup: GPUBindGroup;
  readonly instOpaque: GPUBuffer;
  readonly instWater: GPUBuffer;
  readonly indirect: GPUBuffer;
  private camBuf: GPUBuffer;
  private camData = new ArrayBuffer(CAMERA_BYTES);
  private depth?: GPUTexture;
  private pickTex?: GPUTexture;
  private pickBuf: GPUBuffer;
  private pickBusy = false;
  private pickRequest?: { x: number; y: number; resolve: (hit: PickHit | null) => void };
  private pickPending?: (hit: PickHit | null) => void;
  readonly opaqueCapacity: number;
  /** Last-known instance counts (async readback, for the perf overlay). */
  instanceCounts = { opaque: 0, water: 0 };
  private countBuf: GPUBuffer;
  private countBusy = false;
  private countNeeded = false;

  constructor(
    private device: GPUDevice,
    format: GPUTextureFormat,
    private world: WorldGpu,
    private profiler: Profiler,
  ) {
    const N = world.cells;
    this.opaqueCapacity = N * (world.maxK + VEG_INSTANCES);
    this.instOpaque = world.buf('instOpaque', this.opaqueCapacity * 16, GPUBufferUsage.STORAGE);
    // up to two liquid boxes per column (water + oil)
    this.instWater = world.buf('instWater', N * 2 * 16, GPUBufferUsage.STORAGE);
    this.indirect = world.buf(
      'indirect',
      32,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.camBuf = world.buf('camera', CAMERA_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.pickBuf = world.buf('pick', 256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.countBuf = world.buf('counts', 32, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    this.prep = makeCompute(device, 'renderprep', [commonWgsl, layersWgsl, materialsWgsl, renderprepWgsl], {
      0: 'uniform',
      1: 'read',
      2: 'uniform',
      3: 'read',
      4: 'read',
      5: 'read',
      6: 'read',
      7: 'rw',
      8: 'rw',
      9: 'rw',
    });
    this.prepGroup = makeBindGroup(device, 'renderprep', this.prep.layout, {
      0: world.globals,
      1: world.chunks,
      2: world.materials,
      3: world.layers,
      4: world.surface,
      5: world.water,
      6: world.oil,
      7: this.instOpaque,
      8: this.instWater,
      9: this.indirect,
    });

    this.vegPrep = makeCompute(device, 'vegprep', [commonWgsl, materialsWgsl, vegplanWgsl, vegprepWgsl], {
      0: 'uniform',
      2: 'uniform',
      3: 'read',
      4: 'read',
      5: 'rw',
      6: 'rw',
    });
    this.vegPrepGroup = makeBindGroup(device, 'vegprep', this.vegPrep.layout, {
      0: world.globals,
      2: world.materials,
      3: world.surface,
      4: world.veg,
      5: this.instOpaque,
      6: this.indirect,
    });

    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const drawLayout = makeLayout(
      device,
      'draw',
      {
        0: 'uniform',
        2: 'uniform',
        3: 'read',
        4: 'read',
        6: 'read',
        7: 'read',
        8: 'read',
        10: 'uniform',
        11: 'read',
      },
      VF,
    );
    const drawModule = makeModule(device, 'render', [commonWgsl, materialsWgsl, renderWgsl]);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [drawLayout] });
    const depthStencil = (write: boolean): GPUDepthStencilState => ({
      format: DEPTH_FORMAT,
      depthWriteEnabled: write,
      depthCompare: 'less',
    });
    const blend: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    this.opaquePipe = device.createRenderPipeline({
      label: 'opaque',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsBox' },
      fragment: { module: drawModule, entryPoint: 'fsBox', targets: [{ format }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(true),
    });
    this.waterPipe = device.createRenderPipeline({
      label: 'water',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsWater' },
      fragment: { module: drawModule, entryPoint: 'fsWater', targets: [{ format, blend }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(false),
    });

    const groupFor = (inst: GPUBuffer) =>
      makeBindGroup(device, 'draw', drawLayout, {
        0: world.globals,
        2: world.materials,
        3: inst,
        4: world.contam,
        6: world.veg,
        7: world.renderFields,
        8: world.water,
        10: this.camBuf,
        11: world.surface,
      });
    this.opaqueGroup = groupFor(this.instOpaque);
    this.waterGroup = groupFor(this.instWater);

    const rainLayout = makeLayout(device, 'rain', { 0: 'uniform', 10: 'uniform' }, VF);
    const rainModule = makeModule(device, 'rain', [commonWgsl, rainWgsl]);
    this.rainPipe = device.createRenderPipeline({
      label: 'rain',
      layout: device.createPipelineLayout({ bindGroupLayouts: [rainLayout] }),
      vertex: { module: rainModule, entryPoint: 'vsRain' },
      fragment: {
        module: rainModule,
        entryPoint: 'fsRain',
        targets: [{ format, blend }, { format: PICK_FORMAT, writeMask: 0 }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthStencil(false),
    });
    this.rainGroup = makeBindGroup(device, 'rain', rainLayout, { 0: world.globals, 10: this.camBuf });

    const partLayout = makeLayout(device, 'particles-draw', { 0: 'uniform', 3: 'read', 10: 'uniform' }, VF);
    const partModule = makeModule(device, 'particles-draw', [commonWgsl, particlesDrawWgsl]);
    this.partPipe = device.createRenderPipeline({
      label: 'particles',
      layout: device.createPipelineLayout({ bindGroupLayouts: [partLayout] }),
      vertex: { module: partModule, entryPoint: 'vs' },
      fragment: { module: partModule, entryPoint: 'fs', targets: [{ format, blend }, { format: PICK_FORMAT, writeMask: 0 }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthStencil(false),
    });
    this.partGroup = makeBindGroup(device, 'particles-draw', partLayout, { 0: world.globals, 3: world.particles, 10: this.camBuf });
  }

  /** Textures are the renderer's own; buffers belong to the world (world.destroy()). */
  destroy(): void {
    this.depth?.destroy();
    this.pickTex?.destroy();
  }

  resize(w: number, h: number): void {
    this.depth?.destroy();
    this.pickTex?.destroy();
    this.depth = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.pickTex = this.device.createTexture({
      size: [w, h],
      format: PICK_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.profiler.trackMemory('depth', w * h * 4);
    this.profiler.trackMemory('pickTex', w * h * 8);
  }

  /** Request the world column under a render-target pixel; resolves after the next frame. */
  pick(x: number, y: number): Promise<PickHit | null> {
    return new Promise((resolve) => {
      this.pickRequest?.resolve(null);
      this.pickRequest = { x, y, resolve };
    });
  }

  encode(enc: GPUCommandEncoder, target: GPUTextureView, cam: Camera, opts: RenderOptions): void {
    cam.write(this.camData);
    this.device.queue.writeBuffer(this.camBuf, 0, this.camData);
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([VERTS_PER_BOX, 0, 0, 0, VERTS_PER_BOX, 0, 0, 0]));

    {
      const pass = enc.beginComputePass({ label: 'renderprep', timestampWrites: this.profiler.timestamps('renderprep') });
      pass.setPipeline(this.prep.pipeline);
      pass.setBindGroup(0, this.prepGroup);
      const [gx, gy] = this.world.groups;
      pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.vegPrep.pipeline);
      pass.setBindGroup(0, this.vegPrepGroup);
      pass.dispatchWorkgroups(gx, gy);
      pass.end();
      this.profiler.dispatches += 2;
    }

    const pass = enc.beginRenderPass({
      label: 'world',
      colorAttachments: [
        { view: target, clearValue: { r: opts.clear[0], g: opts.clear[1], b: opts.clear[2], a: 1 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.pickTex!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: this.depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: this.profiler.timestamps('draw'),
    });
    pass.setPipeline(this.opaquePipe);
    pass.setBindGroup(0, this.opaqueGroup);
    pass.drawIndirect(this.indirect, 0);
    pass.setPipeline(this.waterPipe);
    pass.setBindGroup(0, this.waterGroup);
    pass.drawIndirect(this.indirect, 16);
    pass.setPipeline(this.partPipe);
    pass.setBindGroup(0, this.partGroup);
    pass.draw(6, this.world.particleCap);
    this.profiler.draws++;
    if (opts.rainParticles > 0) {
      pass.setPipeline(this.rainPipe);
      pass.setBindGroup(0, this.rainGroup);
      pass.draw(6, opts.rainParticles);
      this.profiler.draws++;
    }
    pass.end();
    this.profiler.draws += 2;

    if (this.pickRequest && !this.pickBusy) {
      const { x, y, resolve } = this.pickRequest;
      this.pickRequest = undefined;
      const tex = this.pickTex!;
      if (x >= 0 && y >= 0 && x < tex.width && y < tex.height) {
        enc.copyTextureToBuffer({ texture: tex, origin: [Math.floor(x), Math.floor(y)] }, { buffer: this.pickBuf, bytesPerRow: 256 }, [1, 1]);
        this.pickBusy = true;
        this.pickPending = resolve;
      } else resolve(null);
    }
    if (!this.countBusy) {
      enc.copyBufferToBuffer(this.indirect, 0, this.countBuf, 0, 32);
      this.countBusy = true;
      this.countNeeded = true;
    }
  }

  /** Call after submit to start async readbacks requested during encode. */
  afterSubmit(): void {
    if (this.pickPending) {
      const resolve = this.pickPending;
      this.pickPending = undefined;
      this.pickBuf.mapAsync(GPUMapMode.READ, 0, 8).then(() => {
        const [v, info] = new Uint32Array(this.pickBuf.getMappedRange(0, 8));
        this.pickBuf.unmap();
        this.pickBusy = false;
        resolve(v === 0 ? null : { cell: v - 1, mat: info & 0xff, z: (info >> 8) & 0xff, flags: info >>> 16 });
      }, ignoreTeardown);
    }
    if (this.countNeeded) {
      this.countNeeded = false;
      this.countBuf.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(this.countBuf.getMappedRange());
        this.instanceCounts = { opaque: u[1], water: u[5] };
        this.countBuf.unmap();
        // throttle: allow another readback in a little while
        setTimeout(() => (this.countBusy = false), 250);
      }, ignoreTeardown);
    }
  }
}
