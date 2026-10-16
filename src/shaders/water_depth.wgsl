// ---- water transport: depth pass ---------------------------------------
// Applies flux, rain, springs and evaporation. Publishes the water contract:
//   water     – depth after this tick
//   waterPrev – depth before this tick (contaminant transport needs it)
//   flux      – volume moved per neighbour this tick (from the flux pass)
@group(0) @binding(3) var<storage, read> water: array<f32>;
@group(0) @binding(4) var<storage, read> flux: array<Dirs>;
@group(0) @binding(5) var<storage, read> waterSource: array<f32>;
@group(0) @binding(6) var<storage, read_write> waterOut: array<f32>;
@group(0) @binding(7) var<storage, read_write> waterPrev: array<f32>;

const RAIN_RATE: f32 = 0.0012;
const EVAP: f32 = 0.00003;
const EVAP_DEEP: f32 = 0.000002;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let d = water[i];
  let f = flux[i];
  var nd = d - dSum(f);
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (inMap(q)) { nd += flux[colIdxI(q)][k ^ 1u]; }
  }
  nd += rainAt(cellPos(p)) * RAIN_RATE + waterSource[i];
  // thin films (wet ground, puddles) evaporate; deep water barely does — otherwise
  // a large lake evaporates the whole river inflow
  nd = max(0.0, nd - select(EVAP_DEEP, EVAP, nd < 0.08));
  waterPrev[i] = d;
  waterOut[i] = nd;
}
