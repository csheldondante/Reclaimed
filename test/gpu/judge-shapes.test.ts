// The collapse judges side by side (round 120, the user: "Can we treat this as an experiment and test each approach
// side by side?"): the shapes of test/unit/judge-shapes.test.ts (the solver agent's: arch, dome, cliff shelves,
// spire) and a cantilever whose weakest section is mid-span, each judged by A (runs: fracture.ts analyseRock, CPU)
// and B (sections: judge.wgsl on Dawn), through game/judge.ts's one interface. B's expectations are asserted, from a
// stated stone estimate; A's results are kept beside them as a table (its own expectations, with its known misses
// SV1 and SV2, stay in the unit file). JUDGE_LOG=1 writes the table (data/perf/judge/shapes.md).
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RunsJudge, SectionsJudge, type RockJudge } from '../../src/game/judge';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import type { Interval } from '../../src/world/layout';
import { TUNE } from '../../src/tune/params';
import { WORLD_G } from '../../src/world/scale';
import { RockWorld } from '../support/rockworld';
import { gpuCols, judgeWorld } from '../support/judgeworld';
import { testGpu, type TestGpu } from './dawn';

const G = 10;
const W = 64;

// ---- the stone estimate (a cell a metre): intact limestone or sandstone takes ~4 MPa in tension (TUNE.judgeB.tensile),
// rock weighs 2600 kg/m³ × 9.8 m/s² ≈ 25.5 kN/m³ — so a section takes σ' = 4e6 / 25 480 ≈ 157 "metres of rock" of stress.
// A shelf t thick reaching L from its wall (a unit of width): weight t·L, its moment at the root t·L²/2, its section
// modulus t²/6: it holds while t·L²/2 ≤ σ'·t²/6, i.e. L ≤ √(σ'·t / 3) — 7.2 m at 1 m thick, 10.2 at 2, 12.5 at 3, 14.5 at 4.
// (The solver agent's rough estimate for 3 m: "fails around 12–14".) Shear (8 MPa, σ' 314) never governs a shelf.
const SIGMA = (TUNE.judgeB.tensile * 1e6) / (TUNE.judgeB.density * WORLD_G);
const reachLimit = (t: number) => Math.sqrt((SIGMA * t) / 3);

/** a world of stone ground to G with `extra` stone intervals in some columns */
function world(extra: (x: number, y: number) => [number, number][], mat: number = MAT.Stone): RockWorld {
  return new RockWorld(W, W, 64, (x, y) => {
    // (stone ground; what's built on it of `mat` — touching intervals of one material merged)
    const col: Interval[] = [{ z0: 0, z1: G, mat: MAT.Stone }];
    for (const [z0, z1] of extra(x, y).sort((a, b) => a[0] - b[0])) {
      const last = col[col.length - 1];
      if (last.mat === mat && z0 <= last.z1 + 1e-6) last.z1 = Math.max(last.z1, z1);
      else col.push({ z0: Math.max(z0, last.z1), z1, mat });
    }
    return col;
  });
}
const dist = (x: number, y: number, cx: number, cy: number) => {
  const [px, py] = cellPos(x, y);
  const [qx, qy] = cellPos(cx, cy);
  return Math.hypot(px - qx, py - qy);
};

interface Res {
  freed: number;
  bodies: number[];
  tips: number;
  ms: number;
  gpuMs?: number;
}

let gpu: TestGpu;
beforeAll(async () => {
  gpu = await testGpu();
});
afterAll(() => {
  // (JUDGE_LOG=1: the table to data/perf/judge/shapes.md, for the DEVLOG and the report)
  if (process.env.JUDGE_LOG) {
    mkdirSync('data/perf/judge', { recursive: true });
    writeFileSync('data/perf/judge/shapes.md', table.map((r) => `| ${r} |`).join('\n') + '\n');
  }
  expect(gpu.takeErrors()).toEqual([]);
});

const table: string[] = ['shape | A (runs): freed, bodies, tips, ms | B (sections): freed, bodies, tips, ms, gpu ms'];

/** judge `make()` cut at `cut` (and marked cut at `cols`) with one judge */
async function run(j: RockJudge, make: () => RockWorld, cols: [number, number][], cut?: (w: RockWorld) => void): Promise<Res & { w: RockWorld }> {
  const w = make();
  cut?.(w);
  for (const [x, y] of cols) w.cut.add(y * 65536 + x);
  const before = w.rigid.list.length;
  const r = await judgeWorld(w, j, j.id === 'sections' ? gpuCols(gpu.device, w) : undefined);
  const bodies = w.rigid.list.slice(before).map((b) => b.cells.length);
  const tips = w.log.filter((l) => /tips [1-9]/.test(l)).length;
  const ms = r.stats.reduce((s, x) => s + x.ms, 0);
  const gms = r.stats.reduce((s, x) => s + (x.gpuMs ?? 0), 0);
  return { freed: bodies.reduce((s, n) => s + n, 0), bodies, tips, ms, gpuMs: j.id === 'sections' ? gms : undefined, w };
}

