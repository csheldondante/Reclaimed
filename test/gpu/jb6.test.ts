// Round 120, JB6 — the user: "I suspect it will win after JB6 since my understanding is the readbacks are very slow and it
// isn't clear what we need that for." The level's own Integrity on a tiny world on Dawn, every system stepping, as the
// default plays it on the voxel lattice — with the sections judge (judge B) it keeps no CPU copy of the columns: a cut
// that frees an overhang, a blow on sand, a blow on stone and a thing's claimed cells cut are all done with no column
// read back but what a pass fetches on purpose (a thing's claimed cells near the cut); with judge A (runs) the copy is
// kept and read before each pass, as before.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { Integrity } from '../../src/game/integrity';
import { RunsJudge, SectionsJudge } from '../../src/game/judge';
import { installPhysics } from '../../src/physics/install';
import type { Physics } from '../../src/physics/physics';
import { EventKind } from '../../src/sim/globals';
import { OP } from '../../src/sim/edit-ops';
import { cellPos } from '../../src/world/lattice';
import { readColumn, type Interval } from '../../src/world/layout';
import { OWNER_STRUCT } from '../../src/sim/external';

const W = 64;
const FLOOR = 10;
let g: TestGpu;
let w: TinyWorld;
let ig: Integrity;
let phys: Physics;

// (stone to 10; west of x 16 a sand pit on it, 4 deep; at x 40..47, y 20..27 a stone mesa to 24 whose east half hangs
// over a gap from 10 to 14 — held by its west half)
const mesa = (x: number, y: number) => x >= 40 && x < 48 && y >= 20 && y < 28;
beforeAll(async () => {
  g = await testGpu();
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/?solver=lattice'), configurable: true });
  w = await tinyWorld(
    g,
    tinyMap(W, W, 48, (x, y): Interval[] => {
      if (x < 16) return [{ z0: 0, z1: FLOOR, mat: MAT.Stone }, { z0: FLOOR, z1: FLOOR + 4, mat: MAT.Sand }];
      if (mesa(x, y)) return x < 44 ? [{ z0: 0, z1: 24, mat: MAT.Stone }] : [{ z0: 0, z1: FLOOR, mat: MAT.Stone }, { z0: 14, z1: 24, mat: MAT.Stone }];
      return [{ z0: 0, z1: FLOOR, mat: MAT.Stone }];
    }),
    'all',
    'sim',
    // (the field mesh: the rock mesh, and with it the External registry)
    { fieldMesh: true },
  );
  phys = installPhysics(w.core, { wakeOnTouch: false }).physics;
  ig = new Integrity(w.core, true);
  ig.physics = phys;
  ig.judge = new SectionsJudge();
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  w?.destroy();
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true });
});

/** n frames: a sim tick each (every system) and the integrity's update */
async function frames(n: number, each?: () => void) {
  for (let i = 0; i < n; i++) {
    w.core.sim.step(w.core.globals, () => true);
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 0));
    ig.update(1 / 60);
    each?.();
  }
}

/** the columns as the GPU has them now (the test's own read, not the integrity system's) */
async function gpuColumns(): Promise<(x: number, y: number) => Interval[]> {
  const f = await w.read('layers');
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length);
  return (x, y) => readColumn(w.core.packed, u, x, y);
}

const box = (x0: number, y0: number, z0: number, wd: number, d: number, h: number, mat: number) => {
  const out = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < wd; x++) out.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat });
  return out;
};

test('the lattice with the sections judge keeps no copy of the columns', async () => {
  expect(ig.keepsCopy).toBe(false);
  await frames(5);
  expect(ig.readBytes).toBe(0);
  expect(g.takeErrors()).toEqual([]);
});

