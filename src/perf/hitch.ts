// Round 100 (hitchrec): the hitch recorder (`?hitch=1`, threshold `?hitchms=20`). Every frame whose interval (one
// rAF's start to the next real frame's) is over the threshold is logged with what it was spent on:
//   - the CPU steps recorded in it (gpu/cpustat.ts record/timed: slides, writes, tiles, the mesh, the judge, ...),
//     split into those run inside the frame's own callback and those run between frames (async continuations);
//   - frames held back for the GPU (main.ts paces at two frames in flight: a held rAF is the GPU behind);
//   - the GPU's own time for that frame (timestamp-query, when the adapter has it; "n/a" otherwise, not a guess);
//   - garbage collections (no 'gc' entry type in browsers: FinalizationRegistry canaries — a young one a frame for
//     scavenges, one held two seconds a second for the old space's mark-compacts — and performance.memory drops);
//   - long tasks and long animation frames (PerformanceObserver 'long-animation-frame' with its scripts, else
//     'longtask').
// Cheap enough to leave on: per frame a few performance.now(), one tiny canary object, typed-array writes; a hitch
// allocates its record. The session is kept a second a column (timeline) and a minute a row (histograms).

import { spans } from '../gpu/cpustat';
import type { Profiler } from '../gpu/profiler';
import type { GpuMemTrack } from './gpumem';

export interface Step {
  label: string;
  ms: number;
}

export interface Hitch {
  /** session seconds at the frame's start */
  t: number;
  /** the frame's interval, ms */
  ms: number;
  /** the frame callback's own CPU ms (scene.frame) */
  cpu: number;
  /** what it was spent on, one word (see classify) */
  cause: string;
  /** the steps inside the frame's callback and those between frames, largest first (at most 6 each) */
  steps: Step[];
  async: Step[];
  /** rAFs held back for the GPU before this frame */
  held: number;
  /** the GPU's ms for the frame (timestamp-query), its largest pass; null until read back, 'n/a' without */
  gpu: number | 'n/a' | null;
  gpuTop?: string;
  /** collections seen in the interval: young (scavenge), old (mark-compact), heap drop MB */
  gc: { young: number; old: number; dropMB: number };
  /** long animation frames / long tasks overlapping it: duration, blocking, the scripts' invokers */
  long: string[];
  /** the most a long frame / task in it blocked the main thread (ms; a long task counts whole) */
  block: number;
  /**
   * the GPU's traffic in it (src/perf/gpumem.ts): submits, MB written / copied / mapped for reading / made, readbacks
   * asked, readbacks still waiting at its end; the slowest readback that finished in it (its wait, label, MB)
   */
  io?: { submits: number; writeMB: number; copyMB: number; mapMB: number; madeMB: number; maps: number; pending: number; slowMap?: string; slowMs?: number };
  /** the streamer was mid-slide */
  busy?: boolean;
  /** (internal) the profiler's frame number of the frame's work */
  pf?: number;
}

interface MinuteRow {
  frames: number;
  hitches: number;
  /** frame interval histogram, 1 ms bins to 250 */
  hist: Uint32Array;
  max: number;
  heapMB: number;
  gpuMB: number;
  gcYoung: number;
  gcOld: number;
  causes: Record<string, number>;
}

const BINS = 251;
const MAX_HITCHES = 600;

export interface HitchOptions {
  thresholdMs: number;
  profiler: Profiler;
  gpuMem?: GpuMemTrack;
  /** the streamer's state at a hitch (optional, the level's) */
  busy?: () => boolean;
}

