// Render-only land for the tile cache (round 104, TC2; DECISIONS round 104 — the user: "a LOD that used hybrid
// heightmap and other mesher only where needed and that has no simulation active we can generate an isometric tile
// for the terrain with material and normal detail only then compose cheaply in screen space").
//
// A region past the window that no tile draws yet (on screen, nearest the middle first) is made on the GPU as the
// window's would be (Streamer.landInto: gpugen's finish, straight into a scratch region in the pool's layout), meshed
// by a field mesh of its own over that scratch (a "window" one region across: its own Globals with the region's
// size and origin, a chunk table onto the scratch's pages, the scratch's kept fields bound where the window's are),
// baked into a tile (TileCache.bakeTile: the same G-buffer and fsTileBake), and let go: the scratch is the next
// region's. Nothing of it simulates; nothing of it stays but the tile. One region at a time.
//
// Not yet: the hybrid's heightfield for the flat chunks (every chunk is meshed — six for a region); the wetness
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

type State = { k: 'idle' } | { k: 'gen'; rx: number; ry: number } | { k: 'mesh'; rx: number; ry: number; frames: number; lo: number; hi: number; oz: number } | { k: 'bake'; rx: number; ry: number; lo: number; hi: number; oz: number };
/** (hybrid.ts columnNeeds) a gap open to the air: a neighbour's top under a column's highest gap's roof */
const GAP_OPEN = 0.25;

export class TileLand {
  readonly stats = { made: 0, baked: 0, failed: 0, genMs: 0, lastMs: 0, meshed: 0, gridded: 0 };
  /** per scratch mesh chunk: meshed (a gap open to the air in it — hybrid.ts's rule), the rest the grid's */
  private need: Uint8Array;
  private flat: Uint8Array;
  private st: State = { k: 'idle' };
  private slot: GPUBuffer;
  private globals: GPUBuffer;
  private patch: GPUBuffer;
  private patchData: ArrayBuffer;
  private table: GPUBuffer;
  private surface: GPUBuffer;
  private fields: GPUBuffer;
  private drift: GPUTexture;
  private mesh: FieldMesh;
  private cam: GPUBuffer;
  private gGroup?: GPUBindGroup;
  private rGroup?: GPUBindGroup;
  private poolSeen = -1;
  private t0 = 0;
  /** regions asked for that came to nothing (no land made): not asked again */
  private failed = new Set<string>();

