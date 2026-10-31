// (round 120, JB6: "no CPU readback on the hot path") A collapse verdict applied to the GPU's columns in place
// (shaders/colapply.wgsl): the runs a judge freed or crumbled cut out, what crumbled spilled as loose ground onto the
// lowest open column beside it through `deposit`. Integrity applies every verdict this way, whichever judge gave it, so
// it needs no CPU copy of the columns to apply one; where a CPU consumer still keeps a copy (judge A, the old variant's
// CPU rigid rock) Integrity mirrors the same cuts into it with cutColumn, the CPU's statement of the same rule.
//
// The rules, shared by both sides (and the Node tests that hold the GPU to them, test/gpu/colapply.test.ts):
//   cutColumn   colbodies.ts subtract, then a column over its K slots keeps its bottom K − 1 and piles the rest's
//               height as rubble on top (what Integrity.writeColumn did)
//   spillPlan   each crumbled cell's rubble goes to the lowest-topped column of the 3 x 3 round it (offset coordinates,
//               dy then dx, the first lowest) that isn't a crumbled column; a target gets a cell's worth each, and the
//               loose material most of them gave (looseFrom; ties: the lowest material id)
import colapplyWgsl from '../shaders/colapply.wgsl?raw';
import { makeBindGroup, makeLayout } from '../gpu/pipeline';
import { subtract } from './colbodies';
import type { Voxel } from './fracture';
import { CHUNK, type Interval, type PackedWorld } from '../world/layout';
import { MAT } from '../world/materials';

/** What a crumbled cell of material m becomes as loose ground. */
export function looseFrom(m: number): number {
  if (m === MAT.Wood || m === MAT.Canvas || m === MAT.Leaves) return MAT.Ash;
  if (m === MAT.Bone) return MAT.Drift;
  if (m === MAT.Trash) return MAT.Litter;
  if (m === MAT.Ice) return MAT.Snow;
  if (m === MAT.Crystal) return MAT.Sand;
  return MAT.Rubble;
}
/** looseFrom's results, ascending: the GPU's vote slots */
const LOOSE: number[] = [...new Set<number>([MAT.Ash, MAT.Drift, MAT.Litter, MAT.Snow, MAT.Sand, MAT.Rubble])].sort((a, b) => a - b);
if (LOOSE.length !== 6) throw new Error('colapply: looseFrom must give six materials (the shader votes in six slots)');

/** A column written with no room: its bottom k − 1 kept, the rest's height piled as rubble on top (to zMax − 1). */
export function fitColumn(col: Interval[], k: number, zMax: number): Interval[] {
  if (col.length <= k) return col;
  const keep = col.slice(0, k - 1);
  const top = keep.length ? keep[keep.length - 1].z1 : 0;
  const rest = col.slice(k - 1).reduce((s, iv) => s + iv.z1 - iv.z0, 0);
  keep.push({ z0: top, z1: Math.min(top + rest, zMax - 1), mat: MAT.Rubble });
  return keep;
}

/** What applyCuts does to one column: the cuts taken out, then fitted to its k slots. */
export function cutColumn(col: Interval[], cuts: { z0: number; z1: number }[], k: number, zMax: number): Interval[] {
  return fitColumn(subtract(col, cuts), k, zMax);
}

/** Where crumbled cells' rubble goes: target column (y * W + x) → cells and the loose material most given. */
export function spillPlan(cells: Voxel[], topAt: (x: number, y: number) => number, W: number, H: number): Map<number, { amount: number; mat: number }> {
  const gone = new Set(cells.map((c) => c.y * W + c.x));
  const votes = new Map<number, Map<number, number>>();
  for (const c of cells) {
    let best: [number, number] = [c.x, c.y];
    let low = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H || gone.has(y * W + x)) continue;
        const t = topAt(x, y);
        if (t < low) [best, low] = [[x, y], t];
      }
    const key = best[1] * W + best[0];
    const v = votes.get(key) ?? new Map<number, number>();
    const m = looseFrom(c.mat);
    v.set(m, (v.get(m) ?? 0) + 1);
    votes.set(key, v);
  }
  const out = new Map<number, { amount: number; mat: number }>();
  for (const [key, v] of votes) {
    let amount = 0;
    let mat = 0;
    let n = -1;
    for (const m of LOOSE) {
      const c = v.get(m) ?? 0;
      amount += c;
      if (c > n) [mat, n] = [m, c];
    }
    out.set(key, { amount, mat });
  }
  return out;
}

