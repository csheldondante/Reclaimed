// ---- nested/gpu/cliff5.wgsl: ?cliff=5, the cliff rule drawn on real terrain (round 32 step B2) ------------------------
// A separate module variant (src/nested/cliffbox.ts): the draw module, CR_LV / CR_UPL / CR_AMPL, cliffrule.wgsl and this
// file. Reads the per-cell table built by cliffbuild.wgsl (group 1: binding 0 the table, binding 1 the box list), never
// the column pages.
//   fsST5: the textured sheets with every pixel over a SPLIT cell discarded (the box replaces the stretched sheet there).
//   vsBox5 / fsBox5: one box an instance per SPLIT cell (footprint the 16 m cell, from L to H), drawn with level CR_LV's
//   uniforms; the fragment marches the cell's fine quadtree inside its box (crNodeUp: could any / must every descendant
//   be up), front to back, from the box face (or the eye when it is inside the box). A ray that leaves the box: discard.
//   Depth is the box face's (logged limit).
// Not yet: notches (?cliffGap), shadows.

// (the table, then the box list after its n x n records: one buffer, so the box draw binds one storage buffer to the
// vertex stage beside the camera and the registry: cliffbox.ts)
@group(1) @binding(0) var<storage, read> crTab: array<u32>;

// ---- (round 32 step B6) notches, ?cliffGap=1 with ?cliff=5: cliffrule.ts notchLevel / notchAt (notchFrac spans, the
// O(1) margin depth test, no erosion) in the march. Parameters in a small uniform of the box pass (cliffbox.ts setNotch:
// written when they change, never per frame): pct / dep per level 1..6 (index l: [l >> 2][l & 3]); f = (notchFrac[0] and
// [1] x 256, on, slotLog)
struct Cr5NU {
  pct: array<vec4<i32>, 2>,
  dep: array<vec4<i32>, 2>,
  f: vec4<i32>,
}
@group(1) @binding(1) var<uniform> crN: Cr5NU;
fn cr5Pct(l: u32) -> i32 { return crN.pct[l >> 2u][l & 3u]; }
fn cr5Dep(l: u32) -> i32 { return crN.dep[l >> 2u][l & 3u]; }
/** notchLevel (notchFrac branch, notchMargin): level l's notch air [lo, hi) at z (units) in fine column (gx, gy, global) of
 *  split cell r, given the column's margin over the threshold; x > y for none */
fn cr5NotchLv(r: CrCell, cx: i32, cy: i32, gx: i32, gy: i32, z: i32, l: u32, margin: i32) -> vec2<i32> {
  let none = vec2<i32>(1, 0);
  let pct = cr5Pct(l);
  if (pct <= 0) { return none; }
  let c = CR_U >> l;
  let ksh = CR_LF - l;
  let alongX = abs(r.a) < abs(r.b);
  let ka = select(gy, gx, alongX) >> (ksh + u32(crN.f.w));
  let kb = select(cx, cy, alongX);
  let ks = 1 << ksh;
  let mk = crMaskAt(2 * (gx >> ksh) * ks + ks, 2 * (gy >> ksh) * ks + ks);
  // (this level's top cell is never a notch; erosion is off)
  let topLim = r.H - c;
  if (z < r.L || z >= topLim) { return none; }
  let D = r.H - r.L;
  let f0 = crN.f.x;
  let f1 = max(f0, crN.f.y);
  var s0 = r.L;
  for (var k = 0; k < 64; k++) {
    let hk = crHash3(ka, kb, crSalt(0x400 + i32(l)) ^ bitcast<i32>(u32(k) * 0x27d4eb2du));
    let len = max(c, (D * (f0 + i32((hk >> 8u) % u32(f1 - f0 + 1)))) >> 8u);
    if (z < s0 + len) {
      if (hk % 25600u >= u32(pct * mk)) { return none; }
      let h2 = crMix(hk);
      let dC = 1 + i32((h2 >> 16u) % u32(max(1, cr5Dep(l))));
      if (margin < dC * ks * 2 * r.A * CR_TIE) { return vec2<i32>(s0, min(s0 + len, topLim)); }
      return none;
    }
    s0 += len;
  }
  return none;
}
fn cr5NotchAny(r: CrCell, cx: i32, cy: i32, gx: i32, gy: i32, z: i32, margin: i32) -> vec2<i32> {
  for (var l = 1u; l <= CR_LF; l++) {
    let n = cr5NotchLv(r, cx, cy, gx, gy, z, l, margin);
    if (n.x < n.y) { return n; }
  }
  return vec2<i32>(1, 0);
}
/** notchAt: the union of every level's notch air round z, merged with overlapping ones above and below */
fn cr5Notch(r: CrCell, cx: i32, cy: i32, gx: i32, gy: i32, z: i32, margin: i32) -> vec2<i32> {
  var n = cr5NotchAny(r, cx, cy, gx, gy, z, margin);
  if (n.x >= n.y) { return n; }
  for (var i = 0; i < 8; i++) {
    let b = cr5NotchAny(r, cx, cy, gx, gy, n.x - 1, margin);
    let a = cr5NotchAny(r, cx, cy, gx, gy, n.y, margin);
    let hb = b.x < b.y;
    let ha = a.x < a.y;
    if (!hb && !ha) { break; }
    if (hb) { n.x = min(n.x, b.x); }
    if (ha) { n.y = max(n.y, a.y); }
  }
  return n;
}
/** a level-l node's margin over the threshold (TIE units) at its centre, the finer offsets as zero (crIsUpLod's score) */
fn cr5MarginLod(r: CrCell, cx: i32, cy: i32, l: u32, jx: i32, jy: i32, known: i32) -> i32 {
  let s = CR_N >> l;
  let inBlock = l >= CR_LF - CR_WSH;
  let pc = select(2 * jx * s + s - CR_N, crWCentre((jx * s) >> CR_WSH), inBlock);
  let qc = select(2 * jy * s + s - CR_N, crWCentre((jy * s) >> CR_WSH), inBlock);
  let tie = select(CR_TIE >> 1u, crTieOf((cx << CR_LF) + jx, (cy << CR_LF) + jy), s == 1);
  return (r.a * pc + r.b * qc + known) * CR_TIE + tie - crThetaUsed(r);
}

