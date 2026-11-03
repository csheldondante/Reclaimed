// ---- api/contracts/playmode.ts ----------------------------------------------------------------------------------
// (round 128b, `playmodes`; docs/design/PLAY_MODES.md) A play mode: how a kind of situation is played — the view
// (a PresentationProfile: zoom, pitch, a turn, the look-ahead, the pull-out with speed), what the stick means in that
// view (controls), what the game does for the player (assists), and how it starts (entry). The user (round 128b): "the
// camera is actually one of the best ways to make the game play better by choosing views and controls that work well
// for the type of encounter" and "the game should decide and take over controls only long enough to transition with
// some brief auto that exits as soon as the player touches things."
//
// Pure data. The course's modes are play/modes/modes.ts; the switch between them (and the hand-back on a touch) is
// ModeSwitcher there; the camera blend is play/modes/blend.ts.

import type { V2 } from './camera';
import type { PresentationProfile } from './presentation';

/**
 * What the stick means.
 *   free     the stick is the way to go (screen-relative), as everywhere today
 *   lane     the route steers; the stick's sideways part moves the hero across the way, its forward part a little
 *            faster or slower (the canyon run)
 *   profile  the hero kept on the route's line; the stick's along-the-route part runs forward or back (a 2D plane:
 *            the side-on woods run)
 */
export type ControlScheme = 'free' | 'lane' | 'profile';

/** What the game does for the player. */
export interface PlayAssists {
  /** the route's way is taken without the stick (lane: always; profile: the hero runs on by itself) */
  autoRun: boolean;
  /** the throttle the route is taken at, 0..1 */
  speed: number;
  /** cells either side of the route the hero may go (lane) */
  laneHalf: number;
}

/** Where the eye is, from the route's way at the hero: behind it, or off its left or right side; null: the profile's own. */
export type Facing = 'behind' | 'left' | 'right' | null;

export interface PlayMode {
  id: string;
  name: string;
  icon: string;
  /** the view; its transition the camera's ease in */
  view: PresentationProfile;
  /** the eye kept behind the hero or side-on to the route (the profile's azimuth set each frame from the way) */
  facing: Facing;
  /**
   * (side views) cells over the hero's floor that everything between the eye and the hero is cut down to — land and
   * trees (the view's canopy cutaway) — so a low view along the way isn't a wall of what's in front; null: no cut
   */
  cut: number | null;
  controls: ControlScheme;
  assists: PlayAssists;
  /** the brief auto on the way in: the game steers this many seconds, or until the player touches the screen */
  entry: { autoSeconds: number };
}

/** The route as a mode's controls see it at the hero (play/course/course.ts Route.nearest). */
export interface RouteHere {
  /** the way along the route (unit) */
  tan: V2;
  /** its left (unit) */
  nrm: V2;
  /** how far left of the route the hero is (cells; − right) */
  off: number;
}
