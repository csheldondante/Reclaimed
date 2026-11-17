// ---- roadpath.wgsl: the road path records (road lab, RD1) ----------------------------------------------------------
// The WGSL mirror of src/api/contracts/roadpath.ts (the layout is documented there; keep the two the same). Declares no
// binding: the including kernel binds the buffer as `roads: array<vec4<u32>>` and these read it (roadgrade.wgsl; the
// town's streets.wgsl gradeRast, loop-streets — there `roads` shares binding 4 with b4, never in one entry point).

const ROAD_GRADED: u32 = 1u;
/** (loop-streets) laid as its surface at once; wet columns left */
const ROAD_PAVED: u32 = 2u;
const ROAD_DRY: u32 = 4u;
/** (loop round 11) the points in pairs, each pair a segment of its own (a town's main-street pieces): not a polyline */
const ROAD_SEGS: u32 = 8u;
const ROAD_NONE: u32 = 0xffffffffu;

/** record r (roadpath.ts RoadRecord): its points [first, first + count), surface (0 dirt, 1 cobble), flags, reveal
 *  start and end, shoulder, maxDz; (loop-streets) its box (x0, y0, x1, y1: the points ± half width + shoulder) */
struct RoadRec {
  first: u32,
  count: u32,
  surface: u32,
  flags: u32,
  revealStart: f32,
  revealEnd: f32,
  shoulder: f32,
  maxDz: f32,
  box: vec4<f32>,
};

/** a point: world x, y; the profile z; the half width */
struct RoadPt { xy: vec2<f32>, z: f32, hw: f32 };

/** the header: roads, points, first record's vec4, first point's vec4 */
fn roadHead() -> vec4<u32> { return roads[0]; }

fn roadRec(r: u32) -> RoadRec {
  let h = roadHead();
  let a = roads[h.z + 3u * r];
  let b = bitcast<vec4<f32>>(roads[h.z + 3u * r + 1u]);
  let c = bitcast<vec4<f32>>(roads[h.z + 3u * r + 2u]);
  return RoadRec(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, c);
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

/** (loop-streets) what records [r0, r0 + n) say of a point (the records' frame): `rec` the first whose half width holds
 *  it (ROAD_NONE none) and its profile there (`z`, its nearest segment's); and, over every record whose shoulder holds
 *  it (`near`), the banks — the most of the fills and the least of the cuts, `e` past each edge (fill z − e·fillS, cut
 *  z + e·cutS). One record (the lab's lay) is roadLay's old loop exactly. */
struct RoadHit { rec: u32, z: f32, near: bool, fillT: f32, cutT: f32 };
fn roadHit(wp: vec2<f32>, r0: u32, n: u32, fillS: f32, cutS: f32) -> RoadHit {
  var h = RoadHit(ROAD_NONE, 0.0, false, -1e9, 1e9);
  for (var r = r0; r < r0 + n; r++) {
    let rec = roadRec(r);
    if (rec.count < 2u || wp.x < rec.box.x || wp.y < rec.box.y || wp.x > rec.box.z || wp.y > rec.box.w) { continue; }
    var onD = 1e9;
    var onZ = 0.0;
    let step = select(1u, 2u, (rec.flags & ROAD_SEGS) != 0u);
    for (var i = 0u; i + 1u < rec.count; i += step) {
      let a = roadPt(rec.first + i);
      let b = roadPt(rec.first + i + 1u);
      let s = roadSeg(wp, a.xy, b.xy);
      let z = mix(a.z, b.z, s.y);
      let hw = mix(a.hw, b.hw, s.y);
      if (s.x <= hw) {
        if (s.x < onD) { onD = s.x; onZ = z; }
      } else if (s.x <= hw + rec.shoulder) {
        let e = s.x - hw;
        h.fillT = max(h.fillT, z - e * fillS);
        h.cutT = min(h.cutT, z + e * cutS);
        h.near = true;
      }
    }
    if (onD < 1e8 && h.rec == ROAD_NONE) {
      h.rec = r;
      h.z = onZ;
    }
  }
  return h;
}
