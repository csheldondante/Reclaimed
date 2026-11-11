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
  x: vec4<f32>, // (m3i) the town circle's reach (× its radius: with supercells, far enough never to show); (farms) the farm belt (× the budget, 0 none), a field's size (× a lot), 0
  t: vec4<f32>, // (citygen M4a) an arterial's width, the height-to-plot ratio (0: storeys × a random 0.7–1.3), a deck's clearance over its banks, the longest bridge
  rc: vec4<f32>, // (M4b) the roads' colour (rgb 0–1), its tone (0 the lab's white, 1 dirt, 2 stone)
  pp: vec4<f32>, // (M4b) the population field: its peak density (0 the field off: 0.5 everywhere), the settlement's purpose (0–5; −1 none), 0, 0
  tl: vec4<f32>, // (time-lapse) the town's clock now (s), a lot's build time (s), a time-lapse's start and its spread (s)
  sk: vec4<f32>, // (the street skeleton) its reach (0 core only, 1 districts begun + a margin, 2 everywhere), the margin (m), minor streets ahead of their buildings (1), 0
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
  // (M4a: the block's key — its jitter and its lots' seeds: a field block its slot (a seed's), a gap block (mode 1) its
  // region node (word 10), not its slot, which the gap fill hands out in whatever order its threads run)
  let bk = select(bi, 3u * T + 3u * b1[o + 10u] + bi % 3u, u.n.w == 1u);
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
  // (M4b: the lots' size by the population field's density there — dense, small lots; sparse, large: 1 at 0.5)
  let qc = cityB4(0.25 * (q0.v[0] + q0.v[1] + q0.v[2] + q0.v[3]));
  let farm = u.h2.z > 0.5 && qc.purpose == P_FARMS;
  let lotK = mix(1.6, 0.4, qc.dens);
  var made = 0u;
  while (n > 0u) {
    n--;
    let q = st[n];
    let A = qArea(q);
    // (halves under the smallest lot's area: not split — the merge)
    var split = !plaza && A > u.c.x * lotK && q.d < DEPTH && n + 2u <= STACK && A * 0.42 >= u.c.y * lotK;
    if (farm) {
      // (farms: a field — split across its longest edge only while it's longer than FIELD_ASPECT + 1 × its width or
      // bigger than x.z block lengths squared: fields of several blocks, 3:1–4:1)
      var lmax = 0.0;
      var lmin = 1e9;
      for (var j = 0u; j < 4u; j++) { let l = distance(q.v[j], q.v[(j + 1u) % 4u]); lmax = max(lmax, l); lmin = min(lmin, l); }
      split = q.d < DEPTH && n + 2u <= STACK && (lmax > (FIELD_ASPECT + 1.0) * max(lmin, 1.0) || A > max(u.x.z, 1.0) * u.a.w * u.a.w);
    }
    if (split) {
      var k = 0u;
      var ll = -1.0;
      for (var j = 0u; j < 4u; j++) { let l = distance(q.v[j], q.v[(j + 1u) % 4u]); if (l > ll) { ll = l; k = j; } }
      let t = 0.5 + (hsh(bk * 977u + q.d * 131u + made * 17u + n) - 0.5) * 0.16;
      let v0 = q.v[k]; let v1 = q.v[(k + 1u) % 4u]; let v2 = q.v[(k + 2u) % 4u]; let v3 = q.v[(k + 3u) % 4u];
      let c1 = mix(v0, v1, t);
      let c2 = mix(v3, v2, t);
      let ek = ecls(q.e, k); let e1 = ecls(q.e, k + 1u); let e2 = ecls(q.e, k + 2u); let e3 = ecls(q.e, k + 3u);
      var a: Quad;
      a.v = array<vec2<f32>, 4>(v0, c1, c2, v3);
      // (m3f: a big block's first two splits are roads — the cut a street both sides, its segment listed)
      // (farms: only the biggest field block's first split is a track — one every few hundred metres)
      let road = u.l.z > 0.0 && A >= select(u.l.z, FARM_TRACK_AREA, farm) && q.d < select(2u, 1u, farm);
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
    // (M4a: a lot on an arterial's corridor isn't made — the arterial runs through the block)
    if (artHitB2(q.v)) { continue; }
    let li = atomicAdd(&w6[0], 1u);
    if (li >= u.m.x) { continue; }
    let lo = li * LW;
    for (var j = 0u; j < 4u; j++) { putV(lo + j * 2u, q.v[j]); }
    w5[lo + 8u] = q.e;
    w5[lo + 9u] = (bk * 256u + made) | select(0u, PAVED, plaza) | select(0u, EDGE_LOT, edge);
    made++;
  }
}

// ---- the mesh (vsSkin: two vec4<u32> a vertex — position bits + colour, normal bits + 1) -------------------
fn hAt(p: vec2<f32>) -> f32 {
  let t = triAt(p);
  return t.w.x * r3(ixq(t.c[0])) + t.w.y * r3(ixq(t.c[1])) + t.w.z * r3(ixq(t.c[2]));
}
/** a vertex into the mesh (w7) */
/** (time-lapse) what the next vertices are (tlRise moves them each frame): TG_* | an id + 1 << 8 (a record, a district);
 *  OUTLINE_BIT a roof's outline, over it */
const TG_STATIC: u32 = 0u;
const TG_TOP: u32 = 1u;
const TG_BASE: u32 = 2u;
const TG_ROAD: u32 = 3u;
const TG_LOT: u32 = 4u;
const OUTLINE_BIT: u32 = 8u;
var<private> curTag: u32 = 0u;
/** (time-lapse) whether the road piece being drawn marks its columns for the claims (its reveal begun — CG25) */
var<private> roadLive: bool = true;
/**
 * (CG25, roads grow in with their lots) The road piece being drawn: the town's clock time its end a, and its end b,
 * are reached as the road grows in (REV_UNGATED: always shown, untagged). ribbon writes them into its vertices' word 7
 * over the surface byte — the vertex layout, mirrored in render/bodies.wgsl vsSkin:
 *   word 7, bits 0–7   the surface (1 a flat colour; archgen's 3 dirt, 4 cobbles, 5 grass) — vert writes it
 *   word 7, bits 8–31  the reveal code: 0 ungated; c > 0 the point is reached at (c − 1) / REV_RES s of the town's clock
 * vsSkin interpolates the time along the triangle (VOut.tint) and fsBody discards a fragment ahead of the clock (the
 * town's clock in its place's w: MESH_XF.w), laying it as dirt for its first REV_DIRT_S there.
 */
var<private> revA: f32 = REV_UNGATED;
var<private> revB: f32 = REV_UNGATED;
fn vert(at: u32, p: vec3<f32>, col: u32, n: vec3<f32>) {
  let o = at * 8u;
  w5[at * 2u] = curTag;
  w5[at * 2u + 1u] = bitcast<u32>(p.z);
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
/** (M4b) the columns under a road piece from a to b, half width hw, marked in ROADS (w6: 1 a road; a deck its z, as
 *  DECK_BIT | z × 256 — the higher wins) — what the town claims as paving or deck (claimSpans) */
const DECK_BIT: u32 = 0x80000000u;
fn markRoad(a: vec2<f32>, b: vec2<f32>, hw: f32, za: f32, zb: f32, deck: bool) {
  let L = distance(a, b);
  if (L < 1e-4) { return; }
  let d = (b - a) / L;
  let n = vec2<f32>(-d.y, d.x);
  let na = u32(ceil(L / 0.5));
  let nc = u32(ceil(2.0 * hw / 0.5));
  for (var i = 0u; i <= na; i++) {
    let t = f32(i) / f32(max(na, 1u));
    let z = mix(za, zb, t);
    let v = select(1u, DECK_BIT | u32(clamp(z, 0.0, 8.0e6) * 256.0), deck);
    for (var j = 0u; j <= nc; j++) {
      let p = a + d * (t * L) + n * (-hw + 2.0 * hw * f32(j) / f32(max(nc, 1u)));
      if (!inb(p)) { continue; }
      atomicMax(&w6[ixp(p)], v);
    }
  }
}
/** (farms) the road piece being drawn is a track between fields: narrow, dirt, not paved (no claim) */
var<private> roadTrack: bool = false;
fn ribbon(at: u32, a: vec2<f32>, b: vec2<f32>, hw0: f32, col0: u32) {
  let hw = select(hw0, min(hw0, TRACK_HW), roadTrack);
  let col = select(col0, C_TRACK, roadTrack);
  if (roadLive && !roadTrack) { markRoad(a, b, hw, 0.0, 0.0, false); }
  let d = normalize(b - a);
  let s = vec2<f32>(-d.y, d.x) * hw;
  // (M4b: on the town's paving — the claimed quarter cell over the ground, claimSpans; a track a little lower)
  let lift = select(0.27, 0.12, roadTrack);
  let p0 = vec3<f32>(a - s, hAt(a - s) + lift);
  let p1 = vec3<f32>(b - s, hAt(b - s) + lift);
  let p2 = vec3<f32>(b + s, hAt(b + s) + lift);
  let p3 = vec3<f32>(a + s, hAt(a + s) + lift);
  tri(at, p0, p1, p2, col);
  tri(at + 3u, p0, p2, p3, col);
  // (CG25: each vertex's reveal time over the surface byte — the vertices at a, b, b, a, b, a)
  let ca = revCode(revA);
  let cb = revCode(revB);
  if (ca != 0u || cb != 0u) {
    let c6 = array<u32, 6>(ca, cb, cb, ca, cb, ca);
    for (var j = 0u; j < 6u; j++) {
      let o = (at + j) * 8u + 7u;
      w7[o] = (w7[o] & 0xffu) | (c6[j] << 8u);
    }
  }
}
const C_MAJOR_W: u32 = 0xfbf7eeu;
const C_MINOR_W: u32 = 0xeee8dau;
const C_STEEP_W: u32 = 0xf08c33u;
/** (M4b) a road colour: the tone's (u.rc: dirt or stone, a little lighter than the ground) × k, or the lab's white */
fn rgbOf(c: vec3<f32>) -> u32 { let q = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0; return (u32(q.x) << 16u) | (u32(q.y) << 8u) | u32(q.z); }
fn roadTone(k: f32, white: u32) -> u32 { return select(white, rgbOf(u.rc.rgb * k), u.rc.w > 0.5); }
fn cMajor() -> u32 { return roadTone(1.0, C_MAJOR_W); }
fn cMinor() -> u32 { return roadTone(0.95, C_MINOR_W); }
/** a street too steep for carts: the lab's orange, the game's a darker tone (stairs) */
fn cSteep() -> u32 { return roadTone(0.8, C_STEEP_W); }
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
    // (time-lapse, CG25: shown once lots front it or it links two districts begun — mainRev — grown in ahead of them)
    if (u.h2.z > 0.5) { revMain(a, b, normalize(gr) * 0.35 * u.a.x, false); }
    ribbon(at, a, b, u.b.x * 0.5, select(cMajor(), cSteep(), steep(a, b)));
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
  ribbon(at, a - d, c + d, u.b.y * 0.5, select(cMinor(), cSteep(), steep(a, c)));
}
const C_WALL: u32 = 0xf3eee6u;
/** (M4b) the cut-off outline (the fortress's warning red) */
const C_CUTOFF: u32 = 0xe0322du;
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
// ---- (citygen M4a) the lot records: the town's contract with what builds on it (api/contracts/citygen.ts) ---------
// One record a lot slot (RECW words), then one a landmark site from REC_LM: what's on each plot and its shape, in the
// grid's frame. Made from the lots (and the widths and setback: the mesh stage), read by the mesh here and by whatever
// dresses or animates the buildings. Words: 0–7 the parcel (4 corners, x y, counter-clockwise), 8–15 the footprint (the
// parcel inset by its streets' half widths and the setback: the building's; a park's or a plaza's own), 16 the frontage
// (the parcel's edge k → k+1 on the widest street; 255 none), 17 the kind (REC_*), 18 the supercell (district) id,
// 19 storeys, 20 the height (f32: base to roof, world units), 21 the base z (f32, window z when made — the grid's frame),
// 22 the growth key (f32: blocks show out from the centres as growth passes it), 23 the lot's seed (its identity).
const RECW: u32 = 24u;
const REC_LM: u32 = 32768u;
const REC_NONE: u32 = 0u;
const REC_BUILDING: u32 = 1u;
const REC_PARK: u32 = 2u;
const REC_PLAZA: u32 = 3u;
const REC_LANDMARK: u32 = 4u;
/** (farms) a field: its footprint the field (crops — bare.wgsl), a hedge round it, a farmhouse at a corner when its
 *  height is over 0 (words 20, 21 the farmhouse's) */
const REC_FIELD: u32 = 5u;
/** (farms) one farmhouse or barn to about this many fields; its height (one storey and a roof) */
const FARMHOUSE_SHARE: f32 = 0.3;
const FARMHOUSE_H: f32 = 3.5;
/** (farms) a farm belt district's growth key: grown last (under the growth's 1, so shown) */
const BELT_KEY: f32 = 0.97;
/** (farms) a track between fields: its half width, and a hedge's height and half width */
const TRACK_HW: f32 = 0.55;
const HEDGE_H: f32 = 0.7;
const HEDGE_HW: f32 = 0.35;
const C_HEDGE: u32 = 0x4e7436u;
const C_TRACK: u32 = 0x9c8261u;
/** (farms) a field's farmhouse: a small square at its first corner, set in from both sides */
fn farmhouse(q: array<vec2<f32>, 4>) -> array<vec2<f32>, 4> {
  let a = q[0];
  let e1 = normalize(q[1] - q[0]);
  let e2 = normalize(q[3] - q[0]);
  let s = 3.2;
  let o = a + (e1 + e2) * 1.2;
  return array<vec2<f32>, 4>(o, o + e1 * s, o + e1 * s + e2 * s, o + e2 * s);
}
/** the edge on the widest street: a major line (class 1) over a minor street (2); 255 none */
fn frontage(e: u32) -> u32 {
  var best = 255u;
  var bc = 0u;
  for (var k = 0u; k < 4u; k++) {
    let c = ecls(e, k);
    if (c == 1u && bc != 1u) { best = k; bc = 1u; }
    else if (c == 2u && bc == 0u) { best = k; bc = 2u; }
  }
  return best;
}
/** a record into w7 */
fn putRec(i: u32, par: array<vec2<f32>, 4>, fp: array<vec2<f32>, 4>, front: u32, kind: u32, sc: City, storeys: u32, height: f32, base: f32, seed: u32) {
  let o = i * RECW;
  for (var k = 0u; k < 4u; k++) {
    set7(o + k * 2u, par[k].x);
    set7(o + k * 2u + 1u, par[k].y);
    set7(o + 8u + k * 2u, fp[k].x);
    set7(o + 9u + k * 2u, fp[k].y);
  }
  w7[o + 16u] = front;
  w7[o + 17u] = kind;
  w7[o + 18u] = sc.id | (sc.purpose << 24u);
  w7[o + 19u] = storeys;
  set7(o + 20u, height);
  set7(o + 21u, base);
  set7(o + 22u, sc.t);
  w7[o + 23u] = seed;
}
/** one thread a lot slot (mode 0) or a landmark site (mode 1): its record — what stands there, its footprint, its
 *  height by the height-to-plot rule (r1 the lots, b2 the supercells, r3 H, r4 the distance, w5 the sites, w6 the
 *  counts; w7 the records) */