/** both judges on a shape; the table row; B's result for the test */
async function both(name: string, make: () => RockWorld, cols: [number, number][], cut?: (w: RockWorld) => void): Promise<Res & { w: RockWorld }> {
  const a = await run(new RunsJudge(), make, cols, cut);
  const jb = new SectionsJudge();
  const b = await run(jb, make, cols, cut);
  jb.destroy();
  const fmt = (r: Res) => `${r.freed}, [${r.bodies.slice(0, 4).join(' ')}${r.bodies.length > 4 ? ' …' : ''}], ${r.tips}, ${r.ms.toFixed(2)}${r.gpuMs !== undefined ? ', ' + r.gpuMs.toFixed(3) : ''}`;
  table.push(`${name} | ${fmt(a)} | ${fmt(b)}`);
  return b;
}

// (the user on the keystone, round 120b: "Follow the material" — natural stone keeps its tensile strength, built
// masonry has none: materials.ts bond, TUNE.judgeB.tRock / tMasonry)
for (const [kind, mat] of [
  ['natural rock', MAT.Stone],
  ['masonry (brick)', MAT.Brick],
] as const)
  describe(`a ${kind} arch (two legs 3 × 3, 12 high, 9 apart, a span 3 deep over them)`, () => {
    const legA = (x: number) => x >= 10 && x < 13;
    const legB = (x: number) => x >= 22 && x < 25;
    const rows = (y: number) => y >= 15 && y < 18;
    const arch = () =>
      world((x, y) => {
        if (!rows(y) || x < 10 || x >= 25) return [];
        const out: [number, number][] = [[G + 12, G + 15]];
        if (legA(x) || legB(x)) out.push([G, G + 12]);
        return out;
      }, mat);
    const all: [number, number][] = [];
    for (let y = 15; y < 18; y++) for (let x = 10; x < 25; x++) all.push([x, y]);
    const tag = mat === MAT.Stone ? 'arch' : 'brick arch';

    test('stands (held from both legs: in compression, a parabola 3 deep fits its span of 9)', async () => {
      expect((await both(tag, arch, all)).freed).toBe(0);
    });

    test('a foot cut out from under one leg: the leg and the span let go (a 12-reach arm with a 108-cell leg on its end)', async () => {
      const r = await both(`${tag}, one foot cut`, arch, all, (w) => {
        for (let y = 15; y < 18; y++) for (let x = 22; x < 25; x++) w.dig(x, y, G, G + 3);
      });
      expect(r.freed).toBeGreaterThan(9 * 6);
    });

    // natural stone: each half is a corbel 3 thick reaching 3 from its leg — its root moment 3·3²/2 = 13.5 a metre of
    // width against σ'·3²/6 ≈ 235: it holds 17×, as Wall Arch's stubs stood after it fell (2008). Masonry: no tension
    // (Heyman) — a half held from one side can't hang, it falls
    if (mat === MAT.Stone)
      test('the keystone cut out: the halves stand as corbels (natural stone keeps its tension; SV1)', async () => {
        const r = await both(`${tag}, keystone cut`, arch, all, (w) => {
          for (let y = 15; y < 18; y++) for (let x = 16; x < 19; x++) w.dig(x, y, G + 12, G + 15);
        });
        expect(r.freed).toBe(0);
      });
    else
      test('the keystone cut out: both halves fall (masonry has no tension; SV1)', async () => {
        const r = await both(`${tag}, keystone cut`, arch, all, (w) => {
          for (let y = 15; y < 18; y++) for (let x = 16; x < 19; x++) w.dig(x, y, G + 12, G + 15);
        });
        expect(r.freed).toBeGreaterThanOrEqual(2 * 9 * 2);
      });
  });

describe('a dome (a stone shell 1.5 thick, radius 9, on the ground)', () => {
  const C: [number, number] = [32, 32];
  const R = 9;
  const T = 1.5;
  const shell = (x: number, y: number, crownHole = 0): [number, number][] => {
    const d = dist(x, y, C[0], C[1]);
    if (d > R) return [];
    const outer = G + Math.sqrt(R * R - d * d);
    if (d < crownHole) return [];
    const ri = R - T;
    const inner = d < ri ? G + Math.sqrt(ri * ri - d * d) : G;
    return [[Math.floor(inner), Math.ceil(outer)]];
  };
  const cols: [number, number][] = [];
  for (let y = 20; y < 45; y++) for (let x = 20; x < 45; x++) if (dist(x, y, C[0], C[1]) <= R) cols.push([x, y]);

  test('stands (its cap held all round: a funicular fits its shell)', async () => {
    expect((await both('dome', () => world((x, y) => shell(x, y)), cols)).freed).toBe(0);
  });

  test('with a hole in its crown, stands (a compression ring)', async () => {
    expect((await both('dome, crown hole', () => world((x, y) => shell(x, y, 2.5)), cols)).freed).toBe(0);
  });

  test('its base ring cut all round: it lets go (held by nothing)', async () => {
    const r = await both('dome, base ring cut', () => world((x, y) => shell(x, y)), cols, (w) => {
      for (const [x, y] of cols) if (dist(x, y, C[0], C[1]) > R - T - 0.5) w.dig(x, y, G, G + 2);
    });
    expect(r.freed).toBeGreaterThan(100);
  });
});

