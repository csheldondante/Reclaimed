// (street lab, milestone 1) Street centrelines and widths over the window's columns, all on the GPU — the standalone
// prototype's kernels (scratchpad streetlab/index.html: blur, feat, jfa, jdist, center, tensor, trace) moved onto the
// hex lattice: a field is one value a column in window order (y · w + x); distances, gradients and traces are in window
// world units (cellPos: x across, rows ROW_H apart, odd rows half a cell right). Every entry has its own pass uniform.
//
// Bindings: 0 the pass's numbers; 1–4 read; 5–7 read-write (6 atomic in `trace` and `mesh`).

struct U {
  n: vec4<u32>, // w, h, k (a JFA step / a fill's value), mode
  m: vec4<u32>, // count (fill, trace's seeds a side), cap (mesh vertices), -, -
  a: vec4<f32>,
  b: vec4<f32>,
  c: vec4<f32>, // offsets (trace's seed lattice), -
  d: vec4<f32>, // the town's centre (world x, y), its radius, the stairs slope (rise / run)
};
@group(0) @binding(0) var<uniform> u: U;

const NONE: u32 = 0xffffffffu;
const ROW_H: f32 = 0.8660254;
const TAU: f32 = 6.2831853;

fn W() -> i32 { return i32(u.n.x); }
fn H() -> i32 { return i32(u.n.y); }
fn ix(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, H() - 1) * W() + clamp(x, 0, W() - 1)); }
/** a column's centre (world) — common.wgsl cellPos */
fn cpos(x: i32, y: i32) -> vec2<f32> { return vec2<f32>(f32(x) + 0.5 + 0.5 * f32(y & 1), (f32(y) + 0.5) * ROW_H); }
/** the column a world point is in — common.wgsl cellAt (cube rounding) */
fn cat(w: vec2<f32>) -> vec2<i32> {
  let r = (w.y - 0.5 * ROW_H) / ROW_H;
  let q = w.x - 0.5 - 0.5 * r;
  let c = vec3<f32>(q, r, -q - r);
  var o = round(c);
  let e = abs(o - c);
  if (e.x > e.y && e.x > e.z) { o.x = -o.y - o.z; } else if (e.y > e.z) { o.y = -o.x - o.z; }
  let a = vec2<i32>(i32(o.x), i32(o.y));
  return vec2<i32>(a.x + (a.y - (a.y & 1)) / 2, a.y);
}
fn ixp(p: vec2<f32>) -> u32 { let q = cat(p); return ix(q.x, q.y); }
/** inside the window's world extent */
fn inb(p: vec2<f32>) -> bool { return p.x >= 0.5 && p.y >= 0.5 && p.x < f32(W()) - 0.5 && p.y < f32(H()) * ROW_H - 0.5; }
fn inTown(p: vec2<f32>) -> bool { return distance(p, u.d.xy) < u.d.z; }
/** a centreline seed: its column and class (0 a feature, 1 major, 2 minor, +2 steep: stairs) */
fn pk(x: u32, y: u32, c: u32) -> u32 { return x | (y << 10u) | (c << 20u); }
fn pxy(v: u32) -> vec2<i32> { return vec2<i32>(i32(v & 1023u), i32((v >> 10u) & 1023u)); }
fn ppos(v: u32) -> vec2<f32> { let q = pxy(v); return cpos(q.x, q.y); }
fn pc(v: u32) -> u32 { return v >> 20u; }

// (every field is u32 words: a seed's bits kept exact, a float's through bitcast)
@group(0) @binding(1) var<storage, read> b1: array<u32>;
@group(0) @binding(2) var<storage, read> b2: array<u32>;
@group(0) @binding(3) var<storage, read> b3: array<u32>;
@group(0) @binding(4) var<storage, read> b4: array<u32>;
@group(0) @binding(5) var<storage, read_write> w5: array<u32>;
@group(0) @binding(6) var<storage, read_write> w6: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> w7: array<u32>;
fn r1(i: u32) -> f32 { return bitcast<f32>(b1[i]); }
fn r2(i: u32) -> f32 { return bitcast<f32>(b2[i]); }
fn r3(i: u32) -> f32 { return bitcast<f32>(b3[i]); }
fn r4(i: u32) -> f32 { return bitcast<f32>(b4[i]); }
fn u1(i: u32) -> u32 { return b1[i]; }
fn put5(i: u32, v: u32) { w5[i] = v; }
fn set5(i: u32, v: f32) { w5[i] = bitcast<u32>(v); }
fn set7(i: u32, v: f32) { w7[i] = bitcast<u32>(v); }

