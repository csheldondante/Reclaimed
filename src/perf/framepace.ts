// Round 114 (framepace): the frame pacing probe. Where does a frame's time go between the display's vsync and the
// GPU finishing it? The Pixel 9a dropped 3-5% of its frames parked (33-50 ms, CPU ~1-2 ms in them), which the hitch
// recorder could only call "browser" or "gpu-busy". This records, for every rendered frame:
//   - the rAF interval, and the lag from the rAF's timestamp (the frame's begin) to its callback running;
//   - the callback's CPU, and rAF → the frame's last queue.submit;
//   - the frame's last submit → queue.onSubmittedWorkDone (its GPU work and the queue ahead of it, wall clock);
//   - the frames still on the GPU when it began (are frames queueing behind each other?) and the rAFs held for them;
//   - its GPU span (timestamp-query: first pass begin → last pass end), the gap from the previous frame's GPU end
//     (≈0 or negative: the GPU never idles between frames), and its passes by name;
//   - the sim ticks it ran (and which slow-period systems were due), the bytes written and readbacks asked.
// Installed by main.ts with ?hitch=1 (every bench page) or ?framepace=1; the bench reads `report(from)` over its
// captures (src/perf/bench.ts, the pan page's `pace`). The probe only watches; `maxInFlight` is main.ts's pacing
// limit (two frames on the GPU at once, round 82) set from here so the bench can A/B it.

import type { Profiler } from '../gpu/profiler';

interface PaceFrame {
  /** the rAF's timestamp (ms) */
  t: number;
  interval: number;
  /** rAF timestamp → callback start */
  lag: number;
  /** the callback's own ms */
  cpu: number;
  /** rAF timestamp → the frame's last submit (NaN: none) */
  toSubmit: number;
  submits: number;
  /** frames not yet done on the GPU when this one began */
  inFlight: number;
  /** rAFs held (skipped for the GPU) just before this one */
  held: number;
  /** last submit → onSubmittedWorkDone (ms; NaN until it resolves) */
  done: number;
  /** GPU ms first pass begin → last end (NaN until read back / none) */
  gpu: number;
  /** this frame's first GPU begin less the previous frame's last end (ms; NaN when not consecutive) */
  gap: number;
  /** sim ticks run in the callback, and the slow-period systems that were due in them */
  ticks: number;
  slow: string;
  /** the counters (PaceSources.counters) that moved in the frame */
  ran: string;
  writeKB: number;
  maps: number;
  frameNo: number;
  passes?: [string, number][];
}

const RING = 4096;
const r2 = (v: number) => (Number.isFinite(v) ? +v.toFixed(2) : null);

function st(xs: number[]): { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null; mean: number | null } | null {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, p50: r2(q(0.5)), p95: r2(q(0.95)), p99: r2(q(0.99)), max: r2(a[a.length - 1]), mean: r2(a.reduce((s, v) => s + v, 0) / a.length) };
}
const mean = (xs: number[]) => {
  const a = xs.filter((v) => Number.isFinite(v));
  return a.length ? r2(a.reduce((s, v) => s + v, 0) / a.length) : null;
};

export interface PaceSources {
  /** the sim's tick counter, and the systems with a period over 1 (name, period) */
  simTick?: () => number;
  slowSystems?: () => { name: string; period: number }[];
  /** bytes written by queue.writeBuffer and readbacks asked so far (src/perf/gpumem.ts io) */
  io?: () => { writeBytes: number; maps: number };
  /** work that runs now and then (the coarse world's step parts, the streamer's work): a count that moves when it ran */
  counters?: Record<string, () => number>;
}

export class FramePace {
  /** main.ts's pacing: the most frames on the GPU at once before a rAF is held (round 82: 2) */
  maxInFlight = 2;
  private frames: PaceFrame[] = [];
  private cur: PaceFrame | null = null;
  private prevT = 0;
  private heldRun = 0;
  private cbStart = 0;
  private lastSubmit = NaN;
  private submits = 0;
  private tick0 = 0;
  private io0 = { writeBytes: 0, maps: 0 };
  private c0: Record<string, number> = {};
  private byFrameNo = new Map<number, PaceFrame>();
  private prevGpuEnd = 0;
  private prevGpuFrame = -1;
  sources: PaceSources = {};

  constructor(
    device: GPUDevice,
    private profiler: Profiler,
    private canvasInfo: () => Record<string, unknown>,
  ) {
    const q = device.queue;
    const submit = q.submit.bind(q);
    q.submit = (b: Iterable<GPUCommandBuffer>) => {
      this.lastSubmit = performance.now();
      this.submits++;
      return submit(b);
    };
    // (a listener of its own: the hitch recorder's and the bench's onFrame slot stays theirs)
    profiler.listen((f, ms) => this.gpuFrame(f, ms));
  }

  /** a rAF held for the GPU (main.ts) */
  held(): void {
    this.heldRun++;
  }

