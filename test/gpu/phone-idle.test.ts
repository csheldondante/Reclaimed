// (phone-idle round 2, 2026-11-15) The liquids, the wind field, the sway and the coarse world at idle: what they ask of
// the GPU a tick, counted (src/gpu/census.ts), and that they compute what they did. On the phone an indirect dispatch
// costs ~0.1 ms whether it runs 1 workgroup or 0 (docs/FRAMECOST.md), so:
// - the liquids' passes over their run list are dispatched direct over a bound the CPU knows (flow/liquid.ts `bound`),
//   and a liquid whose every source is the CPU's — lava — encodes nothing once a small read says none is left;
// - the wind field's painted update is direct, and not encoded at all with nothing painted or landed lately;
// - the sway and the coarse world sleep on a small read until the CPU knows of a reason to look again.
// The reference each is held to, bit for bit: LiquidSystem.reference (indirect over the GPU's lists, never asleep — the
// system as it was), the whole wind field painted every update, the coarse world stepping every tile.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Coarse } from '../../src/atlas/coarse';
import { LiquidSystem } from '../../src/flow/liquid';
import { Census, censusUse, installCensus, type CensusRow } from '../../src/gpu/census';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
const CHUNKS = (W / 16) ** 2;
let g: TestGpu;
const census = new Census();
let undo: (() => void) | undefined;
const made: TinyWorld[] = [];

beforeAll(async () => {
  g = await testGpu();
  // (the census over this device's classes, from their instances)
  const enc = g.device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.end();
  enc.finish();
  const buf = g.device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST });
  const cls = (o: object) => ({ prototype: Object.getPrototypeOf(o) as object });
  undo = installCensus(census, { GPUCommandEncoder: cls(enc), GPUComputePassEncoder: cls(pass), GPURenderPassEncoder: { prototype: {} }, GPUQueue: cls(g.device.queue), GPUBuffer: cls(buf), GPUDevice: cls(g.device) }, GPUMapMode.READ);
  buf.destroy();
});
afterAll(async () => {
  censusUse(null);
  undo?.();
  await g.device.queue.onSubmittedWorkDone();
  for (const w of made) w.destroy();
});

/** a turn of the event loop: the small reads land */
const turn = () => new Promise((r) => setTimeout(r, 0));

/** n ticks of each world, one at a time, the reads landing between */
async function ticks(ws: TinyWorld[], n: number, each?: (w: TinyWorld) => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    for (const w of ws) {
      each?.(w);
      await w.step(1);
    }
    await turn();
  }
}

/** what n ticks of world w ask of the GPU, in all, by system; `reads`: the settled reads taken (gpu/settled.ts), whoever's */
async function counted(w: TinyWorld, n: number, each?: (w: TinyWorld) => void): Promise<{ of: (system: string) => CensusRow | undefined; reads: number }> {
  censusUse(census);
  census.reset();
  await ticks([w], n, each);
  await turn();
  const r = census.take();
  censusUse(null);
  const settled = (x: CensusRow) => (x.system.includes('settled read') ? x.reads : x.labels.filter((l) => l.label.includes('settled read')).reduce((n, l) => n + (l.reads ?? 0), 0));
  return { of: (s) => r.systems.find((x) => x.system === s), reads: r.systems.reduce((n, x) => n + settled(x), 0) };
}

// ---------------------------------------------------------------------------------------------------- the liquids

async function liquidWorld(reference: boolean): Promise<TinyWorld> {
  const rim = (x: number, y: number) => x === 0 || y === 0 || x === W - 1 || y === W - 1 || y === 32;
  // (ground falling toward +x, a wall between the water's half and the lava's)
  const map = tinyMap(W, W, 32, (x, y) => [{ z0: 0, z1: rim(x, y) ? 20 : 14 - Math.min(8, Math.floor(x / 8)), mat: MAT.Stone }]);
  for (let y = 18; y < 26; y++) for (let x = 4; x < 12; x++) map.water[y * W + x] = 1.5;
  LiquidSystem.reference = reference;
  const w = await tinyWorld(g, map, ['surface', 'liquid-water', 'liquid-lava']);
  LiquidSystem.reference = false;
  made.push(w);
  return w;
}

