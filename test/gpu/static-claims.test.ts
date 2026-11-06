// (round 128j, claims at load) Static grids' claims written with the land (sim/static-claims.ts, colapply.wgsl
// claimGrid): the GPU's columns after regions are written one by one equal the CPU's rule (claimFreeColumn with the
// grid's spans of each column, in its order, its frame moved into the window's), only inside what was written; an edit
// (a thing changed) lets the old go where it lies (to air, the GPU's release) and claims the grid again over the written
// land; and the registry sees the static things — found by column, judged only where their land was written before the
// read was asked, never orphans.
import { describe, expect, test } from 'vitest';
import { ColumnApply, fitColumn, type GpuColumns } from '../../src/game/colapply';
import { claimFreeColumn, ExternalRegistry, releaseSpan, type ExternalCol } from '../../src/sim/external';
import { gridIdOf } from '../../src/build/site';

/** (onetown) a town's claims are owned by its grid's id */
const OWNER_TOWN = gridIdOf('test');
import { StaticClaims, gridColumnSpans, type StaticThing } from '../../src/sim/static-claims';
import { columnSlots, readColumn, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { RockWorld } from '../support/rockworld';
import { gpuCols } from '../support/judgeworld';
import { rng } from '../support/judgeshapes';
import { testGpu } from './dawn';

const W = 32;
const R = 16;

/** columns of ground, water, External and built runs with gaps (air) between (colapply.test.ts' stamp world) */
function stampWorld(seed: number): RockWorld {
  const r = rng(seed);
  const mats = [MAT.Stone, MAT.Sand, MAT.Brick, MAT.Concrete, MAT.Water, MAT.Air];
  const cols = new Map<number, Interval[]>();
  const w = new RockWorld(W, W, 64, (x, y) => {
    const col: Interval[] = [];
    let z = 0;
    for (let i = 0; i < 1 + Math.floor(r() * 5); i++) {
      const z0 = z + (i && r() < 0.5 ? Math.round(r() * 3 * 4) / 4 : 0);
      const z1 = z0 + 0.5 + Math.round(r() * 5 * 4) / 4;
      if (z1 > 40) break;
      const mat = mats[Math.floor(r() * mats.length)];
      if (mat === MAT.Air) {
        z = z1;
        continue;
      }
      col.push({ z0, z1, mat });
      z = z1;
    }
    cols.set(y * 65536 + x, col);
    return col;
  });
  for (const [k, col] of cols) w.write(k % 65536, Math.floor(k / 65536), col);
  return w;
}

/** random buildings in a grid's frame (some past the window's edges): each a box of columns, a span or two a column */
function things(seed: number, n: number): StaticThing[] {
  const r = rng(seed);
  const out: StaticThing[] = [];
  for (let k = 0; k < n; k++) {
    const x0 = Math.floor(r() * 40) - 8;
    const y0 = Math.floor(r() * 40) - 8;
    const bw = 1 + Math.floor(r() * 5);
    const bh = 1 + Math.floor(r() * 5);
    const z0 = Math.round(r() * 20 * 4) / 4;
    const z1 = z0 + 1 + Math.round(r() * 10 * 4) / 4;
    const cols: ExternalCol[] = [];
    for (let y = y0; y < y0 + bh; y++)
      for (let x = x0; x < x0 + bw; x++) {
        cols.push({ x, y, z0, z1 });
        if (r() < 0.2) cols.push({ x, y, z0: z1 + 1, z1: z1 + 3 });
      }
    out.push({ key: k, cols, fallback: [MAT.Rubble, MAT.Stone, MAT.Brick][k % 3] });
  }
  return out;
}

interface Rig {
  w: RockWorld;
  cols: GpuColumns;
  ap: ColumnApply;
  sc: StaticClaims;
  ext: ExternalRegistry;
  unwritten: [number, number][];
  place: { dx: number; dy: number; dz: number };
}

async function rig(seed: number, unwritten: [number, number][]): Promise<Rig> {
  const gpu = await testGpu();
  const dev = gpu.device;
  const w = stampWorld(seed);
  const g = gpuCols(dev, w);
  dev.queue.writeBuffer(g.slots, 0, w.packed.slots);
  const cols: GpuColumns = { slots: g.slots, chunks: g.chunks, packed: w.packed };
  const ap = new ColumnApply(dev);
  // (the registry's columns: the GPU's release, as Integrity gives it; nothing read)
  const ext = new ExternalRegistry({
    read: () => {
      throw new Error('read: the static claims read nothing');
    },
    write: () => {
      throw new Error('write: the static claims write through the GPU');
    },
    release: (spans) => ap.run(cols, [{ cuts: [], release: spans }]),
  });
  const r: Rig = { w, cols, ap, ext, unwritten, place: { dx: 3, dy: -2, dz: 1.5 }, sc: null! };
  r.sc = new StaticClaims({
    device: dev,
    apply: () => ap,
    columns: () => cols,
    registry: () => ext,
    dims: { w: W, h: W },
    R,
    origin: () => [64, 32],
    unwritten: () => r.unwritten,
    held: () => false,
  });
  ext.statics = r.sc;
  return r;
}

async function gpuSlots(r: Rig): Promise<Uint32Array> {
  const gpu = await testGpu();
  const slots = new Uint32Array(await gpu.read(r.cols.slots, r.w.packed.slots.byteLength));
  expect(gpu.takeErrors()).toEqual([]);
  return slots;
}

function same(r: Rig, got: Uint32Array, what: string): void {
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) expect(readColumn(r.w.packed, got, x, y), `${what}: column ${x},${y}`).toEqual(readColumn(r.w.packed, r.w.packed.slots, x, y));
}

