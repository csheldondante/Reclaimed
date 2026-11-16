// (PA10, PA11) A hard hit knocks a building down, on a tiny world: a stone floor with one External box on it (a
// house's claim: 8 x 8 columns, 4 high) and a lot record of the same footprint.
//  - a fast row hits the box: the engine keeps the hit (its place on the box, its energy) in the ring after its
//    events, and tells the host at its chained read (Engine.onOwnerHit); a slow one tells nothing;
//  - the lot felled (game/housefall.ts): the box's External intervals are gone from the columns, rows stand in its
//    place with its volume (columns × layers), their mass the cells' by the material's density, and they come to rest
//    on the floor.
// The town's own part (the lot flagged gone, its mesh and claim grid) is citygen's: scripts/lab/townhouse.mjs.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { lotColumns, lotLayers, type LotBox } from '../../src/citygen/lotblocks';
import { HIT_AT, HIT_ROOM, type OwnerHit } from '../../src/engine/engine';
import { modelMesh } from '../../src/engine/modelmesh';
import { fellLot } from '../../src/game/housefall';
import { physMass } from '../../src/physics/physics';
import { ownedByRow } from '../../src/sim/external';
import { cellPos, ROW_H } from '../../src/world/lattice';
import { readColumn, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { testGpu, type TestGpu } from './dawn';
import { box, breakRig, type BreakRig } from './engine-rig';

const FLOOR = 10;
const HOUSE = { x0: 16, y0: 12, x1: 23, y1: 19, h: 4 };
const inHouse = (x: number, y: number) => x >= HOUSE.x0 && x <= HOUSE.x1 && y >= HOUSE.y0 && y <= HOUSE.y1;
const col = (x: number, y: number): Interval[] =>
  inHouse(x, y) ? [{ z0: 0, z1: FLOOR, mat: MAT.Stone }, { z0: FLOOR, z1: FLOOR + HOUSE.h, mat: MAT.External, aux: MAT.Rubble }] : [{ z0: 0, z1: FLOOR, mat: MAT.Stone }];
// (the lot's record: its footprint a quad round the box's columns' centres)
const LOT: LotBox = {
  quad: [
    [HOUSE.x0 + 0.2, (HOUSE.y0 + 0.1) * ROW_H],
    [HOUSE.x1 + 1.3, (HOUSE.y0 + 0.1) * ROW_H],
    [HOUSE.x1 + 1.3, (HOUSE.y1 + 0.9) * ROW_H],
    [HOUSE.x0 + 0.2, (HOUSE.y1 + 0.9) * ROW_H],
  ],
  base: FLOOR,
  height: HOUSE.h,
  hash: 1,
};

let g: TestGpu;
let R: BreakRig;
const hits: OwnerHit[] = [];
const ring = async () => {
  const b = await g.read(R.e.debugBuffers.events, (4 + HIT_ROOM * 4) * 4, HIT_AT * 4);
  return { n: new Uint32Array(b)[0], f: new Float32Array(b) };
};
const layers = async () => new Uint32Array(await g.read(R.w.core.world.layers, R.w.core.world.layers.size));

beforeAll(async () => {
  g = await testGpu();
  R = await breakRig(g, col, 48, 32);
  R.e.onOwnerHit = (h) => hits.push(h);
});
afterAll(() => g?.destroy());

test('the lot record covers the box: its columns are the claim\'s', () => {
  const cols = lotColumns(LOT.quad);
  expect(cols.length).toBe(64);
  for (const [x, y] of cols) expect(inHouse(x, y)).toBe(true);
  expect(lotLayers(LOT.base, LOT.height)).toEqual({ z0: FLOOR, n: HOUSE.h });
});

test('a block set down gently on the street tells nothing; one thrown at the wall tells its place and energy', async () => {
  const slow = box(8, 24, FLOOR, 2, 2, 2);
  R.e.add({ cells: slow, mesh: modelMesh(slow) });
  await R.step(40);
  expect((await ring()).n).toBe(0);
  const fast = box(9, 15, FLOOR + 1, 2, 2, 2);
  R.e.add({ cells: fast, mesh: modelMesh(fast), vel: [14, 0, 0] });
  await R.step(60);
  const r = await ring();
  expect(r.n).toBeGreaterThan(0);
  // (the first hit: on the box's west face — the house's columns start at x = 16 — at the block's height)
  const [px, py, pz, e] = [r.f[4], r.f[5], r.f[6], r.f[7]];
  expect(px).toBeGreaterThan(HOUSE.x0 - 1.5);
  expect(px).toBeLessThan(HOUSE.x0 + 1.5);
  expect(py).toBeGreaterThan(cellPos(0, 13)[1]);
  expect(py).toBeLessThan(cellPos(0, 18)[1]);
  expect(pz).toBeGreaterThan(FLOOR);
  expect(pz).toBeLessThan(FLOOR + HOUSE.h + 0.5);
  expect(e).toBeGreaterThan(100);
  // (the host is told at its chained read: a few ticks, a map)
  for (let k = 0; k < 20 && !hits.length; k++) {
    await R.step(4);
    await new Promise((res) => setTimeout(res, 5));
  }
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].energy).toBeCloseTo(e, 1);
  expect(hits[0].p[0]).toBeCloseTo(px, 3);
  if (process.env.HOUSE_LOG) console.log(`[house] hits ${r.n}, first at ${[px, py, pz].map((v) => v.toFixed(2))}, energy ${e.toFixed(0)}; host told ${hits.length}`);
});

