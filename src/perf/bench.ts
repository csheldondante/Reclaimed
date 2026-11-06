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

import type { FramePace } from './framepace';
import type { Profiler } from '../gpu/profiler';
import type { Host, Scene } from '../scenes/world-core';
import { RegionStore } from '../world/region-store';
import type { HitchBoot } from './start';
import { copyText, deviceTag, downloadJson, postDev, shareJson, stamp } from './report-io';
import { heroPage, mainPage, panPage, pansPage, winPage } from './bench/pages';
import { BENCH_VERSION, BUILD, LAST, RIDE_AT, OWN, MB, WINDOWS } from './bench/defs';
import { judgeTimestamps, timestampModes } from './bench/timestamps';
import { panPlan, makePanReport, panSummary } from './bench/pan-report';
import { BenchState, idbPut, idbGet, whole, pending, load, loadFull, save } from './bench/state';
import { wakeLog, keepAwake, letSleep, Panel, GpuTimer } from './bench/page';
import { fixedWorkload, ioRates, deviceFacts } from './bench/device';
import { makeReport, summary } from './bench/report';
import { urlFlags } from '../flags';
export { BENCH_VERSION, stat } from './bench/defs';
export type { Stat } from './bench/defs';
export { judgeTimestamps } from './bench/timestamps';
export { panWindowFor } from './bench/pan-report';
export { benchMode, wakeLog, keepAwake, letSleep, Panel, GpuTimer } from './bench/page';
export { deviceFacts } from './bench/device';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** (v4) the bench's last sign of life (a frame it waited for, a step it began): the watchdog's */
let beat = performance.now();
let beatWhat = 'loading';
export const frame = () =>
  new Promise<number>((r) =>
    requestAnimationFrame((t) => {
      beat = performance.now();
      r(t);
    }),
  );
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
  // (v5, the user: "It's probably just during the reload which takes a while" — the lock was asked for only once the
  // level was up, ~30 s into a page on the phone: now from the page's first moment)
  void keepAwake();
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
    if (urlFlags().get('benchpage')) {
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

export async function start(host: Host, panel: Panel): Promise<void> {
  panel.el.querySelectorAll('button').forEach((b) => b.remove());
  const awake = await keepAwake();
  const old = await loadFull();
  const id = `${stamp()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const q = urlFlags();
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
    // (round 112) ?bgcheck=0 on the start page runs the pan pages without the background check (its depth and pick
    // stores may cost frames on the phone's GPU), for a clean frame-time run
    const bg = host.params.get('bgcheck') === '0' ? '0' : '1';
    s.pages = [s.pages[0], ...plan.pages.map((pg) => ({ name: `pan${pg.window}`, params: { ...common, at: RIDE_AT, win: String(pg.window), panzooms: pg.zooms.join('_'), bgcheck: bg } }))];
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

/**
 * Download (the primary path), Copy and Share… for a report; `kind` names its file (reclaimed-<kind>-<stamp>-<device>
 * .json) and the share sheet (round 120: the physics bench's too)
 */
export function reportButtons(panel: Panel, body: string, previous = false, kind = 'bench', title = 'Reclaimed benchmark', auto = false): void {
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
    return (name = `reclaimed-${kind}-${stamp()}-${await deviceTag(gpu)}.json`);
  };
  panel.button(previous ? 'Download previous run' : 'Download report', !previous, () => void nameOf().then((n) => say(downloadJson(body, n))));
  panel.button('Copy', false, () => void copyText(body).then(say, (e: Error) => say(`copy failed: ${e.message}`)));
  panel.button('Share…', false, () => void nameOf().then(async (n) => say((await shareJson(body, n, title)) || 'this browser can’t share files: use Download')));
  panel.el.appendChild(status);
  // (saved at once, no tap needed — the button is there to save it again)
  if (auto) void nameOf().then((n) => say(downloadJson(body, n)));
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
  await letSleep();
  panel.say(`Benchmark done — this run (bench v${BENCH_VERSION}, ${s.id}).`);
  // (round 112, bgcheck: the steps that showed the background, in red above the table)
  const bgFlagged = (report as { summary?: { bgFlagged?: string[] } }).summary?.bgFlagged ?? [];
  if (s.suite === 'pan' && bgFlagged.length) {
    const d = panel.text(`Background showed while panning: ${bgFlagged.join('; ')}`);
    d.style.color = '#ff6b6b';
    d.style.fontWeight = '600';
  }
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
  /** (v6, round 114) the frame pacing probe (src/perf/framepace.ts): every frame rAF to GPU done */
  pacer: FramePace | null;
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
  const out: Record<string, unknown> = { page: page.name, url: `?${urlFlags()}` };
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
      s.results[page.name] = { ...out, wakeLog: [...wakeLog], incomplete: true, lastStep: step };
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
  out.wakeLog = [...wakeLog];
  s.results[page.name] = out;
  panel.say(`${page.name} done — next…`);
  go(s);
}

export async function waitFor<T>(f: () => T | null | undefined | false, ms: number): Promise<T> {
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

export interface Sample {
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

export class Bench {
  readonly R: Engine;
  prof: Profiler;
  dev: GPUDevice;
  timer: GpuTimer;
  constructor(
    public ctx: LevelCtx,
    R: Engine,
    public panel: Panel,
    public tag: string,
  ) {
    this.R = R;
    this.prof = ctx.host.profiler;
    this.dev = ctx.host.gpu.device;
    this.timer = new GpuTimer(this.dev);
    const pacer = ctx.pacer;
    if (pacer) {
      pacer.sources.simTick = () => this.R.core.sim.tick;
      pacer.sources.slowSystems = () => (this.R.core.sim.systems as { name: string; period: number }[]).filter((x) => x.period > 1);
      // (what runs now and then: the coarse world's step parts; the streamer's work — any of its counts moving)
      const sum = (o: Record<string, unknown> | undefined) => Object.values(o ?? {}).reduce((t: number, v) => t + (typeof v === 'number' ? v : 0), 0);
      pacer.sources.counters = { coarse: () => this.R.atlas?.coarse?.partsRun ?? 0, stream: () => sum(this.R.stream?.stats) };
    }
  }

  say(s: string): void {
    this.panel.say(`${this.tag} ${s}`);
    beat = performance.now();
    beatWhat = s;
    this.checkpoint?.(s);
  }
  /** (v3) called at every step: the page's results so far saved */
  checkpoint?: (step: string) => void;

  get W(): number {
    return this.R.stream.W;
  }

  keepMesh = false;
  framesHook: ((f: number[]) => void) | null = null;

  idleFrames: number[] | null = null;

  parkedCover = 0;

  /** the timestamps judged over every capture so far */
  tsChecks: ReturnType<typeof judgeTimestamps>[] = [];

  // ---- main ----

  /** (v4) where the main page began (world cells, rows): the warp comes back to it */
  startAt: [number, number] = [0, 0];

  mainPage(out: Record<string, unknown>): Promise<void> {
    return mainPage(this, out);
  }

  /**
   * (v4) The pans, the fastest pan, the warp back and the meteor on a page of their own: the Pixel 9a's v3 main page
   * died after them and lost every sandbox number with it (its state too big to keep, or the page too heavy to leave)
   */
  pansPage(out: Record<string, unknown>): Promise<void> {
    return pansPage(this, out);
  }

  freshK = 0;
  used = new Set<string>();

  lastF = performance.now();
  /** (round 104) this zoom's parked rendered fps (the pan ramp stops when a step falls under a quarter of it) */
  parkedFps = 60;

  idleP50 = 17;

  // ---- hero ----

  heroPage(out: Record<string, unknown>): Promise<void> {
    return heroPage(this, out);
  }

  /**
   * A pan page: one window, the zooms it covers. First the disk line is filled: a pan along it with every window region
   * marked touched, so each is written to the store as it leaves (and the pool forgets the start of it by the end).
   * Then for each zoom, three land sources, each a speed ramp (PAN_SPEEDS, PAN_STEP_S each) until a criterion fails:
   *  pool       back and forth over three regions where it is (what comes in is in the GPU pool)
   *  generated  along a line of its own, parallel, never seen (made by the generator as it comes)
   *  disk       along the filled line from its start (from the store: disk to memory to the GPU)
   */
  panPage(out: Record<string, unknown>, zooms: number[]): Promise<void> {
    return panPage(this, out, zooms);
  }

  winPage(out: Record<string, unknown>): Promise<void> {
    return winPage(this, out);
  }
}
