// The idle phone bench (phone-idle, 2026-11-15; the user on the Pixel 9a: the atlas town "very very slow. Unplayable
// really"). One link on the real phone, the screen kept awake, under three minutes:
//   /?skipmenu=1&level=atlas&town=1&fresh=1&idlebench=1          (&benchsettle=12 &benchwin=1 &benchonly=living,ind64)
// In the atlas town with the camera still, once the town is made and the world has settled:
//   1. the idle frame: its interval, its GPU-done time (the frame's last submit to queue.onSubmittedWorkDone) and its
//      census (gpu/census.ts: passes, direct and indirect dispatches, draws, reads … per frame and system, with the
//      cost model's estimate);
//   2. each major system off and on in alternating windows (memory "toggle, don't timestamp": a tiler's per-pass
//      timestamps overlap — the frame with the thing, less the frame without it);
//   3. probes: calls added to the frame, to price the patterns the cuts would use (docs/FRAMECOST.md "The decision"):
//      64 indirect dispatches of 0 workgroups, 64 direct dispatches, 16 direct dispatches of 1024 workgroups whose
//      threads return at once (a GPU-gated kernel dispatched direct), one 64-byte read a frame, 128 indirect draws of
//      0 instances.
// The timestamps are not turned on (their readback is itself a per-frame read). A result table on the page and a JSON
// to download, copy or share (and, on the dev server, kept in perf-reports/). Headless: scripts/idlebench.mjs.
// API: idleBench.
import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, wakeLog } from './bench';
import { postDev } from './report-io';
import { estimateMs, PHONE_MODEL, type CensusReport } from '../gpu/census';
import { SKIP, type FrameCompute } from '../render/renderer';

const NL = String.fromCharCode(10);
declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.idlebench.last';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

interface Side {
  frames: number;
  /** the frame's interval: mean, median, 95th (ms) */
  frameMs: number;
  p50: number;
  p95: number;
  /** the frame's last submit to the GPU's work done: mean (ms) */
  doneMs: number | null;
}
export interface IdleRow {
  name: string;
  kind: 'system' | 'probe';
  what: string;
  /** with it, less without it: the frame's interval and its GPU-done time (ms). A probe's: the cost of what it adds */
  frameMs: number | null;
  doneMs: number | null;
  /** a probe's cost a call (doneMs over its calls a frame, ms) */
  perCallMs?: number | null;
  on: Side;
  off: Side;
}

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const r2 = (v: number) => (Number.isFinite(v) ? +v.toFixed(2) : NaN);
function side(dt: number[], done: number[]): Side {
  const s = [...dt].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? r2(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : NaN);
  return { frames: dt.length, frameMs: r2(mean(dt)), p50: q(0.5), p95: q(0.95), doneMs: done.length ? r2(mean(done)) : null };
}
const diff = (a: number | null, b: number | null) => (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) ? r2(a - b) : null);

/** every frame's interval and GPU-done time into the open bucket (the scene's frame wrapped: what main.ts calls) */
class Sampler {
  private dt: number[] = [];
  private done: number[] = [];
  private last = 0;
  private open = false;
  constructor(R: Rec) {
    const scene = R.scene;
    const device: GPUDevice = R.core.host.gpu.device;
    const frame = scene.frame.bind(scene);
    scene.frame = (now: number, d: number) => {
      frame(now, d);
      if (!this.open) {
        this.last = 0;
        return;
      }
      if (this.last) this.dt.push(now - this.last);
      this.last = now;
      const t0 = performance.now();
      const bucket = this.done;
      void device.queue.onSubmittedWorkDone().then(() => bucket.push(performance.now() - t0));
    };
  }
  start(): void {
    this.dt = [];
    this.done = [];
    this.last = 0;
    this.open = true;
  }
  stop(): { dt: number[]; done: number[] } {
    this.open = false;
    return { dt: this.dt, done: this.done };
  }
}

interface Toggle {
  name: string;
  kind: 'system' | 'probe';
  what: string;
  /** a probe's calls a frame */
  calls?: number;
  set: (off: boolean) => void;
}

