// ---- atlas/common.wgsl ----------------------------------------------------
// The atlas's parameters (round 67; mirrored by AtlasGpu.writeParams in
// atlas.ts — keep the two in step). Prepended to every atlas kernel.

struct AtlasP {
  /** the macro grid: n × n texels over the torus */
  n: u32,
  seed: u32,
  /** a JFA pass's step (texels) */
  step: u32,
  /** 0 earth, 1 strange (more patterned regions), 2 flesh */
  style: u32,
  /** the world's extent (world units): it wraps at these */
  worldW: f32,
  worldH: f32,
  sea: f32,
  zTop: f32,
  /** continents: lattice cells a turn of the first octave; land where the noise is above landThresh */
  landPer: f32,
  landThresh: f32,
  /** domain warp of the macro fields (turns) */
  warp: f32,
  /** Voronoi cells a turn (the partition) */
  cellsPer: f32,
  /** faults: noise period, and the band between the two thresholds */
  faultPer: f32,
  faultLo: f32,
  faultHi: f32,
  jitter: f32,
  /** how much a continent's interior rises with distance from its coast */
  lift: f32,
  minIsland: u32,
  x0: i32,
  y0: i32,
  /** a column batch: w × h columns from world cell (x0, y0), one cell of margin each side */
  w: u32,
  h: u32,
  /** the regions' borders wiggle this far below the macro texel (world units) */
  warpCell: f32,
  minLake: u32,
  /** the viewer: the world at the screen's centre, world units a pixel, what to show */
  vc: vec2<f32>,
  vscale: f32,
  mode: u32,
  vsize: vec2<f32>,
  caveDepth: f32,
  caveScale: f32,
  /** round 78: the continent's slope reaches its full lift this far from the coast; regions' own detail shown */
  liftReach: f32,
  detail: f32,
  /** round 80: the tile of the batch colFinish does (columns along x, y from the batch's corner) */
  tileX: f32,
  tileY: f32,
}

@group(0) @binding(0) var<uniform> AP: AtlasP;

const ROW_H_A: f32 = 0.8660254;

fn torusU(p: vec2<f32>) -> vec2<f32> { return p / vec2<f32>(AP.worldW, AP.worldH); }
/** lattice cells a turn for features `scale` world units across */
fn perOf(scale: f32) -> i32 { return max(1, i32(round(AP.worldW / max(scale, 1.0)))); }
fn texIdxW(t: vec2<i32>) -> u32 {
  let w = wrapi(t, vec2<i32>(i32(AP.n)));
  return u32(w.y) * AP.n + u32(w.x);
}
