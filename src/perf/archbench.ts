// (archgen) The building generator's phone bench: one link on the real phone, the screen kept awake (bench.ts keepAwake).
//   /?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&arch=1&archbench=1          (&benchsecs=6)
// Toggle diffs, not timestamps (memory: a tiler's per-pass timestamps aren't to be trusted): the frame interval with a
// thing on against off, at the start town at play zoom (60°, the device's own zoom), the camera on its built lots.
// Phases:
//   draw       the buildings drawn (every part kind, shadows) against not drawn at all: off, on, off
//   kinds      each heavy kind left out in turn (roofs, built windows, cones, shrubs, wheels, bodies, crenels, steps):
//              its share of the frame is all − without
//   shadows    the buildings in the sun's shadow pass against out of it
//   windows    the built windows (the PC's detail layer) forced on against off — what they'd cost on this device
//   generate   every live town's lots made again every frame against not (a town made as it streams in)
//   pan        a streamed pan from the start town past the next one (towns made back to back), its spikes
// A result card and a JSON to download, copy or share (and, on the dev server, kept in perf-reports/).

import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, stat, wakeLog, type Stat } from './bench';
import { postDev } from './report-io';
import type { FieldTowns } from '../citygen/towns';
import type { TownBuildings } from '../archgen/townbuildings';
import { KIND } from '../archgen/archgen';
import { ROW_H } from '../world/lattice';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.archbench.last';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** what the bench reads of the level (window.reclaimed) */
interface Rec {
  core: { host: Parameters<typeof deviceFacts>[0] & { gpu: { device: GPUDevice } } };
  camera: { elevation: number; target: number[]; zoom: number };
  stream: { origin: [number, number] };
  renderer: { archSources: unknown[]; archSkip: Set<number>; archShadow: boolean; archWindows: boolean };
  scene: { fieldTowns?: FieldTowns; opts: { atlas?: { startTown?: string } } };
}

interface Run {
  frameMs: Stat | null;
  over33: number;
  over50: number;
  n: number;
}