/** (cliffrule.wgsl's crKindOf needs a height source; the draw never derives a cell, it reads the table) */
fn crH(x: i32, y: i32) -> i32 { return 0; }
fn crT() -> i32 { return 2; }

/** the march's step cap (nodes visited a pixel) */
const CR5_CAP: i32 = 96;

/** the table's window (cl3.yzw: gx, gy, n of the window the table was built for) */
fn cr5Win() -> vec3<i32> { return vec3<i32>(i32(d.cl3.y), i32(d.cl3.z), i32(d.cl3.w)); }
/** a cell's record (window-local index) as the rule's CrCell */
fn cr5Cell(i: u32) -> CrCell {
  let b = i * CR_REC;
  let w0 = crTab[b];
  var r: CrCell;
  r.kind = w0 & 3u;
  r.saddle = ((w0 >> 2u) & 1u) != 0u;
  r.a = i32((w0 >> 4u) & 15u) - 8;
  r.b = i32((w0 >> 8u) & 15u) - 8;
  r.A = max(abs(r.a), abs(r.b));
  r.B = min(abs(r.a), abs(r.b));
  r.H = bitcast<i32>(crTab[b + 1u]);
  r.L = bitcast<i32>(crTab[b + 2u]);
  r.theta = bitcast<i32>(crTab[b + 3u]);
  r.dTheta = bitcast<i32>(crTab[b + 4u]);
  r.h = bitcast<i32>(crTab[b + 5u]);
  // (F is not stored: w6 holds the box's bottom, read by the box draw itself)
  r.F = 0;
  return r;
}

/** the sheets' vertex output with the 16 m level's z origin (world units) added: the fragment stage cannot read the
 *  registry (reg is bound to the vertex stage only) */
struct VOutS5 {
  @builtin(position) pos: vec4<f32>,
  @location(0) q: vec3<f32>,
  @location(1) @interpolate(flat) mat: u32,
  @location(2) wp: vec3<f32>,
  @location(3) dEye: f32,
  @location(4) toEye: vec3<f32>,
  @location(5) vn: vec3<f32>,
  @location(6) @interpolate(flat) zo: f32,
  @location(7) @interpolate(flat) zo1: f32,
}
/** draw.wgsl vsSheet, with zo1 */
@vertex
fn vsSheet5(@builtin(vertex_index) vv: u32, @builtin(instance_index) inst: u32) -> VOutS5 {
  let s = sheetVert(inst, vv / 3u, vv % 3u);
  var o: VOutS;
  if (!s.ok) {
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  } else {
    o = smoothOut(s.lp, s.kid, s.mat);
    if (s.nrm != 0u) { o.vn = octDec(s.nrm); }
  }
  return VOutS5(o.pos, o.q, o.mat, o.wp, o.dEye, o.toEye, o.vn, o.zo, zOrigW(CR_LV));
}

@fragment
fn fsST5(v: VOutS5) -> FOut {
  // (derivatives first, as fsST)
  let qx = dpdx(v.q);
  let qy = dpdy(v.q);
  let pxL = footprint(qx, qy);
  let cr = cross(qx, qy);
  let cl = length(cr);
  var n = select(vec3<f32>(0.0, 0.0, 1.0), cr / cl, cl > 0.0);
  if (dot(n, v.toEye) < 0.0) { n = -n; }
  let vl = length(v.vn);
  if (vl > 1e-3) {
    let nv = v.vn / vl;
    if (dot(nv, n) >= d.sun.w) { n = nv; }
  }
  // the pixel's 16 m cell (as cliff4.wgsl): 2^e fine columns a column of the drawn level
  let g = cr5Win();
  let e = 6 - i32(round(log2(d.misc.w))) * (i32(d.lvl.w) - i32(CR_LV));
  if (g.z > 0 && e >= 0) {
    let fi = (d.lvl.xy << vec2<u32>(u32(e))) + vec2<i32>(floor(ldexp(v.q.xy, vec2<i32>(e))));
    let c = (fi >> vec2<u32>(6u)) - g.xy;
    if (c.x >= 0 && c.y >= 0 && c.x < g.z && c.y < g.z) {
      // (the box closes the cell: up to a higher sheet neighbour's edge too, fsBox5's side walls)
      if ((crTab[u32(c.y * g.z + c.x) * CR_REC] & 3u) == CR_SPLIT) { discard; }
    }
  }
  return texOut(v.q, v.zo, n, v.mat, pxL, v.toEye, v.dEye);
}

struct VBox {
  @builtin(position) pos: vec4<f32>,
  /** the point on the box, level CR_LV's local units (window-relative x, y) */
  @location(0) q: vec3<f32>,
  /** toward the eye, local units */
  @location(1) toEye: vec3<f32>,
  @location(2) dEye: f32,
  @location(3) @interpolate(flat) zo: f32,
  /** the cell's window-local index into the table */
  @location(4) @interpolate(flat) cell: u32,
  /** the face: 0 +x, 1 -x, 2 +y, 3 -y, 4 top, 5 bottom */
  @location(5) @interpolate(flat) face: u32,
  /** the cell's window-local origin (table window), local units relative to the drawn window */
  @location(6) @interpolate(flat) org: vec2<f32>,
  /** the eye, level CR_LV's local units (flat: exact, where an interpolated point plus toEye wobbles per pixel) */
  @location(7) @interpolate(flat) eye: vec3<f32>,
}
const CR5_TRI = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);

// ---- (step B3) the box pass's cost where boxes overlap on screen (NS-292) --------------------------------------------
/** (B3) back faces collapsed in the vertex stage when the eye is outside the box (the fragment stage discarded them) */
override CR5_CULL: bool = true;
/** (B3) the box list read in a front-to-back order (the build's two diagonal lists, cliffbuild.wgsl crSort*) */
override CR5_ORDER: bool = true;
// (B3, measured and not kept: the box's solid part below L drawn first as plain faces; branch exp/nested-b3-low)

/** (B3) the box list entry for instance inst: with CR5_ORDER the diagonal list whose order is front to back for the
 *  camera's forward direction (its quadrant in plan; a list read backwards for the opposite quadrant): a ray in that
 *  quadrant crosses cells in nondecreasing (or nonincreasing) x and y, so a box that can hide another comes first.
 *  Table tail: [n x n records][the unordered list, n x n][count][list by x + y, n x n][list by x - y, n x n] */
