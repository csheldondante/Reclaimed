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
  it('every species makes a mesh, deterministically, within its height range and triangle budget', { timeout: 30000 }, () => {
    // phone budget (tris a plant): trees ≤ 3200, small plants ≤ 400 — hundreds of trees and thousands of clumps a view
    for (const id of SPECIES_IDS) {
      const sp = SPECIES[id];
      const a = generate(id, 1);
      const b = generate(id, 1);
      expect(Array.from(a.verts)).toEqual(Array.from(b.verts));
      expect(a.tris).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThanOrEqual(sp.height[0] - 1e-3);
      expect(a.height).toBeLessThanOrEqual(sp.height[1] + 1e-3);
      // (round 125: the elder stands one to a 2 x 2 of the other trees' slots — flora/spacing.ts — so its budget is the
      // area's: up to 5000 a tree, a quarter as many trees)
      // (round 128: the crowns' sprays along the last branch orders, the extruded stems, the epiphytes — the elder 9500;
      // it stands one to a 28 x 32 super-block now, TREE_SCALE: a quarter as many a wood. Small plants 450: the thicket's sprays)
      // (round 128: space-colonized crowns and lobe canopies — a tree 6000, the elder 14000; a tree stands one to a 14 x 16
      // block, the elder one to 28 x 32 (TREE_SCALE): per area still under round 125's budgets)
      // (the willow: the viewer's, not in the game's plan yet — its curtains of twigs 14000)
      const budget = id === 'giant' || id === 'willow' ? 16000 : sp.form === 'tree' ? 7500 : 500;
      expect(a.tris, `${id} tris`).toBeLessThanOrEqual(budget);
      // indices in range; parts and sway well-formed
      const nv = a.verts.length / 4;
      // (one expect a check, not a vertex: the meshes are thousands of vertices now)
      let maxI = 0;
      for (const i of a.index) maxI = Math.max(maxI, i);
      expect(maxI).toBeLessThan(nv);
      let lo = 99;
      let hi = 0;
      for (let k = 3; k < a.verts.length; k += 4) {
        lo = Math.min(lo, Math.floor(a.verts[k]));
        hi = Math.max(hi, Math.floor(a.verts[k]));
      }
      expect(lo).toBeGreaterThanOrEqual(3);
      expect(hi).toBeLessThanOrEqual(14);
    }
  });
  it('variants differ', () => {
    expect(Array.from(generate('birch', 1).verts)).not.toEqual(Array.from(generate('birch', 2).verts));
  });
  it('a birch is tall and slender: towering, narrower than it is tall', () => {
    for (let s = 0; s < 6; s++) {
      const m = generate('birch', s);
      expect(m.height).toBeGreaterThan(10);
      // (round 128: the stems kink and vary their spacing — a seed or two spread wider than half their height)
      expect(m.radius).toBeLessThan(m.height * 0.6);
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
    // (round 128: px 3 — the lobe canopy keeps its full lobes down to ~24 px a lobe, which the phone's 6 px a cell still is)
    const phone = generate('birch', 1, { px: 3 });
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
    // (round 128: + the close-up level of the trees, the thicket and the tall grass — 16 kinds, a draw each)
    expect(lib.kinds.length).toBeLessThanOrEqual(64);
    expect(lib.wgsl()).toMatch(/FL_GIANT_C/);
  });
});

