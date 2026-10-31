// Judge B's fast paths held to its oracle (round 120, the user: "Yes please implement options 1 and 2" — every level at
// once on the whole GPU, few sequential passes — and "culling to only a local neighborhood"). The oracle is the level
// pass (mode 'levels': a pass a distance level in one workgroup, as first built) over every piece in the window
// (cull off). Each fast variant must give the same verdict — the same pieces (their runs), the same crumbs, the same
// hinges — on the shapes and on random caves:
//   levels + cull   only the pieces a cut could have weakened are flooded and judged
//   pairs + cull    every level's sections at once (union-find on (run, level) pairs), culled — the default
//   pairs, no cull
//   pairs + cull + grow  (JB13) a window from the leg walk's reach, grown when a piece reaches its side
import { describe, expect, test } from 'vitest';
import { SectionsJudge } from '../../src/game/judge';
import type { Fracture } from '../../src/game/fracture';
import { subtract } from '../../src/game/colbodies';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import type { Interval } from '../../src/world/layout';
import { RockWorld } from '../support/rockworld';
import { gpuCols } from '../support/judgeworld';
import { testGpu } from './dawn';

const G = 10;

/** a verdict as text, order-free: each piece's runs sorted, the pieces sorted, the crumbs, the hinges (rounded) */
function canon(fr: Fracture): string {
  const run = (c: { x: number; y: number; ivs: { z0: number; z1: number; mat: number }[] }) => `${c.x},${c.y}:${c.ivs.map((iv) => `${iv.z0.toFixed(3)}-${iv.z1.toFixed(3)}/${iv.mat}`).join('+')}`;
  const pieces = (fr.pieces ?? []).map((p, i) => {
    const tip = (fr.tips ?? []).find((t) => t.piece === i);
    const h = tip ? ` tip ${tip.pivot.map((v) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2)).join(',')} ${tip.axis.map((v) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2)).join(',')}` : '';
    return p.map(run).sort().join(' ') + h;
  });
  const crumbs = (fr.crumbleRuns ?? []).map(run).sort();
  return JSON.stringify({ pieces: pieces.sort(), crumbs });
}

const VARIANTS = [
  { mode: 'levels', cull: true, grow: false },
  { mode: 'pairs', cull: true, grow: false },
  { mode: 'pairs', cull: false, grow: false },
  // (JB13: a window from the leg walk's reach, grown when a seeded piece or its leg reaches its side)
  { mode: 'pairs', cull: true, grow: true },
  // (the default: the pairs from TUNE.judgeB.pairsDepth levels, else the level pass)
  { mode: 'auto', cull: true, grow: true },
] as const;

/** the oracle's verdict and each variant's, on one world cut at `seeds` (weighed: those columns) */
async function compare(w: RockWorld, seeds: [number, number][]): Promise<{ oracle: string; got: string[]; pieces: number }> {
  const gpu = await testGpu();
  const cols = gpuCols(gpu.device, w);
  gpu.device.queue.writeBuffer(cols.slots, 0, w.packed.slots);
  const weighed = new Set(seeds.map(([x, y]) => y * 65536 + x));
  const judge = async (mode: 'levels' | 'pairs' | 'auto', cull: boolean, grow: boolean) => {
    const j = new SectionsJudge();
    j.mode = mode;
    j.cull = cull;
    j.grow = grow;
    const fr = await j.judge({ cols: { packed: w.packed, gpu: cols }, seeds, weigh: (x, y) => weighed.has(y * 65536 + x), rotate: true });
    j.destroy();
    return fr;
  };
  const ref = await judge('levels', false, false);
  const got: string[] = [];
  for (const v of VARIANTS) got.push(canon(await judge(v.mode, v.cull, v.grow)));
  cols.slots.destroy();
  cols.chunks.destroy();
  expect(gpu.takeErrors()).toEqual([]);
  return { oracle: canon(ref), got, pieces: (ref.pieces ?? []).length };
}

