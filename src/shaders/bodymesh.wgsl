// Bodies' own meshes, skinned (round 120; render/bodymesh.ts, render/bodymeshbuild.ts). Each frame each vertex is placed
// by its body's entry: on the node solver, by the nodes it's bound to (up to four, its own cell's node first), each
// carrying it at its offset turned with it, between the solver's last two ticks — only the nodes still in its own
// node's part, so a broken body's mesh splits along its cells' faces; or by the body's matrix (the CPU rigid rock).
// Out: render.wgsl vsSkin's triangle list (position bits + the material word, the normal bits), drawn lit and shadowed.
// Self-contained: no common.wgsl.

struct BMU { alpha: f32, count: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> U: BMU;
// per vertex: [pos (spawn frame) | word bits] [normal | entry bits] [weights] [node indices bits]
@group(0) @binding(1) var<storage, read> rest: array<vec4<f32>>;
// per entry: [mode, slot, 0, 0] [rest centre of mass] [matrix row 0] [row 1] [row 2]
@group(0) @binding(2) var<storage, read> ents: array<vec4<f32>>;
// the node solver's (solver.wgsl): 4 vec4 a node — prev pos, prev rot, pos, rot; its lanes, LANE_V vec4 a node
@group(0) @binding(3) var<storage, read> pose: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> lane: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> outv: array<vec4<u32>>;

const NN: u32 = 64u;
const LANE_V: u32 = 8u;
const ENT_V: u32 = 5u;

fn qrot(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= U.count) { return; }
  let a = rest[i * 4u];
  let b = rest[i * 4u + 1u];
  let w = rest[i * 4u + 2u];
  let ix = bitcast<vec4<u32>>(rest[i * 4u + 3u]);
  let e = bitcast<u32>(b.w);
  let e0 = ents[e * ENT_V];
  var wp = a.xyz;
  var wn = b.xyz;
  if (e0.x > 1.5) {
    // (the CPU's matrix: the spawn frame to the world)
    let r0 = ents[e * ENT_V + 2u];
    let r1 = ents[e * ENT_V + 3u];
    let r2 = ents[e * ENT_V + 4u];
    let p = vec4<f32>(a.xyz, 1.0);
    wp = vec3<f32>(dot(r0, p), dot(r1, p), dot(r2, p));
    wn = vec3<f32>(dot(r0.xyz, b.xyz), dot(r1.xyz, b.xyz), dot(r2.xyz, b.xyz));
  } else if (e0.x > 0.5) {
    let base = u32(e0.y) * NN;
    let s = a.xyz - ents[e * ENT_V + 1u].xyz;
    let al = clamp(U.alpha, 0.0, 1.0);
    let part = u32(lane[(base + ix.x) * LANE_V + 4u].z) >> 6u;
    var sp = vec3<f32>(0.0);
    var sn = vec3<f32>(0.0);
    var ws = 0.0;
    for (var k = 0u; k < 4u; k++) {
      let wk = w[k];
      if (wk <= 0.0) { continue; }
      let j = base + ix[k];
      if (lane[j * LANE_V].w < 0.0) { continue; }
      if (k > 0u && (u32(lane[j * LANE_V + 4u].z) >> 6u) != part) { continue; }
      let q0 = pose[j * 4u + 1u];
      var q1 = pose[j * 4u + 3u];
      if (dot(q0, q1) < 0.0) { q1 = -q1; }
      let q = normalize(mix(q0, q1, al));
      let x = mix(pose[j * 4u].xyz, pose[j * 4u + 2u].xyz, al);
      sp += wk * (x + qrot(q, s - lane[j * LANE_V + 6u].xyz));
      sn += wk * qrot(q, b.xyz);
      ws += wk;
    }
    if (ws > 0.0) {
      wp = sp / ws;
      wn = sn / ws;
    }
  }
  outv[i * 2u] = vec4<u32>(bitcast<vec3<u32>>(wp), bitcast<u32>(a.w));
  outv[i * 2u + 1u] = vec4<u32>(bitcast<vec3<u32>>(normalize(wn)), 0u);
}
