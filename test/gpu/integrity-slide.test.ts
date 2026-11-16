// phone-idle PI-5 (2026-11-15): a slide alone reads nothing back. The census found Integrity's kept copy read whole
// after every slide (27–29 MB at the game's window, 7–10 times in a 10 s pan) though nothing was to be judged: the
// slide's orphan check went through a kept pass. Now the check runs on the GPU from the CPU's claims; the copy is read
// again only when something asks for a judge pass.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { Integrity } from '../../src/game/integrity';

const W = 64;
let g: TestGpu;
let w: TinyWorld;
let ig: Integrity;

beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(W, W, 48, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]), 'all');
  // (no rigid rock: the judge's CPU copy is kept — Integrity.keepsCopy — as on the atlas level)
  ig = new Integrity(w.core);
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  w?.destroy();
});

async function frames(n: number) {
  for (let i = 0; i < n; i++) {
    w.core.sim.step(w.core.globals, () => true);
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 0));
    ig.update(1 / 60);
  }
}

test('the copy is kept here, and read once to begin with', async () => {
  await frames(90);
  expect(ig.keepsCopy).toBe(true);
  expect(ig.cols.whole).toBe(true);
  expect(ig.cols.readBytes).toBeGreaterThan(0);
});

test('a slide with nothing to judge reads nothing back; its orphan check runs on the GPU', async () => {
  const bytes = ig.cols.readBytes;
  const passes = ig.stats.passes;
  for (let s = 0; s < 3; s++) {
    (w.core as { windowEpoch: number }).windowEpoch++;
    ig.slid(0, 0, 0);
    expect(ig.orphanCheck).toBe(true);
    await frames(90);
    expect(ig.orphanCheck).toBe(false);
  }
  expect(ig.cols.readBytes).toBe(bytes);
  expect(ig.stats.passes).toBe(passes);
  // (this tiny world has no External claims: the check has nothing to send; with claims it is one GPU kernel,
  // stats.slideOrphans)
  expect(g.takeErrors()).toEqual([]);
});

test('an edit after the slide still gets its pass, on a whole read of the window as it is now', async () => {
  const bytes = ig.cols.readBytes;
  const passes = ig.stats.passes;
  ig.markBox(20, 20, 28, 28);
  await frames(120);
  expect(ig.stats.passes).toBeGreaterThan(passes);
  // (the copy was of the window before the slides: read whole, then the box's chunks on its second look)
  expect(ig.cols.readBytes - bytes).toBeGreaterThanOrEqual(w.core.packed.slots.length * 4);
  expect(g.takeErrors()).toEqual([]);
});

test('with nothing more to judge, no further read', async () => {
  await frames(60);
  const bytes = ig.cols.readBytes;
  await frames(120);
  expect(ig.cols.readBytes).toBe(bytes);
});
