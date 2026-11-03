// ---- play/controllers/horse.ts ----------------------------------------------------------------------------------
// (round 128, the user) The horse: "A horseback option instead of the hover bike that auto steers around obstacles
// for you and will slow down stop in the canyon or turn around the bend for you if you angle that way." A mount on the
// shared physical drive (core/drive.ts HORSE_DRIVE: top speed between the knight's 9 and the bike's 22) with strong
// assist (core/mount.ts): it follows a bend when the stick is roughly that way, goes round small things, slows into a
// dead end and stops short of a wall; a hard steer is the rider's own. Body: the character generator's quadruped
// (gaits by speed: walk, trot, canter, gallop) and the knight's body as its rider.

import type { HeroCamera } from '../../api/contracts/hero';
import type { SpeciesSpec } from '../../api/contracts/inhabitants';
import type { ControllerInfo, ControllerProfile, ParamSpec, Params } from '../../api/contracts/play';
import { HORSE_DRIVE } from '../core/drive';
import { MOUNT } from '../core/mount';

export const HORSE_DEFAULTS = {
  /** 0..1: how hard the horse helps (core/mount.ts MountAssist.assist) — the lab's assist chips */
  assist: MOUNT.assist,
  /** seconds of speed it looks ahead; degrees: a stick this near the open way takes it; this far off is the rider's */
  look: MOUNT.look,
  cone: MOUNT.cone,
  strong: MOUNT.strong,
  /** cells it stops short of a wall */
  margin: MOUNT.margin,
  /** cells: the tallest step its stride takes; falling (cells/s²) */
  step: 1.1,
  gravity: 30,
  /** (round 128) always the physical drive: the horse has no other (1) */
  drive: 1,
};

export type HorseParams = typeof HORSE_DEFAULTS;

/** the horse's body (the generator's quadruped: long legs, a long neck, a tail) */
export const HORSE_BODY: SpeciesSpec = {
  id: 'horse',
  traits: ['living'],
  plan: 'quadruped',
  seed: 17,
  proportions: { size: 1.6, legs: 1.25, neck: 1.25, head: 1.05, tail: 0.9, girth: 1 },
  palette: { body: '#7a4a2a', belly: '#c89a6a', accent: '#2a1a12', eye: '#101010' },
  secondary: { tailFlex: 0.6 },
  behaviour: { kind: 'wander' },
};

/** between the knight's close view and the bike's wide one; it pulls back with speed */
export const HORSE_CAMERA: HeroCamera = {
  zoom: 30,
  behind: Math.PI / 4,
  chase: { lead: 0.4, leadMax: 14, leadShare: 0.5, ahead: 0.8, minZoom: 18, back: 0, follow: 4, zoomOut: 1.5, zoomIn: 0.8, speedEase: 1.5 },
};

const P = (id: keyof HorseParams, label: string, min: number, max: number, step: number, group: string, help?: string): ParamSpec => ({ id, label, min, max, step, group, help });

export const HORSE_PARAMS: ParamSpec[] = [
  P('assist', 'assist', 0, 1, 0.05, 'assist', '0: the stick as it is; 1: it steers, slows and stops for you'),
  P('look', 'looks ahead', 0.3, 3, 0.1, 'assist', 's of its speed'),
  P('cone', 'takes a bend within', 10, 90, 5, 'assist', 'degrees between the stick and the open way'),
  P('strong', 'hard steer', 30, 150, 5, 'assist', 'degrees off its way: the rider\'s own'),
  P('margin', 'stops short by', 0, 6, 0.25, 'assist', 'cells'),
];

export function horseProfile(params: Params = HORSE_DEFAULTS): ControllerProfile {
  const p = { ...HORSE_DEFAULTS, ...params } as HorseParams;
  return {
    speed: { cruise: HORSE_DRIVE.vMax * 0.7, top: HORSE_DRIVE.vMax },
    turnRadius: (HORSE_DRIVE.vMax * HORSE_DRIVE.vMax) / HORSE_DRIVE.lateral,
    climb: { slope: 1, step: p.step, rate: 0, drop: 4 },
    jump: { height: 0, gap: 0, ramp: false },
    fly: { ceiling: 0 },
    water: { wade: 1.6, over: false },
    vegetation: { through: 0.4, cuts: false },
    body: { mass: 2, height: 3 },
    bridge: 0,
    destruction: 0.1,
    encounters: { race: 1, chase: 1, fight: 0.3, spectacle: 0.4, delve: 0.2, tricks: 0.2 },
  };
}

export const horse: ControllerInfo = {
  id: 'horse',
  name: 'Horse',
  icon: '🐎',
  line: 'A rider on a horse. Point the way and it finds the path.',
  controls: 'Push the stick the way you want to go. The horse steers round rocks, follows bends and stops before walls. Push hard across its way to steer yourself.',
  params: HORSE_PARAMS,
  defaults: HORSE_DEFAULTS,
  profile: horseProfile,
};
