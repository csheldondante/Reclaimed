// ---- the engine's drawing: one mesh a body in every state (DESIGN §10 "Rendering skins meshes to body or voxel
// transforms by vertex weights"; the owner, 2026-11-15: "the render should not jump to voxel") -------------------------
// A body is never drawn as cubes. Rigid: its model's mesh by the row's pose. Expanded: the same mesh, each vertex by
// the voxels it is weighted to (their places and their regions' rotations). Settled: that mesh baked into the part's
// own model (engine_settle.wgsl). At the instant of expansion every particle sits at pose x rest place with the row's
// rotation, so the two are the same triangles: nothing moves on the screen.
//
// The draw list (dl; its words are in engine_deform.wgsl) is made again only when a row comes or goes, falls asleep or
// wakes (the pool's dirty word), by the GPU: rows the GPU made are drawn with no word to the host. The triangles of
// rows awake or deforming come first and are placed every frame; those of rows asleep come after and are placed once,
// the frame after the list is made (the owner: static geometry stays on the GPU, moved by transforms — an asleep row
// costs the frame nothing).
// Out (render.wgsl vsSkin's triangle list): a vertex [xyz bits, material word] [its triangle's normal bits, 0].
@group(0) @binding(32) var<storage, read_write> dl: array<atomic<u32>>;
@group(0) @binding(33) var<storage, read_write> dout: array<vec4<u32>>;
@group(0) @binding(34) var<storage, read> dlR: array<u32>;
// x where the frame lies between the tick's start and now
@group(0) @binding(36) var<uniform> FU: vec4<f32>;

// one workgroup, every tick: is the list to be made again?
@compute @workgroup_size(1)
fn drawArm() {
  if (atomicExchange(&pool[P_DL_DIRTY], 0u) != 0u) {
    atomicStore(&kargs[8], (EU.e.x + 63u) / 64u);
    atomicStore(&kargs[9], 1u);
    atomicStore(&kargs[10], 1u);
    atomicStore(&dl[8], 0u);
    atomicStore(&dl[9], 0u);
    atomicStore(&pool[P_DL_MAKING], 1u);
  } else {
    atomicStore(&kargs[8], 0u);
    atomicStore(&pool[P_DL_MAKING], 0u);
  }
}

/** a row's triangles into the list from `base` */
fn listRow(r: u32, base: u32, tris: u32, v0: u32) {
  for (var t = 0u; t < tris; t++) {
    if (base + t >= EU.i.w) { break; }
    atomicStore(&dl[DL_AT + 2u * (base + t)], r);
    atomicStore(&dl[DL_AT + 2u * (base + t) + 1u], v0 + 3u * t * MESH_V);
  }
}

// a thread a row slot (only when the list is made again): the triangles of the rows awake or deforming, from the start
@compute @workgroup_size(64)
fn drawlist(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = id.x;
  if (r >= EU.e.x || atomicLoad(&pool[P_DL_MAKING]) == 0u) { return; }
  let fl = rowFlags(r);
  if ((fl & ROW_ALIVE) == 0u || (fl & ROW_ASLEEP) != 0u) { return; }
  let model = bitcast<u32>(info[4u * r + 3u].x);
  if (model == 0u) { return; }
  info[4u * r].w = bitcast<f32>(fl & ~ROW_LISTED_ASLEEP);
  let h = bitcast<vec4<u32>>(heap[hAt(model) + 1u]);
  let tris = h.y / 3u;
  if (tris == 0u) { return; }
  listRow(r, atomicAdd(&dl[8], tris), tris, hAt(h.x));
}

// then the rows asleep, after them (the awake count is whole by now)
@compute @workgroup_size(64)
fn drawlistAsleep(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = id.x;
  if (r >= EU.e.x || atomicLoad(&pool[P_DL_MAKING]) == 0u) { return; }
  let fl = rowFlags(r);
  if ((fl & ROW_ALIVE) == 0u || (fl & ROW_ASLEEP) == 0u) { return; }
  let model = bitcast<u32>(info[4u * r + 3u].x);
  if (model == 0u) { return; }
  info[4u * r].w = bitcast<f32>(fl | ROW_LISTED_ASLEEP);
  let h = bitcast<vec4<u32>>(heap[hAt(model) + 1u]);
  let tris = h.y / 3u;
  if (tris == 0u) { return; }
  listRow(r, atomicLoad(&dl[8]) + atomicAdd(&dl[9], tris), tris, hAt(h.x));
}

// one workgroup, every tick: the draw's and the skin's arguments from the count (past the room: what fits is drawn,
// the pool's `want` tells the host, and the list is made again once it has grown)
@compute @workgroup_size(1)
fn drawEnd() {
  if (atomicLoad(&kargs[8]) != 0u) {
    let awake = atomicLoad(&dl[8]);
    let want = awake + atomicLoad(&dl[9]);
    atomicMax(&pool[P_DL_WANT], want);
    let n = min(want, EU.i.w);
    if (want > EU.i.w) { atomicStore(&pool[P_DL_DIRTY], 1u); }
    atomicStore(&dl[7], want);
    atomicStore(&dl[0], 3u * n);
    atomicStore(&dl[1], 1u);
    atomicStore(&dl[2], 0u);
    atomicStore(&dl[3], 0u);
    // (the list is new: the next frame places all of it, the rows asleep too — once)
    atomicStore(&dl[4], (n + 63u) / 64u);
    atomicStore(&dl[5], 1u);
    atomicStore(&dl[6], 1u);
    atomicStore(&dl[10], n);
    atomicStore(&dl[11], min(awake, EU.i.w));
  }
  // settle's mesh kernels go over the list as it stood when the tick began: only while a body settles
  let m = min(atomicLoad(&dl[7]), EU.i.w);
  atomicStore(&dl[12], select(0u, (m + 63u) / 64u, atomicLoad(&pool[P_SETTLING]) != 0u));
  atomicStore(&dl[13], 1u);
  atomicStore(&dl[14], 1u);
}

