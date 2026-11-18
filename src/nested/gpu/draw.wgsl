// ---- nested/gpu/draw.wgsl: a level's surface, pulled from its pages (store.wgsl prepended) ---------------------------
// One grid of n x n vertices at the window's column centres, in the level's own units; the view-projection comes from
// the camera pass (cam). A child's vertices in its rim band (one parent cell wide) and while it fades in are blended
// toward the parent's drawn surface there (the parent's own triangles and normals), so the two agree at the rim and a
// promotion sharpens in instead of popping. A parent discards its fragments inside its child's footprint (inset by
// three quarters of a child column, where the child already equals the parent): a coarse surface never pokes through.

struct DrawU {
  lvl: vec4<i32>, // gx0, gy0, n, depth
  par: vec4<i32>, // parent gx0, gy0, n, has a parent
  cut: vec4<f32>, // the child's footprint in this level's local units, inset (x0, y0, x1, y1); empty: x0 > x1
  misc: vec4<f32>, // now, fade seconds, tint on, k
  want: vec4<f32>, // (metrics) where the focus wants this level's child, local units
  sun: vec4<f32>,
  misc2: vec4<u32>, // x: this level's offset in the quad list
}

@group(0) @binding(0) var<uniform> d: DrawU;
@group(0) @binding(1) var<storage, read> tab: array<u32>;
@group(0) @binding(2) var<storage, read> pg: array<u32>;
@group(0) @binding(3) var<storage, read> cam: array<f32>;
@group(0) @binding(4) var<storage, read> reg: array<i32>;
@group(0) @binding(5) var<storage, read> qlist: array<u32>;
@group(0) @binding(6) var<storage, read> dinfo: array<u32>;
// (the scan's: the same buffers, writable, in the compute bind group)
@group(0) @binding(7) var<storage, read_write> qlistW: array<u32>;
@group(0) @binding(8) var<storage, read_write> dinfoW: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> drawW: array<u32>;
// the top sheet's per-quad triangle mask (bit t: triangle t kept), written by the scan, read by fsA
@group(0) @binding(10) var<storage, read> amask: array<u32>;
@group(0) @binding(11) var<storage, read_write> amaskW: array<u32>;

fn tabLoad(i: u32) -> u32 { return tab[i]; }
fn pgLoad(i: u32) -> u32 { return pg[i]; }

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) fade: f32,
  @location(4) wp: vec3<f32>, // world position (the pattern's coordinates, the same on every level)
}

/** a level's z origin in world units (reg words 1..L: each level's origin in its parent's units) */
fn zOrigW(L: u32) -> f32 {
  var z = 0.0;
  for (var j = 1u; j <= L; j++) { z += bitcast<f32>(reg[j]) / pow(d.misc.w, f32(j - 1u)); }
  return z;
}
/** a level's local point in world units */
fn worldOf(L: u32, lp: vec3<f32>) -> vec3<f32> {
  let s = pow(d.misc.w, f32(L));
  return vec3<f32>((f32(d.lvl.x) + lp.x) / s, (f32(d.lvl.y) + lp.y) / s, zOrigW(L) + lp.z / s);
}
fn vpOf(L: u32) -> mat4x4<f32> {
  let b = 32u + L * 24u;
  return mat4x4<f32>(
    vec4<f32>(cam[b], cam[b + 1u], cam[b + 2u], cam[b + 3u]),
    vec4<f32>(cam[b + 4u], cam[b + 5u], cam[b + 6u], cam[b + 7u]),
    vec4<f32>(cam[b + 8u], cam[b + 9u], cam[b + 10u], cam[b + 11u]),
    vec4<f32>(cam[b + 12u], cam[b + 13u], cam[b + 14u], cam[b + 15u]));
}

