// Round 128 (treegen): the user's tree variants — a link's round trip, a new variant in range, the world's overrides.
import { describe, expect, it } from 'vitest';
import { decodeLink, encodeLink, newVariant, worldOverrides } from './variants';
import { PARAMS } from './params';
import { SPECIES } from './species';

describe('tree variants', () => {
  it('a link carries the parameters exactly', () => {
    const v = { oak: { sWidth: 0.51, bark: '#aabbcc', cStyle: 4 } };
    expect(decodeLink(encodeLink(v))).toEqual(v);
    expect(worldOverrides(new URLSearchParams(`ftree=${encodeLink(v)}`))).toEqual(v);
    expect(() => worldOverrides(new URLSearchParams(`ftree=${encodeLink({ nope: {} })}`))).toThrow();
  });
  it('a new variant: deterministic by its seed, every value in its slider, the switches kept', () => {
    const a = newVariant('giant', {}, 42);
    expect(newVariant('giant', {}, 42)).toEqual(a);
    expect(newVariant('giant', {}, 43)).not.toEqual(a);
    for (const [k, v] of Object.entries(a)) {
      const p = PARAMS.find((x) => x.key === k)!;
      expect(v as number).toBeGreaterThanOrEqual(p.min);
      expect(v as number).toBeLessThanOrEqual(p.max);
    }
    expect(a.cStyle).toBeUndefined();
    expect(a.sLeader).toBeUndefined();
  });
  it('the game library builds a species with the world\'s overrides', async () => {
    const { FloraLibrary } = await import('./library');
    const lib = new FloraLibrary({ species: [{ id: 'oak', variants: 1 }], seed: 1 }, 6, 'mesh', { oak: { sWidth: 0.2 } });
    const plain = new FloraLibrary({ species: [{ id: 'oak', variants: 1 }], seed: 1 }, 6);
    expect(lib.defOf('oak').colonize!.width).toBe(0.2);
    expect(plain.defOf('oak')).toBe(SPECIES.oak);
    expect(lib.kinds[0].mesh.radius).toBeLessThan(plain.kinds[0].mesh.radius);
  }, 60000);
});
