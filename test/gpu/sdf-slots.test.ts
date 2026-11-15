// Stable pair slots (src/engine/sdf/fine.ts, sdf-fine.wgsl "Stable pair slots"; docs/design/PHYSICS_ENGINE.md
// "Round 6") on the real device. A pair's contact rows are at slot * 4, and the slot is the pair's for as long as the
// pair is in the pair list every pass:
// - a resting stack keeps identical slots over 100 passes, whatever the list's order and whichever body is named first;
// - a pair absent for one pass has lost its slot: back again it starts with age 0 and zeroed rows;
// - two pairs never share a slot, and a slot's key record names its pair (a pile of 1,100 rows; a churn of pairs);
// - released slots are reused: 720 claims of 168 different pairs through a table of 64;
// - a growth keeps every live key with its age and its rows, and says where each slot went;
// - a pair that finds no slot has no rows and both its body rows are flagged; the table then grows (by load, before
//   any pair fails, when it is half full).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { CONTACT_BYTES, CONTACTS_PER_PAIR, MISS_SLOTS, NO_SLOT, SLOT_KEY_AGE, SLOT_KEY_BYTES, unpackContacts, type BodyRow, type Contact } from '../../src/engine/sdf/contract';
import { SdfModels } from '../../src/engine/sdf/models';
import { axisAngle, bodyOf, boxShape, coarseScene, coarseShapes } from '../../src/engine/sdf/shapes';
import { testGpu, type TestGpu } from './dawn';
import { expectSafe, rig } from './sdf-collide-rig';
import { makeScene, type RunResult, type Scene } from './sdf-harness';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const box = boxShape(8, 8, 8);
/** a small generator, so every run shuffles the same way */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** the scene's pair list as given, uploaded with its count (the list's object is the one the harness reads) */
function setPairs(scene: Scene, list: number[]): void {
  scene.pairs.length = 0;
  scene.pairs.push(...list);
  const buf = new Uint32Array(Math.max(list.length, 2));
  buf.set(list);
  g.device.queue.writeBuffer(scene.inputs.pairs as GPUBuffer, 0, buf);
  g.device.queue.writeBuffer(scene.inputs.pairCount as GPUBuffer, 0, new Uint32Array([list.length / 2]));
}

const keyOf = (scene: Scene, p: number) => `${Math.min(scene.pairs[2 * p], scene.pairs[2 * p + 1])},${Math.max(scene.pairs[2 * p], scene.pairs[2 * p + 1])}`;

/** every pair of a pass has a slot of its own, and the slot's key record names it. Returns key → slot */
function expectSlots(scene: Scene, r: RunResult): Map<string, number> {
  const out = new Map<string, number>();
  r.pairs.forEach((p, i) => {
    const key = keyOf(scene, i);
    expect(p.slot, `pair ${key} has no slot`).not.toBe(NO_SLOT);
    expect(p.slot).toBeLessThan(scene.fine.slots);
    expect(`${p.key[0]},${p.key[1]}`).toBe(key);
    for (const row of p.rows) expect([Math.min(row.a, row.b), Math.max(row.a, row.b)].join(',')).toBe(key);
    out.set(key, p.slot);
  });
  expect(new Set(out.values()).size, 'two pairs share a slot').toBe(out.size);
  return out;
}

const zero = (c: Contact) => c.a === 0 && c.b === 0 && c.energy === 0 && c.depth === 0 && c.closing === 0 && c.point.every((v) => v === 0) && c.normal.every((v) => v === 0);
const same = (a: Contact[], b: Contact[]) => JSON.stringify(a) === JSON.stringify(b);

/** six 8³ boxes stacked 0.3 cells into each other */
const stack = (): BodyRow[] => [0, 1, 2, 3, 4, 5].map((k) => bodyOf(box, 0, [0.4 * k, 0.3 * k, 7.7 * k], axisAngle([0, 0, 1], 0.1 * k)));
const stackPairs = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5];

test('a resting stack keeps identical slots over 100 passes: the list shuffled and either body first, each pair’s slot, age and rows stay', async () => {
  const scene = makeScene(g, 'grad8', [box], stack(), [...stackPairs], { maxPairs: 8 });
  const R = rng(5);
  const first = await scene.run(0);
  const slots = expectSlots(scene, first);
  const rows0 = new Map(first.pairs.map((p, i) => [keyOf(scene, i), p.slotRows]));
  expect(first.pairs.every((p) => p.age === 0 && p.rows.length >= 3)).toBe(true);
  for (let t = 1; t < 100; t++) {
    // the five pairs in a new order; from pass 50 on, some with their bodies the other way round
    const order = [0, 1, 2, 3, 4].sort(() => R() - 0.5);
    const list = order.flatMap((p) => (t >= 50 && R() < 0.5 ? [stackPairs[2 * p + 1], stackPairs[2 * p]] : [stackPairs[2 * p], stackPairs[2 * p + 1]]));
    setPairs(scene, list);
    const r = await scene.run(t);
    const now = expectSlots(scene, r);
    expect([...now].sort()).toEqual([...slots].sort());
    r.pairs.forEach((p, i) => {
      expect(p.age).toBe(t);
      // (the bodies as first given: the rows are the same bits in the same places)
      if (list[2 * i] < list[2 * i + 1]) expect(same(p.slotRows, rows0.get(keyOf(scene, i))!), `pass ${t}: a pair's rows moved or changed`).toBe(true);
    });
  }
  scene.destroy();
});

