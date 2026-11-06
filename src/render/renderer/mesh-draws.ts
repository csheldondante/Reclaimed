// The field mesh's draws, made once by the Renderer's constructor when the mesh is on: its draw and depth pipelines,
// the deferred G-buffer and resolve, the terrain cache's and tiles' layouts, the rock mesh's draw, and the shadow
// pipes. API: buildMeshDraws(rd, ctx) — ctx the constructor's shared locals (layouts, modules, the draw helpers).
// Sets the renderer's mesh fields only.
import { makeBindGroup, makeLayout, makeModule, renderPipe } from '../../gpu/pipeline';
import commonWgsl from '../../shaders/common.wgsl?raw';
import layersWgsl from '../../shaders/layers.wgsl?raw';
import materialsWgsl from '../../shaders/materials.wgsl?raw';
import terrainShapeWgsl from '../../shaders/terrainshape.wgsl?raw';
import { renderWgsl } from '../../shaders/render';
import meshRegionWgsl from '../../shaders/meshregion.wgsl?raw';
import meshStateWgsl from '../../shaders/meshstate.wgsl?raw';
import meshDrawWgsl from '../../shaders/meshdraw.wgsl?raw';
import meshSourceWgsl from '../../shaders/meshsource.wgsl?raw';
import tilesWgsl from '../../shaders/tiles.wgsl?raw';
import coverFieldWgsl from '../../shaders/coverfield.wgsl?raw';
import { riverHeld } from '../../sim/systems';
import { TileCache } from '../tilecache';
import rockMeshWgsl from '../../shaders/rockmesh.wgsl?raw';
import { tcPipesMake } from '../renderer/terrain-cache';
import { drawGrid, gridLive } from '../renderer/grid';
import { CAM_BYTES, SHADOW_FORMAT, PICK_FORMAT, DEPTH_FORMAT, MESH_FRONT, HYBRID, TILES, GRID_N } from '../renderer/defs';
import { Renderer } from '../renderer';

