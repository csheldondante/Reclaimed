// GPU-resident world state: every buffer that forms a contract between
// systems is allocated (and documented) here. Systems never allocate shared
// state themselves, so replacing one system's implementation cannot silently
// change what another system sees.

import type { Profiler } from '../gpu/profiler';
import { PHYS_COL_WORDS, type PackedWorld } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { packMaterialTable } from '../world/materials';
import { globalsBytes } from './globals';
import { Pages } from './pages';
import { PAGE_ADDR, PAGE_CHECK, PAGE_MISS_MAX, pageMiss, pageTab, pageTables } from '../gpu/pages-mode';
import { DIRS_BYTES } from '../world/lattice';
import { FRAME_BYTES, MAX_STRUCTS, POOL_VOXELS, PROJ_K } from '../grids/structures';
import { COVER_N } from '../weather/cover';
import { MAX_PLACES } from '../world/places';
import { AwakeTiles, SIM_CULL, TileCopy } from './cull';

export const STATS_COUNT = 16;
/** exact takes and puts in flight at once (edit.wgsl: the tag in the event's code bits 10-15) */
export const EDIT_TAGS = 64;

const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

/**
 * (round 84) How the atlas's rivers are kept: ?rivers=sim (as before: springs along each river's middle, the pipes
 * from the land as it came in), hold (the perf agent's: each river column topped up to its depth), table (the
 * atlas's steady state, riverFlow: held and drawn flowing with no simulation until something wakes it).
 */
export const RIVERS: 'sim' | 'hold' | 'table' = (() => {
  const q = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  // (perfopt's ?riverhold=1 is rivers=hold; round 86: table by default on the atlas level — the user: "the rivers
  // look good!" — the valley levels keep sim, their rivers aren't the atlas's)
  const v = q.get('rivers') ?? (q.get('riverhold') === '1' ? 'hold' : q.get('level') === 'atlas' ? 'table' : 'sim');
  if (v !== 'sim' && v !== 'hold' && v !== 'table') throw new Error(`?rivers=${v}: sim, hold or table`);
  return v;
})();
/** the riverFlow rating (above): depth and speed with the discharge */
export const RIVER_DEPTH_EXP = 0.6;
export const RIVER_SPEED_EXP = 0.4;
/** (?rivers=table) ?riverpull=x: a woken river's column is pulled toward the table by x a step (0: the pipes alone;
 *  0.02 by default — the pipes alone empty a reach above a fall down it, and the river upstream past the window
 *  feeds what's woken only by its level's slope, a trickle) */
export const RIVER_PULL = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('riverpull');
  return v === null ? (RIVERS === 'table' ? 0.02 : 0) : Number(v);
})();
/** (round 109) cells between the riverWet field's texels (WorldGpu riverWet) */
export const RIVER_WET_CELLS = 8;
/** ?riverwet=x: the rivers' wetness held at x, everywhere (the climate's and each watershed's storms' otherwise:
 *  riverheld.wgsl riverWetAt) */
export const RIVER_WET = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('riverwet');
  return v === null ? -1 : Number(v);
})();

/** blows the wind field takes a tick (api/wind.ts merges past it) */
export const MAX_BLOWS = 256;

export class WorldGpu {
  readonly w: number;
  readonly h: number;
  readonly cells: number;
  readonly zMax: number;
  readonly maxK: number;

  // shared, read by nearly every shader
  readonly globals: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly chunks: GPUBuffer;
  /** (round 85, simcull — sim/cull.ts) the chunks live this tick, by a flow's sleeping rate (Simulation.step
   *  makes them from the sleep mask), and the ping-pong fields' copy back over them; null without the flag */
  readonly tiles: AwakeTiles | null;
  /** (round 104, simscale) CPU contract for the projection (grids/systems.ts ProjectSystem): per structure slot its
   *  world xy bounds (grids/structures.ts), and whether every column must be projected next tick (bodyCpu written,
   *  the window slid) */
  readonly strBounds = new Map<number, [number, number, number, number]>();
  projectAll = true;
  readonly tileCopy: TileCopy | null;