fn matColor(m: u32, slope: f32) -> vec3<f32> {
  switch (m) {
    case 1u: { return vec3<f32>(0.47, 0.45, 0.43); }
    case 2u: { return mix(vec3<f32>(0.36, 0.52, 0.24), vec3<f32>(0.45, 0.36, 0.24), clamp(slope * 1.4 - 0.3, 0.0, 1.0)); }
    case 3u: { return vec3<f32>(0.80, 0.70, 0.48); }
    case 4u: { return vec3<f32>(0.62, 0.38, 0.30); }
    default: { return vec3<f32>(1.0, 0.0, 1.0); }
  }
}
/** a column's surface and the material showing there (the top interval with any thickness) */
fn surfMat(lid: u32, X: i32, Y: i32) -> vec2<f32> {
  let n = colCount(lid, X, Y);
  if (n == 0u) { return vec2<f32>(0.0, 0.0); }
  let top = ivlAt(lid, X, Y, n - 1u);
  var m = top.m;
  var i = n - 1u;
  loop {
    let a = ivlAt(lid, X, Y, i);
    if (a.z1 - a.z0 > 1e-4 || i == 0u) {
      m = a.m;
      break;
    }
    i--;
  }
  return vec2<f32>(top.z1, f32(m));
}
fn clampW(w: vec4<i32>, X: i32, Y: i32) -> vec2<i32> { return vec2<i32>(clamp(X, w.x, w.x + w.z - 1), clamp(Y, w.y, w.y + w.z - 1)); }
fn sAt(lid: u32, w: vec4<i32>, X: i32, Y: i32) -> f32 {
  let q = clampW(w, X, Y);
  return topS(lid, q.x, q.y, colCount(lid, q.x, q.y));
}
fn nrmAt(lid: u32, w: vec4<i32>, X: i32, Y: i32) -> vec3<f32> {
  return normalize(vec3<f32>(-(sAt(lid, w, X + 1, Y) - sAt(lid, w, X - 1, Y)) * 0.5, -(sAt(lid, w, X, Y + 1) - sAt(lid, w, X, Y - 1)) * 0.5, 1.0));
}
fn birthOf(lid: u32, X: i32, Y: i32) -> f32 {
  let s = tFind(tKey0(X >> 4, Y >> 4), tKey1(lid, 0u));
  if (s == NONE) { return -1e9; }
  return bitcast<f32>(tab[s * 4u + 3u]);
}

// ---- air regions (gaps) of a column, from the top: gap 0 the sky above the top, then the air between solid runs ------
// A face of the solid/air boundary is a floor (a gap's bottom) or a ceiling (its top). Neighbouring columns' gaps
// correspond when each is the other's nearest-floor gap among those overlapping it in z (mutual nearest): the ground
// outside an overhang meets the floor under it, not its roof; a tunnel's air meets no air in solid neighbours.
/** an air gap thinner than this (local units: a quarter column) is below the level's resolution (a finer level's tunnel
 *  restricted to its mean air) and is drawn as solid: a sliver gap otherwise shows as shards of floor and roof */