/** the constructor's `if (this.fieldMesh.on) { … }` block, verbatim (`this` is rd) */
export function buildMeshDraws(rd: Renderer, ctx: { format: GPUTextureFormat; tufts: string; VF: number; drawLayout: GPUBindGroupLayout; riverFoam: string; drawModule: GPUShaderModule; pl: GPUPipelineLayout; depthStencil: (write: boolean) => GPUDepthStencilState; groupFor: (inst: GPUBuffer | GPUBufferBinding, cam?: GPUBuffer, shadow?: GPUTextureView) => GPUBindGroup; miVertex: (module: GPUShaderModule) => GPUVertexState; miModule: GPUShaderModule | undefined }): void {
  const { format, VF, riverFoam, drawModule, pl, depthStencil, groupFor, miVertex, miModule } = ctx;
  const { device, world, profiler } = rd;
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
    { 3: GPUShaderStage.VERTEX, 5: GPUShaderStage.VERTEX, 11: VF, ...Object.fromEntries([1, 4, 6, 7, 8, 9, 13].map((b) => [b, GPUShaderStage.FRAGMENT])) },
  );
  // (round 82, ?look=: the terrain's pixel shader cut down, to measure it on a phone — full (default), lookup
  // (the interval's material and the lighting only), flat (grey by the normal: the geometry alone))
  const look = { full: 0, lookup: 1, flat: 2 }[new URLSearchParams(location.search).get('look') ?? 'full'];
  if (look === undefined) throw new Error('?look= must be full, lookup or flat');
  const meshModule = makeModule(device, 'mesh-draw', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, renderWgsl, meshStateWgsl, meshRegionWgsl, `const MESH_LOOK: u32 = ${look}u;`, `const TUFTS_DRAWN: bool = ${new URLSearchParams(location.search).get('tufts') !== '0'};`, meshSourceWgsl, meshDrawWgsl]);
  renderPipe(device, {
    label: 'mesh',
    layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }),
    vertex: { module: meshModule, entryPoint: 'vsMesh' },
    fragment: { module: meshModule, entryPoint: 'fsMesh', targets: [{ format }, { format: PICK_FORMAT }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthStencil(true),
  }, (p) => (rd.meshPipe = p));
  const meshPl = device.createPipelineLayout({ bindGroupLayouts: [meshLayout] });
  // (perfopt, ?defer=1: the G-buffer's pass and the resolve's layout — the mesh's plus the G-buffer)
  const resolveSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'uniform', 11: 'read', 13: 'read', 15: 'tex', 17: 'tex', 23: 'tex', 25: 'depth', 26: 'csampler', 30: 'uniform', 40: 'utex', 41: 'utex' } as const;
  const resolveStages = { 3: GPUShaderStage.VERTEX, 5: GPUShaderStage.VERTEX, 11: VF, ...Object.fromEntries([1, 4, 6, 7, 8, 9, 13].map((b) => [b, GPUShaderStage.FRAGMENT])) };
  const resolveLayout = makeLayout(device, 'mesh-resolve', resolveSpec, VF, resolveStages);
  rd.meshResolveLayout = resolveLayout;
  // (round 108, TC20: the tiles' bake resolves with the held rivers' table too — their depths go in the river plane)
  // (and the weather's cover: what it was where the tile's own snow lies, as baked)
  if (TILES) rd.tileBakeLayout = makeLayout(device, 'tiles-bake', { ...resolveSpec, 22: 'tex', 47: 'tex', 62: 'tex' }, VF, resolveStages);
  rd.meshLayoutT = meshLayout;
  rd.meshPipesReady = (async () => {
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
    rd.meshPipes = { g: gp, gBack, gCut, resolve };
    // (round 86, the hybrid: the window's heightfield chunks as a grid through its columns' tops, the mesh's look)
    // (round 105: and with ?tiles=1 — the render-only land's flat chunks are the grid's — tilelandgpu.ts)
    if (HYBRID || TILES) {
      const gr = (label: string, vertex: string, fragment: string | null, targets: GPUColorTargetState[], depth: GPUDepthStencilState) =>
        device.createRenderPipelineAsync({
          label,
          layout: meshPl,
          vertex: { module: meshModule, entryPoint: vertex },
          fragment: fragment ? { module: meshModule, entryPoint: fragment, targets } : undefined,
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: depth,
        });
      const gt: GPUColorTargetState[] = [{ format: 'rgba32uint' }, { format: 'rg32uint' }];
      const ft: GPUColorTargetState[] = [{ format }, { format: PICK_FORMAT }];
      const [gg, ggCut, gFwd, gShadow] = await Promise.all([
        gr('grid-g', 'vsGridG', 'fsMeshG', gt, depthStencil(true)),
        gr('grid-g-cut', 'vsGridG', 'fsMeshGCut', gt, depthStencil(true)),
        gr('grid', 'vsGrid', 'fsMesh', ft, depthStencil(true)),
        gr('shadow-grid', 'vsGridG', null, [], { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 }),
      ]);
      const idx = new Uint32Array((GRID_N - 1) * (GRID_N - 1) * 6);
      let o = 0;
      // (the lattice's rows start at the chunk's row -1: an even lattice row is an odd row of the window's,
      // its next row shifted half a cell back; an odd one an even row, its next shifted half a cell on —
      // meshdraw.wgsl gridAt)
      for (let r = 0; r < GRID_N - 1; r++)
        for (let i = 0; i < GRID_N - 1; i++) {
          const a = r * GRID_N + i;
          const b = a + 1;
          const c = a + GRID_N;
          const d = c + 1;
          idx.set((r & 1) === 1 ? [a, b, c, b, d, c] : [a, b, d, a, d, c], o);
          o += 6;
        }
      const ib = device.createBuffer({ label: 'grid index', size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ib, 0, idx);
      rd.gridPipes = { g: gg, gCut: ggCut, fwd: gFwd, shadow: gShadow, index: ib, count: idx.length };
    }
    // (the terrain's cached layer's, when it's asked for: ?tcache)
    if (Renderer.opts.tcache > 0) await tcPipesMake(rd);
  })();
  rd.meshPreMake = () => {
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
  rd.meshModule = meshModule;
  rd.meshEntries = (src, cam = rd.camBuf, shadow = rd.shadowView) =>
    Object.entries(rd.meshResources(cam, shadow, src)).map(([b, r]) => ({ binding: Number(b), resource: r instanceof GPUBuffer ? { buffer: r } : r }));
  rd.meshGroupOf = (cam, shadow, src) => makeBindGroup(device, 'mesh-draw', meshLayout, rd.meshResources(cam, shadow, src));
  rd.meshResources = (cam, shadow, src) => ({
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
    26: rd.shadowSampler,
  });
  // (round 95) the rigid rock's mesh: the mesh's layout and look, one more uniform (its draws), its own vertex stage
  rd.makeRockDraw = (rm) => {
    const layout = makeLayout(
      device,
      'rock-mesh',
      { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'uniform', 11: 'read', 13: 'read', 15: 'tex', 17: 'tex', 23: 'tex', 25: 'depth', 26: 'csampler', 30: 'uniform', 31: 'read', 32: 'read', 33: 'read', 34: 'read', 35: 'read' },
      VF,
      { 3: GPUShaderStage.VERTEX, 5: GPUShaderStage.VERTEX, 11: VF, 31: GPUShaderStage.VERTEX, 32: GPUShaderStage.VERTEX, 33: GPUShaderStage.VERTEX, 34: GPUShaderStage.VERTEX, 35: GPUShaderStage.VERTEX, ...Object.fromEntries([1, 4, 6, 7, 8, 9, 13].map((b) => [b, GPUShaderStage.FRAGMENT])) },
    );
    const module = makeModule(device, 'rock-mesh', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, renderWgsl, meshStateWgsl, meshRegionWgsl, `const MESH_LOOK: u32 = ${look}u;`, `const TUFTS_DRAWN: bool = ${new URLSearchParams(location.search).get('tufts') !== '0'};`, meshSourceWgsl, meshDrawWgsl, rockMeshWgsl]);
    const pipe = device.createRenderPipeline({
      label: 'rock-mesh',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vsRock' },
      fragment: { module, entryPoint: 'fsRock', targets: [{ format }, { format: PICK_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depthStencil(true),
    });
    // (solver step 2: the node solver's nodes, the metal's mesh skinned to them; a stand-in without them)
    const none = device.createBuffer({ label: 'rock no nodes', size: 64, usage: GPUBufferUsage.STORAGE });
    const group = (cam: GPUBuffer = rd.camBuf, shadow: GPUTextureView = rd.shadowView) => {
      const p = rd.rockNodes;
      const q = rd.rockParticles;
      return makeBindGroup(device, 'rock-mesh', layout, { ...rd.meshResources(cam, shadow, { mesh: rm.mesh, chunks: rm.chunks, layers: rm.layers }), 31: rm.uni, 32: p?.pose ?? none, 33: p?.lanes ?? none, 34: q?.px ?? none, 35: q?.pq ?? none });
    };
    // (round 99: depth only, through the sun's camera)
    // (made when a rock mesh is: synchronously, as its own pipe above)
    const shadow = device.createRenderPipeline({ label: 'shadow-rock', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: 'vsRock' }, fragment: { module, entryPoint: 'fsRockZ', targets: [] }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: shadowDepth });
    return { pipe, group, shadow };
  };
  // (round 103, ?tiles=1: the tile cache — the mesh's module with tiles.wgsl, the resolve's layout and its own)
  if (TILES) {
    const tileModule = makeModule(device, 'tiles', [commonWgsl, layersWgsl, materialsWgsl, terrainShapeWgsl, riverFoam, renderWgsl, meshStateWgsl, meshRegionWgsl, `const MESH_LOOK: u32 = ${look}u;`, `const TUFTS_DRAWN: bool = ${new URLSearchParams(location.search).get('tufts') !== '0'};`, meshSourceWgsl, meshDrawWgsl, coverFieldWgsl, riverHeld(), tilesWgsl]);
    const drawLayout = makeLayout(
      device,
      'tiles-draw',
      { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'read', 7: 'read', 8: 'read', 9: 'read', 10: 'uniform', 11: 'read', 13: 'read', 15: 'tex', 17: 'tex', 23: 'tex', 25: 'depth', 26: 'csampler', 30: 'uniform', 40: 'utex', 41: 'utex', 42: 'tex', 43: 'utex', 44: 'read', 45: 'uniform', 46: 'read', 47: 'tex', 48: 'tex', 62: 'tex' },
      VF,
      { 3: GPUShaderStage.VERTEX, 5: GPUShaderStage.VERTEX, 11: VF, 44: GPUShaderStage.VERTEX, 46: GPUShaderStage.VERTEX, ...Object.fromEntries([1, 4, 6, 7, 8, 9, 13].map((b) => [b, GPUShaderStage.FRAGMENT])) },
    );
    const win = { mesh: rd.fieldMesh, chunks: world.chunks, layers: world.layers };
    rd.tiles = new TileCache({
      device,
      world,
      profiler,
      colorFormat: format,
      pickFormat: PICK_FORMAT,
      depthFormat: DEPTH_FORMAT,
      module: tileModule,
      resolveLayout: rd.tileBakeLayout!,
      drawLayout,
      camBytes: CAM_BYTES,
      camBuf: rd.camBuf,
      camData: () => rd.camData,
      win,
      band: () => (rd.band ? { mesh: rd.band.mesh, chunks: rd.band.chunks, layers: rd.band.layers } : undefined),
      gPipe: () => rd.meshPipes?.g,
      gridPipe: () => rd.gridPipes?.g,
      gridOn: () => (gridLive(rd) ? rd.gridOn!.on : null),
      chunkBox: () => rd.gridOn,
      drawGrid: (pass, which) => void drawGrid(rd, pass, which),
      windowDrawn: () => rd.windowDrawn(),
      meshGroup: (cam, src) => rd.meshGroupOf!(cam, rd.shadowView, src),
      meshEntries: (src, cam) => rd.meshEntries(src, cam),
    });
  }
  const meshGroupFor = (cam: GPUBuffer, shadow: GPUTextureView = rd.shadowView) => rd.meshGroupOf!(cam, shadow, { mesh: rd.fieldMesh, chunks: world.chunks, layers: world.layers });
  rd.meshGroup = meshGroupFor(rd.camBuf);
  // the sun's shadow pass: the same vertex shaders, depth only, through the
  // sun's camera (the prisms and plants draw the sides facing it)
  const shadowDepth: GPUDepthStencilState = { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 };
  const shadowPipe = (label: string, layout: GPUPipelineLayout, module: GPUShaderModule, entryPoint: string, set: (p: GPURenderPipeline) => void) =>
    renderPipe(device, { label, layout, vertex: { module, entryPoint }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: shadowDepth }, set);
  shadowPipe('shadow-opaque', pl, drawModule, 'vsBox', (p) => (rd.shadowOpaquePipe = p));
  shadowPipe('shadow-bodies', pl, drawModule, 'vsBody', (p) => (rd.shadowBodyPipe = p));
  shadowPipe('shadow-skins', pl, drawModule, 'vsSkin', (p) => (rd.shadowSkinPipe = p));
  shadowPipe('shadow-mesh', device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }), meshModule, 'vsMeshG', (p) => (rd.shadowMeshPipe = p));
  renderPipe(device, {
    label: 'shadow-mesh-cull',
    layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }),
    vertex: { module: meshModule, entryPoint: 'vsMeshG' },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: MESH_FRONT },
    depthStencil: shadowDepth,
  }, (p) => (rd.shadowMeshCullPipe = p));
  // (the pass draws into the map, so its groups bind a stand-in texel there)
  const none = device.createTexture({ label: 'shadow-none', size: [1, 1], format: SHADOW_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
  rd.noShadowView = none;
  const L = rd.lightCamBuf;
  rd.shadowGroups = {
    opaque: groupFor(rd.instOpaque, L, none),
    tops: groupFor({ buffer: rd.instOpaque, offset: rd.topsBase * 16 }, L, none),
    plants: groupFor(rd.instPlant, L, none),
    struct: groupFor(rd.structInst, L, none),
    bodies: groupFor(rd.bodyBuf, L, none),
    mesh: meshGroupFor(L, none),
  };
  if (rd.meshInst && miModule) {
    renderPipe(device, { label: 'shadow-meshinst', layout: pl, vertex: miVertex(miModule), primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: shadowDepth }, (p) => (rd.miShadowPipe = p));
    rd.miShadowGroup = groupFor(rd.meshInst.instances, L, none);
  }
}