export class HitchRecorder {
  readonly threshold: number;
  readonly t0 = performance.now();
  readonly hitches: Hitch[] = [];
  /** per session second: the worst interval (ms) and the frames */
  readonly secWorst = new Float32Array(3600);
  readonly secFrames = new Uint16Array(3600);
  /** per second: index into CAUSES of the worst hitch's cause (0 none) */
  readonly secCause = new Uint8Array(3600);
  readonly minutes: MinuteRow[] = [];
  readonly causeCount: Record<string, number> = {};
  readonly causeMs: Record<string, number> = {};
  readonly support: { gpu: boolean; loaf: boolean; longtask: boolean; memory: boolean; finalization: boolean };
  frames = 0;
  heldTotal = 0;
  gcYoung = 0;
  gcOld = 0;

  private prof: Profiler;
  private gpuMem?: GpuMemTrack;
  private busyFn?: () => boolean;
  private lastStart = -1;
  private lastCpu = 0;
  private lastPf = 0;
  private held = 0;
  /** spans recorded before this index were the previous callback's; after, between frames */
  private cbEnd = 0;
  private cbBegin = 0;
  private young?: FinalizationRegistry<number>;
  private old?: FinalizationRegistry<number>;
  private oldHeld: object[] = [];
  private lastOldAt = 0;
  /** collection times (session ms): young batches and old */
  private gcYoungAt: number[] = [];
  private gcOldAt: number[] = [];
  private lastYoungCb = -1e9;
  private heapPrev = 0;
  private heapDropAt: { t: number; mb: number }[] = [];
  private lastMemAt = 0;
  private pendingGpu: Hitch[] = [];
  private gpuSeen = new Map<number, [number, string]>();
  private longQueue: { start: number; end: number; text: string; block: number }[] = [];
  private observers: PerformanceObserver[] = [];
  private ioPrev = { submits: 0, writeBytes: 0, copyBytes: 0, mapBytes: 0, madeBytes: 0, maps: 0, pendingMaps: 0 };

