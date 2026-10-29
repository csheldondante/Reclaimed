// Round 101 (bench): the calibration benchmark (`?bench=1`). The user (DECISIONS round 101): "Can you build a
// calibration test that we can run on the phone to directly give you benchmark numbers? … so you can compute
// throughput and then target the actual bottlenecks." One tap, about 12 minutes (v3: the A/B, five window sizes, pans to 320 and the fastest pan each sustains), then a report (one versioned JSON)
// to download, copy or share. It instruments and never optimises: every system runs as the deployed page runs it.
//
// The suite is a chain of page loads, its state in localStorage between them (docs/ARCHITECTURE.md "Benchmark"):
//   start   (no level) device facts; the fixed GPU workload (thermal, first); readback, upload and GPU-copy rates
//   main    the atlas level at the viewer's range: parked frames; region generation stage by stage; regions/s at 1, 2,
//           4 and 8 tiles a frame; agents at 100/500/2000; render scales; the disk store; the scenarios — riding
//           (driveprofile's route), pans at 80 and 120, a warp across the atlas
//   hero    ?run=bell, the hero walked by the pad's scripted stick: frames, the camera's zoom and what it shows
//   win*    the other window sizes (256/320/384), parked
//   final   (no level) the fixed workload again (the drift), the derived throughput, the report
// Each number: its unit, the samples, p50/p95/max. GPU times are timestamp-query's where the adapter has it; else
// wall-clock around an isolated submit (queue.onSubmittedWorkDone), labelled so ("wall").

import { landFrom } from '../atlas/atlas';
import { stampWays } from '../atlas/ways';
import { GPUGEN } from '../atlas/finish';
import { SETTLE } from '../sim/sleep';
import { warpWindow } from '../api/atlas-world';
import { cpuStats } from '../gpu/cpustat';
import type { Profiler } from '../gpu/profiler';
import type { Host, Scene } from '../scenes/world-core';
import { RANGES } from '../scenes/range';
import { RegionStore } from '../world/region-store';
import type { HitchBoot } from './start';
import { copyText, deviceTag, downloadJson, postDev, shareJson, stamp } from './report-io';

/** (v3) vite.config.ts `define`: the build's time */
declare const __BENCH_BUILD__: string;

export const BENCH_VERSION = 4;
const STATE = 'reclaimed.bench.state';
/** (v3) the build, on the start page: vite.config.ts defines it at build time */
const BUILD: string = typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev';
const LAST = 'reclaimed.bench.last';
const ROW_H = Math.sqrt(3) / 2;
/** the riding scenario's start (scripts/hitchrun.mjs: a road in a temperate place on the default seed) */
const RIDE_AT = '15024,14337';
/** the URL keys the suite sets itself (the rest of the start page's URL is carried to every page) */
const OWN = ['bench', 'benchpage', 'benchsmoke', 'panzooms', 'run', 'win', 'drive', 'at', 'hitch', 'hitchhud', 'world', 'skipmenu', 'level', 'tutorial', 'perf'];

// ---------- numbers ----------

export interface Stat {
  unit: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  min: number;
}

const r3 = (v: number) => (Number.isFinite(v) ? +v.toFixed(3) : v);

/** samples → their unit, count, p50/p95/max (null when none) */
export function stat(xs: number[], unit: string): Stat | null {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { unit, n: a.length, p50: r3(q(0.5)), p95: r3(q(0.95)), max: r3(a[a.length - 1]), mean: r3(a.reduce((s, v) => s + v, 0) / a.length), min: r3(a[0]) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** (v4) the bench's last sign of life (a frame it waited for, a step it began): the watchdog's */
let beat = performance.now();
let beatWhat = 'loading';
const frame = () =>
  new Promise<number>((r) =>
    requestAnimationFrame((t) => {
      beat = performance.now();
      r(t);
    }),
  );
const MB = 1048576;

/** (v2) the A/B's systems that may scale with the window (the window pages) */
const AB_WINDOW = ['simAll', 'renderprep', 'meshRebuild', 'shadow', 'grid', 'farLand'];
/**
 * (v4) The A/B on an active scene (the user: "it turns off systems to check perf but on a pretty static scene … those
 * systems sleep most of the time anyway"): while riding with a storm over the camera (land arriving wakes its chunks,
 * the rain wakes water and sediment), and at a meteor's lava
 */
const AB_RIDE = ['simAll', 'water', 'sediment', 'wind', 'lava', 'plants', 'otherSims', 'renderfields', 'particlesSim', 'agents', 'renderprep', 'meshRebuild', 'shadow', 'farLand', 'grid', 'voxelMesh', 'particlesDraw', 'waterDraw', 'plantsDraw'];
const AB_METEOR = ['simAll', 'lava', 'water', 'sediment', 'particlesSim', 'renderfields'];
/** (v3, round 102) the window sizes: the range button's three and two wider (the user: "crank up pan speed and view distance") */
const WINDOWS = [...RANGES, 448, 512];
/** (v3) the max-sustainable probe's pan speeds (cells/s), each held PROBE_S seconds */
const PROBE_SPEEDS = [80, 100, 125, 160, 200, 250, 320, 400, 500, 640];
const PROBE_S = 3;

/**
 * (v2) Are this GPU's per-pass timestamps to be trusted? Round 101's Pixel 9a (Mali, Valhall): each pass read
 * 20–100 ms though frames came every 16.7 ms — the passes' sum many frames long, and a frame's first-to-last span
 * (gpuFrame) longer than the frame interval. Untrusted when the passes' sum (p50) is over 1.5 frame intervals, or
 * the span (p50) over 1.25.
 */
export function judgeTimestamps(passSum: number[], span: number[], frames: number[]): { reliable: boolean | null; passSumP50: number | null; spanP50: number | null; frameP50: number | null; why: string } {
  const p = stat(passSum, 'ms')?.p50 ?? null;
  const g = stat(span, 'ms')?.p50 ?? null;
  const f = stat(frames, 'ms')?.p50 ?? null;
  if (p === null || g === null || f === null) return { reliable: null, passSumP50: p, spanP50: g, frameP50: f, why: 'no timestamps read back' };
  const bad: string[] = [];
  if (p > 1.5 * f) bad.push(`the passes sum to ${p} ms a frame, ${(p / f).toFixed(1)} frame intervals`);
  if (g > 1.25 * f) bad.push(`a frame's first-to-last span is ${g} ms against frames every ${f}`);
  return { reliable: !bad.length, passSumP50: p, spanP50: g, frameP50: f, why: bad.length ? `${bad.join('; ')}: per-pass GPU numbers unreliable (cumulative or overlapping) — use the A/B` : 'ok' };
}

/**
 * (v2) Timestamps three ways over the same work (six dispatches of a fixed kernel): each in its own compute pass
 * of one encoder (as the engine times its passes), each in its own encoder and submit, and all six in one pass —
 * against the wall clock of each. Shows whether a GPU's per-pass timestamps add up (Mali's didn't in the game).
 */
async function timestampModes(device: GPUDevice): Promise<Record<string, unknown>> {
  if (!device.features.has('timestamp-query')) return { error: 'no timestamp-query' };
  const N = 1 << 18;
  const buf = device.createBuffer({ size: N * 16, usage: GPUBufferUsage.STORAGE });
  const mod = device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> d: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= arrayLength(&d)) { return; }
  var v = d[i] + vec4f(f32(i & 255u) * 0.001);
  for (var k = 0u; k < 256u; k++) { v = fract(v * 1.37 + vec4f(0.11, 0.23, 0.31, 0.47)); }
  d[i] = v;
}`,
  });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  const K = 6;
  const qs = device.createQuerySet({ type: 'timestamp', count: 2 * K });
  const res = device.createBuffer({ size: 2 * K * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const read = async (n: number): Promise<number[]> => {
    const st = device.createBuffer({ size: n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.resolveQuerySet(qs, 0, n, res, 0);
    enc.copyBufferToBuffer(res, 0, st, 0, n * 8);
    device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const w = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(w[k * 2] + w[k * 2 + 1] * 4294967296);
    return out;
  };
  const pass = (enc: GPUCommandEncoder, k: number | null, dispatches = 1) => {
    const p = enc.beginComputePass(k === null ? {} : { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 } });
    p.setPipeline(pipe);
    p.setBindGroup(0, bg);
    for (let j = 0; j < dispatches; j++) p.dispatchWorkgroups(N / 64);
    p.end();
  };
  const modes: Record<string, { perPass: number[]; sum: number[]; span: number[]; wall: number[] }> = { onePassEach: { perPass: [], sum: [], span: [], wall: [] }, ownEncoderEach: { perPass: [], sum: [], span: [], wall: [] }, allInOnePass: { perPass: [], sum: [], span: [], wall: [] } };
  for (let rep = 0; rep < 6; rep++) {
    for (const m of Object.keys(modes)) {
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      if (m === 'onePassEach') {
        const enc = device.createCommandEncoder();
        for (let k = 0; k < K; k++) pass(enc, k);
        device.queue.submit([enc.finish()]);
      } else if (m === 'ownEncoderEach') {
        for (let k = 0; k < K; k++) {
          const enc = device.createCommandEncoder();
          pass(enc, k);
          device.queue.submit([enc.finish()]);
        }
      } else {
        const enc = device.createCommandEncoder();
        pass(enc, 0, K);
        device.queue.submit([enc.finish()]);
      }
      await device.queue.onSubmittedWorkDone();
      const wall = performance.now() - t0;
      const n = m === 'allInOnePass' ? 2 : 2 * K;
      const t = await read(n);
      const per: number[] = [];
      for (let k = 0; k < n / 2; k++) per.push((t[2 * k + 1] - t[2 * k]) / 1e6);
      // (the first warms up)
      if (rep === 0) continue;
      const mm = modes[m];
      mm.perPass.push(...per);
      mm.sum.push(per.reduce((a, v) => a + v, 0));
      mm.span.push((Math.max(...t) - Math.min(...t)) / 1e6);
      mm.wall.push(wall);
    }
  }
  buf.destroy();
  res.destroy();
  qs.destroy();
  const out: Record<string, unknown> = { what: `${K} dispatches of 2^18 threads x 256 fract-FMAs: timed per pass in one encoder, per pass each in its own encoder+submit, and as one pass` };
  for (const [m, v] of Object.entries(modes)) {
    const sum = stat(v.sum, 'GPU ms, the passes summed');
    const wall = stat(v.wall, 'ms wall, submit to onSubmittedWorkDone');
    out[m] = { perPass: stat(v.perPass, 'GPU ms a pass'), sum, span: stat(v.span, 'GPU ms first start to last end'), wall, sumOverWall: sum && wall ? r3(sum.p50 / wall.p50) : null };
  }
  return out;
}

// ---------- the pan benchmark (round 104) ----------

/**
 * (round 104) The user (verbatim): "Let's build a test of just panning in a straight line as fast as we can at zooms
 * that always keep all regions on screen drawn. I want to try both generating and intelligently streaming from disc to
 * memory to the GPU. I want to know on each device and at each zoom what is a max speed that is smooth, hitch free and
 * never lags behind the camera." From the hero's close zoom (14) to the sandbox's (2.76) and wider.
 */
const PAN_ZOOMS = [14, 8, 5, 3.5, 2.76, 2.2];
/** the widest window a page asks for (more and a phone's memory goes: the zoom is reported as not run) */
// (round 104: 640 — window 768 is ~650 MB of GPU memory before the pool and the meshes, ~1.1 KB a column (slidehitch's
// estimate): past what Chrome gives a Pixel 9a's GPU process; the phone's pan768 never finished loading)
const PAN_MAX_WINDOW = 640;
/** speeds (cells/s), each held PAN_STEP_S */
const PAN_SPEEDS = [10, 20, 40, 80, 120, 160, 240, 320, 480, 640];
const PAN_STEP_S = 3;
/** (round 104) a frame over this (ms) is over a 60 fps frame's budget, with room */
const PAN_BUDGET = 20;
/** the pass criteria: rendered fps, the longest frame, the p99, the screen in detail (none lost against parked) */
const PAN_FPS = 58;
const PAN_MAX_FRAME = 33;
const PAN_P99 = 20;

/**
 * The window a zoom needs: the screen's ground (the camera's view at the sandbox's turn, a quarter turn — its corners
 * as screenDeltaToWorld gives them) inside it, and a region more each side (the window slides a region at a time,
 * the camera off its middle by up to half of one) — whole regions, at least 256.
 */
export function panWindowFor(zoom: number, cssW: number, cssH: number, az = Math.PI / 4): number {
  const elev = Math.PI / 6;
  let mx = 0;
  let my = 0;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const wx = (sx * cssW) / 2 / zoom;
    const wy = (sy * cssH) / 2 / zoom / Math.sin(elev);
    const x = -Math.sin(az) * wx + Math.cos(az) * wy;
    const y = Math.cos(az) * wx + Math.sin(az) * wy;
    mx = Math.max(mx, Math.abs(x));
    my = Math.max(my, Math.abs(y));
  }
  const need = Math.max(2 * mx, (2 * my) / ROW_H) + 2 * 64;
  return Math.max(256, Math.ceil(need / 64) * 64);
}

function panPlan(cssW: number, cssH: number, smoke: boolean, win = 0): { zooms: { zoom: number; window: number; run: boolean }[]; pages: { window: number; zooms: number[] }[] } {
  const zs = (smoke ? [14, 5] : PAN_ZOOMS).map((zoom) => {
    // (round 104, ?panwin=N: every zoom at window N — the tile cache's beyond it)
    const w = win || panWindowFor(zoom, cssW, cssH);
    return { zoom, window: w, run: w <= PAN_MAX_WINDOW };
  });
  const pages: { window: number; zooms: number[] }[] = [];
  for (const z of zs) {
    if (!z.run) continue;
    const pg = pages.find((p) => p.window === z.window) ?? (pages.push({ window: z.window, zooms: [] }), pages[pages.length - 1]);
    pg.zooms.push(z.zoom);
  }
  pages.sort((a, b) => a.window - b.window);
  return { zooms: zs, pages };
}

/**
 * (round 106, tilephone) The tiles' render-only land over a pan step: tiles baked a second, in flight now, each stage's
 * p50 / p95 ms (render/tilelandgpu.ts LandTimes: wanted to started — the queue; started to submitted — the land's GPU
 * work, paced; to baked; baked to drawn; all), of the regions drawn during the step, and the leading half's share out of
 * detail (mean, worst).
 */
function tileStepOf(T: any, baked0: number, t0: number, secs: number, lead: number[]): Record<string, unknown> {
  const L = (T.land.latencies as { wanted: number; start: number; mapped: number; cur: number; baked: number; drawn: number }[]).filter((t) => t.drawn >= t0);
  const q = (a: number[], f: number) => (a.length ? r3(a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))]) : null);
  const st = (f: (t: (typeof L)[number]) => number) => {
    const a = L.map(f).filter((x) => Number.isFinite(x));
    return [q(a, 0.5), q(a, 0.95)];
  };
  return {
    perSecond: r3(((T.land.stats.baked as number) - baked0) / secs),
    inFlight: T.land.stats.inFlight,
    n: L.length,
    queue: st((t) => t.start - t.wanted),
    land: st((t) => t.mapped - t.start),
    toBake: st((t) => t.baked - t.mapped),
    toDrawn: st((t) => t.drawn - t.baked),
    total: st((t) => t.drawn - t.wanted),
    leadOut: lead.length ? [r3(lead.reduce((a, v) => a + v, 0) / lead.length), r3(Math.max(...lead))] : null,
  };
}

function makePanReport(s: BenchState): Record<string, unknown> {
  const res = s.results as Record<string, any>;
  const rows: Record<string, unknown>[] = [];
  for (const [k, v] of Object.entries(res))
    if (/^pan\d+$/.test(k) && v?.zooms)
      for (const z of v.zooms as any[])
        for (const src of ['generated', 'disk', 'pool'])
          if (z[src]) {
            const st = (z[src].steps ?? []) as any[];
            const worstSlide = st.reduce((m, x) => Math.max(m, x.max ?? 0), 0);
            rows.push({ zoom: z.zoom, window: v.window?.w ?? null, source: src, parked: z.parked ?? null, maxSmooth: z[src].maxSmooth, failedFirst: z[src].failedFirst, at: z[src].failedAt, maxNoPopIn: z[src].maxNoPopIn, popInAt: z[src].popInAt, worstFrameMs: r3(worstSlide), overBudgetPerSlide: st.map((x) => `${x.speed}:${x.overBudgetPerSlide ?? '-'}`).join(' '), tilesPerSecond: st.map((x) => `${x.speed}:${x.tiles?.perSecond ?? '-'}`).join(' '), tileLatency: st.map((x) => `${x.speed}:${x.tiles?.total?.[0] ?? '-'}/${x.tiles?.total?.[1] ?? '-'}`).join(' '), leadOut: st.map((x) => `${x.speed}:${x.tiles?.leadOut?.[0] ?? '-'}`).join(' '), causesAtFail: z[src].causesAtFail, coverParked: z.coverParked });
          }
  const plan = res.panPlan as { zooms: { zoom: number; window: number; run: boolean }[] } | undefined;
  return {
    kind: 'reclaimed-bench-pan',
    version: BENCH_VERSION,
    id: s.id,
    startedAt: s.startedAt,
    finishedAt: new Date().toISOString(),
    build: location.origin + location.pathname,
    summary: {
      note: 'per zoom and land source: the fastest straight pan (cells/s) that held every criterion, and the criterion that failed first one step above',
      criteria: `smooth: rendered fps >= ${PAN_FPS}, no frame over ${PAN_MAX_FRAME} ms, p99 <= ${PAN_P99} ms and no pop-in, each step ${PAN_STEP_S} s; no pop-in: none of the screen out of detail against parked, frames as they come; overBudgetPerSlide: frames over ${PAN_BUDGET} ms per slide at each speed`,
      device: `${res.device?.adapter?.vendor ?? '?'} ${res.device?.adapter?.architecture ?? ''}, dpr ${res.device?.devicePixelRatio}, css ${res.device?.css?.w}x${res.device?.css?.h}`,
      table: rows.map((r: any) => `zoom ${r.zoom} window ${r.window} ${r.source}: parked ${r.parked?.fps ?? '?'} fps p99 ${r.parked?.p99 ?? '?'}; smooth to ${r.maxSmooth ?? 'none'} c/s${r.failedFirst ? ` (then ${r.failedFirst} at ${r.at})` : ''}; no pop-in to ${r.maxNoPopIn ?? 'none'} c/s${r.popInAt ? ` (pop-in at ${r.popInAt})` : ''}; worst frame ${r.worstFrameMs} ms; tiles/s ${r.tilesPerSecond}; tile ms p50/p95 ${r.tileLatency}; leading half out ${r.leadOut}`),
      notRun: plan?.zooms.filter((z) => !z.run).map((z) => `zoom ${z.zoom} needs window ${z.window} (over ${PAN_MAX_WINDOW})`) ?? [],
      errors: s.errors.length,
    },
    rows,
    errors: s.errors,
    ...s.results,
  };
}

function panSummary(r: Record<string, any>): string {
  return [`device: ${r.summary?.device}`, ...(r.summary?.table ?? []), ...(r.summary?.notRun ?? []), `errors: ${r.errors?.length ?? 0}`].join('\n');
}

// ---------- the suite's state ----------

interface PageSpec {
  name: string;
  params: Record<string, string>;
}

interface BenchState {
  /** (round 104) which suite: the full one (?bench=1) or the pan benchmark (?bench=pan) */
  suite?: 'full' | 'pan';
  version: number;
  id: string;
  startedAt: string;
  step: number;
  pages: PageSpec[];
  base: string;
  /** world ids the level pages saved into (cleared at the end: the viewer's own world is never touched) */
  worlds: string[];
  results: Record<string, unknown>;
  errors: string[];
  done?: boolean;
}

// (v4) The pages' results live in IndexedDB; localStorage keeps only the chain (pages, step, errors: a few KB). The
// origin's localStorage is shared by every branch's build — on the Pixel 9a v3's main page couldn't keep its results
// there and the chain stopped; a headless run with it filled to the brim lost every page's numbers to the fallback.
const IDB = 'reclaimed-bench';
let idbP: Promise<IDBDatabase | null> | null = null;
function idb(): Promise<IDBDatabase | null> {
  return (idbP ??= new Promise((res) => {
    try {
      const r = indexedDB.open(IDB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch {
      res(null);
    }
  }));
}
async function idbPut(key: string, value: unknown): Promise<boolean> {
  const db = await idb();
  if (!db) return false;
  return new Promise((res) => {
    try {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(value, key);
      t.oncomplete = () => res(true);
      t.onerror = () => res(false);
      t.onabort = () => res(false);
    } catch {
      res(false);
    }
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  if (!db) return undefined;
  return new Promise((res) => {
    try {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result as T | undefined);
      r.onerror = () => res(undefined);
    } catch {
      res(undefined);
    }
  });
}
/** states whose results were loaded (or made) whole: only those write their results (a skeleton would blank them) */
const whole = new WeakSet<BenchState>();
/** the last results write, waited for before the page goes */
let pending: Promise<unknown> = Promise.resolve();
/** IndexedDB refused: the results go in localStorage as before (v4's compacting save) */
let idbFailed = false;

function load(): BenchState | null {
  try {
    const s = JSON.parse(localStorage.getItem(STATE) ?? 'null') as BenchState | null;
    if (!s || s.version !== BENCH_VERSION) return null;
    s.results ??= {};
    // (results kept in localStorage — IndexedDB refused — make it whole)
    if (Object.keys(s.results).length) whole.add(s);
    return s;
  } catch {
    return null;
  }
}

/** the state with its results (IndexedDB's over any localStorage held) */
async function loadFull(): Promise<BenchState | null> {
  const s = load();
  if (!s) return null;
  const r = await idbGet<Record<string, unknown>>(`results:${s.id}`);
  if (r) s.results = { ...r, ...s.results };
  whole.add(s);
  return s;
}

function save(s: BenchState): void {
  if (whole.has(s) && !idbFailed) {
    const results = s.results;
    const id = s.id;
    // (a copy: the results go on changing while the write is under way)
    const copy = JSON.parse(JSON.stringify(results));
    pending = pending.then(() =>
      idbPut(`results:${id}`, copy).then((ok) => {
        if (!ok) idbFailed = true;
      }),
    );
    const skeleton = { ...s, results: {} };
    try {
      localStorage.setItem(STATE, JSON.stringify(skeleton));
      return;
    } catch {
      // (even the skeleton didn't fit: the fallback below)
    }
  }
  const body = JSON.stringify(s);
  try {
    localStorage.setItem(STATE, body);
    return;
  } catch {
    // (v4: full — the origin is shared by every branch's build; room made below)
  }
  // the previous run's stored report first, then the pages' details (the summary-worthy numbers stay)
  try {
    localStorage.removeItem(LAST);
    localStorage.setItem(STATE, body);
    s.errors.push('localStorage was full: the previous run\'s stored report was dropped to make room');
    localStorage.setItem(STATE, JSON.stringify(s));
    return;
  } catch {
    // (still full)
  }
  const slim = JSON.parse(body) as BenchState;
  for (const r of Object.values(slim.results) as Record<string, unknown>[])
    if (r && typeof r === 'object')
      for (const c of Object.values(r) as Record<string, unknown>[])
        if (c && typeof c === 'object') {
          delete c.gpuPasses;
          delete c.cpuSteps;
          delete c.hitch;
          delete c.stream;
        }
  slim.errors.push('localStorage was full: per-capture details (passes, CPU steps, hitches) dropped');
  try {
    localStorage.setItem(STATE, JSON.stringify(slim));
    return;
  } catch {
    // (still full: the pages' numbers go, the chain goes on — the report says what was lost)
  }
  for (const k of Object.keys(slim.results)) {
    const r = slim.results[k] as Record<string, unknown> | undefined;
    const keep: Record<string, unknown> = { dropped: 'localStorage full' };
    if (r && typeof r === 'object') for (const f of ['page', 'error', 'readyAtMs', 'pageMs']) if (f in r) keep[f] = r[f];
    if (!['device', 'timestampModes', 'thermalStart'].includes(k)) slim.results[k] = keep;
  }
  slim.errors.push('localStorage was full even slimmed: the numbers of the pages dropped (free space on this site: other builds saves)');
  try {
    localStorage.setItem(STATE, JSON.stringify(slim));
  } catch (e) {
    throw new Error(`bench: localStorage refused even the suite's bare state (${(e as Error).message}) — the benchmark needs it between pages`);
  }
}