/** the systems, each turned off by what the page already has: the sim's paused set, the renderer's ?skip= set */
function systems(R: Rec): Toggle[] {
  const sim = R.core.sim;
  const names = new Set<string>(sim.systems.map((s: { name: string }) => s.name));
  const pause = (list: string[]) => (off: boolean) => {
    for (const n of list) if (names.has(n)) off ? sim.paused.add(n) : sim.paused.delete(n);
  };
  const skip = (list: string[]) => (off: boolean) => {
    for (const n of list) off ? SKIP.add(n) : SKIP.delete(n);
  };
  const both = (...f: ((off: boolean) => void)[]) => (off: boolean) => f.forEach((g) => g(off));
  const coarse = R.scene.opts?.atlas?.atlas?.coarse;
  const stepPart = coarse?.stepPart;
  const ig = R.scene.integrity;
  const ui = document.getElementById('ui');
  return [
    { name: 'sim (all)', kind: 'system', what: 'every sim tick held (LevelScene.noSim)', set: (off) => (R.scene.noSim = off) },
    { name: 'living town', kind: 'system', what: "the living town's frame compute: graph, riders, works, figures", set: skip(['living']) },
    { name: 'town contracts', kind: 'system', what: "the side map's and the place table's watch and solves", set: skip(['towncontracts']) },
    { name: 'town draw', kind: 'system', what: "the towns' meshes and the people's figures (skins, voxels)", set: skip(['skins', 'voxels']) },
    { name: 'fluids', kind: 'system', what: 'liquid-water, liquid-lava, lava, oil', set: pause(['liquid-water', 'liquid-lava', 'lava', 'oil']) },
    { name: 'weather', kind: 'system', what: 'windfield, climate, cover', set: pause(['windfield', 'climate', 'cover']) },
    { name: 'sediment', kind: 'system', what: 'sediment', set: pause(['sediment']) },
    { name: 'nature fields', kind: 'system', what: 'contamination, moisture, fire, wilt, ecology', set: pause(['contamination', 'moisture', 'fire', 'wilt', 'ecology']) },
    { name: 'flora', kind: 'system', what: 'sway, and the plants and trees drawn', set: both(pause(['sway']), skip(['plants', 'trees'])) },
    { name: 'particles', kind: 'system', what: 'particles stepped and drawn, rain', set: both(pause(['particles']), skip(['particles', 'rain'])) },
    {
      name: 'old physics',
      kind: 'system',
      what: 'structure, structtick, project, physics, solver, the body meshes; the judge and its reads',
      set: both(pause(['structure', 'structtick', 'project', 'physics', 'solver']), skip(['bodymesh']), (off) => {
        if (ig) ig.paused.physics = ig.paused.judge = off;
      }),
    },
    { name: 'agents', kind: 'system', what: 'agents, traits (the units’ fields, steps and sync)', set: pause(['agents', 'traits']) },
    { name: 'terrain mesh', kind: 'system', what: "the field mesh's change check and rebuilds (meshprep)", set: skip(['meshprep']) },
    { name: 'render prep', kind: 'system', what: 'the instance lists (prep), the shore', set: skip(['prep', 'shore']) },
    { name: 'tiles', kind: 'system', what: 'the far tiles baked and drawn, the far land', set: skip(['tiles', 'far']) },
    { name: 'shadows', kind: 'system', what: 'the shadow passes', set: skip(['shadow']) },
    {
      name: 'coarse world',
      kind: 'system',
      what: "the atlas's coarse step (three frames of four)",
      set: (off) => {
        if (coarse) coarse.stepPart = off ? () => {} : stepPart;
      },
    },
    {
      name: 'UI',
      kind: 'system',
      what: 'the page’s UI layer hidden (#ui: the card sheet, the HUD)',
      set: (off) => {
        if (ui) ui.style.visibility = off ? 'hidden' : '';
      },
    },
    { name: 'render (all)', kind: 'system', what: 'nothing prepared or drawn (?skip=render)', set: skip(['render']) },
  ];
}

