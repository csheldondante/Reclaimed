// Render-only land for the tile cache (round 104, TC2; DECISIONS round 104 — the user: "a LOD that used hybrid
// heightmap and other mesher only where needed and that has no simulation active we can generate an isometric tile
// for the terrain with material and normal detail only then compose cheaply in screen space").
//
// A region past the window that no tile draws yet (on screen, nearest the middle first) is made on the GPU as the
// window's would be (Streamer.landInto: gpugen's finish, straight into a scratch region in the pool's layout), meshed
// by a field mesh of its own over that scratch (a "window" one region across: its own Globals with the region's
// size and origin, a chunk table onto the scratch's pages, the scratch's kept fields bound where the window's are),
// baked into a tile (TileCache.bakeTile: the same G-buffer and fsTileBake), and let go: the scratch is the next
// region's. Nothing of it simulates; nothing of it stays but the tile. (Round 105, tileahead: the camera's way first,
// a few regions made at once in slots of their own, one meshed and baked at a time.)
//
// Not yet: the wetness
// (renderFields is the sim's: dry here); the drift (none); the region's neighbours (its edges are open: the columns
// past them go on as the edge's, so a cliff at a region's edge is cut — the tiles overlap a cell).

import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import type { FinishMeta } from '../atlas/finish';
import type { RegionLayout } from '../world/region-record';
import { CHUNK, sfPack } from '../world/layout';
import { ROW_H } from '../world/lattice';
import type { Camera } from './camera';
import { FieldMesh } from './fieldmesh';
import type { Basis, TileCache } from './tilecache';

const R = 64;
/** frames the scratch's mesh is given to build (its six chunks, two a frame, and a margin) */
const MESH_FRAMES = 8;

/** what makes a region's land (level.ts: the streamer's) */
export interface TileLandSource {
  layout: RegionLayout;
  /** the window's oz (the land is cut at it) */
  oz(): number;
  landInto(x0: number, y0: number, buf: GPUBuffer, off: number): Promise<FinishMeta> | null;
  /** (round 105, tilelatency) the atlas's trace of a streamed build (Atlas.builds: its tiles' turns, the ways, the finish) */
  trace?(x0: number, y0: number): { t0: number; tiles: number[]; ways: number; mapped: number } | undefined;
}

/** (round 105, tilelatency) a region's way from wanted to drawn (performance.now() ms) */
export interface LandTimes {
  key: string;
  wanted: number;
  start: number;
  cols: number;
  ways: number;
  mapped: number;
  ready: number;
  cur: number;
  baked: number;
  drawn: number;
}

/** what the renderer lends it */
export interface TileLandHost {
  device: GPUDevice;
  world: WorldGpu;
  profiler: Profiler;
  meshLayout: GPUBindGroupLayout;
  resolveLayout: GPUBindGroupLayout;
  gPipe: () => GPURenderPipeline | undefined;
  /** (hybrid) the grid's G-buffer pipeline and drawing a set of its chunks (renderer.ts drawGrid); none: every chunk meshed */
  gridPipe: () => GPURenderPipeline | undefined;
  drawGrid: (pass: GPURenderPassEncoder, which: Uint8Array) => void;
  /** the window mesh's draw resources for this camera (renderer.ts meshResources): the textures and the shadow kept */
  meshResources: (cam: GPUBuffer) => Record<number, GPUBuffer | GPUTextureView | GPUSampler>;
  camBytes: number;
}

/** (hybrid.ts columnNeeds) a gap open to the air: a neighbour's top under a column's highest gap's roof */
const GAP_OPEN = 0.25;
/** (round 105, tileahead) regions made at once (each its own scratch slot): ?tilelandn= */
const IN_FLIGHT = Math.max(1, Number(new URLSearchParams(location.search).get('tilelandn') ?? 3) | 0);

