// ---- oil (second liquid): depth pass ----------------------------------------
// Applies oil flux. Oil resting on bare ground (no water under it) slowly soaks
// in and becomes soil stain (via the particle/contamination exchange buffer),
// so a spill that is never washed away leaves lasting damage.
@group(0) @binding(3) var<storage, read> oil: array<f32>;
@group(0) @binding(4) var<storage, read> oilFlux: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> oilOut: array<f32>;
@group(0) @binding(6) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read_write> contamDelta: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read> surface: array<u32>;

const SOAK: f32 = 0.0004;
const STAIN_PER_OIL: f32 = 1.5;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let f = oilFlux[i];
  var o = oil[i] - (f.x + f.y + f.z + f.w);
  for (var k = 0u; k < 4u; k++) {
    let q = p + DIRS[k];
    if (inMap(q)) { o += oilFlux[colIdxI(q)][k ^ 1u]; }
  }
  o = max(o, 0.0);
  // only loose, porous ground (soil, sand, rubble, waste) soaks oil up; tanks,
  // concrete and asphalt hold it
  let porous = matState(sfMat(surface[i])) == ST_GRANULAR;
  if (o > 0.0 && water[i] < 0.01 && porous) {
    let s = min(o, SOAK + o * 0.0005);
    o -= s;
    atomicAdd(&contamDelta[i], i32(s * STAIN_PER_OIL * 100000.0));
  }
  oilOut[i] = select(o, 0.0, o < 1e-5);
}
