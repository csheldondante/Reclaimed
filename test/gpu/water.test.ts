// The water system on a tiny world (contract.ts `pool`, moved to Node): a pool on bare stone inside a rim, no spring —
// its volume is kept and it spreads. The real WorldCore, kernels and Simulation, on Dawn.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

test('a pool on flat stone keeps its volume and spreads', async () => {
  const W = 32;
  const H = 32;
  const rim = (x: number, y: number) => x === 0 || y === 0 || x === W - 1 || y === H - 1;
  const map = tinyMap(W, H, 32, (x, y) => [{ z0: 0, z1: rim(x, y) ? 14 : 10, mat: MAT.Stone }]);
  let v0 = 0;
  for (let y = 8; y < 24; y++)
    for (let x = 8; x < 24; x++) {
      map.water[y * W + x] = 2;
      v0 += 2;
    }
  const w = await tinyWorld(g, map, ['surface', 'water']);
  const start = w.sum(await w.read('water'));
  await w.step(600);
  const b = await w.read('water');
  const end = w.sum(b);
  expect(g.takeErrors()).toEqual([]);
  expect(Math.abs(start - v0)).toBeLessThan(0.01 * v0);
  expect(Math.abs(end - start)).toBeLessThan(0.01 * start);
  expect(Math.max(...b)).toBeLessThan(1.9);
  w.destroy();
});
