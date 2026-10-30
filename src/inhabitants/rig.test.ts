// The body generator at its contract (round 117): every plan and preset builds a valid rig, deterministically.
import { describe, expect, it } from 'vitest';
import { BODY_PLANS, type SpeciesSpec } from '../api/contracts/inhabitants';
import { buildRig, hex, MAX_POINTS, MAX_SEGS, Role, BONE_VERTS, TRI_VERTS } from './rig';
import { PRESETS, SPECIES } from './species';

const base = (plan: SpeciesSpec['plan']): SpeciesSpec => ({ id: plan, plan, palette: { body: '#806040' }, behaviour: { kind: 'wander' } });

describe('buildRig', () => {
  for (const plan of BODY_PLANS)
    it(`${plan}: parents first, within limits, segments name real points`, () => {
      const r = buildRig(base(plan));
      expect(r.points.length).toBeLessThanOrEqual(MAX_POINTS);
      expect(r.segments.length).toBeLessThanOrEqual(MAX_SEGS);
      expect(r.points[0].role).toBe(Role.Root);
      r.points.forEach((p, i) => {
        if (i > 0) expect(p.parent).toBeGreaterThanOrEqual(0);
        expect(p.parent).toBeLessThan(i);
        // a knee's end point comes before it (the kernel solves it from points already placed)
        if (p.role === Role.Knee) expect(p.p[0]).toBeLessThan(i);
        for (const v of [...p.rest, ...p.p]) expect(Number.isFinite(v)).toBe(true);
      });
      for (const s of r.segments) {
        for (const k of s.kind === 'bone' ? [s.a, s.b] : [s.a, s.b, s.c]) {
          expect(k).toBeGreaterThanOrEqual(0);
          expect(k).toBeLessThan(r.points.length);
        }
        expect(s.colour).toBeGreaterThanOrEqual(0);
        expect(s.colour).toBeLessThan(1 << 24);
      }
      const verts = r.segments.reduce((a, s) => a + (s.kind === 'bone' ? BONE_VERTS : TRI_VERTS), 0);
      expect(r.vertsPerAgent).toBe(verts);
      expect(r.height).toBeGreaterThan(0);
      expect(r.stride).toBeGreaterThan(0);
    });

  it('legged plans have feet in pairs; serpents none', () => {
    const feet = (plan: SpeciesSpec['plan']) => buildRig(base(plan)).points.filter((p) => p.role === Role.Foot).length;
    expect(feet('biped')).toBe(2);
    expect(feet('quadruped')).toBe(4);
    expect(feet('beast')).toBe(4);
    expect(feet('winged')).toBe(4);
    expect(feet('insect')).toBe(6);
    expect(feet('bird')).toBe(2);
    expect(feet('serpent')).toBe(0);
  });

  it('gait groups split the feet evenly (a foot steps only while the other group stands)', () => {
    for (const plan of BODY_PLANS) {
      const f = buildRig(base(plan)).points.filter((p) => p.role === Role.Foot);
      const g0 = f.filter((p) => p.p[0] === 0).length;
      expect(g0 * 2).toBe(f.length);
    }
  });

  it('is deterministic from the seed; another seed varies proportions a little', () => {
    const a = buildRig({ ...SPECIES.deer, seed: 4 });
    const b = buildRig({ ...SPECIES.deer, seed: 4 });
    const c = buildRig({ ...SPECIES.deer, seed: 5 });
    expect(a).toEqual(b);
    expect(c.height).not.toBe(a.height);
    expect(Math.abs(c.height / a.height - 1)).toBeLessThan(0.15);
  });

  it('size scales the body', () => {
    const s1 = buildRig({ ...SPECIES.wolf, proportions: { ...SPECIES.wolf.proportions, size: 1 } });
    const s2 = buildRig({ ...SPECIES.wolf, proportions: { ...SPECIES.wolf.proportions, size: 2 } });
    expect(s2.height / s1.height).toBeCloseTo(2, 5);
  });

  it('gear: a cape adds cloth (two strands, six triangles), a weapon a bone', () => {
    const plain = buildRig({ ...base('biped') });
    const caped = buildRig({ ...base('biped'), gear: [{ slot: 'cape', colour: '#aa2222' }] });
    expect(caped.segments.filter((s) => s.kind === 'tri').length - plain.segments.filter((s) => s.kind === 'tri').length).toBe(6);
    expect(caped.points.filter((p) => p.role === Role.Chain).length).toBe(6);
    const armed = buildRig({ ...base('biped'), gear: [{ slot: 'weapon', colour: '#cccccc' }] });
    expect(armed.segments.length).toBe(plain.segments.length + 1);
  });

  it('fur adds swaying tufts', () => {
    const bare = buildRig({ ...SPECIES.deer, secondary: { fur: 0 } });
    const furry = buildRig({ ...SPECIES.deer, secondary: { fur: 1 } });
    expect(furry.points.filter((p) => p.role === Role.Chain).length).toBeGreaterThan(bare.points.filter((p) => p.role === Role.Chain).length);
  });

  it('every preset builds', () => {
    for (const p of PRESETS) expect(() => buildRig(SPECIES[p])).not.toThrow();
  });

  it('a bad colour is loud', () => {
    expect(() => hex('red')).toThrow();
    expect(() => buildRig({ ...base('biped'), palette: { body: '#12345' } })).toThrow();
  });
});
