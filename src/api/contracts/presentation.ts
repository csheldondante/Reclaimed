// ---- api/contracts/presentation.ts ------------------------------------------------------------------------------
// (round 124, `presentation`; BACKLOG PRE1, docs/design/REGION_PRESENTATION.md) Region presentation: how a place is
// shown when the hero is in it — the camera's framing (zoom, pitch, a route-facing turn, look-ahead), what is left out
// of the draw so the hero reads (the canopy's treatments), the local light, and how the change in and out is made (the
// transition). The user's handoff: "Create a lightweight presentation profile for each prototype ... Hardcoded authored
// examples are fine; don't prematurely proceduralize selection."
//
// A profile is pure data. The camera mode `present` (src/present/mode.ts) blends it in by a weight 0..1 as the hero
// enters its region and writes the frame's `present` look (CamFrame.present); the browser's adapter writes that into
// the renderer's camera uniform (render.wgsl Camera.present*). Nothing here removes anything from the world: a canopy
// dithered out is still in the simulation, the wind, the sight queries and the sun's shadow map.

import type { V2, V3 } from './camera';

/** The canopy's treatments (they combine). */
export interface CanopyTreatment {
  /** the canopy round the hero on screen dithered out (a hole that follows the hero) */
  dither: boolean;
  /** the trees standing between the eye and the hero cut down to `cutHeight` over the hero's floor (the far ones whole) */
  cutaway: boolean;
  /** the upper canopy drawn as a fixed screen-space stipple (faint, see-through), the trunks whole */
  stipple: boolean;
}

export type TransitionStyle =
  /** the zoom eases in; the treatment is simply on with it */
  | 'zoom'
  /** the zoom eases in and the treatment opens as a dithered iris from the hero outward */
  | 'zoomDither'
  /** the zoom eases in and the treated canopy dissolves in evenly over the whole screen (a dither crossfade) */
  | 'crossfade';

export interface PresentationProfile {
  id: string;
  name: string;
  camera: {
    /** CSS px a cell at full weight (the overworld chase's own zoom outside); null: the chase's */
    zoom: number | null;
    /** degrees over the horizon at full weight; null: whatever the rig's modes gave (30° the fixed view) */
    elevation: number | null;
    /** degrees round the target the eye is at full weight (C: facing a cliff's face); null: the rig's own */
    azimuth: number | null;
    /** turn the view so the way the hero is going points up the screen (B: the canyon's route-facing camera) */
    routeFacing: boolean;
    /** seconds of the hero's velocity the screen's centre leads by (0: the chase's own lead) */
    lookAhead: number;
    /** zoom out with speed: the zoom times (1 − speedOut × fast) (0: fixed framing) */
    speedOut: number;
  };
  canopy: CanopyTreatment & {
    /** the hole's radius round the hero (cells on screen) */
    radius: number;
    /** the foreground cut's height over the hero's floor (cells) */
    cutHeight: number;
    /** the stipple's share left out, 0..1 */
    stippleShare: number;
  };
  /** local light and detail (0 off .. 1 full) */
  light: {
    /** sun flecks under the canopy, drifting with the wind; a deeper understory shade round them */
    dapple: number;
  };
  transition: { style: TransitionStyle; seconds: number };
  /**
   * (the user, round 124: "the PC was approximately .25-1 trunk width") scale as presented — draw only: the hero's
   * body, reach and framing, the trees' sight and shadows stay as they are
   */
  scale: {
    /** the hero drawn at this size (0.7: the villagers' true size) */
    hero: number;
    /** the birches drawn this much bigger round their foot, near the hero */
    trees: number;
    /** the share of the birches left out where they're bigger (the stand thinned so its spacing stays open) */
    thin: number;
  };
}

/** Where a profile applies: a disc, its weight 1 inside `radius` and falling to 0 over `edge` cells beyond it. */
export interface PresentRegion {
  id: string;
  centre: V2;
  radius: number;
  edge: number;
}

/** What the renderer is given each frame (render/camera.ts writes it into Camera.present*). */
export interface PresentLook {
  /** the hero's feet (world) and the floor it's on */
  at: V3;
  floor: number;
  canopy: CanopyTreatment;
  /** the hole's radius (cells on screen) */
  radius: number;
  cutHeight: number;
  stippleShare: number;
  /** how far the treatment is in, 0..1 (the region's weight through the transition) */
  weight: number;
  /** the transition's spatial form: 0 a radial iris from the hero, 1 an even dissolve */
  even: number;
  dapple: number;
  /** the region's reach (cells round `at`) for the light */
  reach: number;
  /** the birches' scale and thinning near the hero (1, 0: as they are) */
  treeScale: number;
  thin: number;
}
