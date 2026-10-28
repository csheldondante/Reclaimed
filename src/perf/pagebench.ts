// Round 107 (`pages`, docs/PAGES.md P2.0 M1): what the page-table lookup costs, on the phone. ?pagebench=1.
// The same atlas spot at window 256, loaded once a way to find a chunk's page (gpu/pages-mode.ts ?pages=): the ring
// computed, the table in the Globals (a uniform) and the table in a storage buffer — twice each, in the order
// ring, table, storage, storage, table, ring (the clock drifts; the two rounds are averaged). On each, a storm over
// the camera wakes the land, then the heavy neighbour-reading systems (liquid-water, sediment, water) are encoded
// once more through a recorder and every dispatch they made is replayed on its own: REPS of it in one compute pass,
// timed at the pass's begin and end (bench v4's way: Mali's timestamps are sane inside one pass, not across many),
// and the wall from submit to onSubmittedWorkDone (less an empty submit's). The end page shows the table and has a
// Download button.
//   start:  ?pagebench=1          a run page: ?pagebench=run&pages=<way>   the end: ?pagebench=done

import { GpuTimer, stat } from './bench';
import { copyText, deviceTag, downloadJson, stamp } from './report-io';

declare const __BENCH_BUILD__: string;
const BUILD: string = typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev';
const KEY = 'reclaimed-pagebench';
const ORDER = ['ring', 'table', 'storage', 'storage', 'table', 'ring'] as const;
/** the systems timed (their names on core.sim.systems) */
const SYSTEMS = ['liquid-water', 'sediment', 'water'];
/** dispatches of a kernel in one timed pass, and samples of that */
const REPS = 8;
const SAMPLES = 7;
/** the run page's waits: the load to settle, then the storm to wake the land */
const SETTLE_MS = 25000;
const STORM_MS = 12000;

interface RunResult {
  way: string;
  round: number;
  /** the kernels that read the table from storage on this page (?pages=storage) */
  storageKernels: string[];
  awakeChunks: number | null;
  emptySubmitMs: number;
  kernels: Record<string, { gpuMs: number | null; wallMs: number | null; groups: number; indirect: boolean }>;
  systems: Record<string, { gpuMs: number | null; wallMs: number | null; dispatches: number }>;
  error?: string;
}

interface State {
  started: string;
  build: string;
  i: number;
  /** the page index running (a page that loads again with this set crashed) */
  running: number;
  runs: RunResult[];
}

export function pageBenchMode(params: URLSearchParams): 'start' | 'run' | 'done' | null {
  const v = params.get('pagebench');
  if (v === '1') return 'start';
  if (v === 'run' || v === 'done') return v;
  return null;
}

function load(): State | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as State) : null;
  } catch {
    return null;
  }
}

function save(s: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    console.error('pagebench: could not save', e);
  }
}

function runUrl(i: number): string {
  const q = new URLSearchParams({
    pagebench: 'run',
    pages: ORDER[i],
    skipmenu: '1',
    level: 'atlas',
    win: '256',
    q: 'low',
    tutorial: '0',
    at: '15024,14337',
    world: 'pagebench',
    worldsave: '0',
  });
  return `${location.pathname}?${q.toString()}`;
}

function goNext(s: State): void {
  s.i++;
  s.running = -1;
  save(s);
  location.href = s.i < ORDER.length ? runUrl(s.i) : `${location.pathname}?pagebench=done`;
}

function panel(ui: HTMLElement): { el: HTMLDivElement; text(t: string): HTMLPreElement; button(t: string, f: () => void): HTMLButtonElement } {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;overflow:auto;padding:16px;background:#101418;color:#e8e8e8;font:13px/1.45 system-ui,sans-serif;z-index:1000';
  ui.appendChild(el);
  return {
    el,
    text(t) {
      const p = document.createElement('pre');
      p.style.cssText = 'white-space:pre-wrap;font:12px/1.4 ui-monospace,monospace;margin:8px 0';
      p.textContent = t;
      el.appendChild(p);
      return p;
    },
    button(t, f) {
      const b = document.createElement('button');
      b.textContent = t;
      b.style.cssText = 'display:block;margin:10px 0;padding:14px 18px;font-size:16px;border-radius:8px;border:0;background:#3a7bd5;color:#fff;width:100%';
      b.onclick = f;
      el.appendChild(b);
      return b;
    },
  };
}

