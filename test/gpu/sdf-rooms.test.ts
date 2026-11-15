// Rooms that grow, and the tick that fails safe (src/engine/sdf/collide.ts, rooms.ts; docs/design/PHYSICS_ENGINE.md
// "Round 6"), on the real device against brute force (test/support/sdf-coarse-ref.ts):
// - with room for an eighth of what a scene asks of every room, each tick until the rooms have grown, every row with a
//   pair the pass did not write, or a pair whose contacts it did not all make, carries a bit in `missing`; and after
//   the growth the pair set is brute force's, each pair's record is the roomy pass's, and no row is flagged;
// - each room alone: pairs past the room flag exactly their rows; work items past the room flag every row that lacks
//   a pair; sample groups past the room flag both rows of their pair;
// - oversize bodies have no room to run out of: 400 of them, awake and asleep, give the brute-force set;
// - the engine's rows past the room made for: the room doubles in that tick, and the sleepers are found again;
// - a growth makes no pipeline, and the read is one in `readEvery` ticks.
// SDF_BENCH=1 also measures the read and a growth (printed, and in data/perf/sdf/rooms-bench.json).
import fs from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MISS_GROUPS, MISS_ITEMS, MISS_PAIRS, type BodyRow } from '../../src/engine/sdf/contract';
import type { CollideOptions } from '../../src/engine/sdf/collide';
import { SdfModels } from '../../src/engine/sdf/models';
import { coarseScene, coarseShapes } from '../../src/engine/sdf/shapes';
import { testGpu, type TestGpu } from './dawn';
import { expectSafe, rig as rigOf, rowsOf, type Tick } from './sdf-collide-rig';

let g: TestGpu;
let store: SdfModels;
let ids: number[];
beforeAll(async () => {
  g = await testGpu();
  store = new SdfModels(g.device, 'grad8');
  ids = specs.map((s) => store.add(s));
  store.flush();
});
afterAll(() => {
  store?.destroy();
  g?.destroy();
});

const specs = coarseShapes();
const rig = (bodies: BodyRow[], opts: Partial<CollideOptions> = {}, rowRoom = bodies.length, bufRows = bodies.length) => rigOf({ g, store, ids, specs }, bodies, opts, rowRoom, bufRows);

