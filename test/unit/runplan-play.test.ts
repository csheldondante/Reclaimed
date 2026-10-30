// (round 117, runplan) The play adapter at its contract: play's profiles (the shape of contracts/play.ts on `play`
// 6c3947f) as HeroCapabilities, and a run planned with them on seed 1.
import { describe, expect, test } from 'vitest';
import { seed1, seed1Graph } from '../support/seed1';
import { capsFromProfile, type CrossingLike, type ProfileLike } from '../../src/runplan/play-adapter';
import { planRun } from '../../src/runplan/plan';

// play's crossCost, copied verbatim from contracts/play.ts (play 6c3947f) until play is on places
function crossCost(p: ProfileLike, c: CrossingLike): number {
  let cost = 1;
  const flies = p.fly.ceiling > 0;
  const step = c.step ?? 0;
  if (step > p.climb.step) {
    if (p.jump.height >= step && (!p.jump.ramp || c.ramp)) cost += 0.2;
    else return Infinity;
  } else if (step > 0 && p.climb.rate > 0) cost += (step * p.speed.cruise) / p.climb.rate;
  const slope = c.slope ?? 0;
  if (slope > p.climb.slope && !flies) return Infinity;
  if (!flies) cost *= 1 + Math.max(0, slope) / Math.max(p.climb.slope, 0.1);
  const gap = c.gap ?? 0;
  if (gap > 0 && !flies) {
    if (p.jump.gap >= gap && (!p.jump.ramp || c.ramp)) cost += 0.2;
    else if (p.bridge >= gap) cost += 3;
    else return Infinity;
  }
  const water = c.water ?? 0;
  if (water > p.water.wade && !p.water.over && !flies) return Infinity;
  if (water > 0 && !p.water.over && !flies) cost *= 1 + water / Math.max(p.water.wade, 0.1);
  const veg = Math.max(0, Math.min(1, c.vegetation ?? 0));
  if (veg > 0 && !flies) {
    const through = p.vegetation.cuts ? Math.max(p.vegetation.through, 0.5) : p.vegetation.through;
    if (through <= 0 && veg > 0.5) return Infinity;
    cost /= 1 - veg * (1 - Math.max(through, 0.05));
  }
  return cost;
}

// profiles shaped like play's bikeProfile / lichProfile at their defaults (numbers approximate)
const bike: ProfileLike = { speed: { cruise: 24, top: 40 }, climb: { slope: 0.9, step: 1.5, rate: 0 }, jump: { height: 4, gap: 16, ramp: true }, fly: { ceiling: 0 }, water: { wade: 0, over: true }, vegetation: { through: 0.5, cuts: false }, bridge: 0, destruction: 0.3, encounters: { race: 1, chase: 0.9, fight: 0.6, spectacle: 0.3, delve: 0, tricks: 0.9 } };
const lich: ProfileLike = { speed: { cruise: 10, top: 10 }, climb: { slope: Infinity, step: Infinity, rate: 6 }, jump: { height: 0, gap: 0, ramp: false }, fly: { ceiling: 8 }, water: { wade: 0, over: true }, vegetation: { through: 1, cuts: false }, bridge: 0, destruction: 0.9, encounters: { race: 0, chase: 0.2, fight: 0.8, spectacle: 1, delve: 0.3, tricks: 0 } };

describe('play profiles as capabilities', () => {
  test('the bike: no cliffs, skims rivers and the sea, a ravine only off a ramp (a fun crossing)', () => {
    const c = capsFromProfile('bike', bike, crossCost);
    expect(c.passes.cliff).toBe(0);
    expect(c.passes.river).toBe(1);
    expect(c.passes.ravine).toBe(0);
    expect(c.funCrossings?.ravine).toMatch(/ramp/);
    expect(c.likes.race).toBe(1);
  });
  test('the lich: floats over everything, likes breaking things', () => {
    const c = capsFromProfile('lich', lich, crossCost);
    for (const b of ['cliff', 'mountain', 'ravine', 'water', 'lava'] as const) expect(c.passes[b], b).toBeGreaterThan(0);
    expect(c.likes.spectacle).toBe(1);
    expect(c.funCrossings?.cliff).toBeTruthy();
  });
  test('runs plan with play\u2019s profiles on seed 1', () => {
    const { wiki } = seed1();
    for (const [role, p] of [['bike', bike], ['lich', lich]] as const) {
      const plan = planRun({ graph: seed1Graph(), world: wiki.snapshot, hero: capsFromProfile(role, p, crossCost), seed: 1, from: wiki.spawn.region });
      expect(plan.stages.length).toBeGreaterThanOrEqual(4);
      expect(plan.minutes.max).toBeLessThanOrEqual(50);
    }
  });
});