fn cr5Entry(inst: u32) -> u32 {
  let g = cr5Win();
  let nn = u32(g.z * g.z);
  let tail = CR_REC * nn;
  if (!CR5_ORDER) { return crTab[tail + inst]; }
  let cnt = crTab[tail + nn];
  // (the camera's forward in the level's local frame: the view-projection's w row, the same for every instance)
  let m = vpOf(CR_LV) * d.model;
  let fw = vec2<f32>(m[0].w, m[1].w);
  // (x + y ascending is front to back when forward has fx >= 0 and fy >= 0; x - y ascending when fx >= 0, fy <= 0)
  let diagB = (fw.x >= 0.0) != (fw.y >= 0.0);
  let rev = select(fw.x + fw.y < 0.0, fw.x - fw.y < 0.0, diagB);
  let k = select(inst, cnt - 1u - min(inst, cnt - 1u), rev);
  return crTab[tail + nn + 1u + select(0u, nn, diagB) + k];
}
/** (B3) the eye in the cell's frame (fine columns: x, y 0..64, z units / 16) and whether it is inside the box (Lb..Ht):
 *  the same expressions as fsBox5's, so the vertex cull agrees with the fragment test */
fn cr5Inside(eye: vec3<f32>, org: vec2<f32>, idx: u32) -> bool {
  let eyeP = vec3<f32>((eye.xy - org) * 64.0, eye.z * 64.0);
  let Lbf = f32(bitcast<i32>(crTab[idx * CR_REC + 6u])) / 16.0;
  let Htf = f32(cr5Top(idx)) / 16.0;
  return all(eyeP.xy > vec2<f32>(0.0)) && all(eyeP.xy < vec2<f32>(64.0)) && eyeP.z > Lbf && eyeP.z < Htf;
}

@vertex
fn vsBox5(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VBox {
  var o: VBox;
  let g = cr5Win();
  let ent = cr5Entry(inst);
  let lx = i32(ent & 0xffffu);
  let ly = i32(ent >> 16u);
  let idx = u32(ly * g.z + lx);
  let H = cr5Top(idx);
  // (from the box's bottom Lb, below L: its sides reach any lower neighbouring floor or sheet)
  let L = bitcast<i32>(crTab[idx * CR_REC + 6u]);
  let f = vi / 6u;
  let k = CR5_TRI[vi % 6u];
  let u = f32(k == 1u || k == 2u);
  let w = f32(k >= 2u);
  var c = vec3<f32>(u, w, 0.0);
  switch (f) {
    case 0u: { c = vec3<f32>(1.0, u, w); }
    case 1u: { c = vec3<f32>(0.0, w, u); }
    case 2u: { c = vec3<f32>(w, 1.0, u); }
    case 3u: { c = vec3<f32>(u, 0.0, w); }
    case 4u: { c = vec3<f32>(u, w, 1.0); }
    default: { c = vec3<f32>(w, u, 0.0); }
  }
  // (the table's window and the drawn window may differ while a new table waits for the store to settle: the cell is
  // placed by its global column)
  let org = vec2<f32>(vec2<i32>(g.x + lx, g.y + ly) - d.lvl.xy);
  let lp = vec3<f32>(org + c.xy, mix(f32(L), f32(H), c.z) / CR_UPL);
  o.pos = vpOf(CR_LV) * (d.model * vec4<f32>(lp, 1.0));
  let eb = 32u + CR_LV * 24u;
  let eye = vec3<f32>(cam[eb + 16u], cam[eb + 17u], cam[eb + 18u]);
  // (B3) a face the fragment stage would discard at every pixel is collapsed here: with the eye outside the box, a face
  // turned away from it and the bottom (fsBox5: !inside && (!front || face 5)). The faces are axis-aligned, so "turned
  // away" is the same at every vertex of a face
  if (CR5_CULL && !cr5Inside(eye, org, idx) && (f == 5u || dot(NRM[f], eye - lp) <= 0.0)) { o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0); }
  o.q = lp;
  o.toEye = eye - lp;
  o.dEye = length(o.toEye);
  o.zo = zOrigW(CR_LV);
  o.cell = idx;
  o.face = f;
  o.org = org;
  o.eye = eye;
  return o;
}

/** the box's top, units: H, or higher where a sheet neighbour's edge wall is (the air over the columns up to it is
 *  marched too, so the wall closes the gap under that sheet's edge) */
fn cr5Top(i: u32) -> i32 {
  let b = i * CR_REC;
  let w = max(max(bitcast<i32>(crTab[b + 8u]), bitcast<i32>(crTab[b + 9u])), max(bitcast<i32>(crTab[b + 10u]), bitcast<i32>(crTab[b + 11u])));
  return max(bitcast<i32>(crTab[b + 1u]), w);
}
/** the textured shading of a march hit (texOut's inputs, level CR_LV's uniform); a column face takes the face normal, a
 *  soft fill and the recess occlusion */
fn cr5Shade(q: vec3<f32>, zo: f32, n: vec3<f32>, mat: u32, pxL: f32, toEye: vec3<f32>, dEye: f32, side: bool, ao: f32) -> vec3<f32> {
  let gz = i32(d.geo.z);
  let s = levelS() - gz;
  let sc = ldexp(1.0, -s);
  var si: ShadeIn;
  si.p = DPt(d.lvl.xy, s, ldexp(zo, gz), q);
  si.fog = select(-1.0, fogAt(u32(d.lvl.w), dEye), d.geo.y > 0.0);
  si.ng = n;
  si.mat = mat;
  si.pxW = pxL * sc;
  si.view = -normalize(toEye);
  si.distW = dEye * sc;
  si.sun = normalize(d.sun.xyz);
  si.split = select(-1.0, f32(s), d.misc.y > 0.5);
  si.nb = d.want.z;
  si.canopy = d.want.y;
  if (side) {
    si.colW = 1.0;
    si.colN = n;
    // (the strata, cl3.x on: a brightness by world height; the pixel's size in metres for the fade)
    var st = 1.0;
    if (d.cl3.x > 0.5) {
      let k = pow(d.misc.w, f32(CR_LV));
      let mpl = d.geo.x / k;
      let pm = vec3<f32>((vec2<f32>(d.lvl.xy) + q.xy) * mpl, (zo + q.z / k) * d.geo.x);
      st = cr5Strata(pm, pxL * mpl);
    }
    si.colTint = st;
    si.colAo = ao;
    // (a fill strong enough that a face turned from the sun stays readable stone: shFinish adds colFill x the sun x a
    // squared half-Lambert; at 1.0 the darkest faces in side2 read 35 against ~100-120 for sunlit stone (display
    // luminance), so 1.6: see DEVLOG)
    si.colFill = CR5_FILL;
  }
  return texShade(si);
}
const CR5_FILL: f32 = 1.6;

