// The land round the window in rings of less detail (round 83, lod.wgsl; drawn by far.ts): each ring a
// grid of the atlas's ground (the same function the streamer's columns are made from), its vertices
// 2, 4, 8, 16 cells apart, centred on the camera. A ring is anchored to the world — its texel (I, J) at
// (I, J) · spacing — and held round in its slots (I mod n, J mod n): when the camera has moved 8 of its
// spacings, only the strips new to it are made; a slide of the window makes nothing. For the coarse
// world's changes, an eighth of one ring's rows is made again every REFRESH_S. Each ring's edge melts into
// the next one out (far.wgsl vsLod), the last into the far land: no cracks between them.

import { makeBindGroup, makeComputeAsync, makeModule, type ComputeKernel } from '../gpu/pipeline';
import { MATERIALS } from '../world/materials';
import type { Atlas } from './atlas';
import lodW from './lod.wgsl?raw';

/** far.wgsl LodD: a vec4 a ring (5: ?ceiling's 1-cell ring and the four), then info, then the window's mesh chunks,
 *  then (round 86, the hybrid) a bit a mesh chunk the window's grid draws (64 words) */
export const LOD_UNI_BYTES = 7 * 16 + 256;
const MAX_RINGS = 5;
/** seconds between one eighth of a ring made again and the next (the coarse world changes slowly) */
const REFRESH_S = 0.4;
const BANDS = 8;
/** lod.wgsl lodAlbedo's size */
const ALBEDOS = 64;
/** (round 93) lod.wgsl WAY_REACH; world units a bin's side */
const WAY_REACH = 3.2;
const WAY_BIN = 64;
/** ways.ts WAY.tunnel, WAY.lift: not on the ground */
const WAY_UNDER = [1, 4];

/**
 * (round 93) The atlas's ways for the rings (lod.wgsl wayDist): a grid of WAY_BIN bins over the world, each listing
 * every way point within WAY_REACH of it (a point in up to four), a word a point (x · 3 | y · 3 << 16) — made once.
 * Header: bins across, down, the bin's side (f32 bits), 0; then bins + 1 offsets; then the points.
 */
export function wayBins(atlas: Atlas): Uint32Array {
  const W = atlas.worldW;
  const H = atlas.worldH;
  const nbx = Math.ceil(W / WAY_BIN);
  const nby = Math.ceil(H / WAY_BIN);
  const counts = new Uint32Array(nbx * nby);
  const pts = atlas.ways.points.filter((p) => !WAY_UNDER.includes(p.kind));
  const binsOf = (x: number, y: number, f: (k: number) => void) => {
    const i0 = Math.floor((x - WAY_REACH) / WAY_BIN);
    const i1 = Math.floor((x + WAY_REACH) / WAY_BIN);
    const j0 = Math.floor((y - WAY_REACH) / WAY_BIN);
    const j1 = Math.floor((y + WAY_REACH) / WAY_BIN);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) f(((j % nby) + nby) % nby * nbx + (((i % nbx) + nbx) % nbx));
  };
  for (const p of pts) binsOf(p.x, p.y, (k) => counts[k]++);
  const off = new Uint32Array(nbx * nby + 1);
  for (let k = 0; k < nbx * nby; k++) off[k + 1] = off[k] + counts[k];
  const out = new Uint32Array(4 + off.length + off[nbx * nby]);
  out[0] = nbx;
  out[1] = nby;
  out[2] = new Uint32Array(new Float32Array([WAY_BIN]).buffer)[0];
  out.set(off, 4);
  const fill = off.slice(0, nbx * nby);
  const base = 4 + off.length;
  for (const p of pts) {
    const w = (Math.min(65535, Math.round(p.x * 3)) | (Math.min(65535, Math.round(p.y * 3)) << 16)) >>> 0;
    binsOf(p.x, p.y, (k) => (out[base + fill[k]++] = w));
  }
  return out;
}

