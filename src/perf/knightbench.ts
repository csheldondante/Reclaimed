// The knight's phone bench (knight pass 2, round 128; the user's PERF RULE: "all need to be done and benchmarks I run on
// my phone via the existing pattern which keeps the screen awake and generates downloadable reports"). One link, run on
// the real phone: the knight's station on the atlas, every system in play as the deployed page runs it, the same
// scripted fight each page — the knight running a circle (the stick held round), a swipe every 0.4 s, a jump every 3 s
// — against no enemies, a raider wave (7) and a mixed wave (3 raiders, 2 guards, 2 lungers), each a page of its own by
// reload, in the order none, raiders, mixed, mixed, raiders, none (matched pairs: the clock and heat drift averaged
// out). Frame p50/p95/p99, the GPU's frame (where the adapter times it: a tiler's timestamps are a proxy), the play
// layer's main-thread ms, the units' sync. A result card and a JSON to download, copy or share (src/perf/report-io.ts
// through bench.ts reportButtons), the screen kept awake (bench.ts keepAwake).
//   /?skipmenu=1&level=atlas&play=knight&station=1&tutorial=0&knightbench=1
// State between the loads in localStorage (cleared at the end).

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, stat, wakeLog } from './bench';
import { postDev } from './report-io';

const KEY = 'reclaimed.knightbench';
const LAST = 'reclaimed.knightbench.last';
const NL = String.fromCharCode(10);
const ORDER = ['none', 'raiders', 'mixed', 'mixed', 'raiders', 'none'] as const;
type Wave = (typeof ORDER)[number];
const WAVES: Record<Wave, string[]> = {
  none: [],
  raiders: ['raider', 'raider', 'raider', 'raider', 'raider', 'raider', 'raider'],
  mixed: ['raider', 'raider', 'raider', 'blocker', 'blocker', 'lunger', 'lunger'],
};
const SETTLE_MS = 20000;
const MEASURE_MS = 15000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

interface Row {
  wave: Wave;
  page: number;
  frames: number;
  fps: number;
  frameMs: ReturnType<typeof stat>;
  gpuMs: number | null;
  playMs: number;
  syncMs: number | null;
  units: number;
  knight: Record<string, number>;
}

interface State {
  startedAt: string;
  rows: Row[];
  device?: Record<string, unknown>;
  wake: { page: number; held: boolean }[];
  wakeLog: string[];
}

/** a stroke on the play pad as touch pointer events, `ms` apart (the knight reads strokes as they're drawn) */
async function stroke(pts: [number, number][], ms = 16): Promise<void> {
  const pad = document.querySelector('.play-pad');
  if (!pad) return;
  const id = 900 + Math.floor(Math.random() * 1000);
  const ev = (type: string, [x, y]: [number, number]) => pad.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: false }));
  ev('pointerdown', pts[0]);
  for (const q of pts.slice(1)) {
    await sleep(ms);
    ev('pointermove', q);
  }
  ev('pointerup', pts[pts.length - 1]);
}