const GAP_MIN: f32 = 0.25;
struct Gap {
  f: f32, // floor
  c: f32, // ceiling (1e30: the sky)
  fm: u32,
  cm: u32,
  rb: f32, // the bottom of the solid run under the floor
  ok: bool,
}
fn gapAt(lid: u32, X: i32, Y: i32, g: u32) -> Gap {
  let n = colCount(lid, X, Y);
  var out = Gap(0.0, 0.0, 0u, 0u, 0.0, false);
  if (n == 0u) { return out; }
  var cur = 0u;
  var ceil = 1e30;
  var cm = 0u;
  var i = i32(n) - 1;
  loop {
    let top = ivlAt(lid, X, Y, u32(i));
    var j = i;
    loop {
      if (j == 0) { break; }
      if (ivlAt(lid, X, Y, u32(j)).z0 > ivlAt(lid, X, Y, u32(j - 1)).z1 + GAP_MIN) { break; }
      j--;
    }
    let bot = ivlAt(lid, X, Y, u32(j));
    if (cur == g) { return Gap(top.z1, ceil, top.m, cm, max(bot.z0, top.z1 - 1000.0), true); }
    if (j == 0) { return out; }
    ceil = bot.z0;
    cm = bot.m;
    cur++;
    i = j - 1;
  }
}
fn gapCount(lid: u32, X: i32, Y: i32) -> u32 {
  let n = colCount(lid, X, Y);
  var c = select(0u, 1u, n > 0u);
  for (var i = 1u; i < n; i++) {
    if (ivlAt(lid, X, Y, i).z0 > ivlAt(lid, X, Y, i - 1u).z1 + GAP_MIN) { c++; }
  }
  return c;
}
fn nearestGap(lid: u32, X: i32, Y: i32, f: f32, c: f32) -> i32 {
  var best = -1;
  var bd = 1e30;
  let gc = gapCount(lid, X, Y);
  for (var g = 0u; g < gc; g++) {
    let h = gapAt(lid, X, Y, g);
    if (h.f < c && f < h.c && abs(h.f - f) < bd) {
      bd = abs(h.f - f);
      best = i32(g);
    }
  }
  return best;
}
/** gap g of column a: the matching gap of column b (mutual nearest floor), or -1 */
fn mutual(lid: u32, a: vec2<i32>, g: u32, b: vec2<i32>) -> i32 {
  let G = gapAt(lid, a.x, a.y, g);
  if (!G.ok) { return -1; }
  let j = nearestGap(lid, b.x, b.y, G.f, G.c);
  if (j < 0) { return -1; }
  let H = gapAt(lid, b.x, b.y, u32(j));
  if (nearestGap(lid, a.x, a.y, H.f, H.c) != i32(g)) { return -1; }
  return j;
}
/** the quad's corner q (0: (i, j), 1: (i + 1, j), 2: (i, j + 1), 3: (i + 1, j + 1)) */
fn cornerOf(q: u32) -> vec2<i32> { return vec2<i32>(i32(q & 1u), i32(q >> 1u)); }
/** triangle t of a quad, vertex s: the diagonal from (i, j) to (i + 1, j + 1), as the parent blend assumes */
fn triCorner(t: u32, s: u32) -> u32 {
  if (t == 0u) { return array<u32, 3>(0u, 1u, 3u)[s]; }
  return array<u32, 3>(0u, 3u, 2u)[s];
}

/** A: the top sheet (the floor of the sky), an indexed grid: one vertex a column. A triangle whose corners' skies do
 *  not all meet (an overhang's roof beside the ground) is masked by the scan (fsA discards it) and drawn in B. */
