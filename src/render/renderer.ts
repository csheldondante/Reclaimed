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
import meshStateWgsl from '../shaders/meshstate.wgsl?raw';
import meshDrawWgsl from '../shaders/meshdraw.wgsl?raw';
import tcacheWgsl from '../shaders/tcache.wgsl?raw';
import { FieldMesh, READBACK } from './fieldmesh';
import { POOL_VOXELS } from '../grids/structures';
import type { WorldGpu } from '../sim/world-gpu';
import { ShoreField } from './shore';
import { CAMERA_BYTES, CAMERA_CUT_BYTES, CAMERA_CUT_OFFSET, type Camera } from './camera';
import { OutsideBand } from './band';

/** the draw shaders' camera (render.wgsl Camera): the view's, then the sun's shadow matrix */
const CAM_BYTES = CAMERA_BYTES + 64 + 16 + CAMERA_CUT_BYTES;
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

/** (perfopt) the winding of the mesh's faces out of the solid on screen (fieldmesh.wgsl makeQuads; ?front=cw to try the other) */
const MESH_FRONT: GPUFrontFace = new URLSearchParams(location.search).get('front') === 'cw' ? 'cw' : 'ccw';
/** (perfopt) the look's pieces ?nodetail= can leave out (meshdraw.wgsl ND_*; shadow: render.wgsl lighting) */
const DETAIL_BITS: Record<string, number> = { strata: 1, water: 2, plants: 4, stains: 8, struct: 16, shadow: 32, warp: 64, fields: 128, specks: 256 };

// (perf branch: ?skip=render (round 82: world-core.ts — nothing drawn),opaque,tops,plants,prisms,mesh,bodies,structs,voxels,skins,water,particles,rain,shadow,prep,meshprep
// leaves that piece out of the frame, to measure what it costs: scripts/perfprofile.mjs)
/** (perfopt, tcache) the cached terrain layer's margin past the screen, render pixels a side */
const TC_MARGIN = 24;
export const SKIP = new Set((new URLSearchParams(location.search).get('skip') ?? '').split(',').filter(Boolean));

