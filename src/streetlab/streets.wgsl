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
  q: vec4<f32>, // (m3d) bad cells (0 merge, 1 plaza), the junction plazas' radius (0 none), the cross streets a junction needs, 0
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
fn inTown(p: vec2<f32>) -> bool { return distance(p, u.d.xy) < u.d.z; }
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
  if (g.x < u.m.x) { w5[g.x] = u.n.z; }
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
  let T = u.m.w * u32(u.c.w);
  if (bi >= 3u * T) { return; }
  let o = bi * BQW;
  if (b1[o] == 0u) { return; }
  // (m3d: a block made a plaza — its meta, the slot after it, status 1 — is one paved lot, not split)
  let plaza = bi % 3u == 0u && u.o.w == 0u && b1[o + BQW + 5u] == 1u;
  var st: array<Quad, STACK>;
  var n = 1u;
  var q0: Quad;
  for (var k = 0u; k < 4u; k++) { q0.v[k] = vec2<f32>(r1(o + 2u + k * 2u), r1(o + 3u + k * 2u)); }
  q0.e = b1[o + 1u];
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
      a.e = ek | (e2 << 16u) | (e3 << 24u);
      a.d = q.d + 1u;
      var b: Quad;
      b.v = array<vec2<f32>, 4>(c1, v1, v2, c2);
      b.e = ek | (e1 << 8u) | (e2 << 16u);
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
    w5[lo + 9u] = (bi * 256u + made) | select(0u, PAVED, plaza);
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
  if (!inTown(c) || blockedAt(c) || inPlazaB1(c)) { return; }
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
  if ((hs & PAVED) != 0u || inPlazaW5(mid) || (u.q.x < 1.5 && badQuad(v, 0.0))) { paveLot(v, mid); return; }
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
// edge; NONE none), 5 6 where that street ends.
const SDW: u32 = 8u;
const SID: u32 = 0x1fffu;
/** (m3d) a cross street that ends on the town's edge — the circle a closing line */
const EDGE: u32 = 0xfffffffeu;
/** the field the seeds sit on: φ's (family 1) or, radial, the rings' */
fn mainK() -> u32 { return select(2u, 1u, fam(1u)); }
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
  let key = (u32(min(distance(p, cc) / u.a.w, 0.99) * 4096.0) << 13u) | id;
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
      if (distance(vec2<f32>(bitcast<f32>(w5[j]), bitcast<f32>(w5[j + 1u])), p) < 0.6 * u.a.w) { keep = false; }
    }
  }
  if (!keep) { w5[o + 3u] = 0u; }
}
fn sdPos(j: u32) -> vec2<f32> { return vec2<f32>(r1(j * SDW), r1(j * SDW + 1u)); }
/** where seed j's cross street ends (words 5 6: a seed's position, or the point on the town's edge) */
fn sdEnd(j: u32) -> vec2<f32> { return vec2<f32>(r1(j * SDW + 5u), r1(j * SDW + 6u)); }
/** the kept seeds into the floods' columns: even lines' w5, odd lines' w7 (r1 the seeds) */
@compute @workgroup_size(64)
fn vrast(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= u.m.w * u32(u.c.w)) { return; }
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
  if (id >= u.m.w * u32(u.c.w)) { return; }
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
  // (m3d: the next line past the town's edge — the edge's circle closes the strip: the street runs up to it)
  if (!ok && !inTown(s + gr / gl2)) {
    let up = gr / sqrt(gl2);
    let rel = s - u.d.xy;
    let b = dot(rel, up);
    let disc = b * b - (dot(rel, rel) - u.d.z * u.d.z);
    if (disc > 0.0) {
      e = s + up * (-b + sqrt(disc) - 0.5);
      end = EDGE;
      ok = true;
    }
  }
  if (!ok) { return; }
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
  if (id >= u.m.w * u32(u.c.w)) { return; }
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
  let s = sdPos(id);
  let L = b1[o + 2u];
  let gr = gradAt(mainK(), s);
  let tn = normalize(vec2<f32>(-gr.y, gr.x));
  let bl = u.a.w;
  let reach = array<f32, 3>(1.0, 1.5, 0.7);
  var c = NONE;
  for (var k = 0; k < 3; k++) {
    let n = nearestOf(L & 1u, s + tn * bl * reach[k]);
    if (n == NONE || n == id || b1[n * SDW + 2u] != L || b1[n * SDW + 3u] == 0u) { continue; }
    let dv = sdPos(n) - s;
    if (dot(dv, tn) < 0.3 * bl || length(dv) > 2.5 * bl) { continue; }
    c = n;
    break;
  }
  var tc = NONE;
  if (c != NONE) { tc = b1[c * SDW + 4u]; }
  if (tc == NONE) { w7[id] = 1u; return; }
  let es = sdEnd(id);
  let ec = sdEnd(c);
  let sc = sdPos(c);
  if (segsCross(s, es, sc, ec)) { return; }
  w7[id] = 1u;
  // (a street to the town's edge beside one to a seed: no block)
  if ((ts == EDGE) != (tc == EDGE)) { return; }
  w5[mo + 2u] = c;
  if (tc == ts && ts != EDGE) {
    w5[mo + 4u] = 1u;
    _ = putBlock(ob, array<vec2<f32>, 4>(s, sc, es, 0.5 * (es + s)), array<u32, 4>(1u, 2u, 2u, 2u), id);
  } else {
    let far = select(1u, 0u, ts == EDGE);
    _ = putBlock(ob, array<vec2<f32>, 4>(s, sc, ec, es), array<u32, 4>(1u, 2u, far, 2u), id);
  }
}
/** the cross streets: eight ribbon pieces a drawn street, on the ground (r1 the seeds, r2 drawn, r3 H, b4 the plazas) */
@compute @workgroup_size(64)
fn vroad(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x / 8u;
  let k = g.x % 8u;
  if (id >= u.m.w * u32(u.c.w) || b2[id] == 0u) { return; }
  let t = b1[id * SDW + 4u];
  if (t == NONE) { return; }
  let s = sdPos(id);
  let e = sdEnd(id);
  let a = mix(s, e, f32(k) / 8.0);
  let b = mix(s, e, f32(k + 1u) / 8.0);
  // (m3d: a junction's plaza swallows the street's pieces in it)
  if (inPlazaB4(0.5 * (a + b))) { return; }
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
// A junction plaza (PJ): word 0 the count, then x, y each (PJ_ROOM at most).
const PAVED: u32 = 0x80000000u;
const C_PAVE: u32 = 0xdcd0b6u;
const PJ_ROOM: u32 = 64u;
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
  if (id >= u.m.w * u32(u.c.w)) { return; }
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
  if (id >= u.m.w * u32(u.c.w) || u.q.x > 0.5) { return; }
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
  if (okC) { lc = distance(sdPos(c), sdEnd(c)) + select(1e4, 0.0, w5[c * 3u * BQW + BQW + 1u] == 1u); }
  let st = w5[mo + 8u];
  if (okP) { lp = distance(sdPos(st), sdEnd(st)) + select(1e4, 0.0, w5[p * 3u * BQW + BQW + 1u] == 1u); }
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
  if (id >= u.m.w * u32(u.c.w) || u.q.x > 0.5) { return; }
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
  let pa = sdPos(a);
  let pb = sdPos(b);
  let ea = sdEnd(a);
  let eb = sdEnd(b);
  var ok = false;
  var tri = 0u;
  if (ta == tb && ta != EDGE) {
    tri = 1u;
    ok = putBlock(ob, array<vec2<f32>, 4>(pa, pb, ea, 0.5 * (ea + pa)), array<u32, 4>(1u, 2u, 2u, 2u), id);
  } else {
    ok = putBlock(ob, array<vec2<f32>, 4>(pa, pb, eb, ea), array<u32, 4>(1u, 2u, select(1u, 0u, ta == EDGE), 2u), id);
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
/** one thread a drawn cross street: one more at the seed it ends at (w6 the counts; r1 the seeds, b2 drawn) */
@compute @workgroup_size(64)
fn jcount(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= u.m.w * u32(u.c.w) || b2[id] == 0u) { return; }
  let t = b1[id * SDW + 4u];
  if (t == NONE || t == EDGE) { return; }
  atomicAdd(&w6[t], 1u);
}
/** one thread a seed: a plaza where q.z or more cross streets meet (w6 the plazas; r1 the seeds, b2 the counts) */
@compute @workgroup_size(64)
fn jlist(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  if (id >= u.m.w * u32(u.c.w) || u.q.y <= 0.0) { return; }
  if (b1[id * SDW + 3u] == 0u || f32(b2[id]) < u.q.z) { return; }
  let k = atomicAdd(&w6[0], 1u);
  if (k >= PJ_ROOM) { return; }
  let p = sdPos(id);
  atomicStore(&w6[1u + k * 2u], bitcast<u32>(p.x));
  atomicStore(&w6[2u + k * 2u], bitcast<u32>(p.y));
}
fn inPlazaB1(p: vec2<f32>) -> bool {
  if (u.q.y <= 0.0) { return false; }
  for (var k = 0u; k < min(b1[0], PJ_ROOM); k++) { if (distance(p, vec2<f32>(r1(1u + k * 2u), r1(2u + k * 2u))) < u.q.y) { return true; } }
  return false;
}
fn inPlazaB4(p: vec2<f32>) -> bool {
  if (u.q.y <= 0.0) { return false; }
  for (var k = 0u; k < min(b4[0], PJ_ROOM); k++) { if (distance(p, vec2<f32>(r4(1u + k * 2u), r4(2u + k * 2u))) < u.q.y) { return true; } }
  return false;
}
fn inPlazaW5(p: vec2<f32>) -> bool {
  if (u.q.y <= 0.0) { return false; }
  for (var k = 0u; k < min(w5[0], PJ_ROOM); k++) { if (distance(p, vec2<f32>(bitcast<f32>(w5[1u + k * 2u]), bitcast<f32>(w5[2u + k * 2u]))) < u.q.y) { return true; } }
  return false;
}
/** the junction plazas: a paved disc each (r1 the plazas, r3 H) */
@compute @workgroup_size(64)
fn plazas(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = g.x;
  if (u.q.y <= 0.0 || j >= min(b1[0], PJ_ROOM)) { return; }
  let p = vec2<f32>(r1(1u + j * 2u), r1(2u + j * 2u));
  let at = room(36u);
  if (at == NONE) { return; }
  let z = hAt(p) + 0.18;
  for (var k = 0u; k < 12u; k++) {
    let a0 = f32(k) * TAU / 12.0;
    let a1 = f32(k + 1u) * TAU / 12.0;
    let q0 = p + u.q.y * vec2<f32>(cos(a0), sin(a0));
    let q1 = p + u.q.y * vec2<f32>(cos(a1), sin(a1));
    tri(at + k * 3u, vec3<f32>(p, z), vec3<f32>(q0, hAt(q0) + 0.18), vec3<f32>(q1, hAt(q1) + 0.18), C_PAVE);
  }
}
