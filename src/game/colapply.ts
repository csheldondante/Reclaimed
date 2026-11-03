// (round 120, JB6: "no CPU readback on the hot path") Changes to the GPU's columns made in place (shaders/colapply.wgsl):
// a collapse verdict's cuts, its crumbs spilled as loose ground onto the lowest open column beside them, loose ground
// laid (added to `deposit`, never overwritten), External spans let go, orphans made ground again. The integrity system
// makes every such change this way, whichever judge gave it, so it needs no CPU copy of the columns to make one; where a
// CPU consumer still keeps a copy (judge A, the CPU rigid rock) it mirrors the same change into it with the CPU's
// statement of the rule.
//
// The rules, one statement each on the CPU (held equal to the GPU's by test/gpu/colapply.test.ts):
//   cutColumn     colbodies.ts subtract, then a column over its K slots keeps its bottom K − 1 and piles the rest's
//                 height as rubble on top (fitColumn: what Integrity.writeColumn did)
//   spillPlan     each crumbled cell's rubble goes to the lowest-topped column of the 3 x 3 round it (offset coordinates,
//                 dy then dx, the first lowest) that isn't a crumbled column; a target gets a cell's worth each, and the
//                 loose material most of them gave (looseFrom; ties: the lowest material id)
//   releaseSpan, orphanColumn   sim/external.ts
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

/** Where loose ground lands: the per-column deposit buffer and the window's page table (sim/pages.ts). */
export interface SpillTarget {
  deposit: GPUBuffer;
  /** a page's slot, page row by page row (Pages.slots over the whole window) */
  pages: Uint16Array | Uint32Array;
}

/**
 * One step of the changes, in order: these cuts, then (optional) these crumbled cells spilled, this loose ground laid,
 * these External spans let go (sim/external.ts release).
 */
export interface ApplyStage {
  cuts: { x: number; y: number; cuts: { z0: number; z1: number }[] }[];
  spill?: Voxel[];
  /** loose ground laid: a column's amount and material (one entry a column) */
  deposits?: { x: number; y: number; amount: number; mat: number }[];
  /** External spans let go (to their fallback, or air) */
  release?: { x: number; y: number; z0: number; z1: number; fallback: number; toAir: boolean }[];
}

const MAX_CUTS = 32;
const PARAM_BYTES = 128;
const PARAM_STRIDE = 256;
const KERNELS = ['applyCuts', 'spillTarget', 'spillDeposit', 'depositAdd', 'release', 'orphans'] as const;
type Kernel = (typeof KERNELS)[number];
const BINDS = { 0: 'uniform', 1: 'read', 2: 'rw', 3: 'read', 4: 'rw', 5: 'rw' } as const;
type ParamKey = 'nOps' | 'nSpill' | 'nGone' | 'hashCap' | 'opOff' | 'cutOff' | 'spillOff' | 'goneOff' | 'nDep' | 'depOff' | 'nKeys' | 'keyOff' | 'refOff' | 'spanOff';

interface Dispatch {
  kernel: Kernel;
  groups: number;
  params: ArrayBuffer;
}

/** items merged by their column, in first-seen order */
function byColumn<T extends { x: number; y: number }, E>(items: T[], W: number, H: number, each: (t: T) => E[]): { x: number; y: number; items: E[] }[] {
  const by = new Map<number, { x: number; y: number; items: E[] }>();
  for (const t of items) {
    if (t.x < 0 || t.y < 0 || t.x >= W || t.y >= H) throw new Error(`ColumnApply: column ${t.x},${t.y} off the window`);
    const k = t.y * W + t.x;
    const e = by.get(k) ?? { x: t.x, y: t.y, items: [] };
    e.items.push(...each(t));
    by.set(k, e);
  }
  return [...by.values()];
}

export class ColumnApply {
  private layout: GPUBindGroupLayout;
  private pipes: Record<Kernel, GPUComputePipeline>;
  private inp: GPUBuffer | null = null;
  private params: GPUBuffer | null = null;
  private hash: GPUBuffer | null = null;
  /** a deposit buffer for runs that lay nothing */
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

  /** The stages applied in order, in one submit. A stage that spills or lays loose ground needs `target`. */
  run(cols: GpuColumns, stages: ApplyStage[], target?: SpillTarget): void {
    const enc = this.encode(cols, stages, null, target);
    if (enc) this.device.queue.submit([enc.finish()]);
  }

  /**
   * External intervals no claimed span holds made ground again over the whole window (sim/external.ts orphans; the
   * registry's claimedSpans: column key y · 65536 + x → spans in its order).
   */
  orphans(cols: GpuColumns, claimed: Map<number, { z0: number; z1: number }[]>): void {
    const enc = this.encode(cols, [], claimed);
    if (enc) this.device.queue.submit([enc.finish()]);
  }

