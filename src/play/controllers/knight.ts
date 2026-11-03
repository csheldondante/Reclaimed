// ---- play/controllers/knight.ts ---------------------------------------------------------------------------------
// (knight, round 128) The knight as a library entry: a hero on foot with a sword and a bow. The user (round 127):
// "add a normal on foot hero with a sword and the left joy plus swipe to slash and change weapons in the bottom right
// or activate secondary abilities with a tap. There was a whole project that built this and it was fun. The character
// lunged in the direction you swipe for slashes and aimed slightly towards enemies, they could switch to a bow that
// you draw back in the opposite direction you want to fire which was pretty fun and they had an arcady spin move with
// the blade that let them flick around as a top and bounce of enemies. Faster on foot than the lich by a bit but slower
// than the bike and a Dodge button in the bottom right with the weapon/ability select button."
//
// Where the numbers come from: GameplayGM runtimes/iso-adventure (branch runtime/iso-adventure) — src/sim/data/
// weapons.ts (the sword's combo, lungeSwing and spin; the bow; DODGE), src/sim/lab/momentum.ts SLIDES.spin, src/sim/
// combat.ts (ACCEL 70, FRICTION 14 × 0.6) and src/sim/data/profiles.ts BASE_BODY (hp 12, speed 6). Times are kept as
// they were (they're the feel); distances and speeds are scaled by SCALE = 1.3 (a person there is 0.35 cells across
// the middle, here a unit is 0.45: units/agent-units.ts), except the run, which is set against the other heroes: the
// lich floats at 7 cells/s, the bike cruises at 32 — the knight runs at 9 ("faster than the lich by a bit").
// DEVLOG round 128 has the table.

import type { HeroCamera } from '../../api/contracts/hero';
import type { SpeciesSpec } from '../../api/contracts/inhabitants';
import type { ControllerInfo, ControllerProfile, ParamSpec, Params } from '../../api/contracts/play';

/** GameplayGM iso-adventure's cells → Reclaimed's (a body 0.35 → 0.45 cells: 1.29) */
export const SCALE = 1.3;
const deg = (d: number) => (d * Math.PI) / 180;
const s = (v: number) => +(v * SCALE).toFixed(2);

