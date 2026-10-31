// Round 120, the rules "no fallbacks" and "no GPU memory caps" (the coordinator: "Make the rock mesh's slots grow on
// demand to the device's limits … so a rock body is always the rock mesh"). The rock mesh's copy (render/rockmesh.ts):
// more pieces than its starting room — small ones packed together, big ones past its 72 starting blocks — all get a
// slot; its storage grows; given back, the room is there again.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import type { RockMesh } from '../../src/render/rockmesh';

let g: TestGpu;
let w: TinyWorld;
let rm: RockMesh;

beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(256, 256, 48), [], 'sim', { fieldMesh: true });
  const m = w.core.renderer.enableRockMesh();
  if (!m) throw new Error('no rock mesh: the field mesh is off');
  rm = m;
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  w?.destroy();
});

const piece = (x0: number, y0: number, wd: number, d: number, h: number) => {
  const out = [];
  for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < wd; x++) out.push({ x: x0 + x, y: y0 + y, z: 12 + z, mat: MAT.Stone });
  return out;
};

test('more pieces than the old 18 slots: 120 small ones, each its own slot (packed)', async () => {
  const ids: number[] = [];
  for (let k = 0; k < 120; k++) {
    const got = rm.alloc(piece(10 + (k % 12) * 3, 10 + Math.floor(k / 12) * 3, 2, 2, 2));
    expect(got, `piece ${k}`).toBeTruthy();
    ids.push(got!.id);
  }
  expect(rm.held).toBe(120);
  for (const id of ids) rm.release(id);
  expect(rm.held).toBe(0);
  await g.device.queue.onSubmittedWorkDone();
  expect(g.takeErrors()).toEqual([]);
});

test('big pieces past the 72 starting blocks: the storage grows, every piece gets its slot', async () => {
  const start = rm.blockRoom;
  const ids: number[] = [];
  // (each a 26 × 26 footprint: its region with the margins spans about 2 × 2 column chunks or more)
  for (let k = 0; k < 40; k++) {
    const got = rm.alloc(piece(4, 4, 26, 26, 1));
    expect(got, `piece ${k}`).toBeTruthy();
    ids.push(got!.id);
  }
  expect(rm.blockRoom).toBeGreaterThan(start);
  await g.device.queue.onSubmittedWorkDone();
  expect(g.takeErrors()).toEqual([]);
  for (const id of ids) rm.release(id);
  expect(rm.held).toBe(0);
});

test('the window full of moving pieces: no slot (null, for the caller to make room), never a different look', () => {
  const ids: number[] = [];
  let got = rm.alloc(piece(0, 0, 200, 200, 1));
  expect(got).toBeTruthy();
  ids.push(got!.id);
  got = rm.alloc(piece(0, 0, 200, 200, 1));
  expect(got).toBeNull();
  for (const id of ids) rm.release(id);
});
