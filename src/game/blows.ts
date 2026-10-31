// What a blow does to the ground (round 120, the user: "dropping the tanker in a stone does not trigger breaking and it
// probably should"). Pure: test/unit/blows.test.ts.
import { TUNE } from '../tune/params';

/** the radius a blow of this energy (½mv²) crumbles hard ground to (0: it holds) — Integrity.groundBlow */
export function groundBlowRadius(energy: number): number {
  const T = TUNE.impact.groundEnergy;
  if (!(energy >= T)) return 0;
  return Math.min(3, 0.8 * Math.cbrt(energy / T));
}
