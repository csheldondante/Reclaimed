// The joined physics engine's phone bench (docs/design/PHYSICS_ENGINE.md "The tick on a phone"; BACKLOG PJ3): where a
// tick's time goes on the phone, by switching things on and off. Its own page, enginebench.html: a small world (the
// surface pass and the engine, nothing else stepped), no level.
//   /enginebench.html                 the floor ladder, the stage split, the solver (about 4 minutes)
//   …?long=1                          longer windows and three of them each way (about 10 minutes)
//   …?only=ladder,split,solver        some sections;  …&rows=1000,10000  the free-flight sizes
//   …&window=0.8&windows=2            the toggle's window, seconds, and how many of each
//   …&auto=1                          starts without the tap (headless: scripts/enginebench.mjs)
// A phone's GPU is a tiler and per-pass timestamps mislead there (the owner, round 120: "You need to toggle systems to
// measure the diff"). Every number here is a difference between frames that encode a thing and frames that encode
// nothing: windows of each variant in turn, the median time from a frame's submit to the GPU done with it
// (onSubmittedWorkDone), less the same for an empty frame. `reps` ticks a frame lift the difference clear of the noise;
// the number is a tick's.
// The scenes are held (Engine.hold): every stage does a tick's work, and `rowFinish` leaves each row where it was, so
// every tick does the same work and a stage can be left out (Engine.skip) without the scene changing under it. What a
// stage left out would have written stays as the last tick left it, so the stages after it are not starved.
// Reads: none a frame. At a scene's end: the engine's own counts (32 B) and, for the solver's resting quality, the
// rows' velocities and the pairs' depths, once.

import { initGpu } from '../gpu/device';
import { urlFlags } from '../flags';
import { beginPipelineBatch, endPipelineBatch } from '../gpu/pipeline';
import { Profiler } from '../gpu/profiler';
import { kickOnEvents } from '../engine/install';
import { Engine, type EngineBody, type EngineCell, type EngineStage, type TickCounts } from '../engine/engine';
import { WorldCore, type Host, type Quality } from '../scenes/world-core';
import type { SimSystem } from '../sim/system';
import { useRivers } from '../sim/world-gpu';
import { TUNE } from '../tune/params';
import { CHUNK, ColumnGrid } from '../world/layout';
import type { MapData } from '../world/mapgen';
import { MAT } from '../world/materials';
import { keepAwake, letSleep, Panel, wakeLog } from './bench/page';
import { copyText, deviceTag, downloadJson, postDev, shareJson, stamp } from './report-io';

declare const __BUILD_COMMIT__: string;

// v2: the row-level terrain test and the quiet tick are in the engine (BACKLOG PP4, PP5); the ladder shows the tick
// asleep both ways (quiet, and with the quiet gate off); medians, not means
// v3: stage 4 is encoded only while something deforms (PP6's first cut): the awake tick is 9 direct + 56 indirect
// dispatches in these scenes, and the `stage4` share reads about nothing; the watch tick is off by default
// v4: the kernels a thread a row or a pair, the coarse pass's table builds, fold and the draw list are dispatched
// direct while the rooms are small (PP11): an awake tick in the 1,000-row scenes is 57 direct + 8 indirect dispatches
// (the 10,000 and 50,000 free-flight scenes are past the bound and stay indirect)
const VERSION = 4;
const KEY = 'reclaimed.enginebench.partial';
const NL = String.fromCharCode(10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
/** the middle value: a stalled frame or two in a window do not move it */
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (v: number, d = 3) => (Number.isFinite(v) ? +v.toFixed(d) : null);
const QUALITY: Quality = { renderScale: 0.5, maxDpr: 1, rain: 1500, maxTicksPerFrame: 2, particles: 4096, agentSweeps: 2, shadowSize: 1024, meshSlots: 1 };
const MAP = 128;
const GROUND = 10;
const FLOOR = 4;
/** the pit the pour falls into (columns) */
const PIT = [6, 6, 44, 44];

/** flat stone at GROUND with a pit down to FLOOR */
function benchMap(): MapData {
  const n = MAP * MAP;
  const grid = new ColumnGrid({ w: MAP, h: MAP, zMax: 64 });
  const surface = new Float32Array(n);
  for (let y = 0; y < MAP; y++)
    for (let x = 0; x < MAP; x++) {
      const z1 = x >= PIT[0] && x < PIT[2] && y >= PIT[1] && y < PIT[3] ? FLOOR : GROUND;
      grid.cols[y * MAP + x] = [{ z0: 0, z1, mat: MAT.Stone }];
      surface[y * MAP + x] = z1;
    }
  return { grid, water: new Float32Array(n), contam: new Float32Array(n * 2), moisture: new Float32Array(n), vegetation: new Float32Array(n), oil: new Float32Array(n), drift: new Float32Array(n), oilStored: new Float32Array(n * 2), waterSource: new Float32Array(n), surface, poi: { healthy: [MAP >> 1, MAP >> 1] } };
}

const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number, mat: number = MAT.Stone): EngineCell[] => {
  const out: EngineCell[] = [];
  for (let z = z0; z < z0 + h; z++) for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, z, mat });
  return out;
};