  private encode(cols: GpuColumns, stages: ApplyStage[], claimed: Map<number, { z0: number; z1: number }[]> | null, target?: SpillTarget): GPUCommandEncoder | null {
    const { packed } = cols;
    const W = packed.dims.w;
    const H = packed.dims.h;
    const words: number[] = [];
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    const bits = (z: number) => ((f[0] = z), u[0]);
    const dispatches: Dispatch[] = [];
    // (the page table and the loose slots once, shared by every spill and deposit)
    let pageOff = 0;
    let looseOff = 0;
    if (stages.some((s) => s.spill?.length || s.deposits?.length)) {
      if (!target) throw new Error('ColumnApply: loose ground to lay, but no deposit was given');
      pageOff = words.length;
      for (const s of target.pages) words.push(s);
      looseOff = words.length;
      for (let m = 0; m < 256; m++) words.push(LOOSE.indexOf(looseFrom(m)));
    }
    let maxSpill = 0;
    const param = (kernel: Kernel, groups: number, v: Partial<Record<ParamKey, number>>) => {
      const b = new ArrayBuffer(PARAM_BYTES);
      const pu = new Uint32Array(b);
      const pf = new Float32Array(b);
      pu.set([W, H, packed.chunksX, CHUNK, v.nOps ?? 0, v.nSpill ?? 0, v.nGone ?? 0, v.hashCap ?? 1, v.opOff ?? 0, v.cutOff ?? 0, v.spillOff ?? 0, v.goneOff ?? 0, pageOff, looseOff, W / CHUNK]);
      pf[15] = packed.dims.zMax;
      pu.set([...LOOSE, 0, 0], 16);
      pu.set([v.nDep ?? 0, v.depOff ?? 0, v.nKeys ?? 0, v.keyOff ?? 0, v.refOff ?? 0, v.spanOff ?? 0, 0, 0], 24);
      if (groups > 0) dispatches.push({ kernel, groups, params: b });
    };
    for (const st of stages) {
      // (a column once a dispatch, its cuts merged: a column's intervals while cut are its K and a split a cut, held in
      // the shader's MAX_IV — more cuts than MAX_CUTS on one column is a bug upstream, not cut in rounds: a round's
      // fit to K between them would pile rubble the CPU's one fit doesn't)
      const ops = byColumn(st.cuts, W, H, (c) => c.cuts);
      for (const e of ops) if (e.items.length > MAX_CUTS) throw new Error(`ColumnApply: ${e.items.length} cuts on column ${e.x},${e.y} (at most ${MAX_CUTS})`);
      if (ops.length) {
        const opOff = words.length;
        let first = 0;
        for (const e of ops) {
          words.push(e.x, e.y, first, e.items.length);
          first += e.items.length;
        }
        const cutOff = words.length;
        for (const e of ops) for (const c of e.items) words.push(bits(c.z0), bits(c.z1));
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
      const dep = st.deposits ?? [];
      if (dep.length) {
        const seen = new Set<number>();
        const depOff = words.length;
        for (const d of dep) {
          if (d.x < 0 || d.y < 0 || d.x >= W || d.y >= H) throw new Error(`ColumnApply: deposit at ${d.x},${d.y} off the window`);
          const k = d.y * W + d.x;
          if (seen.has(k)) throw new Error(`ColumnApply: two deposits on column ${d.x},${d.y} in one stage (one a column)`);
          seen.add(k);
          words.push(d.x, d.y, bits(d.amount), d.mat);
        }
        param('depositAdd', Math.ceil(dep.length / 64), { nDep: dep.length, depOff });
      }
      const rel = byColumn(st.release ?? [], W, H, (r) => [r]);
      if (rel.length) {
        const opOff = words.length;
        let first = 0;
        for (const e of rel) {
          words.push(e.x, e.y, first, e.items.length);
          first += e.items.length;
        }
        const cutOff = words.length;
        for (const e of rel) for (const r of e.items) words.push(bits(r.z0), bits(r.z1), r.fallback, r.toAir ? 1 : 0);
        param('release', Math.ceil(rel.length / 64), { nOps: rel.length, opOff, cutOff });
      }
    }
    if (claimed) {
      const keys = [...claimed.keys()].sort((a, b) => a - b);
      const keyOff = words.length;
      words.push(...keys);
      const refOff = words.length;
      let first = 0;
      for (const k of keys) {
        const n = claimed.get(k)!.length;
        words.push(first, n);
        first += n;
      }
      const spanOff = words.length;
      for (const k of keys) for (const c of claimed.get(k)!) words.push(bits(c.z0), bits(c.z1));
      param('orphans', Math.ceil((W * H) / 64), { nKeys: keys.length, keyOff, refOff, spanOff });
    }
    if (!dispatches.length) return null;
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
    return enc;
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