/** (v3) the page is navigating to the next: a device lost now is the page going, not a crash */
let leaving = false;

function go(s: BenchState): void {
  if (leaving) return;
  leaving = true;
  s.step++;
  try {
    save(s);
  } catch (e) {
    // (v4: the state couldn't be kept — said on screen, not a silent stall)
    leaving = false;
    s.step--;
    showStall(`the benchmark can't save its state: ${(e as Error).message}`);
    throw e;
  }
  const p = s.pages[s.step];
  // (v4: this page's GPU memory freed before the next page asks for a device — the phone's next page never came up;
  // the readbacks still in flight reject as the device goes — expected now, not page errors)
  window.addEventListener('unhandledrejection', (e) => {
    if (leaving) e.preventDefault();
  });
  try {
    pageDevice?.destroy();
  } catch {
    // (already gone)
  }
  pageDevice = null;
  const q = new URLSearchParams(s.base);
  q.set('bench', s.suite === 'pan' ? 'pan' : '1');
  q.set('benchpage', p.name);
  for (const [k, v] of Object.entries(p.params)) q.set(k, v);
  const to = `${location.pathname}?${q.toString()}`;
  // (the results' write landed first — at most 5 s)
  void Promise.race([pending, sleep(5000)]).then(() => {
    location.href = to;
  });
}

/** What this page is in the suite: the start screen, a level page, the end — or not the benchmark at all. */
export function benchMode(params: URLSearchParams): 'start' | 'final' | 'level' | 'skip' | null {
  if (params.get('bench') !== '1' && params.get('bench') !== 'pan') return null;
  const page = params.get('benchpage');
  const s = load();
  if (!page || !s || s.done || s.pages[s.step]?.name !== page) return 'start';
  if (page === 'final') return 'final';
  // (v3: a level page loaded a second time never finished the first — the tab killed, the device lost: skipped)
  const ps = s.pages[s.step] as PageSpec & { tries?: number };
  ps.tries = (ps.tries ?? 0) + 1;
  save(s);
  return ps.tries > 1 ? 'skip' : 'level';
}

/** (v4) the page's GPU device: destroyed before going to the next page, so its memory is free when that page asks */
let pageDevice: GPUDevice | null = null;

/** (v4) the GPU is up: the watchdog's GPU wait is over; the device kept to be let go before the next page */
export function benchGpuUp(device: GPUDevice): void {
  pageDevice = device;
  if (beatWhat === 'gpu') {
    beat = performance.now();
    beatWhat = 'loading';
  }
}

/** (v4) the end page's GPU, or null when it doesn't come up in 20 s (the report is shown without the thermal step) */
export async function benchGpu<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 20000))]);
}

/** (round 104) where a level page's load is (level.ts sets it) and the memory, for an error's note */
export function benchStageNote(): string {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const gpuMem = (window as unknown as { reclaimedHitch?: { mem?: { liveBytes(): number } } }).reclaimedHitch?.mem?.liveBytes?.();
  const stage = (globalThis as { __benchStage?: string }).__benchStage ?? 'before the level';
  return ` (at "${beatWhat === 'loading' || beatWhat === 'gpu' ? stage : beatWhat}"; JS heap ${mem ? `${(mem.usedJSHeapSize / MB).toFixed(0)} of ${(mem.jsHeapSizeLimit / MB).toFixed(0)} MB` : 'n/a'}; GPU buffers alive ${gpuMem !== undefined ? `${(gpuMem / MB).toFixed(0)} MB` : 'n/a'})`;
}

/** (v4) a stall said on screen (the watchdog's, a failed save): big, not a console line */
function showStall(msg: string): void {
  const d = document.getElementById('bench-stall') ?? document.body.appendChild(document.createElement('div'));
  d.id = 'bench-stall';
  d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:max(8px,env(safe-area-inset-bottom));z-index:70;background:#600d;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px';
  d.textContent = msg;
}

/**
 * (v4) The watchdog (the user: "it goes grey and never resumes"): a level page with no sign of life from the bench — a
 * frame it waited for or a step it began — for 60 s (150 s while the level loads) records why, says so on screen and
 * goes on to the next page. JS has to run for it to fire: a main thread that never returns can't be caught here.
 */
export function benchWatchdog(): void {
  const started = performance.now();
  beat = started;
  beatWhat = 'gpu';
  setInterval(() => {
    if (leaving) return;
    const now = performance.now();
    const loading = beatWhat === 'loading';
    const limit = beatWhat === 'gpu' ? 30000 : loading ? 150000 : 60000;
    const quiet = now - (loading ? Math.max(beat, started) : beat);
    if (quiet < limit) return;
    const s = load();
    const page = s?.pages[s.step]?.name ?? '?';
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const gpuMem = (window as unknown as { reclaimedHitch?: { mem?: { liveBytes(): number } } }).reclaimedHitch?.mem?.liveBytes?.();
    const where = loading ? ` (the load at "${(globalThis as { __benchStage?: string }).__benchStage ?? 'before the level'}"; JS heap ${mem ? `${(mem.usedJSHeapSize / MB).toFixed(0)} of ${(mem.jsHeapSizeLimit / MB).toFixed(0)} MB` : 'n/a'}; GPU buffers alive ${gpuMem !== undefined ? `${(gpuMem / MB).toFixed(0)} MB` : 'n/a'}; device memory ${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? '?'} GB)` : '';
    const why = beatWhat === 'gpu' ? `${page}: the GPU didn't come up in ${(quiet / 1000).toFixed(0)} s (requestAdapter/requestDevice pending) — the watchdog moved on` : `${page}: no progress for ${(quiet / 1000).toFixed(0)} s at "${beatWhat}"${where} — the watchdog moved on`;
    showStall(`${why}. Next page…`);
    benchSkip(why, true);
  }, 5000);
}

/** (v3) while a level page loads (the grey screen): which page of the run this is, so it never looks finished */
export function benchLoadingNote(ui: HTMLElement): void {
  const s = load();
  if (!s) return;
  const d = document.createElement('div');
  d.id = 'bench-loading';
  d.style.cssText = 'position:fixed;left:8px;right:8px;top:max(8px,env(safe-area-inset-top));z-index:60;background:#000d;color:#e6f0e8;font:14px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px';
  d.textContent = `Benchmark running: page ${s.step} of ${s.pages.length - 1} (${s.pages[s.step]?.name}) loading — don't close. The report comes at the end.`;
  ui.appendChild(d);
}

/** (v3) this page didn't finish: noted, and on to the next */
export function benchSkip(why: string, keep = false): void {
  if (leaving) return;
  void benchSkipNow(why, keep);
}
async function benchSkipNow(why: string, keep: boolean): Promise<void> {
  const s = await loadFull();
  if (!s || leaving) return;
  const page = s.pages[s.step]?.name ?? '?';
  s.errors.push(why.startsWith(`${page}:`) ? why : `${page}: ${why}`);
  // (what the page measured before it stopped is kept: its last checkpoint)
  const had = s.results[page] as Record<string, unknown> | undefined;
  s.results[page] = keep && had ? { ...had, error: why } : { ...(had ?? {}), page, error: why };
  go(s);
}

// ---------- the UI (drawn between measurements only) ----------

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake(): Promise<boolean> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl) return false;
    wakeLock = await wl.request('screen');
    return true;
  } catch {
    return false;
  }
}

class Panel {
  readonly el: HTMLDivElement;
  private line: HTMLDivElement;
  constructor(ui: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;left:8px;right:8px;top:max(8px,env(safe-area-inset-top));z-index:60;background:#000d;color:#e6f0e8;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;pointer-events:auto;max-height:90vh;overflow:auto';
    this.el.id = 'bench-panel';
    this.line = document.createElement('div');
    this.line.id = 'bench-say';
    this.el.appendChild(this.line);
    for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'mousedown', 'click']) this.el.addEventListener(ev, (e) => e.stopPropagation());
    ui.appendChild(this.el);
  }
  say(s: string): void {
    this.line.textContent = s;
  }
  button(label: string, big: boolean, f: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = big
      ? 'display:block;width:100%;margin:10px 0 4px;padding:16px;font:600 18px system-ui,sans-serif;background:#2d6a4f;color:#fff;border:0;border-radius:8px'
      : 'display:inline-block;margin:6px 6px 0 0;padding:10px 14px;font:15px system-ui,sans-serif;background:#234;color:#fff;border:1px solid #6a8;border-radius:6px';
    b.onclick = (e) => {
      e.stopPropagation();
      f();
    };
    this.el.appendChild(b);
    return b;
  }
  text(s: string, small = false): HTMLDivElement {
    const d = document.createElement('div');
    d.style.cssText = small ? 'font:11px/1.35 ui-monospace,monospace;white-space:pre-wrap;margin-top:6px;color:#bcd' : 'margin-top:6px;white-space:pre-line';
    d.textContent = s;
    this.el.appendChild(d);
    return d;
  }
}

// ---------- GPU timing ----------

/** The suite's own timestamp queries (a Profiler-shaped `timestamps(name)` for the code it lends itself to). */
export class GpuTimer {
  readonly on: boolean;
  private qs?: GPUQuerySet;
  private names: string[] = [];
  private cap = 512;
  constructor(private device: GPUDevice) {
    this.on = device.features.has('timestamp-query');
    if (this.on) this.qs = device.createQuerySet({ type: 'timestamp', count: this.cap });
  }
  timestamps(name: string): GPUComputePassTimestampWrites | undefined {
    if (!this.qs || this.names.length * 2 + 2 > this.cap) return undefined;
    const i = this.names.length * 2;
    this.names.push(name);
    return { querySet: this.qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 };
  }
  /** every pass timed since the last read: its ms, by name (after the work was submitted) */
  async read(): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const n = this.names.length;
    if (!this.qs || !n) return out;
    const names = this.names;
    this.names = [];
    const dev = this.device;
    const res = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const st = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: 'bench timestamps' });
    enc.resolveQuerySet(this.qs, 0, n * 2, res, 0);
    enc.copyBufferToBuffer(res, 0, st, 0, n * 16);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const w = new Uint32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    res.destroy();
    const ns = (k: number) => w[k * 2] + w[k * 2 + 1] * 4294967296;
    for (let p = 0; p < n; p++) {
      const ms = (ns(p * 2 + 1) - ns(p * 2)) / 1e6;
      // (a pass the driver didn't time comes back 0 or backwards: left out, not counted as free)
      if (!(ms > 0 && ms < 10000)) continue;
      (out.get(names[p]) ?? out.set(names[p], []).get(names[p])!).push(ms);
    }
    return out;
  }
}

/** The fixed workload (thermal state): ALU over a 16 MB buffer, the same at the start and the end. */
async function fixedWorkload(device: GPUDevice, timer: GpuTimer, reps = 10): Promise<Record<string, unknown>> {
  const N = 1 << 20;
  const buf = device.createBuffer({ size: N * 16, usage: GPUBufferUsage.STORAGE });
  const mod = device.createShaderModule({
    code: `@group(0) @binding(0) var<storage, read_write> d: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 1048576u;
  if (i >= arrayLength(&d)) { return; }
  var v = d[i] + vec4f(f32(i & 255u) * 0.001);
  for (var k = 0u; k < 192u; k++) { v = fract(v * 1.37 + vec4f(0.11, 0.23, 0.31, 0.47)); }
  d[i] = v;
}`,
  });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  const gpu: number[] = [];
  const wall: number[] = [];
  for (let k = 0; k < reps + 3; k++) {
    const enc = device.createCommandEncoder({ label: 'bench fixed workload' });
    const p = enc.beginComputePass({ timestampWrites: timer.timestamps('fixed') });
    p.setPipeline(pipe);
    p.setBindGroup(0, bg);
    p.dispatchWorkgroups(N / 64);
    p.end();
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    const ms = performance.now() - t0;
    // (three to warm the clocks up, not counted)
    if (k >= 3) wall.push(ms);
    const t = (await timer.read()).get('fixed');
    if (k >= 3 && t) gpu.push(...t);
  }
  buf.destroy();
  return { what: '2^20 threads x 192 fract-FMA iterations over a 16 MB buffer, one dispatch', gpu: timer.on ? stat(gpu, 'ms') : 'n/a', wall: stat(wall, 'ms (wall: submit to onSubmittedWorkDone)') };
}

