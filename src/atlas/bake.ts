// The land past the window baked into a texture (round 94, bake.wgsl; drawn by far.wgsl). The user: "I don't
// understand why towns and grass aren't baked into a texture we can stream so that distant tiles draw correctly
// further out". A clipmap: a level a ring (a texel half its spacing) and one for the far land (16 world units a
// texel), each N × N texels round the camera, anchored to the world and held round in its slots — when the camera
// has moved 32 of a level's texels, only the strips new to it are baked, a band at a time. Each texel is baked once
// from the window's rules (bake.wgsl bakeSurface) and the stamps laid on it (the towns' plans, settle/raster.ts), and
// lit as it's drawn. While a level's strips are coming in, what's valid of it is drawn and the rest from the next
// level out (far.wgsl bakeAt); nothing is drawn from a texel not yet baked.
//
// RoughGround (the same module): the atlas's ground a column a cell over a box, for a settlement planned far from
// the window (settle/settlements.ts farPlans).

import { makeBindGroup, makeComputeAsync, makeModule, type ComputeKernel } from '../gpu/pipeline';
import type { Atlas } from './atlas';
import type { LodRings } from './lod';
import lodW from './lod.wgsl?raw';
import bakeW from './bake.wgsl?raw';

/**
 * Something laid over the baked ground (a town's plan): two rasters of its tops — a texel a world unit, and their
 * 4-unit average — each a word a texel (pack4x8unorm: its colour sRGB, its cover in a; 0: nothing there).
 * World units; (x0, y0) the first texel's corner.
 */
export interface SurfaceStamp {
  id: string;
  x0: number;
  y0: number;
  w: number;
  h: number;
  px: Uint32Array;
  w4: number;
  h4: number;
  px4: Uint32Array;
}

/** far.wgsl BakeD: two vec4s a level (its valid rectangle in world units; its texel, N, layer), then the info */
export const MAX_BAKE = 7;
export const BAKE_UNI_BYTES = (MAX_BAKE * 2 + 1) * 16;
/** a level re-centred every Q texels */
const Q = 32;
/** texels a dispatch at most, and a frame's at most */
const BAND = 512 * 32;
const FRAME_TEXELS = 2 * BAND;
/** seconds between one band baked again and the next (the coarse world's changes, the season) */
const REFRESH_S = 0.5;
const POOL = 6;

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Job = { level: number } & Rect;

const inter = (a: Rect, b: Rect): Rect | null => {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x0 < r.x1 && r.y0 < r.y1 ? r : null;
};

export class SurfaceBake {
  readonly tex: GPUTexture;
  /** the levels for sampling (a 2d-array), its sampler (linear, repeating: a texel's slot is its index mod N) */
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  /** far.wgsl BakeD */
  readonly uni: GPUBuffer;
  /** world units a texel, each level (the rings' finest first, the far land's last) */
  readonly texel: number[];
  /** the GPU bytes held (the levels, the stamps) */
  get bytes(): number {
    return this.tex.width * this.tex.height * this.tex.depthOrArrayLayers * 4 + this.stampBuf.size;
  }
  private kernel?: ComputeKernel;
  private rough?: ComputeKernel;
  private module: GPUShaderModule;
  private params: GPUBuffer[];
  private groups: GPUBindGroup[] = [];
  private stampBuf: GPUBuffer;
  private storeView: GPUTextureView;
  /** each level's window (texel indices of its corner) as last asked for; null: not yet */
  private target: ([number, number] | null)[];
  /** each level's rectangle that's baked (texel indices), null: none */
  private valid: (Rect | null)[];
  private queue: Job[] = [];
  private refresh = REFRESH_S;
  private nextRefresh = 0;
  /** the stamps laid (by id: where, for baking again when one changes or goes) */
  private stamps = new Map<string, SurfaceStamp>();
  /** what the bake has done: texels, dispatches, the ms the CPU took queueing */
  stats = { texels: 0, dispatches: 0, stampWords: 0, stamps: 0, filled: false };
  /** the plants the window's sim has grown on soil and silt by now (far.ts grownVeg) and the season */
  grownVeg = 1.6;
  season = 0;

