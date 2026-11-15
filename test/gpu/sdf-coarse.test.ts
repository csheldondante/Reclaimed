// The coarse pass (src/engine/sdf/coarse.ts, sdf-coarse.wgsl) on the real device, against brute force on the CPU
// (test/support/sdf-coarse-ref.ts): the pair set of random scenes of mixed sizes (a 2³ crumb to a 32 × 32 × 8 slab) is
// exactly the brute-force set, each pair once; no pair of two sleepers, no row with itself, no pair whose oriented
// boxes miss; sleepers are found by the awake rows next to them, bigger or smaller; an all-asleep scene costs the one
// fixed workgroup; pairs past the buffer's room are counted; and the pairs feed the fine pass as they are.
// A pair within 0.001 cells of the edge of counting may fall either side (the GPU's floats).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { COUNT_PAIRS_DROPPED, COUNTS_BYTES, PAIR_HIT_BYTES, PAIR_HIT_ROWS, packBodies, type BodyRow } from '../../src/engine/sdf/contract';
import { PAIR_ASKED, PAIR_HEADER_WORDS, PAIR_OVERSIZE, SdfCoarse, type CoarseInputs, type CoarseOptions } from '../../src/engine/sdf/coarse';
import { SdfFine } from '../../src/engine/sdf/fine';
import { SdfModels } from '../../src/engine/sdf/models';
import { awakeList, axisAngle, bodyOf, COARSE_MAX_DIAMETER, coarseScene, coarseShapes } from '../../src/engine/sdf/shapes';
import { brutePairs } from '../support/sdf-coarse-ref';
import { testGpu, type TestGpu } from './dawn';
import { storage } from './sdf-harness';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const MARGIN = 0.25;
const specs = coarseShapes();

interface Rig {
  store: SdfModels;
  ids: number[];
  coarse: SdfCoarse;
  inputs: CoarseInputs;
  bodies: BodyRow[];
  /** the rows uploaded again, with their awake list; `epoch` as the engine would bump it */
  set(bodies: BodyRow[], epoch: number): void;
  /** one pass: the pairs written (a < b, sorted), the header, the dispatch arguments it used */
  run(): Promise<{ pairs: string[]; asked: number; oversize: number; sleeperGroups: number; pairGroups: number }>;
  expectBrute(r: { pairs: string[] }): void;
  destroy(): void;
}