// ---- (step B2) strata on the column faces: shading only, a function of the world position alone (metres) ----------
/** a hashed value in -1..1 for layer boundary or layer k */
fn cr5Hs(k: i32, salt: i32, lane: i32) -> f32 { return f32(crHash3(k, lane, salt) & 1023u) / 511.5 - 1.0; }
/** one scale of layers along z: nominal thickness T, each boundary moved by up to J (< T / 2, so they stay in order), a
 *  hashed brightness of +-amp a layer, faded out where a layer is under about 2 pixels (pxM metres a pixel) */
fn cr5Layer(z: f32, T: f32, J: f32, salt: i32, pxM: f32, amp: f32) -> f32 {
  let j0 = i32(floor(z / T));
  var j = j0;
  if (z < f32(j0) * T + J * cr5Hs(j0, salt, 1)) {
    j = j0 - 1;
  } else if (z >= f32(j0 + 1) * T + J * cr5Hs(j0 + 1, salt, 1)) {
    j = j0 + 1;
  }
  let fade = smoothstep(1.0, 3.0, T / max(pxM, 1e-6));
  return 1.0 + amp * cr5Hs(j, salt, 2) * fade;
}
/** the strata brightness at world point pm (metres): two scales (layers of 0.5-3.5 m and 0.16-1 m), the layers drifting
 *  up and down slowly along the wall (value noise over plan position, up to about +-2.8 m) */
fn cr5Strata(pm: vec3<f32>, pxM: f32) -> f32 {
  let dz = 2.0 * (2.0 * vnoise(pm.xy / 80.0) - 1.0) + 0.8 * (2.0 * vnoise(pm.xy / 23.0 + vec2<f32>(17.0)) - 1.0);
  let z = pm.z + dz;
  return cr5Layer(z, 2.0, 0.75, 0x7101, pxM, 0.24) * cr5Layer(z, 0.6, 0.22, 0x7202, pxM, 0.10);
}

/** (B3) the shading of the box's side below L (the ground's own wall down to a lower neighbour: no march) */
fn cr5Low(v: VBox) -> FOut {
  let P = vec3<f32>((v.q.xy - v.org) * 64.0, v.q.z * 64.0);
  let q0 = vec3<f32>(P.xy / 64.0 + v.org, P.z / 64.0);
  let n0 = NRM[v.face];
  let c0 = cr5Shade(q0, v.zo, n0, 1u, d.cl.x * v.dEye, v.toEye, v.dEye, true, 0.8);
  var o0: FOut;
  o0.color = vec4<f32>(c0, 1.0);
  o0.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, 0.0, select(1.0, 0.5, u32(d.cl.z) == 12u));
  return o0;
}

/** a box fragment's march: code 0 nothing (discard), 1 the side below L (cr5Low), 2 marched (hk 0: a miss) */
struct Cr5M {
  code: u32,
  hk: u32,
  hp: vec3<f32>,
  axis: u32,
  dir: vec3<f32>,
  steps: i32,
  start: vec3<f32>,
  eyeP: vec3<f32>,
  /** (B6) the last notch's depth into the face at its node, fine columns (the hollow's darkening) */
  nd: f32,
}

@fragment
fn fsBox5(v: VBox) -> FOut {
  let m = cr5March(v);
  if (m.code == 0u) { discard; }
  if (m.code == 1u) { return cr5Low(v); }
  let steps = m.steps;
  var hk = m.hk;
  let hp = m.hp;
  let dir = m.dir;
  let axis = m.axis;
  let eyeP = m.eyeP;
  let mat = (crTab[v.cell * CR_REC] >> 12u) & 15u;
  // (?cliffDbg=12: march steps / CR5_CAP, flat, misses included; 13 the hit kind. The info target carries the steps in b
  // (/255) and 0.5 in a, so a readback can count them: scripts/nested-rB2-stills.mjs)
  if (u32(d.cl.z) == 12u || u32(d.cl.z) == 13u) {
    var o: FOut;
    let t = f32(steps) / f32(CR5_CAP);
    o.color = vec4<f32>(select(vec3<f32>(t, 1.0 - abs(2.0 * t - 1.0), 1.0 - t), TINTS[hk % 6u], u32(d.cl.z) == 13u), 1.0);
    o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, f32(steps) / 255.0, 0.5);
    // (13: a miss is discarded as in the plain draw, so coplanar faces of neighbouring boxes do not fight)
    if (hk == 0u && u32(d.cl.z) == 13u) { discard; }
    return o;
  }
  if (hk == 0u) { discard; }
  var nrm = vec3<f32>(0.0, 0.0, 1.0);
  // (4: a sheet neighbour's edge wall, shaded as a column side)
  if (hk == 4u) { hk = 1u; }
  if (hk == 1u || hk == 7u) { nrm = select(vec3<f32>(0.0, -sign(dir.y), 0.0), vec3<f32>(-sign(dir.x), 0.0, 0.0), axis == 0u); }
  // (B6) a notch's ceiling faces down; its floor (a ledge) up
  if (hk == 6u) { nrm = vec3<f32>(0.0, 0.0, -1.0); }
  let q = vec3<f32>(hp.xy / 64.0 + v.org, hp.z / 64.0);
  let toEye = (eyeP - hp) / 64.0;
  let dE = length(toEye);
  // the recess: darker the further the hit lies in from where the ray entered the box (plan distance, fine columns)
  var ao = mix(1.0, 0.55, smoothstep(0.0, 32.0, length((hp - m.start).xy)));
  // (B6) inside a notch (floor, ceiling, back): darker by its depth into the face (fine columns; 32 = 8 m), the ceiling
  // darker still
  let stone = hk == 1u || hk >= 5u;
  if (hk >= 5u) { ao *= mix(0.85, 0.35, smoothstep(0.0, 32.0, m.nd)) * select(1.0, 0.5, hk == 6u); }
  let col = cr5Shade(q, v.zo, nrm, select(mat, 1u, stone), d.cl.x * dE, toEye, dE, stone, ao);
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, 0.0, 1.0);
  return o;
}

