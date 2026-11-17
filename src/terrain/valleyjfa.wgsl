// Terrain rivers, step 2 (docs/design/TERRAIN_RIVERS.md §9.3): the coarse valley field at every texel centre of the
// warped space. Appended to the atlas build module only when a.rivers2 is on (atlas/atlas/build.ts).
//  jfaSeedVal  each node's texel seeds both slots with it (keyB: per texel its node + 1)
//  jfaStepVal  a two-slot jump flood: x the nearest node (by the exact distance to its segments), y the lowest (by the
//              valley surface S at the texel centre, + min(LF_PEN, LF_SLOPE · the texel's distance into its landform)
//              for a river of another landform than the texel's)
//  valleyField the union of the 3 × 3 neighbourhood's slots evaluated exactly at the texel centre: E (the least S, the
//              penalty left out), the least distance D and the winner's landform → jfaDst as (E, pack2x16float(D, ℓ))
// terrain/valley.wgsl (valNodeS) is the surface; valleyGround reads the result.

/** the texel centre (world units) and its profile, landform */
fn valTexX(me: vec2<i32>) -> vec2<f32> { return (vec2<f32>(me) + 0.5) * vec2<f32>(AP.worldW, AP.worldH) / f32(AP.n); }

@compute @workgroup_size(8, 8)
fn jfaSeedVal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let v = keyB[i];
  jfaSrc[i] = vec2<u32>(v, v);
}

@compute @workgroup_size(8, 8)
fn jfaStepVal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let me = vec2<i32>(id.xy);
  let x = valTexX(me);
  let reg = regs[regionR[i]];
  let pr = valProfOf(valTier(reg));
  let lfMe = reg.lf;
  let pen = min(VAL_LF_PEN, VAL_LF_SLOPE * max(distR[i].w, 0.0));
  var best = jfaSrc[i];
  var bd = 1e30;
  var bs = 1e30;
  if (best.x != 0u) { bd = valNodeS(best.x - 1u, x, pr).y; }
  if (best.y != 0u) {
    let nd = best.y - 1u;
    bs = valNodeS(nd, x, pr).x + select(0.0, pen, nodeLf(riverNode(nd)) != lfMe);
  }
  let k = i32(AP.step);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let c = jfaSrc[texIdxW(me + vec2<i32>(dx, dy) * k)];
      for (var s = 0u; s < 2u; s++) {
        let v = select(c.x, c.y, s == 1u);
        if (v == 0u || (v == best.x && v == best.y)) { continue; }
        let r = valNodeS(v - 1u, x, pr);
        if (r.y < bd) {
          bd = r.y;
          best.x = v;
        }
        let sc = r.x + select(0.0, pen, nodeLf(riverNode(v - 1u)) != lfMe);
        if (sc < bs) {
          bs = sc;
          best.y = v;
        }
      }
    }
  }
  jfaDst[i] = best;
}

/** (no river within reach: E far over any ground, D far, no landform) */
const VAL_NONE_E: f32 = 1e4;

@compute @workgroup_size(8, 8)
fn valleyField(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let me = vec2<i32>(id.xy);
  let x = valTexX(me);
  let reg = regs[regionR[i]];
  let pr = valProfOf(valTier(reg));
  let lfMe = reg.lf;
  let pen = min(VAL_LF_PEN, VAL_LF_SLOPE * max(distR[i].w, 0.0));
  var bs = 1e30;
  var E = VAL_NONE_E;
  var lf = -1.0;
  var D = 6e4;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = jfaSrc[texIdxW(me + vec2<i32>(dx, dy))];
      for (var s = 0u; s < 2u; s++) {
        let v = select(c.x, c.y, s == 1u);
        if (v == 0u || (s == 1u && v == c.x)) { continue; }
        // (each candidate and the node downstream of it: a creek's node beside its parent took both slots there and
        // hid the parent's valley — 20-cell seams by the channel, the continuity probe)
        let nd0 = v - 1u;
        let nd1 = riverNode(nd0).next;
        for (var q = 0u; q < 2u; q++) {
          let nd = select(nd0, nd1, q == 1u);
          if (q == 1u && nd1 == nd0) { continue; }
          let r = valNodeS(nd, x, pr);
          D = min(D, r.y);
          let nl = nodeLf(riverNode(nd));
          let sc = r.x + select(0.0, pen, nl != lfMe);
          if (sc < bs) {
            bs = sc;
            E = min(r.x, VAL_NONE_E);
            // (a landform id as a half float: exact under 2048; the sea's (0xffffffff) and anything past it: none, −1)
            lf = select(-1.0, f32(nl), nl < 2048u);
          }
        }
      }
    }
  }
  jfaDst[i] = vec2<u32>(bitcast<u32>(E), pack2x16float(vec2<f32>(min(D, 6e4), lf)));
}
