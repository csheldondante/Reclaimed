// (round 128o, DA-B6) The nearest trees found on the GPU (api/treequery.ts, shaders/treequery.wgsl) are the CPU's
// layout's (api/plants.ts planTree) nearest: on a 64 × 64 window of woods, for asks round several points, radii and
// counts — the list is the n nearest (to the bin's width), each tree's species and size as planTree has them; fewer
// than n in reach: every one; none: an empty list (not null); asks made together are read once.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { GLOBALS_BYTES } from '../../src/sim/globals';
import { packMaterialTable } from '../../src/world/materials';
import { planTree } from '../../src/api/plants';
import { TreeQuery } from '../../src/api/treequery';
import { cellPos } from '../../src/world/lattice';
import { testGpu, type TestGpu } from './dawn';

let g: TestGpu;
beforeAll(async () => {
  g = await testGpu();
});
afterAll(() => g?.destroy());

const W = 64;
const H = 64;

test('the GPU finds the n nearest trees planTree lays out, read once for every ask', async () => {
  const dev = g.device;
  const org: [number, number] = [-1234, 5678];
  const glob = new ArrayBuffer(GLOBALS_BYTES);
  const u = new Uint32Array(glob);
  const f = new Float32Array(glob);
  u[0] = W;
  u[1] = H;
  f[276] = org[0];
  f[277] = org[1] * (Math.sqrt(3) / 2);
  f[278] = org[0];
  f[279] = org[1];
  // (succession: woods in the west half, bare in the east; the buffer page-major as the game's: colIdx, ring at 0)
  const v = new Float32Array(W * H);
  const idx = (x: number, y: number) => ((y >> 4) * (W / 16) + (x >> 4)) * 256 + (y & 15) * 16 + (x & 15);
  const vegAt = (x: number, y: number) => (x < 40 ? 3.7 + (1.5 * (x + y)) / (W + H) : 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v[idx(x, y)] = vegAt(x, y);
  const mk = (size: number, usage: number, data?: ArrayBufferView | ArrayBuffer) => {
    const b = dev.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
    if (data) dev.queue.writeBuffer(b, 0, data as ArrayBuffer);
    return b;
  };
  const mats = packMaterialTable();
  const globals = mk(GLOBALS_BYTES, GPUBufferUsage.UNIFORM, glob);
  const materials = mk(mats.byteLength, GPUBufferUsage.UNIFORM, mats);
  const veg = mk(v.byteLength, GPUBufferUsage.STORAGE, v);
  const q = new TreeQuery({ device: dev, globals: () => globals, materials: () => materials, veg: () => veg, dims: () => ({ w: W, h: H }), epoch: () => 0 });
  /** the CPU's trees within r of (x, y), nearest first */
  const cpu = (x: number, y: number, r: number) => {
    const out: { cx: number; cy: number; d: number; species: string; trunk: number; crown: number }[] = [];
    for (let cy = 0; cy < H; cy++)
      for (let cx = 0; cx < W; cx++) {
        const t = planTree(cx, cy, vegAt(cx, cy), W, H, org);
        if (!t) continue;
        const [px, py] = cellPos(cx, cy);
        const d = Math.hypot(px - x, py - y);
        if (d <= r) out.push({ cx, cy, d, species: t.species, trunk: t.trunk, crown: t.crown });
      }
    return out.sort((a, b) => a.d - b.d);
  };
  const asks: [number, number, number, number][] = [
    [20, 20, 18, 12],
    [10, 40, 30, 32],
    [38, 10, 8, 5],
    [33, 33, 40, 1],
    // (the bare east: none)
    [56, 30, 6, 12],
  ];
  const got = await Promise.all(asks.map(([x, y, r, n]) => q.nearest(x, y, r, n)));
  expect(g.takeErrors()).toEqual([]);
  expect(q.stats.reads).toBe(1);
  asks.forEach(([x, y, r, n], i) => {
    const want = cpu(x, y, r);
    const list = got[i]!;
    expect(list, `ask ${i}`).not.toBeNull();
    expect(list.length, `ask ${i}: how many`).toBe(Math.min(n, want.length));
    // (the n nearest, to the width of a distance bin: r / 128)
    const bin = r / 128;
    const nth = want[Math.min(n, want.length) - 1]?.d ?? 0;
    for (const t of list) {
      const w = want.find((c) => c.cx === t.cx && c.cy === t.cy);
      expect(w, `ask ${i}: (${t.cx}, ${t.cy}) is a tree in reach`).toBeTruthy();
      expect(w!.d).toBeLessThanOrEqual(nth + bin);
      expect([t.species, t.trunk, t.crown]).toEqual([w!.species, w!.trunk, w!.crown]);
    }
    // (every tree nearer than the cut is in)
    for (const c of want) if (c.d < nth - bin) expect(list.some((t) => t.cx === c.cx && t.cy === c.cy), `ask ${i}: (${c.cx}, ${c.cy}) missing`).toBe(true);
  });
  expect(cpu(20, 20, 18).length).toBeGreaterThan(12);
  expect(got[4]).toEqual([]);
  q.destroy();
});
