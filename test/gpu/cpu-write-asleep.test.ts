// (round 128, INT16; ported from the hallfall branch's diagnosis) A change stamped into the columns stays there in a
// sleeping chunk. The column passes (structure, edit, the layer pulls) read the layers, write layersNext — the awake
// chunks' only — and copy layersNext back over the layers whole; a sleeping chunk's layersNext holds what it had when
// it last ran. A change to the layers alone was undone by the next tick's copy-back: a town's building claimed as
// External in a chunk that couldn't wake (the hybrid's filter) lost its claim within a tick, was found cut by the
// integrity check and fell to rubble. ColumnApply (WorldCore.stampColumns) writes both buffers; this checks it with
// every system stepping and every chunk asleep. (DA-B14: the passes write in place now and copy nothing back, so a write
// to the layers alone stays too — the last test.)
import { afterAll, beforeAll, expect, test } from 'vitest';
import { columnSlots, packColumn, readColumn, SLOT_WORDS, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { tinyMap } from '../support/tinymap';
import { testGpu, type TestGpu } from './dawn';
import { tinyWorld, type TinyWorld } from './world';

const W = 32;
const H = 32;

let g: TestGpu;
let w: TinyWorld;
beforeAll(async () => {
  g = await testGpu();
  w = await tinyWorld(g, tinyMap(W, H, 32), 'all');
  // (awake first: every pass has written layersNext once; then every chunk asleep, none drowsy)
  await w.step(30);
  w.core.globals.sleep = new Uint32Array(64).fill(0xffffffff);
  w.core.globals.drowse = new Uint32Array(64);
  await w.step(30);
});
afterAll(() => w?.destroy());

const plain = (col: Interval[]) => col.map(({ z0, z1, mat }) => ({ z0, z1, mat }));
async function columns(): Promise<Uint32Array> {
  return new Uint32Array((await w.read('layers')).buffer);
}

test('a claim stamped into a sleeping chunk is still there after the sim steps', async () => {
  const cols: [number, number][] = [
    [5, 5],
    [20, 9],
    [27, 27],
  ];
  const before = await columns();
  const tops = cols.map(([x, y]) => {
    const c = readColumn(w.core.packed, before, x, y);
    return c.length ? c[c.length - 1].z1 : 0;
  });
  w.core.stampColumns([{ cuts: [], claim: cols.map(([x, y], i) => ({ x, y, z0: tops[i], z1: tops[i] + 6, aux: MAT.Rubble })) }]);
  await w.step(60);
  expect(g.takeErrors()).toEqual([]);
  const after = await columns();
  cols.forEach(([x, y], i) => {
    const col = readColumn(w.core.packed, after, x, y);
    expect(col.filter((iv) => iv.mat === MAT.External), `column ${x},${y}`).toEqual([{ z0: tops[i], z1: tops[i] + 6, mat: MAT.External, aux: MAT.Rubble }]);
  });
});

test('cells taken and a model seated in a sleeping chunk stay so', async () => {
  const before = await columns();
  const [tx, ty] = [10, 14];
  const top = readColumn(w.core.packed, before, tx, ty).at(-1)!;
  const zTop = Math.ceil(top.z1 - 0.5) - 1;
  w.core.stampColumns([{ cuts: [], take: { cells: [{ x: tx, y: ty, z: zTop }], materials: new Set([top.mat]) } }]);
  const [sx, sy] = [24, 20];
  const base = Math.ceil(readColumn(w.core.packed, before, sx, sy).at(-1)!.z1) + 1;
  w.core.stampColumns([{ cuts: [], seat: { cols: [{ x: sx, y: sy, runs: [{ z0: base, z1: base + 3, mat: MAT.Steel }] }], base, aux: 15 << 4 } }]);
  await w.step(60);
  expect(g.takeErrors()).toEqual([]);
  const after = await columns();
  const taken = readColumn(w.core.packed, after, tx, ty);
  expect(taken.at(-1)!.z1, 'the top cell taken').toBeLessThanOrEqual(Math.max(top.z0, zTop) + 1e-4);
  expect(plain(readColumn(w.core.packed, after, sx, sy)).at(-1), 'the model seated').toEqual({ z0: base, z1: base + 3, mat: MAT.Steel });
});

// (DA-B14: the column passes write in place and copy nothing back — the cause is gone: a write to the layers alone stays)
test('(the cause, gone) a column written to the layers alone in a sleeping chunk stays', async () => {
  const [x, y] = [12, 26];
  const before = readColumn(w.core.packed, await columns(), x, y);
  const want: Interval[] = [...before, { z0: before.at(-1)!.z1, z1: before.at(-1)!.z1 + 4, mat: MAT.External, aux: MAT.Rubble }];
  const { base, k } = columnSlots(w.core.packed, x, y);
  w.core.host.gpu.device.queue.writeBuffer(w.core.world.layers, base * SLOT_WORDS * 4, packColumn(want, k));
  await w.step(10);
  expect(g.takeErrors()).toEqual([]);
  expect(plain(readColumn(w.core.packed, await columns(), x, y))).toEqual(plain(want));
});
