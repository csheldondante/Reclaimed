// The hero lab's phone bench (round 128; the user's perf rule: "benchmarks I run on my phone via the existing pattern
// which keeps the screen awake and generates downloadable reports"). One link, run on the real phone: the hero lab's
// canyon, the autopilot riding (or walking) its ring, each hero under the chase alone and under the default camera
// (the cut and the tilt, CAM9/CAM11) — a reload each, matched pairs — then a result card and a JSON to download or
// copy (frame p50/p95/p99, fps, GPU ms where timed, the play layer's main-thread ms, and the cut's cost by toggling it
// against the chase within the page, as a tiler GPU needs).
//   /?skipmenu=1&level=herolab&tutorial=0&herobench=1                                   (every pair)
//   …&herobench=1&pairs=hoverbike:chase,hoverbike:cutaway+tilt                           (some)
// State between the loads in localStorage (cleared at the end). Every system in play as the deployed page runs it.

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, wakeLog } from './bench';
import { postDev } from './report-io';
import type { Toggle } from './physsummary';
import { HERO_BENCH_PAIRS, heroBenchLines, parsePair, type HeroBenchRow } from './herosummary';
import { toggled } from './toggle';

const KEY = 'reclaimed.herobench';
const LAST = 'reclaimed.herobench.last';
const NL = String.fromCharCode(10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** s to settle after the lab is up, s measured riding */
const SETTLE_S = 12;
const RIDE_S = 20;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

interface State {
  pairs: string[];
  rows: HeroBenchRow[];
  startedAt: string;
  device?: Record<string, unknown>;
  wake: { pair: string; held: boolean }[];
  wakeLog: string[];
}

function goTo(pair: string, step: number): void {
  const { hero, cam, station } = parsePair(pair);
  const u = new URL(location.href);
  u.searchParams.set('hero', hero);
  u.searchParams.set('cam', cam);
  u.searchParams.set('station', station);
  u.searchParams.delete('test');
  u.searchParams.delete('auto');
  u.searchParams.set('herobenchstep', String(step));
  location.href = u.toString();
}

export async function heroBench(params: URLSearchParams): Promise<void> {
  const R: Rec = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  let st: State | null;
  try {
    st = JSON.parse(localStorage.getItem(KEY) ?? 'null') as State | null;
  } catch {
    st = null;
  }
  const given = (params.get('pairs') ?? '').split(',').filter(Boolean);
  for (const p of given) parsePair(p);
  const pairs = given.length ? given : HERO_BENCH_PAIRS;
  if (!params.get('herobenchstep') || !st) {
    st = { pairs, rows: [], startedAt: new Date().toISOString(), wake: [], wakeLog: [] };
    panel.say('hero bench: the device…');
    st.device = await deviceFacts(R.core.host);
    localStorage.setItem(KEY, JSON.stringify(st));
    goTo(pairs[0], 0);
    return;
  }
  const step = Number(params.get('herobenchstep'));
  const here = st.pairs[step];
  st.wake.push({ pair: here, held });
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'herobench', 'Reclaimed hero bench');
  const head = `hero bench ${step + 1}/${st.pairs.length} (${here})`;
  panel.say(`${head}: the lab starting…`);
  // (the lab starts after the level: play/lab/herolab.ts on window.reclaimed.lab)
  for (let k = 0; !R.lab && k < 600; k++) await sleep(100);
  if (!R.lab) throw new Error('herobench: the hero lab did not start (is this ?level=herolab?)');
  const lab = R.lab;
  panel.say(`${head}: letting the level settle (${SETTLE_S} s)…`);
  await sleep(SETTLE_S * 1000);
  const P = R.core.host.profiler;
  P.active = true;
  P.resetTotals();
  const { cam, station } = parsePair(here);
  panel.say(`${head}: riding (${RIDE_S} s)…`);
  const s0 = { frames: lab.session.stats.frames, ms: lab.session.stats.ms };
  const p0 = lab.session.hero.position();
  const t: number[] = [];
  let cells = 0;
  let last = p0;
  let on = true;
  const tick = () => {
    t.push(performance.now());
    const p = lab.session.hero.position();
    cells += Math.hypot(p[0] - last[0], p[1] - last[1]);
    last = p;
    if (on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await sleep(RIDE_S * 1000);
  on = false;
  const d: number[] = [];
  for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  const f = [...d].sort((a, b) => a - b);
  const q = (x: number) => +f[Math.min(f.length - 1, Math.floor(x * f.length))].toFixed(1);
  const fr = P.framesResolved as number;
  const sf = lab.session.stats.frames - s0.frames;
  let cutToggle: Toggle | null = null;
  if (cam !== 'chase') {
    panel.say(`${head}: the camera off and on…`);
    cutToggle = await toggled(R, (off) => lab.pick({ cam: off ? 'chase' : cam }));
  }
  st.rows.push({
    pair: here,
    station,
    frames: d.length,
    fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    worst: +f[f.length - 1].toFixed(1),
    gpu: fr ? +(P.gpuTotalMs / fr).toFixed(2) : null,
    playMs: sf ? +((lab.session.stats.ms - s0.ms) / sf).toFixed(3) : null,
    cells: Math.round(cells),
    cutToggle,
  });
  st.wakeLog.push(...wakeLog.map((l) => `${here} ${l}`));
  localStorage.setItem(KEY, JSON.stringify(st));
  if (step + 1 < st.pairs.length) {
    panel.say(`hero bench: next, ${st.pairs[step + 1]} (reloading)…`);
    goTo(st.pairs[step + 1], step + 1);
    return;
  }
  localStorage.removeItem(KEY);
  await letSleep();
  const report = {
    kind: 'reclaimed-herobench',
    version: 1,
    startedAt: st.startedAt,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device: st.device ?? null,
    wakeLock: st.wake,
    wakeLog: st.wakeLog,
    note: 'Each pair is its own page load. The cut\'s cost is measured by toggling it against the chase within the page (cutToggle); per-pass GPU timestamps are unreliable on tiler GPUs (phones).',
    rows: st.rows,
  };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { heroBenchReport: string }).heroBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say(`Hero bench done: ${st.pairs.length} runs.`);
  panel.text(heroBenchLines(st.rows).join(NL), true);
  reportButtons(panel, body, false, 'herobench', 'Reclaimed hero bench', true);
  const dev = await postDev(body, 'herobench');
  if (dev) panel.text(`dev server: ${dev}`, true);
  panel.button('Run again', false, () => {
    const u = new URL(location.href);
    u.searchParams.delete('herobenchstep');
    location.href = u.toString();
  });
}