/** frame intervals for `secs` while `each` runs every frame */
async function frames(secs: number, each?: () => void): Promise<Run> {
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

const p50 = (r: Run) => r.frameMs?.p50 ?? 0;
const mean = (r: Run) => r.frameMs?.mean ?? 0;
const d2 = (x: number) => +x.toFixed(2);

/** a test-only read of a buffer (the bench aims the camera; play never reads back) */
async function read(dev: GPUDevice, buf: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
  const b = dev.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const e = dev.createCommandEncoder();
  e.copyBufferToBuffer(buf, 0, b, 0, bytes);
  dev.queue.submit([e.finish()]);
  await b.mapAsync(GPUMapMode.READ);
  const out = b.getMappedRange().slice(0);
  b.destroy();
  return out;
}

export async function archBench(params: URLSearchParams): Promise<void> {
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'archbench', 'Reclaimed building bench');
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const secs = Number(params.get('benchsecs') ?? 6);
  panel.text(`build ${BUILD.commit} (${BUILD.at})`);
  panel.say('building bench — waiting for the level…');
  let R: Rec | undefined;
  while (!(R = (window as unknown as { reclaimed?: Rec }).reclaimed)?.scene?.fieldTowns) await sleep(250);
  const ft = R.scene.fieldTowns!;
  const tb = (globalThis as { archTowns?: TownBuildings }).archTowns;
  if (!tb) throw new Error('building bench: no building generator (the link needs &arch=1)');
  const rd = R.renderer;
  const dev = R.core.host.gpu.device;
  const device = await deviceFacts(R.core.host);
  R.camera.elevation = Math.PI / 3;
  panel.say('building bench — waiting for the start town…');
  const start = R.scene.opts.atlas?.startTown ?? 's84';
  while (!ft.live.get(start)?.times) await sleep(250);
  await sleep(3000);
  // the camera on the start town's built lots (their mean), at the device's own zoom
  const town = ft.live.get(start)!;
  const cnt = new Uint32Array(await read(dev, town.lots.counts, 16));
  const n = Math.min(cnt[0], cnt[3]);
  const rec = await read(dev, town.lots.records, Math.max(n, 1) * 96);
  const pr = new Float32Array(await read(dev, town.lots.progress, Math.max(n, 1) * 4));
  const u = new Uint32Array(rec);
  const f = new Float32Array(rec);
  let x = 0;
  let y = 0;
  let k = 0;
  for (let i = 0; i < n; i++) if (u[i * 24 + 17] === 1 && pr[i] > 0.5) (x += f[i * 24 + 8], (y += f[i * 24 + 9]), k++);
  const w = k ? ft.inWindow(start, [x / k, y / k]) : null;
  if (w) R.camera.target = [w[0], w[1], R.camera.target[2]];
  await sleep(1500);
  const counts = await tb.counts();
  const view = { zoom: R.camera.zoom, elevation: R.camera.elevation, builtLots: k, towns: tb.live, windowsDrawn: rd.archWindows };

  // ---- draw: the buildings against none
  panel.say(`building bench — drawn against not: ${secs} s each, off / on / off…`);
  const keep = [...rd.archSources];
  const off = () => rd.archSources.splice(0, rd.archSources.length);
  const on = () => (off(), rd.archSources.push(...keep));
  off();
  const off1 = await frames(secs);
  on();
  const all = await frames(secs);
  off();
  const off2 = await frames(secs);
  on();
  const offP50 = (p50(off1) + p50(off2)) / 2;
  const draw = { off: off1, on: all, offAgain: off2, costP50: d2(p50(all) - offP50), costMean: d2(mean(all) - (mean(off1) + mean(off2)) / 2) };

  // ---- kinds: each left out in turn
  const kinds: Record<string, unknown> = {};
  for (const [name, kk] of Object.entries(KIND)) {
    if (!counts[name]) continue;
    panel.say(`building bench — without ${name} (${counts[name]} instances)…`);
    rd.archSkip.add(kk);
    const r = await frames(secs);
    rd.archSkip.delete(kk);
    kinds[name] = { instances: counts[name], without: r, shareP50: d2(p50(all) - p50(r)), shareMean: d2(mean(all) - mean(r)) };
  }

  // ---- shadows
  panel.say('building bench — the buildings out of the shadow pass…');
  rd.archShadow = false;
  const noShadow = await frames(secs);
  rd.archShadow = true;
  const shadows = { without: noShadow, shareP50: d2(p50(all) - p50(noShadow)) };

  // ---- the built windows forced the other way
  const was = rd.archWindows;
  panel.say(`building bench — the built windows ${was ? 'off' : 'on'}…`);
  rd.archWindows = !was;
  const flipped = await frames(secs);
  rd.archWindows = was;
  const windows = { drawnByDefault: was, flipped, diffP50: d2(p50(flipped) - p50(all)) };

  // ---- generate: every town's lots made every frame
  panel.say('building bench — every town made again every frame…');
  const gen = await frames(secs, () => tb.remakeAll());
  const generate = { towns: tb.live, every: gen, costP50: d2(p50(gen) - p50(all)), costMean: d2(mean(gen) - mean(all)) };

  // ---- pan: streamed, towns made back to back
  const from = ft.sites.find((s) => s.id === start)!.at;
  const next = ft.sites.filter((s) => s.id !== start).sort((p, q) => Math.hypot(p.at[0] - from[0], p.at[1] - from[1]) - Math.hypot(q.at[0] - from[0], q.at[1] - from[1]))[0];
  let pan: Record<string, unknown> = {};
  if (next) {
    panel.say(`building bench — pan ${start} → ${next.name} and on (streaming)…`);
    const dx = next.at[0] - from[0];
    const dy = next.at[1] - from[1];
    const L = Math.hypot(dx, dy) + 500;
    const speed = 55;
    const dt: number[] = [];
    const spikes: [number, number][] = [];
    let last = await frame();
    const t0 = performance.now();
    for (;;) {
      const now = await frame();
      dt.push(now - last);
      if (now - last > 40) spikes.push([+((now - t0) / 1000).toFixed(2), +(now - last).toFixed(0)]);
      last = now;
      const s = Math.min(L, ((now - t0) / 1000) * speed);
      const o = R.stream.origin;
      const hl = Math.hypot(dx, dy);
      R.camera.target = [from[0] + (dx / hl) * s - o[0], from[1] + (dy / hl) * s - o[1] * ROW_H, R.camera.target[2]];
      if (s >= L) break;
    }
    pan = { to: next.name, length: +L.toFixed(0), speed, frameMs: stat(dt, 'ms'), over33: dt.filter((v) => v > 33.4).length, over50: dt.filter((v) => v > 50).length, spikes, townsMade: tb.stats.made };
  }
  await letSleep();

  const report = { kind: 'reclaimed-archbench', version: 1, build: BUILD, startedAt, finishedAt: new Date().toISOString(), url: location.href, device, wakeLock: held, wakeLog: [...wakeLog], secs, view, counts, draw, kinds, shadows, windows, generate, pan, errors };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { archBenchReport: string }).archBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (storage full: the download is the copy)
  }
  panel.say('building bench done.');
  const ks = Object.entries(kinds).map(([kn, v]) => `${kn} ${(v as { shareP50: number }).shareP50}`);
  panel.text(
    [
      `${counts.vertices ?? 0} vertices drawn (${Object.entries(counts).filter(([kn]) => kn !== 'vertices').map(([kn, c]) => `${kn} ${c}`).join(', ')})`,
      `buildings: frame p50 ${p50(off1)} → ${p50(all)} ms drawn: +${draw.costP50} ms`,
      `each kind's share (ms, p50): ${ks.join(' · ')}`,
      `in the shadow pass: ${shadows.shareP50} ms; built windows ${was ? 'off' : 'on'}: ${windows.diffP50 > 0 ? '+' : ''}${windows.diffP50} ms`,
      `every town made every frame: +${generate.costP50} ms (${generate.towns} towns)`,
      `pan: p50 ${(pan.frameMs as Stat | undefined)?.p50} p95 ${(pan.frameMs as Stat | undefined)?.p95} max ${(pan.frameMs as Stat | undefined)?.max} ms`,
      ...errors.map((e) => `error: ${e}`),
    ].join(NL),
    true,
  );
  const kept = await postDev(body, 'archbench');
  if (kept) panel.text(kept, true);
  reportButtons(panel, body, false, 'archbench', 'Reclaimed building bench', true);
}
