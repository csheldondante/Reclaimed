// The play contract's profiles (round 117): what the generators read — derived from each controller's parameters.
import { describe, expect, it } from 'vitest';
import { crossCost, fun } from '../api/contracts/play';
import { library } from './library';

const bike = library.get('hoverbike')!;
const lich = library.get('lich')!;

describe('controller library', () => {
  it('lists the hoverbike and the lich with parameters within their slider ranges', () => {
    expect(library.controllers().map((c) => c.id)).toEqual(['hoverbike', 'lich']);
    for (const c of library.controllers())
      for (const p of c.params) {
        const v = c.defaults[p.id];
        expect(v, `${c.id}.${p.id}`).toBeGreaterThanOrEqual(p.min);
        expect(v, `${c.id}.${p.id}`).toBeLessThanOrEqual(p.max);
      }
  });

  it('a profile follows its parameters: launch the bike harder and it clears wider gaps', () => {
    const base = bike.profile();
    const hard = bike.profile({ ...bike.defaults, launchMax: bike.defaults.launchMax * 1.5 });
    expect(hard.jump.gap).toBeGreaterThan(base.jump.gap);
    expect(hard.jump.height).toBeGreaterThan(base.jump.height);
  });
});

describe('crossCost', () => {
  it('open ground is 1 for both', () => {
    expect(crossCost(bike.profile(), {})).toBe(1);
    expect(crossCost(lich.profile(), {})).toBe(1);
  });

  it('a sheer 5-cell wall stops the bike but the lich floats up it (slowly)', () => {
    expect(crossCost(bike.profile(), { step: 5 })).toBe(Infinity);
    const c = crossCost(lich.profile(), { step: 5 });
    expect(c).toBeGreaterThan(1);
    expect(c).toBeLessThan(Infinity);
  });

  it('a 15-cell ravine: the bike clears it only off a ramp', () => {
    const p = bike.profile();
    expect(p.jump.gap).toBeGreaterThan(15);
    expect(crossCost(p, { gap: 15, ramp: true })).toBeLessThan(2);
    expect(crossCost(p, { gap: 15 })).toBe(Infinity);
  });

  it('deep water: both go over; a thicket slows the bike, not the lich', () => {
    expect(crossCost(bike.profile(), { water: 4 })).toBe(1);
    expect(crossCost(lich.profile(), { water: 4 })).toBe(1);
    expect(crossCost(bike.profile(), { vegetation: 0.8 })).toBeGreaterThan(1.5);
    expect(crossCost(lich.profile(), { vegetation: 0.8 })).toBe(1);
  });
});

describe('fun', () => {
  it('ramps and straights for the bike; packs and breakables for the lich', () => {
    const b = fun(bike.profile()).map((f) => f.kind);
    expect(b.slice(0, 2)).toEqual(expect.arrayContaining(['ramp', 'straight']));
    const l = fun(lich.profile()).map((f) => f.kind);
    expect(l.slice(0, 2)).toEqual(expect.arrayContaining(['pack', 'breakables']));
    expect(l).not.toContain('ramp');
  });
});
