// (DA-B15) The coarse world steps only its live tiles (where something changed or flowed, beside them, under a vent)
// and puts only their cells back: the same world, bit for bit, as stepping every tile every step — through a meteor,
// an eruption (its cone, its ash, a vent pouring lava that cools and sets), rain and erosion turned on and off, and
// rest after.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Coarse } from '../../src/atlas/coarse';
import { testGpu, type TestGpu } from './dawn';

const CN = 64;
const WORLD = 2048;
let g: TestGpu;
let live: Coarse;
let every: Coarse;

/** a rolling macro ground: hills, a valley, sea in one corner */
const ground = () => {
  const h = new Float32Array(CN * CN);
  for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) h[j * CN + i] = 40 + 18 * Math.sin(i / 7) * Math.cos(j / 9) + (i + j) * 0.3;
  return h;
};
const sea = (t: number) => t % CN < 6 && Math.floor(t / CN) < 6;

beforeAll(async () => {
  g = await testGpu();
  live = new Coarse(g.device, CN, WORLD, WORLD);
  every = new Coarse(g.device, CN, WORLD, WORLD, false);
  const h = ground();
  await live.init(h, CN, sea);
  await every.init(h, CN, sea);
});
afterAll(() => {
  live?.dispose();
  every?.dispose();
});

const cells = async (c: Coarse) => new Uint32Array(await g.read(c.cells, CN * CN * 32));
/** the live tiles the last step went over */
const liveTiles = async (c: Coarse) => new Uint32Array(await g.read((c as unknown as { args: GPUBuffer }).args, 4))[0];

test('the live tiles step to the same world as every tile', async () => {
  const both = (f: (c: Coarse) => void) => [live, every].forEach(f);
  both((c) => c.step(3));
  both((c) => c.meteor(900, 700, 180));
  both((c) => c.step(40));
  const after = await cells(live);
  expect(after.some((v) => v !== 0), 'the meteor changed the world').toBe(true);
  expect(after).toEqual(await cells(every));
  // (a crater is a corner of the world: most tiles at rest while it slumps)
  const n = await liveTiles(live);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan((CN / 8) ** 2);
  both((c) => c.erupt(1500, 1300, { lava: 0.4, steps: 60 }));
  // (a step's parts over several calls, as the level spreads them)
  for (let k = 0; k < 3 * 30; k++) both((c) => c.stepPart());
  expect(await cells(live)).toEqual(await cells(every));
  both((c) => c.step(150));
  expect(await cells(live)).toEqual(await cells(every));
  expect(g.takeErrors()).toEqual([]);
});

test('at rest nothing steps', async () => {
  // (the meteor's slopes slump, the lava sets; then the world is still)
  live.step(600);
  every.step(600);
  expect(await cells(live)).toEqual(await cells(every));
  live.step(1);
  const n = await liveTiles(live);
  expect(n).toBe(0);
  expect(await liveTiles(every)).toBe((CN / 8) ** 2);
  expect(g.takeErrors()).toEqual([]);
});

test('rain and wearing water turned on and off: every tile live the step it changes, the same world', async () => {
  const both = (f: (c: Coarse) => void) => [live, every].forEach(f);
  both((c) => ((c.rain = 0.002), (c.erode = 0.05)));
  both((c) => c.step(60));
  expect(await cells(live)).toEqual(await cells(every));
  both((c) => ((c.rain = 0), (c.erode = 0)));
  both((c) => c.step(60));
  expect(await cells(live)).toEqual(await cells(every));
  expect(g.takeErrors()).toEqual([]);
});
