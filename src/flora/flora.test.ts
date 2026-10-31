// Unit tests for the flora generators at their contract (round 117): determinism, the shapes' bounds, the triangle
// budgets the phone can afford, the root automaton's rules.
import { describe, expect, it } from 'vitest';
import { expand, interpret } from './lsystem';
import { growRoots, rootReach, rootSegments } from './roots';
import { generate } from './generate';
import { SPECIES, SPECIES_IDS } from './species';

describe('L-system', () => {
  const spec = { axiom: 'A', rules: { A: [{ s: 'F[+A][-A]', w: 1 }] }, iterations: 3 };
  it('rewrites deterministically', () => {
    expect(expand(spec, 1)).toBe(expand(spec, 1));
    expect(expand({ axiom: 'A', rules: { A: [{ s: 'AB', w: 1 }] }, iterations: 3 }, 0)).toBe('ABBB');
  });
  it('picks stochastic successors by the seed', () => {
    const s = { axiom: 'AAAAAAAAAAAAAAAAAAAA', rules: { A: [{ s: 'x', w: 1 }, { s: 'y', w: 1 }] }, iterations: 1 };
    const a = expand(s, 1);
    const b = expand(s, 2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/x/);
    expect(a).toMatch(/y/);
  });
  it('applies finals', () => {
    expect(expand({ axiom: 'AB', rules: {}, finals: { A: 'L' }, iterations: 2 }, 0)).toBe('LB');
  });
  it('walks a straight trunk up z with the right length and taper', () => {
    const t = { step: 1, stepDecay: 0.5, radius: 0.4, radiusDecay: 0.5, taper: 0.9, angle: 30, roll: 137.5, jitter: 0, tropism: [0, 0, -1] as [number, number, number], tropismStrength: [0, 0, 0] as [number, number, number], minRadius: 0.001 };
    const sk = interpret('FFF', t, 0);
    expect(sk.segments.length).toBe(3);
    expect(sk.height).toBeCloseTo(3);
    expect(sk.segments[2].r1).toBeCloseTo(0.4 * 0.9 ** 3);
    // a branch is shorter and thinner (depth decay), and pitched off the trunk
    const br = interpret('F[&F]', t, 0);
    expect(br.segments[1].depth).toBe(1);
    expect(br.segments[1].r0).toBeCloseTo(0.4 * 0.9 * 0.5);
    const dz = br.segments[1].b[2] - br.segments[1].a[2];
    expect(dz).toBeCloseTo(0.5 * Math.cos(Math.PI / 6));
  });
  it('bends a branch toward the tropism (weeping)', () => {
    const t = { step: 1, stepDecay: 1, radius: 0.4, radiusDecay: 1, taper: 1, angle: 90, roll: 0, jitter: 0, tropism: [0, 0, -1] as [number, number, number], tropismStrength: [0, 0.5, 0.5] as [number, number, number], minRadius: 0.001 };
    const sk = interpret('[&FFFF]', t, 0);
    const last = sk.segments[sk.segments.length - 1];
    expect(last.b[2]).toBeLessThan(last.a[2]);
  });
  it('rejects unbalanced brackets', () => {
    const t = SPECIES.birch.turtle!;
    expect(() => interpret('F[F', t, 0)).toThrow();
    expect(() => interpret('F]F', t, 0)).toThrow();
  });
});

describe('root automaton', () => {
  const spec = { half: 6, depth: 4, res: 0.3, generations: 10, growth: 0.6, down: 0.3, maxCells: 120, trunkRadius: 0.3 };
  it('is deterministic and grows from the trunk', () => {
    const a = growRoots(spec, 5);
    const b = growRoots(spec, 5);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
    expect(a.count).toBeGreaterThan(10);
    expect(a.count).toBeLessThanOrEqual(spec.maxCells);
  });
  it('every root cell connects back to a seed (no floating roots)', () => {
    const g = growRoots(spec, 7);
    for (let i = 0; i < g.cells.length; i++) {
      if (!g.cells[i]) continue;
      let j = i;
      let steps = 0;
      while (g.parent[j] >= 0 && steps++ < 1000) j = g.parent[j];
      expect(g.age[j]).toBe(0);
    }
  });
  it('avoids rock (soil 0)', () => {
    const g = growRoots(spec, 3, (x) => (x > 1 ? 0 : 1));
    for (let i = 0; i < g.cells.length; i++) {
      if (!g.cells[i]) continue;
      const x = (i % g.n) - spec.half;
      expect(x).toBeLessThanOrEqual(1);
    }
  });
  it('shallow-rooted species spread wider than they go deep; tap-rooted go deeper', () => {
    const shallow = rootReach(growRoots({ ...spec, down: 0.1, depth: 6 }, 9));
    const tap = rootReach(growRoots({ ...spec, down: 0.9, depth: 6 }, 9));
    expect(tap.depth).toBeGreaterThan(shallow.depth);
    expect(shallow.spread).toBeGreaterThan(shallow.depth);
  });
  it('shows only the surface roots as wood', () => {
    const g = growRoots(spec, 2);
    for (const s of rootSegments(g, 0.5, 0.1)) expect(s.b[2]).toBeGreaterThan(-0.6);
  });
});

