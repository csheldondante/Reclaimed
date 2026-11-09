// (round 128o, DA-B22: the tumble's sub-moves) A unit thrown hard at a wall one column thick never gets into it nor
// through it, at fast-forward's longest steps as a tick at a time. The units step in strides of a frame's ticks
// (agents/stepplan.ts); a stride of 9 ticks at 60 cells/s is 9 cells — past a one-column wall in one move, were the
// move not taken in sub-moves of at most half a cell (units.wgsl SUB_MOVE), each checking the column it enters.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAT } from '../../src/world/materials';
import { cellAt, cellPos } from '../../src/world/lattice';
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
/** the wall: column x 40 on every row, 6 high over ground at 10 */
const WALL_X = 40;
const GROUND = 10;
const TOP = 16;

async function throwAt(frameTicks: number) {
  const map = tinyMap(W, W, 32, (x) => [{ z0: 0, z1: x === WALL_X ? TOP : GROUND, mat: MAT.Stone }]);
  const w = await tinyWorld(g, map, ['surface']);
  const agents = installAgents(w.core);
  const sim = w.core.sim;
  // (a frame of `frameTicks` ticks, as WorldCore.advance steps one)
  const frame = () => {
    sim.frameTicks = frameTicks;
    for (let i = 0; i < frameTicks; i++) {
      sim.tickOfFrame = i;
      sim.step(w.core.globals, (s) => s.name === 'surface' || s.name === 'agents');
    }
    sim.frameTicks = 1;
    sim.tickOfFrame = 0;
  };
  const throws: { v: number; ang: number; id: number }[] = [];
  for (const v of [10, 25, 40, 60, 90]) for (const ang of [0, 25, -40]) {
    const [x, y] = cellPos(30, 12 + throws.length * 2);
    const [id] = agents.spawn(1, x, y, { spread: 0 });
    throws.push({ v, ang, id });
  }
  // (on their feet first)
  for (let i = 0; i < Math.ceil(60 / frameTicks); i++) frame();
  for (const t of throws) {
    const a = (t.ang * Math.PI) / 180;
    agents.launch(t.id, [t.v * Math.cos(a), t.v * Math.sin(a), 1]);
  }
  const bad: string[] = [];
  let most = 0;
  for (let f = 0; f < Math.ceil(240 / frameTicks); f++) {
    frame();
    const u = new Float32Array(await agents.readRaw('units'));
    for (const t of throws) {
      const o = (t.id % 8192) * 24;
      const [cx] = cellAt(u[o], u[o + 1]);
      most = Math.max(most, cx);
      if (cx > WALL_X) bad.push(`${t.v}/${t.ang}: through, column ${cx} at frame ${f}`);
      else if (cx === WALL_X && u[o + 2] < TOP - 0.3) bad.push(`${t.v}/${t.ang}: inside, z ${u[o + 2].toFixed(2)} at frame ${f}`);
    }
  }
  expect(g.takeErrors()).toEqual([]);
  return { bad: [...new Set(bad)].slice(0, 10), most, stride: agents.strideMost() };
}

test('a frame of 16 ticks (16x): no throw gets into a one-column wall or through it', async () => {
  const r = await throwAt(16);
  expect(r.stride).toBeGreaterThan(1);
  expect(r.bad).toEqual([]);
  // (the throws reached it: the column before the wall)
  expect(r.most).toBe(WALL_X - 1);
});

test('a tick a frame (1x): the same', async () => {
  const r = await throwAt(1);
  expect(r.bad).toEqual([]);
  expect(r.most).toBe(WALL_X - 1);
});
