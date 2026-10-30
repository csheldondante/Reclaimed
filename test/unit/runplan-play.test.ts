// (round 117, runplan) The play adapter at its contract: play's profiles (contracts/play.ts) as HeroCapabilities, and a run planned with them on seed 1.
import { describe, expect, test } from 'vitest';
import { seed1, seed1Graph } from '../support/seed1';
import { capsFromProfile } from '../../src/runplan/play-adapter';
import { planRun } from '../../src/runplan/plan';
import { library } from '../../src/play/library';

// (runplay, round 119: play's real profiles at their defaults — the copied crossCost and the shaped stand-ins are gone)
const bike = library.get('hoverbike')!.profile();
const lich = library.get('lich')!.profile();

describe('play profiles as capabilities', () => {
  test('the bike: no cliffs, skims rivers and the sea, a ravine only off a ramp (a fun crossing)', () => {
    const c = capsFromProfile('bike', bike);
    expect(c.passes.cliff).toBe(0);
    expect(c.passes.river).toBe(1);
    expect(c.passes.ravine).toBe(0);
    expect(c.funCrossings?.ravine).toMatch(/ramp/);
    expect(c.likes.race).toBe(1);
  });
  test('the lich: floats over everything, likes breaking things', () => {
    const c = capsFromProfile('lich', lich);
    for (const b of ['cliff', 'steep', 'ravine', 'sea', 'lava'] as const) expect(c.passes[b], b).toBeGreaterThan(0);
    expect(c.likes.spectacle).toBe(1);
    expect(c.funCrossings?.cliff).toBeTruthy();
  });
  test('runs plan with play\u2019s profiles on seed 1', () => {
    const { wiki } = seed1();
    for (const [role, p] of [['bike', bike], ['lich', lich]] as const) {
      const plan = planRun({ graph: seed1Graph(), world: wiki.snapshot, hero: capsFromProfile(role, p), seed: 1, from: wiki.spawn.region });
      expect(plan.stages.length).toBeGreaterThanOrEqual(4);
      expect(plan.minutes.max).toBeLessThanOrEqual(50);
    }
  });
});
