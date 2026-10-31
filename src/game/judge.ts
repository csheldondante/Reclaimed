// The collapse judges (round 120, the user: "Can we treat this as an experiment and test each approach side by side?
// Performance batteries and feel tests so I can see what is improved vs the cost?"). One interface, two judges, picked
// by `?judge=` (or a lab's panel, from JUDGES):
//   runs      judge A (the default): fracture.ts analyseRock on the CPU, over a read-back copy of the columns —
//             joints of runs (round 92), legs that buckle, bend and tip (round 96)
//   sections  judge B: the user's method of sections on the GPU (shaders/judge.wgsl) — every section's shear and
//             moment (weight × lever to the centre of mass beyond it) against its strength and section modulus, a
//             thrust line for what's held from opposite sides (arches, domes); the columns read in place on the GPU,
//             only the verdict read back
// Both take the columns and the seeds (the columns an edit cut) and return a Fracture (what falls, what crumbles, what
// tips and about which edge), so Integrity, the tests and a lab switch judges with nothing else changed.
// docs/ARCHITECTURE.md "The collapse judges"; DEVLOG round 120 has the why and the numbers.

import { analyseRock, type Fracture, type RockOpts, type RunPiece, type WorldVox } from './fracture';
import { MATERIALS, MatState } from '../world/materials';
import { type PackedWorld } from '../world/layout';
import { nbr, NDIR } from '../world/lattice';
import { WORLD_G } from '../world/scale';
import { TUNE } from '../tune/params';
import { makeBindGroup, makeLayout } from '../gpu/pipeline';
import judgeWgsl from '../shaders/judge.wgsl?raw';

/** The columns a judge looks at: their packing, and the copy each judge reads (A the CPU's, B the GPU's own). */
export interface JudgeColumns {
  packed: PackedWorld;
  /** (judge A) the CPU's copy of the slots, as read back */
  vox?: WorldVox;
  /** (judge B) the GPU's slots and chunk table (WorldGpu.layers, WorldGpu.chunks), read in place */
  gpu?: { device: GPUDevice; slots: GPUBuffer; chunks: GPUBuffer };
}

export interface JudgeInput {
  cols: JudgeColumns;
  /** the columns an edit changed (and what's to be looked at again) */
  seeds: Iterable<[number, number]>;
  /** (judge A) the columns the CPU's copy holds as they are now (fracture.ts analyseRock `known`) */
  known?: (x: number, y: number) => boolean;
  /** what's weighed (fracture.ts RockOpts.weigh): only a piece an edit weakened, by default every one */
  weigh?: RockOpts['weigh'];
  /** pieces that tip turn (RockOpts.rotate): their edges reported */
  rotate?: boolean;
}

export interface JudgeStats {
  /** wall time of the last judging (ms): A its CPU, B its submit to the verdict in hand */
  ms: number;
  /** (B) its GPU time, by timestamp queries (when the device has them) */
  gpuMs?: number;
  /** bytes read back for the verdict (B) */
  readBytes?: number;
  /** (B) runs in the window, hanging ones, sections checked */
  nodes?: number;
  hanging?: number;
  sections?: number;
  /** (B) pieces that fell because a thrust line didn't fit (or crushed its crown) */
  arch?: number;
  window?: [number, number, number, number];
  /** (B) its GPU ms kernel by kernel */
  kernels?: Record<string, number>;
  /** (B) the runs it judged (of the seeded, weighed pieces), the deepest level, the pairs (a judged run at each of
   *  its levels), and the judged runs' box (x0, y0, x1, y1): what the cut really needed of the window */
  judged?: number;
  deepest?: number;
  pairs?: number;
  judgedBox?: [number, number, number, number];
}

export interface RockJudge {
  readonly id: JudgeId;
  judge(input: JudgeInput): Promise<Fracture>;
  /** (B) make its pipelines ahead of the first cut (async: the first judging otherwise compiled them on the frame — a
   *  1.4 s frame on the phone proxy's first cut, round 120's browser battery) */
  warm?(device: GPUDevice): Promise<void>;
  readonly stats: JudgeStats;
  destroy(): void;
}

