// (phone-idle, 2026-11-15) What the field mesh asks of the GPU in a frame (render/fieldmesh.ts "what a frame encodes"):
// one compute pass of direct dispatches where the path before took ten passes, five of them indirect; nothing at all
// when it may sleep and is asleep; and the same chunks rebuilt in the same frames with the same vertices and quads as
// the path before (`indirect`: kept as this test's reference — its own kernels, a workgroup a 4 x 4 x 4 block of
// samples, where the direct path's is a 4 x 4 column walking its blocks). Counted with the frame census
// (gpu/census.ts) over the real device.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';
import { attachSim } from '../../src/api/world';
import { cellPos } from '../../src/world/lattice';
import type { FieldMesh } from '../../src/render/fieldmesh';
import { Census, installCensus, type Counts } from '../../src/gpu/census';

const W = 128;
/** meshstate.wgsl CHUNK0, CSTRIDE; meshregion.wgsl VPP, QPP, a page's u32s */
const CHUNK0 = 16;
const CSTRIDE = 14;
const VPP = 512;
const QPP = 2048;
const PAGE_U32 = 4096;

interface Side {
  w: TinyWorld;
  fm: FieldMesh;
  dig: (x: number, y: number) => void;
}

let g: TestGpu;
/** the path under test, and the path before (the reference) */
let now: Side;
let before: Side;
const census = new Census();
let undo: (() => void) | undefined;

async function side(indirect: boolean): Promise<Side> {
  const w = await tinyWorld(g, tinyMap(W, W, 32), ['edit'], 'sim', { fieldMesh: true });
  const fm = w.core.renderer.fieldMesh;
  fm.indirect = indirect;
  const [nx, ny] = fm.chunkGrid;
  fm.pin(new Uint8Array(nx * ny).fill(1));
  const terrain = attachSim(w.core, { terrain: true }).terrain!;
  return { w, fm, dig: (x, y) => terrain.dig(...cellPos(x, y), { radius: 2, layers: 2 }) };
}

beforeAll(async () => {
  g = await testGpu();
  globalThis.requestAnimationFrame ??= ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
  now = await side(false);
  before = await side(true);
  // (the census over this device's classes, from their instances)
  const enc = g.device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.end();
  enc.finish();
  const cls = (o: object) => ({ prototype: Object.getPrototypeOf(o) as object });
  undo = installCensus(census, { GPUCommandEncoder: cls(enc), GPUComputePassEncoder: cls(pass), GPURenderPassEncoder: { prototype: {} }, GPUQueue: cls(g.device.queue), GPUBuffer: cls(now.fm.stateBuffer), GPUDevice: cls(g.device) });
});
afterAll(async () => {
  undo?.();
  await g.device.queue.onSubmittedWorkDone();
  now?.w.destroy();
  before?.w.destroy();
});

/** one frame of a mesh as the renderer runs it (maintain, encode, afterSubmit), its reads let land */
async function encodeFrame(s: Side): Promise<void> {
  s.fm.maintain();
  const enc = g.device.createCommandEncoder();
  s.fm.encode(enc, s.w.core.camera);
  g.device.queue.submit([enc.finish()]);
  s.fm.afterSubmit();
  await g.device.queue.onSubmittedWorkDone();
  await new Promise((r) => setTimeout(r, 0));
}

/** one frame: the chunks it took to rebuild (none when it was asleep: nothing was encoded) */
async function frame(s: Side): Promise<number[]> {
  const slept = s.fm.sleptFrames;
  await encodeFrame(s);
  if (s.fm.sleptFrames !== slept) return [];
  const u = new Uint32Array(await g.read(s.fm.stateBuffer, 64));
  return [...u.subarray(1, 1 + Math.min(u[0], 15))].sort((a, b) => a - b);
}

/** frames until one rebuilds nothing: what each rebuilt */
async function settle(s: Side): Promise<number[][]> {
  const frames: number[][] = [];
  for (let i = 0; i < 80; i++) {
    const r = await frame(s);
    if (!r.length) return frames;
    frames.push(r);
  }
  throw new Error('the mesh never settled');
}

const flat = (frames: number[][]) => new Set(frames.flat());

/** what `n` frames of a mesh ask of the GPU, in all */
async function counted(s: Side, n: number): Promise<Counts> {
  census.reset();
  for (let i = 0; i < n; i++) await encodeFrame(s);
  return census.take().total;
}

