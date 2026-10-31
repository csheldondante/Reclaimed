// The physics phone bench (round 120; the user: "Consider making a physics benchmark for the phone that can drop things
// and topple towers"). One link, run on the real phone: the playground, the same scripted scene every run — the
// line-up dropped, towers toppled, the mesa undercut, the house's towers cut, a tanker swung into the bridge with the
// drag tool — under each solver variant and each collapse judge in turn (a reload each: ?solver= ?judge=), then a
// result card and a JSON to copy or download (frame p50/p95/p99, GPU ms, physics and judge ms, awake bodies, the slow
// frames and how they cluster, as bench v9 reports).
//   /?skipmenu=1&level=playground&tutorial=0&physbench=1        (every pair)
//   …&physbench=1&pairs=nodes:runs,hybrid:sections             (some)
// State between the loads in localStorage (cleared at the end). Every system in play as the deployed page runs it.

import { VARIANTS } from '../solver/variant';
import { JUDGES } from '../game/judge';
import { postDev } from './report-io';
import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, wakeLog } from './bench';
import { summarize, summaryLines, TIMESTAMP_NOTE, type PhysRow, type Toggle } from './physsummary';
import { stepTaps } from '../gpu/cpustat';

const KEY = 'reclaimed.physbench';
const NL = String.fromCharCode(10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Stage {
  /** what's done: [station id, button label] pressed in turn, or the drag tool's swing */
  name: string;
  run: (R: Rec) => Promise<void> | void;
  /** s measured after it */
  secs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

function press(R: Rec, station: string, label: string): void {
  const st = R.scene.level.stations as { id: string; actions: { label: string }[] }[];
  const i = st.findIndex((s) => s.id === station);
  if (i < 0) throw new Error(`physbench: no station ${station}`);
  R.scene.stationsBar.pick(i);
  const b = [...document.querySelectorAll<HTMLButtonElement>('.stations button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`physbench: no button "${label}" at ${station}`);
  b.click();
}

/** the scripted scene: the same every run */
const STAGES: Stage[] = [
  { name: 'drop the line-up', run: (R) => press(R, 'metal', 'drop the line-up'), secs: 8 },
  {
    name: 'topple the rock towers',
    run: async (R) => {
      press(R, 'rock', 'nick the legs');
      await sleep(1500);
      press(R, 'rock', 'cut the towers');
    },
    secs: 8,
  },
  { name: 'undercut the mesa', run: (R) => press(R, 'slide', 'undercut the mesa'), secs: 6 },
  { name: 'topple the house towers', run: (R) => press(R, 'house', 'topple the towers'), secs: 6 },
  {
    name: 'swing the tanker into the bridge',
    run: async (R) => {
      press(R, 'metal', 'drop the tanker');
      await sleep(2500);
      const ig = R.scene.integrity;
      // (the drag tool's pull: the tanker grabbed where it lies — the metal station's, storage x 238–250, rows 226–231,
      // on ground at 10 — swung up and across into the girder bridge, rows 197–199 at 20)
      const RH = Math.sqrt(3) / 2;
      const g = ig.grabAt(244, 228.5 * RH, 14, 16);
      if (!g) throw new Error('physbench: no tanker to grab at the metal station');
      const path: [number, number, number][] = [
        [244, 228.5 * RH, 30],
        [226, 198 * RH, 34],
        [226, 198 * RH, 22],
      ];
      for (const target of path)
        for (let k = 0; k < 40; k++) {
          ig.pull(g, target, 1 / 60);
          await new Promise((r) => requestAnimationFrame(r));
        }
    },
    secs: 6,
  },
];

type Row = PhysRow;

/** this run's state between its pages, and the last finished run's report (a "previous run" download) */
const LAST = 'reclaimed.physbench.last';
interface State {
  pairs: string[];
  rows: Row[];
  startedAt: string;
  device?: Record<string, unknown>;
  /** each page's wake lock: held or not */
  wake: { pair: string; held: boolean }[];
  wakeLog: string[];
}

/**
 * A system's cost by the frame with it and without it (round 120: per-pass timestamps don't add up on a tiler): `set`
 * turns it off (true) or on, in WINDOWS alternating windows each way, each WINDOW_S long — so heat and clocks even
 * out as the main bench's toggles do; the frames' mean interval and GPU span with it on, less with it off.
 */
const WINDOWS = 3;
const WINDOW_S = 1.5;
async function toggled(R: Rec, set: (off: boolean) => void): Promise<Toggle> {
  const P = R.core.host.profiler;
  const sums = { on: { dt: [] as number[], gpu: [] as number[] }, off: { dt: [] as number[], gpu: [] as number[] } };
  let side: 'on' | 'off' = 'on';
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
    for (const s of ['on', 'off'] as const) {
      set(s === 'off');
      await sleep(250);
      side = s;
      last = 0;
      await sleep(WINDOW_S * 1000);
    }
  set(false);
  live = false;
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const d = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) ? +(a - b).toFixed(2) : null);
  return {
    frameMs: d(mean(sums.on.dt), mean(sums.off.dt)),
    gpuMs: d(mean(sums.on.gpu), mean(sums.off.gpu)),
    on: { frameMs: +mean(sums.on.dt).toFixed(2), gpuMs: sums.on.gpu.length ? +mean(sums.on.gpu).toFixed(2) : null },
    off: { frameMs: +mean(sums.off.dt).toFixed(2), gpuMs: sums.off.gpu.length ? +mean(sums.off.gpu).toFixed(2) : null },
    windows: WINDOWS,
  };
}

export async function physBench(params: URLSearchParams): Promise<void> {
  const R: Rec = (window as unknown as { reclaimed: Rec }).reclaimed;
  // (round 120, the user: "the bench does not generate an automated report or keep my phone awake the way the other
  // benches do" — the bench's own panel, wake lock, report and its buttons: src/perf/bench.ts, report-io.ts)
  const panel = new Panel(document.body);
  const held = await keepAwake();
  let st: State;
  try {
    st = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? null;
  } catch {
    st = null as unknown as State;
  }
  const all = (params.get('pairs') ?? '').split(',').filter(Boolean);
  const pairs = all.length ? all : VARIANTS.flatMap((v) => Object.keys(JUDGES).map((j) => `${v}:${j}`));
  const here = `${params.get('solver') ?? 'nodes'}:${params.get('judge') ?? 'runs'}`;
  // (a fresh start: the device's facts, then the first pair's page)
  if (!params.get('physbenchstep') || !st) {
    st = { pairs, rows: [], startedAt: new Date().toISOString(), wake: [], wakeLog: [] };
    panel.say('physics bench: the device…');
    st.device = await deviceFacts(R.core.host);
    localStorage.setItem(KEY, JSON.stringify(st));
    const [solver, judge] = pairs[0].split(':');
    const u = new URL(location.href);
    u.searchParams.set('solver', solver);
    u.searchParams.set('judge', judge);
    u.searchParams.set('physbenchstep', '0');
    location.href = u.toString();
    return;
  }
  st.wake.push({ pair: here, held });
  // (the last finished run, while this one goes)
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'physbench', 'Reclaimed physics bench');
  const step = Number(params.get('physbenchstep'));
  panel.say(`physics bench ${step + 1}/${st.pairs.length} (${here}) — letting the level settle (12 s)…`);
  await sleep(12000);
  const P = R.core.host.profiler;
  P.active = true;
  for (const s of STAGES) {
    panel.say(`physics bench ${step + 1}/${st.pairs.length} (${here}) — ${s.name}…`);
    let cpu = 0;
    const steps = new Map<string, number>();
    const tap = (label: string, ms: number) => {
      steps.set(label, (steps.get(label) ?? 0) + ms);
      if (label === 'rockbodies' || label.startsWith('physics') || label.startsWith('solver')) cpu += ms;
    };
    stepTaps.push(tap);
    // (each judging and each readback, seen as its stats change)
    const J = { passes: 0, sum: 0, worst: 0, gpu: 0, gpuN: 0, bytes: 0, bytesN: 0, last: null as Rec };
    const RD = { reads: 0, sum: 0, worst: 0, kb: 0, last: -1 };
    P.resetTotals();
    const t: number[] = [];
    let awake = 0;
    let on = true;
    const tick = () => {
      t.push(performance.now());
      const ig = R.scene.integrity;
      const solverAwake = ig?.solver ? [...ig.solver.bodies].filter((b: Rec) => !ig.solver.read(b)?.asleep).length : 0;
      const ph = R.scene.physics;
      const physAwake = ph ? ph.bodies.length - (ph.asleep?.size ?? 0) : 0;
      awake = Math.max(awake, (ig?.rigid?.list.length ?? 0) + solverAwake + physAwake);
      const js = ig?.judge?.stats;
      if (js && js !== J.last && js.ms !== J.last?.ms) {
        J.last = { ...js };
        J.passes++;
        J.sum += js.ms;
        J.worst = Math.max(J.worst, js.ms);
        if (js.gpuMs !== undefined) (J.gpu += js.gpuMs), J.gpuN++;
        if (js.readBytes !== undefined) (J.bytes += js.readBytes), J.bytesN++;
      }
      const rm = ig?.stats.readMs ?? 0;
      if (rm && rm !== RD.last) {
        RD.last = rm;
        RD.reads++;
        RD.sum += rm;
        RD.worst = Math.max(RD.worst, rm);
        RD.kb += ig.stats.readKB ?? 0;
      }
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await s.run(R);
    await sleep(s.secs * 1000);
    on = false;
    stepTaps.splice(stepTaps.indexOf(tap), 1);
    // (round 120, the user: "the tiled rendering on phones makes per system unreliable … You need to toggle systems to
    // measure the diff" — the scene goes on, the system off and on in turn, the frame's interval and GPU time compared)
    panel.say(`physics bench ${step + 1}/${st.pairs.length} (${here}) — ${s.name}: physics off and on…`);
    const physicsToggle = await toggled(R, (off) => {
      const sim = R.core.sim;
      for (const n of ['solver', 'physics']) off ? sim.paused.add(n) : sim.paused.delete(n);
      if (R.scene.integrity) R.scene.integrity.paused.physics = off;
    });
    panel.say(`physics bench ${step + 1}/${st.pairs.length} (${here}) — ${s.name}: the judge off and on…`);
    const judgeToggle = await toggled(R, (off) => {
      if (R.scene.integrity) R.scene.integrity.paused.judge = off;
    });
    const d: number[] = [];
    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    const f = [...d].sort((a, b) => a - b);
    const q = (x: number) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
    // (slow: past twice the median and a 30 fps frame; clusters: runs of them)
    const slowAt = Math.max(33.4, 2 * q(0.5));
    let slow = 0;
    let clusters = 0;
    let run = 0;
    let longest = 0;
    for (const x of d) {
      if (x > slowAt) {
        slow++;
        if (run === 0) clusters++;
        run++;
        longest = Math.max(longest, run);
      } else run = 0;
    }
    let gp = 0;
    for (const [name, ms] of P.totalMs as Map<string, number>) if (/solver|phys|body-mesh|rock/i.test(name)) gp += ms;
    const fr = P.framesResolved as number;
    st.rows.push({
      pair: here,
      stage: s.name,
      frames: d.length,
      fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
      worst: +f[f.length - 1].toFixed(1),
      gpu: fr ? +(P.gpuTotalMs / fr).toFixed(2) : null,
      gpuPhysicsPasses: fr ? +(gp / fr).toFixed(2) : null,
      physicsToggle,
      judgeToggle,
      cpuPhysics: +(cpu / Math.max(1, d.length)).toFixed(2),
      cpuTop: Object.fromEntries([...steps].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k, +(v / Math.max(1, d.length)).toFixed(2)])),
      judge: { passes: J.passes, ms: +(J.sum / Math.max(1, J.passes)).toFixed(2), worst: +J.worst.toFixed(2), gpuMs: J.gpuN ? +(J.gpu / J.gpuN).toFixed(2) : null, readKB: J.bytesN ? +(J.bytes / J.bytesN / 1024).toFixed(1) : null },
      read: { reads: RD.reads, ms: +(RD.sum / Math.max(1, RD.reads)).toFixed(2), worst: +RD.worst.toFixed(2), kb: +(RD.kb / Math.max(1, RD.reads)).toFixed(1) },
      awake,
      slow,
      clusters,
      longestRun: longest,
    });
  }
  st.wakeLog.push(...wakeLog.map((l) => `${here} ${l}`));
  localStorage.setItem(KEY, JSON.stringify(st));
  if (step + 1 < st.pairs.length) {
    const [solver, judge] = st.pairs[step + 1].split(':');
    const u = new URL(location.href);
    u.searchParams.set('solver', solver);
    u.searchParams.set('judge', judge);
    u.searchParams.set('physbenchstep', String(step + 1));
    panel.say(`physics bench: next, ${st.pairs[step + 1]} (reloading)…`);
    location.href = u.toString();
    return;
  }
  localStorage.removeItem(KEY);
  await letSleep();
  const report = {
    kind: 'reclaimed-physbench',
    version: 2,
    startedAt: st.startedAt,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device: st.device ?? null,
    wakeLock: st.wake,
    wakeLog: st.wakeLog,
    stages: STAGES.map((s) => s.name),
    summary: summarize(st.rows),
    note: TIMESTAMP_NOTE,
    rows: st.rows,
  };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { physBenchReport: string }).physBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say(`Physics bench done — ${st.pairs.length} solver × judge pairs, ${STAGES.length} stages each.`);
  panel.text(summaryLines(st.rows).join(NL), true);
  panel.text(TIMESTAMP_NOTE, true);
  reportButtons(panel, body, false, 'physbench', 'Reclaimed physics bench', true);
  const dev = await postDev(body, 'physbench');
  if (dev) panel.text(`dev server: ${dev}`, true);
  panel.button('Run again', false, () => {
    const u = new URL(location.href);
    u.searchParams.delete('physbenchstep');
    location.href = u.toString();
  });
}
