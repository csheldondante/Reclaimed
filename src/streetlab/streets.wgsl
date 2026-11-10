// (street lab, milestone 2: option B) Streets, blocks and lots over the window's columns, all on the GPU.
//   large  — the major lines: level sets of up to three fields — the smoothed distance to water and cliffs over the
//            major spacing (family 1), rings about the town's centre (2) and spokes past the first ring (3);
//   medium — cross streets: one trace a seed (a lattice half a block length apart) along the minor direction of a
//            tensor field aligned to the major lines (its axis the blended gradients of families 1 and 2), both ways
//            until it meets a major line — the crossing found exactly by bisection on that line's field — or the
//            water / a cliff (a shore end) or the town's edge (open: dropped). A trace conflicts with a lower seed's
//            trace of its strip nearer than 0.8 block lengths (a few rounds: a greedy independent set);
//   blocks — each kept trace and the next one along its strip (the same two lines at its ends) bound a block: a quad
//            of the four exact crossings;
//   lots   — each block split across its longest edge at its middle (a little jitter) until under the largest lot's
//            area; a split that would leave a lot under the smallest isn't made (the merge);
//   mesh   — the lots inset by their streets' half widths and the setback and extruded, the parks flat, the cross
//            streets as ribbons along their traces, the major lines as ribbon pieces a column along the exact level
//            set — triangles for Renderer.addMesh (render.wgsl vsSkin).
// A field is one value a column in window order (y · w + x); positions are window world units (cellPos). Every entry
// has its own pass uniform; bindings 1–4 read, 5 and 7 read-write, 6 and 8 atomic.

struct U {
  n: vec4<u32>, // w, h, k (a JFA step / a fill's value / a blur's radius), mode
  m: vec4<u32>, // count (a fill's; the lots' room), vertex room, families (1 distance, 2 rings, 4 spokes), seeds across
  a: vec4<f32>, // major spacing, ring spacing, spokes, block length
  b: vec4<f32>, // major width, minor width, setback, height (storeys)
  c: vec4<f32>, // largest lot area, smallest lot area, cliff slope, seeds down (as f32)
  d: vec4<f32>, // the town's centre (world x, y), its radius, the stairs slope
  e: vec4<f32>, // (m3) blend width (smooth-min k), point radius, point strength, auto points
  o: vec4<u32>, // (m3) a boxed pass's first column (x, y), φ's mode (0 distance, 1 smooth min, 2 bump), cross streets (0 vector JFA, 1 tensor)
  s: vec4<f32>, // (m3c) the band height, the cart grade, the shape (0 none, 1 terraces, 2 spiral, 3 switchbacks), the spiral's point + 1
  q: vec4<f32>, // (m3d) bad cells (0 merge, 1 plaza, 2 left); (m3e) the landmarks' radius × (0 none), the cross streets a busy junction has, their kind (0 plaza, 1 big structure)
  l: vec4<f32>, // (m3e) a landmark's smallest and largest radius; (m3f) a big block's area (0: no roads in them), gap fill (1 on)
  r: vec4<f32>, // (m3g) the field (0 the distance smoothed, 1 the mask smoothed), the mask's smoothing, grown streets (1), the landmarks kept (top K)
  h: vec4<f32>, // (m3h) a supercell's size (block lengths), the limit's noise (supercells), the empty fraction, the seed
  h2: vec4<f32>, // (m3h) the growth (0–1), the district tint (1), supercells on (1), the limit (× the town's radius)
  x: vec4<f32>, // (m3i) the town circle's reach (× its radius: with supercells, far enough never to show), 0, 0, 0
};
@group(0) @binding(0) var<uniform> u: U;

const NONE: u32 = 0xffffffffu;
const ROW_H: f32 = 0.8660254;
const TAU: f32 = 6.2831853;

fn W() -> i32 { return i32(u.n.x); }
fn H() -> i32 { return i32(u.n.y); }
fn ix(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, H() - 1) * W() + clamp(x, 0, W() - 1)); }
fn ixq(q: vec2<i32>) -> u32 { return ix(q.x, q.y); }
/** a column's centre (world) — common.wgsl cellPos */
fn cpos(x: i32, y: i32) -> vec2<f32> { return vec2<f32>(f32(x) + 0.5 + 0.5 * f32(y & 1), (f32(y) + 0.5) * ROW_H); }
fn axialCell(a: vec2<i32>) -> vec2<i32> { return vec2<i32>(a.x + (a.y - (a.y & 1)) / 2, a.y); }
fn axialOf(w: vec2<f32>) -> vec2<f32> { let r = (w.y - 0.5 * ROW_H) / ROW_H; return vec2<f32>(w.x - 0.5 - 0.5 * r, r); }
/** the column a world point is in — common.wgsl cellAt */
fn cat(w: vec2<f32>) -> vec2<i32> {
  let a = axialOf(w);
  let c = vec3<f32>(a.x, a.y, -a.x - a.y);
  var o = round(c);
  let e = abs(o - c);
  if (e.x > e.y && e.x > e.z) { o.x = -o.y - o.z; } else if (e.y > e.z) { o.y = -o.x - o.z; }
  return axialCell(vec2<i32>(i32(o.x), i32(o.y)));
}
fn ixp(p: vec2<f32>) -> u32 { return ixq(cat(p)); }
/** the three centres round p and their weights — common.wgsl triAt */
struct Tri { c: array<vec2<i32>, 3>, w: vec3<f32> }
fn triAt(w: vec2<f32>) -> Tri {
  let a = axialOf(w);
  let b = vec2<i32>(floor(a));
  let f = a - floor(a);
  var t: Tri;
  if (f.x + f.y < 1.0) {
    t.c = array<vec2<i32>, 3>(axialCell(b), axialCell(b + vec2<i32>(1, 0)), axialCell(b + vec2<i32>(0, 1)));
    t.w = vec3<f32>(1.0 - f.x - f.y, f.x, f.y);
  } else {
    t.c = array<vec2<i32>, 3>(axialCell(b + vec2<i32>(1, 1)), axialCell(b + vec2<i32>(0, 1)), axialCell(b + vec2<i32>(1, 0)));
    t.w = vec3<f32>(f.x + f.y - 1.0, 1.0 - f.x, 1.0 - f.y);
  }
  return t;
}
fn inb(p: vec2<f32>) -> bool { return p.x >= 0.5 && p.y >= 0.5 && p.x < f32(W()) - 0.5 && p.y < f32(H()) * ROW_H - 0.5; }
/** (m3i: with supercells the circle is only a bound, x.x radii out — the supercells' limit is the town's) */
fn inTown(p: vec2<f32>) -> bool { return distance(p, u.d.xy) < u.d.z * max(u.x.x, 1.0); }
fn pk(x: u32, y: u32, c: u32) -> u32 { return x | (y << 10u) | (c << 20u); }
fn pxy(v: u32) -> vec2<i32> { return vec2<i32>(i32(v & 1023u), i32((v >> 10u) & 1023u)); }
fn ppos(v: u32) -> vec2<f32> { let q = pxy(v); return cpos(q.x, q.y); }
fn hsh(v: u32) -> f32 { var x = v * 747796405u + 2891336453u; x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u; x = (x >> 22u) ^ x; return f32(x) / 4294967295.0; }
fn cross2(a: vec2<f32>, b: vec2<f32>) -> f32 { return a.x * b.y - a.y * b.x; }

// (every field is u32 words: a seed's bits kept exact, a float's through bitcast)
@group(0) @binding(1) var<storage, read> b1: array<u32>;
@group(0) @binding(2) var<storage, read> b2: array<u32>;
@group(0) @binding(3) var<storage, read> b3: array<u32>;
@group(0) @binding(4) var<storage, read> b4: array<u32>;
@group(0) @binding(5) var<storage, read_write> w5: array<u32>;
@group(0) @binding(6) var<storage, read_write> w6: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> w7: array<u32>;
@group(0) @binding(8) var<storage, read_write> args: array<atomic<u32>>;
fn r1(i: u32) -> f32 { return bitcast<f32>(b1[i]); }
fn r2(i: u32) -> f32 { return bitcast<f32>(b2[i]); }
fn r3(i: u32) -> f32 { return bitcast<f32>(b3[i]); }
fn r4(i: u32) -> f32 { return bitcast<f32>(b4[i]); }
fn set5(i: u32, v: f32) { w5[i] = bitcast<u32>(v); }
fn set7(i: u32, v: f32) { w7[i] = bitcast<u32>(v); }
fn putV(i: u32, p: vec2<f32>) { set5(i, p.x); set5(i + 1u, p.y); }
fn grad1(x: i32, y: i32) -> vec2<f32> { return vec2<f32>((r1(ix(x + 1, y)) - r1(ix(x - 1, y))) * 0.5, (r1(ix(x, y + 1)) - r1(ix(x, y - 1))) / (2.0 * ROW_H)); }

// ---- the fields (as milestone 1) ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn fill(@builtin(global_invocation_id) g: vec3<u32>) {
  // (from o.x: a fill's offset)
  if (g.x < u.m.x) { w5[g.x + u.o.x] = u.n.z; }
}
/** a box blur of r1 along x (mode 0) or y (mode 1), radius k columns */
@compute @workgroup_size(8, 8)
fn blur(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let r = i32(u.n.z);
  var s = 0.0;
  for (var k = -r; k <= r; k++) {
    if (u.n.w == 0u) { s += r1(ix(x + k, y)); } else { s += r1(ix(x, y + k)); }
  }
  set5(ix(x, y), s / f32(2 * r + 1));
}
/** water (r2) and cliffs (r1's slope over c.z): the flood's seeds (w5) and the blocked mask (w7) */
@compute @workgroup_size(8, 8)
fn feat(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  if (r2(i) > 0.5 || length(grad1(x, y)) > u.c.z) { w5[i] = pk(u32(x), u32(y), 0u); set7(i, 1.0); } else { w5[i] = NONE; set7(i, 0.0); }
}
/** a jump-flood step of size k over b1's seeds (0: a copy) */
@compute @workgroup_size(8, 8)
fn jfa(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let k = i32(u.n.z);
  let p = cpos(x, y);
  var best = NONE;
  var bd = 1e30;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let qx = x + dx * k; let qy = y + dy * k;
      if (qx < 0 || qy < 0 || qx >= W() || qy >= H()) { continue; }
      let v = b1[u32(qy * W() + qx)];
      if (v == NONE) { continue; }
      let d = distance(ppos(v), p);
      if (d < bd) { bd = d; best = v; }
    }
  }
  w5[ix(x, y)] = best;
}
/** a flood's distance (w5; 1e4 no seed) */
@compute @workgroup_size(8, 8)
fn jdist(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let v = b1[i];
  if (v == NONE) { set5(i, 1e4); return; }
  set5(i, distance(ppos(v), cpos(x, y)));
}

// ---- the major lines' fields at a point: b4 the smoothed feature distance, negative where blocked (`phi`) ----
fn fdAt(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  return t.w.x * r4(ixq(t.c[0])) + t.w.y * r4(ixq(t.c[1])) + t.w.z * r4(ixq(t.c[2]));
}
const QUAY: f32 = 3.0;
fn fam(k: u32) -> bool { return (u.m.z & (1u << (k - 1u))) != 0u; }
fn ringF(p: vec2<f32>) -> f32 { return distance(p, u.d.xy) / u.a.y; }
fn spokeF(p: vec2<f32>) -> f32 { let r = p - u.d.xy; return (atan2(r.y, r.x) / TAU + 0.5) * u.a.z; }
/** family k's field at p (1 the feature distance over the major spacing, 2 rings, 3 spokes) */
fn fieldAt(k: u32, p: vec2<f32>) -> f32 {
  // (m3: line 0 a quay QUAY off the water — the shore strip has a line to build against)
  if (k == 1u) { return (fdAt(p) - QUAY) / u.a.x; }
  if (k == 2u) { return ringF(p); }
  return spokeF(p);
}
/** the spokes' field near r0 (the angle's seam unwrapped) */
fn unwrap(f: f32, r0: f32) -> f32 {
  let n = u.a.z;
  if (f - r0 > n * 0.5) { return f - n; }
  if (r0 - f > n * 0.5) { return f + n; }
  return f;
}
/** spokes only past the first ring (the middle a plaza) */
fn spokesAt(p: vec2<f32>) -> bool { return fam(3u) && ringF(p) >= 1.0; }
fn gradAt(k: u32, p: vec2<f32>) -> vec2<f32> {
  let e = 0.35;
  let f0 = fieldAt(k, p);
  var fx0 = fieldAt(k, p - vec2<f32>(e, 0.0)); var fx1 = fieldAt(k, p + vec2<f32>(e, 0.0));
  var fy0 = fieldAt(k, p - vec2<f32>(0.0, e)); var fy1 = fieldAt(k, p + vec2<f32>(0.0, e));
  if (k == 3u) { fx0 = unwrap(fx0, f0); fx1 = unwrap(fx1, f0); fy0 = unwrap(fy0, f0); fy1 = unwrap(fy1, f0); }
  return vec2<f32>(fx1 - fx0, fy1 - fy0) / (2.0 * e);
}
fn blockedAt(p: vec2<f32>) -> bool { return r4(ixp(p)) < 0.0; }

/** the minor axis at p as a doubled angle (cos 2θ, sin 2θ): the gradients of families 1 and 2 (the lines the blocks
 *  run along), each weighted by its nearness to its own nearest line — spokes alone, across them */
