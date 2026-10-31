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
import { copyText, downloadJson } from './report-io';
import { stepTaps } from '../gpu/cpustat';

const KEY = 'reclaimed.physbench';
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

interface Row {
  pair: string;
  stage: string;
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  gpu: number | null;
  gpuPhysics: number | null;
  cpuPhysics: number;
  /** the main thread's steps over the stage, ms a frame, the five biggest (cpustat labels) */
  cpuTop: Record<string, number>;
  /** the collapse judge (game/judge.ts: A its CPU, B submit to verdict): passes, mean and worst ms, B's GPU ms and bytes read */
  judge: { passes: number; ms: number; worst: number; gpuMs: number | null; readKB: number | null };
  /** the columns' readback for the judge (Integrity.stats readMs, readKB): reads, mean and worst latency, KB a read */
  read: { reads: number; ms: number; worst: number; kb: number };
  awake: number;
  slow: number;
  clusters: number;
  longestRun: number;
}

function say(el: HTMLElement, t: string): void {
  el.textContent = t;
}

export async function physBench(params: URLSearchParams): Promise<void> {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:60;background:rgba(20,24,30,.9);color:#eef;font:12px system-ui;padding:8px;border-radius:8px;white-space:pre-wrap;pointer-events:auto;max-height:60vh;overflow:auto';
  document.body.appendChild(box);
  let st: { pairs: string[]; rows: Row[] };
  try {
    st = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? { pairs: [], rows: [] };
  } catch {
    st = { pairs: [], rows: [] };
  }
  const all = (params.get('pairs') ?? '').split(',').filter(Boolean);
  const pairs = all.length ? all : VARIANTS.flatMap((v) => Object.keys(JUDGES).map((j) => `${v}:${j}`));
  const here = `${params.get('solver') ?? 'nodes'}:${params.get('judge') ?? 'runs'}`;
  // (a fresh start: the first pair's page, with nothing stored for this run)
  if (!params.get('physbenchstep')) {
    st = { pairs, rows: [] };
    localStorage.setItem(KEY, JSON.stringify(st));
    const [solver, judge] = pairs[0].split(':');
    const u = new URL(location.href);
    u.searchParams.set('solver', solver);
    u.searchParams.set('judge', judge);
    u.searchParams.set('physbenchstep', '0');
    location.href = u.toString();
    return;
  }
  const step = Number(params.get('physbenchstep'));
  const R: Rec = (window as unknown as { reclaimed: Rec }).reclaimed;
  say(box, `physics bench ${step + 1}/${st.pairs.length} (${here}) — letting the level settle (12 s)…`);
  await sleep(12000);
  const P = R.core.host.profiler;
  P.active = true;
  for (const s of STAGES) {
    say(box, `physics bench ${step + 1}/${st.pairs.length} (${here}) — ${s.name}…`);
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
      gpuPhysics: fr ? +(gp / fr).toFixed(2) : null,
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
  localStorage.setItem(KEY, JSON.stringify(st));
  if (step + 1 < st.pairs.length) {
    const [solver, judge] = st.pairs[step + 1].split(':');
    const u = new URL(location.href);
    u.searchParams.set('solver', solver);
    u.searchParams.set('judge', judge);
    u.searchParams.set('physbenchstep', String(step + 1));
    say(box, `physics bench: next, ${st.pairs[step + 1]} (reloading)…`);
    location.href = u.toString();
    return;
  }
  localStorage.removeItem(KEY);
  const report = JSON.stringify({ bench: 'physics', v: 1, ua: navigator.userAgent, when: new Date().toISOString(), stages: STAGES.map((s) => s.name), rows: st.rows }, null, 1);
  (window as unknown as { physBenchReport: string }).physBenchReport = report;
  const lines: string[] = [];
  for (const pair of st.pairs) {
    const rs = st.rows.filter((r) => r.pair === pair);
    const p95 = Math.max(...rs.map((r) => r.p95));
    const gpu = rs.map((r) => r.gpu ?? 0).reduce((a, b) => a + b, 0) / Math.max(1, rs.length);
    lines.push(`${pair}: worst p95 ${p95} ms, p50 ${Math.max(...rs.map((r) => r.p50))} ms, GPU ${gpu.toFixed(1)} ms, slow ${rs.reduce((a, r) => a + r.slow, 0)} in ${rs.reduce((a, r) => a + r.clusters, 0)} runs`);
  }
  box.innerHTML = '';
  const pre = document.createElement('div');
  pre.textContent = `physics bench done:\n${lines.join('\n')}`;
  const copy = document.createElement('button');
  copy.textContent = 'copy JSON';
  copy.onclick = async () => (copy.textContent = await copyText(report));
  const down = document.createElement('button');
  down.textContent = 'download JSON';
  down.onclick = () => (down.textContent = downloadJson(report, `physbench-${Date.now()}.json`));
  box.append(pre, copy, document.createTextNode(' '), down);
}