  constructor(
    private device: GPUDevice,
    private atlas: Atlas,
    private lod: LodRings,
    /** texels a side of each level */
    readonly N = 512,
  ) {
    this.texel = [...lod.spacings.map((s) => s / 2), Math.max(16, lod.spacings[lod.spacings.length - 1])];
    if (this.texel.length > MAX_BAKE) throw new Error(`SurfaceBake: at most ${MAX_BAKE} levels`);
    if (N % Q) throw new Error(`SurfaceBake: N a multiple of ${Q}`);
    this.tex = device.createTexture({ label: 'bake levels', size: [N, N, this.texel.length], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this.view = this.tex.createView({ dimension: '2d-array' });
    this.storeView = this.tex.createView({ dimension: '2d-array' });
    this.sampler = device.createSampler({ label: 'bake', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    this.uni = device.createBuffer({ label: 'bake draw', size: BAKE_UNI_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.params = Array.from({ length: POOL }, () => device.createBuffer({ label: 'bake params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.stampBuf = this.makeStamps();
    this.target = this.texel.map(() => null);
    this.valid = this.texel.map(() => null);
    this.module = makeModule(device, 'bake', atlas.parts(lodW, bakeW));
    const A = { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 52: 'uniform', 53: 'read' } as const;
    void makeComputeAsync(device, 'bake', this.module, { ...A, 54: 'read', 55: 'uniform', 56: 'stex8a' }, 'bakeSurface').then((k) => {
      this.kernel = k;
      this.makeGroups();
    });
    void makeComputeAsync(device, 'rough ground', this.module, { ...A, 57: 'uniform', 58: 'rw' }, 'roughGround').then((k) => (this.rough = k));
  }

  private makeGroups(): void {
    const k = this.kernel;
    if (!k) return;
    const a = this.atlas;
    this.groups = this.params.map((pb) =>
      makeBindGroup(this.device, 'bake', k.layout, { 0: this.lod.atlasParams, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 52: this.lod.albedo, 53: this.lod.ways, 54: this.stampBuf, 55: pb, 56: this.storeView }),
    );
  }

  /** the stamps' buffer from this.stamps (bake.wgsl stampAt's layout) */
  private makeStamps(): GPUBuffer {
    const list = [...this.stamps.values()];
    let words = 4 + list.length * 8;
    for (const s of list) words += s.px.length + s.px4.length;
    const u = new Uint32Array(words);
    const f = new Float32Array(u.buffer);
    u[0] = list.length;
    let off = 4 + list.length * 8;
    list.forEach((s, i) => {
      const b = 4 + i * 8;
      f[b] = s.x0;
      f[b + 1] = s.y0;
      u.set([s.w, s.h, off], b + 2);
      u.set(s.px, off);
      off += s.px.length;
      u.set([s.w4, s.h4, off], b + 5);
      u.set(s.px4, off);
      off += s.px4.length;
    });
    const buf = this.device.createBuffer({ label: 'bake stamps', size: Math.max(16, u.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, u);
    this.stats.stampWords = words;
    this.stats.stamps = list.length;
    return buf;
  }

  /** a level's window for the camera at world point w (texel indices) */
  private windowFor(k: number, w: readonly number[]): Rect {
    const t = this.texel[k];
    const x0 = Math.round(w[0] / t / Q) * Q - this.N / 2;
    const y0 = Math.round(w[1] / t / Q) * Q - this.N / 2;
    return { x0, y0, x1: x0 + this.N, y1: y0 + this.N };
  }

  private push(level: number, r: Rect): void {
    // (in bands of rows: a dispatch at most BAND texels)
    const rows = Math.max(1, Math.floor(BAND / (r.x1 - r.x0)));
    for (let y = r.y0; y < r.y1; y += rows) this.queue.push({ level, x0: r.x0, y0: y, x1: r.x1, y1: Math.min(r.y1, y + rows) });
  }

  /**
   * Lay these stamps (all of them: any not in the list is lifted). The ground under each that's new, changed or
   * gone is baked again.
   */
  setStamps(list: SurfaceStamp[]): void {
    const next = new Map(list.map((s) => [s.id, s]));
    const redo: SurfaceStamp[] = [];
    for (const [id, s] of this.stamps) if (next.get(id) !== s) redo.push(s);
    for (const [id, s] of next) if (this.stamps.get(id) !== s) redo.push(s);
    if (!redo.length) return;
    this.stamps = next;
    this.stampBuf.destroy();
    this.stampBuf = this.makeStamps();
    this.makeGroups();
    const W = this.atlas.worldW;
    const H = this.atlas.worldH;
    for (const s of redo)
      this.texel.forEach((t, k) => {
        const win = this.target[k];
        if (!win) return;
        // (the copy round the torus nearest the level's middle)
        const cx = ((win[0] + this.N / 2) * t);
        const cy = ((win[1] + this.N / 2) * t);
        const x0 = s.x0 + Math.round((cx - s.x0) / W) * W;
        const y0 = s.y0 + Math.round((cy - s.y0) / H) * H;
        const r = inter({ x0: Math.floor(x0 / t) - 1, y0: Math.floor(y0 / t) - 1, x1: Math.ceil((x0 + s.w) / t) + 1, y1: Math.ceil((y0 + s.h) / t) + 1 }, { x0: win[0], y0: win[1], x1: win[0] + this.N, y1: win[1] + this.N });
        if (r) this.push(k, r);
      });
  }

  /** each frame: the camera (world units); bakes what's new and writes far.wgsl's BakeD */
  update(cam: readonly number[], dt: number): void {
    const k = this.kernel;
    if (!k || !this.groups.length) return;
    const N = this.N;
    this.texel.forEach((_, i) => {
      const win = this.windowFor(i, cam);
      const old = this.target[i];
      if (old && old[0] === win.x0 && old[1] === win.y0) return;
      this.target[i] = [win.x0, win.y0];
      if (!old) {
        this.push(i, win);
        return;
      }
      // (what's queued for this level outside its new window would land in slots the window now holds elsewhere)
      this.queue = this.queue.flatMap((j) => {
        if (j.level !== i) return [j];
        const r = inter(j, win);
        return r ? [{ level: i, ...r }] : [];
      });
      const was: Rect = { x0: old[0], y0: old[1], x1: old[0] + N, y1: old[1] + N };
      const v = this.valid[i];
      this.valid[i] = v ? inter(v, win) : null;
      // the strips new to it: the columns beside what it was, then the rows above or below
      const ox = inter(was, win);
      if (!ox) {
        this.push(i, win);
        return;
      }
      if (win.x0 < ox.x0) this.push(i, { x0: win.x0, y0: win.y0, x1: ox.x0, y1: win.y1 });
      if (win.x1 > ox.x1) this.push(i, { x0: ox.x1, y0: win.y0, x1: win.x1, y1: win.y1 });
      if (win.y0 < ox.y0) this.push(i, { x0: ox.x0, y0: win.y0, x1: ox.x1, y1: ox.y0 });
      if (win.y1 > ox.y1) this.push(i, { x0: ox.x0, y0: ox.y1, x1: ox.x1, y1: win.y1 });
    });
    // (a band of a level again now and then: the coarse world's changes, the season)
    this.refresh -= dt;
    if (this.refresh <= 0 && !this.queue.length) {
      this.refresh = REFRESH_S;
      const bands = N / Q;
      const lv = Math.floor(this.nextRefresh / bands) % this.texel.length;
      const b = this.nextRefresh % bands;
      this.nextRefresh = (this.nextRefresh + 1) % (bands * this.texel.length);
      const t = this.target[lv];
      if (t) this.queue.push({ level: lv, x0: t[0], y0: t[1] + b * Q, x1: t[0] + N, y1: t[1] + (b + 1) * Q });
    }
    // the finest levels' first: they're nearest
    this.queue.sort((a, b) => a.level - b.level);
    let budget = FRAME_TEXELS;
    let n = 0;
    const enc = this.device.createCommandEncoder({ label: 'bake' });
    while (this.queue.length && n < POOL && budget > 0) {
      const j = this.queue.shift()!;
      const w = j.x1 - j.x0;
      const h = j.y1 - j.y0;
      const ab = new ArrayBuffer(48);
      new Int32Array(ab, 0, 4).set([j.x0, j.y0, w, h]);
      new Float32Array(ab, 16, 8).set([this.texel[j.level], N, j.level, this.grownVeg, this.season, 0, 0, 0]);
      this.device.queue.writeBuffer(this.params[n], 0, ab);
      const cp = enc.beginComputePass({ label: 'bake', timestampWrites: this.atlas.profiler?.timestamps(`bake ${this.texel[j.level]}`) });
      cp.setPipeline(k.pipeline);
      cp.setBindGroup(0, this.groups[n]);
      cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      cp.end();
      budget -= w * h;
      this.stats.texels += w * h;
      this.stats.dispatches++;
      n++;
    }
    if (n) this.device.queue.submit([enc.finish()]);
    // a level with nothing left to bake is all valid
    this.texel.forEach((_, i) => {
      const t = this.target[i];
      if (t && !this.queue.some((j) => j.level === i)) this.valid[i] = { x0: t[0], y0: t[1], x1: t[0] + N, y1: t[1] + N };
    });
    this.stats.filled = this.valid.every((v) => v);
    const f = new Float32Array(BAKE_UNI_BYTES / 4);
    this.texel.forEach((t, i) => {
      const v = this.valid[i];
      // (a texel in from its edge: the filter reaches the next one)
      if (v) f.set([(v.x0 + 1) * t, (v.y0 + 1) * t, (v.x1 - 1) * t, (v.y1 - 1) * t], i * 8);
      else f.set([1, 1, 0, 0], i * 8);
      f.set([t, N, i, 0], i * 8 + 4);
    });
    f.set([this.texel.length, this.texel.length - 1, 1, 0], MAX_BAKE * 8);
    this.device.queue.writeBuffer(this.uni, 0, f);
  }

  /**
   * The atlas's ground a column a cell over a box (world cells; y0 even): its top (world z), the water on it, its
   * top's material, the plants it starts with — the rings' ground (bake.wgsl roughGround). Null until compiled.
   */
  async roughGround(x0: number, y0: number, w: number, h: number): Promise<{ ground: Float32Array; water: Float32Array; top: Uint8Array; veg: Float32Array } | null> {
    const k = this.rough;
    if (!k) return null;
    const dev = this.device;
    const pb = dev.createBuffer({ label: 'rough params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(pb, 0, new Int32Array([x0, y0, w, h]));
    const out = dev.createBuffer({ label: 'rough out', size: w * h * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rd = dev.createBuffer({ label: 'rough read', size: w * h * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const a = this.atlas;
    const enc = dev.createCommandEncoder({ label: 'rough ground' });
    const cp = enc.beginComputePass({ label: 'rough ground', timestampWrites: this.atlas.profiler?.timestamps('rough ground') });
    cp.setPipeline(k.pipeline);
    cp.setBindGroup(0, makeBindGroup(dev, 'rough', k.layout, { 0: this.lod.atlasParams, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 52: this.lod.albedo, 53: this.lod.ways, 57: pb, 58: out }));
    cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    cp.end();
    enc.copyBufferToBuffer(out, 0, rd, 0, rd.size);
    dev.queue.submit([enc.finish()]);
    try {
      await rd.mapAsync(GPUMapMode.READ);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    }
    const f = new Float32Array(rd.getMappedRange().slice(0));
    rd.unmap();
    pb.destroy();
    out.destroy();
    rd.destroy();
    const N = w * h;
    const ground = new Float32Array(N);
    const water = new Float32Array(N);
    const top = new Uint8Array(N);
    const veg = new Float32Array(N);
    const u = new Uint32Array(f.buffer);
    for (let i = 0; i < N; i++) {
      ground[i] = f[i * 4];
      water[i] = f[i * 4 + 1];
      top[i] = u[i * 4 + 2];
      veg[i] = f[i * 4 + 3];
    }
    return { ground, water, top, veg };
  }

  dispose(): void {
    this.tex.destroy();
    this.uni.destroy();
    this.stampBuf.destroy();
    for (const b of this.params) b.destroy();
  }
}
