// ---- present/profiles.ts ----------------------------------------------------------------------------------------
// (round 124, `presentation`; BACKLOG PRE1) The prototypes' presentation profiles, hard-coded as the handoff allows
// ("Hardcoded authored examples are fine"), and the variants the review overlay switches between. Pure data.
//
//   A forest   the birch wood on the atlas: the overworld chase outside, a close isometric view beneath the canopy
//              inside (the tilt kept at 30° for the baseline); visibility, light and transition variants
//   B canyon   the hero lab's ring canyon at speed: the overworld framing against a steeper, route-facing camera
//   C cliff    the hero lab's cliff foot (a labelled proxy for climbing: no hero climbs yet): normal, near-profile,
//              looking down the drop
//   D throne   a separate small interior scene (src/present/throne.ts), entered from a building's doorway

import type { CanopyTreatment, PresentationProfile, TransitionStyle } from '../api/contracts/presentation';

export type SceneId = 'forest' | 'canyon' | 'cliff' | 'throne';

export const SCENES: { id: SceneId; icon: string; name: string; hint: string }[] = [
  { id: 'forest', icon: '🌳', name: 'A · Birch forest', hint: 'canopy to understory: ride into a birch wood on the atlas; visibility, light and transition variants' },
  { id: 'canyon', icon: '🏜', name: 'B · Hoverbike canyon', hint: 'speed and navigation: the overworld framing against a steeper, route-facing camera' },
  { id: 'cliff', icon: '🧗', name: 'C · Cliffside', hint: 'height and danger: normal, near-profile and looking down (a proxy: no hero climbs yet)' },
  { id: 'throne', icon: '👑', name: 'D · Throne room', hint: 'a separate interior entered from a doorway: zoom + dissolve in, petitioners' },
];

/** a profile with nothing changed: the overworld as it is (the chase, the rig's own modes) */
export function baseProfile(id: string, name: string): PresentationProfile {
  return {
    id,
    name,
    camera: { zoom: null, elevation: null, routeFacing: false, lookAhead: 0, speedOut: 0 },
    canopy: { dither: false, cutaway: false, stipple: false, radius: 9, cutHeight: 3, stippleShare: 0.55 },
    light: { dapple: 0 },
    transition: { style: 'zoom', seconds: 1.6 },
  };
}

// ---- A: the birch forest --------------------------------------------------------------------------------------

/** The forest's visibility variants (they combine; `rig` is today's occlusion: the default camera's cut + tilt). */
export type ForestVis = 'rig' | keyof CanopyTreatment;
export const FOREST_VIS: { id: ForestVis; icon: string; label: string; hint: string }[] = [
  { id: 'rig', icon: '✂', label: 'today', hint: "today's occlusion: the default camera's cut + tilt (the baseline)" },
  { id: 'dither', icon: '◎', label: 'dither', hint: 'the canopy round the rider dithered out (a hole that follows the rider on screen)' },
  { id: 'cutaway', icon: '⫠', label: 'cut front', hint: 'the trees between the eye and the rider cut down to a few cells (the far ones whole)' },
  { id: 'stipple', icon: '░', label: 'stipple', hint: 'the upper canopy a fixed see-through stipple, the trunks whole' },
];

export const TRANSITIONS: { id: TransitionStyle; icon: string; label: string; hint: string }[] = [
  { id: 'zoom', icon: '🔍', label: 'zoom', hint: 'a pure continuous zoom; the treatment simply on' },
  { id: 'zoomDither', icon: '◌', label: 'zoom+iris', hint: 'the zoom with the treatment opening as a dithered iris from the rider' },
  { id: 'crossfade', icon: '▒', label: 'zoom+fade', hint: 'the zoom with the treated canopy dissolving in evenly (a dither crossfade)' },
];

/** close in under the canopy: CSS px a cell (the bike's chase is 12-22) */
export const FOREST_ZOOM = 44;