/** a region being made: its scratch slot; once its land is in, what the bake needs of it */
interface Job {
  rx: number;
  ry: number;
  slot: number;
  oz: number;
  t0: number;
  ready?: { su: Uint32Array; need: Uint8Array; lo: number; hi: number; meshed: number };
  /** (round 105, tilelatency) its times */
  times: LandTimes;
}

export class TileLand {
  readonly stats = { made: 0, baked: 0, failed: 0, genMs: 0, lastMs: 0, meshed: 0, gridded: 0, inFlight: 0, dropped: 0 };
  /** per scratch mesh chunk of the region being baked: meshed (a gap open to the air in it — hybrid.ts's rule), the rest the grid's */
  private need: Uint8Array;
  private flat: Uint8Array;
  /** the scratch slots (IN_FLIGHT regions in the pool's layout, one buffer), which are a job's */
  private slots: GPUBuffer;
  private slotJob: (Job | null)[];
  private jobs = new Map<string, Job>();
  /** the region being meshed and baked (one at a time: the scratch's field mesh, chunk table, surface) */
  private cur: { job: Job; frames: number } | null = null;
  private globals: GPUBuffer;
  private patch: GPUBuffer;
  private patchData: ArrayBuffer;
  private table: GPUBuffer;
  private surface: GPUBuffer;
  private fields: GPUBuffer;
  private drift: GPUTexture;
  private mesh: FieldMesh;
  private cam: GPUBuffer;
  /** per slot: its draw groups (the mesh's G-buffer pass, the resolve) */
  private groupsOf: ({ g: GPUBindGroup; r: GPUBindGroup } | null)[];
  private poolSeen = -1;
  /** regions asked for that came to nothing (no land made): not asked again */
  private failed = new Set<string>();

