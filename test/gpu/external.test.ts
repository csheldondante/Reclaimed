// External intervals on the GPU (sim/external.ts's contract, ARCHITECTURE "External intervals"): every sim treats a
// thing's cells as solid rock that never gives by itself — they stay where they are, as they are, and water goes round
// them. Every system the level steps, on a tiny world: a block of External cells (a buried statue's top, standing out
// of a stone floor) in a pool.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unpackColumns } from '../../src/world/mapfile';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 32;
const H = 32;
const inBlock = (x: number, y: number) => x >= 12 && x < 20 && y >= 12 && y < 20;
const rim = (x: number, y: number) => x === 0 || y === 0 || x === W - 1 || y === H - 1;

let g: TestGpu;
let w: TinyWorld;
beforeAll(async () => {
  g = await testGpu();
  const map = tinyMap(W, H, 32, (x, y) =>
    inBlock(x, y)
      ? [{ z0: 0, z1: 6, mat: MAT.Stone }, { z0: 6, z1: 14, mat: MAT.External, aux: MAT.Stone }]
      : [{ z0: 0, z1: rim(x, y) ? 16 : 10, mat: MAT.Stone }],
  );
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!rim(x, y) && !inBlock(x, y)) map.water[y * W + x] = 1.5;
  w = await tinyWorld(g, map, 'all');
  await w.step(600);
});
afterAll(() => w?.destroy());

test('no GPU validation errors with every system stepping', () => {
  expect(g.takeErrors()).toEqual([]);
});

test("the thing's cells are where they were, External, their fallback kept", async () => {
  const layers = await w.read('layers');
  const grid = unpackColumns(w.core.packed, new Uint32Array(layers.buffer));
  const bad: string[] = [];
  for (let y = 12; y < 20; y++)
    for (let x = 12; x < 20; x++) {
      const ext = grid.cols[y * W + x].filter((iv) => iv.mat === MAT.External);
      const z0 = Math.min(...ext.map((iv) => iv.z0));
      const z1 = Math.max(...ext.map((iv) => iv.z1));
      if (!ext.length || Math.abs(z0 - 6) > 1e-3 || Math.abs(z1 - 14) > 1e-3) bad.push(`${x},${y}: ${JSON.stringify(grid.cols[y * W + x])}`);
    }
  expect(bad).toEqual([]);
});

test('water goes round it: none stands on its top (higher than the pool), the pool is still there', async () => {
  const water = await w.read('water');
  let onTop = 0;
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) onTop = Math.max(onTop, water[y * W + x]);
  expect(onTop).toBeLessThan(0.01);
  expect(water[5 * W + 5]).toBeGreaterThan(0.5);
});