@compute @workgroup_size(64)
fn lotRec(@builtin(global_invocation_id) g: vec3<u32>) {
  if (u.n.w == 1u) {
    let k = g.x;
    if (k >= LM_ROOM) { return; }
    let o = 1u + k * LMW;
    var none: array<vec2<f32>, 4>;
    if (k >= min(w5[0], LM_ROOM) || u.q.y <= 0.0 || bitcast<f32>(w5[o + 2u]) <= 0.0) {
      putRec(REC_LM + k, none, none, 255u, REC_NONE, cityB2(vec2<f32>(0.0)), 0u, 0.0, 0.0, 0u);
      return;
    }
    let p = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
    let r = bitcast<f32>(w5[o + 2u]);
    let big = w5[o + 3u] == 1u;
    // (the circle as its inscribed square, corners on it: the centre their mean, the radius to a corner)
    var par: array<vec2<f32>, 4>;
    var fp: array<vec2<f32>, 4>;
    let rs = max(r - u.b.y * 0.5 - u.b.z - 1.0, 1.0);
    for (var j = 0u; j < 4u; j++) {
      let a = f32(j) * TAU / 4.0 + TAU / 8.0;
      par[j] = p + r * vec2<f32>(cos(a), sin(a));
      fp[j] = p + select(r - u.b.y * 0.5, rs, big) * vec2<f32>(cos(a), sin(a));
    }
    let z = hAt(p);
    let zlo = z - 1.5;
    let top = z + max(3.0, u.b.w * 9.0);
    putRec(REC_LM + k, par, fp, 255u, REC_LANDMARK, cityB2(p), select(0u, u32(max(1.0, round((top - z) / 3.0))), big), select(0.0, top - zlo, big), zlo, 0x40000000u | k);
    return;
  }
  let i = g.x;
  if (i >= u.m.x) { return; }
  var v: array<vec2<f32>, 4>;
  if (i >= min(atomicLoad(&w6[0]), u.m.x)) { putRec(i, v, v, 255u, REC_NONE, cityB2(vec2<f32>(0.0)), 0u, 0.0, 0.0, 0u); return; }
  let o = i * LW;
  for (var k = 0u; k < 4u; k++) { v[k] = vec2<f32>(r1(o + k * 2u), r1(o + 1u + k * 2u)); }
  let e = b1[o + 8u];
  let hs = b1[o + 9u];
  let mid = 0.25 * (v[0] + v[1] + v[2] + v[3]);
  let sc = cityB2(mid);
  let front = frontage(e);
  // (blocked, or a landmark's (its own record): nothing)
  if (blockedAt(mid) || inLandmarkW5(mid)) { putRec(i, v, v, 255u, REC_NONE, sc, 0u, 0.0, 0.0, hs); return; }
  // (m3d: paved — a plaza block, inside a junction's plaza, or a bad lot (a sliver): flat paving, no building)
  var pv: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { pv[k] = mix(v[k], mid, 0.04); }
  let paveOk = u.q.x < 1.5;
  if ((hs & PAVED) != 0u || (paveOk && badQuad(v, 0.0))) { putRec(i, v, pv, front, REC_PLAZA, sc, 0u, 0.0, hAt(mid), hs); return; }
  // (farms: a farm district's lot is a field — inset from its tracks, a hedge round it, now and then a farmhouse)
  if (u.h2.z > 0.5 && sc.purpose == P_FARMS) {
    var fd: array<f32, 4>;
    for (var k = 0u; k < 4u; k++) { fd[k] = select(0.4, TRACK_HW + 0.4, ecls(e, k) != 0u); }
    var fq: array<vec2<f32>, 4>;
    for (var k = 0u; k < 4u; k++) { fq[k] = insetCorner(v, fd, k); }
    var fa = 0.0;
    for (var k = 0u; k < 4u; k++) { fa += cross2(fq[k], fq[(k + 1u) % 4u]); }
    if (fa < 8.0) { putRec(i, v, v, front, REC_NONE, sc, 0u, 0.0, 0.0, hs); return; }
    var fh = 0.0;
    var fb = hAt(mid);
    if (hsh(hs ^ 0xfa12u) < FARMHOUSE_SHARE) {
      let hq = farmhouse(fq);
      var zlo = 1e9;
      var zhi = -1e9;
      for (var k = 0u; k < 4u; k++) { let z = hAt(hq[k]); zlo = min(zlo, z); zhi = max(zhi, z); }
      fb = zlo - 0.5;
      fh = zhi + FARMHOUSE_H - fb;
    }
    putRec(i, v, fq, front, REC_FIELD, sc, select(0u, 1u, fh > 0.0), fh, fb, hs);
    return;
  }
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
  var bad = area < 2.0;
  for (var k = 0u; k < 4u; k++) {
    if (cross2(q[(k + 1u) % 4u] - q[k], q[(k + 2u) % 4u] - q[(k + 1u) % 4u]) <= 0.0) { bad = true; }
  }
  if (bad) { putRec(i, v, pv, front, select(REC_NONE, REC_PLAZA, paveOk), sc, 0u, 0.0, hAt(mid), hs); return; }
  // (m3i: an edge block's lots: one with no street is open land, and now and then one fronting a street is left
  // empty too — a ragged edge)
  if ((hs & EDGE_LOT) != 0u && (!street || hsh(hs ^ 0x9e37u) < 0.15)) { putRec(i, v, q, front, REC_NONE, sc, 0u, 0.0, 0.0, hs); return; }
  if (!street) { putRec(i, v, q, front, REC_PARK, sc, 0u, 0.0, hAt(mid), hs); return; }
  var zlo = 1e9;
  var zhi = -1e9;
  for (var k = 0u; k < 4u; k++) { let z = hAt(q[k]); zlo = min(zlo, z); zhi = max(zhi, z); }
  // (M4a, the height-to-plot rule: a building no taller than t.y × its plot's shortest side — never over the storeys'
  // most, never under a storey — so the street behind it stays in sight at 60°; t.y 0: the lab's storeys × 0.7–1.3)
  var rise = max(1.0, u.b.w * 3.0 * (0.7 + 0.6 * hsh(hs)));
  if (u.t.y > 0.0) {
    var side = 1e9;
    for (var k = 0u; k < 4u; k++) { side = min(side, distance(q[k], q[(k + 1u) % 4u])); }
    // (M4b: the storeys' most by the population field — dense, up to 1.6×; sparse, half)
    rise = clamp(u.t.y * side * (0.85 + 0.3 * hsh(hs)), 3.0, max(3.0, u.b.w * 3.0 * 1.3 * mix(0.5, 1.6, sc.dens)));
  }
  let base = zlo - 0.5;
  putRec(i, v, q, front, REC_BUILDING, sc, u32(max(1.0, round(rise / 3.0))), zhi + rise - base, base, hs);
}
/** one thread a lot's record: a building extruded to its height × its construction progress (r2: 0–1), a park or a
 *  plaza flat; a landmark's is drawn by lmMesh (r1 the records, r2 the progress, r3 H, w6 the counts) */
@compute @workgroup_size(64)
fn lotMesh(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= min(atomicLoad(&w6[0]), u.m.x)) { return; }
  let o = i * RECW;
  let kind = b1[o + 17u];
  if (kind == REC_NONE || kind == REC_LANDMARK) { return; }
  var q: array<vec2<f32>, 4>;
  for (var k = 0u; k < 4u; k++) { q[k] = vec2<f32>(r1(o + 8u + k * 2u), r1(o + 9u + k * 2u)); }
  if (kind == REC_FIELD) {
    fieldMesh(i, o, q);
    return;
  }
  if (kind != REC_BUILDING) {
    let at = room(6u);
    if (at == NONE) { return; }
    curTag = TG_LOT | ((i + 1u) << 8u);
    let lift = select(0.12, 0.15, kind == REC_PLAZA);
    let col = select(C_PARK, cPave(), kind == REC_PLAZA);
    var z: array<vec3<f32>, 4>;
    for (var k = 0u; k < 4u; k++) { z[k] = vec3<f32>(q[k], hAt(q[k]) + lift); }
    tri(at, z[0], z[1], z[2], col);
    tri(at + 3u, z[0], z[2], z[3], col);
    return;
  }
  // (time-lapse: made full height — tlRise sets the tops' z by the lot's progress each frame)
  let h = r1(o + 20u);
  if (h < 0.05) { return; }
  let base = r1(o + 21u);
  let top = base + h;
  let hs = b1[o + 23u];
  // (M4b: cut off from the town's reach — lotReach — a red line round its roof)
  if (b4[i] == 1u) {
    let at2 = room(24u);
    curTag = TG_TOP | OUTLINE_BIT | ((i + 1u) << 8u);
    if (at2 != NONE) {
      for (var k = 0u; k < 4u; k++) {
        let a = q[k];
        let b = q[(k + 1u) % 4u];
        var n = normalize(vec2<f32>(b.y - a.y, a.x - b.x)) * 0.5;
        // (wound to face up, whichever way the footprint turns)
        if (cross2(b - a, n) < 0.0) { n = -n; }
        let z = top + 0.06;
        tri(at2 + k * 6u, vec3<f32>(a - n, z), vec3<f32>(b - n, z), vec3<f32>(b + n, z), C_CUTOFF);
        tri(at2 + k * 6u + 3u, vec3<f32>(a - n, z), vec3<f32>(b + n, z), vec3<f32>(a + n, z), C_CUTOFF);
      }
    }
  }
  let at = room(30u);
  if (at == NONE) { return; }
  let roof = roofColour(u32(hsh(hs * 7u + 3u) * 5.999));
  // (the tops tagged, the bases left: TG_TOP vertices at `top` go to base + height × progress)
  let tg = TG_TOP | ((i + 1u) << 8u);
  curTag = tg;
  tri(at, vec3<f32>(q[0], top), vec3<f32>(q[1], top), vec3<f32>(q[2], top), roof);
  tri(at + 3u, vec3<f32>(q[0], top), vec3<f32>(q[2], top), vec3<f32>(q[3], top), roof);
  for (var k = 0u; k < 4u; k++) {
    let a = q[k];
    let b = q[(k + 1u) % 4u];
    // (counter-clockwise: outward is right of a → b)
    tri(at + 6u + k * 6u, vec3<f32>(a, base), vec3<f32>(b, top), vec3<f32>(a, top), C_WALL);
    tri(at + 9u + k * 6u, vec3<f32>(a, base), vec3<f32>(b, base), vec3<f32>(b, top), C_WALL);
    // (the base vertices: where they're made — or, the lot not begun, sunk with its tops)
    let tb = TG_BASE | ((i + 1u) << 8u);
    w5[(at + 6u + k * 6u) * 2u] = tb;
    w5[(at + 9u + k * 6u) * 2u] = tb;
    w5[(at + 10u + k * 6u) * 2u] = tb;
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
  if (u.h2.z > 0.5) {
    let side = normalize(vec2<f32>(a.y - b.y, b.x - a.x)) * 0.5 * u.a.w;
    // (an arterial is the skeleton's: shown with the main roads; a minor street with its lots (CG25), or ahead with u.sk.z)
    if (hsh(id * 31u + 5u) < 0.33 || u.sk.z > 0.5) { revMain(a, b, side, true); }
    else { revStreet(s, e, a, b, true); }
  }
  ribbon(at, a - d, b + d, u.b.y * 0.5, select(cMinor(), cSteep(), steep(a, b)));
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
  ribbon(at, a, b, u.b.y * 0.5, select(C_CART, cSteep(), stairs));
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
/** (farms) a field block is merged along its line until its length is this × its strip's width (3:1–4:1), and no
 *  longer than FIELD_LEN_MAX */
const FIELD_ASPECT: f32 = 3.5;
const FIELD_LEN_MAX: f32 = 140.0;
/** (m3i) a lot of a block at the town's edge or an empty district's */
const EDGE_LOT: u32 = 0x40000000u;
const C_PAVE_W: u32 = 0xdcd0b6u;
fn cPave() -> u32 { return roadTone(1.02, C_PAVE_W); }
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
  let bq = blockQuad(ob);
  let bad = w5[mo + 4u] == 1u || badQuad(bq, u.c.y);
  // (farms: a block in a farm district or the farm belt is a field's start — merged along its line, its cross streets
  // gone, until it's FIELD_ASPECT × as long as its strip is wide: meta word 11 its farm mark, word 1 asks the merge.
  // Only the truly bad are ever paved)
  let farm = u.h2.z > 0.5 && cityB4(0.25 * (bq[0] + bq[1] + bq[2] + bq[3])).purpose == P_FARMS;
  w5[mo + 11u] = select(0u, 1u, farm);
  let tooShort = farm && distance(bq[0], bq[1]) < FIELD_ASPECT * max(distance(bq[1], bq[2]), 1.0) && distance(bq[0], bq[1]) < FIELD_LEN_MAX;
  w5[mo + 1u] = select(0u, 1u, bad || tooShort);
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
  let farm = w5[mo + 11u];
  let okC = c != NONE && w5[c * 3u * BQW] == 1u && w5[c * 3u * BQW + BQW + 5u] != 1u && w5[c * 3u * BQW + BQW + 11u] == farm;
  let okP = p != NONE && w5[p * 3u * BQW] == 1u && w5[p * 3u * BQW + BQW + 5u] != 1u && w5[p * 3u * BQW + BQW + 11u] == farm;
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
    // (M4a: a tie by position — the list's order is whatever order lmlist's threads ran)
    let pj = vec2<f32>(bitcast<f32>(w5[oj]), bitcast<f32>(w5[oj + 1u]));
    let above = sj > si || (sj == si && (pj.x < pi.x || (pj.x == pi.x && pj.y < pi.y)));
    if (above) { rank++; }
    if (distance(pi, pj) < ri + rj && above) { w5[oi + 2u] = bitcast<u32>(-ri); return; }
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
    ribbon(at, p + r * vec2<f32>(cos(a0), sin(a0)), p + r * vec2<f32>(cos(a1), sin(a1)), u.b.y * 0.5, cMinor());
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
    tri(at, vec3<f32>(p, z + 0.16), vec3<f32>(q0, hAt(q0) + 0.16), vec3<f32>(q1, hAt(q1) + 0.16), cPave());
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
  // (M4a: its region node — the lots' key for it, whatever slot it got)
  w7[o + 10u] = i;
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
  if (u.h2.z > 0.5) {
    // (CG25: with its lots, grown in from its end on a road shown first; ahead with u.sk.z, as a main road)
    if (u.sk.z > 0.5) { revMain(a, b, vec2<f32>(s.y - e.y, e.x - s.x) * (0.5 * u.a.w / max(distance(s, e), 1e-3)), false); }
    else { revStreet(s, e, a, b, false); }
  }
  ribbon(at, a, b, u.b.y * 0.5, cMinor());
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
/** one thread a seed slot: line n.z's live seeds marched up to the next line — where none meets it, its street's end
 *  is LINE_END and its landing waits for a slot (gplace) (w5 the seeds; b4 φ) */
@compute @workgroup_size(64)
fn gmarch(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= nSeeds()) { return; }
  let o = id * SDW;
  if (w5[o + 3u] == 0u || w5[o + 2u] != u.n.z) { return; }
  let s = vec2<f32>(bitcast<f32>(w5[o]), bitcast<f32>(w5[o + 1u]));
  let m = marchUp(s, w5[o + 2u]);
  if (!m.ok) { return; }
  w5[o + 4u] = m.end;
  set5(o + 5u, m.e.x);
  set5(o + 6u, m.e.y);
}
/** wants a landing this round: on line n.z, alive, its march ended on the next line with no seed (gmarch) */
fn wantsLanding(id: u32) -> bool {
  let o = id * SDW;
  return w5[o + 3u] == 1u && w5[o + 2u] == u.n.z && w5[o + 4u] == LINE_END;
}
var<workgroup> gpN: array<u32, 256>;
/** one workgroup (M4a): the landings made — each wanting source its slot T + the landings so far + its rank among this
 *  round's by id (a scan), so a seed's slot is the same whatever order the threads run (it was an atomic counter: the
 *  town came out a lot different now and then) (w5 the seeds, w6 the landings so far) */