  constructor(o: HitchOptions) {
    this.threshold = o.thresholdMs;
    this.prof = o.profiler;
    this.gpuMem = o.gpuMem;
    this.busyFn = o.busy;
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? [];
    this.support = {
      gpu: o.profiler.enabled && o.profiler.active,
      loaf: types.includes('long-animation-frame'),
      longtask: types.includes('longtask'),
      memory: !!(performance as unknown as { memory?: unknown }).memory,
      finalization: typeof FinalizationRegistry !== 'undefined',
    };
    if (this.support.gpu) {
      o.profiler.onFrame = (f, ms, top) => this.gpuFrame(f, ms, top);
    }
    if (this.support.finalization) {
      this.young = new FinalizationRegistry(() => {
        const t = performance.now() - this.t0;
        // (a scavenge collects every canary since the last: one batch, one collection)
        if (t - this.lastYoungCb > 2) {
          this.gcYoung++;
          this.gcYoungAt.push(t);
          if (this.gcYoungAt.length > 256) this.gcYoungAt.shift();
        }
        this.lastYoungCb = t;
      });
      this.old = new FinalizationRegistry(() => {
        const t = performance.now() - this.t0;
        this.gcOld++;
        this.gcOldAt.push(t);
        if (this.gcOldAt.length > 64) this.gcOldAt.shift();
      });
    }
    const observe = (type: string, f: (e: PerformanceEntry) => void) => {
      const ob = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) f(e);
      });
      ob.observe({ type, buffered: false } as PerformanceObserverInit);
      this.observers.push(ob);
    };
    if (this.support.loaf)
      observe('long-animation-frame', (e) => {
        const L = e as PerformanceEntry & { blockingDuration?: number; scripts?: { invoker?: string; invokerType?: string; sourceFunctionName?: string; duration: number; forcedStyleAndLayoutDuration?: number }[] };
        const scripts = (L.scripts ?? [])
          .filter((s) => s.duration >= 4)
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 3)
          .map((s) => `${s.invokerType ?? ''}:${s.sourceFunctionName || s.invoker || '?'} ${s.duration.toFixed(0)}`);
        this.long(e.startTime, e.duration, `loaf ${e.duration.toFixed(0)} block ${(L.blockingDuration ?? 0).toFixed(0)}${scripts.length ? ' [' + scripts.join(', ') + ']' : ''}`, L.blockingDuration ?? 0);
      });
    else if (this.support.longtask) observe('longtask', (e) => this.long(e.startTime, e.duration, `task ${e.duration.toFixed(0)} ${e.name}`, e.duration));
    spans.on = true;
    spans.label.length = 0;
    spans.ms.length = 0;
  }

  /** a rAF held back for the GPU (main.ts's pacing) */
  heldFrame(): void {
    this.held++;
  }

  /** a real frame begins (before scene.frame): judge the interval just ended */
  frameStart(now: number): void {
    // (spans since the previous callback ended were between frames)
    const n = spans.ms.length;
    if (this.lastStart >= 0) {
      const interval = now - this.lastStart;
      this.account(now, interval);
      if (interval > this.threshold) this.hitch(interval, n);
    }
    spans.label.length = 0;
    spans.ms.length = 0;
    this.held = 0;
    this.lastStart = now;
    if (this.gpuMem) Object.assign(this.ioPrev, this.gpuMem.io);
    this.cbBegin = 0;
    // (a young canary a frame; an old one a second, held two seconds so it's promoted first)
    if (this.young) this.young.register({}, this.frames);
    if (this.old && now - this.lastOldAt > 1000) {
      this.lastOldAt = now;
      const o = {};
      this.old.register(o, this.frames);
      this.oldHeld.push(o);
      if (this.oldHeld.length > 2) this.oldHeld.shift();
    }
  }

  /** the frame's callback is done (after scene.frame): its CPU ms */
  frameEnd(cpuMs: number): void {
    this.lastCpu = cpuMs;
    this.cbEnd = spans.ms.length;
    this.lastPf = this.prof.frameNo;
    this.frames++;
  }

  private account(now: number, interval: number): void {
    const t = now - this.t0;
    const sec = Math.floor(t / 1000);
    if (sec < this.secWorst.length) {
      if (interval > this.secWorst[sec]) this.secWorst[sec] = interval;
      this.secFrames[sec]++;
    }
    const m = Math.floor(t / 60000);
    while (this.minutes.length <= m) this.minutes.push({ frames: 0, hitches: 0, hist: new Uint32Array(BINS), max: 0, heapMB: 0, gpuMB: 0, gcYoung: 0, gcOld: 0, causes: {} });
    const row = this.minutes[m];
    row.frames++;
    row.hist[Math.min(BINS - 1, Math.round(interval))]++;
    if (interval > row.max) row.max = interval;
    row.gcYoung = this.gcYoung;
    row.gcOld = this.gcOld;
    this.heldTotal += this.held;
    // (the heap and the GPU's memory a second: performance.memory's getter allocates)
    if (now - this.lastMemAt > 1000) {
      this.lastMemAt = now;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (mem) {
        const mb = mem.usedJSHeapSize / 1048576;
        if (this.heapPrev - mb > 1) {
          this.heapDropAt.push({ t, mb: this.heapPrev - mb });
          if (this.heapDropAt.length > 64) this.heapDropAt.shift();
        }
        this.heapPrev = mb;
        row.heapMB = mb;
      }
      row.gpuMB = (this.gpuMem ? this.gpuMem.liveBytes() : this.prof.totalMemoryBytes()) / 1048576;
    }
  }

  private hitch(interval: number, n: number): void {
    const t1 = performance.now() - this.t0;
    const t0 = this.lastStart - this.t0;
    const pick = (a: number, b: number): Step[] => {
      const out: Step[] = [];
      for (let i = a; i < b; i++) out.push({ label: spans.label[i], ms: +spans.ms[i].toFixed(1) });
      return out.sort((x, y) => y.ms - x.ms).slice(0, 6);
    };
    // (the spans before this frame's start: [0, cbEnd) the previous callback's, [cbEnd, n) between frames)
    const steps = pick(this.cbBegin, Math.min(this.cbEnd, n));
    const async = pick(Math.min(this.cbEnd, n), n);
    const inRange = (a: number[]) => a.filter((x) => x >= t0 - 1 && x <= t1 + 1).length;
    const drop = this.heapDropAt.filter((d) => d.t >= t0 - 500 && d.t <= t1 + 500).reduce((s, d) => s + d.mb, 0);
    const h: Hitch = {
      t: +(t0 / 1000).toFixed(2),
      ms: +interval.toFixed(1),
      cpu: +this.lastCpu.toFixed(1),
      cause: '',
      steps,
      async,
      held: this.held,
      gpu: this.support.gpu ? null : 'n/a',
      gc: { young: inRange(this.gcYoungAt), old: inRange(this.gcOldAt), dropMB: +drop.toFixed(1) },
      long: [],
      block: 0,
      busy: this.busyFn?.() || undefined,
      pf: this.lastPf,
    };
    if (this.gpuMem) {
      const a = this.gpuMem.io;
      const b = this.ioPrev;
      const mb = (x: number) => +(x / 1048576).toFixed(2);
      h.io = { submits: a.submits - b.submits, writeMB: mb(a.writeBytes - b.writeBytes), copyMB: mb(a.copyBytes - b.copyBytes), mapMB: mb(a.mapBytes - b.mapBytes), madeMB: mb(a.madeBytes - b.madeBytes), maps: a.maps - b.maps, pending: a.pendingMaps };
      const sm = this.gpuMem.slowMap;
      if (sm.at >= this.lastStart - 1 && sm.at <= performance.now() + 1) {
        h.io.slowMap = `${sm.label} ${mb(sm.bytes)}MB`;
        h.io.slowMs = Math.round(sm.ms);
      }
    }
    const g = this.gpuSeen.get(this.lastPf);
    if (g) {
      h.gpu = +g[0].toFixed(1);
      h.gpuTop = g[1];
    } else if (this.support.gpu) this.pendingGpu.push(h);
    for (const l of this.longQueue)
      if (l.end >= this.lastStart - 2 && l.start <= this.lastStart + interval + 2) {
        h.long.push(l.text);
        h.block = Math.max(h.block, l.block);
      }
    h.cause = this.classify(h);
    this.count(h, +1);
    this.hitches.push(h);
    if (this.hitches.length > MAX_HITCHES) {
      // (keep the worst: drop the mildest of the oldest half)
      let k = 0;
      for (let i = 1; i < MAX_HITCHES / 2; i++) if (this.hitches[i].ms < this.hitches[k].ms) k = i;
      this.hitches.splice(k, 1);
    }
    const m = this.minutes[this.minutes.length - 1];
    if (m) m.hitches++;
    const sec = Math.floor(t0 / 1000);
    if (sec < this.secCause.length) this.secCause[sec] = Math.max(this.secCause[sec], causeIndex(h.cause));
  }

  /**
   * One word for what a hitch was spent on, from what's known now (a late GPU time or long frame re-classifies):
   * - gpu-held: frames were held back for the GPU (two in flight)
   * - cpu:<step>: the frame's callback took most of it, and one step most of that (cpu:untimed when none)
   * - async:<step>: work between frames (a readback's continuation) took most of it
   * - gpu: the GPU's own time for the frame was most of it (timestamp-query)
   * - task: a long task / animation frame not ours explained it
   * - gc: a mark-compact (or a heap drop) in it and nothing else
   * - browser: none of these (the compositor, presentation, the OS)
   */
  private classify(h: Hitch): string {
    const I = h.ms;
    // (a held rAF is a vsync waited for the GPU: held, the frames it explains — one held in a 9 s gap is the
    // browser not giving frames at all, not the GPU behind)
    if (h.held > 0 && h.held * 16.7 >= 0.5 * (I - h.cpu)) return 'gpu-held';
    if (h.cpu >= 0.5 * I) {
      const s = h.steps[0];
      if (!s || s.ms < 0.3 * h.cpu) return 'cpu:untimed';
      // (a step that holds others — render the mesh's rebuilds, the judge the rock bodies — names the one inside
      // when that's most of it)
      const kid = h.steps.find((k) => KIDS[s.label]?.includes(k.label) && k.ms >= 0.5 * s.ms);
      return `cpu:${base((kid ?? s).label)}`;
    }
    const a = h.async[0];
    if (a && a.ms >= 0.3 * (I - h.cpu)) return `async:${base(a.label)}`;
    if (typeof h.gpu === 'number' && h.gpu >= 0.7 * I) return 'gpu';
    // (a readback that waited most of it: the GPU's queue was that far behind — gpu-busy, its label in io.slowMap)
    if (h.io?.slowMs !== undefined && h.io.slowMs >= 0.5 * I) return 'gpu-busy';
    // (a collection is a pause of milliseconds to a second: one seen in a longer gap didn't make it)
    if ((h.gc.old > 0 || h.gc.dropMB > 2) && I < 1000) return 'gc';
    if (h.block >= 0.3 * I) return 'task';
    return 'browser';
  }

  private count(h: Hitch, k: number): void {
    this.causeCount[h.cause] = (this.causeCount[h.cause] ?? 0) + k;
    this.causeMs[h.cause] = (this.causeMs[h.cause] ?? 0) + k * h.ms;
    const m = this.minutes[Math.min(this.minutes.length - 1, Math.floor((h.t * 1000) / 60000))];
    if (m) m.causes[h.cause] = (m.causes[h.cause] ?? 0) + k;
  }

  private reclassify(h: Hitch): void {
    const c = this.classify(h);
    if (c === h.cause) return;
    this.count(h, -1);
    h.cause = c;
    this.count(h, +1);
  }

  private gpuFrame(f: number, ms: number, top: string): void {
    this.gpuSeen.set(f, [ms, top]);
    if (this.gpuSeen.size > 16) this.gpuSeen.delete(this.gpuSeen.keys().next().value!);
    if (!this.pendingGpu.length) return;
    for (let i = this.pendingGpu.length - 1; i >= 0; i--) {
      const h = this.pendingGpu[i];
      if (h.pf === f) {
        h.gpu = +ms.toFixed(1);
        h.gpuTop = top;
        this.pendingGpu.splice(i, 1);
        this.reclassify(h);
      } else if ((h.pf ?? 0) < f - 8) this.pendingGpu.splice(i, 1);
    }
  }

  private long(start: number, dur: number, text: string, block: number): void {
    const end = start + dur;
    this.longQueue.push({ start, end, text, block });
    if (this.longQueue.length > 32) this.longQueue.shift();
    // (they arrive after the frame: attach to the recent hitches they overlap)
    for (let i = this.hitches.length - 1; i >= 0 && i >= this.hitches.length - 8; i--) {
      const h = this.hitches[i];
      const hs = h.t * 1000 + this.t0;
      if (end >= hs - 2 && start <= hs + h.ms + 2 && !h.long.includes(text)) {
        h.long.push(text);
        h.block = Math.max(h.block, block);
        this.reclassify(h);
      }
    }
  }

  /** session seconds */
  elapsed(): number {
    return (performance.now() - this.t0) / 1000;
  }

  /** hitches in the last minute */
  perMinute(): number {
    const t = this.elapsed() - 60;
    let n = 0;
    for (let i = this.hitches.length - 1; i >= 0 && this.hitches[i].t >= t; i--) n++;
    return n;
  }

  worst(k = 10): Hitch[] {
    return [...this.hitches].sort((a, b) => b.ms - a.ms).slice(0, k);
  }

  /** forget everything so far (a script's phase) */
  reset(): void {
    this.hitches.length = 0;
    this.minutes.length = 0;
    this.secWorst.fill(0);
    this.secFrames.fill(0);
    this.secCause.fill(0);
    for (const k of Object.keys(this.causeCount)) delete this.causeCount[k];
    for (const k of Object.keys(this.causeMs)) delete this.causeMs[k];
    this.frames = 0;
    this.heldTotal = 0;
    (this as { t0: number }).t0 = performance.now();
    this.lastStart = -1;
    this.gcYoungAt.length = 0;
    this.gcOldAt.length = 0;
    this.gcYoung = 0;
    this.gcOld = 0;
  }

  /** the session as JSON (the report): what was measured and how */
  report(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const q = (h: Uint32Array, total: number, p: number) => {
      let c = 0;
      for (let i = 0; i < h.length; i++) {
        c += h[i];
        if (c >= p * total) return i;
      }
      return h.length - 1;
    };
    const secs = Math.min(this.secWorst.length, Math.ceil(this.elapsed()));
    return {
      kind: 'reclaimed-hitch-report',
      version: 1,
      when: new Date().toISOString(),
      url: location.href,
      ua: navigator.userAgent,
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, css: [innerWidth, innerHeight] },
      thresholdMs: this.threshold,
      support: this.support,
      gcMethod: this.support.finalization ? 'FinalizationRegistry canaries (young a frame, old a second held 2 s) + performance.memory drops' : 'performance.memory drops only',
      seconds: +this.elapsed().toFixed(1),
      frames: this.frames,
      heldForGpu: this.heldTotal,
      gc: { young: this.gcYoung, old: this.gcOld },
      causes: Object.fromEntries(
        Object.entries(this.causeCount)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => [c, { n, ms: Math.round(this.causeMs[c]) }]),
      ),
      minutes: this.minutes.map((m, i) => ({
        minute: i,
        frames: m.frames,
        p50: q(m.hist, m.frames, 0.5),
        p95: q(m.hist, m.frames, 0.95),
        p99: q(m.hist, m.frames, 0.99),
        max: Math.round(m.max),
        hitches: m.hitches,
        heapMB: +m.heapMB.toFixed(1),
        gpuMB: +m.gpuMB.toFixed(1),
        gcYoung: m.gcYoung,
        gcOld: m.gcOld,
        causes: m.causes,
      })),
      worst: this.worst(10).map(strip),
      hitches: this.hitches.map(strip),
      timeline: { worstMsPerSecond: Array.from(this.secWorst.subarray(0, secs), (v) => Math.round(v)), framesPerSecond: Array.from(this.secFrames.subarray(0, secs)) },
      ...extra,
    };
  }

  dispose(): void {
    for (const o of this.observers) o.disconnect();
    spans.on = false;
    if (this.prof.onFrame) this.prof.onFrame = undefined;
  }
}

function strip(h: Hitch): Omit<Hitch, 'pf'> {
  const { pf, ...rest } = h;
  void pf;
  return rest;
}

/** the steps timed inside another (src/scenes/level.ts's render and judge) */
const KIDS: Record<string, string[]> = { render: ['mesh'], judge: ['rockbodies'] };

/** a step's family ('slide.move' → 'slide', 'write.gpu' → 'write'): causes group by it */
function base(label: string): string {
  const i = label.indexOf('.');
  return i > 0 ? label.slice(0, i) : label;
}

/** the timeline's colours: a cause's family, ordered by how much it matters (a second keeps the highest) */
export const CAUSES = ['', 'browser', 'task', 'gc', 'gpu', 'gpu-busy', 'gpu-held', 'async', 'cpu'];
export const CAUSE_COLOURS = ['#0000', '#888', '#a7f', '#f5d', '#fa3', '#fd0', '#f80', '#3cf', '#f33'];

export function causeIndex(cause: string): number {
  const fam = cause.startsWith('cpu') ? 'cpu' : cause.startsWith('async') ? 'async' : cause;
  const i = CAUSES.indexOf(fam);
  return i < 0 ? 1 : i;
}
