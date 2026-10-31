// (round 120, JB6) Verdicts applied on the GPU (game/colapply.ts, shaders/colapply.wgsl) equal the CPU's application
// (cutColumn, spillPlan) — the columns word for word, the spilled rubble's deposits — on the judges' shapes and random
// caves (judge B's verdicts: crumbled runs cut and spilled, then the pieces cut), and on random columns with random
// cuts (splits past a column's K slots: the rubble rule).
import { describe, expect, test } from 'vitest';
import { ColumnApply, cutColumn, fitColumn, spillPlan, type ApplyStage } from '../../src/game/colapply';
import { orphanColumn, releaseSpan } from '../../src/sim/external';
import { SectionsJudge } from '../../src/game/judge';
import type { Fracture, Voxel } from '../../src/game/fracture';
import { columnSlots, readColumn, type Interval } from '../../src/world/layout';
import { MAT } from '../../src/world/materials';
import { RockWorld } from '../support/rockworld';
import { gpuCols } from '../support/judgeworld';
import { cave, rng, SHAPES } from '../support/judgeshapes';
import { testGpu } from './dawn';

/** Integrity.apply's stages for a verdict: the crumbled runs cut and their cells spilled, then the pieces cut */
function stagesOf(fr: Fracture): ApplyStage[] {
  const crumbs = (fr.crumbleRuns ?? []).filter((c) => c.ivs.length);
  const cells: Voxel[] = [];
  for (const c of crumbs) for (const iv of c.ivs) for (let z = Math.floor(iv.z0); z < iv.z1 - 0.25; z++) cells.push({ x: c.x, y: c.y, z, mat: iv.mat });
  return [
    { cuts: crumbs.map((c) => ({ x: c.x, y: c.y, cuts: c.ivs })), spill: cells },
    { cuts: (fr.pieces ?? []).flat().map((c) => ({ x: c.x, y: c.y, cuts: c.ivs })) },
  ];
}

/** the CPU's application of the stages to `w` (in place): the deposits it would make (window index → amount, mat) */
function cpuApply(w: RockWorld, stages: ApplyStage[]): Map<number, { amount: number; mat: number }> {
  const dep = new Map<number, { amount: number; mat: number }>();
  for (const st of stages) {
    const by = new Map<number, { x: number; y: number; cuts: { z0: number; z1: number }[] }>();
    for (const c of st.cuts) {
      const k = c.y * w.W + c.x;
      const e = by.get(k) ?? { x: c.x, y: c.y, cuts: [] };
      e.cuts.push(...c.cuts);
      by.set(k, e);
    }
    for (const e of by.values()) {
      const { k } = columnSlots(w.packed, e.x, e.y);
      w.write(e.x, e.y, cutColumn(w.read(e.x, e.y), e.cuts, k, w.packed.dims.zMax));
    }
    if (st.spill?.length) {
      const plan = spillPlan(st.spill, (x, y) => {
        const col = w.read(x, y);
        return col.length ? col[col.length - 1].z1 : 0;
      }, w.W, w.H);
      for (const [i, v] of plan) {
        const d = dep.get(i);
        // (a second spill onto a column: the GPU adds the cells and takes the later material)
        dep.set(i, d ? { amount: d.amount + v.amount, mat: v.mat } : v);
      }
    }
    for (const d of st.deposits ?? []) {
      const i = d.y * w.W + d.x;
      const e = dep.get(i);
      dep.set(i, { amount: (e?.amount ?? 0) + d.amount, mat: d.mat });
    }
    for (const r of st.release ?? []) {
      const out = releaseSpan(w.read(r.x, r.y), r, r.fallback, r.toAir);
      if (out) w.write(r.x, r.y, fitColumn(out, columnSlots(w.packed, r.x, r.y).k, w.packed.dims.zMax));
    }
  }
  return dep;
}