/** The columns as the GPU has them: its slots and chunk table, laid out as `packed` says (its chunk table mirrored). */
export interface GpuColumns {
  slots: GPUBuffer;
  chunks: GPUBuffer;
  packed: PackedWorld;
}

/** Where spilled rubble lands: the per-column deposit buffer and the window's page table (sim/pages.ts). */
export interface SpillTarget {
  deposit: GPUBuffer;
  /** a page's slot, page row by page row (Pages.slots over the whole window) */
  pages: Uint16Array | Uint32Array;
}

/** One step of a verdict's application: these cuts, then (optional) these crumbled cells spilled. In order. */
export interface ApplyStage {
  cuts: { x: number; y: number; cuts: { z0: number; z1: number }[] }[];
  spill?: Voxel[];
}

const MAX_CUTS = 32;
const PARAM_BYTES = 96;
const PARAM_STRIDE = 256;
const KERNELS = ['applyCuts', 'spillTarget', 'spillDeposit'] as const;
type Kernel = (typeof KERNELS)[number];
const BINDS = { 0: 'uniform', 1: 'read', 2: 'rw', 3: 'read', 4: 'rw', 5: 'rw' } as const;

interface Dispatch {
  kernel: Kernel;
  groups: number;
  params: ArrayBuffer;
}

export class ColumnApply {
  private layout: GPUBindGroupLayout;
  private pipes: Record<Kernel, GPUComputePipeline>;
  private inp: GPUBuffer | null = null;
  private params: GPUBuffer | null = null;
  private hash: GPUBuffer | null = null;
  /** (tests) a deposit buffer for runs with nothing to spill */
  private noDeposit: GPUBuffer;
  /** bytes uploaded by the last run (its whole cost on the bus: nothing comes back) */
  lastBytes = 0;

  constructor(private device: GPUDevice) {
    this.layout = makeLayout(device, 'colapply', BINDS, GPUShaderStage.COMPUTE);
    const module = device.createShaderModule({ label: 'colapply.wgsl', code: colapplyWgsl });
    const pl = device.createPipelineLayout({ label: 'colapply', bindGroupLayouts: [this.layout] });
    this.pipes = Object.fromEntries(KERNELS.map((k) => [k, device.createComputePipeline({ label: `colapply ${k}`, layout: pl, compute: { module, entryPoint: k } })])) as Record<Kernel, GPUComputePipeline>;
    this.noDeposit = device.createBuffer({ label: 'colapply no deposit', size: 16, usage: GPUBufferUsage.STORAGE });
  }