/** The start and end pages (no level). */
export async function pageBenchStandalone(mode: 'start' | 'done', ui: HTMLElement, device: GPUDevice | null): Promise<void> {
  const p = panel(ui);
  if (mode === 'start') {
    p.text(
      `Page-table lookup bench (M1, docs/PAGES.md)\n\nSix pages of the atlas at window 256 (about 1 minute each): the ring computed, the table in the Globals, the table in storage, then the same again backwards. Keep the screen on and the phone still; the last page has the results and a Download button.\n\nbuild ${BUILD}`,
    );
    const prev = load();
    if (prev && prev.runs.length) p.button('Show the last results', () => (location.href = `${location.pathname}?pagebench=done`));
    p.button('Start', () => {
      const s: State = { started: new Date().toISOString(), build: BUILD, i: -1, running: -1, runs: [] };
      goNext(s);
    });
    return;
  }
  const s = load();
  if (!s) {
    p.text('No results kept on this device: start it with ?pagebench=1');
    return;
  }
  const report = makeReport(s, device);
  const body = JSON.stringify(report, null, 1);
  p.text(summary(report));
  const say = p.text('');
  const name = async () => `pagebench-${await deviceTag(device?.adapterInfo?.vendor ?? '')}-${stamp()}.json`;
  p.button('Download report', () => void name().then((n) => (say.textContent = downloadJson(body, n))));
  p.button('Copy', () => void copyText(body).then((m) => (say.textContent = m)));
  p.button('Run it again', () => (location.href = `${location.pathname}?pagebench=1`));
}

/** a run page: called once the level is up (main.ts) */
export async function pageBenchRun(): Promise<void> {
  const s = load();
  if (!s || s.i < 0 || s.i >= ORDER.length) return;
  const way = ORDER[s.i];
  const round = ORDER.slice(0, s.i).filter((w) => w === way).length;
  if (s.running === s.i) {
    // (this page loaded again without finishing: crashed or killed — noted, on to the next)
    s.runs.push({ way, round, storageKernels: [], awakeChunks: null, emptySubmitMs: 0, kernels: {}, systems: {}, error: 'the page loaded again without finishing' });
    goNext(s);
    return;
  }
  s.running = s.i;
  save(s);
  const note = document.createElement('div');
  note.style.cssText = 'position:fixed;left:8px;top:8px;z-index:1000;background:#000a;color:#fff;padding:6px 10px;font:13px system-ui;border-radius:6px';
  document.body.appendChild(note);
  const say = (t: string) => (note.textContent = `page bench ${s.i + 1}/${ORDER.length} (${way}): ${t}`);
  let r: RunResult;
  try {
    say('loading');
    await waitFor(() => (window as unknown as { reclaimed?: { core?: unknown } }).reclaimed?.core, 240000);
    say('settling');
    await sleep(SETTLE_MS);
    const R = (window as unknown as { reclaimed: any }).reclaimed;
    const c = R.camera.target;
    const w = R.weather ?? R.core?.weather;
    w?.spawn?.(c[0], c[1]);
    say('a storm waking the land');
    await sleep(STORM_MS);
    say('timing');
    r = await measure(R, way, round);
  } catch (e) {
    r = { way, round, storageKernels: [], awakeChunks: null, emptySubmitMs: 0, kernels: {}, systems: {}, error: e instanceof Error ? e.message : String(e) };
  }
  s.runs.push(r);
  say('done');
  goNext(s);
}

interface Rec {
  label: string;
  pipeline: GPUComputePipeline;
  groups: (GPUBindGroup | null)[];
  x?: [number, number, number];
  ind?: [GPUBuffer, number];
}

