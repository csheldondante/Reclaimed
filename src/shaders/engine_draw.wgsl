// ---- the engine's drawing: one mesh a body in every state (DESIGN §10 "Rendering skins meshes to body or voxel
// transforms by vertex weights"; the owner, 2026-11-15: "the render should not jump to voxel") -------------------------
// A body is never drawn as cubes. Rigid: its model's mesh by the row's pose. Expanded: the same mesh, each vertex by
// the voxels it is weighted to (their places and their regions' rotations). Settled: that mesh baked into the part's
// own model (engine_settle.wgsl). At the instant of expansion every particle sits at pose x rest place with the row's
// rotation, so the two are the same triangles: nothing moves on the screen.
//
// The draw list (dl, u32): [0..3] the draw's arguments (vertices, 1, 0, 0), [4..6] `eskin`'s dispatch, [7] triangles,
// then two words a triangle from DL_AT: its row, its first vertex's place in the heap. It is made again only when a
// row comes or goes (the pool's dirty word), by the GPU: rows the GPU made are drawn with no word to the host.
// Out (render.wgsl vsSkin's triangle list): a vertex [xyz bits, material word] [its triangle's normal bits, 0].
const DL_AT: u32 = 8u;
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
    atomicStore(&dl[7], 0u);
  } else {
    atomicStore(&kargs[8], 0u);
  }
}

// a thread a row slot (only when the list is made again): its model's triangles into the list
@compute @workgroup_size(64)
fn drawlist(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = id.x;
  if (r >= EU.e.x || (rowFlags(r) & ROW_ALIVE) == 0u) { return; }
  let model = bitcast<u32>(info[4u * r + 3u].x);
  if (model == 0u) { return; }
  let h = bitcast<vec4<u32>>(heap[hAt(model) + 1u]);
  let tris = h.y / 3u;
  if (tris == 0u) { return; }
  let base = atomicAdd(&dl[7], tris);
  atomicMax(&pool[P_DL_WANT], base + tris);
  let v0 = hAt(h.x);
  for (var t = 0u; t < tris; t++) {
    if (base + t >= EU.i.w) { break; }
    atomicStore(&dl[DL_AT + 2u * (base + t)], r);
    atomicStore(&dl[DL_AT + 2u * (base + t) + 1u], v0 + 3u * t * MESH_V);
  }
}

// one workgroup, every tick: the draw's and the skin's arguments from the count (past the room: what fits is drawn,
// the pool's `want` tells the host, and the list is made again once it has grown)
@compute @workgroup_size(1)
fn drawEnd() {
  let want = atomicLoad(&dl[7]);
  let n = min(want, EU.i.w);
  if (want > EU.i.w) { atomicStore(&pool[P_DL_DIRTY], 1u); }
  atomicStore(&dl[0], 3u * n);
  atomicStore(&dl[1], 1u);
  atomicStore(&dl[2], 0u);
  atomicStore(&dl[3], 0u);
  atomicStore(&dl[4], (n + 63u) / 64u);
  atomicStore(&dl[5], 1u);
  atomicStore(&dl[6], 1u);
}

struct SkinV { p: vec3<f32>, rest: vec3<f32>, word: u32, ok: bool };

/** a vertex of a deforming body: by the voxels it is weighted to */
fn skinVertex(v: u32, slot: u32, recs: u32) -> SkinV {
  let idx = bitcast<vec4<u32>>(heap[v]);
  let wt = heap[v + 1u];
  let rest = heap[v + 2u];
  var o: SkinV;
  o.rest = rest.xyz;
  o.word = bitcast<u32>(rest.w);
  var p = vec3<f32>(0.0);
  var ws = 0.0;
  for (var k = 0u; k < 4u; k++) {
    if (idx[k] == NONE || wt[k] <= 0.0) { continue; }
    let j = partAt(slot, idx[k]);
    if (!alive(j)) { continue; }
    p += (px[2u * j].xyz + eqrot(ps[3u * j + 2u], rest.xyz - heap[recs + idx[k]].xyz)) * wt[k];
    ws += wt[k];
  }
  o.ok = ws > 0.35;
  o.p = p / max(ws, 1e-6);
  return o;
}

// a thread a triangle of the list, every frame
@compute @workgroup_size(64)
fn eskin(@builtin(global_invocation_id) id: vec3<u32>) {
  let t = id.x;
  if (t >= dlR[7] || t >= EU.i.w) { return; }
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
