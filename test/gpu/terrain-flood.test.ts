// Terrain track (round 117): the GPU flood fill (src/terrain/flood.wgsl via FloodGpu) against its CPU reference
// (fillCpu / markCpu) on small heightmaps: the same spill height, the same basin texel for texel.
import { describe, expect, it } from 'vitest';
import { testGpu } from './dawn';
import { FloodGpu, fillCpu, markCpu } from '../../src/terrain/flood';

/** two bowls joined by a saddle, a notch out of one to a low plain; noise on top */
function land(m: number): Float32Array {
  const h = new Float32Array(m * m);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const a = Math.hypot(x - m * 0.3, y - m * 0.5) / (m * 0.2);
    const b = Math.hypot(x - m * 0.7, y - m * 0.5) / (m * 0.2);
    let z = 60;
    z = Math.min(z, 20 + 40 * a * a, 26 + 40 * b * b);
    if (Math.abs(y - m * 0.5) < 2 && x > m * 0.8) z = Math.min(z, 44);
    if (x > m * 0.92) z = 10;
    h[y * m + x] = z + rnd() * 1.5;
  }
  return h;
}

describe('terrain flood (GPU)', () => {
  it('fills to the spill height and marks the basin exactly as the CPU does', async () => {
    const g = await testGpu();
    const F = new FloodGpu(g.device);
    for (const m of [48, 96]) {
      const G = { m, h: land(m) };
      const seed = Math.floor(m * 0.5) * m + Math.floor(m * 0.3);
      const r = await F.flood(G, seed);
      const W = fillCpu(G);
      const c = markCpu(G, seed, W[seed]);
      expect(r.level).toBeCloseTo(W[seed], 4);
      expect(r.count).toBe(c.count);
      let differ = 0;
      for (let i = 0; i < m * m; i++) if (r.mask[i] !== c.mask[i]) differ++;
      expect(differ).toBe(0);
      expect(r.count).toBeGreaterThan(m);
    }
    expect(g.takeErrors()).toEqual([]);
  });
  it('a given level floods only what joins the seed under it', async () => {
    const g = await testGpu();
    const F = new FloodGpu(g.device);
    const m = 64;
    const G = { m, h: land(m) };
    const seed = 32 * m + Math.floor(m * 0.3);
    const r = await F.flood(G, seed, 30);
    const c = markCpu(G, seed, 30);
    expect(r.count).toBe(c.count);
    expect(g.takeErrors()).toEqual([]);
  });
});
