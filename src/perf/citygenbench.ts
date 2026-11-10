// (citygen M4b+) The town layout's phone bench: one link on the real phone, the screen kept awake (bench.ts keepAwake).
//   /?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&citygenbench=1          (&benchruns=5 &benchsecs=8)
// Phases:
//   generate  the whole town pipeline (citygen/town.ts townLayout: the atlas's raw ground, then every stage) for the
//             street lab's five sites (their atlas places, from the fixtures' headers) and three streamed atlas towns,
//             N runs each: GPU timestamps per stage where the device has them (a tiler's may not be trusted), the raw
//             ground's wall time, lots, vertices, bytes
//   toggle    the frame with a town generated every frame against the frame without — the toggle diff (memory "toggle,
//             don't timestamp"), the number to trust on a tiler
//   pan       the streamed-town pan: Muru to Bumku and 700 units on (towns made and let go as on a real pan), then back
//             with the streaming paused — frame intervals, spikes, the towns made and let go
// A result card and a JSON to download, copy or share (and, on the dev server, kept in perf-reports/).

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, stat, wakeLog, type Stat } from './bench';
import { postDev } from './report-io';
import { townLayout, type FieldTownSite } from '../citygen/town';
import type { FieldTowns } from '../citygen/towns';
import { STAGES, type StreetTimes } from '../citygen/gpu';
import { loadFixtureLand } from '../lab/fixtures';
import { ROW_H } from '../world/lattice';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.citygenbench.last';
const LAB_SITES = ['muru', 'river', 'mountain', 'mesa', 'coast'];
/** the atlas towns benched besides the lab's sites (the start town and its nearest two with a grid) */
const ATLAS_TOWNS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** what the bench reads of the level (window.reclaimed) */
interface Rec {
  core: { host: Parameters<typeof deviceFacts>[0] & { gpu: { device: GPUDevice } } };
  camera: { elevation: number; target: number[] };
  stream: { origin: [number, number] };
  scene: {
    fieldTowns?: FieldTowns;
    opts: { atlas?: { atlas: { rawGroundGpu(x0: number, y0: number, w: number, h: number, out: GPUBuffer): Promise<void>; p: { sea: number; cols: number; rows: number } }; startTown?: string } };
  };
}

interface SiteRow {
  site: string;
  kind: 'lab' | 'atlas';
  size: string;
  box: [number, number];
  rawGroundWallMs: number;
  lots: number;
  verts: number;
  mb: number;
  /** per stage, GPU ms over the runs (null: no timestamp-query) */
  stages: Record<string, Stat | null>;
  total: Stat | null;
}

async function genSite(R: Rec, site: FieldTownSite, kind: 'lab' | 'atlas', runs: number): Promise<SiteRow> {
  const a = R.scene.opts.atlas!.atlas;
  const dev = R.core.host.gpu.device;
  const L = townLayout(dev, site, { cols: a.p.cols, rows: a.p.rows }, a.p.sea);
  try {
    const t0 = performance.now();
    await a.rawGroundGpu(L.box.x0, L.box.y0, L.box.w, L.box.h, L.raw);
    await dev.queue.onSubmittedWorkDone();
    const rawMs = performance.now() - t0;
    // (the first run makes the heights and warms the passes: not counted)
    await L.gen.run(L.params, 'field');
    const ts: StreetTimes[] = [];
    for (let i = 0; i < runs; i++) ts.push(await L.gen.run(L.params, 'field'));
    const stages: Record<string, Stat | null> = {};
    for (const s of STAGES) {
      const v = ts.map((t) => t.stage[s]).filter((x): x is number => x !== null);
      stages[s] = v.length ? stat(v, 'ms') : null;
    }
    const tot = ts.map((t) => t.total).filter((x): x is number => x !== null);
    return { site: site.name, kind, size: site.size, box: [L.box.w, L.box.h], rawGroundWallMs: +rawMs.toFixed(1), lots: ts[0].lots, verts: ts[0].verts, mb: +((L.gen.bytes + L.raw.size) / 1048576).toFixed(1), stages, total: tot.length ? stat(tot, 'ms') : null };
  } finally {
    L.gen.dispose();
    L.raw.destroy();
  }
}

