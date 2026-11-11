// Liquids as runs in the columns (?flow=1, docs/ARCHITECTURE.md "The flow model"; liquid.wgsl). One system, one kernel set; a liquid is
// a few numbers (LiquidKind). Water replaces the water system: its open runs ARE the water contract (`water`,
// `waterPrev`, `flux`), so every reader of water is unchanged; runs under rock (caves, tunnels) and the falling
// streams are the system's own. Lava here is the same kernels with lava's numbers (the sandbox's beam and
// volcanoes keep sim/lava.ts).

import { makeBindGroup, makeCompute, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { Profiler } from '../gpu/profiler';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import liquidWgsl from '../shaders/liquid.wgsl?raw';
import { dispatch, type SimSystem } from '../sim/system';
import type { WorldGpu } from '../sim/world-gpu';
import { FLOW_SUB, flowConst } from '../sim/flow';
import { cullSource, GpuTileList, TILES_BINDING } from '../sim/cull';
import { CHUNK } from '../world/layout';
import { urlFlags } from '../flags';
import { riverHeld } from '../sim/systems';

/** A liquid's numbers: what makes water water and lava lava. */
export interface LiquidKind {
  name: 'water' | 'lava';
  /** material id drawn (render.wgsl) */
  mat: number;
  /**
   * (round 108, AR5) its flow numbers: a field of the Globals' Tune struct (the tuning registry, src/tune/params.ts
   * group `flow` — live from the panel), or a fixed number. gain: how fast a level difference moves it sideways;
   * friction: the flux kept from last tick; yieldZ: it won't move down a step smaller than this (cells); thick:
   * thinner than this it barely flows, as (depth / thick)^2 (0: off)
   */
  gain: Tuned;
  friction: Tuned;
  yieldZ: Tuned;
  thick: Tuned;
  /** heat: fresh (springs), where it stops flowing and sets, where it runs freely (0: no heat) */
  hot: number;
  set: number;
  runny: number;
  /** a drop past this under the run's floor is a fall (a stream) */
  drop: Tuned;
  /** cooling: e-folds a second for a cell of depth (thinner cools faster; 0: none) */
  cool: Tuned;
}

/** a Tune struct field (common.wgsl, `G.tune.<field>`) or a fixed number */
export type Tuned = { tune: string } | number;

export const WATER: LiquidKind = { name: 'water', mat: 8, gain: { tune: 'flowWaterGain' }, friction: { tune: 'flowWaterFriction' }, yieldZ: 0, thick: 0, hot: 0, set: 0, runny: 1, drop: { tune: 'flowWaterDrop' }, cool: 0 };
export const LAVA: LiquidKind = { name: 'lava', mat: 24, gain: { tune: 'flowLavaGain' }, friction: { tune: 'flowLavaFriction' }, yieldZ: { tune: 'flowLavaYield' }, thick: { tune: 'flowLavaThick' }, hot: 1250, set: 750, runny: 1150, drop: { tune: 'flowLavaDrop' }, cool: { tune: 'flowLavaCool' } };

export const MAX_SPRINGS = 8;
/** ticks between the idle scans (encode) */
const SCAN_IDLE = 15;
/** ticks between the idle preps (encode) */
const PREP_IDLE = 4;
/** (trackA-liquids) ?lqall=1: every chunk on the run list every step (a check against the lists: the same water) */
const LQ_ALL = typeof location !== 'undefined' && urlFlags().get('lqall') === '1';
export interface Spring {
  x: number;
  y: number;
  /** the height it pours in at (cells): in a tunnel, its floor */
  z: number;
  /** cells^3 a second */
  rate: number;
}

/** a run's prism (30) or a stream's sheet (render.wgsl streamVertex: 2 ribbons x 3 segments x 6) */
const VERTS_PER_PRISM = 36;

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const t = (v: Tuned) => (typeof v === 'number' ? f(v) : `G.tune.${v.tune}`);
function prelude(k: LiquidKind, runW: number): string {
  return [
    `const LQ_RUN_W: u32 = ${runW}u;`,
    `const LQ_MAT: u32 = ${k.mat}u;`,
    `const LQ_WATER: bool = ${k.name === 'water'};`,
    `fn lqGain() -> f32 { return ${t(k.gain)}; }`,
    `fn lqFric() -> f32 { return ${t(k.friction)}; }`,
    `fn lqYield() -> f32 { return ${t(k.yieldZ)}; }`,
    `fn lqThick() -> f32 { return ${t(k.thick)}; }`,
    `const LQ_HOT: f32 = ${f(k.hot)};`,
    `const LQ_SET: f32 = ${f(k.set)};`,
    `const LQ_RUNNY: f32 = ${f(k.runny)};`,
    `fn lqDrop() -> f32 { return ${t(k.drop)}; }`,
    `fn lqCool() -> f32 { return ${t(k.cool)}; }`,
    '',
  ].join('\n');
}

export class LiquidSystem implements SimSystem {
  readonly name: string;
  readonly period = 1;
  readonly springs: Spring[] = [];
  /** the water pipeline's list (runs under rock, streams) and the opaque one's (open lava) */
  readonly inst: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly instO: GPUBuffer;
  readonly indirectO: GPUBuffer;
  /** the open runs' depth (water: world.water) */
  readonly open: GPUBuffer;
  /** the step the records carry (it stands still while idle) */
  step = 1;
  /** nothing awake or settling (install.ts: the sleep mask's counts — the CPU's own, no readback) */
  idle: () => boolean = () => false;
  private idleTicks = 0;
  /** passes dispatched at the last encode (the cost report) */
  ran = 0;
  /** (one a substep: ?simhz=30|15 runs FLOW_SUB 60 Hz steps a tick, sim/flow.ts) */
  private unis: GPUBuffer[];
  private runs: GPUBuffer[];
  private uniData = new ArrayBuffer(16 + 16 * MAX_SPRINGS + 16 * 512 + 16);
  /** the ticks the next prep's spray stands for (LiquidU.extra.x) */
  private prepTicks = 1;
  /** frozen chunks' flux rescaled next step (chunk -> factor; steady.ts: their supply changed) */
  readonly rescale = new Map<number, number>();
  private k: Record<string, ComputeKernel> = {};
  /** (trackA-liquids, DA-P5) the chunks that run this step and the chunks with liquid (liquid.wgsl lqScan / lqList) */
  private runList: GpuTileList;
  private wetList: GpuTileList;
  private lqState: GPUBuffer;
  private lqWet: GPUBuffer;
  private gaps: GPUBuffer | null = null;
  private lqRun: GPUTexture;
  private emptyArgs: GPUBuffer;
  private nChunks: number;
  private runW: number;
  /** per substep, per parity */
  private g: Record<string, GPUBindGroup[][]> = {};

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    private prof: Profiler,
    readonly kind: LiquidKind,
    act: GPUBuffer,
    /** the frozen column's wake tolerance: |in - out| (cells^3 a tick) */
    wakeTol: number,
  ) {
    this.name = `liquid-${kind.name}`;
    const N = world.cells;
    const S = GPUBufferUsage.STORAGE;
    this.open = kind.name === 'water' ? world.water : world.buf(`${kind.name}Open`, N * 4, S | GPUBufferUsage.COPY_DST);
    const runs = [0, 1].map((p) => world.buf(`${kind.name}Runs${p}`, N * 4 * 16, S | GPUBufferUsage.COPY_SRC));
    this.runs = runs;
    const fl = world.buf(`${kind.name}Flux`, N * 4 * 2 * 16, S);
    const emit = world.buf(`${kind.name}Emit`, N * 4, S);
    // (room for N instances, then two more vec4 an instance for the streams: liquid.wgsl prep)
    this.inst = world.buf(`${kind.name}RunInst`, N * 16 * 3, S | GPUBufferUsage.COPY_SRC);
    this.indirect = world.buf(`${kind.name}RunIndirect`, 16, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.instO = world.buf(`${kind.name}OpenInst`, kind.name === 'water' ? 48 : N * 16 * 3, S);
    this.indirectO = world.buf(`${kind.name}OpenIndirect`, 16, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.unis = Array.from({ length: FLOW_SUB }, (_, s) => world.buf(`${kind.name}U${s}`, this.uniData.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST));
    new Uint32Array(this.uniData, 0, 4)[2] = new Uint32Array(new Float32Array([wakeTol]).buffer)[0];
    // (trackA-liquids, DA-P5) the run lists: only chunks with liquid in or next to them run, sleeping ones are parked
    if (!world.tiles) throw new Error('the flow model runs over chunk lists: ?simcull=0 is not supported with it');
    const tiles = world.tiles;
    this.nChunks = (world.w / CHUNK) * (world.h / CHUNK);
    this.runW = Math.ceil(this.nChunks / 16) * 16;
    this.runList = new GpuTileList(device, `${kind.name} run`, tiles);
    this.wetList = new GpuTileList(device, `${kind.name} wet`, tiles);
    // (LQ4) the water on every surface: the water's runs published per gap (liquid.wgsl publishGaps)
    if (kind.name === 'water') this.gaps = world.waterGaps;
    this.lqWet = world.buf(`${kind.name}LqWet`, this.runW * 8, S | GPUBufferUsage.COPY_DST);
    this.lqState = world.buf(`${kind.name}LqState`, this.runW * 16, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    this.lqRun = device.createTexture({ label: `${kind.name}LqRun`, size: { width: this.runW, height: 1 }, format: 'rgba32uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const never = new Uint32Array(this.runW * 4);
    for (let c = 0; c < this.runW; c++) never.set([0xffffffff, 0xffffffff, 0, 0], c * 4);
    device.queue.writeBuffer(this.lqState, 0, never);
    device.queue.writeTexture({ texture: this.lqRun }, never, { bytesPerRow: this.runW * 16 }, { width: this.runW, height: 1 });
    this.emptyArgs = world.buf(`${kind.name}LqEmpty`, 12, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(this.emptyArgs, 0, new Uint32Array([0, 1, 1]));
    const lqRunView = this.lqRun.createView();
    const size = { width: world.w, height: world.h };
    const tex = () => device.createTexture({ label: `${kind.name}Jet`, size, format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    const jets = [0, 1].map(() => [tex(), tex(), tex(), tex()].map((t) => t.createView()));

    const parts = [commonWgsl, layersWgsl, materialsWgsl, prelude(kind, this.runW) + flowConst(kind.name) + liquidWgsl + riverHeld()];
    const base: BindSpec = { 0: 'uniform', 1: 'read', 2: 'uniform', 21: 'tex', 33: 'uniform', 35: 'utex', [TILES_BINDING]: 'uniform' };
    const specs: Record<string, BindSpec> = {
      flux: { 3: 'rw', 5: 'rw', 6: 'read', 8: 'rw', 9: 'rw', 10: 'read', 62: 'tex', 63: 'tex' },
      jets: { 3: 'rw', 5: 'rw', 6: 'read', 8: 'rw', 9: 'rw', 11: 'rw', 22: 'tex', 23: 'tex', 24: 'tex', 28: 'tex', 25: 'stex', 26: 'stex', 27: 'stex', 34: 'stex' },
      depth: { 3: 'rw', 4: 'read', 5: 'rw', 6: 'read', 7: 'rw', 8: 'rw', 11: 'rw', 17: 'tex', 22: 'tex', 23: 'tex', 24: 'tex', 28: 'tex', 62: 'tex', 63: 'tex' },
      publishWater: { 4: 'read', 5: 'rw', 7: 'rw', 8: 'rw', 14: 'rw', 16: 'read', 19: 'rw' },
      publishLava: { 3: 'rw', 5: 'rw', 7: 'rw', 11: 'rw', 12: 'rw', 13: 'rw', 20: 'rw' },
      prep: { 5: 'rw', 6: 'read', 12: 'rw', 13: 'rw', 22: 'tex', 23: 'tex', 24: 'tex', 28: 'tex', 29: 'rw', 30: 'rw', 31: 'rw', 32: 'rw' },
      publishGaps: { 5: 'rw', 7: 'rw', 45: 'rw' },
      lqScan: { 1: 'read', 3: 'rw', 5: 'rw', 6: 'read', 11: 'rw', 16: 'read', 22: 'tex', 24: 'tex', 36: 'rw', 37: 'rw' },
      lqList: { 36: 'rw', 37: 'rw', 40: 'rw', 41: 'rw', 42: 'rw', 43: 'rw' },
    };
    const entries = ['flux', 'jets', 'depth', kind.name === 'water' ? 'publishWater' : 'publishLava', 'prep', 'lqScan', 'lqList', ...(kind.name === 'water' ? ['publishGaps'] : [])];
    /** the passes dispatched over a chunk list (cullSource's wrapper); lqScan and lqList over every chunk */
    const listed = (e: string) => e !== 'lqScan' && e !== 'lqList';
    for (const e of entries) {
      // (the prep doesn't read the layers' chunk table: one storage slot fewer. Round 128o, DA-B26: the water's publish
      // does, for the water's versions — bumpWater; its eighth storage buffer)
      const spec: BindSpec = { ...base, ...specs[e] };
      if (e === 'prep' || e === 'lqList') delete spec[1];
      if (!listed(e)) {
        delete spec[TILES_BINDING];
        // (lqScan reads a column's gaps where a solid may have come over its water: the materials, the bodies)
        if (e === 'lqList') {
          delete spec[21];
          delete spec[2];
          delete spec[35];
        }
      }
      const k = makeCompute(device, `${this.name}-${e}`, listed(e) ? [cullSource(parts.join(String.fromCharCode(10)), e, tiles.vec4s)] : parts, spec, e);
      this.k[e] = k;
      // per substep (its uniforms), per parity: runs/jets in and out
      this.g[e] = this.unis.map((uni) => [0, 1].map((par) => {
        const res: Record<number, GPUBuffer | GPUTextureView> = {
          0: world.globals,
          1: world.chunks,
          2: world.materials,
          3: world.layers,
          4: world.surface,
          5: this.open,
          6: e === 'prep' ? runs[1 - par] : runs[par],
          7: runs[1 - par],
          8: fl,
          9: emit,
          10: world.oil,
          11: act,
          12: world.particles,
          13: world.particleCounters,
          14: world.waterPrev,
          16: world.waterSource,
          17: world.driftView,
          19: world.flux,
          20: world.water,
          21: world.bodyProjView,
          // (jets and lqScan read last step's, jets writes this one's; depth and prep read this one's)
          22: e === 'jets' || e === 'lqScan' ? jets[par][0] : jets[1 - par][0],
          23: e === 'jets' ? jets[par][1] : jets[1 - par][1],
          24: e === 'jets' || e === 'lqScan' ? jets[par][2] : jets[1 - par][2],
          25: jets[1 - par][0],
          26: jets[1 - par][1],
          27: jets[1 - par][2],
          28: e === 'jets' ? jets[par][3] : jets[1 - par][3],
          34: jets[1 - par][3],
          29: this.inst,
          30: this.indirect,
          31: this.instO,
          32: this.indirectO,
          33: uni,
          35: lqRunView,
          62: world.riverWetView,
          63: world.riverFlowView,
          36: this.lqWet,
          45: this.gaps ?? this.lqWet,
          37: this.lqState,
          [TILES_BINDING]: e === 'prep' ? this.wetList.uniform : this.runList.uniform,
          40: this.runList.list,
          41: this.runList.args,
          42: this.wetList.list,
          43: this.wetList.args,
        };
        return makeBindGroup(device, `${this.name}-${e}-${par}`, k.layout, Object.fromEntries(Object.keys(spec).map((n) => [n, res[Number(n)]])));
      }));
    }
  }

  /**
   * (trackA-liquids) Window rectangle [lx, lx + w) x [ly, ly + h) was just written with arriving land (the streamer's
   * onWritten): its chunks' slots hold another place's records now — forgotten (never ran: every record of theirs
   * invalid; the open depth is the land's own, written with it). A few words a chunk, once a region.
   */
  forget(lx: number, ly: number, w: number, h: number): void {
    const cx = this.world.w / CHUNK;
    const never = new Uint32Array([0xffffffff, 0xffffffff, 0, 0]);
    for (let y = Math.max(0, Math.floor(ly / CHUNK)); y < Math.min(this.world.h / CHUNK, Math.ceil((ly + h) / CHUNK)); y++)
      for (let x = Math.max(0, Math.floor(lx / CHUNK)); x < Math.min(cx, Math.ceil((lx + w) / CHUNK)); x++)
      {
        const slot = this.world.ring.table[y * cx + x];
        this.device.queue.writeBuffer(this.lqState, slot * 16, never);
        this.device.queue.writeBuffer(this.lqWet, slot * 8, never, 2, 2);
      }
  }

  /** Pour `rate` cells^3/s in at world (x, y), height z (a tunnel's floor, a crater); the oldest goes past MAX_SPRINGS. */
  addSpring(x: number, y: number, z: number, rate: number): void {
    if (this.springs.length >= MAX_SPRINGS) this.springs.shift();
    this.springs.push({ x, y, z, rate });
  }

  /**
   * (scripts) The runs as they stand: the enclosed runs' count and volume over the map, the instances drawn
   * (runs under rock + stream segments), and column (x, y)'s runs (floor, depth, heat; slot 0 the open run's floor).
   */
  async probe(x = -1, y = -1): Promise<{ enclosed: number; enclosedVol: number; drawn: number; col?: number[][]; at: [number, number][] }> {
    const dev = this.device;
    const src = this.runs[1 - (this.step & 1)];
    const a = dev.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const b = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const st = dev.createBuffer({ size: this.lqState.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, a, 0, src.size);
    enc.copyBufferToBuffer(this.indirect, 0, b, 0, 16);
    enc.copyBufferToBuffer(this.lqState, 0, st, 0, this.lqState.size);
    dev.queue.submit([enc.finish()]);
    await Promise.all([a.mapAsync(GPUMapMode.READ), b.mapAsync(GPUMapMode.READ), st.mapAsync(GPUMapMode.READ)]);
    const r = new Float32Array(a.getMappedRange());
    const drawn = new Uint32Array(b.getMappedRange())[1];
    const L = new Uint32Array(st.getMappedRange());
    let enclosed = 0;
    let enclosedVol = 0;
    /** (window columns) where some enclosed runs lie, the first 16 */
    const at: [number, number][] = [];
    // (a record is valid by its chunk's stamps — liquid.wgsl parkedOk: the last step the chunk ran, or the one before)
    const per = CHUNK * CHUNK;
    for (let i = 0; i < this.world.cells; i++) {
      const w = r[i * 16 + 3];
      const l = L[Math.floor(i / per) * 4];
      if (l === 0xffffffff || (w >>> 3 !== l && w >>> 3 !== ((l - 1) & 0x3ffff))) continue;
      for (let s = 1; s <= (w & 7); s++) {
        enclosed++;
        enclosedVol += r[i * 16 + s * 4 + 1];
        if (at.length < 16 && r[i * 16 + s * 4 + 1] > 0.05) at.push(this.world.ring.xy(i));
      }
    }
    let col: number[][] | undefined;
    if (x >= 0) {
      const i = this.world.ring.idx(x, y);
      col = [0, 1, 2, 3].map((s) => [...r.slice(i * 16 + s * 4, i * 16 + s * 4 + 4)]);
    }
    a.destroy();
    b.destroy();
    st.destroy();
    return { enclosed, enclosedVol, drawn, col, at };
  }

  /** substep `sub`'s uniforms: its step, the springs, and (the first substep only) the frozen chunks' rescale */
  /**
   * (scripts) The streams drawn this frame (liquid.wgsl prep's list): per stream its column, where it enters (x, y, z),
   * vz, velocity xy, the front (s along its path drawn), its time since the lip, the volume a second.
   */
  async probeStreams(): Promise<{ col: [number, number]; e: number[]; vz: number; u: number[]; tEnd: number; lip: number; rate: number }[]> {
    const dev = this.device;
    const a = dev.createBuffer({ size: this.inst.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const b = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.inst, 0, a, 0, this.inst.size);
    enc.copyBufferToBuffer(this.indirect, 0, b, 0, 16);
    dev.queue.submit([enc.finish()]);
    await Promise.all([a.mapAsync(GPUMapMode.READ), b.mapAsync(GPUMapMode.READ)]);
    const u = new Uint32Array(a.getMappedRange());
    const f = new Float32Array(u.buffer);
    const cap = u.length / 4 / 3;
    const n = Math.min(new Uint32Array(b.getMappedRange())[1], cap);
    const out = [];
    for (let k = 0; k < n; k++) {
      const w = u[k * 4 + 3];
      if (((w >> 8) & 0xfff & (2048 | 128)) !== (2048 | 128)) continue;
      const d = (cap + 2 * k) * 4;
      out.push({ col: [u[k * 4] & 0xfff, (u[k * 4] >> 12) & 0xfff] as [number, number], e: [f[d], f[d + 1], f[k * 4 + 1]], vz: f[k * 4 + 2], u: [f[d + 2], f[d + 3]], tEnd: f[d + 4], lip: f[d + 5], rate: f[d + 6] });
    }
    a.destroy();
    b.destroy();
    return out;
  }

  private writeUniforms(sub: number): void {
    const u = new Uint32Array(this.uniData, 0, 4);
    u[0] = this.step;
    u[1] = this.springs.length;
    u[3] = LQ_ALL ? 1 : 0;
    const fv = new Float32Array(this.uniData, 16);
    this.springs.forEach((s, i) => fv.set([s.x, s.y, s.z, s.rate], i * 4));
    new Float32Array(this.uniData, 16 + 16 * MAX_SPRINGS + 16 * 512, 4)[0] = this.prepTicks;
    const sc = new Float32Array(this.uniData, 16 + 16 * MAX_SPRINGS, 4 * 512);
    sc.fill(1);
    if (sub === 0) for (const [k, r] of this.rescale) if (k < sc.length) sc[k] = r;
    this.device.queue.writeBuffer(this.unis[sub], 0, this.uniData);
  }

  encode(enc: GPUCommandEncoder): void {
    this.ran = 0;
    // (?simhz=30|15: FLOW_SUB 60 Hz steps a tick, each its own uniforms - the streams' time across a column is
    // the 60 Hz step's, so a fall takes as long at any tick rate)
    // (trackA-liquids: nothing awake or settling — the sleep mask, the CPU's own — and nothing to rescale: no step. Only
    // the scan every SCAN_IDLE ticks, for a solid come over sleeping water (a deck claimed: it wakes it through steady,
    // which reads every STEADY_WIN ticks anyway). Otherwise every step; the GPU's lists say what runs.)
    // (idle, the draw lists are kept as they were and made again every PREP_IDLE ticks only — the spray off the frozen
    // falls goes on, PREP_IDLE ticks' worth at a time: LiquidU.extra)
    if (this.idle() && this.rescale.size === 0) {
      const t = ++this.idleTicks;
      if (t % SCAN_IDLE === 0 || t % PREP_IDLE === 0) {
        this.prepTicks = PREP_IDLE;
        this.writeUniforms(0);
      }
      if (t % SCAN_IDLE === 0) {
        dispatch(enc, this.prof, `${this.name}-lqScan`, this.k.lqScan, this.g.lqScan[0][this.step & 1], [this.nChunks, 1]);
        this.ran++;
      }
      if (t % PREP_IDLE === 0) {
        this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([VERTS_PER_PRISM, 0, 0, 0]));
        this.device.queue.writeBuffer(this.indirectO, 0, new Uint32Array([30, 0, 0, 0]));
        this.listed(enc, 'prep', this.g.prep[0][this.step & 1], this.wetList);
        this.ran++;
      }
      return;
    }
    this.idleTicks = 0;
    this.prepTicks = 1;
    const subs = FLOW_SUB;
    let sub = 0;
    for (; sub < subs; sub++) {
      this.step++;
      this.writeUniforms(sub);
      const par = this.step & 1;
      // (trackA-liquids, DA-P5) which chunks run this step, on the GPU: lqScan marks those with liquid, lqList lists
      // the ones to run and those to draw and stamps them; the lists into the culled passes' uniforms
      this.runList.reset(enc, this.emptyArgs);
      this.wetList.reset(enc, this.emptyArgs);
      dispatch(enc, this.prof, `${this.name}-lqScan`, this.k.lqScan, this.g.lqScan[sub][par], [this.nChunks, 1]);
      dispatch(enc, this.prof, `${this.name}-lqList`, this.k.lqList, this.g.lqList[sub][par], [Math.ceil(this.nChunks / 64), 1]);
      enc.copyBufferToTexture({ buffer: this.lqState, bytesPerRow: this.runW * 16 }, { texture: this.lqRun }, { width: this.runW, height: 1 });
      this.runList.publish(enc);
      this.wetList.publish(enc);
      for (const e of ['flux', 'jets', 'depth', ...(this.kind.name === 'water' ? ['publishWater', 'publishGaps'] : ['publishLava'])]) this.listed(enc, e, this.g[e][sub][par], this.runList);
      this.ran += 6;
    }
    this.rescale.clear();
    const last = Math.min(sub, subs - 1);
    this.device.queue.writeBuffer(this.indirect, 0, new Uint32Array([VERTS_PER_PRISM, 0, 0, 0]));
    this.device.queue.writeBuffer(this.indirectO, 0, new Uint32Array([30, 0, 0, 0]));
    // (the draw lists over the chunks with liquid — the last step's list)
    this.listed(enc, 'prep', this.g.prep[last][this.step & 1], this.wetList);
    this.ran++;
  }

  /** a culled pass over a list made on the GPU (indirect: the CPU never knows its count) */
  private listed(enc: GPUCommandEncoder, e: string, group: GPUBindGroup, list: GpuTileList): void {
    const name = `${this.name}-${e}`;
    const pass = enc.beginComputePass({ label: name, timestampWrites: this.prof.timestamps(name) });
    pass.setPipeline(this.k[e].pipeline);
    pass.setBindGroup(0, group);
    list.dispatch(pass);
    pass.end();
    this.prof.dispatches++;
  }
}
