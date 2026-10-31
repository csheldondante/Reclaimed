// Round 120, the user on 6aef66e: "the tower toppling does not wake up the tanker on top of it so the tanker floats until
// touched" and "dropping the tanker in a stone does not trigger breaking and it probably should". The level's own
// Integrity (the judge, the rigid rock, the node solver, the voxel lattice) on a tiny world on Dawn, every system
// stepping: a lattice sleeper wakes when what holds it goes; a hard blow on stone crumbles it, a light one doesn't.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { Integrity } from '../../src/game/integrity';
import { installPhysics } from '../../src/physics/install';
import type { Physics } from '../../src/physics/physics';

const W = 64;
const FLOOR = 10;
let g: TestGpu;
let w: TinyWorld;
let ig: Integrity;
let phys: Physics;

beforeAll(async () => {
  g = await testGpu();
  // (the hybrid variant: rock on the node solver, metal on the voxel lattice)
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/?solver=hybrid'), configurable: true });
  w = await tinyWorld(g, tinyMap(W, W, 48), 'all');
  phys = installPhysics(w.core, { wakeOnTouch: false }).physics;
  ig = new Integrity(w.core, true);
  ig.physics = phys;
  await ig.ensureCopy();
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  w?.destroy();
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true });
});

/** n frames: a sim tick each (every system, the ones added since too) and the integrity's update */
async function frames(n: number, each?: () => void) {
  for (let i = 0; i < n; i++) {
    w.core.sim.step(w.core.globals, () => true);
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 0));
    ig.update(1 / 60);
    each?.();
  }
}

const box = (x0: number, y0: number, z0: number, wd: number, d: number, h: number, mat: number) => {
  const out = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < wd; x++) out.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat });
  return out;
};
const asleep = (id: number) => (phys as unknown as { asleep: Set<number> }).asleep.has(id);

test('no GPU validation errors', async () => {
  await frames(5);
  expect(g.takeErrors()).toEqual([]);
});

test('a lattice sleeper wakes when a rock body goes by it (it slept on what moved away: the tanker on the tower)', async () => {
  // a steel slab on the floor, left to sleep
  expect(ig.dropBody(box(20, 20, FLOOR, 6, 2, 1, MAT.Steel))).toBe(true);
  const body = phys.bodies[phys.bodies.length - 1];
  await frames(150);
  expect(asleep(body.id)).toBe(true);
  // a stone block falls past it, beside it (it doesn't touch it)
  expect(ig.dropBody(box(27, 20, FLOOR + 12, 3, 3, 3, MAT.Stone))).toBe(true);
  let woke = false;
  await frames(60, () => (woke ||= !asleep(body.id)));
  expect(woke).toBe(true);
  expect(g.takeErrors()).toEqual([]);
});

test('a heavy blow on stone crumbles it where it struck; a light one leaves it whole', async () => {
  const before = ig.stats.groundBlows;
  const orig = ig.groundBlow.bind(ig);
  if (process.env.SOLVER_LOG) ig.groundBlow = (x, y, z, e) => (console.log('blow', x.toFixed(1), y.toFixed(1), z.toFixed(1), Math.round(e)), orig(x, y, z, e));
  // light: a small stone block set down from a cell up
  ig.dropBody(box(40, 40, FLOOR + 1, 2, 2, 2, MAT.Stone));
  await frames(90);
  expect(ig.stats.groundBlows).toBe(before);
  // heavy: a big stone block from 28 up
  expect(ig.dropBody(box(40, 10, FLOOR + 28, 6, 4, 4, MAT.Stone))).toBe(true);
  await frames(240);
  expect(ig.stats.groundBlows).toBeGreaterThan(before);
  expect(g.takeErrors()).toEqual([]);
});

test("the voxel lattice's blows reach the ground too (the hybrid's tanker on stone)", async () => {
  const before = ig.stats.groundBlows;
  expect(ig.dropBody(box(14, 44, FLOOR + 24, 8, 3, 3, MAT.Steel))).toBe(true);
  await frames(220);
  expect(ig.stats.groundBlows).toBeGreaterThan(before);
  expect(g.takeErrors()).toEqual([]);
});
