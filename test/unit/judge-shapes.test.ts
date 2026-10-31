// The column-space collapse judge (game/fracture.ts analyseRock — the user, round 120: "Did it replace my column space
// collapse solver? Can we get a collapse test for domes and arches and cliffs with overhang in there?"). It did not:
// the judge still decides what lets go, the node solver only moves what it frees. Hand-built stone in packed columns
// (test/support/rockworld.ts: the production judge, WorldVox and the rigid rock on CPU columns), cut the way a player
// would, judged as Integrity's passes do. What a shape should do is written down first (the expected), what the judge
// does is measured; a shape it gets wrong stays visible as test.fails with its BACKLOG row (SV1–SV4), so the suite goes
// red when the judge is fixed. JUDGE_LOG=1 prints the numbers for the DEVLOG.
import { describe, expect, test } from 'vitest';
import { cellPos } from '../../src/world/lattice';
import { MAT } from '../../src/world/materials';
import type { Interval } from '../../src/world/layout';
import { RockWorld } from '../support/rockworld';

const G = 10;
const W = 64;

/** a world of stone ground to G with `extra` stone intervals in some columns */
function world(extra: (x: number, y: number) => [number, number][]): RockWorld {
  return new RockWorld(W, W, 64, (x, y) => {
    const col: Interval[] = [{ z0: 0, z1: G, mat: MAT.Stone }];
    for (const [z0, z1] of extra(x, y).sort((a, b) => a[0] - b[0])) {
      const last = col[col.length - 1];
      if (z0 <= last.z1 + 1e-6) last.z1 = Math.max(last.z1, z1);
      else col.push({ z0, z1, mat: MAT.Stone });
    }
    return col;
  });
}

/** judge after marking these columns cut; what came loose: bodies (cells), and how much stayed */
function judged(w: RockWorld, cols: [number, number][]): { freed: number; bodies: number[]; tips: number } {
  for (const [x, y] of cols) w.cut.add(y * 65536 + x);
  const before = w.rigid.list.length;
  w.judge();
  const bodies = w.rigid.list.slice(before).map((b) => b.cells.length);
  const tips = w.log.filter((l) => /tips [1-9]/.test(l)).length;
  return { freed: bodies.reduce((s, n) => s + n, 0), bodies, tips };
}
const log = (...a: unknown[]) => {
  if (process.env.JUDGE_LOG) console.log(...a);
};
const dist = (x: number, y: number, cx: number, cy: number) => {
  const [px, py] = cellPos(x, y);
  const [qx, qy] = cellPos(cx, cy);
  return Math.hypot(px - qx, py - qy);
};

describe('an arch (two legs 3 × 3, 12 high, 9 apart, a span 3 deep over them)', () => {
  const legA = (x: number) => x >= 10 && x < 13;
  const legB = (x: number) => x >= 22 && x < 25;
  const rows = (y: number) => y >= 15 && y < 18;
  const arch = () =>
    world((x, y) => {
      if (!rows(y) || x < 10 || x >= 25) return [];
      const out: [number, number][] = [[G + 12, G + 15]];
      if (legA(x) || legB(x)) out.push([G, G + 12]);
      return out;
    });
  const all: [number, number][] = [];
  for (let y = 15; y < 18; y++) for (let x = 10; x < 25; x++) all.push([x, y]);

  test('stands', () => {
    const r = judged(arch(), all);
    log('arch stands:', r);
    expect(r.freed).toBe(0);
  });

  test('a foot cut out from under one leg: the leg and the span let go', () => {
    const w = arch();
    for (let y = 15; y < 18; y++) for (let x = 22; x < 25; x++) w.dig(x, y, G, G + 3);
    const r = judged(w, all);
    log('arch, one foot cut:', r);
    expect(r.freed).toBeGreaterThan(9 * 6);
  });

  // (SV1) the keystone out, each half is a cantilever off its leg — the judge's bend holds a 5-cell arm 3 deep; a real
  // arch's halves lean in on each other and fall without it
  test.fails('the keystone cut out: both halves of the span fall (SV1)', () => {
    const w = arch();
    for (let y = 15; y < 18; y++) for (let x = 16; x < 19; x++) w.dig(x, y, G + 12, G + 15);
    const r = judged(w, all);
    log('arch, keystone cut:', r);
    expect(r.freed).toBeGreaterThan(2 * 9 * 2);
  });
});

