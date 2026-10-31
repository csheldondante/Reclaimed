import { describe, expect, it } from 'vitest';
import { fillCpu, markCpu, rimOf } from './flood';

/** a bowl of radius r (its walls to 50, a rim at 60) in an m×m plain at 30, its floor at 20, a notch in its rim at 35 toward +x */
function bowl(m: number, r: number): Float32Array {
  const h = new Float32Array(m * m);
  const c = m / 2;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const d = Math.hypot(x - c, y - c);
    let z = d < r ? 20 + 30 * (d / r) ** 2 : d < r + 2 ? 60 : 30;
    if (d >= r * 0.6 && d < r + 3 && Math.abs(y - c) < 1 && x > c) z = Math.min(z, 35);
    h[y * m + x] = z;
  }
  return h;
}

describe('flood', () => {
  it('fills a bowl to the notch in its rim (its spill height) and marks just the bowl', () => {
    const m = 64;
    const h = bowl(m, 20);
    const W = fillCpu({ m, h });
    const seed = 32 * m + 32;
    expect(W[seed]).toBeCloseTo(35, 4);
    const f = markCpu({ m, h }, seed, W[seed]);
    expect(f.floor).toBe(20);
    // the bowl under 35: r·sqrt(0.5) ≈ 14 texels round → ~π·14² texels
    expect(f.count).toBeGreaterThan(500);
    expect(f.count).toBeLessThan(900);
    expect(h[f.spill]).toBeCloseTo(35, 3);
  });
  it('a given level floods only what joins the seed under it', () => {
    const m = 64;
    const h = bowl(m, 20);
    const f = markCpu({ m, h }, 32 * m + 32, 25);
    expect(f.count).toBeGreaterThan(50);
    expect(f.count).toBeLessThan(300);
    for (let i = 0; i < m * m; i++) if (f.mask[i]) expect(h[i]).toBeLessThan(25);
    expect(rimOf(m, f.mask).every((i) => !f.mask[i])).toBe(true);
  });
  it('an outlet (the sea) drains what reaches it', () => {
    const m = 32;
    const h = new Float32Array(m * m).fill(10);
    const outlet = new Uint8Array(m * m);
    outlet[16 * m + 16] = 1;
    h[16 * m + 16] = 2;
    const W = fillCpu({ m, h, outlet });
    expect(W[10 * m + 10]).toBe(10);
    expect(W[16 * m + 16]).toBe(2);
  });
});
