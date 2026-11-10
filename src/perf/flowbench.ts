// (trackA-liquids, DA-P5) The liquid's phone bench: the flow model (flow/, liquid.wgsl) on the flow lab's scenes, each
// a toggle diff (memory "toggle, don't timestamp": the frame with the liquid against the frame without; GPU timestamps
// kept beside it where the device has them). The pipes it was measured against are retired (the user approved the
// flow model on the Pixel 9a: awake 1.9 ms against the pipes' 2.6):
//   /?skipmenu=1&level=flowlab&fresh=1&flowbench=1                 (&benchsecs=8 &benchspeed=1)
// (v2) Read the whole frame's GPU time diffs (gpuCostP50): a phone's frame is capped by vsync, and its per-pass
// timestamps are noise (memory "toggle, don't timestamp" — here the toggle is read on the frame's GPU time).
// States, each measured with the liquids on and with them paused:
//   awake      every chunk kept awake: the pool pouring through its breach, the tunnel's stream and its waterfall, the
//              trenches running off the map (the rivers), the lava vent — the model's whole cost
//   steady     the lava vent stopped, then let alone until the steady state puts what's
//              still to sleep — what a quiet map costs: it should mostly sleep
//   disturbed  a dig in the river trench every 1.5 s: a small area woken, the rest asleep
//   lava       (awake) only the lava paused — what the lava costs
// A result card and a JSON to download, copy or share (on the dev server, kept in perf-reports/).

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, stat, wakeLog, type Stat } from './bench';
import { postDev } from './report-io';
import { EventKind } from '../sim/globals';
import { cellPos } from '../world/lattice';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.flowbench.last';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** a dig at storage cell (x, y): the Edit event as test-api's breach makes it (op 2, edit.wgsl) */
function dig(R: Rec, x: number, y: number, radius: number): void {
  const [wx, wy] = cellPos(x, y);
  R.core.globals.events.push({ kind: EventKind.Edit, x: wx, y: wy, z: 2 * 32 + 512, radius, strength: 1 });
}

/** what the bench reads of the level (window.reclaimed) */
interface Rec {
  core: {
    host: Parameters<typeof deviceFacts>[0] & { profiler: { enabled: boolean; active: boolean; listen(fn: (frame: number, ms: number) => void): void; lastPasses: ReadonlyMap<string, number> }; gpu: { device: GPUDevice } };
    sim: { paused: Set<string>; systems: { name: string }[] };
    world: { waterSource: GPUBuffer; w: number; ring: { idx(x: number, y: number): number } };
    globals: { events: { kind: number; x: number; y: number; z?: number; radius: number; strength: number }[] };
  };
  scene: { speed: number; lava?: { vents: unknown[]; addVent(x: number, y: number, seconds?: number, rate?: number, radius?: number, height?: number, riseS?: number): void } };
  camera: { target: number[] };
  flow?: { breach(spring?: number): void; sleep?: SleepView; steady: { last: Record<string, number> }; lava: { springs: unknown[] } };
}
interface SleepView {
  awake: number;
  wakeAll(secs: number, now: number): void;
}

type State = 'awake' | 'steady' | 'disturbed';
interface Phase {
  name: string;
  state: State;
  /** what's paused: 'liquids' (the model's systems), 'lava' (its lava only) */
  off?: 'liquids' | 'lava';
}
const PHASES: Phase[] = [
  { name: 'awake', state: 'awake' },
  { name: 'awake, liquids off', state: 'awake', off: 'liquids' },
  { name: 'awake, lava off', state: 'awake', off: 'lava' },
  { name: 'steady', state: 'steady' },
  { name: 'steady, liquids off', state: 'steady', off: 'liquids' },
  { name: 'disturbed', state: 'disturbed' },
  { name: 'disturbed, liquids off', state: 'disturbed', off: 'liquids' },
];

interface Row {
  phase: string;
  frames: number;
  fps: number;
  frameMs: Stat | null;
  over20: number;
  /** chunks awake (mean over the phase) */
  awake: number;
  gpuMs: Stat | null;
  /** the liquids' passes (ms a frame, mean), where the device has timestamps */
  liquidPassMs: number | null;
  /** each pass's ms a frame (mean), heaviest 10 */
  passes: [string, number][];
  /** this phase's frame p50 against its state's all-on p50 (ms) — 0 where vsync caps the frame (a phone at 60 Hz) */
  costP50: number | null;
  costMean: number | null;
  /** (v2) the whole frame's GPU time p50 against its state's all-on (ms): the number to read — per-pass timestamps on a
   *  tiler are noise, and the frame time is capped by vsync */
  gpuCostP50: number | null;
}

const LIQUID_PASS = /^(liquid-|water|lava|flow-)/;

function systemsOff(off: Phase['off'], known: Set<string>): string[] {
  if (!off) return [];
  const names = off === 'lava' ? ['liquid-lava'] : ['liquid-water', 'liquid-lava', 'flow-steady'];
  return names.filter((n) => known.has(n));
}

