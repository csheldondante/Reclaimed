// ---- the rigid rock's mesh (round 95, render/rockmesh.ts; appended after meshdraw.wgsl) ----------------------
// Its own field mesh over a copy of the layers that holds only the pieces in flight, each in a slot (a rectangle of
// mesh chunks) at a shift from where it broke free. Per vertex: the draw whose slot holds it, and its transform
// (spawn frame -> world: rotation | translation); a ghost's vertices (a piece just broken, its fragments not yet
// meshed) take the transform of the fragment whose seed is nearest, those where it crumbled none.
// The look: the copy's intervals for the material, the spawn frame's position for what was there (strata, specks,
// facets, plants: the land it came from), lit and shadowed where it is now.
const RK_STRIDE: u32 = 12u;
// (round 120: as many draws as there are — a storage buffer that grows with them, read by the vertex stage only: the
// fragment stage gets what it needs of its draw as flat varyings, ROut.ek and rq)
@group(0) @binding(31) var<storage, read> RKD: array<vec4<f32>>;
const RK_NONE: u32 = 0xffffffffu;
// (solver step 2) the node solver's nodes (solver.ts): their transforms for the last two ticks (pose: prev pos, prev
// rot, pos, rot) and their lanes ([0] w < 0 gone; [6] the rest a mesh is bound to, about the body's rest centre of
// mass) — a metal piece's mesh is skinned to them, drawn between the two ticks at RKD[0].y
@group(0) @binding(32) var<storage, read> rkPose: array<vec4<f32>>;
@group(0) @binding(33) var<storage, read> rkLane: array<vec4<f32>>;
const RK_LANE: u32 = 8u;
// (round 120: rendering by material, not by solver — the rock on the voxel lattice drawn with the same mesh, skinned
// to the lattice's particles: 2 vec4 a particle, xyz where it is, w < 0 gone; its rotation)
@group(0) @binding(34) var<storage, read> rkPx: array<vec4<f32>>;
@group(0) @binding(35) var<storage, read> rkPq: array<vec4<f32>>;

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
  // (round 96) a skinned vertex's particle's rotation (the detail's normals turn with it); round 120: every draw's — a
  // matrix's rotation as a quaternion too
  @location(7) rq: vec4<f32>,
  // (round 120) its draw's material to be drawn as (0: the copy's own)
  @location(8) @interpolate(flat) ek: vec2<f32>,
};

/** a rotation matrix's rows as a quaternion */
fn quatOfRows(r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>) -> vec4<f32> {
  let tr = r0.x + r1.y + r2.z;
  if (tr > 0.0) {
    let s = sqrt(tr + 1.0) * 2.0;
    return vec4<f32>((r2.y - r1.z) / s, (r0.z - r2.x) / s, (r1.x - r0.y) / s, 0.25 * s);
  }
  if (r0.x > r1.y && r0.x > r2.z) {
    let s = sqrt(1.0 + r0.x - r1.y - r2.z) * 2.0;
    return vec4<f32>(0.25 * s, (r0.y + r1.x) / s, (r0.z + r2.x) / s, (r2.y - r1.z) / s);
  }
  if (r1.y > r2.z) {
    let s = sqrt(1.0 + r1.y - r0.x - r2.z) * 2.0;
    return vec4<f32>((r0.y + r1.x) / s, 0.25 * s, (r1.z + r2.y) / s, (r0.z - r2.x) / s);
  }
  let s = sqrt(1.0 + r2.z - r0.x - r1.y) * 2.0;
  return vec4<f32>((r0.z + r2.x) / s, (r1.z + r2.y) / s, 0.25 * s, (r1.x - r0.y) / s);
}

/** v (the spawn frame's) turned as the fragment's piece is */
fn rkTurnF(in: ROut, v: vec3<f32>) -> vec3<f32> {
  return quatRotate(normalize(in.rq), v);
}