fn minorAxis(p: vec2<f32>) -> vec2<f32> {
  var t = vec2<f32>(0.0);
  for (var k = 1u; k <= 2u; k++) {
    if (!fam(k)) { continue; }
    let g = gradAt(k, p);
    let gl = length(g);
    if (gl < 1e-5) { continue; }
    let f = fieldAt(k, p);
    let dl = min(fract(f), 1.0 - fract(f)) / gl;
    let w = 1.0 / (dl + 1.0);
    let th = atan2(g.y, g.x);
    t += w * vec2<f32>(cos(2.0 * th), sin(2.0 * th));
  }
  if (length(t) < 1e-6) { let g = gradAt(3u, p); let th = atan2(g.y, g.x); t = vec2<f32>(cos(2.0 * th), sin(2.0 * th)); }
  return t;
}
/** the tensor field a column (w5, w7: its minor axis's doubled angle), for the traces to interpolate */
@compute @workgroup_size(8, 8)
fn tensor(@builtin(global_invocation_id) g: vec3<u32>) {
  // (a boxed pass: from column o.xy — a moved point's disc)
  let x = i32(g.x + u.o.x); let y = i32(g.y + u.o.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let t = minorAxis(cpos(x, y));
  let l = max(length(t), 1e-6);
  set5(i, t.x / l);
  set7(i, t.y / l);
}
/** the minor direction at p (the tensor field interpolated: r1, r2); `prev` picks the sign */
fn minorAt(p: vec2<f32>, prev: vec2<f32>) -> vec2<f32> {
  let tr = triAt(p);
  var t = vec2<f32>(0.0);
  for (var k = 0; k < 3; k++) { let i = ixq(tr.c[k]); t += tr.w[k] * vec2<f32>(r1(i), r2(i)); }
  let a = 0.5 * atan2(t.y, t.x);
  var d = vec2<f32>(cos(a), sin(a));
  if (dot(d, prev) < 0.0) { d = -d; }
  return d;
}

// ---- medium: the traces ------------------------------------------------------------------------------------
// A trace's record (TRW words): 0 1 a candidate (two closed ends on different lines), 1 its seed's strip key, 2–3 its
// low end, 4 the low end's line (family << 24 | level; family 0 a shore), 5–6 its high end, 7 its line, 8 which side
// its last point is (0 the high), 9 its first point, 10 its last; 16.. TP points (x, y) — the seed at TP / 2 − 1, one
// side up from it, the other down, each side's last its exact end.
const TRW: u32 = 144u;
const TP: u32 = 64u;
/** steps a recorded point (a step a world unit: the crossings are exact anyway, by bisection) */
const REC: i32 = 3;
const STEP: f32 = 1.0;
/** a point's strip key: its families' floors */
fn stripKey(p: vec2<f32>) -> u32 {
  var key = 0u;
  if (fam(1u)) { key = key | u32(clamp(floor(fieldAt(1u, p)), 0.0, 255.0)); }
  if (fam(2u)) { key = key | (u32(clamp(floor(fieldAt(2u, p)), 0.0, 255.0)) << 8u); }
  if (spokesAt(p)) { key = key | (u32(clamp(floor(fieldAt(3u, p)), 0.0, 254.0)) << 16u); } else { key = key | (255u << 16u); }
  return key;
}
fn lineKey(f: u32, level: f32) -> u32 { return (f << 24u) | (u32(max(level, 0.0)) & 0xffffffu); }

struct End { p: vec2<f32>, key: u32, closed: bool }
/** walk from p0 along the minor direction, recording points up (or down) from the seed's slot; where it ends */
fn walk(base: u32, p0: vec2<f32>, d0: vec2<f32>, up: bool) -> End {
  var p = p0;
  var d = d0;
  var e: End;
  e.closed = false;
  e.key = 0u;
  e.p = p0;
  var slot = select(i32(TP / 2u) - 2, i32(TP / 2u), up);
  let lim = select(0, i32(TP) - 1, up);
  var steps = 0;
  loop {
    d = minorAt(p, d);
    let q = p + d * STEP;
    steps++;
    // (the town's edge, the window's: open)
    if (!inb(q) || !inTown(q)) { e.p = p; break; }
    // (water, a cliff: a shore end at the last open point)
    if (blockedAt(q)) { e.p = p; e.key = lineKey(0u, 0.0); e.closed = true; break; }
    // (a major line crossed: which, and where — bisection on its field)
    var hit = false;
    for (var k = 1u; k <= 3u; k++) {
      if (!fam(k) || hit) { continue; }
      if (k == 3u && !(spokesAt(p) && spokesAt(q))) { continue; }
      let f0 = fieldAt(k, p);
      var f1 = fieldAt(k, q);
      if (k == 3u) { f1 = unwrap(f1, f0); }
      if (floor(f0) == floor(f1)) { continue; }
      let level = select(floor(f0), floor(f1), f1 > f0);
      var a = 0.0;
      var b = 1.0;
      for (var it = 0; it < 14; it++) {
        let t = 0.5 * (a + b);
        var ft = fieldAt(k, mix(p, q, t));
        if (k == 3u) { ft = unwrap(ft, f0); }
        if ((ft >= level) == (f0 >= level)) { a = t; } else { b = t; }
      }
      var lv = level;
      if (k == 3u) { lv = level - floor(level / u.a.z) * u.a.z; }
      e.p = mix(p, q, 0.5 * (a + b));
      e.key = lineKey(k, lv);
      e.closed = true;
      hit = true;
    }
    if (hit) { break; }
    p = q;
    if (steps % REC == 0) {
      // (out of room: open)
      if (slot == lim) { e.p = p; break; }
      putV(base + 16u + u32(slot) * 2u, p);
      slot = select(slot - 1, slot + 1, up);
    }
  }
  // (the exact end the side's last point)
  putV(base + 16u + u32(slot) * 2u, e.p);
  if (up) { w5[base + 10u] = u32(slot); } else { w5[base + 9u] = u32(slot); }
  return e;
}
/** one thread a seed (a lattice m.w across, spacing a.w / 2): its trace both ways (w5 the records, w7 candidates;
 *  r1, r2 the tensor field, r4 the feature distance) */
@compute @workgroup_size(64)
fn trace(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  let mx = u.m.w;
  let my = u32(u.c.w);
  if (id >= mx * my) { return; }
  let base = id * TRW;
  w5[base] = 0u;
  w7[id] = 0u;
  let sp = u.a.w * 0.5;
  let p0 = (vec2<f32>(f32(id % mx), f32(id / mx)) + 0.5) * sp;
  if (!inb(p0) || !inTown(p0) || blockedAt(p0)) { return; }
  if (fam(2u) && ringF(p0) < 1.0) { return; }
  let d0 = minorAt(p0, vec2<f32>(1.0, 0.0));
  putV(base + 16u + (TP / 2u - 1u) * 2u, p0);
  let eu = walk(base, p0, d0, true);
  let ed = walk(base, p0, -d0, false);
  if (!eu.closed || !ed.closed || eu.key == ed.key || distance(eu.p, ed.p) < 2.0) { return; }
  var lo = ed;
  var hi = eu;
  var side = 0u;
  if (eu.key < ed.key) { lo = eu; hi = ed; side = 1u; }
  w5[base] = 1u;
  w5[base + 1u] = stripKey(p0);
  putV(base + 2u, lo.p);
  w5[base + 4u] = lo.key;
  putV(base + 5u, hi.p);
  w5[base + 7u] = hi.key;
  w5[base + 8u] = side;
  w7[id] = 1u;
}
fn trMid(t: u32) -> vec2<f32> { let b = t * TRW; return 0.5 * (vec2<f32>(r1(b + 2u), r1(b + 3u)) + vec2<f32>(r1(b + 5u), r1(b + 6u))); }
/** a round of the conflicts: kept (w5) a candidate no lower kept (b2) trace of its strip is nearer than 0.8 a.w */
@compute @workgroup_size(64)
fn mis(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let T = u.m.w * u32(u.c.w);
  if (i >= T) { return; }
  let bi = i * TRW;
  if (b1[bi] == 0u) { w5[i] = 0u; return; }
  let key = b1[bi + 1u];
  let mi = trMid(i);
  let R = 0.8 * u.a.w;
  var keep = 1u;
  for (var j = 0u; j < i; j++) {
    if (b2[j] == 0u) { continue; }
    if (b1[j * TRW + 1u] != key) { continue; }
    if (distance(trMid(j), mi) < R) { keep = 0u; break; }
  }
  w5[i] = keep;
}

// ---- blocks: a kept trace and the next kept one along its strip ----------------------------------------------
// Three block slots a trace (BQW words each): 0 the block to the next kept trace along its strip; 1 and 2, when there's
// no kept trace that way (+ along, − along), the end of its strip: its two lines walked to where another line (a spoke,
// a contour) cuts them. A block: 0 1 when there's one, 1 its edges' classes (8 bits each: 0 none — a shore, the town's
// edge, an open end; 1 a major line, 2 a cross street), 2–9 its corners counter-clockwise, 10 its trace.
// (r1 the traces, r2 kept, r4 the feature distance)
const BQW: u32 = 12u;
/** a block's quad written counter-clockwise (edges e[k] from v[k] to v[k + 1]); not when it isn't convex */
fn putBlock(o: u32, v0: array<vec2<f32>, 4>, e0: array<u32, 4>, tr: u32) -> bool {
  var v = v0;
  var e = e0;
  var area = 0.0;
  for (var k = 0; k < 4; k++) { area += cross2(v[k], v[(k + 1) % 4]); }
  if (area < 0.0) {
    v = array<vec2<f32>, 4>(v0[0], v0[3], v0[2], v0[1]);
    e = array<u32, 4>(e0[3], e0[2], e0[1], e0[0]);
  }
  for (var k = 0; k < 4; k++) {
    // (a straight corner allowed: a triangle block is a quad with a corner on an edge's middle)
    if (cross2(v[(k + 1) % 4] - v[k], v[(k + 2) % 4] - v[(k + 1) % 4]) < -1e-3) { return false; }
  }
  w5[o] = 1u;
  w5[o + 1u] = e[0] | (e[1] << 8u) | (e[2] << 16u) | (e[3] << 24u);
  for (var k = 0u; k < 4u; k++) { putV(o + 2u + k * 2u, v[k]); }
  w5[o + 10u] = tr;
  return true;
}
struct Stop { p: vec2<f32>, key: u32, hit: bool }
/** walk along line `key` (family's level set) from p0 the way `dir` points, up to `most`: where another family's line
 *  cuts it (exact: bisection), or where it leaves the town, meets the water, or runs out (not a hit) */
fn lineWalk(key: u32, p0: vec2<f32>, dir: vec2<f32>, most: f32) -> Stop {
  let k = key >> 24u;
  let level = f32(key & 0xffffffu);
  var p = p0;
  var t = dir;
  var s: Stop;
  s.hit = false;
  s.key = 0u;
  for (var n = 0; n < i32(most); n++) {
    let g = gradAt(k, p);
    if (length(g) < 1e-6) { break; }
    var tan = normalize(vec2<f32>(-g.y, g.x));
    if (dot(tan, t) < 0.0) { tan = -tan; }
    t = tan;
    var q = p + tan;
    for (var it = 0; it < 3; it++) {
      let gq = gradAt(k, q);
      var f = fieldAt(k, q);
      if (k == 3u) { f = unwrap(f, level); }
      q -= (f - level) * gq / max(dot(gq, gq), 1e-8);
    }
    if (!inb(q) || !inTown(q) || blockedAt(q)) { break; }
    for (var j = 1u; j <= 3u; j++) {
      if (j == k || !fam(j) || s.hit) { continue; }
      if (j == 3u && !(spokesAt(p) && spokesAt(q))) { continue; }
      let f0 = fieldAt(j, p);
      var f1 = fieldAt(j, q);
      if (j == 3u) { f1 = unwrap(f1, f0); }
      if (floor(f0) == floor(f1)) { continue; }
      let lv = select(floor(f0), floor(f1), f1 > f0);
      var a = 0.0;
      var b = 1.0;
      for (var it = 0; it < 12; it++) {
        let m = 0.5 * (a + b);
        var fm = fieldAt(j, mix(p, q, m));
        if (j == 3u) { fm = unwrap(fm, f0); }
        if ((fm >= lv) == (f0 >= lv)) { a = m; } else { b = m; }
      }
      var l2 = lv;
      if (j == 3u) { l2 = lv - floor(lv / u.a.z) * u.a.z; }
      s.p = mix(p, q, 0.5 * (a + b));
      s.key = lineKey(j, l2);
      s.hit = true;
    }
    if (s.hit) { return s; }
    p = q;
  }
  s.p = p;
  return s;
}
@compute @workgroup_size(64)
fn blocks(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let T = u.m.w * u32(u.c.w);
  if (i >= T) { return; }
  let o = i * 3u * BQW;
  w5[o] = 0u;
  w5[o + BQW] = 0u;
  w5[o + 2u * BQW] = 0u;
  if (b2[i] == 0u) { return; }
  let bi = i * TRW;
  let key = b1[bi + 1u];
  let lk = b1[bi + 4u];
  let hk = b1[bi + 7u];
  let lo = vec2<f32>(r1(bi + 2u), r1(bi + 3u));
  let hi = vec2<f32>(r1(bi + 5u), r1(bi + 6u));
  let mi = 0.5 * (lo + hi);
  let ax = normalize(hi - lo);
  let along = vec2<f32>(-ax.y, ax.x);
  let L = u.a.w;
  // (the nearest kept trace of the strip each way; the next one ahead with the same two lines)
  var best = NONE;
  var bd = 2.5 * L;
  var aheadAny = false;
  var behindAny = false;
  for (var j = 0u; j < T; j++) {
    if (j == i || b2[j] == 0u) { continue; }
    let bj = j * TRW;
    if (b1[bj + 1u] != key) { continue; }
    let dv = trMid(j) - mi;
    let al = dot(dv, along);
    if (abs(al) < 0.25 * L || length(dv) > 2.5 * L) { continue; }
    if (al > 0.0) { aheadAny = true; } else { behindAny = true; }
    if (al < 0.0 || b1[bj + 4u] != lk || b1[bj + 7u] != hk) { continue; }
    let dd = length(dv);
    if (dd < bd) { bd = dd; best = j; }
  }
  let cl = select(1u, 0u, (lk >> 24u) == 0u);
  let ch = select(1u, 0u, (hk >> 24u) == 0u);
  if (best != NONE) {
    let bj = best * TRW;
    let lo2 = vec2<f32>(r1(bj + 2u), r1(bj + 3u));
    let hi2 = vec2<f32>(r1(bj + 5u), r1(bj + 6u));
    _ = putBlock(o, array<vec2<f32>, 4>(lo, lo2, hi2, hi), array<u32, 4>(cl, 2u, ch, 2u), i);
  }
  // (the strip's ends: its two lines walked out to what cuts them; not along a shore)
  if (cl == 0u || ch == 0u) { return; }
  for (var side = 0u; side < 2u; side++) {
    if ((side == 0u && aheadAny) || (side == 1u && behindAny)) { continue; }
    let dir = select(along, -along, side == 1u);
    let a = lineWalk(lk, lo, dir, 2.5 * L);
    let b = lineWalk(hk, hi, dir, 2.5 * L);
    let cut = select(0u, 1u, a.hit && b.hit && a.key == b.key);
    _ = putBlock(o + (1u + side) * BQW, array<vec2<f32>, 4>(lo, a.p, b.p, hi), array<u32, 4>(1u, cut, 1u, 2u), i);
  }
}

// ---- lots: each block split across its longest edge until small enough ------------------------------------
// A lot (LW words): 0–7 its corners counter-clockwise, 8 its edges' classes, 9 a hash. w6[0] the lots' count.
const LW: u32 = 10u;
const DEPTH: u32 = 8u;
const STACK: u32 = 12u;
struct Quad { v: array<vec2<f32>, 4>, e: u32, d: u32 }
fn qArea(q: Quad) -> f32 {
  var a = 0.0;
  for (var k = 0; k < 4; k++) { a += cross2(q.v[k], q.v[(k + 1) % 4]); }
  return 0.5 * a;
}
fn ecls(e: u32, k: u32) -> u32 { return (e >> (8u * (k % 4u))) & 255u; }
@compute @workgroup_size(64)
fn lots(@builtin(global_invocation_id) g: vec3<u32>) {
  let bi = g.x;
  let T = nSeeds();
  if (bi >= 3u * T) { return; }
  let o = bi * BQW;
  if (b1[o] == 0u) { return; }
  // (m3h: a block whose supercell is out or empty, or not grown yet, isn't lotted — bgrow's meta words 10 and 9)
  if (u.h2.z > 0.5 && bi % 3u == 0u && !(b1[o + BQW + 10u] == 2u && bitcast<f32>(b1[o + BQW + 9u]) <= u.h2.x)) { return; }
  // (m3d: a block made a plaza — its meta, the slot after it, status 1 — is one paved lot, not split)
  let plaza = bi % 3u == 0u && u.o.w == 0u && b1[o + BQW + 5u] == 1u;
  var st: array<Quad, STACK>;
  var n = 1u;
  var q0: Quad;
  for (var k = 0u; k < 4u; k++) { q0.v[k] = vec2<f32>(r1(o + 2u + k * 2u), r1(o + 3u + k * 2u)); }
  q0.e = b1[o + 1u];
  // (m3i: a side facing a hidden block — out past the limit, an empty district, not grown — is open land, no street:
  // the lots face the inside streets, their backs to the open land)
  var edge = false;
  if (u.h2.z > 0.5 && bi % 3u == 0u) {
    for (var k = 0u; k < 4u; k++) {
      let a = q0.v[k];
      let b = q0.v[(k + 1u) % 4u];
      let d = b - a;
      if (dot(d, d) < 1e-6) { continue; }
      let out = normalize(vec2<f32>(d.y, -d.x));
      if (!shownCity(cityB4(0.5 * (a + b) + out * 0.5 * u.a.w))) {
        q0.e = q0.e & ~(255u << (8u * k));
        edge = true;
      }
    }
  }
  q0.d = 0u;
  st[0] = q0;
  var made = 0u;
  while (n > 0u) {
    n--;
    let q = st[n];
    let A = qArea(q);
    // (halves under the smallest lot's area: not split — the merge)
    let split = !plaza && A > u.c.x && q.d < DEPTH && n + 2u <= STACK && A * 0.42 >= u.c.y;
    if (split) {
      var k = 0u;
      var ll = -1.0;
      for (var j = 0u; j < 4u; j++) { let l = distance(q.v[j], q.v[(j + 1u) % 4u]); if (l > ll) { ll = l; k = j; } }
      let t = 0.5 + (hsh(bi * 977u + q.d * 131u + made * 17u + n) - 0.5) * 0.16;
      let v0 = q.v[k]; let v1 = q.v[(k + 1u) % 4u]; let v2 = q.v[(k + 2u) % 4u]; let v3 = q.v[(k + 3u) % 4u];
      let c1 = mix(v0, v1, t);
      let c2 = mix(v3, v2, t);
      let ek = ecls(q.e, k); let e1 = ecls(q.e, k + 1u); let e2 = ecls(q.e, k + 2u); let e3 = ecls(q.e, k + 3u);
      var a: Quad;
      a.v = array<vec2<f32>, 4>(v0, c1, c2, v3);
      // (m3f: a big block's first two splits are roads — the cut a street both sides, its segment listed)
      let road = u.l.z > 0.0 && A >= u.l.z && q.d < 2u;
      let cut = select(0u, 2u, road);
      if (road) {
        let k2 = atomicAdd(&w6[1], 1u);
        if (k2 < ROAD_ROOM) {
          atomicStore(&w6[4u + k2 * 4u], bitcast<u32>(c1.x));
          atomicStore(&w6[5u + k2 * 4u], bitcast<u32>(c1.y));
          atomicStore(&w6[6u + k2 * 4u], bitcast<u32>(c2.x));
          atomicStore(&w6[7u + k2 * 4u], bitcast<u32>(c2.y));
        }
      }
      a.e = ek | (cut << 8u) | (e2 << 16u) | (e3 << 24u);
      a.d = q.d + 1u;
      var b: Quad;
      b.v = array<vec2<f32>, 4>(c1, v1, v2, c2);
      b.e = ek | (e1 << 8u) | (e2 << 16u) | (cut << 24u);
      b.d = q.d + 1u;
      st[n] = a;
      st[n + 1u] = b;
      n += 2u;
      continue;
    }
    let li = atomicAdd(&w6[0], 1u);
    if (li >= u.m.x) { continue; }
    let lo = li * LW;
    for (var j = 0u; j < 4u; j++) { putV(lo + j * 2u, q.v[j]); }
    w5[lo + 8u] = q.e;
    w5[lo + 9u] = (bi * 256u + made) | select(0u, PAVED, plaza) | select(0u, EDGE_LOT, edge);
    made++;
  }
}

// ---- the mesh (vsSkin: two vec4<u32> a vertex — position bits + colour, normal bits + 1) -------------------
fn hAt(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  return t.w.x * r3(ixq(t.c[0])) + t.w.y * r3(ixq(t.c[1])) + t.w.z * r3(ixq(t.c[2]));
}
/** a vertex into the mesh (w7) */
fn vert(at: u32, p: vec3<f32>, col: u32, n: vec3<f32>) {
  let o = at * 8u;
  w7[o] = bitcast<u32>(p.x);
  w7[o + 1u] = bitcast<u32>(p.y);
  w7[o + 2u] = bitcast<u32>(p.z);
  w7[o + 3u] = col;
  w7[o + 4u] = bitcast<u32>(n.x);
  w7[o + 5u] = bitcast<u32>(n.y);
  w7[o + 6u] = bitcast<u32>(n.z);
  w7[o + 7u] = 1u;
}
fn tri(at: u32, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, col: u32) {
  var n = cross(b - a, c - a);
  let l = length(n);
  n = select(vec3<f32>(0.0, 0.0, 1.0), n / max(l, 1e-6), l > 1e-6);
  vert(at, a, col, n);
  vert(at + 1u, b, col, n);
  vert(at + 2u, c, col, n);
}
/** room for `count` vertices: the first, or NONE when the mesh is full */
fn room(count: u32) -> u32 {
  let b = atomicAdd(&args[0], count);
  if (b + count > u.m.y) { return NONE; }
  return b;
}
/** a flat ribbon piece from a to b, half width hw, lifted over the ground */
fn ribbon(at: u32, a: vec2<f32>, b: vec2<f32>, hw: f32, col: u32) {
  let d = normalize(b - a);
  let s = vec2<f32>(-d.y, d.x) * hw;
  let lift = 0.22;
  let p0 = vec3<f32>(a - s, hAt(a - s) + lift);
  let p1 = vec3<f32>(b - s, hAt(b - s) + lift);
  let p2 = vec3<f32>(b + s, hAt(b + s) + lift);
  let p3 = vec3<f32>(a + s, hAt(a + s) + lift);
  tri(at, p0, p1, p2, col);
  tri(at + 3u, p0, p2, p3, col);
}
const C_MAJOR: u32 = 0xfbf7eeu;
const C_MINOR: u32 = 0xeee8dau;
const C_STEEP: u32 = 0xf08c33u;
fn steep(a: vec2<f32>, b: vec2<f32>) -> bool { return abs(hAt(b) - hAt(a)) > u.d.w * max(distance(a, b), 1e-3); }

/** the major lines: one thread a column, a ribbon piece where a family's line passes it (r3 H, r4 the distance) */
@compute @workgroup_size(8, 8)
fn roadMajor(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let c = cpos(x, y);
  if (!inTown(c) || blockedAt(c) || inLandmarkB1(c)) { return; }
  for (var k = 1u; k <= 3u; k++) {
    if (!fam(k)) { continue; }
    // (the line passes the column: its field's floor differs to one of three neighbours')
    let f0 = fieldAt(k, c);
    var crosses = false;
    var level = 0.0;
    for (var j = 0; j < 3; j++) {
      var q = cpos(x + 1, y);
      if (j == 1) { q = cpos(x, y + 1); }
      if (j == 2) { q = cpos(x - 1 + 2 * (y & 1), y + 1); }
      if (k == 3u && !(spokesAt(c) && spokesAt(q))) { continue; }
      var f1 = fieldAt(k, q);
      if (k == 3u) { f1 = unwrap(f1, f0); }
      if (floor(f0) != floor(f1) && !blockedAt(q)) { crosses = true; level = max(floor(f0), floor(f1)); }
    }
    if (!crosses) { continue; }
    // (the column's centre onto the line: Newton on its field)
    var p = c;
    for (var it = 0; it < 4; it++) {
      let gr = gradAt(k, p);
      var f = fieldAt(k, p);
      if (k == 3u) { f = unwrap(f, level); }
      p -= (f - level) * gr / max(dot(gr, gr), 1e-8);
    }
    if (distance(p, c) > 1.2) { continue; }
    let gr = gradAt(k, p);
    if (length(gr) < 1e-6) { continue; }
    let t = normalize(vec2<f32>(-gr.y, gr.x));
    let a = p - t * 0.85;
    let b = p + t * 0.85;
    // (m3i: drawn where the blocks both sides are shown, and on through the empty supercells as they grow)
    if (u.h2.z > 0.5) {
      let side = normalize(gr) * 0.35 * u.a.x;
      let c = cityB2(p);
      if (!((shownCity(cityB2(p + side)) && shownCity(cityB2(p - side))) || (c.state == 1u && c.t <= u.h2.x))) { continue; }
    }
    let at = room(6u);
    if (at == NONE) { return; }
    ribbon(at, a, b, u.b.x * 0.5, select(C_MAJOR, C_STEEP, steep(a, b)));
  }
}
/** the cross streets: one thread a trace's segment (TP a trace), a ribbon piece (r1 the traces, r2 kept, r3 H) */
@compute @workgroup_size(64)
fn roadMinor(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x / TP;
  let k = g.x % TP;
  let T = u.m.w * u32(u.c.w);
  if (i >= T || b2[i] == 0u) { return; }
  let b = i * TRW;
  let p0 = b1[b + 9u];
  let p1 = b1[b + 10u];
  if (k < p0 || k >= p1) { return; }
  let at = room(6u);
  if (at == NONE) { return; }
  let a = vec2<f32>(r1(b + 16u + k * 2u), r1(b + 17u + k * 2u));
  let c = vec2<f32>(r1(b + 18u + k * 2u), r1(b + 19u + k * 2u));
  let d = normalize(c - a) * 0.3;
  ribbon(at, a - d, c + d, u.b.y * 0.5, select(C_MINOR, C_STEEP, steep(a, c)));
}
const C_WALL: u32 = 0xf3eee6u;
const C_PARK: u32 = 0x9fcf86u;
fn roofColour(k: u32) -> u32 {
  switch (k) {
    case 0u: { return 0xf6c6a8u; }
    case 1u: { return 0xf2dfa7u; }
    case 2u: { return 0xc9d9f0u; }
    case 3u: { return 0xe9c2d9u; }
    case 4u: { return 0xcfe3c0u; }
    default: { return 0xd9d2f2u; }
  }
}
/** corner k of the quad inset by d[] (its edges' insets): the crossing of edges k − 1 and k moved in */
fn insetCorner(v: array<vec2<f32>, 4>, d: array<f32, 4>, k: u32) -> vec2<f32> {
  let km = (k + 3u) % 4u;
  let da = normalize(v[k] - v[km]);
  let db = normalize(v[(k + 1u) % 4u] - v[k]);
  let pa = v[km] + vec2<f32>(-da.y, da.x) * d[km];
  let pb = v[k] + vec2<f32>(-db.y, db.x) * d[k];
  let den = cross2(da, db);
  if (abs(den) < 1e-4) { return pb; }
  return pa + da * (cross2(pb - pa, db) / den);
}
/** (m3d) a lot paved: flat, a little in from its corners */
fn paveLot(v: array<vec2<f32>, 4>, mid: vec2<f32>) {
  let at = room(6u);
  if (at == NONE) { return; }
  var z: array<vec3<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { z[k] = vec3<f32>(mix(v[k], mid, 0.04), hAt(v[k]) + 0.15); }
  tri(at, z[0], z[1], z[2], C_PAVE);
  tri(at + 3u, z[0], z[2], z[3], C_PAVE);
}
/** one thread a lot slot: inset, extruded — a park when no street fronts it (r1 the lots, r2 their count, r3 H, r4 the distance) */
@compute @workgroup_size(64)
fn lotMesh(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= min(b2[0], u.m.x)) { return; }
  let o = i * LW;
  var v: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { v[k] = vec2<f32>(r1(o + k * 2u), r1(o + 1u + k * 2u)); }
  let e = b1[o + 8u];
  let hs = b1[o + 9u];
  let mid = 0.25 * (v[0] + v[1] + v[2] + v[3]);
  if (blockedAt(mid)) { return; }
  // (m3d: paved — a plaza block, inside a junction's plaza, or a bad lot (a sliver): flat paving, no building)
  // (m3e: a lot whose middle is in a landmark's circle is the landmark's: none)
  if (inLandmarkW5(mid)) { return; }
  if ((hs & PAVED) != 0u || (u.q.x < 1.5 && badQuad(v, 0.0))) { paveLot(v, mid); return; }
  var street = false;
  var d: array<f32, 4>;
  for (var k = 0u; k < 4u; k++) {
    let c = ecls(e, k);
    if (c == 1u) { d[k] = u.b.x * 0.5 + u.b.z; street = true; }
    else if (c == 2u) { d[k] = u.b.y * 0.5 + u.b.z; street = true; }
    else { d[k] = 0.35; }
  }
  var q: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { q[k] = insetCorner(v, d, k); }
  // (an inset turned inside out or too small: paved — m3d; m2 left it empty)
  var area = 0.0;
  for (var k = 0u; k < 4u; k++) { area += cross2(q[k], q[(k + 1u) % 4u]); }
  if (area < 2.0) { if (u.q.x < 1.5) { paveLot(v, mid); } return; }
  for (var k = 0u; k < 4u; k++) {
    if (cross2(q[(k + 1u) % 4u] - q[k], q[(k + 2u) % 4u] - q[(k + 1u) % 4u]) <= 0.0) { if (u.q.x < 1.5) { paveLot(v, mid); } return; }
  }
  // (m3i: an edge block's lots: one with no street is open land, and now and then one fronting a street is left
  // empty too — a ragged edge)
  if ((hs & EDGE_LOT) != 0u && (!street || hsh(hs ^ 0x9e37u) < 0.15)) { return; }
  if (!street) {
    let at = room(6u);
    if (at == NONE) { return; }
    var z: array<vec3<f32>, 4>;
    for (var k = 0u; k < 4u; k++) { z[k] = vec3<f32>(q[k], hAt(q[k]) + 0.12); }
    tri(at, z[0], z[1], z[2], C_PARK);
    tri(at + 3u, z[0], z[2], z[3], C_PARK);
    return;
  }
  var zlo = 1e9;
  var zhi = -1e9;
  for (var k = 0u; k < 4u; k++) { let z = hAt(q[k]); zlo = min(zlo, z); zhi = max(zhi, z); }
  let at = room(30u);
  if (at == NONE) { return; }
  let top = zhi + max(1.0, u.b.w * 3.0 * (0.7 + 0.6 * hsh(hs)));
  let base = zlo - 0.5;
  let roof = roofColour(u32(hsh(hs * 7u + 3u) * 5.999));
  tri(at, vec3<f32>(q[0], top), vec3<f32>(q[1], top), vec3<f32>(q[2], top), roof);
  tri(at + 3u, vec3<f32>(q[0], top), vec3<f32>(q[2], top), vec3<f32>(q[3], top), roof);
  for (var k = 0u; k < 4u; k++) {
    let a = q[k];
    let b = q[(k + 1u) % 4u];
    // (counter-clockwise: outward is right of a → b)
    tri(at + 6u + k * 6u, vec3<f32>(a, base), vec3<f32>(b, top), vec3<f32>(a, top), C_WALL);
    tri(at + 9u + k * 6u, vec3<f32>(a, base), vec3<f32>(b, base), vec3<f32>(b, top), C_WALL);
  }
}
/** the count clamped to the room (threads past it wrote nothing) */
@compute @workgroup_size(1)
fn meshCap() {
  let n = atomicLoad(&args[0]);
  atomicStore(&args[0], min(n, u.m.y));
}

