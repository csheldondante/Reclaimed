// ---- the rigid rock's mesh (round 95, render/rockmesh.ts; appended after meshdraw.wgsl) ----------------------
// Its own field mesh over a copy of the layers that holds only the pieces in flight, each in a slot (a rectangle of
// mesh chunks) at a shift from where it broke free. Per vertex: the draw whose slot holds it, and its transform
// (spawn frame -> world: rotation | translation); a ghost's vertices (a piece just broken, its fragments not yet
// meshed) take the transform of the fragment whose seed is nearest, those where it crumbled none.
// The look: the copy's intervals for the material, the spawn frame's position for what was there (strata, specks,
// facets, plants: the land it came from), lit and shadowed where it is now.
const RK_N: u32 = 40u;
const RK_STRIDE: u32 = 12u;
struct RockDraws { d: array<vec4<f32>, 481> };
@group(0) @binding(31) var<uniform> RK: RockDraws;
// (round 96) the physics voxels' particles (physics.ts): positions (two vec4 each: now xyz, inverse mass (< 0 gone);
// before), rest positions (the spawn frame's), rotations (their regions'): a metal piece's mesh is skinned to them
@group(0) @binding(32) var<storage, read> rkPx: array<vec4<f32>>;
@group(0) @binding(33) var<storage, read> rkPr: array<vec4<f32>>;
@group(0) @binding(34) var<storage, read> rkPq: array<vec4<f32>>;

/** (round 96) the particle of lattice cell c (column x, y, cell z of the spawn frame) of draw e's body, or -1 */
fn rkParticle(e: u32, c: vec3<i32>) -> i32 {
  let a = rkAt(e, 1u);
  let dm = vec3<i32>(rkAt(e, 2u).xyz);
  let l = c - vec3<i32>(a.yzw);
  if (any(l < vec3<i32>(0)) || any(l >= dm)) { return -1; }
  let j = i32(a.x) + (l.z * dm.y + l.y) * dm.x + l.x;
  if (rkPx[2 * j].w < 0.0) { return -1; }
  return j;
}

struct ROut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  // the copy's position and normal (the spawn frame's, shifted), its shift
  @location(2) lpos: vec3<f32>,
  @location(3) lnrm: vec3<f32>,
  @location(4) @interpolate(flat) ent: u32,
  @location(5) @interpolate(flat) shift: vec3<f32>,
  // (round 96) 1 where its particle is gone (a skinned vertex): the triangles there aren't drawn
  @location(6) gone: f32,
  // (round 96) a skinned vertex's particle's rotation (the detail's normals turn with it)
  @location(7) rq: vec4<f32>,
};

/** v (the spawn frame's) turned as the fragment's piece is */
fn rkTurnF(in: ROut, v: vec3<f32>) -> vec3<f32> {
  if (rkAt(in.ent, 4u).w > 1.5) { return quatRotate(normalize(in.rq), v); }
  return rkTurn(in.ent, v);
}

fn rkAt(e: u32, k: u32) -> vec4<f32> { return RK.d[1u + e * RK_STRIDE + k]; }
fn rkMove(e: u32, s: vec3<f32>) -> vec3<f32> {
  let a = rkAt(e, 1u);
  let b = rkAt(e, 2u);
  let c = rkAt(e, 3u);
  return vec3<f32>(dot(a.xyz, s) + a.w, dot(b.xyz, s) + b.w, dot(c.xyz, s) + c.w);
}
fn rkTurn(e: u32, n: vec3<f32>) -> vec3<f32> { return vec3<f32>(dot(rkAt(e, 1u).xyz, n), dot(rkAt(e, 2u).xyz, n), dot(rkAt(e, 3u).xyz, n)); }

