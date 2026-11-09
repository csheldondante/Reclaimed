// ---- swaylist.wgsl -------------------------------------------------------------------------------------------------
// (round 128p; the user: "when wind is low let them sleep and wake them up for gusts like other systems like dust")
// The plants' sway sleeps under the map's own breeze: which chunks the sway spring (sway.wgsl) runs over this frame,
// listed on the GPU (sim/cull.ts GpuTileList) — a chunk where the wind past the map's own (painted gusts, blows, a
// landing's shove, storms, the cursor's breeze) is more than WAKE somewhere (its middle and its corners), or whose
// spring is still swinging (`restless`, set by sway.wgsl). The rest keep the lean they have. Over a CPU list of every
// chunk in the window (SCOPE, packed as sim/cull.ts packEntry).
// Prepended: common.wgsl, materials.wgsl, `const VEC4S: u32`.

/** the wind past the map's own (cells/s) that wakes a chunk's plants: a gust, not the breeze */
const WAKE: f32 = 1.0;
const WG_PER_CHUNK: u32 = 4u;

@group(0) @binding(3) var<storage, read> surface: array<u32>;
/** per window chunk (cy * chunksX + cx): 1 its spring hasn't settled (sway.wgsl writes it) */
@group(0) @binding(5) var<storage, read_write> restless: array<u32>;
@group(0) @binding(6) var<storage, read_write> list: array<u32>;
@group(0) @binding(7) var<storage, read_write> args: array<atomic<u32>, 3>;
@group(0) @binding(8) var<uniform> SCOPE_N: vec4<u32>;
@group(0) @binding(39) var<uniform> SCOPE: array<vec4<u32>, VEC4S>;

/** a gust at column q: the wind there past the map's own (windAt's whole wind less the field's map wind, ba − rg) */
fn windyAt(q: vec2<u32>) -> bool {
  let p = vec2<u32>(min(q.x, G.mapW - 1u), min(q.y, G.mapH - 1u));
  let c = vec3<f32>(cellPos(vec2<i32>(p)), f32(sfZ(surface[colIdx(p.x, p.y)])) + 2.5);
  let f = windSample(c.xy);
  return length(windAt(c) - (f.zw - f.xy)) > WAKE;
}

@compute @workgroup_size(64)
fn swayList(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= SCOPE_N.x) { return; }
  let e = SCOPE[id.x >> 2u][id.x & 3u];
  let c = vec2<u32>(e & 63u, (e >> 6u) & 63u);
  setOwnPage(c, vec2<u32>((e >> 12u) & 63u, (e >> 18u) & 63u));
  let ci = c.y * G.chunksX + c.x;
  let o = c * G.chunkSize;
  let s = G.chunkSize - 1u;
  var wake = restless[ci] != 0u;
  if (!wake) {
    wake = windyAt(o + vec2<u32>(s / 2u)) || windyAt(o) || windyAt(o + vec2<u32>(s, 0u)) || windyAt(o + vec2<u32>(0u, s)) || windyAt(o + vec2<u32>(s));
  }
  // (sway.wgsl sets it again while the spring hasn't settled)
  restless[ci] = 0u;
  if (!wake) { return; }
  let k = atomicAdd(&args[0], WG_PER_CHUNK) / WG_PER_CHUNK;
  list[k] = e;
}