// ==== milestone 3a: one blended field φ ======================================================================
// φ = the smoothed distance to water and cliffs, bent near a few points: a smooth min with a cone round each point
// (o.z 1) or a bump taken off it (o.z 2), each point's term faded out by its radius — beyond it φ is the distance.
// The major lines are φ's level sets; near a point they close into rings and ∇φ turns radial (spokes for free).
// A point (PW words): 0 1 its position, 2 its intensity (× its radius and its strength), 3 its cone's offset (GPU), 4 its flag (the CPU's: 0 placed
// by the GPU, 1 pinned — placed or moved by a tap, 2 removed), 5 alive (the GPU's), 6 7 unused.
const NPTS: u32 = 8u;
const PW: u32 = 8u;
const AUTO: u32 = 4u;
var<workgroup> wsc: array<f32, 256>;
var<workgroup> wid: array<u32, 256>;
var<workgroup> chosen: array<vec2<f32>, 4>;
/** how far a column stands above the ground round it (r1 the smoothed heights): a knoll's score */
fn prominence(x: i32, y: i32) -> f32 {
  let p = cpos(x, y);
  var s = 0.0;
  for (var k = 0; k < 6; k++) {
    let a = f32(k) * TAU / 6.0;
    s += r1(ixp(p + 12.0 * vec2<f32>(cos(a), sin(a))));
  }
  return r1(ix(x, y)) - s / 6.0;
}
fn fdbAt(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  return t.w.x * r2(ixq(t.c[0])) + t.w.y * r2(ixq(t.c[1])) + t.w.z * r2(ixq(t.c[2]));
}
/** one workgroup: the auto points (the town's middle moved inland, then the most prominent knoll, a shore point nearest the centre,
 *  the next knoll — each 1.6 point radii from those before) into the slots the CPU left to the GPU, and every live
 *  point's cone offset (r1 the smoothed heights, r2 the smoothed distance, r3 the blocked mask; w5 the points) */
