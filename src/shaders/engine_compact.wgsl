// ---- the engine's rows awake, compacted (engine.wgsl; a thread a row in use: the one read an asleep row costs) -------
// The host's commands are taken here too (a velocity change, a wake, the window's slide), so nothing else has to
// visit a row asleep.
@group(0) @binding(10) var<storage, read_write> list: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read> surfaceIn: array<u32>;

@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = id.x;
  if (r == 0u) {
    atomicStore(&list[1], 1u);
    atomicStore(&list[2], 1u);
    atomicStore(&list[5], 1u);
    atomicStore(&list[6], 1u);
  }
  if (r >= EU.e.x) { return; }
  var fl = rowFlags(r);
  if ((fl & ROW_ALIVE) == 0u) { return; }
  var wake = false;
  var dv = vec3<f32>(0.0);
  var shiftBy = vec3<f32>(0.0);
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
    }
  }
  // (a sleeper whose ground changed — dug, cut, washed out, built on: the surface pass's word of the column under its
  // centre isn't the one it fell asleep on. One read a row asleep; the word is fresh this tick.)
  if ((fl & ROW_ASLEEP) != 0u) {
    let c = cellAt(x.xy);
    if (inMap(c) && surfaceIn[colIdxI(c)] != bitcast<u32>(pose[4u * r].w)) { wake = true; }
  }
  if (any(shiftBy != vec3<f32>(0.0))) {
    pose[4u * r] = vec4<f32>(pose[4u * r].xyz + shiftBy, pose[4u * r].w);
    pose[4u * r + 2u] = vec4<f32>(x + shiftBy, pose[4u * r + 2u].w);
  }
  if (wake) {
    if ((fl & ROW_ASLEEP) != 0u) {
      fl = fl & ~ROW_ASLEEP;
      info[3u * r].w = bitcast<f32>(fl);
    }
    let v = vel[2u * r];
    vel[2u * r] = vec4<f32>(v.xyz + dv, 0.0);
  }
  if ((fl & ROW_ASLEEP) != 0u) { return; }
  let k = atomicAdd(&list[3], 1u);
  atomicAdd(&list[4], 1u);
  if (k % 64u == 0u) { atomicAdd(&list[0], 1u); }
  atomicStore(&list[LIST_AT + k], r);
}
