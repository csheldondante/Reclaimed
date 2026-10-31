// Round 112 (testspeed): the contract tier — a system (or a few) on a tiny world, its contract inputs set and its
// outputs read back, in seconds and without the atlas. Systems talk only through the WorldGpu buffers
// (sim/world-gpu.ts) and src/api/contracts, so most behaviour can be checked here; the full-atlas checks stay as the
// integration tier (every system in play, as the phone runs it), fewer and run in parallel.
//
//   contract.html?run=breach            runs one test; its result is on window.__contract (scripts/contract.mjs)
//   window.contract.run('breach', { systems: 'all' })   from a script, any number on one page and one device
//
// A test makes its world with the real WorldCore (the same buffers, kernels and Simulation as the level), runs the
// fixed-step sim (Simulation.step, as WorldCore.warmup does), and reads the contract buffers back. Which systems
// step is the test's choice: `systems` (default the test's own) or 'all' (every system the level steps).

import '../ui/style.css';
import { initGpu, showFatal, UnsupportedError } from '../gpu/device';
import { Profiler } from '../gpu/profiler';
import { WorldCore, type Host, type Quality } from '../scenes/world-core';
import type { SimSystem } from '../sim/system';
import { useRivers } from '../sim/world-gpu';
import { EventKind } from '../sim/globals';
import { OP } from '../sim/edit-ops';
import { CHUNK } from '../world/layout';
import { ROW_H } from '../world/lattice';
import type { MapData } from '../world/mapgen';
import { generatePlayground, STATIONS, type StationKit } from '../levels/playground';
import { cropMap } from './crop';
import { MAT } from '../world/materials';
import { beginPipelineBatch, endPipelineBatch, makeCompute } from '../gpu/pipeline';
import commonWgsl from '../shaders/common.wgsl?raw';
import probeWgsl from './probe.wgsl?raw';

const QUALITY: Quality = { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2, particles: 4096, agentSweeps: 2, shadowSize: 1024, meshSlots: 1 };

export interface ContractResult {
  name: string;
  ok: boolean;
  checks: { label: string; ok: boolean; detail?: unknown }[];
  /** what was measured, for the log */
  data: Record<string, unknown>;
  ticks: number;
  ms: { make: number; run: number; total: number };
  systems: string[];
}
export interface ContractOpts {
  /** the systems stepped: names (sim/systems.ts `name`), or 'all' */
  systems?: string[] | 'all';
  /** ticks to run (the test's default otherwise) */
  ticks?: number;
}
interface Ctx {
  host: Host;
  opts: ContractOpts;
  check(label: string, ok: boolean, detail?: unknown): void;
  data: Record<string, unknown>;
  /** a world: `map`, its systems; stepped `n` ticks at a time with step(n) */
  world(map: MapData, systems: string[], rivers?: 'sim' | 'table'): Promise<World>;
}
interface World {
  core: WorldCore;
  step(n: number): Promise<void>;
  ticks: number;
  /** a per-column buffer in window order (y * w + x) */
  read(name: 'water' | 'surface' | 'layers' | 'waterSource'): Promise<Float32Array>;
  /** the sum of a buffer over columns [x0, x1) × [y0, y1) (storage cells of this world) */
  sum(buf: Float32Array, x0: number, y0: number, x1: number, y1: number): number;
  destroy(): void;
}
type Test = (c: Ctx) => Promise<void>;

