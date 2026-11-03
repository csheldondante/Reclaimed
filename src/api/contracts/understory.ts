// The understory contract (round 125, branch `forest`; BACKLOG FLO32; docs/ARCHITECTURE.md "The understory").
//
// The user, verbatim (DECISIONS round 124): "They should be seas of leaves or branches and when we pass under their
// canopy it should be like entering another world. Dither out the leaves and trees that are in the way and make leave
// shadows stencil, make leaves fall from above, have corpuscular rays and leafs on the ground (already in the engine)
// blowing with wind. Make it like a new little world within a world. We are trying to create a seamless transition".
//
// One look, made on the CPU from where the hero is and the trees standing round it (forest/understory.ts, from the
// flora plan: no GPU readback), handed to the renderer (render/camera.ts `understory`: the eye's camera only — the sun's
// shadow pass never sees it, so every leaf still shades) and drawn by the shaders: the trees in the way dithered out,
// the sun through the canopy as leaf-shaped flecks, mist and light shafts, leaves falling from above. Off (weight 0) the
// draw is exactly as before: every treatment multiplies by the weight and the understory's own draw is skipped.
//
// Coordinates: the level's window (x cells, y world units, z cells).

/** Each treatment's strength 0..1 (the lab's switches: on/off pairs for the phone's cost, the user's rule). */
export interface UnderstoryTreatments {
  /**
   * the canopy left out of the eye's draw once under it (the user, verbatim: "I think once it fades you don't need to
   * render the canopy at all", "Just the s shadows and the trunks"): the crowns, limbs and leaves of the trees round the
   * hero dither out as the weight rises and aren't drawn at all once it's whole; their shadows (and the dapple) stay
   */
  canopy: number;
  /** the trees and leaves between the eye and the hero, and the canopy over it, dithered out */
  dither: number;
  /** the sun through the canopy as leaf-shaped flecks on the floor and trunks (a stencil, drifting with the canopy) */
  dapple: number;
  /** light shafts slanting down through the gaps (crepuscular rays), in mist */
  rays: number;
  /** the low mist under the canopy */
  mist: number;
  /** leaves falling from the crowns round the hero */
  leaves: number;
}

export interface UnderstoryLook {
  /** 0 out in the open .. 1 deep under the canopy: every treatment is scaled by it (the transition) */
  weight: number;
  /** the hero (its feet) */
  at: [number, number, number];
  /** the canopy's underside over the hero (cells, z): what's above it is the crown */
  canopyZ: number;
  /** the hole kept open round the hero on screen (world units) */
  radius: number;
  /** the falling leaves' colour (sRGB 0..1): the crowns' over the hero, turned by the season */
  leaf: [number, number, number];
  treatments: UnderstoryTreatments;
}

export const NO_TREATMENTS: UnderstoryTreatments = { canopy: 0, dither: 0, dapple: 0, rays: 0, mist: 0, leaves: 0 };
export const ALL_TREATMENTS: UnderstoryTreatments = { canopy: 1, dither: 1, dapple: 1, rays: 1, mist: 1, leaves: 1 };
