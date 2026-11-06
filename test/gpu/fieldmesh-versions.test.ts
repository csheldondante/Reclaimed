// (round 128o, DA-B28) The field mesh rebuilds from the chunks' shape versions (fieldmesh.wgsl changedChunk), not a
// hash of every near chunk's columns: once built, nothing changed rebuilds nothing; a dig rebuilds exactly the mesh
// chunks whose columns (and their two-cell margin) take in a 4 x 4 block it changed; a forced one (STALE: setCaves,
// setWanted's neighbours) is rebuilt and drawn meanwhile.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { attachSim } from '../../src/api/world';
import { cellPos } from '../../src/world/lattice';
import type { FieldMesh } from '../../src/render/fieldmesh';
import { shapeVersionIndices } from '../../src/sim/chunkver';

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

/** the shape versions of every 4 x 4 block of the window, by block (bx, by) — chunkver.wgsl */
async function blockVersions(): Promise<Map<string, number>> {
  const raw = new Uint32Array((await w.core.readBuffer('chunks')).buffer);
  const p = w.core.packed;
  const base = p.chunkTable.length;
  const out = new Map<string, number>();
  for (let ci = 0; ci < p.chunksX * p.chunksY; ci++) {
    const idx = shapeVersionIndices(p, ci);
    const cx = ci % p.chunksX;
    const cy = Math.floor(ci / p.chunksX);
    idx.forEach((k, b) => out.set(`${cx * 4 + (b % 4)},${cy * 4 + Math.floor(b / 4)}`, raw[base + k]));
  }
  return out;
}

test('built once; nothing changed, nothing rebuilt; a dig rebuilds exactly the mesh chunks over the blocks it changed', async () => {
  const [nx, ny] = fm.chunkGrid;
  const first = await settle();
  expect(first.size).toBe(nx * ny);
  await w.step(3);
  expect(await settle()).toEqual(new Set());
  const v0 = await blockVersions();
  attachSim(w.core, { terrain: true }).terrain!.dig(...cellPos(60, 60), { radius: 2, layers: 2 });
  await w.step(8);
  const v1 = await blockVersions();
  const changed = [...v1].filter(([k, v]) => v !== v0.get(k)).map(([k]) => k.split(',').map(Number));
  expect(changed.length).toBeGreaterThan(0);
  // (round 128o, DA-B28: a dig of radius 2 changes a few 4 x 4 blocks, not whole 16-column chunks)
  expect(changed.length).toBeLessThanOrEqual(9);
  const rebuilt = await settle();
  // (the mesh chunks whose columns and margin, fieldmesh.wgsl chunkCols, take in a changed block)
  const reach = new Set<number>();
  for (let c = 0; c < nx * ny; c++) {
    const mx = c % nx;
    const my = Math.floor(c / nx);
    const i0 = Math.max(Math.floor(mx * 32 - 2) - 1, 0);
    const i1 = Math.min(Math.ceil((mx + 1) * 32 + 2) + 1, W - 1);
    const j0 = Math.max(Math.floor((my * 32 * ROW_H - 2) / ROW_H) - 1, 0);
    const j1 = Math.min(Math.ceil(((my + 1) * 32 * ROW_H + 2) / ROW_H) + 1, W - 1);
    if (changed.some(([bx, by]) => i0 >> 2 <= bx && bx <= i1 >> 2 && j0 >> 2 <= by && by <= j1 >> 2)) reach.add(c);
  }
  expect(rebuilt).toEqual(reach);
  expect(g.takeErrors()).toEqual([]);
});

test('a chunk forced (setCaves, setWanted: STALE) is rebuilt once', async () => {
  await settle();
  const c = 5;
  g.device.queue.writeBuffer(fm.stateBuffer, (16 + c * 14 + 5) * 4, new Uint32Array([0xfffffffe]));
  expect(await settle()).toEqual(new Set([c]));
  expect(g.takeErrors()).toEqual([]);
});
