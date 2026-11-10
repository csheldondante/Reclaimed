// (living town, RT2-4) The settled graph's phone bench: one link on the real phone, the screen kept awake (bench.ts
// keepAwake).
//   /?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&living=1&livingpanel=0&livingbench=1   (&benchsecs=2)
// Once the start town's living town has settled, two toggle diffs (memory "toggle, don't timestamp": a tiler's
// per-pass timestamps overlap; the frame's interval and GPU span with a thing on, less with it off, in alternating
// windows so heat and clocks even out):
//   empty    the settled graph's pass as it is in play (its ~45 indirect dispatches of 0 workgroups) against the pass
//            not encoded at all — what the empty dispatches cost. A CPU "settled" signal is worth having only if this
//            is more than noise on the phone.
//   awake    the graph forced awake (its relax sweeps dispatched every frame, as while it settles) against settled —
//            what settling costs while it runs.
// The living passes' GPU ms (the profiler's smoothed per-pass ms, where the device has timestamps) for each side too.
// A result card and a JSON to download, copy or share (and, on the dev server, kept in perf-reports/).
import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, wakeLog } from './bench';
import { postDev } from './report-io';
import type { LivingTowns } from '../citylife/towns';
import type { Profiler } from '../gpu/profiler';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.livingbench.last';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rec {
  core: { host: Parameters<typeof deviceFacts>[0] & { profiler: Profiler } };
  camera: { elevation: number };
  scene: { livingTowns?: LivingTowns };
}

interface Side {
  frameMs: number;
  gpuMs: number | null;
  frames: number;
  /** the living passes' smoothed GPU ms at the side's last window's end */
  passes: Record<string, number>;
}
interface Toggle {
  /** on less off: the frame's mean interval, its mean GPU span (ms) */
  frameMs: number | null;
  gpuMs: number | null;
  on: Side;
  off: Side;
  windows: number;
  windowS: number;
}

/** `set(true)` turns the thing on; WINDOWS alternating windows each way, `windowS` long; then `set(rest)` (as in play) */
const WINDOWS = 4;
async function toggled(R: Rec, LT: LivingTowns, windowS: number, rest: boolean, set: (on: boolean) => void): Promise<Toggle> {
  const P = R.core.host.profiler;
  const skipped = () => [...LT.live.values()].some((x) => x.life.debugSkipGraph);
  const sums = { on: { dt: [] as number[], gpu: [] as number[], passes: {} as Record<string, number> }, off: { dt: [] as number[], gpu: [] as number[], passes: {} as Record<string, number> } };
  let side: 'on' | 'off' = 'off';
  let last = 0;
  let live = true;
  const tick = (t: number) => {
    if (last) sums[side].dt.push(t - last);
    last = t;
    if (live) requestAnimationFrame(tick);
  };
  P.listen((_f: number, ms: number) => {
    if (live) sums[side].gpu.push(ms);
  });
  requestAnimationFrame(tick);
  for (let k = 0; k < WINDOWS; k++)
    for (const s of ['off', 'on'] as const) {
      set(s === 'on');
      await sleep(300);
      side = s;
      last = 0;
      await sleep(windowS * 1000);
      // (a pass not encoded keeps its last smoothed ms: shown as absent)
      sums[s].passes = LT.gpuMs();
      if (skipped()) delete sums[s].passes['living-graph'];
    }
  set(rest);
  live = false;
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const d = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) ? +(a - b).toFixed(3) : null);
  const sideOf = (s: 'on' | 'off'): Side => ({ frameMs: +mean(sums[s].dt).toFixed(3), gpuMs: sums[s].gpu.length ? +mean(sums[s].gpu).toFixed(3) : null, frames: sums[s].dt.length, passes: sums[s].passes });
  return { frameMs: d(mean(sums.on.dt), mean(sums.off.dt)), gpuMs: d(mean(sums.on.gpu), mean(sums.off.gpu)), on: sideOf('on'), off: sideOf('off'), windows: WINDOWS, windowS };
}

export async function livingBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'livingbench', 'Reclaimed living town bench');
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const windowS = Number(params.get('benchsecs') ?? 2);
  panel.text(`build ${BUILD.commit} (${BUILD.at})`);
  const device = await deviceFacts(R.core.host);
  R.camera.elevation = Math.PI / 3;
  panel.say('living bench — waiting for the living town to settle…');
  let LT: LivingTowns | undefined;
  for (let k = 0; k < 600 && !(LT = R.scene.livingTowns)?.live.size; k++) await sleep(250);
  if (!LT?.live.size) throw new Error('living bench: no living town (the link needs &citygen=fields&living=1)');
  const [townId, l] = LT.live.entries().next().value!;
  // (settled: the phase word 4 — read through the debug counters, the bench's own read)
  let settledS = 0;
  const t0 = performance.now();
  for (;;) {
    const h = await l.life.counters();
    if (h && h[0] === 4) break;
    if (performance.now() - t0 > 120000) {
      errors.push('not settled after 120 s');
      break;
    }
    await sleep(250);
  }
  settledS = +((performance.now() - t0) / 1000).toFixed(1);
  await sleep(2000);
  const P = R.core.host.profiler;
  P.active = true;
  const all = () => [...LT!.live.values()].map((x) => x.life);
  panel.say(`living bench — empty dispatches: the settled graph encoded, then not (${WINDOWS} × ${windowS} s each way)…`);
  const empty = await toggled(R, LT, windowS, true, (on) => all().forEach((x) => (x.debugSkipGraph = !on)));
  panel.say(`living bench — awake: the graph's sweeps forced every frame, then settled (${WINDOWS} × ${windowS} s each way)…`);
  const awake = await toggled(R, LT, windowS, false, (on) => all().forEach((x) => (x.debugAwake = on)));
  const h = (await l.life.counters()) ?? new Uint32Array(8);
  await letSleep();
  const report = {
    kind: 'reclaimed-livingbench',
    version: 1,
    build: BUILD,
    startedAt,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device,
    wakeLock: held,
    wakeLog: [...wakeLog],
    town: townId,
    riders: l.life.riders,
    sweeps: l.life.values.graph.sweeps,
    settledS,
    relaxFrames: h[7],
    emptyDispatches: empty,
    awake,
    errors,
  };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { livingBenchReport: string }).livingBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (storage full: the download is the copy)
  }
  const line = (n: string, t: Toggle) => `${n}: frame ${t.off.frameMs} → ${t.on.frameMs} ms (${t.frameMs! >= 0 ? '+' : ''}${t.frameMs}); GPU span ${t.off.gpuMs ?? 'n/a'} → ${t.on.gpuMs ?? 'n/a'} ms (${t.gpuMs ?? 'n/a'}); graph pass ${t.off.passes['living-graph'] ?? '–'} → ${t.on.passes['living-graph'] ?? '–'} ms`;
  panel.say(`living bench done — ${townId}, ${l.life.riders} riders, settled in ${settledS} s.`);
  panel.text([line('empty dispatches (encoded vs not)', empty), line('awake (forced vs settled)', awake), ...errors.map((e) => `error: ${e}`)].join(NL), true);
  const kept = await postDev(body, 'livingbench');
  if (kept) panel.text(kept, true);
  reportButtons(panel, body, false, 'livingbench', 'Reclaimed living town bench', true);
}
