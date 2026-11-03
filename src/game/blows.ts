// What a blow does to the ground (round 120, the user: "dropping the tanker in a stone does not trigger breaking and it
// probably should"). Pure: test/unit/blows.test.ts.
import { TUNE } from '../tune/params';

/** the radius a blow of this energy (½mv²) crumbles hard ground to (0: it holds) — Integrity.groundBlow */
export function groundBlowRadius(energy: number): number {
  const T = TUNE.impact.groundEnergy;
  if (!(energy >= T)) return 0;
  return Math.min(3, 0.8 * Math.cbrt(energy / T));
}

/** How soft a loose ground is to a blow (world/materials.ts: the GPU's table has it too). */
export { softnessOf } from '../world/materials';

/**
 * How deep a blow of this energy (½mv²) on ground this soft sinks a body whose footprint is `reach` cells round (its
 * centre's): impact.softSink · softness · ∛E over the footprint's side, at most 3 cells; under 0.15, none.
 */
export function sinkDepth(energy: number, softness: number, reach: number): number {
  if (!(softness > 0) || !(energy > 0)) return 0;
  const d = Math.min(3, (TUNE.impact.softSink * softness * Math.cbrt(energy)) / Math.max(1, reach * Math.sqrt(Math.PI)));
  return d < 0.15 ? 0 : d;
}

/** what the displaced ground becomes: a share sprayed up (impact.spray), the rest a rim round the dent — all of it */
export function splitDisplaced(removed: number): { spray: number; rim: number } {
  const spray = removed * TUNE.impact.spray;
  return { spray, rim: removed - spray };
}
