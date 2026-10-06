// ---- contamination system ----------------------------------------------
// Two scalar fields per column: x = bound in soil, y = dissolved in water.
// Water dissolves soil contamination (faster when flowing), carries it with
// the flux published by the water system, and deposits it where water dries
// up. Water leaving the map edge carries contamination away. Vegetation
// slowly remediates soil; dissolved contamination slowly degrades.
// Only depends on the water contract (water, waterPrev, flux).
@group(0) @binding(3) var<storage, read> waterPrev: array<f32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> contamIn: array<vec2<f32>>;
@group(0) @binding(7) var<storage, read_write> contamOut: array<vec2<f32>>;
@group(0) @binding(8) var<storage, read> veg: array<f32>;

const DISSOLVE: f32 = 0.0016;
const DISSOLVE_FLOW: f32 = 0.004;
const WATER_DECAY: f32 = 0.0002;
const REMEDIATE: f32 = 0.00004;
// absolute amount per tick at rain 1: one storm (~1 min) removes ~0.4, enough
// for lightly polluted ground; heavy deposits need floods or many storms.
const RAIN_LEACH: f32 = 0.00012;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let c = contamIn[i];
  var cs = c.x;
  let dp = waterPrev[i];
  let f = flux[i];
  let out = f.x + f.y + f.z + f.w;
  var frac = 0.0;
  if (dp > 1e-6) { frac = min(1.0, out / dp); }
  var cw = c.y * (1.0 - frac);
  for (var k = 0u; k < 4u; k++) {
    let q = p + DIRS[k];
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let dq = waterPrev[j];
    if (dq > 1e-6) { cw += contamIn[j].y * min(1.0, flux[j][k ^ 1u] / dq); }
  }
  let d = water[i];
  if (d > 0.003) {
    let rate = DISSOLVE * min(d, 1.0) + DISSOLVE_FLOW * min(length(netFlow(p)) * 10.0, 1.0);
    let a = min(cs, rate * cs + rate * 0.02);
    cs -= a;
    cw += a;
  } else {
    cs += cw;
    cw = 0.0;
  }
  cw *= 1.0 - WATER_DECAY;
  cs *= 1.0 - REMEDIATE * clamp(veg[i], 0.0, 5.0);
  // rain leaches/dilutes surface contamination directly, so a passing storm
  // visibly cleans lightly polluted ground; heavy industrial deposits still
  // need sustained water (floods, repeated storms) to clear.
  cs = max(0.0, cs - RAIN_LEACH * rainAt(vec2<f32>(p) + 0.5));
  contamOut[i] = vec2<f32>(max(cs, 0.0), max(cw, 0.0));
}