  /** The stages applied in order, in one submit. A stage that spills needs `target`. */
  run(cols: GpuColumns, stages: ApplyStage[], target?: SpillTarget): void {
    const { packed } = cols;
    const W = packed.dims.w;
    const H = packed.dims.h;
    const words: number[] = [];
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    const bits = (z: number) => ((f[0] = z), u[0]);
    const dispatches: Dispatch[] = [];
    // (the page table and the loose slots once, shared by every spill)
    let pageOff = 0;
    let looseOff = 0;
    const spills = stages.some((s) => s.spill?.length);
    if (spills) {
      if (!target) throw new Error('ColumnApply.run: a stage spills, but no deposit was given');
      pageOff = words.length;
      for (const s of target.pages) words.push(s);
      looseOff = words.length;
      for (let m = 0; m < 256; m++) words.push(LOOSE.indexOf(looseFrom(m)));
    }
    let maxSpill = 0;
    const param = (kernel: Kernel, groups: number, v: Partial<Record<'nOps' | 'nSpill' | 'nGone' | 'hashCap' | 'opOff' | 'cutOff' | 'spillOff' | 'goneOff', number>>) => {
      const b = new ArrayBuffer(PARAM_BYTES);
      const pu = new Uint32Array(b);
      const pf = new Float32Array(b);
      pu.set([W, H, packed.chunksX, CHUNK, v.nOps ?? 0, v.nSpill ?? 0, v.nGone ?? 0, v.hashCap ?? 1, v.opOff ?? 0, v.cutOff ?? 0, v.spillOff ?? 0, v.goneOff ?? 0, pageOff, looseOff, W / CHUNK]);
      pf[15] = packed.dims.zMax;
      pu.set([...LOOSE, 0, 0], 16);
      if (groups > 0) dispatches.push({ kernel, groups, params: b });
    };
    for (const st of stages) {
      // (a column once a dispatch, its cuts merged: a column's intervals while cut are its K and a split a cut, held in
      // the shader's MAX_IV — more cuts than MAX_CUTS on one column is a bug upstream, not cut in rounds: a round's
      // fit to K between them would pile rubble the CPU's one fit doesn't)
      const by = new Map<number, { x: number; y: number; cuts: { z0: number; z1: number }[] }>();
      for (const c of st.cuts) {
        if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) throw new Error(`ColumnApply: column ${c.x},${c.y} off the window`);
        const k = c.y * W + c.x;
        const e = by.get(k) ?? { x: c.x, y: c.y, cuts: [] };
        e.cuts.push(...c.cuts);
        by.set(k, e);
      }
      const ops = [...by.values()];
      for (const e of ops) if (e.cuts.length > MAX_CUTS) throw new Error(`ColumnApply: ${e.cuts.length} cuts on column ${e.x},${e.y} (at most ${MAX_CUTS})`);
      if (ops.length) {
        const opOff = words.length;
        let first = 0;
        for (const e of ops) {
          words.push(e.x, e.y, first, e.cuts.length);
          first += e.cuts.length;
        }
        const cutOff = words.length;
        for (const e of ops) for (const c of e.cuts) words.push(bits(c.z0), bits(c.z1));
        param('applyCuts', Math.ceil(ops.length / 64), { nOps: ops.length, opOff, cutOff });
      }
      const sp = st.spill ?? [];
      if (sp.length) {
        const spillOff = words.length;
        for (const c of sp) words.push(c.x, c.y, c.z, c.mat);
        const goneOff = words.length;
        const gone = [...new Set(sp.map((c) => c.y * W + c.x))].sort((a, b) => a - b);
        words.push(...gone);
        let cap = 64;
        while (cap < 2 * sp.length) cap *= 2;
        maxSpill = Math.max(maxSpill, cap);
        param('spillTarget', Math.ceil(sp.length / 64), { nSpill: sp.length, nGone: gone.length, hashCap: cap, spillOff, goneOff });
        param('spillDeposit', Math.ceil(cap / 64), { hashCap: cap });
      }
    }
    if (!dispatches.length) return;
    const dev = this.device;
    const data = new Uint32Array(words);
    this.inp = grow(dev, this.inp, 'colapply input', Math.max(16, data.byteLength), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.params = grow(dev, this.params, 'colapply params', dispatches.length * PARAM_STRIDE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    if (maxSpill) this.hash = grow(dev, this.hash, 'colapply hash', maxSpill * 32, GPUBufferUsage.STORAGE);
    dev.queue.writeBuffer(this.inp, 0, data);
    const pdata = new Uint8Array(dispatches.length * PARAM_STRIDE);
    dispatches.forEach((d, i) => pdata.set(new Uint8Array(d.params), i * PARAM_STRIDE));
    dev.queue.writeBuffer(this.params, 0, pdata);
    this.lastBytes = data.byteLength + pdata.byteLength;
    const hash = this.hash ?? (this.hash = grow(dev, null, 'colapply hash', 64 * 32, GPUBufferUsage.STORAGE));
    const enc = dev.createCommandEncoder({ label: 'colapply' });
    dispatches.forEach((d, i) => {
      const bg = makeBindGroup(dev, `colapply ${d.kernel}`, this.layout, {
        0: { buffer: this.params!, offset: i * PARAM_STRIDE, size: PARAM_BYTES },
        1: cols.chunks,
        2: cols.slots,
        3: this.inp!,
        4: hash,
        5: target?.deposit ?? this.noDeposit,
      });
      // (a pass each: every dispatch sees the last one's writes)
      const pass = enc.beginComputePass({ label: `colapply ${d.kernel}` });
      pass.setPipeline(this.pipes[d.kernel]);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(d.groups);
      pass.end();
    });
    dev.queue.submit([enc.finish()]);
  }

  destroy(): void {
    this.inp?.destroy();
    this.params?.destroy();
    this.hash?.destroy();
    this.noDeposit.destroy();
  }
}

/** a buffer at least `size` bytes (doubled when it grows; a new one's contents are zero) */
function grow(dev: GPUDevice, b: GPUBuffer | null, label: string, size: number, usage: number): GPUBuffer {
  if (b && b.size >= size) return b;
  b?.destroy();
  let s = Math.max(256, b?.size ?? 0);
  while (s < size) s *= 2;
  return dev.createBuffer({ label, size: s, usage });
}