@vertex
fn vs(@builtin(vertex_index) vv: u32) -> VOut {
  let w = d.lvl;
  let L = u32(w.w);
  let i = i32(vv % u32(w.z));
  let j = i32(vv / u32(w.z));
  let X = w.x + i;
  let Y = w.y + j;
  let sm = surfMat(L, X, Y);
  var h = sm.x;
  var nr = nrmAt(L, w, X, Y);
  var c = matColor(u32(sm.y), length(nr.xy) / max(nr.z, 1e-3));
  var fade = 1.0;
  if (d.par.w != 0) {
    let k = d.misc.w;
    let edge = min(min(f32(i) + 0.5, f32(j) + 0.5), min(f32(w.z - i) - 0.5, f32(w.z - j) - 0.5));
    let band = smoothstep(0.5, k, edge);
    fade = clamp((d.misc.x - birthOf(L, X, Y)) / d.misc.y, 0.0, 1.0);
    let bw = band * fade;
    if (bw < 1.0) {
      // the parent's drawn surface here: its triangle (diagonal from (i, j) to (i + 1, j + 1)) and normals
      let pw = d.par;
      let P = L - 1u;
      let ux = (f32(X) + 0.5) / k - 0.5;
      let uy = (f32(Y) + 0.5) / k - 0.5;
      let i0 = i32(floor(ux));
      let j0 = i32(floor(uy));
      let fu = ux - f32(i0);
      let fv = uy - f32(j0);
      let h00 = sAt(P, pw, i0, j0);
      let h10 = sAt(P, pw, i0 + 1, j0);
      let h01 = sAt(P, pw, i0, j0 + 1);
      let h11 = sAt(P, pw, i0 + 1, j0 + 1);
      var wts = vec4<f32>(0.0);
      if (fu >= fv) { wts = vec4<f32>(1.0 - fu, fu - fv, 0.0, fv); } else { wts = vec4<f32>(1.0 - fv, 0.0, fv - fu, fu); }
      let ph = wts.x * h00 + wts.y * h10 + wts.z * h01 + wts.w * h11;
      let pn = normalize(wts.x * nrmAt(P, pw, i0, j0) + wts.y * nrmAt(P, pw, i0 + 1, j0) + wts.z * nrmAt(P, pw, i0, j0 + 1) + wts.w * nrmAt(P, pw, i0 + 1, j0 + 1));
      let q00 = clampW(pw, i0, j0);
      let q10 = clampW(pw, i0 + 1, j0);
      let q01 = clampW(pw, i0, j0 + 1);
      let q11 = clampW(pw, i0 + 1, j0 + 1);
      let sl = length(pn.xy) / max(pn.z, 1e-3);
      let pc = wts.x * matColor(u32(surfMat(P, q00.x, q00.y).y), sl) + wts.y * matColor(u32(surfMat(P, q10.x, q10.y).y), sl) + wts.z * matColor(u32(surfMat(P, q01.x, q01.y).y), sl) + wts.w * matColor(u32(surfMat(P, q11.x, q11.y).y), sl);
      let z0 = bitcast<f32>(reg[L]);
      h = mix((ph - z0) * k, h, bw);
      nr = normalize(mix(pn, nr, bw));
      c = mix(pc, c, bw);
    }
  }
  var o: VOut;
  let lp = vec3<f32>(f32(i) + 0.5, f32(j) + 0.5, h);
  o.pos = vpOf(L) * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nr;
  o.col = c;
  o.fade = fade;
  o.wp = worldOf(L, lp);
  return o;
}

// ---- B's rim morph: a child's floor or ceiling blended toward the parent's matching bound ------------------------------
/** the rim band and fade weight of a child's local point (1: the child's own; 0: the parent's) */
fn bandW(L: u32, lp: vec2<f32>) -> vec2<f32> {
  if (d.par.w == 0) { return vec2<f32>(1.0, 1.0); }
  let w = d.lvl;
  let k = d.misc.w;
  let edge = min(min(lp.x, lp.y), min(f32(w.z) - lp.x, f32(w.z) - lp.y));
  let band = smoothstep(0.5, k, edge);
  let fade = clamp((d.misc.x - birthOf(L, w.x + i32(floor(lp.x)), w.y + i32(floor(lp.y)))) / d.misc.y, 0.0, 1.0);
  return vec2<f32>(band * fade, fade);
}
/** the parent's bound matching a child gap (floor gf, ceiling gc; child units) at child local point lp: over the
 *  parent's triangle there (as the top sheet's morph), each corner's gap overlapping the child's, its floor or ceiling;
 *  a corner with none takes the child's own value. Child units. */
fn parentBound(L: u32, lp: vec2<f32>, gf: f32, gc: f32, ceil: bool, own: f32) -> f32 {
  let k = d.misc.w;
  let pw = d.par;
  let P = L - 1u;
  let z0 = bitcast<f32>(reg[L]);
  let ux = (f32(d.lvl.x) + lp.x) / k - 0.5;
  let uy = (f32(d.lvl.y) + lp.y) / k - 0.5;
  let i0 = i32(floor(ux));
  let j0 = i32(floor(uy));
  let fu = ux - f32(i0);
  let fv = uy - f32(j0);
  var wts = vec4<f32>(0.0);
  if (fu >= fv) { wts = vec4<f32>(1.0 - fu, fu - fv, 0.0, fv); } else { wts = vec4<f32>(1.0 - fv, 0.0, fv - fu, fu); }
  let pf = gf / k + z0;
  let pc = select(gc / k + z0, 1e30, gc > 1e29);
  var z = 0.0;
  for (var q = 0u; q < 4u; q++) {
    if (wts[q] <= 0.0) { continue; }
    let C = clampW(pw, i0 + i32(q & 1u), j0 + i32(q >> 1u));
    let g = nearestGap(P, C.x, C.y, pf, pc);
    var v = own;
    if (g >= 0) {
      let G = gapAt(P, C.x, C.y, u32(g));
      let b = select(G.f, G.c, ceil);
      if (b < 1e29) { v = (b - z0) * k; }
    }
    z += wts[q] * v;
  }
  return z;
}

