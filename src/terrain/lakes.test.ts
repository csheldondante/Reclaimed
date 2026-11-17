import { describe, expect, it } from 'vitest';
import { walkRivers, type WalkInput } from './walks';
import { basinsOf } from './lakes';
import { fillCpu } from './flood';

const SEA = 90;

/** a round island rising to its middle, with two bowls: one on the walks' way to the coast, one off it (a "crater") */
function island(n: number): { inp: WalkInput; crater: number } {
  const N = n * n;
  const cx = n / 2;
  const cy = n / 2;
  const R = 44;
  const G = new Float32Array(N);
  const coast = new Float32Array(N);
  const water = new Uint8Array(N);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(x - cx, y - cy);
      const i = y * n + x;
      coast[i] = (R - r) * 8;
      water[i] = r > R ? 1 : 0;
      G[i] = r > R ? SEA - 5 : SEA + 2 + (R - r) * 0.8;
      // a bowl a third of the way out east (the walks from the middle cross it), a crater north-west
      const b = Math.hypot(x - (cx + 16), y - cy);
      if (b < 9) G[i] -= 14 * (1 - b / 9);
      const c = Math.hypot(x - (cx - 14), y - (cy - 14));
      if (c < 6) G[i] -= 10 * (1 - c / 6);
    }
  const h = Float32Array.from(G, (v, i) => (water[i] ? Math.max(v, SEA) : v));
  const W = fillCpu({ m: n, h, outlet: water });
  const basins = basinsOf(n, G, W, water);
  const crater = Math.round(cy - 14) * n + Math.round(cx - 14);
  return { inp: { n, seed: 5, sea: SEA, worldW: n * 8, worldH: n * 8, G, coast, water, spacing: 10, creeks: false, basins, lakeSeeds: [crater] }, crater };
}

describe('lakes the walks find (step 3)', () => {
  it('pools in basins, spills at the outlet, and keeps the tree and its levels consistent', () => {
    const { inp, crater } = island(128);
    const bs = inp.basins!;
    expect(bs.basins.length).toBeGreaterThanOrEqual(2);
    const rv = walkRivers(inp);
    expect(rv.stats.stranded).toBe(0);
    expect(rv.lakes.length).toBeGreaterThanOrEqual(2);
    // the crater's basin is a lake (placed), and some lake was found by a walk
    expect(rv.lakes.some((L) => L.basin === bs.basinOf[crater])).toBe(true);
    expect(rv.stats.lakesFound ?? 0).toBeGreaterThanOrEqual(1);
    const W = 8;
    const f = new Float32Array(rv.nodes.buffer);
    const next = (k: number) => rv.nodes[k * W + 4];
    const level = (k: number) => f[k * W + 2];
    const n = rv.count;
    // no cycles: every chain ends
    for (let k = 0; k < n; k++) {
      let c = k;
      let steps = 0;
      while (next(c) !== c && steps <= n) {
        c = next(c);
        steps++;
      }
      expect(steps).toBeLessThanOrEqual(n);
    }
    // levels never rise downstream
    for (let k = 0; k < n; k++) if (next(k) !== k) expect(level(next(k))).toBeLessThanOrEqual(level(k) + 1e-4);
    for (const L of rv.lakes) {
      const b = bs.basins[L.basin];
      // the lake's node stands at its outlet, at the basin's spill level; its whole basin lies under it
      expect(level(L.node)).toBeCloseTo(b.level, 4);
      expect(Math.round(f[L.node * W] / 8 - 0.5) + Math.round(f[L.node * W + 1] / 8 - 0.5) * 128).toBe(b.outlet);
      for (const c of b.texels) expect(inp.G[c]).toBeLessThan(b.level);
      // every node upstream of the lake stands at its level or over it (the rivers come down to its water)
      for (let k = 0; k < n; k++) {
        let c = k;
        let reaches = false;
        while (next(c) !== c) {
          c = next(c);
          if (c === L.node) {
            reaches = true;
            break;
          }
        }
        if (reaches) expect(level(k)).toBeGreaterThanOrEqual(L.level - 1e-4);
      }
      // the outlet's river reaches the sea (a mouth: still, at the sea's level)
      let c = L.node;
      while (next(c) !== c) c = next(c);
      expect(level(c)).toBeLessThan(SEA);
    }
    // the catchments: every land texel drains to a node
    const cat = rv.catchments;
    for (let s = 0; s < cat.of.length; s++) {
      const sx = (s % cat.side) * cat.step;
      const sy = Math.floor(s / cat.side) * cat.step;
      if (!inp.water[sy * 128 + sx]) expect(cat.of[s]).toBeGreaterThanOrEqual(0);
    }
  });
});