/** each chunk's mesh as what it draws, whatever pages and order it was made in: its quads, each its four vertices' words */
async function meshOf(s: Side): Promise<string[]> {
  const fm = s.fm as unknown as { vpt: number; qpt: number; stateBuffer: GPUBuffer; vertexBuffer: GPUBuffer; chunkGrid: [number, number, number] };
  const [nx, ny] = fm.chunkGrid;
  const chunks = nx * ny;
  const st = new Uint32Array(await g.read(fm.stateBuffer, fm.stateBuffer.size));
  const pool = new Uint32Array(await g.read(fm.vertexBuffer, fm.vertexBuffer.size));
  const rt0 = CHUNK0 + chunks * (CSTRIDE + 1) + chunks * 4 + 4;
  const out: string[] = [];
  for (let c = 0; c < chunks; c++) {
    const b = CHUNK0 + c * CSTRIDE;
    const quads = st[b] / 6;
    const rt = rt0 + st[b + 10] * (8 + fm.vpt + fm.qpt);
    const vert = (v: number) => {
      const at = st[rt + 8 + Math.floor(v / VPP)] * PAGE_U32 + (v % VPP) * 8;
      return [...pool.subarray(at, at + 8)].join(',');
    };
    const qs: string[] = [];
    for (let q = 0; q < quads; q++) {
      const at = st[rt + 8 + fm.vpt + Math.floor(q / QPP)] * PAGE_U32 + Math.floor((q % QPP) / 2) * 4 + (q & 1) * 2;
      const [w0, w1] = [pool[at], pool[at + 1]];
      qs.push([w0 & 0xffff, w0 >>> 16, w1 & 0xffff, w1 >>> 16].map(vert).join(' '));
    }
    out.push(`${st[b + 7]} vertices, ${quads} quads\n${qs.sort().join('\n')}`);
  }
  return out;
}

/** both meshes hold the same quads in every chunk */
async function sameMesh(): Promise<void> {
  const [a, b] = [await meshOf(now), await meshOf(before)];
  expect(a.map((m) => m.split('\n')[0])).toEqual(b.map((m) => m.split('\n')[0]));
  for (let c = 0; c < a.length; c++) expect(a[c] === b[c], `chunk ${c}'s quads`).toBe(true);
}

/** the same on both sides: frames until settled, how many chunks each frame took, the chunks in all */
async function settleBoth(): Promise<{ frames: number[][]; all: Set<number> }> {
  const [a, b] = [await settle(now), await settle(before)];
  expect(a.map((f) => f.length)).toEqual(b.map((f) => f.length));
  expect(flat(a)).toEqual(flat(b));
  return { frames: a, all: flat(a) };
}

const asleepMasks = (s: Side, asleep: boolean) => {
  s.w.core.globals.sleep = asleep ? new Uint32Array(64).fill(0xffffffff) : undefined;
  s.w.core.globals.drowse = asleep ? new Uint32Array(64) : undefined;
};

test('the first build: the same frames, chunks, vertices and quads as the path before', async () => {
  const [nx, ny] = now.fm.chunkGrid;
  const { frames, all } = await settleBoth();
  expect(all.size).toBe(nx * ny);
  // (low tier: one ordinary slot, a chunk a frame)
  expect(frames.length).toBe(nx * ny);
  await sameMesh();
  expect(g.takeErrors()).toEqual([]);
});

test('awake and nothing changed: one pass of direct dispatches, no indirect, no copy for the rebuild (before: 10 passes, 5 indirect)', async () => {
  const N = 5;
  await settleBoth();
  const a = await counted(now, N);
  expect(a.indirect).toBe(0);
  expect(a.computePasses).toBe(N);
  // (the two change passes, the bounds, and the rebuild's seven kernels — two of them the pool's one-workgroup allocs)
  expect(a.direct).toBe(10 * N);
  // (the header and the counters; the near words only when they differ)
  expect(a.uploads).toBe(2 * N);
  expect(a.copies).toBeLessThanOrEqual(2);
  const b = await counted(before, N);
  expect(b.indirect).toBe(5 * N);
  expect(b.computePasses).toBe(10 * N);
  expect(b.direct).toBe(6 * N);
  expect(b.copies).toBeGreaterThanOrEqual(N);
  // (the rebuild's room, direct: a workgroup a 4 x 4 column of a slot's samples — 9 x 9 a slot a kernel at spacing 1
  // whatever the height, over the one ordinary slot of the low tier when nothing is marked urgent; the path before's
  // workgroup was a 4 x 4 x 4 block: 9 x 9 x 9 a slot here, zMax 32)
  expect(now.fm.slotRoom).toEqual([9, 9, 9]);
  expect(now.fm.slotCount).toEqual([5, 1]);
  expect(g.takeErrors()).toEqual([]);
});

test('a dig, awake: the same chunks in the same frames, the same mesh; marked urgent, all in the next frame', async () => {
  for (const s of [now, before]) {
    s.dig(60, 60);
    await s.w.step(8);
  }
  const dug = await settleBoth();
  expect(dug.all.size).toBeGreaterThan(0);
  expect(dug.frames.length).toBe(dug.all.size);
  await sameMesh();
  for (const s of [now, before]) {
    s.dig(48, 48);
    s.fm.urgent(...cellPos(48, 48), ...cellPos(48, 48));
    await s.w.step(8);
  }
  const urgent = await settleBoth();
  expect(urgent.all.size).toBeGreaterThan(0);
  // (the dig is inside chunk (1, 1): the one chunk, in the one frame)
  expect(urgent.frames).toEqual([[now.fm.chunkGrid[0] + 1]]);
  await sameMesh();
  expect(g.takeErrors()).toEqual([]);
});