/** B: everything off the plain top sheet, for the quads the scan listed (a corner with more than one gap): per
 *  instance a quad, an anchor corner and its gap g. Each triangle of the quad: the gap's floor and ceiling where its
 *  corners share it, cut half way to a corner that lacks it (marching triangles), and a wall along the cut: for an
 *  enclosed gap from floor to ceiling (facing the air), for the sky from the floor down its solid run (an overhang's
 *  front, facing out). A region is drawn from the lowest corner that has it; the sky's whole triangles are A's. */
@vertex
fn vsB(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  o.fade = 1.0;
  let w = d.lvl;
  let L = u32(w.w);
  let G = max(dinfo[u32(w.w) * 4u + 1u], 1u);
  let g = inst % G;
  let ac = (inst / G) % 4u;
  let quad = qlist[d.misc2.x + inst / (4u * G)];
  let base = vec2<i32>(w.x + i32(quad & 0xffffu), w.y + i32(quad >> 16u));
  let A = base + cornerOf(ac);
  let AG = gapAt(L, A.x, A.y, g);
  if (!AG.ok) { return o; }
  // the region at each corner of the quad
  var pres = array<bool, 4>(false, false, false, false);
  var gp = array<Gap, 4>(AG, AG, AG, AG);
  var sky = array<bool, 4>(false, false, false, false);
  var gi = array<u32, 4>(g, g, g, g);
  for (var q = 0u; q < 4u; q++) {
    let C = base + cornerOf(q);
    var m = i32(g);
    if (q != ac) { m = mutual(L, A, g, C); }
    if (m >= 0) {
      pres[q] = true;
      gi[q] = u32(m);
      gp[q] = gapAt(L, C.x, C.y, u32(m));
      sky[q] = m == 0;
      if (q < ac) { return o; } // a lower corner draws it
    }
  }
  let t = vv / 18u;
  let part = (vv % 18u) / 6u;
  let s = vv % 6u;
  var tc = array<u32, 3>(triCorner(t, 0u), triCorner(t, 1u), triCorner(t, 2u));
  // present for this part: floors need the region; ceilings also a finite ceiling
  var p = array<bool, 3>(false, false, false);
  var np = 0u;
  for (var r = 0u; r < 3u; r++) {
    p[r] = pres[tc[r]] && (part != 1u || gp[tc[r]].c < 1e29);
    if (p[r]) { np++; }
  }
  if (np == 0u) { return o; }
  if (part == 0u && np == 3u && sky[tc[0]] && sky[tc[1]] && sky[tc[2]]) { return o; } // A's
  if (part == 2u && np == 3u) { return o; }
  // order: present corners first
  var ord = array<u32, 3>(0u, 1u, 2u);
  var k2 = 0u;
  for (var r = 0u; r < 3u; r++) {
    if (p[r]) {
      ord[k2] = r;
      k2++;
    }
  }
  for (var r = 0u; r < 3u; r++) {
    if (!p[r]) {
      ord[k2] = r;
      k2++;
    }
  }
  let ca = tc[ord[0]];
  let cb = tc[ord[1]];
  let cx = tc[ord[2]];
  let pa = vec2<f32>(cornerOf(ca)) + 0.5 + vec2<f32>(base - w.xy);
  let pb = vec2<f32>(cornerOf(cb)) + 0.5 + vec2<f32>(base - w.xy);
  let px = vec2<f32>(cornerOf(cx)) + 0.5 + vec2<f32>(base - w.xy);
  let ga = gp[ca];
  let gb = gp[cb];
  var pts = array<vec3<f32>, 6>();
  var nrm = vec3<f32>(0.0, 0.0, 1.0);
  var mat = ga.fm;
  var lp = vec3<f32>(0.0);
  if (part < 2u) {
    let za = select(ga.f, ga.c, part == 1u);
    let zb = select(gb.f, gb.c, part == 1u);
    // the corner whose bound each point takes (its z, its normal)
    var src = array<u32, 6>(ca, ca, ca, ca, ca, ca);
    if (np == 3u) {
      let zx = select(gp[cx].f, gp[cx].c, part == 1u);
      pts = array<vec3<f32>, 6>(vec3<f32>(pa, za), vec3<f32>(pb, zb), vec3<f32>(px, zx), vec3<f32>(pa, za), vec3<f32>(pa, za), vec3<f32>(pa, za));
      src = array<u32, 6>(ca, cb, cx, ca, ca, ca);
    } else if (np == 2u) {
      let mbx = vec3<f32>(0.5 * (pb + px), zb);
      let max_ = vec3<f32>(0.5 * (pa + px), za);
      pts = array<vec3<f32>, 6>(vec3<f32>(pa, za), vec3<f32>(pb, zb), mbx, vec3<f32>(pa, za), mbx, max_);
      src = array<u32, 6>(ca, cb, cb, ca, cb, ca);
    } else {
      let mab = vec3<f32>(0.5 * (pa + pb), za);
      let mak = vec3<f32>(0.5 * (pa + px), za);
      pts = array<vec3<f32>, 6>(vec3<f32>(pa, za), mab, mak, vec3<f32>(pa, za), vec3<f32>(pa, za), vec3<f32>(pa, za));
    }
    // the normal: the gap's floor (ceiling) gradient over the quad's corners that have it (no further page walks;
    // smooth within a quad, not across quads: NS-23's gap table would give the neighbours' values cheaply)
    let sc = src[s];
    var gx = 0.0;
    var gy = 0.0;
    var nx = 0.0;
    var ny = 0.0;
    let zq = array<f32, 4>(select(gp[0].f, gp[0].c, part == 1u), select(gp[1].f, gp[1].c, part == 1u), select(gp[2].f, gp[2].c, part == 1u), select(gp[3].f, gp[3].c, part == 1u));
    let ok = array<bool, 4>(pres[0] && zq[0] < 1e29, pres[1] && zq[1] < 1e29, pres[2] && zq[2] < 1e29, pres[3] && zq[3] < 1e29);
    if (ok[0] && ok[1]) { gx += zq[1] - zq[0]; nx += 1.0; }
    if (ok[2] && ok[3]) { gx += zq[3] - zq[2]; nx += 1.0; }
    if (ok[0] && ok[2]) { gy += zq[2] - zq[0]; ny += 1.0; }
    if (ok[1] && ok[3]) { gy += zq[3] - zq[1]; ny += 1.0; }
    nrm = normalize(vec3<f32>(-gx / max(nx, 1.0), -gy / max(ny, 1.0), 1.0));
    if (part == 1u) { nrm = -nrm; }
    if (part == 1u) { mat = ga.cm; }
    lp = pts[s];
    let bw = bandW(L, lp.xy);
    o.fade = bw.y;
    if (bw.x < 1.0) { lp.z = mix(parentBound(L, lp.xy, gp[sc].f, gp[sc].c, part == 1u, lp.z), lp.z, bw.x); }
  } else {
    // the wall along the cut, between the two half-way points
    var m1 = 0.5 * (pa + px);
    var m2 = 0.5 * (pb + px);
    var g1 = ga;
    var g2 = gb;
    if (np == 1u) {
      m1 = 0.5 * (pa + pb);
      m2 = 0.5 * (pa + px);
      g2 = ga;
    }
    // (both ends' gaps decide: a region that is the sky at one corner and enclosed at another walls like the sky)
    let enclosed = g1.c < 1e29 && g2.c < 1e29;
    var b1 = select(g1.rb, g1.f, enclosed);
    var t1 = select(g1.f, g1.c, enclosed);
    var b2 = select(g2.rb, g2.f, enclosed);
    var t2 = select(g2.f, g2.c, enclosed);
    // the rim morph: the wall's floor and ceiling ends follow the faces they meet
    let w1 = bandW(L, m1);
    let w2 = bandW(L, m2);
    o.fade = min(w1.y, w2.y);
    if (w1.x < 1.0) {
      if (enclosed) { b1 = mix(parentBound(L, m1, g1.f, g1.c, false, b1), b1, w1.x); }
      t1 = mix(parentBound(L, m1, g1.f, g1.c, enclosed, t1), t1, w1.x);
    }
    if (w2.x < 1.0) {
      if (enclosed) { b2 = mix(parentBound(L, m2, g2.f, g2.c, false, b2), b2, w2.x); }
      t2 = mix(parentBound(L, m2, g2.f, g2.c, enclosed, t2), t2, w2.x);
    }
    pts = array<vec3<f32>, 6>(vec3<f32>(m1, b1), vec3<f32>(m2, b2), vec3<f32>(m2, t2), vec3<f32>(m1, b1), vec3<f32>(m2, t2), vec3<f32>(m1, t1));
    let dir = normalize(m2 - m1);
    var hn = vec2<f32>(-dir.y, dir.x);
    // toward the present side for an enclosed gap (the air), away from it for the sky (the solid faces out)
    let toPresent = dot(hn, pa - m1) > 0.0;
    if (toPresent != enclosed) { hn = -hn; }
    nrm = vec3<f32>(hn, 0.0);
    lp = pts[s];
  }
  o.pos = vpOf(L) * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nrm;
  o.col = matColor(mat, select(0.0, 2.0, part == 2u));
  o.wp = worldOf(L, lp);
  return o;
}

