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
/** (?rivers=hold / ?riverhold=1, the perf agent's) the most a held source tops its column up by a step (a breach
 *  upstream of it still shows) */
const HOLD_RATE: f32 = 0.5;
/** (round 84, ?rivers=table) how fast a held river's column comes to the table's depth (a step's share): the river
 *  rises and falls with the wetness, and comes back to its level when a breach falls asleep, smoothly */
const RIVER_RELAX: f32 = 0.02;

// (perfopt: a settling pass runs over the rect of the land just come in — x, y, w, h columns: sim/systems.ts)
@group(0) @binding(31) var<uniform> SR: vec4<u32>;
@group(0) @binding(22) var riverFlowTex: texture_2d<f32>;
// (round 84) per chunk the most a column's water changed in a step (sim/world-gpu.ts waterChange)
@group(0) @binding(9) var<storage, read_write> waterChange: array<atomic<u32>>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (SETTLE_PASS && (gid.x >= SR.z || gid.y >= SR.w)) { return; }
  let id = select(gid.xy, gid.xy + SR.xy, SETTLE_PASS);
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  // (round 84, ?rivers=table: a river's column nothing has woken: the atlas's table at the rivers' wetness, no
  // simulation — riverheld.wgsl)
  let rh = riverHere(id.xy);
  if (riverHeld(id.xy, rh)) {
    let ia = colIdx(id.x, id.y);
    waterPrev[ia] = water[ia];
    // (round 104, simscale: off from anything live, a held river is updated every RIVER_SLOW_N ticks — sim/cull.ts
    // NEAR — so it relaxes that many steps' worth at once)
    var relax = RIVER_RELAX;
    if (RIVER_SLOW_N > 1u && !nearLive(id.xy)) { relax = 1.0 - pow(1.0 - RIVER_RELAX, f32(RIVER_SLOW_N)); }
    waterOut[ia] = mix(water[ia], rh.depth, relax);
    return;
  }
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
  // a source: positive, a spring (water a step); negative (?rivers=hold: forms.wgsl RIVER_HOLD), the depth it's
  // topped up to — the river held at its level by what comes down from upstream
  let src = waterSource[i];
  nd += rainAt(cellPos(p)) * RAIN_RATE * (1.0 - snowShare(airTempAt(f32(sfZ(surface[i]))))) + max(src, 0.0);
  if (src < 0.0) { nd = max(nd, min(-src, nd + HOLD_RATE)); }
  // thin films (wet ground, puddles) evaporate; deep water barely does — otherwise
  // a large lake evaporates the whole river inflow
  nd = max(0.0, nd - select(EVAP_DEEP, EVAP, nd < 0.08));
  // a column with nothing in it (round 69: the window slides in z, and the ground here is
  // below its floor): what runs in falls on out of the window — but not under the sea (round 88): there the
  // column under the floor is the sea's, full, and the water stands on the floor at the sea's level (it drained
  // in, the sea beside it stood as a wall over the dry floor)
  if (sfCount(surface[i]) == 0u && G.ocean.x <= 0.0) { nd = 0.0; }
  // (round 84, ?rivers=table&riverpull=x: a woken river's column pulled toward the atlas's table by x a step — what
  // comes down from upstream past the window keeps coming: a breach is fed, the river runs on past it)
  if (RIVER_PULL > 0.0 && rh.on) { nd = mix(nd, rh.depth, RIVER_PULL); }
  waterPrev[i] = d;
  waterOut[i] = nd;
  let dd = abs(nd - d);
  if (dd > 1e-4) {
    let c = (id.y / G.chunkSize) * G.chunksX + id.x / G.chunkSize;
    if (c < 2048u) { atomicMax(&waterChange[c], bitcast<u32>(dd)); }
  }
}
