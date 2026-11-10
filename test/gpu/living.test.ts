// (living town LT2, docs/design/LIVING_TOWN.md) The route graph from a citygen-shaped road raster on the GPU, the hubs'
// fields settled with no readback, routes traced and shared, riders on kinematic trips: on a 96 × 96 box with a
// crossroads (a bridge deck on the west arm), homes along the east-west road and a market district east. Commuters ride
// home → market → home; a commuter from the west rides the deck at its height; builders go to the two sites rising.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { LivingTown, C, L_C, LT_WORDS } from '../../src/citylife/living';
import { LIVING_TUNING } from '../../src/citylife/params';
import { Works } from '../../src/citylife/works';
import { GLOBALS_BYTES } from '../../src/sim/globals';
import { packMaterialTable } from '../../src/world/materials';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 96;
const H = 96;
const ROW_H = Math.sqrt(3) / 2;
const RECW = 24;
const LOT_ROOM = 64;
const DECK_BIT = 0x80000000;

test('riders ride routes traced on the GPU from the road raster, over a deck at its height', async () => {
  const dev = g.device;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (data: ArrayBufferView) => {
    const b = dev.createBuffer({ size: Math.max(16, data.byteLength), usage: S });
    dev.queue.writeBuffer(b, 0, data);
    return b;
  };
  const N = W * H;
  // (the road raster: row 48 east-west, column 48 north-south; the west arm's x 8..20 a deck at z 7)
  const roads = new Uint32Array(N);
  for (let x = 0; x < W; x++) roads[48 * W + x] = x >= 8 && x <= 20 ? (DECK_BIT | (7 * 256)) >>> 0 : 1;
  for (let y = 0; y < H; y++) roads[y * W + 48] = 1;
  const heights = new Float32Array(N).fill(2);
  // (the population field: market east of x 60, homes elsewhere)
  const pop = new Float32Array(N * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pop[(y * W + x) * 4 + 2] = x > 60 ? 1 : 0;
  // (lots: 20 buildings north of the east-west road, fronting it (edge 0 faces south), x 2..90 every 4.5)
  const rec = new ArrayBuffer((LOT_ROOM + 64) * RECW * 4);
  const ru = new Uint32Array(rec);
  const rf = new Float32Array(rec);
  const yRoad = (48 + 0.5) * ROW_H;
  let n = 0;
  for (let k = 0; k < 20; k++) {
    const x0 = 2 + k * 4.5;
    if (x0 > 44 && x0 < 52) continue;
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
    ru[o + 23] = 1000 + k;
    n++;
  }
  const progress = new Float32Array(LOT_ROOM + 64).fill(1);
  progress[3] = 0.4;
  progress[10] = 0.6;
  const town = new LivingTown(dev, {
    w: W,
    h: H,
    roads: mk(roads),
    heights: mk(heights),
    wet: mk(new Uint32Array(N)),
    pop: mk(pop),
    art: mk(new Uint32Array(4 + 8 * 276)),
    records: mk(ru),
    counts: mk(new Uint32Array([n, 0, RECW, LOT_ROOM])),
    progress: mk(progress),
    lotRoom: LOT_ROOM,
    centre: [48, 48 * ROW_H],
    radius: 40,
  });
  const p = LIVING_TUNING.values;
  Object.assign(p.people, { commuters: 60, farmers: 0, quarrymen: 0, stoneCarts: 0, woodcutters: 0, logCarts: 0, builders: 6, work: 2, speed: 1 });
  p.quarry.on = 0;
  p.forest.on = 0;
  const place = { dx: 0, dy: 0, dz: 0, winW: W, winH: H };
  for (let f = 0; f < 900; f++) {
    const enc = dev.createCommandEncoder();
    town.frame(enc, 0.1, place);
    dev.queue.submit([enc.finish()]);
    if (f % 100 === 99) await dev.queue.onSubmittedWorkDone();
  }
  const head = (await town.counters())!;
  expect(g.takeErrors()).toEqual([]);
  const c = (k: keyof typeof C) => head[L_C + C[k]];
  // (settled, routes traced, nobody without a route)
  expect(head[0]).toBe(2);
  expect(c('traced')).toBeGreaterThan(10);
  expect(c('miss')).toBe(0);
  expect(c('poolFull')).toBe(0);
  expect(c('arrivals')).toBeGreaterThan(60);
  // (shared: fewer routes than riders' trips — a home's route is one key however many ride it)
  const routes = head[4];
  expect(routes).toBeLessThan(c('arrivals'));
  // (the deck: a route's point on the west arm at the deck's height)
  const pts = new Float32Array(await town.debugRead(town.pts, head[3] * 16));
  let onDeck = 0;
  for (let i = 0; i < head[3]; i++) if (pts[i * 4] > 9 && pts[i * 4] < 19 && Math.abs(pts[i * 4 + 2] - 7) < 1e-3) onDeck++;
  expect(onDeck).toBeGreaterThan(0);
  // (the builders: at the two sites (progress between 0 and 1, read on the GPU), working)
  expect(c('buildWork')).toBeGreaterThan(50);
  // (Track B's interface: byte 3 of the behaviour word is its override — a rider with it set isn't stepped by its job
  // that tick, and resumes where it was once it's cleared)
  {
    const frames = async (n: number) => {
      for (let f = 0; f < n; f++) {
        const enc = dev.createCommandEncoder();
        town.frame(enc, 0.1, place);
        dev.queue.submit([enc.finish()]);
      }
      await dev.queue.onSubmittedWorkDone();
    };
    const rows = async () => new Uint32Array(await town.debugRead(town.rid, town.riders * 64));
    const before = await rows();
    // (a rider on a route leg: byte 2 forward or back)
    let k = -1;
    for (let i = 0; i < town.riders && k < 0; i++) {
      const leg = (before[i * 16 + 4] >> 16) & 0xff;
      if (leg === 1 || leg === 2) k = i;
    }
    expect(k).toBeGreaterThanOrEqual(0);
    const word = (before[k * 16 + 4] & 0x00ffffff) | (0x01 << 24);
    dev.queue.writeBuffer(town.rid, k * 64 + 16, new Uint32Array([word >>> 0]));
    await frames(40);
    const held = await rows();
    // (untouched: its position and its behaviour word, override and all)
    expect(Array.from(held.slice(k * 16, k * 16 + 8))).toEqual([...Array.from(before.slice(k * 16, k * 16 + 4)), word >>> 0, ...Array.from(before.slice(k * 16 + 5, k * 16 + 8))]);
    // (the override cleared: the job goes on from the same state)
    dev.queue.writeBuffer(town.rid, k * 64 + 16, new Uint32Array([before[k * 16 + 4]]));
    await frames(10);
    const after = await rows();
    expect(after[k * 16 + 4] >>> 24).toBe(0);
    expect(after[k * 16] !== held[k * 16] || after[k * 16 + 1] !== held[k * 16 + 1]).toBe(true);
  }
  // (the state words' size as the WGSL's)
  expect(town.lt.size).toBe(LT_WORDS * 4);
  console.log(`[living test] routes ${routes}, traced ${c('traced')}, arrivals ${c('arrivals')}, sweeps ${head[7]}, points ${head[3]}, deck points ${onDeck}, build work ${c('buildWork')}`);
  town.dispose();
}, 120_000);

test('the works kernels compile and bind (works.wgsl over the world prelude)', async () => {
  const dev = g.device;
  const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const b = (n: number, u = S) => dev.createBuffer({ size: n, usage: u });
  const town = new LivingTown(dev, { w: 64, h: 64, roads: b(64 * 64 * 4), heights: b(64 * 64 * 4), wet: b(64 * 64 * 4), pop: b(64 * 64 * 16), art: b(4096), records: b(4096), counts: b(16), progress: b(4096), lotRoom: 16, centre: [32, 28], radius: 20 });
  const works = new Works(dev, town, { globals: b(GLOBALS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), chunks: b(4096), materials: b(packMaterialTable().byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), layers: b(4096), veg: b(4096), vegNext: b(4096) });
  await dev.queue.onSubmittedWorkDone();
  expect(g.takeErrors()).toEqual([]);
  works.dispose();
  town.dispose();
});