/** Readback, upload and GPU-copy rates (isolated submits; wall-clock — there's no timestamp for a copy). */
async function ioRates(device: GPUDevice, quick = false): Promise<Record<string, unknown>> {
  const BIG = 34 * MB;
  const src = device.createBuffer({ size: BIG, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const dst = device.createBuffer({ size: BIG, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const host = new Uint8Array(BIG);
  for (let i = 0; i < BIG; i += 4096) host[i] = i & 255;
  device.queue.writeBuffer(src, 0, host);
  await device.queue.onSubmittedWorkDone();
  const readOnce = async (bytes: number) => {
    const st = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder({ label: 'bench readback' });
    enc.copyBufferToBuffer(src, 0, st, 0, bytes);
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const t1 = performance.now();
    const copy = st.getMappedRange().slice(0);
    const t2 = performance.now();
    st.unmap();
    st.destroy();
    void copy;
    return { latency: t1 - t0, copyOut: t2 - t1 };
  };
  const sizes: [string, number, number][] = quick
    ? [
        ['1MB', 1 * MB, 5],
        ['8MB', 8 * MB, 3],
      ]
    : [
        ['0.1MB', 0.1 * MB, 10],
        ['1MB', 1 * MB, 8],
        ['8MB', 8 * MB, 5],
        ['34MB', BIG, 3],
      ];
  const readback: Record<string, unknown> = {};
  for (const [name, bytes, reps] of sizes) {
    const b = Math.ceil(bytes / 4) * 4;
    const lat: number[] = [];
    const out: number[] = [];
    for (let k = 0; k < reps; k++) {
      const r = await readOnce(b);
      lat.push(r.latency);
      out.push(r.copyOut);
    }
    const l = stat(lat, 'ms (submit to mapAsync resolved)');
    readback[name] = { bytes: b, latency: l, getMappedRangeCopy: stat(out, 'ms'), MBps: l ? +(b / MB / (l.p50 / 1000)).toFixed(1) : null };
  }
  let contention: unknown = null;
  if (!quick) {
    // a small readback asked right after a big one: does it wait for the big one?
    const small: number[] = [];
    const big: number[] = [];
    for (let k = 0; k < 3; k++) {
      const [a, s] = await Promise.all([readOnce(BIG), readOnce(Math.ceil((0.1 * MB) / 4) * 4)]);
      big.push(a.latency);
      small.push(s.latency);
    }
    const alone = (readback['0.1MB'] as { latency: Stat }).latency;
    const s = stat(small, 'ms');
    contention = { small0p1MBAfter34MB: s, big34MB: stat(big, 'ms'), small0p1MBAlone: alone?.p50 ?? null, delayedBy: s && alone ? +(s.p50 - alone.p50).toFixed(2) : null, unit: 'ms' };
  }
  const upload: Record<string, unknown> = {};
  for (const [name, bytes, reps] of (quick ? [['8MB', 8 * MB, 3]] : [['1MB', 1 * MB, 5], ['8MB', 8 * MB, 5], ['34MB', BIG, 3]]) as [string, number, number][]) {
    const call: number[] = [];
    const done: number[] = [];
    for (let k = 0; k < reps; k++) {
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      device.queue.writeBuffer(dst, 0, host, 0, bytes);
      const t1 = performance.now();
      await device.queue.onSubmittedWorkDone();
      call.push(t1 - t0);
      done.push(performance.now() - t0);
    }
    const d = stat(done, 'ms (writeBuffer to onSubmittedWorkDone)');
    upload[name] = { bytes, call: stat(call, 'ms (the writeBuffer call, CPU)'), done: d, MBps: d ? +(bytes / MB / (d.p50 / 1000)).toFixed(1) : null };
  }
  const copy: number[] = [];
  for (let k = 0; k < (quick ? 2 : 4); k++) {
    const enc = device.createCommandEncoder({ label: 'bench copy' });
    for (let j = 0; j < 4; j++) enc.copyBufferToBuffer(j & 1 ? dst : src, 0, j & 1 ? src : dst, 0, BIG);
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    copy.push(performance.now() - t0);
  }
  const c = stat(copy, 'ms (wall: four 34 MB copies in one submit)');
  src.destroy();
  dst.destroy();
  return { readback, contention, upload, gpuCopy: { per4x34MB: c, MBps: c ? +((4 * BIG) / MB / (c.p50 / 1000)).toFixed(0) : null, how: 'wall' } };
}

// ---------- device facts ----------

async function deviceFacts(host: Host): Promise<Record<string, unknown>> {
  const { adapter, device } = host.gpu;
  const lim = (l: GPUSupportedLimits) => {
    const o: Record<string, number> = {};
    for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension', 'maxTextureDimension2D', 'maxUniformBufferBindingSize', 'maxBindGroups'])
      o[k] = (l as unknown as Record<string, number>)[k];
    return o;
  };
  const info = adapter.info as unknown as Record<string, unknown>;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  let hints: unknown = null;
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<unknown> } }).userAgentData;
    if (uad) hints = await uad.getHighEntropyValues(['model', 'platform', 'platformVersion', 'architecture', 'fullVersionList']);
  } catch {
    hints = null;
  }
  return {
    adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description },
    features: [...adapter.features].sort(),
    timestampQuery: device.features.has('timestamp-query'),
    adapterLimits: lim(adapter.limits),
    deviceLimits: lim(device.limits),
    ua: navigator.userAgent,
    clientHints: hints,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    performanceMemory: mem ? { usedMB: +(mem.usedJSHeapSize / MB).toFixed(1), totalMB: +(mem.totalJSHeapSize / MB).toFixed(1), limitMB: +(mem.jsHeapSizeLimit / MB).toFixed(0) } : null,
    // (v4: localStorage is shared by every build on the origin — the Pixel 9a's v3 main page lost its state)
    localStorage: (() => {
      try {
        const keys: [string, number][] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)!;
          keys.push([k, (localStorage.getItem(k) ?? '').length]);
        }
        keys.sort((a, b) => b[1] - a[1]);
        return { keys: keys.length, chars: keys.reduce((a, [, n]) => a + n, 0), top: keys.slice(0, 6).map(([k, n]) => `${k} ${n}`) };
      } catch (e) {
        return { error: String(e) };
      }
    })(),
    storageEstimate: await (navigator.storage?.estimate?.() ?? Promise.resolve(null)).then((e) => (e ? { usageMB: +((e.usage ?? 0) / MB).toFixed(1), quotaMB: +((e.quota ?? 0) / MB).toFixed(0) } : null)).catch(() => null),
    devicePixelRatio: devicePixelRatio,
    screen: { w: screen.width, h: screen.height },
    css: { w: innerWidth, h: innerHeight },
    quality: { tier: host.qualityName, ...host.quality },
  };
}

// ---------- the start and the end (no level) ----------

/** The start screen (one tap), or the end (the report). Runs instead of a scene: nothing else draws. */
export async function benchStandalone(mode: 'start' | 'final', host: Host | null): Promise<void> {
  const panel = new Panel(host?.ui ?? document.getElementById('ui') ?? document.body);
  if (mode === 'final') return finish(host, panel);
  if (!host) return;
  panel.text(`Reclaimed calibration benchmark — bench v${BENCH_VERSION}, build ${BUILD}`);
  const cut = await loadFull();
  // (v3, the user: "because the report finished once it shows the download option mid test whenever it goes to the
  // grey loading screen so it wasn't possible for me to tell when it was done" — a run in progress shows only that)
  if (cut && !cut.done && cut.step > 0) {
    const page = cut.pages[cut.step];
    if (new URLSearchParams(location.search).get('benchpage')) {
      // (mid-chain on the wrong page — a reload, a restored tab: back to the page the run is on)
      panel.say(`Benchmark running: page ${cut.step} of ${cut.pages.length - 1} (${page?.name}) — don't close`);
      setTimeout(() => goTo(cut), 1500);
      return;
    }
    panel.say(`Benchmark running (or cut off): page ${cut.step} of ${cut.pages.length - 1}, ${page?.name}. Don't close it if it's still going.`);
    panel.button('Carry on from the next page', true, () => {
      cut.errors.push(`${page?.name}: stopped (the page was left or crashed)`);
      go(cut);
    });
    panel.button('Start again', false, () => void start(host, panel));
    const more = panel.text('');
    const btn = panel.button('Stuck? Download what it has (incomplete)', false, () => {
      btn.remove();
      reportButtons(panel, partialReport(cut));
    });
    void more;
    return;
  }
  panel.text('About 12 minutes. The page reloads itself a few times — leave it in front, plugged in if you can, and don’t touch the screen till the report shows. Your own saved world isn’t touched.');
  const last =
    (await idbGet<string>('last')) ??
    (() => {
      try {
        return localStorage.getItem(LAST);
      } catch {
        return null;
      }
    })();
  panel.button('Start benchmark', true, () => void start(host, panel));
  if (last) {
    let label = 'previous run';
    try {
      const r = JSON.parse(last) as { version?: number; finishedAt?: string; startedAt?: string };
      label = `previous run (bench v${r.version ?? '?'}, ${(r.finishedAt ?? r.startedAt ?? '').slice(0, 16).replace('T', ' ')})`;
    } catch {
      // (unreadable: the plain label)
    }
    panel.text(`The ${label} is kept:`);
    reportButtons(panel, last, true);
  }
  panel.say('');
}

/** (v3) an unfinished run's report: marked incomplete, the pages done, the page it stopped on and why */
function partialReport(s: BenchState): string {
  const done = s.pages.slice(1, s.step).map((p) => p.name);
  const at = s.pages[s.step]?.name ?? null;
  const why = s.errors.filter((e) => at && e.startsWith(`${at}:`));
  const head = { incomplete: true, pagesDone: done, stoppedOn: at, why };
  try {
    return JSON.stringify({ ...head, ...makeReport(s) });
  } catch (e) {
    return JSON.stringify({ ...head, kind: 'reclaimed-bench', version: BENCH_VERSION, reportError: String(e), errors: s.errors, ...s.results });
  }
}

/** (v3) the page the run is on now (no step taken) */
function goTo(s: BenchState): void {
  s.step--;
  go(s);
}

async function start(host: Host, panel: Panel): Promise<void> {
  panel.el.querySelectorAll('button').forEach((b) => b.remove());
  const awake = await keepAwake();
  const old = await loadFull();
  const id = `${stamp()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const q = new URLSearchParams(location.search);
  for (const k of OWN) q.delete(k);
  const s: BenchState = { version: BENCH_VERSION, id, startedAt: new Date().toISOString(), step: 0, pages: [], base: q.toString(), worlds: old?.worlds ?? [], results: {}, errors: [] };
  whole.add(s);
  // (v4: an old run's report kept in localStorage moves out of the way — the origin's localStorage is shared)
  try {
    const was = localStorage.getItem(LAST);
    if (was) {
      await idbPut('last', was);
      localStorage.removeItem(LAST);
    }
  } catch {
    // (none)
  }
  // (a run cut short left its worlds: gone now)
  await clearWorlds(s);
  const world = `bench-${id}`;
  const common = { skipmenu: '1', level: 'atlas', tutorial: '0', hitch: '1', hitchhud: '0', world };
  const myWin = (() => {
    try {
      const v = Number(localStorage.getItem('reclaimed.atlasRange'));
      if (v >= 256) return v;
    } catch {
      // (no storage: the tier's)
    }
    return null;
  })();
  s.pages = [
    { name: 'start', params: {} },
    { name: 'main', params: { ...common, at: RIDE_AT, drive: '18' } },
    { name: 'pans', params: { ...common, at: RIDE_AT } },
    { name: 'hero', params: { ...common, run: 'bell' } },
  ];
  // the other window sizes (the main page has the viewer's own: the stored range, else the tier's)
  const own = myWin ?? (host.qualityName === 'low' && host.params.get('phone') !== '0' ? 320 : 256);
  for (const w of WINDOWS) if (w !== own) s.pages.push({ name: `win${w}`, params: { ...common, at: RIDE_AT, drive: '18', win: String(w) } });
  // (round 104, ?bench=pan: the pan benchmark's pages — a window per group of zooms)
  if (host.params.get('bench') === 'pan') {
    s.suite = 'pan';
    const plan = panPlan(innerWidth, innerHeight, host.params.get('benchsmoke') === '1', Number(host.params.get('panwin') ?? 0));
    s.results.panPlan = plan;
    s.pages = [s.pages[0], ...plan.pages.map((pg) => ({ name: `pan${pg.window}`, params: { ...common, at: RIDE_AT, win: String(pg.window), panzooms: pg.zooms.join('_') } }))];
  }
  // (v3, ?benchsmoke=1: the start, the hero and one window page, the end — a check that the chain works, ~3 min)
  if (host.params.get('benchsmoke') === '1' && s.suite !== 'pan') s.pages = [s.pages[0], s.pages.find((x) => x.name === 'hero')!, { name: 'win256', params: { ...common, at: RIDE_AT, drive: '18', win: '256' } }];
  s.pages.push({ name: 'final', params: {} });
  const t0 = performance.now();
  panel.say('device facts…');
  s.results.device = await deviceFacts(host);
  s.results.wakeLock = awake;
  const timer = new GpuTimer(host.gpu.device);
  panel.say('the fixed GPU workload (thermal, first)…');
  await frame();
  s.results.thermalStart = { at: new Date().toISOString(), ...(await fixedWorkload(host.gpu.device, timer)) };
  if (s.suite !== 'pan') {
    panel.say('timestamps three ways…');
    await frame();
    s.results.timestampModes = await timestampModes(host.gpu.device);
    panel.say('readback, upload and copy rates…');
    await frame();
    s.results.io = await ioRates(host.gpu.device);
  }
  s.results.startMs = Math.round(performance.now() - t0);
  panel.say('loading the atlas level…');
  go(s);
}

async function clearWorlds(s: BenchState): Promise<void> {
  for (const w of s.worlds) {
    try {
      const st = await RegionStore.open(w);
      await st.clear();
    } catch (e) {
      s.errors.push(`clearing ${w}: ${(e as Error).message}`);
    }
  }
  s.worlds = [];
}

function reportButtons(panel: Panel, body: string, previous = false): void {
  const status = panel.text('');
  const say = (m: string) => (status.textContent = m);
  let name = '';
  const nameOf = async () => {
    if (name) return name;
    let gpu = '';
    try {
      gpu = (JSON.parse(body) as { device?: { adapter?: { vendor?: string } } }).device?.adapter?.vendor ?? '';
    } catch {
      gpu = '';
    }
    return (name = `reclaimed-bench-${stamp()}-${await deviceTag(gpu)}.json`);
  };
  panel.button(previous ? 'Download previous run' : 'Download report', !previous, () => void nameOf().then((n) => say(downloadJson(body, n))));
  panel.button('Copy', false, () => void copyText(body).then(say, (e: Error) => say(`copy failed: ${e.message}`)));
  panel.button('Share…', false, () => void nameOf().then(async (n) => say((await shareJson(body, n, 'Reclaimed benchmark')) || 'this browser can’t share files: use Download')));
  panel.el.appendChild(status);
}

async function finish(host: Host | null, panel: Panel): Promise<void> {
  const s = (await loadFull())!;
  await keepAwake();
  if (host) {
    panel.say('the fixed GPU workload again (the drift)…');
    await sleep(1500);
    const timer = new GpuTimer(host.gpu.device);
    s.results.thermalEnd = { at: new Date().toISOString(), ...(await fixedWorkload(host.gpu.device, timer)) };
    s.results.ioEnd = await ioRates(host.gpu.device, true);
  } else s.errors.push('final: the GPU didn\'t come up in 20 s — the thermal drift and the end rates not measured');
  await clearWorlds(s);
  const report = s.suite === 'pan' ? makePanReport(s) : makeReport(s);
  const body = JSON.stringify(report);
  if (!(await idbPut('last', body)))
    try {
      localStorage.setItem(LAST, body);
    } catch {
      s.errors.push('neither IndexedDB nor localStorage kept the result: download it now');
    }
  s.done = true;
  save(s);
  await pending;
  (window as unknown as { reclaimedBench: unknown }).reclaimedBench = report;
  try {
    await wakeLock?.release();
  } catch {
    // (already let go)
  }
  panel.say(`Benchmark done — this run (bench v${BENCH_VERSION}, ${s.id}).`);
  panel.text(s.suite === 'pan' ? panSummary(report) : summary(report));
  reportButtons(panel, body);
  const dev = await postDev(body, 'bench');
  if (dev) panel.text(`dev server: ${dev}`, true);
  panel.button('Run again', false, () => {
    location.href = `${location.pathname}?bench=${s.suite === 'pan' ? 'pan' : '1'}`;
  });
}

// ---------- a level page ----------

interface LevelCtx {
  host: Host;
  scene: () => Scene | null;
  hitch: HitchBoot | null;
  /** the render scale now (main.ts resizes the targets) */
  setRenderScale: (s: number) => void;
}

/** A level page of the suite: waits for the level, runs its part, and goes to the next page. */
export async function benchLevel(ctx: LevelCtx): Promise<void> {
  const s = (await loadFull())!;
  const page = s.pages[s.step];
  document.getElementById('bench-loading')?.remove();
  const panel = new Panel(ctx.host.ui);
  panel.el.style.opacity = '0.85';
  panel.el.style.right = 'auto';
  panel.el.style.font = '11px/1.3 ui-monospace,monospace';
  panel.el.style.padding = '4px 6px';
  let hidden = false;
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && (hidden = true));
  const out: Record<string, unknown> = { page: page.name, url: location.search };
  const t0 = performance.now();
  try {
    await keepAwake();
    panel.say(`Benchmark running: page ${s.step} of ${s.pages.length - 1} (${page.name}), loading — don't close`);
    const R = await waitFor(() => {
      const r = (window as unknown as { reclaimed?: Record<string, unknown> }).reclaimed;
      return r?.stream && (r.stream as { store?: unknown }).store ? r : null;
    }, 240000);
    // (ms from the page's navigation to the level ready: the atlas built, the window made, the store open)
    out.readyAtMs = Math.round(performance.now());
    beat = performance.now();
    beatWhat = 'ready';
    const B = new Bench(ctx, R as unknown as Engine, panel, `Benchmark running: page ${s.step} of ${s.pages.length - 1} (${page.name}), don't close —`);
    // (v3: what the page has so far saved at every step — a crash leaves it, marked incomplete)
    B.checkpoint = (step) => {
      s.results[page.name] = { ...out, incomplete: true, lastStep: step };
      try {
        save(s);
      } catch {
        // (storage full: the page's results come at its end)
      }
    };
    if (!s.worlds.includes(B.R.stream.save.world)) s.worlds.push(B.R.stream.save.world);
    save(s);
    if (page.name.startsWith('pan') && page.name !== 'pans') await B.panPage(out, (page.params.panzooms ?? '').split('_').map(Number));
    else if (page.name === 'main') await B.mainPage(out);
    else if (page.name === 'pans') await B.pansPage(out);
    else if (page.name === 'hero') await B.heroPage(out);
    else await B.winPage(out);
    out.canvas = { w: ctx.host.canvas.width, h: ctx.host.canvas.height, cssW: ctx.host.canvas.clientWidth, cssH: ctx.host.canvas.clientHeight };
  } catch (e) {
    s.errors.push(`${page.name}: ${(e as Error).stack ?? e}`);
    out.error = String((e as Error).message ?? e);
  }
  out.pageMs = Math.round(performance.now() - t0);
  out.hiddenDuring = hidden;
  s.results[page.name] = out;
  panel.say(`${page.name} done — next…`);
  go(s);
}