@compute @workgroup_size(256)
fn autoPts(@builtin(local_invocation_index) li: u32) {
  let nAuto = u32(u.e.w);
  let R = u.e.y;
  let c = u.d.xy;
  let x0 = max(i32(c.x - u.d.z) - 1, 0);
  let x1 = min(i32(c.x + u.d.z) + 1, W() - 1);
  let y0 = max(i32((c.y - u.d.z) / ROW_H) - 1, 0);
  let y1 = min(i32((c.y + u.d.z) / ROW_H) + 1, H() - 1);
  // (every fourth column each way; n.w 1: nothing they're placed from changed — the auto points stay, offsets only)
  let bw = u32(max((x1 - x0) / 4 + 1, 1));
  let bh = u32(max((y1 - y0) / 4 + 1, 1));
  let place = u.n.w == 0u;
  for (var k = 0u; k < AUTO; k++) {
    if (!place) { break; }
    var best = -1e30;
    var bi = NONE;
    for (var j = li; j < bw * bh; j += 256u) {
      let x = x0 + 4 * i32(j % bw);
      let y = y0 + 4 * i32(j / bw);
      let p = cpos(x, y);
      if (distance(p, c) > select(0.8, 0.4, k == 0u) * u.d.z) { continue; }
      let i = ix(x, y);
      if (r3(i) > 0.5) { continue; }
      var far = true;
      for (var m = 0u; m < k; m++) { if (distance(p, chosen[m]) < 1.6 * R) { far = false; } }
      if (!far) { continue; }
      var sc = 0.0;
      if (k == 0u) {
        // (the centre: the town's middle, moved inland — off the water, where its rings have room)
        sc = r2(i) - 0.5 * distance(p, c);
      } else if (k == 2u) {
        let d = r2(i);
        if (d < 3.0 || d > 10.0) { continue; }
        sc = -distance(p, c);
      } else {
        sc = prominence(x, y);
      }
      if (sc > best) { best = sc; bi = pk(u32(x), u32(y), 0u); }
    }
    wsc[li] = best;
    wid[li] = bi;
    workgroupBarrier();
    for (var st = 128u; st > 0u; st >>= 1u) {
      if (li < st && wsc[li + st] > wsc[li]) { wsc[li] = wsc[li + st]; wid[li] = wid[li + st]; }
      workgroupBarrier();
    }
    if (li == 0u) { chosen[k] = select(ppos(wid[0]), vec2<f32>(-1e5), wid[0] == NONE); }
    workgroupBarrier();
  }
  if (li >= NPTS) { return; }
  let o = li * PW;
  let flag = w5[o + 4u];
  var alive = flag == 1u;
  if (li < AUTO && flag == 0u && !place) {
    alive = w5[o + 5u] == 1u;
  } else if (li < AUTO && flag == 0u) {
    alive = li < nAuto && chosen[li].x > -1e4;
    if (alive) {
      putV(o, chosen[li]);
      // (the intensities: the centre largest, the minor points smaller)
      set5(o + 2u, array<f32, 4>(1.0, 0.7, 0.55, 0.45)[li]);
    }
  }
  w5[o + 5u] = select(0u, 1u, alive);
  if (alive) {
    let p = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
    let I = bitcast<f32>(w5[o + 2u]);
    // (the cone meets the distance strength × radius out — both × the point's intensity: its rings inside its radius.
    // Near the water the offset goes negative: φ is 0 out to the shore's distance — a plaza — and rings past it)
    set5(o + 3u, fdbAt(p) - u.e.z * I * R * I);
  }
}
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / max(k, 1e-4);
  return min(a, b) - h * h * k * 0.25;
}
/** φ a column, negative where blocked — the field the major lines are level sets of (r1 the smoothed distance, r2 the
 *  blocked mask, r3 the points; w5 φ). A boxed pass from o.xy: a point's change touches only its radius */
@compute @workgroup_size(8, 8)
fn phi(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x + u.o.x); let y = i32(g.y + u.o.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  if (r2(i) > 0.5) { set5(i, -1.0); return; }
  let p = cpos(x, y);
  var f = max(r1(i), 0.0);
  if (u.o.z != 0u) {
    for (var j = 0u; j < NPTS; j++) {
      let o = j * PW;
      if (b3[o + 5u] == 0u) { continue; }
      let R = u.e.y * r3(o + 2u);
      let r = distance(p, vec2<f32>(r3(o), r3(o + 1u)));
      if (r >= R) { continue; }
      if (u.o.z == 1u) {
        f = mix(smin(f, r3(o + 3u) + r, u.e.x), f, smoothstep(0.7, 1.0, r / R));
      } else {
        let q = 1.0 - (r / R) * (r / R);
        f -= u.e.z * r3(o + 2u) * R * q * q;
      }
    }
  }
  set5(i, max(f, 0.0));
}

// ==== milestone 3b: cross streets by vector JFA ==============================================================
// Seeds on the major lines (a lattice point snapped onto its nearest line, thinned to a block length apart by an
// occupancy grid), a jump flood over the even lines' seeds and one over the odd lines', and each seed's cross street:
// half a level up the gradient from it, the nearest seed of the other parity — on the next line up. A seed's street and
// the next seed's along its line bound a block, its corners exactly on the lines.
// A seed (SDW words): 0 1 its position, 2 its line's level, 3 alive, 4 its street's other end (a seed; EDGE the town's
// edge; NONE none), 5 6 where that street ends (m3e: clipped at a landmark's circle), 7 the next seed along its line,
// 8 9 where its street starts (clipped), 10 flags (1 start clipped, 2 end clipped).
const SDW: u32 = 12u;
const SID: u32 = 0x3fffu;
/** (m3d) a cross street that ends on the town's edge — the circle a closing line */
const EDGE: u32 = 0xfffffffeu;
/** (m3f) a cross street that ends on a ridge of φ (no next line there), or on the next line with no seed to meet */
const RIDGE: u32 = 0xfffffffdu;
const LINE_END: u32 = 0xfffffffcu;
fn isOpen(t: u32) -> bool { return t >= LINE_END && t != NONE; }
/** an end on the next line: a seed, or a line end */
fn onLine(t: u32) -> bool { return t <= LINE_END; }
/** the field the seeds sit on: φ's (family 1) or, radial, the rings' */
fn mainK() -> u32 { return select(2u, 1u, fam(1u)); }
/** the seed slots: the lattice's, and (m3g, grown streets) as many again for the landings */
fn nSeeds() -> u32 { return u.m.w * u32(u.c.w) * select(1u, 2u, u.r.z > 0.5); }
fn occDims() -> vec2<u32> { return vec2<u32>(u32(f32(W()) / u.a.w) + 2u, u32(f32(H()) * ROW_H / u.a.w) + 2u); }
fn occAt(c: vec2<i32>, L: u32) -> u32 {
  let d = occDims();
  let q = vec2<u32>(clamp(c, vec2<i32>(0), vec2<i32>(d) - 1));
  return ((L & 3u) * d.y + q.y) * d.x + q.x;
}
/** one thread a lattice point: snapped onto its nearest line (Newton on the field), its claim on its occupancy cell
 *  (w5 the seeds, w6 the grid: the lowest key — nearest the cell's middle — wins; b4 φ) */
@compute @workgroup_size(64)
fn vseed(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  let mx = u.m.w;
  let my = u32(u.c.w);
  if (id >= mx * my) { return; }
  let o = id * SDW;
  w5[o + 3u] = 0u;
  w5[o + 4u] = NONE;
  let sp = u.a.w * 0.5;
  let p0 = (vec2<f32>(f32(id % mx), f32(id / mx)) + 0.5) * sp;
  if (!inb(p0) || !inTown(p0) || blockedAt(p0)) { return; }
  let k = mainK();
  let L = round(fieldAt(k, p0));
  if (L < 0.0) { return; }
  var p = p0;
  for (var it = 0; it < 5; it++) {
    let gr = gradAt(k, p);
    p -= (fieldAt(k, p) - L) * gr / max(dot(gr, gr), 1e-8);
  }
  if (abs(fieldAt(k, p) - L) > 0.02 || distance(p, p0) > sp || !inb(p) || !inTown(p) || blockedAt(p)) { return; }
  putV(o, p);
  w5[o + 2u] = u32(L);
  w5[o + 3u] = 1u;
  let cc = (floor(p / u.a.w) + 0.5) * u.a.w;
  let key = (u32(min(distance(p, cc) / u.a.w, 0.99) * 4096.0) << 14u) | id;
  atomicMin(&w6[occAt(vec2<i32>(floor(p / u.a.w)), u32(L))], key);
}
/** a seed kept: it won its cell, and no neighbouring cell's winner of its line with a lower key is nearer than 0.6
 *  block lengths (w5 the seeds — only alive written; b2 the grid) */
@compute @workgroup_size(64)
fn vthin(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= u.m.w * u32(u.c.w)) { return; }
  let o = id * SDW;
  if (w5[o + 3u] == 0u) { return; }
  let p = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
  let L = w5[o + 2u];
  let c = vec2<i32>(floor(p / u.a.w));
  let mine = b2[occAt(c, L)];
  var keep = (mine & SID) == id;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (!keep || (dx == 0 && dy == 0)) { continue; }
      let v = b2[occAt(c + vec2<i32>(dx, dy), L)];
      if (v == NONE || v >= mine) { continue; }
      let j = (v & SID) * SDW;
      if (w5[j + 2u] != L) { continue; }
      // (m3g, grown: thinned to 0.85 — the first line's streets evenly spaced)
      if (distance(vec2<f32>(bitcast<f32>(w5[j]), bitcast<f32>(w5[j + 1u])), p) < select(0.6, 0.85, u.r.z > 0.5) * u.a.w) { keep = false; }
    }
  }
  if (!keep) { w5[o + 3u] = 0u; }
}
fn sdPos(j: u32) -> vec2<f32> { return vec2<f32>(r1(j * SDW), r1(j * SDW + 1u)); }
/** where seed j's cross street ends (words 5 6: a seed's position, the point on the town's edge, or on a circle) */
fn sdEnd(j: u32) -> vec2<f32> { return vec2<f32>(r1(j * SDW + 5u), r1(j * SDW + 6u)); }
/** where it starts (8 9: the seed, or where its street leaves a landmark's circle) */
fn sdStart(j: u32) -> vec2<f32> { return vec2<f32>(r1(j * SDW + 8u), r1(j * SDW + 9u)); }
/** the kept seeds into the floods' columns: even lines' w5, odd lines' w7 (r1 the seeds) */
@compute @workgroup_size(64)
fn vrast(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  if (b1[o + 3u] == 0u) { return; }
  let i = ixp(sdPos(id));
  if ((b1[o + 2u] & 1u) == 0u) { w5[i] = id; } else { w7[i] = id; }
}
/** a jump-flood step of size k over both floods (b1 even, b2 odd → w5, w7; b3 the seeds) */
@compute @workgroup_size(8, 8)
fn vjfa(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let k = i32(u.n.z);
  let p = cpos(x, y);
  var be = NONE; var de = 1e30;
  var bo = NONE; var dd = 1e30;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let qx = x + dx * k; let qy = y + dy * k;
      if (qx < 0 || qy < 0 || qx >= W() || qy >= H()) { continue; }
      let qi = u32(qy * W() + qx);
      let ve = b1[qi];
      if (ve != NONE) { let d = distance(vec2<f32>(r3(ve * SDW), r3(ve * SDW + 1u)), p); if (d < de) { de = d; be = ve; } }
      let vo = b2[qi];
      if (vo != NONE) { let d = distance(vec2<f32>(r3(vo * SDW), r3(vo * SDW + 1u)), p); if (d < dd) { dd = d; bo = vo; } }
    }
  }
  w5[ix(x, y)] = be;
  w7[ix(x, y)] = bo;
}
/** the nearest kept seed of line parity `par` to p (b2 even, b3 odd) */
fn nearestOf(par: u32, p: vec2<f32>) -> u32 {
  if (!inb(p)) { return NONE; }
  if (par == 0u) { return b2[ixp(p)]; }
  return b3[ixp(p)];
}
/** one thread a seed: its cross street — half a level up the gradient from it, the other parity's nearest seed, kept
 *  when it's on the next line up, near enough, and no water or cliff between (w5 the seeds: only word 4 written; b2 b3
 *  the floods, b4 φ) */
@compute @workgroup_size(64)
fn vseg(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  if (w5[o + 3u] == 0u) { return; }
  let s = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
  let L = w5[o + 2u];
  let gr = gradAt(mainK(), s);
  let gl2 = dot(gr, gr);
  if (gl2 < 1e-8) { return; }
  let t = nearestOf((L + 1u) & 1u, s + 0.5 * gr / gl2);
  var ok = t != NONE;
  var e = s;
  if (ok) {
    let to = t * SDW;
    ok = w5[to + 3u] == 1u && w5[to + 2u] == L + 1u;
    e = vec2<f32>(bitcast<f32>(w5[to]), bitcast<f32>(w5[to + 1u]));
  }
  var end = t;
  // (m3f: no seed to pair with — march up the gradient instead: to the next line (no seed there: a line end), to the
  // ridge where φ stops rising before the next line (a river's tongue, a saddle: before, no street and an empty
  // strip), or (m3d) to the town's edge)
  if (!ok) {
    var q = s;
    var fq = fieldAt(mainK(), s);
    let most = 2.5 / sqrt(gl2);
    for (var k = 0; k < 64; k++) {
      if (distance(q, s) > most) { break; }
      let gq = gradAt(mainK(), q);
      if (dot(gq, gq) < 1e-10) { e = q; end = RIDGE; ok = true; break; }
      let n = q + 2.0 * normalize(gq);
      if (!inTown(n)) {
        let up = normalize(n - q);
        let rel = q - u.d.xy;
        let b = dot(rel, up);
        let disc = b * b - (dot(rel, rel) - u.d.z * u.d.z);
        e = q + up * max(-b + sqrt(max(disc, 0.0)) - 0.5, 0.0);
        end = EDGE;
        ok = true;
        break;
      }
      if (blockedAt(n)) { break; }
      let fn1 = fieldAt(mainK(), n);
      if (fn1 >= f32(L + 1u)) { e = mix(q, n, clamp((f32(L + 1u) - fq) / max(fn1 - fq, 1e-6), 0.0, 1.0)); end = LINE_END; ok = true; break; }
      if (fn1 <= fq + 1e-3) { e = q; end = RIDGE; ok = true; break; }
      q = n;
      fq = fn1;
    }
  }
  if (!ok || distance(s, e) < 1.0) { return; }
  // (no longer than 2.5 levels' spacing here)
  if (distance(s, e) * sqrt(gl2) > 2.5) { return; }
  for (var k = 1; k < 8; k++) { if (blockedAt(mix(s, e, f32(k) / 8.0))) { return; } }
  w5[o + 4u] = end;
  set5(o + 5u, e.x);
  set5(o + 6u, e.y);
}
fn segsCross(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>, d: vec2<f32>) -> bool {
  let r = b - a;
  let s = d - c;
  let den = cross2(r, s);
  if (abs(den) < 1e-6) { return false; }
  let t = cross2(c - a, s) / den;
  let v = cross2(c - a, r) / den;
  return t > 0.02 && t < 0.98 && v > 0.02 && v < 0.98;
}
/** one thread a seed with a street: the next seed along its line (ahead, the tangent's way: the same-parity flood
 *  looked up a block length ahead) and the block between their streets — a quad, or a triangle when they end at the
 *  same seed; the street drawn unless it crosses that next one's (r1 the seeds, b2 b3 the floods, b4 φ; w5 the
 *  blocks, w7 drawn) */
