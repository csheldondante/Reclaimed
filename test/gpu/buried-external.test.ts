// A body at rest is a column projection (the coordinator, round 120: "a sleeping body keeps its External intervals
// (MI4/PX4) so sediment can bury it, and it stays overgrowable"). A resting rock's cells are External intervals in the
// columns (sim/external.ts; Integrity.restRigid writes them); here a block of them stands out of a stone floor on a tiny
// world with every system stepping: sand poured over it lies on it (buried), and plants on its top live on (External
// carries a growth cap and suitability: moss and grass on a resting rock).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unpackColumns } from '../../src/world/mapfile';
import { MAT, MATERIALS, MatState } from '../../src/world/materials';
import { EventKind } from '../../src/sim/globals';
import { OP } from '../../src/sim/edit-ops';
import { cellPos } from '../../src/world/lattice';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 32;
const inBlock = (x: number, y: number) => x >= 12 && x < 20 && y >= 12 && y < 20;

let g: TestGpu;
let w: TinyWorld;
let vegBefore = 0;
beforeAll(async () => {
  g = await testGpu();
  const map = tinyMap(W, W, 32, (x, y) => (inBlock(x, y) ? [{ z0: 0, z1: 10, mat: MAT.Stone }, { z0: 10, z1: 14, mat: MAT.External, aux: MAT.Stone }] : [{ z0: 0, z1: 10, mat: MAT.Stone }]));
  map.moisture.fill(0.5);
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) map.vegetation[y * W + x] = 0.4;
  w = await tinyWorld(g, map, 'all');
  const v0 = await w.core.readBuffer('veg' as never);
  vegBefore = w.sum(v0, 14, 14, 18, 18) / 16;
  // sand poured over the block's middle
  w.core.sim.edit.always = true;
  const [cx, cy] = cellPos(16, 16);
  for (let k = 0; k < 6; k++) w.core.globals.events.push({ kind: EventKind.Edit, x: cx, y: cy, z: OP.POUR * 32 + MAT.Sand + 512, radius: 3, strength: 1 });
  await w.step(900);
});
afterAll(() => w?.destroy());

test('no GPU validation errors with every system stepping', () => {
  expect(g.takeErrors()).toEqual([]);
});

test('the sand lies on the resting body: its columns hold loose ground over their External cells (buried)', async () => {
  const layers = await w.read('layers');
  const grid = unpackColumns(w.core.packed, new Uint32Array(layers.buffer));
  let buried = 0;
  for (let y = 14; y < 18; y++)
    for (let x = 14; x < 18; x++) {
      const col = grid.cols[y * W + x];
      const ext = col.find((iv) => iv.mat === MAT.External);
      expect(ext, `${x},${y}: ${JSON.stringify(col)}`).toBeTruthy();
      if (col.some((iv) => iv.z0 >= ext!.z1 - 1e-3 && MATERIALS[iv.mat]?.state === MatState.Granular)) buried++;
    }
  expect(buried).toBeGreaterThan(8);
});

test('plants on its top live on (it stays overgrowable)', async () => {
  const v = await w.core.readBuffer('veg' as never);
  const after = w.sum(v, 14, 14, 18, 18) / 16;
  if (process.env.SOLVER_LOG) console.log('veg on the block', vegBefore, '->', after);
  expect(vegBefore).toBeGreaterThan(0.3);
  expect(after).toBeGreaterThan(0.05);
});

