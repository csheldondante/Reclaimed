import { describe, expect, it } from 'vitest';
import { canonical, classes, jointKind, runsOf } from './cases';

/** Burnside: necklaces N(n) = (1/n) Σ_{d|n} φ(d) 2^(n/d); bracelets B(n) = N(n)/2 + (odd n: 2^((n−1)/2)/2 … ) */
const phi = (d: number) => {
  let r = 0;
  for (let k = 1; k <= d; k++) {
    let a = k;
    let b = d;
    while (b) [a, b] = [b, a % b];
    if (a === 1) r++;
  }
  return r;
};
const necklaces = (n: number) => {
  let s = 0;
  for (let d = 1; d <= n; d++) if (n % d === 0) s += phi(d) * 2 ** (n / d);
  return s / n;
};
const bracelets = (n: number) => (n % 2 ? necklaces(n) / 2 + 2 ** ((n - 1) / 2) : necklaces(n) / 2 + (3 / 4) * 2 ** (n / 2));

describe('vertex case set (TILEKIT.md §4)', () => {
  it('counts classes per valence as Burnside says', () => {
    for (const n of [3, 4, 5, 6]) {
      expect(classes(n, false).length).toBe(necklaces(n));
      expect(classes(n, true).length).toBe(bracelets(n));
    }
  });
  it('totals 32 rotation classes and 31 with reflection for valences 3–6', () => {
    const r = [3, 4, 5, 6].reduce((s, n) => s + classes(n, false).length, 0);
    const f = [3, 4, 5, 6].reduce((s, n) => s + classes(n, true).length, 0);
    expect([r, f]).toEqual([32, 31]);
  });
  it('canonical is invariant under rotation', () => {
    for (let w = 0; w < 64; w++) {
      const r = ((w << 1) | (w >> 5)) & 63;
      expect(canonical(r, 6, false)).toBe(canonical(w, 6, false));
    }
  });
  it('runs: one run a joint, two runs a pinch', () => {
    expect(runsOf(0b0011, 4)).toEqual([[0, 2]]);
    expect(runsOf(0b1001, 4)).toEqual([[3, 2]]);
    expect(runsOf(0b0101, 4).length).toBe(2);
    expect(runsOf(0b111, 3)).toEqual([[0, 3]]);
    expect(runsOf(0, 5)).toEqual([]);
  });
  it('joint kinds by angle', () => {
    expect(jointKind(90)).toBe(0);
    expect(jointKind(185)).toBe(1);
    expect(jointKind(270)).toBe(2);
  });
});
