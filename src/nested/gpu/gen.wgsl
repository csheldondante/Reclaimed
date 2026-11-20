// ---- nested/gpu/gen.wgsl: the lab's generator field from the atlas's ground (round 25) --------------------------------
// Appended to Atlas.parts() (src/atlas/atlas.ts), like terrain/sample.wgsl: ground(p) is the atlas's own (compose.wgsl),
// unedited. genFill evaluates it at the centres of a rect of one level's global columns and writes, per column, into
// that level's toroidal n x n slot of the field (nest.wgsl genAt reads it):
//   x the ground's height (metres), y the cover's thickness (metres, 0: bare rock), z the plant layer's thickness
//   (metres, 0: none), w the cover's material (the lab's id, as bits: 2 soil, 3 sand; 0 none).
// The field's header (vec4 0..7, written by the CPU, gen.ts): per level its column size in metres, n, 1 when filled.
// The cover and plants are the region's (Region.cover / topMat / veg) with forms.wgsl colFinish's slope and wet rules,
// at the column's centre (a function of the position alone, so a column made again is bit-identical).

struct GenU {
  /** level, rect x0, y0 (the level's global columns), w */
  a: vec4<i32>,
  /** rect h, the slot's n, -, - */
  b: vec4<i32>,
  /** metres a column of this level, -, -, - */
  f: vec4<f32>,
}
@group(0) @binding(40) var<uniform> GU: GenU;
@group(0) @binding(41) var<storage, read_write> genOut: array<vec4<f32>>;

/** the field's header words before the levels' slots */
const GEN_HDR: u32 = 8u;
/** the lab's materials (nest.wgsl MAT_*) */
const GEN_SOIL: u32 = 2u;
const GEN_SAND: u32 = 3u;
/** (stand-in, BACKLOG NS-187) the plant layer's thickness where the region grows plants, metres */
const GEN_PLANT_M: f32 = 0.5;

/** a column centre in metres on the torus: x exactly (the torus is 2^16 m wide and a column 2^(7 - 3L) m), y in f32 */
fn genP(gx: i32, gy: i32, cs: f32) -> vec2<f32> {
  let x = (f32(gx) + 0.5) * cs;
  let y = (f32(gy) + 0.5) * cs;
  return vec2<f32>(x - floor(x / AP.worldW) * AP.worldW, y - floor(y / AP.worldH) * AP.worldH);
}

@compute @workgroup_size(8, 8)
fn genFill(@builtin(global_invocation_id) id: vec3<u32>) {
  if (i32(id.x) >= GU.a.w || i32(id.y) >= GU.b.x) { return; }
  let gx = GU.a.y + i32(id.x);
  let gy = GU.a.z + i32(id.y);
  let p = genP(gx, gy, GU.f.x);
  // ground() at the centre, and on the root's fills at the four points a metre away (the slope below): ONE call site in
  // a loop whose bound the compiler does not know, so ground() is compiled once (FXC inlines every call: four more
  // call sites took the compile from 9 to 24 s)
  let nq = select(1, 5, GU.a.x == 0);
  var g: Ground;
  var slope = 0.0;
  for (var q = 0; q < nq; q++) {
    let d = vec2<f32>(select(select(0.0, -1.0, q == 2), 1.0, q == 1), select(select(0.0, -1.0, q == 4), 1.0, q == 3));
    let gq = ground(p + d);
    if (q == 0) { g = gq; } else { slope = max(slope, abs(gq.h - g.h)); }
  }
  let R = regs[g.a];
  let h = g.h;
  // the cover, forms.wgsl colFinish's rule: the region's cover of its top material less half the slope to the steepest
  // neighbour a metre away (there a hex cell), none past 1.6; wet ground (under sea + 1.2) 1.5 of sand; rock tops bare.
  // Only the root's columns carry materials (finer levels inherit its structure), so only a root fill pays the slope's
  // four more ground() calls
  var cm = 0u;
  if (R.topMat == 2u || R.topMat == 22u || R.topMat == 4u || R.topMat == 26u) { cm = GEN_SOIL; }
  if (R.topMat == 3u) { cm = GEN_SAND; }
  var cover = max(R.cover - slope * 0.5, 0.0);
  if (slope > 1.6) {
    cover = 0.0;
  } else if (h < AP.sea + 1.2) {
    cm = GEN_SAND;
    cover = 1.5;
  }
  if (cm == 0u) { cover = 0.0; }
  // plants where the region grows them, on soil, not under snow, under the tree line (forms.wgsl colFinish: sea + 70)
  var plant = 0.0;
  if (cm == GEN_SOIL && cover > 0.0 && R.veg >= 0.5 && temperature(p, h) >= 0.0 && h < AP.sea + 70.0) { plant = GEN_PLANT_M; }
  let n = GU.b.y;
  let x = ((gx % n) + n) % n;
  let y = ((gy % n) + n) % n;
  genOut[GEN_HDR + u32(GU.a.x) * u32(n * n) + u32(y * n + x)] = vec4<f32>(h, cover, plant, bitcast<f32>(cm));
}