export const KNIGHT_DEFAULTS = {
  // ---- on foot (core/foot.ts)
  /** the run (cells/s): iso-adventure's 6 × 1.5 — set between the lich (7) and the bike (32) */
  speed: 9,
  accel: 70,
  /** excess speed bled (1/s × speed): iso-adventure's FRICTION 14 × 0.6 */
  friction: 8.4,
  step: 0.9,
  slope: 1.2,
  gravity: 30,
  health: 12,
  // ---- the sword (weapons.ts sword): two light swings and a finisher, each with a lunge forward; a double swipe lunges
  slashWindup: 0.06,
  slashActive: 0.1,
  slashRecovery: 0.16,
  slashRange: s(1.55),
  slashArc: deg(130),
  slashDamage: 2,
  slashKnock: s(6),
  /** (pass 2, round 128: "we want the default lunge to be further") each swing DASHES this far (cells) along its way,
   *  over its active time and the recovery up to the chain (core/slip.ts: through a crowd, not stopped by it); round
   *  128's first pass was iso-adventure's impulse (3.5 × 1.3 cells/s) that friction bled in a few frames: 0.11 cells */
  slashLunge: 1.6,
  finWindup: 0.12,
  finActive: 0.12,
  finRecovery: 0.32,
  finRange: s(1.8),
  finArc: deg(170),
  finDamage: 3,
  finKnock: s(12),
  /** the finisher's dash (cells; first pass: an impulse of 6 × 1.3 cells/s) */
  finLunge: 2.4,
  /** the double swipe's lunge: a dash-strike that way */
  lungeWindup: 0.04,
  lungeActive: 0.16,
  lungeRecovery: 0.24,
  lungeRange: s(1.7),
  lungeArc: deg(100),
  lungeDamage: 3,
  lungeKnock: s(11),
  /** the double swipe's dash (cells; first pass: an impulse of 15 × 1.3 cells/s, which carried 2.5): still the big move */
  lungeSpeed: 4.8,
  /** the share of the dash's way it turns to slip between bodies at most (radians), how far past a body it carries on
   *  rather than end inside it (cells), and the share of a dash's blow knocked along it (the rest aside) */
  slipTurn: deg(14),
  /** a blow a guard blocks knocks the knight back this fast (cells/s) and ends its dash */
  blockRecoil: 6,
  slipExtend: 1.2,
  dashForward: 0.45,
  /** the throw up a blow gives (cells/s; new here: the units fly a little, readable at play zoom) and the stun (s,
   *  the agents' status: they stay down) of a light swing, the finisher and the lunge */
  slashLift: 2,
  slashStun: 0.25,
  finStun: 0.5,
  lungeStun: 0.6,
  /** share of the run kept while swinging (weapons.ts moveMul 0.9: attacking never stops motion) */
  swingMove: 0.9,
  /** the next swing chains once this share of the recovery has passed (combat.ts recovery × 0.4) */
  chainAt: 0.4,
  /** the aim lean (new: core/aim.ts leanAim): a swipe turns toward an enemy within this cone (radians either side) and
   *  range (cells) by this share of the angle off */
  aimCone: deg(35),
  aimRange: 4.5,
  aimLean: 0.35,
  // ---- the spin (weapons.ts sword moves.circle, momentum.ts SLIDES.spin): a spinning top that's flicked about
  spinTime: 4,
  spinRate: 18,
  spinDrag: 0.55,
  spinDecel: 1.6,
  spinBounce: 0.82,
  /** the blade's reach past the body (cells), and how far past the body it caroms off what it meets (new: see
   *  heroes/knight.ts spinStep) */
  spinReach: s(1),
  spinTouch: s(0.6),
  spinDamage: 1,
  spinPerSpeed: 0.08,
  spinKnock: s(6),
  spinKnockPerSpeed: 0.3,
  spinRehit: 0.35,
  spinStun: 0.3,
  /** a flick while spinning: its speed from a short flick to a full one (cells/s), and the spin it keeps going (s) */
  spinFlickLow: s(8),
  spinFlickHigh: s(24),
  spinFlickFuel: 2,
  spinEvery: 0.2,
  /** stick push while spinning (cells/s²; iso-adventure 0) */
  spinSteer: 0,
  // ---- the bow (weapons.ts bow): drawn back, loosed the other way; a full draw takes drawTime
  bowDraw: 0.7,
  bowMin: 0.15,
  arrowSlow: s(11),
  arrowFast: s(32),
  arrowDamageLow: 1,
  arrowDamageHigh: 4,
  arrowKnockLow: s(2),
  arrowKnockHigh: s(13),
  bowMove: 0.5,
  bowEvery: 0.15,
  /** the bow's secondary (weapons.ts bow moves.doubleTap: a volley) */
  volleyArrows: 3,
  volleySpread: 0.32,
  volleyEvery: 0.8,
  // ---- (pass 2, round 128) the jump and the jump attack: the user, "the knight could use a jump button and maybe a tap
  // to lock on to enemies so we can do platforming and moves like a jump attack". GameplayGM iso-adventure has no jump
  // (its dodge roll carried over 2-cell gaps): these are new. Each its own state with its own profile (the user's
  // earlier guidance: "jump variants are separate states, not bonus fields on one jump state").
  /** the jump: up at this (cells/s), pulled down at `jumpRise` going up and `jumpFall` coming down (cells/s²: a quick
   *  fall reads as weight), steered in the air at `jumpSteer` (cells/s²) toward the stick's run. Up 11 at 30: 2 cells
   *  high, so a ledge 2.9 cells up (with the 0.9 step) is reached; 0.37 s up, 0.29 s down */
  jumpUp: 11,
  jumpRise: 30,
  jumpFall: 48,
  jumpSteer: 40,
  /** the jump attack (a swipe in the air): a dive at `plungeSpeed` (cells/s) — onto the enemy the swipe means (or the
   *  locked one) within `plungeReach` cells, else down along the swipe at `plungeAngle` below level; on landing a shockwave of `slamRadius` cells (damage, an outward push, a throw, a stun) and a stomp
   *  on what it lands on; then `plungeLag` s to stand up. From above: a guard's shield doesn't stop it */
  plungeSpeed: 24,
  plungeReach: 5,
  plungeAngle: deg(55),
  plungeLag: 0.28,
  slamRadius: 2,
  slamDamage: 2,
  slamPush: 9,
  slamLift: 4,
  slamStun: 0.7,
  stompDamage: 4,
  // ---- (pass 2) the lock-on: a tap on an enemy (within this many px of its middle on the screen) locks it; it's let go
  // past `lockRange` cells. Locked, slashes within `lockCone` of it go at it, the bow aims at it, a jump attack lands on it
  lockPick: 46,
  lockRange: 18,
  lockCone: deg(75),
  // ---- (pass 2, round 128) the hook gun: the user, "add back in the grapling hook gun". The bike's hook (heroes/hook.ts)
  // carried by the knight: a tap on a foe yanks it in (lobbed to land 1.3 cells short of the knight), a tap on the ground
  // or a ledge zips the knight there (over a gap, water, up a ledge); ✦ fires at the locked enemy
  hookRange: 14,
  hookTime: 1.2,
  hookTurn: Math.PI,
  hookYank: 0.45,
  hookZip: 22,
  // ---- (pass 2) the parry, as variants to compare (the user: "We should also experiment with parrying"): 0 off; 1 a
  // PARRY button — pressed within parryWindow before a blow lands, it's parried; 2 a swipe at an enemy in its wind-up;
  // 3 hold BLOCK — blows from the front (blockArc) are blocked (blockTaken of their knock), and a block begun within
  // parryWindow of the blow parries it. A parried enemy is thrown back and lies parryStagger s: open, whatever its kind.
  // iso-adventure's SHIELD: perfectWindow 0.16 s, arc 130°, moveMul 0.45, knockbackTaken 0.35, the attacker staggered
  // 0.75 s and pushed back 5 cells/s — ported as they were (× 1.3 for the push)
  parryMode: 1,
  parryWindow: 0.16,
  parryStagger: 0.75,
  parryPush: s(5),
  parryEvery: 0.5,
  parryReach: 2.6,
  blockArc: deg(130),
  blockTaken: 0.35,
  blockMove: 0.45,
  // ---- the dodge (weapons.ts DODGE)
  dodgeTime: 0.28,
  dodgeGuard: 0.24,
  dodgeSpeed: s(15),
  dodgeEvery: 0.45,
};