/** a thing a frame can encode, measured against a frame that encodes nothing */
interface Variant {
  name: string;
  /** encodes it once; called `reps` times a frame */
  encode: (enc: GPUCommandEncoder) => void;
  reps?: number;
  /** set before its windows, and undone after (a stage left out) */
  enter?: () => void;
  leave?: () => void;
  note?: string;
}

interface Row {
  name: string;
  reps: number;
  /** a tick's (or the thing's) cost, ms: the GPU-done time less an empty frame's, over reps; and by the frame interval */
  ms: number | null;
  frameMs: number | null;
  /** the frames as measured */
  doneMs: number | null;
  intervalMs: number | null;
  frames: number;
  counts?: TickCounts;
  note?: string;
}

export async function engineBench(): Promise<void> {
  const params = urlFlags();
  const canvas = document.getElementById('world') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  const panel = new Panel(ui);
  const long = params.get('long') === '1';
  const windowS = Number(params.get('window') ?? (long ? 1.2 : 0.7));
  const windows = Number(params.get('windows') ?? (long ? 3 : 2));
  const only = (params.get('only') ?? 'ladder,split,solver').split(',');
  const flightRows = (params.get('rows') ?? '1000,10000,50000').split(',').map(Number);
  let partial: string | null = null;
  try {
    partial = localStorage.getItem(KEY);
  } catch {
    partial = null;
  }
  panel.say(`Physics engine bench v${VERSION} (${__BUILD_COMMIT__}). About ${long ? 10 : 4} minutes. Keep the screen on and this tab in front; the screen stays dark green while it runs. A table and a Download button come at the end.`);
  if (partial) {
    panel.text('The last run on this device did not finish. Its results so far:', false);
    panel.button('Download the unfinished report', false, () => void downloadJson(partial!, `reclaimed-enginebench-partial-${stamp()}.json`));
  }
  if (params.get('auto') !== '1') await new Promise<void>((go) => panel.button('Start', true, go));
  const awake = await keepAwake();
  const startedAt = new Date().toISOString();
  const t00 = performance.now();
  panel.say('Starting: compiling the world’s and the engine’s shaders (up to a minute the first time)…');
  await sleep(50);
  const gpu = await initGpu(canvas);
  const dev = gpu.device;
  const info = gpu.adapter.info as unknown as Record<string, unknown>;
  const prof = new Profiler(dev, false);
  const host: Host = { gpu, profiler: prof, quality: { ...QUALITY }, qualityName: 'low', params: new URLSearchParams(), canvas, ui };
  useRivers('sim');
  beginPipelineBatch();
  const core = new WorldCore(host, benchMap(), QUALITY.particles, CHUNK, false);
  await endPipelineBatch();
  core.tiers.apply();
  core.sim.prime(core.globals);
  const e = new Engine(dev, core.world, prof);
  const sys = core.sim.systems;
  sys.splice(sys.findIndex((s) => s.name === 'surface') + 1, 0, e);
  kickOnEvents(core.sim, e);
  const on = (s: SimSystem) => s.name === 'surface' || s.name === 'engine';
  await dev.queue.onSubmittedWorkDone();
  const setupMs = performance.now() - t00;
  const T = TUNE.engine as Record<string, number>;
  const T0 = { ...T };
  const errors: string[] = [];
  const sections: Record<string, unknown> = {};
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ kind: 'enginebench', version: VERSION, build: __BUILD_COMMIT__, startedAt, unfinished: true, sections, errors }));
    } catch {
      // (no storage: nothing kept of an unfinished run)
    }
  };

  // (a frame for the toggle: the canvas cleared, so the browser presents something every frame)
  const present = (enc: GPUCommandEncoder) => {
    const p = enc.beginRenderPass({ colorAttachments: [{ view: gpu.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.05, g: 0.08, b: 0.07, a: 1 } }] });
    p.end();
  };
  const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
  const read = async (buf: GPUBuffer, size: number, off = 0): Promise<ArrayBuffer> => {
    const rd = dev.createBuffer({ label: 'enginebench read', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(buf, off, rd, 0, size);
    dev.queue.submit([enc.finish()]);
    await rd.mapAsync(GPUMapMode.READ);
    const out = rd.getMappedRange().slice(0);
    rd.unmap();
    rd.destroy();
    return out;
  };
  /** real ticks (the surface pass and the engine), a few a turn of the event loop so the engine's own read lands */
  const step = async (n: number) => {
    for (let i = 0; i < n; i++) {
      core.sim.step(core.globals, on);
      if (i % 4 === 3) {
        await dev.queue.onSubmittedWorkDone();
        await sleep(0);
      }
    }
    await dev.queue.onSubmittedWorkDone();
  };
  /** ticks one at a time until the pair passes' rooms have stopped growing (a room that ran out holds its rows) */
  const settleRooms = async () => {
    let same = 0;
    let last = '';
    for (let i = 0; i < 200 && same < 10; i++) {
      await step(1);
      await sleep(4);
      const now = JSON.stringify([e.collide.rooms, e.rooms.rows, e.collide.growing]);
      same = now === last && !e.collide.growing ? same + 1 : 0;
      last = now;
    }
  };
  /** the rows awake, the tick's pairs (the GPU's own counts) */
  const sceneCounts = async () => {
    const head = new Uint32Array(await read(e.debugBuffers.list, 32));
    const pairs = new Uint32Array(await read(e.collide.coarse.pairBuf, 16));
    return { awake: head[3], pairs: pairs[0] };
  };

  /**
   * The variants in turn, `windows` times round: frames that encode a variant `reps` times, and frames that encode
   * nothing. A variant's cost is its median GPU-done time less the empty frames', over its reps.
   */
  const measure = async (label: string, variants: Variant[]): Promise<Row[]> => {
    const all: Variant[] = [{ name: 'empty frame', encode: () => {} }, ...variants];
    const sums = all.map(() => ({ dt: [] as number[], done: [] as number[] }));
    for (let w = 0; w < windows; w++)
      for (let k = 0; k < all.length; k++) {
        const v = all[k];
        panel.say(`${label}: ${v.name} (${w * all.length + k + 1} / ${windows * all.length})`);
        v.enter?.();
        const reps = v.reps ?? 1;
        const until = performance.now() + (windowS + 0.2) * 1000;
        // (the first fifth of a second of a window is left out: the switch settles)
        const begin = performance.now() + 200;
        let last = 0;
        while (performance.now() < until) {
          const t = await frame();
          const enc = dev.createCommandEncoder();
          for (let i = 0; i < reps; i++) v.encode(enc);
          present(enc);
          const t0 = performance.now();
          dev.queue.submit([enc.finish()]);
          const took = dev.queue.onSubmittedWorkDone().then(() => performance.now() - t0);
          if (t >= begin) {
            if (last) sums[k].dt.push(t - last);
            last = t;
            void took.then((ms) => sums[k].done.push(ms));
          }
        }
        await dev.queue.onSubmittedWorkDone();
        v.leave?.();
      }
    const base = { done: median(sums[0].done), dt: mean(sums[0].dt) };
    return all.map((v, k) => {
      const reps = v.reps ?? 1;
      const done = median(sums[k].done);
      const dt = mean(sums[k].dt);
      return { name: v.name, reps, ms: k ? round((done - base.done) / reps) : 0, frameMs: k ? round((dt - base.dt) / reps) : 0, doneMs: round(done, 2), intervalMs: round(dt, 2), frames: sums[k].dt.length, note: v.note };
    });
  };
  /** `k` ticks submitted alone, wall ms a tick to the GPU done */
  const batch = async (encode: (enc: GPUCommandEncoder) => void, k: number) => {
    const enc = dev.createCommandEncoder();
    for (let i = 0; i < k; i++) encode(enc);
    const t0 = performance.now();
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
    return (performance.now() - t0) / k;
  };
  const tick = (enc: GPUCommandEncoder) => e.encode(enc);
  /** reps a frame for a held scene: about 6 ms of ticks, four at most */
  const repsFor = async () => {
    await batch(tick, 2);
    const ms = Math.min(await batch(tick, 4), await batch(tick, 4));
    return { reps: Math.max(1, Math.min(4, Math.round(6 / Math.max(ms, 0.05)))), batchMs: round(ms) };
  };
  const reset = async () => {
    Object.assign(T, T0);
    e.hold = false;
    e.skip = {};
    e.clear();
    await dev.queue.onSubmittedWorkDone();
  };

  // ---- scenes ----------------------------------------------------------------------------------------------------------
  const cube = () => e.addModel(box(0, 0, 0, 2, 2, 2));
  /** `n` blocks in the air on a grid, none near another: awake, in no pair, held */
  const freeFlight = async (n: number) => {
    await reset();
    e.hold = true;
    const model = cube();
    const per = Math.floor((MAP - 8) / 5);
    for (let k = 0; k < n; k++) e.add({ model, pose: { pos: [5 + (k % per) * 5, 5 + (Math.floor(k / per) % per) * 5, 30 + Math.floor(k / (per * per)) * 5] } });
    await settleRooms();
  };
  /** 1,000 blocks in 250 stacks of four on the flat ground, set down touching, awake */
  const stacks = async () => {
    await reset();
    e.hold = true;
    for (let s = 0; s < 250; s++) for (let k = 0; k < 4; k++) e.add({ cells: box(48 + (s % 16) * 5, 4 + Math.floor(s / 16) * 6, GROUND + 2 * k, 2, 2, 2) });
    await settleRooms();
  };
  /** 1,000 blocks as a pile laid like bricks: ten layers of 10 x 10, each block set down on the corners of four below (about four pairs a block), nothing overlapping at the start; `awakeShare` of them awake, the rest asleep */
  const pile = async (awakeShare: number, hold: boolean) => {
    await reset();
    e.hold = hold;
    const model = cube();
    const out: EngineBody[] = [];
    for (let k = 0; k < 1000; k++) {
      // (every `1 / share`-th awake, spread through the pile)
      const up = awakeShare >= 1 || (k * 7919) % 1000 < awakeShare * 1000;
      const layer = Math.floor(k / 100);
      const shift = layer % 2 ? 1.5 : 0;
      out.push(e.add({ model, pose: { pos: [62 + (k % 10) * 3 + shift, 62 + (Math.floor(k / 10) % 10) * 3 + shift, GROUND + 1 + layer * 2] }, asleep: !up })!);
    }
    if (hold) await settleRooms();
    return out;
  };
  const SHAPES: [number, number, number, number][] = [
    [2, 2, 2, MAT.Stone],
    [3, 2, 2, MAT.Brick],
    [4, 2, 2, MAT.Concrete],
    [2, 2, 4, MAT.Stone],
    [3, 3, 3, MAT.Steel],
  ];
  /** 200 mixed blocks poured into the pit (test/gpu/engine-pile.test.ts's pour), held `ticks` in */
  const pour = async (ticks: number) => {
    await reset();
    const across = 6;
    for (let k = 0; k < 200; k++) {
      const s = SHAPES[(k * 7 + Math.floor(k / across)) % SHAPES.length];
      const layer = Math.floor(k / (across * across));
      e.add({ cells: box(8 + (k % across) * 5 + (layer % 2), 8 + (Math.floor(k / across) % across) * 6 + 2 * (layer % 2), 14 + layer * 5, s[0], s[1], s[2], s[3]) });
    }
    await step(ticks);
    e.hold = true;
    await settleRooms();
  };
  /** 1,000 blocks asleep on the ground, apart; then `awakeN` more in the air */
  const sleepers = async (awakeN: number) => {
    await reset();
    e.hold = true;
    for (let k = 0; k < 1000; k++) e.add({ cells: box(2 + (k % 32) * 4, 2 + Math.floor(k / 32) * 4, GROUND, 2, 2, 2), asleep: true });
    const model = cube();
    for (let k = 0; k < awakeN; k++) e.add({ model, pose: { pos: [20 + k * 6, 20, 40] } });
    await settleRooms();
  };

  const STAGES: [EngineStage, string][] = [
    ['integrate', 'integrate'],
    ['coarse', 'coarse collision'],
    ['fine', 'fine collision'],
    ['terrain', 'terrain contacts'],
    ['solve', 'solve'],
    ['sleep', 'move and sleep'],
    ['stage4', 'stage 4 (idle: nothing deforms)'],
    ['compact', 'compact (the awake list)'],
    ['draw', 'fold and draw list'],
  ];

  // ---- the floor ladder ------------------------------------------------------------------------------------------------
  if (only.includes('ladder')) {
    try {
      await sleepers(0);
      await step(2);
      const c0 = { ...e.counts };
      const D = c0.direct + c0.indirect;
      // a one-workgroup shader that does next to nothing, two pipelines of it, and its indirect arguments
      const mod = dev.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> b: array<u32>; @compute @workgroup_size(1) fn a() { b[0] = b[0] + 1u; } @compute @workgroup_size(1) fn c() { b[1] = b[1] + 1u; }' });
      const layout = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      const pl = dev.createPipelineLayout({ bindGroupLayouts: [layout] });
      const pipes = [await dev.createComputePipelineAsync({ layout: pl, compute: { module: mod, entryPoint: 'a' } }), await dev.createComputePipelineAsync({ layout: pl, compute: { module: mod, entryPoint: 'c' } })];
      const store = [0, 1].map(() => dev.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE }));
      const groups = store.map((b) => dev.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: b } }] }));
      const args = dev.createBuffer({ size: 32, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(args, 0, new Uint32Array([1, 1, 1, 0, 0, 0, 0, 0]));
      const trivial = (how: 'direct' | 'indirect' | 'zero', each: 'one pass' | 'a pass each', rebind: boolean) => (enc: GPUCommandEncoder) => {
        let pass = enc.beginComputePass();
        pass.setPipeline(pipes[0]);
        pass.setBindGroup(0, groups[0]);
        for (let i = 0; i < D; i++) {
          if (each === 'a pass each' && i) {
            pass.end();
            pass = enc.beginComputePass();
            pass.setPipeline(pipes[i & 1]);
            pass.setBindGroup(0, groups[i & 1]);
          } else if (rebind) {
            pass.setPipeline(pipes[i & 1]);
            pass.setBindGroup(0, groups[i & 1]);
          }
          if (how === 'direct') pass.dispatchWorkgroups(1);
          else pass.dispatchWorkgroupsIndirect(args, how === 'zero' ? 16 : 0);
        }
        pass.end();
      };
      const emptyPasses = (k: number) => (enc: GPUCommandEncoder) => {
        for (let i = 0; i < k; i++) enc.beginComputePass().end();
      };
      // the tick's clears, by the rooms `rows` bodies need (engine.ts encode, sdf/coarse.ts clears)
      const clearsAt = (bodies: number) => {
        let rows = 64;
        while (rows < bodies * 2) rows *= 2;
        let heads = 4096;
        while (heads < rows * 2) heads *= 2;
        const sizes = [28, 32, 128, 16, 32, (2 * heads + 4) * 4, rows * 4];
        const bufs = sizes.map((s) => dev.createBuffer({ size: Math.ceil(s / 4) * 4 + 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
        return { bytes: sizes.reduce((a, c) => a + c, 0), encode: (enc: GPUCommandEncoder) => bufs.forEach((b, i) => enc.clearBuffer(b, 0, Math.ceil(sizes[i] / 4) * 4)) };
      };
      const cl = [1024, 4096, 16384].map((n) => ({ n, ...clearsAt(n) }));
      // the tick's uploads: the same sizes into uniform buffers of their own
      const upSizes = [512, 224, 224, 224, 192, 48, 48, 48];
      const upBufs = upSizes.map((s) => dev.createBuffer({ size: s, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      const upData = upSizes.map((s) => new Uint8Array(s));
      const uploads = () => upBufs.forEach((b, i) => dev.queue.writeBuffer(b, 0, upData[i]));
      const A = await measure('floor ladder', [
        { name: `${c0.passes} empty compute pass${c0.passes > 1 ? 'es' : ''} (the tick's)`, encode: emptyPasses(c0.passes) },
        { name: `${D} empty compute passes`, encode: emptyPasses(D) },
        { name: `${D} one-workgroup dispatches, direct, one pass, one pipeline`, encode: trivial('direct', 'one pass', false) },
        { name: `${D} direct, one pass, pipeline and bind group set each`, encode: trivial('direct', 'one pass', true) },
        { name: `${D} direct, a pass each`, encode: trivial('direct', 'a pass each', true) },
        { name: `${D} indirect (1 workgroup), one pass, set each`, encode: trivial('indirect', 'one pass', true) },
        { name: `${D} indirect (0 workgroups), one pass, set each`, encode: trivial('zero', 'one pass', true) },
        ...cl.map((c) => ({ name: `the tick's ${c0.clears} clears at ${c.n} rows (${c.bytes} B)`, encode: c.encode })),
        { name: `the tick's ${upSizes.length} uploads (${upSizes.reduce((a, c) => a + c, 0)} B)`, encode: () => uploads() },
        { name: 'the whole tick, 0 awake, 1,000 asleep (the quiet gate off: as v1 ran it)', encode: tick },
      ]);
      A[A.length - 1].counts = c0;
      // the same scene as play runs it: once a read has shown nothing awake, a tick encodes nothing
      e.hold = false;
      for (let i = 0, still = 0; i < 300 && still < 3; i++) {
        await step(1);
        await sleep(4);
        still = e.counts.direct + e.counts.indirect === 0 ? still + 1 : 0;
      }
      const cq = { ...e.counts };
      const Q = await measure('floor ladder, asleep', [{ name: 'the real tick, 0 awake, 1,000 asleep (quiet)', encode: tick }]);
      Q[1].counts = cq;
      Q[1].note = cq.direct + cq.indirect === 0 ? 'quiet: nothing encoded' : 'the engine did not go quiet in 300 ticks';
      await sleepers(1);
      await step(2);
      const c1 = { ...e.counts };
      const B = await measure('floor ladder, one awake', [
        { name: 'the real tick, 1 awake, 1,000 asleep', encode: tick },
        { name: 'the real tick 4 times a frame (a tick’s share)', encode: tick, reps: 4 },
      ]);
      B[1].counts = B[2].counts = c1;
      const one = B[1].ms ?? NaN;
      const four = (B[2].ms ?? NaN) * 4;
      sections.ladder = {
        tickCounts: c0,
        rows: [...A, Q[1], ...B.slice(1)],
        scaling: { oneTickMs: round(one), fourTicksMs: round(four), fourOverOne: round(four / one, 2), reading: four < 2.5 * one ? 'four ticks cost far less than four times one: a light frame is being run slowly (the GPU’s clock scales down under light load, or a fixed cost a frame)' : 'four ticks cost about four times one: the cost is the work, not a slow clock' },
      };
      for (const b of [...store, args, ...upBufs]) b.destroy();
    } catch (err) {
      errors.push(`ladder: ${(err as Error).stack ?? err}`);
    }
    save();
  }

  // ---- the stage split -------------------------------------------------------------------------------------------------
  const split: Record<string, unknown>[] = [];
  const runSplit = async (name: string, build: () => Promise<void>) => {
    try {
      panel.say(`stage split: building ${name}…`);
      const tb = performance.now();
      await build();
      const buildMs = performance.now() - tb;
      await step(2);
      const counts = { ...e.counts };
      const sc = await sceneCounts();
      const { reps, batchMs } = await repsFor();
      const rows = await measure(`stage split, ${name}`, [
        { name: 'the whole tick', encode: tick, reps },
        ...STAGES.map(([st, label]): Variant => ({ name: `without ${label}`, encode: tick, reps, enter: () => (e.skip = { [st]: true }), leave: () => (e.skip = {}) })),
      ]);
      const whole = rows[1].ms ?? NaN;
      // (a stage's cost: the whole tick less the tick without it)
      const stages = Object.fromEntries(STAGES.map(([st], i) => [st, round(whole - (rows[2 + i].ms ?? NaN))]));
      split.push({ scene: name, ...sc, reps, tickMs: rows[1].ms, tickFrameMs: rows[1].frameMs, batchMs, stages, counts, buildMs: round(buildMs, 0), rooms: e.collide.rooms, rows });
    } catch (err) {
      errors.push(`split ${name}: ${(err as Error).stack ?? err}`);
    }
    sections.split = split;
    save();
  };
  if (only.includes('split')) {
    await runSplit('1,000 resting in 250 stacks', stacks);
    await runSplit('pile of 1,000, 10% awake', async () => void (await pile(0.1, true)));
    await runSplit('200 poured into a pit, mid-pour', () => pour(120));
  }

  // ---- the solver ------------------------------------------------------------------------------------------------------
  if (only.includes('solver')) {
    try {
      const out: Record<string, unknown>[] = [];
      await pile(1, true);
      const sc = await sceneCounts();
      const { reps } = await repsFor();
      const iters = [1, 2, 4, 8];
      const rows = await measure('solver, pile of 1,000 awake', iters.map((it): Variant => ({ name: `${it} iteration${it > 1 ? 's' : ''}`, encode: tick, reps, enter: () => (T.pairIters = it), leave: () => (T.pairIters = T0.pairIters) })));
      // resting quality: the same pile let go for 5 s at each setting; then its largest speed and deepest overlap
      for (let i = 0; i < iters.length; i++) {
        panel.say(`solver: the pile for 5 s at ${iters[i]} iteration${iters[i] > 1 ? 's' : ''}…`);
        const bodies = await pile(1, false);
        T.pairIters = iters[i];
        const t0 = performance.now();
        await step(300);
        const wallMs = (performance.now() - t0) / 300;
        const D = e.debugBuffers;
        const n = e.rooms.rows;
        const vel = new Float32Array(await read(D.vel, n * 32));
        const pose = new Float32Array(await read(D.pose, n * 64));
        const flags = new Uint32Array(await read(D.info, n * 64));
        const pc = Math.min(new Uint32Array(await read(e.collide.coarse.pairBuf, 16))[0], e.collide.coarse.pairRoom);
        const prow = pc ? new Float32Array(await read(D.prow, pc * 256)) : new Float32Array(0);
        const prowU = new Uint32Array(prow.buffer);
        let speed = 0;
        let asleep = 0;
        let top = 0;
        for (const b of bodies) {
          speed = Math.max(speed, Math.hypot(vel[b.row * 8], vel[b.row * 8 + 1], vel[b.row * 8 + 2]));
          if (flags[b.row * 16 + 3] & 2) asleep++;
          top = Math.max(top, pose[b.row * 16 + 10]);
        }
        // (a pair's first row is its deepest sample, as the fine pass found it this tick: engine_pairs.wgsl pairPrep)
        let deep = 0;
        for (let p = 0; p < pc; p++) if (prowU[p * 64 + 2] > 0) deep = Math.max(deep, prow[p * 64 + 11]);
        // (pairs among rows awake only: asleep, the deepest is as the last awake tick left it)
        out.push({ iterations: iters[i], ms: rows[1 + i].ms, frameMs: rows[1 + i].frameMs, after5s: { largestSpeed: round(speed), deepestOverlap: round(deep), pairsAwake: pc, asleep, topCentre: round(top, 2), topCentreAtStart: GROUND + 19 }, wallMsATick: round(wallMs, 2) });
        Object.assign(T, T0);
      }
      sections.solver = { scene: 'pile of 1,000, all awake (ten layers of 10 x 10 laid like bricks)', ...sc, reps, rows, results: out };
    } catch (err) {
      errors.push(`solver: ${(err as Error).stack ?? err}`);
    }
    Object.assign(T, T0);
    save();
  }

  // (the free-flight scenes last, the largest at the very end: a phone that runs out of memory there has saved the rest)
  if (only.includes('split')) for (const n of flightRows) await runSplit(`${n.toLocaleString('en-US')} in free flight`, () => freeFlight(n));

  await letSleep();
  if (document.querySelector('.fatal')) errors.push(`fatal overlay: ${document.querySelector('.fatal')!.textContent}`);
  let hints: unknown = null;
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<unknown> } }).userAgentData;
    if (uad) hints = await uad.getHighEntropyValues(['model', 'platform', 'platformVersion']);
  } catch {
    hints = null;
  }
  const report = {
    kind: 'enginebench',
    version: VERSION,
    build: __BUILD_COMMIT__,
    startedAt,
    endedAt: new Date().toISOString(),
    runSeconds: round((performance.now() - t00) / 1000, 0),
    what: 'the joined physics engine: every ms is a difference of median GPU-done time (submit to onSubmittedWorkDone) between frames that encode the thing and frames that encode nothing, over reps; frameMs the same by the frame interval. Held scenes: every tick does the same work. A stage’s cost is the whole tick less the tick without it. No timestamp queries.',
    method: { windowS, windows, long },
    device: { adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }, ua: navigator.userAgent, clientHints: hints, screen: [innerWidth, innerHeight, devicePixelRatio] },
    wakeLock: { held: awake, log: wakeLog },
    setupMs: round(setupMs, 0),
    tune: { substeps: T0.substeps, pairIters: T0.pairIters, deform: T0.deform, fastPath: T0.fastPath },
    sections,
    errors,
  };
  const body = JSON.stringify(report);
  (window as unknown as { engineBenchReport: string }).engineBenchReport = body;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // (no storage)
  }
  panel.say(`Done in ${report.runSeconds} s${errors.length ? ` with ${errors.length} error${errors.length > 1 ? 's' : ''} (in the report)` : ''}. Download the report and send it.`);
  const pad = (v: unknown, w: number) => String(v ?? '-').padStart(w);
  const lines: string[] = [];
  const L = sections.ladder as { rows: Row[]; tickCounts: TickCounts; scaling: { oneTickMs: number; fourTicksMs: number; fourOverOne: number; reading: string } } | undefined;
  const cnt = (c: TickCounts) => `${c.passes} pass, ${c.direct} direct + ${c.indirect} indirect dispatches, ${c.clears} clears, ${c.copies} copies, ${c.uploads} uploads (${c.uploadBytes} B)`;
  if (L) {
    lines.push('FLOOR LADDER   ms (GPU done) / ms (frame interval)', `a tick is ${cnt(L.tickCounts)}`);
    for (const r of L.rows.slice(1)) lines.push(`${pad(r.ms, 7)} / ${pad(r.frameMs, 7)}  ${r.name}`);
    lines.push(`one tick ${L.scaling.oneTickMs} ms, four ${L.scaling.fourTicksMs} ms (x${L.scaling.fourOverOne}): ${L.scaling.reading}`, '');
  }
  if (split.length) {
    lines.push('STAGE SPLIT   ms a tick (GPU done): the whole tick, then each stage’s share');
    for (const s of split as { scene: string; awake: number; pairs: number; tickMs: number; reps: number; stages: Record<string, number>; counts: TickCounts }[]) {
      lines.push(`${s.scene}: ${s.awake} awake, ${s.pairs} pairs; tick ${s.tickMs} ms (${s.reps} a frame)`, `  ${Object.entries(s.stages).map(([k, v]) => `${k} ${v}`).join(', ')}`, `  ${cnt(s.counts)}`);
    }
    lines.push('');
  }
  const S = sections.solver as { results: { iterations: number; ms: number; after5s: { largestSpeed: number; deepestOverlap: number; asleep: number; topCentre: number } }[] } | undefined;
  if (S) {
    lines.push('SOLVER   pile of 1,000: iterations, ms a tick; after 5 s: largest speed (cells/s), deepest overlap (cells), asleep, top block’s centre (29 at the start; the pile has gaps and compacts)');
    for (const r of S.results) lines.push(`${pad(r.iterations, 2)}  ${pad(r.ms, 7)}  ${pad(r.after5s.largestSpeed, 7)}  ${pad(r.after5s.deepestOverlap, 7)}  ${pad(r.after5s.asleep, 5)}  ${pad(r.after5s.topCentre, 6)}`);
  }
  if (errors.length) lines.push('', 'ERRORS', ...errors);
  panel.text(lines.join(NL), true);
  const status = panel.text('');
  const say = (m: string) => (status.textContent = m);
  const name = `reclaimed-enginebench-v${VERSION}-${stamp()}-${await deviceTag(String(info.vendor ?? ''))}.json`;
  panel.button('Download report', true, () => say(downloadJson(body, name)));
  panel.button('Copy', false, () => void copyText(body).then(say, (err: Error) => say(`copy failed: ${err.message}`)));
  panel.button('Share…', false, () => void shareJson(body, name, 'Reclaimed engine bench').then((m) => say(m || 'this browser can’t share files: use Download')));
  const saved = await postDev(body, 'enginebench');
  if (saved) panel.text(`dev server: ${saved}`, true);
}

void engineBench().catch((err: unknown) => {
  console.error(err);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.style.cssText = 'color:#f88;font:13px ui-monospace,monospace;white-space:pre-wrap;padding:12px';
  el.textContent = `enginebench failed: ${(err as Error).stack ?? err}`;
  document.body.appendChild(el);
});
