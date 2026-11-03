// ---- play/input/types.ts --------------------------------------------------------------------------------------
// Layer A's output, in the world (ported from GameplayGM runtimes/hoverbike/src/units/common.ts, round 117): what the
// thumbs did this frame, already on the ground through the camera. What it MEANS is each hero's (its intents and
// planners: core/intent.ts) — the user's "mapping gesture to intent to toleranced assisted action" (D-r97). Pure data,
// so the heroes run in Node tests from scripted inputs.

import type { Pt } from '../core/gestures';

/** The right thumb held: in the world, from where it went down. */
export interface Drag {
  from: Pt;
  at: Pt;
  /** the way it's dragged over the ground (unit; [0, 0] before it moves) and how far, 0..1 of a full drag */
  dir: Pt;
  extent: number;
  /** how far up the screen it's dragged (px; down is negative) */
  up: number;
  /** it went down on the hero itself */
  self: boolean;
  /** where it went down and where it is now, on the screen (px) */
  screen: Pt;
  screenAt: Pt;
}

/** A gesture let go this frame, in the world. */
export type Act =
  | { kind: 'tap'; at: Pt; screen: Pt; self: boolean }
  | { kind: 'flick'; from: Pt; /** over the ground, unit */ dir: Pt; /** 0..1 */ power: number; screen: Pt; self: boolean }
  | { kind: 'circle'; centre: Pt; ccw: boolean; turns: number };

/**
 * (knight, round 128) The right thumb's stroke as drawn so far, on the screen (px, s): for a hero that reads a stroke
 * while it's drawn (the knight's swipe strikes the moment it's long enough, no lift needed — core/swordplay.ts). The
 * samples are the stroke's own (moves under 2 px dropped); `ended`: let go this frame (its last sample is the lift).
 */
export interface Thumb {
  /** the same number every frame of one stroke */
  id: number;
  samples: readonly { at: Pt; t: number }[];
  ended: boolean;
  /** when it was let go (s; the last sample can be older: a thumb held still before it lifts adds none) */
  endedAt?: number;
}

export interface PlayInput {
  /** the wanted direction over the ground (world xy, length 0..1) */
  dir: Pt;
  /** each of its buttons held (or pressed since the last frame) */
  buttons: boolean[];
  drag: Drag | null;
  acts: Act[];
  /** (knight) the strokes drawn this frame (the one held, and any let go since the last), on the screen */
  thumbs?: Thumb[];
  /** (knight) a screen step (px) as a ground step: the ground vectors of screen +x and +y (the camera's, this frame) */
  basis?: [Pt, Pt];
}

export const NO_INPUT: PlayInput = { dir: [0, 0], buttons: [], drag: null, acts: [] };

/** (knight) a screen direction on the ground through `basis`, unit length (or [0, 0]) */
export function onGround(basis: [Pt, Pt], d: Pt): Pt {
  const x = basis[0][0] * d[0] + basis[1][0] * d[1];
  const y = basis[0][1] * d[0] + basis[1][1] * d[1];
  const l = Math.hypot(x, y);
  return l > 0 ? [x / l, y / l] : [0, 0];
}

/** A hero's button, as the controls draw it. */
export interface PadButton {
  icon: string;
  name: string;
  /** held (kept down) rather than pressed */
  held?: boolean;
}

/** How a hero is played: a stick or not, its buttons, a hint. */
export interface Pad {
  /** 'stick': a floating stick under the left thumb; 'none': it goes where it's tapped (its gestures say so) */
  move: 'stick' | 'none';
  buttons: PadButton[];
  hint: string;
}

/** A button's state as drawn: a gauge round it (0..1: a charge, a cooldown), lit (a mode on). */
export interface ButtonLook {
  gauge?: number;
  lit?: boolean;
  /** (knight) its icon and name now (the weapon in hand), when they change with the hero's state */
  icon?: string;
  name?: string;
}