/** a field's world gradient at column (x, y) (central differences; the odd rows' half-cell shift left out) */
fn grad1(x: i32, y: i32) -> vec2<f32> { return vec2<f32>((r1(ix(x + 1, y)) - r1(ix(x - 1, y))) * 0.5, (r1(ix(x, y + 1)) - r1(ix(x, y - 1))) / (2.0 * ROW_H)); }
fn grad2(x: i32, y: i32) -> vec2<f32> { return vec2<f32>((r2(ix(x + 1, y)) - r2(ix(x - 1, y))) * 0.5, (r2(ix(x, y + 1)) - r2(ix(x, y - 1))) / (2.0 * ROW_H)); }
fn grad4(x: i32, y: i32) -> vec2<f32> { return vec2<f32>((r4(ix(x + 1, y)) - r4(ix(x - 1, y))) * 0.5, (r4(ix(x, y + 1)) - r4(ix(x, y - 1))) / (2.0 * ROW_H)); }

// ---- one thread a value: fill w5 with the bits n.z ------------------------------------------------------
@compute @workgroup_size(64)
fn fill(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x < u.m.x) { put5(g.x, u.n.z); }
}

// ---- one thread a column ---------------------------------------------------------------------------------
/** a box blur of r1 along x (mode 0) or y (mode 1), radius a.x columns */
@compute @workgroup_size(8, 8)
fn blur(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let r = i32(u.a.x);
  var s = 0.0;
  for (var k = -r; k <= r; k++) {
    if (u.n.w == 0u) { s += r1(ix(x + k, y)); } else { s += r1(ix(x, y + k)); }
  }
  set5(ix(x, y), s / f32(2 * r + 1));
}

/** the features streets keep off and follow: water (r2) and cliffs (r1's slope over a.x) — JFA seeds; w7 the mask */
@compute @workgroup_size(8, 8)
fn feat(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  // (w7: the column blocked to streets — water or cliff; the centrelines, traces and display read it)
  if (r2(i) > 0.5 || length(grad1(x, y)) > u.a.x) { put5(i, pk(u32(x), u32(y), 0u)); set7(i, 1.0); } else { put5(i, NONE); set7(i, 0.0); }
}

/** a jump-flood step of size n.z over r1's seeds (0: a copy) */
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
      let v = u1(u32(qy * W() + qx));
      if (v == NONE) { continue; }
      let d = distance(ppos(v), p);
      if (d < bd) { bd = d; best = v; }
    }
  }
  put5(ix(x, y), best);
}

/** a flood's distance (w5) and its seed's class (w7); mode 1: less the class's half width (a.x major, a.y minor) */
@compute @workgroup_size(8, 8)
fn jdist(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let v = u1(i);
  if (v == NONE) { set5(i, 1e9); set7(i, 0.0); return; }
  let c = pc(v);
  var hw = 0.0;
  if (u.n.w == 1u) { hw = select(u.a.x, u.a.y, c == 2u || c == 4u); }
  set5(i, distance(ppos(v), cpos(x, y)) - hw);
  set7(i, f32(c));
}

// ---- level-set centrelines: L1 (mode 1) heights, L2 (mode 2) the feature distance, L2 + radial (mode 3) ------
// r1 the smoothed heights, r2 the smoothed feature distance, r4 the blocked mask (water, cliffs). a: contour step (height), major spacing,
// minor spacing (radial), spokes.
fn fMaj(x: i32, y: i32) -> f32 {
  if (u.n.w == 1u) { return r1(ix(x, y)) / u.a.x; }
  return r2(ix(x, y)) / u.a.y;
}
fn ring(x: i32, y: i32) -> f32 { return floor(distance(cpos(x, y), u.d.xy) / u.a.z); }
fn spoke(x: i32, y: i32) -> f32 {
  let r = cpos(x, y) - u.d.xy;
  return floor((atan2(r.y, r.x) / TAU + 0.5) * u.a.w);
}
@compute @workgroup_size(8, 8)
fn center(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let p = cpos(x, y);
  if (!inTown(p) || r4(i) > 0.5) { put5(i, NONE); return; }
  var c = 0u;
  // (the street's direction: along the level set — across the gradient of the field whose level it is)
  var along = vec2<f32>(0.0);
  let a = floor(fMaj(x, y));
  if (a != floor(fMaj(x + 1, y)) || a != floor(fMaj(x, y + 1))) {
    c = 1u;
    var gr = grad2(x, y);
    if (u.n.w == 1u) { gr = grad1(x, y); }
    along = vec2<f32>(-gr.y, gr.x);
  }
  if (u.n.w == 3u && c == 0u) {
    let rp = p - u.d.xy;
    let rl = length(rp);
    // (rings everywhere; spokes past one ring from the middle, where they'd crowd)
    let rg = ring(x, y);
    if (rg != ring(x + 1, y) || rg != ring(x, y + 1)) { c = 2u; along = vec2<f32>(-rp.y, rp.x); }
    else if (rl > u.a.z) {
      let s = spoke(x, y);
      if (s != spoke(x + 1, y) || s != spoke(x, y + 1)) { c = 2u; along = rp; }
    }
  }
  if (c == 0u) { put5(i, NONE); return; }
  // (stairs: the ground's rise along the street over d.w)
  let al = length(along);
  if (al > 1e-5 && abs(dot(grad1(x, y), along / al)) > u.d.w) { c += 2u; }
  put5(i, pk(u32(x), u32(y), c));
}