/** (B3, measurement only: render.cliffCount) the box pass's overdraw, added into an rgba16float target: CNT_ALL with no
 *  depth test, every fragment rasterized in r and those past the front test in g; CNT_DEPTH against the depth so far,
 *  the fragments that march in b and their march steps in a */
@fragment
fn fsBox5CntAll(v: VBox) -> @location(0) vec4<f32> {
  let m = cr5March(v);
  return vec4<f32>(1.0, select(1.0, 0.0, m.code == 0u), 0.0, 0.0);
}
@fragment
fn fsBox5CntDepth(v: VBox) -> @location(0) vec4<f32> {
  let m = cr5March(v);
  return vec4<f32>(0.0, 0.0, select(0.0, 1.0, m.code == 2u), select(0.0, f32(m.steps), m.code == 2u));
}

/** (B8, measurement only: BoxOpt.notchB6) the march as step B6 built it, the BEFORE of NS-307: descends to the level of
 *  detail first, then tests every level's notch at each solid node and walks a notch's air node by node there */
override CR5_NOTCH_B6: bool = false;

fn cr5March(v: VBox) -> Cr5M {
  if (CR5_NOTCH_B6) { return cr5MarchB6(v); }
  return cr5MarchCF(v);
}

fn cr5MarchB6(v: VBox) -> Cr5M {
  var res: Cr5M;
  res.code = 0u;
  let r = cr5Cell(v.cell);
  let mm = bitcast<i32>(crTab[v.cell * CR_REC + 7u]);
  let g = cr5Win();
  let cx = g.x + i32(v.cell % u32(g.z));
  let cy = g.y + i32(v.cell / u32(g.z));
  // the cell's frame: fine columns across (0..64), z in fine columns too (16 units each)
  let P = vec3<f32>((v.q.xy - v.org) * 64.0, v.q.z * 64.0);
  let eyeP = vec3<f32>((v.eye.xy - v.org) * 64.0, v.eye.z * 64.0);
  let dir = normalize(P - eyeP);
  let Hf = f32(r.H) / 16.0;
  let Lf = f32(r.L) / 16.0;
  // (the box reaches down to Lb; inside it everything below L is solid ground)
  let Lbf = f32(bitcast<i32>(crTab[v.cell * CR_REC + 6u])) / 16.0;
  // (the box's top: H or a higher sheet neighbour's edge wall)
  let Htf = f32(cr5Top(v.cell)) / 16.0;
  let inside = all(eyeP.xy > vec2<f32>(0.0)) && all(eyeP.xy < vec2<f32>(64.0)) && eyeP.z > Lbf && eyeP.z < Htf;
  let front = dot(NRM[v.face], v.toEye) > 0.0;
  if (!inside && (!front || v.face == 5u)) { return res; }
  var p = select(P, eyeP, inside);
  res.start = p;
  res.eyeP = eyeP;
  res.dir = dir;
  // the entry axis: 0 x, 1 y, 2 the top, 3 none (the eye inside)
  var axis = select(select(select(2u, 1u, v.face == 2u || v.face == 3u), 0u, v.face <= 1u), 3u, inside);
  // (a side face entered below L: the ground's own wall down to a lower neighbour (cr5Low); the eye below L: inside the
  // ground)
  if (p.z < Lf) {
    res.code = select(1u, 0u, inside);
    return res;
  }
  res.code = 2u;
  // the finest level wanted: its cells at least ?cliffPx= pixels (d.cl.y) at the distance reached along the ray (d.cl.x a
  // pixel per unit of distance), chosen again at every step
  let pxK = d.cl.x * 64.0 * max(d.cl.y, 0.25);
  // the remaining amplitude below each level (the mask at its bound)
  var amp: array<i32, 7>;
  for (var k = 1u; k <= 6u; k++) { amp[k] = crAmpOf(r.A, k, mm); }
  var ra: array<i32, 7>;
  ra[6] = 0;
  for (var k = 5; k >= 0; k--) { ra[k] = ra[k + 1] + amp[k + 1]; }
  var known: array<i32, 7>;
  known[0] = 0;
  var ix = clamp(i32(floor(p.x)), 0, 63);
  var iy = clamp(i32(floor(p.y)), 0, 63);
  var l = 0u;
  // hit: 0 none (miss), 1 a column's side, 2 a column's top, 3 the floor
  var hk = 0u;
  var hp = p;
  var steps = 0;
  var solid = false;
  // (B6, ?cliffGap=1) notches: the node's air interval [lo, hi) in units when it is a notch; whether the ray came from one
  let notchOn = crN.f.z != 0;
  var wasNotch = false;
  res.nd = 0.0;
  loop {
    if (steps >= CR5_CAP) { break; }
    let dist = length(p - eyeP) / 64.0;
    let lt = u32(clamp(floor(6.0 - log2(max(pxK * dist, 1e-6))), 0.0, 6.0));
    l = min(l, lt);
    // descend from level l (known[] valid down to it) to the node that decides; every node looked at is a step
    solid = false;
    // (B6: with notches on, a node all up below H still descends to the level wanted: its notches are per column)
    let deep = notchOn && p.z < Hf;
    loop {
      steps++;
      let jx = ix >> (6u - l);
      let jy = iy >> (6u - l);
      let nb = crNodeUp(r, l, jx, jy, known[l], ra[l]);
      if (!nb.x) { break; }
      if (nb.y && !(deep && l < lt)) {
        solid = true;
        break;
      }
      if (l >= lt) {
        solid = crIsUpLod(r, cx, cy, l, jx, jy, known[l]);
        break;
      }
      l++;
      known[l] = known[l - 1u] + crLevelOff(r, cx, cy, l, ix >> (6u - l), iy >> (6u - l));
    }
    // (B6) a solid node below H may be a notch at the ray's height: the node's centre column, its margin at this level
    var nl = vec2<i32>(1, 0);
    if (solid && deep) {
      let s = 64 >> l;
      let jx = ix >> (6u - l);
      let jy = iy >> (6u - l);
      let mg = cr5MarginLod(r, cx, cy, l, jx, jy, known[l]);
      nl = cr5Notch(r, cx, cy, (cx << 6u) + jx * s + (s >> 1), (cy << 6u) + jy * s + (s >> 1), i32(floor(p.z * 16.0)), mg);
      if (nl.x < nl.y) {
        solid = false;
        res.nd = f32(mg) / f32(2 * max(r.A, 1) * CR_TIE);
      }
    }
    let inN = nl.x < nl.y;
    if (solid && p.z <= Hf + 1e-3) {
      if (axis == 3u) { break; }
      // (entered from the box's top above H: the column's top, reached by falling onto it; B6: from a notch's air, its
      // back)
      hk = select(select(1u, 7u, wasNotch), 2u, axis == 2u);
      hp = p;
      break;
    }
    // through the node's air to its exit: onto the floor (an empty node), onto the tops (a solid node, the ray above H), or
    // out of the box's top
    let s = 64 >> l;
    let x0 = f32((ix >> (6u - l)) * s);
    let y0 = f32((iy >> (6u - l)) * s);
    let tx = select(select(1e30, (x0 - p.x) / dir.x, dir.x < 0.0), (x0 + f32(s) - p.x) / dir.x, dir.x > 0.0);
    let ty = select(select(1e30, (y0 - p.y) / dir.y, dir.y < 0.0), (y0 + f32(s) - p.y) / dir.y, dir.y > 0.0);
    let tEx = max(min(tx, ty), 0.0);
    if (dir.z < 0.0) {
      // (B6: in a notch, its floor)
      let tF = (select(select(Lf, Hf, solid), f32(nl.x) / 16.0, inN) - p.z) / dir.z;
      if (tF <= tEx) {
        hk = select(select(3u, 2u, solid), 5u, inN);
        hp = p + dir * max(tF, 0.0);
        break;
      }
    } else if (dir.z > 0.0) {
      // (B6: in a notch, its ceiling)
      if (inN && (f32(nl.y) / 16.0 - p.z) / dir.z <= tEx) {
        hk = 6u;
        hp = p + dir * max((f32(nl.y) / 16.0 - p.z) / dir.z, 0.0);
        break;
      }
      if ((Htf - p.z) / dir.z <= tEx) { break; }
    }
    wasNotch = inN;
    p += dir * tEx;
    let ox = ix;
    let oy = iy;
    if (tx <= ty) {
      axis = 0u;
      ix = select(i32(x0) - 1, i32(x0) + s, dir.x > 0.0);
      iy = clamp(i32(floor(p.y)), i32(y0), i32(y0) + s - 1);
    } else {
      axis = 1u;
      iy = select(i32(y0) - 1, i32(y0) + s, dir.y > 0.0);
      ix = clamp(i32(floor(p.x)), i32(x0), i32(x0) + s - 1);
    }
    if (ix < 0 || iy < 0 || ix > 63 || iy > 63) {
      // (leaving the cell through a side: below a sheet neighbour's edge there is that sheet's ground: a wall)
      let side = select(select(3u, 2u, dir.y > 0.0), select(1u, 0u, dir.x > 0.0), axis == 0u);
      if (p.z < f32(bitcast<i32>(crTab[v.cell * CR_REC + 8u + side])) / 16.0) {
        hk = 4u;
        hp = p;
      }
      break;
    }
    // back up to the deepest level the old and new points share
    let df = u32(ox ^ ix) | u32(oy ^ iy);
    l = min(l, 5u - firstLeadingBit(df));
  }
  if (steps >= CR5_CAP && hk == 0u) {
    // (the cap: the coarser answer known, never black: a column if the node may hold one, else the floor)
    if (solid || axis == 3u) {
      hk = 1u;
    } else {
      hk = 3u;
      p.z = Lf;
    }
    hp = p;
  }
  res.hk = hk;
  res.hp = hp;
  res.axis = axis;
  res.steps = steps;
  return res;
}