/** the CPU's rule over window box [x0, x1) × [y0, y1): each column's grid spans (window z) claimed where free, fitted */
function cpuClaim(r: Rig, x0: number, y0: number, x1: number, y1: number, g: Parameters<typeof gridColumnSpans>[0]): void {
  const { dx, dy, dz } = r.place;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const spans = gridColumnSpans(g, x - dx, y - dy).map((s) => ({ z0: s.z0 + dz, z1: s.z1 + dz, aux: s.aux }));
      if (!spans.length) continue;
      r.w.write(x, y, fitColumn(claimFreeColumn(r.w.read(x, y), spans), columnSlots(r.w.packed, x, y).k, r.w.packed.dims.zMax));
    }
}

describe('static grids claimed with the land (round 128j)', () => {
  test('regions written one by one: each claimed where it lies, nothing outside what was written', async () => {
    for (let s = 1; s <= 6; s++) {
      const all: [number, number][] = [
        [0, 0],
        [16, 0],
        [0, 16],
        [16, 16],
      ];
      const r = await rig(s * 97, all.slice());
      const g = r.sc.grid('town', OWNER_TOWN, () => r.place);
      r.sc.set(g, things(s * 31, 12));
      // (nothing written yet: nothing claimed)
      same(r, await gpuSlots(r), `seed ${s} before any land`);
      for (const [lx, ly] of all) {
        r.sc.landWritten(lx, ly, R, R);
        r.unwritten = r.unwritten.filter(([x, y]) => x !== lx || y !== ly);
        cpuClaim(r, lx, ly, lx + R, ly + R, g);
        same(r, await gpuSlots(r), `seed ${s} region ${lx},${ly}`);
      }
      // (written again — a region thawed from the pool with its claims in it: unchanged)
      r.sc.landWritten(16, 0, R, R);
      same(r, await gpuSlots(r), `seed ${s} written twice`);
      expect(r.sc.stats.passes).toBeGreaterThan(0);
    }
  }, 120_000);

  test('an edit: a thing changed let go where it lies (to air) and the grid claimed again over the written land', async () => {
    for (let s = 1; s <= 6; s++) {
      // (the right half still coming in)
      const r = await rig(s * 113, [
        [16, 0],
        [16, 16],
      ]);
      const g = r.sc.grid('fort', OWNER_TOWN, () => r.place);
      const t = things(s * 7, 10);
      const before = r.sc.set(g, t);
      cpuClaim(r, 0, 0, 16, W, g);
      same(r, await gpuSlots(r), `seed ${s} set`);
      // (thing 2 moved up two cells, thing 5 gone)
      const old2 = before.get(2)!.cols.map((c) => ({ ...c }));
      const old5 = before.get(5)!.cols.map((c) => ({ ...c }));
      const t2 = t.filter((x) => x.key !== 5).map((x) => (x.key === 2 ? { ...x, cols: x.cols.map((c) => ({ ...c, z0: c.z0 + 2, z1: c.z1 + 2 })) } : x));
      const after = r.sc.set(g, t2);
      expect(after.get(0)!.id, 'an unchanged thing keeps its instance').toBe(before.get(0)!.id);
      expect(after.get(2)!.id).not.toBe(before.get(2)!.id);
      expect(after.has(5)).toBe(false);
      for (const [old, fb] of [
        [old2, t[2].fallback],
        [old5, t[5].fallback],
      ] as const)
        for (const c of old) {
          if (c.x < 0 || c.y < 0 || c.x >= 16 || c.y >= W) continue;
          const out = releaseSpan(r.w.read(c.x, c.y), c, fb, true);
          if (out) r.w.write(c.x, c.y, fitColumn(out, columnSlots(r.w.packed, c.x, c.y).k, r.w.packed.dims.zMax));
        }
      cpuClaim(r, 0, 0, 16, W, g);
      same(r, await gpuSlots(r), `seed ${s} edit`);
    }
  }, 120_000);

  test('the registry sees them: by column, judged where written before the read, never orphans, released through it', async () => {
    const r = await rig(5, [[16, 16]]);
    const g = r.sc.grid('town', OWNER_TOWN, () => r.place);
    const inst = r.sc.set(g, [{ key: 1, cols: [{ x: 0, y: 2, z0: 30, z1: 33 }, { x: 14, y: 15, z0: 30, z1: 31 }], fallback: MAT.Brick }]).get(1)!;
    const { dx, dy } = r.place;
    expect(r.ext.at(dx, dy + 2).map((i) => i.id)).toEqual([inst.id]);
    expect(r.ext.at(dx + 1, dy + 2)).toEqual([]);
    expect(r.ext.get(inst.id)).toBe(inst);
    expect([...r.ext.instances].map((i) => i.id)).toContain(inst.id);
    // (window column (17, 13) lies in region (16, 0): written; a read asked before the thing was made doesn't judge it)
    const asOf = r.ext.epoch;
    expect(r.sc.judged(17, 13, asOf)).toBe(true);
    expect(r.sc.judged(17, 13, -1)).toBe(false);
    expect(r.sc.judged(16, 16, asOf), 'land still coming in').toBe(false);
    r.sc.landWritten(16, 16, R, R);
    r.unwritten = [];
    expect(r.sc.judged(16, 16, asOf), 'written after the read was asked').toBe(false);
    expect(r.sc.judged(16, 16, r.ext.epoch)).toBe(true);
    // (its spans in the window are claimed: the orphan pass keeps them)
    const spans = r.ext.claimedSpans();
    expect(spans.get((dy + 2) * 65536 + dx)).toEqual([{ z0: 31.5, z1: 34.5 }]);
    expect(spans.get((15 + dy) * 65536 + 14 + dx)).toEqual([{ z0: 31.5, z1: 32.5 }]);
    // (released through the registry: let go on the GPU, out of the grid, not claimed with the land again)
    r.ext.release(inst.id, true);
    expect(r.ext.get(inst.id)).toBeUndefined();
    expect(r.ext.at(dx, dy + 2)).toEqual([]);
    expect(g.things.size).toBe(0);
    const got = await gpuSlots(r);
    expect(readColumn(r.w.packed, got, dx, dy + 2).some((iv) => iv.mat === MAT.External)).toBe(false);
  }, 60_000);
});