  /** a rendered frame begins: its rAF timestamp, the frames still on the GPU */
  begin(now: number, inFlight: number): void {
    this.cbStart = performance.now();
    this.submits = 0;
    this.lastSubmit = NaN;
    this.tick0 = this.sources.simTick?.() ?? 0;
    this.io0 = this.sources.io?.() ?? { writeBytes: 0, maps: 0 };
    for (const [k, f] of Object.entries(this.sources.counters ?? {})) this.c0[k] = f();
    this.cur = {
      t: now,
      interval: this.prevT ? now - this.prevT : NaN,
      lag: this.cbStart - now,
      cpu: 0,
      toSubmit: NaN,
      submits: 0,
      inFlight,
      held: this.heldRun,
      done: NaN,
      gpu: NaN,
      gap: NaN,
      ticks: 0,
      slow: '',
      ran: '',
      writeKB: 0,
      maps: 0,
      frameNo: -1,
    };
    this.prevT = now;
    this.heldRun = 0;
  }

  /** the frame's callback ends (after its last submit); `done` resolves when its GPU work is done */
  end(): (() => void) | undefined {
    const f = this.cur;
    if (!f) return undefined;
    this.cur = null;
    const tEnd = performance.now();
    f.cpu = tEnd - this.cbStart;
    f.submits = this.submits;
    f.toSubmit = this.lastSubmit - f.t;
    const tick1 = this.sources.simTick?.() ?? 0;
    f.ticks = tick1 - this.tick0;
    if (f.ticks > 0 && this.sources.slowSystems) {
      const due: string[] = [];
      for (const s of this.sources.slowSystems()) for (let k = this.tick0; k < tick1; k++) if (k % s.period === 0) due.push(s.name);
      f.slow = due.join(' ');
    }
    const ran: string[] = [];
    for (const [k, fn] of Object.entries(this.sources.counters ?? {})) if (fn() !== this.c0[k]) ran.push(k);
    f.ran = ran.join(' ');
    const io = this.sources.io?.();
    if (io) {
      f.writeKB = (io.writeBytes - this.io0.writeBytes) / 1024;
      f.maps = io.maps - this.io0.maps;
    }
    f.frameNo = this.profiler.frameNo;
    this.byFrameNo.set(f.frameNo, f);
    if (this.byFrameNo.size > 32) this.byFrameNo.delete(this.byFrameNo.keys().next().value!);
    this.frames.push(f);
    if (this.frames.length > RING) this.frames.splice(0, this.frames.length - RING);
    const sub = Number.isFinite(this.lastSubmit) ? this.lastSubmit : tEnd;
    return () => {
      f.done = performance.now() - sub;
    };
  }

  private gpuFrame(frameNo: number, ms: number): void {
    const f = this.byFrameNo.get(frameNo);
    const start = this.profiler.lastStartNs;
    const end = this.profiler.lastEndNs;
    if (f) {
      f.gpu = ms;
      if (this.prevGpuFrame === frameNo - 1) f.gap = (start - this.prevGpuEnd) / 1e6;
      f.passes = [...this.profiler.lastPasses];
    }
    this.prevGpuEnd = end;
    this.prevGpuFrame = frameNo;
  }

  /** forget what's been recorded (the next report starts here) */
  mark(): number {
    return performance.now();
  }