// ---- (round 32 step B8, NS-307) notches tested coarse-first inside the hierarchy -------------------------------------
// A notch is one more subtraction in the quadtree: level l's notch is keyed on level-l cells, so the march evaluates it
// once, at its level-l ancestor node, as the span of that cell round the ray's height (z range, depth threshold T), and
// keeps it while the ray stays in that cell and span. At a node of level l the bound of every descendant column's margin
// over the threshold [mMin, mMax] (crNodeUp's bound) decides each level k <= l: mMax < T, every column in the node is air
// at this height (up and notched, or down): the node is crossed in one step, to its side or to the notch's floor /
// ceiling, whichever comes first; mMin >= T, that notch does not touch the node; else the node is descended. An up node
// no coarser notch touches stays solid unless a finer notch could reach it (mMin < the deepest finer notch, fineT). At
// the level of detail a node is one column: its centre margin decides (crIsUpLod's score, as B6), and notches of levels
// finer than the level of detail are not drawn (B6 tested every level at the node's centre column).

/** "no notch": a depth threshold no margin is under */
const CR5_NOT: i32 = -2147483647;
/** how far ahead of p (fine columns) the ray's height is taken for the span lookup, so a point on a span's floor or
 *  ceiling reads the span the ray goes on into */
const CR5_EPS: f32 = 0.004;

/** level l's notch span round height z (units) in level-l cell (jx, jy) of split cell r: x, y the span's z range [lo,
 *  hi) whether it is a notch or not (the march keeps it while z stays inside); z its depth threshold T in TIE units (a
 *  column with margin in [0, T) is notch air), CR5_NOT when the span is no notch. cr5NotchLv's lookup (cliffrule.ts
 *  notchLevel, notchFrac branch), keyed on the level-l cell rather than a column in it */