const PROBE_WGSL = `
@group(0) @binding(0) var<uniform> U: vec4<u32>;
@group(0) @binding(1) var<storage, read_write> OUT: array<u32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  // (a GPU-gated kernel dispatched direct: every thread reads the gate and returns)
  if (U.x == 0u) { return; }
  OUT[g.x % 64u] = g.x;
}
`;

/** the probes: calls added to the frame as it is (a frame compute hook, an extra draw) */
function probes(R: Rec): Toggle[] {
  const device: GPUDevice = R.core.host.gpu.device;
  const rd = R.core.renderer;
  const mod = device.createShaderModule({ label: 'idlebench probe', code: PROBE_WGSL });
  const pipe = device.createComputePipeline({ label: 'idlebench probe', layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  const U = device.createBuffer({ label: 'idlebench probe gate', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const out = device.createBuffer({ label: 'idlebench probe out', size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const group = device.createBindGroup({ label: 'idlebench probe', layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: U } }, { binding: 1, resource: { buffer: out } }] });
  // (indirect args of 0 workgroups, and a draw's of 0 instances)
  const zero = device.createBuffer({ label: 'idlebench probe args', size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(zero, 0, new Uint32Array([0, 1, 1, 0]));
  const drawArgs = device.createBuffer({ label: 'idlebench probe draw args', size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(drawArgs, 0, new Uint32Array([36, 0, 0, 0]));
  const staging = device.createBuffer({ label: 'idlebench probe read', size: 64, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  let reading = false;
  let wantRead = false;
  const compute = (name: string, body: (p: GPUComputePassEncoder) => void): ((off: boolean) => void) => {
    const hook: FrameCompute = (enc) => {
      const p = enc.beginComputePass({ label: `idlebench ${name}` });
      p.setPipeline(pipe);
      p.setBindGroup(0, group);
      body(p);
      p.end();
    };
    hook.skipKey = 'idlebench-probe';
    return (off) => {
      const i = rd.frameCompute.indexOf(hook);
      if (off && i >= 0) rd.frameCompute.splice(i, 1);
      if (!off && i < 0) rd.frameCompute.push(hook);
    };
  };
  // (the read: the copy encoded in the frame, the map started once the frame is submitted — a microtask after the hook)
  const readHook: FrameCompute = (enc) => {
    if (reading) return;
    enc.copyBufferToBuffer(out, 0, staging, 0, 64);
    wantRead = true;
    queueMicrotask(() => {
      if (!wantRead) return;
      wantRead = false;
      reading = true;
      // (after the frame's submit: the level's frame runs to its end before any microtask)
      void staging.mapAsync(GPUMapMode.READ).then(
        () => {
          staging.unmap();
          reading = false;
        },
        () => (reading = false),
      );
    });
  };
  readHook.skipKey = 'idlebench-probe';
  const drawHook = (pass: GPURenderPassEncoder) => {
    pass.setPipeline(rd.bodyPipe);
    pass.setBindGroup(0, rd.bodyGroup);
    for (let k = 0; k < 128; k++) pass.drawIndirect(drawArgs, 0);
  };
  return [
    { name: 'probe: 64 indirect × 0', kind: 'probe', calls: 64, what: '64 indirect dispatches of 0 workgroups in one pass (the model: ~0.1 ms each)', set: compute('ind64', (p) => { for (let k = 0; k < 64; k++) p.dispatchWorkgroupsIndirect(zero, 0); }) },
    { name: 'probe: 64 direct × 1', kind: 'probe', calls: 64, what: '64 direct dispatches of 1 workgroup in one pass (the model: ~0.008 ms each)', set: compute('dir64', (p) => { for (let k = 0; k < 64; k++) p.dispatchWorkgroups(1); }) },
    { name: 'probe: 16 direct × 1024 gated', kind: 'probe', calls: 16, what: '16 direct dispatches of 1024 workgroups (65,536 threads each) that read a gate word and return: a GPU-gated kernel dispatched direct instead of indirect', set: compute('early16', (p) => { for (let k = 0; k < 16; k++) p.dispatchWorkgroups(1024); }) },
    {
      name: 'probe: 64-byte read a frame',
      kind: 'probe',
      calls: 1,
      what: 'one copy and mapAsync of 64 bytes a frame (skipped while one is in flight): what a small "settled" signal read would cost',
      set: (off) => {
        const i = rd.frameCompute.indexOf(readHook);
        if (off && i >= 0) rd.frameCompute.splice(i, 1);
        if (!off && i < 0) rd.frameCompute.push(readHook);
      },
    },
    {
      name: 'probe: 128 indirect draws × 0',
      kind: 'probe',
      calls: 128,
      what: '128 indirect draws of 0 instances in the world pass (the idle frame has ~190 indirect draws: not in the cost model)',
      set: (off) => {
        const i = rd.extraDraws.indexOf(drawHook);
        if (off && i >= 0) rd.extraDraws.splice(i, 1);
        if (!off && i < 0) rd.extraDraws.push(drawHook);
      },
    },
  ];
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(2));

/** the report's lines for the page: the idle frame, the census's top systems, each toggle's difference */
export function idleLines(rep: { idle: Side; census: CensusReport | null; rows: IdleRow[] }): string[] {
  const out: string[] = [];
  out.push(`idle frame: ${num(rep.idle.frameMs)} ms (p50 ${num(rep.idle.p50)}, p95 ${num(rep.idle.p95)}), GPU done ${num(rep.idle.doneMs)} ms after the frame's submit, ${rep.idle.frames} frames`);
  const c = rep.census;
  if (c) {
    const t = c.total;
    out.push(`census a frame: ${t.indirect.toFixed(1)} indirect and ${t.direct.toFixed(1)} direct dispatches, ${t.computePasses.toFixed(1)} compute and ${t.renderPasses.toFixed(1)} render passes, ${t.draws.toFixed(0)} draws and ${t.drawsIndirect.toFixed(0)} indirect draws, ${t.reads.toFixed(2)} reads (${(t.readBytes / 1024).toFixed(1)} KB), ${c.ticksPerFrame.toFixed(2)} ticks; the model: ${t.phoneMs.toFixed(1)} ms`);
    out.push(`${pad('system (census)', 18)}${lpad('ind', 6)}${lpad('dir', 6)}${lpad('pass', 6)}${lpad('reads', 6)}${lpad('model', 7)}`);
    const n1 = (v: number) => (v === 0 ? '.' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
    for (const s of c.systems.slice(0, 12)) out.push(`${pad(s.system.slice(0, 17), 18)}${lpad(n1(s.indirect), 6)}${lpad(n1(s.direct), 6)}${lpad(n1(s.computePasses + s.renderPasses), 6)}${lpad(n1(s.reads), 6)}${lpad(num(s.phoneMs), 7)}`);
  }
  out.push('');
  out.push(`${pad('on less off (ms)', 30)}${lpad('GPU done', 9)}${lpad('frame', 8)}${lpad('a call', 8)}`);
  for (const r of rep.rows) out.push(`${pad(r.name.slice(0, 29), 30)}${lpad(num(r.doneMs), 9)}${lpad(num(r.frameMs), 8)}${lpad(r.kind === 'probe' ? (r.perCallMs === null || r.perCallMs === undefined ? '–' : r.perCallMs.toFixed(3)) : '', 8)}`);
  return out;
}

export async function idleBench(params: URLSearchParams): Promise<void> {
  const R: Rec = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const held = await keepAwake();
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'idlebench', 'Reclaimed idle bench');
  const startedAt = new Date().toISOString();
  const settleS = Number(params.get('benchsettle') ?? 12);
  const winS = Number(params.get('benchwin') ?? 1);
  const only = (params.get('benchonly') ?? '').split(',').filter(Boolean);
  const notes: string[] = [];
  panel.say('idle bench: waiting for the town…');
  // (the start town made and its season's hand dealt: the level as the player first sees it)
  const t0 = performance.now();
  const season = () => (globalThis as { season?: { town: string | null } }).season;
  while (!season()?.town && performance.now() - t0 < 120000) await sleep(250);
  if (!season()?.town) notes.push('no start town after 120 s: measured as it was');
  const townS = (performance.now() - t0) / 1000;
  const census = (window as unknown as { __census?: { take(reset?: boolean): CensusReport } }).__census ?? null;
  for (let s = settleS; s > 0; s--) {
    panel.say(`idle bench: letting the world settle (${s} s)… keep the screen on, don't touch it`);
    await sleep(1000);
  }
  // (a fatal overlay — the first frames held the GPU past the watchdog — is reported, and the frames measured if they run)
  const fatal = document.querySelector('.fatal')?.textContent ?? null;
  if (fatal) notes.push(`fatal overlay up: ${fatal.slice(0, 300)}`);
  const device = await deviceFacts(R.core.host);
  const S = new Sampler(R);
  // 1. the idle frame and its census
  panel.say('idle bench: the idle frame (6 s)…');
  census?.take();
  S.start();
  await sleep(6000);
  const b = S.stop();
  const idle = side(b.dt, b.done);
  const idleCensus = census?.take() ?? null;
  if (!census) notes.push('no census (the page must be opened with idlebench=1 from the start)');
  // 2, 3. each system, each probe: off and on in alternating windows
  const all = [...systems(R), ...probes(R)].filter((t) => !only.length || only.some((o) => t.name.includes(o)));
  const rows: IdleRow[] = [];
  // (a probe is off but while it is measured; a system on)
  for (const t of all) if (t.kind === 'probe') t.set(true);
  const WINDOWS = 2;
  for (let k = 0; k < all.length; k++) {
    const t = all[k];
    panel.say(`idle bench ${k + 1}/${all.length}: ${t.name} off and on…`);
    const on = { dt: [] as number[], done: [] as number[] };
    const off = { dt: [] as number[], done: [] as number[] };
    for (let w = 0; w < WINDOWS; w++)
      for (const s of ['on', 'off'] as const) {
        t.set(s === 'off');
        await sleep(200);
        S.start();
        await sleep(winS * 1000);
        const got = S.stop();
        (s === 'on' ? on : off).dt.push(...got.dt);
        (s === 'on' ? on : off).done.push(...got.done);
      }
    t.set(t.kind === 'probe');
    const a = side(on.dt, on.done);
    const o = side(off.dt, off.done);
    const doneMs = diff(a.doneMs, o.doneMs);
    rows.push({ name: t.name, kind: t.kind, what: t.what, frameMs: diff(a.frameMs, o.frameMs), doneMs, perCallMs: t.calls && doneMs !== null ? +(doneMs / t.calls).toFixed(4) : t.calls ? null : undefined, on: a, off: o });
    await sleep(150);
  }
  await letSleep();
  const report = {
    kind: 'reclaimed-idlebench',
    version: 1,
    build: BUILD,
    startedAt,
    finishedAt: new Date().toISOString(),
    url: location.href,
    device,
    wakeLock: held,
    wakeLog: [...wakeLog],
    notes,
    townReadyS: +townS.toFixed(1),
    settleS,
    windowS: winS,
    windows: WINDOWS,
    quality: R.core.host.qualityName,
    canvas: [R.core.host.canvas.width, R.core.host.canvas.height],
    model: PHONE_MODEL,
    idle,
    /** the idle frame's counts by the cost model (ms a frame) */
    modelMs: idleCensus ? +estimateMs(idleCensus.total).toFixed(2) : null,
    census: idleCensus,
    rows,
    how: 'on less off: each system or probe in two windows each way; GPU done is the frame’s last submit to queue.onSubmittedWorkDone (frames in flight add to it); the frame’s interval only moves once a frame misses the display’s rate. No timestamps (their readback is a per-frame read).',
  };
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { idleBenchReport: string }).idleBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say(`Idle bench done — ${rows.length} toggles, ${((performance.now() - t0) / 1000).toFixed(0)} s.${notes.length ? ` Notes: ${notes.join('; ')}` : ''}`);
  panel.text(idleLines(report).join(NL), true);
  reportButtons(panel, body, false, 'idlebench', 'Reclaimed idle bench', true);
  const dev = await postDev(body, 'idlebench');
  if (dev) panel.text(`dev server: ${dev}`, true);
  panel.button('Run again', false, () => location.reload());
}