test('room for an eighth of what the scene asks: while the rooms grow every row with a missing pair or contact is flagged; then the pair set is brute force’s, the records the roomy pass’s, and no row is flagged', async () => {
  const scene = coarseScene(1500, 0.7, 'pile', ids, 31);
  // what the scene asks of each room, and each pair's record, from a pass with room to spare
  const roomy = rig(scene.bodies, { readEvery: 0 });
  const full = await roomy.tick();
  const ref = roomy.brute();
  expect(expectSafe(full, ref)).toEqual([]);
  expect([full.asked.itemsDropped, full.asked.groupsDropped, full.missing.some((m) => m !== 0)]).toEqual([0, 0, false]);
  expect(full.asked.pairs).toBeGreaterThan(1000);
  roomy.destroy();

  const eighth = (n: number) => Math.ceil(n / 8);
  // (the pair slots: a table an eighth of the pairs, where it should be twice them)
  const r = rig(scene.bodies, { pairRoom: eighth(full.asked.pairs), itemRoom: eighth(full.asked.items), groupRoom: eighth(full.asked.groups), slotRoom: 256 });
  let slotless = 0;
  let ticks = 0;
  let last: Tick | null = null;
  let flaggedTicks = 0;
  for (; ticks < 16; ticks++) {
    const t = await r.tick();
    const lacks = expectSafe(t, ref);
    // a pair written whose contacts are not the roomy pass's (sample groups ran out, or it found no slot for its rows): both its rows are flagged
    const thin = t.pairs.filter((x) => t.samples.get(x) !== full.samples.get(x) || t.rowsOf.get(x) !== full.rowsOf.get(x));
    slotless += t.asked.slotFails;
    expect(thin.filter((x) => rowsOf(x).some((row) => t.missing[row] === 0)), 'pairs with contacts left out whose rows are not both flagged').toEqual([]);
    if (ticks === 0) {
      // (every room ran out at once)
      expect(lacks.length).toBeGreaterThan(full.asked.pairs / 2);
      expect(t.asked.itemsDropped).toBeGreaterThan(0);
    }
    const flagged = t.missing.some((m) => m !== 0);
    if (flagged) flaggedTicks++;
    if (!lacks.length && !thin.length && !flagged) {
      last = t;
      break;
    }
  }
  expect(last, `the rooms had not grown after ${ticks} ticks: ${JSON.stringify(r.c.rooms)}`).not.toBeNull();
  // (a clean tick can come while a room is still over half full: the reads after it finish the growth, with nothing flagged)
  for (let k = 0; k < 3; k++) expect((await r.tick()).missing.some((m) => m !== 0)).toBe(false);
  expect(new Set(r.c.growths.map((x) => x.room))).toEqual(new Set(['pairs', 'items', 'groups', 'slots']));
  expect(slotless).toBeGreaterThan(100);
  expect(r.c.rooms.slots).toBeGreaterThan(full.asked.pairs * 2);
  // (grown until what is asked is under half of each)
  expect(r.c.rooms.pairs).toBeGreaterThan(full.asked.pairs * 2);
  expect(r.c.rooms.items).toBeGreaterThan(full.asked.items * 2);
  expect(r.c.rooms.groups).toBeGreaterThan(full.asked.groups * 2);
  expect([...last!.pairs].sort()).toEqual([...full.pairs].sort());
  for (const x of full.pairs) expect([last!.samples.get(x), last!.rowsOf.get(x)]).toEqual([full.samples.get(x), full.rowsOf.get(x)]);
  // settled: more ticks grow nothing more
  const grown = r.c.growths.length;
  for (let k = 0; k < 3; k++) expect((await r.tick()).missing.some((m) => m !== 0)).toBe(false);
  expect(r.c.growths.length).toBe(grown);
  if (process.env.SDF_LOG) console.log(`rooms: clean after ${ticks + 1} ticks (${flaggedTicks} flagged), growths ${JSON.stringify(r.c.growths)}`);
  r.destroy();
});

test('pairs past the room: exactly the rows of the pairs not written are flagged (MISS_PAIRS); work items past the room: every row that lacks a pair is flagged (MISS_ITEMS)', async () => {
  const scene = coarseScene(800, 1, 'pile', ids, 4);
  // (no read: the rooms stay as made)
  let r = rig(scene.bodies, { pairRoom: 100, readEvery: 0 });
  let ref = r.brute();
  let t = await r.tick();
  expect(t.asked.pairs).toBeGreaterThan(400);
  expect(t.pairs.length).toBe(100);
  let lacks = expectSafe(t, ref);
  const rows = new Set(lacks.flatMap(rowsOf));
  // (a pair at the edge of counting may be one the GPU found and could not write)
  const edge = new Set([...ref.maybe].flatMap(rowsOf));
  for (let i = 0; i < scene.bodies.length; i++) {
    if (rows.has(i)) expect(t.missing[i]).toBe(MISS_PAIRS);
    else if (!edge.has(i)) expect(t.missing[i]).toBe(0);
  }
  r.destroy();

  r = rig(scene.bodies, { itemRoom: 200, readEvery: 0 });
  ref = r.brute();
  t = await r.tick();
  expect(t.asked.items).toBeGreaterThan(800);
  expect(t.asked.itemsDropped).toBe(t.asked.items - 200);
  lacks = expectSafe(t, ref);
  expect(lacks.length).toBeGreaterThan(100);
  expect(t.missing.every((m) => m === 0 || m === MISS_ITEMS)).toBe(true);
  r.destroy();
});

