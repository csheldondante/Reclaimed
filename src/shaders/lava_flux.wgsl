// ---- lava (molten rock): flux pass (docs/PHYSICS.md "Lava") -------------------
// The same virtual pipes as water and oil, but thick: lava flows only while
// hot (fluidity falls to nothing at the setting point), slowly, and not at
// all down a step smaller than its yield, so it runs in tongues and levees
// instead of spreading into a film. It lies on the ground and on bodies
// (bodyProj), ignores water (water over it boils away: lava.wgsl). Edges
// drain.
//   lava: x depth, y temperature, z the ground's heat at its top, w the
//   lava's surface height (lava.wgsl writes it; physics reads it)
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> lava: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> lavaFlux: array<Dirs>;

// LAVA_GAIN (was 0.012): G.tune.lavaGain (round 108, src/tune/params.ts)
// LAVA_FRICTION (was 0.9): G.tune.lavaFriction (round 108, src/tune/params.ts)
// it won't move for less of a step than this (cells)
// LAVA_YIELD (was 0.12): G.tune.lavaYield (round 108, src/tune/params.ts)
const LAVA_SET: f32 = 750.0;
const LAVA_RUNNY: f32 = 1150.0;
// thin lava barely moves (round 48: a film raced down a volcano's sides
// unseen): it flows as (depth / this)², full above it, so it thickens into
// tongues and streams that can be seen running down
const LAVA_THICK: f32 = 0.8;

fn bedAt(q: vec2<i32>) -> f32 {
  return groundZ(q, f32(sfZ(surface[colIdxI(q)])));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  // (a sleeping chunk: round 80)
  if (id.x >= G.mapW || id.y >= G.mapH || flowFrozen(id.xy, FLOW_N)) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let L = lava[i];
  if (L.x <= 1e-4) { lavaFlux[i] = dZero(); return; }
  let thick = min(L.x / LAVA_THICK, 1.0);
  let fluid = smoothstep(LAVA_SET, LAVA_RUNNY, L.y) * thick * thick;
  let H = bedAt(p) + L.x;
  var f = lavaFlux[i];
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    // (off the map: drains like a cliff)
    var Hn = H - 4.0;
    if (inMap(q)) { Hn = bedAt(q) + lava[colIdxI(q)].x; }
    f[k] = max(0.0, f[k] * G.tune.lavaFriction + G.tune.lavaGain * fluid * (H - Hn - G.tune.lavaYield));
    if (fluid <= 0.0) { f[k] = 0.0; }
  }
  let total = dSum(f);
  if (total > L.x) { f = dScale(f, L.x / total); }
  lavaFlux[i] = f;
}
