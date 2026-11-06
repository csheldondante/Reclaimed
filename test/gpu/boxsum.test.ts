// (DA-B13) BoxMeans: the mean of a per-column texture's x over boxes, on the GPU (the menu's dust over its buried
// models), against the same means of the texture read back whole.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BoxMeans } from '../../src/sim/boxsum';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
let g: TestGpu;
let w: TinyWorld;
beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(W, W, 32, () => [{ z0: 0, z1: 8, mat: MAT.Stone }]), []);
});
afterAll(() => w?.destroy());

test('box means equal the whole texture read back and summed', async () => {
  // (a known x in window order, written where each column's texel lies)
  const vals = new Float32Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) vals[(y * W + x) * 4] = ((x * 7 + y * 13) % 17) / 8;
  const tex = w.core.world.drift;
  g.device.queue.writeTexture({ texture: tex }, w.core.ring.toStore(vals, 4), { bytesPerRow: tex.width * 16 }, [tex.width, tex.height]);
  const back = (await w.core.readTexture(tex)).data;
  const boxes: [number, number, number, number][] = [
    [0, 0, 64, 64],
    [3, 5, 11, 9],
    [40, 17, 41, 18],
    [20, 30, 52, 63],
  ];
  const bm = new BoxMeans(g.device, w.core.world.globals, w.core.world.driftView);
  const got = await bm.query(boxes)!;
  boxes.forEach(([x0, y0, x1, y1], k) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += back[(y * W + x) * 4];
    expect(got[k]).toBeCloseTo(s / ((x1 - x0) * (y1 - y0)), 5);
  });
  bm.destroy();
  expect(g.takeErrors()).toEqual([]);
});