export class Renderer {
  /** (round 82) the pieces left out, changed at run time by scripts/drawbench.mjs */
  static readonly skip = SKIP;
  /** (perfopt) run-time switches for A/B (scripts/drawbench.mjs flips them): prepass — the terrain mesh's depth
   *  first, then its look tested equal, so each pixel's look is shaded once (?prepass=1) */
  static readonly opts = {
    prepass: new URLSearchParams(location.search).get('prepass') === '1',
    /** the mesh drawn to a G-buffer and its look shaded once a pixel in a full-screen pass (meshdraw.wgsl; on by
     *  default, ?defer=0 the forward draw) */
    defer: new URLSearchParams(location.search).get('defer') !== '0',
    /** the sun's shadow map drawn every Nth frame (?shadowevery=N; 1 every frame): kept with the light matrix it was
     *  drawn with, so it stays right as the camera moves; drawn again at once after a slide or when the box it covers moves */
    /** the G-buffer pass culls the mesh's faces turned from the eye, the shadow pass those turned from the sun
     *  (?cull=1; fieldmesh.wgsl winds them out of the solid); the G-buffer not while the cutaway is on: it shows the inside */
    cull: new URLSearchParams(location.search).get('cull') === '1',
    /** the terrain look's pieces left out (?nodetail=strata,water,plants,stains,struct,shadow,warp,fields,specks;
     *  meshdraw.wgsl ND_*): Camera.eye.w bits 2 up, read at run time — to find what the look's cost is */
    noDetail: (new URLSearchParams(location.search).get('nodetail') ?? '')
      .split(',')
      .filter(Boolean)
      .reduce((m, k) => {
        const b = DETAIL_BITS[k];
        if (b === undefined) throw new Error(`?nodetail=${k}: one of ${Object.keys(DETAIL_BITS).join(', ')}`);
        return m | b;
      }, 0),
    /** the sun's map's static casters (the terrain mesh, the prisms) drawn every Nth frame into a cache, copied in
     *  and the moving ones (plants, structures, bodies) drawn over it every frame (?shadowcache=N; 0 off) */
    shadowCache: Number(new URLSearchParams(location.search).get('shadowcache') ?? 0),
    /** the terrain drawn into a cached layer every Nth frame (a margin past the screen), copied in each frame moved
     *  by the camera, which is snapped to its pixels (?tcache=N; 0 off; not with the cutaway or the free camera) */
    tcache: Number(new URLSearchParams(location.search).get('tcache') ?? 0),
    /** the band's G-buffer draw culls the faces turned from the eye (?bandcull=1) */
    bandcull: new URLSearchParams(location.search).get('bandcull') === '1',
    shadowEvery: Number(new URLSearchParams(location.search).get('shadowevery') ?? 1),
    /** the prisms' and plants' instance lists made every Nth frame (?prepevery=N): a frame's lag on what changed;
     *  made again at once after a slide */
    prepEvery: Number(new URLSearchParams(location.search).get('prepevery') ?? 1),
  };
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
  /** (perfopt, ?prepass=1) the mesh's depth-only pipelines (no cut, cut) and its look tested less-equal, made on first use */
  private meshPre?: { z: GPURenderPipeline; zCut: GPURenderPipeline; look: GPURenderPipeline };
  private meshPreMake?: () => { z: GPURenderPipeline; zCut: GPURenderPipeline; look: GPURenderPipeline };
  /** (perfopt, ?defer=1) the G-buffer pipelines (no cut, cut), the resolve, its groups (window, band), made on first use */
  private meshDef?: { g: GPURenderPipeline; gBack: GPURenderPipeline; gCut: GPURenderPipeline; resolve: GPURenderPipeline; groups: GPUBindGroup[]; tex: GPUTexture[]; band?: OutsideBand };
  private meshEntries!: (src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }, cam?: GPUBuffer) => GPUBindGroupEntry[];
  /** (perfopt, ?tcache=N) the terrain's cached layer: its textures (a margin past the screen), its camera, groups,
   *  and what it was drawn with (the camera's matrix, the frame, the size, the slides) */
  private tc?: {
    tex: { g0: GPUTexture; g1: GPUTexture; gd: GPUTexture; color: GPUTexture; pick: GPUTexture; depth: GPUTexture };
    cam: GPUBuffer;
    uni: GPUBuffer;
    gGroups: GPUBindGroup[];
    rGroups: GPUBindGroup[];
    comp: GPUBindGroup;
    band?: OutsideBand;
    m: Float32Array;
    frame: number;
    w: number;
    h: number;
    slides: number;
  };
  /** (perfopt, tcache) frames the layer was reused and drawn again (scripts read it) */
  readonly tcStats = { reuse: 0, refresh: 0 };
  private tcPipes?: { resolve: GPURenderPipeline; comp: GPURenderPipeline; compLayout: GPUBindGroupLayout };
  private meshPipes?: { g: GPURenderPipeline; gBack: GPURenderPipeline; gCut: GPURenderPipeline; resolve: GPURenderPipeline };
  private meshModule?: GPUShaderModule;
  private meshResources!: (cam: GPUBuffer, shadow: GPUTextureView, src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }) => Record<number, GPUBuffer | GPUTextureView | GPUSampler>;
  /** (perfopt) the deferred pipelines, compiled off the main thread from the start (createRenderPipelineAsync): the
   *  terrain draws forward until they're in — compiled on first use they froze the frame ~1.5 s after a load */
  private meshPipesReady?: Promise<void>;
  /** the pipelines compiled off the main thread, in (a scene awaits it while it loads: WorldCore.warmup) */
  ready(): Promise<void> {
    return this.meshPipesReady ?? Promise.resolve();
  }
  private meshResolveLayout?: GPUBindGroupLayout;
  /** further opaque draws in the world pass, with the sky's colour (round 73: the atlas's far land) */
  readonly extraDraws: ((pass: GPURenderPassEncoder, clear: [number, number, number]) => void)[] = [];
  /** what an extra draw renders into, and the camera it reads (render.wgsl Camera) */
  get targets(): { format: GPUTextureFormat; pickFormat: GPUTextureFormat; depthFormat: GPUTextureFormat; camera: GPUBuffer; mesh?: { state: GPUBuffer; grid: [number, number, number] } } {
    // (round 83: the field mesh's state, when it draws the ground — far.ts's rings fill the chunks not built yet)
    const mesh = this.fieldMesh.on ? { state: this.fieldMesh.stateBuffer, grid: this.fieldMesh.chunkGrid } : undefined;
    return { format: this.colorFormat, pickFormat: PICK_FORMAT, depthFormat: DEPTH_FORMAT, camera: this.camBuf, mesh };
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
  /** (perfopt, ?cull=1) the mesh into the sun's map, the faces turned from the sun culled */
  private shadowMeshCullPipe?: GPURenderPipeline;
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
  /** frames, for the window's and the band's mesh turns (round 82) */
  private meshTurn = 0;
  /** (perfopt, shadowEvery) the light matrix and lookup bias the shadow map holds, when it was drawn, the box, the slides */
  private shadowAt = { m: new Float32Array(16), bias: 0, frame: -1e9, rect: '', slides: -1, cached: false };
  /** (perfopt, shadowCache) the static casters' depth, copied into the sun's map each frame */
  private shadowStatic?: GPUTexture;
  /** (perfopt, prepEvery) when the instance lists were last made, and the slides then */
  private prepAt = { frame: -1e9, slides: -1 };
  private frameNo = 0;
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
    private meshSlots?: number,
  ) {
    const N = world.cells;
    // (round 83) the nearest shore to every column: the water's swell (render.wgsl shoreTex)
    this.shore = new ShoreField(device, world, world.w, world.h);
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
    this.shadowTex = device.createTexture({ label: 'shadow', size: [ss, ss], format: SHADOW_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.shadowView = this.shadowTex.createView();
    this.shadowSampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    profiler.trackMemory('shadow', ss * ss * 4);
    // (?skip=cull: every column, as before the view culling)
    const cullOff = `const CULL_OFF: bool = ${SKIP.has('cull')};`;
    this.prep = makeCompute(device, 'renderprep', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, cullOff, renderprepWgsl], {
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

    // (perfopt, ?tufts=0: the grass tufts left out — most of the plant boxes, each under a pixel at low)
    const tufts = `const TUFTS: bool = ${new URLSearchParams(location.search).get('tufts') !== '0'};`;
    this.vegPrep = makeCompute(device, 'vegprep', [commonWgsl, materialsWgsl, vegplanWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, tufts, vegprepWgsl], {
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
        24: 'tex',
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
        24: this.shore.view,
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
      const meshModule = makeModule(device, 'mesh-draw', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, renderWgsl, meshStateWgsl, meshRegionWgsl, `const MESH_LOOK: u32 = ${look}u;`, `const TUFTS_DRAWN: bool = ${new URLSearchParams(location.search).get('tufts') !== '0'};`, meshDrawWgsl]);
      this.meshPipe = device.createRenderPipeline({
        label: 'mesh',
        layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }),
        vertex: { module: meshModule, entryPoint: 'vsMesh' },
        fragment: { module: meshModule, entryPoint: 'fsMesh', targets: [{ format }, { format: PICK_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthStencil(true),
      });
      const meshPl = device.createPipelineLayout({ bindGroupLayouts: [meshLayout] });
      // (perfopt, ?defer=1: the G-buffer's pass and the resolve's layout — the mesh's plus the G-buffer)
      const resolveLayout = makeLayout(
        device,
        'mesh-resolve',
        { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'uniform', 11: 'read', 13: 'read', 15: 'tex', 17: 'tex', 23: 'tex', 25: 'depth', 26: 'csampler', 30: 'uniform', 40: 'utex', 41: 'utex' },
        VF,
        { 3: GPUShaderStage.VERTEX, 5: GPUShaderStage.VERTEX, ...Object.fromEntries([1, 4, 6, 7, 8, 9, 11, 13].map((b) => [b, GPUShaderStage.FRAGMENT])) },
      );
      this.meshResolveLayout = resolveLayout;
      this.meshPipesReady = (async () => {
        const g = (entryPoint: string, cullMode: GPUCullMode = 'none') =>
          device.createRenderPipelineAsync({
            label: `mesh-${entryPoint}-${cullMode}`,
            layout: meshPl,
            vertex: { module: meshModule, entryPoint: 'vsMeshG' },
            fragment: { module: meshModule, entryPoint, targets: [{ format: 'rgba32uint' }, { format: 'rg32uint' }] },
            primitive: { topology: 'triangle-list', cullMode, frontFace: MESH_FRONT },
            depthStencil: depthStencil(true),
          });
        const [gp, gBack, gCut, resolve] = await Promise.all([
          g('fsMeshG'),
          g('fsMeshG', 'back'),
          g('fsMeshGCut'),
          device.createRenderPipelineAsync({
            label: 'mesh-resolve',
            layout: device.createPipelineLayout({ bindGroupLayouts: [resolveLayout] }),
            vertex: { module: meshModule, entryPoint: 'vsFull' },
            fragment: { module: meshModule, entryPoint: 'fsMeshResolve', targets: [{ format }, { format: PICK_FORMAT }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
          }),
        ]);
        this.meshPipes = { g: gp, gBack, gCut, resolve };
        // (the terrain's cached layer's, when it's asked for: ?tcache)
        if (Renderer.opts.tcache > 0) await this.tcPipesMake();
      })();
      this.meshPreMake = () => {
        const z = (entryPoint: string) =>
          device.createRenderPipeline({
            label: `mesh-${entryPoint}`,
            layout: meshPl,
            vertex: { module: meshModule, entryPoint: 'vsMesh' },
            fragment: { module: meshModule, entryPoint, targets: [{ format, writeMask: 0 }, { format: PICK_FORMAT, writeMask: 0 }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthStencil(true),
          });
        return {
          z: z('fsMeshZ'),
          zCut: z('fsMeshZCut'),
          look: device.createRenderPipeline({
            label: 'mesh-look',
            layout: meshPl,
            vertex: { module: meshModule, entryPoint: 'vsMesh' },
            fragment: { module: meshModule, entryPoint: 'fsMesh', targets: [{ format }, { format: PICK_FORMAT }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less-equal' },
          }),
        };
      };
      // (round 79: or the band's — its mesh, chunk table and layers)
      this.meshModule = meshModule;
      this.meshEntries = (src, cam = this.camBuf, shadow = this.shadowView) =>
        Object.entries(this.meshResources(cam, shadow, src)).map(([b, r]) => ({ binding: Number(b), resource: r instanceof GPUBuffer ? { buffer: r } : r }));
      this.meshGroupOf = (cam, shadow, src) => makeBindGroup(device, 'mesh-draw', meshLayout, this.meshResources(cam, shadow, src));
      this.meshResources = (cam, shadow, src) => ({
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
      this.shadowMeshPipe = shadowPipe('shadow-mesh', device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }), meshModule, 'vsMeshG');
      this.shadowMeshCullPipe = device.createRenderPipeline({
        label: 'shadow-mesh-cull',
        layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }),
        vertex: { module: meshModule, entryPoint: 'vsMeshG' },
        primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: MESH_FRONT },
        depthStencil: shadowDepth,
      });
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
    this.shadowStatic?.destroy();
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

  /**
   * ?ceiling=1 (the perf ceiling: a heightfield alone): the camera written and one pass — the colour target
   * cleared, the depth, `draw` (far.ts's rings and far land) — nothing prepared, no mesh, no shadow, no pick.
   */
  encodeCeiling(enc: GPUCommandEncoder, target: GPUTextureView, cam: Camera, clear: [number, number, number], draw: (pass: GPURenderPassEncoder) => void): void {
    cam.write(this.camData);
    this.device.queue.writeBuffer(this.camBuf, 0, this.camData);
    const pass = enc.beginRenderPass({
      label: 'ceiling',
      colorAttachments: [{ view: target, clearValue: { r: clear[0], g: clear[1], b: clear[2], a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.profiler.timestamps('draw'),
    });
    draw(pass);
    pass.end();
    this.profiler.draws += 2;
  }

  encode(enc: GPUCommandEncoder, target: GPUTextureView, cam: Camera, opts: RenderOptions): void {
    cam.write(this.camData);
    // look flags (render.wgsl Camera.eye.w)
    new Float32Array(this.camData)[19] = (this.flatTops ? 1 : 0) | (this.fieldMesh.on ? 2 : 0) | (Renderer.opts.noDetail << 2);
    this.fieldMesh.cull(cam);
    // (perfopt, ?cavemesh=near: the caves meshed round the player when the cut slices a roof off; all when flying)
    this.fieldMesh.setCaves(cam.cut.slice !== null ? [cam.target[0], cam.target[1]] : null, !!cam.fly);
    this.band?.mesh.cull(cam);
    this.frameNo++;
    const shadowDue = this.fieldMesh.on ? this.writeLight(opts.sun) : false;
    // (perfopt, ?prepevery=N: the instance lists kept from an earlier frame — their counts too)
    const pe = Math.max(1, Renderer.opts.prepEvery | 0);
    const prepDue = pe <= 1 || this.frameNo - this.prepAt.frame >= pe || this.prepAt.slides !== this.fieldMesh.slides;
    if (prepDue) this.prepAt = { frame: this.frameNo, slides: this.fieldMesh.slides };
    // (perfopt, ?tcache=N: the terrain's cached layer — reused, the camera snapped to its pixels; or drawn again)
    const tcMode = this.terrainCacheMode(cam);
    this.device.queue.writeBuffer(this.camBuf, 0, this.camData);
    if (this.world.strVoxels > 0) this.device.queue.writeBuffer(this.structIndirect, 0, new Uint32Array([36, 0, 0, 0]));
    if (prepDue)
      this.device.queue.writeBuffer(
        this.indirect,
        0,
        new Uint32Array([VERTS_PER_PRISM, 0, 0, 0, VERTS_PER_PRISM, 0, 0, 0, VERTS_PER_BOX, 0, 0, 0, VERTS_PER_TOP, 0, 0, 0, this.topsBase]),
      );

    if (!SKIP.has('shore')) this.shore.encode(enc, performance.now());
    if (!SKIP.has('prep') && prepDue) {
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
    // (round 82: with a band, the window's mesh and the band's look for changes and rebuild on alternate frames —
    // a frame never rebuilds both: on the phone the rebuilds were the biggest share of the p95 spikes)
    const turn = this.meshTurn++ & 1;
    // (round 86: but chunks marked urgent — an edit's, a falling piece's — are looked at every frame)
    if (!SKIP.has('meshprep') && !this.holdMesh && (!this.band || turn === 0 || this.fieldMesh.hasUrgent)) this.fieldMesh.encode(enc, cam);
    if (this.band && !SKIP.has('band') && !this.holdMesh && turn === 1) this.band.mesh.encode(enc, cam);
    if (this.shadowGroups && !SKIP.has('shadow') && shadowDue) this.encodeShadow(enc, shadowDue);

    // (perfopt, ?defer=1: the mesh's G-buffer pass, its depth the world pass's)
    if (tcMode === 'refresh') this.encodeTerrainCache(enc);
    // (the deferred pipelines compile off the main thread from the start: forward until they're in)
    const def = !tcMode && this.meshPipe && this.meshPipes && !SKIP.has('mesh') && Renderer.opts.defer ? this.encodeGBuffer(enc, cam) : undefined;
    // (perfopt: nothing reads the depth after this pass, nor the pick target unless a pick is asked for — on a
    // tile-based GPU a discarded attachment never leaves the tile: 12 bytes a pixel not written out every frame)
    const keepPick = !!this.pickRequest && !this.pickBusy;
    const pass = enc.beginRenderPass({
      label: 'world',
      colorAttachments: [
        { view: target, clearValue: { r: opts.clear[0], g: opts.clear[1], b: opts.clear[2], a: 1 }, loadOp: 'clear', storeOp: 'store' },
        { view: this.pickTex!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: keepPick ? 'store' : 'discard' },
      ],
      depthStencilAttachment: def
        ? { view: this.depth!.createView(), depthLoadOp: 'load', depthStoreOp: 'discard' }
        : { view: this.depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.profiler.timestamps('draw'),
    });
    if (tcMode) {
      pass.setPipeline(this.tcPipes!.comp);
      pass.setBindGroup(0, this.tc!.comp);
      pass.draw(3);
    }
    if (def) {
      pass.setPipeline(def.resolve);
      pass.setBindGroup(0, def.groups[0]);
      pass.draw(3);
      if (this.band && !SKIP.has('band')) {
        pass.setBindGroup(0, def.groups[1]);
        pass.draw(3);
      }
    }
    // (perfopt, ?prepass=1: the terrain mesh's depth first — its look is then shaded once a pixel, not for
    // every surface behind it drawn before the one in front)
    const pre = !def && this.meshPipe && !SKIP.has('mesh') && Renderer.opts.prepass ? (this.meshPre ??= this.meshPreMake!()) : undefined;
    if (pre) {
      pass.setPipeline(cutOn(cam) ? pre.zCut : pre.z);
      pass.setBindGroup(0, this.meshGroup!);
      this.fieldMesh.draw(pass);
      if (this.band && !SKIP.has('band')) {
        pass.setBindGroup(0, this.bandGroup!);
        this.band.mesh.draw(pass);
      }
    }
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
    if (this.meshPipe && !SKIP.has('mesh') && !def && !tcMode) {
      pass.setPipeline(pre ? pre.look : this.meshPipe);
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
      this.countNeeded = READBACK && this.profiler.active;
    }
  }

  /**
   * (perfopt, ?tcache=N) Whether the terrain's cached layer is used this frame: 'reuse' (the camera, in camData,
   * moved by whole pixels of it — snapped — within its margin, nothing else about it changed), 'refresh' (drawn
   * again this frame: every Nth, after a slide, a turn, a zoom, a new size, or the margin used up), or false (off,
   * the cutaway on, the free camera). Writes the composite's uniform (the shift, the depth's change).
   */
  private terrainCacheMode(cam: Camera): 'reuse' | 'refresh' | false {
    const N = Renderer.opts.tcache | 0;
    // (its pipelines asked for at the first frame it's on, compiled off the main thread; till then it's off)
    if (N > 0 && !this.tcPipes) void this.tcPipesMake();
    if (N <= 0 || !Renderer.opts.defer || !this.meshPipes || !this.tcPipes || !this.meshPipe || SKIP.has('mesh') || cam.fly || cutOn(cam)) return false;
    const f = new Float32Array(this.camData);
    const W = this.depth!.width;
    const H = this.depth!.height;
    const T = this.tc;
    const M = TC_MARGIN;
    let shift: [number, number] = [0, 0];
    let dz = 0;
    let mode: 'reuse' | 'refresh' = 'refresh';
    if (T && T.w === W && T.h === H && T.slides === this.fieldMesh.slides && this.frameNo - T.frame < N && T.band === this.band && [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => f[i] === T.m[i])) {
      const sx = Math.round(((f[12] - T.m[12]) * W) / 2);
      const sy = Math.round((-(f[13] - T.m[13]) * H) / 2);
      if (Math.abs(sx) < M && Math.abs(sy) < M) {
        // (snapped: the camera moved by whole pixels of the layer — everything this frame draws with it)
        f[12] = T.m[12] + (sx * 2) / W;
        f[13] = T.m[13] - (sy * 2) / H;
        shift = [sx, sy];
        dz = f[14] - T.m[14];
        mode = 'reuse';
      }
    }
    if (mode === 'refresh') this.tcPrepare(W, H, f);
    this.tcStats[mode]++;
    this.device.queue.writeBuffer(this.tc!.uni, 0, new Float32Array([shift[0], shift[1], dz, M]));
    return mode;
  }

  /** (perfopt, tcache) the layer's textures, camera, groups and pipelines for a refresh at W x H, the camera f */
  private tcPrepare(W: number, H: number, f: Float32Array): void {
    const dev = this.device;
    const M = TC_MARGIN;
    const LW = W + 2 * M;
    const LH = H + 2 * M;
    const tcPipes = this.tcPipes!;
    let T = this.tc;
    if (!T || T.tex.color.width !== LW || T.tex.color.height !== LH || T.band !== this.band) {
      if (T) for (const t of Object.values(T.tex)) t.destroy();
      const RT = GPUTextureUsage.RENDER_ATTACHMENT;
      const RB = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const mk = (label: string, format: GPUTextureFormat, usage: number) => dev.createTexture({ label, size: [LW, LH], format, usage });
      const tex = {
        g0: mk('tcache-g0', 'rgba32uint', RB),
        g1: mk('tcache-g1', 'rg32uint', RB),
        gd: mk('tcache-gdepth', DEPTH_FORMAT, RT),
        color: mk('tcache-color', this.colorFormat, RB),
        pick: mk('tcache-pick', PICK_FORMAT, RB),
        depth: mk('tcache-depth', 'r32float', RB),
      };
      this.profiler.trackMemory('tcache', LW * LH * (16 + 8 + 4 + 4 + 8 + 4));
      const camB = T?.cam ?? dev.createBuffer({ label: 'tcache camera', size: CAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const uni = T?.uni ?? dev.createBuffer({ label: 'tcache uniform', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const srcs = [{ mesh: this.fieldMesh, chunks: this.world.chunks, layers: this.world.layers }];
      if (this.band) srcs.push({ mesh: this.band.mesh, chunks: this.band.chunks, layers: this.band.layers });
      const g0v = tex.g0.createView();
      const g1v = tex.g1.createView();
      T = {
        tex,
        cam: camB,
        uni,
        gGroups: srcs.map((s) => this.meshGroupOf!(camB, this.shadowView, s)),
        rGroups: srcs.map((s) =>
          dev.createBindGroup({ label: 'tcache-resolve', layout: this.meshResolveLayout!, entries: [...this.meshEntries(s, camB), { binding: 40, resource: g0v }, { binding: 41, resource: g1v }] }),
        ),
        comp: makeBindGroup(dev, 'tcache', tcPipes.compLayout, { 0: tex.color.createView(), 1: tex.pick.createView(), 2: tex.depth.createView(), 3: uni }),
        band: this.band,
        m: new Float32Array(16),
        frame: 0,
        w: W,
        h: H,
        slides: 0,
      };
      this.tc = T;
    }
    T.m = f.slice(0, 16);
    T.frame = this.frameNo;
    T.w = W;
    T.h = H;
    T.slides = this.fieldMesh.slides;
    // the layer's camera: the frame's, its clip x and y scaled so the screen sits inside it, a margin round
    const c = new Float32Array(this.camData.slice(0));
    for (const i of [0, 4, 8, 12]) c[i] *= W / LW;
    for (const i of [1, 5, 9, 13]) c[i] *= H / LH;
    dev.queue.writeBuffer(T.cam, 0, c);
  }

  /** (perfopt, tcache) the layer's pipelines, compiled off the main thread (made when ?tcache is first on) */
  private tcPipesBusy?: Promise<void>;
  private tcPipesMake(): Promise<void> {
    if (this.tcPipesBusy) return this.tcPipesBusy;
    const dev = this.device;
    this.tcPipesBusy = (async () => {
      const compLayout = makeLayout(dev, 'tcache', { 0: 'tex', 1: 'utex', 2: 'tex', 3: 'uniform' }, GPUShaderStage.FRAGMENT);
      const module = makeModule(dev, 'tcache', [tcacheWgsl]);
      const [comp, resolve] = await Promise.all([
        dev.createRenderPipelineAsync({
          label: 'tcache-composite',
          layout: dev.createPipelineLayout({ bindGroupLayouts: [compLayout] }),
          vertex: { module, entryPoint: 'vsComp' },
          fragment: { module, entryPoint: 'fsComp', targets: [{ format: this.colorFormat }, { format: PICK_FORMAT }] },
          primitive: { topology: 'triangle-list' },
          depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
        }),
        dev.createRenderPipelineAsync({
          label: 'tcache-resolve',
          layout: dev.createPipelineLayout({ bindGroupLayouts: [this.meshResolveLayout!] }),
          vertex: { module: this.meshModule!, entryPoint: 'vsFull' },
          fragment: { module: this.meshModule!, entryPoint: 'fsMeshResolveC', targets: [{ format: this.colorFormat }, { format: PICK_FORMAT }, { format: 'r32float' }] },
          primitive: { topology: 'triangle-list' },
        }),
      ]);
      this.tcPipes = { compLayout, comp, resolve };
    })();
    return this.tcPipesBusy;
  }

  /** (perfopt, tcache) The terrain into its layer: the G-buffer of the chunks near the view, then the resolve. */
  private encodeTerrainCache(enc: GPUCommandEncoder): void {
    const T = this.tc!;
    const P = this.meshPipes!;
    const g = enc.beginRenderPass({
      label: 'tcache-g',
      colorAttachments: [
        { view: T.tex.g0.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: T.tex.g1.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: T.tex.gd.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.profiler.timestamps('tcache-g'),
    });
    g.setPipeline(Renderer.opts.cull ? P.gBack : P.g);
    g.setBindGroup(0, T.gGroups[0]);
    this.fieldMesh.drawNear(g);
    if (this.band && !SKIP.has('band') && T.gGroups[1]) {
      g.setBindGroup(0, T.gGroups[1]);
      this.band.mesh.drawNear(g);
    }
    g.end();
    const r = enc.beginRenderPass({
      label: 'tcache-resolve',
      colorAttachments: [
        { view: T.tex.color.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: T.tex.pick.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: T.tex.depth.createView(), clearValue: { r: 1, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      timestampWrites: this.profiler.timestamps('tcache-r'),
    });
    r.setPipeline(this.tcPipes!.resolve);
    r.setBindGroup(0, T.rGroups[0]);
    r.draw(3);
    if (this.band && !SKIP.has('band') && T.rGroups[1]) {
      r.setBindGroup(0, T.rGroups[1]);
      r.draw(3);
    }
    r.end();
  }

  /**
   * (perfopt, ?defer=1) The terrain mesh into the G-buffer (meshdraw.wgsl gPack) and the depth: what the
   * resolve shades a pixel at a time. The textures follow the render target's size.
   */
  private encodeGBuffer(enc: GPUCommandEncoder, cam: Camera): { resolve: GPURenderPipeline; groups: GPUBindGroup[] } {
    const depth = this.depth!;
    if (!this.meshDef || this.meshDef.tex[0].width !== depth.width || this.meshDef.tex[0].height !== depth.height) {
      const p = this.meshDef ?? { ...this.meshPipes!, groups: [], tex: [] };
      for (const t of p.tex) t.destroy();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      p.tex = [
        this.device.createTexture({ label: 'gbuf0', size: [depth.width, depth.height], format: 'rgba32uint', usage }),
        this.device.createTexture({ label: 'gbuf1', size: [depth.width, depth.height], format: 'rg32uint', usage }),
      ];
      this.profiler.trackMemory('gbuffer', depth.width * depth.height * 24);
      p.groups = [];
      this.meshDef = p;
    }
    const d = this.meshDef;
    // (the groups: the band's comes and goes — made again when it's missing)
    if (!d.groups.length || d.band !== this.band) {
      d.band = this.band;
      const g0 = d.tex[0].createView();
      const g1 = d.tex[1].createView();
      const mk = (src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }) =>
        this.device.createBindGroup({
          label: 'mesh-resolve',
          layout: this.meshResolveLayout!,
          entries: [
            ...this.meshEntries(src),
            { binding: 40, resource: g0 },
            { binding: 41, resource: g1 },
          ],
        });
      d.groups = [mk({ mesh: this.fieldMesh, chunks: this.world.chunks, layers: this.world.layers })];
      if (this.band) d.groups.push(mk({ mesh: this.band.mesh, chunks: this.band.chunks, layers: this.band.layers }));
    }
    const pass = enc.beginRenderPass({
      label: 'gbuffer',
      colorAttachments: [
        { view: d.tex[0].createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        { view: d.tex[1].createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      timestampWrites: this.profiler.timestamps('gbuffer'),
    });
    pass.setPipeline(cutOn(cam) ? d.gCut : Renderer.opts.cull ? d.gBack : d.g);
    pass.setBindGroup(0, this.meshGroup!);
    this.fieldMesh.draw(pass);
    if (this.band && !SKIP.has('band')) {
      // (perfopt, ?bandcull=1: the band's faces turned from the eye culled — the land over and under the window seen
      // from outside, its undersides and insides never; not with the cut, which opens them)
      if (Renderer.opts.bandcull && !cutOn(cam)) pass.setPipeline(d.gBack);
      pass.setBindGroup(0, this.bandGroup!);
      this.band.mesh.draw(pass);
    }
    pass.end();
    return d;
  }

  /**
   * The sun's view: an orthographic box round the whole map (it's small
   * enough for one map) looking along the light, into both cameras — the
   * view's, to look shadows up, and the sun's own, to draw them.
   */
  /** (returns whether the shadow map is drawn this frame — perfopt's shadowEvery — and with shadowCache whether
   *  its static casters are: 'all', 'moving' (the cache copied in, the moving casters over it) or false) */
  private writeLight(sun: [number, number, number]): 'all' | 'moving' | false {
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
    // (perfopt, ?shadowevery=N: between redraws the map and the matrix it was drawn with are kept — the lookups
    // stay consistent while the camera moves; a slide (the land moved under the window's coordinates) or a new box
    // draws it at once)
    const sc = Math.max(0, Renderer.opts.shadowCache | 0);
    const se = sc > 1 ? sc : Math.max(1, Renderer.opts.shadowEvery | 0);
    const S = this.shadowAt;
    const rect = `${x0},${y0},${x1},${y1}`;
    if (se > 1 && this.frameNo - S.frame < se && S.rect === rect && S.slides === this.fieldMesh.slides && S.cached === sc > 1) {
      cf.set(S.m, CAMERA_BYTES / 4);
      cf[23] = S.bias;
      return sc > 1 ? 'moving' : false;
    }
    this.shadowAt = { m, bias: 0.25 * sz, frame: this.frameNo, rect, slides: this.fieldMesh.slides, cached: sc > 1 };
    cf.set(m, CAMERA_BYTES / 4);
    this.fieldMesh.castCull(m);
    // the lookup's depth bias: a quarter of a cell along the light
    cf[23] = 0.25 * sz;
    // the sun's own camera: its matrix as the view, looking from the sun
    const lf = new Float32Array(this.lightCamData);
    lf.set(cf);
    lf.set(m, 0);
    lf.set([-f[0], -f[1], -f[2], cf[19]], 16);
    // (round 82: no cutaway from the sun — what's cut still casts)
    lf.fill(0, CAMERA_CUT_OFFSET / 4, (CAMERA_CUT_OFFSET + CAMERA_CUT_BYTES) / 4);
    this.device.queue.writeBuffer(this.lightCamBuf, 0, this.lightCamData);
    return 'all';
  }

  /** The sun's shadow map: every built mesh chunk, the prisms, plants, structures and bodies, depth only. */
  private encodeShadow(enc: GPUCommandEncoder, due: 'all' | 'moving'): void {
    const g = this.shadowGroups!;
    // (perfopt, ?shadowcache=N: the static casters into their own map every Nth frame, copied in every frame)
    const cache = Renderer.opts.shadowCache > 1;
    if (cache && (!this.shadowStatic || this.shadowStatic.width !== this.shadowTex.width)) {
      this.shadowStatic?.destroy();
      this.shadowStatic = this.device.createTexture({ label: 'shadow-static', size: [this.shadowTex.width, this.shadowTex.height], format: SHADOW_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      due = 'all';
    }
    const statics = (pass: GPURenderPassEncoder) => {
      pass.setPipeline(Renderer.opts.cull ? this.shadowMeshCullPipe! : this.shadowMeshPipe!);
      pass.setBindGroup(0, g.mesh);
      this.fieldMesh.drawCasters(pass);
      pass.setPipeline(this.shadowOpaquePipe!);
      pass.setBindGroup(0, g.opaque);
      pass.drawIndirect(this.indirect, 0);
      pass.setBindGroup(0, g.tops);
      pass.drawIndirect(this.indirect, 48);
    };
    if (cache && due === 'all') {
      const sp = enc.beginRenderPass({
        label: 'shadow-static',
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowStatic!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
        timestampWrites: this.profiler.timestamps('shadow-static'),
      });
      statics(sp);
      sp.end();
    }
    if (cache) enc.copyTextureToTexture({ texture: this.shadowStatic! }, { texture: this.shadowTex }, [this.shadowTex.width, this.shadowTex.height]);
    const pass = enc.beginRenderPass({
      label: 'shadow',
      colorAttachments: [],
      depthStencilAttachment: { view: this.shadowView, depthClearValue: 1, depthLoadOp: cache ? 'load' : 'clear', depthStoreOp: 'store' },
      timestampWrites: this.profiler.timestamps('shadow'),
    });
    if (!cache) statics(pass);
    pass.setPipeline(this.shadowOpaquePipe!);
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
  /**
   * (round 83) The streamed window moved by (dcx, dcy) mesh chunks, its vertices translated by t (world units):
   * what's drawn from the window follows — the meshes (the window's and the band's), the shore field.
   * dcx 1 << 12: every chunk made again (a warp).
   */
  windowMoved(dcx: number, dcy: number, t: [number, number, number]): void {
    this.fieldMesh.shift(dcx, dcy, t);
    this.band?.mesh.shift(dcx, dcy, t);
    this.shore.dirty();
  }

  /** (hybrid) the mesh chunks wanted (FieldMesh.setWanted): the window's and the band's, the same grid */
  private meshWant: Uint8Array | null = null;
  /**
   * (hybrid, ?hybrid=1) Which of the window's mesh chunks are voxels — built and drawn by the field mesh and the
   * band's — per chunk (fieldMesh.chunkGrid's order), or null for all; the rest are the LOD rings' (far.wgsl).
   */
  setMeshWanted(want: Uint8Array | null): void {
    this.meshWant = want ? want.slice() : null;
    this.fieldMesh.setWanted(want);
    this.band?.mesh.setWanted(want);
  }

  private edgesOpen = false;
  /** (round 83) the nearest shore to every column (render/shore.ts): made every second, and after the window moves */
  readonly shore: ShoreField;
  /** (round 83) no mesh made while set: a streamed window's slide is writing its land (Streamer.busy) */
  holdMesh = false;

  /**
   * (round 83) The window's edge open (FieldMesh.openEdges): no wall down it — for a streamed window with
   * land drawn past its edge (the atlas's rings), which covers what the open edge shows under the ground.
   */
  openEdges(): void {
    this.edgesOpen = true;
    this.fieldMesh.openEdges();
    this.band?.mesh.openEdges();
  }

  enableBand(zSpan: number): OutsideBand | undefined {
    if (!this.fieldMesh.on || !this.meshGroupOf || this.band) return this.band;
    this.band = new OutsideBand(this.device, this.world, this.profiler, zSpan, Math.min(3, this.meshSlots ?? 3));
    if (this.edgesOpen) this.band.mesh.openEdges();
    if (this.meshWant) this.band.mesh.setWanted(this.meshWant);
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

/** (round 83) is anything cut from the camera's view (a slice, a hole round a point kept seen)? */
function cutOn(cam: Camera): boolean {
  return cam.cut.slice !== null || cam.cut.see.length > 0;
}