async function waitFor<T>(f: () => T | null | undefined | false, ms: number): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`bench: waited ${ms / 1000} s for the level`);
    // (a wait with its own limit: alive for the watchdog)
    if (beatWhat !== 'loading' && beatWhat !== 'gpu') beat = performance.now();
    await sleep(100);
  }
}

/** what the suite reads of the level (window.reclaimed): the engine's own objects, instrumented, never changed */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Engine = Record<string, any> & {
  stream: any;
  atlas: any;
  scene: any;
  camera: any;
  core: any;
  agents: any;
  far: any;
};

interface Sample {
  frames: number[];
  gpu: number[];
  passes: Map<string, number[]>;
  awake: number[];
  ticks: number;
  grid: number[];
  voxel: number[];
  bodies: number[];
  mesh: number[];
  /** (v2) per GPU frame read back: the passes' ms summed (a sane GPU's is under its frame's span) */
  passSum: number[];
  /** (v2) rAFs that rendered nothing (held for the GPU) */
  held?: number;
  /** (v4) per rendered frame: the share of the screen in the window's detail (in it, its region written) */
  cover: number[];
}

class Bench {
  readonly R: Engine;
  private prof: Profiler;
  private dev: GPUDevice;
  private timer: GpuTimer;
  constructor(
    private ctx: LevelCtx,
    R: Engine,
    private panel: Panel,
    private tag: string,
  ) {
    this.R = R;
    this.prof = ctx.host.profiler;
    this.dev = ctx.host.gpu.device;
    this.timer = new GpuTimer(this.dev);
  }

  private say(s: string): void {
    this.panel.say(`${this.tag} ${s}`);
    beat = performance.now();
    beatWhat = s;
    this.checkpoint?.(s);
  }
  /** (v3) called at every step: the page's results so far saved */
  checkpoint?: (step: string) => void;

  private get W(): number {
    return this.R.stream.W;
  }

  /** the streamer and the mesh quiet: nothing sliding, no frames over twice the median for a second */
  private async settle(minMs = 4000, maxMs = 30000): Promise<number> {
    const t0 = performance.now();
    await sleep(minMs);
    let last = performance.now();
    const recent: number[] = [];
    for (;;) {
      const t = await frame();
      recent.push(t - last);
      last = t;
      if (recent.length > 60) recent.shift();
      const sorted = [...recent].sort((a, b) => a - b);
      const med = sorted[sorted.length >> 1];
      if (recent.length >= 60 && !this.R.stream.busy && Math.max(...recent) < Math.max(2 * med, 40)) break;
      if (performance.now() - t0 > maxMs) break;
    }
    return Math.round(performance.now() - t0);
  }

  /** Record `seconds` of frames with every system running: frame times, GPU per pass, the hitch recorder's causes. */
  private async capture(seconds: number, during?: (t: number) => void): Promise<Record<string, unknown>> {
    const r = await this.captureRaw(seconds, during);
    if (!this.keepMesh) delete r.meshFrames;
    return r;
  }
  private keepMesh = false;
  private framesHook: ((f: number[]) => void) | null = null;

  private async captureRaw(seconds: number, during?: (t: number) => void): Promise<Record<string, unknown>> {
    const rec = this.ctx.hitch?.rec;
    rec?.reset();
    this.prof.resetTotals();
    cpuStats.clear();
    const st0 = { ...this.R.stream.stats };
    const sm: Sample = { frames: [], gpu: [], passes: new Map(), awake: [], ticks: 0, grid: [], voxel: [], bodies: [], mesh: [], passSum: [], cover: [] };
    const prevOnFrame = this.prof.onFrame;
    const perName = (this.prof as unknown as { perName: Map<string, number> }).perName;
    this.prof.onFrame = (f, ms, top) => {
      prevOnFrame?.(f, ms, top);
      sm.gpu.push(ms);
      let mesh = 0;
      let all = 0;
      for (const [n, v] of perName) {
        (sm.passes.get(n) ?? sm.passes.set(n, []).get(n)!).push(v);
        if (n.includes('fieldmesh')) mesh += v;
        all += v;
      }
      sm.mesh.push(mesh);
      sm.passSum.push(all);
    };
    const tick0 = this.R.core.sim.tick;
    const t0 = performance.now();
    let last = t0;
    let fno = this.prof.frameNo;
    let held = 0;
    const sleepSys = this.R.scene.sleep;
    try {
      for (;;) {
        const t = await frame();
        // (v2: a rendered frame — the level's frame began one — not a rAF held for the GPU)
        if (this.prof.frameNo === fno) {
          held++;
          if (t - t0 >= seconds * 1000) break;
          continue;
        }
        fno = this.prof.frameNo;
        sm.frames.push(t - last);
        last = t;
        if (sleepSys) sm.awake.push(sleepSys.awake);
        sm.cover.push(this.writtenShare());
        const hy = this.R.scene.hybrid?.stats;
        if (hy) {
          sm.grid.push(hy.grid);
          sm.voxel.push(hy.voxel);
        }
        const rb = this.R.scene.integrity?.rigid?.list;
        if (rb) sm.bodies.push(rb.length);
        if (during) during((t - t0) / 1000);
        if (t - t0 >= seconds * 1000) break;
      }
    } finally {
      this.prof.onFrame = prevOnFrame;
    }
    sm.ticks = this.R.core.sim.tick - tick0;
    sm.held = held;
    this.framesHook?.(sm.frames);
    // (the readbacks of the last frames' timestamps)
    await sleep(100);
    return this.summarise(sm, st0, (performance.now() - t0) / 1000, rec);
  }

