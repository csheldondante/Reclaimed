// (round 128o, DA-B28) The field mesh rebuilds from the chunks' shape versions (fieldmesh.wgsl changedChunk), not a
// hash of every near chunk's columns: once built, nothing changed rebuilds nothing; a dig rebuilds the mesh chunks
// whose columns (and their two-cell margin) lie on the dug sim chunk, and no other; a forced one (STALE: setCaves,
// setWanted's neighbours) is rebuilt and drawn meanwhile.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { attachSim } from '../../src/api/world';
import { cellPos } from '../../src/world/lattice';
import type { FieldMesh } from '../../src/render/fieldmesh';

let g: TestGpu;
let w: TinyWorld;
let fm: FieldMesh;
const W = 128;
const ROW_H = Math.sqrt(3) / 2;

beforeAll(async () => {
  g = await testGpu();
  globalThis.requestAnimationFrame ??= ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
  w = await tinyWorld(g, tinyMap(W, W, 32), ['edit'], 'sim', { fieldMesh: true });
  fm = w.core.renderer.fieldMesh;
  const [nx, ny] = fm.chunkGrid;
  fm.pin(new Uint8Array(nx * ny).fill(1));
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  w?.destroy();
});

/** one frame of the mesh: the chunks it took to rebuild */
async function frame(): Promise<number[]> {
  // (the page pool grown when it ran short, as the renderer's frame does: maintain, afterSubmit)
  fm.maintain();
  const enc = g.device.createCommandEncoder();
  fm.encode(enc, w.core.camera);
  g.device.queue.submit([enc.finish()]);
  fm.afterSubmit();
  const u = new Uint32Array(await g.read(fm.stateBuffer, 64));
  return [...u.subarray(1, 1 + Math.min(u[0], 15))];
}

/** frames until nothing more is rebuilt: every chunk rebuilt meanwhile */
async function settle(): Promise<Set<number>> {
  const all = new Set<number>();
  for (let i = 0; i < 80; i++) {
    const r = await frame();
    if (!r.length) return all;
    for (const c of r) all.add(c);
  }
  throw new Error('the mesh never settled');
}

test('built once; nothing changed, nothing rebuilt; a dig rebuilds only the mesh chunks over its sim chunk', async () => {
  const [nx, ny] = fm.chunkGrid;
  const first = await settle();
  expect(first.size).toBe(nx * ny);
  await w.step(3);
  expect(await settle()).toEqual(new Set());
  // (a dig at column (60, 60): its sim chunk (3, 3))
  attachSim(w.core, { terrain: true }).terrain!.dig(...cellPos(60, 60), { radius: 2, layers: 2 });
  await w.step(8);
  const rebuilt = await settle();
  // (the mesh chunks whose columns and margin reach sim chunk (3, 3): fieldmesh.wgsl chunkCols)
  const reach = new Set<number>();
  for (let c = 0; c < nx * ny; c++) {
    const mx = c % nx;
    const my = Math.floor(c / nx);
    const i0 = Math.max(Math.floor(mx * 32 - 2) - 1, 0);
    const i1 = Math.min(Math.ceil((mx + 1) * 32 + 2) + 1, W - 1);
    const j0 = Math.max(Math.floor((my * 32 * ROW_H - 2) / ROW_H) - 1, 0);
    const j1 = Math.min(Math.ceil(((my + 1) * 32 * ROW_H + 2) / ROW_H) + 1, W - 1);
    if (i0 >> 4 <= 3 && 3 <= i1 >> 4 && j0 >> 4 <= 3 && 3 <= j1 >> 4) reach.add(c);
  }
  expect(rebuilt.size).toBeGreaterThan(0);
  for (const c of rebuilt) expect(reach.has(c), `mesh chunk ${c} rebuilt`).toBe(true);
  expect(g.takeErrors()).toEqual([]);
});

test('a chunk forced (setCaves, setWanted: STALE) is rebuilt once', async () => {
  await settle();
  const c = 5;
  g.device.queue.writeBuffer(fm.stateBuffer, (16 + c * 14 + 5) * 4, new Uint32Array([0xfffffffe]));
  expect(await settle()).toEqual(new Set([c]));
  expect(g.takeErrors()).toEqual([]);
});
