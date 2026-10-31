import { describe, expect, it } from 'vitest';
import { HDR, MAX_SPECIES, packSpecies, preyMaskOf, TABLE_VEC4 } from './pack';
import { buildRig, MAX_POINTS } from './rig';
import { SPECIES } from './species';

describe('pack', () => {
  it('a stalker hunts the species it names, by slot', () => {
    expect(preyMaskOf(SPECIES.wolf, ['deer', 'wolf', 'goat'])).toBe(0b101);
    expect(preyMaskOf(SPECIES.deer, ['deer', 'wolf'])).toBe(0);
  });
  it('writes the header and the points where inhabitants.wgsl reads them', () => {
    const t = new Float32Array(TABLE_VEC4 * 4);
    const rig = buildRig(SPECIES.wolf);
    packSpecies(t, 2, SPECIES.wolf, rig, 1);
    const h = 2 * HDR * 4;
    expect(t[h + 1]).toBe(SPECIES.wolf.run);
    expect(t[h + 4]).toBe(2); // stalker
    expect(t[h + 7]).toBe(1); // prey mask
    expect(t[h + 12]).toBe(rig.points.length);
    expect(t[h + 14]).toBe(rig.vertsPerAgent);
    const P = (MAX_SPECIES * HDR + 2 * MAX_POINTS * 2) * 4;
    // point 1's role and parent: role + (parent + 1) * 16
    expect(t[P + 8 + 3]).toBe(rig.points[1].role + (rig.points[1].parent + 1) * 16);
    expect(() => packSpecies(t, MAX_SPECIES, SPECIES.wolf, rig, 0)).toThrow();
  });
});
