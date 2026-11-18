// Nested scales lab (docs/design/NESTED_SCALES.md): the oracle's invariants. The page self-test (?selftest=1) runs the
// same invariants on the GPU passes and compares them with this oracle.
import { describe, expect, it } from 'vitest';
import { E_FAR, MAT, Nest, OPEN_BOTTOM, RING, colDist, egOf, esOf, makeRoot, ppm2, ppmSub, present, q16, toLayers, type Col, type Frame, type Level } from '../../src/nested/oracle';

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
const snap = (lv: Level) => lv.cols.map((c) => ({ mat: c.mat.slice(), z0: c.z0.slice(), z1: c.z1.slice(), eS: c.mat.map((_m, i) => esOf(c, i)), eG: c.mat.map((_m, i) => egOf(c, i)) }));
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
    // (footprints: a ghost interval is air, a ghost gap solid)
    const solid = (c: Col, ref: number) => c.mat.reduce((s, _m, i) => s + (i === 0 || present(esOf(c, i)) ? c.z1[i] - Math.max(c.z0[i], ref) : 0) + (i > 0 && !present(egOf(c, i)) ? c.z0[i] - c.z1[i - 1] : 0), 0);
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
      // (its air: the present gaps and the ghost intervals between them)
      expect(t.mat.reduce((s, _m, i) => s + (i ? (present(egOf(t, i)) ? t.z0[i] - t.z1[i - 1] : 0) + (present(esOf(t, i)) ? 0 : t.z1[i] - t.z0[i]) : 0), 0)).toBeGreaterThan(4);
    }
    // restrict over a mixed block: the parent holds the block's mean surface, soil and enclosed air
    const px = (F2.gx + 32) / K;
    const py = (F2.gy + 32) / K;
    const kids: Col[] = [];
    for (let b = 0; b < K; b++) for (let a = 0; a < K; a++) kids.push(n.levels[2].at(px * K + a, py * K + b)!);
    const parentCol = n.levels[1].at(px, py)!;
    // (footprints: a ghost interval's thickness is air, a ghost gap's is solid of the interval above it)
    const soilOf = (c: Col) => c.mat.reduce((s, m, i) => s + (i > 0 && m === MAT.soil ? (present(esOf(c, i)) ? c.z1[i] - c.z0[i] : 0) + (present(egOf(c, i)) ? 0 : c.z0[i] - c.z1[i - 1]) : 0), 0);
    const airOf = (c: Col) => c.mat.reduce((s, _m, i) => s + (i > 0 ? (present(egOf(c, i)) ? c.z0[i] - c.z1[i - 1] : 0) + (present(esOf(c, i)) ? 0 : c.z1[i] - c.z0[i]) : 0), 0);
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
    expect(a[(py * K + 4 - f.gy) * f.n + (px * K + 4 - f.gx)].mat.length).toBe(40);
    n.demote(1);
    n.promote(f);
    expect(maxDiff(snap(n.levels[1]), a)).toBe(0);
  });

  it('the camera: drawn solid (the sheets between column centres) lies inside the dilated column boxes', () => {
    // a quad of four columns, each ground (open below) up to a floor f, air, a roof from c to the top t; the draw
    // interpolates f, c and t over the quad's two triangles (diagonal (0,0)-(1,1)); any point under the drawn floor, or
    // between the drawn ceiling and the drawn top, must be at distance 0 from some corner's dilated column. This holds
    // where the four corners' parts of one layer overlap in z (their union is then one interval); a layer that steps
    // by more than its thickness between neighbouring columns can leave a sliver of drawn roof outside (BACKLOG NS-24).
    let s = 12345;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
    let bad = 0;
    for (let trial = 0; trial < 400; trial++) {
      const cols: Col[] = [];
      const fz: number[] = [];
      const cz: number[] = [];
      const tz: number[] = [];
      for (let q = 0; q < 4; q++) {
        const f = rnd() * 3;
        const c = 3.5 + rnd() * 2;
        const t = 5.7 + rnd() * 4;
        fz.push(f);
        cz.push(c);
        tz.push(t);
        cols.push({ mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, c], z1: [f, t] });
      }
      const at = (v: number[], u: number, w: number) => (u >= w ? (1 - u) * v[0] + (u - w) * v[1] + w * v[3] : (1 - w) * v[0] + (w - u) * v[2] + u * v[3]);
      for (let i = 0; i < 20; i++) {
        const u = rnd();
        const w = rnd();
        const zs = [at(fz, u, w) - 1e-9 - rnd() * 2, at(cz, u, w) + (at(tz, u, w) - at(cz, u, w)) * rnd()];
        for (const z of zs) {
          const d = Math.min(...cols.map((c, q) => colDist(c, q & 1, q >> 1, [0.5 + u, 0.5 + w, z])));
          if (d > 0) bad++;
        }
      }
    }
    expect(bad).toBe(0);
    // a point in the air beside or above a single column: its plain distance less the dilation
    const one: Col = { mat: [MAT.stone], z0: [OPEN_BOTTOM], z1: [2] };
    expect(colDist(one, 0, 0, [3.5, 0.5, 2])).toBeCloseTo(2, 12);
    expect(colDist(one, 0, 0, [0.5, 0.5, 5])).toBeCloseTo(3, 12);
  });

  it('footprints: a tunnel ball and a mid-air blob write e and a ring of ghosts; the structure is constant across every edge that has a present column; promote, demote, promote bit-identical with e', () => {
    const n = nest();
    const f = withZ0(n, F1);
    n.promote(f);
    const lv = n.levels[1];
    const mid = lv.at(F1.gx + 32, F1.gy + 32)!;
    const cz = mid.z1[mid.z1.length - 1] - 6;
    const cx = F1.gx + 32.3;
    const cy = F1.gy + 31.8;
    const r = 4.2;
    const centre = lv.at(F1.gx + 32, F1.gy + 32)!;
    const before = centre.mat.length;
    // the interval holding the centre splits: the new gap is the one above it
    const gi = centre.mat.findIndex((_m, i) => (i === 0 || centre.z0[i] <= cz) && cz <= centre.z1[i]) + 1;
    n.edit(1, 'carve', cx, cy, r, 0, cz);
    // inside: a new gap, present, its footprint r - d; the ring: a zero-thickness ghost gap at the same index
    for (let y = F1.gy + 24; y < F1.gy + 40; y++)
      for (let x = F1.gx + 24; x < F1.gx + 40; x++) {
        const c = lv.at(x, y)!;
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < r + RING - 1e-9) {
          expect(c.mat.length).toBe(before + 1);
          const g = egOf(c, gi);
          expect(Math.abs(g - (r - d))).toBeLessThan(0.01);
          if (d >= r) expect(c.z0[gi] - c.z1[gi - 1]).toBe(0);
          else expect(c.z0[gi] - c.z1[gi - 1]).toBeGreaterThan(0);
        } else expect(c.mat.length).toBe(before);
      }
    // every edge (8 neighbours) from a column with a present tunnel gap reaches a column of the same interval count
    const rim = (lvl: Level, has: (c: Col) => boolean) => {
      let bad = 0;
      for (let y = lvl.f.gy + 1; y < lvl.f.gy + lvl.f.n - 1; y++)
        for (let x = lvl.f.gx + 1; x < lvl.f.gx + lvl.f.n - 1; x++) {
          const c = lvl.at(x, y)!;
          if (!has(c)) continue;
          for (let j = -1; j <= 1; j++)
            for (let i = -1; i <= 1; i++)
              if (lvl.at(x + i, y + j)!.mat.length !== c.mat.length) {
                if (bad < 2) console.log('rim', x - lvl.f.gx, y - lvl.f.gy, JSON.stringify(c), JSON.stringify(lvl.at(x + i, y + j)));
                bad++;
              }
        }
      return bad;
    };
    // a column with something a brush made present and the draw must cut: an air gap, or a solid it laid in the air
    // (not a ring ghost, nor a solid piece a carve trimmed)
    const anyPresentExtra = (c: Col) =>
      c.mat.some((_m, i) => i >= 1 && ((present(egOf(c, i)) && egOf(c, i) < E_FAR && c.z0[i] - c.z1[i - 1] >= 0.25) || (present(esOf(c, i)) && esOf(c, i) < E_FAR && c.z0[i] - c.z1[i - 1] >= 0.25 && c.mat[i] === MAT.soil && i === c.mat.length - 1)));
    expect(rim(lv, anyPresentExtra)).toBe(0);
    // a row of balls (a tunnel, as a stroke lays it) reuses the first gap: still one structure across every edge
    for (let i = 1; i < 7; i++) n.edit(1, 'carve', cx + i * 3.1, cy + i * 0.4, r, 0, cz + i * 0.3);
    expect(rim(lv, anyPresentExtra)).toBe(0);
    expect(lv.at(F1.gx + 45, F1.gy + 34)!.mat.length).toBe(before + 1);
    // a blob in mid-air: a new interval (present inside, a zero-thickness ghost in the ring), the same rule
    const under = lv.at(F1.gx + 20, F1.gy + 44)!;
    const bz = under.z1[under.z1.length - 1] + 12;
    n.edit(1, 'add', F1.gx + 20.5, F1.gy + 44.5, 3, 0, bz);
    const b = lv.at(F1.gx + 20, F1.gy + 44)!;
    expect(present(esOf(b, b.mat.length - 1))).toBe(true);
    expect(b.z0[b.mat.length - 1] - b.z1[b.mat.length - 2]).toBeGreaterThan(5);
    const ringCol = lv.at(F1.gx + 24, F1.gy + 44)!;
    expect(ringCol.mat.length).toBe(b.mat.length);
    expect(present(esOf(ringCol, ringCol.mat.length - 1))).toBe(false);
    expect(rim(lv, anyPresentExtra)).toBe(0);
    // promote, demote, promote: identical, footprints included; and with a child below it, the child's ring holds too
    n.promote(withZ0(n, F2));
    const s1 = snap(n.levels[1]);
    const s2 = snap(n.levels[2]);
    expect(rim(n.levels[2], anyPresentExtra)).toBe(0);
    const f2 = n.levels[2].f;
    for (let i = 0; i < 3; i++) {
      n.demote(1);
      n.promote(f);
      n.promote(f2);
    }
    expect(snap(n.levels[1])).toEqual(s1);
    expect(snap(n.levels[2])).toEqual(s2);
  });

  it('footprints: a contour crossing a block — enhance places the children\'s contour between the parents, restrict keeps its sign and place', () => {
    const n = nest();
    n.detailAmp = 0;
    const root = n.levels[0];
    // a tunnel layer everywhere (stone, soil, gap, soil); its gap present for x < 22.6 (eG = 22.6 - (x + 0.5)), ghost past
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 48; x++)
        root.set(x, y, { mat: [MAT.stone, MAT.soil, MAT.soil], z0: [OPEN_BOTTOM, 6, 8], z1: [5, 6, 10], eS: [E_FAR, E_FAR, E_FAR], eG: [E_FAR, E_FAR, q16(22.6 - (x + 0.5))] });
    const ch = n.promote({ depth: 1, gx: 128, gy: 128, n: 64, z0: 0 });
    // children of parent columns 16..23: the contour at parent x 22.6 is child x 180.8
    let lastIn = -1;
    for (let x = ch.f.gx; x < ch.f.gx + ch.f.n; x++) if (present(egOf(ch.at(x, ch.f.gy + 20)!, 2))) lastIn = x;
    expect(Math.abs(lastIn + 0.5 - 22.6 * K)).toBeLessThan(1);
    // restrict straight back (an edit with no change: raise by 0): the parent's contour stays within a column of 22.6
    n.edit(1, 'raise', ch.f.gx + 52.5, ch.f.gy + 20.5, 30, 0);
    let pIn = -1;
    for (let x = 16; x < 24; x++) if (present(egOf(root.at(x, 18)!, 2))) pIn = x;
    expect(pIn).toBeGreaterThanOrEqual(21);
    expect(pIn).toBeLessThanOrEqual(22);
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