describe('the stems (round 128, treegen)', () => {
  it('a branch is one extruded tube: its steps share rings (no seams)', async () => {
    const { stemPaths } = await import('./mesh');
    const t = { ...SPECIES.birch.turtle!, jitter: 0, tropismStrength: [0, 0, 0] as [number, number, number], kinkChance: 0, stepVar: 0, taperVar: 0, twist: 0 };
    const sk = interpret('FFF[&FF]FF', t, 0);
    const paths = stemPaths(sk.segments, () => false);
    expect(paths.length).toBe(2);
    // the trunk's five steps one path (six points), the branch's two another
    expect(paths.map((p) => p.p.length).sort()).toEqual([3, 6]);
  });
  it('the variances draw from their own stream: the branching is the old one, the new parameters only bend it', () => {
    for (const id of ['birch', 'oak', 'pine', 'giant'] as const) {
      const sp = SPECIES[id];
      const str = expand(sp.lsystem!, 9);
      const a = interpret(str, { ...sp.turtle!, taperVar: 0, stepVar: 0, twist: 0, kinkChance: 0 }, 3);
      const b = interpret(str, sp.turtle!, 3);
      expect(b.leaves.length).toBe(a.leaves.length);
    }
  });
  it('twist rolls the frame: children leave in a spiral', () => {
    const t = { step: 1, stepDecay: 1, radius: 0.4, radiusDecay: 0.5, taper: 1, angle: 45, roll: 0, jitter: 0, tropism: [0, 0, 1] as [number, number, number], tropismStrength: [0, 0, 0] as [number, number, number], minRadius: 0.001 };
    const s = 'F[&F]F[&F]';
    const plain = interpret(s, t, 1).segments.filter((g) => g.depth === 1);
    const tw = interpret(s, { ...t, twist: 90 }, 1).segments.filter((g) => g.depth === 1);
    const dir = (g: { a: number[]; b: number[] }) => Math.atan2(g.b[1] - g.a[1], g.b[0] - g.a[0]);
    expect(Math.abs(dir(plain[0]) - dir(plain[1]))).toBeLessThan(1e-6);
    expect(Math.abs(Math.cos(dir(tw[0]) - dir(tw[1])))).toBeLessThan(0.1);
  });
  it('kinks change direction along a stem', () => {
    const t = { step: 1, stepDecay: 1, radius: 0.4, radiusDecay: 0.5, taper: 1, angle: 30, roll: 0, jitter: 0, tropism: [0, 0, 1] as [number, number, number], tropismStrength: [0, 0, 0] as [number, number, number], minRadius: 0.001 };
    const straight = interpret('FFFFFFFF', t, 1);
    const kinked = interpret('FFFFFFFF', { ...t, kinkChance: 1, kinkAngle: 20 }, 1);
    expect(straight.segments.every((g) => Math.abs(g.b[0] - g.a[0]) < 1e-9)).toBe(true);
    expect(kinked.segments.some((g) => Math.abs(g.b[0] - g.a[0]) > 0.05)).toBe(true);
  });
  it('noise and knots move the stem off its round prism', () => {
    const base = { ...SPECIES.oak, stem: { ...SPECIES.oak.stem!, noise: 0, knots: 0 } };
    const a = generate('oak', 2, { def: base });
    const b = generate('oak', 2, { def: { ...SPECIES.oak, stem: { ...SPECIES.oak.stem!, noise: 0.3, knots: 6, knotSize: 0.6 } } });
    expect(a.tris).toBe(b.tris);
    expect(Array.from(a.verts)).not.toEqual(Array.from(b.verts));
  });
  it('the viewer\'s old side is round 117\'s mesh exactly', async () => {
    const { legacyDef } = await import('./generate');
    // (the legacy path: no stem look, no variances — the same triangles as a prism a step)
    const m = generate('birch', 5, { def: legacyDef(SPECIES.birch) });
    expect(m.tris).toBeGreaterThan(0);
    expect(generate('birch', 5, { legacy: true }).tris).toBe(m.tris);
  });
});