/** the playground's station, alone: its chunks cut out of the playground's map (a world of a few chunks) */
function station(id: string): { map: MapData; rect: [number, number, number, number]; kit: (core: WorldCore, later: (s: number, f: () => void) => void) => StationKit } {
  const s = STATIONS.find((x) => x.id === id);
  if (!s) throw new Error(`no playground station "${id}"`);
  const full = generatePlayground({ w: 256, h: 256, zMax: 96 });
  const [x0, y0, x1, y1] = s.rect;
  const map = cropMap(full, x0, y0, x1 - x0, y1 - y0);
  // (the station's world coordinates are the playground's: shifted to this world's — whole chunks, even rows: the
  // lattice's offset rows line up)
  const ox = x0;
  const oy = y0 * ROW_H;
  const kit = (core: WorldCore, later: (s: number, f: () => void) => void): StationKit => ({
    // (as the level's kit, scenes/level.ts stationKit: the world's events, the spring buffer)
    smash: (x, y, z, r) => core.globals.events.push({ kind: EventKind.Edit, x: x - ox, y: y - oy, z: OP.SMASH * 32, radius: r, strength: z }),
    dig: (x, y, r, layers) => core.globals.events.push({ kind: EventKind.Edit, x: x - ox, y: y - oy, z: OP.DIG * 32 + 512, radius: r, strength: layers }),
    source: (cols, rate) => {
      const v = new Float32Array([rate / 60 / cols.length]);
      for (const [cx, cy] of cols) core.host.gpu.device.queue.writeBuffer(core.world.waterSource, core.ring.i(cx - x0, cy - y0) * 4, v);
    },
    dust: () => undefined,
    rain: () => undefined,
    later,
    pour: (x, y, r, layers, mat) => core.globals.events.push({ kind: EventKind.Edit, x: x - ox, y: y - oy, z: OP.POUR * 32 + mat + 512, radius: r, strength: layers }),
    drop: () => {
      throw new Error('contract tier: a station drop needs the level (the node solver comes with its rigid rock)');
    },
    wakeMetal: () => {
      throw new Error('contract tier: waking metal needs the level (the node solver comes with its rigid rock)');
    },
    dropModels: () => {
      throw new Error('contract tier: dropping models needs the level (the solvers come with its rigid rock)');
    },
  });
  return { map, rect: [0, 0, x1 - x0, y1 - y0], kit };
}