fn rkAt(e: u32, k: u32) -> vec4<f32> { return RKD[1u + e * RK_STRIDE + k]; }
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
  let cnt = u32(RKD[0].x);
  var e = RK_NONE;
  for (var i = 0u; i < cnt; i++) {
    let r = rkAt(i, 0u);
    if (p.x >= r.x && p.y >= r.y && p.x < r.z && p.y < r.w) {
      e = i;
      break;
    }
  }
  if (e == RK_NONE) { return o; }
  let sh = rkAt(e, 4u);
  let s = p - sh.xyz;
  var t = e;
  if (sh.w > 0.5 && sh.w < 1.5) {
    // (a ghost: crumbled here — not drawn; else the nearest fragment's)
    let hit = rkAt(e, 5u);
    let cut = length(s - hit.xyz) < hit.w;
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
    // (round 120: a vertex left out is placed — where it was, the ghost's own transform — and marked gone, so the
    // triangles it's in are discarded whole. Sent off the clip volume instead, a triangle with one vertex there and two
    // drawn was clipped to a sliver stretched off toward the screen's corner: the long dark streaks into the sky the
    // node solver's breaks showed, its pieces breaking more often)
    if (t == e || cut) { o.gone = 1.0; }
  }
  var wp = vec3<f32>(0.0);
  var wn = n;
  if (rkAt(t, 4u).w > 2.5) {
    // (round 120, on the voxel lattice: the particles of the cells round where the vertex was — its own cell's and the
    // six beside it, a layer above and below — each carrying it at its offset from where that cell stood, turned with
    // the particle; by nearness. None left: it's gone, its triangles torn)
    let a = rkAt(t, 1u);
    let dm = rkAt(t, 2u);
    let off = u32(a.x);
    let lo = vec3<i32>(i32(a.y), i32(a.z), i32(a.w));
    let dims = vec3<i32>(i32(dm.x), i32(dm.y), i32(dm.z));
    let c0 = cellAt(s.xy);
    let z0 = i32(floor(s.z));
    var sp = vec3<f32>(0.0);
    var sn = vec3<f32>(0.0);
    var ws = 0.0;
    for (var k = 0u; k <= NDIR; k++) {
      var c = c0;
      if (k < NDIR) { c = cellAt(cellPos(c0) + DIRV[k]); }
      for (var dz = -1; dz <= 1; dz++) {
        let l = vec3<i32>(c.x, c.y, z0 + dz) - lo;
        if (any(l < vec3<i32>(0)) || any(l >= dims)) { continue; }
        let j = off + u32(l.x + dims.x * (l.y + dims.y * l.z));
        let x = rkPx[2u * j];
        if (x.w < 0.0) { continue; }
        let rc = vec3<f32>(cellPos(c), f32(z0 + dz) + 0.5);
        let d = length(s - rc);
        if (d > 1.6) { continue; }
        let w = 1.0 / ((d + 0.25) * (d + 0.25));
        let q = normalize(rkPq[j]);
        sp += w * (x.xyz + quatRotate(q, s - rc));
        sn += w * quatRotate(q, n);
        ws += w;
        if (ws == w) { o.rq = q; }
      }
    }
    if (ws <= 0.0) {
      o.gone = 1.0;
      wp = s;
    } else {
      wp = sp / ws;
      wn = normalize(sn);
    }
  } else if (rkAt(t, 4u).w > 1.5) {
    // (solver step 2, skinned: the vertex goes with the nodes nearest where it was bound — up to four, weighted by
    // nearness — each carrying it at its offset turned with it, between the last two ticks. Round 120: a ghost's
    // vertex with its fragment's nodes, when that fragment is skinned — the spawn frame is the same lattice's, so its
    // place about the fragment's rest centre is where it was bound)
    let a = rkAt(t, 1u);
    let nn = u32(rkAt(t, 2u).x);
    let base = u32(a.x) * 64u;
    let al = clamp(RKD[0].y, 0.0, 1.0);
    let sr = s - a.yzw;
    var bi = vec4<u32>(0u);
    var bd = vec4<f32>(1e9);
    for (var k = 0u; k < nn; k++) {
      let ln = rkLane[(base + k) * RK_LANE];
      if (ln.w < 0.0) { continue; }
      let d = length(sr - rkLane[(base + k) * RK_LANE + 6u].xyz);
      if (d < bd.w) {
        if (d < bd.z) {
          if (d < bd.y) {
            if (d < bd.x) { bd = vec4<f32>(d, bd.xyz); bi = vec4<u32>(k, bi.xyz); }
            else { bd = vec4<f32>(bd.x, d, bd.yz); bi = vec4<u32>(bi.x, k, bi.yz); }
          } else { bd = vec4<f32>(bd.xy, d, bd.z); bi = vec4<u32>(bi.xy, k, bi.z); }
        } else { bd.w = d; bi.w = k; }
      }
    }
    if (bd.x > 1e8) { return o; }
    var wsum = 0.0;
    var nsum = vec3<f32>(0.0);
    for (var i = 0u; i < 4u; i++) {
      if (bd[i] > 1e8 || bd[i] > bd.x + 1.5 * rkLane[(base + bi.x) * RK_LANE + 2u].w) { continue; }
      let j = base + bi[i];
      let w = 1.0 / ((bd[i] + 0.25) * (bd[i] + 0.25));
      let q0 = rkPose[j * 4u + 1u];
      var q1 = rkPose[j * 4u + 3u];
      if (dot(q0, q1) < 0.0) { q1 = -q1; }
      let q = normalize(mix(q0, q1, al));
      let x = mix(rkPose[j * 4u].xyz, rkPose[j * 4u + 2u].xyz, al);
      wp += w * (x + quatRotate(q, sr - rkLane[j * RK_LANE + 6u].xyz));
      nsum += w * quatRotate(q, n);
      wsum += w;
      if (i == 0u) { o.rq = q; }
    }
    wp /= wsum;
    wn = normalize(nsum);
  } else {
    wp = rkMove(t, s);
    wn = rkTurn(t, n);
    o.rq = quatOfRows(rkAt(t, 1u).xyz, rkAt(t, 2u).xyz, rkAt(t, 3u).xyz);
  }
  o.pos = CAM.viewProj * vec4<f32>(wp, 1.0);
  o.wpos = wp;
  o.nrm = wn;
  o.lpos = p;
  o.lnrm = n;
  o.ent = t;
  o.ek = vec2<f32>(select(0.0, rkAt(t, 2u).w, rkAt(t, 4u).w > 1.5 && rkAt(t, 4u).w < 2.5), 0.0);
  o.shift = sh.xyz;
  return o;
}

/** (round 120) the sun's depth: what the look leaves out (gone, torn) casts no shadow either */
@fragment
fn fsRockZ(in: ROut) {
  let st = max(length(dpdx(in.wpos)) / max(length(dpdx(in.lpos)), 1e-4), length(dpdy(in.wpos)) / max(length(dpdy(in.lpos)), 1e-4));
  if (in.gone > 0.02 || st > 1.6) { discard; }
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
  if (in.ek.x > 0.5) { mat = u32(in.ek.x); }
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
  o.pick = vec2<u32>(winIdx(wc) + 1u, pickInfo(mat, in.wpos.z, 0u));
  return o;
}
