// (loop round 12, docs/design/FRONTS.md) A shield is a wall to the liquids: lava poured up a slope toward a disc parts
// round it — none flows in, it runs on past both sides — and with no shield the same lava runs over the disc's ground.
// The liquids' kernels on Dawn in Node (liquid.wgsl `shielded`; LiquidSystem.shields).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Shields } from '../../src/api/shields';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 64;
let g: TestGpu;
const made: TinyWorld[] = [];
beforeAll(async () => {
  g = await testGpu();
});
afterAll(async () => {
  await g.device.queue.onSubmittedWorkDone();
  for (const w of made) w.destroy();
});

/** ground falling toward +x (a cell every 4 columns), walls round the rim */
async function slope(): Promise<TinyWorld> {
  const rim = (x: number, y: number) => x === 0 || y === 0 || x === W - 1 || y === W - 1;
  const map = tinyMap(W, W, 48, (x, y) => [{ z0: 0, z1: rim(x, y) ? 40 : 34 - Math.floor(x / 2), mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface', 'liquid-lava']);
  made.push(w);
  return w;
}

/** the lava's open depth by window column */
async function lava(w: TinyWorld): Promise<(x: number, y: number) => number> {
  const L = w.core.flow!.lava;
  const raw = new Float32Array(await g.read(L.open, L.open.size));
  const ring = w.core.world.ring;
  return (x, y) => raw[ring.idx(x, y)];
}

const SHIELD = { x: 28, y: cellPos(0, 32)[1], r: 7 };
const inside = (x: number, y: number) => {
  const [px, py] = cellPos(x, y);
  return Math.hypot(px - SHIELD.x, py - SHIELD.y) < SHIELD.r;
};

async function pour(shield: boolean): Promise<{ in: number; past: number; sides: [number, number] }> {
  const w = await slope();
  const L = w.core.flow!.lava;
  if (shield) L.shields = [SHIELD];
  // (hot lava, poured long enough to reach past the disc)
  L.addSpring(10, SHIELD.y, 31, 40);
  for (let i = 0; i < 30; i++) await w.step(50);
  const d = await lava(w);
  let inn = 0;
  let past = 0;
  const sides: [number, number] = [0, 0];
  for (let y = 1; y < W - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const v = d(x, y);
      if (inside(x, y)) inn += v;
      const [px, py] = cellPos(x, y);
      if (px > SHIELD.x + SHIELD.r) {
        past += v;
        sides[py < SHIELD.y ? 0 : 1] += v;
      }
    }
  if (process.env.SHIELD_LOG) {
    const rows: string[] = [];
    for (let y = 16; y < 48; y += 2) {
      let s = '';
      for (let x = 4; x < W - 4; x++) s += inside(x, y) ? '#' : d(x, y) > 0.5 ? 'O' : d(x, y) > 0.05 ? 'o' : d(x, y) > 0.001 ? '.' : ' ';
      rows.push(s);
    }
    console.log(`shield ${shield}\n${rows.join('\n')}`);
  }
  return { in: inn, past, sides };
}

// (loop round 14, docs/design/FRONTS.md "The shield as an energy barrier") The press read on the GPU (shields.wgsl):
// lava standing at the rim drains the store; a big store holds, a small one gives way — told as 'drained'.
async function pressed(energy: number): Promise<{ ended: string | null; lava: number; left: number }> {
  const w = await slope();
  const L = w.core.flow!.lava;
  const shields = new Shields(w.core.flow!, () => {}, w.core.globals, { device: g.device, globals: () => w.core.world.globals, fire: () => w.core.world.fire, lava: () => L.open, units: () => null, combat: () => null });
  let ended: string | null = null;
  shields.onEnd.push((_s, how) => (ended = how));
  const s = shields.raise(SHIELD.x, SHIELD.y, { radius: SHIELD.r, seconds: 1000, z: 30, energy, regen: 0 });
  L.addSpring(10, SHIELD.y, 31, 40);
  let lava = 0;
  for (let i = 0; i < 120 && !ended; i++) {
    await w.step(15);
    shields.update(0.25);
    // (the read is async: let it land before the next quarter second)
    await g.device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 5));
    lava = Math.max(lava, s.press.lava);
  }
  expect(g.takeErrors()).toEqual([]);
  return { ended, lava, left: s.energy };
}

test('a shield drains under the lava pressing on it: a big store holds, a small one gives way', async () => {
  const big = await pressed(1e6);
  expect(big.lava, 'lava measured at the rim').toBeGreaterThan(1);
  expect(big.ended, 'a big store holds').toBe(null);
  expect(big.left).toBeLessThan(1e6);
  const small = await pressed(5);
  expect(small.ended, 'a small store gives way').toBe('drained');
}, 300000);

test('a shield is a wall to lava: it parts round the disc and runs on past both sides', async () => {
  const open = await pour(false);
  expect(open.in, 'no shield: lava over the disc').toBeGreaterThan(5);
  const held = await pour(true);
  expect(held.in, 'a shield: no lava inside it').toBeLessThan(0.01);
  expect(held.past, 'it runs on past the disc').toBeGreaterThan(1);
  expect(Math.min(...held.sides), 'round both sides').toBeGreaterThan(0.2);
  expect(g.takeErrors()).toEqual([]);
}, 300000);
