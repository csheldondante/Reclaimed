// ---- play/controllers/hoverbike.ts ------------------------------------------------------------------------------
// The hoverbike as a library entry (round 117): its parameters (the drive's — core/bike.ts BikeTuning — and its
// weapons'), and the capability profile they give. The user: "For the bike if is going fast, launching off ramps,
// swinging weapons at nearby enemies in front of the bike and I would like to add more later." The profile is derived
// from the numbers, not written beside them, so a tuned bike tells the generators the truth: launch it harder and its
// ramps' gaps grow; give it more thrust and its slaloms tighten.

import type { HeroCamera } from '../../api/contracts/hero';
import type { ControllerInfo, ControllerProfile, ParamSpec, Params } from '../../api/contracts/play';
import { BIKE, type BikeTuning } from '../core/bike';

/** The weapons' and the ram's numbers (heroes/bike.ts reads them from the same Params). */
export const BIKE_WEAPONS = {
  /** the ram: faster than this (cells/s) what it touches is hit, harder the faster */
  ramMin: 8,
  ramDamage: 0.4,
  ramPush: 0.6,
  /** the slash: its blow, its shove, how often (s) */
  slashDamage: 3,
  slashPush: 7,
  /** and the throw up it gives (cells/s): the one cut flies, readable at play zoom */
  slashLift: 5,
  slashEvery: 0.35,
  /** the grappling hook (a tap): its reach (cells; 0: no hook), how long a swing holds (s) and how far round (radians),
   *  and how long a yanked enemy takes to fly in (s) — the user: "Maybe a grappling hook to reel in enemies or do sharp turns" */
  hookRange: 16,
  hookTime: 1.6,
  hookTurn: 3.2,
  hookYank: 0.45,
  /** the planner's help: 0 strict, 1 moderate, 2 forgiving (core/intercept.ts ASSIST) */
  assist: 1,
};

/**
 * (round 118) Faster than the slice's bike — the user, after riding it on the phone: "I want to bike to be faster". Cruise
 * 22 → 32 cells/s, thrust 30 → 46, boost top 32 → 46 (its thrust 45 → 70), downhill top 34 → 50; the drag the same, so it
 * still coasts and carries momentum. The core's BIKE (core/bike.ts, the slice's tested numbers) stays as it was.
 */
export const BIKE_FASTER = { accel: 46, max: 32, limit: 50, boost: 70, boostMax: 46 };

/**
 * (round 120, PL20) The bike's chase camera — the user: "The bike was not really playable because of how zoomed in we
 * are and how little notice for the gates." Wider at rest (34 → 22 px a cell: ~19 cells across a 412 px phone, was 12),
 * and at speed fitted in time (play/core/chase.ts): 0.8 s of travel kept on screen ahead, the centre leading by 0.45 s
 * (at most 0.6 of the way to the edge), out to 12 px a cell. Out at 1.5/s, back in at 0.6/s, the speed it fits smoothed
 * over ~0.7 s: no pumping over bumps and boosts. Numbers and why: DEVLOG round 120.
 */
export const BIKE_CAMERA: HeroCamera = {
  zoom: 22,
  behind: Math.PI / 6,
  firm: Math.PI / 4,
  chase: { lead: 0.45, leadMax: 40, leadShare: 0.6, ahead: 0.8, minZoom: 12, back: 0, follow: 3, zoomOut: 1.5, zoomIn: 0.6, speedEase: 1.5 },
};

export type BikeParams = BikeTuning & typeof BIKE_WEAPONS;
export const BIKE_DEFAULTS: BikeParams = { ...BIKE, ...BIKE_FASTER, ...BIKE_WEAPONS };

const P = (id: keyof BikeParams, label: string, min: number, max: number, step: number, group: string, help?: string): ParamSpec => ({ id, label, min, max, step, group, help });

