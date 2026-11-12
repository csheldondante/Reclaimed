// ---- roadpath.wgsl: the road path records (road lab, RD1) ----------------------------------------------------------
// The WGSL mirror of src/api/contracts/roadpath.ts (the layout is documented there; keep the two the same). Declares no
// binding: the including kernel binds the buffer as `roads: array<vec4<u32>>` and these read it.

const ROAD_GRADED: u32 = 1u;

/** record r (roadpath.ts RoadRecord): its points [first, first + count), surface (0 dirt, 1 cobble), flags, reveal
 *  start and end, shoulder, maxDz */
struct RoadRec {
  first: u32,
  count: u32,
  surface: u32,
  flags: u32,
  revealStart: f32,
  revealEnd: f32,
  shoulder: f32,
  maxDz: f32,
};

/** a point: world x, y; the profile z; the half width */
struct RoadPt { xy: vec2<f32>, z: f32, hw: f32 };

/** the header: roads, points, first record's vec4, first point's vec4 */
fn roadHead() -> vec4<u32> { return roads[0]; }

fn roadRec(r: u32) -> RoadRec {
  let h = roadHead();
  let a = roads[h.z + 2u * r];
  let b = bitcast<vec4<f32>>(roads[h.z + 2u * r + 1u]);
  return RoadRec(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w);
}

fn roadPt(i: u32) -> RoadPt {
  let p = bitcast<vec4<f32>>(roads[roadHead().w + i]);
  return RoadPt(p.xy, p.z, p.w);
}

/** the nearest point of segment a → b to p: x its distance, y how far along (0..1) — roadstamp.wgsl rsSegDist's,
 *  with the parameter kept (the profile and the width are read there) */
fn roadSeg(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let d = b - a;
  let t = clamp(dot(p - a, d) / max(dot(d, d), 1e-12), 0.0, 1.0);
  return vec2<f32>(length(p - a - d * t), t);
}