/** a system encoded through a recorder: every dispatch it makes (copies and clears dropped) */
function record(sys: { encode(e: GPUCommandEncoder, t: number): void }, tick: number, dev: GPUDevice): Rec[] {
  const out: Rec[] = [];
  const real = dev.createCommandEncoder({ label: 'pagebench record' });
  const pass = (label: string) => {
    let pipeline: GPUComputePipeline | null = null;
    const groups: (GPUBindGroup | null)[] = [];
    return {
      label,
      setPipeline: (p: GPUComputePipeline) => (pipeline = p),
      setBindGroup: (i: number, g: GPUBindGroup | null) => (groups[i] = g),
      dispatchWorkgroups: (x: number, y = 1, z = 1) => out.push({ label, pipeline: pipeline!, groups: groups.slice(), x: [x, y, z] }),
      dispatchWorkgroupsIndirect: (b: GPUBuffer, o: number) => out.push({ label, pipeline: pipeline!, groups: groups.slice(), ind: [b, o] }),
      end: () => {},
      pushDebugGroup: () => {},
      popDebugGroup: () => {},
      insertDebugMarker: () => {},
    };
  };
  const enc = new Proxy(real, {
    get(t, key) {
      if (key === 'beginComputePass') return (d?: GPUComputePassDescriptor) => pass(d?.label ?? '?');
      const v = (t as unknown as Record<string | symbol, unknown>)[key];
      // (copies, clears, render passes: not replayed)
      if (typeof v === 'function') return () => {};
      return v;
    },
  }) as GPUCommandEncoder;
  sys.encode(enc, tick);
  return out;
}

async function measure(R: any, way: string, round: number): Promise<RunResult> {
  const core = R.core;
  const dev: GPUDevice = core.host.gpu.device;
  if (!dev.features.has('timestamp-query')) throw new Error('no timestamp-query on this device');
  const prof = core.host.profiler as { active: boolean };
  const timer = new GpuTimer(dev);
  const { pageTab } = await import('../gpu/pages-mode');
  const empty: number[] = [];
  for (let k = 0; k < 7; k++) {
    await dev.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    dev.queue.submit([dev.createCommandEncoder().finish()]);
    await dev.queue.onSubmittedWorkDone();
    empty.push(performance.now() - t0);
  }
  const emptyMs = stat(empty, 'ms')?.p50 ?? 0;
  const kernels: RunResult['kernels'] = {};
  const systems: RunResult['systems'] = {};
  const replay = (p: GPUComputePassEncoder, d: Rec) => {
    p.setPipeline(d.pipeline);
    d.groups.forEach((g, i) => g && p.setBindGroup(i, g));
    if (d.x) p.dispatchWorkgroups(d.x[0], d.x[1], d.x[2]);
    else p.dispatchWorkgroupsIndirect(d.ind![0], d.ind![1]);
  };
  const time = async (name: string, body: (p: GPUComputePassEncoder) => void): Promise<{ gpu: number | null; wall: number | null }> => {
    const gpu: number[] = [];
    const wall: number[] = [];
    for (let k = 0; k < SAMPLES; k++) {
      await new Promise((r) => requestAnimationFrame(r));
      const enc = dev.createCommandEncoder({ label: `pagebench ${name}` });
      const p = enc.beginComputePass({ label: name, timestampWrites: timer.timestamps(name) });
      body(p);
      p.end();
      await dev.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      dev.queue.submit([enc.finish()]);
      await dev.queue.onSubmittedWorkDone();
      wall.push(performance.now() - t0 - emptyMs);
      const g = (await timer.read()).get(name) ?? [];
      if (g.length) gpu.push(g[0]);
    }
    return { gpu: stat(gpu, 'ms')?.p50 ?? null, wall: stat(wall, 'ms')?.p50 ?? null };
  };
  const was = prof.active;
  prof.active = false;
  try {
    for (const name of SYSTEMS) {
      const sys = core.sim.systems.find((x: { name: string }) => x.name === name);
      if (!sys) continue;
      const recs = record(sys, core.sim.tick, dev);
      // (the whole system in one pass, as bench v4)
      const all = await time(name, (p) => recs.forEach((d) => replay(p, d)));
      systems[name] = { gpuMs: r4(all.gpu), wallMs: r4(all.wall), dispatches: recs.length };
      // (each kernel on its own: the first dispatch of each label, REPS of it in one pass)
      const seen = new Set<string>();
      for (const d of recs) {
        if (seen.has(d.label)) continue;
        seen.add(d.label);
        const t = await time(d.label, (p) => {
          for (let k = 0; k < REPS; k++) replay(p, d);
        });
        kernels[d.label] = { gpuMs: r4(t.gpu === null ? null : t.gpu / REPS), wallMs: r4(t.wall === null ? null : t.wall / REPS), groups: d.x ? d.x[0] * d.x[1] * d.x[2] : -1, indirect: !d.x };
      }
    }
  } finally {
    prof.active = was;
  }
  return { way, round, storageKernels: [...pageTab.storageKernels], awakeChunks: R.scene?.sleep?.awake ?? null, emptySubmitMs: r4(emptyMs)!, kernels, systems };
}

