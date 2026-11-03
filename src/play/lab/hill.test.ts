// (round 128) The hill station on the lab's own cells (hex columns, as the live world builds them): the knight on the
// physical drive crawls up the ramp from standing (the pull nearly matches its push) and carries up with a run-up; the
// brute can't from standing, only with a run-up. (core/drive.test.ts checks the same on a smooth ramp; the cells are what the browser rides.)
import { describe, expect, it } from 'vitest';
import { makeHero } from '../heroes/make';
import { input, testWorld } from '../testing';
import { sight } from './ride';
import { HILL, HILL_RIDE } from './terrains';

/** the highest it gets up the ramp in `secs`, and how long it took to the top (Infinity: never) */
function climb(drive: number, from: number, secs = 8): { up: number; top: number } {
  const s = sight();
  const world = testWorld((x, y) => s.top(x, y), { maxHeld: 4 });
  const y = HILL_RIDE[0].at[1];
  const hero = makeHero('knight', world, [HILL.foot - from, y], { drive });
  const dt = 1 / 30;
  let up = 0;
  let top = Infinity;
  for (let k = 0; k < secs / dt; k++) {
    hero.update(dt, { move: [1, 0], input: input({ dir: [1, 0] }) });
    up = Math.max(up, hero.position()[2] - HILL.base);
    // (from the ramp's foot: the time from reaching it)
    if (up >= HILL.height - 0.2 && top === Infinity) top = k * dt;
  }
  return { up, top };
}

describe('the hill station', () => {
  it('on the cells: the knight crawls up from standing and carries up from a run-up; the brute only with a run-up', () => {
    const stand = climb(1, 0.3);
    const run = climb(1, 30);
    const bStand = climb(2, 0.3);
    const bRun = climb(2, 50, 12);
    expect(run.up).toBeGreaterThan(HILL.height - 0.2);
    expect(stand.up).toBeGreaterThan(HILL.height - 0.2);
    expect(bStand.up).toBeLessThan(0.6);
    expect(bRun.up).toBeGreaterThan(bStand.up + 1);
  });
});