export async function knightBench(params: URLSearchParams): Promise<void> {
  const R: Rec = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  let st: State | null;
  try {
    st = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    st = null;
  }
  const stepP = params.get('knightbenchstep');
  if (stepP === null || !st) {
    st = { startedAt: new Date().toISOString(), rows: [], wake: [], wakeLog: [] };
    panel.say('knight bench: the device…');
    st.device = await deviceFacts(R.core.host);
    localStorage.setItem(KEY, JSON.stringify(st));
    const u = new URL(location.href);
    u.searchParams.set('knightbenchstep', '0');
    location.href = u.toString();
    return;
  }
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'knightbench', 'Reclaimed knight bench');
  const step = Number(stepP);
  const wave = ORDER[step];
  st.wake.push({ page: step, held });
  const tag = `knight bench ${step + 1}/${ORDER.length} (${wave})`;
  panel.say(`${tag} — letting the land come in (${SETTLE_MS / 1000} s)…`);
  await sleep(SETTLE_MS);
  const play = R.play;
  if (!play?.station) throw new Error('knightbench: needs the knight station (&play=knight&station=1)');
  play.station.clear();
  if (WAVES[wave].length) play.station.ring(WAVES[wave], 8);
  await sleep(1500);
  // the scripted fight: the stick round a circle (scripted thumb), a swipe every 0.4 s toward the screen's middle-right,
  // JUMP every 3 s
  const W = innerWidth;
  const H = innerHeight;
  const S: [number, number] = [W * 0.62, H * 0.38];
  let live = true;
  const t0 = performance.now();
  void (async () => {
    let k = 0;
    while (live) {
      const a = ((performance.now() - t0) / 1000) * 1.2;
      play.controls.script = { stick: [Math.cos(a), Math.sin(a)], buttons: [k % 8 === 7] };
      const d = (k % 4) * (Math.PI / 2);
      await stroke([S, [S[0] + Math.cos(d) * 35, S[1] + Math.sin(d) * 35], [S[0] + Math.cos(d) * 70, S[1] + Math.sin(d) * 70]]);
      k++;
      await sleep(370);
    }
    play.controls.script = null;
  })();
  panel.say(`${tag} — the fight, measuring ${MEASURE_MS / 1000} s…`);
  const P = R.core.host.profiler;
  P.active = true;
  P.resetTotals();
  const ms0 = play.stats.ms;
  const fr0 = play.stats.frames;
  const t: number[] = [];
  let on = true;
  let units = 0;
  const tick = () => {
    t.push(performance.now());
    if (on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const syncs: number[] = [];
  const watch = setInterval(() => {
    const s = R.units?.stats;
    if (s) {
      syncs.push(s.syncMs);
      units = Math.max(units, s.units);
    }
  }, 250);
  await sleep(MEASURE_MS);
  on = false;
  live = false;
  clearInterval(watch);
  const d: number[] = [];
  for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  const fr = P.framesResolved as number;
  const h = play.hero;
  st.rows.push({
    wave,
    page: step,
    frames: d.length,
    fps: +(d.length / ((t[t.length - 1] - t[0]) / 1000)).toFixed(1),
    frameMs: stat(d, 'ms'),
    gpuMs: fr ? +(P.gpuTotalMs / fr).toFixed(2) : null,
    playMs: +((play.stats.ms - ms0) / Math.max(1, play.stats.frames - fr0)).toFixed(3),
    syncMs: syncs.length ? +(syncs.reduce((a, b) => a + b, 0) / syncs.length).toFixed(2) : null,
    units,
    knight: { ...(h.stats ?? {}) },
  });
  play.station.clear();
  st.wakeLog.push(...wakeLog.map((l) => `page ${step} ${l}`));
  localStorage.setItem(KEY, JSON.stringify(st));
  if (step + 1 < ORDER.length) {
    const u = new URL(location.href);
    u.searchParams.set('knightbenchstep', String(step + 1));
    panel.say(`knight bench: next, ${ORDER[step + 1]} (reloading)…`);
    location.href = u.toString();
    return;
  }
  localStorage.removeItem(KEY);
  await letSleep();
  // (each wave's pages pooled: the matched pairs' mean)
  const by = (w: Wave) => st!.rows.filter((r) => r.wave === w);
  const mean = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === 'number');
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
  };
  const summary = Object.fromEntries(
    (['none', 'raiders', 'mixed'] as Wave[]).map((w) => [w, { p50: mean(by(w).map((r) => r.frameMs?.p50)), p95: mean(by(w).map((r) => r.frameMs?.p95)), fps: mean(by(w).map((r) => r.fps)), gpuMs: mean(by(w).map((r) => r.gpuMs)), playMs: mean(by(w).map((r) => r.playMs)) }]),
  );
  const report = { kind: 'reclaimed-knightbench', version: 1, startedAt: st.startedAt, finishedAt: new Date().toISOString(), url: location.href, device: st.device ?? null, wakeLock: st.wake, wakeLog: st.wakeLog, order: ORDER, summary, rows: st.rows };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { knightBenchReport: string }).knightBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (storage full: the download is the copy)
  }
  panel.say(`Knight bench done — ${ORDER.length} pages (none, raiders, mixed, each twice).`);
  const lines = Object.entries(summary).map(([w, s]) => `${w}: ${s.fps} fps, frame p50 ${s.p50} / p95 ${s.p95} ms${s.gpuMs !== null ? `, GPU ${s.gpuMs} ms` : ''}, play ${s.playMs} ms`);
  panel.text(lines.join(NL), true);
  reportButtons(panel, body, false, 'knightbench', 'Reclaimed knight bench', true);
  const dev = await postDev(body, 'knightbench');
  if (dev) panel.text(`dev server: ${dev}`, true);
  panel.button('Run again', false, () => {
    const u = new URL(location.href);
    u.searchParams.delete('knightbenchstep');
    location.href = u.toString();
  });
}