/** the GPU's application of the stages to `w`'s columns (a copy): its slots and deposits read back */
async function gpuApply(w: RockWorld, stages: ApplyStage[], claimed?: Map<number, { z0: number; z1: number }[]>): Promise<{ slots: Uint32Array; dep: Map<number, { amount: number; mat: number }> }> {
  const gpu = await testGpu();
  const dev = gpu.device;
  const cols = gpuCols(dev, w);
  dev.queue.writeBuffer(cols.slots, 0, w.packed.slots);
  const N = w.W * w.H;
  const deposit = dev.createBuffer({ label: 'test deposit', size: N * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  // (the identity ring: page (cx, cy) at slot cy * nx + cx)
  const nx = w.W / 16;
  const pages = new Uint16Array(nx * (w.H / 16)).map((_, i) => i);
  const ap = new ColumnApply(dev);
  ap.run({ slots: cols.slots, chunks: cols.chunks, packed: w.packed }, stages, { deposit, pages });
  if (claimed) ap.orphans({ slots: cols.slots, chunks: cols.chunks, packed: w.packed }, claimed);
  const slots = new Uint32Array(await gpu.read(cols.slots, w.packed.slots.byteLength));
  const D = new Float32Array(await gpu.read(deposit, N * 16));
  const dep = new Map<number, { amount: number; mat: number }>();
  for (let y = 0; y < w.H; y++)
    for (let x = 0; x < w.W; x++) {
      const i = (((y >> 4) * nx + (x >> 4)) << 8) + ((y & 15) << 4) + (x & 15);
      if (D[i * 4 + 1] > 0) dep.set(y * w.W + x, { amount: D[i * 4 + 1], mat: D[i * 4 + 2] });
    }
  ap.destroy();
  cols.slots.destroy();
  cols.chunks.destroy();
  deposit.destroy();
  expect(gpu.takeErrors()).toEqual([]);
  return { slots, dep };
}

/** both applications agree: every column word for word (mat, aux, heights), every deposit */
async function check(w: RockWorld, stages: ApplyStage[], what: string, claimed?: Map<number, { z0: number; z1: number }[]>): Promise<void> {
  const before = new Uint32Array(w.packed.slots);
  const got = await gpuApply(w, stages, claimed);
  const dep = cpuApply(w, stages);
  if (claimed)
    for (let y = 0; y < w.H; y++)
      for (let x = 0; x < w.W; x++) {
        const out = orphanColumn(w.read(x, y), claimed.get(y * 65536 + x) ?? []);
        if (out) w.write(x, y, fitColumn(out, columnSlots(w.packed, x, y).k, w.packed.dims.zMax));
      }
  // (a column's spare word: the CPU's writeSlot zeroes it, as the GPU's)
  for (let y = 0; y < w.H; y++)
    for (let x = 0; x < w.W; x++) {
      const want = readColumn(w.packed, w.packed.slots, x, y);
      const have = readColumn(w.packed, got.slots, x, y);
      expect(have, `${what}: column ${x},${y}`).toEqual(want);
    }
  expect([...got.dep].sort((a, b) => a[0] - b[0]), `${what}: deposits`).toEqual([...dep].sort((a, b) => a[0] - b[0]));
  // (and something was applied: the tests aren't vacuous)
  if (stages.some((s) => s.cuts.length || s.release?.length) || claimed) expect(w.packed.slots, what).not.toEqual(before);
}

async function verdict(w: RockWorld, seeds: [number, number][]): Promise<Fracture> {
  const gpu = await testGpu();
  const cols = gpuCols(gpu.device, w);
  gpu.device.queue.writeBuffer(cols.slots, 0, w.packed.slots);
  const weighed = new Set(seeds.map(([x, y]) => y * 65536 + x));
  const j = new SectionsJudge();
  const fr = await j.judge({ cols: { packed: w.packed, gpu: cols }, seeds, weigh: (x, y) => weighed.has(y * 65536 + x), rotate: true });
  j.destroy();
  cols.slots.destroy();
  cols.chunks.destroy();
  return fr;
}

describe('verdicts applied on the GPU equal the CPU application', () => {
  for (const sh of SHAPES)
    test(sh.name, async () => {
      const w = sh.make();
      sh.cut?.(w);
      const fr = await verdict(w, sh.seeds);
      await check(w, stagesOf(fr), sh.name);
    });

  test('40 random caves', async () => {
    let applied = 0;
    let spilled = 0;
    for (let s = 1; s <= 40; s++) {
      const { w, seeds } = cave(s * 7919, s % 3 === 0 ? MAT.Brick : MAT.Stone);
      if (!seeds.length) continue;
      const fr = await verdict(w, seeds);
      const st = stagesOf(fr);
      if (!st.some((x) => x.cuts.length)) continue;
      applied++;
      if (st[0].spill?.length) spilled++;
      await check(w, st, `cave ${s}`);
    }
    // (the caves are worth it: verdicts to apply, crumbs to spill)
    expect(applied).toBeGreaterThan(3);
    expect(spilled).toBeGreaterThan(0);
  }, 300_000);
});

describe('random cuts on random columns', () => {
  /** columns of up to `n` runs of random materials (some loose), at most K */
  function randomWorld(seed: number, n: number): RockWorld {
    const r = rng(seed);
    const mats = [MAT.Stone, MAT.Brick, MAT.Concrete, MAT.Sand, MAT.Rubble, MAT.Wood, MAT.Ice];
    return new RockWorld(32, 32, 64, () => {
      const col: Interval[] = [];
      let z = 0;
      for (let i = 0; i < 1 + Math.floor(r() * n); i++) {
        const z0 = z + (i && r() < 0.6 ? Math.round(r() * 3) : 0);
        const z1 = z0 + 0.5 + Math.round(r() * 6 * 4) / 4;
        if (z1 > 60) break;
        col.push({ z0, z1, mat: mats[Math.floor(r() * mats.length)] });
        z = z1;
      }
      return col;
    });
  }

  test('cuts that split runs past K (the rubble rule), cells spilled', async () => {
    for (let s = 1; s <= 12; s++) {
      const w = randomWorld(s * 31, 8);
      const r = rng(s * 977);
      const cuts: ApplyStage['cuts'] = [];
      const spill: Voxel[] = [];
      for (let i = 0; i < 120; i++) {
        const x = Math.floor(r() * w.W);
        const y = Math.floor(r() * w.H);
        const z0 = Math.round(r() * 40 * 4) / 4;
        const cs = [{ z0, z1: z0 + 0.25 + Math.round(r() * 3 * 4) / 4 }];
        // (some columns cut many times: 21 cuts, splits past K)
        if (r() < 0.1) for (let k = 0; k < 20; k++) cs.push({ z0: k * 2 + 0.5, z1: k * 2 + 1 });
        cuts.push({ x, y, cuts: cs });
        if (r() < 0.3) spill.push({ x, y, z: Math.floor(z0), mat: [MAT.Stone, MAT.Wood, MAT.Ice, MAT.Brick][Math.floor(r() * 4)] });
      }
      await check(w, [{ cuts, spill }, { cuts: cuts.slice(0, 20) }], `random ${s}`);
    }
  }, 120_000);
});

describe('External intervals: let go and orphans (sim/external.ts releaseSpan, orphanColumn)', () => {
  /** columns of ground with External runs (aux: what they become) between and on top */
  function externalWorld(seed: number): RockWorld {
    const r = rng(seed);
    const mats = [MAT.Stone, MAT.Sand, MAT.Brick, MAT.External, MAT.External];
    const cols = new Map<number, Interval[]>();
    const w = new RockWorld(32, 32, 64, (x, y) => {
      const col: Interval[] = [];
      let z = 0;
      for (let i = 0; i < 1 + Math.floor(r() * 7); i++) {
        const z0 = z + (i && r() < 0.4 ? Math.round(r() * 2) : 0);
        const z1 = z0 + 0.5 + Math.round(r() * 5 * 4) / 4;
        if (z1 > 60) break;
        const mat = mats[Math.floor(r() * mats.length)];
        col.push({ z0, z1, mat, aux: mat === MAT.External ? [0, MAT.Sand, MAT.Brick][Math.floor(r() * 3)] : 0 });
        z = z1;
      }
      cols.set(y * 65536 + x, col);
      return col;
    });
    // (packColumns leaves aux out: written again with it)
    for (const [k, col] of cols) w.write(k % 65536, Math.floor(k / 65536), col);
    expect(w.read(0, 0)).toEqual(cols.get(0)!.map((iv) => ({ ...iv, aux: iv.aux ?? 0 })));
    return w;
  }

  test('spans let go to their fallback or to air; touching runs joined', async () => {
    for (let s = 1; s <= 10; s++) {
      const w = externalWorld(s * 131);
      const r = rng(s * 7);
      const release: NonNullable<ApplyStage['release']> = [];
      for (let i = 0; i < 200; i++) {
        const x = Math.floor(r() * w.W);
        const y = Math.floor(r() * w.H);
        const ext = w.read(x, y).filter((iv) => iv.mat === MAT.External);
        const at = ext.length && r() < 0.8 ? ext[Math.floor(r() * ext.length)] : { z0: Math.round(r() * 30), z1: Math.round(r() * 30) + 3 };
        // (a span: an External run's, or part of one, or anywhere)
        const z0 = at.z0 + (r() < 0.3 ? 0.5 : 0);
        release.push({ x, y, z0, z1: Math.max(z0 + 0.25, at.z1 - (r() < 0.3 ? 0.5 : 0)), fallback: [0, MAT.Stone, MAT.Rubble][Math.floor(r() * 3)], toAir: r() < 0.4 });
      }
      await check(w, [{ cuts: [], release }], `release ${s}`);
    }
  }, 120_000);

  test('the parts of External runs no claimed span holds become their fallback', async () => {
    for (let s = 1; s <= 10; s++) {
      const w = externalWorld(s * 577);
      const r = rng(s * 3);
      const claimed = new Map<number, { z0: number; z1: number }[]>();
      for (let y = 0; y < w.H; y++)
        for (let x = 0; x < w.W; x++) {
          const spans: { z0: number; z1: number }[] = [];
          for (const iv of w.read(x, y)) {
            if (iv.mat !== MAT.External) continue;
            const u = r();
            // (held whole, held in part, not held, or two spans across it)
            if (u < 0.35) spans.push({ z0: iv.z0, z1: iv.z1 });
            else if (u < 0.6) spans.push({ z0: iv.z0 + 0.25, z1: Math.max(iv.z0 + 0.5, iv.z1 - 0.5) });
            else if (u < 0.8) spans.push({ z0: iv.z0, z1: (iv.z0 + iv.z1) / 2 }, { z0: (iv.z0 + iv.z1) / 2 + 0.25, z1: iv.z1 + 1 });
          }
          if (spans.length) claimed.set(y * 65536 + x, spans);
        }
      await check(w, [{ cuts: [], deposits: [{ x: 3, y: 4, amount: 2.5, mat: MAT.Sand }, { x: 20, y: 30, amount: 1, mat: MAT.Rubble }] }], `orphans ${s}`, claimed);
    }
  }, 120_000);
});

describe('the GPU asked of its columns (game/colquery.ts)', () => {
  test('how many columns of each box hold something built', async () => {
    const { ColumnQuery } = await import('../../src/game/colquery');
    const { isStructural } = await import('../../src/game/fracture');
    const gpu = await testGpu();
    for (let s = 1; s <= 6; s++) {
      const r = rng(s * 4099);
      const mats = [MAT.Stone, MAT.Sand, MAT.Brick, MAT.Concrete, MAT.Steel, MAT.Wood, MAT.Soil];
      const w = new RockWorld(48, 48, 64, () => {
        const col: Interval[] = [{ z0: 0, z1: 4, mat: MAT.Stone }];
        if (r() < 0.15) col.push({ z0: 4, z1: 5 + Math.floor(r() * 4), mat: mats[Math.floor(r() * mats.length)] });
        return col;
      });
      const boxes: [number, number, number, number][] = [];
      for (let i = 0; i < 20; i++) {
        const x0 = Math.floor(r() * 60) - 6;
        const y0 = Math.floor(r() * 60) - 6;
        boxes.push([x0, y0, x0 + Math.floor(r() * 30), y0 + Math.floor(r() * 30)]);
      }
      const cols = gpuCols(gpu.device, w);
      gpu.device.queue.writeBuffer(cols.slots, 0, w.packed.slots);
      const q = new ColumnQuery(gpu.device);
      const got = await q.count({ slots: cols.slots, chunks: cols.chunks, packed: w.packed }, boxes, isStructural);
      const want = boxes.map(([x0, y0, x1, y1]) => {
        let n = 0;
        for (let y = Math.max(0, y0); y <= Math.min(w.H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w.W - 1, x1); x++) if (w.read(x, y).some((iv) => isStructural(iv.mat))) n++;
        return n;
      });
      expect(got, `world ${s}`).toEqual(want);
      expect(want.some((n) => n > 0)).toBe(true);
      cols.slots.destroy();
      cols.chunks.destroy();
    }
    expect(gpu.takeErrors()).toEqual([]);
  });
});

describe('the CPU copy (game/colcopy.ts)', () => {
  test('sparse: a column is readable once fetched, this window and this frame only; writes during a fetch go back over it', async () => {
    const { ColumnCopy } = await import('../../src/game/colcopy');
    const gpu = await testGpu();
    const w = new RockWorld(48, 48, 64, (x) => [{ z0: 0, z1: 10 + (x % 5), mat: MAT.Stone }]);
    const cols = gpuCols(gpu.device, w);
    gpu.device.queue.writeBuffer(cols.slots, 0, w.packed.slots);
    let epoch = 0;
    const copy = new ColumnCopy({ device: gpu.device, packed: w.packed, layers: () => cols.slots, epoch: () => epoch, readWhole: async () => new Float32Array(await gpu.read(cols.slots, w.packed.slots.byteLength)) }, 'sparse');
    expect(() => copy.read(3, 3)).toThrow(/isn't held/);
    const fetching = copy.fetch([copy.chunkOf(3, 3)]);
    // (written while the fetch is in flight: the copy keeps this, not what the read brought)
    copy.write(4, 3, [{ z0: 0, z1: 2, mat: MAT.Sand }]);
    expect(await fetching).toBe(true);
    expect(copy.read(3, 3)).toEqual(w.read(3, 3));
    expect(copy.read(4, 3)).toEqual([{ z0: 0, z1: 2, mat: MAT.Sand, aux: 0 }]);
    // (another chunk: not fetched)
    expect(() => copy.read(20, 3)).toThrow(/isn't held/);
    // (a new frame: nothing held)
    copy.frame();
    expect(() => copy.read(3, 3)).toThrow(/isn't held/);
    // (fetched, then the window slid: not readable)
    expect(await copy.fetch([copy.chunkOf(3, 3)])).toBe(true);
    epoch++;
    expect(copy.has(3, 3)).toBe(false);
    // (kept: the whole window read, every column readable)
    copy.mode = 'kept';
    copy.drop();
    expect(await copy.readFor(new Set())).toBe('whole');
    expect(copy.read(40, 40)).toEqual(w.read(40, 40));
    cols.slots.destroy();
    cols.chunks.destroy();
    expect(gpu.takeErrors()).toEqual([]);
  });
});