  private summarise(sm: Sample, st0: Record<string, number>, secs: number, rec: HitchBoot['rec']): Record<string, unknown> {
    const hasGpu = this.prof.enabled && this.prof.active;
    const passes: Record<string, Stat | null> = {};
    const perFrame: Record<string, number> = {};
    const nf = Math.max(1, sm.gpu.length);
    for (const [n, a] of [...sm.passes].sort((x, y) => y[1].reduce((s, v) => s + v, 0) - x[1].reduce((s, v) => s + v, 0))) {
      passes[n] = stat(a, 'ms a frame it ran in');
      perFrame[n] = r3(a.reduce((s, v) => s + v, 0) / nf);
    }
    const sum = (re: RegExp) => r3(Object.entries(perFrame).filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0));
    const groups = hasGpu
      ? {
          unit: 'GPU ms a frame (mean over frames read back)',
          note: 'draw is the frame draw pass (the lighting and the forward draw); render = gbuffer + shadow + draw + renderprep (renderprep, renderfields, project) + tcache',
          render: sum(/^(draw|gbuffer|tcache|shadow|renderprep|renderfields|project)/),
          gbuffer: sum(/^gbuffer|^tcache-g/),
          shadow: sum(/^shadow/),
          draw: sum(/^draw$/),
          renderprep: sum(/^(renderprep|renderfields|project)/),
          mesh: sum(/fieldmesh/),
          water: sum(/^water/),
          oil: sum(/^oil/),
          wind: sum(/^(windfield|sway|wind)/),
          sediment: sum(/^(sediment|surface|structure|slope|erosion)/),
          lava: sum(/^lava/),
          plants: sum(/^(ecology|wilt|moisture|veg|plant)/),
          otherSim: sum(/^(fire|contamination|climate|copyback|stats)/),
          particles: sum(/^particles/),
          agents: sum(/^agents/),
          physics: sum(/^physics/),
          streaming: sum(/^atlas-/),
          far: sum(/^(lod|bake|rough)/),
        }
      : 'n/a (no timestamp-query)';
    const ts = judgeTimestamps(sm.passSum, sm.gpu, sm.frames);
    if (hasGpu) this.tsChecks.push(ts);
    const topPasses: Record<string, Stat | null> = {};
    for (const k of Object.keys(passes).slice(0, 12)) topPasses[k] = passes[k];
    const cpu: Record<string, unknown> = {};
    for (const [k, v] of [...cpuStats].sort((a, b) => b[1].sum - a[1].sum).slice(0, 15)) cpu[k] = { n: v.n, mean: r3(v.sum / Math.max(1, v.n)), max: r3(v.max), totalMs: Math.round(v.sum), unit: 'ms CPU' };
    const st1 = this.R.stream.stats;
    const stream: Record<string, number> = {};
    for (const k of Object.keys(st1)) if (typeof st1[k] === 'number' && k !== 'lastMs') stream[k] = st1[k] - (st0[k] ?? 0);
    const awake = stat(sm.awake, 'chunks awake (16x16)');
    // (a sim's GPU ms a tick for each chunk awake: the passes are dispatched over the awake list, sim/cull.ts)
    const tpf = sm.ticks / Math.max(1, sm.frames.length);
    const awakeMean = awake?.mean ?? 0;
    const perAwake: Record<string, number | string> = { unit: 'GPU ms a sim tick per awake 16x16 chunk', ticksPerFrame: r3(tpf) };
    if (typeof groups === 'object' && awakeMean > 0 && tpf > 0)
      for (const k of ['water', 'oil', 'wind', 'sediment', 'lava', 'plants', 'otherSim']) perAwake[k] = r3((groups as unknown as Record<string, number>)[k] / tpf / awakeMean);
    let hitch: unknown = null;
    if (rec) {
      const r = rec.report() as Record<string, unknown>;
      const worst = (r.worst as { ms: number; cause: string; cpu: number; gpu: unknown; steps: { label: string; ms: number }[]; async: { label: string; ms: number }[] }[]).slice(0, 5);
      hitch = {
        causes: r.causes,
        worst: worst.map((h) => `${h.ms} ${h.cause} cpu ${h.cpu} ${[...h.steps, ...h.async].slice(0, 2).map((x) => `${x.label} ${x.ms}`).join(', ')}`),
        heldForGpu: r.heldForGpu,
        gc: r.gc,
        threshold: r.thresholdMs,
        hitches: (r.hitches as unknown[]).length,
      };
    }
    return {
      seconds: +secs.toFixed(1),
      frames: stat(sm.frames, 'ms between rendered frames'),
      heldRafs: sm.held ?? 0,
      screenInDetail: stat(sm.cover, 'share of the screen in the window\'s detail (0..1)'),
      p99: r3([...sm.frames].sort((a, b) => a - b)[Math.floor(0.99 * sm.frames.length)] ?? NaN),
      fps: +(sm.frames.length / secs).toFixed(1),
      fpsNote: 'rendered frames a second (a rAF held for the GPU not counted)',
      gpuFrame: hasGpu ? stat(sm.gpu, 'GPU ms a frame (first pass start to last end)') : 'n/a',
      timestamps: hasGpu ? ts : 'n/a',
      gpuGroups: groups,
      gpuPasses: hasGpu ? topPasses : 'n/a',
      simTicks: sm.ticks,
      ticksPerSecond: +(sm.ticks / secs).toFixed(1),
      awake,
      simPerAwakeChunk: perAwake,
      hybrid: sm.grid.length ? { gridChunks: stat(sm.grid, 'heightfield-grid chunks'), voxelChunks: stat(sm.voxel, 'voxel chunks') } : null,
      rockBodies: stat(sm.bodies, 'rigid rock bodies'),
      meshFrame: hasGpu ? stat(sm.mesh, 'GPU ms of the field mesh a frame') : 'n/a',
      meshFrames: sm.mesh,
      cpuSteps: cpu,
      stream,
      hitch,
    };
  }

  /** what the camera shows: zoom, the ground's footprint, how much of it is the window, the rings, the far land */
  private view(): Record<string, unknown> {
    const c = this.R.camera;
    const W = this.W;
    const H = this.R.stream.H;
    const vw = c.viewportW;
    const vh = c.viewportH;
    const rings: number[] = this.R.far?.lod ? this.R.far.lod.spacings.map((s: number) => s * (this.R.far.lod.n - 1)) : [];
    const counts: Record<string, number> = { window: 0, far: 0 };
    for (const r of rings) counts[`ring${r}`] = 0;
    const G = 24;
    let xs0 = Infinity;
    let xs1 = -Infinity;
    let ys0 = Infinity;
    let ys1 = -Infinity;
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const [dx, dy] = c.fly ? [0, 0] : c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * vw, ((j + 0.5) / G - 0.5) * vh);
        const x = c.target[0] + dx;
        const y = c.target[1] + dy;
        xs0 = Math.min(xs0, x);
        xs1 = Math.max(xs1, x);
        ys0 = Math.min(ys0, y);
        ys1 = Math.max(ys1, y);
        if (x >= 0 && x <= W && y >= 0 && y <= H * ROW_H) counts.window++;
        else {
          const d = Math.max(Math.abs(dx), Math.abs(dy)) * 2;
          const r = rings.find((e) => d <= e);
          if (r !== undefined) counts[`ring${r}`]++;
          else counts.far++;
        }
      }
    const pct: Record<string, number> = {};
    for (const [k, v] of Object.entries(counts)) pct[k] = +((100 * v) / (G * G)).toFixed(1);
    // (v4, the user: "so that the whole screen is nearly always loaded in detail") the smallest window (a side, whole
    // regions) holding 95% of the screen's ground with the camera at its middle, at this zoom and turn
    let need: number | null = null;
    if (!c.fly)
      for (let w = 256; w <= 4096 && need === null; w += 64) {
        let inside = 0;
        for (let j = 0; j < G; j++)
          for (let i = 0; i < G; i++) {
            const [dx, dy] = c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * vw, ((j + 0.5) / G - 0.5) * vh);
            if (Math.abs(dx) <= w / 2 && Math.abs(dy) <= (w / 2) * ROW_H) inside++;
          }
        if (inside >= 0.95 * G * G) need = w;
      }
    return {
      zoom: +c.zoom.toFixed(3),
      fly: !!c.fly,
      azimuth: c.azimuth !== undefined ? +c.azimuth.toFixed(3) : null,
      viewportCss: [vw, vh],
      footprintCells: { w: Math.round(xs1 - xs0), h: Math.round(ys1 - ys0), unit: 'cells (ground at the target height)' },
      window: { w: W, h: H, unit: 'cells' },
      coveragePct: pct,
      windowFor95: need,
      rings,
      target: c.target.map((v: number) => Math.round(v)),
    };
  }

  // ---- the A/B: systems switched off one at a time (v2: a GPU's timestamps may not be trustworthy — Mali's weren't) ----

  /** what can be switched off for a few seconds: the sim systems (their encode a no-op), agents, the renderer's pieces (Renderer.skip) */
  private toggles(): Record<string, { what: string; off: () => void; on: () => void; matched: string[] }> {
    const sims: { name: string; encode: unknown }[] = this.R.core.sim.systems;
    const out: Record<string, { what: string; off: () => void; on: () => void; matched: string[] }> = {};
    const simGroup = (key: string, re: RegExp, what: string) => {
      const hit = sims.filter((x) => re.test(x.name));
      if (!hit.length) return;
      const own = hit.map((x) => Object.prototype.hasOwnProperty.call(x, 'encode'));
      const was = hit.map((x) => x.encode);
      out[key] = {
        what,
        matched: hit.map((x) => x.name),
        off: () => hit.forEach((x) => (x.encode = () => {})),
        on: () =>
          hit.forEach((x, i) => {
            if (own[i]) x.encode = was[i];
            else delete (x as { encode?: unknown }).encode;
          }),
      };
    };
    simGroup('simAll', /^(?!edit$|layerpull$|landbrush$|townstamp$|placeop$|stats$)/, 'every sim system but the edits and stamps (events still consumed)');
    simGroup('water', /^water$/, 'the water flow');
    simGroup('lava', /^lava$/, 'the lava flow');
    simGroup('sediment', /^sediment$/, 'sediment and loose ground');
    simGroup('wind', /^windfield$/, 'the wind field');
    simGroup('plants', /^(ecology|wilt|moisture)$/, 'ecology, wilt, moisture');
    simGroup('otherSims', /^(oil|contamination|fire|climate|sway|structure|project|structtick|surface)$/, 'oil, contamination, fire, climate, sway, structure, surface');
    simGroup('renderfields', /^renderfields$/, 'the render fields (shadow/AO fields the draw reads)');
    simGroup('particlesSim', /^particles$/, 'the particles\' update');
    simGroup('physics', /^physics$/, 'the physics voxels');
    const ag = this.R.agents;
    if (ag) {
      const own = Object.prototype.hasOwnProperty.call(ag, 'encode');
      const was = ag.encode;
      out.agents = { what: 'the agents pass', matched: ['agents'], off: () => (ag.encode = () => {}), on: () => (own ? (ag.encode = was) : delete ag.encode) };
    }
    const skip: Set<string> = this.R.core.renderer.constructor.skip;
    const sk = (key: string, names: string[], what: string) => {
      const had = names.map((n) => skip.has(n));
      out[key] = { what, matched: names, off: () => names.forEach((n) => skip.add(n)), on: () => names.forEach((n, i) => !had[i] && skip.delete(n)) };
    };
    sk('renderprep', ['prep'], 'renderprep (the column lists for the draw)');
    sk('meshRebuild', ['meshprep'], 'the field mesh looking for changes and rebuilding');
    sk('shadow', ['shadow'], 'the sun\'s shadow map');
    sk('farLand', ['far'], 'the LOD rings and the far land (extra draws)');
    sk('grid', ['grid'], 'the hybrid\'s heightfield grid draw');
    sk('voxelMesh', ['mesh'], 'the field mesh draw (the hybrid\'s voxel chunks)');
    sk('particlesDraw', ['particles', 'rain'], 'particles and rain drawn');
    sk('waterDraw', ['water'], 'water drawn');
    sk('plantsDraw', ['plants', 'trees'], 'plants and trees drawn');
    sk('band', ['band'], 'the band above and below the window');
    sk('shore', ['shore'], 'the shore pass');
    return out;
  }

  /** a phase of frames: the frame interval and, each frame, the wall from after its submit to onSubmittedWorkDone */
  private async abPhase(seconds: number): Promise<{ frameMean: number; frameP50: number; fps: number; drainMean: number; drainP50: number; n: number; awake: number | null }> {
    const frames: number[] = [];
    const drains: number[] = [];
    const awake: number[] = [];
    const sl = this.R.scene.sleep;
    const dev = this.dev;
    const t0 = performance.now();
    let last = t0;
    let fno = this.prof.frameNo;
    for (;;) {
      const t = await frame();
      if (t - t0 >= seconds * 1000) break;
      // (a rendered frame only: a rAF held for the GPU submitted nothing)
      if (this.prof.frameNo === fno) continue;
      fno = this.prof.frameNo;
      frames.push(t - last);
      last = t;
      if (sl) awake.push(sl.awake);
      // (this callback runs after main.ts's frame, which submitted: the queue's drain from here is the frame's GPU work, or more when it's behind)
      const ts = performance.now();
      void dev.queue.onSubmittedWorkDone().then(() => drains.push(performance.now() - ts));
    }
    await dev.queue.onSubmittedWorkDone();
    const f = stat(frames, 'ms');
    const d = stat(drains, 'ms');
    // (v4: no frame rendered in the phase — the GPU stalled — is a number, not a crash)
    if (!f) return { frameMean: NaN, frameP50: NaN, fps: 0, drainMean: d?.mean ?? NaN, drainP50: d?.p50 ?? NaN, n: 0, awake: null };
    const aw = stat(awake, 'chunks');
    return { frameMean: f.mean, frameP50: f.p50, fps: +(frames.length / ((last - t0) / 1000)).toFixed(1), drainMean: d?.mean ?? NaN, drainP50: d?.p50 ?? NaN, n: frames.length, awake: aw ? aw.mean : null };
  }

  /** Each system off for `secs` against the frames just before with it on: the frame-time and the drain it costs. */
  private async ab(keys: string[], secs = 2, scene = 'parked'): Promise<Record<string, unknown>> {
    const T = this.toggles();
    const systems: Record<string, unknown> = {};
    const t0 = performance.now();
    for (const k of keys) {
      const t = T[k];
      if (!t) {
        systems[k] = 'not in this level';
        continue;
      }
      this.say(`A/B: ${k} off…`);
      await sleep(300);
      const on = await this.abPhase(secs);
      let off: typeof on;
      try {
        t.off();
        await sleep(300);
        off = await this.abPhase(secs);
      } finally {
        t.on();
      }
      systems[k] = {
        what: t.what,
        matched: t.matched,
        costFrameMs: r3(on.frameMean - off.frameMean),
        costDrainMs: r3(on.drainP50 - off.drainP50),
        fpsOn: on.fps,
        fpsOff: off.fps,
        // (v4: the chunks awake meanwhile — a cost of ~0 with none awake is asleep, not free)
        awakeOn: on.awake,
        awakeOff: off.awake,
        on: { frameMean: on.frameMean, drainP50: r3(on.drainP50), n: on.n },
        off: { frameMean: off.frameMean, drainP50: r3(off.drainP50), n: off.n },
      };
    }
    await sleep(400);
    return {
      unit: 'ms a frame: costFrameMs = mean frame interval with it on - off (what it costs when the frame is GPU- or CPU-bound; ~0 when the frame waits for vsync); costDrainMs = the same of the median wall from a frame\'s submit to onSubmittedWorkDone. Only a bound frame shows a system\'s cost in its interval: at the display\'s rate (a desktop at vsync) the costs read ~0 and only the drain moves',
      method: `${secs} s on then ${secs} s off each, 0.3 s settling; ${scene}; works on any GPU (no timestamps)`,
      scene,
      bound: this.boundNote(),
      seconds: +((performance.now() - t0) / 1000).toFixed(0),
      systems,
    };
  }

  /** is the frame bound (by the GPU or the CPU) or waiting for the display? from the parked frames: fps under 90% of the fastest frames' rate */
  private boundNote(): string {
    const f = (this.idleFrames ?? []).slice().sort((a, b) => a - b);
    if (!f.length) return 'unknown';
    const fast = f[Math.floor(f.length * 0.05)];
    const mean = f.reduce((a, v) => a + v, 0) / f.length;
    return mean > fast * 1.1 ? `bound: frames ${mean.toFixed(1)} ms on average against ${fast.toFixed(1)} at their fastest — the costs show in the interval` : `at the display's rate (${(1000 / mean).toFixed(0)} fps): the frame costs read ~0; the drain is the guide`;
  }
  private idleFrames: number[] | null = null;

  /** (v3) the share of a 12x12 grid of screen points whose ground is in the window, in a region already written */
  private writtenShare(): number {
    const c = this.R.camera;
    const S = this.R.stream;
    const W = S.W;
    const H = S.H;
    const R = S.R;
    const un: [number, number][] = S.unwritten ?? [];
    const G = 12;
    let n = 0;
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const [dx, dy] = c.fly ? [0, 0] : c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * c.viewportW, ((j + 0.5) / G - 0.5) * c.viewportH);
        const x = c.target[0] + dx;
        const y = (c.target[1] + dy) / ROW_H;
        // (round 104, ?tiles=1: land a tile draws is in detail too — render/tilecache.ts)
        const tiled = this.R.core.renderer.tiles?.drawsAt(x, y) ?? false;
        if (x < 0 || x >= W || y < 0 || y >= H) {
          if (tiled) n++;
          continue;
        }
        const lx = Math.floor(x / R) * R;
        const ly = Math.floor(y / R) * R;
        if (un.some(([ux, uy]) => ux === lx && uy === ly) && !tiled) continue;
        n++;
      }
    return n / (G * G);
  }
  private parkedCover = 0;

  /**
   * (round 106, tilephone: where the pop-in is) The screen's 12 x 12 points not in detail now, as shares of the screen:
   * in the window but its region not written yet (and no tile there), or past it with no tile — those split by the pan's
   * way `dir` (world x y): ahead, to the side, behind.
   */
  private missingWhere(dir: [number, number]): { win: number; ahead: number; side: number; behind: number } {
    const c = this.R.camera;
    const S = this.R.stream;
    const un: [number, number][] = S.unwritten ?? [];
    const G = 12;
    const dl = Math.hypot(dir[0], dir[1]) || 1;
    const o = { win: 0, ahead: 0, side: 0, behind: 0 };
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const [dx, dy] = c.fly ? [0, 0] : c.screenDeltaToWorld(((i + 0.5) / G - 0.5) * c.viewportW, ((j + 0.5) / G - 0.5) * c.viewportH);
        const x = c.target[0] + dx;
        const y = (c.target[1] + dy) / ROW_H;
        if (this.R.core.renderer.tiles?.drawsAt(x, y)) continue;
        if (x >= 0 && x < S.W && y >= 0 && y < S.H) {
          if (un.some(([ux, uy]) => ux === Math.floor(x / S.R) * S.R && uy === Math.floor(y / S.R) * S.R)) o.win++;
          continue;
        }
        const along = (dx * dir[0] + dy * dir[1]) / (dl * (Math.hypot(dx, dy) || 1));
        if (along > 0.5) o.ahead++;
        else if (along < -0.5) o.behind++;
        else o.side++;
      }
    const n = G * G;
    return { win: o.win / n, ahead: o.ahead / n, side: o.side / n, behind: o.behind / n };
  }

  /** (v3) low detail now: the share of the screen detailed when parked that isn't now (outside the window, or not written yet) */
  private lowDetail(): number {
    return Math.max(0, this.parkedCover - this.writtenShare());
  }

  /**
   * (v3) The fastest pan this window sustains: the speed raised step by step (PROBE_SPEEDS, PROBE_S each) until, over
   * a step, the low detail's p90 is over 5% of the screen or the rendered fps under 30 — the last step that held.
   */
  private async maxPan(): Promise<Record<string, unknown>> {
    const sc = this.R.scene;
    await this.settle(1000, 10000);
    this.parkedCover = this.writtenShare();
    const [ux, uy] = this.R.camera.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    const steps: { speed: number; fps: number; lowP90: number; ok: boolean }[] = [];
    let held: number | null = null;
    let why = `held to ${PROBE_SPEEDS[PROBE_SPEEDS.length - 1]} cells/s`;
    sc.pan = { speed: PROBE_SPEEDS[0], dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
    try {
      for (const v of PROBE_SPEEDS) {
        this.say(`the fastest pan: ${v} cells/s…`);
        sc.pan.speed = v;
        const low: number[] = [];
        const fno0 = this.prof.frameNo;
        const t0 = performance.now();
        while (performance.now() - t0 < PROBE_S * 1000) {
          await frame();
          low.push(this.lowDetail());
        }
        const fps = (this.prof.frameNo - fno0) / ((performance.now() - t0) / 1000);
        const lowP90 = [...low].sort((a, b) => a - b)[Math.floor(low.length * 0.9)] ?? 0;
        const ok = lowP90 <= 0.05 && fps >= 30;
        steps.push({ speed: v, fps: +fps.toFixed(1), lowP90: r3(lowP90), ok });
        if (!ok) {
          why = lowP90 > 0.05 ? `low detail ${(lowP90 * 100).toFixed(0)}% of the screen at ${v}` : `${fps.toFixed(0)} fps at ${v}`;
          break;
        }
        held = v;
      }
    } finally {
      sc.pan = null;
    }
    return { unit: 'cells/s', maxSustainable: held, stoppedBy: why, rule: `the speed raised every ${PROBE_S} s; it holds while low detail (p90) <= 5% of the screen and rendered fps >= 30`, parkedDetailed: r3(this.parkedCover), window: this.W, steps };
  }

  /**
   * (v4) Each sim system's GPU time, its dispatches in one compute pass: Mali's timestamps are sane inside a pass
   * (round 102's phone: one pass sum/wall 0.87) and not across passes (3.0). The system is encoded once more, outside
   * the frame, through an encoder that hands it one shared pass (its own end()s ignored; a copy or a clear between its
   * passes ends the pass and the next dispatch opens another — each timed on its own); its own timestamp asks are off
   * meanwhile (the profiler inactive). A system runs one extra tick for each sample — the bench's own world. Wall:
   * the isolated submit's, less an empty submit's.
   */
  private async systemGpu(label: string): Promise<Record<string, unknown>> {
    if (!this.dev.features.has('timestamp-query')) return { error: 'no timestamp-query' };
    const dev = this.dev;
    const prof = this.prof as { active: boolean };
    const timer = new GpuTimer(dev);
    const sims: { name: string; encode: (e: GPUCommandEncoder, t: number) => void }[] = this.R.core.sim.systems.filter((x: { name: string }) => !/^(edit|layerpull|landbrush|townstamp|placeop|stats)$/.test(x.name));
    const items: [string, (e: GPUCommandEncoder) => void][] = sims.map((x) => [x.name, (e) => x.encode(e, this.R.core.sim.tick)]);
    if (this.R.agents) items.push(['agents', (e) => this.R.agents.encode(e)]);
    const empty: number[] = [];
    for (let k = 0; k < 5; k++) {
      await dev.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      dev.queue.submit([dev.createCommandEncoder().finish()]);
      await dev.queue.onSubmittedWorkDone();
      empty.push(performance.now() - t0);
    }
    const emptyP50 = stat(empty, 'ms')?.p50 ?? 0;
    const out: Record<string, unknown> = {};
    const awake = this.R.scene.sleep?.awake ?? null;
    for (const [name, enc] of items) {
      const gpu: number[] = [];
      const wall: number[] = [];
      let segs = 0;
      for (let k = 0; k < 4; k++) {
        await frame();
        const real = dev.createCommandEncoder({ label: `bench one-pass ${name}` });
        let pass: GPUComputePassEncoder | null = null;
        let n = 0;
        const open = () => {
          if (!pass) {
            pass = real.beginComputePass({ timestampWrites: timer.timestamps(name) });
            n++;
          }
          return pass;
        };
        const close = () => {
          if (pass) {
            (pass as GPUComputePassEncoder).end();
            pass = null;
          }
        };
        const passProxy = {
          label: '',
          setPipeline: (p: GPUComputePipeline) => open().setPipeline(p),
          setBindGroup: (i: number, g: GPUBindGroup | null, o?: Iterable<number>) => open().setBindGroup(i, g, o as number[]),
          dispatchWorkgroups: (x: number, y?: number, z?: number) => open().dispatchWorkgroups(x, y, z),
          dispatchWorkgroupsIndirect: (b: GPUBuffer, o: number) => open().dispatchWorkgroupsIndirect(b, o),
          end: () => {},
          pushDebugGroup: () => {},
          popDebugGroup: () => {},
          insertDebugMarker: () => {},
        };
        const encProxy = new Proxy(real, {
          get(t, key) {
            if (key === 'beginComputePass') return () => passProxy;
            const v = (t as unknown as Record<string | symbol, unknown>)[key];
            if (typeof v === 'function')
              return (...a: unknown[]) => {
                close();
                return (v as (...x: unknown[]) => unknown).apply(t, a);
              };
            return v;
          },
        }) as GPUCommandEncoder;
        const was = prof.active;
        prof.active = false;
        try {
          enc(encProxy);
        } finally {
          prof.active = was;
        }
        close();
        await dev.queue.onSubmittedWorkDone();
        const t0 = performance.now();
        dev.queue.submit([real.finish()]);
        await dev.queue.onSubmittedWorkDone();
        wall.push(performance.now() - t0 - emptyP50);
        const g = (await timer.read()).get(name) ?? [];
        gpu.push(g.reduce((a, v) => a + v, 0));
        segs = n;
      }
      out[name] = { gpuMs: stat(gpu, 'GPU ms a tick (its dispatches in one pass)')?.p50 ?? null, wallMs: r3(stat(wall, 'ms')?.p50 ?? NaN), passes: segs };
    }
    return { unit: 'ms a tick of that system alone', scene: label, awakeChunks: awake, windowChunks: (this.W / 16) * (this.R.stream.H / 16), emptySubmitMs: r3(emptyP50), how: 'its dispatches in one compute pass, timed at that pass\'s begin and end (sane on Mali where per-pass timestamps aren\'t); wall = the isolated submit less an empty one', systems: out };
  }

  /** (v4) a storm over the camera (its rain wakes water and sediment, its wind the field): spawned, or why not */
  private storm(): string {
    const w = this.R.weather ?? this.R.core?.weather;
    if (!w?.spawn) return 'no weather here';
    const c = this.R.camera.target;
    const st = w.spawn(c[0], c[1]);
    if (!st) return 'the weather refused (a storm already, or its cooldown)';
    st.intensity = Math.max(st.intensity ?? 0, 0.8);
    return `a storm at ${Math.round(c[0])},${Math.round(c[1])}`;
  }

  /** the timestamps judged over every capture so far */
  private tsChecks: ReturnType<typeof judgeTimestamps>[] = [];

  // ---- main ----

  /** (v4) where the main page began (world cells, rows): the warp comes back to it */
  private startAt: [number, number] = [0, 0];

  async mainPage(out: Record<string, unknown>): Promise<void> {
    const sc = this.R.scene;
    const S0 = this.R.stream;
    this.startAt = [S0.origin[0] + S0.W / 2, S0.origin[1] + S0.H / 2];
    const drive = sc.drive;
    sc.drive = null;
    sc.pan = null;
    this.say('settling…');
    out.settleMs = await this.settle(6000);
    out.window = { w: this.W, h: this.R.stream.H, region: this.R.stream.R, layoutBytes: this.R.stream.layout.bytes };
    out.view = this.view();
    this.say('parked frames…');
    this.framesHook = (f) => (this.idleFrames = f);
    out.idle = await this.capture(5);
    this.framesHook = null;
    this.idleP50 = (out.idle as { frames?: Stat }).frames?.p50 ?? 17;
    // (v4: the A/B runs on an active scene — riding in a storm, and at a meteor's lava — not parked)
    this.say('region generation, stage by stage…');
    // (round 102: the GPU's way when it's on — and the CPU's, to compare, in the same run)
    out.regionStages = GPUGEN ? await this.regionStagesGpu(5) : await this.regionStages(5);
    if (GPUGEN) out.regionStagesCpu = await this.regionStages(5);
    this.say('regions/s at 1, 2, 4, 8 tiles a frame…');
    out.tiles = await this.tileSweep();
    this.say('agents…');
    out.agents = await this.agentsSweep();
    this.say('render scales…');
    out.renderScale = await this.renderScales();
    this.say('the disk store…');
    out.store = await this.storeIO(4);
    // the scenarios
    this.say('scenario: riding the road (20 s)…');
    await this.settle(1500, 15000);
    if (drive) {
      sc.drive = drive;
      out.ride = { ...(await this.capture(20)), view: this.view() };
      // (v4) the A/B while it rides on, a storm over the camera
      out.abRideStorm = this.storm();
      await sleep(1500);
      out.ab = await this.ab(AB_RIDE, 1.5, `riding at 18 cells/s, ${out.abRideStorm}`);
      this.say('each system\'s GPU time, one pass each (riding in the storm)…');
      out.systemGpu = await this.systemGpu(`riding at 18 cells/s, ${out.abRideStorm}`);
      sc.drive = null;
    } else out.ride = { error: 'no road near the start (?drive found none)' };
    out.timestampsJudged = this.tsChecks;
  }

  /**
   * (v4) The pans, the fastest pan, the warp back and the meteor on a page of their own: the Pixel 9a's v3 main page
   * died after them and lost every sandbox number with it (its state too big to keep, or the page too heavy to leave)
   */
  async pansPage(out: Record<string, unknown>): Promise<void> {
    const sc = this.R.scene;
    const S0 = this.R.stream;
    this.startAt = [S0.origin[0] + S0.W / 2, S0.origin[1] + S0.H / 2];
    sc.drive = null;
    sc.pan = null;
    this.say('settling…');
    out.settleMs = await this.settle(5000);
    out.window = { w: this.W, h: this.R.stream.H };
    out.parked = await this.capture(3);
    this.idleP50 = (out.parked as { frames?: Stat }).frames?.p50 ?? 17;
    // (v3: pans at 80 and 120, then 160, 240 and 320 — the user: "crank up pan speed and view distance")
    for (const v of [80, 120, 160, 240, 320]) {
      const secs = v <= 120 ? 12 : 10;
      this.say(`scenario: a fast pan at ${v} cells/s (${secs} s)…`);
      await this.settle(1500, 15000);
      const [ux, uy] = this.R.camera.screenDeltaToWorld(0, -1);
      const l = Math.hypot(ux, uy) || 1;
      this.parkedCover = this.writtenShare();
      sc.pan = { speed: v, dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      const pc = this.R.atlas.pacer;
      const pz = () => ({ how: pc.how, tileMs: +pc.tileMs.toFixed(3), gpuMs: +pc.gpuMs.toFixed(2), budgetMs: +pc.budgetMs.toFixed(2), perFrame: pc.perFrame, tiles: pc.tiles });
      const pacerBefore = pz();
      const low: number[] = [];
      const cap = await this.capture(secs, () => low.push(this.lowDetail()));
      out[`pan${v}`] = { ...cap, lowDetail: stat(low, 'share of the screen that is detailed parked but not now (0..1)'), view: this.view(), pacerBefore, pacerAfter: pz() };
      sc.pan = null;
    }
    this.say('the fastest pan it keeps up with…');
    out.maxPan = await this.maxPan();
    // (v4: back to the start — the pans carried the window thousands of cells away, and v3's warp went a third of the
    // way round from there, to flat land; the user: "the atlas location it jumps to seems to have shifted and is less
    // interesting and has no cliffs". The start (RIDE_AT: a road among cliffs, a town) is where the warp lands now)
    this.say('scenario: a warp back to the start…');
    await this.settle(1500, 15000);
    out.warp = await this.warp(this.startAt);
    // the integrity judge and the rock bodies: a meteor beside the camera (the bench's own world, cleared at the end)
    this.say('a meteor: the judge and the rock bodies (12 s)…');
    await this.settle(1500, 15000);
    out.meteor = await this.meteor();
    // (v4) the A/B at the meteor: its lava and debris awake
    out.abMeteor = await this.ab(AB_METEOR, 1.5, 'parked by a meteor\'s crater (lava, debris)');
    out.systemGpuMeteor = await this.systemGpu('parked by a meteor\'s crater (lava, debris)');
    out.timestampsJudged = this.tsChecks;
  }

  /** a region's corner (world cells) in fresh ground: away from the window and from anything made so far */
  private freshAt(k: number): [number, number] {
    const S = this.R.stream;
    const a = this.R.atlas;
    const R = S.R;
    // (on land — over the sea a region has nothing to march and costs nothing: round 101's first run measured 0.2 ms
    // regions 2 km out to sea — and a spiral 12+ regions out from the window, away from what the scenarios ride)
    for (let j = k; ; j += 7) {
      const ang = j * 2.399963;
      const d = (12 + (j % 23)) * R;
      const x = (((S.origin[0] + S.W / 2 + Math.cos(ang) * d) % a.p.cols) + a.p.cols) % a.p.cols;
      const y = (((S.origin[1] + S.H / 2 + Math.sin(ang) * d) % a.p.rows) + a.p.rows) % a.p.rows;
      const c: [number, number] = [Math.floor(x / R) * R, Math.floor(y / R) * R];
      const key = `${c[0]},${c[1]}`;
      if (this.used.has(key)) continue;
      // (land under most of it: the macro height at its middle and corners over the sea)
      let land = 0;
      for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) if (a.macroAt(c[0] + fx * R, (c[1] + fy * R) * ROW_H) > a.p.sea + 2) land++;
      if (land < 4 && j < k + 7 * 400) continue;
      this.used.add(key);
      return c;
    }
  }
  private freshK = 0;
  private used = new Set<string>();

  /** Region generation stage by stage, as Atlas.regionLand and Streamer.generate do it (not the geysers' sinter) */
  private async regionStages(n: number): Promise<Record<string, unknown>> {
    const a = this.R.atlas;
    const S = this.R.stream;
    const R = S.R;
    const was = a.profiler;
    a.profiler = this.timer;
    const t: Record<string, number[]> = { columnsWall: [], readbackWait: [], land: [], ways: [], hooks: [], cutPack: [], toBody: [], uploadCall: [], uploadDone: [], total: [] };
    const gpu: Record<string, number[]> = { colHeight: [], formSeed: [], colFinish: [] };
    const scratch = this.dev.createBuffer({ size: S.layout.bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    try {
      for (let k = 0; k < n; k++) {
        const [x0, y0] = this.freshAt(this.freshK++);
        await this.dev.queue.onSubmittedWorkDone();
        const tA = performance.now();
        const c = await a.columns(x0, y0, R, R, false);
        const tB = performance.now();
        const g = await this.timer.read();
        const gs = (nm: string) => (g.get(`atlas-${nm}`) ?? []).reduce((s, v) => s + v, 0);
        for (const nm of Object.keys(gpu)) if (g.has(`atlas-${nm}`)) gpu[nm].push(gs(nm));
        t.columnsWall.push(tB - tA);
        // (only where the timestamps can be trusted: the Pixel 9a's made it -495 ms)
        if (this.timer.on && this.tsChecks[0]?.reliable) t.readbackWait.push(tB - tA - gs('colHeight') - gs('formSeed') - gs('colFinish'));
        let t0 = performance.now();
        const land = landFrom(c, x0, y0, Infinity);
        t.land.push(performance.now() - t0);
        t0 = performance.now();
        stampWays(a.ways, land, x0, y0, R, R, (cx: number, cy: number) => [cx + 0.5 + 0.5 * (cy & 1), (cy + 0.5) * ROW_H], a.worldW, a.worldH);
        t.ways.push(performance.now() - t0);
        t0 = performance.now();
        for (const f of a.landHooks) await f(land, x0, y0, R, R, false);
        t.hooks.push(performance.now() - t0);
        t0 = performance.now();
        const fz = S.cutRegion(land, undefined);
        t.cutPack.push(performance.now() - t0);
        t0 = performance.now();
        const body: Uint8Array = S.toBody(fz);
        t.toBody.push(performance.now() - t0);
        t0 = performance.now();
        this.dev.queue.writeBuffer(scratch, 0, body);
        t.uploadCall.push(performance.now() - t0);
        await this.dev.queue.onSubmittedWorkDone();
        t.uploadDone.push(performance.now() - t0);
        t.total.push(performance.now() - tA);
        await frame();
      }
    } finally {
      a.profiler = was;
      scratch.destroy();
    }
    const o: Record<string, unknown> = {
      regions: n,
      regionCells: `${R}x${R}`,
      note: 'whole region in one dispatch (the first window\'s way); the streamer splits colFinish into 32x32 tiles over frames (see tiles)',
      gpu: this.timer.on ? Object.fromEntries(Object.entries(gpu).map(([k, v]) => [k, stat(v, 'GPU ms a region')])) : 'n/a (no timestamp-query: columnsWall is the GPU work and the readback together)',
      cpu: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stat(v, k === 'columnsWall' || k === 'readbackWait' || k === 'uploadDone' || k === 'total' ? 'ms wall a region' : 'ms CPU a region')])),
      bytes: S.layout.bytes,
    };
    const tot = stat(t.total, 'ms');
    if (tot) o.regionsPerSecondSerial = +(1000 / tot.p50).toFixed(2);
    return o;
  }

  /**
   * (round 102, `gpugen`) Region generation stage by stage the GPU's way (Atlas.regionInto, as Streamer.generateGpu does
   * it): the columns, the ways' and the stamps' CPU part, finish.wgsl straight into a slot, the small readback of what
   * the CPU keeps — wall, the GPU passes and the main thread's ms.
   */
  private async regionStagesGpu(n: number): Promise<Record<string, unknown>> {
    const a = this.R.atlas;
    const S = this.R.stream;
    const R = S.R;
    const was = a.profiler;
    a.profiler = this.timer;
    const t: Record<string, number[]> = { total: [], columnsCall: [], finishWall: [], readbackWait: [], encode: [], parse: [], cut: [], mainThread: [] };
    const gpu: Record<string, number[]> = { colHeight: [], formSeed: [], colFinish: [], regionFinish: [] };
    const slot = S.pool.temp();
    let back = 0;
    try {
      for (let k = 0; k < n; k++) {
        const [x0, y0] = this.freshAt(this.freshK++);
        await this.dev.queue.onSubmittedWorkDone();
        const c0 = cpuStats.get('ways')?.sum ?? 0;
        const s0 = cpuStats.get('stamp')?.sum ?? 0;
        const tA = performance.now();
        const m = await a.regionInto(x0, y0, R, R, { buf: slot.buf, off: slot.off, layout: S.layout, oz: S.oz, zMax: this.R.core.dims.zMax, K: S.K, colK: S.colK, settle: !SETTLE }, false);
        const tB = performance.now();
        // (the streamer's own CPU part: the relief bits, the structural box)
        const t0 = performance.now();
        const rel = new Uint8Array(R * R);
        for (let i = 0; i < R * R; i++) rel[i] = Math.abs(m.surface[i] - m.ground[i]) > 0.75 ? 1 : 0;
        t.cut.push(performance.now() - t0);
        const L = a.finisher.last;
        back = L.backBytes;
        const g = await this.timer.read();
        const gs = (nm: string) => (g.get(`atlas-${nm}`) ?? []).reduce((s, v) => s + v, 0);
        for (const nm of Object.keys(gpu)) if (g.has(`atlas-${nm}`)) gpu[nm].push(gs(nm));
        t.total.push(tB - tA);
        t.finishWall.push(L.waitMs + L.encodeMs + L.parseMs);
        t.readbackWait.push(L.waitMs);
        t.encode.push(L.encodeMs);
        t.parse.push(L.parseMs);
        const ways = (cpuStats.get('ways')?.sum ?? 0) - c0;
        const stamps = (cpuStats.get('stamp')?.sum ?? 0) - s0;
        t.columnsCall.push(ways + stamps);
        t.mainThread.push(ways + stamps + L.encodeMs + L.parseMs + t.cut[t.cut.length - 1]);
        await frame();
      }
    } finally {
      a.profiler = was;
      S.pool.release(slot);
    }
    const o: Record<string, unknown> = {
      path: 'gpu (atlas/finish.wgsl straight into a pool slot)',
      regions: n,
      regionCells: `${R}x${R}`,
      gpu: this.timer.on ? Object.fromEntries(Object.entries(gpu).map(([k, v]) => [k, stat(v, 'GPU ms a region')])) : 'n/a (no timestamp-query)',
      cpu: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stat(v, k === 'total' || k === 'finishWall' || k === 'readbackWait' ? 'ms wall a region' : 'ms main thread a region')])),
      note: 'columnsCall: the ways\' and the stamps\' CPU part (cpustat ways + stamp); mainThread: all of the main thread\'s ms a region',
      readbackBytes: back,
      uploadBytes: 0,
    };
    const tot = stat(t.total, 'ms');
    if (tot) o.regionsPerSecondSerial = +(1000 / tot.p50).toFixed(2);
    return o;
  }

  /** (round 102) a region made as the streamer makes it — on the GPU into a slot (let go after), or the CPU's way */
  private async makeRegion(x0: number, y0: number, spread: boolean): Promise<void> {
    const a = this.R.atlas;
    const S = this.R.stream;
    if (!GPUGEN) {
      await a.regionLand(x0, y0, S.R, S.R, Infinity, spread);
      return;
    }
    const slot = S.pool.temp();
    try {
      await a.regionInto(x0, y0, S.R, S.R, { buf: slot.buf, off: slot.off, layout: S.layout, oz: S.oz, zMax: this.R.core.dims.zMax, K: S.K, colK: S.colK, settle: !SETTLE }, spread);
    } finally {
      S.pool.release(slot);
    }
  }

  /** Regions made as the streamer makes them (tiles over frames), the pacer held at k tiles a frame */
  private async tileSweep(): Promise<Record<string, unknown>> {
    const a = this.R.atlas;
    const S = this.R.stream;
    const R = S.R;
    const out: Record<string, unknown> = {};
    const was = a.profiler;
    a.profiler = this.timer;
    const pacer = a.pacer;
    const nReg = 6;
    try {
      for (const k of [1, 2, 4, 8]) {
        await this.settle(1000, 8000);
        // (the streamer's own batches first: their tiles share the pacer — measured alone, not with them)
        const quiet = await this.genQuiet(15000);
        pacer.fixed = k;
        const frames: number[] = [];
        let last = performance.now();
        let on = true;
        const loop = async () => {
          while (on) {
            const t = await frame();
            frames.push(t - last);
            last = t;
          }
        };
        const lp = loop();
        const tiles0 = pacer.tiles;
        const fr0 = pacer.frames;
        const t0 = performance.now();
        const spots = Array.from({ length: nReg }, () => this.freshAt(this.freshK++));
        await Promise.all(spots.map(([x0, y0]) => this.makeRegion(x0, y0, true)));
        const ms = performance.now() - t0;
        on = false;
        await lp;
        const g = await this.timer.read();
        out[`k${k}`] = {
          tilesPerFrame: k,
          regions: nReg,
          ms: Math.round(ms),
          regionsPerSecond: +((nReg * 1000) / ms).toFixed(2),
          // (the settlements' hooks plan a town's ground as raw batches through the same pacer: more tiles than the
          // regions' own where a town is near — the tile rate is the comparable one across k)
          tilesPerSecond: +(((pacer.tiles - tiles0) * 1000) / ms).toFixed(1),
          regionsPerSecondFromTiles: +(((pacer.tiles - tiles0) * 1000) / ms / (R / 32) ** 2).toFixed(2),
          tiles: pacer.tiles - tiles0,
          tilesExpected: nReg * (R / 32) ** 2,
          streamerQuietBefore: quiet,
          framesWithTiles: pacer.frames - fr0,
          frames: stat(frames, 'ms frame interval while generating'),
          gpuColFinishPerTile: this.timer.on ? stat(g.get('atlas-colFinish') ?? [], 'GPU ms a 32x32 tile') : 'n/a',
          gpuColHeight: this.timer.on ? stat(g.get('atlas-colHeight') ?? [], 'GPU ms a region') : 'n/a',
          gpuFormSeed: this.timer.on ? stat(g.get('atlas-formSeed') ?? [], 'GPU ms a region') : 'n/a',
        };
      }
    } finally {
      pacer.fixed = 0;
      a.profiler = was;
    }
    return out;
  }

  /** the atlas's tile pacer with nothing waiting and the streamer making nothing (false: still busy at the limit) */
  private async genQuiet(ms: number): Promise<boolean> {
    const t0 = performance.now();
    const pacer = this.R.atlas.pacer as { waiting?: unknown[] };
    for (;;) {
      if (!(pacer.waiting?.length ?? 0) && !(this.R.stream.jobs?.size ?? 0) && !this.R.stream.busy) return true;
      if (performance.now() - t0 > ms) return false;
      await sleep(50);
    }
  }

  private async agentsSweep(): Promise<Record<string, unknown>> {
    const ag = this.R.agents;
    const out: Record<string, unknown> = { baseUnits: ag.size };
    const c = this.R.camera.target;
    const base = await this.capture(3);
    const ms = (cap: Record<string, unknown>) => (cap.gpuGroups as Record<string, number>)?.agents ?? null;
    out.base = { agentsGpu: ms(base), unit: 'GPU ms a frame' };
    for (const n of [100, 500, 2000]) {
      let ids: number[] = [];
      try {
        ids = ag.spawn(n, c[0], c[1], { group: 7, spread: Math.sqrt(n) * 0.8 });
        await sleep(800);
        const cap = await this.capture(3);
        out[`n${n}`] = { units: ag.size, agentsGpu: ms(cap), agentsPass: (cap.gpuPasses as Record<string, Stat>)?.agents ?? null, frames: cap.frames, unit: 'GPU ms a frame' };
      } catch (e) {
        out[`n${n}`] = { error: (e as Error).message };
      } finally {
        if (ids.length) ag.remove(ids);
      }
      await sleep(300);
    }
    return out;
  }

  private async renderScales(): Promise<Record<string, unknown>> {
    const q = this.ctx.host.quality;
    const was = q.renderScale;
    const out: Record<string, unknown> = { tier: was };
    try {
      for (const s of [0.35, 0.75, 1]) {
        if (s === was) continue;
        this.ctx.setRenderScale(s);
        await sleep(1200);
        const cap = await this.capture(4);
        out[`x${s}`] = { canvas: [this.ctx.host.canvas.width, this.ctx.host.canvas.height], frames: cap.frames, gpuFrame: cap.gpuFrame, gpuGroups: cap.gpuGroups };
      }
    } finally {
      this.ctx.setRenderScale(was);
    }
    await sleep(800);
    return out;
  }

  /** the disk store: a real region's record (made here) written and read back, in a world of its own then cleared */
  private async storeIO(n: number): Promise<Record<string, unknown>> {
    const a = this.R.atlas;
    const S = this.R.stream;
    const R = S.R;
    const [x0, y0] = this.freshAt(this.freshK++);
    const land = await a.regionLand(x0, y0, R, R, Infinity, false);
    const fz = S.cutRegion(land, undefined);
    const body: Uint8Array = S.toBody(fz).slice();
    const st = await RegionStore.open(`bench-io-${Date.now().toString(36)}`);
    const put: number[] = [];
    const get: number[] = [];
    try {
      for (let k = 0; k < n; k++) {
        const t0 = performance.now();
        await st.put(`b${k}`, body.slice(), { session: 'bench', hash: k });
        put.push(performance.now() - t0);
      }
      for (let k = 0; k < n; k++) {
        const t0 = performance.now();
        await st.get(`b${k}`);
        get.push(performance.now() - t0);
      }
      const s = st.stats;
      return {
        bytes: body.byteLength,
        packedBytes: Math.round(s.packedBytes / Math.max(1, s.puts)),
        put: stat(put, 'ms wall a region (compress in the worker + IndexedDB write)'),
        get: stat(get, 'ms wall a region (IndexedDB read + decompress)'),
        workerPutMs: r3(s.putMs / Math.max(1, s.puts)),
        workerGetMs: r3(s.getMs / Math.max(1, s.gets)),
        note: 'the record body only (no header/outside sections); pool freeze/thaw are in each scenario\'s cpuSteps (rs.freeze, rs.thaw, write.pool, slide.freeze) and gpuCopy in io',
      };
    } finally {
      await st.clear();
    }
  }

  private async warp(to: [number, number]): Promise<Record<string, unknown>> {
    const a = this.R.atlas;
    const S = this.R.stream;
    const dims = { w: S.W, h: S.H, zMax: this.R.core.dims.zMax };
    const [wx, wy] = to;
    const from = [S.origin[0] + S.W / 2, S.origin[1] + S.H / 2];
    const W = a.p.cols;
    const Hh = a.p.rows;
    const dx = ((wx - from[0] + W * 1.5) % W) - W / 2;
    const dy = ((wy - from[1] + Hh * 1.5) % Hh) - Hh / 2;
    const idle = this.idleP50;
    let warped = -1;
    let settled = -1;
    const t0 = performance.now();
    const p = warpWindow(a, S, dims, wx, wy).then(() => (warped = performance.now() - t0));
    let good = 0;
    const cap = await this.capture(20, () => {
      if (warped >= 0 && settled < 0) {
        // (settled: the streamer quiet and 30 frames running within 1.5x the parked median)
        const fr = performance.now();
        good = !S.busy && fr - this.lastF < idle * 1.5 + 2 ? good + 1 : 0;
        if (good >= 30) settled = performance.now() - t0;
      }
      this.lastF = performance.now();
    });
    await p;
    return { to: [Math.round(wx), Math.round(wy)], distanceCells: Math.round(Math.hypot(dx, dy * ROW_H)), warpMs: Math.round(warped), settledMs: settled >= 0 ? Math.round(settled) : 'not within 20 s', unit: 'ms from the warp asked (warpMs: every region written; settledMs: frames back to normal)', ...cap, view: this.view() };
  }
  private lastF = performance.now();
  /** (round 104) this zoom's parked rendered fps (the pan ramp stops when a step falls under a quarter of it) */
  private parkedFps = 60;

  private async meteor(): Promise<Record<string, unknown>> {
    const c = this.R.camera.target;
    const [ux, uy] = this.R.camera.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    // (40 cells up the screen from the target: in sight, not under the camera)
    const x = c[0] + (ux / l) * 40;
    const y = c[1] + (uy / l) * 40;
    const z = this.R.api?.terrain?.heightAt?.(x, y) ?? c[2];
    let fired = false;
    const cap = await this.capture(12, (t) => {
      if (!fired && t > 0.5) {
        fired = true;
        this.R.meteorNow(x, y, z);
      }
    });
    const cs = cap.cpuSteps as Record<string, { n: number; mean: number; max: number }>;
    const rb = cap.rockBodies as Stat | null;
    return {
      at: [Math.round(x), Math.round(y), Math.round(z)],
      judgePass: cs.judge ?? null,
      rockBodiesStep: cs.rockbodies ?? null,
      rockBodiesPerBody: cs.rockbodies && rb?.mean ? r3(cs.rockbodies.mean / rb.mean) : null,
      unit: 'ms CPU (judgePass: a pass of the integrity judge; rockBodiesPerBody: the rigid step a frame / bodies alive)',
      ...cap,
    };
  }
  private idleP50 = 17;

  // ---- hero ----

  async heroPage(out: Record<string, unknown>): Promise<void> {
    this.say('waiting for the run…');
    const run = await waitFor(() => this.R.run?.play && this.R.run, 120000);
    out.settleMs = await this.settle(5000);
    out.window = { w: this.W, h: this.R.stream.H };
    out.viewStanding = this.view();
    out.standing = await this.capture(6);
    this.say('the hero walking (25 s)…');
    // (a talk open holds the hero still: closed, as a player would tap it away)
    out.atStart = { dialogOpen: !!run.play?.dialog?.isOpen, ended: !!run.ended, alive: run.hero?.alive ?? null };
    if (run.play?.dialog?.isOpen) run.play.dialog.close?.();
    let ang = -Math.PI / 2;
    // (a copy: position() hands back the hero's own array, moved in place — v1 compared it with itself and saw no walk)
    let prev = [...run.hero.position()];
    let walked = 0;
    let placed = 0;
    let mode = 'stick';
    let lastPut = 0;
    const capt = await this.capture(25, (t) => {
      if (run.play?.dialog?.isOpen) run.play.dialog.close?.();
      const h = run.hero.position();
      const d = Math.hypot(h[0] - prev[0], h[1] - prev[1]);
      if (d < 50) walked += d;
      prev = [h[0], h[1], h[2]];
      // (the pad's scripted stick, as runtest.mjs: up the screen, a quarter turn every 8 s)
      ang = -Math.PI / 2 + Math.floor(t / 8) * (Math.PI / 2);
      if (mode === 'stick') {
        // (the TouchPad's scripted stick: its intent() reads it as a held stick — the same path a thumb takes)
        run.pad.scripted = { stick: [Math.cos(ang) * 56, Math.sin(ang) * 56] };
        // (the stick didn't move it in 4 s: the hero put down ahead every 0.5 s at a hover bike's pace, as runtest.mjs's ride)
        if (t > 4 && walked < 3) mode = 'placed';
      } else if (t - lastPut > 0.5 && !this.R.stream.busy && run.winOf && run.worldOf) {
        lastPut = t;
        const [ux, uy] = this.R.camera.screenDeltaToWorld(Math.cos(ang), Math.sin(ang));
        const l = Math.hypot(ux, uy) || 1;
        const wv = run.worldOf([h[0], h[1]]);
        const to = run.winOf([wv[0] + (ux / l) * 8, wv[1] + (uy / l) * 8]);
        if (this.R.api?.terrain?.heightAt?.(to[0], to[1]) !== null) {
          run.hero.place(to);
          placed++;
        }
      }
    });
    run.pad.scripted = null;
    out.walking = { ...capt, view: this.view(), movedBy: mode, walkedCells: Math.round(walked), placedSteps: placed };
  }

  // ---- the pan benchmark (round 104) ----

  /**
   * A pan page: one window, the zooms it covers. First the disk line is filled: a pan along it with every window region
   * marked touched, so each is written to the store as it leaves (and the pool forgets the start of it by the end).
   * Then for each zoom, three land sources, each a speed ramp (PAN_SPEEDS, PAN_STEP_S each) until a criterion fails:
   *  pool       back and forth over three regions where it is (what comes in is in the GPU pool)
   *  generated  along a line of its own, parallel, never seen (made by the generator as it comes)
   *  disk       along the filled line from its start (from the store: disk to memory to the GPU)
   */
  async panPage(out: Record<string, unknown>, zooms: number[]): Promise<void> {
    const sc = this.R.scene;
    const S = this.R.stream;
    const a = this.R.atlas;
    const cam = this.R.camera;
    sc.drive = null;
    sc.pan = null;
    this.say('settling…');
    out.settleMs = await this.settle(4000, 20000);
    out.window = { w: this.W, h: S.H };
    const W = this.W;
    // the line: up the screen from the start, in world cells (x) and world units (y)
    const [ux, uy] = cam.screenDeltaToWorld(0, -1);
    const l = Math.hypot(ux, uy) || 1;
    const dir: [number, number] = [ux / l, uy / l];
    const perp: [number, number] = [-dir[1], dir[0]];
    const start: [number, number] = [S.origin[0] + cam.target[0], (S.origin[1] * ROW_H + cam.target[1])];
    const toRows = (p: [number, number]): [number, number] => [p[0], p[1] / ROW_H];
    const dims = { w: S.W, h: S.H, zMax: this.R.core.dims.zMax };
    const goToWorld = async (p: [number, number]) => {
      await warpWindow(a, S, dims, ...toRows(p));
      await this.settle(1500, 15000);
    };
    // the disk line, filled: every region the window holds marked touched as it pans (saved as it leaves)
    const fillLen = PAN_SPEEDS.reduce((t, v) => t + v * PAN_STEP_S, 0) + W;
    this.say(`filling the disk line (${Math.round(fillLen)} cells)…`);
    const f0 = performance.now();
    const saved0 = S.stats.saved;
    cam.zoom = Math.min(...zooms);
    sc.pan = { speed: 300, dir, t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
    try {
      while (sc.pan.asked < fillLen) {
        await frame();
        S.touch(0, 0, S.W, S.H);
        if (performance.now() - f0 > 60000) break;
      }
    } finally {
      sc.pan = null;
    }
    await this.settle(1500, 20000);
    await S.store?.flush?.();
    out.fill = { cells: Math.round(fillLen), ms: Math.round(performance.now() - f0), regionsSaved: S.stats.saved - saved0, storeRegions: S.store?.size ?? null };
    const rows: Record<string, unknown>[] = [];
    out.zooms = rows;
    let lane = 0;
    for (const z of zooms) {
      const row: Record<string, unknown> = { zoom: z };
      rows.push(row);
      for (const src of ['pool', 'generated', 'disk'] as const) {
        this.say(`zoom ${z}, ${src}: placing…`);
        if (src === 'generated') await goToWorld([start[0] + perp[0] * (lane + 1) * (W + 512), start[1] + perp[1] * (lane + 1) * (W + 512)]);
        if (src === 'disk') await goToWorld(start);
        if (src === 'pool') {
          // (a first leg there and back: what the pings bring in is in the pool)
          await this.settle(1000, 10000);
        }
        cam.zoom = z;
        await sleep(600);
        this.parkedCover = this.writtenShare();
        row.coverParked = r3(this.parkedCover);
        // (the window's own cost at this zoom, parked: what a pan's frames are measured against)
        if (!row.parked) {
          const pk = await this.capture(3);
          const fr = pk.frames as Stat | null;
          row.parked = { fps: pk.fps, p50: fr?.p50 ?? null, p99: pk.p99, max: fr?.max ?? null, overBudget: null, unit: 'rendered fps; ms' };
          this.parkedFps = pk.fps as number;
        }
        row[src] = await this.panRamp(z, src, dir);
      }
      lane++;
    }
  }

  /** One speed ramp: each speed PAN_STEP_S s, measured; the last that passed, and why the next didn't */
  private async panRamp(zoom: number, src: 'pool' | 'generated' | 'disk', dir: [number, number]): Promise<Record<string, unknown>> {
    const sc = this.R.scene;
    const cam = this.R.camera;
    const steps: Record<string, unknown>[] = [];
    let maxSmooth: number | null = null;
    let failedFirst: string | null = null;
    let failedAt: number | null = null;
    let causesAtFail: unknown = null;
    let maxNoPopIn: number | null = null;
    let popInAt: number | null = null;
    let strict = true;
    const anchor: [number, number] = [cam.target[0], cam.target[1]];
    let sign = 1;
    let st0 = { ...this.R.stream.stats };
    sc.pan = { speed: PAN_SPEEDS[0], dir: [...dir], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
    try {
      if (src === 'pool') {
        // (the pool warmed: once there and back over the three regions)
        sc.pan.speed = 120;
        for (const leg of [1, -1]) {
          sc.pan.dir = [dir[0] * leg, dir[1] * leg];
          const t0 = performance.now();
          while (performance.now() - t0 < 1800) await frame();
        }
        sc.pan.dir = [...dir];
      }
      // (a warm-up at the first speed, not measured: the streaming going, the window placed's own work done)
      sc.pan.speed = PAN_SPEEDS[0];
      {
        const t0 = performance.now();
        while (performance.now() - t0 < 2000) {
          await frame();
          if (src === 'pool') {
            const off = (cam.target[0] - anchor[0]) * dir[0] + (cam.target[1] - anchor[1]) * dir[1];
            if (off > 192 && sign > 0) sign = -1;
            else if (off < 0 && sign < 0) sign = 1;
            sc.pan.dir = [dir[0] * sign, dir[1] * sign];
          }
        }
      }
      // (where the land that came in came from, during the ramp: the source is what it says)
      st0 = { ...this.R.stream.stats };
      for (const v of PAN_SPEEDS) {
        this.say(`zoom ${zoom}, ${src}: ${v} cells/s…`);
        sc.pan.speed = v;
        this.ctx.hitch?.rec?.reset();
        // (round 104) each slide's GPU time by onSubmittedWorkDone (Mali's sane clock), the queue's usual lag, the slide's CPU
        const S = this.R.stream;
        const sd0 = S.slideDone?.length ?? 0;
        const bd0 = S.baseDone?.length ?? 0;
        const tr0 = S.trace.length;
        const frames: number[] = [];
        let low = 0;
        const fno0 = this.prof.frameNo;
        let fno = fno0;
        const sl0 = this.R.stream.stats.slides;
        const t0 = performance.now();
        let last = t0;
        // (round 106, tilephone: the tiles' render-only land during the step — what's baked, its stages, the leading half)
        const TL = this.R.core.renderer.tiles;
        const baked0 = (TL?.land?.stats.baked as number | undefined) ?? 0;
        const lead: number[] = [];
        const miss = { win: 0, ahead: 0, side: 0, behind: 0 };
        while (performance.now() - t0 < PAN_STEP_S * 1000) {
          const t = await frame();
          if (src === 'pool') {
            const off = (cam.target[0] - anchor[0]) * dir[0] + (cam.target[1] - anchor[1]) * dir[1];
            if (off > 192 && sign > 0) sign = -1;
            else if (off < 0 && sign < 0) sign = 1;
            sc.pan.dir = [dir[0] * sign, dir[1] * sign];
          }
          if (this.prof.frameNo === fno) continue;
          fno = this.prof.frameNo;
          frames.push(t - last);
          last = t;
          low = Math.max(low, this.parkedCover - this.writtenShare());
          if (TL) lead.push(1 - TL.coverageSplit(cam).lead);
          // (round 106: where what's not in detail is, the worst frame's of each kind)
          const mw = this.missingWhere(sc.pan.dir);
          for (const k of ['win', 'ahead', 'side', 'behind'] as const) miss[k] = Math.max(miss[k], mw[k]);
        }
        const secs = (performance.now() - t0) / 1000;
        const fps = (this.prof.frameNo - fno0) / secs;
        const sorted = [...frames].sort((x, y) => x - y);
        const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? Infinity;
        const max = sorted[sorted.length - 1] ?? Infinity;
        const fails: string[] = [];
        if (fps < PAN_FPS) fails.push(`fps ${fps.toFixed(0)}`);
        if (max > PAN_MAX_FRAME) fails.push(`frame ${max.toFixed(0)} ms`);
        if (p99 > PAN_P99) fails.push(`p99 ${p99.toFixed(0)} ms`);
        const popIn = low > 0.001;
        if (popIn) fails.push(`pop-in ${(low * 100).toFixed(0)}% of the screen`);
        const slides = this.R.stream.stats.slides - sl0;
        const over = frames.filter((f) => f > PAN_BUDGET).length;
        // (the arrays keep their last 64 / 200: what came in during the step)
        const slideDone = S.slideDone ? S.slideDone.slice(Math.min(sd0, S.slideDone.length)) : null;
        const bd = S.baseDone ? [...S.baseDone.slice(Math.min(bd0, S.baseDone.length))].sort((x: number, y: number) => x - y) : [];
        const slideCpu = S.trace.slice(Math.min(tr0, S.trace.length)).map((t: { t0: number; sync: number }) => r3(t.sync - t.t0));
        const tiles = TL?.land ? { ...tileStepOf(TL, baked0, t0, secs, lead), missMax: { win: r3(miss.win), ahead: r3(miss.ahead), side: r3(miss.side), behind: r3(miss.behind) } } : null;
        steps.push({ speed: v, fps: +fps.toFixed(1), p99: r3(p99), max: r3(max), lowDetailMax: r3(low), tiles, slides, framesOverBudget: over, overBudgetPerSlide: slides ? r3(over / slides) : null, slideDoneMs: slideDone, baseDoneP50: bd.length ? bd[Math.floor(bd.length / 2)] : null, slideCpuMs: slideCpu, ok: !fails.length });
        if (fails.length && strict) {
          strict = false;
          failedFirst = fails.join(', ');
          failedAt = v;
          const rep = this.ctx.hitch?.rec?.report() as { causes?: unknown; worst?: { ms: number; cause: string; steps: { label: string; ms: number }[]; async: { label: string; ms: number }[] }[] } | undefined;
          causesAtFail = rep ? { causes: rep.causes, worst: (rep.worst ?? []).slice(0, 3).map((h) => `${h.ms} ${h.cause} ${[...h.steps, ...h.async].slice(0, 2).map((x) => `${x.label} ${x.ms}`).join(', ')}`) } : null;
        }
        if (strict) maxSmooth = v;
        // (the ramp goes on past frames over budget: the fastest it keeps the screen in detail, apart)
        if (popIn) {
          popInAt = v;
          break;
        }
        maxNoPopIn = v;
        if (fps < Math.max(8, this.parkedFps / 4)) break;
      }
    } finally {
      sc.pan = null;
    }
    const st1 = this.R.stream.stats;
    const came = { generated: st1.generated - st0.generated, fromPool: st1.thawed - st0.thawed, fromDisk: st1.loaded - st0.loaded, slides: st1.slides - st0.slides };
    return { maxSmooth, failedFirst, failedAt, causesAtFail, maxNoPopIn, popInAt, came, steps };
  }

  // ---- other window sizes ----

  async winPage(out: Record<string, unknown>): Promise<void> {
    const sc = this.R.scene;
    // (the ride's road, kept for later — the smoke run found v3 dropped it before keeping it)
    const drive = sc.drive;
    sc.drive = null;
    sc.pan = null;
    this.say('settling…');
    out.settleMs = await this.settle(5000);
    out.window = { w: this.W, h: this.R.stream.H };
    out.view = this.view();
    this.framesHook = (f) => (this.idleFrames = f);
    out.parked = await this.capture(4);
    this.framesHook = null;
    // (v3) a short ride; (v4) the A/B of what scales with the window while it rides on, a storm over it
    this.say('a short ride (10 s)…');
    await this.settle(1000, 10000);
    if (drive) {
      sc.drive = drive;
      out.ride = { ...(await this.capture(10)), view: this.view() };
      out.abStorm = this.storm();
      await sleep(1000);
      out.ab = await this.ab(AB_WINDOW, 1.5, `riding at 18 cells/s, ${out.abStorm}`);
      this.say('each system\'s GPU time, one pass each…');
      out.systemGpu = await this.systemGpu(`riding at 18 cells/s, ${out.abStorm}`);
      sc.drive = null;
    } else out.ab = await this.ab(AB_WINDOW, 1.5, 'parked (no road)');
    out.maxPan = await this.maxPan();
  }
}

// ---------- the report ----------

function makeReport(s: BenchState): Record<string, unknown> {
  const res = s.results as Record<string, any>;
  // (v4: the sandbox is two pages now — the pans page's numbers alongside the main page's)
  const main = { ...(res.pans ?? {}), ...(res.main ?? {}), ...Object.fromEntries(Object.entries(res.pans ?? {}).filter(([k]) => /^(pan\d+|maxPan|warp|meteor|abMeteor)$/.test(k))) };
  const idle = main.idle ?? {};
  // (v2: not from timestamps a GPU got wrong; the budget is then the frame interval's and the A/B's)
  const gpuIdle = typeof idle.gpuFrame === 'object' && idle.timestamps?.reliable !== false ? idle.gpuFrame.p50 : null;
  const frameIdle = idle.frames?.p50 ?? null;
  const W = main.window?.w ?? 320;
  const R = main.window?.region ?? 64;
  const derived: Record<string, unknown> = { window: W, region: R };
  // the region rate at each tile count, and the camera speed it sustains: a move of R cells along an axis brings W/R regions
  const tiles = main.tiles ?? {};
  const speeds: Record<string, unknown> = {};
  let best = 0;
  let bestK = 0;
  for (const k of [1, 2, 4, 8]) {
    const t = tiles[`k${k}`];
    if (!t?.regionsPerSecond) continue;
    // (the tile rate's regions: a region is (R/32)^2 tiles — plan batches counted as the work they are)
    const rate = t.regionsPerSecondFromTiles ?? t.regionsPerSecond;
    const v = (rate * R * R) / W;
    speeds[`k${k}`] = { regionsPerSecond: rate, measuredRegionsPerSecond: t.regionsPerSecond, maxCameraCellsPerSecondAxis: +v.toFixed(1), maxCameraCellsPerSecondDiagonal: +((rate * R * R) / (2 * W - R) * Math.SQRT2).toFixed(1), frameP95: t.frames?.p95 ?? null };
    if (rate > best) {
      best = rate;
      bestK = k;
    }
  }
  derived.cameraSpeed = { unit: 'cells/s, the camera moving straight on with no prefetch beyond the window', rule: 'regions/s x R^2 / W (axis); diagonal: a strip and a column a region moved', ...speeds };
  const tileMs = tiles.k1?.gpuColFinishPerTile?.p50 ?? null;
  const regGpu = main.regionStages?.gpu;
  const fixedRegionMs = typeof regGpu === 'object' ? (regGpu.colHeight?.p50 ?? 0) + (regGpu.formSeed?.p50 ?? 0) : null;
  const budget = (fps: number) => (gpuIdle !== null ? +(1000 / fps - gpuIdle).toFixed(2) : null);
  derived.gpuBudget = {
    unit: 'GPU ms a frame',
    parkedGpuFrameP50: gpuIdle,
    parkedFrameIntervalP50: frameIdle,
    leftAt60: budget(60),
    leftAt30: budget(30),
    note: gpuIdle === null ? 'no timestamp-query: the frame interval only' : 'the frame period less the parked GPU frame (p50)',
  };
  const suggest = (left: number | null) => (left !== null && tileMs ? Math.max(1, Math.floor((left * 0.5) / tileMs)) : null);
  derived.tilesPerFrame = {
    gpuMsPerTile: tileMs,
    regionFixedGpuMs: fixedRegionMs,
    suggestedAt60: suggest(budget(60)),
    suggestedAt30: suggest(budget(30)),
    rule: 'half the GPU time left at that rate / colFinish ms a 32x32 tile (the other half for play); a region is 4 tiles + colHeight + formSeed once',
    measuredBest: bestK ? { tilesPerFrame: bestK, regionsPerSecond: best } : null,
  };
  if (best) {
    const cells = best * R * R;
    derived.precache = {
      unit: 'at the measured best region rate',
      cellsPerSecond: Math.round(cells),
      areaSidePerSecond: +Math.sqrt(cells).toFixed(0),
      windowSecondsToFill: +((W / R) ** 2 / best).toFixed(1),
      ringOf1RegionAroundWindowSeconds: +((4 * (W / R) + 4) / best).toFixed(1),
      note: 'how much land could be made ahead of a ride or round a warp target a second, if generation had the GPU to itself at that tile rate',
    };
  }
  const t0 = res.thermalStart?.gpu?.p50 ?? res.thermalStart?.wall?.p50;
  const t1 = res.thermalEnd?.gpu?.p50 ?? res.thermalEnd?.wall?.p50;
  derived.thermal = t0 && t1 ? { startMs: t0, endMs: t1, driftPct: +((100 * (t1 - t0)) / t0).toFixed(1), how: res.thermalStart?.gpu?.p50 ? 'GPU (timestamp)' : 'wall' } : null;
  const hero = res.hero ?? {};
  derived.heroVsSandbox = {
    sandboxRide: main.ride?.frames ?? null,
    heroWalking: hero.walking?.frames ?? null,
    sandboxView: main.ride?.view ?? main.view ?? null,
    heroView: hero.walking?.view ?? hero.viewStanding ?? null,
    sandboxGpuGroups: main.ride?.gpuGroups ?? null,
    heroGpuGroups: hero.walking?.gpuGroups ?? null,
  };
  const ride = main.ride ?? {};
  derived.mesh = main.mesh ? { unit: 'GPU ms', perChunk: main.mesh.perChunk, slotsPerFrame: main.mesh.slotsPerFrame, parkedPerFrame: main.mesh.parkedMeshPerFrame?.p50 ?? null, ridingPerFrame: ride.meshFrame?.p50 ?? null } : null;
  derived.sims = { parked: idle.simPerAwakeChunk ?? null, riding: ride.simPerAwakeChunk ?? null };
  derived.judge = main.meteor ? { judgePass: main.meteor.judgePass, rockBodiesStep: main.meteor.rockBodiesStep, rockBodiesPerBody: main.meteor.rockBodiesPerBody, bodies: main.meteor.rockBodies } : null;
  // (v2) the A/B: the costliest systems; and what scales with the window (its cost at each window size)
  const abSys = (main.ab?.systems ?? {}) as Record<string, any>;
  const costs = Object.entries(abSys)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => [k, v.costFrameMs, v.costDrainMs] as [string, number, number])
    .sort((a, b) => b[1] - a[1]);
  derived.ab = { unit: 'ms a frame (frame interval with it on - off; drain)', top: costs.slice(0, 12).map(([k, f, d]) => `${k} ${f} / ${d}`) };
  const wins: Record<string, Record<string, any>> = { [String(W)]: abSys };
  for (const k of Object.keys(res)) if (/^win\d+$/.test(k) && res[k]?.ab?.systems) wins[k.slice(3)] = res[k].ab.systems;
  const sizes = Object.keys(wins).map(Number).sort((a, b) => a - b);
  const scaling: Record<string, unknown> = {};
  for (const k of AB_WINDOW) {
    const by = sizes.map((w) => wins[String(w)]?.[k]?.costFrameMs ?? null);
    const fps = sizes.map((w) => wins[String(w)]?.[k]?.fpsOn ?? null);
    if (by.every((v) => v === null)) continue;
    const a = by[0];
    const b = by[by.length - 1];
    scaling[k] = { costFrameMs: Object.fromEntries(sizes.map((w, i) => [w, by[i]])), fpsOn: Object.fromEntries(sizes.map((w, i) => [w, fps[i]])), ratioLargestToSmallest: a && b && a > 0.2 ? r3(b / a) : null };
  }
  derived.windowScaling = { sizes, areaRatio: sizes.length > 1 ? r3((sizes[sizes.length - 1] / sizes[0]) ** 2) : null, note: 'a system that scales with the window costs about areaRatio times more at the largest; costs under ~0.3 ms are noise', systems: scaling };
  // (v3) per window size: rendered fps parked and riding, the fastest pan it sustains
  const table: Record<string, unknown> = {};
  const pageOf = (w: number) => (w === W ? { parked: main.idle, ride: main.ride, maxPan: main.maxPan } : res[`win${w}`]);
  for (const w of [...WINDOWS].sort((a, b) => a - b)) {
    const pg = pageOf(w);
    if (!pg || (w === W && !main.idle)) continue;
    table[w] = pg.error
      ? { error: pg.error }
      : {
          parkedFps: pg.parked?.fps ?? null,
          rideFps: pg.ride?.fps ?? null,
          rideP95: pg.ride?.frames?.p95 ?? null,
          maxPan: pg.maxPan?.maxSustainable ?? null,
          stoppedBy: pg.maxPan?.stoppedBy ?? null,
          // (v4) the share of the screen in the window's detail: parked, riding, and over the pans (the main page's)
          detailParked: pg.parked?.screenInDetail?.mean ?? null,
          detailRiding: pg.ride?.screenInDetail?.mean ?? null,
          simsGpuMs: pg.systemGpu?.systems ? r3(Object.entries(pg.systemGpu.systems as Record<string, { gpuMs: number | null }>).filter(([k]) => k !== 'agents').reduce((a, [, v]) => a + (v.gpuMs ?? 0), 0)) : null,
          awakeChunks: pg.systemGpu?.awakeChunks ?? null,
          windowChunks: pg.systemGpu?.windowChunks ?? null,
        };
  }
  // (v4) the window the screen needs (95% of it in detail at the sandbox's zoom), and what a frame costs there: measured
  // if it's one of the sizes, else the frame time's line in the window's area through the sizes measured
  const need = (main.ride?.view?.windowFor95 ?? main.view?.windowFor95 ?? null) as number | null;
  const pts = Object.entries(table)
    .map(([w, v]: [string, any]) => [Number(w), v?.rideFps ?? v?.parkedFps] as [number, number])
    .filter(([, f]) => f > 0)
    .map(([w, f]) => [w * w, 1000 / f] as [number, number]);
  let at: unknown = null;
  if (need && pts.length >= 2) {
    const n = pts.length;
    const mx = pts.reduce((a, [x]) => a + x, 0) / n;
    const my = pts.reduce((a, [, y]) => a + y, 0) / n;
    const b = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / Math.max(1e-9, pts.reduce((a, [x]) => a + (x - mx) ** 2, 0));
    const ms = my + b * (need * need - mx);
    at = { window: need, frameMs: r3(ms), fps: +(1000 / ms).toFixed(1), how: (table as Record<string, unknown>)[need] ? 'measured' : 'extrapolated: frame ms linear in the window\'s area through the sizes measured (riding, else parked)', msPerMillionCells: r3(b * 1e6) };
  }
  derived.coverage = { unit: 'share of the screen in the window\'s detail', windowFor95AtSandboxZoom: need, heroWindowFor95: res.hero?.walking?.view?.windowFor95 ?? null, costThere: at };
  derived.byWindow = { unit: 'rendered fps; maxPan cells/s; detail = share of the screen in the window\'s detail; simsGpuMs = the sims\' GPU ms a tick, one pass each', table };
  const tsJ = main.timestampsJudged as { reliable: boolean | null; why: string }[] | undefined;
  const tsBad = tsJ?.find((t) => t.reliable === false);
  const tsSum = { reliable: tsJ?.length ? !tsBad : null, why: tsBad?.why ?? tsJ?.[0]?.why ?? 'n/a', modes: res.timestampModes ? Object.fromEntries(['onePassEach', 'ownEncoderEach', 'allInOnePass'].map((m) => [m, res.timestampModes[m] ? { sumP50: res.timestampModes[m].sum?.p50, wallP50: res.timestampModes[m].wall?.p50, sumOverWall: res.timestampModes[m].sumOverWall } : null])) : null };
  const fpsOf = (c: any) => (c?.fps ?? null);
  const head = {
    note: 'the headline numbers; everything below is detail',
    device: `${res.device?.adapter?.vendor ?? '?'} ${res.device?.adapter?.architecture ?? ''}, dpr ${res.device?.devicePixelRatio}, css ${res.device?.css?.w}x${res.device?.css?.h}`,
    timestamps: tsSum,
    window: W,
    fps: { parked: fpsOf(idle), ride: fpsOf(main.ride), pan120: fpsOf(main.pan120), warp: fpsOf(main.warp), hero: fpsOf(res.hero?.walking), ...Object.fromEntries(Object.keys(res).filter((k) => /^win\d+$/.test(k)).map((k) => [k, fpsOf(res[k]?.parked)])) },
    frameP95: { parked: idle.frames?.p95 ?? null, ride: main.ride?.frames?.p95 ?? null, pan120: main.pan120?.frames?.p95 ?? null, hero: res.hero?.walking?.frames?.p95 ?? null },
    byWindow: table,
    coverage: derived.coverage,
    pansDetail: Object.fromEntries([80, 120, 160, 240, 320].map((v) => [v, main[`pan${v}`]?.screenInDetail?.mean ?? null])),
    systemGpu: main.systemGpu?.systems ? Object.fromEntries(Object.entries(main.systemGpu.systems as Record<string, { gpuMs: number | null }>).sort((a, b) => (b[1].gpuMs ?? 0) - (a[1].gpuMs ?? 0)).slice(0, 10).map(([k, v]) => [k, v.gpuMs])) : null,
    pans: Object.fromEntries([80, 120, 160, 240, 320].map((v) => [v, main[`pan${v}`] ? { fps: main[`pan${v}`].fps, p95: main[`pan${v}`].frames?.p95 ?? null, lowDetailP95: main[`pan${v}`].lowDetail?.p95 ?? null } : null])),
    abTop: derived.ab,
    abBound: main.ab?.bound ?? null,
    windowScaling: Object.fromEntries(Object.entries(scaling).map(([k, v]: [string, any]) => [k, v.costFrameMs])),
    region: { wallMs: main.regionStages?.cpu?.total?.p50 ?? null, cutPackMs: main.regionStages?.cpu?.cutPack?.p50 ?? null, columnsWallMs: main.regionStages?.cpu?.columnsWall?.p50 ?? null, mainThreadMs: main.regionStages?.cpu?.mainThread?.p50 ?? null, path: main.regionStages?.path ?? 'cpu', cpuPathWallMs: main.regionStagesCpu?.cpu?.total?.p50 ?? null },
    tilesRegionsPerSecond: Object.fromEntries([1, 2, 4, 8].map((k) => [k, main.tiles?.[`k${k}`]?.regionsPerSecondFromTiles ?? null])),
    warp: { landMs: main.warp?.warpMs ?? null, settledMs: main.warp?.settledMs ?? null },
    hero: { movedBy: res.hero?.walking?.movedBy ?? null, walkedCells: res.hero?.walking?.walkedCells ?? null, zoom: res.hero?.walking?.view?.zoom ?? null, footprint: res.hero?.walking?.view?.footprintCells?.w ?? null, sandboxZoom: main.ride?.view?.zoom ?? null, sandboxFootprint: main.ride?.view?.footprintCells?.w ?? null },
    thermalDriftPct: (derived.thermal as { driftPct?: number } | null)?.driftPct ?? null,
    errors: s.errors.length,
  };
  return {
    kind: 'reclaimed-bench',
    version: BENCH_VERSION,
    summary: head,
    id: s.id,
    startedAt: s.startedAt,
    finishedAt: new Date().toISOString(),
    build: location.origin + location.pathname,
    errors: s.errors,
    derived,
    ...s.results,
  };
}

