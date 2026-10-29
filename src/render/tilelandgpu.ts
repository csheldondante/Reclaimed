// Render-only land for the tile cache with nothing read back (round 105, `tilelatency`; DECISIONS round 105 — the
// user: "If the time to generate them is on the ms scale how can it take so long to show? Don't we prioritize the
// rendering latency for those tiles?" and "Why does the CPU readback and all of that happen all we care about is
// visuals until your character gets there.").
//
// The playable path (round 104's) made a region the streamer's way: the settlements' plan awaited, the
// finish read back (its summary to the CPU), the CPU's loop over it, the mesher's frames, one bake a frame. Here a
// region is made for its tile alone and stays on the GPU from the ask to the draw:
//   1. (round 108, TC18) the window's own generation (Streamer.tileLand -> Atlas.regionInto, how: the tiles' lane of
//      the pacer, the plans already made stamped and none started, the per-column summary left on the GPU) into a
//      scratch slot — (TC19) the region and a border of its neighbours' cells round it, in the corner of a wider slot;
//      it resolves when the last is submitted.
//   2. The next frame, in one encoder: the slot brought into the tiles' world (render/tileworld.ts) and the window's
//      render preparation run on it — SurfaceSystem and RenderFieldsSystem, as on the window's land (the loose ground's
//      drift, the moisture, the rivers' flow); then tilelandgpu.wgsl prep (the region's lowest and highest) and camera
//      (the bake's box, scale and camera, and what the tile was baked at — the slot's TP); then the bake: every chunk
//      drawn as the hybrid's grid through its columns' tops into the G-buffer, fsTileBake into the atlas. Several a
//      frame (?tilebakes=, 4), none waiting on another.
// The window's own trailing bakes wait a frame the land bakes (TileCache.encode). Not yet: the mesher's chunks (a gap
// open to the air: arches, caves — BACKLOG TC12) — the grid draws their tops.

import type { Profiler } from '../gpu/profiler';
import { makeBindGroup, makeCompute, type ComputeKernel } from '../gpu/pipeline';
import type { WorldGpu } from '../sim/world-gpu';
import { Pages } from '../sim/pages';
import { GLOBALS_HEAD_BYTES } from '../sim/globals';
import { CHUNK } from '../world/layout';
import { ROW_H } from '../world/lattice';
import type { Camera } from './camera';
import type { Basis, TileCache } from './tilecache';
import type { LandTimes, TileLandSource } from './tileland';
import { TileWorld } from './tileworld';
import type { CoverSource } from '../weather/cover';
import tileLandGpuWgsl from '../shaders/tilelandgpu.wgsl?raw';

const R = 64;
/** regions made at once (a scratch slot each): ?tilelandn= */
const IN_FLIGHT = Math.max(1, Number(new URLSearchParams(location.search).get('tilelandn') ?? 6) | 0);
/** bakes a frame at most: ?tilebakes= */
const BAKES = Math.max(1, Number(new URLSearchParams(location.search).get('tilebakes') ?? 4) | 0);
/** the bake's view of the scratch: its mesh chunks' side (cells; the grid's lattice: meshdraw.wgsl GRID_N = side + 2) */
const MESH_SIDE = 32;
/** the tiles' overlap past their region (tilecache.ts OVERLAP) */
const OVERLAP = 1;

export type TileLandGpuSource = TileLandSource;

export interface TileLandGpuHost {
  device: GPUDevice;
  world: WorldGpu;
  profiler: Profiler;
  meshLayout: GPUBindGroupLayout;
  resolveLayout: GPUBindGroupLayout;
  gridPipe: () => GPURenderPipeline | undefined;
  drawGrid: (pass: GPURenderPassEncoder, which: Uint8Array) => void;
  meshResources: (cam: GPUBuffer) => Record<number, GPUBuffer | GPUTextureView | GPUSampler>;
  camBytes: number;
  /** the frame's camera data as written (the bake camera's start: the compute writes its matrix and place over it) */
  camData: () => ArrayBuffer;
  /** (round 108, TC20) the weather's cover told of a tile's land as made (weather/cover.ts seed) */
  seedCover: (enc: GPUCommandEncoder, src: CoverSource, side: number, lo: number, hi: number) => void;
}

