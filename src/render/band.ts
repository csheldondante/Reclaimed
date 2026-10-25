// The band outside the window (round 79, the user: "Why not stream vertical identical to lateral …
// It will just render different intervals of the same columns right?"). The streamed window holds
// oz .. oz + zMax of every column live (the sim's z: 8 bits for its surface); what lies above and below
// it is kept on the CPU (Streamer.outside, world z). The band packs that into a second layers buffer in
// window z (over zMax above the window, under 0 below it) with its own chunk table, and a second field
// mesh draws it — the same mesher, its samples spanning the world's height, its quads only outside
// [0, zMax). It doesn't tick: frozen, as the regions beside the window are. A cliff taller than the
// window is drawn whole; from a mesa's top the plain far under the window shows.
//
// The seam: the window's mesh doesn't close a run cut at its top (it goes on up — fieldmesh.wgsl
// colDist), and the band's runs cut at the window's edges reach SEAM cells across, so each mesh's field
// is the same either side of the seam and the two meet.

import type { Profiler } from '../gpu/profiler';
import type { WorldGpu } from '../sim/world-gpu';
import { CHUNK, SLOT_WORDS, fitColumn, packColumn, type Interval } from '../world/layout';
import { FieldMesh } from './fieldmesh';

/** slots a column in the band (more are merged: layout.ts fitColumn) */
const BAND_K = 12;
/** how far a run cut at the window's edge reaches into it in the band (cells) */
const SEAM = 6;

export class OutsideBand {
  readonly mesh: FieldMesh;
  readonly chunks: GPUBuffer;
  readonly layers: GPUBuffer;
  private table: Uint32Array;
  /** columns packed at the last update, and how many were merged to fit */
  stats = { columns: 0, runs: 0, fitted: 0, ms: 0 };

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    profiler: Profiler,
    /** the world's height (the atlas's zTop) */
    zSpan: number,
  ) {
    const { w, h } = world;
    const cx = w / CHUNK;
    const cy = h / CHUNK;
    this.table = new Uint32Array(cx * cy * 2);
    for (let c = 0; c < cx * cy; c++) this.table.set([c * CHUNK * CHUNK * BAND_K, BAND_K], c * 2);
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.chunks = world.buf('band chunks', this.table.byteLength, S);
    device.queue.writeBuffer(this.chunks, 0, this.table);
    this.layers = world.buf('band layers', w * h * BAND_K * SLOT_WORDS * 4, S);
    // (no structures out there: an empty frame table)
    const frames = world.buf('band frames', world.strFrames.size, S);
    const vox = world.buf('band vox', 16, S);
    this.mesh = new FieldMesh(device, world, profiler, true, 2, { name: 'band', chunks: this.chunks, layers: this.layers, frames, vox, zSpan, slots: 3 });
  }

  /** What's outside every column (world z, Streamer.outside) packed in window z at oz. */
  update(outside: Interval[][], oz: number, zMax: number): void {
    if (!this.mesh.on) return;
    const t0 = performance.now();
    const { w, h } = this.world;
    const out = new Uint32Array(w * h * BAND_K * SLOT_WORDS);
    const cx = w / CHUNK;
    let columns = 0;
    let runs = 0;
    let fitted = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const src = outside[y * w + x];
        if (!src.length) continue;
        const col: Interval[] = src.map((iv) => {
          let z0 = iv.z0 - oz;
          let z1 = iv.z1 - oz;
          // (cut at the window's top or bottom: reaching across the seam)
          if (Math.abs(z0 - zMax) < 1e-3) z0 = zMax - SEAM;
          if (Math.abs(z1) < 1e-3) z1 = SEAM;
          return { z0, z1, mat: iv.mat };
        });
        if (fitColumn(col, BAND_K)) fitted++;
        const ci = Math.floor(y / CHUNK) * cx + Math.floor(x / CHUNK);
        const base = this.table[ci * 2] + ((y % CHUNK) * CHUNK + (x % CHUNK)) * BAND_K;
        out.set(packColumn(col, BAND_K), base * SLOT_WORDS);
        columns++;
        runs += col.length;
      }
    this.device.queue.writeBuffer(this.layers, 0, out);
    this.mesh.setBand(oz, zMax);
    this.stats = { columns, runs, fitted, ms: +(performance.now() - t0).toFixed(1) };
  }
}
