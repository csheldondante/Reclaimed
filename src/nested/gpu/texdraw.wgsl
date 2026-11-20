// ---- nested/gpu/texdraw.wgsl (round 27, ?tex=2): the draws' entry points for the tiling textures (tex.wgsl), appended
// to the draw module after draw.wgsl and tex.wgsl (the field's fsFieldT2 is in fielddraw.wgsl)

/** texOut for ?tex=2 (draw.wgsl texOut's frame: shading units, fog, the level tint) */
fn texOut2(q: vec3<f32>, zo: f32, ng: vec3<f32>, mm: MatMix, qx: vec3<f32>, qy: vec3<f32>, toEye: vec3<f32>, dEye: f32) -> FOut {
  let gz = i32(d.geo.z);
  let s = levelS() - gz;
  let sc = ldexp(1.0, -s);
  var si: ShadeIn;
  si.p = DPt(d.lvl.xy, s, ldexp(zo, gz), q);
  si.fog = select(-1.0, fogAt(u32(d.lvl.w), dEye), d.geo.y > 0.0);
  si.ng = ng;
  si.mat = matId(mm.a);
  si.pxW = footprint(qx, qy) * sc;
  si.view = -normalize(toEye);
  si.distW = dEye * sc;
  si.sun = normalize(d.sun.xyz);
  si.split = -1.0;
  si.debug = false;
  si.nb = d.want.z;
  si.canopy = d.want.y;
  // (geo.w: the fine tile's frequency, log2 tiles a world unit; in shading units less gz)
  var col = texShade2(si, mm, qx, qy, i32(d.geo.w) - gz);
  if (d.misc.z > 0.5) { col = mix(col, TINTS[u32(d.lvl.w) % 6u] * dot(col, vec3<f32>(0.3, 0.5, 0.2)) * 1.3, 0.55); }
  var o: FOut;
  o.color = vec4<f32>(col, 1.0);
  let coarse = d.want.x > 0.0 && dEye < d.want.x;
  o.info = vec4<f32>(1.0, f32(d.lvl.w) / 8.0, select(0.0, 1.0, coarse), 1.0);
  return o;
}
@fragment
fn fsST2(v: VOutS) -> FOut {
  // (derivatives first, as fsST)
  let qx = dpdx(v.q);
  let qy = dpdy(v.q);
  let cr = cross(qx, qy);
  let cl = length(cr);
  var n = select(vec3<f32>(0.0, 0.0, 1.0), cr / cl, cl > 0.0);
  if (dot(n, v.toEye) < 0.0) { n = -n; }
  let vl = length(v.vn);
  if (vl > 1e-3) {
    let nv = v.vn / vl;
    if (dot(nv, n) >= d.sun.w) { n = nv; }
  }
  // (the drawn sheet's material, flat; its neighbours' looked up at the pixel's height: draw.wgsl matMix)
  let mm = matMix(u32(d.lvl.w), v.q.xy, v.q.z, v.mat);
  return texOut2(v.q, v.zo, n, mm, qx, qy, v.toEye, v.dEye);
}
@fragment
fn fsT2(v: VOut) -> FOut {
  let qx = dpdx(v.q);
  let qy = dpdy(v.q);
  let px = length(fwidth(v.wp));
  if (d.misc.x == 1.0 || d.misc.x == 2.0) { return flatOut(v, px); }
  var n = normalize(v.nrm);
  if (dot(n, v.toEye) < 0.0) { n = -n; }
  // (the boxes: the face's material only, no border mix: a limit, the box draw is not the default)
  return texOut2(v.q, v.zo, n, MatMix(v.mat, v.mat, 0.0), qx, qy, v.toEye, v.dEye);
}
