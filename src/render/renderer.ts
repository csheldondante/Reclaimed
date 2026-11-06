// Renderer: render-preparation compute pass (world → box instances) followed
// by one render pass (opaque boxes, translucent water, rain streaks).
// Renders directly from the canonical representation; no meshing/LOD yet
// (design doc §14: one straightforward path until profiling says otherwise).

import { ignoreTeardown, makeBindGroup, makeCompute, makeLayout, makeModule, renderPipe, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import renderprepWgsl from '../shaders/renderprep.wgsl?raw';
import vegplanWgsl from '../shaders/vegplan.wgsl?raw';
import terrainShapeWgsl from '../shaders/terrainshape.wgsl?raw';
import vegprepWgsl from '../shaders/vegprep.wgsl?raw';
import { renderWgsl } from '../shaders/render';
import rainWgsl from '../shaders/rain.wgsl?raw';
import particlesDrawWgsl from '../shaders/particles_draw.wgsl?raw';
import gridsWgsl from '../shaders/grids.wgsl?raw';
import structPrepWgsl from '../shaders/structprep.wgsl?raw';
import { StructureGpu } from '../structures/gpu';
import meshRegionWgsl from '../shaders/meshregion.wgsl?raw';
import meshStateWgsl from '../shaders/meshstate.wgsl?raw';
import type { CoverSource } from '../weather/cover';
import { TileCache } from './tilecache';
import type { TileLandSource } from './tileland';
import { TileLandGpu } from './tilelandgpu';
import { FieldMesh } from './fieldmesh';
import { POOL_VOXELS } from '../grids/structures';
import { riverMode, type WorldGpu } from '../sim/world-gpu';
import { ShoreField } from './shore';
import { WaterSurface } from './watersurf';
import { type Camera } from './camera';
import { OutsideBand } from './band';
import { RockMesh } from './rockmesh';
import meshInstWgsl from '../shaders/meshinst.wgsl?raw';
import floraLookWgsl from '../shaders/floralook.wgsl?raw';
import floraPutWgsl from '../shaders/floraput.wgsl?raw';
import floraFieldWgsl from '../shaders/florafield.wgsl?raw';
import { MeshInstances, MI_ARGS_WORD } from './meshinst';
import { treeKinds } from './treemesh';
import { MESHINST } from '../sim/external';
import { FLORA } from '../flora/flags';
import { FloraLibrary, GAME_LIBRARY } from '../flora/library';
import { BGCHECK, BgCheck } from './bgcheck';
import { encode, encodeCeiling } from './renderer/encode';
import { drawGrid, windowDrawn, windowMoved } from './renderer/grid';
import { enableBand, enableRockMesh, enableStructures } from './renderer/features';
import { CAM_BYTES, SHADOW_SIZE, SHADOW_FORMAT, VEG_INSTANCES, INST_GROW, INST_START, INST_GROW_AT, PICK_FORMAT, PickHit, DEPTH_FORMAT, RenderOptions, DETAIL_BITS, SKIP } from './renderer/defs';
export { SKIP } from './renderer/defs';
export type { PickHit, RenderOptions } from './renderer/defs';
import { buildMeshDraws } from './renderer/mesh-draws';

// (round 117, structures: the city's pieces — src/structures/gpu.ts, shaders/structmesh.wgsl + structgame.wgsl)
// (round 113, step 5.1: what the mesh's look reads of the land — the window's; a region's height grid gives its own)

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
  prep: ComputeKernel;
  prepGroup: GPUBindGroup;
  vegPrep: ComputeKernel;
  vegPrepGroup: GPUBindGroup;
  /** (round 117, flora) plants placed by other fields (florafield.wgsl: reeds by water), after vegprep */
  floraField?: ComputeKernel;
  floraFieldGroup?: GPUBindGroup;
  opaquePipe!: GPURenderPipeline;
  blendPipe!: GPURenderPipeline;
  /** (?skip=waterflat) the water's geometry with a flat fragment: a measuring aid */
  waterFlatPipe!: GPURenderPipeline;
  /** (watersurf, FC2) with the field mesh: the water drawn as one surface (render/watersurf.ts), not prisms */
  readonly waterSurf?: WaterSurface;
  waterSurfPipe?: GPURenderPipeline;
  rainPipe!: GPURenderPipeline;
  partPipe!: GPURenderPipeline;
  partGroup: GPUBindGroup;
  opaqueGroup: GPUBindGroup;
  plantGroup: GPUBindGroup;
  topsGroup: GPUBindGroup;
  /** First instance of the tops list in instOpaque. */
  topsBase: number;
  blendGroup: GPUBindGroup;
  /** rigid bodies (F7): rotated voxels, 2 × vec4<u32> each (render.wgsl vsBody) */
  bodyBuf: GPUBuffer;
  bodyGroup: GPUBindGroup;
  bodyPipe!: GPURenderPipeline;
  /** meshes over physics bodies (render.wgsl vsSkin) */
  skinPipe!: GPURenderPipeline;
  shadowSkinPipe?: GPURenderPipeline;
  meshSources: { indirect: GPUBuffer; group: GPUBindGroup; shadow?: GPUBindGroup }[] = [];
  /** the structure grids' exposed voxels, as rotated cubes (structprep.wgsl → the body pipeline) */
  structPrep: ComputeKernel;
  structPrepGroup: GPUBindGroup;
  structInst: GPUBuffer;
  structIndirect: GPUBuffer;
  structGroup: GPUBindGroup;
  /** the field mesh (G13 h: ?mesh=1) */
  readonly fieldMesh: FieldMesh;
  meshPipe?: GPURenderPipeline;
  /** (perfopt, ?prepass=1) the mesh's depth-only pipelines (no cut, cut) and its look tested less-equal, made on first use */
  meshPre?: { z: GPURenderPipeline; zCut: GPURenderPipeline; look: GPURenderPipeline };
  meshPreMake?: () => { z: GPURenderPipeline; zCut: GPURenderPipeline; look: GPURenderPipeline };
  /** (perfopt, ?defer=1) the G-buffer pipelines (no cut, cut), the resolve, its groups (window, band), made on first use */
  meshDef?: { g: GPURenderPipeline; gBack: GPURenderPipeline; gCut: GPURenderPipeline; resolve: GPURenderPipeline; groups: GPUBindGroup[]; tex: GPUTexture[]; band?: OutsideBand };
  meshEntries!: (src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }, cam?: GPUBuffer) => GPUBindGroupEntry[];
  /** (perfopt, ?tcache=N) the terrain's cached layer: its textures (a margin past the screen), its camera, groups,
   *  and what it was drawn with (the camera's matrix, the frame, the size, the slides) */
  tc?: {
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
  tcPipes?: { resolve: GPURenderPipeline; comp: GPURenderPipeline; compLayout: GPUBindGroupLayout };
  meshPipes?: { g: GPURenderPipeline; gBack: GPURenderPipeline; gCut: GPURenderPipeline; resolve: GPURenderPipeline };
  meshModule?: GPUShaderModule;
  /**
   * (round 99, ?meshinst=1) the instanced meshes (render/meshinst.ts): the trees, one indexed draw a species, their
   * instances written by the vegetation pass; their pipelines and groups (the view's and the sun's)
   */
  meshInst?: MeshInstances;
  /** (round 117, flora) the generated plant library drawn through meshInst (null with ?flora=0) */
  flora?: FloraLibrary;
  floraWgsl = '';
  miPipe?: GPURenderPipeline;
  miGroup?: GPUBindGroup;
  miShadowPipe?: GPURenderPipeline;
  miShadowGroup?: GPUBindGroup;
  /** (round 117, structures) the city's pieces (enableStructures): drawn as the trees are, in the world and shadow passes */
  structs?: { sg: StructureGpu; pipe?: GPURenderPipeline; shadow?: GPURenderPipeline; glow?: GPURenderPipeline; group?: GPUBindGroup; shadowGroup?: GPUBindGroup; version: number; lod: boolean };
  /** (round 120, cities) how dark it is (the day/night's night, 0..1: Globals sky.w), set by the scene each frame — the
   *  towns' light pools are drawn only when it's past dusk */
  structNight = 0;
  /**
   * (round 117, STR10) the zoom (screen pixels a cell) under which the city's pieces draw their far look: the camera is
   * orthographic, so one zoom says how small every piece is; `?structlod=` to tune (0: always full, 99: always far)
   */
  structLodZoom = Number(new URLSearchParams(location.search).get('structlod') ?? 7);
  /** the draw pipelines' layout (render.wgsl's), for draws enabled after construction */
  drawPl!: GPUPipelineLayout;
  /** (round 95, ?rockbody=1) the rigid rock's own mesh (enableRockMesh), its pipeline and group */
  rockMesh?: RockMesh;
  rockPipe?: GPURenderPipeline;
  rockGroup?: GPUBindGroup;
  rockPoolSeen = -1;
  makeRockDraw?: (rm: RockMesh) => { pipe: GPURenderPipeline; group: (cam?: GPUBuffer, shadow?: GPUTextureView) => GPUBindGroup; shadow: GPURenderPipeline };
  /** (round 99) the rock's mesh into the sun's shadow map (the resting rock has no cubes to cast it) */
  rockShadowPipe?: GPURenderPipeline;
  rockShadowGroup?: GPUBindGroup;
  rockGroupOf?: (cam?: GPUBuffer, shadow?: GPUTextureView) => GPUBindGroup;
  /** (solver step 2) the node solver's buffers the rock mesh is skinned to (setRockNodes) */
  rockNodes?: { pose: GPUBuffer; lanes: GPUBuffer };
  /** (round 95) of the body voxels, the first this many are drawn (the rest only cast shadows: the rigid rock's, its mesh drawn) */
  bodyShown = 0;
  meshResources!: (cam: GPUBuffer, shadow: GPUTextureView, src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }) => Record<number, GPUBuffer | GPUTextureView | GPUSampler>;
  /** (perfopt) the deferred pipelines, compiled off the main thread from the start (createRenderPipelineAsync): the
   *  terrain draws forward until they're in — compiled on first use they froze the frame ~1.5 s after a load */
  meshPipesReady?: Promise<void>;
  /** the pipelines compiled off the main thread, in (a scene awaits it while it loads: WorldCore.warmup) */
  ready(): Promise<void> {
    return this.meshPipesReady ?? Promise.resolve();
  }
  meshResolveLayout?: GPUBindGroupLayout;
  /** (round 86, the hybrid) the grid's pipelines (G-buffer, with the cut, forward, the sun's) and its lattice's
   *  triangles (one chunk's: drawn with each chunk's base vertex) */
  gridPipes?: { g: GPURenderPipeline; gCut: GPURenderPipeline; fwd: GPURenderPipeline; shadow: GPURenderPipeline; index: GPUBuffer; count: number };
  /** (round 86) per mesh chunk: the grid draws it, the lowest and highest of its tops (window z); null: none */
  gridOn: { on: Uint8Array; lo: Float32Array; hi: Float32Array } | null = null;
  /** per mesh chunk: the grid's in view, near it (the terrain cache's margin), in the sun's box */
  gridView = new Uint8Array(0);
  gridNear = new Uint8Array(0);
  gridCasts = new Uint8Array(0);
  /** grid chunks drawn last frame */
  gridDrawn = 0;
  /** further opaque draws in the world pass, with the sky's colour (round 73: the atlas's far land) */
  readonly extraDraws: ((pass: GPURenderPassEncoder, clear: [number, number, number]) => void)[] = [];
  /** what an extra draw renders into, and the camera it reads (render.wgsl Camera) */
  get targets(): { format: GPUTextureFormat; pickFormat: GPUTextureFormat; depthFormat: GPUTextureFormat; camera: GPUBuffer; mesh?: { state: GPUBuffer; grid: [number, number, number] }; tileMask: GPUBuffer } {
    // (round 83: the field mesh's state, when it draws the ground — far.ts's rings fill the chunks not built yet)
    const mesh = this.fieldMesh.on ? { state: this.fieldMesh.stateBuffer, grid: this.fieldMesh.chunkGrid } : undefined;
    return { format: this.colorFormat, pickFormat: PICK_FORMAT, depthFormat: DEPTH_FORMAT, camera: this.camBuf, mesh, tileMask: this.tiles?.mask ?? this.tileMaskNone };
  }
  /** (round 103, ?tiles=1) the tile cache: the land past the window drawn from tiles (render/tilecache.ts) */
  tiles?: TileCache;
  /** (no tiles: the rings' mask, off — far.wgsl tiled) */
  tileMaskNone: GPUBuffer;
  /** (round 103) The streamed window's cell (0, 0) in the world (cells, rows) and its oz: the tiles' anchors. */
  setTileOrigin(ox: number, oy: number, oz: number): void {
    this.tiles?.setOrigin(ox, oy, oz);
  }
  /** (round 104, TC2) What makes the land past the window (the streamer's): the tiles' render-only regions. */
  setTileLand(src: TileLandSource): void {
    if (!this.tiles || this.tiles.land || !this.tileBakeLayout || !this.meshLayoutT) return;
    this.tiles.land = new TileLandGpu(
      {
        device: this.device,
        world: this.world,
        profiler: this.profiler,
        meshLayout: this.meshLayoutT,
        resolveLayout: this.tileBakeLayout!,
        gridPipe: () => this.gridPipes?.g,
        drawGrid: (pass, which) => void drawGrid(this, pass, which),
        meshResources: (cam) => this.meshResources(cam, this.shadowView, { mesh: this.fieldMesh, chunks: this.world.chunks, layers: this.world.layers }),
        camBytes: CAM_BYTES,
        camData: () => this.camData,
        seedCover: (enc, w, side, lo, hi) => this.coverSeed?.(enc, w, side, lo, hi),
      },
      src,
      this.tiles,
    );
  }
  /** (round 108, TC20) the weather's cover seeded from a render-only tile's land as it's made (world-core.ts: the
   *  simulation's WeatherCoverSystem.seed) */
  coverSeed?: (enc: GPUCommandEncoder, src: CoverSource, side: number, lo: number, hi: number) => void;
  /** (round 108) the tiles' bake's resolve layout: the mesh's and the held rivers' table (22) */
  tileBakeLayout?: GPUBindGroupLayout;
  /** (round 104) the mesh's draw layout (the render-only land's groups) */
  meshLayoutT?: GPUBindGroupLayout;
  meshGroup?: GPUBindGroup;
  /** the band outside the window (round 79, enableBand): its draw group */
  band?: OutsideBand;
  bandGroup?: GPUBindGroup;
  meshGroupOf?: (cam: GPUBuffer, shadow: GPUTextureView, src: { mesh: FieldMesh; chunks: GPUBuffer; layers: GPUBuffer }) => GPUBindGroup;
  bodyCount = 0;
  static readonly MAX_BODY_VOXELS = 16384;
  rainGroup: GPUBindGroup;
  instOpaque: GPUBuffer;
  instPlant: GPUBuffer;
  instBlend: GPUBuffer;
  readonly indirect: GPUBuffer;
  camBuf: GPUBuffer;
  camData = new ArrayBuffer(CAM_BYTES);
  /** the sun's view for the shadow pass (the same layout: its viewProj is the light's) */
  lightCamBuf: GPUBuffer;
  lightCamData = new ArrayBuffer(CAM_BYTES);
  shadowTex: GPUTexture;
  shadowView: GPUTextureView;
  shadowSampler: GPUSampler;
  shadowOpaquePipe?: GPURenderPipeline;
  shadowBodyPipe?: GPURenderPipeline;
  shadowMeshPipe?: GPURenderPipeline;
  /** (perfopt, ?cull=1) the mesh into the sun's map, the faces turned from the sun culled */
  shadowMeshCullPipe?: GPURenderPipeline;
  /** more voxel instances drawn like the structures' (physics bodies): instances, indirect args, and their draw and shadow groups */
  voxelSources: { indirect: GPUBuffer; group: GPUBindGroup; shadow?: GPUBindGroup }[] = [];
  /** more prisms for the opaque pipeline (lava: sim/lava.ts) */
  prismSources: { indirect: GPUBuffer; group: GPUBindGroup }[] = [];
  /** (?flow=1) more for the water pipeline: liquid runs under rock, falling streams (flow/liquid.ts) */
  blendSources: { indirect: GPUBuffer; group: GPUBindGroup }[] = [];
  noShadowView?: GPUTextureView;
  groupFor!: (inst: GPUBuffer | GPUBufferBinding, cam?: GPUBuffer, shadow?: GPUTextureView) => GPUBindGroup;
  shadowGroups?: { opaque: GPUBindGroup; tops: GPUBindGroup; plants: GPUBindGroup; struct: GPUBindGroup; bodies: GPUBindGroup; mesh: GPUBindGroup };
  /** ?smooth=0: tops lit flat, a hexagon at a time (the look before G13). */
  flatTops = new URLSearchParams(location.search).get('smooth') === '0';
  depth?: GPUTexture;
  pickTex?: GPUTexture;
  /** (round 112, ?bgcheck=1 only: the share of the screen showing the background or the far land — bgcheck.ts) */
  readonly bgCheck?: BgCheck;
  pickBuf: GPUBuffer;
  pickBusy = false;
  pickRequest?: { x: number; y: number; resolve: (hit: PickHit | null) => void };
  pickPending?: (hit: PickHit | null) => void;
  opaqueCapacity: number;
  /** (round 93) the plant and blended lists' room (instances) */
  plantCapacity = 0;
  blendCapacity = 0;
  /** (round 93, instgrow) the lists' room asked for by the last count readback (0: none), and how often they grew */
  instGrowTo = { opaque: 0, plant: 0, blend: 0 };
  instGrown = 0;
  /** the raw counts asked for (before the clamp), last read */
  instAsked = { opaque: 0, blend: 0, plants: 0 };
  clampB!: ComputeKernel;
  clampV!: ComputeKernel;
  clampBGroup!: GPUBindGroup;
  clampVGroup!: GPUBindGroup;
  prepEntries!: () => Record<number, GPUBuffer | GPUTextureView>;
  vegEntries!: () => Record<number, GPUBuffer | GPUTextureView>;
  /** Last-known instance counts (async readback, for the perf overlay). */
  instanceCounts = { opaque: 0, blend: 0, tops: 0, prisms: 0, plants: 0 };
  /** frames, for the window's and the band's mesh turns (round 82) */
  meshTurn = 0;
  /** (perfopt, shadowEvery) the light matrix and lookup bias the shadow map holds, when it was drawn, the box, the slides */
  shadowAt = { m: new Float32Array(16), bias: 0, frame: -1e9, rect: '', slides: -1, cached: false };
  /** (perfopt, shadowCache) the static casters' depth, copied into the sun's map each frame */
  shadowStatic?: GPUTexture;
  /** (perfopt, prepEvery) when the instance lists were last made, and the slides then */
  prepAt = { frame: -1e9, slides: -1 };
  frameNo = 0;
  countBuf: GPUBuffer;
  countBusy = false;
  countNeeded = false;

  constructor(
    public device: GPUDevice,
    public colorFormat: GPUTextureFormat,
    public world: WorldGpu,
    public profiler: Profiler,
    /** the field mesh unless ?mesh=0, rather than only with ?mesh=1 */
    meshByDefault = false,
    /** the sun's shadow map's side (texels; quality `shadowSize`): it covers the chunks near the view */
    shadowSize = SHADOW_SIZE,
    /** the field mesh's room a chunk, times its default */
    meshRoom = 1,
    /** field mesh chunks rebuilt a frame (quality `meshSlots`; round 81) */
    public meshSlots?: number,
    /** (round 117, flora) render pixels a CSS pixel (the tier's dpr cap × render scale): the plants' detail is made
     *  for it (src/flora/generate.ts px) and their grass thins by it */
    public floraRpx = 1,
  ) {
    const N = world.cells;
    // (round 83) the nearest shore to every column: the water's swell (render.wgsl shoreTex)
    this.shore = new ShoreField(device, world, world.w, world.h);
    // column intervals and the loose sheet (hex prisms); plants (boxes) apart,
    // drawn with fewer vertices
    // (round 93, instgrow: a tenth of each worst case to start, grown as asked)
    const f = INST_GROW ? INST_START : 1;
    this.opaqueCapacity = Math.ceil(N * (world.maxK + 1) * f);
    // + the tops list after it (renderprep.wgsl: two per column at most), from
    // a storage-offset-aligned instance (256 bytes)
    this.topsBase = Math.ceil(this.opaqueCapacity / 16) * 16;
    this.instOpaque = world.buf('instOpaque', (this.topsBase + 2 * N) * 16, GPUBufferUsage.STORAGE);
    this.plantCapacity = Math.ceil(N * VEG_INSTANCES * f);
    this.instPlant = world.buf('instPlant', this.plantCapacity * 16, GPUBufferUsage.STORAGE);
    // up to four blended boxes per column: water, oil, two see-through solids (renderprep.wgsl GLASS_MAX)
    this.blendCapacity = Math.ceil(N * 4 * f);
    this.instBlend = world.buf('instBlend', this.blendCapacity * 16, GPUBufferUsage.STORAGE);
    // draw args: [0..3] opaque prisms, [4..7] water, [8..11] plants, [12..15]
    // tops alone; [16] where the tops start in instOpaque (renderprep.wgsl); (round 93) [20..22] the prisms',
    // water's and plants' counts before they were held to their lists' room; (round 99, meshinst) [24..] the
    // instanced meshes' indexed draws, five words a kind
    // (round 117, flora: the library's kinds — dozens, not four — each its five words)
    const miKinds = FLORA ? (this.flora ??= new FloraLibrary(GAME_LIBRARY, 12 * this.floraRpx)).kinds.length : 4;
    this.indirect = world.buf(
      'indirect',
      MI_ARGS_WORD * 4 + 4 * 5 * miKinds,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    this.camBuf = world.buf('camera', CAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.lightCamBuf = world.buf('lightCamera', CAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.pickBuf = world.buf('pick', 256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.countBuf = world.buf('counts', 96, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.tileMaskNone = device.createBuffer({ label: 'tiles mask none', size: 16, usage: GPUBufferUsage.STORAGE });

    const format = this.colorFormat;
    this.fieldMesh = new FieldMesh(device, world, profiler, meshByDefault, meshRoom, undefined, meshSlots);
    // (a texel when there's no shadow pass: the draw shaders still bind one)
    const ss = this.fieldMesh.on ? shadowSize : 1;
    this.shadowTex = device.createTexture({ label: 'shadow', size: [ss, ss], format: SHADOW_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.shadowView = this.shadowTex.createView();
    this.shadowSampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    profiler.trackMemory('shadow', ss * ss * 4);
    // (?skip=cull: every column, as before the view culling)
    // (watersurf: with the field mesh the water is a surface — render/watersurf.ts — and renderprep's blended list holds
    // only the oil and the see-through solids; without it, as before, a prism a wet column)
    const cullOff = `const CULL_OFF: bool = ${SKIP.has('cull')};
const WATER_BOXES: bool = ${!this.fieldMesh.on};`;
    if (this.fieldMesh.on) this.waterSurf = new WaterSurface(device, world, profiler, this.camBuf);
    const prepSpec = {
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
    } as const;
    this.prep = makeCompute(device, 'renderprep', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, cullOff, renderprepWgsl], prepSpec);
    // (round 93: and the blended list's clamp, after it — renderprep.wgsl clampBlend)
    this.clampB = makeCompute(device, 'renderprep-clamp', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, cullOff, renderprepWgsl], prepSpec, 'clampBlend');
    this.prepEntries = () => ({
      0: world.globals,
      1: world.chunks,
      2: world.materials,
      3: world.layers,
      4: world.surface,
      5: world.water,
      6: world.oil,
      7: this.instOpaque,
      8: this.instBlend,
      9: this.indirect,
      14: world.cornerView,
      17: world.driftView,
      21: world.bodyProjView,
      30: this.fieldMesh.region,
      31: this.camBuf,
    });
    this.prepGroup = makeBindGroup(device, 'renderprep', this.prep.layout, this.prepEntries());
    this.clampBGroup = makeBindGroup(device, 'renderprep-clamp', this.clampB.layout, this.prepEntries());

    // (perfopt, ?tufts=0: the grass tufts left out — most of the plant boxes, each under a pixel at low)
    const tufts = `const TUFTS: bool = ${new URLSearchParams(location.search).get('tufts') !== '0'};`;
    // (round 99, ?meshinst=1) the trees as instanced meshes: their instances written by vegprep (binding 10)
    // (round 117, flora: on unless ?flora=0) the flora library's generated species are the plants' meshes
    // (src/flora/library.ts): its kinds in the same renderer, its constants (each species' kinds, colours) for the kernels
    if (FLORA) {
      this.flora ??= new FloraLibrary(GAME_LIBRARY, 12 * this.floraRpx);
      // (round 119: 4096 a kind — ~45 kinds; the view cull keeps a kind's on-screen count far under it)
      this.meshInst = new MeshInstances(device, this.flora.kinds, (l, n, u) => world.buf(l, n, u), 4096);
    } else if (MESHINST) this.meshInst = new MeshInstances(device, treeKinds(), (l, n, u) => world.buf(l, n, u));
    this.floraWgsl = `const FLORA: bool = ${!!this.flora};\nconst FLORA_RPX: f32 = ${this.floraRpx.toFixed(3)};\n${this.flora ? this.flora.wgsl() : FloraLibrary.stubWgsl()}`;
    const treeMesh = `const TREE_MESH: bool = ${!!this.meshInst};\n${this.meshInst ? this.meshInst.wgsl() : 'const MI_CAP: u32 = 0u;\nconst MI_N: u32 = 1u;\nconst MI_ARGS: u32 = 24u;\n'}${this.floraWgsl}`;
    const noTrees = this.meshInst ? undefined : world.buf('meshinst none', 64, GPUBufferUsage.STORAGE);
    const vegSpec = {
      0: 'uniform',
      2: 'uniform',
      3: 'read',
      4: 'read',
      5: 'rw',
      6: 'rw',
      7: 'read',
      8: 'read',
      9: 'rw',
      10: 'rw',
      14: 'tex',
      17: 'tex',
      30: 'uniform',
      // (round 117, flora: the view, to leave out plants off screen — renderprep's PrepCam)
      31: 'uniform',
    } as const;
    this.vegPrep = makeCompute(device, 'vegprep', [commonWgsl, materialsWgsl, vegplanWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, tufts, treeMesh, floraPutWgsl, vegprepWgsl], vegSpec);
    this.clampV = makeCompute(device, 'vegprep-clamp', [commonWgsl, materialsWgsl, vegplanWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, tufts, treeMesh, floraPutWgsl, vegprepWgsl], vegSpec, 'clampVeg');
    this.vegEntries = () => ({
      0: world.globals,
      2: world.materials,
      3: world.surface,
      4: world.veg,
      5: this.instOpaque,
      6: this.indirect,
      7: world.wilt,
      8: world.petals,
      9: this.instPlant,
      10: this.meshInst?.instances ?? noTrees!,
      14: world.cornerView,
      17: world.driftView,
      30: this.fieldMesh.region,
      31: this.camBuf,
    });
    this.vegPrepGroup = makeBindGroup(device, 'vegprep', this.vegPrep.layout, this.vegEntries());
    this.clampVGroup = makeBindGroup(device, 'vegprep-clamp', this.clampV.layout, this.vegEntries());
    if (this.flora && this.meshInst) {
      const ffSpec = { 0: 'uniform', 2: 'uniform', 3: 'read', 4: 'read', 6: 'rw', 10: 'rw', 11: 'read', 12: 'read', 14: 'tex', 17: 'tex', 30: 'uniform', 31: 'uniform' } as const;
      this.floraField = makeCompute(device, 'florafield', [commonWgsl, materialsWgsl, terrainShapeWgsl, meshStateWgsl, meshRegionWgsl, treeMesh, floraPutWgsl, floraFieldWgsl], ffSpec);
      this.floraFieldGroup = makeBindGroup(device, 'florafield', this.floraField.layout, {
        0: world.globals,
        2: world.materials,
        3: world.surface,
        4: world.veg,
        6: this.indirect,
        10: this.meshInst.instances,
        11: world.moisture,
        12: world.water,
        14: world.cornerView,
        17: world.driftView,
        30: this.fieldMesh.region,
        31: this.camBuf,
      });
    }

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
    // (round 84, ?rivers=table: foam by the water's speed — render.wgsl fsWater)
    const riverFoam = `const RIVER_FOAM_SPEED: bool = ${riverMode() === 'table'};\n`;
    const drawModule = makeModule(device, 'render', [commonWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, renderWgsl]);
    const pl = device.createPipelineLayout({ bindGroupLayouts: [drawLayout] });
    this.drawPl = pl;
    const depthStencil = (write: boolean): GPUDepthStencilState => ({
      format: DEPTH_FORMAT,
      depthWriteEnabled: write,
      depthCompare: 'less',
    });
    const blend: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    renderPipe(device, {
      label: 'opaque',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsBox' },
      fragment: { module: drawModule, entryPoint: 'fsBox', targets: [{ format }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(true),
    }, (p) => (this.opaquePipe = p));
    renderPipe(device, {
      label: 'blended',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsWater' },
      fragment: { module: drawModule, entryPoint: 'fsWater', targets: [{ format, blend }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(false),
    }, (p) => (this.blendPipe = p));
    if (this.waterSurf)
      renderPipe(device, {
        label: 'water-surface',
        layout: pl,
        vertex: { module: drawModule, entryPoint: 'vsWaterSurf' },
        fragment: { module: drawModule, entryPoint: 'fsWaterSurf', targets: [{ format, blend }, { format: PICK_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthStencil(false),
      }, (p) => (this.waterSurfPipe = p));
    renderPipe(device, {
      label: 'water-flat',
      layout: pl,
      vertex: { module: drawModule, entryPoint: this.waterSurf ? 'vsWaterSurf' : 'vsWater' },
      fragment: { module: drawModule, entryPoint: 'fsWaterFlat', targets: [{ format, blend }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(false),
    }, (p) => (this.waterFlatPipe = p));

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
    this.blendGroup = groupFor(this.instBlend);
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
    renderPipe(device, {
      label: 'bodies',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsBody' },
      fragment: { module: drawModule, entryPoint: 'fsBody', targets: [{ format }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(true),
    }, (p) => (this.bodyPipe = p));

    renderPipe(device, {
      label: 'skins',
      layout: pl,
      vertex: { module: drawModule, entryPoint: 'vsSkin' },
      fragment: { module: drawModule, entryPoint: 'fsBody', targets: [{ format }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(true),
    }, (p) => (this.skinPipe = p));

    // (round 99, ?meshinst=1) the instanced meshes: render.wgsl's bindings and look, their own vertex stage
    const miVertex = (module: GPUShaderModule): GPUVertexState => ({
      module,
      entryPoint: 'vsInst',
      buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    });
    const miModule = this.meshInst ? makeModule(device, 'meshinst', [commonWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, this.meshInst.wgsl(), this.floraWgsl, renderWgsl, floraLookWgsl, meshInstWgsl]) : undefined;
    if (this.meshInst && miModule) {
      renderPipe(device, {
        label: 'meshinst',
        layout: pl,
        vertex: miVertex(miModule),
        fragment: { module: miModule, entryPoint: 'fsInst', targets: [{ format }, { format: PICK_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthStencil(true),
      }, (p) => (this.miPipe = p));
      this.miGroup = groupFor(this.meshInst.instances);
    }

    if (this.fieldMesh.on) {
      buildMeshDraws(this, { format, tufts, VF, drawLayout, riverFoam, drawModule, pl, depthStencil, groupFor, miVertex, miModule });
    }

    const rainLayout = makeLayout(device, 'rain', { 0: 'uniform', 10: 'uniform' }, VF);
    const rainModule = makeModule(device, 'rain', [commonWgsl, rainWgsl]);
    renderPipe(device, {
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
    }, (p) => (this.rainPipe = p));
    this.rainGroup = makeBindGroup(device, 'rain', rainLayout, { 0: world.globals, 10: this.camBuf });

    const partLayout = makeLayout(device, 'particles-draw', { 0: 'uniform', 2: 'uniform', 3: 'read', 10: 'uniform' }, VF);
    const partModule = makeModule(device, 'particles-draw', [commonWgsl, materialsWgsl, particlesDrawWgsl]);
    renderPipe(device, {
      label: 'particles',
      layout: device.createPipelineLayout({ bindGroupLayouts: [partLayout] }),
      vertex: { module: partModule, entryPoint: 'vs' },
      fragment: { module: partModule, entryPoint: 'fs', targets: [{ format, blend }, { format: PICK_FORMAT, writeMask: 0 }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthStencil(false),
    }, (p) => (this.partPipe = p));
    this.partGroup = makeBindGroup(device, 'particles-draw', partLayout, { 0: world.globals, 2: world.materials, 3: world.particles, 10: this.camBuf });
  }

  /**
   * The rigid bodies' voxels for this frame: per voxel centre xyz, material,
   * rotation quaternion xyzw (f32 bits; Bodies.pack writes them).
   */
  setBodies(data: Uint32Array, count: number, shown = count): void {
    this.bodyCount = Math.min(count, Renderer.MAX_BODY_VOXELS);
    this.bodyShown = Math.min(shown, this.bodyCount);
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
  /** (solver step 2) a voxel source let go (its instances are made again: the node solver's grew) */
  removeVoxels(indirect: GPUBuffer): void {
    this.voxelSources = this.voxelSources.filter((s) => s.indirect !== indirect);
  }

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
  /** (round 120) a mesh source let go (its buffers made again: render/bodymesh.ts grew) */
  removeMesh(indirect: GPUBuffer): void {
    this.meshSources = this.meshSources.filter((s) => s.indirect !== indirect);
  }

  /** (round 120) compute run at the start of each frame's encode, before anything's drawn (bodies' meshes skinned) */
  readonly frameCompute: ((enc: GPUCommandEncoder) => void)[] = [];

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

  /** Draw these instances (renderprep's form; flag 2048: a liquid run, render.wgsl shadeRun) with the water pipeline too. */
  addWaterPrisms(inst: GPUBuffer, indirect: GPUBuffer): void {
    this.blendSources.push({ indirect, group: this.groupFor(inst) });
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
    // (round 112, ?bgcheck=1: the depth and the pick sampled after the world pass — bgcheck.ts)
    const sampled = BGCHECK ? GPUTextureUsage.TEXTURE_BINDING : 0;
    this.depth = this.device.createTexture({ size: [w, h], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | sampled });
    this.pickTex = this.device.createTexture({
      size: [w, h],
      format: PICK_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | sampled,
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
    return encodeCeiling(this, enc, target, cam, clear, draw);
  }

  /** (round 93, the mesh's page pool) the pools' versions summed when the mesh's draw groups were last made */
  meshPoolSeen = 0;

  encode(enc: GPUCommandEncoder, target: GPUTextureView, cam: Camera, opts: RenderOptions): void {
    return encode(this, enc, target, cam, opts);
  }

  /** (perfopt, tcache) the layer's pipelines, compiled off the main thread (made when ?tcache is first on) */
  tcPipesBusy?: Promise<void>;

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
    return windowMoved(this, dcx, dcy, t);
  }

  drawnNow = new Uint8Array(0);
  /**
   * (round 113, tilesfirst) Per mesh chunk (chunkGrid order) how the window draws its land this frame, as the CPU knows
   * it after the frame's culls: 1 the hybrid grid's and in its view; 2 the voxel mesh's in view and built (FieldMesh.built
   * — the stats readback's mirror, a frame or more behind; not trusted while it's from before a slide); 3 the voxel mesh's
   * in view, not known built (the GPU's state decides: tilecache.ts encodeMask); 0 not drawn. Drawn for sure: 1 or 2.
   * The coverage check's and the tiles' cover's.
   */
  windowDrawn(): Uint8Array {
    return windowDrawn(this);
  }

  /** (hybrid) the mesh chunks wanted (FieldMesh.setWanted): the window's and the band's, the same grid */
  meshWant: Uint8Array | null = null;
  /**
   * (hybrid, ?hybrid=1) Which of the window's mesh chunks are voxels — built and drawn by the field mesh and the
   * band's — per chunk (fieldMesh.chunkGrid's order), or null for all; the rest are the LOD rings' (far.wgsl).
   */
  setMeshWanted(want: Uint8Array | null): void {
    this.meshWant = want ? want.slice() : null;
    this.fieldMesh.setWanted(want);
    this.band?.mesh.setWanted(want);
  }

  /**
   * (round 86, the hybrid) The window's heightfield chunks the grid draws (meshdraw.wgsl vsGrid: a lattice through
   * the window's own columns' tops, the mesh's look), per mesh chunk (fieldMesh.chunkGrid's order) 1 or 0, and
   * each chunk's lowest and highest top (window z: its box for the culling); null: none.
   */
  setGrid(on: Uint8Array | null, lo?: Float32Array, hi?: Float32Array): void {
    this.gridOn = on && lo && hi ? { on: on.slice(), lo: lo.slice(), hi: hi.slice() } : null;
  }

  edgesOpen = false;
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
    return enableBand(this, zSpan);
  }

  /**
   * (round 95, ?rockbody=1) The rigid rock's own mesh (render/rockmesh.ts), drawn with the bodies; none without the
   * field mesh.
   */
  enableRockMesh(): RockMesh | undefined {
    return enableRockMesh(this);
  }

  /**
   * (round 117, structures) Draw these pieces (src/structures/gpu.ts) with the game's light, as the trees are: render.wgsl's
   * layout with the pieces' buffer at binding 3, in the world pass and the sun's shadow pass. Window coordinates: the
   * owner moves them when the window slides.
   */
  enableStructures(sg: StructureGpu): void {
    return enableStructures(this, sg);
  }

  /** (solver step 2) The node solver's buffers, for the rock mesh's skinned draws (the metal's); again when they grow. */
  /** (round 120) the voxel lattice's particles (positions, rotations) the rock mesh is skinned to on the lattice */
  rockParticles?: { px: GPUBuffer; pq: GPUBuffer };
  setRockParticles(p: { px: GPUBuffer; pq: GPUBuffer }): void {
    this.rockParticles = p;
    if (this.rockGroupOf) {
      this.rockGroup = this.rockGroupOf();
      this.rockShadowGroup = this.noShadowView ? this.rockGroupOf(this.lightCamBuf, this.noShadowView) : undefined;
    }
  }

  setRockNodes(p: { pose: GPUBuffer; lanes: GPUBuffer }): void {
    this.rockNodes = p;
    if (this.rockGroupOf) {
      this.rockGroup = this.rockGroupOf();
      this.rockShadowGroup = this.noShadowView ? this.rockGroupOf(this.lightCamBuf, this.noShadowView) : undefined;
    }
  }

  /** Call after submit to start async readbacks requested during encode. */
  afterSubmit(): void {
    this.fieldMesh.afterSubmit();
    this.tiles?.afterSubmit();
    this.rockMesh?.mesh.afterSubmit();
    this.band?.mesh.afterSubmit();
    this.bgCheck?.afterSubmit();
    if (this.pickPending) {
      const resolve = this.pickPending;
      this.pickPending = undefined;
      this.pickBuf.mapAsync(GPUMapMode.READ, 0, 8).then(() => {
        const [v, info] = new Uint32Array(this.pickBuf.getMappedRange(0, 8));
        this.pickBuf.unmap();
        this.pickBusy = false;
        resolve(v === 0 ? null : { cell: v - 1, mat: info & 0xff, z: (info >>> 8) & 0x1ff, flags: info >>> 17 });
      }, ignoreTeardown);
    }
    if (this.countNeeded) {
      this.countNeeded = false;
      this.countBuf.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(this.countBuf.getMappedRange());
        this.instanceCounts = { opaque: u[1] + u[9] + u[13], blend: u[5], tops: u[13], prisms: u[1], plants: u[9] };
        // (round 93) what was asked for before the clamp; a list asked for more than INST_GROW_AT of its room grows
        this.instAsked = { opaque: u[20], blend: u[21], plants: u[22] };
        if (INST_GROW) {
          const want = (asked: number, cap: number) => (asked > cap * INST_GROW_AT ? Math.max(Math.ceil(cap * 1.5), Math.ceil(asked * 1.25)) : 0);
          this.instGrowTo = { opaque: want(u[20], this.opaqueCapacity), plant: want(u[22], this.plantCapacity), blend: want(u[21], this.blendCapacity) };
        }
        this.countBuf.unmap();
        // throttle: allow another readback in a little while
        setTimeout(() => (this.countBusy = false), 250);
      }, ignoreTeardown);
    }
  }
}
