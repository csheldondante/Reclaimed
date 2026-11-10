// The fortress's reach on the GPU (round 128l, m4; shaders/fortreach.wgsl): which planned blocks the stores reach, as
// connected components of the walkable surfaces over the fortress's box, the plan's solid as if built merged into the
// columns. Replaces the CPU flood over the window's columns read back (fortress/reach.ts, ~140-210 ms a tap, and the
// whole 'layers' + 'water' read back every 3 s while building: FT-61, TL-6).
//
// A check: the plan's spans (written where they changed), the stores' column and the queries (each block's stands)
// written, then a solve: one submit peels the box, labels every surface, hooks and jumps ROUND times, writes the answers
// and copies them and the "something moved in the last iteration" flag out. Read back asynchronously — bytes: a word a
// query, the ramp spots (and, asked for, a bit a box column for the water). Converged when the flag is clear; else
// another ROUND (no peel, no relabel). Asked why (an edit to judge) and some query not reached: the same solve with the
// deep water lifted, then with the plan's solid left out. Nothing waits on it: the fortress gets the answer a few frames
// later.
import { makeBindGroup, makeCompute, whenPipelinesReady, type BindSpec, type ComputeKernel } from '../gpu/pipeline';
import type { WorldGpu } from '../sim/world-gpu';
import commonWgsl from '../shaders/common.wgsl?raw';
import layersWgsl from '../shaders/layers.wgsl?raw';
import materialsWgsl from '../shaders/materials.wgsl?raw';
import reachWgsl from '../shaders/fortreach.wgsl?raw';
import { FIX_CAP, RAMP_CAP, REACH_BITS, type ReachAsk, type ReachEngine, type ReachFix, type ReachReply } from './reach';

/** fortreach.wgsl's */
const NAV_K = 4;
/** hook-and-jump iterations a submit (the flag cleared before the last: clear, converged) */
const ROUND = 12;
/** submits a solve before giving up — past it the labels never settled: a bug, loud */
const MAX_ROUNDS = 40;
/** the solves: the rules as they are; deep water no bar; the plan's solid left out (fortreach.wgsl RP.mode) */
const MODES: { lift: number; bit: number }[] = [
  { lift: 0, bit: 0 },
  { lift: 1, bit: Math.log2(REACH_BITS.dry) },
  { lift: 2, bit: Math.log2(REACH_BITS.unplanned) },
  // (round 128o, B) the fix peel: the plan's cuttable solid left out
  { lift: 4, bit: 0 },
];
const FIX_MODE = 3;
/** (B) fix field sweeps a submit (the flag cleared before the last: clear, converged) */
const FIX_ROUND = 48;

type K = 'peel' | 'init' | 'hook' | 'jump' | 'query' | 'ramps' | 'wet' | 'fixInit' | 'fixRelax' | 'fixTrace' | 'mark';

export class FortressReachGpu implements ReachEngine {
  private k: Record<K, ComputeKernel>;
  private spans: GPUBuffer;
  private surf: GPUBuffer;
  private deep: GPUBuffer;
  private label: GPUBuffer;
  private flag: GPUBuffer;
  /** (B) per box column whether its plan solid may be cut; per surface the fix field; the fixes found */
  private cutCol: GPUBuffer;
  private fixDist: GPUBuffer;
  private fixBuf: GPUBuffer;
  private fixStage: GPUBuffer;
  /** (DA-A10) per box column the highest drop a ramp on it joins */
  private rampRiseBuf: GPUBuffer;
  private riseWritten: Float32Array;
  /** a params buffer a solve's mode */
  private params: GPUBuffer[];
  private queryBuf: GPUBuffer | null = null;
  private answerBuf: GPUBuffer | null = null;
  private stage: GPUBuffer | null = null;
  private cap = 0;
  /** per mode, per kernel its bind group */
  private groups: Record<K, GPUBindGroup>[] = [];
  /** the spans as last written (written again only where they differ) */
  private written: Uint32Array;
  private ready: Promise<void>;
  private gone = false;
  readonly stats = { checks: 0, rounds: 0, solves: 0, lastMs: 0 };

