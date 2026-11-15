// The model store's bake (src/engine/sdf/models.ts, sdf-bake.wgsl) on the real device: the jump flood's signed
// distances against the brute-force distance at every padded voxel centre, for solid, thin and concave models; the
// surface sample list against the CPU's; many models in one batch of dispatches; a model baked again after its voxels
// change (from the CPU, and from bits a GPU pass wrote); a sample list too small is counted.
// SDF_LOG=1 prints each model's worst error.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SdfFormat } from '../../src/engine/sdf/contract';
import { padOccupancy, SdfModels, type SdfModelSpec } from '../../src/engine/sdf/models';
import { ballShape, boxShape, lShape, notchShape, shape } from '../../src/engine/sdf/shapes';
import { refModel } from '../support/sdf-reference';
import { testGpu, type TestGpu } from './dawn';
import { readField, readGrad, readSamples } from './sdf-harness';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

/** the flood is exact this near the surface (measured: its only misses are 64 voxels of the 32-voxel ball, 8.4 voxels
 *  or more inside, at most 0.175 voxels off) */
const DEEP = 8;

const SHAPES: [string, SdfModelSpec][] = [
  ['box 8³', boxShape(8, 8, 8)],
  ['ball 12', ballShape(12)],
  ['L 12', lShape(12)],
  ['notched block 16 × 8 × 8', notchShape(16, 8, 8, 4, 4)],
  ['plate 10 × 10 × 1 (thin)', boxShape(10, 10, 1)],
  ['rod 1 × 1 × 12 (thin)', boxShape(1, 1, 12)],
  ['one voxel', boxShape(1, 1, 1)],
  // a closed shell one voxel thick: the hollow inside is empty space the flood must reach only through distance, not through the wall
  ['hollow shell 10³', shape([10, 10, 10], 1, (x, y, z) => [x, y, z].some((v) => v === 0 || v === 9))],
  // a one-voxel diagonal stair: thin and concave at once
  ['diagonal stair 12', shape([12, 4, 12], 1, (x, _y, z) => x === z || x === z + 1)],
  // two slabs with a one-voxel gap between them
  ['two slabs, a one-voxel gap', shape([8, 8, 9], 1, (_x, _y, z) => z !== 4)],
  ['comb (teeth one voxel wide)', shape([15, 6, 8], 1, (x, _y, z) => z < 2 || x % 2 === 0)],
  ['girder 24 × 3 × 4', shape([24, 3, 4], 1, (_x, y, z) => z === 0 || z === 3 || y === 1)],
  ['box 32³', boxShape(32, 32, 32)],
  ['ball 32', ballShape(32)],
];