@compute @workgroup_size(64)
fn vblock(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let ob = id * 3u * BQW;
  w5[ob] = 0u;
  w5[ob + 2u * BQW] = 0u;
  // (m3d: the block's meta in the slot after it — never a block itself: word 0 stays 0)
  let mo = ob + BQW;
  w5[mo] = 0u;
  w5[mo + 1u] = 0u;
  w5[mo + 2u] = NONE;
  w5[mo + 3u] = NONE;
  w5[mo + 4u] = 0u;
  w5[mo + 5u] = 0u;
  w5[mo + 6u] = NONE;
  w5[mo + 7u] = 0u;
  w5[mo + 8u] = id;
  w7[id] = 0u;
  let o = id * SDW;
  let ts = b1[o + 4u];
  if (b1[o + 3u] == 0u || ts == NONE) { return; }
  let s = sdStart(id);
  let c = b1[o + 7u];
  var tc = NONE;
  if (c != NONE) { tc = b1[c * SDW + 4u]; }
  if (tc == NONE) { w7[id] = 1u; return; }
  let es = sdEnd(id);
  let ec = sdEnd(c);
  let sc = sdStart(c);
  if (segsCross(s, es, sc, ec)) { return; }
  w7[id] = 1u;
  // (a street to the next line beside one to a ridge or the town's edge: a block whose far side has no street —
  // m3g; before, none)
  let mixed = onLine(ts) != onLine(tc);
  w5[mo + 2u] = c;
  // (m3e: streets that end on a landmark's circle — the far side the ring road, a trapezoid, never a triangle)
  let ring = (b1[o + 10u] & 2u) != 0u && (b1[c * SDW + 10u] & 2u) != 0u;
  if (tc == ts && !isOpen(ts) && !ring) {
    w5[mo + 4u] = 1u;
    _ = putBlock(ob, array<vec2<f32>, 4>(s, sc, es, 0.5 * (es + s)), array<u32, 4>(1u, 2u, 2u, 2u), id);
  } else {
    // (the far side: the next line, the ring road, or — the town's edge, a ridge — no street: lots back to back)
    let far = select(select(1u, 2u, ring), 0u, !onLine(ts) || mixed);
    _ = putBlock(ob, array<vec2<f32>, 4>(s, sc, ec, es), array<u32, 4>(1u, 2u, far, 2u), id);
  }
}
/** the cross streets: eight ribbon pieces a drawn street, on the ground, clipped at the landmarks (r1 the seeds, r2
 *  drawn, r3 H) */
@compute @workgroup_size(64)
fn vroad(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x / 8u;
  let k = g.x % 8u;
  if (id >= nSeeds() || b2[id] == 0u) { return; }
  let t = b1[id * SDW + 4u];
  if (t == NONE) { return; }
  let s = sdStart(id);
  let e = sdEnd(id);
  let a = mix(s, e, f32(k) / 8.0);
  let b = mix(s, e, f32(k + 1u) / 8.0);
  // (m3h, m3i: drawn where the blocks both sides are shown — a street only where lots face it; the edge blocks face
  // inwards — and an arterial, about one street in three, also through the empty supercells)
  if (u.h2.z > 0.5) {
    let mid = 0.5 * (a + b);
    let side = normalize(vec2<f32>(a.y - b.y, b.x - a.x)) * 0.5 * u.a.w;
    let c = cityB4(mid);
    let arterial = hsh(id * 31u + 5u) < 0.33;
    if (!((shownCity(cityB4(mid + side)) && shownCity(cityB4(mid - side))) || (arterial && c.state == 1u && c.t <= u.h2.x))) { return; }
  }
  let at = room(6u);
  if (at == NONE) { return; }
  let d = normalize(b - a) * 0.3;
  ribbon(at, a - d, b + d, u.b.y * 0.5, select(C_MINOR, C_STEEP, steep(a, b)));
}
/** the points as markers: a little hexagonal spire each, red placed by the GPU, blue pinned (r1 the points, r3 H) */
@compute @workgroup_size(8)
fn marks(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = g.x;
  if (j >= NPTS) { return; }
  let o = j * PW;
  if (b1[o + 5u] == 0u) { return; }
  let p = vec2<f32>(r1(o), r1(o + 1u));
  // (its size its intensity)
  let I = r1(o + 2u);
  let z0 = hAt(p);
  let z1 = z0 + 4.0 + 10.0 * I;
  let rr = 1.0 + 3.0 * I;
  // (n.w: the selected point + 1 — gold)
  var col = select(0xe0483cu, 0x3c7be0u, b1[o + 4u] == 1u);
  if (u.n.w == j + 1u) { col = 0xf0c020u; }
  let at = room(36u);
  if (at == NONE) { return; }
  for (var k = 0u; k < 6u; k++) {
    let a0 = f32(k) * TAU / 6.0;
    let a1 = f32(k + 1u) * TAU / 6.0;
    let q0 = p + rr * vec2<f32>(cos(a0), sin(a0));
    let q1 = p + rr * vec2<f32>(cos(a1), sin(a1));
    tri(at + k * 6u, vec3<f32>(q0, z0), vec3<f32>(q1, z0), vec3<f32>(q1, z1), col);
    tri(at + k * 6u + 3u, vec3<f32>(q0, z1), vec3<f32>(q1, z1), vec3<f32>(p, z1 + 1.0), col);
  }
}

// ==== milestone 3c: shaping steep ground (the lab's heights only — the world's columns aren't touched) ==========
// s.z the shape: 1 terraces — h' = band·(floor(h/band) + a smoothed step of its fraction); 2 a spiral ramp and 3
// switchbacks leave the heights and draw a cart road (roadShape): the spiral the level sets of h/band − θ/2π round a
// point (one band a turn; inside the radius the grade allows, band / (2π grade), stairs); the switchbacks the level
// sets of h/band + a triangle wave along the contours (its period from the grade). s.x the band, s.y the grade, s.w
// the point the spiral winds round + 1 (0: the knoll, else the town's centre).
fn bandH() -> f32 { return max(u.s.x, 0.25); }
fn gradeG() -> f32 { return max(u.s.y, 0.01); }
/** the shaped heights: r1 the heights → w5 */
@compute @workgroup_size(8, 8)
fn shape(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let h = r1(i);
  let b = bandH();
  let f = h / b;
  set5(i, b * (floor(f) + smoothstep(0.25, 0.75, fract(f))));
}
fn tri01(t: f32) -> f32 { return 1.0 - abs(2.0 * fract(t) - 1.0); }
/** the road field ψ at p for a shape (r1 the smoothed heights): its integer level sets are the cart road */
fn psiAt(p: vec2<f32>, mode: u32, c: vec2<f32>, dir: vec2<f32>) -> f32 {
  let hb = hsAt(p) / bandH();
  if (mode == 2u) {
    let r = p - c;
    return hb - (atan2(r.y, r.x) / TAU + 0.5);
  }
  // (switchbacks: half a band up and back along the contours, over the length the grade allows a band)
  let s = dot(p - c, vec2<f32>(-dir.y, dir.x));
  let lam = 2.0 * bandH() / gradeG();
  return hb + 0.5 * tri01(s / lam);
}
fn hsAt(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  return t.w.x * r1(ixq(t.c[0])) + t.w.y * r1(ixq(t.c[1])) + t.w.z * r1(ixq(t.c[2]));
}
const C_CART: u32 = 0xb07a48u;
/** the cart road: one thread a column, a ribbon piece where ψ crosses an integer (r1 the smoothed heights, r2 the
 *  points, r3 H, r4 φ) */
@compute @workgroup_size(8, 8)
fn roadShape(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let p = cpos(x, y);
  if (!inTown(p) || blockedAt(p)) { return; }
  let mode = u32(u.s.z);
  var c = u.d.xy;
  var ps = u32(u.s.w);
  if (ps == 0u && b2[PW + 5u] == 1u) { ps = 2u; }
  if (ps > 0u && b2[(ps - 1u) * PW + 5u] == 1u) { c = vec2<f32>(r2((ps - 1u) * PW), r2((ps - 1u) * PW + 1u)); }
  // (the town's slope: the smoothed heights' gradient over 40 cells round the centre)
  let e = 20.0;
  var dir = vec2<f32>(hsAt(u.d.xy + vec2<f32>(e, 0.0)) - hsAt(u.d.xy - vec2<f32>(e, 0.0)), hsAt(u.d.xy + vec2<f32>(0.0, e)) - hsAt(u.d.xy - vec2<f32>(0.0, e)));
  dir = select(vec2<f32>(1.0, 0.0), normalize(dir), length(dir) > 1e-4);
  let rmin = bandH() / (TAU * gradeG());
  if (mode == 2u && distance(p, c) > 3.0 * u.e.y) { return; }
  let f0 = psiAt(p, mode, c, dir);
  var crosses = false;
  var q = p;
  for (var j = 0; j < 3; j++) {
    var n = cpos(x + 1, y);
    if (j == 1) { n = cpos(x, y + 1); }
    if (j == 2) { n = cpos(x - 1 + 2 * (y & 1), y + 1); }
    var f1 = psiAt(n, mode, c, dir);
    // (the spiral's seam: ψ jumps by one there — unwrapped, so the road runs on round it)
    if (f1 - f0 > 0.5) { f1 -= 1.0; } else if (f0 - f1 > 0.5) { f1 += 1.0; }
    if (floor(f0) != floor(f1)) { crosses = true; q = n; }
  }
  if (!crosses) { return; }
  // (the road's direction: across ψ's gradient, by differences)
  let d = 0.5;
  var gx = psiAt(p + vec2<f32>(d, 0.0), mode, c, dir) - psiAt(p - vec2<f32>(d, 0.0), mode, c, dir);
  var gy = psiAt(p + vec2<f32>(0.0, d), mode, c, dir) - psiAt(p - vec2<f32>(0.0, d), mode, c, dir);
  if (abs(gx) > 0.5) { gx -= sign(gx); }
  if (abs(gy) > 0.5) { gy -= sign(gy); }
  let gr = vec2<f32>(gx, gy);
  if (length(gr) < 1e-6) { return; }
  let t = normalize(vec2<f32>(-gr.y, gr.x));
  let a = p - t * 0.85;
  let b = p + t * 0.85;
  let at = room(6u);
  if (at == NONE) { return; }
  // (inside the spiral's smallest radius: stairs — orange)
  let stairs = mode == 2u && distance(p, c) < rmin;
  ribbon(at, a, b, u.b.y * 0.5, select(C_CART, C_STEEP, stairs));
}
/** the shaped ground as a tinted skin (terraces): one thread a column, two triangles to its neighbours, drawn at
 *  the higher of the shaped and the real ground — the bands tinted by their parity, cut ground darker (r1 the real
 *  heights, r3 the shaped) */
@compute @workgroup_size(8, 8)
fn ground(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() - 1 || y >= H() - 1) { return; }
  let p = cpos(x, y);
  if (!inTown(p) || blockedAt(p)) { return; }
  let q0 = vec2<i32>(x, y);
  let q1 = vec2<i32>(x + 1, y);
  let q2 = vec2<i32>(x + (y & 1), y + 1);
  let q3 = vec2<i32>(x + (y & 1) - 1, y + 1);
  var v: array<vec3<f32>, 4>;
  let qs = array<vec2<i32>, 4>(q0, q1, q2, q3);
  for (var k = 0; k < 4; k++) {
    let i = ixq(qs[k]);
    v[k] = vec3<f32>(cpos(qs[k].x, qs[k].y), max(r3(i), r1(i)) + 0.12);
  }
  let i0 = ixq(q0);
  let band = u32(floor(r3(i0) / bandH() + 0.001));
  var col = select(0x8fae6au, 0x6f8f52u, (band & 1u) == 1u);
  if (r3(i0) < r1(i0) - 0.5) { col = select(0x8a7a5cu, 0x6e6046u, (band & 1u) == 1u); }
  let at = room(6u);
  if (at == NONE) { return; }
  tri(at, v[0], v[1], v[2], col);
  tri(at + 3u, v[0], v[2], v[3], col);
}

// ==== milestone 3d: bad cells merged or paved; plazas at the junctions ========================================
// A block's meta (the slot after it, vblock): 0 always 0 (not a block), 1 bad, 2 the next seed along its line (whose
// street is its far side), 3 the seed before it (whose block shares its near street), 4 a triangle, 5 its status (0,
// 1 a plaza, 2 merged away, 3 grown by a merge), 6 the neighbour it asks to merge with, 7 which way (0 ahead, 1 behind),
// 8 its first seed (its own, until it takes over the block behind it).
const PAVED: u32 = 0x80000000u;
/** (m3i) a lot of a block at the town's edge or an empty district's */
const EDGE_LOT: u32 = 0x40000000u;
const C_PAVE: u32 = 0xdcd0b6u;
/** a cell too thin to build on: an interior angle under 25°, area / perimeter² under 0.3 of a circle's, or area under
 *  `minA` */
fn badQuad(v: array<vec2<f32>, 4>, minA: f32) -> bool {
  var a = 0.0;
  var per = 0.0;
  // (the largest corner cosine: a corner under 25° has one over 0.906; a triangle's fourth corner, on an edge's middle, is −1)
  var maxCos = -1.0;
  for (var k = 0; k < 4; k++) {
    let p1 = v[k];
    let p2 = v[(k + 1) % 4];
    a += cross2(p1, p2);
    per += distance(p1, p2);
    let d0 = v[(k + 3) % 4] - p1;
    let d1 = p2 - p1;
    let l = length(d0) * length(d1);
    if (l > 1e-6) { maxCos = max(maxCos, dot(d0, d1) / l); }
  }
  a = abs(0.5 * a);
  return maxCos > 0.906 || 4.0 * 3.14159265 * a / max(per * per, 1e-6) < 0.3 || a < minA;
}
fn blockQuad(o: u32) -> array<vec2<f32>, 4> {
  var v: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { v[k] = vec2<f32>(bitcast<f32>(w5[o + 2u + k * 2u]), bitcast<f32>(w5[o + 3u + k * 2u])); }
  return v;
}
/** one thread a seed (merge rounds; n.w the step): 0 its block's link from the one before cleared; 1 its quality —
 *  bad: too thin, too small, a triangle — and its link into the next block along; 2 the last round's: what's still
 *  bad is paved. q.x 1 (plaza): bad is paved at once; 2: nothing marked (w5 the blocks) */
@compute @workgroup_size(64)
fn bqual(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let ob = id * 3u * BQW;
  let mo = ob + BQW;
  if (u.n.w == 0u) { w5[mo + 3u] = NONE; return; }
  if (w5[ob] == 0u) { return; }
  let c = w5[mo + 2u];
  if (c != NONE) { w5[c * 3u * BQW + BQW + 3u] = id; }
  if (u.q.x > 1.5) { return; }
  let bad = w5[mo + 4u] == 1u || badQuad(blockQuad(ob), u.c.y);
  w5[mo + 1u] = select(0u, 1u, bad);
  if (bad && (u.q.x > 0.5 || u.n.w == 2u)) { w5[mo + 5u] = 1u; }
}
/** one thread a bad block (merge): a neighbour claimed — across the longer cross street, a good one first (the lowest
 *  seed wins; w6 the claims; w5 the blocks, r1 the seeds) */
@compute @workgroup_size(64)
fn bclaim(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds() || u.q.x > 0.5) { return; }
  let ob = id * 3u * BQW;
  let mo = ob + BQW;
  w5[mo + 6u] = NONE;
  if (w5[ob] == 0u || w5[mo + 1u] == 0u || w5[mo + 5u] == 1u) { return; }
  let c = w5[mo + 2u];
  let p = w5[mo + 3u];
  let okC = c != NONE && w5[c * 3u * BQW] == 1u && w5[c * 3u * BQW + BQW + 5u] != 1u;
  let okP = p != NONE && w5[p * 3u * BQW] == 1u && w5[p * 3u * BQW + BQW + 5u] != 1u;
  // (the shared streets: ahead c's own, behind this seed's own; a good neighbour first)
  var lc = -1.0;
  var lp = -1.0;
  if (okC) { lc = distance(sdStart(c), sdEnd(c)) + select(1e4, 0.0, w5[c * 3u * BQW + BQW + 1u] == 1u); }
  let st = w5[mo + 8u];
  if (okP) { lp = distance(sdStart(st), sdEnd(st)) + select(1e4, 0.0, w5[p * 3u * BQW + BQW + 1u] == 1u); }
  if (lc < 0.0 && lp < 0.0) { return; }
  let n = select(p, c, lc >= lp);
  w5[mo + 6u] = n;
  w5[mo + 7u] = select(1u, 0u, lc >= lp);
  atomicMin(&w6[n], id);
}
/** one thread a bad block that won its claim and wasn't claimed itself: the merged quad into its own slot, the
 *  neighbour's block gone, the street between them no longer drawn, the links along the line kept (w5 the blocks, b2
 *  the claims, w7 drawn; r1 the seeds) */
