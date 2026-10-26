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
import terrainShapeWgsl from '../shaders/terrainshape.wgsl?raw';
import vegprepWgsl from '../shaders/vegprep.wgsl?raw';
import renderWgsl from '../shaders/render.wgsl?raw';
import rainWgsl from '../shaders/rain.wgsl?raw';
import particlesDrawWgsl from '../shaders/particles_draw.wgsl?raw';
import gridsWgsl from '../shaders/grids.wgsl?raw';
import structPrepWgsl from '../shaders/structprep.wgsl?raw';
import meshRegionWgsl from '../shaders/meshregion.wgsl?raw';
import meshDrawWgsl from '../shaders/meshdraw.wgsl?raw';
import { FieldMesh, READBACK } from './fieldmesh';
import { POOL_VOXELS } from '../grids/structures';
import type { WorldGpu } from '../sim/world-gpu';
import { CAMERA_BYTES, type Camera } from './camera';
import { OutsideBand } from './band';

/** the draw shaders' camera (render.wgsl Camera): the view's, then the sun's shadow matrix */
const CAM_BYTES = CAMERA_BYTES + 64 + 16;
/** the sun's shadow map, texels a side (the whole map: ~0.15 cells a texel on 256²) */
const SHADOW_SIZE = 2048;
const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';

// a hex prism: the top in four triangles + three sides (render.wgsl)
const VERTS_PER_PRISM = 30;
// a plant box: the top + two sides
const VERTS_PER_BOX = 18;
// a prism whose sides are all hidden: its top alone (the prism's first 12)
const VERTS_PER_TOP = 12;
/** Extra instances a column may emit beyond its slots (shrub/trunk+crown, tufts, flower). */
// per cell worst case: plan (tree 2 + tufts 3 + flower 1) + a planting (6) + drift (1)
const VEG_INSTANCES = 13;
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
  /** toward the sun (world, unit) */
  sun: [number, number, number];
}

// (perf branch: ?skip=render (round 82: world-core.ts — nothing drawn),opaque,tops,plants,prisms,mesh,bodies,structs,voxels,skins,water,particles,rain,shadow,prep,meshprep
// leaves that piece out of the frame, to measure what it costs: scripts/perfprofile.mjs)
export const SKIP = new Set((new URLSearchParams(location.search).get('skip') ?? '').split(',').filter(Boolean));

