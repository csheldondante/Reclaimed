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
  // (stone to 10; west of x 16 a sand pit on it, 4 deep: its top at 14)
  w = await tinyWorld(g, tinyMap(W, W, 48, (x) => (x < 16 ? [{ z0: 0, z1: FLOOR, mat: MAT.Stone }, { z0: FLOOR, z1: FLOOR + 4, mat: MAT.Sand }] : [{ z0: 0, z1: FLOOR, mat: MAT.Stone }])), 'all');
  phys = installPhysics(w.core, { wakeOnTouch: false }).physics;
  ig = new Integrity(w.core, true);
  ig.physics = phys;
  await ig.columnsReady([], () => {});
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

/** (round 120, JB6: the blows are the edit pass's, on the GPU) the columns as the GPU has them now */
async function gpuColumns(): Promise<(x: number, y: number) => import('../../src/world/layout').Interval[]> {
  const { readColumn } = await import('../../src/world/layout');
  const f = await w.read('layers');
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
  return (x, y) => readColumn(w.core.packed, u, x, y);
}
/** columns in [x0, x1) × [y0, y1) whose stone at z (just under the floor's top) is gone or broken */
async function broken(x0: number, y0: number, x1: number, y1: number, z = FLOOR - 0.5): Promise<number> {
  const col = await gpuColumns();
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!col(x, y).some((iv) => iv.mat === MAT.Stone && iv.z0 <= z && iv.z1 > z)) n++;
  return n;
}

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
  const orig = ig.groundBlow.bind(ig);
  if (process.env.SOLVER_LOG) ig.groundBlow = (x, y, z, e, r) => (console.log('blow', x.toFixed(1), y.toFixed(1), z.toFixed(1), Math.round(e)), orig(x, y, z, e, r));
  // light: a small stone block set down from a cell up
  ig.dropBody(box(40, 40, FLOOR + 1, 2, 2, 2, MAT.Stone));
  await frames(90);
  expect(await broken(36, 36, 46, 46)).toBe(0);
  // heavy: a big stone block from 28 up
  expect(await broken(34, 4, 52, 20)).toBe(0);
  expect(ig.dropBody(box(40, 10, FLOOR + 28, 6, 4, 4, MAT.Stone))).toBe(true);
  await frames(240);
  expect(await broken(34, 4, 52, 20)).toBeGreaterThan(0);
  expect(g.takeErrors()).toEqual([]);
});

test("the voxel lattice's blows reach the ground too (the hybrid's tanker on stone)", async () => {
  expect(await broken(26, 46, 42, 58)).toBe(0);
  expect(ig.dropBody(box(30, 50, FLOOR + 24, 8, 3, 3, MAT.Steel))).toBe(true);
  await frames(220);
  expect(await broken(26, 46, 42, 58)).toBeGreaterThan(0);
  expect(g.takeErrors()).toEqual([]);
});

// (round 120, the user: "when bodies hit the ground with heavy impacts in soft material like sand or dirt they should
// displace material … push into the ground a bit")
test('a block dropped on sand sinks in, deeper from higher; a rim round the dent; no bounce', async () => {
  const dent = async (x0: number, h: number) => {
    const b0 = ig.stats.blows;
    let up = 0;
    expect(ig.dropBody(box(x0, 30, FLOOR + 4 + h, 3, 3, 3, MAT.Stone))).toBe(true);
    const b = ig.rigid!.list[ig.rigid!.list.length - 1];
    let landed = false;
    await frames(Math.round(60 * Math.sqrt((2 * h) / 9.8)) + 120, () => {
      if (!ig.rigid!.list.includes(b)) return;
      if (b.contact) landed = true;
      if (landed) up = Math.max(up, b.v[2]);
    });
    expect(ig.stats.blows).toBeGreaterThan(b0);
    // (the sand dug out under it: the sand's own top — what it shattered into, or a resting body's External cells,
    // lie on it after — under the footprint, deepest)
    const col = await gpuColumns();
    const sandTop = (x: number, y: number) => Math.max(0, ...col(x, y).filter((iv) => iv.mat === MAT.Sand).map((iv) => iv.z1));
    let lowest = Infinity;
    for (let y = 30; y < 33; y++) for (let x = x0; x < x0 + 3; x++) lowest = Math.min(lowest, sandTop(x, y));
    return { depth: FLOOR + 4 - lowest, up };
  };
  const low = await dent(2, 3);
  const high = await dent(9, 24);
  if (process.env.SOLVER_LOG) console.log('sand dent from 3:', low, 'from 24:', high);
  expect(high.depth).toBeGreaterThan(low.depth);
  expect(high.depth).toBeGreaterThan(0.3);
  // no rebound off the sand
  expect(low.up).toBeLessThan(1);
  expect(high.up).toBeLessThan(1);
  expect(g.takeErrors()).toEqual([]);
});

test('a block dropped on stone does not sink', async () => {
  expect(ig.dropBody(box(50, 30, FLOOR + 10, 3, 3, 3, MAT.Stone))).toBe(true);
  await frames(150);
  // (no dent: the stone's top where it lies as it was)
  const col = await gpuColumns();
  for (let y = 28; y < 36; y++)
    for (let x = 48; x < 56; x++) {
      const ground = col(x, y).filter((iv) => iv.mat === MAT.Stone);
      expect(ground[ground.length - 1].z1, `${x},${y}`).toBeGreaterThanOrEqual(FLOOR - 1e-3);
    }
});

// (round 120, the user's rule: no GPU memory caps) the lattice's mesh room grows on demand to what the device holds
test("the voxel lattice's mesh room grows past its start, within the device's bindings", async () => {
  const p = phys as unknown as { growSkin(t: number): boolean; skinRoom: number; skinMost(): number };
  const start = p.skinRoom;
  expect(p.growSkin(start * 3)).toBe(true);
  expect(p.skinRoom).toBeGreaterThanOrEqual(start * 3);
  expect(p.growSkin(p.skinMost() + 1)).toBe(false);
  // (the bodies made before and after draw on: the kernels bound to the new buffers)
  expect(ig.dropBody(box(30, 40, FLOOR + 6, 4, 2, 2, MAT.Steel))).toBe(true);
  await frames(30);
  expect(g.takeErrors()).toEqual([]);
});