// ---- L4: a tensor field's major / minor eigenvector streamlines ------------------------------------------
fn tt(th: f32) -> vec2<f32> { return vec2<f32>(cos(2.0 * th), sin(2.0 * th)); }
/** the major direction's angle (w5): a grid at b.x, radial round the town's centre (within b.z), along the height
 *  contours (gain b.w) and along the features (decay b.y), weighted a.x..a.w. r1 the heights, r2 the feature distance. */
@compute @workgroup_size(8, 8)
fn tensor(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  let p = cpos(x, y);
  var t = u.a.x * tt(u.b.x);
  let rp = p - u.d.xy;
  let rl = length(rp);
  if (rl > 1.0) { t += u.a.y * exp(-rl * rl / (u.b.z * u.b.z)) * tt(atan2(rp.y, rp.x) + 1.5708); }
  let hg = grad1(x, y);
  let hl = length(hg);
  if (hl > 1e-4) { t += u.a.z * min(1.0, hl * u.b.w) * tt(atan2(hg.y, hg.x) + 1.5708); }
  let fg = grad2(x, y);
  let fl = length(fg);
  if (fl > 1e-3 && r2(i) < 1e8) { t += u.a.w * exp(-r2(i) / u.b.y) * tt(atan2(fg.y, fg.x) + 1.5708); }
  set5(i, 0.5 * atan2(t.y, t.x));
}

/** the field's direction at p: the major eigenvector (mode 0) or the minor (mode 1) */
fn dirAt(p: vec2<f32>) -> vec2<f32> {
  let a = r1(ixp(p));
  if (u.n.w == 0u) { return vec2<f32>(cos(a), sin(a)); }
  return vec2<f32>(-sin(a), cos(a));
}
/**
 * One thread a seed (a lattice m.x a side, spacing 2 a.x, offset c.xy): a streamline both ways from it, a step a world
 * unit (midpoint), claiming the occupancy grid's cells (a.y a side; w6) — a cell another line holds ends it — and
 * drawn into the centrelines (w5); it ends at the water, the town's edge, or a street it meets (r2: the distance to
 * the streets so far). A seed nearer a street than 0.9 a.x doesn't start. r3 the blocked mask (water, cliffs), r4 the heights.
 */
@compute @workgroup_size(64)
fn trace(@builtin(global_invocation_id) g: vec3<u32>) {
  let id = g.x;
  let m = u.m.x;
  if (id >= m * m) { return; }
  let sp = u.a.x * 2.0;
  let p0 = (vec2<f32>(f32(id % m), f32(id / m)) + u.c.xy) * sp;
  if (!inb(p0) || !inTown(p0) || r3(ixp(p0)) > 0.5 || r2(ixp(p0)) < u.a.x * 0.9) { return; }
  let cs = u.a.y;
  let cm = u32(ceil(f32(W()) / cs));
  let me = id + 1u;
  for (var side = 0; side < 2; side++) {
    var p = p0;
    var pd = dirAt(p0);
    if (side == 1) { pd = -pd; }
    for (var st = 0; st < 900; st++) {
      var e = dirAt(p);
      if (dot(e, pd) < 0.0) { e = -e; }
      var e2 = dirAt(p + e * 0.5);
      if (dot(e2, e) < 0.0) { e2 = -e2; }
      p += e2;
      pd = e2;
      if (!inb(p) || !inTown(p) || r3(ixp(p)) > 0.5) { break; }
      let cc = u32(p.y / cs) * cm + u32(p.x / cs);
      let old = atomicCompareExchangeWeak(&w6[cc], 0u, me).old_value;
      if (old != 0u && old != me) { break; }
      let q = cat(p);
      let i = ix(q.x, q.y);
      var c = 1u + u.n.w;
      if (abs(dot(grad4(q.x, q.y), e2)) > u.d.w) { c += 2u; }
      put5(i, pk(u32(q.x), u32(q.y), c));
      if (st > 3 && r2(i) < 1.5) { break; }
    }
  }
}