export class Renderer {
  /** (round 82) the pieces left out, changed at run time by scripts/drawbench.mjs */
  static readonly skip = SKIP;
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
  private plantGroup: GPUBindGroup;
  private topsGroup: GPUBindGroup;
  /** First instance of the tops list in instOpaque. */
  private topsBase: number;
  private waterGroup: GPUBindGroup;
  /** rigid bodies (F7): rotated voxels, 2 × vec4<u32> each (render.wgsl vsBody) */
  private bodyBuf: GPUBuffer;
  private bodyGroup: GPUBindGroup;
  private bodyPipe: GPURenderPipeline;
  /** meshes over physics bodies (render.wgsl vsSkin) */
  private skinPipe: GPURenderPipeline;
  private shadowSkinPipe?: GPURenderPipeline;
  private meshSources: { indirect: GPUBuffer; group: GPUBindGroup; shadow?: GPUBindGroup }[] = [];
  /** the structure grids' exposed voxels, as rotated cubes (structprep.wgsl → the body pipeline) */
  private structPrep: ComputeKernel;
  private structPrepGroup: GPUBindGroup;
  private structInst: GPUBuffer;
  private structIndirect: GPUBuffer;
  private structGroup: GPUBindGroup;
  /** the field mesh (G13 h: ?mesh=1) */
  readonly fieldMesh: FieldMesh;
  private meshPipe?: GPURenderPipeline;
  /** further opaque draws in the world pass, with the sky's colour (round 73: the atlas's far land) */
  readonly extraDraws: ((pass: GPURenderPassEncoder, clear: [number, number, number]) => void)[] = [];
  /** what an extra draw renders into, and the camera it reads (render.wgsl Camera) */
  get targets(): { format: GPUTextureFormat; pickFormat: GPUTextureFormat; depthFormat: GPUTextureFormat; camera: GPUBuffer } {
    return { format: this.colorFormat, pickFormat: PICK_FORMAT, depthFormat: DEPTH_FORMAT, camera: this.camBuf };
  }
  private meshGroup?: GPUBindGroup;
  /** the band outside the window (round 79, enableBand): its draw group */
  band?: OutsideBand;
  private bandGroup?: GPUBindGroup;
  private meshGroupOf?: (cam: GPUBuffer, shadow: GPUTextureView, src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }) => GPUBindGroup;
  private bodyCount = 0;
  static readonly MAX_BODY_VOXELS = 16384;
  private rainGroup: GPUBindGroup;
  readonly instOpaque: GPUBuffer;
  readonly instPlant: GPUBuffer;
  readonly instWater: GPUBuffer;
  readonly indirect: GPUBuffer;
  private camBuf: GPUBuffer;
  private camData = new ArrayBuffer(CAM_BYTES);
  /** the sun's view for the shadow pass (the same layout: its viewProj is the light's) */
  private lightCamBuf: GPUBuffer;
  private lightCamData = new ArrayBuffer(CAM_BYTES);
  private shadowTex: GPUTexture;
  private shadowView: GPUTextureView;
  private shadowSampler: GPUSampler;
  private shadowOpaquePipe?: GPURenderPipeline;
  private shadowBodyPipe?: GPURenderPipeline;
  private shadowMeshPipe?: GPURenderPipeline;
  /** more voxel instances drawn like the structures' (physics bodies): instances, indirect args, and their draw and shadow groups */
  private voxelSources: { indirect: GPUBuffer; group: GPUBindGroup; shadow?: GPUBindGroup }[] = [];
  /** more prisms for the opaque pipeline (lava: sim/lava.ts) */
  private prismSources: { indirect: GPUBuffer; group: GPUBindGroup }[] = [];
  private noShadowView?: GPUTextureView;
  private groupFor!: (inst: GPUBuffer, cam?: GPUBuffer, shadow?: GPUTextureView) => GPUBindGroup;
  private shadowGroups?: { opaque: GPUBindGroup; tops: GPUBindGroup; plants: GPUBindGroup; struct: GPUBindGroup; bodies: GPUBindGroup; mesh: GPUBindGroup };
  /** ?smooth=0: tops lit flat, a hexagon at a time (the look before G13). */
  private flatTops = new URLSearchParams(location.search).get('smooth') === '0';
  private depth?: GPUTexture;
  private pickTex?: GPUTexture;
  private pickBuf: GPUBuffer;
  private pickBusy = false;
  private pickRequest?: { x: number; y: number; resolve: (hit: PickHit | null) => void };
  private pickPending?: (hit: PickHit | null) => void;
  readonly opaqueCapacity: number;
  /** Last-known instance counts (async readback, for the perf overlay). */
  instanceCounts = { opaque: 0, water: 0, tops: 0, prisms: 0, plants: 0 };
  private countBuf: GPUBuffer;
  private countBusy = false;
  private countNeeded = false;

  constructor(
    private device: GPUDevice,
    private colorFormat: GPUTextureFormat,
    private world: WorldGpu,
    private profiler: Profiler,
    /** the field mesh unless ?mesh=0, rather than only with ?mesh=1 */
    meshByDefault = false,
    /** the sun's shadow map's side (texels; quality `shadowSize`): it covers the chunks near the view */
    shadowSize = SHADOW_SIZE,
    /** the field mesh's room a chunk, times its default */
    meshRoom = 1,
    /** field mesh chunks rebuilt a frame (quality `meshSlots`; round 81) */
    meshSlots?: number,
  ) {
    const N = world.cells;
    // column intervals and the loose sheet (hex prisms); plants (boxes) apart,
    // drawn with fewer vertices
    this.opaqueCapacity = N * (world.maxK + 1);
    // + the tops list after it (renderprep.wgsl: two per column at most), from
    // a storage-offset-aligned instance (256 bytes)
    this.topsBase = Math.ceil(this.opaqueCapacity / 16) * 16;
    this.instOpaque = world.buf('instOpaque', (this.topsBase + 2 * N) * 16, GPUBufferUsage.STORAGE);
    this.instPlant = world.buf('instPlant', N * VEG_INSTANCES * 16, GPUBufferUsage.STORAGE);
    // up to four blended boxes per column: water, oil, two see-through solids (renderprep.wgsl GLASS_MAX)
    this.instWater = world.buf('instWater', N * 4 * 16, GPUBufferUsage.STORAGE);
    // draw args: [0..3] opaque prisms, [4..7] water, [8..11] plants, [12..15]
    // tops alone; [16] where the tops start in instOpaque (renderprep.wgsl)
    this.indirect = world.buf(
      'indirect',
      80,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.camBuf = world.buf('camera', CAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.lightCamBuf = world.buf('lightCamera', CAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.pickBuf = world.buf('pick', 256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.countBuf = world.buf('counts', 64,GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    const format = this.colorFormat;
    this.fieldMesh = new FieldMesh(device, world, profiler, meshByDefault, meshRoom, undefined, meshSlots);
    // (a texel when there's no shadow pass: the draw shaders still bind one)
    const ss = this.fieldMesh.on ? shadowSize : 1;
    this.shadowTex = device.createTexture({ label: 'shadow', size: [ss, ss], format: SHADOW_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowView = this.shadowTex.createView();
    this.shadowSampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    profiler.trackMemory('shadow', ss * ss * 4);
    // (?skip=cull: every column, as before the view culling)
    const cullOff = `const CULL_OFF: bool = ${SKIP.has('cull')};`;
    this.prep = makeCompute(device, 'renderprep', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, meshRegionWgsl, cullOff, renderprepWgsl], {
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
      14: 'tex',
      17: 'tex',
      21: 'tex',
      30: 'uniform',
      31: 'uniform',
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
      14: world.cornerView,
      17: world.driftView,
      21: world.bodyProjView,
      30: this.fieldMesh.region,
      31: this.camBuf,
    });

    this.vegPrep = makeCompute(device, 'vegprep', [commonWgsl, materialsWgsl, vegplanWgsl, terrainShapeWgsl, meshRegionWgsl, vegprepWgsl], {
      0: 'uniform',
      2: 'uniform',
      3: 'read',
      4: 'read',
      5: 'rw',
      6: 'rw',
      7: 'read',
      8: 'read',
      9: 'rw',
      14: 'tex',
      17: 'tex',
      30: 'uniform',
    });
    this.vegPrepGroup = makeBindGroup(device, 'vegprep', this.vegPrep.layout, {
      0: world.globals,
      2: world.materials,
      3: world.surface,
      4: world.veg,
      5: this.instOpaque,
      6: this.indirect,
      7: world.wilt,
      8: world.petals,
      9: this.instPlant,
      14: world.cornerView,
      17: world.driftView,
      30: this.fieldMesh.region,
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
        12: 'read',
        13: 'read',
        14: 'tex',
        15: 'tex',
        17: 'tex',
        19: 'tex',
        23: 'tex',
        25: 'depth',
        26: 'csampler',
      },
      VF,
    );
    const drawModule = makeModule(device, 'render', [commonWgsl, materialsWgsl, terrainShapeWgsl, renderWgsl]);
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

    const groupFor = (inst: GPUBuffer | GPUBufferBinding, cam: GPUBuffer = this.camBuf, shadow: GPUTextureView = this.shadowView) =>
      makeBindGroup(device, 'draw', drawLayout, {
        0: world.globals,
        2: world.materials,
        3: inst,
        4: world.contam,
        6: world.veg,
        7: world.renderFields,
        8: world.water,
        10: cam,
        11: world.surface,
        12: world.bend,
        13: world.wilt,
        14: world.cornerView,
        15: world.windFieldView,
        17: world.driftView,
        19: world.strataView,
        23: world.reachView,
        25: shadow,
        26: this.shadowSampler,
      });
    this.groupFor = groupFor;
    this.opaqueGroup = groupFor(this.instOpaque);
    this.topsGroup = groupFor({ buffer: this.instOpaque, offset: this.topsBase * 16 });
    this.plantGroup = groupFor(this.instPlant);
    this.waterGroup = groupFor(this.instWater);
    this.bodyBuf = world.buf('bodyVoxels', Renderer.MAX_BODY_VOXELS * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bodyGroup = groupFor(this.bodyBuf);
    this.structInst = world.buf('structInst', POOL_VOXELS * 32, GPUBufferUsage.STORAGE);
    this.structIndirect = world.buf('structIndirect', 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.structGroup = groupFor(this.structInst);
    this.structPrep = makeCompute(device, 'structprep', [commonWgsl, gridsWgsl, structPrepWgsl], { 0: 'uniform', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw' });
    this.structPrepGroup = makeBindGroup(device, 'structprep', this.structPrep.layout, {
      0: world.globals,
      3: world.strFrames,
      4: world.strVox,
      5: this.structInst,
      6: this.structIndirect,
    });
    this.bodyPipe = device.createRenderPipeline({
      label: 'bodies',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsBody' },
      fragment: { module: drawModule, entryPoint: 'fsBody', targets: [{ format }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(true),
    });

    this.skinPipe = device.createRenderPipeline({
      label: 'skins',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsSkin' },
      fragment: { module: drawModule, entryPoint: 'fsBody', targets: [{ format }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(true),
    });

    if (this.fieldMesh.on) {
      // the field mesh: its own layout (the intervals for the look, in place of
      // the plants' sway and the corners)
      const meshLayout = makeLayout(
        device,
        'mesh-draw',
        { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'uniform', 11: 'read', 13: 'read', 15: 'tex', 17: 'tex', 23: 'tex', 25: 'depth', 26: 'csampler', 30: 'uniform' },
        VF,
        // (a stage has eight storage buffers: the vertices and the mesh's
        // state (its translations) are the vertex stage's, the look's and the
        // water's (its film) the fragments')
        { 3: GPUShaderStage.VERTEX, 5: GPUShaderStage.VERTEX, ...Object.fromEntries([1, 4, 6, 7, 8, 9, 11, 13].map((b) => [b, GPUShaderStage.FRAGMENT])) },
      );
      // (round 82, ?look=: the terrain's pixel shader cut down, to measure it on a phone — full (default), lookup
      // (the interval's material and the lighting only), flat (grey by the normal: the geometry alone))
      const look = { full: 0, lookup: 1, flat: 2 }[new URLSearchParams(location.search).get('look') ?? 'full'];
      if (look === undefined) throw new Error('?look= must be full, lookup or flat');
      const meshModule = makeModule(device, 'mesh-draw', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, renderWgsl, meshRegionWgsl, `const MESH_LOOK: u32 = ${look}u;`, meshDrawWgsl]);
      this.meshPipe = device.createRenderPipeline({
        label: 'mesh',
        layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }),
        vertex: { module: meshModule, entryPoint: 'vsMesh' },
        fragment: { module: meshModule, entryPoint: 'fsMesh', targets: [{ format }, { format: PICK_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthStencil(true),
      });
      // (round 79: or the band's — its mesh, chunk table and layers)
      this.meshGroupOf = (cam, shadow, src) => makeBindGroup(device, 'mesh-draw', meshLayout, {
        0: world.globals,
        1: src.chunks,
        2: world.materials,
        3: src.mesh.vertexBuffer,
        4: world.contam,
        5: src.mesh.stateBuffer,
        30: src.mesh.region,
        6: world.veg,
        7: world.renderFields,
        8: world.water,
        9: src.layers,
        10: cam,
        11: world.surface,
        13: world.wilt,
        15: world.windFieldView,
        17: world.driftView,
        23: world.reachView,
        25: shadow,
        26: this.shadowSampler,
      });
      const meshGroupFor = (cam: GPUBuffer, shadow: GPUTextureView = this.shadowView) => this.meshGroupOf!(cam, shadow, { mesh: this.fieldMesh, chunks: world.chunks, layers: world.layers });
      this.meshGroup = meshGroupFor(this.camBuf);
      // the sun's shadow pass: the same vertex shaders, depth only, through the
      // sun's camera (the prisms and plants draw the sides facing it)
      const shadowDepth: GPUDepthStencilState = { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 };
      const shadowPipe = (label: string, layout: GPUPipelineLayout, module: GPUShaderModule, entryPoint: string) =>
        device.createRenderPipeline({ label, layout, vertex: { module, entryPoint }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: shadowDepth });
      this.shadowOpaquePipe = shadowPipe('shadow-opaque', pl, drawModule, 'vsBox');
      this.shadowBodyPipe = shadowPipe('shadow-bodies', pl, drawModule, 'vsBody');
      this.shadowSkinPipe = shadowPipe('shadow-skins', pl, drawModule, 'vsSkin');
      this.shadowMeshPipe = shadowPipe('shadow-mesh', device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }), meshModule, 'vsMesh');
      // (the pass draws into the map, so its groups bind a stand-in texel there)
      const none = device.createTexture({ label: 'shadow-none', size: [1, 1], format: SHADOW_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
      this.noShadowView = none;
      const L = this.lightCamBuf;
      this.shadowGroups = {
        opaque: groupFor(this.instOpaque, L, none),
        tops: groupFor({ buffer: this.instOpaque, offset: this.topsBase * 16 }, L, none),
        plants: groupFor(this.instPlant, L, none),
        struct: groupFor(this.structInst, L, none),
        bodies: groupFor(this.bodyBuf, L, none),
        mesh: meshGroupFor(L, none),
      };
    }

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

    const partLayout = makeLayout(device, 'particles-draw', { 0: 'uniform', 2: 'uniform', 3: 'read', 10: 'uniform' }, VF);
    const partModule = makeModule(device, 'particles-draw', [commonWgsl, materialsWgsl, particlesDrawWgsl]);
    this.partPipe = device.createRenderPipeline({
      label: 'particles',
      layout: device.createPipelineLayout({ bindGroupLayouts: [partLayout] }),
      vertex: { module: partModule, entryPoint: 'vs' },
      fragment: { module: partModule, entryPoint: 'fs', targets: [{ format, blend }, { format: PICK_FORMAT, writeMask: 0 }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthStencil(false),
    });
    this.partGroup = makeBindGroup(device, 'particles-draw', partLayout, { 0: world.globals, 2: world.materials, 3: world.particles, 10: this.camBuf });
  }

  /**
   * The rigid bodies' voxels for this frame: per voxel centre xyz, material,
   * rotation quaternion xyzw (f32 bits; Bodies.pack writes them).
   */
  setBodies(data: Uint32Array, count: number): void {
    this.bodyCount = Math.min(count, Renderer.MAX_BODY_VOXELS);
    if (this.bodyCount > 0) this.device.queue.writeBuffer(this.bodyBuf, 0, data, 0, this.bodyCount * 8);
  }

  /**
   * Draw more voxels in the body format (render.wgsl vsBody) from a
   * GPU-written instance buffer and its indirect args (drawIndirect: 36
   * vertices, one instance per voxel): lit, shadowed, with or without the
   * field mesh. Per voxel two vec4<u32>: centre xyz (f32 bits) and the
   * material word, then the rotation quaternion xyzw (f32 bits). The word:
   * bits 0-7 material, 24-29 the voxel's size (0 a whole cell, n n/16 of a
   * cell), 30 a physics voxel (8-15 speckle, 16-23 heat), 31 a structure
   * grid's; leave 30 and 31 clear for a game model. See ARCHITECTURE.md.
   */
  addVoxels(inst: GPUBuffer, indirect: GPUBuffer): void {
    this.voxelSources.push({
      indirect,
      group: this.groupFor(inst),
      shadow: this.shadowGroups ? this.groupFor(inst, this.lightCamBuf, this.noShadowView!) : undefined,
    });
  }

  /**
   * Draw a GPU-written triangle list (render.wgsl vsSkin: per vertex two
   * vec4<u32>, position f32 bits + the material word, then the triangle's
   * normal; drawIndirect args, vertex count first), lit and shadowed like a
   * body's voxels. Physics.skinOut / skinArgs: meshes bent by their bodies.
   */
  addMesh(verts: GPUBuffer, indirect: GPUBuffer): void {
    this.meshSources.push({
      indirect,
      group: this.groupFor(verts),
      shadow: this.shadowGroups ? this.groupFor(verts, this.lightCamBuf, this.noShadowView!) : undefined,
    });
  }

  /** Draw these prisms (renderprep's instance form) with the opaque pipeline too. */
  addPrisms(inst: GPUBuffer, indirect: GPUBuffer): void {
    this.prismSources.push({ indirect, group: this.groupFor(inst) });
  }

  /** Textures are the renderer's own; buffers belong to the world (world.destroy()). */
  destroy(): void {
    this.shadowTex.destroy();
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
    // look flags (render.wgsl Camera.eye.w)
    new Float32Array(this.camData)[19] = (this.flatTops ? 1 : 0) | (this.fieldMesh.on ? 2 : 0);
    this.fieldMesh.cull(cam);
    this.band?.mesh.cull(cam);
    if (this.fieldMesh.on) this.writeLight(opts.sun);
    this.device.queue.writeBuffer(this.camBuf, 0, this.camData);
    if (this.world.strVoxels > 0) this.device.queue.writeBuffer(this.structIndirect, 0, new Uint32Array([36, 0, 0, 0]));
    this.device.queue.writeBuffer(
      this.indirect,
      0,
      new Uint32Array([VERTS_PER_PRISM, 0, 0, 0, VERTS_PER_PRISM, 0, 0, 0, VERTS_PER_BOX, 0, 0, 0, VERTS_PER_TOP, 0, 0, 0, this.topsBase]),
    );

    if (!SKIP.has('prep')) {
      const pass = enc.beginComputePass({ label: 'renderprep', timestampWrites: this.profiler.timestamps('renderprep') });
      pass.setPipeline(this.prep.pipeline);
      pass.setBindGroup(0, this.prepGroup);
      const [gx, gy] = this.world.groups;
      pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(this.vegPrep.pipeline);
      pass.setBindGroup(0, this.vegPrepGroup);
      pass.dispatchWorkgroups(gx, gy);
      if (this.world.strVoxels > 0) {
        pass.setPipeline(this.structPrep.pipeline);
        pass.setBindGroup(0, this.structPrepGroup);
        pass.dispatchWorkgroups(Math.ceil(this.world.strVoxels / 64));
        this.profiler.dispatches++;
      }
      pass.end();
      this.profiler.dispatches += 2;
    }
    if (!SKIP.has('meshprep')) this.fieldMesh.encode(enc, cam);
    if (this.band && !SKIP.has('band')) this.band.mesh.encode(enc, cam);
    if (this.shadowGroups && !SKIP.has('shadow')) this.encodeShadow(enc);

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
    if (!SKIP.has('opaque')) pass.drawIndirect(this.indirect, 0);
    pass.setBindGroup(0, this.topsGroup);
    if (!SKIP.has('tops')) pass.drawIndirect(this.indirect, 48);
    pass.setBindGroup(0, this.plantGroup);
    if (!SKIP.has('plants')) pass.drawIndirect(this.indirect, 32);
    for (const s of SKIP.has('prisms') ? [] : this.prismSources) {
      pass.setBindGroup(0, s.group);
      pass.drawIndirect(s.indirect, 0);
      this.profiler.draws++;
    }
    if (this.meshPipe && !SKIP.has('mesh')) {
      pass.setPipeline(this.meshPipe);
      pass.setBindGroup(0, this.meshGroup!);
      this.fieldMesh.draw(pass);
      this.profiler.draws++;
      // (round 79: the band outside the window — it casts no shadow yet: the sun's box is the window's)
      if (this.band && !SKIP.has('band')) {
        pass.setBindGroup(0, this.bandGroup!);
        this.band.mesh.draw(pass);
      }
    }
    for (const f of SKIP.has('far') ? [] : this.extraDraws) f(pass, opts.clear);
    if (this.bodyCount > 0 && !SKIP.has('bodies')) {
      pass.setPipeline(this.bodyPipe);
      pass.setBindGroup(0, this.bodyGroup);
      pass.draw(36, this.bodyCount);
      this.profiler.draws++;
    }
    if (this.world.strVoxels > 0 && !SKIP.has('structs')) {
      pass.setPipeline(this.bodyPipe);
      pass.setBindGroup(0, this.structGroup);
      pass.drawIndirect(this.structIndirect, 0);
      this.profiler.draws++;
    }
    for (const v of SKIP.has('voxels') ? [] : this.voxelSources) {
      pass.setPipeline(this.bodyPipe);
      pass.setBindGroup(0, v.group);
      pass.drawIndirect(v.indirect, 0);
      this.profiler.draws++;
    }
    for (const v of SKIP.has('skins') ? [] : this.meshSources) {
      pass.setPipeline(this.skinPipe);
      pass.setBindGroup(0, v.group);
      pass.drawIndirect(v.indirect, 0);
      this.profiler.draws++;
    }
    pass.setPipeline(this.waterPipe);
    pass.setBindGroup(0, this.waterGroup);
    if (!SKIP.has('water')) pass.drawIndirect(this.indirect, 16);
    pass.setPipeline(this.partPipe);
    pass.setBindGroup(0, this.partGroup);
    if (!SKIP.has('particles')) pass.draw(6, this.world.particleCap);
    this.profiler.draws++;
    if (opts.rainParticles > 0 && !SKIP.has('rain')) {
      pass.setPipeline(this.rainPipe);
      pass.setBindGroup(0, this.rainGroup);
      pass.draw(6, opts.rainParticles);
      this.profiler.draws++;
    }
    pass.end();
    this.profiler.draws += 3;

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
      enc.copyBufferToBuffer(this.indirect, 0, this.countBuf, 0, 64);
      this.countBusy = true;
      this.countNeeded = READBACK;
    }
  }

  /**
   * The sun's view: an orthographic box round the whole map (it's small
   * enough for one map) looking along the light, into both cameras — the
   * view's, to look shadows up, and the sun's own, to draw them.
   */
  private writeLight(sun: [number, number, number]): void {
    const f = [-sun[0], -sun[1], -sun[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    f[0] /= fl;
    f[1] /= fl;
    f[2] /= fl;
    // (right and up across the light; a sun overhead takes y for its up)
    const up = Math.abs(f[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    let r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    const rl = Math.hypot(r[0], r[1], r[2]);
    r = r.map((v) => v / rl);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    // the box: the chunks near the view, floor to sky (perf branch; it was the
    // whole map). The light is orthographic, so it holds every caster whose
    // shadow falls in them: those up-sun of the view too.
    const [x0, y0, x1, y1] = SKIP.has('shadowfit') ? [0, 0, this.world.w + 0.5, this.world.h * (Math.sqrt(3) / 2)] : this.fieldMesh.nearRect;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 8; k++) {
      const p = [k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? this.world.zMax + 2 : -2];
      const a = [r, u, f].map((ax) => ax[0] * p[0] + ax[1] * p[1] + ax[2] * p[2]);
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], a[i]);
        hi[i] = Math.max(hi[i], a[i]);
      }
    }
    // clip x, y ∈ [-1, 1] across the box, depth ∈ [0, 1] along the light
    const sx = 2 / (hi[0] - lo[0]);
    const sy = 2 / (hi[1] - lo[1]);
    const sz = 1 / (hi[2] - lo[2]);
    const m = new Float32Array(16);
    m.set([r[0] * sx, u[0] * sy, f[0] * sz, 0, r[1] * sx, u[1] * sy, f[1] * sz, 0, r[2] * sx, u[2] * sy, f[2] * sz, 0]);
    m.set([-(lo[0] + hi[0]) / 2 * sx, -(lo[1] + hi[1]) / 2 * sy, -lo[2] * sz, 1], 12);
    const cf = new Float32Array(this.camData);
    cf.set(m, CAMERA_BYTES / 4);
    this.fieldMesh.castCull(m);
    // the lookup's depth bias: a quarter of a cell along the light
    cf[23] = 0.25 * sz;
    // the sun's own camera: its matrix as the view, looking from the sun
    const lf = new Float32Array(this.lightCamData);
    lf.set(cf);
    lf.set(m, 0);
    lf.set([-f[0], -f[1], -f[2], cf[19]], 16);
    this.device.queue.writeBuffer(this.lightCamBuf, 0, this.lightCamData);
  }

  /** The sun's shadow map: every built mesh chunk, the prisms, plants, structures and bodies, depth only. */
  private encodeShadow(enc: GPUCommandEncoder): void {
    const g = this.shadowGroups!;
    const pass = enc.beginRenderPass({
      label: 'shadow',
      colorAttachments: [],
      depthStencilAttachment: { view: this.shadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: this.profiler.timestamps('shadow'),
    });
    pass.setPipeline(this.shadowMeshPipe!);
    pass.setBindGroup(0, g.mesh);
    this.fieldMesh.drawCasters(pass);
    pass.setPipeline(this.shadowOpaquePipe!);
    pass.setBindGroup(0, g.opaque);
    pass.drawIndirect(this.indirect, 0);
    pass.setBindGroup(0, g.tops);
    pass.drawIndirect(this.indirect, 48);
    pass.setBindGroup(0, g.plants);
    pass.drawIndirect(this.indirect, 32);
    pass.setPipeline(this.shadowBodyPipe!);
    if (this.world.strVoxels > 0) {
      pass.setBindGroup(0, g.struct);
      pass.drawIndirect(this.structIndirect, 0);
    }
    if (this.bodyCount > 0) {
      pass.setBindGroup(0, g.bodies);
      pass.draw(36, this.bodyCount);
    }
    for (const v of this.voxelSources) {
      if (!v.shadow) continue;
      pass.setBindGroup(0, v.shadow);
      pass.drawIndirect(v.indirect, 0);
    }
    if (this.meshSources.length) pass.setPipeline(this.shadowSkinPipe!);
    for (const v of this.meshSources) {
      if (!v.shadow) continue;
      pass.setBindGroup(0, v.shadow);
      pass.drawIndirect(v.indirect, 0);
    }
    pass.end();
    this.profiler.draws += 4;
  }

  /**
   * Draw what lies outside the streamed window too (round 79: the atlas level; render/band.ts), up to the
   * world's height. The streamer packs it (Streamer → band.update).
   */
  enableBand(zSpan: number): OutsideBand | undefined {
    if (!this.fieldMesh.on || !this.meshGroupOf || this.band) return this.band;
    this.band = new OutsideBand(this.device, this.world, this.profiler, zSpan);
    this.bandGroup = this.meshGroupOf(this.camBuf, this.shadowView, { mesh: this.band.mesh, chunks: this.band.chunks, layers: this.band.layers });
    return this.band;
  }

  /** Call after submit to start async readbacks requested during encode. */
  afterSubmit(): void {
    this.fieldMesh.afterSubmit();
    this.band?.mesh.afterSubmit();
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
        this.instanceCounts = { opaque: u[1] + u[9] + u[13], water: u[5], tops: u[13], prisms: u[1], plants: u[9] };
        this.countBuf.unmap();
        // throttle: allow another readback in a little while
        setTimeout(() => (this.countBusy = false), 250);
      }, ignoreTeardown);
    }
  }
}
