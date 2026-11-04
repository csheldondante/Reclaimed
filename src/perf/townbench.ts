// The town pan phone bench (round 128g, cityrender; the user: "The town seems slightly glitchy when panning"; "This
// should only happen off screen we should prioritize and keep cached the city tiles"). One link, run on the real phone:
// the atlas at a town, the camera panned across it and back at the play zoom and zoomed out, every frame timed; then a
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
  camera: { zoom: number; screenDeltaToWorld(dx: number, dy: number): [number, number] };
  scene: { pan: unknown };
  settlementsView(): {
    stats: { updateMs: number; built: number; drawn: number; cached: number };
    sg: { stats: { uploads: number; uploadedPieces: number; gridWrites: number; draws: number } };
    gaps: { id: string; gap: number; shown: boolean }[];
    isDrawn(id: string): boolean;
  } | null;
  stream: { origin: [number, number] };
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
}

/** one pan across the town and back at this zoom, every frame measured */
async function panRow(R: Rec, zoom: number, speed: number, secs: number): Promise<Row> {
  const view = R.settlementsView();
  if (!view) throw new Error('town bench: no settlements view (the atlas level with ?town=)');
  R.camera.zoom = zoom;
  for (let t0 = performance.now(); performance.now() - t0 < 2000; ) await frame();
  const [ux, uy] = R.camera.screenDeltaToWorld(0, -1);
  const l = Math.hypot(ux, uy) || 1;
  const dt: number[] = [];
  const vm: number[] = [];
  const up0 = { ...view.sg.stats };
  const built0 = view.stats.built;
  let slides = 0;
  let pops = 0;
  let drawnMax = 0;
  let origin = `${R.stream.origin}`;
  let prev = new Map<string, { on: boolean; drawn: boolean }>();
  for (const d of [1, -1]) {
    (R.scene as { pan: unknown }).pan = { speed, dir: [(ux / l) * d, (uy / l) * d], t: 0, turnAt: 0, turnBy: 0, turned: 0, asked: 0 };
    let last = await frame();
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      const t = await frame();
      dt.push(t - last);
      last = t;
      vm.push(view.stats.updateMs);
      drawnMax = Math.max(drawnMax, view.stats.drawn);
      const o = `${R.stream.origin}`;
      if (o !== origin) {
        origin = o;
        slides++;
      }
      const next = new Map<string, { on: boolean; drawn: boolean }>();
      for (const g of view.gaps) {
        const now = { on: g.gap === 0, drawn: view.isDrawn(g.id) };
        const p = prev.get(g.id);
        if (p && p.on && now.on && p.drawn !== now.drawn) pops++;
        next.set(g.id, now);
      }
      prev = next;
    }
  }
  (R.scene as { pan: unknown }).pan = null;
  const s = view.sg.stats;
  return {
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
  };
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
    panel.say(`town bench ${i + 1}/${zooms.length}: panning across the town and back at zoom ${z.toFixed(2)} (${2 * secs} s)…`);
    rows.push(await panRow(R, z, speed, secs));
  }
  R.camera.zoom = play;
  await letSleep();
  const report = { kind: 'reclaimed-townbench', version: 1, startedAt, finishedAt: new Date().toISOString(), url: location.href, device, wakeLock: held, wakeLog: [...wakeLog], speed, secs, rows };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { townBenchReport: string }).townBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say(`Town bench done — ${rows.length} zooms, ${speed} cells/s, ${secs} s each way.`);
  panel.text(
    rows
      .map((r) => `zoom ${r.zoom}: frames p50 ${r.frameMs?.p50} p95 ${r.frameMs?.p95} max ${r.frameMs?.max} ms; over 33 ms ${r.over33}, over 50 ms ${r.over50}; view ${r.viewMs?.p95} ms p95; ${r.slides} slides, ${r.uploads} uploads (${r.builds} builds), ${r.gridWrites} grid rows; pops on screen ${r.pops}`)
      .join(NL),
    true,
  );
  reportButtons(panel, body, false, 'townbench', 'Reclaimed town pan bench', true);
}
