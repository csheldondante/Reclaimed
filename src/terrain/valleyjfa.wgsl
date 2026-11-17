// Terrain rivers, step 1 (docs/design/TERRAIN_RIVERS.md §4): the second river JFA, by cost — each texel the node whose
// valley is lowest there (cost = the node's level + VAL_VJ · distance), unbounded. Appended to the atlas build module
// only when a.rivers2 is on (atlas/atlas/build.ts); seeded by build.wgsl jfaSeedV, stepped by jfaStepVal, written out
// (no distance cap) by jfaOutVal. terrain/valley.wgsl reads the result.

fn valCost(me: vec2<i32>, v: u32) -> f32 {
  let nd = riverNode(v - 1u);
  let p = (vec2<f32>(me) + 0.5) * vec2<f32>(AP.worldW, AP.worldH) / f32(AP.n);
  let q = nearTo(vec2<f32>(nd.x, nd.y), p);
  // (a river shapes only its own landform's ground: one of another landform costs VAL_LF_PEN more)
  let other = regs[regionR[texIdxW(me)]].lf != nodeLf(nd);
  return nd.level + VAL_VJ * length(q - p) + select(0.0, VAL_LF_PEN, other);
}

@compute @workgroup_size(8, 8)
fn jfaStepVal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  let me = vec2<i32>(id.xy);
  var best = jfaSrc[i];
  var bc = 1e30;
  if (best.x != 0u) { bc = valCost(me, best.y); }
  let k = i32(AP.step);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let c = jfaSrc[texIdxW(me + vec2<i32>(dx, dy) * k)];
      if (c.x == 0u) { continue; }
      let cc = valCost(me, c.y);
      if (cc < bc) {
        bc = cc;
        best = c;
      }
    }
  }
  jfaDst[i] = best;
}

@compute @workgroup_size(8, 8)
fn jfaOutVal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n || id.y >= AP.n) { return; }
  let i = id.y * AP.n + id.x;
  keyB[i] = jfaSrc[i].y;
}
