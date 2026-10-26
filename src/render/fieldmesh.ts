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
export const REGION_BYTES = 96;
/** a chunk's side, world units */
const CHUNK = 32;
const ROW_H = Math.sqrt(3) / 2;
/** fieldmesh.wgsl CHUNK0, CSTRIDE (u32s) */
const CHUNK0 = 16;
const CSTRIDE = 13;
/** cells over a chunk's known top its box reaches (growth since the readback, the bevels) */
const TOP_PAD = 4;

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
    // room per chunk: ~1.3k vertices per 1000 columns at spacing 1 (~5k at
    // 0.5; DEVLOG 2026-10-22), a chunk ~1.2k columns, four times that for
    // cliffs and caves
    const vertsPer = Math.ceil((6144 * room) / (h * h) / 64) * 64;
    const indicesPer = vertsPer * 6;
    const chunks = this.nx * this.ny;
    const ab = new ArrayBuffer(REGION_BYTES);
    const f = new Float32Array(ab);
    const u = new Uint32Array(ab);
    f.set([CHUNK, h, CHUNK * ROW_H, h * ROW_H], 0);
    u.set([this.nx, this.ny, this.nz, 1], 4);
    u.set([this.side, this.slots, vertsPer, indicesPer], 8);
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

    const vb = chunks * vertsPer * 32;
    if (vb > device.limits.maxStorageBufferBindingSize) {
      throw new UnsupportedError(`the ${src?.name ?? 'window'}'s mesh needs ${(vb / 2 ** 20).toFixed(0)} MB in one buffer; this GPU binds ${(device.limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MB (a smaller ?win=)`);
    }
    // (COPY_SRC: the world API's smooth sampling is checked against it, scripts/worldapitest.mjs)
    this.verts = world.buf(`${pre}meshVerts`, chunks * vertsPer * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.indices = world.buf(`${pre}meshIndices`, chunks * indicesPer * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX);
    // (then four words a range: its translation — meshregion.wgsl offBase)
    // (then (round 81) three: the rebuild's dispatch — fieldmesh.wgsl rebuildArgs)
    const stateWords = CHUNK0 + chunks * (CSTRIDE + 1) + chunks * 4 + 4;
    this.argsAt = (stateWords - 4) * 4;
    this.args = world.buf(`${pre}meshArgs`, 16, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.state = world.buf(`${pre}meshState`, stateWords * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const init = new Uint32Array(stateWords);
    for (let c = 0; c < chunks; c++) {
      init.set([0, 1, c * indicesPer, c * vertsPer, 0], CHUNK0 + c * CSTRIDE);
      init[CHUNK0 + c * CSTRIDE + 10] = c;
    }
    device.queue.writeBuffer(this.state, 0, init);
    const s = this.side + 3;
    this.scratch = world.buf(`${pre}meshScratch`, this.slots * s * s * this.nz * 8, GPUBufferUsage.STORAGE);
    this.statBuf = world.buf(`${pre}meshStats`, stateWords * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    const parts = [commonWgsl, layersWgsl, materialsWgsl, gridsWgsl, meshRegionWgsl, IDLE_SKIP, NORMALS_GRID, fieldMeshWgsl];
    const spec = { 0: 'uniform', 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw', 30: 'uniform' } as const;
    const group = (k: ComputeKernel) =>
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
    this.hashGroup = group(this.hash);
    this.argsK = makeCompute(device, 'fieldmesh-args', parts, spec, 'rebuildArgs');
    this.argsGroup = group(this.argsK);
    this.hashF = makeCompute(device, 'fieldmesh-hash-fresh', parts, spec, 'hashFresh');
    this.hashFGroup = group(this.hashF);
    for (const entry of ['sampleField', 'makeVerts', 'makeQuads']) {
      const k = makeCompute(device, `fieldmesh-${entry}`, parts, spec, entry);
      this.kernels.push(k);
      this.groups.push(group(k));
    }
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
      const parts = [commonWgsl, layersWgsl, materialsWgsl, gridsWgsl, meshRegionWgsl, IDLE_SKIP, NORMALS_GRID, fieldMeshWgsl];
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

  /** Find the chunks near the view that changed and rebuild a few of them. */
  encode(enc: GPUCommandEncoder, cam: Camera): void {
    if (!this.on) return;
    const chunks = this.nx * this.ny;
    this.device.queue.writeBuffer(this.state, 0, new Uint32Array([0]));
    // (state word 15: the frame, so the second hash pass knows what the first took)
    this.device.queue.writeBuffer(this.state, 15 * 4, new Uint32Array([++this.frameNo]));
    this.device.queue.writeBuffer(this.state, (CHUNK0 + chunks * CSTRIDE) * 4, this.near);
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
      const name = this.pre + ['fieldmesh-sample', 'fieldmesh-verts', 'fieldmesh-quads'][i];
      const pass = enc.beginComputePass({ label: name, timestampWrites: this.profiler.timestamps(name) });
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, this.groups[i]);
      pass.dispatchWorkgroupsIndirect(this.args, 0);
      pass.end();
    });
    this.profiler.dispatches += 5;
    // (round 82: every 60th time, not 10th — the chunks' tops for the culling move slowly)
    if (READBACK && !this.statBusy && this.statEvery++ % 60 === 0) {
      enc.copyBufferToBuffer(this.state, 0, this.statBuf!, 0, this.statBuf!.size);
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
        const within = (e: number) => behind || (hi[0] >= -e && lo[0] <= e && hi[1] >= -e && lo[1] <= e);
        this.inView[c] = within(1) ? 1 : 0;
        // (over 1: come near within ten frames — the change pass looks at it even asleep, round 80; ten, so a
        // change found when every rebuild slot was taken is found again)
        const was = this.near[c];
        this.near[c] = within(1.5) ? (was === 0 ? 11 : Math.max(1, was - 1)) : 0;
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
        this.casts[cy * this.nx + cx] = hx >= -1 && lx <= 1 && hy >= -1 && ly <= 1 ? 1 : 0;
      }
  }

  /** Draw the chunks in view (one indexed indirect draw each). */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.on) return;
    pass.setIndexBuffer(this.indices, 'uint32');
    let n = 0;
    for (let c = 0; c < this.nx * this.ny; c++) {
      if (!this.inView[c]) continue;
      pass.drawIndexedIndirect(this.state, (CHUNK0 + c * CSTRIDE) * 4);
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
      pass.drawIndexedIndirect(this.state, (CHUNK0 + c * CSTRIDE) * 4);
      this.profiler.draws++;
    }
  }

  /** Draw the chunks in the sun's box (the shadow pass: what's out of view but up-sun casts too). */
  drawCasters(pass: GPURenderPassEncoder): void {
    if (!this.on) return;
    pass.setIndexBuffer(this.indices, 'uint32');
    for (let c = 0; c < this.nx * this.ny; c++) {
      if (!this.casts[c]) continue;
      pass.drawIndexedIndirect(this.state, (CHUNK0 + c * CSTRIDE) * 4);
      this.profiler.draws++;
    }
  }

  afterSubmit(): void {
    if (!this.statNeeded) return;
    this.statNeeded = false;
    const buf = this.statBuf!;
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(buf.getMappedRange());
      let verts = 0;
      let indices = 0;
      let full = 0;
      for (let c = 0; c < this.nx * this.ny; c++) {
        const b = CHUNK0 + c * CSTRIDE;
        indices += u[b];
        verts += u[b + 7];
        full += u[b + 9];
        // (0: never looked at yet, its top unknown)
        const t = new Float32Array(u.buffer, (b + 8) * 4, 1)[0];
        if (t > 0) this.tops[c] = t;
      }
      this.stats = { changed: u[0], verts, indices, full };
      buf.unmap();
      this.statBusy = false;
    }, ignoreTeardown);
  }
}