function world(W: number, extra: (x: number, y: number) => [number, number][], mat: number = MAT.Stone): RockWorld {
  return new RockWorld(W, W, 64, (x, y) => {
    const col: Interval[] = [{ z0: 0, z1: G, mat: MAT.Stone }];
    for (const [z0, z1] of extra(x, y).sort((a, b) => a[0] - b[0])) {
      const last = col[col.length - 1];
      if (last.mat === mat && z0 <= last.z1 + 1e-6) last.z1 = Math.max(last.z1, z1);
      else col.push({ z0: Math.max(z0, last.z1), z1, mat });
    }
    return col;
  });
}
const box = (x0: number, y0: number, x1: number, y1: number) => {
  const o: [number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) o.push([x, y]);
  return o;
};

describe('the shapes: every fast path gives the oracle\'s verdict', () => {
  const shapes: { name: string; make: () => RockWorld; seeds: [number, number][]; cut?: (w: RockWorld) => void }[] = [
    { name: 'arch, one foot cut', make: () => world(64, (x, y) => (y >= 15 && y < 18 && x >= 10 && x < 25 ? [[G + 12, G + 15], ...((x < 13 || x >= 22 ? [[G, G + 12]] : []) as [number, number][])] : [])), seeds: box(10, 15, 25, 18), cut: (w) => box(22, 15, 25, 18).forEach(([x, y]) => w.dig(x, y, G, G + 3)) },
    ...(['foot', 'keystone'] as const).map((cut) => ({
      name: `brick arch, ${cut} cut`,
      make: () => world(64, (x, y) => (y >= 15 && y < 18 && x >= 10 && x < 25 ? [[G + 12, G + 15], ...((x < 13 || x >= 22 ? [[G, G + 12]] : []) as [number, number][])] : []), MAT.Brick),
      seeds: box(10, 15, 25, 18),
      cut: (w: RockWorld) => (cut === 'foot' ? box(22, 15, 25, 18).forEach(([x, y]) => w.dig(x, y, G, G + 3)) : box(16, 15, 19, 18).forEach(([x, y]) => w.dig(x, y, G + 12, G + 15))),
    })),
    { name: 'arch, keystone cut', make: () => world(64, (x, y) => (y >= 15 && y < 18 && x >= 10 && x < 25 ? [[G + 12, G + 15], ...((x < 13 || x >= 22 ? [[G, G + 12]] : []) as [number, number][])] : [])), seeds: box(10, 15, 25, 18), cut: (w) => box(16, 15, 19, 18).forEach(([x, y]) => w.dig(x, y, G + 12, G + 15)) },
    {
      name: 'dome',
      make: () =>
        world(64, (x, y) => {
          const [px, py] = cellPos(x, y);
          const [qx, qy] = cellPos(32, 32);
          const d = Math.hypot(px - qx, py - qy);
          if (d > 9) return [];
          return [[Math.floor(d < 7.5 ? G + Math.sqrt(56.25 - d * d) : G), Math.ceil(G + Math.sqrt(81 - d * d))]];
        }),
      seeds: box(20, 20, 45, 45),
    },
    ...[1, 3].flatMap((t) => [6, 12, 16].map((reach) => ({ name: `shelf ${t} × ${reach}`, make: () => world(64, (x, y) => (y < 20 || y >= 30 ? [] : x < 20 ? [[G, G + 20]] : x < 20 + reach ? [[G + 20 - t, G + 20]] : [])) as RockWorld, seeds: box(18, 20, 20 + reach, 30) }))),
    { name: 'mid-span neck', make: () => world(64, (x, y) => (y < 20 || y >= 30 ? [] : x < 20 ? [[G, G + 20]] : x < 26 ? [[G + 14, G + 20]] : x === 26 ? [[G + 19, G + 20]] : x < 32 ? [[G + 17, G + 20]] : [])), seeds: box(18, 20, 32, 30) },
  ];
  for (const sh of shapes)
    test(sh.name, async () => {
      const w = sh.make();
      sh.cut?.(w);
      const r = await compare(w, sh.seeds);
      for (const g of r.got) expect(g).toBe(r.oracle);
    });
});

