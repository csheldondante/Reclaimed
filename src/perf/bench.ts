// Round 101 (bench): the calibration benchmark (`?bench=1`). The user (DECISIONS round 101): "Can you build a
// calibration test that we can run on the phone to directly give you benchmark numbers? … so you can compute
// throughput and then target the actual bottlenecks." One tap, about 3–5 minutes, then a report (one versioned JSON)
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
import { warpWindow } from '../api/atlas-world';
import { cpuStats } from '../gpu/cpustat';
import type { Profiler } from '../gpu/profiler';
import type { Host, Scene } from '../scenes/world-core';
import { RANGES } from '../scenes/range';
import { RegionStore } from '../world/region-store';
import type { HitchBoot } from './start';
import { copyText, deviceTag, downloadJson, postDev, shareJson, stamp } from './report-io';

export const BENCH_VERSION = 1;
const STATE = 'reclaimed.bench.state';
const LAST = 'reclaimed.bench.last';
const ROW_H = Math.sqrt(3) / 2;
/** the riding scenario's start (scripts/hitchrun.mjs: a road in a temperate place on the default seed) */
const RIDE_AT = '15024,14337';
/** the URL keys the suite sets itself (the rest of the start page's URL is carried to every page) */
const OWN = ['bench', 'benchpage', 'run', 'win', 'drive', 'at', 'hitch', 'hitchhud', 'world', 'skipmenu', 'level', 'tutorial', 'perf'];

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
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const MB = 1048576;

// ---------- the suite's state ----------

interface PageSpec {
  name: string;
  params: Record<string, string>;
}