/** frame intervals for `secs` while `each` runs every frame (its promise not awaited: the GPU's queue takes them) */
async function frames(secs: number, each?: () => void): Promise<{ frameMs: Stat | null; over33: number; over50: number; n: number }> {
  const dt: number[] = [];
  let last = await frame();
  const t0 = performance.now();
  while (performance.now() - t0 < secs * 1000) {
    each?.();
    const t = await frame();
    dt.push(t - last);
    last = t;
  }
  return { frameMs: stat(dt, 'ms'), over33: dt.filter((v) => v > 33.4).length, over50: dt.filter((v) => v > 50).length, n: dt.length };
}

/** a pan between two world points (window coordinates from the window's origin each frame); the frame intervals */
async function pan(R: Rec, from: readonly [number, number], to: readonly [number, number], speed: number): Promise<Record<string, unknown>> {
  const ft = R.scene.fieldTowns!;
  const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const u = [(to[0] - from[0]) / L, (to[1] - from[1]) / L];
  const dt: number[] = [];
  const spikes: [number, number][] = [];
  const events: [string, string, number][] = [];
  const seen = new Set(ft.live.keys());
  let last = await frame();
  const t0 = performance.now();
  for (;;) {
    const now = await frame();
    dt.push(now - last);
    if (now - last > 40) spikes.push([+((now - t0) / 1000).toFixed(2), +(now - last).toFixed(0)]);
    last = now;
    const s = Math.min(L, ((now - t0) / 1000) * speed);
    const o = R.stream.origin;
    R.camera.target = [from[0] + u[0] * s - o[0], from[1] + u[1] * s - o[1] * ROW_H, R.camera.target[2]];
    for (const k of ft.live.keys()) if (!seen.has(k)) (seen.add(k), events.push(['made', k, +((now - t0) / 1000).toFixed(1)]));
    for (const k of [...seen]) if (!ft.live.has(k)) (seen.delete(k), events.push(['let go', k, +((now - t0) / 1000).toFixed(1)]));
    if (s >= L) break;
  }
  const fm = stat(dt, 'ms');
  return { length: +L.toFixed(0), speed, secs: +((performance.now() - t0) / 1000).toFixed(1), frameMs: fm, over33: dt.filter((v) => v > 33.4).length, over50: dt.filter((v) => v > 50).length, spikes, events };
}

