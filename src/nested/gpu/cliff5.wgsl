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

@vertex
fn vsBox5(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VBox {
  var o: VBox;
  let g = cr5Win();
  let ent = crTab[CR_REC * u32(g.z * g.z) + inst];
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

@fragment
fn fsBox5(v: VBox) -> FOut {
  let r = cr5Cell(v.cell);
  let mat = (crTab[v.cell * CR_REC] >> 12u) & 15u;
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
  if (!inside && (!front || v.face == 5u)) { discard; }
  var p = select(P, eyeP, inside);
  // the entry axis: 0 x, 1 y, 2 the top, 3 none (the eye inside)
  var axis = select(select(select(2u, 1u, v.face == 2u || v.face == 3u), 0u, v.face <= 1u), 3u, inside);
  // (a side face entered below L: the ground's own wall down to a lower neighbour; the eye below L: inside the ground)
  if (p.z < Lf) {
    if (inside) { discard; }
    let q0 = vec3<f32>(P.xy / 64.0 + v.org, P.z / 64.0);
    let n0 = NRM[v.face];
    let c0 = cr5Shade(q0, v.zo, n0, 1u, d.cl.x * v.dEye, v.toEye, v.dEye, true, 0.8);
    var o0: FOut;
    o0.color = vec4<f32>(c0, 1.0);
    o0.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, 0.0, select(1.0, 0.5, u32(d.cl.z) == 12u));
    return o0;
  }
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
  loop {
    if (steps >= CR5_CAP) { break; }
    let dist = length(p - eyeP) / 64.0;
    let lt = u32(clamp(floor(6.0 - log2(max(pxK * dist, 1e-6))), 0.0, 6.0));
    l = min(l, lt);
    // descend from level l (known[] valid down to it) to the node that decides; every node looked at is a step
    solid = false;
    loop {
      steps++;
      let jx = ix >> (6u - l);
      let jy = iy >> (6u - l);
      let nb = crNodeUp(r, l, jx, jy, known[l], ra[l]);
      if (!nb.x) { break; }
      if (nb.y) {
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
    if (solid && p.z <= Hf + 1e-3) {
      if (axis == 3u) { break; }
      // (entered from the box's top above H: the column's top, reached by falling onto it)
      hk = select(1u, 2u, axis == 2u);
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
      let tF = (select(Lf, Hf, solid) - p.z) / dir.z;
      if (tF <= tEx) {
        hk = select(3u, 2u, solid);
        hp = p + dir * max(tF, 0.0);
        break;
      }
    } else if (dir.z > 0.0 && (Htf - p.z) / dir.z <= tEx) { break; }
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
  // (?cliffDbg=12: march steps / CR5_CAP, flat, misses included; 13 the hit kind. The info target carries the steps in b
  // (/255) and 0.5 in a, so a readback can count them: scripts/nested-rB2-stills.mjs)
  if (u32(d.cl.z) == 12u || u32(d.cl.z) == 13u) {
    var o: FOut;
    let t = f32(steps) / f32(CR5_CAP);
    o.color = vec4<f32>(select(vec3<f32>(t, 1.0 - abs(2.0 * t - 1.0), 1.0 - t), TINTS[hk], u32(d.cl.z) == 13u), 1.0);
    o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, f32(steps) / 255.0, 0.5);
    // (13: a miss is discarded as in the plain draw, so coplanar faces of neighbouring boxes do not fight)
    if (hk == 0u && u32(d.cl.z) == 13u) { discard; }
    return o;
  }
  if (hk == 0u) { discard; }
  var nrm = vec3<f32>(0.0, 0.0, 1.0);
  // (4: a sheet neighbour's edge wall, shaded as a column side)
  if (hk == 4u) { hk = 1u; }
  if (hk == 1u) { nrm = select(vec3<f32>(0.0, -sign(dir.y), 0.0), vec3<f32>(-sign(dir.x), 0.0, 0.0), axis == 0u); }
  let q = vec3<f32>(hp.xy / 64.0 + v.org, hp.z / 64.0);
  let toEye = (eyeP - hp) / 64.0;
  let dE = length(toEye);
  // the recess: darker the further the hit lies in from where the ray entered the box (plan distance, fine columns)
  let ao = mix(1.0, 0.55, smoothstep(0.0, 32.0, length((hp - select(P, eyeP, inside)).xy)));
  let col = cr5Shade(q, v.zo, nrm, select(mat, 1u, hk == 1u), d.cl.x * dE, toEye, dE, hk == 1u, ao);
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, 0.0, 1.0);
  return o;
}
