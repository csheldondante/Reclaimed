// The flora sprites' atlas and bake (round 128, `treegen`; ?flod=sprite; src/flora/sprites.ts says what a sprite is).
// Each sprite kind's source (the same variant's full mesh, already in the instanced renderer's buffers) is drawn into
// its cells — one a yaw step — on the GPU: once when the atlas is made and again when the season has moved on by a
// step (the look's leaves, blossom, snow are the season's). No readback. The draw (meshinst.wgsl fsSprite) reads the
// two textures by texel.
//
// Memory: SPR_CELL² × (4 + 4) bytes a cell (albedo + coverage; normal, depth, material), a cell a (kind, yaw):
// 11 tree kinds × 8 yaws × 64² × 8 B ≈ 2.9 MB, and the bake's depth (the atlas's size, 4 B a texel).

import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import floraLookWgsl from '../shaders/floralook.wgsl?raw';
import spriteWgsl from '../shaders/florasprite.wgsl?raw';
import { makeBindGroup, makeLayout, makeModule } from '../gpu/pipeline';
import type { FloraLibrary } from '../flora/library';
import { bakeView, SPR_CELL, SPR_COLS, SPR_YAWS } from '../flora/sprites';
import type { MeshInstances } from './meshinst';

/** the season moved on by this much: bake again */
const SEASON_STEP = 1 / 96;

export class FloraSprites {
  readonly albedo: GPUTexture;
  readonly nd: GPUTexture;
  private depth: GPUTexture;
  private pipe: GPURenderPipeline;
  private group: GPUBindGroup;
  private bakedAt = -1;
  readonly cells: number;
  readonly rows: number;
  readonly bytes: number;
  /** bakes done (the perf overlay, the bench) */
  bakes = 0;

  constructor(
    device: GPUDevice,
    private lib: FloraLibrary,
    private mi: MeshInstances,
    globals: GPUBuffer,
    materials: GPUBuffer,
    floraWgsl: string,
    /** a cell's side (texels; the tests bake bigger to look at the trees) */
    readonly cell = SPR_CELL,
  ) {
    this.cells = lib.sprites.length * SPR_YAWS;
    this.rows = Math.max(1, Math.ceil(this.cells / SPR_COLS));
    const size = [SPR_COLS * cell, this.rows * cell];
    // (COPY_SRC: the tests read the atlas back)
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.albedo = device.createTexture({ label: 'flora sprites albedo', size, format: 'rgba8unorm', usage });
    this.nd = device.createTexture({ label: 'flora sprites normal-depth', size, format: 'rgba8unorm', usage });
    this.depth = device.createTexture({ label: 'flora sprites bake depth', size, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.bytes = size[0] * size[1] * 12;
    // (the bakes' views: a sprite's cells in yaw order — the draw's cell = sprite × SPR_YAWS + yaw)
    const B = new Float32Array(Math.max(1, this.cells) * 12);
    for (const s of lib.sprites)
      for (let j = 0; j < SPR_YAWS; j++) {
        const i = s.idx * SPR_YAWS + j;
        const v = bakeView(j, SPR_YAWS);
        B.set([v.eye[0], v.eye[1], v.eye[2], i, s.b.R, s.b.v0, s.b.v1, s.b.d0, s.b.d1, SPR_COLS, this.rows, 0], i * 12);
      }
    const bakeBuf = device.createBuffer({ label: 'flora sprite bakes', size: B.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(bakeBuf, 0, B);
    const layout = makeLayout(device, 'flora-sprite-bake', { 0: 'uniform', 1: 'read', 2: 'uniform' }, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    const module = makeModule(device, 'flora-sprite-bake', [commonWgsl, materialsWgsl, floraWgsl, floraLookWgsl, spriteWgsl]);
    this.pipe = device.createRenderPipeline({
      label: 'flora-sprite-bake',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module,
        entryPoint: 'vsBake',
        buffers: [
          { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: { module, entryPoint: 'fsBake', targets: [{ format: 'rgba8unorm' }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.group = makeBindGroup(device, 'flora-sprite-bake', layout, { 0: globals, 1: bakeBuf, 2: materials });
  }

  /** Bake the atlas when it has never been, or the season has moved on a step since. */
  bake(enc: GPUCommandEncoder, season: number): void {
    if (!this.cells) return;
    if (this.bakedAt >= 0 && Math.abs(season - this.bakedAt) < SEASON_STEP) return;
    this.bakedAt = season;
    this.bakes++;
    const pass = enc.beginRenderPass({
      label: 'flora-sprite-bake',
      colorAttachments: [
        { view: this.albedo.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.nd.createView(), clearValue: { r: 0.5, g: 0.5, b: 1, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.group);
    pass.setVertexBuffer(0, this.mi.verts);
    pass.setVertexBuffer(1, this.mi.uvs);
    pass.setIndexBuffer(this.mi.index, 'uint32');
    for (const s of this.lib.sprites) {
      const r = this.mi.ranges[s.src];
      // (one draw a yaw: the instance index is the bake's — firstInstance)
      for (let j = 0; j < SPR_YAWS; j++) pass.drawIndexed(r.count, 1, r.first, r.base, s.idx * SPR_YAWS + j);
    }
    pass.end();
  }
}
