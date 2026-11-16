// (phone-idle, 2026-11-15) The living town's graph sleeps: settled, its frame encodes one pass of direct dispatches and
// not one indirect; a CPU-known event (rebuild) or a wake only the GPU knows (the works' wake word, the wall's words)
// has it solved again to the same graph as a town that never sleeps; the riders' route keys are traced while it sleeps.
// Each frame here is its own task (a yield after the submit), as the page's frames are: the settled read answers between.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { LivingTown, C, L_C, WATCH_EVERY, graphSettled } from '../../src/citylife/living';
import { LIVING_TUNING } from '../../src/citylife/params';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 96;
const H = 96;
const N = W * H;
const ROW_H = Math.sqrt(3) / 2;
const RECW = 24;
const LOT_ROOM = 64;
const place = { dx: 0, dy: 0, dz: 0, winW: W, winH: H };

/** living.test.ts's town without its deck: a crossroads, an orphan street, homes along the east-west road, a market east */
function makeTown(wall: boolean): { town: LivingTown; roads: Uint32Array; roadsBuf: GPUBuffer; wallBuf?: GPUBuffer } {
  const dev = g.device;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (data: ArrayBufferView) => {
    const b = dev.createBuffer({ size: Math.max(16, data.byteLength), usage: S });
    dev.queue.writeBuffer(b, 0, data);
    return b;
  };
  const roads = new Uint32Array(N);
  for (let x = 0; x < W; x++) roads[48 * W + x] = 1;
  for (let y = 0; y < H; y++) roads[y * W + 48] = 1;
  for (let x = 70; x < 90; x++) roads[80 * W + x] = 1;
  const pop = new Float32Array(N * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pop[(y * W + x) * 4 + 2] = x > 60 ? 1 : 0;
  const rec = new ArrayBuffer((LOT_ROOM + 64) * RECW * 4);
  const ru = new Uint32Array(rec);
  const rf = new Float32Array(rec);
  let n = 0;
  const lot = (x0: number, yRoad: number, id: number) => {
    const x1 = x0 + 3.5;
    const y0 = yRoad + 1.4;
    const y1 = y0 + 5;
    const o = n * RECW;
    rf.set([x0, y0, x1, y0, x1, y1, x0, y1], o);
    rf.set([x0 + 0.4, y0 + 1, x1 - 0.4, y0 + 1, x1 - 0.4, y1 - 0.4, x0 + 0.4, y1 - 0.4], o + 8);
    ru[o + 16] = 0;
    ru[o + 17] = 1;
    ru[o + 19] = 2;
    rf[o + 20] = 6;
    rf[o + 21] = 2;
    ru[o + 23] = id;
    n++;
  };
  for (let k = 0; k < 20; k++) {
    const x0 = 2 + k * 4.5;
    if (x0 > 44 && x0 < 52) continue;
    lot(x0, (48 + 0.5) * ROW_H, 1000 + k);
  }
  lot(76, (80 + 0.5) * ROW_H, 2000);
  const roadsBuf = mk(roads);
  // (a wall input with no ring made: the town watches for it)
  const wallBuf = wall ? mk(new Uint32Array(600)) : undefined;
  const town = new LivingTown(dev, {
    w: W,
    h: H,
    roads: roadsBuf,
    heights: mk(new Float32Array(N).fill(2)),
    wet: mk(new Uint32Array(N)),
    pop: mk(pop),
    art: mk(new Uint32Array(4 + 8 * 276)),
    wall: wallBuf,
    records: mk(ru),
    counts: mk(new Uint32Array([n, 0, RECW, LOT_ROOM])),
    progress: mk(new Float32Array(LOT_ROOM + 64).fill(1)),
    lotRoom: LOT_ROOM,
    centre: [48, 48 * ROW_H],
    radius: 40,
  });
  return { town, roads, roadsBuf, wallBuf };
}

function tune(commuters: number): void {
  const p = LIVING_TUNING.values;
  Object.assign(p.people, { commuters, farmers: 0, quarrymen: 0, stoneCarts: 0, woodcutters: 0, logCarts: 0, builders: 0, wagons: 0, ships: 0, work: 2, speed: 1, spread: 0 });
  p.quarry.on = 0;
  p.forest.on = 0;
}

interface Tally {
  passes: number;
  direct: number;
  indirect: number;
}
const tally = (): Tally => ({ passes: 0, direct: 0, indirect: 0 });

/** a frame of each town, encoded, submitted, and the task yielded; the compute calls counted into `t` */
async function frame(towns: LivingTown[], t?: Tally): Promise<void> {
  const dev = g.device;
  const enc = dev.createCommandEncoder();
  if (t) {
    const begin = enc.beginComputePass.bind(enc);
    enc.beginComputePass = (d?: GPUComputePassDescriptor) => {
      t.passes++;
      const cp = begin(d);
      const direct = cp.dispatchWorkgroups.bind(cp);
      const indirect = cp.dispatchWorkgroupsIndirect.bind(cp);
      cp.dispatchWorkgroups = (x: number, y?: number, z?: number) => (t.direct++, direct(x, y, z));
      cp.dispatchWorkgroupsIndirect = (b: GPUBuffer, o: number) => (t.indirect++, indirect(b, o));
      return cp;
    };
  }
  for (const town of towns) town.frame(enc, 0.1, place);
  dev.queue.submit([enc.finish()]);
  await dev.queue.onSubmittedWorkDone();
  await new Promise((r) => setTimeout(r, 0));
}

/** frames until `done()` (at most `max`); how many it took */
async function until(towns: LivingTown[], done: () => boolean | Promise<boolean>, max: number, t?: Tally): Promise<number> {
  for (let f = 0; f < max; f++) {
    if (await done()) return f;
    await frame(towns, t);
  }
  return max;
}

const head = async (t: LivingTown) => (await t.counters())!;
/** the graph: every field's plane and each column's walk class */
async function graph(t: LivingTown): Promise<{ field: Uint32Array; walk: Uint32Array }> {
  const field = new Uint32Array(await t.debugRead(t.field, t.field.size));
  const walk = new Uint32Array(await t.debugRead(t.walk, t.walk.size)).map((w) => w & 0xf);
  return { field, walk };
}
const same = (a: Uint32Array, b: Uint32Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

test('graphSettled: the phase settled at the gate, nothing relaxing, no wake word, no switch asked, no work wanted', () => {
  const w = new Uint32Array(48);
  expect(graphSettled(w)).toBe(false);
  w[0] = 4;
  expect(graphSettled(w)).toBe(false);
  w[10] = 4;
  expect(graphSettled(w)).toBe(true);
  for (const k of [8, 14, 40, 41]) {
    w[k] = 1;
    expect(graphSettled(w)).toBe(false);
    w[k] = 0;
  }
  for (const ph of [0, 1, 2, 3, 5]) {
    w[0] = ph;
    expect(graphSettled(w)).toBe(false);
  }
});

test('settled, the town encodes one pass of direct dispatches, no indirect, no read; route keys asked meanwhile are traced', async () => {
  tune(12);
  const { town } = makeTown(false);
  const t0 = tally();
  const took = await until([town], () => !town.awake, 900, t0);
  expect(town.awake).toBe(false);
  // (while it solved it used the graph's indirect dispatches, as before)
  expect(t0.indirect).toBeGreaterThan(0);
  const h0 = await head(town);
  expect(h0[0]).toBe(4);
  expect(graphSettled(h0)).toBe(true);
  const reads0 = town.sleepStats.reads;
  // (asleep: 60 frames)
  const t1 = tally();
  for (let f = 0; f < 60; f++) await frame([town], t1);
  expect(t1.indirect).toBe(0);
  expect(t1.passes).toBe(60);
  // (the gate's watch, the switch, the hash, the trace, its end, the ramp, the riders, the figures' two; the sites' two
  // every 30 frames)
  expect(t1.direct).toBeLessThanOrEqual(60 * 9 + 2 * 2);
  expect(town.sleepStats.reads).toBe(reads0);
  expect(town.awake).toBe(false);
  // (more commuters: their homes' keys asked while the graph sleeps — traced, ridden)
  const h1 = await head(town);
  LIVING_TUNING.values.people.commuters = 70;
  const t2 = tally();
  for (let f = 0; f < 400; f++) await frame([town], t2);
  const h2 = await head(town);
  expect(t2.indirect).toBe(0);
  expect(town.awake).toBe(false);
  expect(h2[L_C + C.traced]).toBeGreaterThan(h1[L_C + C.traced]);
  expect(h2[L_C + C.arrivals]).toBeGreaterThan(h1[L_C + C.arrivals]);
  expect(h2[L_C + C.miss]).toBe(0);
  expect(h2[0]).toBe(4);
  expect(g.takeErrors()).toEqual([]);
  console.log(`[living sleep] asleep after ${took} frames (${t0.indirect} indirect while solving); asleep ${(t1.direct / 60).toFixed(1)} direct a frame, 1 pass, 0 indirect, 0 reads; traced ${h1[L_C + C.traced]} → ${h2[L_C + C.traced]} asleep`);
  town.dispose();
}, 120_000);

test('rebuild wakes it: the graph is solved again to the same fields as a town that never sleeps, then it sleeps', async () => {
  tune(30);
  const a = makeTown(false);
  const b = makeTown(false);
  b.town.debugNoSleep = true;
  const both = [a.town, b.town];
  const settledB = async () => graphSettled(await head(b.town));
  await until(both, async () => !a.town.awake && (await settledB()), 900);
  expect(a.town.awake).toBe(false);
  const a0 = await graph(a.town);
  const b0 = await graph(b.town);
  expect(same(a0.field, b0.field)).toBe(true);
  expect(same(a0.walk, b0.walk)).toBe(true);
  // (a new street: a north-south road east of the crossroads, joined to the east-west one)
  for (const t of [a, b]) {
    for (let y = 20; y < 48; y++) t.roads[y * W + 66] = 1;
    g.device.queue.writeBuffer(t.roadsBuf, 0, t.roads);
    t.town.rebuild();
  }
  expect(a.town.awake).toBe(true);
  const sweeps0 = (await head(a.town))[7];
  // (a few frames first: the rebuild is under way in both before either is asked whether it's settled)
  for (let f = 0; f < 8; f++) await frame(both);
  const took = await until(both, async () => !a.town.awake && (await settledB()), 900);
  expect(a.town.awake).toBe(false);
  const ha = await head(a.town);
  expect(ha[0]).toBe(4);
  expect(ha[7]).toBeGreaterThan(sweeps0);
  const a1 = await graph(a.town);
  const b1 = await graph(b.town);
  expect(same(a1.field, b1.field)).toBe(true);
  expect(same(a1.walk, b1.walk)).toBe(true);
  // (and it is a new graph: the street's columns walked)
  expect(a1.walk[30 * W + 66]).not.toBe(0);
  expect(a0.walk[30 * W + 66]).toBe(0);
  expect(same(a1.field, a0.field)).toBe(false);
  // (asleep again: nothing indirect)
  const t = tally();
  for (let f = 0; f < 30; f++) await frame([a.town], t);
  expect(t.indirect).toBe(0);
  expect(g.takeErrors()).toEqual([]);
  console.log(`[living sleep] rebuilt and asleep again ${took + 8} frames after rebuild(); wakes ${a.town.sleepStats.wakes}, reads ${a.town.sleepStats.reads}`);
  a.town.dispose();
  b.town.dispose();
}, 120_000);

test('a wake only the GPU knows (the works’ wake word; the wall’s words) is heard by the watch’s read and solved', async () => {
  tune(12);
  const { town, wallBuf } = makeTown(true);
  await until([town], () => !town.awake, 900);
  expect(town.awake).toBe(false);
  // (asleep with a wall to watch: a small read every WATCH_EVERY frames, nothing indirect)
  const reads0 = town.sleepStats.reads;
  const t = tally();
  for (let f = 0; f < 3 * WATCH_EVERY; f++) await frame([town], t);
  expect(t.indirect).toBe(0);
  expect(town.sleepStats.reads - reads0).toBeLessThanOrEqual(3);
  expect(town.sleepStats.reads - reads0).toBeGreaterThanOrEqual(2);
  expect(town.awake).toBe(false);
  // (the works dug out a walked column: works.wgsl sets the wake word — written here as it does)
  const h0 = await head(town);
  const wakes0 = town.sleepStats.wakes;
  g.device.queue.writeBuffer(town.lt, 40 * 4, new Uint32Array([1]));
  const heard = await until([town], () => town.awake, WATCH_EVERY + 8);
  expect(town.awake).toBe(true);
  expect(town.sleepStats.wakes).toBe(wakes0 + 1);
  const solved = await until([town], () => !town.awake, 900);
  expect(town.awake).toBe(false);
  const h1 = await head(town);
  expect(h1[0]).toBe(4);
  expect(h1[40]).toBe(0);
  // (made again: relaxed again)
  expect(h1[7]).toBeGreaterThan(h0[7]);
  // (the wall's ring made, nobody told: the watch sees the ring's signature, the wall's table is written again)
  const ver = async () => new Uint32Array(await town.debugRead(town.routes, 64))[11];
  const v0 = await ver();
  g.device.queue.writeBuffer(wallBuf!, 0, new Uint32Array([1]));
  const heard2 = await until([town], () => town.awake, WATCH_EVERY + 8);
  expect(town.awake).toBe(true);
  await until([town], () => !town.awake, 300);
  expect(town.awake).toBe(false);
  expect(await ver()).toBeGreaterThan(v0);
  expect(g.takeErrors()).toEqual([]);
  console.log(`[living sleep] the wake word heard after ${heard} frames, solved and asleep ${solved} frames on; the wall's ring heard after ${heard2}`);
  town.dispose();
}, 120_000);