  // canonical layered world (material physics owns writes)
  readonly layers: GPUBuffer;
  readonly layersNext: GPUBuffer;
  /** per column: top z | top mat << 8 | slot count << 16 (surface system) */
  readonly surface: GPUBuffer;

  // water contract (water system owns writes)
  readonly water: GPUBuffer;
  readonly waterNext: GPUBuffer;
  readonly waterPrev: GPUBuffer;
  /** vec4 volume leaving toward +x,-x,+y,-y this tick */
  readonly flux: GPUBuffer;
  readonly waterSource: GPUBuffer;
  /**
   * (round 84 — the user: "we can have a tolerance and decide when we are close enough to steady state to freeze")
   * Per chunk (2 048 at most, sim/sleep.ts), the most an awake column's water changed in a step since the CPU last
   * read it, as an f32's bits (atomicMax: positive floats order as their bits). water_depth.wgsl writes it; the level
   * reads and clears it (Sleep.holdUnsettled keeps a woken chunk awake until it's under the tolerance).
   */
  readonly waterChange: GPUBuffer;

  // oil: second liquid, floats on water (oil system owns writes)
  readonly oil: GPUBuffer;
  readonly oilNext: GPUBuffer;
  /** vec4 oil volume leaving toward +x,-x,+y,-y this tick */
  readonly oilFlux: GPUBuffer;
  /** vec2 per column: oil sealed in a closed tank (amount, roof z) — oil system releases it on breach */
  readonly oilStored: GPUBuffer;
  /** molten rock (sim/lava.ts, lava.wgsl): vec4 per column — x depth, y
   *  temperature, z the ground's heat at its top, w the lava's surface
   *  height; `lavaNext` the depth pass's output, `lavaFlux` its pipes */
  readonly lava: GPUBuffer;
  readonly lavaNext: GPUBuffer;
  readonly lavaFlux: GPUBuffer;

  // environmental fields
  /** vec2: soil-bound, dissolved */
  readonly contam: GPUBuffer;
  readonly contamNext: GPUBuffer;
  readonly moisture: GPUBuffer;
  readonly moistureNext: GPUBuffer;
  /** succession stage 0..5 */
  readonly veg: GPUBuffer;
  readonly vegNext: GPUBuffer;

  /** fire intensity 0..1 per column (fire system owns writes) */
  readonly fire: GPUBuffer;
  readonly fireNext: GPUBuffer;