test('a pair absent for one pass has lost its slot: back again it has age 0 and zeroed rows; the pair that stayed keeps slot and age', async () => {
  // boxes 0 and 1 deep in each other (four rows); 2 and 3 likewise, and never absent
  const deep: BodyRow[] = [bodyOf(box, 0, [0, 0, 0]), bodyOf(box, 0, [2.1, 1.2, 6.4], axisAngle([0, 0, 1], 0.3)), bodyOf(box, 0, [40, 0, 0]), bodyOf(box, 0, [41.3, 2.2, 6.6], axisAngle([1, 0, 0], 0.2))];
  const scene = makeScene(g, 'grad8', [box], deep, [0, 1, 2, 3], { maxPairs: 4 });
  let r = await scene.run(0);
  for (let t = 1; t < 3; t++) r = await scene.run(t);
  const before = expectSlots(scene, r);
  expect(r.pairs.map((p) => p.age)).toEqual([2, 2]);
  expect(r.pairs[0].rows.length).toBe(4);
  // pass 3: the first pair is not in the list
  setPairs(scene, [2, 3]);
  r = await scene.run(3);
  expect(r.pairs.map((p) => p.age)).toEqual([3]);
  // pass 4: it is back, now a corner of box 1 just inside box 0's top face: fewer rows than the slot held
  const next = deep.map((b) => ({ ...b }));
  next[1] = bodyOf(box, 0, [0.5, 0.3, 4 + Math.sqrt(48) - 0.4], axisAngle([1, -1, 0], Math.acos(1 / Math.sqrt(3))));
  scene.setBodies(next);
  setPairs(scene, [0, 1, 2, 3]);
  r = await scene.run(4);
  const after = expectSlots(scene, r);
  expect(after.get('2,3')).toBe(before.get('2,3'));
  expect(r.pairs.map((p) => p.age)).toEqual([0, 4]);
  expect(r.pairs[0].rows.length).toBeGreaterThanOrEqual(1);
  expect(r.pairs[0].rows.length).toBeLessThan(4);
  // the slot is clean: the rows the pair did not write this pass are zero, not what it or any pair left there
  for (const row of r.pairs[0].slotRows.slice(r.pairs[0].rows.length)) expect(zero(row)).toBe(true);
  // and a pass later the pair has kept it
  r = await scene.run(5);
  expect(expectSlots(scene, r).get('0,1')).toBe(after.get('0,1'));
  expect(r.pairs.map((p) => p.age)).toEqual([1, 5]);
  scene.destroy();
});

test('released slots are reused, and two pairs never share one: 720 claims of 168 pairs through a table of 64, four pairs that stay keeping theirs', async () => {
  // (a slot is given to every pair of the list, touching or not: 140 boxes far apart)
  const bodies = Array.from({ length: 140 }, (_, i) => bodyOf(box, 0, [i * 30, 0, 0]));
  const listAt = (t: number) => [...Array.from({ length: 24 }, (_, i) => [i, i + 1 + (t % 7)]), ...[100, 102, 104, 106].map((i) => [i, i + 1])].flat();
  const scene = makeScene(g, 'grad8', [box], bodies, listAt(0), { maxPairs: 28, slots: 64 });
  let stay: Map<string, number> | null = null;
  for (let t = 0; t < 30; t++) {
    setPairs(scene, listAt(t));
    const r = await scene.run(t);
    const now = expectSlots(scene, r);
    // (24 pairs new this pass: none was in the last one's list; the four that stay age)
    expect(r.pairs.slice(0, 24).every((p) => p.age === 0)).toBe(true);
    expect(r.pairs.slice(24).map((p) => p.age)).toEqual([t, t, t, t]);
    const kept = new Map([...now].filter(([k]) => Number(k.split(',')[0]) >= 100));
    if (stay) expect([...kept].sort()).toEqual([...stay].sort());
    stay = kept;
    expect(r.missing.some((m) => m !== 0)).toBe(false);
  }
  scene.destroy();
});