/** a scratch slot's own buffers: its summary, its Globals' patch, chunk table, box, camera, job (its land: `land`'s) */
interface Slot {
  patch: GPUBuffer;
  table: GPUBuffer;
  summ: GPUBuffer;
  box: GPUBuffer;
  cam: GPUBuffer;
  job: GPUBuffer;
  prep?: GPUBindGroup;
  g?: GPUBindGroup;
  r?: GPUBindGroup;
}

interface Job {
  rx: number;
  ry: number;
  slot: number;
  oz: number;
  /** its land submitted (generated) */
  made: boolean;
  times: LandTimes;
}

export class TileLandGpu {
  readonly stats = { made: 0, baked: 0, failed: 0, inFlight: 0, dropped: 0, bakesLastFrame: 0, noSlot: 0 };
  readonly latencies: LandTimes[] = [];
  private land: GPUBuffer;
  /** (round 108, TC18) where a slot's land is prepared as the window's is, and drawn from */
  private tw: TileWorld;
  /** the scratch's side (its layout's R: the region, its border, to whole pages) and the border (cells) */
  private S: number;
  private border: number;
  private slots: Slot[] = [];
  private slotJob: (Job | null)[];
  private jobs = new Map<string, Job>();
  private prepK: ComputeKernel;
  private camK: ComputeKernel;
  private failed = new Set<string>();
  private firstWanted = new Map<string, number>();
  private pendingDraw: LandTimes[] = [];
  /** the grid's chunks across and down the scratch (its lattice's), all of them drawn */
  private nx: number;
  private all: Uint8Array;