interface BenchState {
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

function load(): BenchState | null {
  try {
    const s = JSON.parse(localStorage.getItem(STATE) ?? 'null') as BenchState | null;
    return s && s.version === BENCH_VERSION ? s : null;
  } catch {
    return null;
  }
}

function save(s: BenchState): void {
  try {
    localStorage.setItem(STATE, JSON.stringify(s));
  } catch (e) {
    throw new Error(`bench: localStorage refused the suite's state (${(e as Error).message}) — the benchmark needs it between pages`);
  }
}

function go(s: BenchState): void {
  s.step++;
  save(s);
  const p = s.pages[s.step];
  const q = new URLSearchParams(s.base);
  q.set('bench', '1');
  q.set('benchpage', p.name);
  for (const [k, v] of Object.entries(p.params)) q.set(k, v);
  location.href = `${location.pathname}?${q.toString()}`;
}

/** What this page is in the suite: the start screen, a level page, the end — or not the benchmark at all. */
export function benchMode(params: URLSearchParams): 'start' | 'final' | 'level' | null {
  if (params.get('bench') !== '1') return null;
  const page = params.get('benchpage');
  const s = load();
  if (!page || !s || s.done || s.pages[s.step]?.name !== page) return 'start';
  return page === 'final' ? 'final' : 'level';
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
class GpuTimer {
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
    devicePixelRatio: devicePixelRatio,
    screen: { w: screen.width, h: screen.height },
    css: { w: innerWidth, h: innerHeight },
    quality: { tier: host.qualityName, ...host.quality },
  };
}

// ---------- the start and the end (no level) ----------

/** The start screen (one tap), or the end (the report). Runs instead of a scene: nothing else draws. */
export async function benchStandalone(mode: 'start' | 'final', host: Host): Promise<void> {
  const panel = new Panel(host.ui);
  if (mode === 'final') return finish(host, panel);
  panel.text('Reclaimed calibration benchmark');
  panel.text('About 3–5 minutes. The page reloads itself a few times — leave it in front, plugged in if you can, and don’t touch the screen till the report shows. Your own saved world isn’t touched.');
  const last = (() => {
    try {
      return localStorage.getItem(LAST);
    } catch {
      return null;
    }
  })();
  panel.button('Start benchmark', true, () => void start(host, panel));
  if (last) {
    panel.text('The last result is kept:');
    reportButtons(panel, last);
  }
  panel.say('');
}

async function start(host: Host, panel: Panel): Promise<void> {
  panel.el.querySelectorAll('button').forEach((b) => b.remove());
  const awake = await keepAwake();
  const old = load();
  const id = `${stamp()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const q = new URLSearchParams(location.search);
  for (const k of OWN) q.delete(k);
  const s: BenchState = { version: BENCH_VERSION, id, startedAt: new Date().toISOString(), step: 0, pages: [], base: q.toString(), worlds: old?.worlds ?? [], results: {}, errors: [] };
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
    { name: 'hero', params: { ...common, run: 'bell' } },
  ];
  // the other window sizes (the main page has the viewer's own: the stored range, else the tier's)
  const own = myWin ?? (host.qualityName === 'low' && host.params.get('phone') !== '0' ? 320 : 256);
  for (const w of RANGES) if (w !== own) s.pages.push({ name: `win${w}`, params: { ...common, at: RIDE_AT, win: String(w) } });
  s.pages.push({ name: 'final', params: {} });
  const t0 = performance.now();
  panel.say('device facts…');
  s.results.device = await deviceFacts(host);
  s.results.wakeLock = awake;
  const timer = new GpuTimer(host.gpu.device);
  panel.say('the fixed GPU workload (thermal, first)…');
  await frame();
  s.results.thermalStart = { at: new Date().toISOString(), ...(await fixedWorkload(host.gpu.device, timer)) };
  panel.say('readback, upload and copy rates…');
  await frame();
  s.results.io = await ioRates(host.gpu.device);
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

function reportButtons(panel: Panel, body: string): void {
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
  panel.button('Download report', true, () => void nameOf().then((n) => say(downloadJson(body, n))));
  panel.button('Copy', false, () => void copyText(body).then(say, (e: Error) => say(`copy failed: ${e.message}`)));
  panel.button('Share…', false, () => void nameOf().then(async (n) => say((await shareJson(body, n, 'Reclaimed benchmark')) || 'this browser can’t share files: use Download')));
  panel.el.appendChild(status);
}

async function finish(host: Host, panel: Panel): Promise<void> {
  const s = load()!;
  panel.say('the fixed GPU workload again (the drift)…');
  await keepAwake();
  await sleep(1500);
  const timer = new GpuTimer(host.gpu.device);
  s.results.thermalEnd = { at: new Date().toISOString(), ...(await fixedWorkload(host.gpu.device, timer)) };
  s.results.ioEnd = await ioRates(host.gpu.device, true);
  await clearWorlds(s);
  const report = makeReport(s);
  const body = JSON.stringify(report);
  try {
    localStorage.setItem(LAST, body);
  } catch {
    s.errors.push('localStorage refused the result (too big?): download it now');
  }
  s.done = true;
  save(s);
  (window as unknown as { reclaimedBench: unknown }).reclaimedBench = report;
  try {
    await wakeLock?.release();
  } catch {
    // (already let go)
  }
  panel.say('Benchmark done.');
  panel.text(summary(report));
  reportButtons(panel, body);
  const dev = await postDev(body, 'bench');
  if (dev) panel.text(`dev server: ${dev}`, true);
  panel.button('Run again', false, () => {
    location.href = `${location.pathname}?bench=1`;
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
  const s = load()!;
  const page = s.pages[s.step];
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
    panel.say(`${s.step}/${s.pages.length - 1} ${page.name}: loading…`);
    const R = await waitFor(() => {
      const r = (window as unknown as { reclaimed?: Record<string, unknown> }).reclaimed;
      return r?.stream && (r.stream as { store?: unknown }).store ? r : null;
    }, 240000);
    // (ms from the page's navigation to the level ready: the atlas built, the window made, the store open)
    out.readyAtMs = Math.round(performance.now());
    const B = new Bench(ctx, R as unknown as Engine, panel, `${s.step}/${s.pages.length - 1} ${page.name}`);
    if (!s.worlds.includes(B.R.stream.save.world)) s.worlds.push(B.R.stream.save.world);
    save(s);
    if (page.name === 'main') await B.mainPage(out);
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
    this.panel.say(`${this.tag}: ${s}`);
  }

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

  private async captureRaw(seconds: number, during?: (t: number) => void): Promise<Record<string, unknown>> {
    const rec = this.ctx.hitch?.rec;
    rec?.reset();
    this.prof.resetTotals();
    cpuStats.clear();
    const st0 = { ...this.R.stream.stats };
    const sm: Sample = { frames: [], gpu: [], passes: new Map(), awake: [], ticks: 0, grid: [], voxel: [], bodies: [], mesh: [] };
    const prevOnFrame = this.prof.onFrame;
    const perName = (this.prof as unknown as { perName: Map<string, number> }).perName;
    this.prof.onFrame = (f, ms, top) => {
      prevOnFrame?.(f, ms, top);
      sm.gpu.push(ms);
      let mesh = 0;
      for (const [n, v] of perName) {
        (sm.passes.get(n) ?? sm.passes.set(n, []).get(n)!).push(v);
        if (n.includes('fieldmesh')) mesh += v;
      }
      sm.mesh.push(mesh);
    };
    const tick0 = this.R.core.sim.tick;
    const t0 = performance.now();
    let last = t0;
    const sleepSys = this.R.scene.sleep;
    try {
      for (;;) {
        const t = await frame();
        sm.frames.push(t - last);
        last = t;
        if (sleepSys) sm.awake.push(sleepSys.awake);
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
    const cpu: Record<string, unknown> = {};
    for (const [k, v] of [...cpuStats].sort((a, b) => b[1].sum - a[1].sum).slice(0, 40)) cpu[k] = { n: v.n, mean: r3(v.sum / Math.max(1, v.n)), max: r3(v.max), totalMs: Math.round(v.sum), unit: 'ms CPU' };
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
      hitch = { causes: r.causes, worst: r.worst, heldForGpu: r.heldForGpu, gc: r.gc, threshold: r.thresholdMs, hitches: (r.hitches as unknown[]).length };
    }
    return {
      seconds: +secs.toFixed(1),
      frames: stat(sm.frames, 'ms frame interval'),
      p99: r3([...sm.frames].sort((a, b) => a - b)[Math.floor(0.99 * sm.frames.length)] ?? NaN),
      fps: +(sm.frames.length / secs).toFixed(1),
      gpuFrame: hasGpu ? stat(sm.gpu, 'GPU ms a frame (first pass start to last end)') : 'n/a',
      gpuGroups: groups,
      gpuPasses: hasGpu ? passes : 'n/a',
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
    return {
      zoom: +c.zoom.toFixed(3),
      fly: !!c.fly,
      azimuth: c.azimuth !== undefined ? +c.azimuth.toFixed(3) : null,
      viewportCss: [vw, vh],
      footprintCells: { w: Math.round(xs1 - xs0), h: Math.round(ys1 - ys0), unit: 'cells (ground at the target height)' },
      window: { w: W, h: H, unit: 'cells' },
      coveragePct: pct,
      rings,
      target: c.target.map((v: number) => Math.round(v)),
    };
  }

  // ---- main ----

  async mainPage(out: Record<string, unknown>): Promise<void> {
    const sc = this.R.scene;
    const drive = sc.drive;
    sc.drive = null;
    sc.pan = null;
    this.say('settling…');
    out.settleMs = await this.settle(6000);
    out.window = { w: this.W, h: this.R.stream.H, region: this.R.stream.R, layoutBytes: this.R.stream.layout.bytes };
    out.view = this.view();
    this.say('parked frames…');
    out.idle = await this.capture(8);
    this.idleP50 = (out.idle as { frames?: Stat }).frames?.p50 ?? 17;
    this.say('region generation, stage by stage…');
    out.regionStages = await this.regionStages(5);
    this.say('regions/s at 1, 2, 4, 8 tiles a frame…');
    out.tiles = await this.tileSweep();
    this.say('the mesh rebuilt…');
    out.mesh = await this.meshRebuild();
    this.say('agents…');
    out.agents = await this.agentsSweep();
    this.say('render scales…');
    out.renderScale = await this.renderScales();
    this.say('the disk store…');
    out.store = await this.storeIO(4);
    // the scenarios
    this.say('scenario: riding the road (25 s)…');
    await this.settle(1500, 15000);
    if (drive) {
      sc.drive = drive;
      out.ride = { ...(await this.capture(25)), view: this.view() };
      sc.drive = null;
    } else out.ride = { error: 'no road near the start (?drive found none)' };
    for (const v of [80, 120]) {
      this.say(`scenario: a fast pan at ${v} cells/s (15 s)…`);
      await this.settle(1500, 15000);
      const [ux, uy] = this.R.camera.screenDeltaToWorld(0, -1);
      const l = Math.hypot(ux, uy) || 1;
      sc.pan = { speed: v, dir: [ux / l, uy / l], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      out[`pan${v}`] = { ...(await this.capture(15)), view: this.view() };
      sc.pan = null;
    }
    this.say('scenario: a warp across the atlas…');
    await this.settle(1500, 15000);
    out.warp = await this.warp();
    // the integrity judge and the rock bodies: a meteor beside the camera (the bench's own world, cleared at the end)
    this.say('a meteor: the judge and the rock bodies (12 s)…');
    await this.settle(1500, 15000);
    out.meteor = await this.meteor();
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
        if (this.timer.on) t.readbackWait.push(tB - tA - gs('colHeight') - gs('formSeed') - gs('colFinish'));
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
        await Promise.all(spots.map(([x0, y0]) => a.regionLand(x0, y0, R, R, Infinity, true)));
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

  /**
   * The mesh's rebuilds: every chunk marked moved (as a warp does: renderer.windowMoved), the frames after it timed —
   * the field mesh's GPU ms a frame over its parked cost, a frame's rebuild slots (quality meshSlots) at a time
   */
  private async meshRebuild(): Promise<Record<string, unknown>> {
    this.keepMesh = true;
    const base = await this.capture(3);
    const baseMesh = (base.meshFrame as Stat | null)?.p50 ?? 0;
    this.R.core.renderer.windowMoved(1 << 12, 0, [0, 0, 0]);
    const cap = await this.capture(6);
    this.keepMesh = false;
    const per = (cap.meshFrames as number[]) ?? [];
    const thr = ((base.meshFrame as Stat | null)?.p95 ?? 0) * 1.2 + 0.05;
    const busy = per.filter((v) => v > thr);
    const extra = busy.reduce((a, v) => a + (v - baseMesh), 0);
    const slots = this.ctx.host.quality.meshSlots ?? null;
    const fm = this.R.core.renderer.fieldMesh;
    delete cap.meshFrames;
    delete base.meshFrames;
    return {
      unit: 'GPU ms',
      chunkGrid: fm?.chunkGrid ?? null,
      slotsPerFrame: slots,
      parkedMeshPerFrame: base.meshFrame,
      rebuildMeshPerFrame: cap.meshFrame,
      rebuildingFrames: busy.length,
      perChunk: slots && busy.length ? r3(extra / (busy.length * slots)) : null,
      voxelChunks: (cap.hybrid as { voxelChunks?: Stat } | null)?.voxelChunks ?? null,
      note: busy.length ? '' : 'no frame over the parked p95: the hybrid meshes only its voxel chunks (few, parked), so a forced rebuild shows nothing — the per-chunk cost needs a scene with voxel chunks (BACKLOG BN10)',
      rule: 'frames whose field-mesh GPU ms is over the parked p95: their excess over the parked p50, over (those frames x slots a frame)',
      frames: cap.frames,
      gpuFrame: cap.gpuFrame,
    };
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

  private async warp(): Promise<Record<string, unknown>> {
    const a = this.R.atlas;
    const S = this.R.stream;
    const dims = { w: S.W, h: S.H, zMax: this.R.core.dims.zMax };
    // (across the atlas: a third of the way round, on land)
    let wx = S.origin[0] + a.p.cols / 3;
    let wy = S.origin[1] + a.p.rows / 5;
    for (let k = 0; k < 40; k++) {
      const h = a.macroAt(wx, wy * ROW_H);
      if (h > a.p.sea + 4) break;
      wx += 211;
      wy += 97;
    }
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
    return { to: [Math.round(wx), Math.round(wy)], warpMs: Math.round(warped), settledMs: settled >= 0 ? Math.round(settled) : 'not within 20 s', unit: 'ms from the warp asked (warpMs: every region written; settledMs: frames back to normal)', ...cap, view: this.view() };
  }
  private lastF = performance.now();

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
    let prev = run.hero.position();
    let walked = 0;
    let placed = 0;
    let mode = 'stick';
    let lastPut = 0;
    const capt = await this.capture(25, (t) => {
      if (run.play?.dialog?.isOpen) run.play.dialog.close?.();
      const h = run.hero.position();
      const d = Math.hypot(h[0] - prev[0], h[1] - prev[1]);
      if (d < 50) walked += d;
      prev = h;
      // (the pad's scripted stick, as runtest.mjs: up the screen, a quarter turn every 8 s)
      ang = -Math.PI / 2 + Math.floor(t / 8) * (Math.PI / 2);
      if (mode === 'stick') {
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

  // ---- other window sizes ----

  async winPage(out: Record<string, unknown>): Promise<void> {
    const sc = this.R.scene;
    sc.drive = null;
    sc.pan = null;
    this.say('settling…');
    out.settleMs = await this.settle(5000);
    out.window = { w: this.W, h: this.R.stream.H };
    out.view = this.view();
    out.parked = await this.capture(8);
  }
}

// ---------- the report ----------

function makeReport(s: BenchState): Record<string, unknown> {
  const res = s.results as Record<string, any>;
  const main = res.main ?? {};
  const idle = main.idle ?? {};
  const gpuIdle = typeof idle.gpuFrame === 'object' ? idle.gpuFrame.p50 : null;
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
  return {
    kind: 'reclaimed-bench',
    version: BENCH_VERSION,
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
    `regions/s at 1/2/4/8 tiles: ${[1, 2, 4, 8].map((k) => r.main?.tiles?.[`k${k}`]?.regionsPerSecond ?? '–').join(' / ')}`,
    `warp: land in ${r.main?.warp?.warpMs ?? '–'} ms, settled ${r.main?.warp?.settledMs ?? '–'}`,
    `view: sandbox zoom ${r.main?.ride?.view?.zoom ?? '–'} (${r.main?.ride?.view?.footprintCells?.w ?? '–'} cells across), hero zoom ${r.hero?.walking?.view?.zoom ?? '–'} (${r.hero?.walking?.view?.footprintCells?.w ?? '–'})`,
    `thermal drift: ${d.thermal?.driftPct ?? '–'}%   errors: ${r.errors?.length ?? 0}`,
  ];
  return lines.join('\n');
}