export class LodRings {
  /** each ring's slots: top, colour, the ground, the rock — rings × n² (lod.wgsl lodOut) */
  readonly data: GPUBuffer;
  /** far.wgsl LodD */
  readonly uni: GPUBuffer;
  private kernel?: ComputeKernel;
  private groups: GPUBindGroup[] = [];
  private atlasParams: GPUBuffer;
  private ringParams: GPUBuffer[];
  /** each material's albedo (ALBEDOS vec4s; a uniform: lod.wgsl, far.wgsl) */
  readonly albedo: GPUBuffer;
  /** (round 93) the ways binned (wayBins) */
  private ways: GPUBuffer;
  /** the GPU bytes the rings hold (their slots, the ways, the albedos) */
  readonly bytes: number;
  /** each ring's corner as made (world texel indices), null: not yet */
  private made: ([number, number] | null)[];
  private refresh = REFRESH_S;
  /** the next refresh: ring · BANDS + band */
  private next = 0;
  /** every ring made at least once: drawn from then */
  ready = false;
  /** (round 83) the window's mesh chunks (cells across a chunk, rows, chunks across, down) — the rings fill those
   *  not built yet; null: never inside the window */
  meshGrid: [number, number, number, number] | null = null;
  /** (round 86, the hybrid) a bit a mesh chunk, set: the window's grid draws it (renderer.ts setGrid) — the rings
   *  leave it, as they leave a built one */
  readonly gridBits = new Uint32Array(64);