const TESTS: Record<string, Test> = {
  /**
   * (the runner's self-check) A kernel made the engine's way (common.wgsl prepended, gpu/pipeline.ts) reports the
   * constants it was compiled with: its own PROBE_OWN and common.wgsl's ROW_H. scripts/run.mjs selfcheck edits both
   * in a copy of the sources, rebuilds and runs again on the same Chrome profile: the new values must come back.
   */
  async stamp(c) {
    const dev = c.host.gpu.device;
    const k = makeCompute(dev, 'probe', [commonWgsl, probeWgsl], { 3: 'rw' });
    const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rd = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(k.pipeline);
    pass.setBindGroup(0, dev.createBindGroup({ layout: k.layout, entries: [{ binding: 3, resource: { buffer: buf } }] }));
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(buf, 0, rd, 0, 16);
    dev.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    const v = new Float32Array(rd.getMappedRange().slice(0));
    rd.unmap();
    buf.destroy();
    rd.destroy();
    c.data.own = v[0];
    c.data.rowH = +v[1].toFixed(7);
    c.check('the kernel ran', v[0] !== 0, { own: v[0], rowH: v[1] });
  },

  /**
   * The breach station's pool, held by its plug: it stays (the water's volume steady, nothing over the lip); dug
   * through as the station's button does (its spring on), it pours off the ledge into the basin.
   */
  async breach(c) {
    const st = station('breach');
    const w = await c.world(st.map, ['edit', 'surface', 'water', 'sediment', 'renderfields']);
    const { w: W, h: H } = w.core.dims;
    // the plateau (x < 40 here: the playground's 16..56) and the basin below the ledge (x ≥ 40)
    const vol = async () => {
      const wa = await w.read('water');
      return { pool: +w.sum(wa, 0, 0, 40, H).toFixed(1), basin: +w.sum(wa, 40, 0, W, H).toFixed(1) };
    };
    await w.step(120);
    const v0 = await vol();
    await w.step(c.opts.ticks ? Math.round(c.opts.ticks / 3) : 600);
    const v1 = await vol();
    c.data.held = { v0, v1 };
    c.check('held: the pool keeps its water (within 2 %)', Math.abs(v1.pool - v0.pool) <= 0.02 * v0.pool, { v0: v0.pool, v1: v1.pool });
    c.check('held: nothing over the lip', v1.basin - v0.basin < 1, { basin0: v0.basin, basin1: v1.basin });
    const later: [number, () => void][] = [];
    const s = STATIONS.find((x) => x.id === 'breach')!;
    s.actions.find((a) => a.label === 'breach')!.run(st.kit(w.core, (secs, f) => later.push([secs, f])));
    const n = c.opts.ticks ?? 1200;
    const trace: { t: number; pool: number; basin: number }[] = [];
    for (let k = 0; k < 4; k++) {
      await w.step(Math.round(n / 4));
      trace.push({ t: w.ticks, ...(await vol()) });
    }
    c.data.breached = trace;
    const end = trace[trace.length - 1];
    c.check('breached: water reaches the basin', end.basin - v1.basin > 50, { basin: end.basin });
    c.check('breached: the basin keeps filling', trace[3].basin > trace[1].basin, trace.map((x) => x.basin));
    w.destroy();
  },

  /**
   * The river station's river, held at its authored table (world/rivertable.ts → riverFlow; riverheld.wgsl), awake
   * all the while (no sleep here: the level's): water at every point down it, the lip a sheet, and steady.
   */
  async river(c) {
    const st = station('river');
    const w = await c.world(st.map, ['edit', 'surface', 'water', 'sediment', 'renderfields'], 'table');
    // (playwater.mjs's columns, the playground's storage cells less the station's corner 112, 96)
    const cols: Record<string, [number, number]> = { head: [6, 43], ramp: [48, 36], lip: [83, 41], foot: [88, 41], run: [118, 42], edge: [143, 33] };
    const W = w.core.dims.w;
    const depths = async () => {
      const f = await w.read('water');
      const o: Record<string, number> = {};
      for (const [k, [x, y]] of Object.entries(cols)) {
        let best = 0;
        for (let yy = y - 4; yy <= y + 4; yy++) best = Math.max(best, f[yy * W + x]);
        o[k] = +best.toFixed(3);
      }
      return o;
    };
    const n = c.opts.ticks ?? 1200;
    await w.step(n / 2);
    const a = await depths();
    await w.step(n / 2);
    const b = await depths();
    c.data.depths = { half: a, end: b };
    // (awake, the held river runs the pipes over its table: it drifts — the level's is asleep once settled, and
    // playwater.mjs checks it steady there; measured here, not judged: round 112 found ramp/foot/run moving 0.1-0.3)
    for (const k of Object.keys(cols)) c.check(`${k}: wet`, b[k] > 0.1, b[k]);
    c.data.drift = Object.fromEntries(Object.keys(cols).map((k) => [k, +(b[k] - a[k]).toFixed(3)]));
    w.destroy();
  },

  /** A pool on flat ground, no spring, nothing else: its volume is kept (the water's own conservation) and it lies still. */
  async pool(c) {
    const st = station('dust');
    const map = st.map;
    const { w: W, h: H } = map.grid.dims;
    let v0 = 0;
    // (on bare stone: nothing for it to soak into — the field's drift and ash take water in)
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        map.grid.cols[y * W + x] = [{ z0: 0, z1: 10, mat: MAT.Stone }];
        map.drift[y * W + x] = 0;
        map.surface[y * W + x] = 10;
        if (x >= 8 && x < 24 && y >= 8 && y < 24) {
          map.water[y * W + x] = 2;
          v0 += 2;
        }
      }
    // (a stone rim round it: the water stays on the stone)
    for (let y = 0; y < 32; y++) for (const x of [0, 31]) map.grid.cols[y * W + x] = [{ z0: 0, z1: 14, mat: MAT.Stone }];
    for (let x = 0; x < 32; x++) for (const y of [0, 31]) map.grid.cols[y * W + x] = [{ z0: 0, z1: 14, mat: MAT.Stone }];
    const w = await c.world(map, ['surface', 'water']);
    const a = await w.read('water');
    const start = w.sum(a, 0, 0, W, H);
    await w.step(c.opts.ticks ?? 900);
    const b = await w.read('water');
    const end = w.sum(b, 0, 0, W, H);
    c.data.volume = { put: v0, start: +start.toFixed(2), end: +end.toFixed(2) };
    c.check('the water put is the water there', Math.abs(start - v0) < 0.01 * v0, { v0, start });
    c.check('kept: within 1 % after the run', Math.abs(end - start) < 0.01 * start, { start, end });
    // (it spreads out over the flat: the deepest column well under the 2 it started at)
    let mx = 0;
    for (const v of b) mx = Math.max(mx, v);
    c.data.deepest = +mx.toFixed(3);
    c.check('it spread', mx < 1.9, { deepest: mx });
    w.destroy();
  },
};

