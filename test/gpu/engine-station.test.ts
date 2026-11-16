// The break station's drops, exactly as its buttons make them (levels/playground.ts 'break'), through the merged tick
// (BACKLOG PM2): the brick wall pushed over and the stone block from 24 and 48 cells break into parts; from 8 the
// block stays whole. And PM1: a row that expands takes gravity once in the tick it expands.
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { POOL } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { TUNE } from '../../src/tune/params';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, flat } from './engine-rig';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());
const T = TUNE.engine as Record<string, number>;
const T0 = { ...T };
afterEach(() => Object.assign(T, T0));
const DEFORM = 8;
const FLOOR = 10;
const log = (s: string) => {
  if (process.env.BREAK_LOG) console.log(s);
};

type V3 = [number, number, number];
/** a drop followed till nothing deforms and every row sleeps: whether it ever deformed, and the rows left */
async function drop(cells: ReturnType<typeof box>, vel?: V3, spin?: V3): Promise<{ hit: boolean; parts: number }> {
  const R = await breakRig(g, flat, 64, 64);
  const b = R.e.add({ cells, mesh: modelMesh(cells), vel, spin })!;
  let hit = false;
  let parts = 0;
  for (let t = 0; t < 120; t++) {
    await R.step(10);
    if ((await R.row(b.row)).flags & DEFORM) hit = true;
    const rows = await R.rows();
    parts = rows.length;
    if ((await R.pool())[POOL.deforming] === 0 && rows.every((r) => r.flags & 2)) break;
  }
  expect(g.takeErrors()).toEqual([]);
  R.w.destroy();
  return { hit, parts };
}

test('the brick wall pushed over breaks into parts', async () => {
  const r = await drop(box(20, 20, FLOOR + 22, 8, 2, 7, MAT.Brick), [0, 1.5, 0], [1.1, 0, 0]);
  log(`brick wall: deformed ${r.hit}, ${r.parts} rows at rest`);
  expect(r.hit).toBe(true);
  expect(r.parts).toBeGreaterThan(1);
}, 240_000);

// (the first height was 8 cells. A fall of 8 cells is 78 cells²/s² a mass, over stone's bar of 60: it stayed whole only
// because the rigid contact took part of its speed before the bar was weighed — BACKLOG PE30, fixed with PQ4. From 5
// cells it is 49: under the bar, whole whatever the tick it lands on.)
test('the stone block: whole from 5 cells, in parts from 24 and from 48', async () => {
  const n: number[] = [];
  for (const h of [5, 24, 48]) {
    const r = await drop(box(20, 20, FLOOR + h, 6, 6, 4, MAT.Stone), [2.5, 1.5, 0]);
    log(`stone from ${h}: deformed ${r.hit}, ${r.parts} rows at rest`);
    n.push(r.parts);
  }
  expect(n[0]).toBe(1);
  expect(n[1]).toBeGreaterThan(1);
  expect(n[2]).toBeGreaterThan(1);
}, 240_000);
