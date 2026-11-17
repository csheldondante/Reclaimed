// Terrain rivers, step 2 (docs/design/TERRAIN_RIVERS.md §9): the pure parts — the valley's bound, the smooth minimum,
// the head's floor, the spring's width — and the reason for the two-scale field: the envelope of G-independent valley
// surfaces sampled on a lattice and interpolated is continuous across a medial axis and across texel lines, where
// carrying the nearest river's level jumps. (The GPU's field is valleyjfa.wgsl / valley.wgsl; this is its rule in TS.)
import { describe, expect, it } from 'vitest';
import { HEAD, NO_HEAD, VALLEY, headLevel, phi, riverWidth, smin, vprof, walkRivers, type WalkInput } from './walks';

/** a straight river along y = y0 at level L, half-width w: its valley surface S at (x, y) for a tier (§9.2) */
const surf = (y: number, y0: number, L: number, w: number, tier: number) => {
  const e = Math.max(Math.abs(y - y0) - w, 0);
  return L + vprof(e, w, tier) + phi(e, tier);
};

describe('valley field (step 2)', () => {
  it('phi is zero inside half the reach, then rises — steeper, but a texel can hold it (≤ 7 cells a cell to 300 out)', () => {
    for (let t = 0; t < 4; t++) {
      const vw = VALLEY.VW[t];
      expect(phi(0, t)).toBe(0);
      expect(phi(vw * 0.5, t)).toBe(0);
      expect(phi(vw * 0.5 + 300, t)).toBeGreaterThan(1000);
      let prev = 0;
      for (let e = 0; e < vw * 0.5 + 300; e += 1) {
        expect(phi(e, t)).toBeGreaterThanOrEqual(prev);
        if (e > 0) expect(phi(e, t) - prev).toBeLessThanOrEqual(7);
        prev = phi(e, t);
      }
    }
  });

  it('smin never exceeds min, equals it once the two are k apart, and is continuous', () => {
    const k = VALLEY.SMIN_K;
    for (let a = -10; a <= 10; a += 0.25) {
      expect(smin(a, 0, k)).toBeLessThanOrEqual(Math.min(a, 0) + 1e-12);
      if (Math.abs(a) >= k) expect(smin(a, 0, k)).toBe(Math.min(a, 0));
      expect(Math.abs(smin(a + 0.01, 0, k) - smin(a, 0, k))).toBeLessThanOrEqual(0.0101);
    }
    expect(smin(0, 0, k)).toBeCloseTo(-k / 4, 12);
  });

  it("a head's floor stays near the spring, then climbs to the land", () => {
    const ls = 100;
    const lh = 140;
    expect(headLevel(ls, lh, 0)).toBe(ls);
    expect(headLevel(ls, lh, 1)).toBe(lh);
    expect(headLevel(ls, lh, 0.4) - ls).toBeLessThan(0.15 * (lh - ls));
    let prev = ls;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(headLevel(ls, lh, t)).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = headLevel(ls, lh, t);
    }
  });

  it('a spring widens fast then slowly (concave), from 1.2, never past 12', () => {
    expect(riverWidth(0, 0)).toBeCloseTo(1.2, 9);
    const acc = 400;
    const full = riverWidth(acc, 16);
    // (concave: half the hops gives well over half the growth — not step 1's straight taper)
    expect(riverWidth(acc, 4) - 1.2).toBeGreaterThan(0.45 * (full - 1.2));
    for (let h = 0; h < 30; h++) expect(riverWidth(acc, h + 1)).toBeGreaterThanOrEqual(riverWidth(acc, h));
    expect(riverWidth(1e9, 100)).toBe(12);
  });

  it('the envelope sampled on texels and interpolated is continuous across the medial axis; a carried level jumps', () => {
    // two rivers 120 cells apart, 30 cells different in level; texels 8 cells; a line across both at fine steps
    const yA = 0;
    const yB = 120;
    const LA = 50;
    const LB = 80;
    const tier = 1;
    const E = (y: number) => Math.min(surf(y, yA, LA, 3, tier), surf(y, yB, LB, 3, tier));
    const T = 8;
    const lerp = (f: (y: number) => number, y: number) => {
      const t = y / T - 0.5;
      const i = Math.floor(t);
      const fr = t - i;
      return f((i + 0.5) * T) * (1 - fr) + f((i + 1.5) * T) * fr;
    };
    // (the step-1-like alternative: carry the nearest river's level and its distance, rebuild the profile per cell)
    const nearest = (y: number) => (Math.abs(y - yA) < Math.abs(y - yB) ? { L: LA, y0: yA } : { L: LB, y0: yB });
    const carried = (y: number) => {
      const t = y / T - 0.5;
      const i = Math.floor(t);
      const fr = t - i;
      const n0 = nearest((i + 0.5) * T);
      const n1 = nearest((i + 1.5) * T);
      const L = n0.L * (1 - fr) + n1.L * fr;
      return surf(y, fr < 0.5 ? n0.y0 : n1.y0, L, 3, tier);
    };
    let maxStep = 0;
    let maxCarried = 0;
    const dy = 0.05;
    for (let y = 4; y < 116; y += dy) {
      maxStep = Math.max(maxStep, Math.abs(lerp(E, y + dy) - lerp(E, y)));
      maxCarried = Math.max(maxCarried, Math.abs(carried(y + dy) - carried(y)));
    }
    // (continuous: a step of dy changes it by at most its steepest slope × dy; the wall's slope stays under ~3)
    expect(maxStep).toBeLessThan(3 * dy);
    expect(maxCarried).toBeGreaterThan(1);
    // and the interpolated envelope never comes above the true one by more than a texel of the steepest wall
    for (let y = 4; y < 116; y += 0.5) expect(lerp(E, y) - E(y)).toBeLessThan(VALLEY.SIGMA[tier] * T + 1);
  });
});

describe('heads in the walk (step 2)', () => {
  /** a cone island: sources on its flanks */
  function cone(n: number): WalkInput {
    const N = n * n;
    const G = new Float32Array(N);
    const coast = new Float32Array(N);
    const water = new Uint8Array(N);
    const R = 40;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const r = Math.hypot(x - n / 2, y - n / 2);
        const i = y * n + x;
        coast[i] = (R - r) * 8;
        water[i] = r > R ? 1 : 0;
        G[i] = r > R ? 85 : 92 + (R - r) * 1.5;
      }
    return { n, seed: 5, sea: 90, worldW: n * 8, worldH: n * 8, G, coast, water, spacing: 12 };
  }

  it('every water source has a head over its level by HEAD.MIN at least, and no other node has one', () => {
    const rv = walkRivers(cone(128));
    const f = new Float32Array(rv.nodes.buffer);
    let heads = 0;
    for (let k = 0; k < rv.count; k++) {
      const lava = rv.nodes[k * 8 + 5] & 1;
      const src = rv.up[k] === k && rv.nodes[k * 8 + 4] !== k;
      const still = f[k * 8 + 2] < 90 - 0.35 && rv.nodes[k * 8 + 4] === k;
      if (src && !lava && !still) {
        expect(rv.head[k]).toBeGreaterThanOrEqual(f[k * 8 + 2] + HEAD.MIN - 1e-3);
        heads++;
      } else if (!src) expect(rv.head[k]).toBe(Math.fround(NO_HEAD));
    }
    expect(heads).toBeGreaterThan(3);
  });
});