/** The judges, for a panel to list (the solver lab's variant switch) */
export const JUDGES = {
  runs: { label: 'A — runs (CPU: joints, legs; round 92/96)', make: (): RockJudge => new RunsJudge() },
  sections: { label: 'B — method of sections (GPU: every section, thrust lines)', make: (): RockJudge => new SectionsJudge() },
} as const;
export type JudgeId = keyof typeof JUDGES;

/** the page's judge (?judge=runs|sections; runs by default) */
export const JUDGE_ID: JudgeId = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('judge');
  if (v === null) return 'runs';
  if (!(v in JUDGES)) throw new Error(`?judge=${v}: ${Object.keys(JUDGES).join(' or ')}`);
  return v as JudgeId;
})();

/** the page's address (judge B's ?jbmode= ?jbcull= for the browser battery) */
const PAGE_Q = typeof location === 'undefined' ? null : new URLSearchParams(location.search);

/** Judge A: fracture.ts analyseRock over the CPU's copy. */
export class RunsJudge implements RockJudge {
  readonly id = 'runs' as const;
  readonly stats: JudgeStats = { ms: 0 };
  async judge(inp: JudgeInput): Promise<Fracture> {
    if (!inp.cols.vox) throw new Error('judge A (runs) needs the CPU copy of the columns');
    const t0 = performance.now();
    const r = analyseRock(inp.cols.vox, inp.seeds, inp.known, { weigh: inp.weigh, rotate: inp.rotate });
    this.stats.ms = performance.now() - t0;
    return r;
  }
  destroy(): void {}
}

// ---- judge B ----

/** judge.wgsl's layout: its work buffer's fields, its output's header (keep in step with the shader) */
const NFIELDS = 96;
/** the nodes' own numbers (judge.wgsl N_*) */
const NN = 67;
/** the pairs' fields (judge.wgsl P_*) */
const NPF = 55;
const NCOUNT = 16;
const O_REC0 = 32 + 1024 * 8;
const O_PIECE0 = 32;
const O_STATS = 16;
const PIECE_W = 8;
const MAX_LEVELS = 1024;
const PARAM_BYTES = 112;
const NONE = 0xffffffff;
/** the kinds judge.wgsl reports (K_*) */
const KIND = ['free', 'shear', 'bend', 'arch', 'arch crush', 'tip', 'lean', 'crush'] as const;
/** the kernels, in their order (the pairs' only in mode `pairs`) */
const KERNELS = ['build', 'adjacency', 'pieces', 'pieceFlags', 'judge1', 'faces', 'pairsInit', 'pairsUnite', 'pairsFind', 'pairsSum', 'checks', 'marks', 'judge2', 'judge3', 'freedUnite', 'judge4'] as const;
type Kernel = (typeof KERNELS)[number];
const PAIR_KERNELS = new Set<Kernel>(['pairsInit', 'pairsUnite', 'pairsFind', 'pairsSum', 'checks', 'marks']);
const BINDS = { 0: 'uniform', 1: 'read', 2: 'read', 3: 'read', 4: 'read', 5: 'rw', 6: 'rw', 7: 'rw', 8: 'rw' } as const;

interface Sized {
  ncap: number;
  pcap: number;
  outCap: number;
  cols: number;
  work: GPUBuffer;
  nodes: GPUBuffer;
  out: GPUBuffer;
  read: GPUBuffer;
  mask: GPUBuffer;
}

interface DeviceKit {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  pipes: Record<Kernel, GPUComputePipeline>;
  params: GPUBuffer;
  mats: GPUBuffer;
  ind: GPUBuffer;
  /** (binding 8 of every kernel but judge1: the indirect buffer can't be writable in the pass that dispatches from it) */
  dummy: GPUBuffer;
  query: GPUQuerySet | null;
  qres: GPUBuffer | null;
  sized: Sized | null;
}

/** the material table judge.wgsl reads: state, strength, density (fracture.ts densityOf), never-gives */
function materialTable(): Float32Array {
  const t = new Float32Array(256 * 4);
  MATERIALS.forEach((m, i) => {
    t[i * 4] = m.state;
    t[i * 4 + 1] = m.strength;
    t[i * 4 + 2] = m.density ?? (m.state === MatState.Vegetation ? 0.4 : 1);
    t[i * 4 + 3] = m.span === Infinity ? 1 : 0;
  });
  return t;
}

