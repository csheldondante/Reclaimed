// Round 120, the user on 42335d9: "The rocks do look better with the nodes but largely because of the meshing. The
// lattice still switches to voxels." Under ?solver=lattice nothing is drawn as cells: the voxel lattice's bodies are
// their meshes — the rock the rock mesh skinned to the particles, the rest the body mesh — whole, broken or crumbling;
// what crumbles goes to dust, not to cube fragments.
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
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/?solver=lattice'), configurable: true });
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

/** the voxels the lattice drew this tick (its prep's instance count) */
const voxelsDrawn = async () => new Uint32Array(await g.read(phys.indirect, 16))[1];

test('stone and steel on the lattice, dropped hard enough to crack and crumble: never a voxel drawn', async () => {
  expect(ig.dropBody(Array.from({ length: 64 }, (_, i) => ({ x: 20 + (i % 4), y: 20 + ((i >> 2) % 4), z: FLOOR + 22 + (i >> 4), mat: MAT.Stone })))).toBe(true);
  expect(ig.dropBody(Array.from({ length: 24 }, (_, i) => ({ x: 34 + (i % 8), y: 30 + ((i >> 3) % 3), z: FLOOR + 18, mat: MAT.Steel })))).toBe(true);
  let most = 0;
  let rockDrawn = 0;
  for (let i = 0; i < 200; i++) {
    w.core.sim.step(w.core.globals, () => true);
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 0));
    ig.update(1 / 60);
    if (i % 10 === 0) most = Math.max(most, await voxelsDrawn());
    rockDrawn = Math.max(rockDrawn, (ig as unknown as { latticeRock: unknown[] }).latticeRock.length);
  }
  expect(most).toBe(0);
  // (each body drawn by a mesh: the stone by the rock mesh skinned to its particles where the renderer has one — a
  // tiny world has no field mesh, so here its body mesh — the steel by its body mesh)
  const rm = (ig as unknown as { rockMesh?: unknown }).rockMesh;
  for (const b of phys.bodies) expect(!!b.skin || (!!rm && rockDrawn > 0)).toBe(true);
  expect(g.takeErrors()).toEqual([]);
});
