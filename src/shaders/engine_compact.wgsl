// ---- the engine's rows awake, compacted (engine.wgsl; a thread a row in use: the one read an asleep row costs) -------
// The host's commands are taken here too (a velocity change, a wake, the window's slide), so nothing else has to
// visit a row asleep.
@group(0) @binding(10) var<storage, read_write> list: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read> surfaceIn: array<u32>;
@group(0) @binding(18) var<storage, read_write> poolC: array<atomic<u32>>;
// the list's dispatch arguments again, in a buffer of their own (words 0-2 and 4-6 as the list's): a kernel that
// writes the list's buffer (the rows' work words, engine_pairs.wgsl) cannot be dispatched from it
@group(0) @binding(50) var<storage, read_write> rargs: array<atomic<u32>>;

@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = id.x;
  if (r == 0u) {
    atomicStore(&list[1], 1u);
    atomicStore(&list[2], 1u);
    atomicStore(&list[5], 1u);
    atomicStore(&list[6], 1u);
    atomicStore(&rargs[1], 1u);
    atomicStore(&rargs[2], 1u);
    atomicStore(&rargs[5], 1u);
    atomicStore(&rargs[6], 1u);
  }
  if (r >= EU.e.x) { return; }
  var fl = rowFlags(r);
  if ((fl & ROW_ALIVE) == 0u) { return; }
  // (its particles carry it: engine_deform.wgsl moves them)
  if ((fl & ROW_DEFORM) != 0u) { return; }
  var wake = false;
  var epoch = false;
  var dv = vec3<f32>(0.0);
  var dw = vec3<f32>(0.0);
  var shiftBy = vec3<f32>(0.0);
  var picking = false;
  let x = pose[4u * r + 2u].xyz;
  for (var c = 0u; c < EU.e.y; c++) {
    let k = EC[c].b.x;
    if (k == 1u && EC[c].b.y == r) {
      dv += EC[c].a.xyz;
      wake = true;
    } else if (k == 2u && EC[c].b.y == r) {
      wake = true;
    } else if (k == 3u && distance(x, EC[c].a.xyz) < EC[c].a.w + vel[2u * r + 1u].w) {
      wake = true;
    } else if (k == 4u) {
      shiftBy += EC[c].a.xyz;
    } else if (k == 5u && EC[c].b.y == r && (EU.e.w & 4u) != 0u && bitcast<u32>(info[4u * r + 3u].x) != 0u) {
      wake = true;
      fl = fl | ROW_EXPAND;
      info[4u * r].w = bitcast<f32>(fl);
    } else if (k == 7u) {
      // (the host's grab: every row the pick ray passes — within the thumb's radius of its bound sphere, ahead of the
      // ray's start — bids how near the eye it is; the nearest is left in the slot when the kernel ends)
      picking = true;
      let rd = bitcast<vec3<f32>>(EC[c].b.yzw);
      let along = dot(x - EC[c].a.xyz, rd);
      let off = length(x - EC[c].a.xyz - rd * along);
      if (along > 0.0 && off < EC[c].a.w + vel[2u * r + 1u].w) { atomicMax(&poolC[P_GRAB], ((4095u - min(u32(along * 4.0), 4094u)) << 20u) | (r & 0xfffffu)); }
    }
  }
  // (the row the grab holds, from the tick after the pick — while rows bid the slot is not settled: it is awake and
  // marked for `integrate`'s spring while the host holds a target; let go, or another picked, the mark goes)
  let gk = atomicLoad(&poolC[P_GRAB]);
  let mine = !picking && EU.o.w > 0.5 && gk != 0u && (gk & 0xfffffu) == r;
  if (mine != ((fl & ROW_GRAB) != 0u)) {
    fl = fl ^ ROW_GRAB;
    info[4u * r].w = bitcast<f32>(fl);
    // (the hold begins: the height it is at is the plane it is dragged in — engine.wgsl grabPull)
    if (mine) { info[4u * r + 3u].z = x.z; }
  }
  if (mine) { wake = true; }
  // (a sleeper whose ground changed — dug, cut, washed out, built on: the surface pass's word of the column under its
  // centre isn't the one it fell asleep on. One read a row asleep; the word is fresh this tick.)
  if ((fl & ROW_ASLEEP) != 0u) {
    let c = cellAt(x.xy);
    if ((fl & ROW_NEWSLEEP) != 0u) {
      // (settle made it asleep where its particles stood: the ground's word it sleeps on is taken here)
      var word = 0u;
      if (inMap(c)) { word = surfaceIn[colIdxI(c)]; }
      pose[4u * r].w = bitcast<f32>(word);
      fl = fl & ~ROW_NEWSLEEP;
      info[4u * r].w = bitcast<f32>(fl);
      // (made asleep: the coarse pass's sleeper table is out of date)
      epoch = true;
    } else if (inMap(c) && surfaceIn[colIdxI(c)] != bitcast<u32>(pose[4u * r].w)) { wake = true; }
    // (a pair asked it to wake last tick — engine_pairs.wgsl pairPre: a hit over the threshold, or what it leans on
    // moved. It wakes with what the pair solver gave it meanwhile, and deforms if the hit passed its material's bar.)
    let b = rwAt(r);
    // (the GPU's own tick count, which `integrate` puts up after this kernel: still the stamping tick's)
    let gt = atomicLoad(&list[tickAt()]);
    if (gt > 0u && atomicLoad(&list[b + RW_WAKE]) == gt) {
      wake = true;
      dv += vec3<f32>(f32(bitcast<i32>(atomicExchange(&list[b + RW_DV], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DV + 1u], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DV + 2u], 0u)))) / FPV;
      dw += vec3<f32>(f32(bitcast<i32>(atomicExchange(&list[b + RW_DW], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DW + 1u], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DW + 2u], 0u)))) / FPV;
      let e = bitcast<f32>(atomicExchange(&list[b + RW_ENERGY], 0u));
      let mi = bitcast<vec4<u32>>(info[4u * r + 2u]);
      let thr = expandAt(mi.z & 0xffu);
      if ((EU.e.w & 4u) != 0u && thr > 0.0 && e > thr * info[4u * r + 1u].w && bitcast<u32>(info[4u * r + 3u].x) != 0u) {
        fl = fl | ROW_EXPAND;
        info[4u * r].w = bitcast<f32>(fl);
      }
    }
    if (any(shiftBy != vec3<f32>(0.0))) { epoch = true; }
  }
  if (any(shiftBy != vec3<f32>(0.0))) {
    pose[4u * r] = vec4<f32>(pose[4u * r].xyz + shiftBy, pose[4u * r].w);
    pose[4u * r + 2u] = vec4<f32>(x + shiftBy, pose[4u * r + 2u].w);
  }
  if (wake) {
    if ((fl & ROW_ASLEEP) != 0u) {
      fl = fl & ~ROW_ASLEEP;
      info[4u * r].w = bitcast<f32>(fl);
      epoch = true;
    }
    let v = vel[2u * r];
    vel[2u * r] = vec4<f32>(v.xyz + dv, 0.0);
    let sp = vel[2u * r + 1u];
    vel[2u * r + 1u] = vec4<f32>(sp.xyz + dw, sp.w);
  }
  if (epoch) { atomicAdd(&list[LIST_EPOCH], 1u); }
  // (it waits to deform: frozen as it came in till `expand` runs, which the host encodes once it has read this)
  if ((fl & ROW_EXPAND) != 0u) { atomicAdd(&poolC[P_EXPAND_WAIT], 1u); }
  // (the draw list keeps the triangles of rows asleep apart, placed once: a row that fell asleep or woke since it was
  // made asks for it again)
  if (((fl & ROW_ASLEEP) != 0u) != ((fl & ROW_LISTED_ASLEEP) != 0u) && bitcast<u32>(info[4u * r + 3u].x) != 0u) { atomicStore(&poolC[P_DL_DIRTY], 1u); }
  if ((fl & ROW_ASLEEP) != 0u) { return; }
  let k = atomicAdd(&list[3], 1u);
  atomicAdd(&list[4], 1u);
  atomicAdd(&rargs[4], 1u);
  if (k % 64u == 0u) {
    atomicAdd(&list[0], 1u);
    atomicAdd(&rargs[0], 1u);
  }
  atomicStore(&list[LIST_AT + k], r);
}
