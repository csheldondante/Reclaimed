// (round 128j, claims at load; switchover: GPU-owned grids only) Static grids' claims written with the land
// (sim/static-claims.ts, colapply.wgsl claimGrid): a GPU-owned grid (its dense spans in its slot of the arena, as
// citygen's claim grid writes them) — the GPU's columns after regions are written one by one equal the CPU's rule
// (claimFreeColumn with the grid's span of each column, its frame moved into the window's), only inside what was
// written. (The CPU grids' tests — a thing's edit let go and claimed again, the registry's view of static instances —
// went with the CPU grids: the old towns' and the fortress's.)
import { describe, expect, test } from 'vitest';
import { ColumnApply, fitColumn, type GpuColumns } from '../../src/game/colapply';
import { claimFreeColumn, ExternalRegistry } from '../../src/sim/external';

/** a town's claims' owner (256 and up: sim/external.ts OwnerId — the small ids are the other owners') */
const OWNER_TOWN = 0x10000;
import { StaticClaims, type StaticGrid } from '../../src/sim/static-claims';
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

/** a dense grid's spans (citygen's claim grid's layout: w × h columns, a span or none each) — random boxes, some past the
 *  window's edges: local column (x, y) → its span (grid z) and its fallback */
const GW = 40;
function spans(seed: number, n: number): Map<number, { z0: number; z1: number; aux: number }> {
  const r = rng(seed);
  const out = new Map<number, { z0: number; z1: number; aux: number }>();
  for (let k = 0; k < n; k++) {
    const x0 = Math.floor(r() * (GW - 5));
    const y0 = Math.floor(r() * (GW - 5));
    const bw = 1 + Math.floor(r() * 5);
    const bh = 1 + Math.floor(r() * 5);
    const z0 = Math.round(r() * 20 * 4) / 4;
    const z1 = z0 + 1 + Math.round(r() * 10 * 4) / 4;
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) out.set(y * GW + x, { z0, z1, aux: [MAT.Rubble, MAT.Stone, MAT.Brick][k % 3] });
  }
  return out;
}

/** the grid written into a slot of the arena (ColumnApply.claimGrids' layout: a column table, x y first count, then the
 *  spans, z0 z1 aux 0) and made GPU-owned */
function ownedGrid(r: Rig, sp: Map<number, { z0: number; z1: number; aux: number }>): StaticGrid {
  const slot = r.sc.ownedSlot()!;
  const N = GW * GW;
  const words = new Uint32Array(N * 8);
  const iw = new Int32Array(words.buffer);
  const fw = new Float32Array(words.buffer);
  for (let i = 0; i < N; i++) {
    const s = sp.get(i);
    iw[i * 4] = i % GW;
    iw[i * 4 + 1] = Math.floor(i / GW);
    words[i * 4 + 2] = i;
    words[i * 4 + 3] = s ? 1 : 0;
    if (s) {
      fw[N * 4 + i * 4] = s.z0;
      fw[N * 4 + i * 4 + 1] = s.z1;
      words[N * 4 + i * 4 + 2] = s.aux;
    }
  }
  r.dev.queue.writeBuffer(slot.binding.buffer, slot.binding.offset ?? 0, words);
  return r.sc.gpuGrid('town', OWNER_TOWN, () => r.place, { slot, w: GW, h: GW, maxKey: 0 });
}

interface Rig {
  w: RockWorld;
  cols: GpuColumns;
  ap: ColumnApply;
  sc: StaticClaims;
  dev: GPUDevice;
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
  const cols: GpuColumns = { slots: g.slots, chunks: g.chunks, packed: w.packed, stamp: 1 };
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
  const r: Rig = { w, cols, ap, ext, unwritten, dev, place: { dx: 3, dy: -2, dz: 1.5 }, sc: null! };
  r.sc = new StaticClaims({
    device: dev,
    apply: () => ap,
    columns: () => cols,
    registry: () => ext,
    dims: { w: W, h: W },
    R,
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

/** touching intervals of one material and aux joined, as the GPU's claim stores a column it loaded */
function joined(col: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const iv of col) {
    const last = out[out.length - 1];
    if (last && last.mat === iv.mat && (last.aux ?? 0) === (iv.aux ?? 0) && Math.abs(last.z1 - iv.z0) < 1e-4) last.z1 = iv.z1;
    else out.push({ ...iv });
  }
  return out;
}

/** the CPU's rule over window box [x0, x1) × [y0, y1): each column's grid span (window z) claimed where free, fitted */
function cpuClaim(r: Rig, x0: number, y0: number, x1: number, y1: number, sp: Map<number, { z0: number; z1: number; aux: number }>): void {
  const { dx, dy, dz } = r.place;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const lx = x - dx;
      const ly = y - dy;
      if (lx < 0 || ly < 0 || lx >= GW || ly >= GW) continue;
      // (a dense grid: every column of its box is a claim — one with no span is loaded and stored as it is, fitted)
      const s = sp.get(ly * GW + lx);
      r.w.write(x, y, fitColumn(joined(claimFreeColumn(r.w.read(x, y), s ? [{ z0: s.z0 + dz, z1: s.z1 + dz, aux: s.aux }] : [])), columnSlots(r.w.packed, x, y).k, r.w.packed.dims.zMax));
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
      const sp = spans(s * 31, 12);
      ownedGrid(r, sp);
      // (nothing written yet: nothing claimed)
      same(r, await gpuSlots(r), `seed ${s} before any land`);
      for (const [lx, ly] of all) {
        r.sc.landWritten(lx, ly, R, R);
        r.unwritten = r.unwritten.filter(([x, y]) => x !== lx || y !== ly);
        cpuClaim(r, lx, ly, lx + R, ly + R, sp);
        same(r, await gpuSlots(r), `seed ${s} region ${lx},${ly}`);
      }
      // (written again — a region thawed from the pool with its claims in it: unchanged)
      r.sc.landWritten(16, 0, R, R);
      same(r, await gpuSlots(r), `seed ${s} written twice`);
      expect(r.sc.stats.passes).toBeGreaterThan(0);
    }
  }, 120_000);
});
