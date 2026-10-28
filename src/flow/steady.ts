// Steady state (?flow=1; docs/ARCHITECTURE.md "The flow model"). The user: "As long as our section has material going in
// matching material out it is in steady state and we only need to find that again when we perturb it" — and
// "we can have a tolerance and decide when we are close enough to steady state to freeze and treat it as an
// animation only".
//
// The liquid passes add, per chunk, the net change of everything flowing in it (each column's liquid, and its
// bed: the loose ground moving) and the throughput (what left its columns), over a window of ticks. Read back
// each window: a chunk whose mean net change a tick is under tol x its throughput (+ a small floor) for two
// windows running is near steady — it is let sleep (sim/sleep.ts), so the systems skip it and its last flux is
// kept and drawn: the river runs, the fall arcs, the sand pours, with no ticks. One that isn't is kept awake.
// A sleeping column next to an awake chunk checks its balance each tick (what flows in against the frozen
// outflow): past the wake tolerance its chunk is flagged perturbed and woken, settles, and freezes again.
//
// Tuning: ?steadytol= (relative, default 0.1), ?steadyfloor= (cells^3 a tick a chunk, default 1e-3),
// ?steadywin= (ticks, default 30), ?waketol= (cells^3 a tick a column, default 2e-3), ?rescalemax= (default 4).

import { ignoreTeardown } from '../gpu/pipeline';
import type { Sleep } from '../sim/sleep';
import type { WorldGpu } from '../sim/world-gpu';

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(params.get(k) ?? d);
  if (!(v >= 0)) throw new Error(`?${k}=${params.get(k)}: a number >= 0`);
  return v;
};
export const STEADY_TOL = num('steadytol', 0.1);
export const STEADY_FLOOR = num('steadyfloor', 1e-3);
export const STEADY_WIN = Math.max(2, Math.round(num('steadywin', 30)));
export const WAKE_TOL = num('waketol', 2e-3);
/** a frozen chunk's supply changing by more than this factor (either way) wakes it instead of rescaling it */
export const RESCALE_MAX = Math.max(1.01, num('rescalemax', 4));

export class Steady {
  /** per chunk, act x 4 u32 (net change, throughput, perturbed, overflow): the liquid passes add */
  readonly act: GPUBuffer;
  private stage: GPUBuffer;
  private busy = false;
  private ticks = 0;
  /** per chunk: windows running it was near steady */
  private calm: Uint8Array;
  /** the last window's read (perf overlay, scripts): chunks awake for being unsteady, perturbed, overflow */
  last = { unsteady: 0, perturbed: 0, rescaled: 0, steady: 0, overflow: 0, windows: 0, layerWrites: 0 };
  /** judge every chunk at the next read as if awake (after the warmup: what's unsteady is kept awake, the rest sleeps) */
  judgeAll = false;
  /** a frozen chunk's flux rescaled (install.ts: every liquid's) */
  onRescale: (chunk: number, r: number) => void = () => {};
  /** per chunk, the last window's mean net change a tick, and throughput (scripts) */
  net: Float32Array;
  thr: Float32Array;

  constructor(
    device: GPUDevice,
    world: WorldGpu,
    private sleep: Sleep,
    private chunks: number,
  ) {
    this.act = world.buf('flowAct', chunks * 16 + 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    this.stage = device.createBuffer({ label: 'flowActRead', size: chunks * 16 + 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.calm = new Uint8Array(chunks);
    this.net = new Float32Array(chunks);
    this.thr = new Float32Array(chunks);
  }

  /** after each tick's encode (the tick's commands): every window, the counters read back and cleared */
  encode(enc: GPUCommandEncoder): void {
    if (++this.ticks < STEADY_WIN || this.busy) return;
    const win = this.ticks;
    this.ticks = 0;
    enc.copyBufferToBuffer(this.act, 0, this.stage, 0, this.act.size);
    enc.clearBuffer(this.act);
    this.busy = true;
    this.pending = win;
  }
  private pending = 0;

  afterSubmit(): void {
    if (!this.pending) return;
    const win = this.pending;
    this.pending = 0;
    this.stage.mapAsync(GPUMapMode.READ).then(() => {
      const u = new Uint32Array(this.stage.getMappedRange().slice(0));
      this.stage.unmap();
      this.busy = false;
      this.judge(u, win);
    }, ignoreTeardown);
  }

  private judge(u: Uint32Array, win: number): void {
    const now = performance.now() / 1000;
    const all = this.judgeAll;
    this.judgeAll = false;
    const out = { unsteady: 0, perturbed: 0, rescaled: 0, steady: 0, overflow: 0, windows: this.last.windows + 1, layerWrites: u[this.chunks * 4] / win };
    for (let k = 0; k < this.chunks; k++) {
      const net = u[k * 4] / 1e6 / win;
      const thr = u[k * 4 + 1] / 1e6 / win;
      this.net[k] = net;
      this.thr[k] = thr;
      if (u[k * 4 + 3]) out.overflow += u[k * 4 + 3] / 1e6;
      if (!this.sleep.isAwakeSlot(k, now) && !all) {
        if (!u[k * 4 + 2]) continue;
        // (a frozen chunk whose supply changed — asleep, x and y are its edge's inflow and outflow: the user,
        // "keep the flow proportional and then zero out when they get too low". Its flux is rescaled by in / out,
        // no simulation; under the floor, zeroed (dried up). Something new arriving where nothing flowed, or a
        // change past RESCALE_MAX either way: woken to find its new steady state. Shape changes wake by events.)
        out.perturbed++;
        const r = thr > 1e-6 ? net / thr : Infinity;
        // (round 86: a stream arrived over it where none was - liquid.wgsl jets holds it aloft: woken)
        if (u[k * 4 + 2] & 2) {
          this.calm[k] = 0;
          this.sleep.wakeSlot(k, 1, now);
        } else if (net < STEADY_FLOOR && thr > 1e-6) {
          this.onRescale(k, 0);
          out.rescaled++;
        } else if (r > 1 / RESCALE_MAX && r < RESCALE_MAX) {
          this.onRescale(k, r);
          out.rescaled++;
        } else {
          this.calm[k] = 0;
          this.sleep.wakeSlot(k, 1, now);
        }
        continue;
      }
      if (net <= STEADY_FLOOR + STEADY_TOL * thr) {
        this.calm[k] = Math.min(this.calm[k] + 1, 255);
        if (this.calm[k] >= 2) out.steady++;
        else this.sleep.wakeSlot(k, 0.2, now);
      } else {
        this.calm[k] = 0;
        out.unsteady++;
        // (kept awake until the next window's read, and a little: the read's latency)
        this.sleep.wakeSlot(k, 0.6, now);
      }
    }
    this.last = out;
  }
}