test('the lot felled: its External intervals gone, rows of its volume and mass in its place, at rest on the floor', async () => {
  const core = R.w.core;
  const before = (await R.rows()).length;
  const made: { row: number }[] = [];
  const out = fellLot(LOT, MAT.Concrete, {
    release: (spans) => core.columnApply.run(core.columnsGpu(), [{ cuts: [], release: spans }]),
    drop: (cells) => made.push(R.e.add({ cells, mesh: modelMesh(cells) })!),
  })!;
  expect(out.columns.length).toBe(64);
  expect(out.cells).toBe(64 * HOUSE.h);
  expect(out.blocks.length).toBeGreaterThanOrEqual(2);
  await R.step(2);
  // (the columns: none of the house's External left anywhere; the house's are the floor alone. A row asleep is in the
  // columns as External of its own — "Rest claims External": those name their row in word 3 and are set aside here)
  const L = await layers();
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 48; x++) {
      const c = readColumn(core.packed, L, x, y).filter((v) => !(v.mat === MAT.External && ownedByRow(v.own)));
      expect(c.some((v) => v.mat === MAT.External)).toBe(false);
      if (inHouse(x, y)) expect(c[c.length - 1].z1).toBeCloseTo(FLOOR, 3);
    }
  // (the rows: one a block, their mass the cells' by the material's density)
  const rows = await R.rows();
  expect(rows.length).toBe(before + out.blocks.length);
  const mine = rows.filter((r) => made.some((m) => m.row === r.row));
  expect(mine.length).toBe(out.blocks.length);
  const mass = mine.reduce((s, r) => s + r.mass, 0);
  expect(mass).toBeCloseTo(out.cells * physMass(MAT.Concrete).density, 0);
  // (and they stay where the house stood: nothing thrown out, nothing sunk — within a cell of the box, asleep or slow)
  await R.step(180);
  for (const r of (await R.rows()).filter((q) => made.some((m) => m.row === q.row))) {
    expect(r.pos[0]).toBeGreaterThan(HOUSE.x0 - 2);
    expect(r.pos[0]).toBeLessThan(HOUSE.x1 + 3);
    expect(r.pos[2]).toBeGreaterThan(FLOOR + 0.5);
    expect(r.pos[2]).toBeLessThan(FLOOR + HOUSE.h + 1);
  }
  if (process.env.HOUSE_LOG) console.log(`[house] ${out.blocks.length} blocks, ${out.cells} cells, mass ${mass.toFixed(0)}`);
});
