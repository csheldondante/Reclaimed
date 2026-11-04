// The town pan phone bench (round 128g, cityrender; the user: "The town seems slightly glitchy when panning"; "This
// should only happen off screen we should prioritize and keep cached the city tiles"). One link, run on the real phone:
// the atlas at a town, the camera panned out from it and back four ways (round 128h: far enough that the window slides,
// the town kept on screen) at the play zoom and zoomed out, every frame timed; then a
// result card and a JSON to copy or download (frame p50/p95/p99/max, hitches over 33 and 50 ms, the settlements view's
// CPU ms, pieces uploaded and grid rows written, a town's drawing changing while it's on screen — expected 0).
//   /?skipmenu=1&level=atlas&town=1&tutorial=0&townbench=1        (zooms: the play zoom and 1.3)
//   …&townbench=1&benchzooms=4,2.6,1.3&benchspeed=40&benchsecs=10
// Every system in play as the deployed page runs it; the screen kept awake (src/perf/bench.ts keepAwake).

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, stat, wakeLog, type Stat } from './bench';

const NL = String.fromCharCode(10);
const LAST = 'reclaimed.townbench.last';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** what the bench reads of the level (window.reclaimed) */
interface Rec {
  core: { host: Parameters<typeof deviceFacts>[0] };
  camera: { zoom: number; target: [number, number, number]; viewportW: number; viewportH: number; screenDeltaToWorld(dx: number, dy: number): [number, number] };
  scene: { pan: unknown };
  settlementsView(): {
    stats: { updateMs: number; built: number; drawn: number; cached: number };
    sg: { stats: { uploads: number; uploadedPieces: number; gridWrites: number; draws: number } };
    gaps: { id: string; gap: number; shown: boolean }[];
    isDrawn(id: string): boolean;
  } | null;
  stream: { origin: [number, number]; busy?: boolean };
}

interface Row {
  zoom: number;
  frames: number;
  frameMs: Stat | null;
  over33: number;
  over50: number;
  viewMs: Stat | null;
  slides: number;
  builds: number;
  uploads: number;
  uploadedPieces: number;
  gridWrites: number;
  /** a town's drawing changed while it was on screen (expected 0) */
  pops: number;
  drawnMax: number;
  /** (round 128h) the legs panned (out from the town and back: up, down, left and right of the screen), how far the
   *  camera went in all (m), the share of frames a town was on screen, the share the streamer was busy, the wait for it
   *  to settle before the row (ms) */
  legs: number;
  travel: number;
  townOnScreen: number;
  busy: number;
  settleMs: number;
  /** (round 128h) why this row doesn't measure what it's for (a pan that never slid the window): empty when it does */
  fail: string[];
}

/** (round 128h) the farthest a leg goes out from the town (m): the window slides about every 32 m of a pan */
const LEG_MAX = 100;

/** the camera's point in world units (the window's frame moves with each slide: its origin added back) */
const ROW_H = Math.sqrt(3) / 2;
const worldOf = (R: Rec): [number, number] => [R.stream.origin[0] + R.camera.target[0], R.stream.origin[1] * ROW_H + R.camera.target[1]];

/**
 * (round 128h; the Pixel 9a's report: 0 slides, 0 grid writes, 0 uploads on every row — the pan never slid the window,
 * so the bench never tested the slide path) One row: from the town, legs out and back up, down, left and right of the
 * screen — each out 30% of the screen (the town stays on screen), at most LEG_MAX — every way at least once, then
 * round again till `secs` x 2 seconds are up, every frame measured. A row with no slide fails loudly.
 */
