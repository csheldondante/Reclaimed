// (round 128o, B: the passage chosen on the GPU) The reach's fix field on the GPU (fortreach.wgsl fixRelax, fixTrace)
// answers as its CPU reference (reach.ts CpuReach): a pocket shut in by cuttable plan solid is joined by cutting it (the
// fewest columns), a terrace 2 m up by a ramp, a cliff 6 m up not at all — each place its fixes, the same on both.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { FortressReachGpu } from '../../src/build/reachgpu';
import { CpuReach, packSpan, REACH_BITS, type ReachAsk, type ReachColumns, type ReachFix } from '../../src/build/reach';
import { cellPos } from '../../src/world/lattice';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;
/** the ground: 5 m, a terrace 4 m up (x 40..50: past DROP, a stair joins it), a cliff 7 m up (x >= 56) */
const groundAt = (x: number) => (x >= 56 ? 12 : x >= 40 && x < 50 ? 9 : 5);
/** a ring of cuttable plan solid (a house's ground floor) round (16, 20), 3 to 5 m out, 8 m tall */
const RING: [number, number] = [16, 20];
const ringAt = (x: number, y: number) => {
  const [wx, wy] = cellPos(x, y);
  const d = Math.hypot(wx - RING[0], wy - RING[1]);
  return d >= 3 && d <= 5;
};

test('the fix field and its walk back: the GPU as the CPU reference', async () => {
  const map = tinyMap(W, W, 32, (x) => [{ z0: 0, z1: groundAt(x), mat: MAT.Stone }]);
  const world = await tinyWorld(g, map, ['surface']);
  const cols: ReachColumns = { w: W, h: W, runs: (x) => [[0, groundAt(x)]], water: () => 0 };
  const spans = new Uint32Array(W * W * 2);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (ringAt(x, y)) spans[2 * (y * W + x)] = packSpan(5, 13, true);
  // (the places: the pocket's middle, the terrace, the cliff's top; the stores at (8, 40) on the ground)
  const col = (x: number, y: number) => y * W + x;
  const places = [col(15, 23), col(45, 30), col(60, 30)];
  const ask: ReachAsk = { stores: [8, 40], storesZ: 5, queries: new Int32Array(places.flatMap((c) => [c, -1, -1, -1])), floors: new Float32Array(places.flatMap((c) => [groundAt(c % W), 0, 0, 0])), wet: false, why: true, fix: true };
  const cpu = new CpuReach(cols, W, W, () => [0, 0]);
  cpu.setSpans(spans);
  const gpu = new FortressReachGpu(g.device, world.core.world, W, W, () => [0, 0]);
  gpu.setSpans(spans);
  const a = await cpu.check(ask);
  const b = await gpu.check(ask);
  const key = (f: ReachFix) => `${f.query}:${f.kind}:${f.col}:${f.dir}`;
  // (none reached; the pocket and the terrace fixable, the cliff not)
  expect([...a.bits].map((v) => [v & REACH_BITS.reached, v & REACH_BITS.fixable])).toEqual([[0, 32], [0, 32], [0, 0]]);
  expect([...b.bits]).toEqual([...a.bits]);
  expect(b.fixes.map(key).sort()).toEqual(a.fixes.map(key).sort());
  // (the pocket: cut through the ring — its width, a couple of columns —, no ramp; the terrace: one ramp, no cut)
  const pocket = a.fixes.filter((f) => f.query === 0);
  expect(pocket.every((f) => f.kind === 'cut')).toBe(true);
  expect(pocket.length).toBeGreaterThanOrEqual(1);
  expect(pocket.length).toBeLessThanOrEqual(4);
  const terrace = a.fixes.filter((f) => f.query === 1);
  expect(terrace.map((f) => f.kind)).toEqual(['ramp']);
  expect(a.fixes.filter((f) => f.query === 2)).toEqual([]);
  gpu.dispose();
  expect(g.takeErrors()).toEqual([]);
});
