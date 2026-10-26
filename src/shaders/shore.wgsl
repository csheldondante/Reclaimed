// ---- shore field (round 83) ---------------------------------------------------
// The nearest shore to every column, by jump flooding (the user: "use SDF for the water to make waves from
// large bodies come into the shore"; "water in the ocean should be waves coming into the shore"): a shore
// is a dry column beside a wet one; each column keeps the nearest shore point seen (world xy) — first its
// own (shoreSeed), then from the columns k away round it, k halving to 1 (shoreJump). The water's shader
// (render.wgsl fsWater) takes the distance and the way to it from the nearest point: swell lines parallel
// to the shore, running in.
//   texel: xy the nearest shore point (window coordinates), z 1 when there is one
@group(0) @binding(3) var<storage, read> waterS: array<f32>;
@group(0) @binding(4) var seedIn: texture_2d<f32>;
@group(0) @binding(5) var seedOut: texture_storage_2d<rgba32float, write>;
struct ShoreP {
  /** x the jump (columns) */
  k: vec4<u32>,
}
@group(0) @binding(6) var<uniform> SP: ShoreP;

/** water this deep or more (cells) is water to the shore field */
const SHORE_WET: f32 = 0.05;

fn wetS(p: vec2<i32>) -> bool { return inMap(p) && waterS[colIdxI(p)] > SHORE_WET; }

@compute @workgroup_size(8, 8)
fn shoreSeed(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = vec2<i32>(id.xy);
  if (!inMap(p)) { return; }
  var s = vec4<f32>(0.0);
  if (!wetS(p)) {
    for (var k = 0u; k < NDIR; k++) {
      if (wetS(nbr(p, k))) { s = vec4<f32>(cellPos(p), 1.0, 0.0); }
    }
  }
  textureStore(seedOut, p, s);
}

@compute @workgroup_size(8, 8)
fn shoreJump(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = vec2<i32>(id.xy);
  if (!inMap(p)) { return; }
  let here = cellPos(p);
  var best = textureLoad(seedIn, p, 0);
  var bd = select(1e30, distance(here, best.xy), best.z > 0.5);
  let k = i32(SP.k.x);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let q = p + vec2<i32>(dx, dy) * k;
      if (!inMap(q)) { continue; }
      let s = textureLoad(seedIn, q, 0);
      if (s.z < 0.5) { continue; }
      let d = distance(here, s.xy);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
  }
  textureStore(seedOut, p, best);
}
