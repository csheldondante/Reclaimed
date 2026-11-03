// (round 128, INT16's second mechanism) A unit's exact take (edit.wgsl OP_TAKE: a builder fetching a load off a heap,
// a miner) never takes a thing's External cells: a town's heap planned under a building's roof took 0.45 off the
// claim's top a few seconds into play, the registry found the building cut and let it go to rubble. Dust or sand lying
// on the claim is its own interval on top, and a take takes that as any loose ground; the claim's z0/z1 stay exactly.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { EventKind } from '../../src/sim/globals';
import { OP, STROKE_START } from '../../src/sim/edit-ops';
import { readColumn, type Interval } from '../../src/world/layout';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

let g: TestGpu;
let w: TinyWorld;
beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(32, 32, 32), 'all');
  await w.step(10);
});
afterAll(() => w?.destroy());

async function column(x: number, y: number): Promise<Interval[]> {
  return readColumn(w.core.packed, new Uint32Array((await w.read('layers')).buffer), x, y);
}
let tag = 1;
function exact(op: number, mat: number, x: number, y: number, amount: number): void {
  const [px, py] = cellPos(x, y);
  w.core.globals.events.push({ kind: EventKind.Edit, x: px, y: py, z: op * 32 + mat + STROKE_START + tag++ * 1024, radius: 0.3, strength: amount });
}
const ext = (col: Interval[]) => col.filter((iv) => iv.mat === MAT.External).map(({ z0, z1, aux }) => ({ z0, z1, aux }));

test('a take off a claimed column takes nothing of the claim; sand on it is taken, the claim exactly as it was', async () => {
  const [ax, ay] = [8, 8];
  const [bx, by] = [20, 14];
  const top = async (x: number, y: number) => (await column(x, y)).at(-1)!.z1;
  const ta = await top(ax, ay);
  const tb = await top(bx, by);
  w.core.stampColumns([{ cuts: [], claim: [{ x: ax, y: ay, z0: ta, z1: ta + 6, aux: MAT.Rubble }, { x: bx, y: by, z0: tb, z1: tb + 6, aux: MAT.Rubble }] }]);
  await w.step(1);
  const wantA = ext(await column(ax, ay));
  const wantB = ext(await column(bx, by));
  expect(wantA).toEqual([{ z0: ta, z1: ta + 6, aux: MAT.Rubble }]);
  // (sand put on B's roof: dust on a building, as the wind leaves it)
  exact(OP.PUT, MAT.Sand, bx, by, 1);
  await w.step(1);
  const sandB = (await column(bx, by)).at(-1)!;
  expect(sandB.mat).toBe(MAT.Sand);
  // (a builder's loads off both, several times)
  for (let i = 0; i < 4; i++) {
    exact(OP.TAKE, 0, ax, ay, 0.45);
    exact(OP.TAKE, 0, bx, by, 0.3);
    await w.step(2);
  }
  expect(g.takeErrors()).toEqual([]);
  expect(ext(await column(ax, ay)), 'the claim on A as it was').toEqual(wantA);
  expect(ext(await column(bx, by)), 'the claim on B as it was').toEqual(wantB);
  // (B's sand was taken: 1 cell less 4 × 0.3, all of it — or what the wind left)
  expect((await column(bx, by)).at(-1)!.mat, 'the sand on B taken').toBe(MAT.External);
});
