// (round 128, the user's wall riding) The bike on the physical drive along a tapered canyon wall: fast, it holds its
// height on the flank (its grip and v² / r press it to the wall) and banks with it; slow, it slides down to the floor.
import { describe, expect, it } from 'vitest';
import { BIKE, makeBike, stepBike } from './bike';
import { BIKE_DRIVE } from './drive';

/** a canyon along x: a floor 8 wide at 10, its flanks rising 1·u + 0.5·u² (45 deg at the foot, steep higher up) */
const wall = (u: number) => Math.min(26, u + 0.5 * u * u);
const canyon = (_x: number, y: number) => 10 + wall(Math.max(0, Math.abs(y - 50) - 4));

function ride(speed: number, wallRide: number, secs = 2.5, stick = 1) {
  const t = { ...BIKE, wallRide };
  const y0 = 50 + 4 + 2.5;
  const b = makeBike(20, y0, canyon, t);
  b.vx = speed;
  b.heading = 0;
  let maxBank = 0;
  for (let k = 0; k < secs * 60; k++) {
    stepBike(b, [stick, 0], 1 / 60, canyon, [400, 100], t, false, BIKE_DRIVE);
    maxBank = Math.max(maxBank, Math.abs(b.bank));
  }
  return { up: canyon(b.x, b.y) - 10, start: canyon(20, y0) - 10, bank: maxBank, crashed: b.crash > 0 || b.crashed > 0 };
}

describe('wall riding', () => {
  it('fast, it holds its height on the flank and banks with it; slow, it slides down', () => {
    const fast = ride(20, 1);
    const slow = ride(5, 1, 2.5, 0.25);
    expect(fast.up).toBeGreaterThan(fast.start * 0.6);
    expect(slow.up).toBeLessThan(slow.start * 0.4);
    expect(fast.bank).toBeGreaterThan(0.6);
  });
  it('without it, the same fast bike slides down off the flank', () => {
    const off = ride(20, 0);
    const on = ride(20, 1);
    expect(on.up).toBeGreaterThan(off.up);
  });
  it('steered up onto the wall at speed, it stays on it: no launch off the taper', () => {
    const t = { ...BIKE, wallRide: 1 };
    const b = makeBike(20, 50, canyon, t);
    b.vx = 20;
    let air = 0;
    let up = 0;
    for (let k = 0; k < 3 * 60; k++) {
      // (a second angled up onto the wall, then along it)
      stepBike(b, k < 45 ? [0.9, 0.45] : [1, 0], 1 / 60, canyon, [600, 100], t, false, BIKE_DRIVE);
      if (b.air > 0) air += 1 / 60;
      up = Math.max(up, canyon(b.x, b.y) - 10);
    }
    expect(up).toBeGreaterThan(2);
    expect(air).toBeLessThan(0.15);
  });
});
