// (archgen) The grid lab's cells (archlab.html?gridlab=1): the irregular grid alone, lots aside — each cell a flat quad
// inset a little (the gaps show the edges; a hole shows the ground), coloured by its shape: its sharpest corner green
// at ≥ 75°, yellow at 55°, red at ≤ 35°; magenta a cell that isn't convex (folded by the relaxation).

struct GV {
  viewProj: mat4x4<f32>,
  /** x the cells' z */
  z: vec4<f32>,
};
@group(0) @binding(0) var<uniform> U: GV;
@group(0) @binding(1) var<storage, read> C: array<u32>;

struct O {
  @builtin(position) p: vec4<f32>,
  @location(0) col: vec3<f32>,
};

fn corner(i: u32, j: u32) -> vec2<f32> {
  return vec2<f32>(bitcast<f32>(C[4u + i * 8u + j * 2u]), bitcast<f32>(C[4u + i * 8u + j * 2u + 1u]));
}

@vertex
fn vsCell(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> O {
  var o: O;
  if (ii >= C[0]) { o.p = vec4<f32>(2.0, 2.0, 2.0, 1.0); return o; }
  let q = array<vec2<f32>, 4>(corner(ii, 0u), corner(ii, 1u), corner(ii, 2u), corner(ii, 3u));
  let c = (q[0] + q[1] + q[2] + q[3]) * 0.25;
  // the sharpest corner, and whether every corner turns the same way (convex)
  var amin = 180.0;
  var pos = 0u;
  var neg = 0u;
  for (var k = 0u; k < 4u; k++) {
    let a = q[(k + 1u) % 4u] - q[k];
    let b = q[(k + 3u) % 4u] - q[k];
    amin = min(amin, degrees(acos(clamp(dot(normalize(a), normalize(b)), -1.0, 1.0))));
    let cr = a.x * b.y - a.y * b.x;
    if (cr > 0.0) { pos++; } else { neg++; }
  }
  var col = mix(vec3<f32>(0.85, 0.15, 0.1), vec3<f32>(0.95, 0.8, 0.15), smoothstep(35.0, 55.0, amin));
  col = mix(col, vec3<f32>(0.3, 0.75, 0.3), smoothstep(55.0, 75.0, amin));
  if (pos != 0u && neg != 0u) { col = vec3<f32>(0.9, 0.1, 0.9); }
  let idx = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  let p = mix(q[idx[vi]], c, 0.07);
  o.p = U.viewProj * vec4<f32>(p, U.z.x, 1.0);
  o.col = col;
  return o;
}

@fragment
fn fsCell(in: O) -> @location(0) vec4<f32> { return vec4<f32>(in.col, 1.0); }