describe('a dome (a stone shell 1.5 thick, radius 9, on the ground)', () => {
  const C: [number, number] = [32, 32];
  const R = 9;
  const T = 1.5;
  const shell = (x: number, y: number, crownHole = 0): [number, number][] => {
    const d = dist(x, y, C[0], C[1]);
    if (d > R) return [];
    // (the outer surface z = G + √(R² − d²), the inner G + √((R − T)² − d²); a column inside the inner radius holds a
    // run from the inner to the outer surface, outside it from the ground up)
    const outer = G + Math.sqrt(R * R - d * d);
    if (d < crownHole) return [];
    const ri = R - T;
    const inner = d < ri ? G + Math.sqrt(ri * ri - d * d) : G;
    return [[Math.floor(inner), Math.ceil(outer)]];
  };
  const cols: [number, number][] = [];
  for (let y = 20; y < 45; y++) for (let x = 20; x < 45; x++) if (dist(x, y, C[0], C[1]) <= R) cols.push([x, y]);

  test('stands', () => {
    const r = judged(world((x, y) => shell(x, y)), cols);
    log('dome stands:', r);
    expect(r.freed).toBe(0);
  });

  test('with a hole in its crown, stands', () => {
    const r = judged(world((x, y) => shell(x, y, 2.5)), cols);
    log('dome, crown hole:', r);
    expect(r.freed).toBe(0);
  });

  test('its base ring cut all round: it lets go', () => {
    const w = world((x, y) => shell(x, y));
    for (const [x, y] of cols) if (dist(x, y, C[0], C[1]) > R - T - 0.5) w.dig(x, y, G, G + 2);
    const r = judged(w, cols);
    log('dome, base ring cut:', r);
    expect(r.freed).toBeGreaterThan(100);
  });
});

describe('a cliff with an overhang (a stone wall to G + 20, a shelf off its top of growing reach and thickness)', () => {
  // the wall: columns x < 20; the shelf: x in [20, 20 + reach), its top at G + 20, `thick` deep
  const cliff = (reach: number, thick: number) =>
    world((x, y) => {
      if (y < 20 || y >= 30) return [];
      if (x < 20) return [[G, G + 20]];
      if (x < 20 + reach) return [[G + 20 - thick, G + 20]];
      return [];
    });
  const table: string[] = [];
  const rows: { reach: number; thick: number; freed: number }[] = [];
  for (const thick of [1, 2, 3, 4])
    for (const reach of [2, 4, 6, 8, 12, 16]) {
      const w = cliff(reach, thick);
      const cols: [number, number][] = [];
      for (let y = 20; y < 30; y++) for (let x = 18; x < 20 + reach; x++) cols.push([x, y]);
      const r = judged(w, cols);
      rows.push({ reach, thick, freed: r.freed });
    }
  for (const thick of [1, 2, 3, 4]) table.push(`thick ${thick}: ` + rows.filter((r) => r.thick === thick).map((r) => `reach ${r.reach} ${r.freed ? 'falls (' + r.freed + ')' : 'holds'}`).join(', '));

  test('the numbers (where each lets go)', () => {
    log('cliff overhangs:\n' + table.join('\n'));
    expect(rows.length).toBe(24);
  });

  test('a short thick shelf holds; a long thin one lets go', () => {
    expect(rows.find((r) => r.reach === 2 && r.thick === 4)!.freed).toBe(0);
    expect(rows.find((r) => r.reach === 16 && r.thick === 1)!.freed).toBeGreaterThan(0);
  });

  test('for a given thickness, longer never holds where shorter fell', () => {
    for (const thick of [1, 2, 3, 4]) {
      const f = rows.filter((r) => r.thick === thick).map((r) => r.freed > 0);
      for (let i = 1; i < f.length; i++) if (f[i - 1]) expect(f[i]).toBe(true);
    }
  });
});

describe('a thin spire (radius 1.6, 20 high) undercut on one side', () => {
  const C: [number, number] = [40, 40];
  const spire = () => world((x, y) => (dist(x, y, C[0], C[1]) <= 1.6 ? [[G, G + 20]] : []));
  const cols: [number, number][] = [];
  for (let y = 36; y < 45; y++) for (let x = 36; x < 45; x++) if (dist(x, y, C[0], C[1]) <= 1.6) cols.push([x, y]);

  test('stands', () => {
    expect(judged(spire(), cols).freed).toBe(0);
  });

  test('its foot cut on one side, past its middle: it leans over that way and falls (a tip, not a drop)', () => {
    const w = spire();
    const [cx] = cellPos(C[0], C[1]);
    // (everything of its foot east of a cell short of its axis: what's left of the foot is all to the west of its centre
    // of mass)
    for (const [x, y] of cols) if (cellPos(x, y)[0] > cx - 0.75) w.dig(x, y, G, G + 2);
    const r = judged(w, cols);
    log('spire undercut:', r, w.log.slice(-3));
    expect(r.freed).toBeGreaterThan(30);
    // (it tips over the edge of what's left: the judge hands the body its turn)
    expect(r.tips).toBeGreaterThan(0);
  });
});
