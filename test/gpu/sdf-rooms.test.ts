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
import { MISS_GROUPS, MISS_ITEMS, MISS_PAIRS, PAIR_HIT_BYTES, PAIR_HIT_ROWS, PAIR_HIT_SAMPLES, packBodies, type BodyRow } from '../../src/engine/sdf/contract';
import { PAIR_ASKED, PAIR_HEADER_WORDS, PAIR_ITEMS_ASKED, PAIR_ITEMS_DROPPED, type CoarseInputs } from '../../src/engine/sdf/coarse';
import { SdfCollide, type CollideOptions } from '../../src/engine/sdf/collide';
import { COUNT_BRICKS, COUNT_BRICKS_DROPPED, COUNTS_BYTES } from '../../src/engine/sdf/contract';
import { SdfModels } from '../../src/engine/sdf/models';
import { awakeList, COARSE_MAX_DIAMETER, coarseScene, coarseShapes } from '../../src/engine/sdf/shapes';
import { brutePairs } from '../support/sdf-coarse-ref';
import { testGpu, type TestGpu } from './dawn';
import { storage } from './sdf-harness';

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

const MARGIN = 0.25;
const specs = coarseShapes();

interface Tick {
  /** the pairs written, 'lo,hi', in the list's order, and each one's record: sample contacts and rows */
  pairs: string[];
  samples: Map<string, number>;
  rowsOf: Map<string, number>;
  /** the rows' `missing` words */
  missing: Uint32Array;
  asked: { pairs: number; items: number; itemsDropped: number; groups: number; groupsDropped: number };
}

interface Rig {
  c: SdfCollide;
  bodies: BodyRow[];
  inputs: CoarseInputs;
  /** the rows uploaded again (as many or more), `epoch` as the engine would bump it */
  set(bodies: BodyRow[], epoch: number): void;
  /** one tick: encode, submit, poll; then what it wrote. `wait`: let the read land first (a test's ticks; the engine never waits) */
  tick(wait?: boolean): Promise<Tick>;
  brute(): { sure: string[]; maybe: Set<string> };
  destroy(): void;
}

