// ---- render fields (render preparation) ---------------------------------------
// One packed vec4 per column for the draw shaders, so they stay within the
// 8-storage-buffer budget no matter how many simulation fields exist:
//   x  sun shadow: lowest z that receives direct light (heightfield march
//      toward the light; includes the column itself, so floors under a roof
//      are shadowed)
//   y  soil moisture (wet surfaces darken)
//   z  fire glow: max nearby fire, softly blurred (lights walls next to flames)
//   w  net water flow speed (foam)
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> moisture: array<f32>;
@group(0) @binding(5) var<storage, read> fire: array<f32>;
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> fields: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> waterDepth: array<f32>;

/** Water surface height at grid corner v: mean level of the wet columns touching it, or -1. */
fn waterCornerZ(v: vec2<i32>) -> f32 {
  var sum = 0.0;
  var n = 0.0;
  for (var k = 0; k < 4; k++) {
    let q = v - vec2<i32>(1 - (k & 1), 1 - (k >> 1));
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let d = waterDepth[j];
    if (d < 0.012) { continue; }
    sum += f32(sfZ(surface[j])) + d;
    n += 1.0;
  }
  return select(-1.0, sum / max(n, 1.0), n > 0.0);
}
// smoothed corner heights for soft ground (terrainshape.wgsl), x = height or -1
@group(0) @binding(16) var cornerOut: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);

  let sun = normalize(vec3<f32>(G.sunX, G.sunY, G.sunZ));
  let horiz = max(length(sun.xy), 1e-3);
  let dir = sun.xy / horiz;
  let tanE = sun.z / horiz;
  let p0 = vec2<f32>(p) + 0.5;
  var sz = f32(sfZ(surface[i]));
  for (var k = 1; k < 160; k++) {
    let drop = f32(k) * tanE;
    if (f32(G.zMax) - drop <= sz) { break; }
    let q = vec2<i32>(floor(p0 + dir * f32(k)));
    if (!inMap(q)) { break; }
    // soft ground is drawn sloped (terrainshape.wgsl): it casts from about a
    // cell lower than its whole-cell top, so gentle slopes throw no saw-tooth
    let sq = surface[colIdxI(q)];
    let soft = select(0.0, 0.9, MATS[sfMat(sq)].look.x > 0.0);
    sz = max(sz, f32(sfZ(sq)) - soft - drop);
  }

  var glow = fire[i];
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let q = p + vec2<i32>(dx, dy);
      if (!inMap(q)) { continue; }
      let fall = 1.0 - length(vec2<f32>(f32(dx), f32(dy))) / 3.2;
      glow = max(glow, fire[colIdxI(q)] * fall);
    }
  }

  fields[i] = vec4<f32>(sz, moisture[i], glow, length(netFlow(p)));
  textureStore(cornerOut, p, vec4<f32>(computeCornerZ(p), waterCornerZ(p), 0.0, 0.0));
}
