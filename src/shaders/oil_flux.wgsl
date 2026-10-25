// ---- oil (second liquid): flux pass ------------------------------------------
// Same virtual-pipes model as water, but oil rides on top of the water
// surface (H = ground + water + oil), is more viscous (lower gain, more
// friction) and is dragged along by the water's own net flow, so a river
// carries a slick downstream. Drift dust is part of the bed (round 13). Edges drain: oil leaving the map is gone.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read> oil: array<f32>;
@group(0) @binding(6) var<storage, read_write> oilFlux: array<Dirs>;
@group(0) @binding(7) var<storage, read> flux: array<Dirs>;

const OIL_GAIN: f32 = 0.06 * 2.0 / 3.0; // per pipe (water_flux.wgsl)
const OIL_FRICTION: f32 = 0.95;
const CURRENT_DRAG: f32 = 0.6;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  // (a sleeping chunk: round 80)
  if (id.x >= G.mapW || id.y >= G.mapH || asleep(id.xy)) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let o = oil[i];
  if (o <= 1e-5) { oilFlux[i] = dZero(); return; }
  let g = f32(sfZ(surface[i])) + driftAt(p) + water[i];
  let H = g + o;
  let d = max(water[i], 1e-4);
  let wf = flux[i];
  var f = oilFlux[i];
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    var Hn = g;
    var back = 0.0;
    if (inMap(q)) {
      let j = colIdxI(q);
      Hn = f32(sfZ(surface[j])) + driftAt(q) + water[j] + oil[j];
      back = flux[j][k ^ 1u];
    }
    // current: share of the water column moving this way this tick
    let current = max(0.0, wf[k] - back) / d;
    f[k] = max(0.0, f[k] * OIL_FRICTION + OIL_GAIN * (H - Hn) + CURRENT_DRAG * current * o);
  }
  let total = dSum(f);
  if (total > o) { f = dScale(f, o / total); }
  oilFlux[i] = f;
}