/** the liquids' state: the water, the lava's open depth, both liquids' runs (both parities, stamps and all) */
async function liquidState(w: TinyWorld): Promise<Uint32Array[]> {
  const flow = w.core.flow!;
  const bufs = [w.core.world.water, flow.lava.open, ...[flow.water, flow.lava].flatMap((l) => (l as unknown as { runs: GPUBuffer[] }).runs)];
  return Promise.all(bufs.map(async (b) => new Uint32Array(await g.read(b, b.size))));
}

/** the sleep mask and its count, as a scene's Sleep gives them */
function mask(w: TinyWorld, asleep: (cx: number, cy: number) => boolean): void {
  const table = w.core.world.ring.table;
  const m = new Uint32Array(64);
  let awake = 0;
  for (let c = 0; c < CHUNKS; c++) {
    if (asleep(c % 4, (c / 4) | 0)) m[table[c] >> 5] |= 1 << (table[c] & 31);
    else awake++;
  }
  w.core.globals.sleep = m;
  w.core.globals.drowse = new Uint32Array(64);
  w.core.sleep.awake = awake;
}

test('the liquids: the same water and lava as before, the passes direct, lava with no lava encodes nothing', async () => {
  const now = await liquidWorld(false);
  const ref = await liquidWorld(true);
  const both = [now, ref];
  const lava = now.core.flow!.lava;
  const same = async (what: string) => {
    const [a, b] = await Promise.all(both.map(liquidState));
    a.forEach((buf, k) => expect(Buffer.from(buf.buffer).equals(Buffer.from(b[k].buffer)), `${what}: buffer ${k}`).toBe(true));
  };
  const volume = async (b: GPUBuffer) => new Float32Array(await g.read(b, b.size)).reduce((s, v) => s + v, 0);

  // no lava anywhere: after its first looks the lava sleeps, and a tick asks nothing of the GPU for it
  await ticks(both, 30);
  expect(lava.settle!.awake, 'no lava: asleep').toBe(false);
  await same('at rest');
  const N = 30;
  let c = await counted(now, N);
  await ticks([ref], N);
  expect(c.of('liquid-lava'), 'the sleeping lava: no pass, dispatch, upload or copy').toBeUndefined();
  expect(c.reads, 'no read').toBe(0);
  const water = c.of('liquid-water')!;
  // (a tick: the lists' pass — scan, list — and the step's — flux, jets, depth, two publishes direct, the draw lists
  // indirect; the step's 16 bytes and the two draw arguments uploaded)
  expect([water.computePasses, water.direct, water.indirect]).toEqual([2 * N, 7 * N, N]);
  expect([water.uploads, water.uploadBytes]).toEqual([3 * N, 48 * N]);
  await same('counted');

  // a spring of each, every chunk awake: flowing
  for (const w of both) {
    w.core.flow!.water.addSpring(10, 10, 16, 3);
    w.core.flow!.lava.addSpring(20, 52, 16, 4);
  }
  await ticks(both, 100);
  expect(lava.settle!.awake, 'a spring: awake').toBe(true);
  expect(await volume(lava.open), 'lava poured').toBeGreaterThan(1);
  expect(await volume(now.core.world.water), 'water kept').toBeGreaterThan(90);
  await same('springs');
  // half the window asleep: the liquids run into sleeping chunks
  for (const w of both) mask(w, (cx) => cx >= 2);
  await ticks(both, 120);
  await same('half asleep');
  // every chunk awake again, a region's land come in (its chunks' records forgotten)
  for (const w of both) {
    mask(w, () => false);
    w.core.flow!.water.forget(48, 0, 16, 32);
    w.core.flow!.lava.forget(48, 0, 16, 32);
  }
  await ticks(both, 60);
  await same('land come in');
  // the springs gone, the other half asleep; then everything asleep (the idle scans), then awake
  for (const w of both) {
    w.core.flow!.water.springs.length = 0;
    w.core.flow!.lava.springs.length = 0;
    mask(w, (_cx, cy) => cy < 2);
  }
  await ticks(both, 200);
  await same('springs gone');
  for (const w of both) mask(w, () => true);
  await ticks(both, 40);
  await same('all asleep');
  for (const w of both) mask(w, () => false);
  // the lava cools and sets: once none is left it sleeps again, and costs nothing
  let waited = 0;
  for (; waited < 6000 && lava.settle!.awake; waited += 50) await ticks(both, 50);
  expect(lava.settle!.awake, `the lava set and gone within ${waited} ticks: asleep`).toBe(false);
  expect(await volume(lava.open), 'no lava left').toBeLessThan(1e-3);
  await same('lava gone');
  c = await counted(now, N);
  await ticks([ref], N);
  expect(c.of('liquid-lava'), 'asleep again: nothing').toBeUndefined();
  expect(c.of('liquid-water')!.indirect, 'the water: its draw lists only').toBe(N);
  // woken by a spring after its sleep: the same lava as the system that never slept
  for (const w of both) w.core.flow!.lava.addSpring(40, 44, 16, 4);
  await ticks(both, 60);
  for (const w of both) w.core.flow!.lava.springs.length = 0;
  await ticks(both, 80);
  expect(await volume(lava.open), 'lava again').toBeGreaterThan(0.1);
  await same('lava again');
  expect(g.takeErrors()).toEqual([]);
}, 600000);

