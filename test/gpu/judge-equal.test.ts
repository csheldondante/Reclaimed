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
import { MAT } from '../../src/world/materials';
import type { RockWorld } from '../support/rockworld';
import { cave, SHAPES } from '../support/judgeshapes';
import { gpuCols } from '../support/judgeworld';
import { testGpu } from './dawn';


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

describe('the shapes: every fast path gives the oracle\'s verdict', () => {
  for (const sh of SHAPES)
    test(sh.name, async () => {
      const w = sh.make();
      sh.cut?.(w);
      const r = await compare(w, sh.seeds);
      for (const g of r.got) expect(g).toBe(r.oracle);
    });
});

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
