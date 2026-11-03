// The flora sprites' atlas and bake (round 128, `treegen`; ?flod=sprite; src/flora/sprites.ts says what a sprite is).
// The user: "For the trees is there any way we can render them higher poly and in more detail with better textures for
// the sprites? One render at higher resolution plus mips and they remain more readable and we get our LOD for free".
//
// So the bake's source is a bake-only mesh from the same parameters (generate's lod 'bake': 16-sided stems, every twig,
// the lobes cut twice — never drawn, so its triangles don't count at run time), baked into cells of SPR_CELL² (128 by
// default; ?fcell=64|128|256) with a full mip chain made by our own downsample (shaders/florasprite_mip.wgsl): albedo
// with a coverage-keeping alpha (a quarter of a texel's children covered keeps it: leaf cards don't thin away), colour
// averaged over the covered children, normals averaged and renormalised, the depth the nearest (not the average, so a
// silhouette doesn't shrink or float), the material the most covered child's. The draw (meshinst.wgsl fsSprite) picks
// the level by the sprite's size on screen — the sprite's LOD.
//
// Baked on the GPU when the atlas is made and again when the season has moved on a step. No readback.

import commonWgsl from '../shaders/common.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import floraLookWgsl from '../shaders/floralook.wgsl?raw';
import spriteWgsl from '../shaders/florasprite.wgsl?raw';
import mipWgsl from '../shaders/florasprite_mip.wgsl?raw';
import { makeBindGroup, makeLayout, makeModule } from '../gpu/pipeline';
import { leafAtlasTexture } from '../flora/leafatlas';
import { bakeView, SPR_CELL, SPR_COLS, SPR_YAWS, sprLevels, type spriteBounds } from '../flora/sprites';
import type { FloraMesh } from '../flora/mesh';

/** the season moved on by this much: bake again */
const SEASON_STEP = 1 / 96;

/** what a sprite is baked from: its library kind (the look's tables' row), the bake-only mesh, its bounds */
export interface SpriteSource {
  kind: number;
  mesh: FloraMesh;
  b: ReturnType<typeof spriteBounds>;
}

export class FloraSprites {
  readonly albedo: GPUTexture;
  readonly nd: GPUTexture;
  private depth: GPUTexture;
  private pipe: GPURenderPipeline;
  private group: GPUBindGroup;
  private mipPipe: GPURenderPipeline;
  private mipGroups: GPUBindGroup[] = [];
  private verts: GPUBuffer;
  private uvs: GPUBuffer;
  private index: GPUBuffer;
  private ranges: { first: number; count: number; base: number }[] = [];
  private bakedAt = -1;
  readonly cells: number;
  readonly rows: number;
  readonly levels: number;
  readonly bytes: number;
  /** the bake-only meshes' triangles (all sprites, one yaw) */
  readonly bakeTris: number;
  /** bakes done (the perf overlay, the bench) */
  bakes = 0;

