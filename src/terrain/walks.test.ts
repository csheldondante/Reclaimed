import { describe, expect, it } from 'vitest';
import { designLevels, noise1, vmin, walkRivers, walkTree, type WalkInput, type WalkStats } from './walks';
import { upstreamFirst } from './rivershape';

const SEA = 90;

/** a round island of radius R texels centred at (cx, cy) on an n-torus, rising to its middle, with a cliff ring */
function island(n: number, cx: number, cy: number, R: number, seed = 3): WalkInput {
  const N = n * n;
  const G = new Float32Array(N);
  const coast = new Float32Array(N);
  const water = new Uint8Array(N);
  const tier = new Uint8Array(N);
  const worldW = n * 8;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = ((x - cx + n / 2) % n + n) % n - n / 2;
      const dy = ((y - cy + n / 2) % n + n) % n - n / 2;
      const r = Math.hypot(dx, dy);
      const i = y * n + x;
      coast[i] = (R - r) * 8;
      water[i] = r > R ? 1 : 0;
      // a plateau inside R/2 (a 40-cell cliff), a gentle rise outside it
      G[i] = r > R ? SEA - 5 : SEA + 2 + (R - r) * 0.6 + (r < R / 2 ? 40 : 0);
      tier[i] = r < R / 2 ? 2 : 0;
    }
  return { n, seed, sea: SEA, worldW, worldH: worldW, G, coast, water, tier, spacing: 12 };
}

const blank = (): WalkStats => ({ walks: 0, lavaWalks: 0, merged: 0, toSea: 0, stranded: 0, clamped: 0, clampRounds: 0, clampMax: 0, rises: 0, ms: 0 });

describe('river walks', () => {
  it('the jitter noise is smooth and in range', () => {
    for (let s = 0; s < 50; s += 0.1) {
      const v = noise1(7, s);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(noise1(7, s + 0.01) - v)).toBeLessThan(0.1);
    }
  });

  it('is deterministic from the seed', () => {
    const a = walkRivers(island(128, 64, 64, 40));
    const b = walkRivers(island(128, 64, 64, 40));
    expect(a.count).toBeGreaterThan(20);
    expect(Array.from(a.nodes)).toEqual(Array.from(b.nodes));
    const c = walkRivers(island(128, 64, 64, 40, 4));
    expect(Array.from(c.nodes)).not.toEqual(Array.from(a.nodes));
  });

  it('wraps on the torus: an island across the seam is the same island moved', () => {
    const st = blank();
    const seam = walkTree(island(128, 0, 0, 40), st);
    expect(seam.count).toBeGreaterThan(20);
    for (let k = 0; k < seam.count; k++) {
      expect(seam.x[k]).toBeGreaterThanOrEqual(0);
      expect(seam.x[k]).toBeLessThan(128);
    }
    // (every walk across the seam still reaches the sea or joins one that does; walks cross the seam)
    expect(st.stranded).toBe(0);
    let crosses = 0;
    for (let k = 0; k < seam.count; k++) if (Math.abs(seam.x[seam.next[k]] - seam.x[k]) > 64 || Math.abs(seam.y[seam.next[k]] - seam.y[k]) > 64) crosses++;
    expect(crosses).toBeGreaterThan(0);
  });

  it('makes a tree: every node reaches the sea, no cycles, walks merge', () => {
    const st = blank();
    const t = walkTree(island(128, 64, 64, 40), st);
    expect(() => upstreamFirst(t.next)).not.toThrow();
    expect(st.stranded).toBe(0);
    expect(st.merged).toBeGreaterThan(0);
    for (let k = 0; k < t.count; k++) {
      let j = k;
      let hops = 0;
      while (t.next[j] !== j && hops++ < 10000) j = t.next[j];
      expect(t.still[j]).toBe(1);
    }
  });

  it('levels never rise downstream and stand under the ground beside them', () => {
    const inp = island(128, 64, 64, 40);
    const r = walkRivers(inp);
    const f = new Float32Array(r.nodes.buffer);
    expect(r.stats.rises).toBe(0);
    let falls = 0;
    for (let k = 0; k < r.count; k++) {
      const o = k * 8;
      const j = r.nodes[o + 4];
      if (j !== k) expect(f[j * 8 + 2]).toBeLessThanOrEqual(f[o + 2] + 1e-4);
      if (j !== k && f[o + 2] - f[j * 8 + 2] > 20) falls++;
      // (the terrain at distance 0 is the level: it must be under the ground the GPU starts from)
      const tx = Math.round(f[o] / 8 - 0.5);
      const ty = Math.round(f[o + 1] / 8 - 0.5);
      const g = inp.G[(((ty % 128) + 128) % 128) * 128 + (((tx % 128) + 128) % 128)];
      if (!inp.water[(((ty % 128) + 128) % 128) * 128 + (((tx % 128) + 128) % 128)]) expect(f[o + 2]).toBeLessThanOrEqual(Math.max(g, SEA - 0.3) + 1e-3);
    }
    // (the plateau's 40-cell cliff: rivers leaving it fall)
    expect(falls).toBeGreaterThan(0);
  });

  it('the lateral clamp brings a hanging tributary down to the main valley', () => {
    // a main river along y = 0 at level 100, a parallel tributary 20 units off at level 140 flowing into it
    const x = new Float32Array([0, 50, 100, 150, 0, 50, 100]);
    const y = new Float32Array([0, 0, 0, 0, 20, 20, 0]);
    const next = new Int32Array([1, 2, 3, 3, 5, 2, 2]);
    next[6] = 6;
    const still = new Uint8Array([0, 0, 0, 1, 0, 0, 0]);
    const lava = new Uint8Array(7);
    const width = new Float32Array(7).fill(3);
    const gmin = new Float32Array([104, 104, 104, 90, 150, 150, 150]);
    const up = new Int32Array([0, 0, 1, 2, 4, 4, 6]);
    const level = new Float32Array(7);
    const st = blank();
    designLevels({ x, y, next, still, lava, width, gmin, up, sea: SEA, worldW: 4096, worldH: 4096, radius: 400, level, stats: st });
    expect(level[4]).toBeLessThanOrEqual(level[0] + vmin(20 - 3, 3) + 1e-3);
    expect(level[5]).toBeLessThanOrEqual(level[1] + vmin(20 - 3, 3) + 1e-3);
    expect(st.clamped).toBeGreaterThan(0);
    for (let k = 0; k < 7; k++) if (next[k] !== k && !still[next[k]]) expect(level[next[k]]).toBeLessThanOrEqual(level[k] + 1e-4);
  });
});
