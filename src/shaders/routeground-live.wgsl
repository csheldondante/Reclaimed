// ---- the route network's ground, in play: the world's live columns (townroute.wgsl reads the ground only through
// rgValid / rgTop / rgWater; routeground-raw.wgsl is generation's — one cut kernel, two grounds) ----
// Needs common.wgsl, layers.wgsl (binding 1, the chunk table), materials.wgsl (binding 2).
@group(0) @binding(3) var<storage, read> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;

fn rgValid(p: vec2<i32>) -> bool { return inMap(p); }

/** the land's top at a window column (window z): the highest solid or granular interval not an External claim (a
 *  structure's matter is the plan's, not the land's) */
fn rgTop(p: vec2<i32>) -> f32 {
  let cs = colSlots(u32(p.x), u32(p.y));
  var top = -1e9;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    let m = ivMat(v);
    if (m == MAT_EXTERNAL) { continue; }
    let st = matState(m);
    if (st == ST_SOLID || st == ST_GRANULAR) { top = max(top, ivZ1(v)); }
  }
  return top;
}

fn rgWater(p: vec2<i32>) -> f32 { return water[colIdxI(p)]; }