  constructor(private host: TileLandHost, private src: TileLandSource, private cache: TileCache) {
    const dev = host.device;
    const w = host.world;
    const L = src.layout;
    if (L.R !== R) throw new Error(`TileLand: regions of ${L.R}, not ${R}`);
    if (L.bytes % 256) throw new Error('TileLand: a region record must be 256-byte aligned');
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.slots = w.buf('tileland regions', L.bytes * IN_FLIGHT, S | GPUBufferUsage.COPY_SRC);
    this.slotJob = new Array(IN_FLIGHT).fill(null);
    this.groupsOf = new Array(IN_FLIGHT).fill(null);
    this.globals = w.buf('tileland globals', w.globals.size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.patchData = new ArrayBuffer(w.globals.size);
    this.patch = w.buf('tileland globals patch', w.globals.size, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    // (a chunk table onto the slot's pages: chunk (i, j) of the region is page j · rc + i — written per region)
    this.table = w.buf('tileland chunks', L.rc * L.rc * 8, S);
    this.surface = w.buf('tileland surface', R * R * 4, S);
    this.fields = w.buf('tileland renderFields', R * R * 16, S);
    this.drift = dev.createTexture({ label: 'tileland drift', size: [R, R], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    // (its field mesh: a window one region across — its Globals, chunk table and layers the scratch's)
    const fake = Object.assign(Object.create(w) as WorldGpu, { w: R, h: R, globals: this.globals });
    const frames = w.buf('tileland frames', w.strFrames.size, S);
    const vox = w.buf('tileland vox', 16, S);
    this.mesh = new FieldMesh(dev, fake, host.profiler, true, 1, { name: 'tileland', chunks: this.table, layers: this.slots, frames, vox, zSpan: w.zMax, slots: 2, pages: 192 });
    this.mesh.openEdges();
    const [nx, ny] = this.mesh.chunkGrid;
    this.need = new Uint8Array(nx * ny);
    this.flat = new Uint8Array(nx * ny);
    this.cam = dev.createBuffer({ label: 'tileland bake camera', size: host.camBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** the Globals the scratch's passes read: the frame's, its size, chunks and origin the region's, no sleep */
  // (round 105, ringwin: the window's columns addressed as a ring — colIdx, texCol wrap by Globals.ring, words 476-479;
  // the scratch is a plain window one region across, its fields row-major in the region's layout: its ring is 0)
  private patchGlobals(enc: GPUCommandEncoder, rx: number, ry: number): void {
    const u = new Uint32Array(this.patchData);
    const f = new Float32Array(this.patchData);
    u[0] = R;
    u[1] = R;
    u[4] = R / CHUNK;
    f.set([rx * R, ry * R * ROW_H, rx * R, ry * R], 276);
    // (the grid's chunks across and their side: meshdraw.wgsl gridVertex)
    const [nx, , side] = this.mesh.chunkGrid;
    f[281] = nx;
    f[282] = side;
    // (the sleep, drowse and hfield bits, and the ring: 0)
    u.fill(0, 284, Math.min(480, u.length));
    this.host.device.queue.writeBuffer(this.patch, 0, this.patchData);
    enc.copyBufferToBuffer(this.host.world.globals, 0, this.globals, 0, this.globals.size);
    enc.copyBufferToBuffer(this.patch, 0, this.globals, 0, 8);
    enc.copyBufferToBuffer(this.patch, 16, this.globals, 16, 4);
    enc.copyBufferToBuffer(this.patch, 276 * 4, this.globals, 276 * 4, 16);
    enc.copyBufferToBuffer(this.patch, 281 * 4, this.globals, 281 * 4, 8);
    if (this.globals.size < 480 * 4) throw new Error('TileLand: the Globals have no ring (words 476-479)');
    enc.copyBufferToBuffer(this.patch, 284 * 4, this.globals, 284 * 4, (480 - 284) * 4);
  }

  /** slot s's draw groups (its kept fields at their offsets), made again when the scratch mesh's pool grows */
  private groups(s: number): { g: GPUBindGroup; r: GPUBindGroup } {
    const v = this.mesh.maintain();
    if (v !== this.poolSeen) {
      this.poolSeen = v;
      this.groupsOf.fill(null);
    }
    const have = this.groupsOf[s];
    if (have) return have;
    const h = this.host;
    const L = this.src.layout;
    const base = s * L.bytes;
    const kept = (name: string): GPUBufferBinding => {
      const b = L.bufs.find((x) => x.name === name);
      if (!b) throw new Error(`TileLand: the region layout keeps no ${name}`);
      return { buffer: this.slots, offset: base + b.off, size: b.bytes };
    };
    const res: Record<number, GPUBuffer | GPUBufferBinding | GPUTextureView | GPUSampler> = {
      ...h.meshResources(this.cam),
      0: this.globals,
      1: this.table,
      3: this.mesh.vertexBuffer,
      4: kept('contam'),
      5: this.mesh.stateBuffer,
      6: kept('veg'),
      7: this.fields,
      8: kept('water'),
      9: this.slots,
      11: this.surface,
      13: kept('wilt'),
      17: this.drift.createView(),
      30: this.mesh.region,
    };
    const ent = (r: typeof res) => Object.entries(r).map(([b, x]) => ({ binding: Number(b), resource: x instanceof GPUBuffer ? { buffer: x } : x }));
    const [g0, g1] = this.cache.gbufViews;
    const o = {
      g: h.device.createBindGroup({ label: 'tileland mesh', layout: h.meshLayout, entries: ent(res) }),
      r: h.device.createBindGroup({ label: 'tileland resolve', layout: h.resolveLayout, entries: [...ent(res), { binding: 40, resource: g0 }, { binding: 41, resource: g1 }] }),
    };
    this.groupsOf[s] = o;
    return o;
  }

  /** what the bake needs of a region's land: its surface packed, its box, the chunks the mesher draws (the rest the grid's) */
  private readyOf(m: FinishMeta, oz: number): NonNullable<Job['ready']> {
    const su = new Uint32Array(R * R);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < R * R; i++) {
      su[i] = sfPack(m.surface[i], 0);
      lo = Math.min(lo, m.surface[i]);
      hi = Math.max(hi, m.colTop[i] - oz, m.surface[i]);
    }
    // (the hybrid's rule, the user's "mesher only where needed": a chunk with a gap open to the air is meshed, the
    // rest drawn as the grid through its columns' tops — without the grid, all meshed)
    const grid = !!this.host.gridPipe();
    const [nx, , side] = this.mesh.chunkGrid;
    const need = new Uint8Array(this.need.length).fill(grid ? 0 : 1);
    if (grid)
      for (let y = 0; y < R; y++)
        for (let x = 0; x < R; x++) {
          const g = m.gapTop[y * R + x];
          if (!(g > -1e30)) continue;
          let open = false;
          for (let dy = -1; dy <= 1 && !open; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const qx = x + dx;
              const qy = y + dy;
              if (!(dx || dy) || qx < 0 || qy < 0 || qx >= R || qy >= R) continue;
              if (m.colTop[qy * R + qx] < g - GAP_OPEN) {
                open = true;
                break;
              }
            }
          if (!open) continue;
          const wx = x + 0.5 + 0.5 * (y & 1);
          need[Math.min(need.length / nx - 1, Math.floor((y + 0.5) / side)) * nx + Math.min(nx - 1, Math.floor(wx / side))] = 1;
        }
    return { su, need, lo: lo - 2, hi: hi + 2, meshed: need.reduce((a, v) => a + v, 0) };
  }

  /** a job done or dropped: its slot free */
  private free(j: Job): void {
    this.jobs.delete(`${j.rx},${j.ry}`);
    this.slotJob[j.slot] = null;
  }

  /**
   * A frame's step: start making the next region the camera's way (one a frame, IN_FLIGHT at once), mesh and bake one
   * whose land is in — the one the camera reaches first. True when it baked this frame (the window's bakes wait).
   */
  /** (round 105, tilelatency) when each region was first wanted (the wanted list's first 32, each frame) */
  private firstWanted = new Map<string, number>();
  /** (round 105, tilelatency) the regions baked, their times, waiting to be drawn (TileCache.drawsAt) and done */
  private pendingDraw: LandTimes[] = [];
  readonly latencies: LandTimes[] = [];

  step(enc: GPUCommandEncoder, cam: Camera, B: Basis, rp: number): boolean {
    this.stats.inFlight = this.jobs.size;
    // (round 105, tilelatency: when each region was first wanted; when what was baked was first drawn)
    const now = performance.now();
    for (const w of this.cache.wanted(cam, (k) => this.jobs.has(k), 32)) {
      const k = `${w.rx},${w.ry}`;
      if (!this.firstWanted.has(k)) this.firstWanted.set(k, now);
    }
    if (this.firstWanted.size > 2000) this.firstWanted.clear();
    this.pendingDraw = this.pendingDraw.filter((t) => {
      const [rx, ry] = t.key.split(',').map(Number);
      if (!this.cache.drawsRegion(rx, ry)) return now - t.baked < 10000;
      t.drawn = now;
      this.latencies.push(t);
      if (this.latencies.length > 500) this.latencies.shift();
      this.firstWanted.delete(t.key);
      return false;
    });
    // (a new region asked for: the first of the camera's way not being made)
    const free = this.slotJob.indexOf(null);
    if (free >= 0) {
      const want = this.cache.wanted(cam, (k) => this.failed.has(k) || this.jobs.has(k), 1)[0];
      if (want) {
        const L = this.src.layout;
        const p = this.src.landInto(want.rx * R, want.ry * R, this.slots, free * L.bytes);
        if (p) {
          const key = `${want.rx},${want.ry}`;
          const now = performance.now();
          const times: LandTimes = { key, wanted: this.firstWanted.get(key) ?? now, start: now, cols: 0, ways: 0, mapped: 0, ready: 0, cur: 0, baked: 0, drawn: 0 };
          const j: Job = { rx: want.rx, ry: want.ry, slot: free, oz: this.src.oz(), t0: now, times };
          this.jobs.set(`${want.rx},${want.ry}`, j);
          this.slotJob[free] = j;
          p.then(
            (m) => {
              const tr = this.src.trace?.(want.rx * R, want.ry * R);
              if (tr) {
                times.cols = tr.tiles[tr.tiles.length - 1] ?? 0;
                times.ways = tr.ways;
                times.mapped = tr.mapped;
              }
              times.mapped ||= performance.now();
              j.ready = this.readyOf(m, j.oz);
              times.ready = performance.now();
              this.stats.made++;
              this.stats.genMs = performance.now() - j.t0;
            },
            (e) => {
              console.warn('tileland: no land for', want, e);
              this.failed.add(`${want.rx},${want.ry}`);
              this.stats.failed++;
              this.free(j);
            },
          );
        }
      }
    }
    // (the one to bake: of those whose land is in, the camera's way first — a tile since made of it (the window's): dropped)
    if (!this.cur) {
      const ready = [...this.jobs.values()].filter((j) => j.ready);
      for (const j of ready)
        if (this.cache.hasTile(j.rx, j.ry, cam.azimuth)) {
          this.free(j);
          this.stats.dropped++;
        }
      const left = ready.filter((j) => this.jobs.has(`${j.rx},${j.ry}`));
      if (!left.length) return false;
      const order = this.cache.wanted(cam, () => false, 32).map((w) => `${w.rx},${w.ry}`);
      const rank = (j: Job) => {
        const i = order.indexOf(`${j.rx},${j.ry}`);
        return i < 0 ? 1e6 : i;
      };
      left.sort((a, b) => rank(a) - rank(b));
      const job = left[0];
      job.times.cur = performance.now();
      const r = job.ready!;
      const L = this.src.layout;
      const t = new Uint32Array(L.rc * L.rc * 2);
      const at = (job.slot * L.bytes) / 16;
      for (let p = 0; p < L.rc * L.rc; p++) t.set([at + p * L.K * CHUNK * CHUNK, L.K], p * 2);
      this.host.device.queue.writeBuffer(this.table, 0, t);
      this.host.device.queue.writeBuffer(this.surface, 0, r.su);
      this.need.set(r.need);
      for (let c = 0; c < this.need.length; c++) this.flat[c] = this.need[c] ? 0 : 1;
      this.stats.meshed += r.meshed;
      this.stats.gridded += this.need.length - r.meshed;
      if (r.meshed) this.mesh.shift(1 << 12, 0, [0, 0, 0]);
      this.cur = { job, frames: r.meshed ? 0 : MESH_FRAMES };
    }
    const c = this.cur;
    const job = c.job;
    const r = job.ready!;
    this.patchGlobals(enc, job.rx, job.ry);
    if (c.frames < MESH_FRAMES) {
      this.mesh.pin(this.need);
      this.mesh.encode(enc, cam);
      c.frames++;
      return false;
    }
    const gp = this.host.gPipe();
    if (!gp) return false;
    const gr = this.groups(job.slot);
    const ok = this.cache.bakeTile(enc, cam, B, rp, job.rx, job.ry, r.lo, r.hi, job.oz, [0, 0, -job.oz], this.cam, (g) => {
      g.setPipeline(gp);
      g.setBindGroup(0, gr.g);
      this.mesh.drawMask(g, this.need);
      const grid = this.host.gridPipe();
      if (grid) {
        g.setPipeline(grid);
        g.setBindGroup(0, gr.g);
        this.host.drawGrid(g, this.flat);
      }
    }, [gr.r]);
    if (ok) {
      this.stats.baked++;
      job.times.baked = performance.now();
      this.pendingDraw.push(job.times);
    }
    this.stats.lastMs = performance.now() - job.t0;
    this.free(job);
    this.cur = null;
    return true;
  }

  afterSubmit(): void {
    this.mesh.afterSubmit();
  }
}
