// Terrain track (round 117): the land sampled on a grid for the region graph (terrain/sample.ts → partition.ts) — the
// atlas's own ground() (the same heights, rivers, lakes and coarse world the columns are made of), so the graph and
// what's drawn agree. Appended to Atlas.parts().

struct SampleP {
  x0: f32,
  y0: f32,
  step: f32,
  w: u32,
  h: u32,
  /** (FloodField: the flood level's datum: water stands where the ground is under the world's flood; 0 the sea) */
  sea: f32,
  _p0: f32,
  _p1: f32,
}
@group(0) @binding(40) var<uniform> SP: SampleP;
@group(0) @binding(41) var<storage, read_write> samples: array<vec4<f32>>;

/**
 * Per sample two vec4s: (ground, water surface or −1e9, wet code, lava) and (vegetation density, region, river x, coast).
 * wet: 1 a river's channel, 2 a lake, 3 the sea, 4 the coarse world's standing water.
 */
@compute @workgroup_size(8, 8)
fn sampleLand(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= SP.w || id.y >= SP.h) { return; }
  let p = vec2<f32>(SP.x0 + f32(id.x) * SP.step, SP.y0 + f32(id.y) * SP.step);
  let g = ground(p);
  let R = regs[g.a];
  var h = g.h;
  var water = -1e9;
  var wet = 0.0;
  var lava = 0.0;
  if (g.lkw && g.lk > h) {
    water = g.lk;
    wet = 2.0;
  }
  if (g.rx < 1.0 && g.rl > 0.0) {
    if (g.rflags == 1u) {
      if (g.rx < 0.5) { lava = 1.0; }
    } else if (g.rl - 0.3 > h) {
      water = max(water, g.rl - 0.3);
      wet = 1.0;
    }
  }
  if (h < AP.sea) {
    water = max(water, AP.sea);
    wet = 3.0;
  }
  if (g.cw > 0.05) {
    water = max(water, h + g.cw);
    if (wet == 0.0) { wet = 4.0; }
  }
  if (g.clava > 0.05) { lava = 1.0; }
  // vegetation: forms.wgsl's density (its woods and moisture) as 0..1 — a stand-in until flora's contract supplies the
  // plants' density (flora owns what grows; this only says where the atlas's own woods stand thick)
  var veg = 0.0;
  if (water < h && lava == 0.0 && R.veg > 0.0 && h < AP.sea + 70.0) {
    let m = moistureAt(p, g.coast, R.moist);
    let woods = smoothstep(0.05, 0.35, pfbm(torusU(p), perOf(55.0), 3u, AP.seed + 6u)) * smoothstep(AP.sea + 60.0, AP.sea + 20.0, h);
    let v = clamp(R.veg * (1.0 + m * 1.6 + woods * 2.2), 0.0, 4.2);
    veg = clamp((v - 1.2) / 3.0, 0.0, 1.0);
  }
  let o = (id.y * SP.w + id.x) * 2u;
  samples[o] = vec4<f32>(h, water, wet, lava);
  samples[o + 1u] = vec4<f32>(veg, bitcast<f32>(g.a), g.rx, g.coast);
}
