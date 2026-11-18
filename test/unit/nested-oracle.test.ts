// Nested scales lab (docs/design/NESTED_SCALES.md): the oracle's invariants. The page self-test (?selftest=1) runs the
// same invariants on the GPU passes and compares them with this oracle.
import { describe, expect, it } from 'vitest';
import { MAT, Nest, OPEN_BOTTOM, makeRoot, toLayers, type Col, type Frame, type Level } from '../../src/nested/oracle';

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
    expect(a[(py * K + 4 - f.gy) * f.n + (px * K + 4 - f.gx)].mat.length).toBe(40);
    n.demote(1);
    n.promote(f);
    expect(maxDiff(snap(n.levels[1]), a)).toBe(0);
  });
});