export const BIKE_PARAMS: ParamSpec[] = [
  P('accel', 'thrust', 5, 160, 1, 'drive', 'cells/s² at full stick'),
  P('max', 'cruise', 5, 90, 1, 'drive', 'cells/s thrust adds speed to'),
  P('limit', 'top (downhill)', 10, 120, 1, 'drive'),
  P('drag', 'drag', 0, 2, 0.05, 'drive'),
  P('coastDrag', 'coast drag', 0, 4, 0.1, 'drive'),
  P('slope', 'slope pull', 0, 1.5, 0.05, 'drive', 'share of gravity along the slope'),
  P('hover', 'ride height', 0.3, 3, 0.1, 'drive'),
  P('gravity', 'gravity', 8, 60, 1, 'air'),
  P('launch', 'launch', 0, 2, 0.05, 'air', 'share of the rise speed it flies off at'),
  P('launchSlope', 'ramp slope', 0.1, 2, 0.05, 'air', 'steeper than this, a bump launches'),
  P('launchMax', 'launch max', 0, 40, 1, 'air', 'cells/s up'),
  P('launchHeight', 'launch height', 0.5, 10, 0.5, 'air'),
  P('carry', 'ramp carry', 0, 1.5, 0.05, 'air', 'share of a climb rise speed it keeps over the lip (0: the old slice drive)'),
  P('boost', 'boost thrust', 0, 220, 1, 'boost'),
  P('boostMax', 'boost top', 10, 120, 1, 'boost'),
  P('boostTime', 'tank (s)', 0.2, 6, 0.1, 'boost'),
  P('refill', 'refill /s', 0, 2, 0.05, 'boost'),
  P('climb', 'climb slope', 0.3, 4, 0.1, 'terrain', 'rise over run it rides up'),
  P('wall', 'wall height', 0.3, 4, 0.1, 'terrain', 'taller and steeper is a barricade'),
  P('crash', 'crash speed', 3, 40, 1, 'terrain', 'into a barricade faster than this, it crashes'),
  P('slideMin', 'slide speed', 3, 30, 1, 'slide', 'faster than this, stick hauled back = Akira slide'),
  P('slideTurn', 'slide turn', 1, 15, 0.5, 'slide', 'rad/s'),
  P('ramMin', 'ram speed', 2, 30, 1, 'weapons'),
  P('ramDamage', 'ram damage', 0, 2, 0.05, 'weapons'),
  P('slashDamage', 'slash damage', 0, 10, 0.5, 'weapons'),
  P('slashPush', 'slash shove', 0, 30, 1, 'weapons'),
  P('slashLift', 'slash throw', 0, 20, 0.5, 'weapons', 'cells/s up: the one cut flies'),
  P('slashEvery', 'slash every (s)', 0.1, 1.5, 0.05, 'weapons'),
  P('hookRange', 'hook reach', 0, 40, 1, 'hook', 'cells; 0: no hook'),
  P('hookTime', 'swing time', 0.2, 4, 0.1, 'hook'),
  P('hookTurn', 'swing angle', 0.5, 6.3, 0.1, 'hook', 'radians round the anchor before it lets go'),
  P('hookYank', 'yank flight', 0.15, 1.5, 0.05, 'hook', 's an enemy takes to fly in'),
  P('assist', 'aim help', 0, 2, 1, 'weapons', '0 strict · 1 moderate · 2 forgiving'),
];

/** What a bike with these numbers can do (the generators' terms). */
export function bikeProfile(params: Params = BIKE_DEFAULTS): ControllerProfile {
  const p = { ...BIKE_DEFAULTS, ...params } as BikeParams;
  const top = Math.max(p.max, p.boostMax);
  // (a launch's best: its cap straight up, so the height it reaches and the flight it carries at top speed)
  // (off a ramp it keeps `carry` of its climb's rise speed, and a steep bump throws it by `launch`: either way at most launchMax)
  const vz = p.launch > 0 || p.carry > 0 ? p.launchMax : 0;
  const air = (2 * vz) / p.gravity;
  return {
    speed: { cruise: p.max, top },
    // (thrust is all the sideways pull it has: v²/a at cruise; the slide cuts it, but that's a trick, not a turn)
    // (the hook swings it round an anchor: a turn as tight as the rope it throws, ~0.4 of its reach)
    turnRadius: p.hookRange > 0 ? Math.min((p.max * p.max) / Math.max(p.accel, 1), Math.max(2, p.hookRange * 0.4)) : (p.max * p.max) / Math.max(p.accel, 1),
    climb: { slope: p.climb, step: p.wall, rate: 0, drop: Infinity }, // (drop: core/bike.ts lands any drop; no fall damage)
    jump: { height: (vz * vz) / (2 * p.gravity), gap: top * air, ramp: true },
    fly: { ceiling: 0 },
    // (it rides the top — the water's surface too)
    water: { wade: 0, over: true },
    // (no flora contract yet: it's meant to be slowed in a thicket, not stopped — round 117 "plants making a barrier
    // (even a soft barrier like slowing you down or requiring you to cut through)")
    vegetation: { through: 0.5, cuts: false },
    bridge: 0,
    destruction: 0.3,
    encounters: { race: 1, chase: p.hookRange > 0 ? 1 : 0.9, fight: p.hookRange > 0 ? 0.7 : 0.6, spectacle: 0.3, delve: 0, tricks: 0.9 },
  };
}

export const hoverbike: ControllerInfo = {
  id: 'hoverbike',
  name: 'Hover rider',
  icon: '🏍️',
  line: 'Fast and loose: launch off crests, slash what you pass, slide to a stop.',
  controls: 'Left thumb: ride · BOOST · swipe on a side of the bike: slash that side · tap a foe: hook it in · tap the ground: swing round it · hold a drag: lance · haul the stick back at speed: slide',
  params: BIKE_PARAMS,
  defaults: BIKE_DEFAULTS,
  profile: bikeProfile,
};
