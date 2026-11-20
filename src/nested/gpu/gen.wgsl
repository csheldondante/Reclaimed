// ---- nested/gpu/gen.wgsl: the lab's generator field from the atlas's ground (round 25) --------------------------------
// Appended to Atlas.parts() (src/atlas/atlas.ts), like terrain/sample.wgsl: ground(p) is the atlas's own (compose.wgsl),
// unedited. genFill evaluates it at the centres of a rect of one level's global columns and writes, per column, into
// that level's toroidal n x n slot of the field (nest.wgsl genAt reads it):
//   x the ground's height (metres), y the cover interval's thickness (metres), z the plant interval's (metres), w (bits)
//   the decision: bits 0-3 the cover's material (the lab's id: 2 soil, 3 sand; 0 bare), bit 4 plants (round 27: the
//   thicknesses are the structure, the same kind everywhere; the decision is what each level shows).
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
/** (stand-in, BACKLOG NS-187) the plant layer's thickness, metres (round 27: every generated column has the interval;
 *  where nothing grows it shows the cover's material) */
const GEN_PLANT_M: f32 = 0.5;
/** (round 27) the cover interval's least thickness, metres: a region with no cover (rock) still has the interval, which
 *  shows its stone there (the structure is the same everywhere) */
const GEN_COVER_MIN: f32 = 0.25;

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
  // ground() at the centre and at the four points a metre away (the slope below): ONE call site in a loop whose bound
  // the compiler does not know, so ground() is compiled once (FXC inlines every call: four more call sites took the
  // compile from 9 to 24 s). (round 27: every level's fill decides its own cover, so every fill pays the slope's four
  // more calls; round 25 paid them on the root's fills only)
  let nq = select(1, 5, GU.a.x >= 0);
  var g: Ground;
  var slope = 0.0;
  for (var q = 0; q < nq; q++) {
    let d = vec2<f32>(select(select(0.0, -1.0, q == 2), 1.0, q == 1), select(select(0.0, -1.0, q == 4), 1.0, q == 3));
    let gq = ground(p + d);
    if (q == 0) { g = gq; } else { slope = max(slope, abs(gq.h - g.h)); }
  }
  // (round 27) whose ground this is: across a region border, region A where its blend weight w (the atlas's continuous
  // field) plus a noise is over a half. forms.wgsl colFinish adds a per-cell hash (times 0.3); a hash at our column
  // centres made a checkerboard of the two covers at the 2 m level, so the atlas's own periodic fbm (noise.wgsl pfbm,
  // features 32 m down to 8 m, the same amplitude) instead: the border meanders through the blend band. A function of the
  // world position alone, so a point decides the same from every level.
  let nb = pfbm(p / vec2<f32>(AP.worldW, AP.worldH), i32(AP.worldW / 32.0), 3u, AP.seed + 71u);
  var ri = g.b;
  if (g.w + nb * 0.3 > 0.5) { ri = g.a; }
  let R = regs[ri];
  let h = g.h;
  // the cover, forms.wgsl colFinish's rule: the region's cover of its top material less half the slope to the steepest
  // neighbour a metre away (there a hex cell), none past 1.6; wet ground (under sea + 1.2) 1.5 of sand; rock tops bare
  var cm = 0u;
  if (R.topMat == 2u || R.topMat == 22u || R.topMat == 4u || R.topMat == 26u) { cm = GEN_SOIL; }
  if (R.topMat == 3u) { cm = GEN_SAND; }
  var cover = max(R.cover - slope * 0.5, 0.0);
  let wet = h < AP.sea + 1.2;
  if (slope > 1.6) {
    cover = 0.0;
  } else if (wet) {
    cm = GEN_SAND;
    cover = 1.5;
  }
  if (cm == 0u || cover <= 0.0) { cm = 0u; }
  // plants where the region grows them, on soil, not under snow, under the tree line (forms.wgsl colFinish: sea + 70)
  let plant = cm == GEN_SOIL && R.veg >= 0.5 && temperature(p, h) >= 0.0 && h < AP.sea + 70.0;
  // (round 27) the column's STRUCTURE is the same everywhere (NESTED_SCALES.md "Round 27 plan, part 1"): a cover and a
  // plant interval of these thicknesses (never zero), whatever this column shows; w the decision, which nest.wgsl
  // genMat resolves a role with: bits 0-3 the cover's material (0: bare, the stone shows), bit 4 plants
  let coverT = max(max(R.cover, select(0.0, 1.5, wet)), GEN_COVER_MIN);
  let n = GU.b.y;
  let x = ((gx % n) + n) % n;
  let y = ((gy % n) + n) % n;
  genOut[GEN_HDR + u32(GU.a.x) * u32(n * n) + u32(y * n + x)] = vec4<f32>(h, coverT, GEN_PLANT_M, bitcast<f32>(cm | select(0u, 16u, plant)));
}
