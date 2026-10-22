// ---- field mesh draw (G13 C, a prototype: fieldmesh.wgsl) ----------------------
// The mesh's vertices are bound where the instances usually are (binding 3):
// two vec4<u32> each. The shape is the field's; the look is the intervals':
// each fragment finds the interval it lies in (one step into the surface)
// and takes that interval's material, so the layers show on a cut slope just
// as they did on a prism's side. Where the structure share is high it's a
// structure's voxel instead (its moss and the sand over it, as fsBody draws).
@group(0) @binding(9) var<storage, read> meshLayers: array<vec4<u32>>;

struct MOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) share: f32,
  @location(3) @interpolate(flat) word: u32,
  // large-scale ground patchiness (as the prisms have it)
  @location(4) tint: f32,
};

@vertex
fn vsMesh(@builtin(vertex_index) vi: u32) -> MOut {
  let a = instances[vi * 2u];
  let b = instances[vi * 2u + 1u];
  let p = vec3<f32>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z));
  var o: MOut;
  o.pos = CAM.viewProj * vec4<f32>(p, 1.0);
  o.wpos = p;
  o.nrm = vec3<f32>(bitcast<f32>(b.x), bitcast<f32>(b.y), bitcast<f32>(b.z));
  o.share = bitcast<f32>(b.w);
  o.word = a.w;
  o.tint = 0.82 + 0.36 * fbm2(p.xy * 0.045 + vec2<f32>(p.z * 0.02));
  return o;
}

/** The material of column q at height z: the interval holding it, else the nearest (x), and that interval's top (y as bits). */
fn meshMatAt(q: vec2<i32>, z: f32) -> vec2<u32> {
  let cs = colSlots(u32(q.x), u32(q.y));
  var best = 1e9;
  var out = vec2<u32>(MAT_STONE, 0u);
  for (var i = 0u; i < cs.y; i++) {
    let v = meshLayers[cs.x + i];
    if (ivEmpty(v)) { break; }
    let d = max(ivZ0(v) - z, z - ivZ1(v));
    if (d < best) {
      best = d;
      out = vec2<u32>(ivMat(v), bitcast<u32>(ivZ1(v)));
    }
  }
  return out;
}

