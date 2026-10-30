// ---- hero/walker-pose.ts ----------------------------------------------------------
// The Walker's figure (units/figures.ts FigurePose) from its state: drawn by whoever hosts it (story/hero-run.ts,
// hero/sandbox.ts). Moved out of hero-run.ts in round 112 so the hero sandbox draws it the same way.

import type { FigurePose } from '../units/figures';
import { MAT } from '../world/materials';
import type { Walker } from './walker';

export function walkerPose(h: Walker): FigurePose {
  const sw = h.swingT > 0 ? h.swingT * 2 - 1 : null;
  return {
    at: h.position(),
    heading: h.heading(),
    height: 2.4,
    torso: MAT.Steel,
    head: MAT.Canvas,
    legs: MAT.Asphalt,
    weapon: MAT.Steel,
    phase: h.phase,
    moving: h.pace > 0.3,
    swing: sw,
    lean: sw === null ? 0 : 0.5,
    flash: h.flash > 0 ? Math.min(1, h.flash * 3) : 0,
    dead: !h.alive,
  };
}