function rig(bodies: BodyRow[], opts: Partial<CollideOptions> = {}, rowRoom = bodies.length, bufRows = bodies.length): Rig {
  const dev = g.device;
  const mk = (b: BodyRow[], room: number) => {
    const p = packBodies(b);
    const grown = <T extends Float32Array | Uint32Array>(a: T, per: number): T => {
      const out = new (a.constructor as new (n: number) => T)(room * per);
      out.set(a);
      return out;
    };
    return { pose: grown(p.pose, 16), vel: grown(p.vel, 8), info: grown(p.info, 12), model: grown(p.model, 1), list: awakeList(b.map((_, i) => i).filter((i) => !b[i].asleep && !b[i].dead), room) };
  };
  // (the engine's own buffers: room for the rows a test ends with)
  const room = Math.max(bufRows, bodies.length);
  const first = mk(bodies, room);
  const list = dev.createBuffer({ label: 'test awake list', size: first.list.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(list, 0, first.list);
  const inputs: CoarseInputs = { list, pose: storage(g, 'pose', first.pose), vel: storage(g, 'vel', first.vel), info: storage(g, 'info', first.info), model: storage(g, 'model', first.model), sleepEpoch: storage(g, 'epoch', new Uint32Array([1, 0, 0, 0])) };
  // (no sample cap: every sample every tick, so a pair's record is the same from tick to tick)
  const c = new SdfCollide(dev, store, { rows: rowRoom, cellTop: COARSE_MAX_DIAMETER + MARGIN, margin: MARGIN, readEvery: 1, cap: 1 << 16, ...opts });
  let n = 0;
  const me: Rig = {
    c,
    bodies,
    inputs,
    set(next, epoch) {
      me.bodies = next;
      const q = mk(next, room);
      dev.queue.writeBuffer(inputs.pose, 0, q.pose);
      dev.queue.writeBuffer(inputs.vel, 0, q.vel);
      dev.queue.writeBuffer(inputs.info, 0, q.info);
      dev.queue.writeBuffer(inputs.model, 0, q.model);
      dev.queue.writeBuffer(list, 0, q.list);
      dev.queue.writeBuffer(inputs.sleepEpoch, 0, new Uint32Array([epoch]));
    },
    async tick(wait = true) {
      const enc = dev.createCommandEncoder();
      c.encode(enc, inputs, me.bodies.length, n++);
      dev.queue.submit([enc.finish()]);
      // (read before the poll: its read clears the high-water words, and a growth replaces the buffers)
      const head = new Uint32Array(await g.read(c.coarse.pairBuf, PAIR_HEADER_WORDS * 4));
      const k = Math.min(head[PAIR_ASKED], c.coarse.pairRoom);
      const raw = k ? new Uint32Array(await g.read(c.coarse.pairBuf, k * 8, PAIR_HEADER_WORDS * 4)) : new Uint32Array(0);
      const hits = k ? new Uint32Array(await g.read(c.fine.hits, k * PAIR_HIT_BYTES)) : new Uint32Array(0);
      const counts = new Uint32Array(await g.read(c.fine.counts, COUNTS_BYTES));
      const missing = new Uint32Array(await g.read(c.missing, me.bodies.length * 4));
      c.poll();
      if (wait) await c.settled();
      expect(g.takeErrors()).toEqual([]);
      const out: Tick = { pairs: [], samples: new Map(), rowsOf: new Map(), missing, asked: { pairs: head[PAIR_ASKED], items: head[PAIR_ITEMS_ASKED], itemsDropped: head[PAIR_ITEMS_DROPPED], groups: counts[COUNT_BRICKS], groupsDropped: counts[COUNT_BRICKS_DROPPED] } };
      for (let i = 0; i < k; i++) {
        const key = `${Math.min(raw[2 * i], raw[2 * i + 1])},${Math.max(raw[2 * i], raw[2 * i + 1])}`;
        out.pairs.push(key);
        out.samples.set(key, hits[i * 32 + PAIR_HIT_SAMPLES]);
        out.rowsOf.set(key, hits[i * 32 + PAIR_HIT_ROWS]);
      }
      return out;
    },
    brute() {
      const ref = brutePairs(me.bodies, specs, (b) => ids.indexOf(b.model), MARGIN);
      return { sure: ref.filter((x) => x.slack > 1e-3).map((x) => `${x.a},${x.b}`), maybe: new Set(ref.filter((x) => Math.abs(x.slack) <= 1e-3).map((x) => `${x.a},${x.b}`)) };
    },
    destroy() {
      c.destroy();
      for (const b of Object.values(inputs)) (b as GPUBuffer).destroy();
    },
  };
  return me;
}

const rowsOf = (key: string) => key.split(',').map(Number);

/** a tick against brute force: no pair twice, none that brute force lacks; and every row of a pair the tick lacks is flagged. Returns the pairs it lacks */
function expectSafe(t: Tick, ref: { sure: string[]; maybe: Set<string> }): string[] {
  expect(new Set(t.pairs).size).toBe(t.pairs.length);
  const got = new Set(t.pairs);
  const want = new Set(ref.sure);
  expect(t.pairs.filter((x) => !want.has(x) && !ref.maybe.has(x)), 'GPU pairs brute force lacks').toEqual([]);
  const lacks = ref.sure.filter((x) => !got.has(x));
  const bare = lacks.filter((x) => rowsOf(x).some((r) => t.missing[r] === 0));
  expect(bare, 'pairs not written whose rows are not both flagged').toEqual([]);
  return lacks;
}

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
  const r = rig(scene.bodies, { pairRoom: eighth(full.asked.pairs), itemRoom: eighth(full.asked.items), groupRoom: eighth(full.asked.groups) });
  let ticks = 0;
  let last: Tick | null = null;
  let flaggedTicks = 0;
  for (; ticks < 16; ticks++) {
    const t = await r.tick();
    const lacks = expectSafe(t, ref);
    // a pair written whose contacts are not the roomy pass's (sample groups ran out): both its rows are flagged
    const thin = t.pairs.filter((x) => t.samples.get(x) !== full.samples.get(x));
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
  expect(new Set(r.c.growths.map((x) => x.room))).toEqual(new Set(['pairs', 'items', 'groups']));
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
    // 14 ticks: a read every fourth and one more right after a growth; far from one a tick
    expect(r.c.reads).toBeGreaterThanOrEqual(3);
    expect(r.c.reads).toBeLessThanOrEqual(7);
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