  constructor(private host: TileLandGpuHost, private src: TileLandGpuSource, private cache: TileCache) {
    const dev = host.device;
    const w = host.world;
    const L = src.layout;
    this.S = L.R;
    this.border = src.border;
    if (this.border & 1 || R + 2 * this.border > L.R) throw new Error(`TileLandGpu: a border of ${this.border} round ${R}² regions in a ${L.R}² slot`);
    if (L.bytes % 256) throw new Error('TileLandGpu: a region record must be 256-byte aligned');
    if (w.globals.size < 480 * 4) throw new Error('TileLandGpu: the Globals have no ring (words 476-479)');
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.land = w.buf('tileland-gpu regions', L.bytes * IN_FLIGHT, S | GPUBufferUsage.COPY_SRC);
    this.slotJob = new Array(IN_FLIGHT).fill(null);
    this.tw = new TileWorld(dev, w, host.profiler, L, this.land);
    this.nx = Math.ceil((this.S + 0.5) / MESH_SIDE);
    const ny = Math.ceil(this.S / MESH_SIDE);
    const B = R + 2 * this.border;
    this.all = new Uint8Array(this.nx * ny).fill(1);
    for (let s = 0; s < IN_FLIGHT; s++) {
      // (a chunk table onto the slot's pages: chunk (i, j) of the region is page j · rc + i)
      const t = new Uint32Array(L.rc * L.rc * 2);
      const at = (s * L.bytes) / 16;
      for (let p = 0; p < L.rc * L.rc; p++) t.set([at + p * L.K * CHUNK * CHUNK, L.K], p * 2);
      const table = w.buf(`tileland-gpu chunks ${s}`, t.byteLength, S | GPUBufferUsage.COPY_SRC);
      dev.queue.writeBuffer(table, 0, t);
      this.slots.push({
        patch: w.buf(`tileland-gpu globals patch ${s}`, w.globals.size, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
        table,
        summ: w.buf(`tileland-gpu summary ${s}`, B * B * 16, S),
        box: w.buf(`tileland-gpu box ${s}`, 16, S),
        cam: dev.createBuffer({ label: `tileland-gpu bake camera ${s}`, size: host.camBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        job: dev.createBuffer({ label: `tileland-gpu job ${s}`, size: 7 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      });
    }
    const spec = { 0: 'uniform', 1: 'read', 3: 'rw', 4: 'rw', 5: 'rw' } as const;
    this.prepK = makeCompute(dev, 'tileland-gpu prep', [tileLandGpuWgsl], spec, 'prep');
    this.camK = makeCompute(dev, 'tileland-gpu camera', [tileLandGpuWgsl], spec, 'camera');
  }

  /** the tiles' world's Globals for slot s: the frame's, its size, chunks, origin (the border's corner) and grid the
   *  scratch's, no sleep, no ring */
  private patchGlobals(enc: GPUCommandEncoder, s: number, rx: number, ry: number): void {
    const sl = this.slots[s];
    const S = this.S;
    const ab = new ArrayBuffer(this.host.world.globals.size);
    const u = new Uint32Array(ab);
    const f = new Float32Array(ab);
    u[0] = S;
    u[1] = S;
    u[4] = S / CHUNK;
    const x0 = rx * R - this.border;
    const y0 = ry * R - this.border;
    f.set([x0, y0 * ROW_H, x0, y0], 276);
    // (the grid's chunks across and their side: meshdraw.wgsl gridVertex)
    f[281] = this.nx;
    f[282] = MESH_SIDE;
    // (the sleep, drowse and hfield bits, and the ring — round 105, ringwin: words 476-479 — all 0)
    u.fill(0, 284, 480);
    // (round 107, pages: the page table a plain R-wide window's, the identity at offset 0 — sim/pages.ts)
    const sp = (this.scratchPages ??= new Pages(S, S, null));
    // (the table's way only: the ring computed keeps the tables a vec4 each, and the scratch's ring is 0)
    if (this.host.world.pageVec4 * 8 >= sp.entries.length) {
      new Uint16Array(ab, GLOBALS_HEAD_BYTES, sp.entries.length).set(sp.entries);
      new Uint16Array(ab, GLOBALS_HEAD_BYTES + this.host.world.pageVec4 * 16, sp.inv.length).set(sp.inv);
    }
    this.host.device.queue.writeBuffer(sl.patch, 0, ab);
    const g = this.tw.globals;
    enc.copyBufferToBuffer(this.host.world.globals, 0, g, 0, g.size);
    enc.copyBufferToBuffer(sl.patch, 0, g, 0, 8);
    enc.copyBufferToBuffer(sl.patch, 16, g, 16, 4);
    enc.copyBufferToBuffer(sl.patch, 276 * 4, g, 276 * 4, 16);
    enc.copyBufferToBuffer(sl.patch, 281 * 4, g, 281 * 4, 8);
    enc.copyBufferToBuffer(sl.patch, 284 * 4, g, 284 * 4, (480 - 284) * 4);
    enc.copyBufferToBuffer(sl.patch, GLOBALS_HEAD_BYTES, g, GLOBALS_HEAD_BYTES, g.size - GLOBALS_HEAD_BYTES);
  }
  /** (round 107, pages) the scratch window's page table */
  private scratchPages: Pages | null = null;

  /** slot s's groups: the prep's, the bake's G-buffer pass (the grid: the mesh's layout), the resolve */
  private groupsOf(s: number): Slot {
    const sl = this.slots[s];
    if (sl.g) return sl;
    const h = this.host;
    const tw = this.tw;
    sl.prep = makeBindGroup(h.device, 'tileland-gpu prep', this.prepK.layout, { 0: sl.job, 1: sl.summ, 3: sl.box, 4: sl.cam, 5: this.cache.params });
    // (the mesh's own buffers aren't drawn — the grid draws every chunk — but its layout binds them: the window's;
    // the land and what's prepared from it the tiles' world's — round 108, TC18)
    const res: Record<number, GPUBuffer | GPUBufferBinding | GPUTextureView | GPUSampler> = {
      ...h.meshResources(sl.cam),
      0: tw.globals,
      1: sl.table,
      4: tw.contam,
      6: tw.veg,
      7: tw.renderFields,
      8: tw.water,
      9: this.land,
      11: tw.surface,
      13: tw.wilt,
      17: tw.driftView,
    };
    const ent = (r: typeof res) => Object.entries(r).map(([b, x]) => ({ binding: Number(b), resource: x instanceof GPUBuffer ? { buffer: x } : x }));
    const [g0, g1] = this.cache.gbufViews;
    sl.g = h.device.createBindGroup({ label: 'tileland-gpu grid', layout: h.meshLayout, entries: ent(res) });
    sl.r = h.device.createBindGroup({ label: 'tileland-gpu resolve', layout: h.resolveLayout, entries: [...ent(res), { binding: 40, resource: g0 }, { binding: 41, resource: g1 }, { binding: 22, resource: tw.riverFlowView }, { binding: 47, resource: this.host.world.coverView }, { binding: 62, resource: tw.riverWetView }] });
    return sl;
  }

  /** the window mesh's buffers changed (its pool grew): the groups that bind them made again */
  invalidate(): void {
    for (const sl of this.slots) sl.g = sl.r = sl.prep = undefined;
  }

  private free(j: Job): void {
    this.jobs.delete(`${j.rx},${j.ry}`);
    this.slotJob[j.slot] = null;
  }

  /**
   * A frame's step: bake what was made (the camera's way first, up to BAKES), then ask for the next regions the
   * camera's way into the free slots (one a frame: the pacer spreads their GPU work). True when it baked this frame.
   */
  step(enc: GPUCommandEncoder, cam: Camera, B: Basis, rp: number): boolean {
    const now = performance.now();
    this.stats.inFlight = this.jobs.size;
    const order = this.cache.wanted(cam, (k) => this.failed.has(k), 32);
    // (when each region came into the look-ahead: one that left it before its turn drops out, its wait from its return)
    const inOrder = new Set(order.map((w) => `${w.rx},${w.ry}`));
    for (const k of this.firstWanted.keys()) if (!inOrder.has(k) && !this.jobs.has(k)) this.firstWanted.delete(k);
    for (const k of inOrder) if (!this.firstWanted.has(k) && !this.jobs.has(k)) this.firstWanted.set(k, now);
    this.pendingDraw = this.pendingDraw.filter((t) => {
      const [rx, ry] = t.key.split(',').map(Number);
      if (!this.cache.drawsRegion(rx, ry)) return now - t.baked < 10000;
      t.drawn = now;
      this.latencies.push(t);
      if (this.latencies.length > 500) this.latencies.shift();
      this.firstWanted.delete(t.key);
      return false;
    });
    // (the bakes: what's made, the camera's way first)
    const rank = new Map(order.map((w, i) => [`${w.rx},${w.ry}`, i]));
    const made = [...this.jobs.values()].filter((j) => j.made).sort((a, b) => (rank.get(`${a.rx},${a.ry}`) ?? 1e6) - (rank.get(`${b.rx},${b.ry}`) ?? 1e6));
    const gp = this.host.gridPipe();
    let baked = 0;
    for (const job of made) {
      if (baked >= BAKES || !gp) break;
      if (this.cache.hasTile(job.rx, job.ry, cam.azimuth)) {
        this.free(job);
        this.stats.dropped++;
        continue;
      }
      job.times.cur = performance.now();
      if (!this.bake(enc, cam, B, rp, job, gp)) {
        this.stats.noSlot++;
        // (round 108: the atlas full of what the screen draws — what's made for regions no longer wanted lets its slot go)
        for (const j of made) if (!rank.has(`${j.rx},${j.ry}`)) {
          this.free(j);
          this.stats.dropped++;
        }
        break;
      }
      job.times.baked = performance.now();
      this.pendingDraw.push(job.times);
      this.free(job);
      this.stats.baked++;
      baked++;
    }
    this.stats.bakesLastFrame = baked;
    // (the next: the first of the camera's way not being made, into every free slot — the pacer spreads their GPU work)
    for (let free = this.slotJob.indexOf(null); free >= 0; free = this.slotJob.indexOf(null)) {
      const want = order.find((w) => !this.jobs.has(`${w.rx},${w.ry}`));
      if (!want) break;
      {
        const L = this.src.layout;
        const sl = this.slots[free];
        const p = this.src.landTile(want.rx * R, want.ry * R, this.land, free * L.bytes, { buf: sl.summ, off: 0 });
        if (!p) break;
        {
          const key = `${want.rx},${want.ry}`;
          const t0 = performance.now();
          const times: LandTimes = { key, wanted: this.firstWanted.get(key) ?? t0, start: t0, cols: 0, ways: 0, mapped: 0, ready: 0, cur: 0, baked: 0, drawn: 0 };
          const j: Job = { rx: want.rx, ry: want.ry, slot: free, oz: this.src.oz(), made: false, times };
          this.jobs.set(key, j);
          this.slotJob[free] = j;
          p.then(
            () => {
              j.made = true;
              times.mapped = times.ready = performance.now();
              this.stats.made++;
            },
            (e) => {
              console.warn('tileland-gpu: no land for', want, e);
              this.failed.add(key);
              this.stats.failed++;
              this.free(j);
            },
          );
        }
      }
    }
    return baked > 0;
  }

  /** one region's bake, all on the GPU: the Globals, the prep, the camera, the grid into the G-buffer, the resolve */
  private bake(enc: GPUCommandEncoder, cam: Camera, B: Basis, rp: number, job: Job, gp: GPURenderPipeline): boolean {
    const t = this.cache.allocTile(job.rx, job.ry, cam.azimuth);
    if (!t) return false;
    t.gpu = true;
    const [sx, sy, SW, SH] = this.cache.slotPx(t);
    const sl = this.groupsOf(job.slot);
    const dev = this.host.device;
    this.patchGlobals(enc, job.slot, job.rx, job.ry);
    // (round 108, TC18: the slot into the tiles' world, the window's render preparation run on it)
    this.tw.arrive(enc, sl.table, job.slot * this.src.layout.bytes);
    this.tw.prepare(enc);
    // (round 108, TC20: the weather's cover told of the land as made — the texels it holds nothing of yet)
    this.host.seedCover(enc, this.tw, this.S, this.border, this.border + R);
    // (the job: the view, the scale, the scratch's oz, the atlas slot, its corner and size, the anchor (the region's
    // corner in the scratch: past the border), the region, the overlap, the border, the batch's side)
    const b = this.border;
    dev.queue.writeBuffer(sl.job, 0, new Float32Array([...B.r, 0, ...B.u, 0, ...B.f, B.sz, rp, job.oz, t.slot, 0, sx, sy, SW, SH, b, b * ROW_H, -job.oz, 0, R, OVERLAP, b, R + 2 * b]));
    dev.queue.writeBuffer(sl.box, 0, new Int32Array([0x7fffffff, -0x7fffffff, 0, 0]));
    // (the bake camera's start: the frame's — its eye, viewport, no cut — the compute writes its matrix and place)
    const cd = new Float32Array(this.host.camData().slice(0));
    cd.fill(0, 44);
    dev.queue.writeBuffer(sl.cam, 0, cd);
    const cp = enc.beginComputePass({ label: 'tileland-gpu', timestampWrites: this.host.profiler.timestamps('tile-box') });
    cp.setPipeline(this.prepK.pipeline);
    cp.setBindGroup(0, sl.prep!);
    cp.dispatchWorkgroups(Math.ceil((R + 2 * b) / 8), Math.ceil((R + 2 * b) / 8));
    cp.setPipeline(this.camK.pipeline);
    cp.setBindGroup(0, sl.prep!);
    cp.dispatchWorkgroups(1);
    cp.end();
    this.cache.encodeBake(enc, sx, sy, SW, SH, (g) => {
      g.setPipeline(gp);
      g.setBindGroup(0, sl.g!);
      this.host.drawGrid(g, this.all);
    }, [sl.r!]);
    return true;
  }

  afterSubmit(): void {}
}