export async function flowBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'flowbench', 'Reclaimed liquid bench');
  const secs = Number(params.get('benchsecs') ?? 8);
  const speed = Number(params.get('benchspeed') ?? 1);
  const sleepView = (R as unknown as { scene: { sleep?: SleepView } }).scene.sleep;
  if (!sleepView) throw new Error('flow bench: the level has no sleep (?sleep=0?)');
  const startedAt = new Date().toISOString();
  panel.text(`build ${BUILD.commit} (${BUILD.at})`);
  panel.text('About 4 minutes — leave it in front, screen on, don’t touch it till the report shows.', true);
  panel.say('letting the lab settle (6 s)…');
  R.scene.speed = speed;
  await wait(6000);
  R.flow!.breach(1.5);
  // (the camera on the waterfall and the rivers: the tunnel's mouth)
  const [cx, cy] = cellPos(150, 125);
  R.camera.target[0] = cx;
  R.camera.target[1] = cy;
  const prof = R.core.host.profiler;
  const gpu: number[] = [];
  const passes = new Map<string, number>();
  if (prof.enabled) {
    prof.active = true;
    prof.listen((_f, ms) => {
      gpu.push(ms);
      for (const [k, v] of prof.lastPasses) passes.set(k, (passes.get(k) ?? 0) + v);
    });
  }
  panel.say('running in (8 s)…');
  await wait(8000);
  const rows: Row[] = [];
  const base = new Map<State, Row>();
  for (const [i, p] of PHASES.entries()) {
    panel.say(`${i + 1}/${PHASES.length}: ${p.name}…`);
    const row = await phaseRow(R, p, secs, gpu, passes, sleepView, base.get(p.state) ?? null, panel);
    if (!p.off) base.set(p.state, row);
    rows.push(row);
  }
  R.scene.speed = 0;
  await letSleep();
  const device = await deviceFacts(R.core.host);
  const report = {
    kind: 'reclaimed-flowbench',
    version: 3,
    build: BUILD,
    startedAt,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device,
    wakeLock: held,
    wakeLog: [...wakeLog],
    secs,
    speed,
    notes: [
      'read gpuCostP50 (the whole frame’s GPU time, the liquid on minus off): the frame time is capped by vsync, so its diffs are 0 at 60 Hz',
      'per-pass timestamps (passes, liquidPassMs) are unreliable on a tiler GPU (a phone): kept for the desktop only',
    ],
    summary: summarise(rows),
    rows,
  };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { flowBenchReport: string }).flowBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (storage full: the download is the copy)
  }
  panel.say('flow bench done.');
  panel.text(
    rows.map((r) => `${r.phase}: GPU p50 ${r.gpuMs?.p50 ?? '-'} ms, frame p50 ${r.frameMs?.p50} ms, awake ${r.awake}${r.gpuCostP50 === null ? '' : `; the paused part costs ${r.gpuCostP50} ms GPU`}`).join(NL),
    true,
  );
  reportButtons(panel, body, false, 'flowbench', 'Reclaimed liquid bench', true);
  const dev = await postDev(body, 'flowbench');
  if (dev) panel.text(`dev server: ${dev}`, true);
}

/** each state's cost (ms a frame: GPU p50 diffs; the frame's beside) */
function summarise(rows: Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) if (r.costP50 !== null) out[r.phase] = { gpuCostP50: r.gpuCostP50, frameCostP50: r.costP50 };
  return out;
}

async function phaseRow(R: Rec, p: Phase, secs: number, gpu: number[], passes: Map<string, number>, sleep: SleepView, base: Row | null, panel: Panel): Promise<Row> {
  const known = new Set(R.core.sim.systems.map((s) => s.name));
  const off = systemsOff(p.off, known);
  // (steady: the lava vent stopped first — lava fed for ever sets basalt for ever, never steady; its cost is the awake
  // phase's — then let what's still go to sleep — up to 30 s, until the awake count stops falling)
  if (p.state === 'steady' && !p.off) {
    R.flow!.lava.springs.length = 0;
    // (v2: until nothing is awake twice running, at most 120 s — a draining pool settles slowly, BACKLOG FL11; the
    // chunks still awake at the end are in the row)
    let calm = 0;
    for (let t0 = performance.now(); performance.now() - t0 < 120000 && calm < 2; ) {
      await wait(3000);
      panel.say(`waiting for the steady state — ${sleep.awake} chunks awake…`);
      calm = sleep.awake === 0 ? calm + 1 : 0;
    }
  }
  for (const n of off) R.core.sim.paused.add(n);
  let digT = 0;
  let digK = 0;
  const each = (now: number) => {
    if (p.state === 'awake') sleep.wakeAll(0.5, now / 1000);
    if (p.state === 'disturbed' && now - digT > 1500) {
      digT = now;
      // (a cell dug in the tunnel's run-off trench, a step along each time)
      dig(R, 175 + (digK++ % 8) * 3, 125, 1.5);
    }
  };
  try {
    for (let t0 = performance.now(); performance.now() - t0 < 2000; ) each(await frame());
    gpu.length = 0;
    passes.clear();
    const dt: number[] = [];
    let awake = 0;
    let last = await frame();
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      const t = await frame();
      each(t);
      dt.push(t - last);
      awake += sleep.awake;
      last = t;
    }
    const wall = (performance.now() - t0) / 1000;
    const fm = stat(dt, 'ms');
    const g = [...gpu];
    const per = (v: number) => +(v / Math.max(1, g.length)).toFixed(3);
    let liq = 0;
    for (const [k, v] of passes) if (LIQUID_PASS.test(k)) liq += v;
    return {
      phase: p.name,
      frames: dt.length,
      fps: +(dt.length / wall).toFixed(1),
      frameMs: fm,
      over20: dt.filter((v) => v > 20).length,
      awake: Math.round(awake / Math.max(1, dt.length)),
      gpuMs: g.length ? stat(g, 'ms') : null,
      liquidPassMs: g.length ? per(liq) : null,
      passes: [...passes].map(([k, v]) => [k, per(v)] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 10),
      costP50: base && base.frameMs && fm ? +(base.frameMs.p50 - fm.p50).toFixed(2) : null,
      costMean: base && base.frameMs && fm ? +(base.frameMs.mean - fm.mean).toFixed(2) : null,
      gpuCostP50: base && base.gpuMs && g.length ? +(base.gpuMs.p50 - stat(g, 'ms')!.p50).toFixed(2) : null,
    };
  } finally {
    for (const n of off) R.core.sim.paused.delete(n);
  }
}
