// Terrain track (round 117): a basin flooded by height on the GPU (terrain/flood.ts) — the user: "I think instead of a
// global sea level a GPU flood fill based on height would let us easily flood areas and would be a nice tool. We can
// flood with water, sand, magma etc." / "A GPU algorithm we use for generative tools. I want to be able to flood a
// basin and bury things and flood fill based on heightmap makes that easy."
//
// Over an M×M window of a heightmap (the atlas's macro ground, a texel 8 cells):
//  - fill: the depression-filled surface (Planchon & Darboux): W starts at +inf inside, the ground at the outlets (the
//    window's edge, the standing sea: set by flood.ts); each pass W = max(h, min(W, min of the neighbours' W)); stable, W is the level water
//    would stand at — the seed's W is its basin's spill height.
//  - mark: the basin itself — the texels joined to the seed through ground under the level (a dilation from the seed).
// Each pass is one dispatch; `changed` counts texels that moved, read back every few dozen passes to stop.

struct FloodP {
  m: u32,
  seed: u32,
  level: f32,
  _p: u32,
}
@group(0) @binding(0) var<uniform> FP: FloodP;
@group(0) @binding(1) var<storage, read> hgt: array<f32>;
@group(0) @binding(2) var<storage, read> wIn: array<f32>;
@group(0) @binding(3) var<storage, read_write> wOut: array<f32>;
@group(0) @binding(4) var<storage, read_write> changed: array<atomic<u32>>;

fn nbW(x: i32, y: i32) -> f32 {
  let m = i32(FP.m);
  if (x < 0 || y < 0 || x >= m || y >= m) { return 1e30; }
  return wIn[u32(y) * FP.m + u32(x)];
}

@compute @workgroup_size(8, 8)
fn fillStep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= FP.m || id.y >= FP.m) { return; }
  let i = id.y * FP.m + id.x;
  let x = i32(id.x);
  let y = i32(id.y);
  var n = min(min(nbW(x + 1, y), nbW(x - 1, y)), min(nbW(x, y + 1), nbW(x, y - 1)));
  n = min(n, min(min(nbW(x + 1, y + 1), nbW(x - 1, y - 1)), min(nbW(x - 1, y + 1), nbW(x + 1, y - 1))));
  let w = max(hgt[i], min(wIn[i], n));
  if (w < wIn[i]) { atomicAdd(&changed[0], 1u); }
  wOut[i] = w;
}

/** the mark: 1 where joined to the seed under the level (wIn/wOut as 0/1) */
@compute @workgroup_size(8, 8)
fn markInit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= FP.m || id.y >= FP.m) { return; }
  let i = id.y * FP.m + id.x;
  wOut[i] = select(0.0, 1.0, i == FP.seed && hgt[i] < FP.level);
}

@compute @workgroup_size(8, 8)
fn markStep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= FP.m || id.y >= FP.m) { return; }
  let i = id.y * FP.m + id.x;
  let x = i32(id.x);
  let y = i32(id.y);
  if (wIn[i] > 0.5) {
    wOut[i] = 1.0;
    return;
  }
  var v = 0.0;
  if (hgt[i] < FP.level) {
    // (8 neighbours, as the fill: water spills through a diagonal gap as through the river graph's)
    var dxs = array<i32, 8>(1, -1, 0, 0, 1, -1, -1, 1);
    var dys = array<i32, 8>(0, 0, 1, -1, 1, -1, 1, -1);
    for (var k = 0; k < 8; k++) {
      let nx = x + dxs[k];
      let ny = y + dys[k];
      if (nx < 0 || ny < 0 || nx >= i32(FP.m) || ny >= i32(FP.m)) { continue; }
      if (wIn[u32(ny) * FP.m + u32(nx)] > 0.5) { v = 1.0; }
    }
  }
  if (v > 0.5) { atomicAdd(&changed[0], 1u); }
  wOut[i] = v;
}
