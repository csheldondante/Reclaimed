// (UC-6) The steady state's judge (flow/steady.ts): a frozen chunk whose edge's inflow and outflow differ is woken — never
// its flux rescaled by in / out, which grew without bound when its awake neighbours returned what it sent them (Muru's
// river and the town's basins). Dried up (nothing coming in): zeroed, no simulation.
import { expect, test } from 'vitest';
import { Steady, STEADY_WIN } from '../../src/flow/steady';
import type { Sleep } from '../../src/sim/sleep';
import type { WorldGpu } from '../../src/sim/world-gpu';

// (Node has no WebGPU: the usage flags the constructor names)
const g = globalThis as unknown as Record<string, unknown>;
g.GPUBufferUsage ??= { STORAGE: 0x80, COPY_SRC: 0x4, COPY_DST: 0x8, MAP_READ: 0x1 };
const fakeBuf = { size: 0 } as unknown as GPUBuffer;
const world = { buf: () => fakeBuf } as unknown as WorldGpu;
const device = { createBuffer: () => fakeBuf } as unknown as GPUDevice;

function judged(net: number, thr: number) {
  const woken: number[] = [];
  const sleep = { isAwakeSlot: () => false, wakeSlot: (k: number) => woken.push(k) } as unknown as Sleep;
  const s = new Steady(device, world, sleep, 1);
  const rescaled: [number, number][] = [];
  s.onRescale = (k, r) => rescaled.push([k, r]);
  // (the counters as read back over a window: x in, y out (x 1e6, summed over the window), z perturbed)
  const u = new Uint32Array(8);
  u[0] = Math.round(net * 1e6 * STEADY_WIN);
  u[1] = Math.round(thr * 1e6 * STEADY_WIN);
  u[2] = 1;
  (s as unknown as { judge(u: Uint32Array, win: number): void }).judge(u, STEADY_WIN);
  return { woken, rescaled, last: s.last };
}

test('a frozen chunk taking in more than it sends on is woken, not rescaled', () => {
  const r = judged(0.3, 0.2);
  expect(r.rescaled).toEqual([]);
  expect(r.woken).toEqual([0]);
});

test('a frozen chunk taking in less than it sends on is woken, not rescaled', () => {
  const r = judged(0.1, 0.2);
  expect(r.rescaled).toEqual([]);
  expect(r.woken).toEqual([0]);
});

test('a frozen chunk that has dried up (nothing coming in) is zeroed', () => {
  const r = judged(0, 0.2);
  expect(r.rescaled).toEqual([[0, 0]]);
  expect(r.woken).toEqual([]);
});