fn cr5Span(r: CrCell, cx: i32, cy: i32, l: u32, jx: i32, jy: i32, z: i32) -> vec3<i32> {
  let big = 1 << 30;
  let pct = cr5Pct(l);
  if (pct <= 0) { return vec3<i32>(-big, big, CR5_NOT); }
  let c = CR_U >> l;
  let ksh = CR_LF - l;
  let ks = 1 << ksh;
  let topLim = r.H - c;
  if (z < r.L) { return vec3<i32>(-big, r.L, CR5_NOT); }
  if (z >= topLim) { return vec3<i32>(topLim, big, CR5_NOT); }
  let gx = (cx << CR_LF) + jx * ks;
  let gy = (cy << CR_LF) + jy * ks;
  let alongX = abs(r.a) < abs(r.b);
  let ka = select(gy, gx, alongX) >> (ksh + u32(crN.f.w));
  let kb = select(cx, cy, alongX);
  let mk = crMaskAt(2 * (gx >> ksh) * ks + ks, 2 * (gy >> ksh) * ks + ks);
  let D = r.H - r.L;
  let f0 = crN.f.x;
  let f1 = max(f0, crN.f.y);
  var s0 = r.L;
  for (var k = 0; k < 64; k++) {
    let hk = crHash3(ka, kb, crSalt(0x400 + i32(l)) ^ bitcast<i32>(u32(k) * 0x27d4eb2du));
    let len = max(c, (D * (f0 + i32((hk >> 8u) % u32(f1 - f0 + 1)))) >> 8u);
    if (z < s0 + len) {
      let hi = min(s0 + len, topLim);
      if (hk % 25600u >= u32(pct * mk)) { return vec3<i32>(s0, hi, CR5_NOT); }
      let h2 = crMix(hk);
      let dC = 1 + i32((h2 >> 16u) % u32(max(1, cr5Dep(l))));
      return vec3<i32>(s0, hi, dC * ks * 2 * r.A * CR_TIE);
    }
    s0 += len;
  }
  return vec3<i32>(s0, big, CR5_NOT);
}
/** the deepest notch level l can cut (TIE units), CR5_NOT when the level has none */
fn cr5MaxT(r: CrCell, l: u32) -> i32 {
  if (cr5Pct(l) <= 0) { return CR5_NOT; }
  return max(1, cr5Dep(l)) * (1 << (CR_LF - l)) * 2 * r.A * CR_TIE;
}
/** the bound of every descendant column's margin over the threshold in level-l cell (jx, jy), TIE units (crNodeUp's
 *  bound: x >= 0 every one up, y >= 0 any up) */
fn cr5MarginRange(r: CrCell, l: u32, jx: i32, jy: i32, known: i32, ra: i32) -> vec2<i32> {
  let s = CR_N >> l;
  let p0 = crWCentre((jx * s) >> CR_WSH);
  let p1 = crWCentre((jx * s + s - 1) >> CR_WSH);
  let q0 = crWCentre((jy * s) >> CR_WSH);
  let q1 = crWCentre((jy * s + s - 1) >> CR_WSH);
  let wmax = select(r.a * p0, r.a * p1, r.a > 0) + select(r.b * q0, r.b * q1, r.b > 0);
  let wmin = select(r.a * p1, r.a * p0, r.a > 0) + select(r.b * q1, r.b * q0, r.b > 0);
  let th = crThetaUsed(r);
  return vec2<i32>((wmin + known - ra) * CR_TIE - th, (wmax + known + ra) * CR_TIE + CR_TIE - 1 - th);
}

