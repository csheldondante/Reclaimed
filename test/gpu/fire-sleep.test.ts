// (round 128, treegen) The fire's hold on sleep: a fire set in a wood keeps burning past the 8 s a woken chunk stays
// awake, and spreads chunk to chunk — a burning chunk stays awake and the one its fire reaches wakes (firewatch.wgsl,
// Sleep.holdBurning) — while a chunk with no fire sleeps on schedule. Before: the lightning-set elder wood's fire froze
// where it stood 8 s on (the burn shots: the fire field identical to 3 decimals from 20 s to 60 s).
// The level's loop, in sim time: each frame the sleep mask from the events, two ticks of the fire and its watch; twice a
// second the watch read and cleared, as LevelScene.readBurning does.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Sleep } from '../../src/sim/sleep';
import { EventKind } from '../../src/sim/globals';
import { CHUNK } from '../../src/world/layout';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
const H = 64;
let g: TestGpu;
let w: TinyWorld;
let sleep: Sleep;
let now = 0;

// a wood over the west and middle (x < 44), bare stone in the east: the chunk there never has fuel
const map = tinyMap(W, H, 32, () => [{ z0: 0, z1: 10, mat: MAT.Soil }]);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) map.vegetation[y * W + x] = x < 44 ? 4.2 : 0;
for (let i = 0; i < W * H; i++) map.moisture[i] = 0.2;

beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, map, ['fire', 'firewatch']);
  sleep = new Sleep(W / CHUNK, H / CHUNK, w.core.ring);
});
afterAll(() => w?.destroy());

async function readWatch(): Promise<Float32Array> {
  const dev = g.device;
  const src = w.core.world.fireChunks;
  const tmp = dev.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = dev.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, tmp, 0, src.size);
  enc.clearBuffer(src);
  dev.queue.submit([enc.finish()]);
  await tmp.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(tmp.getMappedRange().slice(0));
  tmp.destroy();
  return out;
}

/** run `secs` of sim time as the level does (60 ticks a second, two a frame) */
async function run(secs: number, events: { kind: number; x: number; y: number; radius: number; strength: number }[] = []): Promise<void> {
  const frames = Math.round(secs * 30);
  for (let f = 0; f < frames; f++) {
    const ev = f === 0 ? events : [];
    w.core.globals.events.push(...ev);
    w.core.globals.sleep = sleep.update(now, null, ev, [], w.ticks);
    w.core.globals.drowse = sleep.drowse;
    await w.step(2);
    w.core.globals.events.length = 0;
    now += 1 / 30;
    if (f % 15 === 14) sleep.holdBurning(await readWatch(), now);
  }
}

const chunkOf = (x: number, y: number) => Math.floor(y / CHUNK) * (W / CHUNK) + Math.floor(x / CHUNK);
async function fire(): Promise<Float32Array> {
  return w.read('fire' as 'water');
}
function burningIn(f: Float32Array, k: number): number {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (chunkOf(x, y) === k && f[y * W + x] > 0.05) n++;
  return n;
}

test('a fire set in a wood burns past 8 s and spreads chunk to chunk; a chunk with no fire sleeps on schedule', { timeout: 300000 }, async () => {
  // set alight in chunk (0, 1), a few columns in from its east edge; and an event in the bare east (chunk (3, 3)) that
  // wakes it with nothing there to burn
  const [ix, iy] = cellPos(11, 24);
  const [ex, ey] = cellPos(56, 56);
  const start = chunkOf(11, 24);
  const east = chunkOf(56, 56);
  await run(1, [
    { kind: EventKind.Ignite, x: ix, y: iy, radius: 2, strength: 0.9 },
    { kind: EventKind.Scare, x: ex, y: ey, radius: 1, strength: 1 },
  ]);
  expect(g.takeErrors()).toEqual([]);
  const f1 = await fire();
  expect(burningIn(f1, start), 'burning after 1 s').toBeGreaterThan(0);
  expect(sleep.isAwakeSlot(east, now), 'the east chunk woken by its event').toBe(true);
  await run(11);
  // past the 8 s an event keeps a chunk awake
  const f12 = await fire();
  expect(sleep.isAwakeSlot(start, now), 'the burning chunk held awake at 12 s').toBe(true);
  expect(sleep.isAwakeSlot(east, now), 'the east chunk (no fire) asleep at 12 s').toBe(false);
  await run(28);
  const f40 = await fire();
  let changed = 0;
  for (let i = 0; i < W * H; i++) if (Math.abs(f40[i] - f12[i]) > 1e-3) changed++;
  // (the fire went on: columns burning up, out, catching — not carried frozen)
  expect(changed, 'columns whose fire changed between 12 s and 40 s').toBeGreaterThan(5);
  // (it crossed into a chunk next to the start: east (1, 1), or north / south)
  const next = [chunkOf(20, 24), chunkOf(11, 12), chunkOf(11, 36)];
  const crossed = next.map((k) => burningIn(f40, k));
  expect(Math.max(...crossed), `burning in the neighbours ${JSON.stringify(crossed)} (start ${burningIn(f40, start)})`).toBeGreaterThan(0);
  expect(sleep.burning, 'chunks held by fire').toBeGreaterThan(0);
});
