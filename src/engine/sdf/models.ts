// The model store (docs/design/PHYSICS_ENGINE.md "Fine collision, body ↔ body"): one row a baked voxel model, its
// signed distance field and its surface samples, all on the GPU. Occupancy bits in; the bake (sdf-bake.wgsl) is a
// jump flood, many models to a batch of dispatches. Instances share a model: a body row names its model row.
//
// Where the state lives: `models` (rows, contract.ts SdfModel), `data` (fields and sample lists, one word arena),
// `occ` (occupancy bits, their own arena), `bakeCount` (surface voxels found a model, kept so a sample list that ran
// out of room is counted). Written by the bake's kernels; read by the fine pass (fine.ts). The CPU keeps only where
// each model's ranges are.
// Transfers: CPU → GPU a model's occupancy bits (padded voxels / 8 bytes: 729 B for 16³) and its 32 B row, when it is
// added or its voxels change on the CPU. Nothing is read back. A buffer that runs out doubles: one GPU → GPU copy of
// what is in use.

import { makeBindGroup, makeCompute, type ComputeKernel } from '../../gpu/pipeline';
import modelWgsl from '../../shaders/engine/sdf-model.wgsl?raw';
import bakeWgsl from '../../shaders/engine/sdf-bake.wgsl?raw';
import { Arena } from './arena';
import { SDF_MAX_SIDE, SDF_MODEL_BYTES, SDF_PAD, type SdfFormat } from './contract';

export interface SdfModelSpec {
  /** voxels a side */
  size: readonly [number, number, number];
  /** x + w * (y + d * z); nonzero is matter (world/models.ts VoxelModel's order) */
  vox: ArrayLike<number>;
  /** cells a voxel: 1, 1/2 or 1/4 */
  voxel: number;
  /** centre of mass in the model's own voxel coordinates (default: the matter's centroid) */
  com?: readonly [number, number, number];
}

/** where a model's data is, and what it takes */
export interface SdfModelInfo {
  /** padded sides */
  dims: [number, number, number];
  fieldBase: number;
  fieldWords: number;
  sampleBase: number;
  sampleCap: number;
  occBase: number;
  occWords: number;
  voxel: number;
  /** padded voxel coordinates */
  com: [number, number, number];
  /** GPU bytes: field, samples, occupancy, row + counter */
  bytes: { field: number; samples: number; occupancy: number; row: number; total: number };
}

interface Rec extends Omit<SdfModelInfo, 'bytes'> {
  live: boolean;
}

/** the first line of both kernels' sources: the field's format */
export function sdfFormatWgsl(format: SdfFormat): string {
  return `const SDF_FORMAT: u32 = ${{ f32: 0, snorm8: 1, grad8: 2 }[format]}u;`;
}

/** a spec's padded occupancy bits, its surface voxel count and its centroid (padded voxel coordinates) */
export function padOccupancy(spec: SdfModelSpec): { dims: [number, number, number]; bits: Uint32Array; surface: number; centroid: [number, number, number] } {
  const [w, d, h] = spec.size;
  const dims: [number, number, number] = [w + 2 * SDF_PAD, d + 2 * SDF_PAD, h + 2 * SDF_PAD];
  if (Math.max(...dims) > SDF_MAX_SIDE || Math.min(w, d, h) < 1) throw new Error(`SdfModels: a model of ${w} × ${d} × ${h} voxels (1 to ${SDF_MAX_SIDE - 2 * SDF_PAD} a side)`);
  if (spec.vox.length !== w * d * h) throw new Error(`SdfModels: ${spec.vox.length} voxels given for ${w} × ${d} × ${h}`);
  const bits = new Uint32Array(Math.ceil((dims[0] * dims[1] * dims[2]) / 32));
  const at = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < w && y < d && z < h && spec.vox[x + w * (y + d * z)] !== 0;
  let surface = 0;
  let n = 0;
  const c = [0, 0, 0];
  for (let z = 0; z < h; z++)
    for (let y = 0; y < d; y++)
      for (let x = 0; x < w; x++) {
        if (!at(x, y, z)) continue;
        const i = x + SDF_PAD + dims[0] * (y + SDF_PAD + dims[1] * (z + SDF_PAD));
        bits[i >> 5] |= 1 << (i & 31);
        n++;
        c[0] += x + 0.5;
        c[1] += y + 0.5;
        c[2] += z + 0.5;
        if (!(at(x + 1, y, z) && at(x - 1, y, z) && at(x, y + 1, z) && at(x, y - 1, z) && at(x, y, z + 1) && at(x, y, z - 1))) surface++;
      }
  const centroid: [number, number, number] = n ? [c[0] / n + SDF_PAD, c[1] / n + SDF_PAD, c[2] / n + SDF_PAD] : [dims[0] / 2, dims[1] / 2, dims[2] / 2];
  return { dims, bits, surface, centroid };
}

