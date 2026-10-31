// Round 120 (the user, on the deployed lab: "I noticed weird sliding in this build under all settings. rock towers fell
// then slid along flat ground quite far"). The CPU rigid rock (the baseline, `?solver=old`) on flat stone: a block
// slid at v stops within v²/(2μg), and a tower toppled over lands and rests within about its own height of its foot.
// (The node solver's own: test/gpu/solver.test.ts.)
import { afterEach, expect, test } from 'vitest';
import { TUNING, TUNE, worldG } from '../../src/tune/params';
import { RockBodies, RB, type RockGround } from '../../src/game/rockbodies';
import { cellPos } from '../../src/world/lattice';

afterEach(() => TUNING.reset());

const FLOOR = 10;
/** flat stone, its top at z FLOOR */
const FLAT: RockGround = {
  probe: (_x, _y, z) => (z < FLOOR ? { d: FLOOR - z, n: [0, 0, 1] } : null),
  topIn: () => FLOOR,
};

function box(rb: RockBodies, w: number, d: number, h: number, x0: number, y0: number, z0: number) {
  const cells = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < d; y++) for (let z = 0; z < h; z++) cells.push({ x: x0 + x, y: y0 + y, z: z0 + z, mat: 1 });
  const b = rb.spawn(cells)!;
  expect(b).toBeTruthy();
  return b;
}

function settle(rb: RockBodies, secs: number, each?: () => void) {
  for (let i = 0; i < secs * 60; i++) {
    rb.update(1 / 60);
    each?.();
  }
}

test('a block slid at v on flat stone stops within v²/(2μg)', () => {
  const rb = new RockBodies(FLAT);
  const b = box(rb, 4, 4, 2, 20, 20, FLOOR);
  // (resting on the floor first)
  settle(rb, 1);
  const v = 8;
  const x0 = b.pos[0];
  b.v = [v, 0, 0];
  let most = 0;
  settle(rb, 4, () => (most = Math.max(most, b.pos[0] - x0)));
  const bound = (v * v) / (2 * RB.friction * worldG() * RB.gravity);
  if (process.env.SOLVER_LOG) console.log('slid', most.toFixed(2), 'bound', bound.toFixed(2), 'v now', b.v.map((q) => q.toFixed(2)));
  expect(most).toBeLessThan(bound * 1.15);
  expect(Math.abs(b.v[0])).toBeLessThan(0.2);
});

test('a tower toppled onto flat stone rests within about its own height of its foot', () => {
  const rb = new RockBodies(FLAT);
  const H = 16;
  const b = box(rb, 3, 3, H, 40, 40, FLOOR);
  const [fx] = cellPos(41, 41);
  // a push at its top: it tips over and falls flat
  b.w = [0, 1.2, 0];
  b.v = [1, 0, 0];
  settle(rb, 8);
  const off = Math.abs(b.pos[0] - fx);
  if (process.env.SOLVER_LOG) console.log('tower rests', off.toFixed(2), 'from its foot; v', b.v.map((q) => q.toFixed(2)), 'pos', b.pos.map((q) => q.toFixed(2)));
  expect(off).toBeLessThan(H * 1.1);
  expect(Math.hypot(b.v[0], b.v[1])).toBeLessThan(0.3);
});

test('the friction is the tuning (μ 0: the same push slides on)', () => {
  TUNE.rigid.friction = 0;
  TUNE.rigid.contactDamp = 0;
  const rb = new RockBodies(FLAT);
  const b = box(rb, 4, 4, 2, 20, 20, FLOOR);
  settle(rb, 1);
  b.v = [4, 0, 0];
  settle(rb, 1);
  expect(b.v[0]).toBeGreaterThan(3);
});
