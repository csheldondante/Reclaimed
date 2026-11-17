import { describe, expect, it } from 'vitest';
import { lidZ, unionRoofs, upTris, worstInside, type RoofSolidIn } from './roofunion';
import { roofCases } from './roofcases';

const ROOF = 3;

/** sampled over the plan: the highest kept top is the highest original top (no hole in the union's top, nothing
 *  higher), and no two kept tops coincide (no doubled surface left to z-fight) */
function topCheck(roofs: RoofSolidIn[], out: number[]) {
  const kept = upTris(out, ROOF);
  const orig = roofs.map((r) => upTris(r.verts, ROOF));
  let lx = Infinity;
  let ly = Infinity;
  let hx = -Infinity;
  let hy = -Infinity;
  for (const L of orig) for (const t of L) for (const p of t) {
    lx = Math.min(lx, p[0]);
    ly = Math.min(ly, p[1]);
    hx = Math.max(hx, p[0]);
    hy = Math.max(hy, p[1]);
  }
  let doubled = 0;
  let worstTop = 0;
  let n = 0;
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  for (let s = 0; s < 4000; s++) {
    const x = lx + (hx - lx) * rnd();
    const y = ly + (hy - ly) * rnd();
    let top = -Infinity;
    for (const L of orig) for (const [a, b, c] of L) {
      const z = lidZ(a, b, c, x, y, -1e-6);
      if (z !== null) top = Math.max(top, z);
    }
    if (top === -Infinity) continue;
    // (the top: kept pieces that hold the point, edges included — the clipping makes slivers; doubled: two pieces that
    // hold it strictly at the same height)
    const loose: number[] = [];
    const strict: number[] = [];
    for (const [a, b, c] of kept) {
      const z = lidZ(a, b, c, x, y, -1e-6);
      if (z !== null) loose.push(z);
      const z2 = lidZ(a, b, c, x, y);
      if (z2 !== null) strict.push(z2);
    }
    n++;
    strict.sort((a, b) => b - a);
    if (strict.length > 1 && strict[0] - strict[1] < 1e-3) doubled++;
    const got = loose.length ? Math.max(...loose) : -Infinity;
    worstTop = Math.max(worstTop, Math.abs(got - top));
  }
  return { samples: n, doubled, worstTop };
}

const CASES: [string, RoofSolidIn[]][] = roofCases();

describe('roof union', () => {
  for (const [name, roofs] of CASES) {
    it(`${name}: nothing left inside another roof's solid, the top intact, no doubled surface`, () => {
      const out: number[] = [];
      const st = unionRoofs(roofs, out);
      const inside = worstInside(roofs, out, st.ranges);
      const top = topCheck(roofs, out);
      console.log(name, JSON.stringify({ trisIn: st.trisIn, trisOut: st.trisOut, clipped: st.clipped, inside: +inside.toFixed(6), ...top }));
      expect(st.clipped).toBeGreaterThan(0);
      expect(inside).toBeLessThanOrEqual(1e-3);
      expect(top.doubled).toBe(0);
      expect(top.worstTop).toBeLessThan(1e-3);
    });
  }
  it('without the union the same roofs interpenetrate (the checks can fail)', () => {
    for (const [, roofs] of CASES.slice(0, 2)) {
      const out: number[] = [];
      const ranges: [number, number][] = [];
      for (const r of roofs) {
        ranges.push([out.length, out.length + r.verts.length]);
        out.push(...r.verts);
      }
      expect(worstInside(roofs, out, ranges)).toBeGreaterThan(0.05);
    }
  });
});