async function makeHost(): Promise<Host> {
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const gpu = await initGpu(canvas);
  return { gpu, profiler: new Profiler(gpu.device, false), quality: { ...QUALITY }, qualityName: 'low', params: new URLSearchParams(location.search), canvas, ui };
}

let hostP: Promise<Host> | null = null;
let errors: string[] = [];

async function runTest(name: string, opts: ContractOpts = {}): Promise<ContractResult> {
  const test = TESTS[name];
  if (!test) throw new Error(`no contract test "${name}" (${Object.keys(TESTS).join(', ')})`);
  const host = await (hostP ??= makeHost());
  const t0 = performance.now();
  let tMade = t0;
  const res: ContractResult = { name, ok: true, checks: [], data: {}, ticks: 0, ms: { make: 0, run: 0, total: 0 }, systems: [] };
  errors = [];
  const worlds: World[] = [];
  const ctx: Ctx = {
    host,
    opts,
    data: res.data,
    check: (label, ok, detail) => {
      res.checks.push({ label, ok, detail });
      if (!ok) res.ok = false;
    },
    world: async (map, own, rivers = 'sim') => {
      useRivers(rivers);
      // (its pipelines compiled together, off the GPU's main thread, as the level's: gpu/pipeline.ts)
      beginPipelineBatch();
      const core = new WorldCore(host, map, host.quality.particles, CHUNK, false);
      await endPipelineBatch();
      const all = opts.systems === 'all';
      const names = new Set(all ? core.sim.systems.map((s) => s.name) : (opts.systems ?? own));
      for (const n of names) if (!core.sim.systems.some((s) => s.name === n)) throw new Error(`no system "${n}" (${core.sim.systems.map((s) => s.name).join(', ')})`);
      const filter = (s: SimSystem) => names.has(s.name);
      res.systems = [...names];
      core.tiers.apply();
      core.sim.prime(core.globals);
      core.globals.collapseEnabled = true;
      await host.gpu.device.queue.onSubmittedWorkDone();
      tMade = performance.now();
      const world: World = {
        core,
        ticks: 0,
        step: async (n) => {
          for (let i = 0; i < n; i++) core.sim.step(core.globals, filter);
          world.ticks += n;
          res.ticks += n;
          await host.gpu.device.queue.onSubmittedWorkDone();
        },
        read: (b) => core.readBuffer(b),
        sum: (buf, x0, y0, x1, y1) => {
          const W = core.dims.w;
          let s = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += buf[y * W + x];
          return s;
        },
        destroy: () => core.destroy(),
      };
      worlds.push(world);
      return world;
    },
  };
  // (a validation error is the test's failure: the device's errors are caught for its run)
  const onErr = (ev: Event) => errors.push(String((ev as GPUUncapturedErrorEvent).error.message));
  host.gpu.device.addEventListener('uncapturederror', onErr);
  try {
    await test(ctx);
  } catch (e) {
    res.ok = false;
    res.checks.push({ label: 'threw', ok: false, detail: String((e as Error)?.stack ?? e) });
  } finally {
    host.gpu.device.removeEventListener('uncapturederror', onErr);
  }
  if (errors.length) {
    res.ok = false;
    res.checks.push({ label: 'GPU errors', ok: false, detail: errors.slice(0, 5) });
  }
  const t1 = performance.now();
  res.ms = { make: +(tMade - t0).toFixed(0), run: +(t1 - tMade).toFixed(0), total: +(t1 - t0).toFixed(0) };
  return res;
}

declare global {
  interface Window {
    contract: { list: string[]; run: typeof runTest };
    __contract?: ContractResult[] | { error: string };
  }
}
window.contract = { list: Object.keys(TESTS), run: runTest };

// ?run=a,b (or all): run them now; the results on window.__contract
const ask = new URLSearchParams(location.search).get('run');
if (ask) {
  (async () => {
    const out: ContractResult[] = [];
    for (const n of ask === 'all' ? Object.keys(TESTS) : ask.split(',')) out.push(await runTest(n, { systems: new URLSearchParams(location.search).get('systems') === 'all' ? 'all' : undefined }));
    window.__contract = out;
  })().catch((e) => {
    window.__contract = { error: String(e?.stack ?? e) };
    if (e instanceof UnsupportedError) showFatal(e.message);
    else showFatal(`contract tests failed to start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  });
}
