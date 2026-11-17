// (loop round 14, LS-122; docs/design/FRONTS.md "Hot lava runs") How far the flow model's lava runs down a long, even
// slope from a spring, and that it still sets: hot lava runs, cooling lava stalls and turns to basalt. The liquids'
// kernels on Dawn in Node (liquid.wgsl `fluidity`, the heat-dependent yield).
//
// Each case pours at the high end of a 256-column ramp for `pour` seconds, then lets it cool. Measured: the farthest
// column holding lava or new rock (reach), the lava still molten, the volume poured vs what lies on the ramp (molten +
// set), all after the pour and after the cooling. LAVA_LOG=1 prints the table.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LAVA } from '../../src/flow/liquid';
import { TUNING } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 256;
const H = 32;
const TOP = 60;
let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
});

interface Reach {
  slope: number;
  rate: number;
  /** farthest column with lava or new rock after the pour, and after the cooling */
  reachPour: number;
  reachCool: number;
  /** molten volume after the pour and after the cooling */
  moltenPour: number;
  moltenCool: number;
  /** poured (spring rate x time) and what lies on the ramp after the cooling (molten + rock grown) */
  poured: number;
  lying: number;
}

async function ramp(slope: number): Promise<TinyWorld> {
  const rim = (x: number, y: number) => x === 0 || y === 0 || x === W - 1 || y === H - 1;
  const map = tinyMap(W, H, 80, (x, y) => [{ z0: 0, z1: rim(x, y) ? 78 : TOP - x * slope, mat: MAT.Stone }]);
  return tinyWorld(g, map, ['surface', 'liquid-lava']);
}

async function run(slope: number, rate: number, pour = 40, cool = 120): Promise<Reach> {
  const w = await ramp(slope);
  try {
    const L = w.core.flow!.lava;
    const ring = w.core.world.ring;
    const ground0 = (await w.core.captureMap()).surface;
    L.addSpring(6, H >> 1, TOP - 6 * slope + 0.5, rate);
    for (let i = 0; i < pour; i++) await w.step(60);
    const measure = async () => {
      const raw = new Float32Array(await g.read(L.open, L.open.size));
      const ground = (await w.core.captureMap()).surface;
      let reach = 0;
      let molten = 0;
      let rock = 0;
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const d = raw[ring.idx(x, y)];
          const grown = Math.max(0, ground[y * W + x] - ground0[y * W + x]);
          molten += d;
          rock += grown;
          if (d > 0.05 || grown > 0.05) reach = Math.max(reach, x);
        }
      return { reach, molten, rock };
    };
    const a = await measure();
    L.springs.length = 0;
    for (let i = 0; i < cool; i++) await w.step(60);
    const b = await measure();
    expect(g.takeErrors()).toEqual([]);
    return { slope, rate, reachPour: a.reach, reachCool: b.reach, moltenPour: a.molten, moltenCool: b.molten, poured: rate * pour, lying: b.molten + b.rock };
  } finally {
    w.destroy();
  }
}

// (a sweep: LAVA_HOTGAIN=n runs with that hot gain — the kernels are made with the world)
if (process.env.LAVA_HOTGAIN) LAVA.hotGain = Number(process.env.LAVA_HOTGAIN);
if (process.env.LAVA_COOL) TUNING.set('flow.lavaCool', Number(process.env.LAVA_COOL));
const SLOPES = [0.05, 0.1, 0.2];
const out: Reach[] = [];

test('lava reach down a long slope, and it sets', async () => {
  for (const s of SLOPES) out.push(await run(s, Number(process.env.LAVA_RATE ?? 120), Number(process.env.LAVA_POUR ?? 60)));
  if (process.env.LAVA_LOG) {
    const lines = ['slope rate | reach pour, cooled | molten pour, cooled | poured lying'];
    for (const r of out) lines.push(`${r.slope} ${r.rate} | ${r.reachPour} ${r.reachCool} | ${r.moltenPour.toFixed(1)} ${r.moltenCool.toFixed(1)} | ${r.poured} ${r.lying.toFixed(1)}`);
    writeFileSync(process.env.LAVA_LOG, lines.join('\n') + '\n');
  }
  // (measured, round 14, 120/s for 60 s: before the heat rule 39 / 41 / 35 columns and 4300-5400 still molten after
  // 120 s; after it 130 / 218 / 254, all set)
  if (!process.env.LAVA_HOTGAIN && !process.env.LAVA_COOL && !process.env.LAVA_RATE) {
    expect(out[1].reachPour, 'hot lava runs: 150+ columns down a 1-in-10 slope').toBeGreaterThan(150);
    expect(out[0].reachPour, 'and further the steeper').toBeLessThan(out[1].reachPour);
    expect(out[1].reachPour).toBeLessThan(out[2].reachPour);
  }
  for (const r of out) {
    expect(r.reachCool - r.reachPour, `slope ${r.slope}: cooling lava stalls once the spring stops`).toBeLessThan(12);
    expect(r.moltenCool, `slope ${r.slope}: it sets once the spring stops`).toBeLessThan(r.poured * 0.05);
    expect(Math.abs(r.lying - r.poured) / r.poured, `slope ${r.slope}: mass kept`).toBeLessThan(0.15);
  }
}, 600000);