  /**
   * The frames since `from` (a `mark()`): their pacing, what the slow ones (an interval over 1.25 vsyncs) had that the
   * others hadn't, the GPU's passes in each kind, and the worst frames one by one.
   */
  report(from: number, label = ''): Record<string, unknown> {
    const fs = this.frames.filter((f) => f.t >= from && Number.isFinite(f.interval));
    if (!fs.length) return { label, frames: 0 };
    const iv = fs.map((f) => f.interval).sort((a, b) => a - b);
    const vsync = iv[Math.floor(iv.length * 0.25)];
    const slowAt = vsync * 1.25;
    const slow = fs.filter((f) => f.interval > slowAt);
    const ok = fs.filter((f) => f.interval <= slowAt);
    // (the frame before a slow one: what it left on the GPU)
    const before = slow.map((f) => fs[fs.indexOf(f) - 1]).filter(Boolean);
    const kind = (xs: PaceFrame[]) => ({
      n: xs.length,
      interval: mean(xs.map((f) => f.interval)),
      lag: mean(xs.map((f) => f.lag)),
      cpu: mean(xs.map((f) => f.cpu)),
      toSubmit: mean(xs.map((f) => f.toSubmit)),
      done: mean(xs.map((f) => f.done)),
      gpu: mean(xs.map((f) => f.gpu)),
      gap: mean(xs.map((f) => f.gap)),
      inFlight: mean(xs.map((f) => f.inFlight)),
      held: mean(xs.map((f) => f.held)),
      ticks: mean(xs.map((f) => f.ticks)),
      submits: mean(xs.map((f) => f.submits)),
      writeKB: mean(xs.map((f) => f.writeKB)),
      maps: mean(xs.map((f) => f.maps)),
      slowSystemsDue: xs.length ? +(xs.filter((f) => f.slow).length / xs.length).toFixed(2) : null,
      // (the share of these frames each counter moved in)
      ran: xs.length ? Object.fromEntries(Object.keys(this.sources.counters ?? {}).map((k) => [k, +(xs.filter((f) => f.ran.split(' ').includes(k)).length / xs.length).toFixed(2)])) : null,
    });
    const passMeans = (xs: PaceFrame[]) => {
      const m = new Map<string, number>();
      let n = 0;
      for (const f of xs) {
        if (!f.passes) continue;
        n++;
        for (const [k, v] of f.passes) m.set(k, (m.get(k) ?? 0) + v);
      }
      return n ? Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => [k, r2(v / n)])) : null;
    };
    const buckets: Record<string, number> = {};
    for (const f of fs) {
      const k = Math.max(1, Math.round(f.interval / vsync));
      buckets[`${k}`] = (buckets[`${k}`] ?? 0) + 1;
    }
    const inFlight: Record<string, number> = {};
    for (const f of fs) inFlight[`${f.inFlight}`] = (inFlight[`${f.inFlight}`] ?? 0) + 1;
    const ticks: Record<string, number> = {};
    for (const f of fs) ticks[`${f.ticks}`] = (ticks[`${f.ticks}`] ?? 0) + 1;
    // (a slow frame's sim ticks against the frame's: 2 ticks a frame after a long one is the accumulator catching up)
    const slowByTicks: Record<string, number> = {};
    for (const f of slow) slowByTicks[`${f.ticks}`] = (slowByTicks[`${f.ticks}`] ?? 0) + 1;
    const worst = [...fs].sort((a, b) => b.interval - a.interval).slice(0, 8).map((f) => {
      const top = (f.passes ?? []).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
      return `${f.interval.toFixed(1)} ms: lag ${f.lag.toFixed(1)} cpu ${f.cpu.toFixed(1)} toSubmit ${f.toSubmit.toFixed(1)} done ${f.done.toFixed(1)} inFlight ${f.inFlight} held ${f.held} gpu ${Number.isFinite(f.gpu) ? f.gpu.toFixed(1) : '-'} gap ${Number.isFinite(f.gap) ? f.gap.toFixed(1) : '-'} ticks ${f.ticks}${f.slow ? ` (${f.slow})` : ''}${f.ran ? ` ran ${f.ran}` : ''} wrote ${f.writeKB.toFixed(0)} KB maps ${f.maps}${top ? `; ${top}` : ''}`;
    });
    return {
      label,
      unit: 'ms',
      how: 'every rendered frame: interval (rAF to rAF), lag (rAF timestamp to its callback), cpu (the callback), toSubmit (rAF timestamp to the last queue.submit), done (last submit to onSubmittedWorkDone, wall), inFlight (frames not done on the GPU when it began; main.ts holds a rAF at maxInFlight), gpu (timestamp-query first pass begin to last end), gap (this frame\'s GPU begin less the previous one\'s end: ~0 or below = the GPU never idles between frames). slow = interval over 1.25 vsync',
      maxInFlight: this.maxInFlight,
      timing: this.profiler.enabled && this.profiler.active ? 'timestamps on (a readback a frame)' : 'timestamps off',
      canvas: this.canvasInfo(),
      frames: fs.length,
      vsyncMs: r2(vsync),
      fps: r2((fs.length / (fs[fs.length - 1].t - fs[0].t + fs[0].interval)) * 1000),
      vsyncsPerFrame: buckets,
      interval: st(fs.map((f) => f.interval)),
      lag: st(fs.map((f) => f.lag)),
      cpu: st(fs.map((f) => f.cpu)),
      toSubmit: st(fs.map((f) => f.toSubmit)),
      done: st(fs.map((f) => f.done)),
      gpu: st(fs.map((f) => f.gpu)),
      gap: st(fs.map((f) => f.gap)),
      inFlightAtStart: inFlight,
      heldRafs: fs.reduce((s, f) => s + f.held, 0),
      ticksPerFrame: ticks,
      slowFramesByTicks: slowByTicks,
      ok: kind(ok),
      slow: kind(slow),
      beforeSlow: kind(before),
      passesOk: passMeans(ok),
      passesSlow: passMeans(slow),
      worst,
    };
  }
}

/** ?hitch=1 (the bench) or ?framepace=1: the probe on the device before the scene makes anything */
export function startFramePace(params: URLSearchParams, device: GPUDevice, profiler: Profiler, canvasInfo: () => Record<string, unknown>): FramePace | null {
  if (params.get('hitch') !== '1' && params.get('framepace') !== '1') return null;
  const p = new FramePace(device, profiler, canvasInfo);
  (window as unknown as { reclaimedPace: FramePace }).reclaimedPace = p;
  return p;
}
