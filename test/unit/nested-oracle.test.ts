// Nested scales lab (docs/design/NESTED_SCALES.md): the oracle's invariants. The page self-test (?selftest=1) runs the
// same invariants on the GPU passes and compares them with this oracle.
import { describe, expect, it } from 'vitest';
import { AIR, MAT, Nest, OPEN_BOTTOM, colDist, fromPart, makeRoot, ppm2, ppmSub, toLayers, toPart, type Col, type Frame, type Level } from '../../src/nested/oracle';

const K = 8;
const SEED = 7;
// a 48-wide root; children 64 columns (8 parent cells) each, chunk aligned, nested with a margin
const F1: Frame = { depth: 1, gx: 128, gy: 160, n: 64, z0: 0 };
const F2: Frame = { depth: 2, gx: (128 + 24) * K, gy: (160 + 24) * K, n: 64, z0: 0 };
const F3: Frame = { depth: 3, gx: (F2.gx + 24) * K, gy: (F2.gy + 24) * K, n: 64, z0: 0 };

function nest(): Nest {
  return new Nest(makeRoot(48, SEED), K, SEED);
}
/** z0 of a child: the parent's surface under the window's centre, whole parent units */
function withZ0(n: Nest, f: Frame): Frame {
  const p = n.levels[f.depth - 1];
  const c = p.at((f.gx + f.n / 2) / K, (f.gy + f.n / 2) / K)!;
  return { ...f, z0: Math.round(c.z1[c.z1.length - 1]) };
}
const snap = (lv: Level) => lv.cols.map((c) => ({ mat: c.mat.slice(), z0: c.z0.slice(), z1: c.z1.slice() }));
function maxDiff(a: Col[], b: Col[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[i].z1.length; j++) m = Math.max(m, Math.abs(a[i].z1[j] - b[i].z1[j]), j > 0 ? Math.abs(a[i].z0[j] - b[i].z0[j]) : 0);
  return m;
}
const surf = (c: Col) => c.z1[c.z1.length - 1];