/** a seeded random (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random caves: a hill of stone (to G + 24) with spherical voids carved through it (roofs, ledges, bridges, pillars;
 * some pieces hanging free), then a cut — a void at a random spot — and every column within it seeded and weighed.
 */
function cave(seed: number, mat: number = MAT.Stone): { w: RockWorld; seeds: [number, number][] } {
  const r = rng(seed);
  const W = 48;
  const voids: [number, number, number, number][] = [];
  for (let i = 0; i < 6 + Math.floor(r() * 6); i++) voids.push([4 + r() * 40, 4 + r() * 36, G + 2 + r() * 16, 2.5 + r() * 6]);
  const hill = (px: number, py: number) => G + 24 - 0.15 * Math.hypot(px - 24, py - 20);
  const w = new RockWorld(W, W, 64, (x, y) => {
    const [px, py] = cellPos(x, y);
    let col: { z0: number; z1: number }[] = [{ z0: 0, z1: Math.max(G, Math.round(hill(px, py))) }];
    for (const [vx, vy, vz, vr] of voids) {
      const d = Math.hypot(px - vx, py - vy);
      if (d >= vr) continue;
      const h = Math.sqrt(vr * vr - d * d);
      col = subtract(col.map((iv) => ({ ...iv, mat: MAT.Stone })), [{ z0: Math.max(G, Math.round(vz - h)), z1: Math.round(vz + h) }]);
    }
    return col.filter((iv) => iv.z1 - iv.z0 > 0.5).map((iv) => ({ z0: iv.z0, z1: iv.z1, mat: iv.z1 <= G ? MAT.Stone : mat }));
  });
  const [cx, cy, cz, cr] = [6 + r() * 36, 6 + r() * 32, G + 1 + r() * 10, 2 + r() * 3];
  const seeds: [number, number][] = [];
  for (const [x, y] of w.near(cx, cy, cr)) {
    const [px, py] = cellPos(x, y);
    const h = Math.sqrt(Math.max(0, cr * cr - (px - cx) ** 2 - (py - cy) ** 2));
    w.dig(x, y, Math.max(G, Math.round(cz - h)), Math.round(cz + h) + 1);
    seeds.push([x, y]);
  }
  return { w, seeds };
}

describe('random caves: every fast path gives the oracle\'s verdict', () => {
  test('40 caves', async () => {
    let falling = 0;
    for (let s = 1; s <= 40; s++) {
      // (every third cave built of brick: masonry, no tension — "Follow the material")
      const { w, seeds } = cave(s * 7919, s % 3 === 0 ? MAT.Brick : MAT.Stone);
      if (!seeds.length) continue;
      const r = await compare(w, seeds);
      falling += r.pieces ? 1 : 0;
      for (const g of r.got) expect(g, `cave ${s}`).toBe(r.oracle);
    }
    // (the caves are worth testing: some of them let something go)
    expect(falling).toBeGreaterThan(3);
  }, 300_000);

  test('40 caves with a short leg walk (neck 4: the growing window starts at 6 columns and has to grow)', async () => {
    const { TUNE } = await import('../../src/tune/params');
    const was = TUNE.judgeB.neck;
    TUNE.judgeB.neck = 4;
    try {
      for (let s = 1; s <= 40; s++) {
        const { w, seeds } = cave(s * 104729, s % 3 === 0 ? MAT.Brick : MAT.Stone);
        if (!seeds.length) continue;
        const r = await compare(w, seeds);
        for (const g of r.got) expect(g, `cave ${s}`).toBe(r.oracle);
      }
    } finally {
      TUNE.judgeB.neck = was;
    }
  }, 300_000);
});