describe.each(['f32', 'snorm8', 'grad8'] as SdfFormat[])('the bake, %s', (format) => {
  // the snorm8 field is in sixteenths of a voxel and holds ±7.9375 voxels
  const tol = format === 'f32' ? 1e-4 : 0.5 / 16 + 1e-4;

  test('the flood gives the brute-force distance at every voxel, and the surface samples, for solid, thin and concave models in one batch', async () => {
    const store = new SdfModels(g.device, format);
    const ids = SHAPES.map(([, s]) => store.add(s));
    expect(store.flush()).toBe(SHAPES.length);
    const rows: string[] = [];
    for (let k = 0; k < SHAPES.length; k++) {
      const [name, spec] = SHAPES[k];
      const ref = refModel(spec, 'f32');
      const got = await readField(g, store, ids[k]);
      let worst = 0;
      let wrong = 0;
      let inexact = 0;
      for (let i = 0; i < got.length; i++) {
        const want = format === 'f32' ? ref.field[i] : Math.max(-127 / 16, Math.min(127 / 16, ref.field[i]));
        const e = Math.abs(got[i] - want);
        worst = Math.max(worst, e);
        if (e > tol) inexact++;
        // exact within DEEP voxels of the surface; a quarter voxel anywhere (the flood's known misses, deep inside a big round model)
        if (e > (Math.abs(want) < DEEP ? tol : 0.25)) wrong++;
      }
      const s = await readSamples(g, store, ids[k]);
      rows.push(`${format} ${name}: ${got.length} voxels, worst error ${worst.toFixed(4)} voxels, ${inexact} past ${tol.toFixed(4)}; ${s.count} samples; ${store.info(ids[k]).bytes.total} B`);
      expect(wrong, `${name}: voxels off by more than ${tol} within ${DEEP} voxels of the surface, or a quarter voxel anywhere (worst ${worst})`).toBe(0);
      if (format === 'grad8') {
        // the kept gradients are the reference's (central differences of the exact distances), to a snorm8 step
        const want = refModel(spec, 'grad8').grad!;
        const gg = await readGrad(g, store, ids[k]);
        let off = 0;
        for (let i = 0; i < gg.length; i++) if (Math.abs(gg[i] - want[i]) > 1.5 / 127 && Math.abs(ref.field[Math.floor(i / 3)]) < DEEP - 1) off++;
        expect(off, `${name}: gradient components off by more than a step`).toBe(0);
      }
      expect(s.count).toBe(ref.samples.length);
      expect(s.found).toBe(ref.samples.length);
      // the samples in the bake's fixed order (brick by brick), and the brick table
      expect(s.words).toEqual(ref.samples);
      expect(s.bricks).toEqual(ref.bricks);
    }
    if (process.env.SDF_LOG) console.log(rows.join('\n'));
    expect(g.takeErrors()).toEqual([]);
    store.destroy();
  });

  test('a batch is one set of dispatches, whatever the number of models', async () => {
    const store = new SdfModels(g.device, format);
    for (let k = 0; k < 64; k++) store.add(k % 2 ? ballShape(16) : boxShape(16, 16, 16));
    store.flush();
    // 64 × 18³ = 373,248 padded voxels: two batches of the default 2^18 threads; each seed + 6 flood (side 18: 16, 8, 4, 2, 1, 1) + finalize + 3 for the samples' bricks
    expect(store.dispatches).toBe(2 * 11);
    const ref = refModel(ballShape(16), format);
    const got = await readField(g, store, 63);
    let worst = 0;
    for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - ref.field[i]));
    expect(worst).toBeLessThan(1e-4);
    expect(g.takeErrors()).toEqual([]);
    store.destroy();
  });

  test('voxels removed on the CPU: the model baked again, its field and samples the new shape’s; a removed model’s room is used again', async () => {
    const store = new SdfModels(g.device, format);
    const other = store.add(ballShape(8));
    const id = store.add(boxShape(8, 8, 8));
    store.flush();
    const before = store.info(id);
    // the top two layers and a corner bite gone
    const eaten = shape([8, 8, 8], 1, (x, y, z) => z < 6 && !(x >= 5 && y >= 5 && z >= 3));
    store.update(id, eaten);
    expect(store.flush()).toBe(1);
    const ref = refModel(eaten, format);
    const got = await readField(g, store, id);
    let worst = 0;
    for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - ref.field[i]));
    expect(worst).toBeLessThan(1e-4);
    const s = await readSamples(g, store, id);
    expect(s.words).toEqual(ref.samples);
    expect(store.info(id).fieldBase).toBe(before.fieldBase);
    // the neighbour model is untouched
    const ball = refModel(ballShape(8), format);
    const gotBall = await readField(g, store, other);
    expect(Math.max(...gotBall.map((v, i) => Math.abs(v - ball.field[i])))).toBeLessThan(1e-4);
    // removed, and its room handed to the next model of that size
    store.remove(id);
    const again = store.add(boxShape(8, 8, 8));
    expect(again).toBe(id);
    expect(store.info(again).fieldBase).toBe(before.fieldBase);
    store.flush();
    const box = refModel(boxShape(8, 8, 8), format);
    const gotBox = await readField(g, store, again);
    expect(Math.max(...gotBox.map((v, i) => Math.abs(v - box.field[i])))).toBeLessThan(1e-4);
    expect(g.takeErrors()).toEqual([]);
    store.destroy();
  });

  test('occupancy bits rewritten on the GPU: baked again with no upload; a sample list too small is counted, never silent', async () => {
    const store = new SdfModels(g.device, format);
    const id = store.add(shape([6, 6, 6], 1, (x, y, z) => x < 2 && y < 2 && z < 2));
    store.flush();
    // (a stand-in for the deformation stage's splat: the bits of a new shape written straight into the store's occupancy)
    const comb = shape([6, 6, 6], 1, (x, _y, z) => z < 2 || x % 2 === 0);
    const bits = padOccupancy(comb).bits;
    g.device.queue.writeBuffer(store.occ, store.info(id).occBase * 4, bits);
    const ref = refModel(comb, format);
    // by default the room is the bound that always holds: every voxel of the model
    store.rebakeFromGpu(id);
    expect(store.info(id).sampleCap).toBe(6 * 6 * 6);
    store.flush();
    let s = await readSamples(g, store, id);
    expect(s.count).toBe(ref.samples.length);
    expect(s.words).toEqual(ref.samples);
    const got = await readField(g, store, id);
    expect(Math.max(...got.map((v, i) => Math.abs(v - ref.field[i])))).toBeLessThan(1e-4);
    // a caller's bound that is too small: the samples that fit are kept (the first in the order), the rest counted
    store.rebakeFromGpu(id, { sampleCap: 20 });
    store.flush();
    s = await readSamples(g, store, id);
    expect(s.count).toBe(20);
    expect(s.found).toBe(ref.samples.length);
    expect(s.words).toEqual(ref.samples.slice(0, 20));
    expect(s.bricks[s.bricks.length - 1]).toBe(20);
    expect(g.takeErrors()).toEqual([]);
    store.destroy();
  });

  test('the store grows: models past the first buffers’ room keep the earlier models’ data', async () => {
    const store = new SdfModels(g.device, format);
    const first = store.add(lShape(12));
    store.flush();
    const v0 = store.version;
    const ids: number[] = [];
    for (let k = 0; k < 70; k++) ids.push(store.add(boxShape(24, 24, 24)));
    store.flush();
    expect(store.version).toBeGreaterThan(v0);
    const ref = refModel(lShape(12), format);
    const got = await readField(g, store, first);
    expect(Math.max(...got.map((v, i) => Math.abs(v - ref.field[i])))).toBeLessThan(1e-4);
    const box = refModel(boxShape(24, 24, 24), format);
    const gotBox = await readField(g, store, ids[69]);
    expect(Math.max(...gotBox.map((v, i) => Math.abs(v - box.field[i])))).toBeLessThan(1e-4);
    expect((await readSamples(g, store, ids[69])).count).toBe(box.samples.length);
    expect(g.takeErrors()).toEqual([]);
    store.destroy();
  });
});