/** (compute) the quads B draws: any corner with more than one gap; dinfo[level*4]: their count, +1: the most gaps */
@compute @workgroup_size(64)
fn scan(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = d.lvl;
  let L = u32(w.w);
  let qn = u32(w.z) - 1u;
  if (gid.x >= qn * qn) { return; }
  let qx = i32(gid.x % qn);
  let qy = i32(gid.x / qn);
  var mg = 1u;
  for (var q = 0u; q < 4u; q++) {
    let C = vec2<i32>(w.x + qx, w.y + qy) + cornerOf(q);
    mg = max(mg, gapCount(L, C.x, C.y));
  }
  // the top sheet's triangles: kept where all three corners' skies meet
  var mask = 3u;
  if (mg > 1u) {
    let base = vec2<i32>(w.x + qx, w.y + qy);
    for (var t = 0u; t < 2u; t++) {
      let c0 = base + cornerOf(triCorner(t, 0u));
      if (!(mutual(L, c0, 0u, base + cornerOf(triCorner(t, 1u))) == 0 && mutual(L, c0, 0u, base + cornerOf(triCorner(t, 2u))) == 0)) { mask &= ~(1u << t); }
    }
  }
  amaskW[d.misc2.x + gid.x] = mask;
  if (mg <= 1u) { return; }
  let at = atomicAdd(&dinfoW[L * 4u], 1u);
  qlistW[d.misc2.x + at] = u32(qx) | (u32(qy) << 16u);
  atomicMax(&dinfoW[L * 4u + 1u], mg);
}
/** (compute) B's indirect draw: 36 vertices, quads x 4 corners x the most gaps */
@compute @workgroup_size(1)
fn finish() {
  let L = u32(d.lvl.w);
  let n = atomicLoad(&dinfoW[L * 4u]);
  let g = atomicLoad(&dinfoW[L * 4u + 1u]);
  drawW[L * 4u] = 36u;
  drawW[L * 4u + 1u] = n * 4u * max(g, 1u);
  drawW[L * 4u + 2u] = 0u;
  drawW[L * 4u + 3u] = 0u;
}