// ------------------------------------------------------------------------------------------- the wind and the sway

async function windWorld(whole: boolean): Promise<TinyWorld> {
  const w = await tinyWorld(g, tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]), 'all');
  // (the reference: the whole field painted every update)
  if (whole) w.core.sim.wind.wholeWhile.push(() => true);
  made.push(w);
  return w;
}

/** the painted wind (rg) of a world's field, texel by texel */
async function painted(w: TinyWorld): Promise<Float32Array> {
  const tex = w.core.world.windField;
  const bpr = Math.ceil((tex.width * 16) / 256) * 256;
  const buf = g.device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = g.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  g.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const all = new Float32Array(buf.getMappedRange());
  const out = new Float32Array(tex.width * tex.height * 2);
  for (let y = 0; y < tex.height; y++)
    for (let x = 0; x < tex.width; x++) {
      out[(y * tex.width + x) * 2] = all[(y * bpr) / 4 + x * 4];
      out[(y * tex.width + x) * 2 + 1] = all[(y * bpr) / 4 + x * 4 + 1];
    }
  buf.destroy();
  return out;
}

test('the wind field and the sway: nothing painted and nothing landing — a band of the map wind, no sway; a stroke paints the same wind', async () => {
  const now = await windWorld(false);
  const ref = await windWorld(true);
  const both = [now, ref];
  const still = (w: TinyWorld) => (w.core.globals.gusts = []);
  // (every band's uniform written once, the sway's first looks)
  await ticks(both, 40, still);
  const N = 32;
  let c = await counted(now, N, still);
  await ticks([ref], N, still);
  const wind = c.of('windfield')!;
  expect([wind.computePasses, wind.direct, wind.indirect, wind.uploads], 'idle: the band alone, one pass, nothing uploaded').toEqual([N, N, 0, 0]);
  expect(c.of('sway'), 'the sway asleep: nothing').toBeUndefined();
  expect(c.reads, 'no read').toBe(0);
  expect(now.core.sim.wind.lastBox).toBeNull();

  // a stroke dragged across: painted where it is, direct, the same wind as the whole field updated
  const stroke = (w: TinyWorld) => {
    // (the same drag in both worlds: where it is by the world's own tick)
    const x = 20 + (w.core.sim.tick % 64) * 0.5;
    w.core.globals.gusts = [
      { x: 0, y: 0, radius: 1, strength: 0, dx: 1, dy: 0 },
      { x, y: 30, radius: 5, strength: 6, dx: 1, dy: 0, len: 0.5 },
    ];
  };
  c = await counted(now, 20, stroke);
  await ticks([ref], 20, stroke);
  expect(now.core.sim.wind.lastBox).not.toBeNull();
  expect(c.of('windfield')!.indirect, 'painted: no indirect dispatch').toBe(0);
  expect(c.of('windfield')!.direct, 'the box, the update, its copy, the band').toBe(4 * 20);
  expect(c.of('sway')!.computePasses, 'the sway awake under the stroke').toBeGreaterThan(0);
  for (let k = 0; k < 6; k++) {
    await ticks(both, 10, still);
    const [a, b] = await Promise.all(both.map(painted));
    if (k === 0) expect(a.some((v) => v !== 0), 'the stroke painted wind').toBe(true);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer)), `the painted wind, ${k}`).toBe(true);
  }
  expect(g.takeErrors()).toEqual([]);
}, 600000);