@compute @workgroup_size(64)
fn bapply(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds() || u.q.x > 0.5) { return; }
  let ob = id * 3u * BQW;
  let mo = ob + BQW;
  let n = w5[mo + 6u];
  if (n == NONE || b2[n] != id || b2[id] != NONE) { return; }
  let ahead = w5[mo + 7u] == 0u;
  // (the merged block: from this seed to the one past the neighbour, or from the one before to the next)
  // (a block's first seed: its own, or after a merge behind, the one it took over)
  var a = w5[mo + 8u];
  var b = w5[n * 3u * BQW + BQW + 2u];
  if (!ahead) { a = w5[n * 3u * BQW + BQW + 8u]; b = w5[mo + 2u]; }
  if (b == NONE) { return; }
  let ta = b1[a * SDW + 4u];
  let tb = b1[b * SDW + 4u];
  let pa = sdStart(a);
  let pb = sdStart(b);
  let ea = sdEnd(a);
  let eb = sdEnd(b);
  var ok = false;
  var tri = 0u;
  if (ta == tb && !isOpen(ta) && ((b1[a * SDW + 10u] & b1[b * SDW + 10u] & 2u) == 0u)) {
    tri = 1u;
    ok = putBlock(ob, array<vec2<f32>, 4>(pa, pb, ea, 0.5 * (ea + pa)), array<u32, 4>(1u, 2u, 2u, 2u), id);
  } else {
    ok = putBlock(ob, array<vec2<f32>, 4>(pa, pb, eb, ea), array<u32, 4>(1u, 2u, select(1u, 0u, !onLine(ta) || !onLine(tb)), 2u), id);
  }
  if (!ok) { return; }
  // (the street between them: ahead the neighbour's first, behind this block's first)
  let gone = select(w5[mo + 8u], w5[n * 3u * BQW + BQW + 8u], ahead);
  w5[mo + 4u] = tri;
  w5[mo + 5u] = 3u;
  w5[mo + 8u] = a;
  w5[n * 3u * BQW] = 0u;
  w5[n * 3u * BQW + BQW + 5u] = 2u;
  if (ahead) {
    w5[mo + 2u] = b;
  } else {
    // (the block before the neighbour now leads into this one)
    let pp = w5[n * 3u * BQW + BQW + 3u];
    if (pp != NONE) { w5[pp * 3u * BQW + BQW + 2u] = id; }
  }
  w7[gone] = 0u;
}
// ==== milestone 3e: landmark sites at the busy junctions ======================================================
// A junction is busy when q.z or more cross streets end at one seed, or two neighbouring ones meet there at under 30°.
// It gets a round plot — a landmark site — whose radius spreads its streets a block length apart:
// r = clamp(max(rmin, blockLen / θmin), rmin, rmax) × the multiplier. Overlapping sites: the bigger kept. Every cross
// street is clipped at the circles (it starts where it leaves one, ends where it enters one), so a fan's triangles
// become a ring of trapezoids round the site, its circle a ring road; the bad-cell merge runs after, on what's left.
// The sites (LM): word 0 the count, then LMW words each — x, y, r (negative: dropped), kind (0 a plaza, 1 a big
// structure), its score (streets + π − its sharpest angle). Later systems claim them from this buffer.
const LM_ROOM: u32 = 64u;
const LMW: u32 = 5u;
const C_LANDMARK: u32 = 0xc9b3e6u;
/** one thread a seed: the next seed along its line (ahead, the tangent's way: the same-parity flood looked up a block
 *  length ahead), and its street's start before any clipping (w5 the seeds: words 7–10; b2 b3 the floods, b4 φ) */
@compute @workgroup_size(64)
fn vnext(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  w5[o + 7u] = NONE;
  w5[o + 8u] = w5[o];
  w5[o + 9u] = w5[o + 1u];
  w5[o + 10u] = 0u;
  if (w5[o + 3u] == 0u || w5[o + 4u] == NONE) { return; }
  let s = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
  let L = w5[o + 2u];
  let gr = gradAt(mainK(), s);
  let tn = normalize(vec2<f32>(-gr.y, gr.x));
  let bl = u.a.w;
  let reach = array<f32, 4>(1.0, 1.5, 0.7, 2.0);
  for (var k = 0; k < 4; k++) {
    let n = nearestOf(L & 1u, s + tn * bl * reach[k]);
    if (n == NONE || n == id || w5[n * SDW + 2u] != L || w5[n * SDW + 3u] == 0u) { continue; }
    let dv = vec2<f32>(bitcast<f32>(w5[n * SDW]), bitcast<f32>(w5[n * SDW + 1u])) - s;
    if (dot(dv, tn) < 0.3 * bl || length(dv) > 2.5 * bl) { continue; }
    w5[o + 7u] = n;
    break;
  }
}
/** one thread a seed with a street to a seed: one more street at that seed, and the angle there to the next seed's
 *  street when it ends there too (w6: counts, then from T the smallest angles' bits; r1 the seeds) */
@compute @workgroup_size(64)
fn jstat(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  let T = nSeeds();
  if (id >= T) { return; }
  let o = id * SDW;
  let t = b1[o + 4u];
  if (b1[o + 3u] == 0u || t == NONE || isOpen(t)) { return; }
  atomicAdd(&w6[t], 1u);
  let c = b1[o + 7u];
  if (c == NONE || b1[c * SDW + 4u] != t) { return; }
  let pt = sdPos(t);
  let a = normalize(sdPos(id) - pt);
  let b = normalize(sdPos(c) - pt);
  let ang = acos(clamp(dot(a, b), -1.0, 1.0));
  atomicMin(&w6[T + t], bitcast<u32>(ang));
}
/** one thread a seed: a landmark site where it's a busy junction (w6 the sites; r1 the seeds, b2 the counts) */
@compute @workgroup_size(64)
fn lmlist(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  let T = nSeeds();
  if (id >= T || u.q.y <= 0.0 || b1[id * SDW + 3u] == 0u) { return; }
  let n = b2[id];
  let ang = bitcast<f32>(b2[T + id]);
  if (!(f32(n) >= u.q.z || (n >= 2u && ang < 0.5236))) { return; }
  let r = clamp(max(u.l.x, u.a.w / max(ang, 1e-3)), u.l.x, u.l.y) * u.q.y;
  let k = atomicAdd(&w6[0], 1u);
  if (k >= LM_ROOM) { return; }
  let p = sdPos(id);
  let o = 1u + k * LMW;
  atomicStore(&w6[o], bitcast<u32>(p.x));
  atomicStore(&w6[o + 1u], bitcast<u32>(p.y));
  atomicStore(&w6[o + 2u], bitcast<u32>(r));
  atomicStore(&w6[o + 3u], u32(u.q.w));
  // (m3g: its score — its streets, and how acute its sharpest angle — for the top K)
  atomicStore(&w6[o + 4u], bitcast<u32>(f32(n) + 3.1416 - min(ang, 3.1416)));
}
/** one thread a site: dropped (its radius negated) when it overlaps a higher-scoring one, or isn't among the top
 *  r.w (w5) */
@compute @workgroup_size(64)
fn lmprune(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let n = min(w5[0], LM_ROOM);
  if (i >= n) { return; }
  let oi = 1u + i * LMW;
  let pi = vec2<f32>(bitcast<f32>(w5[oi]), bitcast<f32>(w5[oi + 1u]));
  let ri = abs(bitcast<f32>(w5[oi + 2u]));
  let si = bitcast<f32>(w5[oi + 4u]);
  var rank = 0u;
  for (var j = 0u; j < n; j++) {
    if (j == i) { continue; }
    let oj = 1u + j * LMW;
    let rj = abs(bitcast<f32>(w5[oj + 2u]));
    let sj = bitcast<f32>(w5[oj + 4u]);
    let above = sj > si || (sj == si && j < i);
    if (above) { rank++; }
    if (distance(pi, vec2<f32>(bitcast<f32>(w5[oj]), bitcast<f32>(w5[oj + 1u]))) < ri + rj && above) { w5[oi + 2u] = bitcast<u32>(-ri); return; }
  }
  // (m3g: only the K busiest, most acute kept)
  if (f32(rank) >= u.r.w) { w5[oi + 2u] = bitcast<u32>(-ri); }
}
/** one thread a seed with a street: the street clipped at every site — its start moved out to where it leaves one,
 *  its end in to where it enters one; inside one altogether, or through one, it's gone (w5 the seeds; b2 the sites) */
@compute @workgroup_size(64)
fn vclip(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds() || u.q.y <= 0.0) { return; }
  let o = id * SDW;
  if (w5[o + 3u] == 0u || w5[o + 4u] == NONE) { return; }
  var a = vec2<f32>(bitcast<f32>(w5[o + 8u]), bitcast<f32>(w5[o + 9u]));
  var e = vec2<f32>(bitcast<f32>(w5[o + 5u]), bitcast<f32>(w5[o + 6u]));
  var fl = 0u;
  for (var k = 0u; k < min(b2[0], LM_ROOM); k++) {
    let ok = 1u + k * LMW;
    let r = bitcast<f32>(b2[ok + 2u]);
    if (r <= 0.0) { continue; }
    let c = vec2<f32>(bitcast<f32>(b2[ok]), bitcast<f32>(b2[ok + 1u]));
    let d = e - a;
    let f = a - c;
    let A = max(dot(d, d), 1e-6);
    let B = 2.0 * dot(f, d);
    let disc = B * B - 4.0 * A * (dot(f, f) - r * r);
    if (disc <= 0.0) { continue; }
    let t1 = (-B - sqrt(disc)) / (2.0 * A);
    let t2 = (-B + sqrt(disc)) / (2.0 * A);
    if (t2 <= 0.0 || t1 >= 1.0) { continue; }
    if ((t1 <= 0.0 && t2 >= 1.0) || (t1 > 0.0 && t2 < 1.0)) { w5[o + 4u] = NONE; return; }
    if (t1 <= 0.0) { a = a + d * t2; fl = fl | 1u; } else { e = a + d * t1; fl = fl | 2u; }
  }
  set5(o + 8u, a.x);
  set5(o + 9u, a.y);
  set5(o + 5u, e.x);
  set5(o + 6u, e.y);
  w5[o + 10u] = fl;
}
fn lmHit(p: vec2<f32>, c: vec2<f32>, r: f32) -> bool { return r > 0.0 && distance(p, c) < r; }
fn inLandmarkB1(p: vec2<f32>) -> bool {
  if (u.q.y <= 0.0) { return false; }
  for (var k = 0u; k < min(b1[0], LM_ROOM); k++) { let o = 1u + k * LMW; if (lmHit(p, vec2<f32>(r1(o), r1(o + 1u)), r1(o + 2u))) { return true; } }
  return false;
}
fn inLandmarkW5(p: vec2<f32>) -> bool {
  if (u.q.y <= 0.0) { return false; }
  for (var k = 0u; k < min(w5[0], LM_ROOM); k++) {
    let o = 1u + k * LMW;
    if (lmHit(p, vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u])), bitcast<f32>(w5[o + 2u]))) { return true; }
  }
  return false;
}
/** 48 threads a site: 24 its ring road's pieces, 24 inside it — the plaza's paving, or the big structure (a tall
 *  12-sided block inset from the ring, a side a thread) (r1 the sites, r3 H) */
@compute @workgroup_size(64)
fn lmMesh(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = g.x / 48u;
  let k = g.x % 48u;
  if (u.q.y <= 0.0 || j >= min(b1[0], LM_ROOM)) { return; }
  let o = 1u + j * LMW;
  let r = r1(o + 2u);
  if (r <= 0.0) { return; }
  let p = vec2<f32>(r1(o), r1(o + 1u));
  let big = b1[o + 3u] == 1u;
  if (k < 24u) {
    // (the ring road: a minor street's width, on the circle)
    let a0 = f32(k) * TAU / 24.0;
    let a1 = f32(k + 1u) * TAU / 24.0;
    let at = room(6u);
    if (at == NONE) { return; }
    ribbon(at, p + r * vec2<f32>(cos(a0), sin(a0)), p + r * vec2<f32>(cos(a1), sin(a1)), u.b.y * 0.5, C_MINOR);
    return;
  }
  let m = k - 24u;
  let z = hAt(p);
  if (!big) {
    let rp = r - u.b.y * 0.5;
    let a0 = f32(m) * TAU / 24.0;
    let a1 = f32(m + 1u) * TAU / 24.0;
    let q0 = p + rp * vec2<f32>(cos(a0), sin(a0));
    let q1 = p + rp * vec2<f32>(cos(a1), sin(a1));
    let at = room(3u);
    if (at == NONE) { return; }
    tri(at, vec3<f32>(p, z + 0.16), vec3<f32>(q0, hAt(q0) + 0.16), vec3<f32>(q1, hAt(q1) + 0.16), C_PAVE);
    return;
  }
  if (m >= 12u) { return; }
  // (a big structure: inset from the ring by the street's half width and the setback, three times a lot's height)
  let rs = max(r - u.b.y * 0.5 - u.b.z - 1.0, 1.0);
  let a0 = f32(m) * TAU / 12.0;
  let a1 = f32(m + 1u) * TAU / 12.0;
  let q0 = p + rs * vec2<f32>(cos(a0), sin(a0));
  let q1 = p + rs * vec2<f32>(cos(a1), sin(a1));
  let zlo = min(z, min(hAt(q0), hAt(q1))) - 1.5;
  let top = z + max(3.0, u.b.w * 9.0);
  let at = room(9u);
  if (at == NONE) { return; }
  tri(at, vec3<f32>(p, top), vec3<f32>(q0, top), vec3<f32>(q1, top), C_LANDMARK);
  tri(at + 3u, vec3<f32>(q0, zlo), vec3<f32>(q1, top), vec3<f32>(q0, top), C_WALL);
  tri(at + 6u, vec3<f32>(q0, zlo), vec3<f32>(q1, zlo), vec3<f32>(q1, top), C_WALL);
}

// ==== milestone 3f: gap fill — the town's empty land partitioned into blocks; roads through the big blocks ======
// On a coarse grid (TILE world units a tile): the tiles no block or landmark covers, in town and buildable, labelled
// into connected regions (min label + pointer jumping), each region split recursively (GAP_LEVELS levels: through its
// centroid, across its major axis snapped to φ's gradient or contour) while bigger than a block; each split a minor
// road, each leaf its oriented box from its moments — a block, lotted like the others. A region node (NODEW words) is
// region root × 16 + its heap index: 0–5 the tiles' count and sums (x, y, xx, xy, yy, in tiles), 6 split, 7 8 the
// split axis, 9 10 the centroid (world). The roads (the lots' count buffer, CNT): 0 lots, 1 roads, 2 gap blocks, 3 0,
// then 4 words a road (x0, y0, x1, y1).
const TILE: f32 = 4.0;
const NODEW: u32 = 12u;
const GAP_LEVELS: u32 = 3u;
const ROAD_ROOM: u32 = 1024u;
const GAP_ROOM: u32 = 512u;
const DONE: u32 = 0x80000000u;
fn gDims() -> vec2<u32> { return vec2<u32>(u32(f32(W()) / TILE) + 1u, u32(f32(H()) * ROW_H / TILE) + 1u); }
fn gPos(t: u32) -> vec2<f32> { let d = gDims(); return (vec2<f32>(f32(t % d.x), f32(t / d.x)) + 0.5) * TILE; }
/** one thread a block slot: the tiles whose middle its quad holds, covered (r1 the blocks; w5 the coverage) */
@compute @workgroup_size(64)
fn gcov(@builtin(global_invocation_id) g: vec3<u32>) {
  let bi = g.x;
  if (bi >= 3u * nSeeds()) { return; }
  let o = bi * BQW;
  if (b1[o] == 0u) { return; }
  var v: array<vec2<f32>, 4>;
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  for (var k = 0u; k < 4u; k++) { v[k] = vec2<f32>(r1(o + 2u + k * 2u), r1(o + 3u + k * 2u)); lo = min(lo, v[k]); hi = max(hi, v[k]); }
  let d = gDims();
  let t0 = vec2<i32>(max(floor(lo / TILE), vec2<f32>(0.0)));
  let t1 = vec2<i32>(min(floor(hi / TILE), vec2<f32>(d) - 1.0));
  for (var ty = t0.y; ty <= t1.y; ty++) {
    for (var tx = t0.x; tx <= t1.x; tx++) {
      let p = (vec2<f32>(f32(tx), f32(ty)) + 0.5) * TILE;
      var inside = true;
      for (var k = 0u; k < 4u; k++) { if (cross2(v[(k + 1u) % 4u] - v[k], p - v[k]) < 0.0) { inside = false; } }
      if (inside) { w5[u32(ty) * d.x + u32(tx)] = 1u; }
    }
  }
}
/** one thread a tile: its label — itself when it's empty (in town, buildable, no block, no landmark), else NONE
 *  (r1 the coverage, r2 the landmarks, b4 φ; w5 the labels) */