@compute @workgroup_size(256)
fn gplace(@builtin(local_invocation_index) li: u32) {
  let nS = nSeeds();
  let T = u.m.w * u32(u.c.w);
  let chunk = (nS + 255u) / 256u;
  let i0 = li * chunk;
  let i1 = min(i0 + chunk, nS);
  // (only the slots below the landings so far can be sources: the slots past them are this round's new landings)
  let base = atomicLoad(&w6[0]);
  let top = min(i1, T + base);
  var c = 0u;
  for (var id = i0; id < top; id++) { if (wantsLanding(id)) { c++; } }
  gpN[li] = c;
  workgroupBarrier();
  if (li == 0u) {
    var acc = 0u;
    for (var k = 0u; k < 256u; k++) { let v = gpN[k]; gpN[k] = acc; acc += v; }
  }
  workgroupBarrier();
  var r = gpN[li];
  for (var id = i0; id < top; id++) {
    if (!wantsLanding(id)) { continue; }
    let k = base + r;
    r++;
    if (k >= T) { continue; }
    let o = id * SDW;
    let nid = T + k;
    let no = nid * SDW;
    w5[no] = w5[o + 5u];
    w5[no + 1u] = w5[o + 6u];
    w5[no + 2u] = u.n.z + 1u;
    w5[no + 3u] = 1u;
    w5[no + 4u] = NONE;
    w5[no + 7u] = id;
    w5[no + 11u] = 3u;
    w5[o + 4u] = nid;
  }
  workgroupBarrier();
  if (li == 255u) { atomicStore(&w6[0], base + r); }
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
const SCW: u32 = 9u;
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
 *  street runs across ∇φ: × 0.7) and along a shore or an arterial (× 0.6) (r3 the smoothed heights, b4 φ, w7 ART) */
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
    // (M4a: along an arterial, as along a shore)
    if (bitcast<f32>(w7[ixp(m) * 4u + 3u]) < 0.5 * u.a.x) { disc = min(disc, 0.6); }
  }
  return L * (1.0 + 3.0 * slope + water) * 0.5 * (fa + fb) * disc;
}
/** one workgroup: the supercells — their seeds (a jittered grid) (M4b: and their density and purpose, the population
 *  field's at the seed — w7), each one's cost distance from the population
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
    // (M4b: the population field at its seed — denser, a bigger budget; sparse, more often an empty district)
    let pi = ixp(scS[c]) * 4u;
    let dens = bitcast<f32>(w7[pi]);
    let thr = lim * (1.0 + u.h.y * (2.0 * vnoise(cc, 2.5, 7u) - 1.0)) * mix(0.55, 1.45, dens);
    let t = scD[c] / max(thr, 1.0);
    // (farms: the farm belt — the cells just past the limit, out to x.y × the budget — in, as farms, grown last)
    let belt = t >= 1.0 && t < u.x.y;
    let inside = t < 1.0 || belt;
    // (empty: never at a centre, never at the edge — under 0.6 of the budget)
    let empty = hash2(c, 4u) < u.h.z * 2.0 * (1.0 - dens) && scD[c] > 0.6 * sc && t < 0.6;
    let o = SC_HEAD + c * SCW;
    w5[o + 6u] = select(u32(bitcast<f32>(w7[pi + 2u])), P_FARMS, belt);
    set5(o + 7u, dens);
    set5(o, scS[c].x);
    set5(o + 1u, scS[c].y);
    w5[o + 2u] = select(0u, select(2u, 1u, empty), inside);
    set5(o + 3u, select(t, BELT_KEY, belt));
    set5(o + 4u, scS[c].x);
    set5(o + 5u, scS[c].y);
  }
}
struct City { state: u32, t: f32, id: u32, dens: f32, purpose: u32, start: f32 }

// ==== CG25: roads grow in with their lots ========================================================================
// (the user, 2026-11-11: "the roads where there are no houses look too dense … hide them until there are houses that
// border them or districts they connect"; "use a shader to fill in the road ahead of the direct work") Each lot's start
// — the town's clock time its progress first passes 0 (LSTART, tlProgress) — is stamped along its parcel's edges into
// the front field (FRONT: the road raster's tail, a word a column, an ordered f32 under atomicMin — frontStamp). A
// parcel's edges lie on its streets' centre lines, so a street reads its fronting lots' earliest start along itself.
// A minor street shows from that start; a main road (a major line, an arterial cross street) from then too, or once it
// links two districts begun (u.sk.x 3, the default). Each grows in over ROAD_LEAD_K of a build, done as its first lot
// starts rising: its vertices carry the clock time the growth reaches them (ribbon; render/bodies.wgsl clips by it).
/** a road grows in over this × a lot's build time (u.tl.y), done as the lot that shows it starts rising */
const ROAD_LEAD_K: f32 = 0.4;
/** the reveal code's steps a second of the town's clock (render/bodies.wgsl vsSkin REV_RES mirrors it) */
const REV_RES: f32 = 16.0;
/** an ungated road: always shown, untagged (code 0) — and a road there from the start (BUILT_AT) */
const REV_UNGATED: f32 = -3e30;
const FRONT_NONE: u32 = 0xffffffffu;
/** the clock time t as the vertex's reveal code (bits 8–31 of word 7): 0 ungated, else 1 + t × REV_RES, the most never */
fn revCode(t: f32) -> u32 {
  if (t < -1e29) { return 0u; }
  return u32(clamp(floor(t * REV_RES) + 1.0, 1.0, 16777215.0));
}
fn revTime(c: u32) -> f32 { return f32(c - 1u) / REV_RES; }
/** an f32 as a u32 that orders as it does (atomicMin on it is the f32 min) */
fn ordF(t: f32) -> u32 { let b = bitcast<u32>(t); return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u); }
fn unordF(k: u32) -> f32 { return bitcast<f32>(select(~k, k & 0x7fffffffu, (k & 0x80000000u) != 0u)); }
/** the earliest start of the lots whose parcels touch p (NOT_YET none): the front field, w6's tail past the raster */
fn frontAt(p: vec2<f32>) -> f32 {
  if (!inb(p)) { return NOT_YET; }
  let k = atomicLoad(&w6[u32(W() * H()) + ixp(p)]);
  return select(unordF(k), NOT_YET, k == FRONT_NONE);
}
/** the supercells' table at b4 (t4) or b2 */
fn cityT(p: vec2<f32>, t4: bool) -> City { if (t4) { return cityB4(p); } return cityB2(p); }
fn scSeedT(id: u32, t4: bool) -> vec2<f32> {
  let o = SC_HEAD + id * SCW;
  if (t4) { return vec2<f32>(r4(o), r4(o + 1u)); }
  return vec2<f32>(r2(o), r2(o + 1u));
}
fn scSizeT(t4: bool) -> f32 { if (t4) { return r4(2u); } return r2(2u); }
/** a district's start, for a main road beside it to link: its start; an empty one's (no lots, only its main roads) the
 *  second earliest start of the districts round p at the margin (u.sk.y) — the road across it links two; outside never */
fn linkStart(c: City, p: vec2<f32>, t4: bool) -> f32 {
  if (c.state == 2u) { return c.start; }
  if (c.state != 1u) { return NOT_YET; }
  let m = max(u.sk.y, 1.0);
  var e1 = NOT_YET;
  var e2 = NOT_YET;
  var i1 = NONE;
  for (var k = 0u; k < 8u; k++) {
    let an = f32(k) * 0.7853982;
    let o = cityT(p + vec2<f32>(cos(an), sin(an)) * m, t4);
    if (o.state != 2u || o.id == i1) { continue; }
    if (o.start < e1) { e2 = e1; e1 = o.start; i1 = o.id; } else if (o.start < e2) { e2 = o.start; }
  }
  return e2;
}
/**
 * (the street skeleton) When a main road at p (its sides p ± side) shows, by the skeleton's reach u.sk.x:
 *   0 its earliest district's start (the old 'with their districts'); 1 that or any within the margin u.sk.y round it
 *   (the old 'begun + a margin'); 2 everywhere (ungated); 3 (CG25, the default) once lots front it, or it links two
 *   districts begun — the two beside it both begun (the core's are, from the start), or the districts round an empty
 *   one it crosses. A main road beside one district begun with nothing begun past it waits for its own lots.
 */
fn mainRev(p: vec2<f32>, side: vec2<f32>, t4: bool) -> f32 {
  let r = u.sk.x;
  if (r > 1.5 && r < 2.5) { return REV_UNGATED; }
  let c1 = cityT(p + side, t4);
  let c2 = cityT(p - side, t4);
  if (r < 1.5) {
    var s = min(c1.start, c2.start);
    if (r > 0.5 && u.sk.y > 0.0) {
      for (var k = 0u; k < 8u; k++) {
        let an = f32(k) * 0.7853982;
        s = min(s, cityT(p + vec2<f32>(cos(an), sin(an)) * u.sk.y, t4).start);
      }
    }
    return s;
  }
  var t = frontAt(p);
  if (c1.id != c2.id || c1.state == 1u) { t = min(t, max(linkStart(c1, p, t4), linkStart(c2, p, t4))); }
  return t;
}
/** the piece's reveal at its ends (ribbon writes them), its time-lapse tag (tlRise sinks it till it begins: the
 *  shadows) and whether it's marked for the claims (its reveal begun) */
fn revSet(ta: f32, tb: f32) {
  revA = ta;
  revB = tb;
  let c = revCode(min(ta, tb));
  curTag = select(0u, TG_ROAD | (c << 8u), c != 0u);
  roadLive = min(ta, tb) <= u.tl.x;
}
/** a main road's piece a → b (sides ± side): shown from mainRev, grown in outward from the town's centre across a
 *  supercell over the lead — its outer end reached last, at that time */
fn revMain(a: vec2<f32>, b: vec2<f32>, side: vec2<f32>, t4: bool) {
  let m = 0.5 * (a + b);
  let t = mainRev(m, side, t4);
  let c1 = cityT(m + side, t4);
  let c2 = cityT(m - side, t4);
  // (farms: a dirt track, not a street, when the earliest district beside it or within the margin is a farm district —
  // the skeleton's rule from before CG25, kept as it was: only when the road shows changed here)
  var ce = c2;
  if (c1.start <= c2.start) { ce = c1; }
  if (u.sk.x > 0.5 && u.sk.y > 0.0) {
    for (var k = 0u; k < 8u; k++) {
      let an = f32(k) * 0.7853982;
      let o = cityT(m + vec2<f32>(cos(an), sin(an)) * u.sk.y, t4);
      if (o.start < ce.start) { ce = o; }
    }
  }
  // (everywhere — reach 2 — never a track, as before)
  roadTrack = ce.purpose == P_FARMS && !(u.sk.x > 1.5 && u.sk.x < 2.5);
  if (t < -1e29) { revSet(REV_UNGATED, REV_UNGATED); return; }
  let S = max(scSizeT(t4), 1.0);
  let r0 = min(distance(scSeedT(c1.id, t4), u.d.xy), distance(scSeedT(c2.id, t4), u.d.xy)) - 0.5 * S;
  let lead = ROAD_LEAD_K * u.tl.y;
  let ga = clamp((distance(a, u.d.xy) - r0) / S, 0.0, 1.0);
  let gb = clamp((distance(b, u.d.xy) - r0) / S, 0.0, 1.0);
  revSet(t - lead * (1.0 - ga), t - lead * (1.0 - gb));
}
/** a minor street s → e (its piece a → b being drawn): shown from its fronting lots' earliest start (the front field at
 *  seven points along it), grown in over the lead from the end whose own road shows first (a tie: the one nearer the
 *  centre) toward the far end — all of it there as that lot starts rising */
fn revStreet(s: vec2<f32>, e: vec2<f32>, a: vec2<f32>, b: vec2<f32>, t4: bool) {
  let L = max(distance(s, e), 1e-3);
  let d = (e - s) / L;
  var t = NOT_YET;
  for (var j = 1u; j < 8u; j++) { t = min(t, frontAt(mix(s, e, f32(j) / 8.0))); }
  let n = vec2<f32>(-d.y, d.x) * 0.5 * u.a.w;
  let mid = 0.5 * (a + b);
  roadTrack = cityT(mid + n, t4).purpose == P_FARMS && cityT(mid - n, t4).purpose == P_FARMS;
  if (t < -1e29) { revSet(REV_UNGATED, REV_UNGATED); return; }
  let off = d * 0.5 * u.a.w;
  let ts = mainRev(s, off, t4);
  let te = mainRev(e, off, t4);
  let fromS = ts < te || (ts == te && distance(s, u.d.xy) <= distance(e, u.d.xy));
  let lead = ROAD_LEAD_K * u.tl.y;
  let sa = clamp(dot(a - s, d) / L, 0.0, 1.0);
  let sb = clamp(dot(b - s, d) / L, 0.0, 1.0);
  revSet(t - lead * (1.0 - select(1.0 - sa, sa, fromS)), t - lead * (1.0 - select(1.0 - sb, sb, fromS)));
}
/** a parcel's edge is stamped this many half cells either side: a gap block's lots (streets.wgsl gleaf) stand clear of
 *  their street, so their edges lie a few cells off its centre line (Muru, all 209 lots begun: ±0.7 left 8 more begun lots
 *  with no live road at their frontage than before CG25, ±2 left 2, ±3 none) */
const FRONT_STEPS: i32 = 6;
/** one thread a lot record: its start (r2 LSTART) stamped along its parcel's edges into the front field — the columns
 *  within 3 of each edge (b1 the records, b3 the counts — CNT; w6 the road raster, FRONT its tail) */