  constructor(
    private device: GPUDevice,
    private world: WorldGpu,
    readonly w: number,
    readonly h: number,
    /** the box's first window column now (a slide moves it) */
    private origin: () => [number, number],
  ) {
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const n = w * h;
    this.spans = device.createBuffer({ label: 'reach spans', size: n * 8, usage: S });
    this.surf = device.createBuffer({ label: 'reach surf', size: n * NAV_K * 8, usage: S });
    this.deep = device.createBuffer({ label: 'reach deep', size: n * 4, usage: S });
    this.label = device.createBuffer({ label: 'reach label', size: n * NAV_K * 4, usage: S });
    this.flag = device.createBuffer({ label: 'reach flag', size: 16, usage: S });
    this.cutCol = device.createBuffer({ label: 'reach cut', size: n * 4, usage: S });
    this.fixDist = device.createBuffer({ label: 'reach fix field', size: n * NAV_K * 4, usage: S });
    this.fixBuf = device.createBuffer({ label: 'reach fixes', size: (1 + 3 * FIX_CAP) * 4, usage: S });
    this.rampRiseBuf = device.createBuffer({ label: 'reach ramp rise', size: n * 4, usage: S });
    this.riseWritten = new Float32Array(n);
    this.fixStage = device.createBuffer({ label: 'reach fixes read', size: (1 + 3 * FIX_CAP) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.params = MODES.map(() => device.createBuffer({ label: 'reach params', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.written = new Uint32Array(n * 2);
    const parts = [commonWgsl, layersWgsl, materialsWgsl, reachWgsl];
    const mk = (e: string, sp: BindSpec) => makeCompute(device, `reach-${e}`, parts, { 0: 'uniform', 12: 'uniform', ...sp }, e);
    this.k = {
      peel: mk('reachPeel', { 1: 'read', 2: 'uniform', 3: 'read', 4: 'read', 5: 'read', 6: 'rw', 7: 'rw', 13: 'rw' }),
      init: mk('reachInit', { 8: 'rw' }),
      hook: mk('reachHook', { 6: 'rw', 7: 'rw', 8: 'rw', 9: 'rw' }),
      jump: mk('reachJump', { 8: 'rw', 9: 'rw' }),
      query: mk('reachQuery', { 6: 'rw', 8: 'rw', 10: 'read', 11: 'rw' }),
      ramps: mk('reachRamps', { 6: 'rw', 7: 'rw', 8: 'rw', 11: 'rw' }),
      wet: mk('reachWet', { 4: 'read', 11: 'rw' }),
      fixInit: mk('fixInit', { 6: 'rw', 14: 'rw' }),
      fixRelax: mk('fixRelax', { 6: 'rw', 7: 'rw', 9: 'rw', 13: 'rw', 14: 'rw', 16: 'read' }),
      fixTrace: mk('fixTrace', { 6: 'rw', 7: 'rw', 10: 'read', 11: 'rw', 13: 'rw', 14: 'rw', 15: 'rw', 16: 'read' }),
      mark: mk('reachMark', { 6: 'rw', 7: 'rw', 8: 'rw', 17: 'rw' }),
    };
    this.marks = device.createBuffer({ label: 'reach marks', size: n * 4, usage: S });
    this.ready = new Promise((r) => whenPipelinesReady(r));
  }

  /**
   * The plan's solid as if built (box columns: two spans a column, z0 | z1 << 16 in eighths of a metre; 0 none). Only
   * the rows that changed since the last call are written.
   */
  setSpans(spans: Uint32Array, rampRise?: Float32Array): void {
    if (spans.length !== this.written.length) throw new Error('reach: spans are two words a box column');
    // (DA-A10: the ramps' rises — written when they changed)
    const rise = rampRise ?? new Float32Array(this.riseWritten.length);
    if (rise.length !== this.riseWritten.length) throw new Error('reach: a ramp rise a box column');
    if (rise.some((v, i) => v !== this.riseWritten[i])) {
      this.riseWritten.set(rise);
      this.device.queue.writeBuffer(this.rampRiseBuf, 0, this.riseWritten);
    }
    const row = this.w * 2;
    let y0 = -1;
    let y1 = -1;
    for (let y = 0; y < this.h; y++) {
      for (let i = y * row, e = i + row; i < e; i++)
        if (spans[i] !== this.written[i]) {
          if (y0 < 0) y0 = y;
          y1 = y;
          break;
        }
    }
    if (y0 < 0) return;
    this.written.set(spans.subarray(y0 * row, (y1 + 1) * row), y0 * row);
    this.device.queue.writeBuffer(this.spans, y0 * row * 4, this.written, y0 * row, (y1 - y0 + 1) * row);
  }

  private sized(nq: number): void {
    const wetWords = Math.ceil((this.w * this.h) / 32);
    const need = Math.max(16, nq);
    if (this.queryBuf && need <= this.cap) return;
    this.cap = Math.max(need, this.cap * 2);
    this.queryBuf?.destroy();
    this.answerBuf?.destroy();
    this.stage?.destroy();
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.queryBuf = this.device.createBuffer({ label: 'reach queries', size: this.cap * 32, usage: S });
    const words = 1 + 2 * RAMP_CAP + this.cap + wetWords;
    this.answerBuf = this.device.createBuffer({ label: 'reach answer', size: words * 4, usage: S });
    this.stage = this.device.createBuffer({ label: 'reach read', size: words * 4 + 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const d = this.device;
    const W = this.world;
    this.groups = this.params.map((pb) => {
      const g = (k: ComputeKernel, r: Record<number, GPUBuffer>) => makeBindGroup(d, 'reach', k.layout, { 0: W.globals, 12: pb, ...r });
      return {
        peel: g(this.k.peel, { 1: W.chunks, 2: W.materials, 3: W.layers, 4: W.water, 5: this.spans, 6: this.surf, 7: this.deep, 13: this.cutCol }),
        init: g(this.k.init, { 8: this.label }),
        hook: g(this.k.hook, { 6: this.surf, 7: this.deep, 8: this.label, 9: this.flag }),
        jump: g(this.k.jump, { 8: this.label, 9: this.flag }),
        query: g(this.k.query, { 6: this.surf, 8: this.label, 10: this.queryBuf!, 11: this.answerBuf! }),
        ramps: g(this.k.ramps, { 6: this.surf, 7: this.deep, 8: this.label, 11: this.answerBuf! }),
        wet: g(this.k.wet, { 4: W.water, 11: this.answerBuf! }),
        fixInit: g(this.k.fixInit, { 6: this.surf, 14: this.fixDist }),
        fixRelax: g(this.k.fixRelax, { 6: this.surf, 7: this.deep, 9: this.flag, 13: this.cutCol, 14: this.fixDist, 16: this.rampRiseBuf }),
        mark: g(this.k.mark, { 6: this.surf, 7: this.deep, 8: this.label, 17: this.marks }),
        fixTrace: g(this.k.fixTrace, { 6: this.surf, 7: this.deep, 10: this.queryBuf!, 11: this.answerBuf!, 13: this.cutCol, 14: this.fixDist, 15: this.fixBuf, 16: this.rampRiseBuf }),
      };
    });
  }

  /** One check (see the head). Rejects with an AbortError when disposed mid-way. */
  async check(ask: ReachAsk): Promise<ReachReply> {
    await this.ready;
    if (this.gone) throw new DOMException('reach: disposed', 'AbortError');
    const t0 = performance.now();
    const nq = ask.queries.length / 4;
    this.sized(nq);
    const d = this.device;
    const [ox, oy] = this.origin();
    const st = ask.stores ?? [-1, -1];
    const sz = new Uint32Array(new Float32Array([ask.storesZ]).buffer)[0];
    MODES.forEach((m, i) => {
      const p = new Int32Array([ox, oy, this.w, this.h, st[0], st[1], nq, ask.wet ? 1 : 0, m.lift, m.bit, sz | 0, 0]);
      d.queue.writeBuffer(this.params[i], 0, p);
    });
    if (nq) {
      // (a stand: its box column + 1, then its floor's f32 bits — fortreach.wgsl `query`)
      const q = new Uint32Array(nq * 8);
      const qf = new Float32Array(q.buffer);
      for (let i = 0; i < nq * 4; i++) {
        // (bit 31: the query's stands are ones a fix would open — never reached as they are)
        q[2 * i] = ask.queries[i] >= 0 ? (ask.queries[i] + 1) | (ask.open?.[i >> 2] ? 0x80000000 : 0) : 0;
        qf[2 * i + 1] = ask.floors[i];
      }
      d.queue.writeBuffer(this.queryBuf!, 0, q);
    }
    const words = 1 + 2 * RAMP_CAP + nq;
    const wetWords = Math.ceil((this.w * this.h) / 32);
    let rounds = 0;
    let all: Uint32Array = new Uint32Array(0);
    for (let mode = 0; mode < FIX_MODE; mode++) {
      // (why: only asked for an edit, and only while some query isn't reached)
      if (mode > 0 && (!ask.why || !all.subarray(4 + 1 + 2 * RAMP_CAP, 4 + words).some((b) => !(b & 1)))) break;
      const r = await this.solve(mode, nq, words, mode === 0 && ask.wet ? wetWords : 0);
      rounds += r.rounds;
      all = r.all;
      this.stats.solves++;
    }
    // (B: the fixes for the queries not reached — the fix field and its walk back, the answer words OR-ed with fixable)
    let fixes: ReachFix[] = [];
    if (ask.fix && nq && all.subarray(4 + 1 + 2 * RAMP_CAP, 4 + words).some((b) => !(b & 1))) {
      const r = await this.solveFix(nq, words);
      rounds += r.rounds;
      all = r.all;
      fixes = r.fixes;
    }
    const a = all.subarray(4);
    const nr = Math.min(a[0], RAMP_CAP);
    const ramps: { col: number; dir: number }[] = [];
    for (let i = 0; i < nr; i++) ramps.push({ col: a[1 + 2 * i], dir: a[2 + 2 * i] });
    this.stats.checks++;
    this.stats.rounds = rounds;
    this.stats.lastMs = performance.now() - t0;
    return { bits: a.slice(1 + 2 * RAMP_CAP, words), ramps, wet: ask.wet ? this.lastWet : null, rounds, fixes };
  }

  /**
   * (B) The fix field: the fix peel, the field from the stores relaxed to the end (FIX_ROUND sweeps a submit, the flag
   * read), then the walk back from each query not reached. The answer words (fixable OR-ed in) and the fixes read back.
   */
  private async solveFix(nq: number, words: number): Promise<{ rounds: number; all: Uint32Array; fixes: ReachFix[] }> {
    const d = this.device;
    const G = this.groups[FIX_MODE];
    const wg: [number, number] = [Math.ceil(this.w / 8), Math.ceil(this.h / 8)];
    for (let round = 1; round <= MAX_ROUNDS * 4; round++) {
      const enc = d.createCommandEncoder({ label: 'reach fix' });
      const pass = (k: ComputeKernel, gr: GPUBindGroup, n: [number, number] | number) => {
        const cp = enc.beginComputePass({ label: 'reach fix' });
        cp.setPipeline(k.pipeline);
        cp.setBindGroup(0, gr);
        if (typeof n === 'number') cp.dispatchWorkgroups(n);
        else cp.dispatchWorkgroups(n[0], n[1]);
        cp.end();
      };
      if (round === 1) {
        pass(this.k.peel, G.peel, wg);
        pass(this.k.fixInit, G.fixInit, wg);
      }
      for (let i = 0; i < FIX_ROUND; i++) {
        if (i === FIX_ROUND - 1) enc.clearBuffer(this.flag);
        pass(this.k.fixRelax, G.fixRelax, wg);
      }
      enc.copyBufferToBuffer(this.flag, 0, this.stage!, 0, 16);
      d.queue.submit([enc.finish()]);
      await this.stage!.mapAsync(GPUMapMode.READ, 0, 16);
      if (this.gone) throw new DOMException('reach: disposed', 'AbortError');
      const moved = new Uint32Array(this.stage!.getMappedRange(0, 16).slice(0))[0];
      this.stage!.unmap();
      if (moved) continue;
      const enc2 = d.createCommandEncoder({ label: 'reach fix trace' });
      enc2.clearBuffer(this.fixBuf);
      const cp = enc2.beginComputePass({ label: 'reach fix trace' });
      cp.setPipeline(this.k.fixTrace.pipeline);
      cp.setBindGroup(0, G.fixTrace);
      cp.dispatchWorkgroups(Math.ceil(nq / 64));
      cp.end();
      enc2.copyBufferToBuffer(this.answerBuf!, 0, this.stage!, 16, words * 4);
      enc2.copyBufferToBuffer(this.fixBuf, 0, this.fixStage, 0, (1 + 3 * FIX_CAP) * 4);
      d.queue.submit([enc2.finish()]);
      await Promise.all([this.stage!.mapAsync(GPUMapMode.READ, 0, 16 + words * 4), this.fixStage.mapAsync(GPUMapMode.READ)]);
      if (this.gone) throw new DOMException('reach: disposed', 'AbortError');
      const all = new Uint32Array(this.stage!.getMappedRange(0, 16 + words * 4).slice(0));
      this.stage!.unmap();
      const fw = new Uint32Array(this.fixStage.getMappedRange().slice(0));
      this.fixStage.unmap();
      const fixes: ReachFix[] = [];
      for (let i = 0; i < Math.min(fw[0], FIX_CAP); i++) {
        const word = fw[3 + 3 * i];
        fixes.push({ query: fw[1 + 3 * i], col: fw[2 + 3 * i], kind: (word & 0xff) === 1 ? 'ramp' : 'cut', dir: word >>> 8 });
      }
      return { rounds: round, all, fixes };
    }
    throw new Error(`reach: the fix field didn't settle in ${MAX_ROUNDS * 4 * FIX_ROUND} sweeps`);
  }

  /** (citygen M4b) the plan's solid as the reach peels it (two words a box column), for a caller that writes it on the
   *  GPU (citygen's decks) instead of setSpans */
  get planSpans(): GPUBuffer {
    return this.spans;
  }
  /** (citygen M4b) a word a box column after markFrom: 0 no surface, 1 joined to the stores', 2 not (reachMark) */
  readonly marks: GPUBuffer;

  /**
   * (citygen M4b) The reach from one column (the box's x, y; its top surface — `z` far above), every box column marked in
   * `marks` (0 no surface, 1 joined, 2 cut off) on the GPU: a town reads them to show what's cut off. What's read back:
   * the solve's convergence flag a round. Resolves with the rounds.
   */
  async markFrom(stores: [number, number], z = 1e6): Promise<number> {
    await this.ready;
    if (this.gone) throw new DOMException('reach: disposed', 'AbortError');
    this.sized(0);
    const d = this.device;
    const [ox, oy] = this.origin();
    const sz = new Uint32Array(new Float32Array([z]).buffer)[0];
    MODES.forEach((m, i) => d.queue.writeBuffer(this.params[i], 0, new Int32Array([ox, oy, this.w, this.h, stores[0], stores[1], 0, 0, m.lift, m.bit, sz | 0, 0])));
    const r = await this.solve(0, 0, 1 + 2 * RAMP_CAP, 0);
    const enc = d.createCommandEncoder({ label: 'reach marks' });
    const cp = enc.beginComputePass({ label: 'reach marks' });
    cp.setPipeline(this.k.mark.pipeline);
    cp.setBindGroup(0, this.groups[0].mark);
    cp.dispatchWorkgroups(Math.ceil(this.w / 8), Math.ceil(this.h / 8));
    cp.end();
    d.queue.submit([enc.finish()]);
    this.stats.solves++;
    return r.rounds;
  }

  /** the wet bits of the first solve (later solves don't ask for them: the answer buffer keeps them) */
  private lastWet: Uint32Array | null = null;

  /** one solve in a mode, to convergence: the flag and the answer words as read back */
  private async solve(mode: number, nq: number, words: number, wetWords: number): Promise<{ rounds: number; all: Uint32Array }> {
    const d = this.device;
    const G = this.groups[mode];
    const wg: [number, number] = [Math.ceil(this.w / 8), Math.ceil(this.h / 8)];
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const enc = d.createCommandEncoder({ label: 'reach' });
      const pass = (k: ComputeKernel, gr: GPUBindGroup, n: [number, number] | number) => {
        const cp = enc.beginComputePass({ label: 'reach' });
        cp.setPipeline(k.pipeline);
        cp.setBindGroup(0, gr);
        if (typeof n === 'number') cp.dispatchWorkgroups(n);
        else cp.dispatchWorkgroups(n[0], n[1]);
        cp.end();
      };
      if (round === 1) {
        pass(this.k.peel, G.peel, wg);
        pass(this.k.init, G.init, wg);
      }
      for (let i = 0; i < ROUND; i++) {
        if (i === ROUND - 1) enc.clearBuffer(this.flag);
        pass(this.k.hook, G.hook, wg);
        pass(this.k.jump, G.jump, wg);
        pass(this.k.jump, G.jump, wg);
      }
      // (the first solve's answers start clear; the later ones OR their bit into the queries' words)
      if (mode === 0) {
        enc.clearBuffer(this.answerBuf!, 0, (words + wetWords) * 4);
        pass(this.k.ramps, G.ramps, wg);
        if (wetWords) pass(this.k.wet, G.wet, wg);
      }
      if (nq) pass(this.k.query, G.query, Math.ceil(nq / 64));
      const n = words + wetWords;
      enc.copyBufferToBuffer(this.flag, 0, this.stage!, 0, 16);
      enc.copyBufferToBuffer(this.answerBuf!, 0, this.stage!, 16, n * 4);
      d.queue.submit([enc.finish()]);
      const stage = this.stage!;
      await stage.mapAsync(GPUMapMode.READ, 0, 16 + n * 4);
      if (this.gone) throw new DOMException('reach: disposed', 'AbortError');
      const all = new Uint32Array(stage.getMappedRange(0, 16 + n * 4).slice(0));
      stage.unmap();
      // (not settled: another round. A half-made labelling only ever leaves components split, never joined: a later
      // mode's bit OR-ed from it is a reached that holds)
      if (all[0] !== 0) continue;
      if (wetWords) this.lastWet = all.slice(16 / 4 + words, 16 / 4 + words + wetWords);
      return { rounds: round, all };
    }
    throw new Error(`reach: the labels didn't settle in ${MAX_ROUNDS * ROUND} iterations`);
  }

  /**
   * (round 128m, townlab: the placement bench's diagnosis, never the game's) the last solve's surfaces at a box column
   * (height, room over it; the top first) — 32 bytes read back
   */
  async surfacesAt(col: number): Promise<[number, number][]> {
    const d = this.device;
    const buf = d.createBuffer({ label: 'reach surf read', size: NAV_K * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = d.createCommandEncoder({ label: 'reach surf read' });
    enc.copyBufferToBuffer(this.surf, col * NAV_K * 8, buf, 0, NAV_K * 8);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(buf.getMappedRange().slice(0));
    buf.destroy();
    const out: [number, number][] = [];
    for (let k = 0; k < NAV_K; k++) if (f[2 * k] >= 0) out.push([+f[2 * k].toFixed(2), +f[2 * k + 1].toFixed(2)]);
    return out;
  }

  dispose(): void {
    this.gone = true;
    for (const b of [this.marks, this.spans, this.surf, this.deep, this.label, this.flag, this.cutCol, this.fixDist, this.fixBuf, this.fixStage, this.rampRiseBuf, ...this.params, this.queryBuf, this.answerBuf]) b?.destroy();
  }
}