export interface ForestPick {
  vis: ForestVis[];
  light: boolean;
  transition: TransitionStyle;
  zoom: number;
  elevation: number;
  seconds: number;
}

export const FOREST_DEFAULT: ForestPick = { vis: ['rig'], light: false, transition: 'zoom', zoom: FOREST_ZOOM, elevation: 30, seconds: 1.8 };

export function forestProfile(p: ForestPick): PresentationProfile {
  const b = baseProfile('forest', 'A · Birch forest');
  b.camera.zoom = p.zoom;
  // (the baseline keeps the tilt constant: 30° unless the review changes it)
  b.camera.elevation = p.elevation;
  b.canopy.dither = p.vis.includes('dither');
  b.canopy.cutaway = p.vis.includes('cutaway');
  b.canopy.stipple = p.vis.includes('stipple');
  b.canopy.radius = 9;
  b.canopy.cutHeight = 3;
  b.light.dapple = p.light ? 1 : 0;
  b.transition = { style: p.transition, seconds: p.seconds };
  return b;
}

// ---- B: the canyon ----------------------------------------------------------------------------------------------

export type CanyonCam = 'overworld' | 'steep' | 'route' | 'steep+route';
export const CANYON_CAMS: { id: CanyonCam; icon: string; label: string; hint: string }[] = [
  { id: 'overworld', icon: '🗺', label: 'overworld', hint: "the overworld's chase as it is (the default camera: cut + tilt)" },
  { id: 'steep', icon: '⤒', label: 'steep', hint: 'a steeper fixed pitch (55°), speed zoom-out and look-ahead' },
  { id: 'route', icon: '🧭', label: 'route', hint: 'the view turned so the way ahead points up the screen (sprung, rate-limited, a dead zone)' },
  { id: 'steep+route', icon: '🚀', label: 'steep+route', hint: 'both: steeper and route-facing, with look-ahead' },
];

export interface CanyonPick {
  cam: CanyonCam;
  /** speed-dependent zoom and look-ahead (true) or a fixed framing (false) */
  speed: boolean;
  elevation: number;
}
export const CANYON_DEFAULT: CanyonPick = { cam: 'overworld', speed: true, elevation: 55 };

export function canyonProfile(p: CanyonPick): PresentationProfile {
  const b = baseProfile('canyon', 'B · Hoverbike canyon');
  if (p.cam === 'overworld') return b;
  const steep = p.cam === 'steep' || p.cam === 'steep+route';
  b.camera.elevation = steep ? p.elevation : null;
  b.camera.routeFacing = p.cam === 'route' || p.cam === 'steep+route';
  b.camera.zoom = 20;
  b.camera.speedOut = p.speed ? 0.4 : 0;
  b.camera.lookAhead = p.speed ? 0.45 : 0;
  b.transition = { style: 'zoom', seconds: 1.2 };
  return b;
}

// ---- C: the cliff (a proxy) ---------------------------------------------------------------------------------------

export type CliffCam = 'overworld' | 'profile' | 'down';
export const CLIFF_CAMS: { id: CliffCam; icon: string; label: string; hint: string }[] = [
  { id: 'overworld', icon: '🗺', label: 'overworld', hint: "the overworld's camera as it is" },
  { id: 'profile', icon: '◧', label: 'near-profile', hint: 'low (12°), turned side-on to the face: the footholds read, the height reads up the screen' },
  { id: 'down', icon: '⤓', label: 'look down', hint: 'steep (68°) and out over the edge: the drop under the hero' },
];

export function cliffProfile(cam: CliffCam): PresentationProfile {
  const b = baseProfile('cliff', 'C · Cliffside');
  if (cam === 'profile') {
    b.camera.elevation = 12;
    b.camera.zoom = 26;
  } else if (cam === 'down') {
    b.camera.elevation = 68;
    b.camera.zoom = 20;
  }
  b.transition = { style: 'zoom', seconds: 1.2 };
  return b;
}
