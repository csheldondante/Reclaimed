// (living town LT2, docs/design/LIVING_TOWN.md) The route graph from a citygen-shaped road raster on the GPU, the hubs'
// fields settled with no readback, routes traced and shared, riders on kinematic trips: on a 96 × 96 box with a
// crossroads (a bridge deck on the west arm), homes along the east-west road and a market district east. Commuters ride
// home → market → home; a commuter from the west rides the deck at its height; builders go to the two sites rising.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { LivingTown, C, L_C, LT_WORDS } from '../../src/citylife/living';
import { LIVING_TUNING } from '../../src/citylife/params';
import { Works } from '../../src/citylife/works';
import routereadWgsl from '../../src/shaders/routeread.wgsl?raw';
import { makeBindGroup, makeCompute } from '../../src/gpu/pipeline';
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

async function rideTown(ptsRoom?: number): Promise<Uint32Array> {
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
  // (an orphan street: a stub of road joined to nothing, with a building on it — the check must lay its passage)
  for (let x = 70; x < 90; x++) roads[80 * W + x] = 1;
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
  {
    // (the orphan street's building, fronting it from the north)
    const yR = (80 + 0.5) * ROW_H;
    const x0 = 76;
    const x1 = 79.5;
    const y0 = yR + 1.4;
    const y1 = y0 + 5;
    const o = n * RECW;
    rf.set([x0, y0, x1, y0, x1, y1, x0, y1], o);
    rf.set([x0 + 0.4, y0 + 1, x1 - 0.4, y0 + 1, x1 - 0.4, y1 - 0.4, x0 + 0.4, y1 - 0.4], o + 8);
    ru[o + 16] = 0;
    ru[o + 17] = 1;
    ru[o + 19] = 2;
    rf[o + 20] = 6;
    rf[o + 21] = 2;
    ru[o + 23] = 2000;
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
  }, LIVING_TUNING.values, ptsRoom);
  const p = LIVING_TUNING.values;
  Object.assign(p.people, { commuters: 60, farmers: 0, quarrymen: 0, stoneCarts: 0, woodcutters: 0, logCarts: 0, builders: 6, work: 2, speed: 1, spread: 0 });
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
  expect(head[0]).toBe(4);
  expect(c('traced')).toBeGreaterThan(10);
  expect(c('miss')).toBe(0);
  // (the connectivity check: the orphan street joined by a passage, nothing left cut off, every built door reached)
  expect(c('passages')).toBeGreaterThan(0);
  expect(c('cutLeft')).toBe(0);
  expect(c('doorsCut')).toBe(0);
  expect(c('poolFull')).toBe(0);
  expect(c('arrivals')).toBeGreaterThan(60);
  // (shared: fewer routes than riders' trips — a home's route is one key however many ride it)
  const routes = head[4];
  expect(routes).toBeLessThan(c('arrivals'));
  // (the deck: a route's point on the west arm at the deck's height)
  // (the points, past the route buffer's header and heads: routeread.wgsl's layout)
  const pts = new Float32Array(await town.debugRead(town.routes, (8 + 8192 * 4 + head[3] * 5) * 4)).subarray(8 + 8192 * 4);
  let onDeck = 0;
  for (let i = 0; i < head[3]; i++) if (pts[i * 5] > 9 && pts[i * 5] < 19 && Math.abs(pts[i * 5 + 2] - 7) < 1e-3) onDeck++;
  expect(onDeck).toBeGreaterThan(0);
  // (routeWidth: every traced point's free width is finite and sensible; on the open box's streets (no buildings in
  // the way: their footprints are 4 m off the road) at least a couple of metres; on the deck narrower than the open
  // road beside it — the water under it is a drop)
  let deckW = 0;
  let deckN = 0;
  let roadW = 0;
  let roadN = 0;
  for (let i = 0; i < head[3]; i++) {
    const w = pts[i * 5 + 4];
    // (a trace reserves a point or two more than it writes: those stay empty)
    if (pts[i * 5] === 0 && pts[i * 5 + 1] === 0) continue;
    expect(Number.isFinite(w) && w > 0 && w <= 12.5).toBe(true);
    if (Math.abs(pts[i * 5 + 2] - 7) < 1e-3) ((deckW += w), deckN++);
    else if (pts[i * 5] > 25 && pts[i * 5] < 44) ((roadW += w), roadN++);
  }
  expect(roadN).toBeGreaterThan(0);
  expect(roadW / roadN).toBeGreaterThan(2);
  // (the builders: at the two sites (progress between 0 and 1, read on the GPU), working)
  expect(c('buildWork')).toBeGreaterThan(50);
  // (Track B's interface: a rider whose override is set — its `overridden`, a forced stub here — is not advanced by the
  // job kernel, and its state isn't touched, so the job resumes by itself once the override's gone)
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
    town.debugOverride = k + 1;
    await frames(40);
    const held = await rows();
    expect(Array.from(held.slice(k * 16, k * 16 + 16))).toEqual(Array.from(before.slice(k * 16, k * 16 + 16)));
    town.debugOverride = 0;
    await frames(30);
    const after = await rows();
    // (resumed: it moved on, or its job stepped — its route's half may have been reused while it was held (a small pool):
    // then its leg ends where it is and the route is asked again)
    expect(after[k * 16] !== held[k * 16] || after[k * 16 + 1] !== held[k * 16 + 1] || after[k * 16 + 4] !== held[k * 16 + 4]).toBe(true);
  }
  // (the route-read contract, routeread.wgsl: every riding rider's position is routeAt(its route, its distance along);
  // its id is valid; after the pool's halves have both been reused, an id held from before is stale)
  {
    const k = makeCompute(dev, 'routeread test', [routereadWgsl, READ_TEST], { 56: 'read', 1: 'read', 2: 'rw' });
    const nR = town.riders;
    const out = dev.createBuffer({ size: nR * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readAt = async () => {
      const enc = dev.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(k.pipeline);
      cp.setBindGroup(0, makeBindGroup(dev, 'routeread test', k.layout, { 56: town.routes, 1: town.rid, 2: out }));
      cp.dispatchWorkgroups(Math.ceil(nR / 64));
      cp.end();
      dev.queue.submit([enc.finish()]);
      return new Float32Array(await town.debugRead(out, nR * 16));
    };
    const at = await readAt();
    const rows = new Float32Array(await town.debugRead(town.rid, nR * 64));
    const ru32 = new Uint32Array(rows.buffer);
    let checked = 0;
    for (let i = 0; i < nR; i++) {
      const leg = (ru32[i * 16 + 4] >> 16) & 0xff;
      if (leg !== 1 && leg !== 2) continue;
      expect(new Uint32Array(at.buffer)[i * 4 + 3]).toBe(1);
      for (let c = 0; c < 3; c++) expect(Math.abs(at[i * 4 + c] - rows[i * 16 + c])).toBeLessThan(1e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    if (ptsRoom) {
      // (an id held now, then the halves reused twice: stale)
      let k0 = -1;
      for (let i = 0; i < nR && k0 < 0; i++) if ([1, 2].includes((ru32[i * 16 + 4] >> 16) & 0xff)) k0 = i;
      const held = ru32[k0 * 16 + 5];
      const sw0 = (await town.counters())![L_C + C.switches];
      for (let f = 0; f < 3000; f++) {
        const enc = dev.createCommandEncoder();
        town.frame(enc, 0.1, place);
        dev.queue.submit([enc.finish()]);
        if (f % 100 === 99 && (await town.counters())![L_C + C.switches] >= sw0 + 2) break;
      }
      expect((await town.counters())![L_C + C.switches]).toBeGreaterThanOrEqual(sw0 + 2);
      dev.queue.writeBuffer(town.rid, k0 * 64 + 20, new Uint32Array([held]));
      // (the rider row's route word set back to the held id, read through routeValid without a frame between)
      const stale = await readAt();
      expect(new Uint32Array(stale.buffer)[k0 * 4 + 3]).toBe(0);
    }
  }
  // (the state words' size as the WGSL's)
  expect(town.lt.size).toBe(LT_WORDS * 4);
  console.log(`[living test] routes ${routes}, traced ${c('traced')}, arrivals ${c('arrivals')}, sweeps ${head[7]}, points ${head[3]}, deck points ${onDeck}, build work ${c('buildWork')}`);
  town.dispose();
  return head;
}

test('riders ride routes traced on the GPU from the road raster, over a deck at its height', async () => {
  await rideTown();
}, 120_000);

test('a small points pool switches halves and every route is traced again: no misses, riders keep arriving', async () => {
  const head = await rideTown(700);
  expect(head[L_C + C.switches]).toBeGreaterThan(0);
  expect(head[L_C + C.miss]).toBe(0);
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

/** (the route-read test) a thread a rider: routeAt(its route word, its distance along) and routeValid(its route word) */
const READ_TEST = `
@group(0) @binding(1) var<storage, read> rid: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outp: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= arrayLength(&rid) / 4u) { return; }
  let w = bitcast<u32>(rid[i * 4u + 1u].y);
  let s = rid[i * 4u + 2u].x;
  let p = routeAt(w, s);
  outp[i] = vec4<f32>(p, bitcast<f32>(select(0u, 1u, routeValid(w))));
}
`;