  // render preparation
  /** vec4 per column: shadow z, moisture, fire glow, flow speed (renderfields.wgsl) */
  readonly renderFields: GPUBuffer;
  /** the field mesh's layout (meshregion.wgsl MeshRegion, 64 bytes; render/fieldmesh.ts writes it): what render preparation leaves to the mesh */
  readonly meshRegion: GPUBuffer;
  /**
   * Wind field: rgba32float, one texel per 2×2 columns (cells/s): rg painted
   * wind, ba whole wind (map wind + painted; windfield.wgsl). Everything that
   * feels wind reads it. `windField` is read, `windFieldNext` written.
   */
  readonly windField: GPUTexture;
  readonly windFieldNext: GPUTexture;
  readonly windFieldView: GPUTextureView;
  readonly windFieldNextView: GPUTextureView;
  /**
   * Loose material arriving per column, vec4 (sediment.wgsl folds it into the
   * layers and zeroes it): x what the editor adds (+, its material from the
   * brush state) or takes away (−; edit.wgsl); y, z an amount and material
   * from the CPU (a crumbled body; game/integrity.ts writes them)
   */
  readonly deposit: GPUBuffer;
  /**
   * Places (docs/PLACES.md; world/places.ts): per column, low u16 the room of
   * the open air on top, high u16 the room of the first enclosed level under
   * it (0: the same); 0 no place. `placeTable`: per place id (MAX_PLACES),
   * a room's region (a region: itself). The CPU uploads both on places.load.
   */
  readonly places: GPUBuffer;
  readonly placeTable: GPUBuffer;
  /** sediment.wgsl's outflows per column (7 vec4: to each neighbour, the wind's easing, totals, spills out of exposed faces) */
  readonly sedOut: GPUBuffer;
  /**
   * The loose ground as seen from above (a view derived from the layers by
   * the surface pass, round 22): x depth of the granular run on top of the
   * column, y its top interval's depth, z that interval's material, w what
   * the wind sent up into the air off it (from `air`)
   */
  readonly drift: GPUTexture;
  readonly driftView: GPUTextureView;
  /** what the sediment pass's wind lifted into the air per column (copied into drift .w) */
  readonly air: GPUTexture;
  readonly airView: GPUTextureView;
  /** sleeping rigid bodies projected per column: top, bottom (top < 0: none) — game/integrity.ts writes it */
  readonly bodyProj: GPUTexture;
  readonly bodyProjView: GPUTextureView;
  /** the CPU's sleeping bodies (integrity.ts writes it; project.wgsl merges it into bodyProj) */
  readonly bodyCpu: GPUTexture;
  readonly bodyCpuView: GPUTextureView;
  /** what the nature grid sees of the structure grids beyond bodyProj (project.wgsl):
   *  xy the top face's world normal, z structure + 1 (0 none), w its top material */
  readonly foreign: GPUTexture;
  readonly foreignView: GPUTextureView;
  /** each column's projected intervals (project.wgsl; common.wgsl projAt): PROJ_K texels per column */
  readonly proj: GPUTexture;
  readonly projView: GPUTextureView;
  /** per column, the floor of the open air above each projected interval and below the lowest (surface.wgsl; sediment.wgsl openAt) */
  readonly levels: GPUTexture;
  readonly levelsView: GPUTextureView;
  /** structure grids (grids.wgsl): frames, and the voxel pool */
  readonly strFrames: GPUBuffer;
  /** the physics voxels as each column sees them (physics.ts writes it each tick; project.wgsl
   *  merges it into bodyProj / proj): PHYS_COL_WORDS u32 per column, bit z set where a voxel's
   *  centre lies in cell z (0..PHYS_COL_WORDS · 32 − 1: 511; round 100 — 8 words, 255, before the window held the atlas's height) */
  readonly physCols: GPUBuffer;
  /** air the physics voxels shove as they land (physics.ts writes it each tick;
   *  windfield.wgsl pushes the wind out from it): u32 per wind texel, ×1000 */
  readonly physPuff: GPUBuffer;
  /**
   * Wind blows and strokes (the world API's wind module, api/wind.ts): [0].x
   * the count, then three vec4 each — (x, y, radius, strength or a stroke's
   * cap, cells/s), (dx, dy, mode: 0 along (dx, dy), 1 outward, 2 inward,
   * 3 swirl, 4 a stroke ending at x, y; its length), (a stroke's paint, 0,
   * 0, 0). windfield.wgsl paints the painted wind under each. CPU-written.
   */
  readonly windBlows: GPUBuffer;
  readonly strVox: GPUBuffer;
  /** voxels of the pool in use (Structures keeps it): the per-voxel kernels' size */
  strVoxels = 0;
  /** derived by the surface pass: xyz the granular intervals beneath the top one in the run on top (bottom first, packed mat·1000 + depth), w the run's base z */
  readonly strata: GPUTexture;
  readonly strataView: GPUTextureView;
  /** lava springs (round 69, the atlas's lava tubes; lava.wgsl depth): x the depth of lava a column is
   *  kept at, and kept molten (0: none) — what's fed from below keeps flowing */
  readonly lavaSpring: GPUTexture;
  readonly lavaSpringView: GPUTextureView;
  /**
   * (round 84, ?rivers=table) The atlas's rivers at their steady state — written when land arrives, by whoever made
   * it (the atlas: atlas/rivers.ts's table, forms.wgsl colFinish); 0 where no river runs:
   *   x, y  the flow at the reference wetness (cells a 60 Hz step, downstream along the river)
   *   z     the column's depth at the reference wetness (> 0: a river's column)
   *   w     the river's depth at its line, there
   * At wetness `wet` (riverheld.wgsl riverWetAt: the season, the storms on its watershed) the river carries wet × its discharge: its level
   * stands RIVER_DEPTH_EXP higher (w · (wet^RIVER_DEPTH_EXP − 1)) and it runs wet^RIVER_SPEED_EXP as fast (riverAt
   * in water_depth.wgsl, renderfields.wgsl). A river's column that nothing has woken is held there (no simulation:
   * its depth that, its flux the pipes' steady flux for it) and drawn flowing by this flow; woken, the water's pipes
   * take it from there, and fed from the held columns round it.
   */
  readonly riverFlow: GPUTexture;
  readonly riverFlowView: GPUTextureView;
  /**
   * (round 108, TC20) The weather's cover past the window (weather/cover.ts owns it; shaders/coverfield.wgsl its
   * shape): a ring of COVER_N² texels round the window, COVER_CELL world cells each. coverState (vec4<u32> a texel:
   * snow, wet | its own moisture, the ground's height, which world texel) is the owner's; coverView (rgba16float:
   * snow (cells), wet (0..1), ice (its share), which lap round the ring — -1: nothing known) is what the tiles draw it from.
   */
  readonly coverState: GPUBuffer;
  readonly coverTex: GPUTexture;
  readonly coverView: GPUTextureView;
  /**
   * (round 109, watershed) The rivers' storm water at the window's coarse texels (r32float, texel (i, j) the window's
   * cell (i, j) · RIVER_WET_CELLS; 0 past the rivers): what a river carries from the storms on its own catchment and
   * its reaches upstream, over its reference discharge (weather/catchwet.ts; written by weather/wetfield.ts). A river's
   * wetness is the climate's (Globals ocean.w: the season) plus this — read only through riverheld.wgsl riverWetAt.
   * All 0 where there's no river graph (the valley levels: their wetness the climate's, storms and all).
   */
  readonly riverWet: GPUTexture;
  readonly riverWetView: GPUTextureView;
  /** ground shaken (layerpull.wgsl writes, sediment reads): x the tick it was shaken, y how hard (0..1): loose ground there slips at a lower angle for a while */
  readonly shake: GPUTexture;
  readonly shakeView: GPUTextureView;
  /** sandbox brush state per column (edit.wgsl reads `editState`, writes `editStateNext`; particles read it) */
  readonly editState: GPUTexture;
  readonly editStateNext: GPUTexture;
  readonly editStateView: GPUTextureView;
  readonly editStateNextView: GPUTextureView;
  /**
   * what each exact take or put did (edit.wgsl OP_TAKE / OP_PUT; round 63),
   * one texel a tag: x the amount, y the material, z the tick, w 1
   */
  readonly editResult: GPUTexture;
  readonly editResultView: GPUTextureView;
  /** smoothed soft-ground corner heights (rgba32float, one texel per grid point; x = height or -1) */
  readonly cornerTex: GPUTexture;
  readonly cornerView: GPUTextureView;
  /** where embers landed (rgba32float per column, x = tick + 1 of the last landing; particles write, fire reads) */
  readonly sparkTex: GPUTexture;
  readonly sparkView: GPUTextureView;
  /** r8unorm per column: how far inside the player's reach (game/reach.ts; 1 everywhere outside story levels) — the draw fogs the rest */
  readonly reachTex: GPUTexture;
  readonly reachView: GPUTextureView;
  /** f32 per column: 1 = flowers in bloom, < 1 = shed by the wind and regrowing (particles.wgsl petalEmit) */
  readonly petals: GPUBuffer;
  /** vec2 per column: ground hostility to plants, plant brownness (wilt.wgsl) */
  readonly wilt: GPUBuffer;
  /** vec4 per column: vegetation lean xy + its velocity (sway.wgsl spring) */
  readonly bend: GPUBuffer;

