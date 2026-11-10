// (round 128r, Track A "Next season") A flood standing in the live window (src/terrain/basin.ts): one fill finds the
// basin, the water is written still at its level over it as held water, and it stays — no run-off, nothing simulated
// into it — until it's lowered. A bowl in a tiny world: floor 6, a rim 12 high with a notch at 11, the plain round it 9.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { cellPos } from '../../src/world/lattice';
import { LiveFlood } from '../../src/terrain/basin';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 48;
const C = 24;
function ground(x: number, y: number): number {
  const r = Math.hypot(x - C, y - C);
  if (r < 8) return 6 + Math.floor(r * 0.5);
  if (r < 10) return x > C + 7 && Math.abs(y - C) <= 1 ? 11 : 12;
  return 9;
}

let g: TestGpu;
let w: TinyWorld;
let flood: LiveFlood;
beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(W, W, 32, (x, y) => [{ z0: 0, z1: ground(x, y), mat: MAT.Stone }]), 'all', 'table');
  await w.step(10);
  flood = new LiveFlood(g.device, w.core.world);
});
afterAll(() => {
  flood?.destroy();
  w?.destroy();
});

const at = (x: number, y: number) => y * W + x;

test('the bowl floods to its spill height, stays still, and goes when lowered', async () => {
  const [px, py] = cellPos(C, C);
  const b = await flood.basin(px, py, { side: 48 });
  expect(g.takeErrors()).toEqual([]);
  expect(b.level).toBeCloseTo(11, 3);
  b.raise(b.level);
  await w.step(1);
  let water = await w.read('water');
  expect(water[at(C, C)]).toBeCloseTo(5, 1);
  expect(water[at(C + 3, C)]).toBeCloseTo(11 - ground(C + 3, C), 1);
  // the rim and the plain outside stay dry (the notch itself is the spill point: dry)
  expect(water[at(C, C + 9)]).toBe(0);
  expect(water[at(C + 9, C)]).toBe(0);
  expect(water[at(2, 2)]).toBe(0);
  // two seconds of the whole sim: it stands where it was put (no run-off)
  await w.step(120);
  water = await w.read('water');
  expect(water[at(C, C)]).toBeGreaterThan(4.9);
  expect(water[at(C + 9, C)]).toBeLessThan(0.01);
  expect(water[at(2, 2)]).toBeLessThan(0.01);
  // what it covers: a structure in the bowl, one on the plain
  const sub = await b.submerged([
    { col: [C, C], structure: 7 },
    { col: [3, 3], structure: 9 },
  ]);
  expect([...sub]).toEqual([7]);
  b.lower(-Infinity);
  await w.step(30);
  water = await w.read('water');
  expect(water[at(C, C)]).toBeLessThan(0.01);
  b.destroy();
  expect(g.takeErrors()).toEqual([]);
});

test('a given level under the spill height: only the lower bowl', async () => {
  const [px, py] = cellPos(C, C);
  const b = await flood.basin(px, py, { side: 48, level: 8 });
  b.raise(8);
  await w.step(1);
  const water = await w.read('water');
  expect(water[at(C, C)]).toBeCloseTo(2, 1);
  expect(water[at(C + 6, C)]).toBe(0);
  b.lower(-Infinity);
  b.destroy();
  expect(g.takeErrors()).toEqual([]);
});