@vertex
fn vsRock(@builtin(vertex_index) vi: u32) -> ROut {
  let mv = meshVert(vi);
  let ob = offBase() + mv.r * 4u;
  let p = vec3<f32>(bitcast<f32>(mv.a.x), bitcast<f32>(mv.a.y), bitcast<f32>(mv.a.z)) + vec3<f32>(bitcast<f32>(meshState[ob]), bitcast<f32>(meshState[ob + 1u]), bitcast<f32>(meshState[ob + 2u]));
  let n = vec3<f32>(bitcast<f32>(mv.b.x), bitcast<f32>(mv.b.y), bitcast<f32>(mv.b.z));
  var o: ROut;
  o.rq = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  let cnt = min(u32(RK.d[0].x), RK_N);
  var e = RK_N;
  for (var i = 0u; i < cnt; i++) {
    let r = rkAt(i, 0u);
    if (p.x >= r.x && p.y >= r.y && p.x < r.z && p.y < r.w) {
      e = i;
      break;
    }
  }
  if (e == RK_N) { return o; }
  let sh = rkAt(e, 4u);
  let s = p - sh.xyz;
  var t = e;
  if (sh.w > 0.5 && sh.w < 1.5) {
    // (a ghost: crumbled here — not drawn; else the nearest fragment's)
    let hit = rkAt(e, 5u);
    if (length(s - hit.xyz) < hit.w) { return o; }
    var best = 1e9;
    for (var k = 0u; k < 6u; k++) {
      let q = rkAt(e, 6u + k);
      if (q.w < 0.0) { continue; }
      let d = length(s - q.xyz);
      if (d < best) {
        best = d;
        t = u32(q.w);
      }
    }
    if (t == e) { return o; }
  }
  var wp = vec3<f32>(0.0);
  var wn = n;
  if (sh.w > 1.5) {
    // (round 96, skinned: the particle of the cell a little inside the surface, or of one beside it)
    let si = s - normalize(n) * 0.35;
    let c0 = cellAt(si.xy);
    let cz = i32(floor(si.z));
    var j = rkParticle(e, vec3<i32>(c0, cz));
    if (j < 0) {
      let odd = (c0.y & 1) != 0;
      let off = array<vec2<i32>, 8>(vec2<i32>(1, 0), vec2<i32>(-1, 0), select(vec2<i32>(0, 1), vec2<i32>(1, 1), odd), select(vec2<i32>(-1, -1), vec2<i32>(0, -1), odd), select(vec2<i32>(-1, 1), vec2<i32>(0, 1), odd), select(vec2<i32>(0, -1), vec2<i32>(1, -1), odd), vec2<i32>(0, 0), vec2<i32>(0, 0));
      for (var k = 0u; k < 8u && j < 0; k++) {
        let dz = select(0, select(1, -1, k == 7u), k >= 6u);
        j = rkParticle(e, vec3<i32>(c0 + off[k], cz + dz));
      }
    }
    if (j < 0) {
      o.gone = 1.0;
      j = 0;
    }
    let q = rkPq[j];
    wp = rkPx[2 * j].xyz + quatRotate(q, s - rkPr[j].xyz);
    wn = quatRotate(q, n);
    o.rq = q;
  } else {
    wp = rkMove(t, s);
    wn = rkTurn(t, n);
  }
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  o.nrm = wn;
  o.lpos = p;
  o.lnrm = n;
  o.ent = t;
  o.shift = sh.xyz;
  return o;
}