/**
 * Judge B: the method of sections on the GPU (judge.wgsl's header says how). A window round the seeds (the seeds' box
 * and TUNE.judgeB.margin columns round it) is judged in one submit and only the verdict comes back: the runs that
 * go, their slots copied, and each piece's kind and hinge. Only the pieces a cut could have weakened are flooded and
 * judged (round 120's culling: exact). Its sections are judged all levels at once on the whole GPU (`mode` 'pairs',
 * the default) or a pass a level in one workgroup ('levels': the oracle the tests hold 'pairs' to). Its work buffers
 * grow to the window (never a silent cap: past them it's judged again in bigger ones).
 */
export class SectionsJudge implements RockJudge {
  readonly id = 'sections' as const;
  readonly stats: JudgeStats = { ms: 0 };
  private kit: DeviceKit | null = null;
  /** 'pairs': every level at once (union-find on (run, level) pairs); 'levels': a pass a level (the oracle) */
  mode: 'pairs' | 'levels' = PAGE_Q?.get('jbmode') === 'levels' ? 'levels' : 'pairs';
  /** (the perf battery, the equality tests; ?jbcull=0) false judges every piece in the window, not only the seeded ones */
  cull = PAGE_Q?.get('jbcull') !== '0';
  /** (perf battery only) stop judge.wgsl's single-workgroup kernels before this phase; 0: every phase */
  stopAt = 0;