@compute @workgroup_size(64)
fn gmask(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x;
  let d = gDims();
  if (t >= d.x * d.y) { return; }
  let p = gPos(t);
  var empty = b1[t] == 0u && inb(p) && inTown(p) && !blockedAt(p);
  // (eroded by a tile: a sliver between blocks, a strip along the water, isn't land to fill)
  let x = i32(t % d.x);
  let y = i32(t / d.x);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = vec2<i32>(x + dx, y + dy);
      if (q.x < 0 || q.y < 0 || q.x >= i32(d.x) || q.y >= i32(d.y)) { empty = false; continue; }
      let qt = u32(q.y) * d.x + u32(q.x);
      if (b1[qt] != 0u || blockedAt(gPos(qt))) { empty = false; }
    }
  }
  for (var k = 0u; k < min(b2[0], LM_ROOM); k++) {
    let ok = 1u + k * LMW;
    if (lmHit(p, vec2<f32>(r2(ok), r2(ok + 1u)), r2(ok + 2u))) { empty = false; }
  }
  w5[t] = select(NONE, t, empty);
}
/** a round of the labelling: the least label of the tile and its four neighbours, then that label's own (a jump)
 *  (r1 → w5) */
@compute @workgroup_size(64)
fn glabel(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x;
  let d = gDims();
  if (t >= d.x * d.y) { return; }
  var m = b1[t];
  if (m == NONE) { w5[t] = NONE; return; }
  let x = t % d.x;
  let y = t / d.x;
  if (x > 0u) { m = min(m, b1[t - 1u]); }
  if (x + 1u < d.x) { m = min(m, b1[t + 1u]); }
  if (y > 0u) { m = min(m, b1[t - d.x]); }
  if (y + 1u < d.y) { m = min(m, b1[t + d.x]); }
  w5[t] = min(m, b1[m]);
}
/** one thread a tile not yet done: its moments into its region node (r1 the labels, r2 the heap indices; w6 the nodes) */
@compute @workgroup_size(64)
fn gacc(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x;
  let d = gDims();
  if (t >= d.x * d.y || b1[t] == NONE || (b2[t] & DONE) != 0u) { return; }
  let n = (b1[t] * 16u + b2[t]) * NODEW;
  let x = t % d.x;
  let y = t / d.x;
  atomicAdd(&w6[n], 1u);
  atomicAdd(&w6[n + 1u], x);
  atomicAdd(&w6[n + 2u], y);
  atomicAdd(&w6[n + 3u], x * x);
  atomicAdd(&w6[n + 4u], x * y);
  atomicAdd(&w6[n + 5u], y * y);
}
struct Mom { c: vec2<f32>, e1: vec2<f32>, l1: f32, l2: f32, area: f32 }
/** a node's centroid (world), its major axis and the variances along both (world²), its area */
fn moments(n: u32) -> Mom {
  var m: Mom;
  let k = f32(w5[n]);
  let mx = f32(w5[n + 1u]) / k;
  let my = f32(w5[n + 2u]) / k;
  let sxx = f32(w5[n + 3u]) / k - mx * mx + 1.0 / 12.0;
  let sxy = f32(w5[n + 4u]) / k - mx * my;
  let syy = f32(w5[n + 5u]) / k - my * my + 1.0 / 12.0;
  let tr = 0.5 * (sxx + syy);
  let dt = sqrt(max(0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy, 0.0));
  m.l1 = (tr + dt) * TILE * TILE;
  m.l2 = max(tr - dt, 0.0) * TILE * TILE;
  let th = 0.5 * atan2(2.0 * sxy, sxx - syy);
  m.e1 = vec2<f32>(cos(th), sin(th));
  m.c = (vec2<f32>(mx, my) + 0.5) * TILE;
  m.area = k * TILE * TILE;
  return m;
}
/** one thread a node of level n.z: split across its major axis (snapped to φ's gradient or its contour, whichever is
 *  nearer) while bigger than a block — the split a minor road, listed (w5 the nodes, b4 φ; w6 the roads) */
@compute @workgroup_size(64)
fn gnode(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let d = gDims();
  if (i >= d.x * d.y * 16u) { return; }
  let h = i % 16u;
  let lv = u.n.z;
  if (h < (1u << lv) || h >= (2u << lv)) { return; }
  let n = i * NODEW;
  if (w5[n] == 0u) { return; }
  let m = moments(n);
  // (split while bigger than a block, or while its box is under 3/4 full — a bent region)
  let fill = m.area / max(12.0 * sqrt(m.l1 * m.l2), 1e-3);
  if ((m.area <= u.a.w * u.a.x && (fill >= 0.75 || m.area < 2.0 * u.c.x)) || lv >= GAP_LEVELS) { return; }
  var ax = m.e1;
  let gr = gradAt(mainK(), m.c);
  if (dot(gr, gr) > 1e-10) {
    let gn = normalize(gr);
    let tn = vec2<f32>(-gn.y, gn.x);
    ax = select(tn, gn, abs(dot(gn, m.e1)) >= abs(dot(tn, m.e1)));
  }
  w5[n + 6u] = 1u;
  set5(n + 7u, ax.x);
  set5(n + 8u, ax.y);
  set5(n + 9u, m.c.x);
  set5(n + 10u, m.c.y);
  // (the road: across the region through its centroid, as far as its spread that way)
  let across = vec2<f32>(-ax.y, ax.x);
  let c1 = dot(across, m.e1);
  let half = sqrt(3.0 * max(m.l1 * c1 * c1 + m.l2 * (1.0 - c1 * c1), 1.0));
  let k = atomicAdd(&w6[1], 1u);
  if (k >= ROAD_ROOM) { return; }
  let a = m.c - across * half;
  let b = m.c + across * half;
  atomicStore(&w6[4u + k * 4u], bitcast<u32>(a.x));
  atomicStore(&w6[5u + k * 4u], bitcast<u32>(a.y));
  atomicStore(&w6[6u + k * 4u], bitcast<u32>(b.x));
  atomicStore(&w6[7u + k * 4u], bitcast<u32>(b.y));
}
/** one thread a tile not yet done: to the split child its side of its node's line, or done (r1 the labels, r2 the
 *  nodes; w5 the heap indices) */
@compute @workgroup_size(64)
fn gsplit(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x;
  let d = gDims();
  if (t >= d.x * d.y || b1[t] == NONE) { return; }
  let h = w5[t];
  if ((h & DONE) != 0u) { return; }
  let n = (b1[t] * 16u + h) * NODEW;
  if (b2[n + 6u] == 0u) { w5[t] = h | DONE; return; }
  let ax = vec2<f32>(r2(n + 7u), r2(n + 8u));
  let side = select(0u, 1u, dot(gPos(t) - vec2<f32>(r2(n + 9u), r2(n + 10u)), ax) > 0.0);
  w5[t] = h * 2u + side;
}
/** one thread a node: a leaf (tiles, not split) bigger than a lot and at least 0.6 full is a block — its oriented box
 *  from its moments, shrunk until clear of the blocks and the water, every side a street (r1 the coverage, b4 φ;
 *  w5 the nodes; w6 the counts — 2 the gap blocks; w7 the gap blocks) */
@compute @workgroup_size(64)
fn gleaf(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let d = gDims();
  if (i >= d.x * d.y * 16u) { return; }
  let n = i * NODEW;
  if (w5[n] == 0u || w5[n + 6u] != 0u) { return; }
  let m = moments(n);
  if (m.area < u.c.x || m.area / max(12.0 * sqrt(m.l1 * m.l2), 1e-3) < 0.6) { return; }
  let e2 = vec2<f32>(-m.e1.y, m.e1.x);
  // (the box shrunk until its corners and edge middles are on empty land: covered tiles, water, a cliff — not)
  var sh = 0.0;
  for (var j = 0; j < 4; j++) {
    let f = 0.92 - 0.12 * f32(j);
    let a = f * sqrt(3.0 * m.l1);
    let b = f * sqrt(3.0 * m.l2);
    var clear = true;
    for (var q = 0; q < 8; q++) {
      let an = f32(q) * TAU / 8.0;
      let pt = m.c + m.e1 * a * sign(cos(an)) * select(1.0, 0.0, abs(cos(an)) < 0.1) + e2 * b * sign(sin(an)) * select(1.0, 0.0, abs(sin(an)) < 0.1);
      let tc = vec2<i32>(floor(pt / TILE));
      if (tc.x < 0 || tc.y < 0 || tc.x >= i32(d.x) || tc.y >= i32(d.y) || b1[u32(tc.y) * d.x + u32(tc.x)] != 0u || blockedAt(pt) || !inTown(pt)) { clear = false; }
    }
    if (clear) { sh = f; break; }
  }
  if (sh == 0.0) { return; }
  let a = sh * sqrt(3.0 * m.l1);
  let b = sh * sqrt(3.0 * m.l2);
  if (b < 2.0) { return; }
  let k = atomicAdd(&w6[2], 1u);
  if (k >= GAP_ROOM) { return; }
  let o = k * 3u * BQW;
  let v = array<vec2<f32>, 4>(m.c - m.e1 * a - e2 * b, m.c + m.e1 * a - e2 * b, m.c + m.e1 * a + e2 * b, m.c - m.e1 * a + e2 * b);
  w7[o] = 1u;
  w7[o + 1u] = 2u | (2u << 8u) | (2u << 16u) | (2u << 24u);
  for (var j = 0u; j < 4u; j++) { w7[o + 2u + j * 2u] = bitcast<u32>(v[j].x); w7[o + 3u + j * 2u] = bitcast<u32>(v[j].y); }
  w7[o + 10u] = NONE;
}
/** the listed roads (gap splits, big blocks' first cuts): eight ribbon pieces each (r1 the counts and roads, r3 H) */
@compute @workgroup_size(64)
fn groad(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x / 8u;
  let k = g.x % 8u;
  if (i >= min(b1[1], ROAD_ROOM)) { return; }
  let s = vec2<f32>(r1(4u + i * 4u), r1(5u + i * 4u));
  let e = vec2<f32>(r1(6u + i * 4u), r1(7u + i * 4u));
  let a = mix(s, e, f32(k) / 8.0);
  let b = mix(s, e, f32(k + 1u) / 8.0);
  if (blockedAt(0.5 * (a + b)) || !inTown(0.5 * (a + b)) || !shownCity(cityB2(0.5 * (a + b)))) { return; }
  let at = room(6u);
  if (at == NONE) { return; }
  ribbon(at, a, b, u.b.y * 0.5, C_MINOR);
}

// ==== milestone 3g: even contours (the mask smoothed, not the distance); streets grown line by line ==============
/** (field mode 1) the smoothed blocked mask thresholded: the flood's seeds (r1 the smoothed mask; w5 the seeds) */
@compute @workgroup_size(8, 8)
fn mseed(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  w5[i] = select(NONE, pk(u32(x), u32(y), 0u), r1(i) > 0.5);
}
// Grown streets (Jobard–Lefer, a line a step): the snapped, thinned seeds on line 0 are live, the rest dormant. Line k's
// live seeds march up ∇φ to line k + 1; each landing is a new seed there (appended past the lattice's), its street the
// march. On line k + 1 a landing nearer than 0.6 block lengths to a lower one stops — its street ends at a T on the
// line — and a dormant seed with no landing within 0.8 block lengths wakes: a new street where they spread apart, or
// a strip with nothing below it. Seed word 11: 0 none, 1 dormant, 2 live, 3 landed (its word 7 its source until vnext).
struct March { e: vec2<f32>, end: u32, ok: bool }
/** from s on line L up the gradient in 2-cell steps: to line L + 1 (the crossing interpolated), to the ridge where φ
 *  stops rising, or to the town's edge; not ok into water or a cliff, or past 2.5 levels' spacing (b4 φ) */
fn marchUp(s: vec2<f32>, L: u32) -> March {
  var m: March;
  m.ok = false;
  m.e = s;
  m.end = NONE;
  let g0 = gradAt(mainK(), s);
  if (dot(g0, g0) < 1e-10) { return m; }
  let most = 2.5 / length(g0);
  var q = s;
  var fq = fieldAt(mainK(), s);
  for (var k = 0; k < 64; k++) {
    if (distance(q, s) > most) { break; }
    let gq = gradAt(mainK(), q);
    if (dot(gq, gq) < 1e-10) { m.e = q; m.end = RIDGE; m.ok = true; break; }
    let n = q + 2.0 * normalize(gq);
    if (!inTown(n)) {
      let up = normalize(n - q);
      let rel = q - u.d.xy;
      let b = dot(rel, up);
      let disc = b * b - (dot(rel, rel) - u.d.z * u.d.z);
      m.e = q + up * max(-b + sqrt(max(disc, 0.0)) - 0.5, 0.0);
      m.end = EDGE;
      m.ok = true;
      break;
    }
    if (blockedAt(n)) { break; }
    let fn1 = fieldAt(mainK(), n);
    if (fn1 >= f32(L + 1u)) { m.e = mix(q, n, clamp((f32(L + 1u) - fq) / max(fn1 - fq, 1e-6), 0.0, 1.0)); m.end = LINE_END; m.ok = true; break; }
    if (fn1 <= fq + 1e-3) { m.e = q; m.end = RIDGE; m.ok = true; break; }
    q = n;
    fq = fn1;
  }
  if (distance(m.e, s) < 1.0) { m.ok = false; }
  return m;
}
/** one thread a seed slot: line 0's seeds live, the others' dormant, the grown slots emptied (w5 the seeds) */
@compute @workgroup_size(64)
fn ginit(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  if (id >= u.m.w * u32(u.c.w)) { w5[o + 3u] = 0u; w5[o + 4u] = NONE; w5[o + 11u] = 0u; return; }
  w5[o + 4u] = NONE;
  if (w5[o + 3u] == 0u) { w5[o + 11u] = 0u; return; }
  if (w5[o + 2u] == 0u) { w5[o + 11u] = 2u; } else { w5[o + 3u] = 0u; w5[o + 11u] = 1u; }
}
/** one thread a seed slot: line n.z's live seeds marched up to the next line — a landing a new seed (w5 the seeds,
 *  w6 the grown seeds' count; b4 φ) */