@compute @workgroup_size(64)
fn frontStamp(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= min(b3[0], REC_LM)) { return; }
  let o = i * RECW;
  if (b1[o + 17u] == REC_NONE) { return; }
  let t = r2(i);
  if (t >= 1e29) { return; }
  let key = ordF(t);
  let base = u32(W() * H());
  for (var k = 0u; k < 4u; k++) {
    let a = vec2<f32>(r1(o + k * 2u), r1(o + k * 2u + 1u));
    let b = vec2<f32>(r1(o + ((k + 1u) % 4u) * 2u), r1(o + ((k + 1u) % 4u) * 2u + 1u));
    let L = distance(a, b);
    if (L < 1e-3) { continue; }
    let nv = vec2<f32>(a.y - b.y, b.x - a.x) / L;
    let ns = u32(ceil(L / 0.5));
    for (var j = 0u; j <= ns; j++) {
      let p = mix(a, b, f32(j) / f32(ns));
      for (var q = -FRONT_STEPS; q <= FRONT_STEPS; q++) {
        let pq = p + nv * (0.5 * f32(q));
        if (inb(pq)) { atomicMin(&w6[base + ixp(pq)], key); }
      }
    }
  }
}
/** a point's supercell — its state, its growth key, its id (the table at b4) */
fn cityB4(p: vec2<f32>) -> City {
  var c: City;
  c.state = 2u;
  c.t = 0.0;
  c.id = 0u;
  c.dens = 0.5;
  c.purpose = 0u;
  c.start = -1e30;
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
  c.purpose = b4[o + 6u];
  c.dens = r4(o + 7u);
  c.start = r4(o + 8u);
  return c;
}
/** the same, the table at b2 */
fn cityB2(p: vec2<f32>) -> City {
  var c: City;
  c.state = 2u;
  c.t = 0.0;
  c.id = 0u;
  c.dens = 0.5;
  c.purpose = 0u;
  c.start = -1e30;
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
  c.purpose = b2[o + 6u];
  c.dens = r2(o + 7u);
  c.start = r2(o + 8u);
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

// ==== citygen M4a: arterials and their bridges ===================================================================
// A town's approach roads: up to NART polylines from its centre outward — the game's: the atlas roads into the town as
// they're stamped in the land (their points, the CPU's upload of authored data); the lab's: straight test spokes. On
// the GPU: each one's length inside the grid, where it crosses water (the wet mask) its spans — a deck at a fixed
// height (its higher bank + t.z) with pillars down to the bed; a crossing longer than t.w, or water that runs on to the
// grid's edge, ends it at its shore (no bridge to nowhere) — and, once the supercells are made, where it leaves the
// town's limit (`artEnd`): drawn to there, tapering to the atlas road's width; past it the stamped road carries on.
// The arterials cut the blocks they cross (a lot on one isn't made: `lots`) and the supercells grow cheaply along them
// (growCost: × 0.6, as along a shore). (Tried first: the arterials as seeds of the distance flood, like a shore — where
// they meet at the centre φ collapsed into a star and the town fell apart: half the lots, streets piled up.)
// ART (words): 0 the count (the CPU's), 1 the core (the CPU's), 2 the town's own bridges after them (GPU: townBridge),
// 3 unused; arterial k at 4 + k · AW: 0 its points, 1 its length along them inside the grid (GPU), 2 its spans (GPU), 3
// where it ends — the town's limit, or its length (GPU), 4 + 4s span s's start and end (along it) and its deck's z at
// each (M4b: a deck slopes from its near bank's height + t.z to its far bank's, so a walker steps on at either end);
// from AP its points (x, y, the grid's world units), the centre's end first.
const NART: u32 = 8u;
const NAP: u32 = 128u;
const AP: u32 = 20u;
const AW: u32 = AP + 2u * NAP;
const NSPAN: u32 = 4u;
const C_ART_W: u32 = 0xf1eadbu;
fn cArt() -> u32 { return roadTone(1.05, C_ART_W); }
const C_DECK: u32 = 0xb08f6au;
const C_PIER: u32 = 0x8f8a82u;
/** a deck's thickness; a pillar every this many world units along it; a pillar's half width */
const DECK_T: f32 = 0.8;
const PIER_EVERY: f32 = 6.0;
const PIER_HW: f32 = 0.6;
/** the atlas road's half width (atlas/ways.ts HALF): an arterial tapers to it over ART_TAPER at the town's limit */
const WAY_HALF: f32 = 2.2;
const ART_TAPER: f32 = 12.0;
/** dry ground after deep water that closes a crossing (world units) */
const ART_GAP: f32 = 2.0;
/** (trackA-liquids, LQ7 — DESIGN §12: roads become bridges over water) a crossing no longer than this (world units of
 *  wet along the road) is a ford: no deck, the road's paving not claimed on its wet columns (claimRoads) — its bed bare
 *  under the water; longer, a deck */
const FORD_MAX: f32 = 2.5;
/** (trackA-liquids) a deck's slab as claimed into the columns (the drawn deck's sides go DECK_T down), and the air it
 *  keeps over the water's surface */
const DECK_CLAIM_T: f32 = 0.25;
const DECK_AIR: f32 = 0.1;
fn artBase(k: u32) -> u32 { return 4u + k * AW; }
/** a word of ART, from the binding it's at in this pass (1, 2, 5 or 7) */
fn artW(src: u32, i: u32) -> u32 {
  switch (src) {
    case 1u: { return b1[i]; }
    case 2u: { return b2[i]; }
    case 5u: { return w5[i]; }
    default: { return w7[i]; }
  }
}
fn artF(src: u32, i: u32) -> f32 { return bitcast<f32>(artW(src, i)); }
/** the arterials: the CPU's (the atlas roads), and the town's bridges after them */
fn artCount(src: u32) -> u32 { return min(artW(src, 0u) + artW(src, 2u), NART); }
fn artCountCpu(src: u32) -> u32 { return min(artW(src, 0u), NART); }
// (the arterials' distance field, AD: a flood from their columns — artRast, the jump flood, jdist; lots and growCost
// read it)
fn artPts(src: u32, k: u32) -> u32 { return min(artW(src, artBase(k)), NAP); }
fn artPt(src: u32, k: u32, j: u32) -> vec2<f32> { let o = artBase(k) + AP + 2u * j; return vec2<f32>(artF(src, o), artF(src, o + 1u)); }
/** one thread an arterial: its length inside the grid and its bridges' spans, marched a segment at a time (b1 the
 *  wet mask, b3 the heights; w5 ART) */
@compute @workgroup_size(8)
fn artSpan(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x;
  if (k >= artCountCpu(5u)) { return; }
  let o = artBase(k);
  let n = artPts(5u, k);
  var end = 0.0;
  var ns = 0u;
  var wet = false;
  var t0 = 0.0;
  var p0 = vec2<f32>(0.0);
  // (the last deep sample: a crossing closes ART_GAP of dry ground after it — a bank's puddle isn't a second bridge)
  var tw = 0.0;
  var pd = artPt(5u, k, 0u);
  var acc = 0.0;
  var out = false;
  // (trackA-liquids: the highest water surface along this crossing — a deck's claimed slab clears it)
  var wsMax = -1e9;
  for (var j = 0u; j + 1u < n && !out; j++) {
    let a = artPt(5u, k, j);
    let b = artPt(5u, k, j + 1u);
    let L = distance(a, b);
    for (var f = 0.0; f < L; f += 0.5) {
      let t = acc + f;
      let p = mix(a, b, f / max(L, 1e-4));
      // (its length inside the grid: to its last point, or where it leaves the grid)
      if (!inb(p)) { out = true; break; }
      end = t;
      let w = r1(ixp(p)) > 0.5;
      if (w && !wet) { wet = true; t0 = t; p0 = pd; wsMax = -1e9; }
      if (w) { wsMax = max(wsMax, r2(ixp(p))); }
      if (w) { tw = t; } else { pd = p; }
      if (!w && wet && t - tw >= ART_GAP) {
        wet = false;
        // (the deck runs a unit onto each bank — its height the higher bank's, a little over; a crossing too long, or
        // past the spans' room, ends the arterial at its near shore)
        let sa = max(t0 - 1.0, 0.0);
        let sb = tw + 1.0;
        // (a short crossing: a ford — no deck)
        if (tw - t0 <= FORD_MAX) { continue; }
        if (sb - sa > u.t.w || ns == NSPAN) { end = sa; out = true; break; }
        let s5 = o + 4u + ns * 4u;
        set5(s5, sa);
        set5(s5 + 1u, sb);
        // (trackA-liquids: and its slab — DECK_CLAIM_T, what's claimed into the columns — DECK_AIR over the water's highest
        // surface along the crossing, so the river runs under it, not into it)
        let zMin = wsMax + DECK_CLAIM_T + DECK_AIR;
        set5(s5 + 2u, max(r3(ixp(p0)) + u.t.z, zMin));
        set5(s5 + 3u, max(r3(ixp(p)) + u.t.z, zMin));
        ns++;
      }
    }
    if (!out) { acc += L; end = acc; }
  }
  if (wet) { end = max(t0 - 1.0, 0.0); }
  set5(o + 1u, end);
  w5[o + 2u] = ns;
  set5(o + 3u, end);
}
/** one thread an arterial's segment: its columns, up to its length, seeds of the arterials' distance flood (b1 ART;
 *  w5 the seeds) */
@compute @workgroup_size(64)
fn artRast(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x / NAP;
  let j = g.x % NAP;
  if (k >= artCountCpu(1u) || j + 1u >= artPts(1u, k)) { return; }
  let len = r1(artBase(k) + 1u);
  var acc = 0.0;
  for (var i = 0u; i < j; i++) { acc += distance(artPt(1u, k, i), artPt(1u, k, i + 1u)); }
  let a = artPt(1u, k, j);
  let b = artPt(1u, k, j + 1u);
  let L = distance(a, b);
  for (var f = 0.0; f <= L; f += 0.5) {
    if (acc + f > len) { return; }
    let c = cat(mix(a, b, f / max(L, 1e-4)));
    if (c.x < 0 || c.y < 0 || c.x >= W() || c.y >= H()) { continue; }
    w5[ixq(c)] = pk(u32(c.x), u32(c.y), 0u);
  }
}
/** one thread an arterial, once the supercells are made: where it leaves the town's limit (a supercell out) — a
 *  bridge it's on carried to its far bank (w5 ART, b4 the supercells) */
@compute @workgroup_size(8)
fn artEnd(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x;
  if (k >= artCountCpu(5u)) { return; }
  let o = artBase(k);
  let len = bitcast<f32>(w5[o + 1u]);
  let n = artPts(5u, k);
  // (never short of the core — past it the atlas's stamped road carries on; ART word 1)
  let core = bitcast<f32>(w5[1u]);
  let c0 = artPt(5u, k, 0u);
  var lim = len;
  var acc = 0.0;
  var done = false;
  for (var j = 0u; j + 1u < n && !done; j++) {
    let a = artPt(5u, k, j);
    let b = artPt(5u, k, j + 1u);
    let L = distance(a, b);
    for (var f = 0.0; f < L; f += 1.0) {
      if (acc + f >= len) { done = true; break; }
      let p = mix(a, b, f / max(L, 1e-4));
      if (distance(p, c0) >= core && cityB4(p).state == 0u) { lim = acc + f; done = true; break; }
    }
    acc += L;
  }
  for (var s = 0u; s < min(w5[o + 2u], NSPAN); s++) {
    let sa = bitcast<f32>(w5[o + 4u + s * 4u]);
    let sb = bitcast<f32>(w5[o + 5u + s * 4u]);
    if (lim > sa && lim < sb) { lim = sb; }
  }
  set5(o + 3u, lim);
}
/** whether a quad meets an arterial's corridor (its half width and a cell): its middle, or a point every unit round
 *  its edges, that near an arterial (b2 the arterials' distance) */
fn artHitB2(v: array<vec2<f32>, 4>) -> bool {
  let m = u.t.x * 0.5 + 1.0;
  if (r2(ixp(0.25 * (v[0] + v[1] + v[2] + v[3]))) < m) { return true; }
  for (var e = 0u; e < 4u; e++) {
    let a = v[e];
    let b = v[(e + 1u) % 4u];
    let n = min(u32(ceil(distance(a, b))), 64u);
    for (var i = 0u; i <= n; i++) { if (r2(ixp(mix(a, b, f32(i) / f32(max(n, 1u))))) < m) { return true; } }
  }
  return false;
}
/** a wall from p to q (outward: to the right of p → q), z0 up to z1 */
fn wall(at: u32, p: vec2<f32>, q: vec2<f32>, z0: f32, z1: f32, col: u32) {
  tri(at, vec3<f32>(p, z0), vec3<f32>(q, z0), vec3<f32>(q, z1), col);
  tri(at + 3u, vec3<f32>(p, z0), vec3<f32>(q, z1), vec3<f32>(p, z1), col);
}
/** a deck's side from p (its top at zp) to q (zq), DECK_T deep (outward: right of p → q) */
fn deckSide(at: u32, p: vec2<f32>, q: vec2<f32>, zp: f32, zq: f32) {
  tri(at, vec3<f32>(p, zp - DECK_T), vec3<f32>(q, zq - DECK_T), vec3<f32>(q, zq), C_DECK);
  tri(at + 3u, vec3<f32>(p, zp - DECK_T), vec3<f32>(q, zq), vec3<f32>(p, zp), C_DECK);
}
/** one thread an arterial's segment: a ribbon on the ground to the town's limit (tapering into the atlas road's
 *  width), or over a span a deck piece and, where a pillar falls in it, a pillar to the bed (b1 ART, r3 the heights;
 *  w7 the mesh) */
@compute @workgroup_size(64)
fn artMesh(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x / NAP;
  let j = g.x % NAP;
  if (k >= artCount(1u) || j + 1u >= artPts(1u, k)) { return; }
  let o = artBase(k);
  let lim = r1(o + 3u);
  var acc = 0.0;
  for (var i = 0u; i < j; i++) { acc += distance(artPt(1u, k, i), artPt(1u, k, i + 1u)); }
  if (acc >= lim) { return; }
  let p0 = artPt(1u, k, j);
  let p1 = artPt(1u, k, j + 1u);
  let L = distance(p0, p1);
  if (L < 1e-3) { return; }
  let s0 = acc;
  let s1 = min(acc + L, lim);
  let d = (p1 - p0) / L;
  let a = p0 + d * (s0 - acc);
  let b = p0 + d * (s1 - acc);
  let mid = 0.5 * (s0 + s1);
  // (the taper: the last ART_TAPER units to the limit narrow to the atlas road's width)
  let hw = mix(WAY_HALF, u.t.x * 0.5, clamp((lim - mid) / ART_TAPER, 0.0, 1.0));
  var deck = -1e9;
  var za = 0.0;
  var zb = 0.0;
  for (var s = 0u; s < min(b1[o + 2u], NSPAN); s++) {
    let q = o + 4u + s * 4u;
    if (mid >= r1(q) && mid <= r1(q + 1u)) {
      // (the deck's height at this piece's ends: a slope from bank to bank)
      let L0 = max(r1(q + 1u) - r1(q), 1e-3);
      za = mix(r1(q + 2u), r1(q + 3u), clamp((s0 - r1(q)) / L0, 0.0, 1.0));
      zb = mix(r1(q + 2u), r1(q + 3u), clamp((s1 - r1(q)) / L0, 0.0, 1.0));
      deck = max(za, zb);
    }
  }
  if (deck < -1e8) {
    let at = room(6u);
    if (at == NONE) { return; }
    ribbon(at, a - d * 0.3, b + d * 0.3, hw, select(cArt(), cSteep(), steep(a, b)));
    return;
  }
  // (a pillar where a multiple of PIER_EVERY falls in this piece, the ground well under the deck)
  let ps = ceil(s0 / PIER_EVERY) * PIER_EVERY;
  let pc = a + d * (ps - s0);
  let pz = mix(za, zb, clamp((ps - s0) / max(s1 - s0, 1e-3), 0.0, 1.0));
  let pier = ps < s1 && hAt(pc) < pz - DECK_T - 0.5;
  let at = room(select(18u, 42u, pier));
  if (at == NONE) { return; }
  let sv = vec2<f32>(-d.y, d.x) * hw;
  let a2 = a - d * 0.05;
  let b2 = b + d * 0.05;
  markRoad(a, b, hw, za, zb, true);
  tri(at, vec3<f32>(a2 - sv, za), vec3<f32>(b2 - sv, zb), vec3<f32>(b2 + sv, zb), C_DECK);
  tri(at + 3u, vec3<f32>(a2 - sv, za), vec3<f32>(b2 + sv, zb), vec3<f32>(a2 + sv, za), C_DECK);
  deckSide(at + 6u, a2 - sv, b2 - sv, za, zb);
  deckSide(at + 12u, b2 + sv, a2 + sv, zb, za);
  if (!pier) { return; }
  let u1 = d * PIER_HW;
  let u2 = vec2<f32>(-d.y, d.x) * PIER_HW;
  let q = array<vec2<f32>, 4>(pc - u1 - u2, pc + u1 - u2, pc + u1 + u2, pc - u1 + u2);
  let z0 = hAt(pc) - 0.5;
  for (var e = 0u; e < 4u; e++) { wall(at + 18u + e * 6u, q[e], q[(e + 1u) % 4u], z0, pz - DECK_T, C_PIER); }
}

// ==== M4b: the population field — density, wealth and purpose over the town's grid ===============================
// DESIGN §17: "The population field is a GPU field … giving density, wealth and purpose by district." Made from the
// town's inputs (its centre, radius, peak density by its size, its purpose, its seed) and the ground: dense at the
// centre, falling off over the radius, thin on slopes and nothing on water; up along the arterials; low-frequency
// noise by the seed. Wealth: the centre and high ground. Purpose (per column; a supercell takes its seed's): the
// highest of market (the centre, the arterials' junctions), harbour (the shore), workshops (along the arterials, out
// of the centre), farms (the thin edge), keep (the centre's high ground) and homes (everywhere else) — the
// settlement's own purpose weighted up. POP: 4 words a column — density, wealth, purpose (f32), the arterials'
// distance (AD, for growCost). The game's player will change it as the city grows (later).
const P_HOMES: u32 = 0u;
const P_MARKET: u32 = 1u;
const P_HARBOUR: u32 = 2u;
const P_WORKSHOPS: u32 = 3u;
const P_FARMS: u32 = 4u;
const P_KEEP: u32 = 5u;
/** one thread a column (b1 the smoothed heights, b2 the feature distance, b3 the arterials' distance, b4 the wet
 *  mask; w5 POP) */
@compute @workgroup_size(8, 8)
fn popField(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let p = cpos(x, y);
  let ad = r3(i);
  set5(i * 4u + 3u, ad);
  if (u.pp.x <= 0.0) { set5(i * 4u, 0.5); set5(i * 4u + 1u, 0.5); set5(i * 4u + 2u, f32(P_HOMES)); return; }
  if (r4(i) > 0.5) { set5(i * 4u, 0.0); set5(i * 4u + 1u, 0.0); set5(i * 4u + 2u, f32(P_HARBOUR)); return; }
  let r = distance(p, u.d.xy) / max(u.d.z, 1.0);
  let slope = length(grad1(x, y));
  let flat = 1.0 - smoothstep(0.15, 0.7, slope);
  let artK = exp(-ad / 12.0);
  var d = u.pp.x * exp(-1.6 * r * r) * mix(0.35, 1.0, flat);
  d += 0.25 * u.pp.x * artK * (1.0 - smoothstep(0.8, 1.3, r));
  d *= mix(0.75, 1.25, vnoise(p / 40.0, 1.0, 11u));
  d = clamp(d, 0.0, 1.0);
  let hgt = r1(i);
  let hc = r1(ixp(u.d.xy));
  let wealth = clamp(0.35 * vnoise(p / 60.0, 1.0, 12u) + 0.45 * exp(-2.0 * r * r) + 0.2 * clamp((hgt - hc) / 20.0, -1.0, 1.0) + 0.1, 0.0, 1.0);
  let fd = r2(i);
  var sc = array<f32, 6>(0.45, 0.0, 0.0, 0.0, 0.0, 0.0);
  sc[P_MARKET] = exp(-8.0 * r * r) + 0.5 * exp(-ad / 6.0) * exp(-3.0 * r * r);
  sc[P_HARBOUR] = exp(-fd / 6.0) * select(0.0, 1.0, fd < 12.0) * 0.9;
  sc[P_WORKSHOPS] = 0.8 * artK * smoothstep(0.3, 0.8, r);
  sc[P_FARMS] = smoothstep(0.7, 1.1, r) * (1.0 - d);
  sc[P_KEEP] = 0.7 * exp(-6.0 * r * r) * clamp((hgt - hc) / 10.0, 0.0, 1.0);
  let k = i32(u.pp.y);
  if (k >= 0 && k < 6) { sc[k] *= 1.6; }
  var best = P_HOMES;
  for (var j = 1u; j < 6u; j++) { if (sc[j] > sc[best]) { best = j; } }
  set5(i * 4u, d);
  set5(i * 4u + 1u, wealth);
  set5(i * 4u + 2u, f32(best));
}

// ==== M4b: the town's own bridge — where water splits the town and no arterial crosses ===========================
// The user: "Do add bridges though across the water that's needed." One workgroup: every other column of the grid a
// candidate where it's dry, in the shown town, on a shore; a ray from it straight across the water (against the
// feature distance's gradient) to the first dry ground; kept when that's in the shown town too, the water at least
// 3 wide, no longer than the longest bridge, the banks within 4 of each other and no arterial within 30 (POP.w). Its
// score its length + half its distance from the centre; the lowest wins (ties by candidate): a bridge appended to the
// arterials (ART word 2: 1, else 0) — two points, one span bank to bank, drawn and claimed as theirs. (b1 the wet
// mask, b2 the feature distance, r3 the heights, b4 the supercells, w5 ART, w7 POP)
var<workgroup> tbS: array<f32, 256>;
var<workgroup> tbI: array<u32, 256>;
var<workgroup> tbL: array<f32, 256>;
fn fdb2(p: vec2<f32>) -> f32 { return r2(ixp(p)); }
@compute @workgroup_size(256)
fn townBridge(@builtin(local_invocation_index) li: u32) {
  let cw = u32(W()) / 2u;
  let n = cw * (u32(H()) / 2u);
  var best = 1e9;
  var bi = NONE;
  var bl = 0.0;
  for (var c = li; c < n; c += 256u) {
    let x = i32(c % cw) * 2;
    let y = i32(c / cw) * 2;
    let p = cpos(x, y);
    if (r1(ix(x, y)) > 0.5 || !inb(p)) { continue; }
    let e = 0.75;
    let gr = vec2<f32>(fdb2(p + vec2<f32>(e, 0.0)) - fdb2(p - vec2<f32>(e, 0.0)), fdb2(p + vec2<f32>(0.0, e)) - fdb2(p - vec2<f32>(0.0, e)));
    if (dot(gr, gr) < 1e-8) { continue; }
    let d = -normalize(gr);
    if (r1(ixp(p + d * 1.0)) < 0.5) { continue; }
    if (!shownCity(cityB4(p))) { continue; }
    var t = 1.0;
    var ok = false;
    loop {
      if (t > u.t.w + 1.0) { break; }
      let q = p + d * t;
      if (!inb(q)) { break; }
      if (r1(ixp(q)) < 0.5) { ok = true; break; }
      t += 0.5;
    }
    if (!ok || t < 3.0) { continue; }
    let q = p + d * t;
    let m = 0.5 * (p + q);
    if (!shownCity(cityB4(q)) || abs(r3(ixp(q)) - r3(ixp(p))) > 4.0 || bitcast<f32>(w7[ixp(m) * 4u + 3u]) < 30.0) { continue; }
    let sc = t + 0.5 * distance(m, u.d.xy);
    if (sc < best) { best = sc; bi = c; bl = t; }
  }
  tbS[li] = best;
  tbI[li] = bi;
  tbL[li] = bl;
  workgroupBarrier();
  if (li != 0u) { return; }
  var b = 0u;
  for (var k = 1u; k < 256u; k++) {
    if (tbS[k] < tbS[b] || (tbS[k] == tbS[b] && tbI[k] < tbI[b])) { b = k; }
  }
  let kk = min(w5[0], NART);
  w5[2] = 0u;
  if (tbI[b] == NONE || kk >= NART) { return; }
  let c = tbI[b];
  let x = i32(c % cw) * 2;
  let y = i32(c / cw) * 2;
  let p = cpos(x, y);
  let e = 0.75;
  let gr = vec2<f32>(fdb2(p + vec2<f32>(e, 0.0)) - fdb2(p - vec2<f32>(e, 0.0)), fdb2(p + vec2<f32>(0.0, e)) - fdb2(p - vec2<f32>(0.0, e)));
  let d = -normalize(gr);
  // (a unit onto each bank)
  let a = p - d;
  let q = p + d * (tbL[b] + 1.0);
  let L = distance(a, q);
  let o = artBase(kk);
  // (a point every 4 units: a piece and a pillar a stretch)
  let np = min(u32(ceil(L / 4.0)) + 1u, NAP);
  w5[o] = np;
  set5(o + 1u, L);
  w5[o + 2u] = 1u;
  set5(o + 3u, L);
  set5(o + 4u, 0.0);
  set5(o + 5u, L);
  set5(o + 6u, r3(ixp(p)) + u.t.z);
  set5(o + 7u, r3(ixp(p + d * tbL[b])) + u.t.z);
  for (var j = 0u; j < np; j++) {
    let v = mix(a, q, f32(j) / f32(np - 1u));
    set5(o + AP + 2u * j, v.x);
    set5(o + AP + 2u * j + 1u, v.y);
  }
  w5[2] = 1u;
}

// ==== M4b: the town's claims — its claim grid, GPU-owned (sim/static-claims.ts gpuGrid; colapply.wgsl claimGrid) ===
// CG, dense over the grid, colapply's claimGrid layout: a column (x, y as i32 in the grid, its span's index — its own —
// and its count, 0 or 1), then its span (z0, z1 world z, the fallback material, the owner: its lot record + 1, 0 the
// town's roads and decks). A building is its footprint's columns from its base to its height × its progress; a deck a
// slab DECK_T deep under its top; a road a quarter cell of paving on the ground (claimed where free: on it). Made at
// every mesh run, read where it lies on the GPU (nothing comes back): claimed as the land arrives, kept by the orphan
// pass, checked after an edit (colapply gridDamage: the damaged records' ids, a few words back). Decks aren't claimed
// (claimRoads): a deck a slab DECK_CLAIM_T under its top, over the river, which runs in the gap under it.
const PAVE_T: f32 = 0.25;
/** a column with no span the town keeps bare of plants all the same (its owner word, count 0): a building's or a
 *  plaza's parcel round its footprint (bare.wgsl) */
const BARE_ONLY: u32 = 0x80000000u;
/** (farms) a field's column, no span: its owner word FIELD_COL | its record — bare.wgsl writes its crop */
const FIELD_COL: u32 = 0x40000000u;
/** (farms) a field block this big has a track across it at its first split */
const FARM_TRACK_AREA: f32 = 9000.0;
/** (farms) a field's columns marked in the claim grid's owner plane (where nothing else spans them) */
fn claimField(r: u32, o: u32) {
  var q: array<vec2<f32>, 4>;
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  for (var k = 0u; k < 4u; k++) {
    q[k] = vec2<f32>(r1(o + 8u + k * 2u), r1(o + 9u + k * 2u));
    lo = min(lo, q[k]);
    hi = max(hi, q[k]);
  }
  let N = u32(W() * H());
  for (var y = max(i32(floor(lo.y / ROW_H)) - 1, 0); y <= min(i32(ceil(hi.y / ROW_H)) + 1, H() - 1); y++) {
    for (var x = max(i32(floor(lo.x)) - 1, 0); x <= min(i32(ceil(hi.x)) + 1, W() - 1); x++) {
      let p = cpos(x, y);
      var inside = true;
      for (var k = 0u; k < 4u; k++) { if (cross2(q[(k + 1u) % 4u] - q[k], p - q[k]) < 0.0) { inside = false; } }
      let c = ix(x, y);
      if (inside && w7[c * 4u + 3u] == 0u) { w7[N * 4u + c * 4u + 3u] = FIELD_COL | r; }
    }
  }
  // (FM3: the farmhouse claimed as a building's columns — its base to its risen height — so units go round it)
  let h = r1(o + 20u) * clamp(r2(r), 0.0, 1.0);
  if (h < 0.05) { return; }
  let hq = farmhouse(q);
  let base = r1(o + 21u);
  var hlo = vec2<f32>(1e9);
  var hhi = vec2<f32>(-1e9);
  for (var k = 0u; k < 4u; k++) { hlo = min(hlo, hq[k]); hhi = max(hhi, hq[k]); }
  for (var y = max(i32(floor(hlo.y / ROW_H)) - 1, 0); y <= min(i32(ceil(hhi.y / ROW_H)) + 1, H() - 1); y++) {
    for (var x = max(i32(floor(hlo.x)) - 1, 0); x <= min(i32(ceil(hhi.x)) + 1, W() - 1); x++) {
      let p = cpos(x, y);
      var inside = true;
      for (var k = 0u; k < 4u; k++) { if (cross2(hq[(k + 1u) % 4u] - hq[k], p - hq[k]) < 0.0) { inside = false; } }
      if (!inside) { continue; }
      let c = ix(x, y);
      let so = N * 4u + c * 4u;
      w7[c * 4u + 3u] = 1u;
      set7(so, base);
      set7(so + 1u, base + h);
      w7[so + 2u] = M_RUBBLE;
      w7[so + 3u] = r + 1u;
    }
  }
}
const M_RUBBLE: u32 = 4u;
const M_WOOD: u32 = 10u;
/** one thread a grid column: its road or deck span from ROADS, or none (b1 ROADS, b2 the wet mask, r3 the heights; w7 CG)
 *  (trackA-liquids, LQ7: a road's paving isn't claimed on a wet column — a ford's bed stays bare under the water; a
 *  deck over water is) */
@compute @workgroup_size(8, 8)
fn claimRoads(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let N = u32(W() * H());
  w7[i * 4u] = bitcast<u32>(x);
  w7[i * 4u + 1u] = bitcast<u32>(y);
  w7[i * 4u + 2u] = i;
  let m = b1[i];
  let so = N * 4u + i * 4u;
  w7[so + 3u] = 0u;
  // (a deck is claimed into the columns, a slab under its top: the river runs in the gap under it — trackA-liquids, CG15;
  // a road's paving isn't claimed on a wet column: a ford's bed stays bare under the water — LQ7)
  if (m == 0u) { w7[i * 4u + 3u] = 0u; return; }
  if ((m & DECK_BIT) == 0u && r2(i) > 0.5) { w7[i * 4u + 3u] = 0u; return; }
  w7[i * 4u + 3u] = 1u;
  if ((m & DECK_BIT) != 0u) {
    let dz = f32(m & ~DECK_BIT) / 256.0;
    set7(so, dz - DECK_CLAIM_T);
    set7(so + 1u, dz);
    w7[so + 2u] = M_WOOD;
  } else {
    let z = r3(i);
    set7(so, z);
    set7(so + 1u, z + PAVE_T);
    w7[so + 2u] = M_RUBBLE;
  }
  w7[so + 3u] = 0u;
}
/** one thread a lot record: a building's (or a big landmark's) footprint columns claimed base to height × progress,
 *  over any road there (b1 the records, r2 the progress, b4 the counts — CNT; w7 CG) */
@compute @workgroup_size(64)
fn claimLots(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  var r = i;
  if (i >= u.m.x) {
    // (the landmark sites' records after the lots')
    r = REC_LM + (i - u.m.x);
    if (r >= REC_LM + LM_ROOM) { return; }
  } else if (i >= min(b4[0], u.m.x)) { return; }
  let o = r * RECW;
  let kind = b1[o + 17u];
  let h = r1(o + 20u) * clamp(r2(r), 0.0, 1.0);
  let built = (kind == REC_BUILDING || kind == REC_LANDMARK) && h >= 0.05;
  if (kind == REC_FIELD) {
    claimField(r, o);
    return;
  }
  if (!built && kind != REC_PLAZA) { return; }
  var q: array<vec2<f32>, 4>;
  var pq: array<vec2<f32>, 4>;
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  for (var k = 0u; k < 4u; k++) {
    q[k] = vec2<f32>(r1(o + 8u + k * 2u), r1(o + 9u + k * 2u));
    pq[k] = vec2<f32>(r1(o + k * 2u), r1(o + 1u + k * 2u));
    lo = min(lo, pq[k]);
    hi = max(hi, pq[k]);
  }
  let base = r1(o + 21u);
  let N = u32(W() * H());
  let y0 = max(i32(floor(lo.y / ROW_H)) - 1, 0);
  let y1 = min(i32(ceil(hi.y / ROW_H)) + 1, H() - 1);
  let x0 = max(i32(floor(lo.x)) - 1, 0);
  let x1 = min(i32(ceil(hi.x)) + 1, W() - 1);
  for (var y = y0; y <= y1; y++) {
    for (var x = x0; x <= x1; x++) {
      let p = cpos(x, y);
      var inside = true;
      var inParcel = true;
      for (var k = 0u; k < 4u; k++) {
        if (cross2(q[(k + 1u) % 4u] - q[k], p - q[k]) < 0.0) { inside = false; }
        if (cross2(pq[(k + 1u) % 4u] - pq[k], p - pq[k]) < 0.0) { inParcel = false; }
      }
      let c = ix(x, y);
      let so = N * 4u + c * 4u;
      // (the parcel round it bare of plants, its spans the roads' where they lie)
      if (!(inside && built)) {
        if (inParcel && w7[c * 4u + 3u] == 0u) { w7[so + 3u] = BARE_ONLY; }
        continue;
      }
      w7[c * 4u + 3u] = 1u;
      set7(so, base);
      set7(so + 1u, base + h);
      w7[so + 2u] = M_RUBBLE;
      w7[so + 3u] = r + 1u;
    }
  }
}
/** one thread a lot record: cut off from the town's reach — the column across its frontage (its street) a surface the
 *  reach didn't join (fortreach.wgsl reachMark: 2) — into REACH (w5). The reach's box is the window: the grid's column
 *  (x, y) at window column (x + o.x, y + o.y) (i32 bits), the window n.z × n.w (b1 the records, b2 the counts, b3 the
 *  reach's marks) */
@compute @workgroup_size(64)
fn lotReach(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= u.m.x) { return; }
  w5[i] = 0u;
  if (i >= min(b2[0], u.m.x)) { return; }
  let o = i * RECW;
  if (b1[o + 17u] != REC_BUILDING) { return; }
  let f = b1[o + 16u];
  if (f == 255u) { return; }
  let a = vec2<f32>(r1(o + f * 2u), r1(o + f * 2u + 1u));
  let k = (f + 1u) % 4u;
  let b = vec2<f32>(r1(o + k * 2u), r1(o + k * 2u + 1u));
  // (its street: six points across its frontage — a quarter, half and three quarters along, one and two units out
  // (counter-clockwise: out is right of a → b). Joined if any is; cut off if none is and one is ground the reach saw —
  // a point on a neighbour's roof, or past the window, says nothing)
  let out = normalize(vec2<f32>(b.y - a.y, a.x - b.x));
  var seen = false;
  for (var j = 0u; j < 6u; j++) {
    let p = mix(a, b, 0.25 * f32(1u + j % 3u)) + out * (1.0 + f32(j / 3u));
    let c = cat(p) + vec2<i32>(bitcast<i32>(u.o.x), bitcast<i32>(u.o.y));
    if (c.x < 0 || c.y < 0 || u32(c.x) >= u.n.z || u32(c.y) >= u.n.w) { continue; }
    let m = b3[u32(c.y) * u.n.z + u32(c.x)];
    if (m == 1u) { return; }
    if (m == 2u) { seen = true; }
  }
  if (seen) { w5[i] = 1u; }
}