export type KnightParams = typeof KNIGHT_DEFAULTS;

/**
 * Its body, from the character generator (src/inhabitants: a biped's rig, built from this spec as the creatures' are;
 * play/draw/rigpose.ts poses it on the CPU and draws its bones as voxels). A helmet (the hood slot), a cape; the sword
 * and the bow are its own parts, swung by the hero.
 */
export const KNIGHT_BODY: SpeciesSpec = {
  id: 'knight',
  traits: ['living'],
  plan: 'biped',
  seed: 41,
  proportions: { size: 0.95, girth: 1.15 },
  palette: { body: '#6e7880', belly: '#d8c4a4', accent: '#2c2a2c', eye: '#101010' },
  gear: [
    { slot: 'hood', colour: '#8a9298' },
    { slot: 'cape', colour: '#a83a2a' },
  ],
  behaviour: { kind: 'wander' },
};

/**
 * The chase camera: closer than the lich's 30 px a cell (a fight is a few cells across and the swing must read on a
 * phone: ~11 cells across a 412 px screen); at a run it leads a little and keeps ~0.6 s of the run ahead in view, out
 * to 26 px a cell. No pull-back with speed (`back` 0): a lunge's burst mustn't pump the view.
 */
export const KNIGHT_CAMERA: HeroCamera = {
  zoom: 38,
  behind: Math.PI / 4,
  chase: { lead: 0.3, leadMax: 5, leadShare: 0.4, ahead: 0.6, minZoom: 26, back: 0, follow: 6, zoomOut: 1.5, zoomIn: 1, speedEase: 2 },
};

const P = (id: keyof KnightParams, label: string, min: number, max: number, step: number, group: string, help?: string): ParamSpec => ({ id, label, min, max, step, group, help });

