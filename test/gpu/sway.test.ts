// (round 128p — the user: "when wind is low let them sleep and wake them up for gusts like other systems like dust")
// The plants' sway (sway.wgsl) runs over the chunks the GPU lists (swaylist.wgsl): a wind rising lists the window's
// chunks and the plants lean; once the springs settle into it — a steady breeze — none is: the sway sleeps, the plants
// keep their lean; the wind dropping wakes them all again to swing back; a gust wakes the chunks round it, not the rest.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
let g: TestGpu;
let w: TinyWorld;
beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]), 'all');
});
afterAll(() => {
  w?.destroy();
  g?.destroy();
});

async function u32s(buf: GPUBuffer, bytes: number): Promise<Uint32Array> {
  const tmp = g.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = g.device.createCommandEncoder();
  enc.copyBufferToBuffer(buf, 0, tmp, 0, bytes);
  g.device.queue.submit([enc.finish()]);
  await tmp.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(tmp.getMappedRange().slice(0));
  tmp.destroy();
  return out;
}

/** the chunks the sway ran over in the last frame (its list's workgroups / 4) */
async function listed(): Promise<number> {
  const sway = w.core.sim.systems.find((s) => s.name === 'sway') as unknown as { lister: { list: { args: GPUBuffer } } };
  return (await u32s(sway.lister.list.args, 12))[0] / 4;
}

async function frames(n: number, set: () => void) {
  for (let i = 0; i < n; i++) {
    set();
    w.core.sim.step(w.core.globals, () => true);
  }
  await g.device.queue.onSubmittedWorkDone();
}

test('the sway sleeps under the breeze, wakes round a gust, sleeps again once its springs stop swinging', async () => {
  const chunks = (W / 16) * (W / 16);
  const G = w.core.globals;
  // (the map's own breeze: nothing listed)
  await frames(60, () => {
    G.windX = 4;
    G.windY = 0;
    G.gusts = [];
  });
  expect(await listed(), 'the breeze: none').toBe(0);
  // (a gust in one corner: the chunks round it, and their plants lean)
  await frames(30, () => {
    G.gusts = [{ x: 8, y: 8, radius: 6, strength: 30, dx: 1, dy: 0 }];
  });
  const n = await listed();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(chunks);
  const bend = new Float32Array((await u32s(w.core.world.bend, W * W * 16)).buffer);
  expect(Math.max(...Array.from({ length: W * W }, (_, i) => Math.abs(bend[i * 4])))).toBeGreaterThan(0.05);
  // (the gust gone: they swing back and stop, then nothing is listed)
  await frames(1200, () => {
    G.gusts = [];
  });
  expect(await listed(), 'settled: none').toBe(0);
  expect(g.takeErrors()).toEqual([]);
});
