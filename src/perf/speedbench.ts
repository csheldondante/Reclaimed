// The 16x toggle-diff phone bench (round 128p, DA-B22; the Pixel 9a at 16x after Build: 12–20 fps). One link, run on
// the real phone: the fortress on the user's start town, Build pressed, the game at 16x, then fixed phases with parts of
// the frame toggled off — each a toggle diff against the phase with everything on (per-pass GPU timestamps are not to
// be trusted on a tiler: what a part costs is the frame with it against the frame without, memory "toggle, don't
// timestamp"). Every frame timed; a result card and a JSON to download, copy or share.
//   /?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&speedbench=1            (10 s a phase)
//   …&speedbench=1&benchsecs=15&benchspeed=16
// Every system as the deployed page runs it; the screen kept awake (src/perf/bench.ts keepAwake).

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, stat, wakeLog, type Stat } from './bench';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.speedbench.last';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** what the bench reads of the level (window.reclaimed) */
interface Rec {
  core: {
    host: Parameters<typeof deviceFacts>[0] & { profiler: { enabled: boolean; active: boolean; listen(fn: (frame: number, ms: number) => void): void; lastPasses: ReadonlyMap<string, number> } };
    sim: { paused: Set<string>; systems: { name: string }[] };
    ticksRun: number;
    ffwd: boolean;
    plantParticles(on: boolean): void;
  };
  scene: { speed: number };
}

/** a phase: what's off for it */
interface Phase {
  name: string;
  /** the sim systems paused */
  off?: string[];
  /** fast-forward off (every tick a frame of its own: WorldCore.ffwd) */
  noFfwd?: boolean;
  /** the plants' particles on (fortress play has them off: WorldCore.plantParticles) */
  plants?: boolean;
}

const PHASES: Phase[] = [
  { name: 'all' },
  { name: 'no agents (units, fields, ride, combat) or traits', off: ['agents', 'traits'] },
  { name: 'fast-forward off', noFfwd: true },
  { name: 'no particles', off: ['particles'] },
  { name: 'no wind field', off: ['windfield', 'wind-blows'] },
  { name: 'no traits', off: ['traits'] },
  { name: 'no sway', off: ['sway'] },
  { name: 'no water', off: ['water'] },
  { name: 'plants’ particles on', plants: true },
  { name: 'all again' },
];

interface Row {
  phase: string;
  frames: number;
  fps: number;
  frameMs: Stat | null;
  over33: number;
  over50: number;
  /** the world's ticks a frame, and the sim's speed it reached (×) */
  ticksPerFrame: number;
  simX: number;
  /** the GPU's frame (timestamps: a tiler's may not be trusted — the toggle diff is what counts) */
  gpuMs: Stat | null;
  /** each pass's ms a frame (mean), heaviest 12 */
  passes: [string, number][];
  /** the frame's p50 against the first phase's (ms): what the toggled part costs */
  diffP50: number | null;
}

async function phaseRow(R: Rec, p: Phase, secs: number, speed: number, gpu: number[], passes: Map<string, number>, base: Row | null): Promise<Row> {
  const { core } = R;
  const known = new Set(core.sim.systems.map((s) => s.name));
  const off = (p.off ?? []).filter((n) => known.has(n));
  for (const n of off) core.sim.paused.add(n);
  if (p.noFfwd) core.ffwd = false;
  if (p.plants) core.plantParticles(true);
  R.scene.speed = speed;
  try {
    // (settled into it first)
    for (let t0 = performance.now(); performance.now() - t0 < 2000; ) await frame();
    gpu.length = 0;
    passes.clear();
    const dt: number[] = [];
    const tick0 = core.ticksRun;
    let last = await frame();
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      const t = await frame();
      dt.push(t - last);
      last = t;
    }
    const wall = (performance.now() - t0) / 1000;
    const ticks = core.ticksRun - tick0;
    const fm = stat(dt, 'ms');
    const g = [...gpu];
    const row: Row = {
      phase: p.name,
      frames: dt.length,
      fps: +(dt.length / wall).toFixed(1),
      frameMs: fm,
      over33: dt.filter((v) => v > 33.4).length,
      over50: dt.filter((v) => v > 50).length,
      ticksPerFrame: +(ticks / Math.max(1, dt.length)).toFixed(2),
      simX: +(ticks / 60 / wall).toFixed(2),
      gpuMs: g.length ? stat(g, 'ms') : null,
      passes: [...passes].map(([k, v]) => [k, +(v / Math.max(1, g.length)).toFixed(2)] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 12),
      diffP50: base && base.frameMs && fm ? +(base.frameMs.p50 - fm.p50).toFixed(2) : null,
    };
    return row;
  } finally {
    for (const n of off) core.sim.paused.delete(n);
    if (p.noFfwd) core.ffwd = true;
    if (p.plants) core.plantParticles(false);
  }
}

export async function speedBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'speedbench', 'Reclaimed 16x toggle bench');
  const startedAt = new Date().toISOString();
  const device = await deviceFacts(R.core.host);
  const speed = Number(params.get('benchspeed') ?? 16);
  const secs = Number(params.get('benchsecs') ?? 10);
  panel.text(`build ${BUILD.commit} (${BUILD.at})`);
  panel.say('16x bench — letting the level settle (10 s)…');
  await sleep(10000);
  // (the fortress's Build: the builders out, as the user plays it)
  const go = document.querySelector<HTMLButtonElement>('.fort-bar button.go');
  if (!go) throw new Error('speed bench: no Build button (the fortress: ?fortress=1&town=1)');
  if (/build/i.test(go.textContent ?? '')) go.click();
  // (each frame's GPU time and passes, when the profiler has timestamps)
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
  R.scene.speed = speed;
  panel.say(`16x bench — warming up at ${speed}x (8 s)…`);
  await sleep(8000);
  const rows: Row[] = [];
  for (const [i, p] of PHASES.entries()) {
    panel.say(`16x bench ${i + 1}/${PHASES.length}: ${p.name} (${secs + 2} s)…`);
    rows.push(await phaseRow(R, p, secs, speed, gpu, passes, rows[0] ?? null));
  }
  R.scene.speed = 0;
  await letSleep();
  const report = { kind: 'reclaimed-speedbench', version: 1, build: BUILD, startedAt, finishedAt: new Date().toISOString(), url: location.href, device, wakeLock: held, wakeLog: [...wakeLog], speed, secs, rows };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { speedBenchReport: string }).speedBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say(`16x bench done — ${rows.length} phases, ${secs} s each at ${speed}x.`);
  panel.text(
    rows
      .map((r) => `${r.phase}: frames p50 ${r.frameMs?.p50} p95 ${r.frameMs?.p95} max ${r.frameMs?.max} ms (${r.fps} fps, ${r.simX}x); ${r.diffP50 === null ? '' : `saves ${r.diffP50} ms p50; `}over 33 ms ${r.over33}`)
      .join(NL),
    true,
  );
  reportButtons(panel, body, false, 'speedbench', 'Reclaimed 16x toggle bench', true);
}