  /** u32 aggregate counters, see src/sim/stats.ts */
  readonly stats: GPUBuffer;

  // particles (contract: particles.wgsl Particle struct, 48 bytes)
  readonly particleCap: number;
  readonly particles: GPUBuffer;
  /** [0] = ring head (monotonic), [1] = live estimate */
  readonly particleCounters: GPUBuffer;
  /**
   * Fixed-point (×1e5) soil-contamination exchange per column. Particles
   * atomically subtract when they pick pollution up and add when they drop it;
   * the contamination system folds it into `contam` and zeroes it.
   */
  readonly contamDelta: GPUBuffer;
  /**
   * (round 105, ringwin) the window on a ring (sim/ring.ts): where each window column's per-column data lies.
   * `?ringbias=x,y` starts it off zero (cells; whole regions of 64 in a streamed world) — the identity test's.
   */
  readonly ring: Pages;

  constructor(
    private device: GPUDevice,
    private profiler: Profiler,
    packed: PackedWorld,
    map: MapData,
    particleCap: number,
  ) {
    const { w, h, zMax } = packed.dims;
    this.w = w;
    this.h = h;
    this.cells = w * h;
    this.zMax = zMax;
    this.maxK = packed.maxK;
    const N = this.cells;
    this.ring = new Pages(w, h);
    // (round 107, P2.2: a shuffled page table needs the table looked up — the ring computed is the identity's)
    if (!this.ring.identity && PAGE_ADDR !== 'table') throw new Error(`?pageperm= needs ?pages=table (not ${PAGE_ADDR}): the ring's wrap computed only gives the identity's slots`);
    {
      const b = (typeof location === 'undefined' ? '' : (new URLSearchParams(location.search).get('ringbias') ?? '')).split(',').map(Number);
      if (b.length === 2 && b.every((v) => Number.isInteger(v))) {
        this.ring.set(b[0], b[1]);
      }
    }
    const r = this.ring;
    // (round 107, ?pagecheck=1: the kernels' counts of chunks looked up off the window)
    if (PAGE_CHECK) {
      this.pageMissBuf = this.buf('pageMiss', PAGE_MISS_MAX * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
      pageMiss.buf = this.pageMissBuf;
    }
    // (round 107, M1's ?pages=storage: the page table in a storage buffer too, an entry a u32 — gpu/pages-mode.ts)
    if (PAGE_ADDR === 'storage') {
      this.pageTab = this.buf('pageTab', Math.max(16, r.table.length * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      pageTab.buf = this.pageTab;
      this.pagesChanged();
    }

    // (COPY_SRC: round 104, the tile cache's render-only land copies it, its size and origin its own — render/tileland.ts)
    // (round 107, PG4: the page tables sized to this window — every kernel made from here on uses this size)
    // (the ring computed needs no table: the Globals keep a vec4 each, their size before pages)
    this.pageVec4 = PAGE_ADDR === 'table' ? Math.max(1, Math.ceil((r.nx * r.ny) / 8)) : 1;
    pageTables.vec4 = this.pageVec4;
    this.globals = this.buf('globals', globalsBytes(this.pageVec4), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const mats = packMaterialTable();
    this.materials = this.buf('materials', mats.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.materials, 0, mats);
    this.chunks = this.buf('chunks', packed.chunkTable.byteLength, S);
    device.queue.writeBuffer(this.chunks, 0, packed.chunkTable);

    this.layers = this.buf('layers', packed.slots.byteLength, S);
    this.layersNext = this.buf('layersNext', packed.slots.byteLength, S);
    device.queue.writeBuffer(this.layers, 0, packed.slots);
    this.surface = this.buf('surface', N * 4, S);

    this.water = this.buf('water', N * 4, S);
    this.waterNext = this.buf('waterNext', N * 4, S);
    this.waterPrev = this.buf('waterPrev', N * 4, S);
    // per-direction quantities: one f32 per hex direction (common.wgsl Dirs)
    this.flux = this.buf('flux', N * DIRS_BYTES, S);
    this.waterSource = this.buf('waterSource', N * 4, S);
    this.waterChange = this.buf('waterChange', 2048 * 4, S);
    device.queue.writeBuffer(this.water, 0, r.toStore(map.water));
    device.queue.writeBuffer(this.waterSource, 0, r.toStore(map.waterSource));

    this.oil = this.buf('oil', N * 4, S);
    this.oilNext = this.buf('oilNext', N * 4, S);
    this.oilFlux = this.buf('oilFlux', N * DIRS_BYTES, S);
    device.queue.writeBuffer(this.oil, 0, r.toStore(map.oil));
    this.oilStored = this.buf('oilStored', N * 8, S);
    this.lava = this.buf('lava', N * 16, S);
    this.lavaNext = this.buf('lavaNext', N * 16, S);
    this.lavaFlux = this.buf('lavaFlux', N * 24, S);
    if (map.lava) device.queue.writeBuffer(this.lava, 0, r.toStore(map.lava, 4));
    device.queue.writeBuffer(this.oilStored, 0, r.toStore(map.oilStored, 2));

    this.contam = this.buf('contam', N * 8, S);
    this.contamNext = this.buf('contamNext', N * 8, S);
    device.queue.writeBuffer(this.contam, 0, r.toStore(map.contam, 2));
    this.moisture = this.buf('moisture', N * 4, S);
    this.moistureNext = this.buf('moistureNext', N * 4, S);
    device.queue.writeBuffer(this.moisture, 0, r.toStore(map.moisture));
    this.veg = this.buf('veg', N * 4, S);
    this.vegNext = this.buf('vegNext', N * 4, S);
    device.queue.writeBuffer(this.veg, 0, r.toStore(map.vegetation));

    this.fire = this.buf('fire', N * 4, S);
    this.fireNext = this.buf('fireNext', N * 4, S);
    this.renderFields = this.buf('renderFields', N * 16, S);
    this.meshRegion = this.buf('meshRegion', 128, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.bend = this.buf('bend', N * 16, S);
    this.wilt = this.buf('wilt', N * 16, S);
    this.petals = this.buf('petals', N * 4, S);
    device.queue.writeBuffer(this.petals, 0, new Float32Array(N).fill(1));
    const wsize = { width: Math.ceil(this.w / 2), height: Math.ceil(this.h / 2) };
    const tusage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.windField = device.createTexture({ label: 'windField', size: wsize, format: 'rgba32float', usage: tusage });
    this.windFieldNext = device.createTexture({ label: 'windFieldNext', size: wsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.windField, this.windFieldNext);
    this.windFieldView = this.windField.createView();
    this.physPuff = this.buf('physPuff', wsize.width * wsize.height * 4, S | GPUBufferUsage.COPY_DST);
    this.windBlows = this.buf('windBlows', (1 + MAX_BLOWS * 3) * 16, S | GPUBufferUsage.COPY_DST);
    this.cornerTex = device.createTexture({ label: 'corners', size: { width: this.w * 5, height: this.h }, format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.textures.push(this.cornerTex);
    this.cornerView = this.cornerTex.createView();
    this.sparkTex = device.createTexture({ label: 'sparks', size: { width: this.w, height: this.h }, format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    this.textures.push(this.sparkTex);
    this.sparkView = this.sparkTex.createView();
    this.reachTex = device.createTexture({ label: 'reach', size: { width: this.w, height: this.h }, format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.textures.push(this.reachTex);
    this.reachView = this.reachTex.createView();
    this.writeReach(new Uint8Array(this.w * this.h).fill(255));
    this.windFieldNextView = this.windFieldNext.createView();
    const dsize = { width: this.w, height: this.h };
    this.drift = device.createTexture({ label: 'drift', size: dsize, format: 'rgba32float', usage: tusage });
    this.air = device.createTexture({ label: 'air', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.drift, this.air);
    this.driftView = this.drift.createView();
    this.airView = this.air.createView();
    this.bodyProj = device.createTexture({ label: 'bodyProj', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.bodyProj);
    this.bodyProjView = this.bodyProj.createView();
    {
      const none = new Float32Array(N * 4);
      for (let k = 0; k < N; k++) none[k * 4] = -1;
      device.queue.writeTexture({ texture: this.bodyProj }, none, { bytesPerRow: this.w * 16 }, dsize);
      this.bodyCpu = device.createTexture({ label: 'bodyCpu', size: dsize, format: 'rgba32float', usage: tusage });
      device.queue.writeTexture({ texture: this.bodyCpu }, none, { bytesPerRow: this.w * 16 }, dsize);
    }
    this.bodyCpuView = this.bodyCpu.createView();
    this.foreign = device.createTexture({ label: 'foreign', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.bodyCpu, this.foreign);
    this.foreignView = this.foreign.createView();
    this.proj = device.createTexture({ label: 'proj', size: { width: this.w * PROJ_K, height: this.h }, format: 'rgba32float', usage: tusage });
    this.levels = device.createTexture({ label: 'levels', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.proj, this.levels);
    this.projView = this.proj.createView();
    this.levelsView = this.levels.createView();
    this.strFrames = this.buf('strFrames', MAX_STRUCTS * FRAME_BYTES, S);
    this.physCols = this.buf('physCols', this.cells * PHYS_COL_WORDS * 4, S | GPUBufferUsage.COPY_DST);
    this.strVox = this.buf('strVox', POOL_VOXELS * 4, S);
    this.strata = device.createTexture({ label: 'strata', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.strata);
    this.strataView = this.strata.createView();
    this.shake = device.createTexture({ label: 'shake', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.shake);
    this.lavaSpring = device.createTexture({ label: 'lavaSpring', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.lavaSpring);
    this.lavaSpringView = this.lavaSpring.createView();
    if (map.lavaSpring) {
      const t = new Float32Array(N * 4);
      for (let k = 0; k < N; k++) t[k * 4] = map.lavaSpring[k];
      device.queue.writeTexture({ texture: this.lavaSpring }, r.texToStore(t, 4), { bytesPerRow: this.w * 16 }, dsize);
    }
    this.riverFlow = device.createTexture({ label: 'riverFlow', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.riverFlow);
    this.riverFlowView = this.riverFlow.createView();
    this.coverState = this.buf('coverState', COVER_N * COVER_N * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.coverTex = device.createTexture({ label: 'cover', size: [COVER_N, COVER_N], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.textures.push(this.coverTex);
    this.coverView = this.coverTex.createView();
    this.riverWet = device.createTexture({
      label: 'riverWet',
      size: { width: Math.floor((this.w - 1) / RIVER_WET_CELLS) + 2, height: Math.floor((this.h - 1) / RIVER_WET_CELLS) + 2 },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.textures.push(this.riverWet);
    this.riverWetView = this.riverWet.createView();
    if (map.riverFlow) device.queue.writeTexture({ texture: this.riverFlow }, r.texToStore(map.riverFlow, 4), { bytesPerRow: this.w * 16 }, dsize);
    this.shakeView = this.shake.createView();
    this.editState = device.createTexture({ label: 'editState', size: dsize, format: 'rgba32float', usage: tusage });
    this.editStateNext = device.createTexture({ label: 'editStateNext', size: dsize, format: 'rgba32float', usage: tusage });
    this.textures.push(this.editState, this.editStateNext);
    this.editStateView = this.editState.createView();
    this.editStateNextView = this.editStateNext.createView();
    this.editResult = device.createTexture({ label: 'editResult', size: [EDIT_TAGS, 1], format: 'rgba32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    this.editResultView = this.editResult.createView();
    this.stats = this.buf('stats', STATS_COUNT * 4, S);

    this.particleCap = particleCap;
    this.particles = this.buf('particles', particleCap * 48, S);
    this.particleCounters = this.buf('particleCounters', 16, S);
    // two halves: [0, N) contamination, [N, 2N) dust landing from the air
    // (particles carry what the wind lifts off the loose layer; drift.wgsl
    // folds it back in where they land — round 15)
    this.contamDelta = this.buf('contamDelta', N * 8, S);
    this.deposit = this.buf('deposit', N * 16, S);
    this.places = this.buf('places', N * 4, S);
    this.placeTable = this.buf('placeTable', MAX_PLACES * 4, S);
    this.sedOut = this.buf('sedOut', N * 7 * DIRS_BYTES, S);
    this.tiles = SIM_CULL ? new AwakeTiles(device, w, h, this.ring) : null;
    this.tileCopy = this.tiles ? new TileCopy(device, this.globals, this.materials, this.tiles, N) : null;
  }

  private owned: GPUBuffer[] = [];
  private textures: GPUTexture[] = [];

  /** Free every GPU buffer this world (and anything allocated through buf()) owns. */
  /** Upload the reach (one byte per column, 255 = inside). */
  writeReach(data: Uint8Array): void {
    this.device.queue.writeTexture({ texture: this.reachTex }, this.ring.texToStore(data, 1), { bytesPerRow: this.w }, { width: this.w, height: this.h });
  }

  /** (round 107, PG4) vec4s in each of the Globals' page tables (8 entries each) */
  pageVec4 = 512;

  /** (round 107, ?pagecheck=1) the off-window counter (null otherwise) */
  pageMissBuf: GPUBuffer | null = null;

  /** (round 107, ?pagecheck=1, scripts/pagetest.mjs) each kernel's lookups of a chunk off the window so far (the nonzero), and the kernels not checked */
  async readPageMiss(): Promise<{ miss: Record<string, number>; checked: number; unchecked: string[] }> {
    if (!this.pageMissBuf) throw new Error('readPageMiss: not a ?pagecheck=1 page');
    const st = this.device.createBuffer({ size: this.pageMissBuf.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.pageMissBuf, 0, st, 0, st.size);
    this.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(st.getMappedRange().slice(0));
    st.destroy();
    const miss: Record<string, number> = {};
    pageMiss.labels.forEach((l, k) => {
      if (u[k]) miss[l] = (miss[l] ?? 0) + u[k];
    });
    return { miss, checked: new Set(pageMiss.labels).size, unchecked: [...pageMiss.unchecked] };
  }

  /** (round 107, M1's ?pages=storage) the storage page table (null otherwise) */
  pageTab: GPUBuffer | null = null;

  /** (round 107) the page table changed (Simulation.uploadGlobals wrote it to the Globals): the storage copy too */
  pagesChanged(): void {
    if (this.pageTab) this.device.queue.writeBuffer(this.pageTab, 0, Uint32Array.from(this.ring.entries));
  }

  destroy(): void {
    if (pageTab.buf === this.pageTab) pageTab.buf = null;
    for (const b of this.owned) b.destroy();
    for (const t of this.textures) t.destroy();
    this.tiles?.destroy();
    this.owned = [];
    this.textures = [];
  }

  buf(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    const b = this.device.createBuffer({ label, size: Math.ceil(size / 4) * 4, usage });
    this.owned.push(b);
    this.profiler.trackMemory(label, size);
    return b;
  }

  /** A texture shaped like `like` (copies of world textures, e.g. undo), freed with the world. */
  texture(label: string, like: GPUTexture): GPUTexture {
    const t = this.device.createTexture({ label, size: [like.width, like.height], format: like.format, usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    this.textures.push(t);
    return t;
  }

  /** Workgroup counts for an 8×8 per-column dispatch. */
  get groups(): [number, number] {
    return [Math.ceil(this.w / 8), Math.ceil(this.h / 8)];
  }
}