test('a growth of the table keeps every live key with its age and its rows, and says where each slot went', async () => {
  const scene = makeScene(g, 'grad8', [box], stack(), [...stackPairs], { maxPairs: 8, slots: 64 });
  let r = await scene.run(0);
  for (let t = 1; t < 5; t++) r = await scene.run(t);
  const before = expectSlots(scene, r);
  const rowsBefore = new Map(r.pairs.map((p, i) => [keyOf(scene, i), p.slotRows]));
  // ---- a growth with the pairs there: each one's slot is where the remap says, its age goes on
  scene.fine.grow({ slots: 256 });
  r = await scene.run(5);
  expect([scene.fine.slots, scene.fine.slotGeneration]).toEqual([256, 1]);
  let remap = new Uint32Array(await g.read(scene.fine.slotRemap!, 64 * 4));
  const mid = expectSlots(scene, r);
  for (const [key, slot] of before) expect(mid.get(key)).toBe(remap[slot]);
  // (every other old slot went nowhere)
  expect([...remap].filter((x) => x !== NO_SLOT).length).toBe(before.size);
  expect(r.pairs.map((p) => p.age)).toEqual([5, 5, 5, 5, 5]);
  r.pairs.forEach((p, i) => expect(same(p.slotRows, rowsBefore.get(keyOf(scene, i))!)).toBe(true));
  // ---- a growth in a pass with no pair at all: what is in the new table is the move's own work
  scene.fine.grow({ slots: 1024 });
  const keep = [...scene.pairs];
  setPairs(scene, []);
  await scene.run(6);
  remap = new Uint32Array(await g.read(scene.fine.slotRemap!, 256 * 4));
  const all = unpackContacts(await g.read(scene.fine.contacts, 1024 * CONTACTS_PER_PAIR * CONTACT_BYTES), 1024 * CONTACTS_PER_PAIR);
  const keys = new Uint32Array(await g.read(scene.fine.slotKeys, 1024 * SLOT_KEY_BYTES));
  for (const [key, slot] of mid) {
    const to = remap[slot];
    expect(to).not.toBe(NO_SLOT);
    expect(`${keys[to * 4]},${keys[to * 4 + 1]}`).toBe(key);
    expect(keys[to * 4 + SLOT_KEY_AGE]).toBe(5);
    expect(same(all.slice(to * 4, to * 4 + 4), rowsBefore.get(key)!)).toBe(true);
  }
  // the pairs back after their pass away: new slots' worth of age, as for any pair that was absent
  setPairs(scene, keep);
  r = await scene.run(7);
  expectSlots(scene, r);
  expect(r.pairs.map((p) => p.age)).toEqual([0, 0, 0, 0, 0]);
  scene.destroy();
});

test('a pair that finds no slot has no rows and both its body rows are flagged (MISS_SLOTS); the pairs with a slot are whole', async () => {
  // twelve touching pairs and a table of four entries
  const bodies = Array.from({ length: 12 }, (_, i) => [bodyOf(box, 0, [i * 40, 0, 0]), bodyOf(box, 0, [i * 40 + 2.1, 1.2, 7.7])]).flat();
  const list = Array.from({ length: 12 }, (_, i) => [2 * i, 2 * i + 1]).flat();
  const scene = makeScene(g, 'grad8', [box], bodies, list, { maxPairs: 12, slots: 4 });
  const r = await scene.run(0);
  const got = r.pairs.filter((p) => p.slot !== NO_SLOT);
  expect(got.length).toBe(4);
  expect(new Set(got.map((p) => p.slot)).size).toBe(4);
  r.pairs.forEach((p, i) => {
    if (p.slot === NO_SLOT) {
      expect(p.rows.length).toBe(0);
      expect([r.missing[2 * i], r.missing[2 * i + 1]]).toEqual([MISS_SLOTS, MISS_SLOTS]);
    } else {
      expect(p.rows.length).toBeGreaterThanOrEqual(3);
      expect([r.missing[2 * i], r.missing[2 * i + 1]]).toEqual([0, 0]);
    }
  });
  scene.destroy();
});

test('a pile of 1,100 rows through both passes: every pair a slot of its own with its key beside it; the table grows at half full with no pair failing, and every pair keeps its age through the growth', async () => {
  const store = new SdfModels(g.device, 'grad8');
  const specs = coarseShapes();
  const ids = specs.map((s) => store.add(s));
  store.flush();
  const scene = coarseScene(1100, 0.7, 'pile', ids, 31);
  // (a table of 2,048 for 1,234 pairs: over half full, so the first read grows it; not so full that a pair's 32 probes all miss)
  const r = rig({ g, store, ids, specs }, scene.bodies, { slotRoom: 2048, pairsARow: 16 });
  const ref = r.brute();
  let pairs = 0;
  for (let t = 0; t < 6; t++) {
    const tick = await r.tick();
    expect(expectSafe(tick, ref)).toEqual([]);
    expect(tick.missing.some((m) => m !== 0)).toBe(false);
    expect(tick.asked.slotFails).toBe(0);
    pairs = tick.pairs.length;
    expect(pairs).toBeGreaterThan(1024);
    expect(new Set(tick.slotOf.values()).size).toBe(pairs);
    for (const key of tick.pairs) {
      expect(tick.slotOf.get(key)).not.toBe(NO_SLOT);
      expect(tick.keyed.get(key), `the slot of ${key} does not name it`).toBe(true);
      expect(tick.ageOf.get(key)).toBe(t);
    }
  }
  expect(r.c.growths.filter((x) => x.room === 'slots').map((x) => [x.from, x.to])).toEqual([[2048, 4096]]);
  expect(r.c.fine.slotGeneration).toBe(1);
  r.destroy();
  store.destroy();
});