  constructor(
    device: GPUDevice,
    private sources: SpriteSource[],
    globals: GPUBuffer,
    materials: GPUBuffer,
    floraWgsl: string,
    /** a cell's side (texels) */
    readonly cell = SPR_CELL,
  ) {
    this.cells = sources.length * SPR_YAWS;
    this.rows = Math.max(1, Math.ceil(this.cells / SPR_COLS));
    this.levels = sprLevels(cell);
    const size = [SPR_COLS * cell, this.rows * cell];
    // (COPY_SRC: the tests read the atlas back)
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.albedo = device.createTexture({ label: 'flora sprites albedo', size, format: 'rgba8unorm', usage, mipLevelCount: this.levels });
    this.nd = device.createTexture({ label: 'flora sprites normal-depth', size, format: 'rgba8unorm', usage, mipLevelCount: this.levels });
    this.depth = device.createTexture({ label: 'flora sprites bake depth', size, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    // (two rgba8 targets with their mips (× 4/3) and the bake's depth)
    this.bytes = Math.round(size[0] * size[1] * 8 * (4 / 3) + size[0] * size[1] * 4);
    // the bake-only meshes: one vertex buffer (the kind in w, + 16 × kind, as the instanced renderer's), uvs, indices
    let nv = 0;
    let ni = 0;
    for (const s of sources) {
      this.ranges.push({ first: ni, count: s.mesh.index.length, base: nv });
      nv += s.mesh.verts.length / 4;
      ni += s.mesh.index.length;
    }
    const V = new Float32Array(Math.max(4, nv * 4));
    const U = new Float32Array(Math.max(4, nv * 4));
    const I = new Uint32Array(Math.max(4, ni));
    sources.forEach((s, i) => {
      const r = this.ranges[i];
      V.set(s.mesh.verts, r.base * 4);
      for (let j = r.base * 4 + 3; j < (r.base + s.mesh.verts.length / 4) * 4; j += 4) V[j] += 16 * s.kind;
      U.set(s.mesh.uv, r.base * 4);
      I.set(s.mesh.index, r.first);
    });
    this.bakeTris = ni / 3;
    this.verts = device.createBuffer({ label: 'flora sprite bake verts', size: V.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.verts, 0, V);
    this.uvs = device.createBuffer({ label: 'flora sprite bake uvs', size: U.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.uvs, 0, U);
    this.index = device.createBuffer({ label: 'flora sprite bake index', size: I.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.index, 0, I);
    // (the bakes' views: a sprite's cells in yaw order — the draw's cell = sprite × SPR_YAWS + yaw)
    const B = new Float32Array(Math.max(1, this.cells) * 12);
    sources.forEach((s, si) => {
      for (let j = 0; j < SPR_YAWS; j++) {
        const i = si * SPR_YAWS + j;
        const v = bakeView(j, SPR_YAWS);
        B.set([v.eye[0], v.eye[1], v.eye[2], i, s.b.R, s.b.v0, s.b.v1, s.b.d0, s.b.d1, SPR_COLS, this.rows, 0], i * 12);
      }
    });
    const bakeBuf = device.createBuffer({ label: 'flora sprite bakes', size: B.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(bakeBuf, 0, B);
    const layout = makeLayout(device, 'flora-sprite-bake', { 0: 'uniform', 1: 'read', 2: 'uniform', 66: 'tex' }, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    const module = makeModule(device, 'flora-sprite-bake', [commonWgsl, materialsWgsl, floraWgsl, floraLookWgsl, spriteWgsl]);
    this.pipe = device.createRenderPipeline({
      label: 'flora-sprite-bake',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module,
        entryPoint: 'vsBake',
        buffers: [
          { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
          { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: { module, entryPoint: 'fsBake', targets: [{ format: 'rgba8unorm' }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    // (round 128: the leaf-cluster atlas, as the instanced draw's)
    this.group = makeBindGroup(device, 'flora-sprite-bake', layout, { 0: globals, 1: bakeBuf, 2: materials, 66: leafAtlasTexture(device).createView() });
    // the mips: each level from the one above (its two textures as single-level views)
    const mipLayout = makeLayout(device, 'flora-sprite-mip', { 0: 'tex', 1: 'tex' }, GPUShaderStage.FRAGMENT);
    const mipModule = makeModule(device, 'flora-sprite-mip', [mipWgsl]);
    this.mipPipe = device.createRenderPipeline({
      label: 'flora-sprite-mip',
      layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
      vertex: { module: mipModule, entryPoint: 'vsFull' },
      fragment: { module: mipModule, entryPoint: 'fsMip', targets: [{ format: 'rgba8unorm' }, { format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    for (let l = 1; l < this.levels; l++) {
      this.mipGroups.push(
        makeBindGroup(device, `flora-sprite-mip-${l}`, mipLayout, {
          0: this.albedo.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }),
          1: this.nd.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }),
        }),
      );
    }
  }

  /** Bake the atlas when it has never been, or the season has moved on a step since; then its mips. */
  bake(enc: GPUCommandEncoder, season: number): void {
    if (!this.cells) return;
    if (this.bakedAt >= 0 && Math.abs(season - this.bakedAt) < SEASON_STEP) return;
    this.bakedAt = season;
    this.bakes++;
    const pass = enc.beginRenderPass({
      label: 'flora-sprite-bake',
      colorAttachments: [
        { view: this.albedo.createView({ baseMipLevel: 0, mipLevelCount: 1 }), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.nd.createView({ baseMipLevel: 0, mipLevelCount: 1 }), clearValue: { r: 0.5, g: 0.5, b: 1, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.group);
    pass.setVertexBuffer(0, this.verts);
    pass.setVertexBuffer(1, this.uvs);
    pass.setIndexBuffer(this.index, 'uint32');
    this.sources.forEach((_, si) => {
      const r = this.ranges[si];
      // (one draw a yaw: the instance index is the bake's — firstInstance)
      for (let j = 0; j < SPR_YAWS; j++) pass.drawIndexed(r.count, 1, r.first, r.base, si * SPR_YAWS + j);
    });
    pass.end();
    for (let l = 1; l < this.levels; l++) {
      const m = enc.beginRenderPass({
        label: `flora-sprite-mip-${l}`,
        colorAttachments: [
          { view: this.albedo.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' },
          { view: this.nd.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: 'clear', clearValue: { r: 0.5, g: 0.5, b: 1, a: 0 }, storeOp: 'store' },
        ],
      });
      m.setPipeline(this.mipPipe);
      m.setBindGroup(0, this.mipGroups[l - 1]);
      m.draw(3);
      m.end();
    }
  }
}
