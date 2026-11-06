// (DA-B16) Things landing shove the air (phys.wgsl's puff); the wind field updates round the box of the shoves, made on
// the GPU (windfield.wgsl windBox), not the whole field while any physics body exists. The painted wind (the field's
// rg) comes out the same, bit for bit, as updating the whole field every update; and with nothing landing lately the
// box is empty.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { Integrity } from '../../src/game/integrity';
import { installPhysics } from '../../src/physics/install';

const W = 64;
const FLOOR = 10;
let g: TestGpu;
const worlds: { w: TinyWorld; ig: Integrity }[] = [];

beforeAll(async () => {
  g = await testGpu();
  for (const whole of [false, true]) {
    const w = await tinyWorld(g, tinyMap(W, W, 48, () => [{ z0: 0, z1: FLOOR, mat: MAT.Stone }]), 'all');
    const { physics } = installPhysics(w.core, { wakeOnTouch: false });
    const ig = new Integrity(w.core, true);
    ig.physics = physics;
    await ig.columnsReady([], () => {});
    // (the reference: the whole field painted every update, as while any body existed before DA-B16)
    if (whole) w.core.sim.wind.wholeWhile.push(() => true);
    worlds.push({ w, ig });
  }
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  for (const { w } of worlds) w.destroy();
});

async function frames(n: number) {
  for (let i = 0; i < n; i++) {
    for (const { w, ig } of worlds) {
      w.core.sim.step(w.core.globals, () => true);
      await g.device.queue.onSubmittedWorkDone();
      ig.update(1 / 60);
    }
  }
}

/** the painted wind (rg) of a world's field, texel by texel */
async function painted(w: TinyWorld): Promise<Float32Array> {
  const tex = w.core.world.windField;
  const bpr = Math.ceil((tex.width * 16) / 256) * 256;
  const buf = g.device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = g.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
  g.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const all = new Float32Array(buf.getMappedRange());
  const out = new Float32Array(tex.width * tex.height * 2);
  for (let y = 0; y < tex.height; y++)
    for (let x = 0; x < tex.width; x++) {
      out[(y * tex.width + x) * 2] = all[(y * bpr) / 4 + x * 4];
      out[(y * tex.width + x) * 2 + 1] = all[(y * bpr) / 4 + x * 4 + 1];
    }
  buf.unmap();
  buf.destroy();
  return out;
}

const box = (x0: number, y0: number, z0: number, n: number, mat: number) => {
  const out = [];
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat });
  return out;
};

test('blocks landing shove the same wind as the whole field updated every update', async () => {
  for (const { ig } of worlds) {
    expect(ig.dropBody(box(20, 20, FLOOR + 14, 3, MAT.Stone))).toBe(true);
    expect(ig.dropBody(box(44, 36, FLOOR + 20, 2, MAT.Stone))).toBe(true);
  }
  let shoved = false;
  for (let k = 0; k < 12; k++) {
    await frames(10);
    const [a, b] = await Promise.all(worlds.map(({ w }) => painted(w)));
    shoved ||= a.some((v) => v !== 0);
    expect(a).toEqual(b);
  }
  expect(shoved, 'the landings shoved some air').toBe(true);
  expect(g.takeErrors()).toEqual([]);
});

test('the shoved wind dies down, and then the box is empty', async () => {
  // (painted wind lives LIFE_S = 45 s after its last stamp)
  await frames(60 * 50);
  const [a, b] = await Promise.all(worlds.map(({ w }) => painted(w)));
  expect(a).toEqual(b);
  expect(a.every((v) => v === 0)).toBe(true);
  const wbox = new Uint32Array(await g.read((worlds[0].w.core.sim.wind as unknown as { wbox: GPUBuffer }).wbox, 32));
  expect(wbox[0] * wbox[1], 'no texels to update').toBe(0);
  expect(g.takeErrors()).toEqual([]);
}, 600000);
