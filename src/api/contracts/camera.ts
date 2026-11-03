// ---- api/contracts/camera.ts ------------------------------------------------------------------------------------
// (round 121, herolab; BACKLOG CAM1) The camera as variants: a CameraMode takes the hero's pose, its intent, what the
// hero cares about (interests) and the world's sight queries, and gives the view's framing (where it looks, the zoom,
// the turn, the tilt) plus an occlusion treatment (a slice, holes kept open round points). The user (round 120):
// "We have options like rotating the camera or going top down or using dithering or cutting tall objects down to a
// short height above the traversable surface the bike is on. Foreground objects occluding can also be atmospheric if
// it occludes only edges or the bottom or top of the screen. This is all just to point out we need a variety of
// settings to try in different terrains to see what works."
//
// Modes compose: each runs in its stage's order on one CamFrame (the framing first, then the turn, the tilt, the cuts)
// and writes only its own part. Pure data in and out, so every mode runs in Node tests (src/play/camera) and the
// metrics run along an autopilot without a browser; the browser's adapter (play/camera/apply.ts) writes the frame
// into the renderer's Camera (target, zoom, azimuth, elevation, cut).

import type { PresentLook } from './presentation';

export type V2 = [number, number];
export type V3 = [number, number, number];

/** The hero as the camera sees it. */
export interface CamPose {
  /** its feet (world) */
  at: V3;
  /** the ground it's on (cells): the sky floor a hero rides */
  floor: number;
  /** radians, the way it faces (0: +x) */
  heading: number;
  /** its velocity over the ground (cells/s), differenced */
  vel: V2;
  /** 0..1 of its top speed */
  fast: number;
}

/** What the player asks for this frame (the stick over the ground, world xy, 0..1). */
export interface CamIntent {
  move: V2;
}

export type InterestKind = 'hero' | 'ahead' | 'enemy' | 'objective' | 'pickup';

/** A point the camera must keep readable. */
export interface Interest {
  id: string;
  kind: InterestKind;
  /** its base (world): what stands in front of it and over it is what hides it */
  at: V3;
  /** how much it matters (the hero 1) */
  weight: number;
  /** (the way ahead) does it go on (true) or end (false); absent: not a way */
  open?: boolean;
}

/** Where interests come from: the way ahead first; enemies, objectives, pickups slot in as more sources. */
export interface InterestSource {
  readonly id: string;
  interests(pose: CamPose, world: SightWorld): Interest[];
}

/** A vertical cylinder that hides things but isn't in the columns (a tree as the draw lays it out). */
export interface Prop {
  x: number;
  y: number;
  z0: number;
  z1: number;
  r: number;
}

/** What the camera may ask of the world (columns and props), nothing else. */
export interface SightWorld {
  /** the solid in the column at (x, y), bottom up (world z); null off the world */
  solid(x: number, y: number): readonly { z0: number; z1: number }[] | null;
  /** the sky floor at (x, y) (what a hover rides) */
  top(x: number, y: number): number;
  /** props within r of (x, y); absent: none */
  props?(x: number, y: number, r: number): readonly Prop[];
  /**
   * (round 128) the column's top is built (a building, a wall, a street post: concrete, brick, plaster, steel), not
   * land — the auto camera tilts by cliffs, and by buildings only in its town variant; absent: nothing is built
   */
  built?(x: number, y: number): boolean;
  /** nothing is higher than this (world z) */
  readonly ceiling: number;
  /** the world's extent (x cells, y world units) */
  readonly bounds: V2;
}

/** The view's framing. */
export interface CamView {
  /** the world point at the screen's centre */
  target: V3;
  /** px a cell */
  zoom: number;
  /** radians: which way the eye is round the target (π/4 the fixed view) */
  azimuth: number;
  /** radians over the horizon the eye looks down from (30° the fixed view) */
  elevation: number;
  /** CSS px */
  w: number;
  h: number;
  /** px kept clear at each edge (the HUD) */
  margin: number;
}

/** The slice: nothing over z drawn within `radius` (world units on screen) of `at`; 0 the whole view. `rim` cells under the cut are lit as a rim. */
export interface CamSlice {
  z: number;
  at: V2;
  radius: number;
  rim: number;
  /** (round 120: the dithered cut) cells above `z` over which the cut thins out by the dither (0: hard) */
  fade?: number;
  /** ...and the outer share of the radius it thins over (0: a hard edge) */
  fadeR?: number;
  /** (round 120) the bowl: the cut rises `bowl` cells a cell² away from `at` (h = z + bowl·d²); 0: flat */
  bowl?: number;
  /** only what stands between the eye and the hero (never beyond it) */
  nearOnly?: boolean;
  /** only real occluders: what has open air behind it along the eye's line (a slope gentler than the eye's never) */
  occluders?: boolean;
}

/** A hole kept open round a point: what's in front of it and over its base, within r on screen, dithered out. */
export interface CamSee {
  id: string;
  at: V3;
  r: number;
}

export interface CamCut {
  slice: CamSlice | null;
  see: CamSee[];
}

/** Something shown on screen about an interest (the way ahead goes on, or ends). */
export interface CamSignal {
  id: string;
  kind: 'open' | 'dead';
  at: V3;
}

export interface CamFrame {
  view: CamView;
  cut: CamCut;
  signals: CamSignal[];
  /** (round 124, presentation: PRE1) the region's presentation look (the canopy's treatments, the local light); absent: none */
  present?: PresentLook | null;
}

export interface CamContext {
  dt: number;
  pose: CamPose;
  intent: CamIntent;
  interests: Interest[];
  world: SightWorld;
}

/** ('present': round 124, the region presentation prototypes — a mode given to the rig from outside: CameraRig.extra) */
export type CamModeId = 'chase' | 'rotate' | 'tilt' | 'cutaway' | 'cutfade' | 'edge' | 'dither' | 'auto' | 'autocity' | 'present';

/** One camera variant: it reads the frame so far and writes its own part. */
export interface CameraMode {
  readonly id: CamModeId;
  /** run order: framing 0, turn 1, tilt 2, cuts 3+ */
  readonly stage: number;
  /** a new hero or a jump: start from this frame at rest */
  reset(frame: CamFrame): void;
  step(ctx: CamContext, frame: CamFrame): void;
  /** the streamed window slid: what it keeps in window coordinates moves by (dx, dy, dz) */
  shift?(dx: number, dy: number, dz: number): void;
}

/** the renderer's limit on holes (render.wgsl Camera.see) */
export const MAX_SEE = 4;