describe('species meshes', () => {
  it('every species makes a mesh, deterministically, within its height range and triangle budget', () => {
    // phone budget (tris a plant): trees ≤ 3200, small plants ≤ 400 — hundreds of trees and thousands of clumps a view
    for (const id of SPECIES_IDS) {
      const sp = SPECIES[id];
      const a = generate(id, 1);
      const b = generate(id, 1);
      expect(Array.from(a.verts)).toEqual(Array.from(b.verts));
      expect(a.tris).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThanOrEqual(sp.height[0] - 1e-3);
      expect(a.height).toBeLessThanOrEqual(sp.height[1] + 1e-3);
      const budget = sp.form === 'tree' ? 3200 : 400;
      expect(a.tris, `${id} tris`).toBeLessThanOrEqual(budget);
      // indices in range; parts and sway well-formed
      const nv = a.verts.length / 4;
      for (const i of a.index) expect(i).toBeLessThan(nv);
      for (let k = 3; k < a.verts.length; k += 4) {
        expect(Math.floor(a.verts[k])).toBeGreaterThanOrEqual(3);
        expect(Math.floor(a.verts[k])).toBeLessThanOrEqual(8);
      }
    }
  });
  it('variants differ', () => {
    expect(Array.from(generate('birch', 1).verts)).not.toEqual(Array.from(generate('birch', 2).verts));
  });
  it('a birch is tall and slender: towering, narrower than it is tall', () => {
    for (let s = 0; s < 6; s++) {
      const m = generate('birch', s);
      expect(m.height).toBeGreaterThan(10);
      expect(m.radius).toBeLessThan(m.height * 0.5);
    }
  });
  it('the wind moves the top, not the foot', () => {
    const m = generate('tallgrass', 3);
    for (let k = 0; k < m.verts.length; k += 4) {
      const sway = m.verts[k + 3] % 1;
      if (m.verts[k + 2] < 0.05) expect(sway).toBeLessThan(0.05);
    }
  });
});

describe('the phone tier (px: render pixels a cell)', () => {
  it('coarse plants have fewer, bigger leaves and no sub-pixel twigs; grass fewer, wider blades', () => {
    const full = generate('birch', 1);
    const phone = generate('birch', 1, { px: 6 });
    expect(phone.tris).toBeLessThan(full.tris);
    expect(phone.height).toBeCloseTo(full.height, 5);
    expect(generate('tallgrass', 1, { px: 6 }).tris).toBeLessThan(generate('tallgrass', 1).tris);
    // desktop-like px: as full
    expect(generate('birch', 1, { px: 40 }).tris).toBe(full.tris);
  });
});

describe('levels of detail (round 119, the phone)', () => {
  it('each tree has a coarse and a far level, far fewer triangles, the same height', () => {
    for (const id of ['birch', 'oak', 'pine', 'giant'] as const) {
      const [a, b, c] = [0, 1, 2].map((lod) => generate(id, 4, { px: 6, lod: lod as 0 | 1 | 2 }));
      expect(b.tris, id).toBeLessThan(a.tris);
      expect(c.tris, id).toBeLessThanOrEqual(40);
      expect(b.height).toBeCloseTo(a.height, 5);
      expect(c.height).toBeCloseTo(a.height, 5);
    }
  });
  it('the library lays out three levels a tree, the same variants in each', async () => {
    const { FloraLibrary } = await import('./library');
    const lib = new FloraLibrary(undefined, 6);
    const lr = lib.lods.get('birch')!;
    expect(lr.length).toBe(3);
    expect(lr[0].count).toBe(lr[2].count);
    expect(lib.kinds[lr[2].first].lod).toBe(2);
    expect(lib.wgsl()).toMatch(/FL_BIRCH_L2/);
    expect(lib.kinds.length).toBeLessThanOrEqual(48);
  });
});