describe('nested scales oracle', () => {
  it('(a) promote, demote, promote returns the same child, with and without edits', () => {
    const n = nest();
    n.promote(withZ0(n, F1));
    const a = snap(n.levels[1]);
    n.demote(1);
    n.promote(withZ0(n, F1));
    expect(snap(n.levels[1])).toEqual(a);
    expect(n.res[1].size).toBe(0);
    n.edit(1, 'raise', F1.gx + 20, F1.gy + 30, 6, 3);
    n.edit(1, 'dig', F1.gx + 40, F1.gy + 20, 5, 4);
    const b = snap(n.levels[1]);
    const f = n.levels[1].f;
    n.demote(1);
    n.promote(f);
    expect(snap(n.levels[1])).toEqual(b);
    expect(n.res[1].size).toBeGreaterThan(0);
  });

  it('(a2) the residual is sparse: an edit in one corner leaves none past its support', () => {
    const n = nest();
    n.promote(withZ0(n, F1));
    n.edit(1, 'raise', F1.gx + 6, F1.gy + 6, 3, 2);
    // restricted parent cells 0..1 of the window, enhance support 2 more: columns 0..31
    const keys = [...n.res[1].keys()].map((key) => [key % n.rowWidth(1), Math.floor(key / n.rowWidth(1))]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(([x, y]) => x - F1.gx < 32 && y - F1.gy < 32)).toBe(true);
  });

  it('(b) restrict conserves volume per material; enhance keeps each block on its parent', () => {
    const n = nest();
    const f = withZ0(n, F1);
    n.promote(f);
    n.edit(1, 'dig', F1.gx + 30, F1.gy + 30, 9, 5);
    n.edit(1, 'raise', F1.gx + 10, F1.gy + 50, 4, 2);
    const c = n.levels[1];
    const p = n.levels[0];
    let worst = 0;
    for (let py = F1.gy / K; py < (F1.gy + F1.n) / K; py++)
      for (let px = F1.gx / K; px < (F1.gx + F1.n) / K; px++) {
        const pl = toLayers(p.at(px, py)!);
        const sum = pl.v.map(() => 0);
        for (let b = 0; b < K; b++) for (let a = 0; a < K; a++) toLayers(c.at(px * K + a, py * K + b)!).v.forEach((v, i) => (sum[i] += v));
        // child units: area 1, heights k times the parent's
        worst = Math.max(worst, Math.abs(sum[0] - K * K * K * (pl.v[0] - f.z0)), ...pl.v.slice(1).map((v, i) => Math.abs(sum[i + 1] - K * K * K * v)));
      }
    expect(worst).toBeLessThan(1e-6);
  });

  it('(c) a three-level chain: an edit at depth 2, both demoted, both promoted again, identical', () => {
    const n = nest();
    n.promote(withZ0(n, F1));
    n.promote(withZ0(n, F2));
    n.edit(2, 'raise', F2.gx + 32, F2.gy + 32, 10, 6);
    n.edit(2, 'dig', F2.gx + 20, F2.gy + 40, 6, 8);
    const s0 = snap(n.levels[0]);
    const s1 = snap(n.levels[1]);
    const s2 = snap(n.levels[2]);
    const f1 = n.levels[1].f;
    const f2 = n.levels[2].f;
    n.demote(2);
    n.demote(1);
    expect(snap(n.levels[0])).toEqual(s0);
    n.promote(f1);
    n.promote(f2);
    expect(snap(n.levels[1])).toEqual(s1);
    expect(snap(n.levels[2])).toEqual(s2);
    // the edit reached the root: its columns under the edit moved
    expect(n.res[1].size).toBeGreaterThan(0);
  });

  it('(d) a parent edit while the child is demoted shows in the child; the child edits survive', () => {
    const n = nest();
    const f = withZ0(n, F1);
    n.promote(f);
    // the child's edit near one corner, the parent's near the other
    n.edit(1, 'raise', F1.gx + 12, F1.gy + 12, 6, 4);
    const before = snap(n.levels[1]);
    n.demote(1);
    n.edit(0, 'dig', F1.gx / K + 6.5, F1.gy / K + 6.5, 1.5, 3);
    n.promote(f);
    const after = snap(n.levels[1]);
    const at = (s: Col[], x: number, y: number) => surf(s[y * F1.n + x]);
    // the child's edit: untouched by the parent's (far away), identical
    expect(at(after, 12, 12)).toBe(at(before, 12, 12));
    // the parent's dig: the child is lower there, by about the dig (in child units)
    expect(at(before, 52, 52) - at(after, 52, 52)).toBeGreaterThan(5);
  });

  it('(e) sliding the child by whole parent cells keeps the overlapping columns identical', () => {
    const n = nest();
    const f = withZ0(n, F1);
    n.promote(f);
    n.edit(1, 'raise', F1.gx + 34, F1.gy + 30, 6, 4);
    const a = n.levels[1];
    const old = new Map<string, Col>();
    for (let y = 0; y < f.n; y++) for (let x = 0; x < f.n; x++) old.set(`${f.gx + x},${f.gy + y}`, a.cols[y * f.n + x]);
    const g = { ...f, gx: f.gx + 16, gy: f.gy - 32 };
    n.slide(g);
    let same = 0;
    for (let y = 0; y < g.n; y++)
      for (let x = 0; x < g.n; x++) {
        const o = old.get(`${g.gx + x},${g.gy + y}`);
        if (!o) continue;
        expect(n.levels[1].cols[y * g.n + x]).toEqual(o);
        same++;
      }
    expect(same).toBe(48 * 32);
  });

  it('every level stays in a local range at depth 3 (columns 1 unit, heights within 1000)', () => {
    const n = nest();
    n.promote(withZ0(n, F1));
    n.promote(withZ0(n, F2));
    n.promote(withZ0(n, F3));
    for (const lv of n.levels) {
      let lo = Infinity;
      let hi = -Infinity;
      let rough = 0;
      for (let i = 0; i < lv.cols.length; i++) {
        const s = surf(lv.cols[i]);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
        if (i % lv.f.n) rough = Math.max(rough, Math.abs(s - surf(lv.cols[i - 1])));
      }
      expect(Math.max(Math.abs(lo), Math.abs(hi))).toBeLessThan(1000);
      expect(rough).toBeGreaterThan(0.01);
    }
    // depth 3's column is 1/512 of the root's: it still spans 1 local unit
    expect(n.origin(3).s).toBe(512);
  });

  it('a tunnel carved through a hill at depth 1 and depth 2: demote/promote identical, volume removed ~ the balls, restrict conserves soil, air and surface', () => {
    const n = nest();
    n.promote(withZ0(n, F1));
    n.promote(withZ0(n, F2));
    const solid = (c: Col, ref: number) => c.mat.reduce((s, _m, i) => s + c.z1[i] - Math.max(c.z0[i], ref), 0);
    const total = (lv: Level, ref: number) => lv.cols.reduce((s, c) => s + solid(c, ref), 0);
    for (const [depth, F] of [
      [1, F1],
      [2, F2],
    ] as const) {
      const lv = n.levels[depth];
      const before = total(lv, -500);
      const mid = lv.at(F.gx + 32, F.gy + 32)!;
      const cz = mid.z1[mid.z1.length - 1] - 4;
      const r = 3;
      for (let i = 0; i < 9; i++) n.edit(depth, 'carve', F.gx + 16 + i * 4 + 0.5, F.gy + 32.5, r, 0, cz);
      const removed = before - total(n.levels[depth], -500);
      // nine balls of radius 3 spaced 4 apart (they overlap); one alone is 113 cells³
      expect(removed).toBeGreaterThan(9 * 50);
      expect(removed).toBeLessThan(9 * ((4 / 3) * Math.PI * r ** 3) * 1.1);
      // the tunnel: the column in its middle has an air gap of about the ball's height
      const t = n.levels[depth].at(F.gx + 32, F.gy + 32)!;
      expect(Math.max(...t.mat.map((_m, i) => (i ? t.z0[i] - t.z1[i - 1] : 0)))).toBeGreaterThan(4);
    }
    // restrict over a mixed block: the parent holds the block's mean surface, soil and enclosed air
    const px = (F2.gx + 32) / K;
    const py = (F2.gy + 32) / K;
    const kids: Col[] = [];
    for (let b = 0; b < K; b++) for (let a = 0; a < K; a++) kids.push(n.levels[2].at(px * K + a, py * K + b)!);
    const parentCol = n.levels[1].at(px, py)!;
    const soilOf = (c: Col) => c.mat.reduce((s, m, i) => s + (i > 0 && m === MAT.soil ? c.z1[i] - c.z0[i] : 0), 0);
    const airOf = (c: Col) => c.mat.reduce((s, _m, i) => s + (i > 0 ? c.z0[i] - c.z1[i - 1] : 0), 0);
    const z0 = n.levels[2].f.z0;
    expect(new Set(kids.map((c) => c.mat.length)).size).toBeGreaterThan(1);
    const kidS = kids.reduce((s, c) => s + c.z1[c.z1.length - 1], 0) / K ** 3 + z0;
    expect(Math.abs(kidS - parentCol.z1[parentCol.z1.length - 1])).toBeLessThan(1e-9);
    expect(Math.abs(kids.reduce((s, c) => s + soilOf(c), 0) / K ** 3 - soilOf(parentCol))).toBeLessThan(1e-9);
    expect(Math.abs(kids.reduce((s, c) => s + airOf(c), 0) / K ** 3 - airOf(parentCol))).toBeLessThan(1e-9);
    // demote both, promote both, 20 times: identical
    const s1 = snap(n.levels[1]);
    const s2 = snap(n.levels[2]);
    const f1 = n.levels[1].f;
    const f2 = n.levels[2].f;
    for (let i = 0; i < 20; i++) {
      n.demote(1);
      n.promote(f1);
      n.promote(f2);
    }
    expect(snap(n.levels[1])).toEqual(s1);
    expect(snap(n.levels[2])).toEqual(s2);
  });

  it('add: a blob in mid-air becomes its own interval and survives demote/promote', () => {
    const n = nest();
    const f = withZ0(n, F1);
    n.promote(f);
    const mid = n.levels[1].at(F1.gx + 30, F1.gy + 30)!;
    n.edit(1, 'add', F1.gx + 30.5, F1.gy + 30.5, 4, 0, mid.z1[mid.z1.length - 1] + 10);
    const c = n.levels[1].at(F1.gx + 30, F1.gy + 30)!;
    expect(c.mat.length).toBe(3);
    expect(c.z0[2] - c.z1[1]).toBeGreaterThan(5);
    const a = snap(n.levels[1]);
    n.demote(1);
    n.promote(f);
    expect(snap(n.levels[1])).toEqual(a);
  });

  it('a column with 40 intervals (more than two pages hold) round-trips promote, edit, demote, promote', () => {
    const n = nest();
    const px = F1.gx / K + 4;
    const py = F1.gy / K + 4;
    const s = surf(n.levels[0].at(px, py)!);
    const mat: number[] = [];
    const z0: number[] = [];
    const z1: number[] = [];
    for (let i = 0; i < 40; i++) {
      mat.push(i % 2 ? MAT.clay : MAT.sand);
      z0.push(i ? s - 4 + i * 0.1 : OPEN_BOTTOM);
      z1.push(s - 4 + (i + 1) * 0.1);
    }
    n.setColumn(0, px, py, { mat, z0, z1 });
    const f = withZ0(n, F1);
    n.promote(f);
    n.edit(1, 'dig', px * K + 4, py * K + 4, 5, 6);
    const a = snap(n.levels[1]);
    // (the dig empties the top few: the partition drops them; still more than one column page's 24 records)
    const cnt = a[(py * K + 4 - f.gy) * f.n + (px * K + 4 - f.gx)].mat.length;
    expect(cnt).toBeGreaterThan(24);
    expect(cnt).toBeLessThan(40);
    n.demote(1);
    n.promote(f);
    expect(maxDiff(snap(n.levels[1]), a)).toBe(0);
  });

  it('the camera: a point is at distance 0 exactly inside a drawn box (a column square by a solid interval)', () => {
    // the box draw draws each column's solid intervals over the column's own square, so the camera's distance is to
    // those boxes: 0 inside one, the plain distance outside
    let s = 12345;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
    let bad = 0;
    for (let trial = 0; trial < 400; trial++) {
      const f = rnd() * 3;
      const c = 3.5 + rnd() * 2;
      const t = 5.7 + rnd() * 4;
      const col: Col = { mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, c], z1: [f, t] };
      const p: [number, number, number] = [rnd() * 3 - 1, rnd() * 3 - 1, rnd() * 12 - 1];
      const inSquare = p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;
      const inSolid = p[2] <= f || (p[2] >= c && p[2] <= t);
      if ((colDist(col, 0, 0, p) === 0) !== (inSquare && inSolid)) bad++;
    }
    expect(bad).toBe(0);
    const one: Col = { mat: [MAT.stone], z0: [OPEN_BOTTOM], z1: [2] };
    expect(colDist(one, 0, 0, [3.5, 0.5, 2])).toBeCloseTo(2.5, 12);
    expect(colDist(one, 0, 0, [0.5, 0.5, 5])).toBeCloseTo(3, 12);
  });

  it('the partition: shared boundaries, air included, merged neighbours; repeated adds do not pile up (NS-63)', () => {
    // a solid view with a touching pair of one material, an empty interval and a gap: one record each, air between
    const c: Col = { mat: [MAT.stone, MAT.soil, MAT.soil, MAT.clay, MAT.soil], z0: [OPEN_BOTTOM, 1, 2, 2.5, 4], z1: [1, 2, 2.5, 2.5, 5] };
    const p = toPart(c);
    expect(p).toEqual({ top: [1, 2.5, 4, 5], mat: [MAT.stone, MAT.soil, AIR, MAT.soil] });
    expect(fromPart(p)).toEqual({ mat: [MAT.stone, MAT.soil, MAT.soil], z0: [OPEN_BOTTOM, 1, 4], z1: [1, 2.5, 5] });
    // adds over one column, each overlapping the last: one soil record above the stone, however many
    const n = nest();
    const x = F1.gx / K + 6;
    const y = F1.gy / K + 6;
    const s0 = surf(n.levels[0].at(x, y)!);
    for (let i = 0; i < 12; i++) n.edit(0, 'add', x + 0.5, y + 0.5, 1.5, 0, s0 + 0.5 + i * 0.4);
    const part = n.levels[0].parts[(y - n.levels[0].f.gy) * n.levels[0].f.n + (x - n.levels[0].f.gx)];
    expect(part.mat).toEqual([MAT.stone, MAT.soil]);
    // a carve then leaves air over its span: a tunnel is an air record between two solid ones
    n.edit(0, 'carve', x + 0.5, y + 0.5, 0.6, 0, s0 - 1);
    const q = n.levels[0].parts[(y - n.levels[0].f.gy) * n.levels[0].f.n + (x - n.levels[0].f.gx)];
    expect(q.mat.includes(AIR)).toBe(true);
    for (let j = 1; j < q.mat.length; j++) {
      expect(q.mat[j]).not.toBe(q.mat[j - 1]);
      expect(q.top[j]).toBeGreaterThan(q.top[j - 1]);
    }
  });

  it('enhance (PPM): block means exact, no overshoot at a step, smooth hilltops kept (NS-34)', () => {
    // a step of height 10 along x, a few cells wide in y: every child within the step's range, every block mean exact
    const step = (x: number, y: number) => (x >= 0 && Math.abs(y) < 3 ? 10 : 0);
    for (let py = -4; py <= 4; py++)
      for (let px = -3; px <= 3; px++) {
        let sum = 0;
        for (let b = 0; b < K; b++)
          for (let a = 0; a < K; a++) {
            const v = step(px, py) + ppm2(step, px, py, a, b, K);
            expect(v).toBeGreaterThanOrEqual(-1e-9);
            expect(v).toBeLessThanOrEqual(10 + 1e-9);
            sum += v;
          }
        expect(sum / (K * K)).toBeCloseTo(step(px, py), 9);
      }
    // random cell averages: the K sub-averages of every cell sum to K times the cell
    let r = 12345;
    const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648) * 20 - 10;
    for (let t = 0; t < 200; t++) {
      const q = [rnd(), rnd(), rnd(), rnd(), rnd()];
      let s = 0;
      for (let a = 0; a < K; a++) s += ppmSub(q, a, K);
      expect(s / K).toBeCloseTo(q[2], 9);
    }
    // a smooth hilltop (cell averages of -x^2): the peak cell is not flattened, and stays under its curvature's bound
    const hill = [-4, -1, 0, -1, -4].map((v) => v - 1 / 12);
    const sub = Array.from({ length: K }, (_, a) => ppmSub(hill, a, K));
    expect(Math.max(...sub) - Math.min(...sub)).toBeGreaterThan(0.1);
    expect(Math.max(...sub)).toBeLessThan(0.01);
    // the oracle's promote with no detail: a root with a cliff gives no child surface above or below the cliff's range
    const n = nest();
    n.detailAmp = 0;
    const root = n.levels[0];
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) root.set(x, y, { mat: [MAT.stone], z0: [OPEN_BOTTOM], z1: [x >= 24 ? 20 : 4] });
    const ch = n.promote({ ...F1, z0: 0 });
    for (const c of ch.cols) {
      const s = c.z1[c.z1.length - 1] / K;
      expect(s).toBeGreaterThanOrEqual(4 - 1e-6);
      expect(s).toBeLessThanOrEqual(20 + 1e-6);
    }
  });
});