test('may sleep, every chunk asleep, nothing pending: the mesh encodes nothing', async () => {
  now.fm.canSleep = true;
  for (const s of [now, before]) {
    asleepMasks(s, true);
    await s.w.step(2);
  }
  // (awake until the read taken after the last wake says nothing is owed)
  for (let i = 0; i < 40 && now.fm.sleptFrames === 0; i++) await frame(now);
  expect(now.fm.sleptFrames).toBeGreaterThan(0);
  // (the stats and the free stack read once more as it falls asleep)
  await frame(now);
  await frame(now);
  const slept = now.fm.sleptFrames;
  const N = 20;
  const a = await counted(now, N);
  expect(now.fm.sleptFrames).toBe(slept + N);
  expect({ passes: a.computePasses, direct: a.direct, indirect: a.indirect, uploads: a.uploads, copies: a.copies, reads: a.reads }).toEqual({ passes: 0, direct: 0, indirect: 0, uploads: 0, copies: 0, reads: 0 });
  expect(g.takeErrors()).toEqual([]);
});

test('asleep: a dig where the sim wakes, urgent, a slide and setWanted rebuild what the path before does, in as many frames', async () => {
  const [nx, ny] = now.fm.chunkGrid;
  // a dig: its chunks are live while the edit lands (the game: Sleep.update from the events)
  for (const s of [now, before]) {
    asleepMasks(s, false);
    s.dig(100, 40);
    await s.w.step(8);
  }
  const dug = await settleBoth();
  expect(dug.all.size).toBeGreaterThan(0);
  for (const s of [now, before]) {
    asleepMasks(s, true);
    await s.w.step(2);
  }
  // (asleep again, by its own read)
  let slept = now.fm.sleptFrames;
  for (let i = 0; i < 40 && now.fm.sleptFrames === slept; i++) await frame(now);
  expect(now.fm.sleptFrames).toBeGreaterThan(slept);
  await sameMesh();

  // urgent: a chunk forced (STALE) and marked — rebuilt in the next frame
  const c = 6;
  const cx = c % nx;
  const cy = Math.floor(c / nx);
  for (const s of [now, before]) {
    g.device.queue.writeBuffer(s.fm.stateBuffer, (CHUNK0 + c * CSTRIDE + 5) * 4, new Uint32Array([0xfffffffe]));
    s.fm.urgent(cx * 32 + 10, (cy * 32 + 10) * (Math.sqrt(3) / 2), cx * 32 + 12, (cy * 32 + 12) * (Math.sqrt(3) / 2));
  }
  const urgent = await settleBoth();
  expect(urgent.frames).toEqual([[c]]);

  // a slide (Renderer.windowMoved → shift): the chunks the land came into are built
  for (const s of [now, before]) s.fm.shift(1, 0, [-32, 0, 0]);
  const slid = await settleBoth();
  // (and here, where no land moved under them, those whose records came from a neighbour with another key)
  for (let j = 0; j < ny; j++) expect(slid.all.has(j * nx + nx - 1)).toBe(true);

  // setWanted (Renderer.setMeshWanted): a chunk unwanted — its wanted neighbours rebuilt; wanted again — it too
  const want = new Uint8Array(nx * ny).fill(1);
  want[5] = 0;
  // (the view's cull leaves an unwanted chunk out of the near ones; here the pin stands for it)
  for (const s of [now, before]) {
    s.fm.setWanted(want);
    s.fm.pin(want);
  }
  const un = await settleBoth();
  expect(un.all.size).toBeGreaterThan(0);
  expect(un.all.has(5)).toBe(false);
  for (const s of [now, before]) {
    s.fm.setWanted(null);
    s.fm.pin(new Uint8Array(nx * ny).fill(1));
  }
  const re = await settleBoth();
  expect(re.all.has(5)).toBe(true);
  await sameMesh();

  // and asleep again after it all
  slept = now.fm.sleptFrames;
  for (let i = 0; i < 40 && now.fm.sleptFrames === slept; i++) await frame(now);
  expect(now.fm.sleptFrames).toBeGreaterThan(slept);
  expect(g.takeErrors()).toEqual([]);
});

test('asleep, a write the mesh is not told of is not meshed until wake() — why canSleep is off until every writer wakes it', async () => {
  const c = 9;
  const slept = now.fm.sleptFrames;
  expect(await frame(now)).toEqual([]);
  expect(now.fm.sleptFrames).toBe(slept + 1);
  // (a writer's change stands in: the chunk's built key forced — a stamp into a sleeping chunk moves its version the same)
  for (const s of [now, before]) g.device.queue.writeBuffer(s.fm.stateBuffer, (CHUNK0 + c * CSTRIDE + 5) * 4, new Uint32Array([0xfffffffe]));
  expect(await frame(before)).toEqual([c]);
  for (let i = 0; i < 5; i++) expect(await frame(now)).toEqual([]);
  now.fm.wake();
  expect(await frame(now)).toEqual([c]);
  expect(g.takeErrors()).toEqual([]);
});
