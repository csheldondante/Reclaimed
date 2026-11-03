// (round 128) the physical drive: the stick as a wanted velocity, the falling push, braking and grip limits, the
// slope's pull on top — a running start climbs higher than a standing one; let go it stops (or coasts); a brute turns
// wide
import { describe, expect, it } from 'vitest';
import { BIKE_DRIVE, BRUTE_DRIVE, KNIGHT_DRIVE, LICH_DRIVE, settleSpeed, stepDrive, type DriveProfile, type V2 } from './drive';
import { FOOT, makeFoot, stepFoot } from './foot';

/** a run-up, then a ramp rising `height` at `slope` rise over run, then a top (the lab's hill station's: terrains.ts HILL) */
const HILL_RAMP = { base: 10, foot: 60, slope: 1.6, height: 1.6 };
const hillRampAt = (x: number) => HILL_RAMP.base + Math.max(0, Math.min(HILL_RAMP.height, (x - HILL_RAMP.foot) * HILL_RAMP.slope));

const dt = 1 / 60;

/** the highest a knight-bodied walker gets up the hill ramp, from `from` cells before its foot, the stick held up it */
function climb(p: DriveProfile, from: number, secs = 6): number {
  const floor = (x: number) => hillRampAt(x);
  const h = (x: number, _y: number) => floor(x);
  const f = makeFoot(HILL_RAMP.foot - from, 5, h);
  const t = { ...FOOT, speed: p.vMax };
  let best = 0;
  for (let k = 0; k < secs / dt; k++) {
    stepFoot(f, [p.vMax, 0], dt, h, null, [400, 20], t, null, p);
    best = Math.max(best, f.z - HILL_RAMP.base);
  }
  return best;
}

describe('the physical drive', () => {
  it('comes to the stick\'s velocity on the flat, never past it', () => {
    let v: V2 = [0, 0];
    let peak = 0;
    for (let k = 0; k < 120; k++) {
      v = stepDrive(v, [1, 0], KNIGHT_DRIVE, [0, 0], dt);
      peak = Math.max(peak, v[0]);
    }
    expect(v[0]).toBeGreaterThan(KNIGHT_DRIVE.vMax * 0.98);
    expect(peak).toBeLessThanOrEqual(KNIGHT_DRIVE.vMax + 1e-9);
    // (half the stick, half the speed)
    v = [0, 0];
    for (let k = 0; k < 240; k++) v = stepDrive(v, [0.5, 0], KNIGHT_DRIVE, [0, 0], dt);
    expect(v[0]).toBeCloseTo(KNIGHT_DRIVE.vMax / 2, 1);
  });

  it('a pull shifts where it settles: downhill faster, uphill slower', () => {
    let down: V2 = [0, 0];
    let up: V2 = [0, 0];
    for (let k = 0; k < 600; k++) {
      down = stepDrive(down, [1, 0], KNIGHT_DRIVE, [10, 0], dt);
      up = stepDrive(up, [1, 0], KNIGHT_DRIVE, [-10, 0], dt);
    }
    expect(down[0]).toBeGreaterThan(KNIGHT_DRIVE.vMax);
    expect(up[0]).toBeCloseTo(settleSpeed(KNIGHT_DRIVE, 10), 0);
  });

  it('let go, it arrests within its brake time; the bike coasts', () => {
    for (const p of [KNIGHT_DRIVE, BRUTE_DRIVE, LICH_DRIVE]) {
      let v: V2 = [p.vMax, 0];
      const t = p.vMax / p.brake;
      for (let k = 0; k < Math.ceil(t / dt) + 1; k++) v = stepDrive(v, [0, 0], p, [0, 0], dt);
      expect(Math.hypot(v[0], v[1])).toBeLessThan(1e-6);
    }
    let v: V2 = [BIKE_DRIVE.vMax, 0];
    for (let k = 0; k < 60; k++) v = stepDrive(v, [0, 0], BIKE_DRIVE, [0, 0], dt);
    expect(v[0]).toBeGreaterThan(BIKE_DRIVE.vMax * 0.75);
  });

  it('an impulse (a lunge) is brought back by the drive with the stick held', () => {
    let v: V2 = [24, 0];
    let t = 0;
    // (the falling push past the top: hard far over it, gentle near it — a lunge carries a little way)
    while (v[0] > KNIGHT_DRIVE.vMax + 0.5 && t < 2) {
      v = stepDrive(v, [1, 0], KNIGHT_DRIVE, [0, 0], dt);
      t += dt;
    }
    expect(t).toBeLessThan(1.2);
    expect(v[0]).toBeGreaterThanOrEqual(KNIGHT_DRIVE.vMax - 1e-6);
  });

  it('the brute turns wide at speed (radius v² / lateral), the knight on a coin', () => {
    const radius = (p: DriveProfile) => {
      let v: V2 = [p.vMax, 0];
      let x = 0;
      let y = 0;
      // (the stick hard across its way: how far it travels sideways before it's going the new way)
      let along = 0;
      for (let k = 0; k < 600 && v[0] > 0.05 * p.vMax; k++) {
        v = stepDrive(v, [0, 1], p, [0, 0], dt);
        x += v[0] * dt;
        y += v[1] * dt;
        along = x;
      }
      return { along, y };
    };
    const b = radius(BRUTE_DRIVE);
    const k = radius(KNIGHT_DRIVE);
    // (it carries on its old way v² / (2 lateral) before it's turned: the brute ~11 cells, the knight ~0.6)
    expect(b.along).toBeGreaterThan(9);
    expect(k.along).toBeLessThan(1);
    expect(b.along).toBeGreaterThan(k.along * 10);
  });

  it('a running start gets higher up the hill ramp than a standing one; from standing the knight can\'t get up it', () => {
    const stand = climb(KNIGHT_DRIVE, 0);
    const run = climb(KNIGHT_DRIVE, 25);
    expect(stand).toBeLessThan(0.6);
    expect(run).toBeGreaterThan(HILL_RAMP.height - 0.05);
    const bStand = climb(BRUTE_DRIVE, 0);
    const bRun = climb(BRUTE_DRIVE, 40);
    expect(bRun).toBeGreaterThan(bStand + 1);
  });
});
