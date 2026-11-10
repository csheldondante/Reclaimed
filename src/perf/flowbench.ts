// (trackA-liquids, DA-P5) The flow model's phone bench: the unified flow model (flow/, liquid.wgsl) against the pipes
// (water_flux/water_depth, lava.ts) on the flow lab's scenes, each a frame-time toggle diff (memory "toggle, don't
// timestamp": on a tiler the frame with a part against the frame without is the number to trust; GPU timestamps are
// kept beside it where the device has them). One link; the page loads twice — the flow model, then the pipes:
//   /?skipmenu=1&level=flowlab&liquid=flow&fresh=1&flowbench=1                 (&benchsecs=8 &benchspeed=1)
// (v2) Read the whole frame's GPU time diffs (gpuCostP50): a phone's frame is capped by vsync, and its per-pass
// timestamps are noise (memory "toggle, don't timestamp" — here the toggle is read on the frame's GPU time).
// States, each measured with the liquids on and with them paused:
//   awake      every chunk kept awake: the pool pouring through its breach, the tunnel's stream and its waterfall, the
//              trenches running off the map (the rivers), the lava vent — the model's whole cost
//   steady     the lava vent stopped, then let alone until the steady state (flow) or the settle (pipes) puts what's
//              still to sleep — what a quiet map costs: it should mostly sleep
//   disturbed  a dig in the river trench every 1.5 s: a small area woken, the rest asleep
//   lava       (awake) only the lava paused — what the lava costs
// A result card and a JSON to download, copy or share (on the dev server, kept in perf-reports/).

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, stat, wakeLog, type Stat } from './bench';
import { postDev } from './report-io';
import { EventKind } from '../sim/globals';
import { cellPos } from '../world/lattice';
import { LIQUID } from '../flow/model';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.flowbench.last';
/** the flow page's rows, carried to the pipes page */
const CARRY = 'reclaimed.flowbench.flow';
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
  // (the pipes page: the lab's sleep through the scene)
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
  model: 'flow' | 'pipes';
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

function systemsOff(model: 'flow' | 'pipes', off: Phase['off'], known: Set<string>): string[] {
  if (!off) return [];
  const names = model === 'flow' ? (off === 'lava' ? ['liquid-lava'] : ['liquid-water', 'liquid-lava', 'flow-steady']) : off === 'lava' ? ['lava'] : ['water', 'lava'];
  return names.filter((n) => known.has(n));
}

export async function flowBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const model: 'flow' | 'pipes' = LIQUID;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev && model === 'flow') reportButtons(panel, prev, true, 'flowbench', 'Reclaimed flow model bench');
  const secs = Number(params.get('benchsecs') ?? 8);
  const speed = Number(params.get('benchspeed') ?? 1);
  const sleepView = (R as unknown as { scene: { sleep?: SleepView } }).scene.sleep;
  if (!sleepView) throw new Error('flow bench: the level has no sleep (level=flowlab)');
  panel.text(`build ${BUILD.commit} (${BUILD.at}) — page ${model === 'flow' ? '1/2: the flow model' : '2/2: the pipes'}`);
  panel.text('About 3 minutes. The page reloads itself once — leave it in front, screen on, don’t touch it till the report shows.', true);
  panel.say(`${model}: letting the lab settle (6 s)…`);
  R.scene.speed = speed;
  await wait(6000);
  setup(R, model);
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
  panel.say(`${model}: running in (8 s)…`);
  await wait(8000);
  const rows: Row[] = [];
  const base = new Map<State, Row>();
  for (const [i, p] of PHASES.entries()) {
    panel.say(`${model} ${i + 1}/${PHASES.length}: ${p.name}…`);
    const row = await phaseRow(R, model, p, secs, gpu, passes, sleepView, base.get(p.state) ?? null, panel);
    if (!p.off) base.set(p.state, row);
    rows.push(row);
  }
  if (model === 'flow') {
    sessionStorage.setItem(CARRY, JSON.stringify({ rows, startedAt: new Date().toISOString() }));
    panel.say('flow model done — loading the pipes…');
    const u = new URL(location.href);
    u.searchParams.delete('flow');
    u.searchParams.set('liquid', 'pipes');
    await wait(500);
    location.href = u.toString();
    return;
  }
  const carried = sessionStorage.getItem(CARRY);
  sessionStorage.removeItem(CARRY);
  const flowPart = carried ? (JSON.parse(carried) as { rows: Row[]; startedAt: string }) : null;
  const all = [...(flowPart?.rows ?? []), ...rows];
  R.scene.speed = 0;
  await letSleep();
  const device = await deviceFacts(R.core.host);
  const report = {
    kind: 'reclaimed-flowbench',
    version: 2,
    build: BUILD,
    startedAt: flowPart?.startedAt ?? null,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device,
    wakeLock: held,
    wakeLog: [...wakeLog],
    secs,
    speed,
    notes: [
      ...(flowPart ? [] : ['the flow page’s rows were lost (the page opened without ?liquid=flow first)']),
      'read gpuCostP50 (the whole frame’s GPU time, liquids on minus off): the frame time is capped by vsync, so its diffs are 0 at 60 Hz',
      'per-pass timestamps (passes, liquidPassMs) are unreliable on a tiler GPU (a phone): kept for the desktop only',
    ],
    summary: summarise(all),
    rows: all,
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
    all.map((r) => `${r.model} ${r.phase}: GPU p50 ${r.gpuMs?.p50 ?? '-'} ms, frame p50 ${r.frameMs?.p50} ms, awake ${r.awake}${r.gpuCostP50 === null ? '' : `; the paused part costs ${r.gpuCostP50} ms GPU`}`).join(NL),
    true,
  );
  reportButtons(panel, body, false, 'flowbench', 'Reclaimed flow model bench', true);
  const dev = await postDev(body, 'flowbench');
  if (dev) panel.text(`dev server: ${dev}`, true);
}