@fragment
fn fsMesh(in: MOut) -> FOut {
  let nrm = normalize(in.nrm);
  // one step into the surface: the interval this point of it belongs to
  let ip = in.wpos - nrm * 0.2;
  let cell = clampCell(cellAt(ip.xy));
  let ci = colIdxI(cell);
  let mz = meshMatAt(cell, ip.z);
  var mat = mz.x;
  let isTop = nrm.z > 0.55 && in.wpos.z > bitcast<f32>(mz.y) - 0.8;
  var alb = toLinear(MATS[mat].albedo.rgb);
  // the loose ground in its own colour (blown dust a greyer silt)
  if (mat == MAT_DRIFT) { alb = toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
  // per-voxel and sub-voxel variation (cell, whole heights), as the prisms had
  let vc = vec3<i32>(cell, i32(floor(ip.z)));
  let sub = vec3<i32>(floor(in.wpos * 4.0 - nrm * 0.02));
  let n1 = randv(sub);
  let n2 = randv(sub + vec3<i32>(71, 13, 5));
  alb *= 0.9 + 0.12 * randv(vc) + 0.08 * n1;
  alb *= in.tint;
  if (mat >= 1u && mat <= 4u) {
    let band = fbm2(in.wpos.xy * 0.11 + vec2<f32>(in.wpos.z * 0.35, 0.0));
    if (mat == 1u) { alb *= mix(vec3<f32>(0.9, 0.92, 0.96), vec3<f32>(1.1, 1.0, 0.9), band); }
    if (mat == 2u) { alb *= mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), band); }
    let pb = randv(sub + vec3<i32>(5, 77, 13));
    if (pb > 0.93) { alb *= 1.25; } else if (pb < 0.05) { alb *= 0.72; }
  }
  if (mat == MAT_TRASH || mat == MAT_LITTER) {
    // faded plastics, paper, glass and rust specks (litter: scraps on dirt), as fsBox
    let k = u32(n2 * 6.0);
    var tc = vec3<f32>(0.45, 0.43, 0.40);
    if (k == 0u) { tc = vec3<f32>(0.42, 0.52, 0.62); }
    else if (k == 1u) { tc = vec3<f32>(0.78, 0.76, 0.70); }
    else if (k == 2u) { tc = vec3<f32>(0.66, 0.38, 0.34); }
    else if (k == 3u) { tc = vec3<f32>(0.38, 0.48, 0.34); }
    else if (k == 4u) { tc = vec3<f32>(0.50, 0.33, 0.20); }
    alb = toLinear(tc) * (0.75 + 0.35 * n1);
    if (mat == MAT_LITTER && n1 < 0.5) { alb = toLinear(vec3<f32>(0.45, 0.36, 0.27)) * (0.85 + 0.3 * n2); }
  }
  if (isTop) {
    let c = contam[ci].x;
    let stain = smoothstep(0.12, 1.1, c);
    let oil = mix(vec3<f32>(0.10, 0.09, 0.06), vec3<f32>(0.42, 0.40, 0.12), smoothstep(0.55, 0.95, n2));
    alb = mix(alb, toLinear(oil), stain * 0.8);
  }
  // wet ground darkens
  alb *= 1.0 - MATS[mat].eco.w * 0.5 * smoothstep(0.15, 0.9, fields[ci].y);
  // plant cover on tops, a few tufts of it up the slopes
  let v = veg[ci];
  if (v > 0.0) {
    let cover = select(smoothstep(0.8, 3.0, v) * 0.55 * (0.5 + 0.5 * n2), smoothstep(0.0, 1.2, v), isTop);
    if (n1 < cover) {
      var g = mix(vec3<f32>(0.33, 0.40, 0.17), vec3<f32>(0.36, 0.54, 0.19), smoothstep(1.0, 2.0, v));
      g = mix(g, vec3<f32>(0.17, 0.33, 0.12), smoothstep(3.0, 4.5, v));
      alb = wither(toLinear(g * (0.82 + 0.3 * n2)), wilt[ci].y, n2);
    }
  }
  // a structure's face: its moss, and the sand lying against it
  let sw = smoothstep(0.35, 0.65, in.share);
  if (sw > 0.0 && in.word != 0u) {
    let w = in.word;
    let r = randv(vec3<i32>(floor(in.wpos * 1.0 - nrm * 0.02)) + vec3<i32>(3, 9, 27));
    var sa = toLinear(MATS[voxMatR(w)].albedo.rgb) * (0.88 + 0.24 * r);
    let moss = f32((w >> 8u) & 0xffu) / 255.0;
    let sand = f32((w >> 16u) & 0xffu) / 255.0;
    let s = randv(sub + vec3<i32>(13, 5, 71));
    if (s < moss * (0.55 + 0.45 * max(nrm.z, 0.0))) {
      sa = toLinear(mix(vec3<f32>(0.2, 0.33, 0.12), vec3<f32>(0.36, 0.5, 0.2), randv(vec3<i32>(floor(in.wpos * 2.0)) + vec3<i32>(3, 1, 7))));
    }
    if (sand > 0.7 + 0.3 * s) {
      var sc = toLinear(MATS[driftMatAt(cell)].albedo.rgb);
      if (driftMatAt(cell) == MAT_DRIFT) { sc = toLinear(vec3<f32>(0.52, 0.46, 0.39)); }
      sa = sc * (0.9 + 0.2 * s);
    }
    alb = mix(alb, sa, sw);
    if (sw > 0.5) { mat = voxMatR(w); }
  }
  var col = alb * lighting(in.wpos, nrm);
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  o.pick = vec2<u32>(ci + 1u, mat | (u32(max(in.wpos.z, 0.0)) << 8u));
  return o;
}

fn voxMatR(w: u32) -> u32 { return w & 0xffu; }
