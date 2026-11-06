// (round 128o, DA-B22) The profiler's timestamps grow with the frame: a frame at 16x asks for several hundred, and a
// fixed 128 left the passes past it (the draw among them) untimed with nothing said. Now the set doubles for the next
// frame, and what a frame couldn't time is counted (`untimed`), never silent.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { testGpu, type TestGpu } from './dawn';
import { Profiler } from '../../src/gpu/profiler';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

test('a frame asking for more timestamps than the set holds: counted, and the set grows for the next', () => {
  const has = g.device.features.has('timestamp-query');
  const p = new Profiler(g.device, has);
  if (!has) {
    expect(p.enabled).toBe(false);
    return;
  }
  const ask = (n: number) => {
    let timed = 0;
    for (let i = 0; i < n; i++) if (p.timestamps(`pass ${i}`)) timed++;
    return timed;
  };
  p.beginFrame();
  expect(ask(100)).toBe(64);
  p.beginFrame();
  // (the last frame's 36 untimed passes, said)
  expect(p.untimed).toBe(36);
  expect(ask(100)).toBe(100);
  p.beginFrame();
  expect(p.untimed).toBe(0);
  expect(g.takeErrors()).toEqual([]);
});