// ==== the time-lapse: a clock per district, each lot's progress from it, the buildings risen each frame ===========
// The user: "see districts fill out in time lapse and buildings rise up". A district's start (SCT word 8; −1e30 built,
// 1e30 not started) is set on the GPU — at load (clkInit: all built, or only the core), a time-lapse's (clkTimelapse:
// each district at T0 + its growth key × the spread, the centre first), an opportunity's claim (clkClaim: the best
// unbuilt district for a purpose, started now). From it each lot's progress (tlProgress) = clamp((now − start −
// its own delay) / the build time); tlRise moves the tagged vertices: a building's tops to base + height × progress,
// a road or a park, a plaza hidden till its district starts. The CPU passes only the clock and which start.
const BUILT_AT: f32 = -1e30;
const NOT_YET: f32 = 1e30;
/** the core built at the start (clkInit mode 1): districts this near the centre (their growth key) */
const CORE_KEY: f32 = 0.35;
/** one workgroup: every district's start — mode (n.w) 0 all built, 1 the core built, the rest not yet (w5 SCT) */
@compute @workgroup_size(256)
fn clkInit(@builtin(local_invocation_index) li: u32) {
  let n = min(w5[0] * w5[1], SC_MAX);
  for (var c = li; c < n; c += 256u) {
    let o = SC_HEAD + c * SCW;
    let core = w5[o + 2u] == 2u && bitcast<f32>(w5[o + 3u]) < CORE_KEY;
    set5(o + 8u, select(NOT_YET, BUILT_AT, u.n.w == 0u || core));
  }
}
/** one workgroup: a time-lapse — every district not started (and not an empty one) starts at T0 + its growth key × the
 *  spread (tl.z, tl.w) (w5 SCT) */