// one workgroup, every frame after `eskin`: the list has been placed whole — from now only the rows awake are
@compute @workgroup_size(1)
fn eskinEnd() {
  let awake = atomicLoad(&dl[11]);
  atomicStore(&dl[4], (awake + 63u) / 64u);
  atomicStore(&dl[10], awake);
}

struct SkinV { p: vec3<f32>, rest: vec3<f32>, word: u32, ok: bool };

/** a vertex of a deforming body: by the voxels that carry it (engine_deform.wgsl `carries`) */
fn skinVertex(v: u32, slot: u32, recs: u32) -> SkinV {
  let idx = bitcast<vec4<u32>>(heap[v]);
  let wt = heap[v + 1u];
  let rest = heap[v + 2u];
  var o: SkinV;
  o.rest = rest.xyz;
  o.word = bitcast<u32>(rest.w);
  o.ok = false;
  if (idx.x == NONE) { return o; }
  let jo = partAt(slot, idx.x);
  if (!alive(jo)) { return o; }
  let bonds = bitcast<u32>(px[2u * jo + 1u].w);
  let d = slotDims(slot);
  var p = vec3<f32>(0.0);
  var ws = 0.0;
  for (var k = 0u; k < 4u; k++) {
    if (idx[k] == NONE || wt[k] <= 0.0 || !carries(slot, d, idx.x, bonds, idx[k])) { continue; }
    let j = partAt(slot, idx[k]);
    if (!alive(j)) { continue; }
    p += (px[2u * j].xyz + eqrot(ps[3u * j + 2u], rest.xyz - heap[recs + idx[k]].xyz)) * wt[k];
    ws += wt[k];
  }
  o.ok = ws > 0.0;
  o.p = p / max(ws, 1e-6);
  return o;
}

// a thread a triangle of the list that is to be placed this frame
@compute @workgroup_size(64)
fn eskin(@builtin(global_invocation_id) id: vec3<u32>) {
  let t = id.x;
  if (t >= dlR[10] || t >= EU.i.w) { return; }
  let r = dlR[DL_AT + 2u * t];
  let v0 = dlR[DL_AT + 2u * t + 1u];
  let fl = rowFlags(r);
  var ps3 = array<vec3<f32>, 3>(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
  var word = 0u;
  var shown = (fl & ROW_ALIVE) != 0u;
  if (shown && (fl & ROW_DEFORM) != 0u) {
    let ids = bitcast<vec4<u32>>(info[4u * r + 3u]);
    let recs = hAt(ids.x) + MODEL_HDR;
    let a = skinVertex(v0, ids.y, recs);
    let b = skinVertex(v0 + MESH_V, ids.y, recs);
    let c = skinVertex(v0 + 2u * MESH_V, ids.y, recs);
    word = a.word;
    ps3 = array<vec3<f32>, 3>(a.p, b.p, c.p);
    // (its voxels mostly gone, or a crack has stretched it far past its rest size: the mesh parts there)
    let tear = G.tune.voxelsTear;
    shown = a.ok && b.ok && c.ok && length(a.p - b.p) <= length(a.rest - b.rest) * tear + 0.05 && length(b.p - c.p) <= length(b.rest - c.rest) * tear + 0.05 && length(c.p - a.p) <= length(c.rest - a.rest) * tear + 0.05;
  } else if (shown) {
    let al = clamp(FU.x, 0.0, 1.0);
    let q0 = pose[4u * r + 1u];
    var q1 = pose[4u * r + 3u];
    if (dot(q0, q1) < 0.0) { q1 = -q1; }
    let q = normalize(mix(q0, q1, al));
    let x = mix(pose[4u * r].xyz, pose[4u * r + 2u].xyz, al);
    for (var k = 0u; k < 3u; k++) { ps3[k] = x + eqrot(q, heap[v0 + k * MESH_V + 2u].xyz); }
    word = bitcast<u32>(heap[v0 + 2u].w);
  }
  if (!shown) {
    // (nothing of it to draw: three vertices at one point)
    ps3 = array<vec3<f32>, 3>(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
  }
  let n = bitcast<vec3<u32>>(normalize(cross(ps3[1] - ps3[0], ps3[2] - ps3[0]) + vec3<f32>(0.0, 0.0, 1e-9)));
  for (var k = 0u; k < 3u; k++) {
    dout[6u * t + 2u * k] = vec4<u32>(bitcast<vec3<u32>>(ps3[k]), word);
    dout[6u * t + 2u * k + 1u] = vec4<u32>(n, 0u);
  }
}