describe('a cliff with an overhang (a stone wall to G + 20, a shelf off its top of growing reach and thickness)', () => {
  const cliff = (reach: number, thick: number) => () =>
    world((x, y) => {
      if (y < 20 || y >= 30) return [];
      if (x < 20) return [[G, G + 20]];
      if (x < 20 + reach) return [[G + 20 - thick, G + 20]];
      return [];
    });
  const rows: { reach: number; thick: number; freed: number }[] = [];
  beforeAll(async () => {
    for (const thick of [1, 2, 3, 4])
      for (const reach of [2, 4, 6, 8, 12, 16]) {
        const cols: [number, number][] = [];
        for (let y = 20; y < 30; y++) for (let x = 18; x < 20 + reach; x++) cols.push([x, y]);
        const r = await both(`shelf ${thick} thick, reach ${reach}`, cliff(reach, thick), cols);
        rows.push({ reach, thick, freed: r.freed });
      }
  });

  test('each shelf holds short of √(σ′t/3) and lets go past it (±10 %: the hex columns\' faces)', () => {
    for (const r of rows) {
      const L = reachLimit(r.thick);
      if (r.reach < 0.9 * L) expect(r.freed, `${r.thick} thick, reach ${r.reach} (limit ${L.toFixed(1)})`).toBe(0);
      if (r.reach > 1.1 * L) expect(r.freed, `${r.thick} thick, reach ${r.reach} (limit ${L.toFixed(1)})`).toBeGreaterThan(0);
    }
  });

  test('3 thick: holds at 12, falls at 16 (SV2: A holds 16)', () => {
    expect(rows.find((r) => r.reach === 12 && r.thick === 3)!.freed).toBe(0);
    expect(rows.find((r) => r.reach === 16 && r.thick === 3)!.freed).toBeGreaterThan(0);
  });

  test('for a given thickness, longer never holds where shorter fell', () => {
    for (const thick of [1, 2, 3, 4]) {
      const f = rows.filter((r) => r.thick === thick).map((r) => r.freed > 0);
      for (let i = 1; i < f.length; i++) if (f[i - 1]) expect(f[i]).toBe(true);
    }
  });
});

describe('a cantilever whose weakest section is mid-span (a shelf 6 thick for 6, a neck 1 thick, then 5 more 3 thick)', () => {
  // the root (6 thick): weight 36 + 16 a metre, its centre of mass 4.9 out — moment 255 against σ'·6²/6 ≈ 940: holds.
  // The neck (1 thick, 6 out): the 16 beyond it, centre 3.3 out — moment 53 against σ'·1²/6 ≈ 26: it breaks there,
  // and only what's beyond it falls (16 cells a row, 10 rows)
  const shelf = () =>
    world((x, y) => {
      if (y < 20 || y >= 30) return [];
      if (x < 20) return [[G, G + 20]];
      if (x < 26) return [[G + 14, G + 20]];
      if (x === 26) return [[G + 19, G + 20]];
      if (x < 32) return [[G + 17, G + 20]];
      return [];
    });
  const cols: [number, number][] = [];
  for (let y = 20; y < 30; y++) for (let x = 18; x < 32; x++) cols.push([x, y]);

  test('it breaks at the neck: what is beyond falls, the root stays', async () => {
    const r = await both('mid-span neck', shelf, cols);
    expect(r.freed).toBe(160);
    expect(r.w.read(23, 25).some((iv) => iv.z0 === G + 14 && iv.z1 === G + 20)).toBe(true);
    expect(r.w.read(28, 25).length).toBe(1);
  });
});

describe('a thin spire (radius 1.6, 20 high) undercut on one side', () => {
  const C: [number, number] = [40, 40];
  const spire = () => world((x, y) => (dist(x, y, C[0], C[1]) <= 1.6 ? [[G, G + 20]] : []));
  const cols: [number, number][] = [];
  for (let y = 36; y < 45; y++) for (let x = 36; x < 45; x++) if (dist(x, y, C[0], C[1]) <= 1.6) cols.push([x, y]);

  test('stands', async () => {
    expect((await both('spire', spire, cols)).freed).toBe(0);
  });

  test('its foot cut on one side, past its middle: it tips over that way (its centre of mass past what is left)', async () => {
    const [cx] = cellPos(C[0], C[1]);
    const r = await both('spire undercut', spire, cols, (w) => {
      for (const [x, y] of cols) if (cellPos(x, y)[0] > cx - 0.75) w.dig(x, y, G, G + 2);
    });
    expect(r.freed).toBeGreaterThan(30);
    expect(r.tips).toBeGreaterThan(0);
  });
});