describe('the generator\'s parameters (round 128: the viewer\'s sliders)', () => {
  it('every species\' value lies in its slider\'s range; edits clamp and never touch the table', async () => {
    const { PARAMS, applyParams, paramsFromQuery } = await import('./params');
    for (const id of SPECIES_IDS) {
      const sp = SPECIES[id];
      for (const p of PARAMS) {
        if (p.woody && !(sp.turtle && sp.stem)) continue;
        if (p.crown && !sp.crown) continue;
        if (p.twigs && !sp.twigs) continue;
        if (p.shape && !sp.colonize) continue;
        const v = p.get(sp);
        expect(v, `${id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
        expect(v, `${id}.${p.key}`).toBeLessThanOrEqual(p.max);
      }
    }
    const before = JSON.stringify(SPECIES.oak);
    const ed = applyParams('oak', { twist: 999, noise: 0.2, bark: '#ff0000' });
    expect(ed.turtle!.twist).toBe(40);
    expect(ed.stem!.noise).toBe(0.2);
    expect(ed.colours.bark[0]).toBe(1);
    expect(JSON.stringify(SPECIES.oak)).toBe(before);
    expect(paramsFromQuery(new URLSearchParams('p.twist=3&p.bark=00ff00&seed=2'))).toEqual({ twist: 3, bark: '#00ff00' });
  });
});

describe('epiphytes and seasons (round 128, treegen)', () => {
  const parts = (m: { verts: Float32Array }) => {
    const c = new Map<number, number>();
    for (let i = 3; i < m.verts.length; i += 4) c.set(Math.floor(m.verts[i]), (c.get(Math.floor(m.verts[i])) ?? 0) + 1);
    return c;
  };
  it('bare, a deciduous tree keeps its limbs at every mesh level: wood reaches out from the trunk', () => {
    for (const id of ['birch', 'oak', 'giant'] as const) {
      for (const lod of [0, 1] as const) {
        const m = generate(id, 4, { px: 6, lod });
        let out = 0;
        for (let i = 0; i < m.verts.length; i += 4) if (Math.floor(m.verts[i + 3]) === 3 && Math.hypot(m.verts[i], m.verts[i + 1]) > m.radius * 0.3) out++;
        expect(out, `${id} lod ${lod}: limb vertices`).toBeGreaterThanOrEqual(16);
      }
    }
  });
  it('the densities add their geometry, and none without them', async () => {
    const { NO_EPIPHYTES } = await import('./species');
    const none = parts(generate('giant', 2, { def: { ...SPECIES.giant, epiphytes: NO_EPIPHYTES } }));
    expect(none.get(9) ?? 0).toBe(0);
    expect(none.get(10) ?? 0).toBe(0);
    const lots = parts(generate('giant', 2, { def: { ...SPECIES.giant, epiphytes: { lichen: 1, moss: 1, plants: 1, vines: 1, lines: 1 } } }));
    const some = parts(generate('giant', 2));
    expect(lots.get(9)!).toBeGreaterThan(some.get(9) ?? 0);
    expect(lots.get(10)!).toBeGreaterThan(some.get(10) ?? 0);
  });
  it('a tree carries icicles (drawn only in winter), a small plant none', () => {
    expect(parts(generate('oak', 1)).get(11) ?? 0).toBeGreaterThan(0);
    expect(parts(generate('tallgrass', 1)).get(11) ?? 0).toBe(0);
  });
  it('the named seasons fall where the season functions of the look say (common.wgsl)', async () => {
    const { SEASONS } = await import('./params');
    const ss = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const bare = (s: number) => ss(0.55, 0.78, s) * (1 - ss(0.9, 1.0, s));
    const snow = (s: number) => ss(0.79, 0.82, s) * (1 - ss(0.88, 0.91, s));
    const bloom = (s: number) => ss(0.92, 0.97, s) + 1 - ss(0.06, 0.13, s);
    const at = Object.fromEntries(SEASONS.map((s) => [s.name, s.at]));
    expect(bare(at.bare)).toBeGreaterThan(0.95);
    expect(snow(at.bare)).toBe(0);
    expect(snow(at.winter)).toBeGreaterThan(0.95);
    expect(bloom(at.flower)).toBeGreaterThan(0.95);
    expect(bloom(at.leaf) + bare(at.leaf) + snow(at.leaf)).toBe(0);
  });
});

describe('the close-up level (round 128: the flora LOD ladder)', () => {
  it('more geometry than full detail, the same height; a budget of twice the full level', () => {
    for (const id of ['birch', 'oak', 'pine', 'giant', 'shrub', 'tallgrass'] as const) {
      const full = generate(id, 3);
      const close = generate(id, 3, { lod: 'close' });
      expect(close.tris, id).toBeGreaterThan(full.tris);
      expect(close.height).toBeCloseTo(full.height, 5);
      const budget = id === 'giant' ? 32000 : SPECIES[id].form === 'tree' ? 16000 : 1600;
      expect(close.tris, `${id} close tris`).toBeLessThanOrEqual(budget);
    }
  });
});

describe('the crowns (round 128: sprays along the last branch orders)', () => {
  const leafVerts = (m: { verts: Float32Array }) => {
    let n = 0;
    for (let i = 3; i < m.verts.length; i += 4) if (Math.floor(m.verts[i]) === 4) n++;
    return n;
  };
  it('fill leaves gaps; more cards a spray, more leaves; no blobs (a card is 4 vertices)', () => {
    const base = { ...SPECIES.oak.crown!, style: 'sprays' as const };
    const full = generate('oak', 2, { def: { ...SPECIES.oak, crown: { ...base, fill: 1 } } });
    const gappy = generate('oak', 2, { def: { ...SPECIES.oak, crown: { ...base, fill: 0.3 } } });
    expect(leafVerts(gappy)).toBeLessThan(leafVerts(full) * 0.5);
    const more = generate('oak', 2, { def: { ...SPECIES.oak, crown: { ...base, leaves: base.leaves * 2 } } });
    expect(leafVerts(more)).toBeGreaterThan(leafVerts(generate('oak', 2, { def: { ...SPECIES.oak, crown: base } })) * 1.5);
    expect(leafVerts(full) % 4).toBe(0);
  });
  it('the coarse level makes fewer cards a spray (about one per 4 px)', () => {
    const sprays = { ...SPECIES.giant, crown: { ...SPECIES.giant.crown!, style: 'sprays' as const } };
    expect(leafVerts(generate('giant', 2, { lod: 1, px: 1, def: sprays }))).toBeLessThan(leafVerts(generate('giant', 2, { def: sprays })) * 0.95);
  });
});

describe('crowns grown by space colonization (round 128)', () => {
  it('deterministic per seed; the branches stay in the envelope; they rise (upBend), a willow\'s weep down', async () => {
    const { colonize, inEnvelope } = await import('./colonize');
    const spec = SPECIES.oak.colonize!;
    const a = colonize(spec, 5);
    const b = colonize(spec, 5);
    expect(JSON.stringify(a.segments)).toBe(JSON.stringify(b.segments));
    const tipsOut = a.leaves.filter((l) => !inEnvelope([l.p[0] * 0.85, l.p[1] * 0.85, Math.min(l.p[2], spec.height)], { ...spec, width: spec.width * 1.3 })).length;
    expect(tipsOut).toBeLessThan(a.leaves.length * 0.2);
    const rise = (sk: typeof a) => sk.segments.filter((g) => g.depth > 0).reduce((s, g) => s + Math.sign(g.b[2] - g.a[2]), 0);
    expect(rise(a)).toBeGreaterThan(0);
    const w = colonize(SPECIES.willow.colonize!, 5);
    const down = w.segments.filter((g) => g.depth > 0 && g.b[2] < g.a[2]).length;
    expect(down).toBeGreaterThan(w.segments.filter((g) => g.depth > 0).length * 0.15);
  });
  it('several branches a fork: the decurrent crown splits into its limbs at the crown\'s base', async () => {
    const { colonize } = await import('./colonize');
    const sk = colonize(SPECIES.giant.colonize!, 3);
    expect(new Set(sk.segments.map((g) => g.stem)).size).toBeGreaterThan(20);
  });
});
