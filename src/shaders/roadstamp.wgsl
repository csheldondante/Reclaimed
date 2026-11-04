// ---- the agents' road bits stamped from shapes (round 128i, FT-58: roads narrower than a cell) -----------------
// The road bit per window column (agents.wgsl `roads`) made on the GPU from the owner's road shapes, in its grid's frame
// (agents/roads.ts packs them: 12 floats a shape — a capsule a→b of radius `half`, or a convex quad abcd grown by
// `half`). The owner uploads its shapes once a change; a slide changes only the offset (whole columns, the row offset
// even, so the frame moves by (ox, oy·ROW_H)), and the bits are made again: clear, then one thread a shape setting the
// bit of every column whose middle lies in it. Nothing read back. Mirrored on the CPU by agents/roads.ts roadBitsCpu.
const RS_ROW_H: f32 = 0.8660254;

struct RoadParams {
  /** the shapes, the window's columns across and rows, the bit words */
  count: u32,
  w: u32,
  h: u32,
  words: u32,
  /** the shapes' frame in the window: whole columns, whole rows (even) */
  ox: i32,
  oy: i32,
  _a: u32,
  _b: u32,
};

@group(0) @binding(40) var<storage, read_write> roadBits: array<atomic<u32>>;
@group(0) @binding(41) var<storage, read> roadShapes: array<vec4<f32>>;
@group(0) @binding(42) var<uniform> RP: RoadParams;

@compute @workgroup_size(64)
fn roadClear(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < RP.words) { atomicStore(&roadBits[id.x], 0u); }
}

fn rsSegDist(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let d = b - a;
  let t = clamp(dot(p - a, d) / max(dot(d, d), 1e-12), 0.0, 1.0);
  return length(p - a - d * t);
}

fn rsCross(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** how far inside the shape p is (>= 0: in) */
fn rsInside(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>, d: vec2<f32>, half: f32, quad: bool) -> f32 {
  if (!quad) { return half - rsSegDist(p, a, b); }
  let s0 = rsCross(a, b, p);
  let s1 = rsCross(b, c, p);
  let s2 = rsCross(c, d, p);
  let s3 = rsCross(d, a, p);
  let e = min(min(rsSegDist(p, a, b), rsSegDist(p, b, c)), min(rsSegDist(p, c, d), rsSegDist(p, d, a)));
  let inq = (s0 >= 0.0 && s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s0 <= 0.0 && s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0);
  return select(half - e, half + e, inq);
}

@compute @workgroup_size(64)
fn roadStamp(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= RP.count) { return; }
  let r0 = roadShapes[id.x * 3u];
  let r1 = roadShapes[id.x * 3u + 1u];
  let r2 = roadShapes[id.x * 3u + 2u];
  let half = r2.x;
  let quad = r2.y > 0.5;
  let a = r0.xy;
  let b = r0.zw;
  let c = select(b, r1.xy, quad);
  let d = select(a, r1.zw, quad);
  let lo = min(min(a, b), min(c, d)) - vec2<f32>(half);
  let hi = max(max(a, b), max(c, d)) + vec2<f32>(half);
  let off = vec2<f32>(f32(RP.ox), f32(RP.oy) * RS_ROW_H);
  let y0 = max(i32(floor((lo.y + off.y) / RS_ROW_H - 0.5)), 0);
  let y1 = min(i32(ceil((hi.y + off.y) / RS_ROW_H - 0.5)), i32(RP.h) - 1);
  let x0 = max(i32(floor(lo.x + off.x - 1.0)), 0);
  let x1 = min(i32(ceil(hi.x + off.x)), i32(RP.w) - 1);
  // (a shape is a lane piece, a cell or less across: a guard against a bad one taking the whole window)
  if (y1 - y0 > 64 || x1 - x0 > 64) { return; }
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      let p = vec2<f32>(f32(x) + 0.5 + 0.5 * f32(y & 1), (f32(y) + 0.5) * RS_ROW_H) - off;
      if (rsInside(p, a, b, c, d, half, quad) >= 0.0) {
        let w = u32(y) * RP.w + u32(x);
        atomicOr(&roadBits[w >> 5u], 1u << (w & 31u));
      }
    }
  }
}
