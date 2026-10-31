// ---- play/controllers/lich.ts -----------------------------------------------------------------------------------
// The lich as a library entry (round 117): "The lich is a floating wrecking ball power fantasy." Levitation
// (core/levitate.ts: untouched by slopes, wind and blows — the user 2026-10-25, "part of what makes it feel powerful
// is how much it is immune to the forces of the world") and telekinesis, a force push, a storm and a slam. Its profile:
// slow, goes up anything, floats over water and thickets, breaks the most; spectacle and fights.

import type { ControllerInfo, ControllerProfile, ParamSpec, Params } from '../../api/contracts/play';
import { LEVITATE } from '../core/levitate';

export const LICH_DEFAULTS = {
  // the levitation (core/levitate.ts LevitateTuning)
  max: 7,
  accel: 4,
  rise: 5,
  sink: 2.5,
  step: 1.5,
  climb: LEVITATE.climb,
  /** float height: the lowest and highest it's dragged to (cells) */
  floatLow: 1.6,
  floatHigh: 10,
  /** telekinesis: the carry's spring (1/s²) and fastest (cells/s), the blow a smack deals per cell/s */
  carrySpring: 70,
  carryMax: 40,
  carryDamage: 0.35,
  /** a fling's speed (cells/s), its aim cone (radians either side) */
  flingSpeed: 26,
  flingCone: 0.5,
  /** the force push (a flick away with nothing held): reach (cells), shove (cells/s), damage */
  forceReach: 8,
  forcePush: 22,
  forceDamage: 1.5,
  /** the slam (a tap on the lich): crater radius (cells), shockwave reach, shove, throw, damage, cooldown (s) */
  slamCrater: 3,
  slamReach: 7,
  slamPush: 14,
  slamLift: 9,
  slamDamage: 2,
  slamEvery: 1.2,
  /** the storm (draw a circle): seconds, gather reach (cells), wind (cells/s) */
  stormTime: 8,
  stormReach: 7,
  stormWind: 9,
  /** face to face: soul drawn per beat, and the share that heals the lich */
  soulDamage: 1,
  soulHeal: 0.6,
};

export type LichParams = typeof LICH_DEFAULTS;

const P = (id: keyof LichParams, label: string, min: number, max: number, step: number, group: string, help?: string): ParamSpec => ({ id, label, min, max, step, group, help });

export const LICH_PARAMS: ParamSpec[] = [
  P('max', 'speed', 1, 25, 0.5, 'float', 'cells/s'),
  P('accel', 'response', 0.5, 15, 0.5, 'float', '1/s to the stick'),
  P('rise', 'rise ease', 1, 15, 0.5, 'float'),
  P('sink', 'sink ease', 0.5, 10, 0.5, 'float'),
  P('climb', 'cliff climb', 1, 20, 0.5, 'float', 'cells/s up a face'),
  P('floatHigh', 'highest', 2, 30, 1, 'float'),
  P('carrySpring', 'carry spring', 10, 200, 5, 'telekinesis'),
  P('carryMax', 'carry speed', 5, 80, 1, 'telekinesis'),
  P('carryDamage', 'smack damage', 0, 2, 0.05, 'telekinesis'),
  P('flingSpeed', 'fling speed', 5, 60, 1, 'telekinesis'),
  P('flingCone', 'fling aim', 0, 1.2, 0.05, 'telekinesis', 'radians either side it bends to a target'),
  P('forceReach', 'push reach', 2, 20, 0.5, 'force'),
  P('forcePush', 'push shove', 0, 60, 1, 'force'),
  P('slamCrater', 'slam crater', 0, 8, 0.5, 'slam', 'cells; 0: no crater'),
  P('slamReach', 'slam reach', 2, 20, 0.5, 'slam'),
  P('slamPush', 'slam shove', 0, 40, 1, 'slam'),
  P('slamLift', 'slam throw', 0, 30, 1, 'slam'),
  P('slamEvery', 'slam cooldown', 0.2, 5, 0.1, 'slam'),
  P('stormTime', 'storm (s)', 1, 20, 0.5, 'storm'),
  P('stormReach', 'storm reach', 2, 15, 0.5, 'storm'),
  P('soulDamage', 'soul drain', 0, 5, 0.1, 'soul'),
];

export function lichProfile(params: Params = LICH_DEFAULTS): ControllerProfile {
  const p = { ...LICH_DEFAULTS, ...params } as LichParams;
  return {
    speed: { cruise: p.max, top: p.max },
    turnRadius: 0,
    // (it floats up any face at its climb rate, while pushed at it)
    climb: { slope: Infinity, step: Infinity, rate: p.climb, drop: Infinity },
    jump: { height: 0, gap: 0, ramp: false },
    fly: { ceiling: p.floatHigh },
    water: { wade: 0, over: true },
    vegetation: { through: 1, cuts: false },
    body: { mass: 1, height: 2.5 },
    bridge: 0,
    destruction: p.slamCrater > 0 ? 0.9 : 0.5,
    encounters: { race: 0, chase: 0.2, fight: 0.8, spectacle: 1, delve: 0.3, tricks: 0 },
  };
}

export const lich: ControllerInfo = {
  id: 'lich',
  name: 'Lich',
  icon: '💀',
  line: 'Untouched by the world: lift, smash and fling your foes; slam the earth.',
  controls: 'Tap: glide there · tap a foe: float it, again: drain it · drag a foe: swing it, let go: fling · flick away: force push · tap the lich: slam · drag up from the lich: rise · draw a circle: storm',
  params: LICH_PARAMS,
  defaults: LICH_DEFAULTS,
  profile: lichProfile,
};