// ------------------------------------------------------------------------------------------------ the coarse world

test('the coarse world at rest encodes nothing, and an event wakes it to the same world', async () => {
  const CN = 64;
  const WORLD = 2048;
  const h = new Float32Array(CN * CN);
  for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) h[j * CN + i] = 40 + 18 * Math.sin(i / 7) * Math.cos(j / 9) + (i + j) * 0.3;
  const sea = (t: number) => t % CN < 6 && Math.floor(t / CN) < 6;
  const live = new Coarse(g.device, CN, WORLD, WORLD);
  const every = new Coarse(g.device, CN, WORLD, WORLD, false);
  await live.init(h, CN, sea);
  await every.init(h, CN, sea);
  const both = (f: (c: Coarse) => void) => [live, every].forEach(f);
  const cells = async (c: Coarse) => Buffer.from(await g.read(c.cells, CN * CN * 32));
  const same = async (what: string) => expect((await cells(live)).equals(await cells(every)), what).toBe(true);
  const awake = () => (live as unknown as { settle: { awake: boolean } }).settle.awake;
  /** n steps a part at a time, as the level's frames carry them, the reads landing between the steps */
  const parts = async (n: number) => {
    for (let k = 0; k < n; k++) {
      for (let q = 0; q < 3; q++) both((c) => c.stepPart());
      await g.device.queue.onSubmittedWorkDone();
      await turn();
    }
  };
  const rest = async (what: string) => {
    let waited = 0;
    for (; waited < 2000 && awake(); waited += 25) await parts(25);
    expect(awake(), `${what}: at rest within ${waited} steps, asleep`).toBe(false);
    await same(what);
    const ran = live.partsRun;
    censusUse(census);
    census.reset();
    for (let k = 0; k < 30; k++) live.stepPart();
    await turn();
    const t = census.take().total;
    censusUse(null);
    expect(live.partsRun, `${what}: no part encoded`).toBe(ran);
    expect([t.computePasses, t.direct, t.indirect, t.uploads, t.copies, t.clears, t.reads, t.submits], `${what}: nothing asked of the GPU`).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    for (let k = 0; k < 30; k++) every.stepPart();
    expect(live.steps).toBe(every.steps);
  };
  // a still world: asleep after its first steps
  await parts(12);
  await rest('the start');
  // a meteor wakes it: the same world as every tile stepped, through its slumping and to rest again
  both((c) => c.meteor(900, 700, 180));
  expect(awake(), 'an event: awake').toBe(true);
  await parts(40);
  await same('a meteor');
  await rest('after the meteor');
  // an eruption: its vent pours (awake while it does), the lava sets
  both((c) => c.erupt(1500, 1300, { lava: 0.4, steps: 30 }));
  await parts(60);
  await same('an eruption');
  await rest('after the eruption');
  // the rain turned on wakes it: every tile live the step it changes
  both((c) => (c.rain = 0.002));
  await parts(20);
  expect(awake(), 'rain: awake').toBe(true);
  await same('rain');
  both((c) => (c.rain = 0));
  await parts(20);
  await same('the rain off');
  live.dispose();
  every.dispose();
  expect(g.takeErrors()).toEqual([]);
}, 600000);