/** each state's cost, flow and pipes side by side (ms a frame: p50 diffs; timestamps where kept) */
function summarise(rows: Row[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) if (r.costP50 !== null) out[`${r.model}: ${r.phase}`] = { gpuCostP50: r.gpuCostP50, frameCostP50: r.costP50 };
  return out;
}

/** the scenes going: the plug breached (flow: its spring), the stream and the vent (flow: setupFlowlab's) */
function setup(R: Rec, model: 'flow' | 'pipes'): void {
  if (model === 'flow') {
    R.flow!.breach(1.5);
    return;
  }
  // (the pipes: the plug dug as test-api's breach digs it; the tunnel's stream as a source at its mouth — the pipes
  // can't run under rock — and the lava vent as the sandbox's lava, flowlab.ts's numbers)
  for (let y = 53; y < 57; y += 2) for (let k = 0; k < 3; k++) dig(R, 65, y, 2.2);
  const w = R.core.world;
  const src = new Float32Array(1).fill(1.2 / 3);
  for (let y = 124; y < 127; y++) R.core.host.gpu.device.queue.writeBuffer(w.waterSource, w.ring.idx(151, y) * 4, src);
  R.scene.lava?.addVent(...cellPos(34, 205), 1e6, 6, 1.6, 0, 0.1);
}

async function phaseRow(R: Rec, model: 'flow' | 'pipes', p: Phase, secs: number, gpu: number[], passes: Map<string, number>, sleep: SleepView, base: Row | null, panel: Panel): Promise<Row> {
  const known = new Set(R.core.sim.systems.map((s) => s.name));
  const off = systemsOff(model, p.off, known);
  // (steady: the lava vent stopped first — lava fed for ever sets basalt for ever, never steady; its cost is the awake
  // phase's — then let what's still go to sleep — up to 30 s, until the awake count stops falling)
  if (p.state === 'steady' && !p.off) {
    if (model === 'flow') R.flow!.lava.springs.length = 0;
    else if (R.scene.lava) R.scene.lava.vents.length = 0;
    // (v2: until nothing is awake twice running, at most 120 s — a draining pool settles slowly, BACKLOG FL11; the
    // chunks still awake at the end are in the row)
    let calm = 0;
    for (let t0 = performance.now(); performance.now() - t0 < 120000 && calm < 2; ) {
      await wait(3000);
      panel.say(`${model}: waiting for the steady state — ${sleep.awake} chunks awake…`);
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
      model,
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