test('sample groups past the room: both rows of every pair with contacts left out are flagged (MISS_GROUPS), and no other row', async () => {
  const scene = coarseScene(600, 1, 'pile', ids, 8);
  const roomy = rig(scene.bodies, { readEvery: 0 });
  const full = await roomy.tick();
  roomy.destroy();
  const r = rig(scene.bodies, { groupRoom: Math.ceil(full.asked.groups / 4), readEvery: 0 });
  const t = await r.tick();
  expect(t.asked.groupsDropped).toBe(full.asked.groups - Math.ceil(full.asked.groups / 4));
  expect([...t.pairs].sort()).toEqual([...full.pairs].sort());
  const thin = t.pairs.filter((x) => t.samples.get(x) !== full.samples.get(x));
  expect(thin.length).toBeGreaterThan(10);
  for (const x of thin) for (const row of rowsOf(x)) expect(t.missing[row]).toBe(MISS_GROUPS);
  // (a flagged row is a row of a pair that asked for a group that found no room: every flagged row has a pair)
  const paired = new Set(t.pairs.flatMap(rowsOf));
  t.missing.forEach((m, i) => expect(m === 0 || (m === MISS_GROUPS && paired.has(i))).toBe(true));
  r.destroy();
});

test('oversize bodies have no room to run out of: 400 rows bigger than the top cell, awake and asleep, give the brute-force set', async () => {
  for (const [awake, seed] of [
    [1, 41],
    [0.3, 42],
  ] as const) {
    const scene = coarseScene(400, awake, 'pile', ids, seed);
    // (a top cell of 3 cells: even the 2³ crumb, 3.5 across, is oversize)
    const r = rig(scene.bodies, { cellTop: 3, readEvery: 0 });
    const t = await r.tick();
    expect(t.pairs.length).toBeGreaterThan(200);
    expect(expectSafe(t, r.brute())).toEqual([]);
    expect(t.missing.some((m) => m !== 0)).toBe(false);
    r.destroy();
  }
});

test('rows past the room made for: the room doubles in that tick, sleepers and all, and the pair set is brute force’s', async () => {
  const scene = coarseScene(700, 0.5, 'pile', ids, 12);
  const r = rig(scene.bodies.slice(0, 300), {}, 300, 700);
  r.set(scene.bodies.slice(0, 300), 1);
  expect(expectSafe(await r.tick(), r.brute())).toEqual([]);
  expect(r.c.rooms.rows).toBe(300);
  // 400 more rows spawn, awake and asleep (the engine bumps the epoch for the sleepers)
  r.set(scene.bodies, 2);
  const t = await r.tick();
  expect(r.c.rooms.rows).toBe(700);
  expect(r.c.growths.some((x) => x.room === 'rows' && x.from === 300)).toBe(true);
  expect(t.pairs.length).toBeGreaterThan(300);
  expect(expectSafe(t, r.brute())).toEqual([]);
  r.destroy();
});

test('a growth makes no pipeline, and the read is one in `readEvery` ticks, never waited for', async () => {
  const scene = coarseScene(500, 1, 'pile', ids, 3);
  const r = rig(scene.bodies, { pairRoom: 64, readEvery: 4 });
  const made = { pipes: 0 };
  const dev = g.device;
  const orig = dev.createComputePipeline.bind(dev);
  dev.createComputePipeline = (d: GPUComputePipelineDescriptor) => {
    made.pipes++;
    return orig(d);
  };
  try {
    const ref = r.brute();
    let clean = -1;
    for (let k = 0; k < 14; k++) {
      // (the engine's way: no waiting on the read)
      const t = await r.tick(false);
      const lacks = expectSafe(t, ref);
      if (clean < 0 && !lacks.length) clean = k;
    }
    await r.c.settled();
    expect(r.c.growths.some((x) => x.room === 'pairs')).toBe(true);
    expect(clean).toBeGreaterThan(2);
    expect(clean).toBeLessThan(14);
    expect(made.pipes).toBe(0);
    // once the rooms have grown (a read follows each growth at once): a read every fourth tick
    const grown = r.c.growths.length;
    const reads = r.c.reads;
    for (let k = 0; k < 40; k++) await r.tick(false);
    await r.c.settled();
    expect(r.c.growths.length).toBe(grown);
    expect(r.c.reads - reads).toBeGreaterThanOrEqual(9);
    expect(r.c.reads - reads).toBeLessThanOrEqual(11);
  } finally {
    dev.createComputePipeline = orig;
  }
  r.destroy();
});

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