@compute @workgroup_size(256)
fn clkTimelapse(@builtin(local_invocation_index) li: u32) {
  let n = min(w5[0] * w5[1], SC_MAX);
  for (var c = li; c < n; c += 256u) {
    let o = SC_HEAD + c * SCW;
    if (w5[o + 2u] != 2u || bitcast<f32>(w5[o + 8u]) < 1e29) { continue; }
    set5(o + 8u, u.tl.z + clamp(bitcast<f32>(w5[o + 3u]), 0.0, 1.0) * u.tl.w);
  }
}
var<workgroup> ckS: array<f32, 256>;
var<workgroup> ckI: array<u32, 256>;
var<workgroup> ckN: array<u32, 256>;
/** (season loop) clkClaim's purpose that claims nothing: only the districts left counted */
const CLAIM_COUNT: u32 = 0xffffffffu;
/** one workgroup: an opportunity's claim — the best district not started for purpose n.w (its purpose that one: 2,
 *  plus its density, less half its growth key: dense and central first), started now (tl.x); its id + 1 (0 none) to
 *  w7[0] — the word read back (w5 SCT, w7 the answer) */
@compute @workgroup_size(256)
fn clkClaim(@builtin(local_invocation_index) li: u32) {
  let n = min(w5[0] * w5[1], SC_MAX);
  var best = -1e9;
  var bi = NONE;
  var left = 0u;
  for (var c = li; c < n; c += 256u) {
    let o = SC_HEAD + c * SCW;
    if (w5[o + 2u] != 2u || bitcast<f32>(w5[o + 8u]) < 1e29) { continue; }
    left++;
    let sc = select(0.0, 2.0, w5[o + 6u] == u.n.w) + bitcast<f32>(w5[o + 7u]) - 0.5 * bitcast<f32>(w5[o + 3u]);
    if (sc > best) { best = sc; bi = c; }
  }
  ckS[li] = best;
  ckI[li] = bi;
  ckN[li] = left;
  workgroupBarrier();
  if (li != 0u) { return; }
  var b = 0u;
  var total = 0u;
  for (var k = 0u; k < 256u; k++) {
    total += ckN[k];
    if (ckS[k] > ckS[b] || (ckS[k] == ckS[b] && ckI[k] < ckI[b])) { b = k; }
  }
  // (season loop: the answer's four words — the id + 1 (0 none), its centre x, y (the grid's frame), the districts
  // not begun after it)
  if (ckI[b] == NONE || u.n.w == CLAIM_COUNT) { w7[0] = 0u; w7[1] = 0u; w7[2] = 0u; w7[3] = total; return; }
  let o = SC_HEAD + ckI[b] * SCW;
  set5(o + 8u, u.tl.x);
  w7[0] = ckI[b] + 1u;
  w7[1] = w5[o + 4u];
  w7[2] = w5[o + 5u];
  w7[3] = total - 1u;
}
/** (season loop, docs/design/SEASON_LOOP.md) a district's build is all its lots up after 1.75 build times (the last
 *  lot's delay, ¾, plus its own build) */
const BUILD_SPAN: f32 = 1.75;
/** (season loop) how far behind the first a share's last lot starts rising (a share of the card's build) */
const STAGGER: f32 = 0.5;
/** one thread a record: its progress now (b1 the records, r2 the district stages — STG: on, from, to, when a
 *  district; b4 SCT, w6 the counts; w5 PROG). A staged district (the season loop's) is built as far as its stage:
 *  its build time eased from `from` × the span to `to` × the span over a span of the clock from `when`; the rest run
 *  on their start alone. (CG25) Its start too — the clock time its progress first passes 0, BUILT_AT a lot there from
 *  the outset, NOT_YET none set — to w7 (LSTART: frontStamp stamps it round the parcel for its streets). */
@compute @workgroup_size(64)
fn tlProgress(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= REC_LM + LM_ROOM) { return; }
  if (i < REC_LM && i >= min(atomicLoad(&w6[0]), REC_LM)) { return; }
  let o = i * RECW;
  if (b1[o + 17u] == REC_NONE) { set5(i, 0.0); set7(i, NOT_YET); return; }
  var start = BUILT_AT;
  let did = b1[o + 18u] & 0xffffffu;
  if (u.h2.z > 0.5) { start = r4(SC_HEAD + did * SCW + 8u); }
  // (each lot its own delay in its district: up to three quarters of the build time)
  let delay = hsh(b1[o + 23u] ^ 0x51edu) * 0.75 * u.tl.y;
  let sg = did * 16u;
  if (u.h2.z > 0.5 && did < SC_MAX && r2(sg) > 0.5) {
    // (staged, cards' shares [a, b] of the district — two slots: its lots in growth order from the district's centre,
    // a lot's key its rank in that order over the district's lots (stgRank), so a share of the key is that share of
    // the lots. A lot in a slot's share rises as that slot's stage S (eased from `from` to `to` over a span of the clock)
    // crosses the share, each a little after the last by its key (STAGGER), so all are up exactly when S reaches b —
    // the card's end; any other lot stands before `end` (earlier cards', done) and isn't begun after it)
    // (its key: its rank in its district's growth order, 0..1 — stgRank)
    let key = bitcast<f32>(b3[i]);
    let span = BUILD_SPAN * max(u.tl.y, 1e-3);
    for (var sl = 0u; sl < 2u; sl++) {
      let q = sg + 2u + sl * 5u;
      let a = r2(q);
      let b = r2(q + 1u);
      // (a slot never used: its share empty; the last share's far edge takes the lots keyed past 1)
      if (b <= a || key < a || (key > b && b < 1.0)) { continue; }
      let k = clamp((u.tl.x - r2(q + 4u)) / span, 0.0, 1.0);
      let S = mix(r2(q + 2u), r2(q + 3u), k * k * (3.0 - 2.0 * k));
      let f = (S - a) / max(b - a, 1e-4);
      let w = clamp((key - a) / max(b - a, 1e-4), 0.0, 1.0);
      set5(i, clamp(f * (1.0 + STAGGER) - STAGGER * w, 0.0, 1.0));
      // (CG25: its start — when S passes the stage it begins at, the ease inverted: k = ½ − sin(asin(1 − 2y) / 3))
      let sx = a + (b - a) * STAGGER * w / (1.0 + STAGGER);
      let s0 = r2(q + 2u);
      let s1 = r2(q + 3u);
      let when = r2(q + 4u);
      var st = NOT_YET;
      if (s0 >= sx) { st = when - span; }
      else if (s1 > sx) {
        let y = clamp((sx - s0) / (s1 - s0), 0.0, 1.0);
        st = when + span * (0.5 - sin(asin(1.0 - 2.0 * y) / 3.0));
      }
      set7(i, st);
      return;
    }
    set5(i, select(0.0, 1.0, key < r2(sg + 1u)));
    set7(i, select(NOT_YET, BUILT_AT, key < r2(sg + 1u)));
    return;
  }
  set5(i, clamp((u.tl.x - start - delay) / max(u.tl.y, 1e-3), 0.0, 1.0));
  // (CG25: its start — the clock time its progress first passes 0; NOT_YET while its district's isn't set)
  set7(i, select(start + delay, NOT_YET, start >= 1e29));
}
/** (season loop) each record's key in its district's growth order: its rank by distance from the district's centre
 *  (ties by index) over the district's records, (rank + ½) / n — so a card's share [a, b] of the district is that
 *  share of its lots (b1 the records, b4 SCT, w6 the counts; w5 the keys). One thread a record, every record of the
 *  town looked at: n² over a few hundred lots, once a mesh run. */
fn lotCentre(o: u32) -> vec2<f32> {
  var c = vec2<f32>(0.0);
  for (var q = 0u; q < 4u; q++) { c += vec2<f32>(r1(o + 8u + q * 2u), r1(o + 9u + q * 2u)); }
  return c * 0.25;
}
@compute @workgroup_size(64)
fn stgRank(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let n = min(atomicLoad(&w6[0]), REC_LM);
  if (i >= n) { return; }
  let o = i * RECW;
  if (b1[o + 17u] == REC_NONE) { w5[i] = 0u; return; }
  let did = b1[o + 18u] & 0xffffffu;
  let sco = SC_HEAD + did * SCW;
  let cen = vec2<f32>(r4(sco + 4u), r4(sco + 5u));
  let di = length(lotCentre(o) - cen);
  var rank = 0u;
  var cnt = 0u;
  for (var j = 0u; j < n; j++) {
    let oj = j * RECW;
    if (b1[oj + 17u] == REC_NONE || (b1[oj + 18u] & 0xffffffu) != did) { continue; }
    cnt++;
    let dj = length(lotCentre(oj) - cen);
    if (dj < di || (dj == di && j < i)) { rank++; }
  }
  w5[i] = bitcast<u32>((f32(rank) + 0.5) / f32(max(cnt, 1u)));
}
/** (season loop, "the shader for now") a building going up: its tops plank and its roof a scaffold deck, its foot
 *  dark stone — its own colours back once it's up (a roof's from its seed, as lotMesh drew it) */
const C_PLANK: u32 = 0xb48853u;
const C_SCAFFOLD: u32 = 0xc9a46au;
const C_FOOT: u32 = 0x8c857bu;
fn riseColour(v: u32, id: u32, top: bool) -> u32 {
  let p = r2(id);
  let up = bitcast<f32>(w7[v * 8u + 6u]) > 0.5;
  if (p > 0.0 && p < 1.0) {
    if (!top) { return C_FOOT; }
    return select(C_PLANK, C_SCAFFOLD, up);
  }
  if (top && up) { return roofColour(u32(hsh(b1[id * RECW + 23u] * 7u + 3u) * 5.999)); }
  return C_WALL;
}
/** one thread a vertex: the tagged ones moved by their lot's progress or their district's start (b1 the records, r2
 *  PROG, b3 VTAG, b4 SCT; w7 the mesh; args its count) */
@compute @workgroup_size(64)
fn tlRise(@builtin(global_invocation_id) g: vec3<u32>) {
  let v = g.x;
  if (v >= min(atomicLoad(&args[0]), u.m.y)) { return; }
  let tag = b3[v * 2u];
  let kind = tag & 7u;
  if (kind == TG_STATIC) { return; }
  let id = (tag >> 8u) - 1u;
  let z0 = bitcast<f32>(b3[v * 2u + 1u]);
  var z = z0;
  if (kind == TG_TOP) {
    let o = id * RECW;
    z = r1(o + 21u) + r1(o + 20u) * r2(id) + select(0.0, 0.06, (tag & OUTLINE_BIT) != 0u);
    // (a lot not begun: its roof and outline sunk out of sight — its walls' bases with them: TG_BASE)
    if (r2(id) <= 0.0) { z = z0 - 1000.0; }
    if ((tag & OUTLINE_BIT) == 0u) { w7[v * 8u + 3u] = riseColour(v, id, true); }
  } else if (kind == TG_BASE) {
    if (r2(id) <= 0.0) { z = z0 - 1000.0; }
    w7[v * 8u + 3u] = riseColour(v, id, false);
  } else if (kind == TG_ROAD) {
    // (CG25: the tag's high bits its piece's reveal code — sunk till its growth begins, so it casts no shadow; the
    // fragments ahead of the growth are clipped by the draw — render/bodies.wgsl fsBody)
    if (revTime(tag >> 8u) > u.tl.x) { z = z0 - 1000.0; }
  } else if (kind == TG_LOT) {
    if (r2(id) <= 0.0) { z = z0 - 1000.0; }
  } else if (kind == TG_WALL) {
    // (season life: a wall piece or a tower — id: its segment, 128 a tower, 256 a foot — risen by its segment's rise;
    // w6 the WALL words)
    let seg = id & 127u;
    // (a bastion — a tower inside a run, its top the walk's deck — rises as the wall does)
    let h = select(WALL_H, TOWER_H, (id & 128u) != 0u && (id & ID_BASTION) == 0u);
    let rw = wallRise(seg, atomicLoad(&w6[2]), bitcast<f32>(atomicLoad(&w6[4])), bitcast<f32>(atomicLoad(&w6[5])), bitcast<f32>(atomicLoad(&w6[6])));
    // (U2-WALLSTAIR: a stair's step — ID_STAIR, its tops heights, not heights over the ground — shown once its piece has
    // risen, as wallClaim claims it)
    let stair = (id & ID_STAIR) != 0u;
    if (rw <= 0.0 || atomicLoad(&w6[0]) != 1u || (stair && rw < 1.0)) { z = z0 - 1000.0; }
    else if ((id & 256u) == 0u && !stair) { z = z0 - h + h * rw; }
  }
  w7[v * 8u + 2u] = bitcast<u32>(z);
}