fn cr5MarchCF(v: VBox) -> Cr5M {
  var res: Cr5M;
  res.code = 0u;
  let r = cr5Cell(v.cell);
  let mm = bitcast<i32>(crTab[v.cell * CR_REC + 7u]);
  let g = cr5Win();
  let cx = g.x + i32(v.cell % u32(g.z));
  let cy = g.y + i32(v.cell / u32(g.z));
  let P = vec3<f32>((v.q.xy - v.org) * 64.0, v.q.z * 64.0);
  let eyeP = vec3<f32>((v.eye.xy - v.org) * 64.0, v.eye.z * 64.0);
  let dir = normalize(P - eyeP);
  let Hf = f32(r.H) / 16.0;
  let Lf = f32(r.L) / 16.0;
  let Lbf = f32(bitcast<i32>(crTab[v.cell * CR_REC + 6u])) / 16.0;
  let Htf = f32(cr5Top(v.cell)) / 16.0;
  let inside = all(eyeP.xy > vec2<f32>(0.0)) && all(eyeP.xy < vec2<f32>(64.0)) && eyeP.z > Lbf && eyeP.z < Htf;
  let front = dot(NRM[v.face], v.toEye) > 0.0;
  if (!inside && (!front || v.face == 5u)) { return res; }
  var p = select(P, eyeP, inside);
  res.start = p;
  res.eyeP = eyeP;
  res.dir = dir;
  // the entry axis: 0 x, 1 y, 2 the top, 3 none (the eye inside); B8: 4 down through a notch's floor plane, 5 up through
  // its ceiling plane
  var axis = select(select(select(2u, 1u, v.face == 2u || v.face == 3u), 0u, v.face <= 1u), 3u, inside);
  if (p.z < Lf) {
    res.code = select(1u, 0u, inside);
    return res;
  }
  res.code = 2u;
  let pxK = d.cl.x * 64.0 * max(d.cl.y, 0.25);
  var amp: array<i32, 7>;
  for (var k = 1u; k <= 6u; k++) { amp[k] = crAmpOf(r.A, k, mm); }
  var ra: array<i32, 7>;
  ra[6] = 0;
  for (var k = 5; k >= 0; k--) { ra[k] = ra[k + 1] + amp[k + 1]; }
  var known: array<i32, 7>;
  known[0] = 0;
  var ix = clamp(i32(floor(p.x)), 0, 63);
  var iy = clamp(i32(floor(p.y)), 0, 63);
  var l = 0u;
  var hk = 0u;
  var hp = p;
  var steps = 0;
  var solid = false;
  let notchOn = crN.f.z != 0;
  var wasNotch = false;
  res.nd = 0.0;
  // the notch span cached per level 1..6 at the march's ancestor node of that level (key jx | jy << 8): z range, T
  var nKey: array<i32, 7>;
  var nLo: array<i32, 7>;
  var nHi: array<i32, 7>;
  var nT: array<i32, 7>;
  for (var k = 0; k < 7; k++) { nKey[k] = -1; }
  // the deepest notch of any level finer than l
  var fineT: array<i32, 7>;
  // (and each level's own deepest notch: a node standing in further than that is not looked up for that level)
  var lvT: array<i32, 7>;
  fineT[6] = CR5_NOT;
  for (var k = 5; k >= 0; k--) {
    lvT[k + 1] = cr5MaxT(r, u32(k + 1));
    fineT[k] = max(fineT[k + 1], lvT[k + 1]);
  }
  var capped = false;
  loop {
    if (steps >= CR5_CAP) {
      capped = true;
      break;
    }
    let dist = length(p - eyeP) / 64.0;
    let lt = u32(clamp(floor(6.0 - log2(max(pxK * dist, 1e-6))), 0.0, 6.0));
    l = min(l, lt);
    // the ray's height just ahead of p, units (the notch spans)
    let zq = i32(floor((p.z + sign(dir.z) * CR5_EPS) * 16.0));
    let below = notchOn && p.z < Hf;
    solid = false;
    // the level whose notch makes the node air at this height (0: none)
    var air = 0u;
    loop {
      if (steps >= CR5_CAP) {
        capped = true;
        break;
      }
      steps++;
      let jx = ix >> (6u - l);
      let jy = iy >> (6u - l);
      let mr = cr5MarginRange(r, l, jx, jy, known[l], ra[l]);
      // (crNodeUp's answer from the same bound)
      if (mr.y < 0) { break; }
      var part = false;
      if (below) {
        for (var k = 1u; k <= l; k++) {
          // (every column of the node stands in further than this level's deepest notch: no lookup; its cached T, if
          // stale, is no deeper than that, so the level-of-detail test below cannot pick it either)
          if (mr.x >= lvT[k]) { continue; }
          let kx = ix >> (6u - k);
          let ky = iy >> (6u - k);
          let key = kx | (ky << 8u);
          if (nKey[k] != key || zq < nLo[k] || zq >= nHi[k]) {
            let sp = cr5Span(r, cx, cy, k, kx, ky, zq);
            nKey[k] = key;
            nLo[k] = sp.x;
            nHi[k] = sp.y;
            nT[k] = sp.z;
          }
          if (mr.y < nT[k]) {
            air = k;
            break;
          }
          if (mr.x < nT[k]) { part = true; }
        }
        if (air != 0u) { break; }
      }
      if (mr.x >= 0 && !part && (!below || l >= lt || mr.x >= fineT[l])) {
        solid = true;
        break;
      }
      if (l >= lt) {
        let mg = cr5MarginLod(r, cx, cy, l, jx, jy, known[l]);
        solid = mg >= 0;
        if (solid && part) {
          for (var k = 1u; k <= l; k++) {
            if (mg < nT[k]) {
              solid = false;
              air = k;
              break;
            }
          }
        }
        break;
      }
      l++;
      known[l] = known[l - 1u] + crLevelOff(r, cx, cy, l, ix >> (6u - l), iy >> (6u - l));
    }
    if (capped) { break; }
    if (air != 0u) {
      res.nd = f32(cr5MarginLod(r, cx, cy, l, ix >> (6u - l), iy >> (6u - l), known[l])) / f32(2 * max(r.A, 1) * CR_TIE);
    }
    if (solid && p.z <= Hf + 1e-3) {
      if (axis == 3u) { break; }
      // (from the top above H: the column's top; through a notch's floor / ceiling plane: that floor / ceiling; from a
      // notch's air through a side: its back)
      hk = select(select(select(select(1u, 7u, wasNotch), 6u, axis == 5u), 5u, axis == 4u), 2u, axis == 2u);
      hp = p;
      break;
    }
    let s = 64 >> l;
    let x0 = f32((ix >> (6u - l)) * s);
    let y0 = f32((iy >> (6u - l)) * s);
    let tx = select(select(1e30, (x0 - p.x) / dir.x, dir.x < 0.0), (x0 + f32(s) - p.x) / dir.x, dir.x > 0.0);
    let ty = select(select(1e30, (y0 - p.y) / dir.y, dir.y < 0.0), (y0 + f32(s) - p.y) / dir.y, dir.y > 0.0);
    let tEx = max(min(tx, ty), 0.0);
    if (air != 0u && dir.z != 0.0) {
      // the notch's floor or ceiling inside this node: onto that plane, then decide again there (the same node: another
      // level's notch may go on, or the column under / over it is the floor / ceiling hit)
      let zp = f32(select(nHi[air], nLo[air], dir.z < 0.0)) / 16.0;
      let tz = (zp - p.z) / dir.z;
      if (tz <= tEx) {
        p += dir * max(tz, 0.0);
        axis = select(5u, 4u, dir.z < 0.0);
        wasNotch = true;
        continue;
      }
    }
    if (dir.z < 0.0) {
      if (air == 0u) {
        let tF = (select(Lf, Hf, solid) - p.z) / dir.z;
        if (tF <= tEx) {
          hk = select(3u, 2u, solid);
          hp = p + dir * max(tF, 0.0);
          break;
        }
      }
    } else if (dir.z > 0.0) {
      if ((Htf - p.z) / dir.z <= tEx) { break; }
    }
    wasNotch = air != 0u;
    p += dir * tEx;
    let ox = ix;
    let oy = iy;
    if (tx <= ty) {
      axis = 0u;
      ix = select(i32(x0) - 1, i32(x0) + s, dir.x > 0.0);
      iy = clamp(i32(floor(p.y)), i32(y0), i32(y0) + s - 1);
    } else {
      axis = 1u;
      iy = select(i32(y0) - 1, i32(y0) + s, dir.y > 0.0);
      ix = clamp(i32(floor(p.x)), i32(x0), i32(x0) + s - 1);
    }
    if (ix < 0 || iy < 0 || ix > 63 || iy > 63) {
      let side = select(select(3u, 2u, dir.y > 0.0), select(1u, 0u, dir.x > 0.0), axis == 0u);
      if (p.z < f32(bitcast<i32>(crTab[v.cell * CR_REC + 8u + side])) / 16.0) {
        hk = 4u;
        hp = p;
      }
      break;
    }
    let df = u32(ox ^ ix) | u32(oy ^ iy);
    l = min(l, 5u - firstLeadingBit(df));
  }
  if (capped && hk == 0u) {
    // (the cap: the surface at the point reached, at the finest level reached, as if the node there were solid: never
    // a coarse block or a floor moved under the ray)
    hk = select(select(select(select(1u, 7u, wasNotch), 6u, axis == 5u), 5u, axis == 4u), 2u, axis == 2u);
    hp = p;
  }
  res.hk = hk;
  res.hp = hp;
  res.axis = axis;
  res.steps = steps;
  return res;
}