test.skipIf(!process.env.SDF_BENCH)('the cost of the read and of a growth (desktop proxy)', async () => {
  const dev = g.device;
  const out: Record<string, unknown> = {};
  const scene = coarseScene(4096, 1, 'pile', ids, 7);
  // ---- the read: a tick's wall time (submit to the GPU done) with no read, a read every eighth tick, every tick
  for (const every of [0, 8, 1]) {
    const r = rig(scene.bodies, { readEvery: every, pairsARow: 16 });
    const wall: number[] = [];
    const cpu: number[] = [];
    const lag: number[] = [];
    for (let k = -8; k < 96; k++) {
      const enc = dev.createCommandEncoder();
      r.c.encode(enc, r.inputs, scene.bodies.length, k + 8);
      const t0 = performance.now();
      dev.queue.submit([enc.finish()]);
      const t1 = performance.now();
      r.c.poll();
      const t2 = performance.now();
      await dev.queue.onSubmittedWorkDone();
      if (k >= 0) {
        wall.push(performance.now() - t0);
        cpu.push(t2 - t1);
      }
      if (r.c.lastReadMs) lag.push(r.c.lastReadMs);
    }
    await r.c.settled();
    out[`read every ${every}`] = { tickWallMs: +median(wall).toFixed(3), pollCpuMsMean: +(cpu.reduce((s, v) => s + v, 0) / cpu.length).toFixed(4), pollCpuMsMax: +Math.max(...cpu).toFixed(3), reads: r.c.reads, readLagMs: lag.length ? +median(lag).toFixed(2) : null };
    r.destroy();
  }
  // ---- a growth: rooms an eighth of the need; each tick's wall time, and the CPU time making the buffers
  {
    const roomy = rig(scene.bodies, { readEvery: 0 });
    const full = await roomy.tick();
    roomy.destroy();
    const r = rig(scene.bodies, { pairRoom: Math.ceil(full.asked.pairs / 8), itemRoom: Math.ceil(full.asked.items / 8), groupRoom: Math.ceil(full.asked.groups / 8), readEvery: 8 });
    const ticks: { wallMs: number; encodeMs: number; grew: number }[] = [];
    for (let k = 0; k < 64; k++) {
      const grown = r.c.growths.length;
      const t0 = performance.now();
      const enc = dev.createCommandEncoder();
      r.c.encode(enc, r.inputs, scene.bodies.length, k);
      const t1 = performance.now();
      dev.queue.submit([enc.finish()]);
      r.c.poll();
      await dev.queue.onSubmittedWorkDone();
      ticks.push({ wallMs: +(performance.now() - t0).toFixed(3), encodeMs: +(t1 - t0).toFixed(3), grew: r.c.growths.length - grown });
    }
    await r.c.settled();
    const calm = ticks.filter((t) => !t.grew);
    out.growth = { rooms: r.c.rooms, growths: r.c.growths.map((x) => ({ ...x, ms: +x.ms.toFixed(3) })), growthTicks: ticks.filter((t) => t.grew), otherTicksWallMs: +median(calm.map((t) => t.wallMs)).toFixed(3), otherTicksEncodeMs: +median(calm.map((t) => t.encodeMs)).toFixed(3), bytes: r.c.bytes };
    r.destroy();
  }
  expect(g.takeErrors()).toEqual([]);
  console.log(`${g.adapterInfo}\n${JSON.stringify(out, null, 1)}`);
  fs.mkdirSync('data/perf/sdf', { recursive: true });
  fs.writeFileSync('data/perf/sdf/rooms-bench.json', JSON.stringify({ at: new Date().toISOString(), adapter: g.adapterInfo, what: 'desktop proxy, Dawn in Node (D3D12): pile, 4,096 rows all awake. The read: a tick’s wall ms (submit to GPU done) and the CPU ms inside poll(), with no read, one every 8 ticks, one every tick. A growth: every room an eighth of the need, read every 8 ticks; the ticks in which a room was made bigger against the others', ...out }, null, 1));
}, 600_000);