/** a few headline numbers for the screen (the JSON has the rest) */
function summary(r: Record<string, any>): string {
  const d = r.derived ?? {};
  const f = (x: any) => (x && typeof x === 'object' ? `${x.p50}/${x.p95}/${x.max}` : '–');
  const lines = [
    `GPU: ${r.device?.adapter?.vendor ?? '?'} ${r.device?.adapter?.architecture ?? ''}  timestamps: ${r.device?.timestampQuery ? 'yes' : 'no'}`,
    `parked frame p50/p95/max: ${f(r.main?.idle?.frames)} ms; GPU ${f(r.main?.idle?.gpuFrame)} ms`,
    `ride: ${f(r.main?.ride?.frames)} ms  hero: ${f(r.hero?.walking?.frames)} ms`,
    `regions/s at 1/2/4/8 tiles: ${[1, 2, 4, 8].map((k) => r.main?.tiles?.[`k${k}`]?.regionsPerSecondFromTiles ?? r.main?.tiles?.[`k${k}`]?.regionsPerSecond ?? '–').join(' / ')}`,
    `warp: land in ${r.main?.warp?.warpMs ?? '–'} ms, settled ${r.main?.warp?.settledMs ?? '–'}`,
    `view: sandbox zoom ${r.main?.ride?.view?.zoom ?? '–'} (${r.main?.ride?.view?.footprintCells?.w ?? '–'} cells across), hero zoom ${r.hero?.walking?.view?.zoom ?? '–'} (${r.hero?.walking?.view?.footprintCells?.w ?? '–'})`,
    `timestamps: ${r.summary?.timestamps?.reliable === false ? 'UNRELIABLE (A/B used)' : r.summary?.timestamps?.reliable ? 'ok' : 'n/a'}`,
    `A/B top: ${(d.ab?.top ?? []).slice(0, 4).join(', ')}`,
    `by window (parked / ride fps, max pan): ${Object.entries(d.byWindow?.table ?? {}).map(([w, v]: [string, any]) => `${w}: ${v.parkedFps ?? '–'}/${v.rideFps ?? '–'}, ${v.maxPan ?? '–'}`).join('; ')}`,
    `screen in detail: window ${d.coverage?.windowFor95AtSandboxZoom ?? '–'} for 95% at the sandbox zoom (${d.coverage?.costThere?.fps ?? '–'} fps there, ${d.coverage?.costThere?.how ?? ''})`,
    `thermal drift: ${d.thermal?.driftPct ?? '–'}%   errors: ${r.errors?.length ?? 0}`,
  ];
  return lines.join('\n');
}