export async function citygenBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'citygenbench', 'Reclaimed town layout bench');
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const runs = Number(params.get('benchruns') ?? 5);
  const secs = Number(params.get('benchsecs') ?? 8);
  panel.text(`build ${BUILD.commit} (${BUILD.at})`);
  const ft = R.scene.fieldTowns;
  if (!ft) throw new Error('citygen bench: no field towns (the link needs &citygen=fields)');
  const device = await deviceFacts(R.core.host);
  R.camera.elevation = Math.PI / 3;
  panel.say('town bench — waiting for the start town…');
  const start = R.scene.opts.atlas?.startTown ?? 's84';
  while (!ft.live.get(start)?.times) await sleep(250);
  await sleep(3000);
  // ---- generate
  const sites: { s: FieldTownSite; kind: 'lab' | 'atlas' }[] = [];
  for (const name of LAB_SITES) {
    try {
      const { fixture: fx } = await loadFixtureLand(name);
      // (the fixture's window origin (cells) and its town's place in it: its atlas place)
      const at: [number, number] = [fx.origin[0] + fx.town.at[0], fx.origin[1] * ROW_H + fx.town.at[1]];
      sites.push({ s: { id: `lab-${name}`, name: `lab ${name}`, at, size: 'town', roads: [], seed: [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) }, kind: 'lab' });
    } catch (e) {
      errors.push(`lab site ${name}: ${(e as Error).message}`);
    }
  }
  const near = [...ft.sites].sort((p, q) => ft.gap(p.id) - ft.gap(q.id)).slice(0, ATLAS_TOWNS);
  for (const s of near) sites.push({ s, kind: 'atlas' });
  const gen: SiteRow[] = [];
  for (const [i, { s, kind }] of sites.entries()) {
    panel.say(`town bench — generating ${i + 1}/${sites.length}: ${s.name} (${runs} runs)…`);
    try {
      gen.push(await genSite(R, s, kind, runs));
    } catch (e) {
      errors.push(`generate ${s.name}: ${(e as Error).message}`);
    }
  }
  // ---- toggle: a town made every frame against none
  panel.say(`town bench — toggle: ${secs} s without, ${secs} s with a town generated every frame, ${secs} s without…`);
  const a = R.scene.opts.atlas!.atlas;
  const dev = R.core.host.gpu.device;
  const T = townLayout(dev, near[0], { cols: a.p.cols, rows: a.p.rows }, a.p.sea);
  await a.rawGroundGpu(T.box.x0, T.box.y0, T.box.w, T.box.h, T.raw);
  await T.gen.run(T.params, 'field');
  const off1 = await frames(secs);
  let made = 0;
  let pending = false;
  const on = await frames(secs, () => {
    if (pending) return;
    pending = true;
    void T.gen.run(T.params, 'field').then(() => ((made++, (pending = false))));
  });
  while (pending) await sleep(50);
  const off2 = await frames(secs);
  T.gen.dispose();
  T.raw.destroy();
  const offP50 = ((off1.frameMs?.p50 ?? 0) + (off2.frameMs?.p50 ?? 0)) / 2;
  const toggle = { off: off1, on: { ...on, townsMade: made, perSec: +(made / secs).toFixed(1) }, offAgain: off2, diffP50: on.frameMs ? +(on.frameMs.p50 - offP50).toFixed(2) : null, diffMean: on.frameMs && off1.frameMs ? +(on.frameMs.mean - off1.frameMs.mean).toFixed(2) : null };
  // ---- pan: streamed, then back with streaming paused
  const from = ft.sites.find((s) => s.id === start)!.at;
  const next = ft.sites.filter((s) => s.id !== start).sort((p, q) => Math.hypot(p.at[0] - from[0], p.at[1] - from[1]) - Math.hypot(q.at[0] - from[0], q.at[1] - from[1]))[0];
  const d = [next.at[0] - from[0], next.at[1] - from[1]];
  const dl = Math.hypot(d[0], d[1]);
  const far: [number, number] = [next.at[0] + (d[0] / dl) * 700, next.at[1] + (d[1] / dl) * 700];
  panel.say(`town bench — pan ${start} → ${next.name} → on (streaming)…`);
  const panOn = await pan(R, from, far, 55);
  await sleep(2000);
  panel.say('town bench — pan back with the streaming paused…');
  ft.paused = true;
  const panOff = await pan(R, far, from, 55);
  ft.paused = false;
  await letSleep();
  const report = { kind: 'reclaimed-citygenbench', version: 1, build: BUILD, startedAt, finishedAt: new Date().toISOString(), url: location.href, device, wakeLock: held, wakeLog: [...wakeLog], runs, secs, generate: gen, toggle, pan: { to: next.name, streaming: panOn, paused: panOff }, live: [...ft.live.keys()], errors };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { citygenBenchReport: string }).citygenBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (storage full: the download is the copy)
  }
  panel.say(`town bench done — ${gen.length} sites × ${runs} runs, the toggle and the pan.`);
  panel.text(
    [
      ...gen.map((g) => `${g.site}: GPU ${g.total ? `p50 ${g.total.p50} ms` : 'n/a'} (${STAGES.map((s) => `${s} ${g.stages[s]?.p50 ?? '–'}`).join(' ')}); raw ground ${g.rawGroundWallMs} ms wall; ${g.lots} lots; ${g.mb} MB`),
      `toggle: frame p50 ${off1.frameMs?.p50} → ${on.frameMs?.p50} ms with a town every frame (${toggle.on.perSec}/s): +${toggle.diffP50} ms`,
      `pan streaming: p50 ${(panOn.frameMs as Stat | null)?.p50} p95 ${(panOn.frameMs as Stat | null)?.p95} max ${(panOn.frameMs as Stat | null)?.max} ms; paused: max ${(panOff.frameMs as Stat | null)?.max} ms`,
      ...errors.map((e) => `error: ${e}`),
    ].join(NL),
    true,
  );
  const kept = await postDev(body, 'citygenbench');
  if (kept) panel.text(kept, true);
  reportButtons(panel, body, false, 'citygenbench', 'Reclaimed town layout bench', true);
}