export const KNIGHT_PARAMS: ParamSpec[] = [
  P('speed', 'run', 3, 20, 0.5, 'foot', 'cells/s at full stick'),
  P('accel', 'grip', 10, 150, 5, 'foot', 'cells/s² to the stick'),
  P('friction', 'bleed', 1, 20, 0.2, 'foot', 'how fast a lunge or a knock stops'),
  P('step', 'step up', 0.2, 2, 0.1, 'foot', 'cells'),
  P('slope', 'steepest', 0.3, 3, 0.1, 'foot', 'rise over run it walks up'),
  P('slashRange', 'reach', 1, 4, 0.05, 'sword'),
  P('slashArc', 'arc', 0.5, 3.2, 0.05, 'sword', 'radians'),
  P('slashDamage', 'damage', 0, 6, 0.5, 'sword'),
  P('slashKnock', 'knock', 0, 30, 0.5, 'sword', 'cells/s'),
  P('slashLunge', 'swing lunge', 0, 5, 0.1, 'sword', 'cells each swing dashes'),
  P('finDamage', 'finisher damage', 0, 8, 0.5, 'sword'),
  P('finKnock', 'finisher knock', 0, 40, 0.5, 'sword'),
  P('finLunge', 'finisher lunge', 0, 6, 0.1, 'sword', 'cells'),
  P('lungeSpeed', 'double-swipe lunge', 0, 10, 0.1, 'sword', 'cells'),
  P('slipTurn', 'slip turn', 0, 0.6, 0.02, 'sword', 'radians a dash turns to slip between bodies'),
  P('dashForward', 'knock ahead', 0, 1.5, 0.05, 'sword', 'share of a dash blow knocked ahead (the rest aside)'),
  P('lungeDamage', 'lunge damage', 0, 8, 0.5, 'sword'),
  P('swingMove', 'run while swinging', 0, 1, 0.05, 'sword'),
  P('aimCone', 'aim cone', 0, 1.2, 0.05, 'aim', 'radians either side a swipe looks for an enemy'),
  P('aimRange', 'aim range', 0, 10, 0.5, 'aim', 'cells'),
  P('aimLean', 'aim lean', 0, 1, 0.05, 'aim', 'share of the angle turned toward it'),
  P('spinTime', 'spin time', 0.5, 8, 0.1, 'spin', 's'),
  P('spinBounce', 'bounce', 0, 1.2, 0.02, 'spin', 'speed kept off an enemy or a wall'),
  P('spinReach', 'blade reach', 0, 3, 0.05, 'spin'),
  P('spinTouch', 'bounce reach', 0, 3, 0.05, 'spin', 'cells past the body it caroms off an enemy'),
  P('spinFlickLow', 'flick low', 0, 40, 0.5, 'spin', 'cells/s'),
  P('spinFlickHigh', 'flick high', 0, 60, 0.5, 'spin', 'cells/s'),
  P('spinDrag', 'spin drag', 0, 3, 0.05, 'spin'),
  P('spinSteer', 'spin steer', 0, 40, 1, 'spin', 'stick push while spinning'),
  P('bowDraw', 'full draw (s)', 0.1, 2, 0.05, 'bow'),
  P('arrowFast', 'arrow speed', 5, 80, 1, 'bow', 'cells/s at full draw'),
  P('arrowDamageHigh', 'arrow damage', 0, 8, 0.5, 'bow', 'at full draw'),
  P('arrowKnockHigh', 'arrow knock', 0, 30, 0.5, 'bow'),
  P('bowMove', 'run while drawing', 0, 1, 0.05, 'bow'),
  P('volleyArrows', 'volley', 1, 9, 1, 'bow', 'arrows'),
  P('jumpUp', 'jump', 4, 20, 0.5, 'jump', 'cells/s up'),
  P('jumpFall', 'fall', 10, 90, 1, 'jump', 'cells/s² coming down'),
  P('jumpSteer', 'air steer', 0, 100, 2, 'jump', 'cells/s² in the air'),
  P('plungeSpeed', 'dive', 8, 40, 1, 'jump', 'the jump attack, cells/s'),
  P('slamRadius', 'slam reach', 0.5, 5, 0.1, 'jump', 'cells'),
  P('hookRange', 'hook range', 4, 30, 0.5, 'hook', 'cells'),
  P('hookZip', 'zip speed', 5, 50, 1, 'hook', 'cells/s'),
  P('parryMode', 'parry variant', 0, 3, 1, 'parry', '0 off, 1 button, 2 swipe in its wind-up, 3 hold to block'),
  P('parryWindow', 'parry window', 0.05, 0.5, 0.01, 'parry', 's'),
  P('parryStagger', 'stagger', 0.1, 2, 0.05, 'parry', 's it lies open'),
  P('dodgeSpeed', 'dodge speed', 5, 40, 0.5, 'dodge'),
  P('dodgeTime', 'dodge time', 0.1, 0.8, 0.02, 'dodge'),
  P('dodgeEvery', 'dodge cooldown', 0, 2, 0.05, 'dodge'),
];

/** What a knight with these numbers can do (the generators' terms). */
export function knightProfile(params: Params = KNIGHT_DEFAULTS): ControllerProfile {
  const p = { ...KNIGHT_DEFAULTS, ...params } as KnightParams;
  return {
    // (downhill it runs a little faster: core/foot.ts's ×1.15)
    speed: { cruise: p.speed, top: p.speed * 1.15 },
    turnRadius: 0,
    climb: { slope: p.slope, step: p.step, rate: 0, drop: 6 },
    jump: { height: 0, gap: 0, ramp: false },
    fly: { ceiling: 0 },
    water: { wade: 1.2, over: false },
    // (the sword cuts a way through brush)
    vegetation: { through: 0.5, cuts: true },
    body: { mass: 1.2, height: 1.9 },
    bridge: 0,
    destruction: 0.2,
    encounters: { race: 0, chase: 0.4, fight: 1, spectacle: 0.3, delve: 1, tricks: 0.3 },
  };
}

export const knight: ControllerInfo = {
  id: 'knight',
  name: 'Knight',
  icon: '🗡️',
  line: 'On foot with a sword and a bow. Slash, lunge, spin and shoot.',
  controls: 'Run with your left thumb. Swipe to slash. Swipe twice fast to lunge. Draw a circle to spin. Pull back the bow and let go to shoot. The buttons dodge, switch weapons and spin.',
  params: KNIGHT_PARAMS,
  defaults: KNIGHT_DEFAULTS,
  profile: knightProfile,
};
