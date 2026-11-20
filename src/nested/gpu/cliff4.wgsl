// ---- nested/gpu/cliff4.wgsl: ?cliff=4, the cliff rule painted on the textured sheets (round 32 step B1) ----------------
// A separate module variant (render.ts cliffRuleCode): this file and cliffrule.wgsl are appended to the draw module only
// when the page loads with ?cliff=4, so the default pipelines' source is unchanged. The generated prefix defines CR_LV (the
// depth of the 16 m level) and CR_UPL (1/64 m units per local unit of that level: 1024).
//
// Heights: the 16 m level's REAL stored columns, read per pixel from the pages (store.wgsl recCount / recAt through
// draw.wgsl cliffColTop): the top (word 0, f32 level-local units) of the column's highest solid record, rounded half up to
// 1/64 m (crUnits). Its window (d.cl3.y, z, w: gx, gy, n; render.ts) is the field: a cell beyond it is clamped to it per
// axis, the TS hAt's edge rule. A column with no solid record (not loaded) sets crMissing (the pixel is painted magenta).

var<private> crMissing: bool;
/** the steep threshold, cell widths (B1: step A's default) */
fn crT() -> i32 { return 2; }
fn crH(x: i32, y: i32) -> i32 {
  let g = vec3<i32>(i32(d.cl3.y), i32(d.cl3.z), i32(d.cl3.w));
  let X = clamp(x, g.x, g.x + g.z - 1);
  let Y = clamp(y, g.y, g.y + g.z - 1);
  let t = cliffColTop(CR_LV, X, Y);
  if (t < -1e29) {
    crMissing = true;
    return 0;
  }
  return crUnits(t, CR_UPL);
}

@fragment
fn fsST4(v: VOutS) -> FOut {
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
  // the pixel's plan point in fine columns (0.25 m) of the 16 m level: 2^e fine columns a column of the drawn level
  let L = i32(d.lvl.w);
  let lk = i32(round(log2(d.misc.w)));
  let e = 6 - lk * (L - i32(CR_LV));
  let fq = ldexp(v.q.xy, vec2<i32>(e));
  let fw = fwidth(fq);
  var o = texOut(v.q, v.zo, n, v.mat, pxL, v.toEye, v.dEye);
  if (d.cl3.w <= 0.0 || e < 0) { return o; }
  // (integer: the window's origin shifted, plus the local part's floor; exact)
  let fi = (d.lvl.xy << vec2<u32>(u32(e))) + vec2<i32>(floor(fq));
  let cx = fi.x >> 6u;
  let cy = fi.y >> 6u;
  let g = vec3<i32>(i32(d.cl3.y), i32(d.cl3.z), i32(d.cl3.w));
  if (cx < g.x || cy < g.y || cx >= g.x + g.z || cy >= g.y + g.z) { return o; }
  crMissing = false;
  let r = crDerive(cx, cy);
  var col = o.color.rgb;
  let lum = dot(col, vec3<f32>(0.3, 0.5, 0.2));
  if (r.kind == CR_SPLIT) {
    let up = crIsUp(r, cx, cy, fi.x & 63, fi.y & 63);
    // up: warm, down: blue; lit a little by the sheet's own shading so the relief still reads
    let c = select(vec3<f32>(0.20, 0.42, 0.95), vec3<f32>(1.0, 0.60, 0.18), up);
    col = c * (0.45 + 0.75 * lum);
  } else if (r.kind == CR_TOP) {
    col = mix(col, vec3<f32>(0.35, 0.95, 0.35) * (0.4 + lum), 0.5);
  } else if (r.kind == CR_BOTTOM) {
    col = mix(col, vec3<f32>(0.85, 0.35, 0.95) * (0.4 + lum), 0.5);
  }
  if (crMissing) { col = vec3<f32>(1.0, 0.0, 1.0); }
  // the coarse cells' borders, about a pixel wide: the position in fine columns mod 64 (the origin's part exact)
  let off = vec2<f32>((d.lvl.xy << vec2<u32>(u32(e))) & vec2<i32>(63));
  let m = (fq + off) - 64.0 * floor((fq + off) / 64.0);
  let dd = min(m, vec2<f32>(64.0) - m) / max(fw, vec2<f32>(1e-6));
  if (min(dd.x, dd.y) < 0.8) { col *= 0.35; }
  o.color = vec4<f32>(col, 1.0);
  return o;
}
