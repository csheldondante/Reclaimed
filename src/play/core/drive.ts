// ---- play/core/drive.ts -----------------------------------------------------------------------------------------
// (round 128, the user) One physical drive for the heroes' root motion, a lab variant ("drive: physical") beside each
// hero's own. The user: "velocity based controllers for the root motion that have a max acceleration and max speed and
// where they optionally convert GPE to KE based on acceleration. The joy is treated as desired velocity relative to
// their max so that at zero they attempt to arrest motion but push in a direction and they will solve for max
// acceleration to go that direction ... a running start could help you up a hill ... large characters [with] slower
// acceleration and ... high top speed ... would essentially be stuck charging".
//   want      the stick is the velocity wanted as a share of the top speed (stick 0: stop — or coast, a profile's choice)
//   forward   along the stick, the drive's push falls with speed: a(v) = a0 (1 − v / (stick · vMax)), past the top
//             negative (it holds back), never harder than `brake`: so an outside pull (a slope) moves where it settles
//             — downhill faster, uphill slower, and where the slope's pull beats a0 it can't climb from standing
//   braking   moving against the stick, it slows at `brake`
//   lateral   across its way, it swings its velocity at most `lateral` (the grip): a fast heavy body turns wide
//   outside   accelerations added on top, not hidden in the limits: the slope's pull (gravity along the ground × the
//             profile's `gravity` share — potential into speed and back), drag. Impulses (a lunge, a dodge, a knock, a
//             zip) are velocity added by the caller; the drive brings them back with its own limits.
// Pure; Node-tested (drive.test.ts).

export type V2 = [number, number];

export type DriveProfile = {
  /** cells/s: the top speed on the flat at full stick */
  vMax: number;
  /** cells/s²: the push from standing (falls to 0 at the top speed) */
  a0: number;
  /** cells/s²: slowing against its way (the stick hauled back, or let go when it arrests) */
  brake: number;
  /** cells/s²: swinging its way (the grip): a turn's radius at speed v is v² / lateral */
  lateral: number;
  /** share of gravity's pull along the slope it feels (0: the lich, immune to the world's forces) */
  gravity: number;
  /** 1/s: drag on its speed */
  drag: number;
  /** stick let go: 0 arrests at `brake`, 1 coasts (only drag) */
  coast: number;
};

/** the stick below this is let go */
const DEAD = 0.05;

/**
 * One step: the velocity after `dt` with the stick `stick` (world xy, length 0..1) and outside accelerations `ext`
 * (cells/s²). Returns the new velocity; `v` isn't changed.
 */
export function stepDrive(v: V2, stick: V2, p: DriveProfile, ext: V2, dt: number): V2 {
  let [vx, vy] = v;
  const sl = Math.hypot(stick[0], stick[1]);
  if (sl > DEAD) {
    const s = Math.min(1, sl);
    const dx = stick[0] / sl;
    const dy = stick[1] / sl;
    let par = vx * dx + vy * dy;
    let px = vx - par * dx;
    let py = vy - par * dy;
    const top = Math.max(1e-3, s * p.vMax);
    if (par < 0) {
      // (going the other way: brake first; what's left of the step pushes on)
      const t = Math.min(dt, -par / Math.max(p.brake, 1e-6));
      par += p.brake * t;
      const rest = dt - t;
      if (rest > 0) par = forward(par, top, p, rest);
    } else par = forward(par, top, p, dt);
    // (across its way: the grip swings it, at most `lateral`)
    const pl = Math.hypot(px, py);
    if (pl > 0) {
      const k = Math.max(0, pl - p.lateral * dt) / pl;
      px *= k;
      py *= k;
    }
    vx = par * dx + px;
    vy = par * dy + py;
  } else if (p.coast < 0.5) {
    const sp = Math.hypot(vx, vy);
    if (sp > 0) {
      const k = Math.max(0, sp - p.brake * dt) / sp;
      vx *= k;
      vy *= k;
    }
  }
  const keep = Math.exp(-p.drag * dt);
  vx = vx * keep + ext[0] * dt;
  vy = vy * keep + ext[1] * dt;
  return [vx, vy];
}

/** along the stick: the falling push, a(v) = a0 (1 − v / top), held back no harder than `brake` past the top */
function forward(par: number, top: number, p: DriveProfile, dt: number): number {
  if (par <= top) {
    // (semi-implicit: an exponential approach to the top that can't overshoot it, whatever the step)
    return (par + p.a0 * dt) / (1 + (p.a0 * dt) / top);
  }
  const a = Math.max(-p.brake, p.a0 * (1 - par / top));
  return Math.max(top, par + a * dt);
}

/**
 * The slope's pull on a body on the ground (cells/s²): gravity `g` down the fall line, g sin θ (a slope of rise over
 * run m: g · m / √(1 + m²)), times the profile's share — on the drive's speed as if along the ground, so a push a0
 * can't climb from standing where g · share · sin θ > a0. `grad`: the ground's gradient.
 */
export function slopePull(grad: V2, g: number, share: number): V2 {
  const m2 = grad[0] * grad[0] + grad[1] * grad[1];
  const k = (-g * share) / Math.sqrt(1 + m2);
  return [grad[0] * k, grad[1] * k];
}

/** where the drive settles on a slope pulling `pull` (cells/s², + uphill against it) at full stick: the curve's zero */
export function settleSpeed(p: DriveProfile, pull: number): number {
  return Math.max(0, p.vMax * (1 - pull / p.a0));
}

// ---- the profiles (round 128): starting numbers, sliders in the lab (DRIVE_SPEC) -------------------------------------

/** the knight: snappy — a hard push and a harder brake and grip, top 9 (its run); gravity at 1.2 so a slope steeper
 *  than ~1.25 rise over run (its old walking limit, 1.2) pulls harder than it pushes from standing (g 30) */
export const KNIGHT_DRIVE: DriveProfile = { vMax: 9, a0: 28, brake: 80, lateral: 70, gravity: 1.2, drag: 0, coast: 0 };
/** a heavy brute (a test profile on the knight's body): a weak push, a high top speed, little grip — it charges and
 *  can't turn; from standing it can't climb past ~0.45 rise over run */
export const BRUTE_DRIVE: DriveProfile = { vMax: 14, a0: 7, brake: 14, lateral: 9, gravity: 0.6, drag: 0, coast: 0 };
/** the lich: floaty — a slow push, a soft stop, no slope (the world's forces don't move it) */
export const LICH_DRIVE: DriveProfile = { vMax: 7, a0: 6, brake: 8, lateral: 10, gravity: 0, drag: 0, coast: 0 };
/** the bike: the same drive, a high top, a modest push, a low grip, a brake; stick let go it coasts */
export const BIKE_DRIVE: DriveProfile = { vMax: 22, a0: 30, brake: 45, lateral: 40, gravity: 0.7, drag: 0.2, coast: 1 };