@compute @workgroup_size(64)
fn gmarch(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  if (w5[o + 3u] == 0u || w5[o + 2u] != u.n.z) { return; }
  let s = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
  let L = w5[o + 2u];
  let m = marchUp(s, L);
  if (!m.ok) { return; }
  var end = m.end;
  if (end == LINE_END) {
    let T = u.m.w * u32(u.c.w);
    let k = atomicAdd(&w6[0], 1u);
    if (k < T) {
      let nid = T + k;
      let no = nid * SDW;
      set5(no, m.e.x);
      set5(no + 1u, m.e.y);
      w5[no + 2u] = L + 1u;
      w5[no + 3u] = 1u;
      w5[no + 4u] = NONE;
      w5[no + 7u] = id;
      w5[no + 11u] = 3u;
      end = nid;
    }
  }
  w5[o + 4u] = end;
  set5(o + 5u, m.e.x);
  set5(o + 6u, m.e.y);
}
fn ggDims() -> vec2<u32> { let cs = 0.8 * u.a.w; return vec2<u32>(u32(f32(W()) / cs) + 2u, u32(f32(H()) * ROW_H / cs) + 2u); }
fn ggCell(p: vec2<f32>) -> vec2<i32> { return vec2<i32>(floor(p / (0.8 * u.a.w))); }
fn ggAt(c: vec2<i32>) -> u32 { let d = ggDims(); let q = vec2<u32>(clamp(c, vec2<i32>(0), vec2<i32>(d) - 1)); return q.y * d.x + q.x; }
/** one thread a seed slot: line n.z's landings claim their grid cell — the lowest id (r1 the seeds; w6 the grid) */
@compute @workgroup_size(64)
fn gclaim(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  if (b1[o + 3u] == 0u || b1[o + 11u] != 3u || b1[o + 2u] != u.n.z) { return; }
  atomicMin(&w6[ggAt(ggCell(sdPos(id)))], id);
}
/** one thread a seed slot on line n.z: a landing too near a lower one stops (its source's street ends at a T on the
 *  line); a dormant seed with no landing near wakes (w5 the seeds; b2 the grid) */
@compute @workgroup_size(64)
fn gkeep(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  if (w5[o + 2u] != u.n.z) { return; }
  let st = w5[o + 11u];
  let landed = st == 3u && w5[o + 3u] == 1u;
  if (!landed && st != 1u) { return; }
  let p = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
  let c = ggCell(p);
  let r = select(0.8, 0.6, landed) * u.a.w;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let v = b2[ggAt(c + vec2<i32>(dx, dy))];
      if (v == NONE || v == id || (landed && v > id)) { continue; }
      let q = vec2<f32>(bitcast<f32>(w5[v * SDW]), bitcast<f32>(w5[v * SDW + 1u]));
      if (distance(p, q) >= r) { continue; }
      if (landed) {
        w5[o + 3u] = 0u;
        w5[w5[o + 7u] * SDW + 4u] = LINE_END;
      }
      return;
    }
  }
  if (!landed) { w5[o + 3u] = 1u; w5[o + 11u] = 2u; }
}

// ==== milestone 3h: supercells — the city's limit, its sparse interior, its growth ==============================
// (m3i: the limit is now a growth budget on a cost distance over the supercell graph — sctab below; this paragraph's
// first rule, a noisy distance to the nearest centre, read as a disc.)
// Supercells: a jittered grid h.x block lengths apart, each point's supercell the nearest grid seed among the 3 × 3
// round it. The population centres are the live points and the kept landmark sites (none: the town's centre). A
// supercell (SCT: a header — across, down, its size, the limit radius — then SCW words a cell: seed x, y, state (0
// out, 1 empty, 2 in), its centre's distance over the limit (its growth start), its centre x, y): in when its
// centre's distance, plus noise of h.y supercells, is under the limit; empty, inside, by a hash under h.z (never
// within 0.6 supercells of a centre). A point's growth key: half its supercell's start, half its own distance to that
// centre over the limit — shown when under the growth h2.x. Blocks are kept or dropped whole, so the limit runs along
// streets; the major lines run on through empty cells, and every third or so cross street (an arterial) too.
const SCW: u32 = 6u;
const SC_HEAD: u32 = 4u;
fn hash2(a: u32, b: u32) -> f32 { return hsh((a * 73856093u) ^ (b * 19349663u) ^ (u32(u.h.w) * 83492791u)); }
/** (m3i) value noise over the supercell grid (one cell of it every `k` supercells), 0–1 */
fn vnoise(c: vec2<f32>, k: f32, salt: u32) -> f32 {
  let q = c / k;
  let i = vec2<u32>(floor(q) + 64.0);
  let f = q - floor(q);
  let s = f * f * (3.0 - 2.0 * f);
  let h00 = hash2(i.x * 977u + i.y, salt);
  let h10 = hash2((i.x + 1u) * 977u + i.y, salt);
  let h01 = hash2(i.x * 977u + i.y + 1u, salt);
  let h11 = hash2((i.x + 1u) * 977u + i.y + 1u, salt);
  return mix(mix(h00, h10, s.x), mix(h01, h11, s.x), s.y);
}
fn hsAt3(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  return t.w.x * r3(ixq(t.c[0])) + t.w.y * r3(ixq(t.c[1])) + t.w.z * r3(ixq(t.c[2]));
}
const SC_MAX: u32 = 256u;
var<workgroup> scD: array<f32, 256>;
var<workgroup> scN: array<f32, 256>;
var<workgroup> scF: array<f32, 256>;
var<workgroup> scS: array<vec2<f32>, 256>;
/** each cell's 8 edge costs, made once (−1: no edge) */
var<workgroup> scW: array<f32, 2048>;
/** what it costs the town to grow from supercell seed a to b: their distance × (1 + its slope × 3, + 4 across
 *  water or a cliff — a bridge) × the two cells' random factors' mean × a discount along a major line (the cross
 *  street runs across ∇φ: × 0.7) and along a shore (× 0.6) (r3 the smoothed heights, b4 φ) */
fn growCost(a: vec2<f32>, b: vec2<f32>, fa: f32, fb: f32) -> f32 {
  let L = max(distance(a, b), 1e-3);
  let slope = abs(hsAt3(b) - hsAt3(a)) / L;
  var water = 0.0;
  for (var k = 1; k < 6; k++) { if (blockedAt(mix(a, b, f32(k) / 6.0))) { water = 4.0; } }
  let m = 0.5 * (a + b);
  var disc = 1.0;
  if (water == 0.0) {
    let g = gradAt(1u, m);
    if (dot(g, g) > 1e-10 && abs(dot(normalize(b - a), normalize(g))) < 0.35) { disc = 0.7; }
    if (fdAt(m) < 1.2 * u.a.x) { disc = min(disc, 0.6); }
  }
  return L * (1.0 + 3.0 * slope + water) * 0.5 * (fa + fb) * disc;
}
/** one workgroup: the supercells — their seeds (a jittered grid), each one's cost distance from the population
 *  centres over the 8-neighbour graph (Bellman–Ford, a round a step), the limit a budget on it with ±h.y of low-
 *  frequency noise (lobes along the roads and the shore, bites in the steep, fingers), its state and its growth start
 *  (r1 the points, r2 the sites, r3 the smoothed heights, b4 φ; w5 the table) */
@compute @workgroup_size(256)
fn sctab(@builtin(local_invocation_index) li: u32) {
  // (no smaller than keeps the grid within SC_MAX cells)
  let sc = max(u.h.x * u.a.w, sqrt(f32(W()) * f32(H()) * ROW_H / 200.0));
  let gx = u32(f32(W()) / sc) + 1u;
  let gy = u32(f32(H()) * ROW_H / sc) + 1u;
  let n = min(gx * gy, SC_MAX);
  let lim = u.d.z * u.h2.w;
  if (li == 0u) { w5[0] = gx; w5[1] = gy; set5(2u, sc); set5(3u, lim); }
  for (var c = li; c < n; c += 256u) {
    let cc = vec2<f32>(f32(c % gx), f32(c / gx));
    let s = (cc + 0.5 + 0.7 * (vec2<f32>(hash2(c, 1u), hash2(c, 2u)) - 0.5)) * sc;
    scS[c] = s;
    // (a strong random factor a cell: 0.5–2, half hash, half low-frequency noise)
    scF[c] = mix(0.5, 2.0, 0.5 * hash2(c, 5u) + 0.5 * vnoise(cc, 3.0, 6u));
    var d = 1e9;
    for (var k = 0u; k < NPTS; k++) {
      if (b1[k * PW + 5u] == 0u) { continue; }
      let e = distance(s, vec2<f32>(r1(k * PW), r1(k * PW + 1u)));
      if (e < 0.75 * sc) { d = min(d, e); }
    }
    for (var k = 0u; k < min(b2[0], LM_ROOM); k++) {
      let o = 1u + k * LMW;
      if (r2(o + 2u) <= 0.0) { continue; }
      let e = distance(s, vec2<f32>(r2(o), r2(o + 1u)));
      if (e < 0.75 * sc) { d = min(d, e); }
    }
    let e0 = distance(s, u.d.xy);
    if (e0 < 0.75 * sc) { d = min(d, e0); }
    scD[c] = d;
  }
  workgroupBarrier();
  for (var c = li; c < n; c += 256u) {
    let x = i32(c % gx);
    let y = i32(c / gx);
    for (var k = 0; k < 9; k++) {
      if (k == 4) { continue; }
      let nx = x + k % 3 - 1;
      let ny = y + k / 3 - 1;
      let e = u32(k - select(0, 1, k > 4));
      scW[c * 8u + e] = -1.0;
      if (nx < 0 || ny < 0 || nx >= i32(gx) || ny >= i32(gy)) { continue; }
      let j = u32(ny) * gx + u32(nx);
      if (j >= n) { continue; }
      scW[c * 8u + e] = growCost(scS[j], scS[c], scF[j], scF[c]);
    }
  }
  workgroupBarrier();
  for (var r = 0u; r < 40u; r++) {
    if (r > gx + gy + 2u) { break; }
    for (var c = li; c < n; c += 256u) {
      var best = scD[c];
      let x = i32(c % gx);
      let y = i32(c / gx);
      for (var k = 0; k < 9; k++) {
        if (k == 4) { continue; }
        let w = scW[c * 8u + u32(k - select(0, 1, k > 4))];
        if (w < 0.0) { continue; }
        let j = u32(y + k / 3 - 1) * gx + u32(x + k % 3 - 1);
        best = min(best, scD[j] + w);
      }
      scN[c] = best;
    }
    workgroupBarrier();
    for (var c = li; c < n; c += 256u) { scD[c] = scN[c]; }
    workgroupBarrier();
  }
  for (var c = li; c < n; c += 256u) {
    let cc = vec2<f32>(f32(c % gx), f32(c / gx));
    let thr = lim * (1.0 + u.h.y * (2.0 * vnoise(cc, 2.5, 7u) - 1.0));
    let t = scD[c] / max(thr, 1.0);
    let inside = t < 1.0;
    // (empty: never at a centre, never at the edge — under 0.6 of the budget)
    let empty = hash2(c, 4u) < u.h.z && scD[c] > 0.6 * sc && t < 0.6;
    let o = SC_HEAD + c * SCW;
    set5(o, scS[c].x);
    set5(o + 1u, scS[c].y);
    w5[o + 2u] = select(0u, select(2u, 1u, empty), inside);
    set5(o + 3u, t);
    set5(o + 4u, scS[c].x);
    set5(o + 5u, scS[c].y);
  }
}
struct City { state: u32, t: f32, id: u32 }
/** a point's supercell — its state, its growth key, its id (the table at b4) */
fn cityB4(p: vec2<f32>) -> City {
  var c: City;
  c.state = 2u;
  c.t = 0.0;
  c.id = 0u;
  if (u.h2.z < 0.5) { return c; }
  let gx = b4[0];
  let gy = b4[1];
  let sc = r4(2u);
  let q = vec2<i32>(floor(p / sc));
  var best = 1e9;
  var bi = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let n = q + vec2<i32>(dx, dy);
      if (n.x < 0 || n.y < 0 || n.x >= i32(gx) || n.y >= i32(gy)) { continue; }
      let i = u32(n.y) * gx + u32(n.x);
      let d = distance(p, vec2<f32>(r4(SC_HEAD + i * SCW), r4(SC_HEAD + i * SCW + 1u)));
      if (d < best) { best = d; bi = i; }
    }
  }
  let o = SC_HEAD + bi * SCW;
  c.state = b4[o + 2u];
  // (m3i: its cell's cost distance over its budget, and a little for its distance from the cell's seed)
  c.t = 0.85 * r4(o + 3u) + 0.15 * distance(p, vec2<f32>(r4(o + 4u), r4(o + 5u))) / max(r4(2u), 1.0);
  c.id = bi;
  return c;
}
/** the same, the table at b2 */
fn cityB2(p: vec2<f32>) -> City {
  var c: City;
  c.state = 2u;
  c.t = 0.0;
  c.id = 0u;
  if (u.h2.z < 0.5) { return c; }
  let gx = b2[0];
  let gy = b2[1];
  let sc = r2(2u);
  let q = vec2<i32>(floor(p / sc));
  var best = 1e9;
  var bi = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let n = q + vec2<i32>(dx, dy);
      if (n.x < 0 || n.y < 0 || n.x >= i32(gx) || n.y >= i32(gy)) { continue; }
      let i = u32(n.y) * gx + u32(n.x);
      let d = distance(p, vec2<f32>(r2(SC_HEAD + i * SCW), r2(SC_HEAD + i * SCW + 1u)));
      if (d < best) { best = d; bi = i; }
    }
  }
  let o = SC_HEAD + bi * SCW;
  c.state = b2[o + 2u];
  // (m3i: its cell's cost distance over its budget, and a little for its distance from the cell's seed)
  c.t = 0.85 * r2(o + 3u) + 0.15 * distance(p, vec2<f32>(r2(o + 4u), r2(o + 5u))) / max(r2(2u), 1.0);
  c.id = bi;
  return c;
}
fn shownCity(c: City) -> bool { return c.state == 2u && c.t <= u.h2.x; }
/** one thread a block slot (every third: the blocks): its supercell's state and its growth key into its meta, words
 *  10 and 9 — the hook for districts and the time-lapse (w5 the blocks — BQ or the gap blocks; b4 the table) */
@compute @workgroup_size(64)
fn bgrow(@builtin(global_invocation_id) g: vec3<u32>) {
  let bi = g.x * 3u;
  if (bi >= u.m.x) { return; }
  let o = bi * BQW;
  if (w5[o] == 0u) { return; }
  var m = vec2<f32>(0.0);
  for (var k = 0u; k < 4u; k++) { m += 0.25 * vec2<f32>(bitcast<f32>(w5[o + 2u + k * 2u]), bitcast<f32>(w5[o + 3u + k * 2u])); }
  let c = cityB4(m);
  set5(o + BQW + 9u, c.t);
  w5[o + BQW + 10u] = c.state;
}
/** a district tint over the town's ground: a muted colour a supercell, darker where empty, nothing outside (one
 *  thread a column, two triangles; b2 the table, r3 H, b4 φ) */
@compute @workgroup_size(8, 8)
fn ctint(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() - 1 || y >= H() - 1) { return; }
  let p = cpos(x, y);
  if (!inTown(p) || blockedAt(p)) { return; }
  let c = cityB2(p);
  if (c.state == 0u) { return; }
  let q1 = vec2<i32>(x + 1, y);
  let q2 = vec2<i32>(x + (y & 1), y + 1);
  let q3 = vec2<i32>(x + (y & 1) - 1, y + 1);
  let h = hsh(c.id * 2654435761u + 7u);
  let k = select(1.0, 0.7, c.state == 1u);
  let rgb = vec3<f32>(0.62 + 0.25 * h, 0.6 + 0.25 * fract(h * 7.3), 0.55 + 0.25 * fract(h * 3.1)) * k;
  let col = (u32(rgb.x * 255.0) << 16u) | (u32(rgb.y * 255.0) << 8u) | u32(rgb.z * 255.0);
  let at = room(6u);
  if (at == NONE) { return; }
  let v0 = vec3<f32>(p, r3(ixq(vec2<i32>(x, y))) + 0.08);
  let v1 = vec3<f32>(cpos(q1.x, q1.y), r3(ixq(q1)) + 0.08);
  let v2 = vec3<f32>(cpos(q2.x, q2.y), r3(ixq(q2)) + 0.08);
  let v3 = vec3<f32>(cpos(q3.x, q3.y), r3(ixq(q3)) + 0.08);
  tri(at, v0, v1, v2, col);
  tri(at + 3u, v0, v2, v3, col);
}