const TINTS = array<vec3<f32>, 6>(vec3<f32>(0.35, 0.55, 1.0), vec3<f32>(1.0, 0.35, 0.3), vec3<f32>(1.0, 0.9, 0.25), vec3<f32>(0.35, 1.0, 0.45), vec3<f32>(0.9, 0.4, 1.0), vec3<f32>(0.3, 1.0, 1.0));

struct FOut {
  @location(0) color: vec4<f32>,
  @location(1) info: vec4<f32>,
}

fn hash2(p: vec2<f32>) -> f32 {
  let q = vec2<u32>(vec2<i32>(floor(p)));
  var h = (q.x * 0x9e3779b1u) ^ (q.y * 0x85ebca6bu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = h ^ (h >> 13u);
  return f32(h & 0xffffu) / 65535.0;
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
/** a triplanar pattern in world units (the same on every level, so the rim shows no change of pattern): value noise
 *  on the three axis planes blended by the normal, octaves from a root column down, each faded out before it is finer
 *  than a pixel. Steep faces and strips take the side planes, so nothing is stretched. */
fn pattern(p: vec3<f32>, n: vec3<f32>, px: f32) -> f32 {
  var bw = pow(abs(n), vec3<f32>(4.0));
  bw /= bw.x + bw.y + bw.z;
  // the three finest octaves (wavelengths 1, 1/4, 1/16 ... world units) still coarser than a pixel
  let top = clamp(floor(log2(0.4 / max(px, 1e-9)) * 0.5), 0.0, 9.0);
  let o0 = max(0.0, top - 2.0);
  var acc = 0.0;
  var norm = 0.0;
  for (var o = o0; o <= top; o += 1.0) {
    let f = pow(4.0, o);
    let vis = 1.0 - smoothstep(0.15, 0.4, px * f);
    let q = p * f + o * 17.0;
    acc += vis * (bw.x * vnoise(q.yz) + bw.y * vnoise(q.xz) + bw.z * vnoise(q.xy));
    norm += vis;
  }
  return select(0.5, acc / norm, norm > 1e-4);
}
/** px: world units a pixel (fwidth, taken before any discard) */
fn shade(v: VOut, px: f32) -> FOut {
  let n = normalize(v.nrm);
  let pat = pattern(v.wp, n, px);
  let sun = normalize(d.sun.xyz);
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = v.col * (0.84 + 0.32 * pat) * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  // info: r a surface was drawn, g the level, b not yet sharp (a parent where the focus wants its child, or a fading child)
  let wa = d.want;
  let coarse = wa.x < wa.z && v.local.x > wa.x && v.local.y > wa.y && v.local.x < wa.z && v.local.y < wa.w;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse || v.fade < 1.0), 1.0);
  return o;
}
fn cutAway(v: VOut) -> bool {
  let c = d.cut;
  return v.local.x > c.x && v.local.y > c.y && v.local.x < c.z && v.local.y < c.w;
}
@fragment
fn fs(v: VOut) -> FOut {
  let px = length(fwidth(v.wp));
  if (cutAway(v)) { discard; }
  return shade(v, px);
}
/** the top sheet: also the triangles the scan masked */
@fragment
fn fsA(v: VOut) -> FOut {
  let px = length(fwidth(v.wp));
  if (cutAway(v)) { discard; }
  let qn = d.lvl.z - 1;
  let fx = v.local.x - 0.5;
  let fy = v.local.y - 0.5;
  let qx = clamp(i32(floor(fx)), 0, qn - 1);
  let qy = clamp(i32(floor(fy)), 0, qn - 1);
  let t = select(1u, 0u, fx - f32(qx) >= fy - f32(qy));
  if (((amask[d.misc2.x + u32(qy * qn + qx)] >> t) & 1u) == 0u) { discard; }
  return shade(v, px);
}
