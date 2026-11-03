// Round 128 (treegen): the flora sprites' pure side — the mode, the bounds, the bake's views, the quad mesh.
import { describe, expect, it } from 'vitest';
import { bakeView, flodMode, PART_SHADOW, PART_SPRITE, spriteBounds, spriteKindMesh, SPR_ELEV } from './sprites';
import { generate } from './generate';
import { FloraLibrary } from './library';

describe('flora sprites', () => {
  it('?flod= mesh (default) or sprite; anything else throws', () => {
    expect(flodMode(null)).toBe('mesh');
    expect(flodMode('sprite')).toBe('sprite');
    expect(() => flodMode('blob')).toThrow();
  });
  it('the bake views are orthonormal, the eye at the iso pitch, right level', () => {
    for (let j = 0; j < 8; j++) {
      const { eye, right, up } = bakeView(j, 8);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      expect(dot(eye, right)).toBeCloseTo(0, 6);
      expect(dot(eye, up)).toBeCloseTo(0, 6);
      expect(dot(right, up)).toBeCloseTo(0, 6);
      expect(Math.asin(eye[2])).toBeCloseTo(SPR_ELEV, 6);
      expect(right[2]).toBe(0);
      expect(up[2]).toBeGreaterThan(0);
    }
  });
  it('every vertex of the source mesh projects inside its cell, at every yaw', () => {
    const m = generate('giant', 5);
    const b = spriteBounds(m.height, m.radius);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < 8; j++) {
      const { eye, right, up } = bakeView(j, 8);
      for (let i = 0; i < m.verts.length; i += 4) {
        const p = [m.verts[i], m.verts[i + 1], m.verts[i + 2]];
        const u = (p[0] * right[0] + p[1] * right[1] + p[2] * right[2]) / (2 * b.R) + 0.5;
        const v = (p[0] * up[0] + p[1] * up[1] + p[2] * up[2] - b.v0) / (b.v1 - b.v0);
        const d = (p[0] * eye[0] + p[1] * eye[1] + p[2] * eye[2] - b.d0) / (b.d1 - b.d0);
        lo = Math.min(lo, u, v + 0.019, d + 0.019);
        hi = Math.max(hi, u, v, d);
      }
    }
    // (the roots dip a little under the foot: a hair of slack)
    expect(lo).toBeGreaterThanOrEqual(-0.001);
    expect(hi).toBeLessThanOrEqual(1.001);
  });
  it('a sprite kind: the far mesh for the shadow pass, a quad for the eye', () => {
    const far = generate('oak', 2, { lod: 2 });
    const s = spriteKindMesh(far);
    expect(s.tris).toBe(far.tris + 2);
    const parts = new Set<number>();
    for (let i = 3; i < s.verts.length; i += 4) parts.add(Math.floor(s.verts[i]));
    expect([...parts].sort()).toEqual([PART_SPRITE, PART_SHADOW]);
  });
  it('the library: a sprite a tree variant, baked from the same variant\'s full mesh', () => {
    const lib = new FloraLibrary(undefined, 6, 'sprite');
    expect(lib.sprites.length).toBe(11);
    for (const s of lib.sprites) {
      expect(lib.kinds[s.kind].lod).toBe(2);
      expect(lib.kinds[s.src].lod).toBe(0);
      expect(lib.kinds[s.src].species).toBe(lib.kinds[s.kind].species);
      expect(lib.kinds[s.src].variant).toBe(lib.kinds[s.kind].variant);
    }
    expect(lib.wgsl()).toMatch(/FLORA_SPR_YAWS/);
    expect(new FloraLibrary(undefined, 6).sprites.length).toBe(0);
  });
});
