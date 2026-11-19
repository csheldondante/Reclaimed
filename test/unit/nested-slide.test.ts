// Nested scales lab, round 22 (docs/design/NESTED_SCALES.md "As built (round 22)"): the edge sample and the slide, in
// the reference (src/nested/edge.ts, oracle.ts brushes / enhance / restrict / residual, boxmesh.ts sheetMesh). A carve's
// rim vertices lie on the true circle; no sheet triangle folds over random carve and add sequences; closure unchanged;
// a level edge slides nothing; the edge survives demote and promote.
import { describe, expect, it } from 'vitest';
import { EDGE_RANGE, SLIDE_MAX, edgeDec, edgeEnc, edgeFromChildren, edgeToChild, slideOf } from '../../src/nested/edge';
import { Level, MAT, Nest, OPEN_BOTTOM, edgeAt, makeRoot, type Frame } from '../../src/nested/oracle';
import { sheetClosure, sheetMesh, type MeshScene } from '../../src/nested/boxmesh';

const K = 4;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
/** a flat root: stone under soil, top at `top` */
function flatRoot(n: number, top: number): Level {
  const lv = new Level({ depth: 0, gx: 0, gy: 0, n, z0: 0 });
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) lv.set(x, y, { mat: [MAT.stone, MAT.soil], z0: [OPEN_BOTTOM, top - 1], z1: [top - 1, top] });
  return lv;
}
const sceneOf = (n: Nest, rimTop = false): MeshScene => ({
  k: n.k,
  rimTop,
  // (heights as f32, as the GPU stores them: the reference's level-edge arithmetic is f32)
  levels: n.levels.map((lv) => ({ depth: lv.f.depth, gx: lv.f.gx, gy: lv.f.gy, n: lv.f.n, zo: lv.f.z0, parts: lv.parts.map((p) => ({ ...p, top: p.top.map(Math.fround) })) })),
});
/** every sheet triangle's horizontal orientation against its unslid one (the slide never folds a triangle) */
function folds(n: Nest, rimTop = false): { tris: number; folded: number; slid: number } {
  const sc = sceneOf(n, rimTop);
  const m = sheetMesh(sc);
  let folded = 0;
  let slid = 0;
  for (const l of m.lines.values()) for (const c of l.clusters) if (c.ox || c.oy) slid++;
  const flat = (key: string) => {
    const [L, cx, cy] = key.split(':').map(Number);
    const s = n.k ** L;
    return [cx / s, cy / s];
  };
  for (const t of m.tris) {
    const p = t.v.map((v) => m.pos.get(v)!);
    const q = t.v.map(flat);
    const a1 = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    const a0 = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
    const bad = (a0 !== 0 && a1 * a0 <= 0) || (a0 === 0 && Math.abs(a1) > 1e-9);
    if (bad) {
      folded++;
      if (process.env.SLIDE_DEBUG) console.log(`fold L${t.L} ${t.X},${t.Y} j${t.j} fan ${t.fan} a0 ${a0} a1 ${a1.toFixed(4)} ${t.v.join(' ')} ${p.map((v) => v.map((x) => x.toFixed(3)).join(',')).join(' | ')}`);
    }
  }
  return { tris: m.tris.length, folded, slid };
}