async function panRow(R: Rec, zoom: number, speed: number, secs: number): Promise<Row> {
  const view = R.settlementsView();
  if (!view) throw new Error('town bench: no settlements view (the atlas level with ?town=)');
  R.camera.zoom = zoom;
  for (let t0 = performance.now(); performance.now() - t0 < 2000; ) await frame();
  // (the streamer settled first: a slide waits while it's busy)
  const s0 = performance.now();
  while (R.stream.busy && performance.now() - s0 < 20000) await frame();
  const settleMs = Math.round(performance.now() - s0);
  const home = worldOf(R);
  const vw = R.camera.viewportW;
  const vh = R.camera.viewportH;
  const legs = [
    [0, -vh],
    [0, vh],
    [-vw, 0],
    [vw, 0],
  ].map(([sx, sy]) => {
    const [x, y] = R.camera.screenDeltaToWorld(sx * 0.3, sy * 0.3);
    const l = Math.hypot(x, y) || 1;
    // (no farther than LEG_MAX: a few slides out and a few back, at 40 cells a second a leg of 5 s or less)
    return { dir: [x / l, y / l] as [number, number], dist: Math.min(l, LEG_MAX) };
  });
  const dt: number[] = [];
  const vm: number[] = [];
  const up0 = { ...view.sg.stats };
  const built0 = view.stats.built;
  let slides = 0;
  let pops = 0;
  let drawnMax = 0;
  let onFrames = 0;
  let busyFrames = 0;
  let travel = 0;
  let nLegs = 0;
  let origin = String(R.stream.origin);
  let prev = new Map<string, { on: boolean; drawn: boolean }>();
  let last = await frame();
  let at = worldOf(R);
  const t0 = performance.now();
  const step = async () => {
    const t = await frame();
    dt.push(t - last);
    last = t;
    vm.push(view.stats.updateMs);
    drawnMax = Math.max(drawnMax, view.stats.drawn);
    if (R.stream.busy) busyFrames++;
    const o = String(R.stream.origin);
    if (o !== origin) {
      origin = o;
      slides++;
    }
    const w = worldOf(R);
    travel += Math.hypot(w[0] - at[0], w[1] - at[1]);
    at = w;
    const next = new Map<string, { on: boolean; drawn: boolean }>();
    let on = false;
    for (const g of view.gaps) {
      const now = { on: g.gap === 0, drawn: view.isDrawn(g.id) };
      on ||= now.on;
      const p = prev.get(g.id);
      if (p && p.on && now.on && p.drawn !== now.drawn) pops++;
      next.set(g.id, now);
    }
    if (on) onFrames++;
    prev = next;
  };
  const along = (d: [number, number]) => {
    const w = worldOf(R);
    return (w[0] - home[0]) * d[0] + (w[1] - home[1]) * d[1];
  };
  // (every way at least once, then on round till the time's up, whole rounds)
  while (nLegs % legs.length !== 0 || nLegs === 0 || performance.now() - t0 < secs * 2000) {
    const leg = legs[nLegs++ % legs.length];
    for (const sgn of [1, -1]) {
      const d: [number, number] = [leg.dir[0] * sgn, leg.dir[1] * sgn];
      (R.scene as { pan: unknown }).pan = { speed, dir: d, t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
      // (out: till it's `dist` from the town; back: till it's home — or the leg's time is up, should the camera be held)
      const l0 = performance.now();
      const limit = Math.min((leg.dist / speed) * 3000 + 2000, 15000);
      while (performance.now() - l0 < limit && (sgn > 0 ? along(leg.dir) < leg.dist : along(leg.dir) > 0)) await step();
    }
    (R.scene as { pan: unknown }).pan = null;
    // (exactly home again: a frame's overshoot taken out)
    const w = worldOf(R);
    R.camera.target[0] -= w[0] - home[0];
    R.camera.target[1] -= w[1] - home[1];
    await step();
  }
  (R.scene as { pan: unknown }).pan = null;
  const s = view.sg.stats;
  const row: Row = {
    zoom: +zoom.toFixed(2),
    frames: dt.length,
    frameMs: stat(dt, 'ms'),
    over33: dt.filter((v) => v > 33.4).length,
    over50: dt.filter((v) => v > 50).length,
    viewMs: stat(vm, 'ms'),
    slides,
    builds: view.stats.built - built0,
    uploads: s.uploads - up0.uploads,
    uploadedPieces: s.uploadedPieces - up0.uploadedPieces,
    gridWrites: s.gridWrites - up0.gridWrites,
    pops,
    drawnMax,
    legs: nLegs,
    travel: Math.round(travel),
    townOnScreen: +(onFrames / Math.max(1, dt.length)).toFixed(2),
    busy: +(busyFrames / Math.max(1, dt.length)).toFixed(2),
    settleMs,
    fail: [],
  };
  if (row.slides === 0) row.fail.push('no slides: the pan never slid the window (the camera went ' + row.travel + ' m, the streamer busy ' + Math.round(row.busy * 100) + '% of frames), so this row did not test the slide path');
  else if (row.gridWrites === 0) row.fail.push('no grid rows written though the window slid');
  if (row.townOnScreen < 0.5) row.fail.push('the town was on screen only ' + Math.round(row.townOnScreen * 100) + '% of frames');
  return row;
}

export async function townBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'townbench', 'Reclaimed town pan bench');
  const startedAt = new Date().toISOString();
  const device = await deviceFacts(R.core.host);
  const play = R.camera.zoom;
  const zooms = (params.get('benchzooms') ?? `${play},1.3`).split(',').map(Number).filter((z) => z > 0);
  const speed = Number(params.get('benchspeed') ?? 40);
  const secs = Number(params.get('benchsecs') ?? 10);
  panel.say('town bench — letting the level settle (15 s)…');
  await sleep(15000);
  const rows: Row[] = [];
  for (const [i, z] of zooms.entries()) {
    panel.say(`town bench ${i + 1}/${zooms.length}: panning out from the town and back four ways at zoom ${z.toFixed(2)} (${2 * secs} s)…`);
    rows.push(await panRow(R, z, speed, secs));
  }
  R.camera.zoom = play;
  await letSleep();
  const failures = rows.flatMap((r) => r.fail.map((f) => `zoom ${r.zoom}: ${f}`));
  const report = { kind: 'reclaimed-townbench', version: 2, startedAt, finishedAt: new Date().toISOString(), url: location.href, device, wakeLock: held, wakeLog: [...wakeLog], speed, secs, ok: failures.length === 0, failures, rows };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { townBenchReport: string }).townBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say(failures.length ? `Town bench FAILED: ${failures.length === 1 ? '1 problem' : `${failures.length} problems`} (in red below).` : `Town bench done — ${rows.length} zooms, ${speed} cells/s, ${2 * secs} s a zoom.`);
  // (round 128h) a row that didn't test what it's for: in red, before the numbers (the report's ok and failures too)
  for (const f of failures) {
    const d = panel.text(`FAILED — ${f}`);
    d.style.color = '#ff6b5a';
    d.style.fontWeight = '600';
  }
  panel.text(
    rows
      .map((r) => `zoom ${r.zoom}: frames p50 ${r.frameMs?.p50} p95 ${r.frameMs?.p95} max ${r.frameMs?.max} ms; over 33 ms ${r.over33}, over 50 ms ${r.over50}; view ${r.viewMs?.p95} ms p95; ${r.slides} slides, ${r.uploads} uploads (${r.builds} builds), ${r.gridWrites} grid rows; pops on screen ${r.pops}; ${r.legs} legs, ${r.travel} m, town on screen ${Math.round(r.townOnScreen * 100)}%`)
      .join(NL),
    true,
  );
  reportButtons(panel, body, false, 'townbench', 'Reclaimed town pan bench', true);
}
