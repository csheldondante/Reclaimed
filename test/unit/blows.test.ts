// Round 120 (the user: "dropping the tanker in a stone does not trigger breaking and it probably should"): hard ground
// struck hard gives, more the harder the blow.
import { afterEach, expect, test } from 'vitest';
import { groundBlowRadius } from '../../src/game/blows';
import { TUNING, TUNE } from '../../src/tune/params';

afterEach(() => TUNING.reset());

test('a light knock leaves hard ground whole; a heavy blow crumbles it, more from higher up', () => {
  const g = 9.8;
  // a tanker truck: some 900 of mass (cells × density)
  const blow = (h: number) => groundBlowRadius(0.5 * 900 * 2 * g * h);
  expect(blow(1)).toBe(0);
  expect(blow(16)).toBeGreaterThan(0.5);
  expect(blow(40)).toBeGreaterThan(blow(16));
  expect(blow(10000)).toBeLessThanOrEqual(3);
});

test('the threshold is the tuning', () => {
  TUNE.impact.groundEnergy = 1e9;
  expect(groundBlowRadius(1e6)).toBe(0);
});
