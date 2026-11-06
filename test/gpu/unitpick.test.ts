// (round 128p, DA-B22 (c)(2)) A tap's unit found on the GPU (agents/pick.ts): among the candidates named, the one whose
// figure middle projects nearest the tap within the radius — what the CPU's projection of every candidate finds;
// none outside the radius, none not among the candidates, none dead.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld } from './world';
import { installAgents } from '../../src/agents/install';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;

/** a camera's matrix, column-major: an oblique view (x, y across, z up the screen) onto a 400 × 800 viewport */
function camera(): Float32Array {
  const m = new Float32Array(16);
  // clip x = (x - 32) / 40, clip y = (32 - y) / 50 * 0.8 + z * 0.02, w = 1
  m[0] = 1 / 40;
  m[12] = -32 / 40;
  m[5] = -0.8 / 50;
  m[9] = 0.02;
  m[13] = (32 * 0.8) / 50;
  m[15] = 1;
  return m;
}
const project = (m: Float32Array, x: number, y: number, z: number): [number, number] => {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [((cx / w + 1) / 2) * 400, ((1 - cy / w) / 2) * 800];
};

test('the nearest candidate drawn within the radius of a tap, as the CPU projects it', async () => {
  const w = await tinyWorld(g, tinyMap(W, W, 32, () => [{ z0: 0, z1: 10, mat: MAT.Stone }]), ['surface']);
  const agents = installAgents(w.core);
  const ids = agents.spawn(120, 32, 28, { spread: 20 });
  for (let i = 0; i < 30; i++) w.core.sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
  const units = new Float32Array(await agents.readRaw('units'));
  const at = (id: number) => [units[(id % 8192) * 24], units[(id % 8192) * 24 + 1], units[(id % 8192) * 24 + 2]];
  const m = camera();
  // (the candidates: every other unit)
  const cand = ids.filter((_, i) => i % 2 === 0);
  let checked = 0;
  for (let t = 0; t < 40; t++) {
    const tap: [number, number] = [20 + ((t * 97) % 360), 100 + ((t * 233) % 600)];
    let want: number | null = null;
    let bd = 26;
    for (const id of cand) {
      const p = at(id);
      const [px, py] = project(m, p[0], p[1], p[2] + 0.7);
      const d = Math.hypot(px - tap[0], py - tap[1]);
      if (d < bd) {
        bd = d;
        want = id;
      }
    }
    const got = await agents.pick(cand, { viewProj: m, viewport: [400, 800], at: tap, radius: 26, lift: 0.7 });
    expect(got, `tap ${tap}`).toBe(want);
    if (want !== null) checked++;
  }
  expect(checked).toBeGreaterThan(5);
  // (none among no candidates)
  expect(await agents.pick([], { viewProj: m, viewport: [400, 800], at: [200, 400], radius: 26, lift: 0.7 })).toBe(null);
  expect(g.takeErrors()).toEqual([]);
  w.destroy();
});
