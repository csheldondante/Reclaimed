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
    camera: { zoom: null, elevation: null, azimuth: null, routeFacing: false, lookAhead: 0, speedOut: 0 },
    canopy: { dither: false, cutaway: false, stipple: false, radius: 9, cutHeight: 3, stippleShare: 0.55 },
    light: { dapple: 0 },
    transition: { style: 'zoom', seconds: 1.6 },
    scale: { hero: 1, trees: 1, thin: 0 },
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

/**
 * (the user, round 124: "If a cell is 1-2M the villager agents are closer to the true size the PC should be ... if the
 * PC was approximately .25-1 trunk width") the scale variants, draw only: today's; the hero at the villagers' size
 * (the lich 2.0 cells tall against their 1.4-1.5: x0.7); and the birches near it twice as big (a trunk ~1.2 cells,
 * two villager widths), half of them left out so the stand stays open; and with stumps: the trunks in front of the
 * hero cut low (0.8 cells), the rest of the wood whole.
 */
export type ForestScale = 'game' | 'true' | 'trees' | 'stumps';
export const FOREST_SCALES: { id: ForestScale; icon: string; label: string; hint: string }[] = [
  { id: 'game', icon: '1', label: 'today', hint: 'the hero as it is drawn today (the lich 2 cells tall)' },
  { id: 'true', icon: '↓', label: 'true', hint: "the hero at the villagers' true size (x0.7)" },
  { id: 'trees', icon: '🌲', label: '+trees', hint: 'true size, and the birches near it twice as big, half of them left out' },
  { id: 'stumps', icon: '🪵', label: '+stumps', hint: 'true size, bigger birches, and the trunks in front of the hero cut low as stumps' },
];
export const HERO_TRUE = 0.7;

export interface ForestPick {
  scale: ForestScale;
  vis: ForestVis[];
  light: boolean;
  transition: TransitionStyle;
  zoom: number;
  elevation: number;
  seconds: number;
}

export const FOREST_DEFAULT: ForestPick = { scale: 'game', vis: ['rig'], light: false, transition: 'zoom', zoom: FOREST_ZOOM, elevation: 30, seconds: 1.8 };

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
  if (p.scale !== 'game') b.scale.hero = HERO_TRUE;
  if (p.scale === 'trees' || p.scale === 'stumps') b.scale = { hero: HERO_TRUE, trees: 2, thin: 0.5 };
  if (p.scale === 'stumps') {
    b.canopy.cutaway = true;
    b.canopy.cutHeight = 0.8;
  }
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
  // (the face looks south, -y: the eye from the south, -90°, to see the face square on)
  if (cam === 'profile') {
    b.camera.elevation = 12;
    b.camera.azimuth = -90;
    b.camera.zoom = 18;
  } else if (cam === 'down') {
    b.camera.elevation = 68;
    b.camera.azimuth = -90;
    b.camera.zoom = 16;
  }
  b.transition = { style: 'zoom', seconds: 1.2 };
  return b;
}

// ---- D: the throne room -------------------------------------------------------------------------------------------

/** how the hall is entered from its door: the handoff's "direct zoom into existing building geometry" against "zoom +
 *  dither/dissolve into the distinct interior", and "a short occlusion/loading transition as fallback" */
export type ThroneEntry = 'zoom' | 'iris' | 'fade' | 'cut';
export const THRONE_ENTRIES: { id: ThroneEntry; icon: string; label: string; hint: string }[] = [
  { id: 'zoom', icon: '🔍', label: 'zoom only', hint: "a direct zoom into the building's own geometry at the door (no interior)" },
  { id: 'iris', icon: '◌', label: 'zoom+iris', hint: 'the zoom into the door, the hall dissolving in from the door outward' },
  { id: 'fade', icon: '▒', label: 'zoom+fade', hint: 'the zoom into the door, the hall dissolving in evenly' },
  { id: 'cut', icon: '■', label: 'cut', hint: 'a short dark cut (the loading fallback)' },
];

export function throneProfile(entry: ThroneEntry): PresentationProfile {
  const b = baseProfile('throne', 'D · Throne room');
  b.camera.zoom = entry === 'zoom' ? 150 : 90;
  b.camera.elevation = 30;
  b.transition = { style: 'zoom', seconds: entry === 'cut' ? 0.3 : 1.1 };
  return b;
}
