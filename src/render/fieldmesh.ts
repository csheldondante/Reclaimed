// The field mesh (G13 h; fieldmesh.wgsl, meshdraw.wgsl): the whole map's
// terrain drawn as one surface meshed from a field evaluated from the
// intervals and the structures' voxels, in place of prisms and sheets. In
// chunks of the world; the GPU finds the chunks that changed and rebuilds a
// few a frame. On in every level and the world API (round 61; ?mesh=0: prisms); ?meshh= the sample spacing (1; 0.5 is
// finer and four times the cost). This side writes the layout (a uniform),
// dispatches, and culls to the view: the chunks drawn, and the chunks
// rebuilt (near the view; the rest when they come into it).

import { ignoreTeardown, makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import { UnsupportedError } from '../gpu/device';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import gridsWgsl from '../shaders/grids.wgsl?raw';
import meshRegionWgsl from '../shaders/meshregion.wgsl?raw';
import meshStateWgsl from '../shaders/meshstate.wgsl?raw';
import fieldMeshWgsl from '../shaders/fieldmesh.wgsl?raw';
import type { WorldGpu } from '../sim/world-gpu';

/** round 82: ?readback=0 — the renderer's and the mesh's periodic readbacks off (main.ts: the timestamps too) */
export const READBACK = new URLSearchParams(location.search).get('readback') !== '0';
import type { Camera } from './camera';
/** perfopt: the rebuild's workgroups wholly under a chunk's bottom or over its top return at once (?idleskip=0 off) */
const IDLE_SKIP = `const IDLE_SKIP: bool = ${new URLSearchParams(location.search).get('idleskip') !== '0'};`;
/** perfopt, ?normals=grid: the vertices' normals from the samples, not six more fields a vertex */
const NORMALS_GRID = `const NORMALS_GRID: bool = ${new URLSearchParams(location.search).get('normals') === 'grid'};`;

/** bytes of the layout uniform (meshregion.wgsl MeshRegion) */
export const REGION_BYTES = 128;
/** (perfopt, ?cavemesh=near) the window's mesh leaves out the caves and the insides of hills, but near the cut */
const CAVE_MESH = new URLSearchParams(location.search).get('cavemesh') === 'near';
/** cells round the cut's focus where the caves are meshed */
const CAVE_NEAR = 48;
/** a chunk's side, world units */
const CHUNK = 32;
const ROW_H = Math.sqrt(3) / 2;
/** fieldmesh.wgsl CHUNK0, CSTRIDE (u32s) */
const CHUNK0 = 16;
const CSTRIDE = 14;
/** meshstate.wgsl FRESH: a record's hash when nothing is built */
const FRESH_HASH = 0x9e3779b9;
/**
 * (round 86) rebuild slots a frame kept for the chunks the CPU marks urgent (`urgent`: an edit's, a falling piece's),
 * over the tier's own — low's one, on alternate frames with the band, made a crater's chunks show over ten frames
 * and would let a falling piece's two chunks take turns. They cost only when used (the rebuild is dispatched for
 * what was found).
 */
const URGENT_SLOTS = 4;
/** fieldmesh.wgsl URGENT_BIT: in a chunk's near word, marked urgent */
const URGENT_BIT = 0x10000;
/** (round 117, terrain) fieldmesh.wgsl UNMESHED_BIT: in a chunk's near word, the hybrid doesn't mesh it */
const UNMESHED_BIT = 0x20000;
/** cells over a chunk's known top its box reaches (growth since the readback, the bevels) */
const TOP_PAD = 4;

/**
 * (round 93; on unless ?meshpool=0, measured: DEVLOG round 93) The page pool (meshregion.wgsl): the vertices and quads in 16 KB pages of one buffer,
 * handed to the chunks built — sized by what's built, not every chunk's worst case — and drawn through one shared
 * quad index buffer (meshdraw.wgsl meshVert). It starts at POOL_START pages a chunk and grows by half when the GPU reports a rebuild
 * it couldn't give pages (starved) or the free pages fall under a fifth; past one binding's room (128 MB at most)
 * it's an UnsupportedError, thrown at the next frame.
 */
export const MESH_POOL = new URLSearchParams(location.search).get('meshpool') !== '0';
const PAGE_BYTES = 16384;
const VPP = 512;
const QPP = 2048;
/** pages a chunk the pool starts with (vertices and quads together) */
const POOL_START = 3;
/** a range table's header words (meshregion.wgsl rtBase) */
const RT_HEAD = 8;
/** the free stack's header words (meshregion.wgsl freeBase) */
const FREE_HEAD = 8;
/** what one binding of the pool may hold at most, whatever the GPU allows */
const POOL_MAX_BYTES = 128 * 2 ** 20;
/** frames between reads of the free stack's header */
const POOL_READ_EVERY = 15;
/** a record's word 13: its range's pages to be given back (fieldmesh.wgsl RELEASE) */
const RELEASE = 1;

/**
 * What a field mesh is made from (round 79): by default the window's own layers; or a band's — the
 * columns' runs outside the window (above and below it, window z), its own chunk table and layers,
 * meshed the same way and drawn with the window's (render/band.ts).
 */
export interface MeshSource {
  name: string;
  chunks: GPUBuffer;
  layers: GPUBuffer;
  frames: GPUBuffer;
  vox: GPUBuffer;
  /** the world's height: the samples along z cover it */
  zSpan: number;
  /** chunks rebuilt a frame */
  slots: number;
  /** (round 95) the page pool's pages to start with (default: a few a chunk of the window) */
  pages?: number;
}

export class FieldMesh {
  /** the layout uniform (world.meshRegion: renderprep, vegprep and renderfields read it) */
  readonly region: GPUBuffer;
  readonly on: boolean;
  private verts!: GPUBuffer;
  private indices!: GPUBuffer;
  /** change detection, rebuild slots, and each chunk's draw args (fieldmesh.wgsl binding 9) */
  private state!: GPUBuffer;
  private scratch!: GPUBuffer;
  private kernels: ComputeKernel[] = [];
  private groups: GPUBindGroup[] = [];
  private hash!: ComputeKernel;
  private hashGroup!: GPUBindGroup;
  /** the first hash pass: chunks with nothing built (round 73) */
  private hashF!: ComputeKernel;
  private hashFGroup!: GPUBindGroup;
  private frameNo = 0;
  /** chunks along x, y; samples along z; a chunk's cells per side (N); rebuild slots */
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private side = 0;
  private slots = 0;
  /** chunks drawn last frame (after culling) */
  drawn = 0;
  /** (perfopt) slides so far: what's cached in window coordinates (the shadow map, the prepared instances) is stale after one */
  slides = 0;
  /** the z its chunks' boxes start at and reach to at most (window z; the band's move with the window's oz) */
  private zLo = -1;
  private zHi = 0;
  /** per chunk: near the view (rebuilt when changed; written to the state), in it (drawn) */
  private near = new Uint32Array(0);
  private inView = new Uint8Array(0);
  /** (round 113, the planner's — scenes/planner.ts) where the view will be (window units, x y) when what's rebuilt now is
   *  ready: the chunks there are near (rebuilt) too. [0, 0]: only the view's own margin */
  lead: [number, number] = [0, 0];
  /** (round 113) per chunk 1: drawn this frame if built (the last cull's; hybrid: only the wanted) */
  get inViewMask(): Uint8Array {
    return this.inView;
  }
  /** per chunk: the top of what's in it (the hash pass's, read back; zMax until known), what its box reaches up to */
  private tops = new Float32Array(0);
  /** per chunk: inside the sun's box (castCull), so it casts into the shadow map */
  private casts = new Uint8Array(0);
  /** the world rect (x0, y0, x1, y1) of the chunks near the view: what the shadow map covers */
  nearRect: [number, number, number, number] = [0, 0, 0, 0];
  /** last-known: chunks found changed that frame, the mesh's size, chunks out of room (async readback) */
  stats = { changed: 0, verts: 0, indices: 0, full: 0 };
  private statBuf?: GPUBuffer;
  private statBusy = false;
  private statNeeded = false;
  private statEvery = 0;
  /** (round 112, tilefix2) frames between the chunk-stat readbacks (the built mirror, the tops): 60; a test reading what's
   *  drawn sets it lower (scripts/tilegate.mjs: 1) */
  statPeriod = 60;

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private profiler: Profiler,
    byDefault = false,
    /** room a chunk, times the default */
    room = 1,
    /** a band's (round 79); the window's own when not given */
    private src?: MeshSource,
    /** chunks rebuilt a frame (the window's: quality `meshSlots`, round 81) */
    slots?: number,
  ) {
    const q = new URLSearchParams(location.search);
    const arg = q.get('mesh');
    this.on = arg === null ? byDefault : arg !== '0';
    this.region = src ? device.createBuffer({ label: `${src.name} region`, size: REGION_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) : world.meshRegion;
    this.zHi = world.zMax;
    if (!this.on) {
      device.queue.writeBuffer(this.region, 0, new ArrayBuffer(REGION_BYTES));
      return;
    }
    // (perfopt, ?bandh=: the band's own sample spacing — a coarser mesh for the land above and below the window)
    const h = Number((src ? q.get('bandh') : null) ?? q.get('meshh') ?? 1);
    // (?meshroom=: the window's room a chunk, times the default — round 79, to tell holes from out of room)
    if (!src && q.get('meshroom')) room = Number(q.get('meshroom'));
    const W = world.w + 0.5;
    const H = world.h * ROW_H;
    // (a chunk is CHUNK across and CHUNK rows down: round 73, a slide is whole chunks both ways)
    this.nx = Math.ceil(W / CHUNK);
    this.ny = Math.ceil(H / (CHUNK * ROW_H));
    this.side = Math.round(CHUNK / h);
    this.nz = Math.ceil(((src?.zSpan ?? world.zMax) + 2) / h) + 2;
    // rebuild slots a frame: their scratch is the big cost in memory
    this.slots = src?.slots ?? (h >= 1 ? (slots ?? 8) : 3);
    // (the window's: the urgent slots over them — at most 14, the state's slot list)
    this.ordinary = this.slots;
    if (!src) this.slots = Math.min(14, this.slots + URGENT_SLOTS);
    // room per chunk: ~1.3k vertices per 1000 columns at spacing 1 (~5k at
    // 0.5; DEVLOG 2026-10-22), a chunk ~1.2k columns, four times that for
    // cliffs and caves
    // (round 93, the page pool: a quad's vertices are 16 bits, so a chunk holds 65536 at most; its room is only
    // the length of its page tables there — it costs nothing until it's used)
    const vertsPer = Math.min(Math.ceil((6144 * room) / (h * h) / 64) * 64, MESH_POOL ? 65536 : Infinity);
    const indicesPer = vertsPer * 6;
    const chunks = this.nx * this.ny;
    this.pool = MESH_POOL;
    this.vpt = Math.ceil(vertsPer / VPP);
    this.qpt = Math.ceil(vertsPer / QPP);
    this.maxPages = Math.floor(Math.min(POOL_MAX_BYTES, device.limits.maxStorageBufferBindingSize) / PAGE_BYTES);
    const ab = new ArrayBuffer(REGION_BYTES);
    const f = new Float32Array(ab);
    const u = new Uint32Array(ab);
    f.set([CHUNK, h, CHUNK * ROW_H, h * ROW_H], 0);
    u.set([this.nx, this.ny, this.nz, 1], 4);
    u.set([this.side, this.slots, vertsPer, indicesPer], 8);
    u.set(this.pool ? [this.ordinary, this.vpt, this.qpt, 1] : [this.ordinary, 0, 0, 0], 28);
    // every column is the mesh's
    f.set([-1, -1, W + 1, H + 1], 12);
    // (round 79) the window's: samples from 0, bedrock under 0, a run cut at its top goes on up (the
    // band draws it), quads under its top; a band's: setBand
    // (zb.w 1: the window's — a chunk whose columns all sleep isn't looked at for changes, round 80)
    f.set([0, 0, world.zMax, src ? 0 : 1], 16);
    f.set([-1e30, world.zMax, 0, 0], 20);
    this.layout = ab;
    device.queue.writeBuffer(this.region, 0, ab);
    const pre = src ? `${src.name} ` : '';
    this.pre = pre;

    if (this.pool) {
      // (round 93: the pool — a few pages a chunk to start, grown as the GPU asks; an index buffer it doesn't use)
      this.pages = Math.min(this.maxPages, src?.pages ?? Math.max(64, chunks * POOL_START));
      this.verts = world.buf(`${pre}meshPool`, this.pages * PAGE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
      // (one quad's corners 0 1 2, 0 2 3 repeated for a chunk's most quads: every range's draw reads it, its base vertex
      // r · 4 · vertsPer — meshdraw.wgsl meshVert)
      const qi = new Uint32Array(indicesPer);
      for (let q = 0; q < vertsPer; q++) qi.set([4 * q, 4 * q + 1, 4 * q + 2, 4 * q, 4 * q + 2, 4 * q + 3], q * 6);
      this.indices = world.buf(`${pre}meshQuadIndex`, qi.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(this.indices, 0, qi);
    } else {
      const vb = chunks * vertsPer * 32;
      if (vb > device.limits.maxStorageBufferBindingSize) {
        throw new UnsupportedError(`the ${src?.name ?? 'window'}'s mesh needs ${(vb / 2 ** 20).toFixed(0)} MB in one buffer; this GPU binds ${(device.limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MB (a smaller ?win=)`);
      }
      // (COPY_SRC: the world API's smooth sampling is checked against it, scripts/worldapitest.mjs)
      this.verts = world.buf(`${pre}meshVerts`, chunks * vertsPer * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      this.indices = world.buf(`${pre}meshIndices`, chunks * indicesPer * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX);
    }
    // (then four words a range: its translation — meshregion.wgsl offBase)
    // (then (round 81) four: the rebuild's dispatch — fieldmesh.wgsl rebuildArgs)
    // (then (round 93, the pool) a table a range, and the free stack: meshregion.wgsl rtBase, freeBase)
    const argsWord = CHUNK0 + chunks * (CSTRIDE + 1) + chunks * 4;
    this.freeAt = argsWord + 4 + chunks * (RT_HEAD + this.vpt + this.qpt);
    const stateWords = this.pool ? this.freeAt + FREE_HEAD + this.maxPages : argsWord + 4;
    this.argsAt = argsWord * 4;
    this.args = world.buf(`${pre}meshArgs`, 16, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.state = world.buf(`${pre}meshState`, stateWords * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const init = new Uint32Array(stateWords);
    for (let c = 0; c < chunks; c++) {
      // (the pool's draws all read the one quad index buffer from 0, the range's corners from r · 4 · vertsPer)
      init.set(this.pool ? [0, 1, 0, c * vertsPer * 4, 0] : [0, 1, c * indicesPer, c * vertsPer, 0], CHUNK0 + c * CSTRIDE);
      init[CHUNK0 + c * CSTRIDE + 10] = c;
    }
    // (the pool's pages: the first alloc pass pushes them all on the free stack)
    if (this.pool) {
      init[this.freeAt + 1] = this.pages;
      init[this.freeAt + 4] = 0xffffffff;
    }
    device.queue.writeBuffer(this.state, 0, init);
    const s = this.side + 3;
    // (and after the samples, perfopt's cavemesh: a float a sample column a slot, what's left out under it)
    this.scratch = world.buf(`${pre}meshScratch`, this.slots * s * s * this.nz * 8 + this.slots * s * s * 4, GPUBufferUsage.STORAGE);
    // (the stats' readback: the records, the near words and translations — not the pool's tables)
    this.statBuf = world.buf(`${pre}meshStats`, this.argsAt + 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    if (this.pool) this.freeBuf = world.buf(`${pre}meshFreeRead`, FREE_HEAD * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    const parts = [commonWgsl, layersWgsl, materialsWgsl, gridsWgsl, meshStateWgsl, meshRegionWgsl, IDLE_SKIP, NORMALS_GRID, fieldMeshWgsl];
    const spec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 30: 'uniform' } as const;
    this.makeGroup = (k: ComputeKernel) =>
      makeBindGroup(device, 'fieldmesh', k.layout, {
        0: world.globals,
        1: src?.chunks ?? world.chunks,
        2: world.materials,
        3: src?.layers ?? world.layers,
        4: src?.frames ?? world.strFrames,
        5: src?.vox ?? world.strVox,
        6: this.scratch,
        7: this.verts,
        8: this.indices,
        9: this.state,
        30: this.region,
      });
    this.hash = makeCompute(device, 'fieldmesh-hash', parts, spec, 'hashChunks');
    this.argsK = makeCompute(device, 'fieldmesh-args', parts, spec, 'rebuildArgs');
    this.hashF = makeCompute(device, 'fieldmesh-hash-fresh', parts, spec, 'hashFresh');
    // (round 93, the pool: the count and alloc passes between — the alloc ones a single workgroup, dispatched direct)
    const steps = this.pool
      ? (['columnTops', 'sampleField', 'countVerts', 'allocVerts', 'makeVerts', 'countQuads', 'allocQuads', 'makeQuads'] as const)
      : (['columnTops', 'sampleField', 'makeVerts', 'makeQuads'] as const);
    const names: Record<string, string> = { columnTops: 'tops', sampleField: 'sample', countVerts: 'count', allocVerts: 'alloc', makeVerts: 'verts', countQuads: 'qcount', allocQuads: 'qalloc', makeQuads: 'quads' };
    for (const entry of steps) {
      const k = makeCompute(device, `fieldmesh-${entry}`, parts, spec, entry);
      this.kernels.push(k);
      this.steps.push({ name: `fieldmesh-${names[entry]}`, direct: entry.startsWith('alloc'), tops: entry === 'columnTops' });
    }
    this.makeGroups();
  }

  /** (round 93) the compute groups — made again when the pool grows (its buffer is new) */
  private makeGroup!: (k: ComputeKernel) => GPUBindGroup;
  private makeGroups(): void {
    this.hashGroup = this.makeGroup(this.hash);
    this.argsGroup = this.makeGroup(this.argsK);
    this.hashFGroup = this.makeGroup(this.hashF);
    this.groups = this.kernels.map((k) => this.makeGroup(k));
  }
  private steps: { name: string; direct: boolean; tops: boolean }[] = [];

  // ---- (round 93) the page pool ----------------------------------------------------------------------------
  private pool = false;
  /** vertex and quad pages a range's table holds; the pool's pages now and at most */
  private vpt = 0;
  private qpt = 0;
  private pages = 0;
  private maxPages = 0;
  /** the free stack's header (state words) */
  private freeAt = 0;
  private freeBuf?: GPUBuffer;
  private freeBusy = false;
  private freeNeeded = false;
  private freeEvery = 0;
  /** what the last read of the free stack said */
  poolStats = { pages: 0, free: 0, starved: 0, grown: 0, mb: 0, low: 0, most: 0 };
  /** bumped when the pool's buffer is replaced: the draw groups that bind it are made again (renderer.ts) */
  poolVersion = 0;
  /** (round 120) its source's buffers made again (the rock mesh's copy grew): its groups again, and the draws' (poolVersion) */
  sourceChanged(): void {
    this.makeGroups();
    this.poolVersion++;
  }
  private poolError: Error | null = null;

  /** Grow the pool to `pages` pages: a new buffer, the old one's pages copied in, the new pages for the GPU to push. */
  private grow(pages: number): void {
    const want = Math.min(this.maxPages, pages);
    if (want <= this.pages) {
      this.poolError = new UnsupportedError(`the ${this.src?.name ?? 'window'}'s mesh needs more than ${((this.maxPages * PAGE_BYTES) / 2 ** 20).toFixed(0)} MB of pages, one binding's room on this GPU (a smaller ?win=)`);
      return;
    }
    const old = this.verts;
    this.verts = this.world.buf(`${this.pre}meshPool`, want * PAGE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const enc = this.device.createCommandEncoder({ label: 'mesh pool grow' });
    enc.copyBufferToBuffer(old, 0, this.verts, 0, old.size);
    this.device.queue.submit([enc.finish()]);
    this.pages = want;
    this.device.queue.writeBuffer(this.state, (this.freeAt + 1) * 4, new Uint32Array([want]));
    this.makeGroups();
    this.poolVersion++;
    this.poolStats.grown++;
    // (destroyed once the frames that may still use it are done)
    this.retired.push({ buf: old, frames: 3 });
  }
  /** pages the pool is to grow to (the free stack's readback asks; maintain does it) */
  private growTo = 0;
  private retired: { buf: GPUBuffer; frames: number }[] = [];

  /**
   * (round 93) Once a frame, before anything is encoded: grow the pool if the GPU asked, retire old buffers; its
   * version (renderer.ts makes the draw groups again when it changes). Out of room on this GPU: thrown here.
   */
  maintain(): number {
    if (!this.pool) return 0;
    if (this.poolError) throw this.poolError;
    for (const r of this.retired) if (--r.frames <= 0) r.buf.destroy();
    this.retired = this.retired.filter((r) => r.frames > 0);
    if (this.growTo > this.pages) {
      this.grow(this.growTo);
      this.growTo = 0;
      if (this.poolError) throw this.poolError;
    }
    return this.poolVersion;
  }

  private layout = new ArrayBuffer(REGION_BYTES);
  /** the rebuild's indirect dispatch (round 81) and where the state keeps it */
  private args!: GPUBuffer;
  private argsAt = 0;
  private argsK!: ComputeKernel;
  private argsGroup!: GPUBindGroup;
  /** frames since a band was last packed (its full change pass runs for a while after) */
  private framesSincePack = 0;

  /** the band's layers were written: look at every chunk for a while (round 80) */
  packed(): void {
    this.framesSincePack = 0;
  }
  /** its passes' and buffers' names begin so ('band ': the profiler tells the two apart) */
  private pre = '';

  /**
   * A band's z (round 79): the window is at oz, zMax high — its samples from the world's floor (window z
   * −oz) up the world's height, the bedrock under the floor, no run going on up, quads outside [0, zMax).
   */
  /** (perfopt, cavemesh) the window's: the caves left out of the mesh (but near the focus) */
  private caveOn = false;
  private caveFocus: [number, number, number] | null = null;

  /**
   * (perfopt, ?cavemesh=near) Where the caves are meshed: round the cut's focus (x, y, radius — the player under
   * a roof), or nowhere; off (every cave meshed) while flying. A change rebuilds the chunks it touches (their mesh
   * stays drawn until each is rebuilt).
   */
  setCaves(focus: [number, number] | null, fly: boolean): void {
    if (!this.on || this.src || !CAVE_MESH) return;
    const on = !fly;
    const f: [number, number, number] | null = focus ? [focus[0], focus[1], CAVE_NEAR] : null;
    const old = this.caveFocus;
    const moved = (f === null) !== (old === null) || (f && old && Math.hypot(f[0] - old[0], f[1] - old[1]) > CAVE_NEAR / 4);
    if (on === this.caveOn && !moved) return;
    const all = on !== this.caveOn;
    this.caveOn = on;
    this.caveFocus = f;
    const fl = new Float32Array(this.layout);
    fl.set([f?.[0] ?? 0, f?.[1] ?? 0, f?.[2] ?? 0, on ? 1 : 0], 24);
    this.device.queue.writeBuffer(this.region, 96, this.layout, 96, 16);
    // (rebuilt: every chunk when it turns on or off; else those the old and new circles touch)
    const touch = (c: [number, number, number] | null, cx: number, cy: number) => {
      if (!c) return false;
      const x = Math.max(cx * CHUNK, Math.min(c[0], (cx + 1) * CHUNK));
      const y = Math.max(cy * CHUNK * ROW_H, Math.min(c[1], (cy + 1) * CHUNK * ROW_H));
      return Math.hypot(x - c[0], y - c[1]) <= c[2] + 4;
    };
    for (let cy = 0; cy < this.ny; cy++)
      for (let cx = 0; cx < this.nx; cx++) {
        if (!all && !touch(old, cx, cy) && !touch(f, cx, cy)) continue;
        // (word 5, the hash it was built from: anything not this one rebuilds it; not FRESH, so it stays drawn)
        this.device.queue.writeBuffer(this.state, (CHUNK0 + (cy * this.nx + cx) * CSTRIDE + 5) * 4, new Uint32Array([1]));
      }
  }

  /** (hybrid) per chunk: 1 meshed and drawn, 0 left to the heightfield (never built; its record emptied); null: all */
  private wanted: Uint8Array | null = null;
  /** (hybrid) chunks wanted (meshed) at the last setWanted */
  wantedCount = -1;

  /**
   * (hybrid, ?hybrid=1) Which chunks are meshed: per chunk (chunkGrid's order) 1 or 0, or null for every one. A
   * chunk not wanted is never looked at, built or drawn, and one that was built is emptied — its record's indices 0,
   * its hash FRESH — so the LOD rings (far.wgsl meshBuilt) draw its land; wanted again, it's built as fresh land is.
   */
  setWanted(want: Uint8Array | null): void {
    if (!this.on) return;
    const n = this.nx * this.ny;
    if (want && want.length !== n) throw new Error(`FieldMesh.setWanted: ${want.length} chunks, not ${n}`);
    const old = this.wanted;
    for (let c = 0; c < n; c++) {
      const was = old ? old[c] : 1;
      const now = want ? want[c] : 1;
      if (!was || now) continue;
      // (its indices 0 — drawn as nothing — and its hash FRESH: built anew when it's wanted again)
      this.device.queue.writeBuffer(this.state, (CHUNK0 + c * CSTRIDE) * 4, new Uint32Array([0]));
      this.device.queue.writeBuffer(this.state, (CHUNK0 + c * CSTRIDE + 5) * 4, new Uint32Array([FRESH_HASH]));
      // (round 93, the pool: its pages given back — fieldmesh.wgsl allocVerts)
      if (this.pool) this.device.queue.writeBuffer(this.state, (CHUNK0 + c * CSTRIDE + 13) * 4, new Uint32Array([RELEASE]));
    }
    this.wanted = want ? want.slice() : null;
    this.wantedCount = want ? want.reduce((s, v) => s + (v ? 1 : 0), 0) : n;
  }

  setBand(oz: number, zMax: number): void {
    if (!this.on || !this.src) return;
    const f = new Float32Array(this.layout);
    f.set([-oz - 1, -oz, 1e30, 0], 16);
    f.set([0, zMax, 1, this.openEdge], 20);
    this.device.queue.writeBuffer(this.region, 0, this.layout);
    this.zLo = -oz - 1;
    this.zHi = this.src.zSpan - oz;
    this.tops.fill(this.zHi);
  }

  private openEdge = 0;

  /**
   * (round 83, the user: "whenever I pan it draws the side of the current cells even if they are going to
   * be covered by neighbors") A streamed window's edge is open: past it each edge column goes on as it is
   * (fieldmesh.wgsl colDist, MR.ze.w), so the mesh makes no wall down the window's edge — a wall that stayed
   * in the chunks by the old edge after a slide until they were made again. A level's own map keeps its wall.
   */
  openEdges(): void {
    this.openEdge = 1;
    if (!this.on) return;
    new Float32Array(this.layout)[23] = 1;
    this.device.queue.writeBuffer(this.region, 0, this.layout);
  }

  /** chunks across and down (the state's records: meshregion.wgsl CHUNK0, CSTRIDE), and a chunk's cells across
   *  (CHUNK rows down) */
  get chunkGrid(): [number, number, number] {
    return [this.nx, this.ny, CHUNK];
  }

  /** The vertices (meshdraw.wgsl binding 3). */
  get vertexBuffer(): GPUBuffer {
    return this.verts;
  }

  /** The chunks' records and the ranges' translations (meshdraw.wgsl binding 5). */
  get stateBuffer(): GPUBuffer {
    return this.state;
  }

  private shiftK?: ComputeKernel;
  private shiftGroup?: GPUBindGroup;
  private shiftUni?: GPUBuffer;
  private stateOld?: GPUBuffer;

  /**
   * The streamed window slid (round 73): what's built moves with the land — chunk records come from
   * the chunks (dcx, dcy) along, every range is drawn moved by t (world units: the land moved by −the
   * window's slide), the chunks the land came into fresh are built (fieldmesh.wgsl shiftChunks).
   */
  shift(dcx: number, dcy: number, t: [number, number, number]): void {
    if (!this.on) return;
    this.slides++;
    const dev = this.device;
    if (!this.shiftK) {
      this.stateOld = this.world.buf('meshStateOld', this.state.size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.shiftUni = dev.createBuffer({ label: 'mesh shift', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const parts = [commonWgsl, layersWgsl, materialsWgsl, gridsWgsl, meshStateWgsl, meshRegionWgsl, IDLE_SKIP, NORMALS_GRID, fieldMeshWgsl];
      this.shiftK = makeCompute(dev, 'fieldmesh-shift', parts, { 0: 'uniform', 9: 'rw', 10: 'read', 30: 'uniform', 31: 'uniform' }, 'shiftChunks');
      this.shiftGroup = makeBindGroup(dev, 'fieldmesh-shift', this.shiftK.layout, { 0: this.world.globals, 9: this.state, 10: this.stateOld, 30: this.region, 31: this.shiftUni });
    }
    const ab = new ArrayBuffer(32);
    new Int32Array(ab).set([dcx, dcy, 0, 0]);
    new Float32Array(ab).set(t, 4);
    dev.queue.writeBuffer(this.shiftUni!, 0, ab);
    const enc = dev.createCommandEncoder({ label: 'mesh shift' });
    enc.copyBufferToBuffer(this.state, 0, this.stateOld!, 0, this.state.size);
    const pass = enc.beginComputePass({ label: 'fieldmesh-shift' });
    pass.setPipeline(this.shiftK.pipeline);
    pass.setBindGroup(0, this.shiftGroup!);
    pass.dispatchWorkgroups(Math.ceil((this.nx * this.ny) / 64));
    pass.end();
    dev.queue.submit([enc.finish()]);
    // (hybrid: what's wanted goes round with them too — the fresh ones the heightfield's till the owner says)
    if (this.wanted) {
      const old = this.wanted.slice();
      for (let cy = 0; cy < this.ny; cy++)
        for (let cx = 0; cx < this.nx; cx++) {
          const sx = cx + dcx;
          const sy = cy + dcy;
          this.wanted[cy * this.nx + cx] = sx < 0 || sy < 0 || sx >= this.nx || sy >= this.ny ? 0 : old[sy * this.nx + sx];
        }
    }
    // (round 104, tilecache: what's built goes round with them too — the fresh ones not)
    if (this.built.length === this.nx * this.ny && this.builtSlides === this.slides - 1) {
      const old = this.built.slice();
      for (let cy = 0; cy < this.ny; cy++)
        for (let cx = 0; cx < this.nx; cx++) {
          const sx = cx + dcx;
          const sy = cy + dcy;
          this.built[cy * this.nx + cx] = sx < 0 || sy < 0 || sx >= this.nx || sy >= this.ny ? 0 : old[sy * this.nx + sx];
        }
      this.builtSlides = this.slides;
    }
    // (the CPU's chunk tops go round with them; the fresh ones aren't known yet)
    if (this.tops.length) {
      const old = this.tops.slice();
      for (let cy = 0; cy < this.ny; cy++)
        for (let cx = 0; cx < this.nx; cx++) {
          const sx = cx + dcx;
          const sy = cy + dcy;
          this.tops[cy * this.nx + cx] = sx < 0 || sy < 0 || sx >= this.nx || sy >= this.ny ? this.zHi : old[sy * this.nx + sx];
        }
    }
  }

  /** the rebuild slots a frame for any change (the rest are the urgent chunks') */
  private ordinary = 0;
  /** (round 86) per chunk: frames it stays urgent */
  private urgentLeft = new Uint8Array(0);
  private nearOut = new Uint32Array(0);
  private urgentN = 0;

  /**
   * (round 86) The chunks over world rect (x0, y0)–(x1, y1) changed because of the player — an edit, a piece
   * falling: for the next `frames` frames they're looked at every frame (asleep or not, the band's turn or not)
   * and take the urgent slots, so the change shows the next frame.
   */
  urgent(x0: number, y0: number, x1: number, y1: number, frames = 3): void {
    if (!this.on || this.src) return;
    const n = this.nx * this.ny;
    if (this.urgentLeft.length !== n) this.urgentLeft = new Uint8Array(n);
    const i0 = Math.max(0, Math.floor((x0 - 3) / CHUNK));
    const i1 = Math.min(this.nx - 1, Math.floor((x1 + 3) / CHUNK));
    const j0 = Math.max(0, Math.floor((y0 - 3) / (CHUNK * ROW_H)));
    const j1 = Math.min(this.ny - 1, Math.floor((y1 + 3) / (CHUNK * ROW_H)));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * this.nx + i;
        if (!this.urgentLeft[c]) this.urgentN++;
        this.urgentLeft[c] = Math.max(this.urgentLeft[c], frames);
      }
  }

  /** (round 86) any chunk marked urgent: the window's mesh looks for changes this frame, whoever's turn it is */
  get hasUrgent(): boolean {
    return this.urgentN > 0;
  }

  /** Find the chunks near the view that changed and rebuild a few of them. */
  encode(enc: GPUCommandEncoder, cam: Camera): void {
    if (!this.on) return;
    const chunks = this.nx * this.ny;
    this.device.queue.writeBuffer(this.state, 0, new Uint32Array([0]));
    // (round 86: the ordinary slots' count, the args' spare word)
    this.device.queue.writeBuffer(this.state, this.argsAt + 12, new Uint32Array([0]));
    // (state word 15: the frame, so the second hash pass knows what the first took)
    this.device.queue.writeBuffer(this.state, 15 * 4, new Uint32Array([++this.frameNo]));
    let nearW = this.near;
    if (this.urgentN > 0 || this.wanted) {
      if (this.nearOut.length !== chunks) this.nearOut = new Uint32Array(chunks);
      nearW = this.nearOut;
      nearW.set(this.near);
      for (let c = 0; c < chunks && this.urgentN > 0; c++) {
        if (!this.urgentLeft[c]) continue;
        if (nearW[c]) nearW[c] |= URGENT_BIT;
        if (--this.urgentLeft[c] === 0) this.urgentN--;
      }
      // (round 117, terrain — TR24: the hybrid's chunks the mesh doesn't draw, marked: a drawn chunk's field closes the
      // caves at its side toward them — fieldmesh.wgsl UNMESHED_BIT, colDist)
      if (this.wanted) for (let c = 0; c < chunks; c++) if (!this.wanted[c]) nearW[c] |= UNMESHED_BIT;
    }
    this.device.queue.writeBuffer(this.state, (CHUNK0 + chunks * CSTRIDE) * 4, nearW);
    // (round 80: a band only changes when it's packed — every chunk looked at for a few seconds after; else
    // only the fresh ones, those come into view)
    const passes = this.src && this.framesSincePack > 180 ? ([[this.hashF, this.hashFGroup]] as const) : ([[this.hashF, this.hashFGroup], [this.hash, this.hashGroup]] as const);
    this.framesSincePack++;
    for (const [k, g] of passes) {
      const pass = enc.beginComputePass({ label: `${this.pre}fieldmesh-hash`, timestampWrites: this.profiler.timestamps(`${this.pre}fieldmesh-hash`) });
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, g);
      pass.dispatchWorkgroups(chunks);
      pass.end();
    }
    // (round 81: the rebuild sized to the chunks found changed — none, most frames)
    {
      const pass = enc.beginComputePass({ label: `${this.pre}fieldmesh-args` });
      pass.setPipeline(this.argsK.pipeline);
      pass.setBindGroup(0, this.argsGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      enc.copyBufferToBuffer(this.state, this.argsAt, this.args, 0, 12);
    }
    this.kernels.forEach((k, i) => {
      const st = this.steps[i];
      const name = this.pre + st.name;
      // (the tops only for cavemesh)
      if (st.tops && !this.caveOn) return;
      const pass = enc.beginComputePass({ label: name, timestampWrites: this.profiler.timestamps(name) });
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, this.groups[i]);
      // (round 93: the pool's alloc passes are one workgroup every frame — the releases are given back even when nothing's rebuilt)
      if (st.direct) pass.dispatchWorkgroups(1);
      else pass.dispatchWorkgroupsIndirect(this.args, 0);
      pass.end();
      this.profiler.dispatches++;
    });
    this.profiler.dispatches += 2;
    // (round 93: the free stack's header, now and then — the pool grows when it runs short)
    if (this.pool && READBACK && !this.freeBusy && this.freeEvery++ % POOL_READ_EVERY === 0) {
      enc.copyBufferToBuffer(this.state, this.freeAt * 4, this.freeBuf!, 0, FREE_HEAD * 4);
      this.freeBusy = true;
      this.freeNeeded = true;
    }
    // (round 82: every 60th time, not 10th — the chunks' tops for the culling move slowly)
    if (READBACK && !this.statBusy && this.statEvery++ % this.statPeriod === 0) {
      enc.copyBufferToBuffer(this.state, 0, this.statBuf!, 0, this.statBuf!.size);
      this.statSlides = this.slides;
      this.statBusy = true;
      this.statNeeded = true;
    }
  }

  /**
   * Which chunks are in view (drawn) and near it (rebuilt: a margin, so
   * panning finds them current): each chunk's box in clip space against the
   * screen's edges.
   */
  cull(cam: Camera): void {
    if (!this.on) return;
    const m = cam.viewProj;
    const zHi = this.zHi;
    const chunks = this.nx * this.ny;
    if (this.near.length !== chunks) {
      this.near = new Uint32Array(chunks);
      this.inView = new Uint8Array(chunks);
      this.casts = new Uint8Array(chunks);
      this.tops = new Float32Array(chunks).fill(this.zHi);
    }
    const r: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    // (the lead's offset in clip space: the camera moved on by it)
    const leadOn = this.lead[0] !== 0 || this.lead[1] !== 0;
    const lx = m[0] * this.lead[0] + m[4] * this.lead[1];
    const ly = m[1] * this.lead[0] + m[5] * this.lead[1];
    for (let cy = 0; cy < this.ny; cy++)
      for (let cx = 0; cx < this.nx; cx++) {
        let lo = [Infinity, Infinity];
        let hi = [-Infinity, -Infinity];
        let behind = false;
        // (up to what's in it: a box to the sky covered a long strip of the screen)
        const zTop = Math.min(this.tops[cy * this.nx + cx] + TOP_PAD, zHi);
        for (let k = 0; k < 8; k++) {
          const x = (cx + (k & 1)) * CHUNK;
          const y = (cy + ((k >> 1) & 1)) * CHUNK * ROW_H;
          const z = k & 4 ? zTop : this.zLo;
          // (divided by clip w: the free camera's perspective; a corner behind its eye: keep the chunk)
          const w = m[3] * x + m[7] * y + m[11] * z + m[15];
          if (w <= 1e-3) behind = true;
          const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / Math.max(w, 1e-3);
          const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / Math.max(w, 1e-3);
          lo = [Math.min(lo[0], px), Math.min(lo[1], py)];
          hi = [Math.max(hi[0], px), Math.max(hi[1], py)];
        }
        const c = cy * this.nx + cx;
        // (hybrid: a chunk not wanted is the heightfield's — never looked at, never drawn)
        const want = !this.wanted || this.wanted[c] !== 0;
        const within = (e: number) => want && (behind || (hi[0] >= -e && lo[0] <= e && hi[1] >= -e && lo[1] <= e));
        this.inView[c] = within(1) ? 1 : 0;
        // (round 113, the planner's lead: where the view will be in the mesh's latency at the camera's speed — the
        // chunks there are near too, rebuilt before the screen's on them)
        const ahead = (e: number) => want && (hi[0] - lx >= -e && lo[0] - lx <= e && hi[1] - ly >= -e && lo[1] - ly <= e);
        // (over 1: come near within ten frames — the change pass looks at it even asleep, round 80; ten, so a
        // change found when every rebuild slot was taken is found again)
        const was = this.near[c];
        this.near[c] = within(1.5) || (leadOn && ahead(1.25)) ? (was === 0 ? 11 : Math.max(1, was - 1)) : 0;
        if (this.near[c]) {
          r[0] = Math.min(r[0], cx * CHUNK);
          r[1] = Math.min(r[1], cy * CHUNK * ROW_H);
          r[2] = Math.max(r[2], (cx + 1) * CHUNK);
          r[3] = Math.max(r[3], (cy + 1) * CHUNK * ROW_H);
        }
      }
    // (none near: nothing shows; the rect is the map's, harmlessly)
    this.nearRect = r[0] <= r[2] ? r : [0, 0, this.nx * CHUNK, this.ny * CHUNK * ROW_H];
  }

  /**
   * (round 95, render/rockmesh.ts) A mesh of its own, not the camera's: exactly these chunks (1) are near (looked at
   * for changes, rebuilt) and drawn.
   */
  pin(on: Uint8Array): void {
    if (!this.on) return;
    const chunks = this.nx * this.ny;
    if (this.near.length !== chunks) {
      this.near = new Uint32Array(chunks);
      this.inView = new Uint8Array(chunks);
      this.casts = new Uint8Array(chunks);
      this.tops = new Float32Array(chunks).fill(this.zHi);
    }
    for (let c = 0; c < chunks; c++) {
      this.inView[c] = on[c] ? 1 : 0;
      this.near[c] = on[c] ? (this.near[c] === 0 ? 11 : Math.max(1, this.near[c] - 1)) : 0;
    }
  }

  /** Which chunks lie in the sun's box (its clip space, `light`): they cast into the shadow map. */
  castCull(light: Float32Array): void {
    if (!this.on) return;
    const zHi = this.zHi;
    for (let cy = 0; cy < this.ny; cy++)
      for (let cx = 0; cx < this.nx; cx++) {
        let lx = Infinity;
        let ly = Infinity;
        let hx = -Infinity;
        let hy = -Infinity;
        const zTop = Math.min(this.tops[cy * this.nx + cx] + TOP_PAD, zHi);
        for (let k = 0; k < 8; k++) {
          const x = (cx + (k & 1)) * CHUNK;
          const y = (cy + ((k >> 1) & 1)) * CHUNK * ROW_H;
          const z = k & 4 ? zTop : this.zLo;
          const px = light[0] * x + light[4] * y + light[8] * z + light[12];
          const py = light[1] * x + light[5] * y + light[9] * z + light[13];
          lx = Math.min(lx, px);
          ly = Math.min(ly, py);
          hx = Math.max(hx, px);
          hy = Math.max(hy, py);
        }
        const want = !this.wanted || this.wanted[cy * this.nx + cx] !== 0;
        this.casts[cy * this.nx + cx] = want && hx >= -1 && lx <= 1 && hy >= -1 && ly <= 1 ? 1 : 0;
      }
  }

  /** chunk c's draw: its record's first five words */
  private drawChunk(pass: GPURenderPassEncoder, c: number): void {
    pass.drawIndexedIndirect(this.state, (CHUNK0 + c * CSTRIDE) * 4);
  }

  /** Draw the chunks in view (one indirect draw each). */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.on) return;
    pass.setIndexBuffer(this.indices, 'uint32');
    let n = 0;
    for (let c = 0; c < this.nx * this.ny; c++) {
      if (!this.inView[c]) continue;
      this.drawChunk(pass, c);
      n++;
    }
    this.drawn = n;
    this.profiler.draws += n;
  }

  /** (perfopt, the terrain's cached layer: a margin past the screen) Draw the chunks near the view. */
  drawNear(pass: GPURenderPassEncoder): void {
    if (!this.on) return;
    pass.setIndexBuffer(this.indices, 'uint32');
    for (let c = 0; c < this.nx * this.ny; c++) {
      if (!this.near[c]) continue;
      this.drawChunk(pass, c);
      this.profiler.draws++;
    }
  }

  /** (round 103, tilecache) Draw the chunks marked in `which` (chunkGrid's order). */
  drawMask(pass: GPURenderPassEncoder, which: Uint8Array): number {
    if (!this.on) return 0;
    pass.setIndexBuffer(this.indices, 'uint32');
    let n = 0;
    for (let c = 0; c < this.nx * this.ny; c++) {
      if (!which[c]) continue;
      this.drawChunk(pass, c);
      n++;
    }
    this.profiler.draws += n;
    return n;
  }

  /**
   * (round 103, tilecache) Per chunk, from the last stats readback (every 60th encode): 1 built and drawn (its hash
   * not FRESH, indices), 0 not; valid while `slides` is still `builtSlides` (a slide since moved the chunks).
   */
  built = new Uint8Array(0);
  /** (round 103, tilecache) chunk c's top (window z; the stats readback's, zHi till known) */
  topKnown(c: number): number {
    const t = this.tops[c];
    return t !== undefined && t < this.zHi ? t : -Infinity;
  }
  /** (round 103, tilecache) chunk c's top as topKnown, zHi while unknown */
  topOf(c: number): number {
    return this.tops[c] ?? this.zHi;
  }
  builtSlides = -1;
  private statSlides = -1;

  /** Draw the chunks in the sun's box (the shadow pass: what's out of view but up-sun casts too). */
  drawCasters(pass: GPURenderPassEncoder): void {
    if (!this.on) return;
    pass.setIndexBuffer(this.indices, 'uint32');
    for (let c = 0; c < this.nx * this.ny; c++) {
      if (!this.casts[c]) continue;
      this.drawChunk(pass, c);
      this.profiler.draws++;
    }
  }

  afterSubmit(): void {
    if (this.freeNeeded) {
      this.freeNeeded = false;
      const fb = this.freeBuf!;
      fb.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(fb.getMappedRange().slice(0));
        fb.unmap();
        this.freeBusy = false;
        const [top, , pushed, starved, low, most] = u;
        // (pages not yet pushed — added by a grow the GPU hasn't seen — count as free)
        const free = top + Math.max(0, this.pages - pushed);
        const was = this.poolStats.starved;
        this.poolStats = { ...this.poolStats, pages: this.pages, free, starved, mb: +((this.pages * PAGE_BYTES) / 2 ** 20).toFixed(1), low: low === 0xffffffff ? -1 : low, most };
        // (short of pages — a rebuild found none, or under a fifth left: half again as many)
        if (starved > was || free < this.pages / 5) this.growTo = Math.max(this.growTo, Math.ceil(this.pages * 1.5));
      }, ignoreTeardown);
    }
    if (!this.statNeeded) return;
    this.statNeeded = false;
    const buf = this.statBuf!;
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(buf.getMappedRange());
      let verts = 0;
      let indices = 0;
      let full = 0;
      if (this.built.length !== this.nx * this.ny) this.built = new Uint8Array(this.nx * this.ny);
      for (let c = 0; c < this.nx * this.ny; c++) {
        const b = CHUNK0 + c * CSTRIDE;
        // (round 103, tilecache: built — as far.wgsl meshBuilt reads it; a readback from before a slide isn't)
        if (this.statSlides === this.slides) this.built[c] = u[b + 5] !== FRESH_HASH && u[b + 5] !== 0 && u[b] > 0 ? 1 : 0;
        indices += u[b];
        verts += u[b + 7];
        full += u[b + 9];
        // (0: never looked at yet, its top unknown)
        const t = new Float32Array(u.buffer, (b + 8) * 4, 1)[0];
        if (t > 0) this.tops[c] = t;
      }
      this.stats = { changed: u[0], verts, indices, full };
      if (this.statSlides === this.slides) this.builtSlides = this.slides;
      buf.unmap();
      this.statBusy = false;
    }, ignoreTeardown);
  }
}