  async judge(inp: JudgeInput): Promise<Fracture> {
    const g = inp.cols.gpu;
    if (!g) throw new Error('judge B (sections) needs the GPU columns (WorldGpu.layers, .chunks)');
    const t0 = performance.now();
    const p = inp.cols.packed;
    const { w: mapW, h: mapH } = p.dims;
    const seeds = [...inp.seeds];
    const empty: Fracture = { bodies: [], crumble: [], pieces: [], crumbleRuns: [], tips: [], why: { free: 0, load: 0, crush: 0, tip: 0, buckle: 0, bend: 0, crushed: 0, crumbs: 0, keyed: 0, weighed: 0 } };
    if (!seeds.length) return empty;
    // the window: the seeds' box and the margin round it
    const T = TUNE.judgeB;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of seeds) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const m = Math.round(T.margin);
    x0 = Math.max(0, x0 - m);
    y0 = Math.max(0, y0 - m);
    x1 = Math.min(mapW - 1, x1 + m);
    y1 = Math.min(mapH - 1, y1 + m);
    const ww = x1 - x0 + 1;
    const wh = y1 - y0 + 1;
    this.stats.window = [x0, y0, ww, wh];
    // the columns' marks: seeded (a seed or beside one), weighed (an edit cut it)
    const mask = new Uint32Array(ww * wh);
    const weighFn = typeof inp.weigh === 'function' ? inp.weigh : null;
    const weighAll = inp.weigh === undefined || inp.weigh === true;
    for (const [sx, sy] of seeds) {
      const cs: [number, number][] = [[sx, sy]];
      for (let k = 0; k < NDIR; k++) cs.push(nbr(sx, sy, k));
      for (const [x, y] of cs) if (x >= x0 && y >= y0 && x <= x1 && y <= y1) mask[(y - y0) * ww + (x - x0)] |= 1;
    }
    if (weighAll || weighFn) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (weighAll || weighFn!(x, y)) mask[(y - y0) * ww + (x - x0)] |= 2;
    const kit = this.kitFor(g.device);
    let ncap = ww * wh * Math.min(p.maxK, 3) + 1024;
    let pcap = ncap * 4;
    let outCap = O_REC0 + 65536;
    for (let attempt = 0; ; attempt++) {
      const s = this.size(kit, ncap, pcap, outCap, ww * wh);
      const r = await this.run(kit, s, g, inp, [x0, y0, ww, wh], mask);
      // (past its buffers: judged again in bigger ones — the verdict is never cut short)
      if (r.over) {
        if (attempt > 5) throw new Error(`judge B: the window ${ww}×${wh} still overflows (${r.over})`);
        if (r.over & 4) ncap = ww * wh * p.maxK + 1024;
        if (r.over & 2) outCap = O_REC0 + (outCap - O_REC0) * 4;
        if (r.over & 16) pcap = Math.max(pcap * 4, r.pairs + 1024);
        if (r.over & 8) throw new Error(`judge B: a piece more than ${MAX_LEVELS} runs from what holds it`);
        if (r.over & 1) throw new Error('judge B: more than 1024 pieces in one judging');
        continue;
      }
      this.stats.ms = performance.now() - t0;
      return r.fracture;
    }
  }

  private warming: Promise<void> | null = null;
  warm(device: GPUDevice): Promise<void> {
    if (this.kit?.device === device) return Promise.resolve();
    return (this.warming ??= (async () => {
      const layout = makeLayout(device, 'judge B', BINDS, GPUShaderStage.COMPUTE);
      const module = device.createShaderModule({ label: 'judge.wgsl', code: judgeWgsl });
      const pl = device.createPipelineLayout({ label: 'judge B', bindGroupLayouts: [layout] });
      const made = await Promise.all(KERNELS.map((k) => device.createComputePipelineAsync({ label: `judge B ${k}`, layout: pl, compute: { module, entryPoint: k } })));
      this.kitFor(device, layout, Object.fromEntries(KERNELS.map((k, i) => [k, made[i]])) as Record<Kernel, GPUComputePipeline>);
    })());
  }

  private kitFor(device: GPUDevice, madeLayout?: GPUBindGroupLayout, made?: Record<Kernel, GPUComputePipeline>): DeviceKit {
    if (this.kit?.device === device) return this.kit;
    const layout = madeLayout ?? makeLayout(device, 'judge B', BINDS, GPUShaderStage.COMPUTE);
    let pipes = made;
    if (!pipes) {
      const module = device.createShaderModule({ label: 'judge.wgsl', code: judgeWgsl });
      const pl = device.createPipelineLayout({ label: 'judge B', bindGroupLayouts: [layout] });
      pipes = Object.fromEntries(KERNELS.map((k) => [k, device.createComputePipeline({ label: `judge B ${k}`, layout: pl, compute: { module, entryPoint: k } })])) as Record<Kernel, GPUComputePipeline>;
    }
    const mats = device.createBuffer({ label: 'judge B materials', size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(mats, 0, materialTable());
    const ts = device.features.has('timestamp-query');
    this.kit = {
      device,
      layout,
      pipes,
      params: device.createBuffer({ label: 'judge B params', size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      mats,
      ind: device.createBuffer({ label: 'judge B pairs dispatch', size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT }),
      dummy: device.createBuffer({ label: 'judge B no dispatch', size: 16, usage: GPUBufferUsage.STORAGE }),
      query: ts ? device.createQuerySet({ type: 'timestamp', count: 2 * KERNELS.length }) : null,
      qres: ts ? device.createBuffer({ label: 'judge B times', size: 16 * KERNELS.length, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null,
      sized: null,
    };
    return this.kit;
  }

  private size(kit: DeviceKit, ncap: number, pcap: number, outCap: number, cols: number): Sized {
    const s = kit.sized;
    if (s && s.ncap >= ncap && s.pcap >= pcap && s.outCap >= outCap && s.cols >= cols) return s;
    if (s) for (const b of [s.work, s.nodes, s.out, s.read, s.mask]) b.destroy();
    const n = Math.max(ncap, s?.ncap ?? 0);
    const pc = Math.max(pcap, s?.pcap ?? 0);
    const o = Math.max(outCap, s?.outCap ?? 0);
    const c = Math.max(cols, s?.cols ?? 0);
    const dev = kit.device;
    const words = NFIELDS * n + NCOUNT + 3 * (MAX_LEVELS + 2) + NPF * pc;
    kit.sized = {
      ncap: n,
      pcap: pc,
      outCap: o,
      cols: c,
      work: dev.createBuffer({ label: 'judge B work', size: words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      nodes: dev.createBuffer({ label: 'judge B nodes', size: (NN * n + 2 * c) * 4, usage: GPUBufferUsage.STORAGE }),
      out: dev.createBuffer({ label: 'judge B out', size: o * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
      read: dev.createBuffer({ label: 'judge B verdict', size: o * 4 + 16 * KERNELS.length, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      mask: dev.createBuffer({ label: 'judge B marks', size: c * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    };
    return kit.sized;
  }

  private async run(kit: DeviceKit, s: Sized, g: NonNullable<JudgeColumns['gpu']>, inp: JudgeInput, win: [number, number, number, number], mask: Uint32Array): Promise<{ over: number; pairs: number; fracture: Fracture }> {
    const dev = kit.device;
    const p = inp.cols.packed;
    const T = TUNE.judgeB;
    const [ox, oy, ww, wh] = win;
    const pairs = this.mode === 'pairs';
    // stresses in the weight of a metre of rock a square metre (a cell a metre, rock of density 1 weighing T.density)
    const unit = 1e6 / (T.density * WORLD_G);
    const pb = new ArrayBuffer(PARAM_BYTES);
    const u = new Uint32Array(pb);
    const f = new Float32Array(pb);
    u.set([ox, oy, ww, wh, p.dims.w, p.dims.h, p.chunksX, 16, s.ncap, p.maxK, s.outCap, inp.rotate ? 1 : 0]);
    f[12] = T.tensile * unit;
    f[13] = T.shear * unit;
    f[14] = T.crush * unit;
    f[15] = T.tipGive;
    f[16] = T.meet;
    f[17] = T.archTol;
    u[18] = Math.round(T.neck);
    f[19] = 8; // fracture.ts MIN_BODY
    f[20] = 0.5; // fracture.ts OVERLAP
    f[21] = 0.02; // fracture.ts FILM_GAP
    u[22] = MAX_LEVELS;
    u[23] = this.stopAt;
    u[24] = s.pcap;
    u[25] = pairs ? 1 : 0;
    u[26] = this.cull ? 0 : 1;
    dev.queue.writeBuffer(kit.params, 0, pb);
    dev.queue.writeBuffer(s.mask, 0, mask);
    const res = { 0: kit.params, 1: g.chunks, 2: g.slots, 3: kit.mats, 4: s.mask, 5: s.work, 6: s.out, 7: s.nodes };
    const bg1 = makeBindGroup(dev, 'judge B (judge1)', kit.layout, { ...res, 8: kit.ind });
    const bg = makeBindGroup(dev, 'judge B', kit.layout, { ...res, 8: kit.dummy });
    const enc = dev.createCommandEncoder({ label: 'judge B' });
    enc.clearBuffer(s.work);
    enc.clearBuffer(s.out, 0, O_REC0 * 4);
    // a pass a kernel, each timed (the frame's GPU budget is what matters on the phone: every kernel's share shown)
    const ran: Kernel[] = KERNELS.filter((k) => pairs || !PAIR_KERNELS.has(k));
    ran.forEach((k, i) => {
      const pass = enc.beginComputePass({ label: `judge B ${k}`, timestampWrites: kit.query ? { querySet: kit.query, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } : undefined });
      pass.setBindGroup(0, k === 'judge1' ? bg1 : bg);
      pass.setPipeline(kit.pipes[k]);
      if (k === 'build') pass.dispatchWorkgroups(Math.ceil((ww * wh) / 64));
      else if (k === 'adjacency' || k === 'faces' || k === 'pieces' || k === 'pieceFlags' || k === 'freedUnite') pass.dispatchWorkgroups(Math.ceil(s.ncap / 64));
      else if (k === 'judge1' || k === 'judge2' || k === 'judge3' || k === 'judge4') pass.dispatchWorkgroups(1);
      else if (k === 'checks') pass.dispatchWorkgroupsIndirect(kit.ind, 16);
      else pass.dispatchWorkgroupsIndirect(kit.ind, 0);
      pass.end();
    });
    if (kit.query && kit.qres) enc.resolveQuerySet(kit.query, 0, 2 * ran.length, kit.qres, 0);
    enc.copyBufferToBuffer(s.out, 0, s.read, 0, s.outCap * 4);
    if (kit.qres) enc.copyBufferToBuffer(kit.qres, 0, s.read, s.outCap * 4, 16 * ran.length);
    dev.queue.submit([enc.finish()]);
    await s.read.mapAsync(GPUMapMode.READ);
    const all = s.read.getMappedRange();
    const O = new Uint32Array(all.slice(0, s.outCap * 4));
    if (kit.qres) {
      const t = new BigUint64Array(all.slice(s.outCap * 4, s.outCap * 4 + 16 * ran.length));
      const kernels: Record<string, number> = {};
      ran.forEach((k, i) => (kernels[k] = Number(t[2 * i + 1] - t[2 * i]) / 1e6));
      this.stats.kernels = kernels;
      this.stats.gpuMs = Number(t[2 * ran.length - 1] - t[0]) / 1e6;
    }
    s.read.unmap();
    const over = (O[2] & 3) | (O[3] === 1 ? 4 : 0) | (O[3] === 2 ? 8 : 0) | (O[3] === 3 ? 16 : 0);
    if (over) return { over, pairs: O[O_STATS + 3], fracture: null as unknown as Fracture };
    const recW = O[0];
    this.stats.readBytes = (O_REC0 + recW) * 4;
    this.stats.sections = O[14];
    this.stats.hanging = O[O_STATS];
    this.stats.judged = O[O_STATS + 1];
    this.stats.deepest = O[O_STATS + 2];
    this.stats.pairs = O[O_STATS + 3];
    this.stats.judgedBox = O[O_STATS + 1] ? [O[O_STATS + 4], O[O_STATS + 5], O[O_STATS + 6], O[O_STATS + 7]] : undefined;
    return { over: 0, pairs: 0, fracture: this.verdict(O, recW) };
  }

  /** the GPU's verdict as a Fracture: its pieces (runs, clipped), what crumbles, the hinges, why */
  private verdict(O: Uint32Array, recW: number): Fracture {
    const F = new Float32Array(O.buffer, O.byteOffset, O.length);
    const nPieces = O[1];
    const pieces: RunPiece[] = Array.from({ length: nPieces }, () => []);
    const crumble: RunPiece = [];
    for (let at = O_REC0; at < O_REC0 + recW; ) {
      const x = O[at];
      const y = O[at + 1];
      const piece = O[at + 2];
      const z0 = F[at + 3];
      const z1 = F[at + 4];
      const n = O[at + 5];
      const ivs: { z0: number; z1: number; mat: number }[] = [];
      for (let s = 0; s < n; s++) {
        const b = at + 6 + 4 * s;
        const a0 = Math.max(F[b], z0);
        const a1 = Math.min(F[b + 1], z1);
        if (a1 > a0 + 1e-3) ivs.push({ z0: a0, z1: a1, mat: O[b + 2] & 0xff });
      }
      at += 6 + 4 * n;
      if (!ivs.length) continue;
      if (piece === NONE) crumble.push({ x, y, ivs });
      else pieces[piece].push({ x, y, ivs });
    }
    const out: Fracture = { bodies: [], crumble: [], pieces: [], crumbleRuns: crumble, tips: [], why: { free: 0, load: 0, crush: 0, tip: 0, buckle: 0, bend: 0, crushed: 0, crumbs: 0, keyed: 0, weighed: 0 } };
    let arch = 0;
    pieces.forEach((pc, i) => {
      if (!pc.length) return;
      const b = O_PIECE0 + i * PIECE_W;
      const kind = KIND[O[b]] ?? 'free';
      if (kind === 'arch' || kind === 'arch crush') arch++;
      if (O[b + 1]) out.tips!.push({ piece: out.pieces!.length, pivot: [F[b + 2], F[b + 3], F[b + 4]], axis: [F[b + 5], F[b + 6], 0] });
      out.pieces!.push(pc);
    });
    const why = out.why!;
    why.free = O[4];
    why.load = O[5] + O[6] + O[7];
    why.crush = O[8];
    why.tip = O[9];
    why.bend = O[10];
    why.weighed = O[11];
    why.keyed = O[12];
    why.crumbs = O[13] / 1000;
    for (const c of crumble) for (const iv of c.ivs) why.crushed += iv.z1 - iv.z0;
    this.stats.arch = arch;
    return out;
  }

  destroy(): void {
    const k = this.kit;
    if (!k) return;
    for (const b of [k.params, k.mats, k.ind, k.dummy, k.qres, k.sized?.work, k.sized?.nodes, k.sized?.out, k.sized?.read, k.sized?.mask]) b?.destroy();
    k.query?.destroy();
    this.kit = null;
  }
}