const r4 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(f: () => T | null | undefined | false, ms: number): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error('timed out waiting for the level');
    await sleep(250);
  }
}

function makeReport(s: State, device: GPUDevice | null): Record<string, unknown> {
  // per kernel and way: the mean of the rounds' medians, and against the ring's
  const ways = ['ring', 'table', 'storage'];
  const labels = [...new Set(s.runs.flatMap((r) => Object.keys(r.kernels)))];
  const mean = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const table: Record<string, Record<string, unknown>> = {};
  for (const l of labels) {
    const row: Record<string, unknown> = {};
    for (const w of ways) row[w] = r4(mean(s.runs.filter((r) => r.way === w).map((r) => r.kernels[l]?.gpuMs)));
    const ring = row.ring as number | null;
    for (const w of ['table', 'storage']) row[`${w}VsRing`] = ring && row[w] !== null ? `${(((row[w] as number) / ring - 1) * 100).toFixed(1)}%` : null;
    row.storageTable = s.runs.some((r) => r.way === 'storage' && r.storageKernels.includes(l));
    table[l] = row;
  }
  const sys: Record<string, Record<string, unknown>> = {};
  for (const n of SYSTEMS) {
    const row: Record<string, unknown> = {};
    for (const w of ways) row[w] = r4(mean(s.runs.filter((r) => r.way === w).map((r) => r.systems[n]?.gpuMs)));
    const ring = row.ring as number | null;
    for (const w of ['table', 'storage']) row[`${w}VsRing`] = ring && row[w] !== null ? `${(((row[w] as number) / ring - 1) * 100).toFixed(1)}%` : null;
    sys[n] = row;
  }
  return {
    what: 'M1 (docs/PAGES.md): the page-table lookup — ring computed vs table in the Globals (uniform) vs table in storage, window 256, per dispatch (GPU ms, its pass timed alone, REPS dispatches a pass)',
    build: s.build,
    started: s.started,
    device: device ? { vendor: device.adapterInfo?.vendor, architecture: device.adapterInfo?.architecture, description: device.adapterInfo?.description } : null,
    userAgent: navigator.userAgent,
    target: 'table no more than 5% over the ring a pass',
    kernels: table,
    systems: sys,
    runs: s.runs,
  };
}

function summary(r: Record<string, any>): string {
  const lines = [`Page-table lookup (M1) — ${r.device?.vendor ?? ''} ${r.device?.architecture ?? ''}`, `GPU ms a dispatch (mean of 2 rounds); * = storage table on that kernel`, ''];
  const f = (v: unknown) => (typeof v === 'number' ? v.toFixed(4) : '  -   ');
  lines.push('kernel                     ring    table   storage  table%  storage%');
  for (const [l, row] of Object.entries(r.kernels as Record<string, any>))
    lines.push(`${(l + (row.storageTable ? '*' : '')).padEnd(24)} ${f(row.ring)} ${f(row.table)} ${f(row.storage)}  ${row.tableVsRing ?? '-'}  ${row.storageVsRing ?? '-'}`);
  lines.push('', 'systems (all their dispatches in one pass)');
  for (const [n, row] of Object.entries(r.systems as Record<string, any>)) lines.push(`${n.padEnd(24)} ${f(row.ring)} ${f(row.table)} ${f(row.storage)}  ${row.tableVsRing ?? '-'}  ${row.storageVsRing ?? '-'}`);
  const errs = (r.runs as RunResult[]).filter((x) => x.error);
  if (errs.length) lines.push('', ...errs.map((e) => `page ${e.way} ${e.round}: ${e.error}`));
  return lines.join('\n');
}