// ---- the display: a flat-shaded hexagon over each street column (render.wgsl vsSkin; Renderer.addMesh) ------
// r1 the street distance (< 0 on a street), r2 the class, r3 the heights, r4 the blocked mask. w6: the vertices (two vec4<u32>
// a vertex: position bits + colour, normal bits + 1) as u32 words; w7 unused. The draw args: binding 7 as u32 (first
// word the vertex count) — `meshArgs` below.
@group(0) @binding(8) var<storage, read_write> args: array<atomic<u32>>;
const DOFF_E = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(0, 1), vec2<i32>(-1, 1), vec2<i32>(-1, 0), vec2<i32>(-1, -1), vec2<i32>(0, -1));
const DOFF_O = array<vec2<i32>, 6>(vec2<i32>(1, 0), vec2<i32>(1, 1), vec2<i32>(0, 1), vec2<i32>(-1, 0), vec2<i32>(0, -1), vec2<i32>(1, -1));
/** the neighbour at 60° k (E, NE, NW, W, SW, SE) */
fn nb(x: i32, y: i32, k: i32) -> vec2<i32> {
  if ((y & 1) == 0) { return vec2<i32>(x, y) + DOFF_E[k]; }
  return vec2<i32>(x, y) + DOFF_O[k];
}
/** the street's lift over the ground (cells) */
const LIFT: f32 = 0.3;
/** a neighbour further up or down than this (cells) doesn't bend a hexagon's corner */
const STEP: f32 = 1.5;
fn corner(x: i32, y: i32, k: i32) -> vec3<f32> {
  let th = (f32(k) + 0.5) * TAU / 6.0;
  let p = cpos(x, y) + vec2<f32>(cos(th), sin(th)) * 0.57735;
  let a = nb(x, y, k);
  let b = nb(x, y, (k + 1) % 6);
  // (the corner's height the mean of the three columns that share it — those within STEP of this one: a hexagon
  // isn't stretched down a cliff or up a wall)
  let z0 = r3(ix(x, y));
  let za = r3(ix(a.x, a.y));
  let zb = r3(ix(b.x, b.y));
  var s = z0;
  var n = 1.0;
  if (abs(za - z0) < STEP) { s += za; n += 1.0; }
  if (abs(zb - z0) < STEP) { s += zb; n += 1.0; }
  return vec3<f32>(p, s / n + LIFT);
}
fn vert(at: u32, p: vec3<f32>, col: u32, n: vec3<f32>) {
  let o = at * 8u;
  atomicStore(&w6[o], bitcast<u32>(p.x));
  atomicStore(&w6[o + 1u], bitcast<u32>(p.y));
  atomicStore(&w6[o + 2u], bitcast<u32>(p.z));
  atomicStore(&w6[o + 3u], col);
  atomicStore(&w6[o + 4u], bitcast<u32>(n.x));
  atomicStore(&w6[o + 5u], bitcast<u32>(n.y));
  atomicStore(&w6[o + 6u], bitcast<u32>(n.z));
  atomicStore(&w6[o + 7u], 1u);
}
@compute @workgroup_size(8, 8)
fn mesh(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = i32(g.x); let y = i32(g.y);
  if (x >= W() || y >= H()) { return; }
  let i = ix(x, y);
  if (r1(i) >= 0.0 || r4(i) > 0.5) { return; }
  let c = u32(r2(i));
  var col = 0xe8dfc8u;
  if (c == 2u) { col = 0xb9ad96u; }
  if (c >= 3u) { col = 0xf08c33u; }
  let base = atomicAdd(&args[0], 12u);
  if (base + 12u > u.m.y) { return; }
  var v: array<vec3<f32>, 6>;
  for (var k = 0; k < 6; k++) { v[k] = corner(x, y, k); }
  for (var t = 0; t < 4; t++) {
    let a = v[0]; let b = v[t + 1]; let d = v[t + 2];
    var n = normalize(cross(b - a, d - a));
    if (n.z < 0.0) { n = -n; }
    vert(base + u32(t) * 3u, a, col, n);
    vert(base + u32(t) * 3u + 1u, b, col, n);
    vert(base + u32(t) * 3u + 2u, d, col, n);
  }
}
/** the count clamped to the room (threads past it wrote nothing) */
@compute @workgroup_size(1)
fn meshCap() {
  let n = atomicLoad(&args[0]);
  atomicStore(&args[0], min(n, u.m.y));
}