test('a cut that frees an overhang: judged, cut out on the GPU, falling as a lattice body — nothing read back', async () => {
  const bodies0 = phys.bodies.length;
  const before = await gpuColumns();
  expect(before(46, 24).some((iv) => iv.z0 >= 14 - 1e-3 && iv.mat === MAT.Stone)).toBe(true);
  // (its hold cut: a slot through the mesa's middle, x 43..44, the whole height above the floor)
  const [cx, cy] = cellPos(44, 24);
  for (let k = 0; k < 3; k++) w.core.globals.events.push({ kind: EventKind.Edit, x: cx, y: cy - 4 + 4 * k, z: OP.SMASH * 32, radius: 2.4, strength: 18 });
  // (two cuts deep: the smash's rubble stays where it's open above — dig it all)
  for (let z = 11; z < 24; z += 3) w.core.globals.events.push({ kind: EventKind.Edit, x: cx, y: cy, z: OP.CRATER * 32, radius: 6, strength: z });
  await frames(150);
  expect(phys.bodies.length).toBeGreaterThan(bodies0);
  const after = await gpuColumns();
  // (the hanging half's stone out of the columns: it's the body's now)
  let left = 0;
  for (let y = 20; y < 28; y++) for (let x = 46; x < 48; x++) left += after(x, y).filter((iv) => iv.z0 >= 14 - 1e-3 && iv.z1 > 20 && iv.mat === MAT.Stone).length;
  expect(left).toBe(0);
  expect(ig.readBytes).toBe(0);
  expect(ig.stats.passes).toBeGreaterThan(0);
  expect(g.takeErrors()).toEqual([]);
}, 120_000);

test('a block dropped on sand sinks in (the edit pass decides): nothing read back', async () => {
  expect(ig.dropBody(box(4, 40, FLOOR + 4 + 20, 3, 3, 3, MAT.Stone))).toBe(true);
  await frames(200);
  const col = await gpuColumns();
  let lowest = Infinity;
  for (let y = 40; y < 43; y++) for (let x = 4; x < 7; x++) lowest = Math.min(lowest, Math.max(0, ...col(x, y).filter((iv) => iv.mat === MAT.Sand).map((iv) => iv.z1)));
  expect(FLOOR + 4 - lowest).toBeGreaterThan(0.3);
  expect(ig.readBytes).toBe(0);
  expect(g.takeErrors()).toEqual([]);
}, 120_000);

test('a thing\'s claimed cells cut: its columns fetched near the cut (and only those), its owner told', async () => {
  const ext = ig.external!;
  let lost = 0;
  ext.owner(OWNER_STRUCT, { name: 'test', onLost: (inst) => (lost++, ext.release(inst.id)) });
  // (a claim: its columns fetched first — round 120 JB6's columnsReady)
  const want: { x: number; y: number; z0: number; z1: number }[] = [];
  for (let y = 50; y < 53; y++) for (let x = 30; x < 33; x++) want.push({ x, y, z0: FLOOR, z1: FLOOR + 3 });
  let inst = null as ReturnType<typeof ext.claim>;
  await ig.columnsReady(want.map((c) => [c.x, c.y] as [number, number]), () => (inst = ext.claim(OWNER_STRUCT, want, MAT.Rubble)));
  expect(inst).not.toBeNull();
  const fetched = ig.readBytes;
  expect(fetched).toBeGreaterThan(0);
  const passes0 = ig.stats.passes;
  await frames(10);
  expect((await gpuColumns())(31, 51).some((iv) => iv.mat === MAT.External)).toBe(true);
  // (dug into)
  const [cx, cy] = cellPos(31, 51);
  w.core.globals.events.push({ kind: EventKind.Edit, x: cx, y: cy, z: OP.CRATER * 32, radius: 4, strength: FLOOR + 2 });
  await frames(40);
  expect(lost).toBe(1);
  // (what each pass fetched: the claimed cells' chunks — x 30..32 straddles two — of 16 x 16 columns of K slots; not
  // the window)
  const chunkBytes = 16 * 16 * w.core.packed.maxK * 16;
  expect(ig.readBytes - fetched).toBeGreaterThan(0);
  expect(ig.readBytes - fetched).toBeLessThanOrEqual((ig.stats.passes - passes0) * 2 * chunkBytes);
  // (let go to its fallback on the GPU: no External left there)
  await frames(5);
  const col = await gpuColumns();
  for (const c of want) expect(col(c.x, c.y).some((iv) => iv.mat === MAT.External), `${c.x},${c.y}`).toBe(false);
  expect(g.takeErrors()).toEqual([]);
}, 120_000);

test('with judge A (runs) the copy is kept and read before each pass', async () => {
  ig.judge = new RunsJudge();
  expect(ig.keepsCopy).toBe(true);
  const r0 = ig.readBytes;
  const [cx, cy] = cellPos(20, 10);
  w.core.globals.events.push({ kind: EventKind.Edit, x: cx, y: cy, z: OP.CRATER * 32, radius: 3, strength: FLOOR });
  await frames(40);
  expect(ig.readBytes).toBeGreaterThan(r0);
  ig.judge = new SectionsJudge();
  expect(g.takeErrors()).toEqual([]);
}, 120_000);