function rig(bodies: BodyRow[], opts: Partial<CoarseOptions> = {}, format: 'grad8' = 'grad8'): Rig {
  const store = new SdfModels(g.device, format);
  const ids = specs.map((s) => store.add(s));
  store.flush();
  const coarse = new SdfCoarse(g.device, store, { rows: bodies.length, cellTop: COARSE_MAX_DIAMETER + MARGIN, margin: MARGIN, ...opts });
  const p = packBodies(bodies);
  const listOf = (b: BodyRow[]) => awakeList(b.map((x, i) => i).filter((i) => !b[i].asleep && !b[i].dead), b.length);
  const list = g.device.createBuffer({ label: 'test awake list', size: (8 + bodies.length) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  g.device.queue.writeBuffer(list, 0, listOf(bodies));
  const inputs: CoarseInputs = { list, pose: storage(g, 'pose', p.pose), vel: storage(g, 'vel', p.vel), info: storage(g, 'info', p.info), model: storage(g, 'model', p.model), sleepEpoch: storage(g, 'epoch', new Uint32Array([1, 0, 0, 0])) };
  const me: Rig = {
    store,
    ids,
    coarse,
    inputs,
    bodies,
    set(next, epoch) {
      me.bodies = next;
      const q = packBodies(next);
      g.device.queue.writeBuffer(inputs.pose, 0, q.pose);
      g.device.queue.writeBuffer(inputs.vel, 0, q.vel);
      g.device.queue.writeBuffer(inputs.info, 0, q.info);
      g.device.queue.writeBuffer(inputs.model, 0, q.model);
      g.device.queue.writeBuffer(list, 0, listOf(next));
      g.device.queue.writeBuffer(inputs.sleepEpoch, 0, new Uint32Array([epoch]));
    },
    async run() {
      coarse.setParams(me.bodies.length);
      const enc = g.device.createCommandEncoder();
      coarse.encode(enc, inputs);
      g.device.queue.submit([enc.finish()]);
      const head = new Uint32Array(await g.read(coarse.pairBuf, PAIR_HEADER_WORDS * 4));
      const n = Math.min(head[PAIR_ASKED], coarse.pairRoom);
      const raw = n ? new Uint32Array(await g.read(coarse.pairBuf, n * 8, PAIR_HEADER_WORDS * 4)) : new Uint32Array(0);
      const st = new Uint32Array(await g.read(coarse.state, 64));
      expect(g.takeErrors()).toEqual([]);
      const pairs: string[] = [];
      for (let k = 0; k < n; k++) pairs.push(`${Math.min(raw[2 * k], raw[2 * k + 1])},${Math.max(raw[2 * k], raw[2 * k + 1])}`);
      return { pairs: pairs.sort(), asked: head[PAIR_ASKED], oversize: head[PAIR_OVERSIZE], sleeperGroups: st[4] + st[8], pairGroups: st[12] };
    },
    expectBrute(r) {
      const ref = brutePairs(me.bodies, specs, (b) => ids.indexOf(b.model), MARGIN);
      const sure = ref.filter((x) => x.slack > 1e-3).map((x) => `${x.a},${x.b}`);
      const maybe = new Set(ref.filter((x) => Math.abs(x.slack) <= 1e-3).map((x) => `${x.a},${x.b}`));
      // each pair once
      expect(new Set(r.pairs).size).toBe(r.pairs.length);
      const got = new Set(r.pairs);
      expect(sure.filter((x) => !got.has(x)), 'brute-force pairs the GPU lacks').toEqual([]);
      const want = new Set(sure);
      expect(r.pairs.filter((x) => !want.has(x) && !maybe.has(x)), 'GPU pairs brute force lacks').toEqual([]);
      for (const x of r.pairs) {
        const [a, b] = x.split(',').map(Number);
        expect(a).not.toBe(b);
        expect(me.bodies[a].asleep && me.bodies[b].asleep).toBeFalsy();
      }
    },
    destroy() {
      coarse.destroy();
      store.destroy();
      for (const b of Object.values(inputs)) (b as GPUBuffer).destroy();
    },
  };
  return me;
}

const ids5 = [0, 1, 2, 3, 4];

test('random scenes of mixed sizes: exactly the brute-force pair set, each pair once (piles and loose fields, all awake and part asleep)', async () => {
  for (const [rows, awake, kind, seed] of [
    [600, 1, 'pile', 1],
    [600, 0.3, 'pile', 2],
    [900, 0.5, 'loose', 3],
    [300, 1, 'pile', 4],
  ] as const) {
    const scene = coarseScene(rows, awake, kind, ids5, seed);
    const r = rig(scene.bodies, { pairsARow: 64 });
    const out = await r.run();
    expect(out.asked).toBe(out.pairs.length);
    expect(out.oversize).toBe(0);
    expect(out.pairs.length).toBeGreaterThan(kind === 'pile' ? rows / 4 : 3);
    r.expectBrute(out);
    if (process.env.SDF_LOG) console.log(`coarse ${kind} ${rows} rows, ${scene.awake.length} awake: ${out.pairs.length} pairs`);
    r.destroy();
  }
});

test('one level or five: the same exact pair set', async () => {
  const scene = coarseScene(500, 0.6, 'pile', ids5, 9);
  for (const levels of [1, 2, 5]) {
    const r = rig(scene.bodies, { levels, pairsARow: 64 });
    r.expectBrute(await r.run());
    r.destroy();
  }
});

test('all asleep: no pair, and no workgroup beyond the gate’s once the sleeper hash is built', async () => {
  const scene = coarseScene(400, 0, 'pile', ids5, 5);
  const r = rig(scene.bodies);
  let out = await r.run();
  // (the first tick builds the sleeper hash)
  expect(out.sleeperGroups).toBeGreaterThan(0);
  expect([out.pairs.length, out.asked, out.pairGroups]).toEqual([0, 0, 0]);
  out = await r.run();
  expect([out.pairs.length, out.asked, out.pairGroups, out.sleeperGroups]).toEqual([0, 0, 0, 0]);
  r.destroy();
});

test('a sleeper is found by the awake body next to it, bigger or smaller; the sleeper hash follows the sleep epoch', async () => {
  const [crumb, , box, , slab] = specs;
  const bodies = [
    // an awake crumb on a sleeping slab; an awake slab over a sleeping crumb; two sleepers touching; an awake box alone
    bodyOf(crumb, 0, [3, 4, 5.1]),
    bodyOf(slab, 4, [0, 0, 0], axisAngle([0, 0, 1], 0.4), { asleep: true }),
    bodyOf(slab, 4, [100, 0, 0], axisAngle([1, 0, 0], 0.3)),
    bodyOf(crumb, 0, [108, 3, 5.4], [0, 0, 0, 1], { asleep: true }),
    bodyOf(box, 2, [200, 0, 0], [0, 0, 0, 1], { asleep: true }),
    bodyOf(box, 2, [200, 0, 7.9], [0, 0, 0, 1], { asleep: true }),
    bodyOf(box, 2, [300, 0, 0]),
  ];
  const r = rig(bodies);
  let out = await r.run();
  expect(out.pairs).toEqual(['0,1', '2,3']);
  r.expectBrute(out);
  // the box at 300 moves onto the two sleeping boxes: it meets both; they still do not meet each other
  const next = bodies.map((b) => ({ ...b }));
  next[6] = bodyOf(box, 2, [200.5, 0.5, 3.9], axisAngle([0, 1, 0], 0.2));
  r.set(next, 1);
  out = await r.run();
  expect(out.sleeperGroups).toBe(0);
  expect(out.pairs).toEqual(['0,1', '2,3', '4,6', '5,6']);
  // row 4 wakes and row 6 falls asleep (the epoch bumped): 4 meets both sleepers now; 5 and 6, both asleep, are no pair
  next[4] = { ...next[4], asleep: false };
  next[6] = { ...next[6], asleep: true };
  r.set(next, 2);
  out = await r.run();
  expect(out.sleeperGroups).toBeGreaterThan(0);
  expect(out.pairs).toEqual(['0,1', '2,3', '4,5', '4,6']);
  r.expectBrute(out);
  r.destroy();
});

test('10,000 rows with 200 awake: the brute-force set; the pass’s threads follow the awake rows', async () => {
  const scene = coarseScene(10000, 0.02, 'pile', ids5, 11);
  const r = rig(scene.bodies, { pairsARow: 8 });
  const out = await r.run();
  expect(scene.awake.length).toBeGreaterThan(150);
  expect(out.pairGroups).toBe(Math.ceil(scene.awake.length / 64));
  expect(out.pairs.length).toBeGreaterThan(scene.awake.length / 2);
  r.expectBrute(out);
  r.destroy();
}, 120_000);

test('nothing dropped unsaid: pairs past the room are counted and the fine pass says how many; a body too big for the top level is counted', async () => {
  const scene = coarseScene(3000, 1, 'pile', ids5, 4);
  const r = rig(scene.bodies, { pairsARow: 0.25 });
  const out = await r.run();
  expect(r.coarse.pairRoom).toBe(1024);
  expect(out.asked).toBeGreaterThan(1024);
  expect(out.pairs.length).toBe(1024);
  const fine = new SdfFine(g.device, r.store, { maxPairs: r.coarse.pairRoom });
  fine.setParams(r.coarse.pairRoom, 0);
  const enc = g.device.createCommandEncoder();
  fine.encode(enc, { ...r.coarse.finePairs, pose: r.inputs.pose, vel: r.inputs.vel, info: r.inputs.info, model: r.inputs.model }, r.coarse.pairRoom);
  g.device.queue.submit([enc.finish()]);
  expect(new Uint32Array(await g.read(fine.counts, COUNTS_BYTES))[COUNT_PAIRS_DROPPED]).toBe(out.asked - 1024);
  expect(g.takeErrors()).toEqual([]);
  fine.destroy();
  r.destroy();
  // a top level smaller than the 16³ boxes and the slabs: they are counted
  const small = rig(scene.bodies, { cellTop: 20, pairsARow: 64 });
  expect((await small.run()).oversize).toBe(scene.bodies.filter((b) => b.model >= 3).length);
  small.destroy();
});

test('coarse into fine: the pairs feed the fine pass as they are, and touching pairs get contact rows', async () => {
  const [, , box, , slab] = specs;
  const bodies = [bodyOf(box, 2, [3.1, 2.2, 7.8], axisAngle([0, 0, 1], 0.5)), bodyOf(slab, 4, [0, 0, 0], [0, 0, 0, 1], { asleep: true, invMass: 0 }), bodyOf(box, 2, [60, 0, 0]), bodyOf(box, 2, [60.4, 0.3, 7.7]), bodyOf(box, 2, [90, 0, 0]), bodyOf(box, 2, [90, 0, 9])];
  const r = rig(bodies);
  r.coarse.setParams(bodies.length);
  const fine = new SdfFine(g.device, r.store, { maxPairs: r.coarse.pairRoom });
  fine.setParams(r.coarse.pairRoom, 0);
  const enc = g.device.createCommandEncoder();
  r.coarse.encode(enc, r.inputs);
  fine.encode(enc, { ...r.coarse.finePairs, pose: r.inputs.pose, vel: r.inputs.vel, info: r.inputs.info, model: r.inputs.model }, r.coarse.pairRoom);
  g.device.queue.submit([enc.finish()]);
  const head = new Uint32Array(await g.read(r.coarse.pairBuf, (PAIR_HEADER_WORDS + 4) * 4));
  // the box on the slab and the two stacked boxes; the boxes a cell apart are no pair
  expect(head[PAIR_ASKED]).toBe(2);
  const hits = new Uint32Array(await g.read(fine.hits, 2 * PAIR_HIT_BYTES));
  expect(hits[PAIR_HIT_ROWS]).toBeGreaterThanOrEqual(3);
  expect(hits[32 + PAIR_HIT_ROWS]).toBeGreaterThanOrEqual(3);
  expect(g.takeErrors()).toEqual([]);
  fine.destroy();
  r.destroy();
});
