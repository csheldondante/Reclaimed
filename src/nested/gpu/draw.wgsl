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

fn tabLoad(i: u32) -> u32 { return tab[i]; }
fn pgLoad(i: u32) -> u32 { return pg[i]; }

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) col: vec3<f32>,
  @location(3) fade: f32,
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
      if (ivlAt(lid, X, Y, u32(j)).z0 > ivlAt(lid, X, Y, u32(j - 1)).z1) { break; }
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
    if (ivlAt(lid, X, Y, i).z0 > ivlAt(lid, X, Y, i - 1u).z1) { c++; }
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

/** A: the top sheet (the floor of the sky), one quad six vertices; a triangle whose corners' skies do not all meet
 *  (an overhang's roof beside the ground) is dropped here and drawn in B */
@vertex
fn vs(@builtin(vertex_index) vv: u32) -> VOut {
  let w = d.lvl;
  let L = u32(w.w);
  let qn = u32(w.z) - 1u;
  let quad = vv / 6u;
  let t = (vv % 6u) / 3u;
  let q = cornerOf(triCorner(t, vv % 3u));
  let i = i32(quad % qn) + q.x;
  let j = i32(quad / qn) + q.y;
  let X = w.x + i;
  let Y = w.y + j;
  let base = vec2<i32>(w.x + i32(quad % qn), w.y + i32(quad / qn));
  let c0 = base + cornerOf(triCorner(t, 0u));
  let c1 = base + cornerOf(triCorner(t, 1u));
  let c2 = base + cornerOf(triCorner(t, 2u));
  var keep = gapCount(L, c0.x, c0.y) == 1u && gapCount(L, c1.x, c1.y) == 1u && gapCount(L, c2.x, c2.y) == 1u;
  if (!keep) { keep = mutual(L, c0, 0u, c1) == 0 && mutual(L, c0, 0u, c2) == 0; }
  if (!keep) {
    var o: VOut;
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return o;
  }
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
  let b = 32u + L * 24u;
  let vp = mat4x4<f32>(
    vec4<f32>(cam[b], cam[b + 1u], cam[b + 2u], cam[b + 3u]),
    vec4<f32>(cam[b + 4u], cam[b + 5u], cam[b + 6u], cam[b + 7u]),
    vec4<f32>(cam[b + 8u], cam[b + 9u], cam[b + 10u], cam[b + 11u]),
    vec4<f32>(cam[b + 12u], cam[b + 13u], cam[b + 14u], cam[b + 15u]));
  o.pos = vp * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nr;
  o.col = c;
  o.fade = fade;
  return o;
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
  for (var q = 0u; q < 4u; q++) {
    let C = base + cornerOf(q);
    var m = i32(g);
    if (q != ac) { m = mutual(L, A, g, C); }
    if (m >= 0) {
      pres[q] = true;
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
  if (part < 2u) {
    let za = select(ga.f, ga.c, part == 1u);
    let zb = select(gb.f, gb.c, part == 1u);
    if (np == 3u) {
      let zx = select(gp[cx].f, gp[cx].c, part == 1u);
      pts = array<vec3<f32>, 6>(vec3<f32>(pa, za), vec3<f32>(pb, zb), vec3<f32>(px, zx), vec3<f32>(pa, za), vec3<f32>(pa, za), vec3<f32>(pa, za));
    } else if (np == 2u) {
      let mbx = vec3<f32>(0.5 * (pb + px), zb);
      let max_ = vec3<f32>(0.5 * (pa + px), za);
      pts = array<vec3<f32>, 6>(vec3<f32>(pa, za), vec3<f32>(pb, zb), mbx, vec3<f32>(pa, za), mbx, max_);
    } else {
      let mab = vec3<f32>(0.5 * (pa + pb), za);
      let mak = vec3<f32>(0.5 * (pa + px), za);
      pts = array<vec3<f32>, 6>(vec3<f32>(pa, za), mab, mak, vec3<f32>(pa, za), vec3<f32>(pa, za), vec3<f32>(pa, za));
    }
    nrm = cross(pts[1] - pts[0], pts[2] - pts[0]);
    if (length(nrm) < 1e-12) { nrm = vec3<f32>(0.0, 0.0, 1.0); }
    nrm = normalize(nrm) * select(1.0, -1.0, (nrm.z < 0.0) != (part == 1u));
    if (part == 1u) { mat = ga.cm; }
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
    let b1 = select(g1.rb, g1.f, enclosed);
    let t1 = select(g1.f, g1.c, enclosed);
    let b2 = select(g2.rb, g2.f, enclosed);
    let t2 = select(g2.f, g2.c, enclosed);
    pts = array<vec3<f32>, 6>(vec3<f32>(m1, b1), vec3<f32>(m2, b2), vec3<f32>(m2, t2), vec3<f32>(m1, b1), vec3<f32>(m2, t2), vec3<f32>(m1, t1));
    let dir = normalize(m2 - m1);
    var hn = vec2<f32>(-dir.y, dir.x);
    // toward the present side for an enclosed gap (the air), away from it for the sky (the solid faces out)
    let toPresent = dot(hn, pa - m1) > 0.0;
    if (toPresent != enclosed) { hn = -hn; }
    nrm = vec3<f32>(hn, 0.0);
  }
  let lp = pts[s];
  let b = 32u + L * 24u;
  let vp = mat4x4<f32>(
    vec4<f32>(cam[b], cam[b + 1u], cam[b + 2u], cam[b + 3u]),
    vec4<f32>(cam[b + 4u], cam[b + 5u], cam[b + 6u], cam[b + 7u]),
    vec4<f32>(cam[b + 8u], cam[b + 9u], cam[b + 10u], cam[b + 11u]),
    vec4<f32>(cam[b + 12u], cam[b + 13u], cam[b + 14u], cam[b + 15u]));
  o.pos = vp * vec4<f32>(lp, 1.0);
  o.local = lp.xy;
  o.nrm = nrm;
  o.col = matColor(mat, select(0.0, 2.0, part == 2u));
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

@fragment
fn fs(v: VOut) -> FOut {
  let c = d.cut;
  if (v.local.x > c.x && v.local.y > c.y && v.local.x < c.z && v.local.y < c.w) { discard; }
  let n = normalize(v.nrm);
  let sun = normalize(d.sun.xyz);
  let lit = 0.35 + 0.65 * max(dot(n, sun), 0.0) + 0.12 * n.z;
  var col = v.col * lit;
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * lit * 0.8, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  // info: r a surface was drawn, g the level, b not yet sharp (a parent where the focus wants its child, or a fading child)
  let wa = d.want;
  let coarse = wa.x < wa.z && v.local.x > wa.x && v.local.y > wa.y && v.local.x < wa.z && v.local.y < wa.w;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse || v.fade < 1.0), 1.0);
  return o;
}