const JOB_WORDS = 4;

export class SdfModels {
  /** rows: contract.ts SdfModel */
  models: GPUBuffer;
  /** fields and sample lists */
  data: GPUBuffer;
  /** occupancy bits (a model's at info(id).occBase, entry x + dx * (y + dy * z) of the padded grid) */
  occ: GPUBuffer;
  /** surface voxels the last bake found, a word a model (more than its sampleCap: samples were dropped) */
  bakeCount: GPUBuffer;
  /** goes up when a buffer above is replaced by a bigger one: whoever binds them makes its bind groups again */
  version = 0;
  /** bake dispatches encoded so far (a test's count) */
  dispatches = 0;

  private recs: Rec[] = [];
  private freeIds: number[] = [];
  private dataArena = new Arena();
  private occArena = new Arena();
  private pending = new Map<number, Uint32Array | null>();
  private kSeed: ComputeKernel;
  private kJfa: ComputeKernel;
  private kFinal: ComputeKernel;
  private kCommit: ComputeKernel;
  private scratch: [GPUBuffer, GPUBuffer] | null = null;
  private scratchThreads = 0;

  /**
   * `scratchThreads`: the padded voxels one batch of dispatches floods at once (16 B of scratch each, kept between
   * bakes); a bigger bake runs as several batches in the one submit.
   */
  constructor(
    private device: GPUDevice,
    readonly format: SdfFormat,
    private opts: { scratchThreads?: number } = {},
  ) {
    const parts = [sdfFormatWgsl(format), modelWgsl, bakeWgsl];
    this.kSeed = makeCompute(device, 'sdf seed', parts, { 0: 'uniform', 1: 'read', 2: 'rw', 3: 'read', 5: 'rw', 6: 'rw', 7: 'rw' }, 'seed');
    this.kJfa = makeCompute(device, 'sdf jfa', parts, { 0: 'uniform', 1: 'read', 2: 'rw', 4: 'read', 5: 'rw' }, 'jfa');
    this.kFinal = makeCompute(device, 'sdf finalize', parts, { 0: 'uniform', 1: 'read', 2: 'rw', 4: 'read', 6: 'rw' }, 'finalize');
    this.kCommit = makeCompute(device, 'sdf commit', parts, { 0: 'uniform', 1: 'read', 2: 'rw', 7: 'rw' }, 'commit');
    this.models = this.make('sdf models', 64 * SDF_MODEL_BYTES);
    this.data = this.make('sdf data', 4 << 16);
    this.occ = this.make('sdf occupancy', 4 << 12);
    this.bakeCount = this.make('sdf bake counts', 64 * 4);
  }

