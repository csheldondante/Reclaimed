// (round 111, BACKLOG TG1–TG7) The noise lab's built-in recipes: three of the atlas's biomes rebuilt from layers
// (their numbers from atlas/regions.ts and compose.wgsl — the same noises, scales and amplitudes; approximations of
// what the atlas composes, not its output) and the user's round-111 ideas as experiments. A recipe is a tuning
// preset: the values that differ from the defaults (params.ts), so each reads as the layers it turns on.

import type { Preset } from '../tune/registry';
import { GEN, MATS, OP, SHAPE, TARGET, XFORM, ZREF, type LayerKey } from './params';

const M = (name: string) => MATS.findIndex((m) => m[0] === name);
type LayerSet = Partial<Record<LayerKey, number>>;

function recipe(lab: Record<string, number>, layers: LayerSet[]): Preset {
  const p: Preset = {};
  for (const [k, v] of Object.entries(lab)) p[`lab.${k}`] = v;
  layers.forEach((L, i) => {
    p[`L${i + 1}.on`] = 1;
    for (const [k, v] of Object.entries(L)) p[`L${i + 1}.${k}`] = v as number;
  });
  return p;
}

const C = { cx: 128, cy: 111 };

export const PRESETS: Record<string, Preset> = {
  // a blank stack: gentle fbm over the sea
  'blank: rolling ground': recipe({ base: 14, sea: 10 }, [{ gen: GEN.fbm, scale: 90, oct: 5, amp: 8 }]),

  // (regions.ts range: base 30–44 over the sea, rough 6–10 at scale 80–130, ridge 40–64 at 1.6 × the scale; a
  // smooth edge into plains)
  'atlas: range': recipe({ base: 14, sea: 10, topMat: M('stone'), cliffMat: M('stone'), snowZ: 96, cliffSlope: 1.6 }, [
    { gen: GEN.sdf, mode: 0, ...C, size: 80, warp: 0.6, scale: 60, shape: SHAPE.threshold, lo: 0, soft: 45, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.fbm, scale: 105, oct: 5, amp: 7 },
    { gen: GEN.ridge, scale: 168, oct: 5, amp: 58, mask: 1 },
    { gen: GEN.constant, amp: 24, mask: 1 },
  ]),

  // (compose.wgsl mesaEdge, round 78: a plateau's edge as tiers of walls by the distance onto the high side,
  // shelves of Voronoi cells ~10 across stepping as the tiers do, buttes standing off the foot, ravines cut back
  // into it; regions.ts mesa: sand on sandstone)
  'atlas: mesa cliffs': recipe({ base: 14, sea: 0, topMat: M('sand'), rockMat: M('sandstone'), cliffMat: M('sandstone'), bandMat: M('stone'), bandH: 4, cliffSlope: 1.2 }, [
    { gen: GEN.mesas, mode: 1, scale: 70, size: 150, share: 0.45, jitter: 0.9, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.mask, src: 1, shape: SHAPE.band, lo: -90, hi: -8, soft: 4, amp: 1, op: OP.set, target: TARGET.m2 },
    { gen: GEN.mesas, mode: 1, scale: 70, size: 150, share: 0.45, jitter: 0.9, cellQ: 10, shape: SHAPE.tiers, lo: 0, hi: 22, soft: 1.2, steps: 4, amp: 46 },
    { gen: GEN.spires, scale: 46, share: 0.4, radius: 0.26, jitter: 0.8, amp: 30, offset: 14, op: OP.max, mask: 2 },
    { gen: GEN.fbm, scale: 140, oct: 3, shape: SHAPE.band, lo: -0.05, hi: 0.05, soft: 0.03, amp: 1, op: OP.set, target: TARGET.m3 },
    { gen: GEN.constant, amp: 16, op: OP.min, mask: 3 },
    { gen: GEN.fbm, scale: 22, oct: 3, amp: 1.5 },
  ]),

  // (regions.ts hills: base 8–16, rough 7–12 at scale 70–130, a little ridge, terraced edges; caves as
  // atlas/columns.wgsl caveVoids makes them: tunnels where a noise is near zero, chambers where another is high,
  // their floor under the surface)
  'atlas: hills, terraces, caves': recipe({ base: 22, sea: 12, caveRoof: 3 }, [
    { gen: GEN.fbm, scale: 100, oct: 5, amp: 11 },
    { gen: GEN.ridge, scale: 160, oct: 5, amp: 4 },
    { gen: GEN.fbm, scale: 200, oct: 2, shape: SHAPE.threshold, lo: 0.1, soft: 0.05, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.height, shape: SHAPE.stairs, lo: 0, hi: 96, steps: 16, amp: 1, op: OP.set, mask: 1 },
    { gen: GEN.fbm, scale: 40, oct: 2, shape: SHAPE.band, lo: -0.06, hi: 0.06, soft: 0.03, amp: 5, op: OP.set, target: TARGET.ch },
    { gen: GEN.fbm, scale: 64, oct: 2, shape: SHAPE.threshold, lo: 0.4, soft: 0.08, amp: 10, op: OP.max, target: TARGET.ch },
    { gen: GEN.height, amp: 1, offset: -13, op: OP.set, target: TARGET.cf },
  ]),

  // TG2 (the user: "a voronoi at the atlas scale and group several cells to define the mesa region, then choose
  // heights of different edges with some zero and blend height to the full mesa height and use the ridge noise to
  // carve winding ravines in that"): grouped cells, a third of their outer edges ramps; ridge-noise ravines cut to
  // the plain — traversable, a flash flood's path
  'TG2: mesas, ramps, ravines': recipe({ base: 10, sea: 6, topMat: M('sand'), rockMat: M('sandstone'), cliffMat: M('sandstone'), bandMat: M('stone'), bandH: 3, cliffSlope: 1.3 }, [
    { gen: GEN.mesas, mode: 0, scale: 90, size: 220, share: 0.45, share2: 0.35, blend: 50, jitter: 0.85, amp: 48 },
    { gen: GEN.ridge, scale: 120, oct: 2, shape: SHAPE.threshold, lo: 0.86, soft: 0.05, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.constant, amp: 10.5, op: OP.set, mask: 1 },
    { gen: GEN.fbm, scale: 18, oct: 3, amp: 1.5 },
  ]),

  // TG3 (the user: "have these along coasts and make coastal caves enter there so we can see them from the ocean
  // using the 2d fractal simplex with two thresholds and blending the height of the caves relative to the surface
  // and bringing them to just below the water level at the coast"), rebuilt in round 112 (TG10) on the user's recipe:
  // "Take a simplex fractal noise in 2d and set a threshold so that they are windy and the width you want (gap
  // between the threshold) you can use JFA to find the narrow points if you want to measure in tuning. Then make the
  // caves interpolate from the bottom of the cliff height at the beach to any intermediary value plus noise inside the
  // cliff layers. For the cave shape just use JFA and take distance form the edge squared or something with noise and
  // make noise lower on the floor so it is walkable." Land to the west, a sheer sea cliff; M2 the coast (1 at the
  // shoreline, 0 thirty cells in, by the JFA distance off the sea's contour); M3 the passages, a band of fractal noise
  // between two thresholds; the carve: the JFA distance in from the passages' edge d, the roof d² over a base that runs
  // from just under the sea at the cliff's foot to 11 under the plateau, the floor with a quarter of the roof's noise
  'TG3: coastal mesas, sea caves': recipe({ base: 2, sea: 14, topMat: M('sand'), rockMat: M('sandstone'), cliffMat: M('sandstone'), bandMat: M('stone'), bandH: 3, cliffSlope: 1.6, caveRoof: 2, caveMin: 2 }, [
    { gen: GEN.sdf, mode: 1, cx: 40, cy: 111, size: 120, size2: 300, warp: 0.45, scale: 46, shape: SHAPE.threshold, lo: 0, soft: 1.5, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.constant, amp: 30, mask: 1 },
    { gen: GEN.mesas, mode: 0, scale: 60, size: 160, share: 0.45, share2: 0.3, blend: 26, jitter: 0.85, amp: 18, mask: 1 },
    { gen: GEN.fbm, scale: 16, oct: 2, amp: 1, mask: 1 },
    { gen: GEN.jfa, src: 0, level: 14, shape: SHAPE.threshold, lo: 15, soft: 15, amp: -1, offset: 1, op: OP.set, target: TARGET.m2 },
    // (round 117, revive: at round 112's scale — passages ~4 cells wide, vaults 7, the floor under the sea — the mouths
    // were 2-5 cells high under a 32-cell cliff, too small to see from the sea; now ~12 wide, vaults 12 over a floor a
    // cell over the water, and a roof too thin at the face opens (a mouth). Measured: 5 mouths 12-13 high on the coast)
    { gen: GEN.fbm, scale: 80, oct: 3, shape: SHAPE.band, lo: -0.15, hi: 0.15, soft: 0.015, amp: 1, op: OP.set, target: TARGET.m3, seed: 23 },
    { gen: GEN.jfa, src: 3, level: 0.5, amp: 1, target: TARGET.carve, kq: 0.35, up: 12, down: 0.5, roofN: 1.2, floorN: 0.3, nScale: 10, zRef: ZREF.surface, zOff: -11, coast: 2, seaZ: 1, wob: 1.5, open: 1 },
  ]),

  // TG11 (round 112; the user: "it was pretty trivial to make some decent looking overhangs that would be good
  // entrances for caves"): a sheer plateau undercut at its foot all round — the carve's value 9 − d, d the JFA distance
  // in from the wall's mid-height contour, so the gap is tallest at the face and closes 9 cells in — and a patchy second
  // undercut half way up (gated by a slow noise), so the wall overhangs in two tiers
  'TG11: overhang cliff': recipe({ base: 6, sea: 4, cliffSlope: 1.4, rockMat: M('stone'), cliffMat: M('stone'), bandMat: M('sandstone'), bandH: 4, caveRoof: 2, caveMin: 2 }, [
    { gen: GEN.sdf, mode: 1, ...C, size: 72, size2: 58, angle: 15, warp: 0.35, scale: 50, shape: SHAPE.threshold, lo: 0, soft: 1, amp: 34 },
    { gen: GEN.fbm, scale: 30, oct: 3, amp: 2 },
    { gen: GEN.fbm, scale: 70, oct: 2, shape: SHAPE.threshold, lo: 0.05, soft: 0.08, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.jfa, src: 0, level: 23, amp: -1, offset: 9, target: TARGET.carve, kq: 0.12, up: 10, down: 0, roofN: 1.5, floorN: 0.2, nScale: 9, zRef: ZREF.abs, zOff: 6.5, wob: 1, open: 1 },
    { gen: GEN.jfa, src: 0, level: 23, amp: -1, offset: 6, target: TARGET.carve, kq: 0.16, up: 6, down: 0, roofN: 1, floorN: 0.2, nScale: 8, zRef: ZREF.abs, zOff: 24, wob: 2, open: 1, mask: 1 },
  ]),

  // TG4 (the user: "a break in the sheer cliff in which we blend height to the ground to make a natural ramp"):
  // a sheer plateau; where a disc on its east face says, the same plateau with a wide soft edge takes over — a ramp
  'TG4: cliff with a ramp break': recipe({ base: 12, sea: 8, cliffSlope: 1.4, rockMat: M('stone'), bandMat: M('sandstone'), bandH: 5 }, [
    { gen: GEN.sdf, mode: 1, ...C, size: 70, size2: 60, angle: 15, warp: 0.3, scale: 50, shape: SHAPE.threshold, lo: 0, soft: 1, amp: 30 },
    { gen: GEN.sdf, mode: 0, cx: 196, cy: 129, size: 26, shape: SHAPE.threshold, lo: 0, soft: 12, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.sdf, mode: 1, ...C, size: 70, size2: 60, angle: 15, warp: 0.3, scale: 50, shape: SHAPE.threshold, lo: -20, soft: 32, amp: 30, offset: 12, op: OP.set, mask: 1 },
    { gen: GEN.sdf, mode: 0, cx: 80, cy: 170, size: 22, shape: SHAPE.threshold, lo: 0, soft: 8, amp: 1, op: OP.set, target: TARGET.m2 },
    { gen: GEN.sdf, mode: 1, ...C, size: 70, size2: 60, angle: 15, warp: 0.3, scale: 50, shape: SHAPE.threshold, lo: -16, soft: 24, amp: 30, offset: 12, op: OP.set, mask: 2 },
    { gen: GEN.height, shape: SHAPE.stairs, lo: 12, hi: 42, steps: 6, amp: 1, op: OP.set, mask: 2 },
    { gen: GEN.fbm, scale: 30, oct: 3, amp: 2 },
  ]),

  // TG5 (the user: "mountains should be a bit bigger"): a massif to 120 cells — the lab level's window is 128 high
  'TG5: bigger mountains': recipe({ base: 10, sea: 8, topMat: M('stone'), snowZ: 84, cliffSlope: 1.8 }, [
    { gen: GEN.sdf, mode: 0, ...C, size: 70, warp: 0.5, scale: 80, shape: SHAPE.threshold, lo: 0, soft: 60, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.ridge, scale: 200, oct: 6, amp: 78, mask: 1 },
    { gen: GEN.fbm, scale: 140, oct: 4, amp: 18, mask: 1 },
    { gen: GEN.ridge, scale: 60, oct: 3, amp: 10, mask: 1 },
    { gen: GEN.constant, amp: 12, mask: 1 },
    { gen: GEN.fbm, scale: 80, oct: 4, amp: 4 },
  ]),

  // TG6 (the user: "biased features like noise where your stretch a domain and turn bumps into ridges along a grain
  // or radially warped"): the west a grain (fbm stretched six times along 30°), the east ridges radiating from a
  // centre (ridge noise in polar coordinates, 24 spokes)
  'TG6: grain and radial': recipe({ base: 14, sea: 10, cliffSlope: 2 }, [
    { gen: GEN.ramp, angle: 0, ...C, scale: 12, shape: SHAPE.threshold, lo: 0, soft: 1, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.fbm, xform: XFORM.grain, angle: 30, stretch: 6, scale: 30, oct: 4, warp: 0.15, amp: 14, mask: 1, maskInv: 1 },
    { gen: GEN.ridge, xform: XFORM.radial, cx: 190, cy: 111, spokes: 24, scale: 30, oct: 4, amp: 26, mask: 1 },
    { gen: GEN.sdf, mode: 0, cx: 190, cy: 111, size: 14, shape: SHAPE.threshold, lo: 0, soft: 10, amp: 18, mask: 1 },
  ]),

  // TG7 (the user: "do JFA but store the vector to the nearest feature at each point then adjust height by noise
  // along the feature border to make ridges perpendicular to isolines"): a plateau from a slow noise's contour;
  // outside it, spurs of ridge noise sampled at the nearest point of its edge (stretched along the distance), so
  // they run straight out from the wall, across the isolines
  'TG7: JFA ridges off a plateau': recipe({ base: 12, sea: 8, cliffSlope: 1.6 }, [
    { gen: GEN.fbm, scale: 120, oct: 2, amp: 1, op: OP.set, target: TARGET.m1 },
    { gen: GEN.mask, src: 1, shape: SHAPE.threshold, lo: 0.05, soft: 0.02, amp: 30 },
    { gen: GEN.jfa, src: 1, level: 0.05, shape: SHAPE.band, lo: -50, hi: -2, soft: 14, amp: 1, op: OP.set, target: TARGET.m2 },
    { gen: GEN.jfaRidge, src: 1, level: 0.05, scale: 9, stretch: 10, oct: 2, amp: 22, mask: 2 },
    { gen: GEN.fbm, scale: 40, oct: 3, amp: 2 },
  ]),
};