// ==== farms: a field's hedges and its farmhouse ================================================================
/** (farms) a field's mesh (lotMesh's REC_FIELD): a low hedge along each edge — shown once its district starts
 *  (TG_LOT) — and, when its record has a height, a farmhouse at its first corner: walls and a roof risen with the
 *  field's progress (TG_TOP / TG_BASE, as a building's). The crops are the vegetation field's (bare.wgsl). */
fn fieldMesh(i: u32, o: u32, q: array<vec2<f32>, 4>) {
  let at = room(72u);
  if (at == NONE) { return; }
  curTag = TG_LOT | ((i + 1u) << 8u);
  for (var k = 0u; k < 4u; k++) {
    let a = q[k];
    let b = q[(k + 1u) % 4u];
    if (distance(a, b) < 0.5) {
      // (a degenerate edge: its room filled with nothing visible — the three faces flat at the corner)
      for (var j = 0u; j < 18u; j++) { vert(at + k * 18u + j, vec3<f32>(a, hAt(a) - 1000.0), C_HEDGE, vec3<f32>(0.0, 0.0, 1.0)); }
      continue;
    }
    let d = normalize(b - a);
    let n = vec2<f32>(d.y, -d.x) * HEDGE_HW;
    let za = hAt(a);
    let zb = hAt(b);
    let a0 = vec3<f32>(a + n, za);
    let b0 = vec3<f32>(b + n, zb);
    let a1 = vec3<f32>(a + n, za + HEDGE_H);
    let b1 = vec3<f32>(b + n, zb + HEDGE_H);
    let a2 = vec3<f32>(a - n, za + HEDGE_H);
    let b2 = vec3<f32>(b - n, zb + HEDGE_H);
    let a3 = vec3<f32>(a - n, za);
    let b3 = vec3<f32>(b - n, zb);
    let base = at + k * 18u;
    tri(base, a1, b1, b2, C_HEDGE);
    tri(base + 3u, a1, b2, a2, C_HEDGE);
    tri(base + 6u, a0, b0, b1, C_HEDGE);
    tri(base + 9u, a0, b1, a1, C_HEDGE);
    tri(base + 12u, a3, a2, b2, C_HEDGE);
    tri(base + 15u, a3, b2, b3, C_HEDGE);
  }
  let h = r1(o + 20u);
  if (h < 0.05) { return; }
  let hq = farmhouse(q);
  let at2 = room(30u);
  if (at2 == NONE) { return; }
  let fb = r1(o + 21u);
  let top = fb + h;
  let roof = roofColour(u32(hsh(b1[o + 23u] * 7u + 3u) * 5.999));
  curTag = TG_TOP | ((i + 1u) << 8u);
  tri(at2, vec3<f32>(hq[0], top), vec3<f32>(hq[1], top), vec3<f32>(hq[2], top), roof);
  tri(at2 + 3u, vec3<f32>(hq[0], top), vec3<f32>(hq[2], top), vec3<f32>(hq[3], top), roof);
  for (var k = 0u; k < 4u; k++) {
    let a = hq[k];
    let b = hq[(k + 1u) % 4u];
    tri(at2 + 6u + k * 6u, vec3<f32>(a, fb), vec3<f32>(b, top), vec3<f32>(a, top), C_WALL);
    tri(at2 + 9u + k * 6u, vec3<f32>(a, fb), vec3<f32>(b, fb), vec3<f32>(b, top), C_WALL);
    let tb = TG_BASE | ((i + 1u) << 8u);
    w5[(at2 + 6u + k * 6u) * 2u] = tb;
    w5[(at2 + 9u + k * 6u) * 2u] = tb;
    w5[(at2 + 10u + k * 6u) * 2u] = tb;
  }
}

// ==== season life: the town wall — a ring round the town as it stands, gates at the arterials, rising in stages ====
// (docs/design/SEASON_LOOP.md "Season life" 2) WALL (words): 0 made (1), 1 its gates, 2 the first gate's segment (the
// rising starts there), 3 unused; 4–6 the card's stage: from, to, when (f32: 0..1 of the ring, the town's clock);
// 8 + b the built lots' furthest reach in direction b (u32, 1/16 unit: an atomic max); 8 + NB + 2b the ring's corner b
// (x, y: the grid's world units); 8 + 3·NB + b segment b (corner b → b + 1) a gate (1). Made once, when the walls card
// starts (wallBins, wallShape); drawn in each mesh run at full height (wallMesh: TG_WALL vertices — tlRise sets each
// piece's height by its segment's rise); claimed after the lots (wallClaim: its columns' spans, the road raster marked
// WALL_MARK where it stands, so the living town's routes go out through the gates).
const NB: u32 = 72u;
const WB_REACH: u32 = 8u;
const WB_V: u32 = 80u;
const WB_GATE: u32 = 224u;
/** (season life, U2's posts) each corner's ground (world z: hAt), and each segment's piece: 0 a wall, 1 a gate, 2 over
 *  water or a cliff (none) — the CPU's posts read them from the saved words */
const WB_Z: u32 = 296u;
const WB_KIND: u32 = 368u;
/** (season life, SL18) a gate segment's arterial (its index + 1; 0 none) and where along it the ring crosses (f32, world
 *  units from its centre end) — the march out follows that arterial, not the nearest road's end */
const WB_ART: u32 = 440u;
const WB_S: u32 = 512u;
/** a stair up to the wall-walk beside each gate: this many steps, a step this long, set in from the wall */
const STAIR_STEPS: u32 = 6u;
const STAIR_RUN: f32 = 1.1;
const STAIR_HW: f32 = 0.55;
const WALL_H: f32 = 4.5;
const TOWER_H: f32 = 8.0;
const WALL_HW: f32 = 1.0;
const TOWER_HW: f32 = 2.0;
/** past the built lots' furthest reach in a direction (world units) */
const WALL_MARGIN: f32 = 7.0;
/** a wall piece rises over this share of the card's build, each piece after the one before round the ring */
const WALL_BAND: f32 = 0.12;
const C_WALLSTONE: u32 = 0xa8977du;
const C_TOWER: u32 = 0x8f806bu;
const TG_WALL: u32 = 5u;
/** (season life) a wall's column in the road raster: not a road — the living town's routes go round it (routes.wgsl
 *  walkInit: blocked) */
const WALL_MARK: u32 = 0x40000000u;
fn binOf(d: vec2<f32>) -> u32 { return min(u32(floor((atan2(d.y, d.x) + 3.14159265) / TAU * f32(NB))), NB - 1u); }
fn binDir(b: u32) -> vec2<f32> { let a = (f32(b) + 0.5) / f32(NB) * TAU - 3.14159265; return vec2<f32>(cos(a), sin(a)); }
/** a segment's rise (0..1) at the stage (from, to, when) and its place round the ring from the first gate */
fn wallRise(seg: u32, gate0: u32, s0: f32, s1: f32, when: f32) -> f32 {
  let span = 1.75 * max(u.tl.y, 1e-3);
  let k = clamp((u.tl.x - when) / span, 0.0, 1.0);
  let S = mix(s0, s1, k * k * (3.0 - 2.0 * k));
  let w = f32((seg + NB - gate0) % NB) / f32(NB);
  return clamp((S - w * (1.0 - WALL_BAND)) / WALL_BAND, 0.0, 1.0);
}
/** one thread a lot record: begun (progress over 0) — its parcel's far corner from the centre, in its direction (b1
 *  the records, b2 the progress, b3 the lot counts; w6 WALL) */
@compute @workgroup_size(64)
fn wallBins(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= min(b3[0], REC_LM)) { return; }
  let o = i * RECW;
  let kind = b1[o + 17u];
  if (kind == REC_NONE || r2(i) <= 0.0) { return; }
  var far = 0.0;
  var c = vec2<f32>(0.0);
  for (var k = 0u; k < 4u; k++) {
    let p = vec2<f32>(r1(o + k * 2u), r1(o + 1u + k * 2u));
    c += 0.25 * p;
    far = max(far, distance(p, u.d.xy));
  }
  atomicMax(&w6[WB_REACH + binOf(c - u.d.xy)], u32(far * 16.0));
}
var<workgroup> wbR: array<f32, 72>;
var<workgroup> wbG: array<u32, 72>;
fn segsHit(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>, d: vec2<f32>) -> bool {
  let r = b - a;
  let s = d - c;
  let den = cross2(r, s);
  if (abs(den) < 1e-6) { return false; }
  let t = cross2(c - a, s) / den;
  let v = cross2(c - a, r) / den;
  return t >= 0.0 && t <= 1.0 && v >= 0.0 && v <= 1.0;
}
/** one workgroup: the ring — each direction's reach widened over ±3 directions (never through a plot) plus the
 *  margin, the town's core where nothing's built — its corners, its gates where an arterial crosses (at least two:
 *  DESIGN §13), the first gate (w5 WALL, b1 ART) */
@compute @workgroup_size(128)
fn wallShape(@builtin(local_invocation_index) li: u32) {
  if (li < NB) { wbR[li] = f32(w5[WB_REACH + li]) / 16.0; }
  workgroupBarrier();
  var r = 0.0;
  if (li < NB) {
    for (var j = 0u; j < 7u; j++) { r = max(r, wbR[(li + NB + j - 3u) % NB]); }
  }
  workgroupBarrier();
  if (li < NB) {
    if (r <= 0.0) { r = u.d.z * 0.35; }
    wbR[li] = r + WALL_MARGIN;
    var v = u.d.xy + binDir(li) * wbR[li];
    v = clamp(v, vec2<f32>(1.0), vec2<f32>(f32(W()) - 1.0, f32(H()) * ROW_H - 1.0));
    w5[WB_V + 2u * li] = bitcast<u32>(v.x);
    w5[WB_V + 2u * li + 1u] = bitcast<u32>(v.y);
  }
  workgroupBarrier();
  if (li < NB) {
    let p = vec2<f32>(bitcast<f32>(w5[WB_V + 2u * li]), bitcast<f32>(w5[WB_V + 2u * li + 1u]));
    let q = vec2<f32>(bitcast<f32>(w5[WB_V + 2u * ((li + 1u) % NB)]), bitcast<f32>(w5[WB_V + 2u * ((li + 1u) % NB) + 1u]));
    var gate = 0u;
    var art = 0u;
    var along = 0.0;
    // (the atlas roads only: the town's own bridges after them are inside it)
    for (var k = 0u; k < artCountCpu(1u); k++) {
      let n = artPts(1u, k);
      var acc = 0.0;
      for (var j = 0u; j + 1u < n; j++) {
        let a = artPt(1u, k, j);
        let b = artPt(1u, k, j + 1u);
        if (gate == 0u && segsHit(p, q, a, b)) {
          gate = 1u;
          art = k + 1u;
          // (where along it: the crossing's parameter on the arterial's piece)
          let r = b - a;
          let sq = q - p;
          let den = cross2(r, sq);
          let t = select(0.5, clamp(cross2(p - a, sq) / den, 0.0, 1.0), abs(den) > 1e-6);
          along = acc + t * distance(a, b);
        }
        acc += distance(a, b);
      }
    }
    wbG[li] = gate;
    w5[WB_ART + li] = art;
    w5[WB_S + li] = bitcast<u32>(along);
  }
  workgroupBarrier();
  if (li == 0u) {
    var n = 0u;
    var first = NONE;
    for (var b = 0u; b < NB; b++) { if (wbG[b] == 1u) { n++; if (first == NONE) { first = b; } } }
    // (fewer than two: the first, or the ring's start, and the segment across from it)
    if (n < 2u) {
      if (first == NONE) { first = 0u; wbG[0] = 1u; }
      wbG[(first + NB / 2u) % NB] = 1u;
      n = 2u;
    }
    w5[1] = n;
    w5[2] = first;
  }
  workgroupBarrier();
  if (li < NB) {
    w5[WB_GATE + li] = wbG[li];
    let p = vec2<f32>(bitcast<f32>(w5[WB_V + 2u * li]), bitcast<f32>(w5[WB_V + 2u * li + 1u]));
    let q = vec2<f32>(bitcast<f32>(w5[WB_V + 2u * ((li + 1u) % NB)]), bitcast<f32>(w5[WB_V + 2u * ((li + 1u) % NB) + 1u]));
    w5[WB_Z + li] = bitcast<u32>(hAt(p));
    var wet = false;
    for (var k = 0u; k <= 4u; k++) { if (blockedAt(mix(p, q, f32(k) / 4.0))) { wet = true; } }
    w5[WB_KIND + li] = select(select(0u, 2u, wet), 1u, wbG[li] == 1u);
  }
  if (li == 0u) { w5[0] = 1u; }
}
fn wbV(b: u32) -> vec2<f32> { let o = WB_V + 2u * (b % NB); return vec2<f32>(r1(o), r1(o + 1u)); }
fn wbGate(b: u32) -> bool { return b1[WB_GATE + (b % NB)] == 1u; }
fn wbTower(b: u32) -> bool { return (b % 6u == 0u || wbGate(b) || wbGate(b + NB - 1u)) && !blockedAt(wbV(b)); }
/** a segment over water or a cliff (b4 the distance field: negative there): no wall piece */
fn wbWet(b: u32) -> bool {
  let p = wbV(b);
  let q = wbV(b + 1u);
  for (var k = 0u; k <= 4u; k++) { if (blockedAt(mix(p, q, f32(k) / 4.0))) { return true; } }
  return false;
}
/** a quad from p (its foot at zp, top tp) to q (zq, tq), outward right of p → q; its foot's vertices tagged `tb` */
fn wquad(at: u32, p: vec2<f32>, q: vec2<f32>, zp: f32, zq: f32, tp: f32, tq: f32, col: u32, tb: u32) {
  tri(at, vec3<f32>(p, zp), vec3<f32>(q, zq), vec3<f32>(q, tq), col);
  tri(at + 3u, vec3<f32>(p, zp), vec3<f32>(q, tq), vec3<f32>(p, tp), col);
  w5[at * 2u] = tb;
  w5[(at + 1u) * 2u] = tb;
  w5[(at + 3u) * 2u] = tb;
}
/** a box from a to b, half width hw, its foot at za / zb and its top at ta / tb (world z, linear between the ends): its
 *  top and two long sides; `caps` its ends too (18 or 30 vertices) */