  private make(label: string, size: number): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }

  /** `buf` with room for `bytes`: itself, or a buffer twice the size (or more) holding its first `used` bytes */
  private room(buf: GPUBuffer, bytes: number, used: number): GPUBuffer {
    if (buf.size >= bytes) return buf;
    let size = buf.size;
    while (size < bytes) size *= 2;
    const next = this.make(buf.label, size);
    if (used > 0) {
      const enc = this.device.createCommandEncoder({ label: 'sdf grow' });
      enc.copyBufferToBuffer(buf, 0, next, 0, Math.min(buf.size, Math.ceil(used / 4) * 4));
      this.device.queue.submit([enc.finish()]);
    }
    buf.destroy();
    this.version++;
    return next;
  }

  get count(): number {
    return this.recs.filter((r) => r.live).length;
  }

  info(id: number): SdfModelInfo {
    const r = this.rec(id);
    const bytes = { field: r.fieldWords * 4, samples: r.sampleCap * 4, occupancy: r.occWords * 4, row: SDF_MODEL_BYTES + 4, total: 0 };
    bytes.total = bytes.field + bytes.samples + bytes.occupancy + bytes.row;
    return { dims: r.dims, fieldBase: r.fieldBase, fieldWords: r.fieldWords, sampleBase: r.sampleBase, sampleCap: r.sampleCap, occBase: r.occBase, occWords: r.occWords, voxel: r.voxel, com: r.com, bytes };
  }

  private rec(id: number): Rec {
    const r = this.recs[id];
    if (!r?.live) throw new Error(`SdfModels: no model ${id}`);
    return r;
  }

  /** A model added: its row index. Baked by the next flush(). */
  add(spec: SdfModelSpec): number {
    const p = padOccupancy(spec);
    const nvox = p.dims[0] * p.dims[1] * p.dims[2];
    const fieldWords = this.format === 'snorm8' ? Math.ceil(nvox / 4) : nvox;
    const occWords = p.bits.length;
    // (a model with no surface still gets a word: a range of nothing can't be freed)
    const sampleCap = Math.max(p.surface, 1);
    const id = this.freeIds.pop() ?? this.recs.length;
    this.recs[id] = {
      live: true,
      dims: p.dims,
      fieldBase: this.dataArena.alloc(fieldWords),
      fieldWords,
      sampleBase: this.dataArena.alloc(sampleCap),
      sampleCap,
      occBase: this.occArena.alloc(occWords),
      occWords,
      voxel: spec.voxel,
      com: spec.com ? [spec.com[0] + SDF_PAD, spec.com[1] + SDF_PAD, spec.com[2] + SDF_PAD] : p.centroid,
    };
    this.pending.set(id, p.bits);
    return id;
  }

  /** A model's voxels changed on the CPU (same size): its occupancy uploaded and the model baked again by the next flush(). */
  update(id: number, spec: SdfModelSpec): void {
    const r = this.rec(id);
    const p = padOccupancy(spec);
    if (p.dims.some((v, k) => v !== r.dims[k])) throw new Error(`SdfModels.update(${id}): the size changed; remove it and add the new one`);
    this.samplesFor(r, Math.max(p.surface, 1));
    r.voxel = spec.voxel;
    r.com = spec.com ? [spec.com[0] + SDF_PAD, spec.com[1] + SDF_PAD, spec.com[2] + SDF_PAD] : p.centroid;
    this.pending.set(id, p.bits);
  }

  /**
   * A model whose occupancy bits a GPU pass rewrote (a body back from deformation, an eroded one): baked again by the
   * next flush(), with no upload. `sampleCap` is the room for its surface voxels (the caller's bound: the CPU has not
   * seen the new shape); `bakeCount` says afterwards if it was too small. `com` in the model's own voxel coordinates.
   */
  rebakeFromGpu(id: number, opts: { sampleCap?: number; com?: readonly [number, number, number] } = {}): void {
    const r = this.rec(id);
    if (opts.sampleCap !== undefined) this.samplesFor(r, Math.max(opts.sampleCap, 1));
    if (opts.com) r.com = [opts.com[0] + SDF_PAD, opts.com[1] + SDF_PAD, opts.com[2] + SDF_PAD];
    if (!this.pending.has(id)) this.pending.set(id, null);
  }

  private samplesFor(r: Rec, cap: number): void {
    if (cap === r.sampleCap) return;
    this.dataArena.free(r.sampleBase, r.sampleCap);
    r.sampleBase = this.dataArena.alloc(cap);
    r.sampleCap = cap;
  }

  remove(id: number): void {
    const r = this.rec(id);
    this.dataArena.free(r.fieldBase, r.fieldWords);
    this.dataArena.free(r.sampleBase, r.sampleCap);
    this.occArena.free(r.occBase, r.occWords);
    r.live = false;
    this.pending.delete(id);
    this.freeIds.push(id);
  }

  /** words in use and free inside the arenas (a report's numbers) */
  usage(): { dataWords: number; dataHoles: number; occWords: number; occHoles: number; dataBytes: number; occBytes: number } {
    return { dataWords: this.dataArena.end, dataHoles: this.dataArena.holeWords, occWords: this.occArena.end, occHoles: this.occArena.holeWords, dataBytes: this.data.size, occBytes: this.occ.size };
  }

  /**
   * Every pending model baked: the uploads, then the bake's dispatches in one submit. Returns how many models.
   * A batch of threads T (padded voxels) is 1 seed + ceil(log2(longest side)) + 1 flood + 1 finalize + 1 commit dispatches.
   */
  flush(): number {
    const ids = [...this.pending.keys()].sort((a, b) => a - b);
    if (!ids.length) return 0;
    const dev = this.device;
    const prev = { data: this.dataArena.end, occ: this.occArena.end };
    this.models = this.room(this.models, this.recs.length * SDF_MODEL_BYTES, this.recs.length * SDF_MODEL_BYTES);
    this.bakeCount = this.room(this.bakeCount, this.recs.length * 4, this.recs.length * 4);
    this.data = this.room(this.data, prev.data * 4, prev.data * 4);
    this.occ = this.room(this.occ, prev.occ * 4, prev.occ * 4);
    for (const id of ids) {
      const r = this.recs[id];
      const row = new ArrayBuffer(SDF_MODEL_BYTES);
      new Uint32Array(row).set([r.fieldBase, r.dims[0] | (r.dims[1] << 8) | (r.dims[2] << 16), r.sampleBase, 0]);
      new Float32Array(row).set([r.com[0], r.com[1], r.com[2], r.voxel], 4);
      dev.queue.writeBuffer(this.models, id * SDF_MODEL_BYTES, row);
      const bits = this.pending.get(id);
      if (bits) dev.queue.writeBuffer(this.occ, r.occBase * 4, bits.buffer, bits.byteOffset, bits.byteLength);
    }
    this.pending.clear();
    const budget = this.opts.scratchThreads ?? 1 << 18;
    const enc = dev.createCommandEncoder({ label: 'sdf bake' });
    const temps: GPUBuffer[] = [];
    const span = (id: number) => Math.ceil((this.recs[id].dims[0] * this.recs[id].dims[1] * this.recs[id].dims[2]) / 4) * 4;
    const batches: { ids: number[]; threads: number }[] = [];
    for (const id of ids) {
      let last = batches[batches.length - 1];
      if (!last || last.threads + span(id) > budget) batches.push((last = { ids: [], threads: 0 }));
      last.ids.push(id);
      last.threads += span(id);
    }
    // (the scratch sized once for the largest batch: every batch is in the one encoder)
    const most = Math.max(...batches.map((x) => x.threads));
    if (most > 65535 * 64) throw new Error(`SdfModels: a bake batch of ${most} voxels (one model past the dispatch's reach)`);
    if (!this.scratch || this.scratchThreads < most) {
      this.scratch?.forEach((x) => x.destroy());
      this.scratchThreads = most;
      this.scratch = [0, 1].map((k) => dev.createBuffer({ label: `sdf scratch ${k}`, size: most * 8, usage: GPUBufferUsage.STORAGE })) as [GPUBuffer, GPUBuffer];
    }
    for (const x of batches) this.encodeBatch(enc, x.ids, temps);
    dev.queue.submit([enc.finish()]);
    for (const b of temps) b.destroy();
    return ids.length;
  }

  private encodeBatch(enc: GPUCommandEncoder, ids: number[], temps: GPUBuffer[]): void {
    const dev = this.device;
    const jobs = new Uint32Array(ids.length * JOB_WORDS);
    let threads = 0;
    let side = 0;
    ids.forEach((id, k) => {
      const r = this.recs[id];
      jobs.set([id, threads, r.occBase, r.sampleCap], k * JOB_WORDS);
      threads += Math.ceil((r.dims[0] * r.dims[1] * r.dims[2]) / 4) * 4;
      side = Math.max(side, ...r.dims);
      enc.clearBuffer(this.bakeCount, id * 4, 4);
    });
    const filled = (label: string, words: Uint32Array, usage: number) => {
      const b = dev.createBuffer({ label, size: words.byteLength, usage, mappedAtCreation: true });
      new Uint32Array(b.getMappedRange()).set(words);
      b.unmap();
      temps.push(b);
      return b;
    };
    const jobBuf = filled('sdf jobs', jobs, GPUBufferUsage.STORAGE);
    const params = (step: number) => filled('sdf bake params', new Uint32Array([ids.length, threads, step, 0]), GPUBufferUsage.UNIFORM);
    const groups = Math.ceil(threads / 64);
    const pass = enc.beginComputePass({ label: 'sdf bake' });
    const run = (k: ComputeKernel, bg: GPUBindGroup, n: number) => {
      pass.setPipeline(k.pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(n);
      this.dispatches++;
    };
    const p0 = params(0);
    const [s0, s1] = this.scratch!;
    run(this.kSeed, makeBindGroup(dev, 'sdf seed', this.kSeed.layout, { 0: p0, 1: jobBuf, 2: this.models, 3: this.occ, 5: s0, 6: this.data, 7: this.bakeCount }), groups);
    // the flood: strides N/2 … 1 for the power of two N at or past the longest side, then 1 again (JFA+1)
    let n = 1;
    while (n < side) n *= 2;
    const steps: number[] = [];
    for (let s = n / 2; s >= 1; s /= 2) steps.push(s);
    steps.push(1);
    let from = s0;
    let to = s1;
    for (const s of steps) {
      run(this.kJfa, makeBindGroup(dev, 'sdf jfa', this.kJfa.layout, { 0: params(s), 1: jobBuf, 2: this.models, 4: from, 5: to }), groups);
      [from, to] = [to, from];
    }
    run(this.kFinal, makeBindGroup(dev, 'sdf finalize', this.kFinal.layout, { 0: p0, 1: jobBuf, 2: this.models, 4: from, 6: this.data }), this.format === 'snorm8' ? Math.ceil(threads / 4 / 64) : groups);
    run(this.kCommit, makeBindGroup(dev, 'sdf commit', this.kCommit.layout, { 0: p0, 1: jobBuf, 2: this.models, 7: this.bakeCount }), Math.ceil(ids.length / 64));
    pass.end();
  }

  destroy(): void {
    for (const b of [this.models, this.data, this.occ, this.bakeCount, ...(this.scratch ?? [])]) b.destroy();
  }
}
