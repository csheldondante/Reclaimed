// ---- water transport: flux pass ---------------------------------------
// Column-volume "virtual pipes" model. flux[i] holds the volume (cells^3)
// leaving column i this tick toward each neighbour (NDIR order, common.wgsl).
// Columns at the map edge drain outward (the world continues downhill) — down to the sea's level where
// there is one (G.ocean.x, round 79: the sea in a streamed window stays).
// Loose dust (drift) is part of the bed: water lies on top of it (round 13).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read_write> flux: array<Dirs>;
// oil floating on the water adds (lighter) weight to the water head
@group(0) @binding(6) var<storage, read> oil: array<f32>;
const OIL_DENSITY: f32 = 0.88;

// per pipe: the hex Laplacian weights each of the six neighbours 2/3 as much
// as the square grid's four (the same continuum spreading rate)
const GAIN: f32 = 0.12 * 2.0 / 3.0;
const FRICTION: f32 = 0.985;

// (round 84, ?rivers=table: riverheld.wgsl) the atlas's rivers at their steady state
@group(0) @binding(22) var riverFlowTex: texture_2d<f32>;
// (perfopt: a settling pass runs over the rect of the land just come in — x, y, w, h columns: sim/systems.ts)
@group(0) @binding(31) var<uniform> SR: vec4<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (SETTLE_PASS && (gid.x >= SR.z || gid.y >= SR.w)) { return; }
  let id = select(gid.xy, gid.xy + SR.xy, SETTLE_PASS);
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  // (a sleeping chunk: round 80 — its flux frozen as it is, the surface drawn moving by it. perfopt, ?settle=0:
  // land come in asleep has none — a river would be drawn still — so while it's drowsy (just come in) a column
  // with no flux takes the pipes' steady state for its levels at once: f = GAIN (H - Hn) / (1 - FRICTION))
  // (round 84, ?rivers=table: a river's column nothing has woken is held at the atlas's steady state — its flux the
  // pipes' steady flux for its levels, so what's awake beside it is fed as the river would feed it)
  // (a settling pass, SETTLE_PASS: its rect, the land just come in, the pipes as awake)
  let held = !SETTLE_PASS && riverHeld(id.xy, riverHere(id.xy));
  let seed = (!SETTLE_PASS && flowFrozen(id.xy, FLOW_N)) || held;
  if (seed && !held && !(FLUX_SEED && drowsy(id.xy) && dSum(flux[i]) == 0.0)) { return; }
  let d = water[i];
  if (d <= 1e-5) { flux[i] = dZero(); return; }
  // (a body lying here is ground to the water: round 17)
  let g = max(f32(sfZ(surface[i])) + driftAt(p), bodyTopAt(p));
  let H = g + d + oil[i] * OIL_DENSITY;
  var f = flux[i];
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    var Hn = max(g, G.ocean.x);
    if (inMap(q)) {
      let j = colIdxI(q);
      Hn = max(f32(sfZ(surface[j])) + driftAt(q), bodyTopAt(q)) + water[j] + oil[j] * OIL_DENSITY;
    }
    f[k] = select(max(0.0, f[k] * FRICTION + GAIN * (H - Hn)), max(0.0, GAIN / (1.0 - FRICTION) * (H - Hn)), seed);
  }
  let total = dSum(f);
  if (total > d) { f = dScale(f, d / total); }
  flux[i] = f;
}
