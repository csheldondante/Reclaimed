// The leaf-cluster atlas (round 128): every tile a cluster of leaves — covering a good share of its square with gaps
// between the leaves, shaded, its mips keeping the coverage.
import { describe, expect, it } from 'vitest';
import { CLUSTER_VARIANTS, LEAF_ROWS, LEAF_TILE, leafAtlasBase, leafAtlasMips, leafRow } from './leafatlas';

describe('leaf-cluster atlas', () => {
  const base = leafAtlasBase();
  const cover = (img: { data: Uint8Array; w: number }, t: number, row: number, v: number) => {
    let a = 0;
    for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) a += img.data[((row * t + y) * img.w + v * t + x) * 4] > 127 ? 1 : 0;
    return a / (t * t);
  };
  it('a tile a species and variant, each 30-80% leaves (gaps between them), the leaves shaded', () => {
    expect(base.w).toBe(CLUSTER_VARIANTS * LEAF_TILE);
    expect(base.h).toBe(LEAF_ROWS.length * LEAF_TILE);
    for (let r = 0; r < LEAF_ROWS.length; r++)
      for (let v = 0; v < CLUSTER_VARIANTS; v++) {
        const c = cover(base, LEAF_TILE, r, v);
        expect(c, `${LEAF_ROWS[r]} ${v}`).toBeGreaterThan(0.28);
        expect(c, `${LEAF_ROWS[r]} ${v}`).toBeLessThan(0.8);
      }
    expect(leafRow('oak')).toBeGreaterThanOrEqual(0);
    expect(leafRow('pine')).toBe(-1);
  });
  it('the mips keep the coverage (within a third) down to 8 texels a tile', () => {
    const mips = leafAtlasMips(base);
    expect(mips.length).toBe(Math.log2(LEAF_TILE) + 1);
    for (let l = 1; l <= 3; l++) {
      const t = LEAF_TILE >> l;
      for (let r = 0; r < LEAF_ROWS.length; r++) {
        const c0 = cover(base, LEAF_TILE, r, 0);
        const c = cover(mips[l], t, r, 0);
        expect(Math.abs(c - c0) / c0, `${LEAF_ROWS[r]} level ${l}`).toBeLessThan(0.34);
      }
    }
  });
});
