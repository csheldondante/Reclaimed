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
// (round 50) the ground's height: below freezing a storm drops snow there
// instead (climate.wgsl lays it)
@group(0) @binding(8) var<storage, read> surface: array<u32>;

const RAIN_RATE: f32 = 0.0012;
const EVAP: f32 = 0.00003;
const EVAP_DEEP: f32 = 0.000002;
/** (perfopt) the most a held source tops its column up by a tick (a breach upstream of it still shows) */
const HOLD_RATE: f32 = 0.5;

// (perfopt: a settling pass runs over the rect of the land just come in — x, y, w, h columns: sim/systems.ts)
@group(0) @binding(31) var<uniform> SR: vec4<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (SETTLE_PASS && (gid.x >= SR.z || gid.y >= SR.w)) { return; }
  let id = select(gid.xy, gid.xy + SR.xy, SETTLE_PASS);
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  // (a sleeping chunk, round 80: what it holds carried through — the next buffer is copied back over this one)
  // (perfopt: a settling pass — SETTLE_PASS, sim/systems.ts WaterSystem — moves its rect, the land just come in)
  if (!SETTLE_PASS && flowFrozen(id.xy, FLOW_N)) {
    let ia = colIdx(id.x, id.y);
    waterOut[ia] = water[ia];
    waterPrev[ia] = water[ia];
    return;
  }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let d = water[i];
  let f = flux[i];
  var nd = d - dSum(f);
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (inMap(q)) { nd += flux[colIdxI(q)][k ^ 1u]; }
  }
  // a source: positive, a spring (water a tick); negative (perfopt, a river's: forms.wgsl RIVER_HOLD), the depth it's
  // topped up to — the river held at its level by what comes down from upstream, however much flows on from it
  let src = waterSource[i];
  nd += rainAt(cellPos(p)) * RAIN_RATE * (1.0 - snowShare(airTempAt(f32(sfZ(surface[i]))))) + max(src, 0.0);
  if (src < 0.0) { nd = max(nd, min(-src, nd + HOLD_RATE)); }
  // thin films (wet ground, puddles) evaporate; deep water barely does — otherwise
  // a large lake evaporates the whole river inflow
  nd = max(0.0, nd - select(EVAP_DEEP, EVAP, nd < 0.08));
  // a column with nothing in it (round 69: the window slides in z, and the ground here is
  // below its floor): what runs in falls on out of the window
  if (sfCount(surface[i]) == 0u) { nd = 0.0; }
  waterPrev[i] = d;
  waterOut[i] = nd;
}