describe('nested scales round 22: the edge sample and the slide', () => {
  it('the field: round trip within a quantisation step; none past the range; enhance and restrict carry a straight line', () => {
    const r = rng(3);
    for (let i = 0; i < 500; i++) {
      const a = r() * 2 * Math.PI;
      const d = (r() * 2 - 1) * EDGE_RANGE * 0.999;
      const s = edgeDec(edgeEnc(Math.cos(a), Math.sin(a), d))!;
      expect(Math.abs(s.d - d)).toBeLessThanOrEqual(0.5 / 1024 + 1e-12);
      expect(Math.abs(Math.atan2(s.ny * Math.cos(a) - s.nx * Math.sin(a), s.nx * Math.cos(a) + s.ny * Math.sin(a)))).toBeLessThanOrEqual(Math.PI / 512 + 1e-9);
    }
    expect(edgeEnc(1, 0, 2.5)).toBe(0);
    // a straight line through a parent column: each child's line is the same line (restrict(enhance) gives it back)
    const nx = Math.cos(0.7);
    const ny = Math.sin(0.7);
    const e = edgeEnc(nx, ny, 0.1);
    const es: number[] = [];
    const offs: [number, number][] = [];
    for (let b = 0; b < K; b++)
      for (let a = 0; a < K; a++) {
        const o: [number, number] = [(a + 0.5) / K - 0.5, (b + 0.5) / K - 0.5];
        const c = edgeToChild(e, o[0], o[1], K);
        offs.push(o);
        es.push(c);
        const want = (0.1 - (nx * o[0] + ny * o[1])) * K;
        if (Math.abs(want) <= EDGE_RANGE * 0.99) expect(Math.abs(edgeDec(c)!.d - want)).toBeLessThan(0.02);
        else if (Math.abs(want) > EDGE_RANGE * 1.01) expect(c).toBe(0);
      }
    const back = edgeDec(edgeFromChildren(es, offs, K))!;
    expect(Math.abs(back.d - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(back.nx - nx) + Math.abs(back.ny - ny)).toBeLessThan(0.02);
  });

  it('the slide: a straight edge puts the corner on the line; no crossing, no slide; bounded by the disc', () => {
    // a line x = 0.2 (normal +x out of the brush, the brush on the -x side): columns at x -0.5 inside (d = 0.7), +0.5 outside
    const smp = [0, 1, 2, 3].map((q) => {
      const cx = -0.5 + (q & 1);
      const cy = -0.5 + (q >> 1);
      return { e: edgeEnc(1, 0, 0.2 - cx), cx, cy };
    });
    const s = slideOf(smp);
    expect(s.crossed).toBe(true);
    expect(Math.abs(s.x - 0.2)).toBeLessThan(0.01);
    expect(Math.abs(s.y)).toBeLessThan(1e-9);
    expect(slideOf(smp.filter((q) => q.cx > 0)).crossed).toBe(false);
    const far = slideOf([0, 1, 2, 3].map((q) => ({ e: edgeEnc(1, 0, 0.9 - (-0.5 + (q & 1))), cx: -0.5 + (q & 1), cy: -0.5 + (q >> 1) })));
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(SLIDE_MAX + 1e-12);
  });

  for (const rimTop of [false, true])
    it(`a sphere carve's rim vertices lie on the true circle (rimtop ${rimTop ? 1 : 0})`, () => {
      const top = 10;
      const n = new Nest(flatRoot(40, top), K, 7);
      const cx = 20.3;
      const cy = 19.6;
      const r = 7.2;
      const cz = top + 0.8;
      n.edit(0, 'carve', cx, cy, r, 0, cz);
      const R = Math.sqrt(r * r - (top - cz) ** 2);
      const m = sheetMesh(sceneOf(n, rimTop));
      let rim = 0;
      let worst = 0;
      let unslid = 0;
      let raw = 0;
      let rawBefore = 0;
      for (const l of m.lines.values()) {
        if (l.L !== 0) continue;
        // a rim corner: its four columns on both sides of the circle (by their centres)
        const ins = [0, 1, 2, 3].map((q) => Math.hypot(l.cx - 0.5 + (q & 1) - cx, l.cy - 0.5 + (q >> 1) - cy) < R);
        if (ins.every((v) => v) || ins.every((v) => !v)) continue;
        // the cluster at the top (the uncarved surface's height) is the rim's
        const c = l.clusters[l.clusters.length - 1];
        rim++;
        if (!c.ox && !c.oy) {
          unslid++;
          continue;
        }
        const dist = Math.hypot(l.cx + c.ox - cx, l.cy + c.oy - cy);
        const before = Math.abs(Math.hypot(l.cx - cx, l.cy - cy) - R);
        // (a corner farther than the disc from the circle stops at the disc)
        const err = Math.abs(dist - R) - Math.max(0, before - SLIDE_MAX);
        worst = Math.max(worst, err);
        raw = Math.max(raw, Math.abs(dist - R));
        rawBefore = Math.max(rawBefore, before);
        if (rimTop) expect(c.z, 'rimtop: the rim corner at the uncarved height').toBeCloseTo(top, 2);
      }
      console.log(`[slide] carve r ${r}: ${rim} rim corners, ${unslid} unslid, worst distance from the circle past the disc's reach ${worst.toFixed(4)} columns; farthest rim vertex from the circle ${raw.toFixed(3)} (unslid corners ${rawBefore.toFixed(3)})`);
      expect(rim).toBeGreaterThan(30);
      expect(unslid).toBe(0);
      expect(worst).toBeLessThan(0.05);
      const cl = sheetClosure(m);
      expect(cl.openInterior).toBe(0);
      expect(cl.coincident).toBe(0);
    });

  it('no triangle folds and closure holds over random carve and add sequences, two levels; level edges slide nothing', () => {
    const r = rng(17);
    for (let run = 0; run < 6; run++) {
      const n = new Nest(makeRoot(32, 5 + run), K, 5 + run);
      const f: Frame = { depth: 1, gx: 32, gy: 32, n: 48, z0: 0 };
      const p = n.levels[0].at((f.gx + f.n / 2) / K, (f.gy + f.n / 2) / K)!;
      n.promote({ ...f, z0: Math.round(p.z1[p.z1.length - 1]) });
      for (let i = 0; i < 8; i++) {
        const d = r() < 0.6 ? 1 : 0;
        const lv = n.levels[d];
        const x = lv.f.gx + 4 + r() * (lv.f.n - 8);
        const y = lv.f.gy + 4 + r() * (lv.f.n - 8);
        const c = lv.at(Math.floor(x), Math.floor(y))!;
        const s = c.z1[c.z1.length - 1];
        const rad = d ? 2 + r() * 8 : 1 + r() * 3;
        n.edit(d, r() < 0.7 ? 'carve' : 'add', x, y, rad, 0, s + (r() - 0.5) * rad);
      }
      for (const rimTop of [false, true]) {
        const fo = folds(n, rimTop);
        expect(fo.slid, `run ${run}: something slid`).toBeGreaterThan(0);
        expect(fo.folded, `run ${run} rimtop ${rimTop}: folded triangles`).toBe(0);
      }
      const m = sheetMesh(sceneOf(n));
      const cl = sheetClosure(m);
      // closure is by vertex identity, which the slide does not touch: the same as with every edge sample removed. (The
      // oracle's f64 chain read as f32 can leave a few open edges at a level edge's corner, slide or not: run 1 has 4
      // at a window corner; the hand-made scenes of nested-boxmesh.test.ts and the GPU's own columns close exactly.)
      const bare = sceneOf(n);
      bare.levels = bare.levels.map((l) => ({ ...l, parts: l.parts.map((p) => ({ top: p.top, mat: p.mat })) }));
      const c0 = sheetClosure(sheetMesh(bare));
      expect({ ...cl, where: [] }, `run ${run}`).toEqual({ ...c0, where: [] });
      expect(cl.openInterior - cl.openLevelEdge, `run ${run}: open inside a level (${cl.where.join('; ')})`).toBe(0);
      expect(cl.repeated).toBe(0);
      expect(cl.coincident).toBe(0);
      for (const l of m.lines.values()) if (l.levelEdge || l.rootEdge) for (const c of l.clusters) expect(c.ox === 0 && c.oy === 0, `run ${run}: a level or root edge line slid`).toBe(true);
    }
  });

  it('the edge survives demote and promote (the residual keeps it) and reaches the parent (restrict)', () => {
    const n = new Nest(makeRoot(32, 9), K, 9);
    const f: Frame = { depth: 1, gx: 32, gy: 32, n: 48, z0: 0 };
    const p = n.levels[0].at((f.gx + f.n / 2) / K, (f.gy + f.n / 2) / K)!;
    n.promote({ ...f, z0: Math.round(p.z1[p.z1.length - 1]) });
    const lv = n.levels[1];
    const c = lv.at(56, 56)!;
    n.edit(1, 'carve', 56.2, 55.7, 6, 0, c.z1[c.z1.length - 1] + 1);
    const edges = (L: number) => n.levels[L].cols.map((cc) => cc.mat.map((_m, i) => edgeAt(cc, i)).join(','));
    const a = edges(1);
    expect(a.filter((s) => /[1-9]/.test(s)).length).toBeGreaterThan(20);
    const fr = n.levels[1].f;
    n.demote(1);
    n.promote(fr);
    expect(edges(1)).toEqual(a);
    expect(edges(0).filter((s) => /[1-9]/.test(s)).length).toBeGreaterThan(0);
  });
});