  constructor(private host: TileLandHost, private src: TileLandSource, private cache: TileCache) {
    const dev = host.device;
    const w = host.world;
    const L = src.layout;
    if (L.R !== R) throw new Error(`TileLand: regions of ${L.R}, not ${R}`);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.slot = w.buf('tileland region', L.bytes, S | GPUBufferUsage.COPY_SRC);
    this.globals = w.buf('tileland globals', w.globals.size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.patchData = new ArrayBuffer(w.globals.size);
    this.patch = w.buf('tileland globals patch', w.globals.size, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    // (a chunk table onto the scratch's pages: chunk (i, j) of the region is page j · rc + i)
    const t = new Uint32Array(L.rc * L.rc * 2);
    for (let p = 0; p < L.rc * L.rc; p++) t.set([p * L.K * CHUNK * CHUNK, L.K], p * 2);
    this.table = w.buf('tileland chunks', t.byteLength, S);
    dev.queue.writeBuffer(this.table, 0, t);
    this.surface = w.buf('tileland surface', R * R * 4, S);
    this.fields = w.buf('tileland renderFields', R * R * 16, S);
    this.drift = dev.createTexture({ label: 'tileland drift', size: [R, R], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    // (its field mesh: a window one region across — its Globals, chunk table and layers the scratch's)
    const fake = Object.assign(Object.create(w) as WorldGpu, { w: R, h: R, globals: this.globals });
    const frames = w.buf('tileland frames', w.strFrames.size, S);
    const vox = w.buf('tileland vox', 16, S);
    this.mesh = new FieldMesh(dev, fake, host.profiler, true, 1, { name: 'tileland', chunks: this.table, layers: this.slot, frames, vox, zSpan: w.zMax, slots: 2, pages: 192 });
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

  /** the scratch's draw groups (the mesh's G-buffer pass, the resolve), made again when its pool grows */
  private groups(): void {
    const v = this.mesh.maintain();
    if (v === this.poolSeen && this.gGroup) return;
    this.poolSeen = v;
    const h = this.host;
    const L = this.src.layout;
    const kept = (name: string): GPUBufferBinding => {
      const b = L.bufs.find((x) => x.name === name);
      if (!b) throw new Error(`TileLand: the region layout keeps no ${name}`);
      return { buffer: this.slot, offset: b.off, size: b.bytes };
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
      9: this.slot,
      11: this.surface,
      13: kept('wilt'),
      17: this.drift.createView(),
      30: this.mesh.region,
    };
    const ent = (r: typeof res) => Object.entries(r).map(([b, x]) => ({ binding: Number(b), resource: x instanceof GPUBuffer ? { buffer: x } : x }));
    this.gGroup = h.device.createBindGroup({ label: 'tileland mesh', layout: h.meshLayout, entries: ent(res) });
    const [g0, g1] = this.cache.gbufViews;
    this.rGroup = h.device.createBindGroup({ label: 'tileland resolve', layout: h.resolveLayout, entries: [...ent(res), { binding: 40, resource: g0 }, { binding: 41, resource: g1 }] });
  }

  /** A frame's step: ask for the next region, mesh what came, bake what's meshed. */
  step(enc: GPUCommandEncoder, cam: Camera, B: Basis, rp: number): void {
    const s = this.st;
    if (s.k === 'idle') {
      const want = this.cache.wanted(cam, (k) => this.failed.has(k));
      if (!want) return;
      const p = this.src.landInto(want.rx * R, want.ry * R, this.slot, 0);
      if (!p) return;
      this.st = { k: 'gen', rx: want.rx, ry: want.ry };
      this.t0 = performance.now();
      const oz = this.src.oz();
      p.then(
        (m) => {
          // (its tops for the box, its surface for the look: water's level, the grid)
          const su = new Uint32Array(R * R);
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 0; i < R * R; i++) {
            su[i] = sfPack(m.surface[i], 0);
            lo = Math.min(lo, m.surface[i]);
            hi = Math.max(hi, m.colTop[i] - oz, m.surface[i]);
          }
          this.host.device.queue.writeBuffer(this.surface, 0, su);
          // (the hybrid's rule, the user's "mesher only where needed": a chunk with a gap open to the air is meshed,
          // the rest drawn as the grid through its columns' tops — without the grid, all meshed)
          const grid = !!this.host.gridPipe();
          const [nx, , side] = this.mesh.chunkGrid;
          this.need.fill(grid ? 0 : 1);
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
                this.need[Math.min(this.need.length / nx - 1, Math.floor((y + 0.5) / side)) * nx + Math.min(nx - 1, Math.floor(wx / side))] = 1;
              }
          for (let c = 0; c < this.need.length; c++) this.flat[c] = this.need[c] ? 0 : 1;
          const meshed = this.need.reduce((a, v) => a + v, 0);
          this.stats.meshed += meshed;
          this.stats.gridded += this.need.length - meshed;
          if (meshed) this.mesh.shift(1 << 12, 0, [0, 0, 0]);
          this.stats.made++;
          this.stats.genMs = performance.now() - this.t0;
          this.st = meshed ? { k: 'mesh', rx: want.rx, ry: want.ry, frames: 0, lo: lo - 2, hi: hi + 2, oz } : { k: 'bake', rx: want.rx, ry: want.ry, lo: lo - 2, hi: hi + 2, oz };
        },
        (e) => {
          console.warn('tileland: no land for', want, e);
          this.failed.add(`${want.rx},${want.ry}`);
          this.stats.failed++;
          this.st = { k: 'idle' };
        },
      );
      return;
    }
    if (s.k === 'gen') return;
    this.patchGlobals(enc, s.rx, s.ry);
    if (s.k === 'mesh') {
      this.mesh.pin(this.need);
      this.mesh.encode(enc, cam);
      if (++s.frames >= MESH_FRAMES) this.st = { k: 'bake', rx: s.rx, ry: s.ry, lo: s.lo, hi: s.hi, oz: s.oz };
      return;
    }
    // bake
    this.groups();
    const gp = this.host.gPipe();
    if (!gp) return;
    const ok = this.cache.bakeTile(enc, cam, B, rp, s.rx, s.ry, s.lo, s.hi, s.oz, [0, 0, -s.oz], this.cam, (g) => {
      g.setPipeline(gp);
      g.setBindGroup(0, this.gGroup!);
      this.mesh.drawMask(g, this.need);
      const gr = this.host.gridPipe();
      if (gr) {
        g.setPipeline(gr);
        g.setBindGroup(0, this.gGroup!);
        this.host.drawGrid(g, this.flat);
      }
    }, [this.rGroup!]);
    if (ok) this.stats.baked++;
    this.stats.lastMs = performance.now() - this.t0;
    this.st = { k: 'idle' };
  }

  afterSubmit(): void {
    this.mesh.afterSubmit();
  }
}