@fragment
fn fsRock(in: ROut) -> FOut {
  // (round 96: a skinned mesh tears where its particles part — stretched past 1.6 × or over a particle gone; the
  // derivatives before any discard)
  let st = max(length(dpdx(in.wpos)) / max(length(dpdx(in.lpos)), 1e-4), length(dpdy(in.wpos)) / max(length(dpdy(in.lpos)), 1e-4));
  if (in.gone > 0.02 || st > 1.6) { discard; }
  let nL = normalize(in.lnrm);
  let nW = normalize(in.nrm);
  // where it was (the spawn frame) and its place in the copy
  let sp = in.lpos - in.shift;
  let ip = in.lpos - nL * 0.2;
  let ips = sp - nL * 0.2;
  let jit = vec3<i32>(floor(sp * 4.0 - nL * 0.02));
  let jo = vec2<f32>(randv(jit + vec3<i32>(41, 0, 0)), randv(jit + vec3<i32>(0, 43, 0))) - 0.5;
  var cell: vec2<i32>;
  if (noDetail(ND_WARP)) { cell = clampCell(cellAt(ip.xy)); } else { cell = clampCell(cellAt(terrainWarp(ips) + jo * 0.6 + in.shift.xy)); }
  let up = nL.z > 0.55;
  let lk = meshLook(cell, ip.z, up);
  var mat = lk.mat;
  // (round 96) a metal piece is meshed as stone (the field leaves metal to the prisms): its own material for the look
  if (rkAt(in.ent, 4u).w > 1.5 && rkAt(in.ent, 2u).w > 0.5) { mat = u32(rkAt(in.ent, 2u).w); }
  let isTop = up && in.lpos.z > lk.top - 0.8;
  var alb = groundAlbedo(mat);
  if (isTop && lk.below != 0u && mat == lk.mat) { alb = mix(groundAlbedo(lk.below), alb, smoothstep(0.02, 0.2, lk.thick)); }
  let scell = cellAt(ips.xy);
  let vc = vec3<i32>(scell, i32(floor(ips.z)));
  let sub = vec3<i32>(floor(sp * 4.0 - nL * 0.02));
  let n1 = randv(sub);
  let n2 = randv(sub + vec3<i32>(71, 13, 5));
  let steep = 1.0 - smoothstep(0.3, 0.7, abs(nL.z));
  if (!noDetail(ND_SPECKS)) { alb *= 1.0 + mix(1.0, 0.35, steep) * (0.12 * randv(vc) + 0.08 * n1 - 0.1); }
  alb *= meshTint(sp);
  if (mat >= 1u && mat <= 4u && !noDetail(ND_STRATA)) {
    let band = strata(sp);
    if (mat == 1u) { alb *= mix(vec3<f32>(0.8, 0.83, 0.9), vec3<f32>(1.16, 1.03, 0.88), band); }
    if (mat == 2u) { alb *= mix(vec3<f32>(0.9, 0.95, 0.92), vec3<f32>(1.12, 0.98, 0.86), band); }
    let pb = randv(sub + vec3<i32>(5, 77, 13));
    if (pb > 0.93) { alb *= 1.25; } else if (pb < 0.05) { alb *= 0.72; }
  }
  if ((mat == 23u || mat == 30u) && !noDetail(ND_STRATA)) { alb *= strataTint(mat, strata(sp)); }
  // the plants it carried on its top (the place it came from's cover)
  if (isTop && !noDetail(ND_PLANTS)) {
    let v = cellFields(sp.xy).y;
    if (v > 0.0 && n1 < smoothstep(0.0, 1.2, v)) {
      var g = mix(vec3<f32>(0.33, 0.40, 0.17), vec3<f32>(0.36, 0.54, 0.19), smoothstep(1.0, 2.0, v));
      g = mix(g, vec3<f32>(0.17, 0.33, 0.12), smoothstep(3.0, 4.5, v));
      alb = toLinear(g * (0.82 + 0.3 * n2));
    }
  }
  // the detail layer, in its own frame, turned with it
  var lnrm = nW;
  if (CAM.viewport.z > 4.0) {
    if (mat == MAT_STONE || bedded(mat)) {
      let rf = rockFacet(sp, nL, 1.0);
      lnrm = normalize(rkTurnF(in, rf.xyz));
      alb *= rf.w;
    } else if (jagged(mat)) {
      let chip = vec3<i32>(floor(sp * 4.0 - nL * 0.1));
      let t = vec3<f32>(randv(chip + vec3<i32>(1, 0, 0)), randv(chip + vec3<i32>(0, 1, 0)), randv(chip + vec3<i32>(0, 0, 1))) - 0.5;
      lnrm = normalize(rkTurnF(in, normalize(nL + (t - nL * dot(t, nL)) * 1.3)));
      let f = fract(sp * 4.0 - nL * 0.1);
      let edge = min(min(f.x, 1.0 - f.x), min(min(f.y, 1.0 - f.y), min(f.z, 1.0 - f.z)));
      alb *= 0.8 + 0.2 * smoothstep(0.0, 0.12, edge);
    }
  }
  var col = alb * lighting(in.wpos, lnrm);
  if (mat == MAT_QUARTZ) { col = gemLook(in.wpos, nW); }
  col = haze(col, in.wpos);
  var o: FOut;
  o.color = vec4<f32>(toSrgb(col), 1.0);
  let wc = clampCell(cellAt(in.wpos.xy));
  o.pick = vec2<u32>(colIdxI(wc) + 1u, pickInfo(mat, in.wpos.z, 0u));
  return o;
}