fn wboxZ(at: u32, a: vec2<f32>, b: vec2<f32>, hw: f32, za: f32, zb: f32, ta: f32, tb: f32, col: u32, tt: u32, tf: u32, caps: bool) {
  let d = normalize(b - a);
  let n = vec2<f32>(d.y, -d.x) * hw;
  curTag = tt;
  tri(at, vec3<f32>(a + n, ta), vec3<f32>(b + n, tb), vec3<f32>(b - n, tb), col);
  tri(at + 3u, vec3<f32>(a + n, ta), vec3<f32>(b - n, tb), vec3<f32>(a - n, ta), col);
  wquad(at + 6u, a + n, b + n, za, zb, ta, tb, col, tf);
  wquad(at + 12u, b - n, a - n, zb, za, tb, ta, col, tf);
  if (caps) {
    wquad(at + 18u, a - n, a + n, za, za, ta, ta, col, tf);
    wquad(at + 24u, b + n, b - n, zb, zb, tb, tb, col, tf);
  }
}
/** a box from a to b, half width hw, h high over the ground at its ends (sunk 0.4) */
fn wbox(at: u32, a: vec2<f32>, b: vec2<f32>, hw: f32, h: f32, col: u32, tt: u32, tb: u32, caps: bool) {
  let za = hAt(a) - 0.4;
  let zb = hAt(b) - 0.4;
  wboxZ(at, a, b, hw, za, zb, za + h, zb + h, col, tt, tb, caps);
}
// ---- (U2-WALLSTAIR) the wall-walk's heights: one rule for the mesh, the claim and the living town's walk points ----
// The walk's deck runs straight between the ring's corners at WALL_H over each corner's ground (WB_Z, less the 0.4 the
// wall is sunk): the drawn wall's top, and now its claimed columns' too (they followed each column's own ground). A
// stair climbs from the ground at its foot to the deck where it meets the walk (STAIR_REACH along the run from the
// gap's corner) in STAIR_STEPS + 1 equal rises: its steps' tops are heights, not heights over their own ground, so on a
// slope it still lands on the walk. A tower at a corner inside a run (every sixth) is a bastion: its top is the deck,
// so the walk crosses it; only the towers beside a gap (gates, water) stand TOWER_H. routes.wgsl (wwStair, wlRunDeck)
// repeats these: keep them in step.
/** a corner's ground (world z: hAt at the corner, wallShape's) */
fn wbZ(b: u32) -> f32 { return r1(WB_Z + (b % NB)); }
/** where a stair's first step starts along the run from the gap's corner; the reach to its top step's far end */
const STAIR_START: f32 = 2.6;
const STAIR_REACH: f32 = 9.2;
/** a stair's foot: beside its first step on the town's side (the gap's tower stands where the stair's line meets the
 *  corner), this far out from the wall's line */
const STAIR_FOOT_OUT: f32 = 3.15;
/** a tower at a corner inside a run of wall (the walk crosses it at the deck's height) */
fn wbBastion(b: u32) -> bool { return wbTower(b) && !wbGap(b) && !wbGap(b + NB - 1u); }
/** the deck's height s metres along the run from the gap's corner of piece b (e: stairStep's end), clamped at the run's
 *  far end */
fn runDeck(b: u32, e: u32, s: f32) -> f32 {
  var c = select(b + 1u, b, e == 1u) % NB;
  var acc = 0.0;
  for (var j = 0u; j < NB; j++) {
    let piece = select(c + NB - 1u, c, e == 1u) % NB;
    let nc = select(c + NB - 1u, c + 1u, e == 1u) % NB;
    if (wbGap(piece)) { break; }
    let l = distance(wbV(c), wbV(nc));
    if (acc + l >= s) { return mix(wbZ(c), wbZ(nc), clamp((s - acc) / max(l, 1e-4), 0.0, 1.0)) - 0.4 + WALL_H; }
    acc += l;
    c = nc;
  }
  return wbZ(c) - 0.4 + WALL_H;
}
/** the wall's foot line s metres along the ring from corner b (s > 0 into piece b, s < 0 back into piece b − 1) */
fn ringFoot(b: u32, s: f32) -> f32 {
  let o = select(b + NB - 1u, b + 1u, s >= 0.0);
  let l = max(distance(wbV(b), wbV(o)), 1e-3);
  return mix(wbZ(b), wbZ(o), clamp(abs(s) / l, 0.0, 1.0)) - 0.4;
}
/** the point s metres along the run from the gap's corner of piece b (e: stairStep's end), on the ring's corners — not
 *  a straight line off the first piece: Muru's ring zigzags (a 10 m piece, then back), and a stair or the walk's first
 *  point straight on from the corner stood off the wall — and the run's way there (x, y, then the direction); past the
 *  run's far end straight on */
fn runPos(b: u32, e: u32, s: f32) -> vec4<f32> {
  var c = select(b + 1u, b, e == 1u) % NB;
  var acc = 0.0;
  var last = vec4<f32>(wbV(c), 1.0, 0.0);
  for (var j = 0u; j < NB; j++) {
    let piece = select(c + NB - 1u, c, e == 1u) % NB;
    let nc = select(c + NB - 1u, c + 1u, e == 1u) % NB;
    if (wbGap(piece)) { break; }
    let l = max(distance(wbV(c), wbV(nc)), 1e-4);
    let d = (wbV(nc) - wbV(c)) / l;
    if (acc + l >= s) { return vec4<f32>(wbV(c) + d * (s - acc), d); }
    acc += l;
    c = nc;
    last = vec4<f32>(wbV(c), d);
  }
  return vec4<f32>(last.xy + last.zw * (s - acc), last.zw);
}
/** the run's side toward the town at a point of it (x, y, direction: runPos) */
fn townSide(r: vec4<f32>) -> vec2<f32> {
  let n = vec2<f32>(-r.w, r.z);
  return select(-n, n, dot(n, u.d.xy - r.xy) >= 0.0);
}
/** a stair at end e of piece b: its foot (x, y; z the ground there — the column's height, as the living town reads it):
 *  beside its first step on the town's side */
fn stairFoot(b: u32, e: u32) -> vec3<f32> {
  let r = runPos(b, e, STAIR_START + 0.5 * STAIR_RUN);
  let f = r.xy + townSide(r) * STAIR_FOOT_OUT;
  return vec3<f32>(f, r3(ixp(f)));
}
/** step k's top (world z): equal rises from the foot's ground to the deck at the stair's reach */
fn stairTop(b: u32, e: u32, k: u32) -> f32 {
  let z0 = stairFoot(b, e).z;
  return z0 + (runDeck(b, e, STAIR_REACH) - z0) * f32(k + 1u) / f32(STAIR_STEPS + 1u);
}
/** a tower's square's way at corner b: the ring's there (the next corner less the one before); beside a gap, its wall
 *  piece's — the stair starts STAIR_START along that piece from the corner, and a square turned to a long or slanted
 *  gate's line stood over its first steps (Bumku) */
fn towerDir(b: u32) -> vec2<f32> {
  var d = wbV(b + 1u) - wbV(b + NB - 1u);
  if (wbGap(b + NB - 1u) && !wbGap(b)) { d = wbV(b + 1u) - wbV(b); }
  if (wbGap(b) && !wbGap(b + NB - 1u)) { d = wbV(b) - wbV(b + NB - 1u); }
  if (length(d) < 1e-3) { return vec2<f32>(1.0, 0.0); }
  return normalize(d);
}
/** wall vertex ids (TG_WALL, after the segment): 128 a tower, 256 a foot, 512 a stair's step (k at bit 10), a bastion */
const ID_STAIR: u32 = 512u;
const ID_BASTION: u32 = 16384u;
/** one thread a ring segment (made): its wall piece (not at a gate) and its corner's tower, at full height — TG_WALL
 *  (tlRise: its rise) (b1 WALL, r3 the heights, b4 the distance field; w5 VTAG, w7 the mesh; args) */
@compute @workgroup_size(128)
fn wallMesh(@builtin(local_invocation_index) li: u32) {
  if (li >= NB || b1[0] != 1u) { return; }
  let p = wbV(li);
  let q = wbV(li + 1u);
  if (!wbGate(li) && !wbWet(li) && distance(p, q) > 0.2) {
    let at = room(18u);
    if (at == NONE) { return; }
    wbox(at, p, q, WALL_HW, WALL_H, C_WALLSTONE, TG_WALL | ((li + 1u) << 8u), TG_WALL | (((li | 256u) + 1u) << 8u), false);
  }
  // (SL19: a stair up to the wall-walk at each end of each run of wall — beside a gate, or where water or a cliff
  // breaks it — on the town's side, rising away from the gap: every post's walk reached from the town. U2-WALLSTAIR:
  // its steps' tops are heights (stairTop), each box's foot at the ground or under its top, whichever is lower; shown
  // once its piece has risen — tlRise)
  for (var e = 0u; e < 2u; e++) {
    if (!wbStair(li, e)) { continue; }
    let at = room(30u * STAIR_STEPS);
    if (at == NONE) { return; }
    for (var k = 0u; k < STAIR_STEPS; k++) {
      let sq = stairStep(li, k, e);
      let t = stairTop(li, e, k);
      let id = li | 128u | ID_STAIR | (k << 10u);
      wboxZ(at + 30u * k, sq[0], sq[1], STAIR_HW, min(hAt(sq[0]) - 0.4, t - 0.3), min(hAt(sq[1]) - 0.4, t - 0.3), t, t, C_WALLSTONE,
        TG_WALL | ((id + 1u) << 8u), TG_WALL | (((id | 256u) + 1u) << 8u), true);
    }
  }
  if (wbTower(li)) {
    let at = room(30u);
    if (at == NONE) { return; }
    // (the tower square on the ring's direction there — beside a gap, its wall piece's: towerDir)
    let e = towerDir(li) * TOWER_HW;
    if (wbBastion(li)) {
      // (U2-WALLSTAIR: inside a run, a bastion — the walk crosses it: its top the deck, its foot the wall's)
      let id = li | 128u | ID_BASTION;
      let fa = ringFoot(li, -TOWER_HW);
      let fb = ringFoot(li, TOWER_HW);
      wboxZ(at, p - e, p + e, TOWER_HW, fa, fb, fa + WALL_H, fb + WALL_H, C_TOWER, TG_WALL | ((id + 1u) << 8u), TG_WALL | (((id | 256u) + 1u) << 8u), true);
    } else {
      let id = li | 128u;
      wbox(at, p - e, p + e, TOWER_HW, TOWER_H, C_TOWER, TG_WALL | ((id + 1u) << 8u), TG_WALL | (((id | 256u) + 1u) << 8u), true);
    }
  }
}
/** one workgroup, a thread a ring segment: its wall piece's, then the towers', then the stairs' columns claimed at their
 *  risen height (spans: the mesh's tops — wallCols), the road raster marked WALL_MARK under them. In that order, a
 *  barrier between (a stair cuts into its wall's inner edge and a tower's corner, never the other way, whichever thread
 *  runs first) (b1 WALL, r3 the heights, b4 the distance field; w5 ROADS, w7 the claim grid) */
@compute @workgroup_size(128)
fn wallClaim(@builtin(local_invocation_index) li: u32) {
  let made = b1[0] == 1u;
  let s = min(li, NB - 1u);
  let on = made && li < NB;
  let r = select(0.0, wallRise(s, b1[2], r1(4u), r1(5u), r1(6u)), on);
  let p = wbV(s);
  let q = wbV(s + 1u);
  // (a piece is open over an arterial only beside a gate: elsewhere a road the ring runs over or along is walled — an
  // ungated hole let walkers round the wall: trackA-unitcontracts, the side map at Muru's river road)
  let byGate = wbGate(s + NB - 1u) || wbGate(s + 1u);
  // (the piece: its top the deck — straight between the corners, as drawn — at its rise)
  if (r > 0.02 && !wbGate(s) && !wbWet(s)) {
    wallCols(p, q, WALL_HW, wbZ(s) - 0.4 + WALL_H * r, wbZ(s + 1u) - 0.4 + WALL_H * r, byGate);
  }
  storageBarrier();
  workgroupBarrier();
  if (r > 0.02 && wbTower(s)) {
    let e = towerDir(s) * TOWER_HW;
    if (wbBastion(s)) {
      wallCols(p - e, p + e, TOWER_HW, ringFoot(s, -TOWER_HW) + WALL_H * r, ringFoot(s, TOWER_HW) + WALL_H * r, byGate);
    } else {
      wallCols(p - e, p + e, TOWER_HW, hAt(p - e) - 0.4 + TOWER_H * r, hAt(p + e) - 0.4 + TOWER_H * r, byGate || wbGate(s));
    }
  }
  storageBarrier();
  workgroupBarrier();
  // (the stairs once their piece has risen: each step's top a height)
  if (r >= 1.0) {
    for (var e = 0u; e < 2u; e++) {
      if (!wbStair(s, e)) { continue; }
      for (var k = 0u; k < STAIR_STEPS; k++) {
        let sq = stairStep(s, k, e);
        let t = stairTop(s, e, k);
        wallCols(sq[0], sq[1], STAIR_HW, t, t, true);
      }
    }
  }
}
/** a gap in the ring: a gate, or water or a cliff (no piece) */
fn wbGap(b: u32) -> bool { return wbGate(b) || wbWet(b); }
/** a stair at end `e` of wall piece `b` (0: its far end, the next segment a gap; 1: its near end, the one before a
 *  gap): its steps along the piece from that corner, on the town's side */
fn wbStair(b: u32, e: u32) -> bool { return !wbGap(b) && select(wbGap(b + 1u), wbGap(b + NB - 1u), e == 1u); }
fn stairStep(b: u32, k: u32, e: u32) -> array<vec2<f32>, 2> {
  // (from the gap's corner, along the run away from it, beside the wall on the town's side)
  let ra = runPos(b, e, STAIR_START + f32(k) * STAIR_RUN);
  let rb = runPos(b, e, STAIR_START + f32(k + 1u) * STAIR_RUN);
  return array<vec2<f32>, 2>(ra.xy + townSide(ra) * (WALL_HW + STAIR_HW), rb.xy + townSide(rb) * (WALL_HW + STAIR_HW));
}
/** a box's columns from a to b, half width hw (a column's centre within 0.35 of it), claimed from the ground (sunk 0.4)
 *  up to its top — ta at a, tb at b, linear between (the mesh's); never under the ground */
fn wallCols(a: vec2<f32>, b: vec2<f32>, hw: f32, ta: f32, tb: f32, openArt: bool) {
  let N = u32(W() * H());
  let lo = min(a, b) - vec2<f32>(hw + 1.0);
  let hi = max(a, b) + vec2<f32>(hw + 1.0);
  let L = distance(a, b);
  let d = select(vec2<f32>(1.0, 0.0), (b - a) / max(L, 1e-4), L > 1e-4);
  let nrm = vec2<f32>(-d.y, d.x);
  for (var y = max(i32(floor(lo.y / ROW_H)), 0); y <= min(i32(ceil(hi.y / ROW_H)), H() - 1); y++) {
    for (var x = max(i32(floor(lo.x)), 0); x <= min(i32(ceil(hi.x)), W() - 1); x++) {
      let c = cpos(x, y);
      // (a box, as drawn: a capsule's round ends reached a tower's claim 2.35 m along past its corner, over a stair's
      // first step)
      let s = dot(c - a, d);
      if (s < -0.35 || s > L + 0.35 || abs(dot(c - a, nrm)) > hw + 0.35) { continue; }
      let i = ix(x, y);
      // (an arterial's columns never walled: its gate stays open whatever stands at the gate's corners — b2 the
      // arterials' distance)
      if (openArt && r2(i) < u.t.x * 0.5 + 1.0) { continue; }
      let base = hAt(c) - 0.4;
      let top = mix(ta, tb, clamp(s / max(L, 1e-4), 0.0, 1.0));
      let so = N * 4u + i * 4u;
      w7[i * 4u + 3u] = 1u;
      set7(so, base);
      set7(so + 1u, max(top, base));
      w7[so + 2u] = M_RUBBLE;
      w7[so + 3u] = 0u;
      w5[i] = WALL_MARK;
    }
  }
}