  constructor(
    private device: GPUDevice,
    private atlas: Atlas,
    /** world units between a ring's vertices, finest first (each twice the last) */
    readonly spacings: number[] = [2, 4, 8, 16],
    /** vertices a side (odd: (n − 1) / 2 a multiple of 4, so a ring's edge is on the next one's lattice) */
    readonly n = 193,
  ) {
    if (spacings.length > MAX_RINGS) throw new Error(`LodRings: at most ${MAX_RINGS} rings`);
    if ((n - 1) % 8 !== 0) throw new Error('LodRings: (n − 1) a multiple of 8');
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.data = device.createBuffer({ label: 'lod rings', size: spacings.length * n * n * 16, usage: S | GPUBufferUsage.COPY_SRC });
    this.uni = device.createBuffer({ label: 'lod draw', size: LOD_UNI_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.atlasParams = device.createBuffer({ label: 'lod atlas params', size: atlas.paramBuf.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    atlas.writeParams({}, this.atlasParams);
    this.ringParams = spacings.map(() => device.createBuffer({ label: 'lod ring', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    // (round 93: a uniform — the kernel's storage buffers are at WebGPU's 8; far.wgsl reads it too)
    if (MATERIALS.length > ALBEDOS) throw new Error(`LodRings: more than ${ALBEDOS} materials`);
    const alb = new Float32Array(ALBEDOS * 4);
    MATERIALS.forEach((m, i) => alb.set([...m.albedo, 1], i * 4));
    this.albedo = device.createBuffer({ label: 'lod albedo', size: alb.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.albedo, 0, alb);
    // (round 93) the ways, binned for the rings' kernel (made once)
    const wb = wayBins(atlas);
    this.ways = device.createBuffer({ label: 'lod ways', size: wb.byteLength, usage: S });
    device.queue.writeBuffer(this.ways, 0, wb);
    this.bytes = this.data.size + wb.byteLength + alb.byteLength;
    this.made = spacings.map(() => null);
    const module = makeModule(device, 'lod', atlas.parts(lodW));
    void makeComputeAsync(device, 'lod', module, { 0: 'uniform', 20: 'read', 21: 'read', 22: 'read', 23: 'read', 25: 'read', 26: 'read', 50: 'uniform', 51: 'rw', 52: 'uniform', 53: 'read' }, 'lodHeight').then((k) => {
      const a = this.atlas;
      this.groups = this.ringParams.map((rp) =>
        makeBindGroup(device, 'lod ring', k.layout, { 0: this.atlasParams, 20: a.region, 21: a.dist, 22: a.regs, 23: a.pat, 25: a.riverBuf, 26: a.coarse.cells, 50: rp, 51: this.data, 52: this.albedo, 53: this.ways }),
      );
      this.kernel = k;
    });
  }

  /** a ring's corner for the camera at world point `w` (texel indices): on the lattice of 8 of its spacings */
  private cornerFor(k: number, w: readonly number[]): [number, number] {
    const s = this.spacings[k];
    const half = (this.n - 1) / 2;
    return [Math.round(w[0] / (8 * s)) * 8 - half, Math.round(w[1] / (8 * s)) * 8 - half];
  }

  /**
   * Each frame before drawing: the camera (window coordinates) and the window's origin (world units).
   * Makes what's new to the rings (a dispatch each that moved), writes far.wgsl's LodD.
   */
  update(mid: readonly number[], org: readonly number[], dt: number): void {
    const k = this.kernel;
    if (!k) return;
    const n = this.n;
    const w = [mid[0] + org[0], mid[1] + org[1]];
    this.refresh -= dt;
    let band = -1;
    if (this.refresh <= 0 && this.ready) {
      this.refresh = REFRESH_S;
      band = this.next;
      this.next = (this.next + 1) % (this.spacings.length * BANDS);
    }
    const enc = this.device.createCommandEncoder({ label: 'lod' });
    let any = false;
    this.spacings.forEach((s, i) => {
      const c = this.cornerFor(i, w);
      const m = this.made[i];
      const moved = !m || m[0] !== c[0] || m[1] !== c[1];
      const refreshed = band >= 0 && Math.floor(band / BANDS) === i;
      if (!moved && !refreshed) return;
      // (not made yet: every row is new)
      const [r0, r1] = !m ? [0, n] : refreshed ? [((band % BANDS) * n) / BANDS, (((band % BANDS) + 1) * n) / BANDS].map(Math.floor) : [0, 0];
      const old = m ?? c;
      const ab = new ArrayBuffer(48);
      new Int32Array(ab, 0, 4).set([c[0], c[1], old[0], old[1]]);
      new Float32Array(ab, 16, 4).set([s, n, 0, 0]);
      new Uint32Array(ab, 32, 4).set([i * n * n, r0, r1, 0]);
      this.device.queue.writeBuffer(this.ringParams[i], 0, ab);
      // (timed in the game's profiler when the level lends it: ?ceiling's strips)
      const cp = enc.beginComputePass({ label: 'lod', timestampWrites: this.atlas.profiler?.timestamps(`lod ${s}`) });
      cp.setPipeline(k.pipeline);
      cp.setBindGroup(0, this.groups[i]);
      cp.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8));
      cp.end();
      this.made[i] = c;
      any = true;
    });
    if (any) this.device.queue.submit([enc.finish()]);
    this.ready = true;
    const f = new Float32Array(LOD_UNI_BYTES / 4);
    this.made.forEach((m, i) => f.set([m![0], m![1], this.spacings[i], n], i * 4));
    const sOut = this.spacings[this.spacings.length - 1];
    const outer = this.made[this.made.length - 1]!;
    f.set([this.spacings.length, outer[0] * sOut - org[0], outer[1] * sOut - org[1], (n - 1) * sOut], MAX_RINGS * 4);
    if (this.meshGrid) f.set(this.meshGrid, MAX_RINGS * 4 + 4);
    new Uint32Array(f.buffer).set(this.gridBits, MAX_RINGS * 4 + 8);
    this.device.queue.writeBuffer(this.uni, 0, f);
  }

  dispose(): void {
    this.data.destroy();
    this.uni.destroy();
    this.atlasParams.destroy();
    this.albedo.destroy();
    this.ways.destroy();
    for (const b of this.ringParams) b.destroy();
  }
}
