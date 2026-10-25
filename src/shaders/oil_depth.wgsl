// ---- oil (second liquid): depth pass ----------------------------------------
// Applies oil flux. Oil resting on bare ground (no water under it) slowly soaks
// in and becomes soil stain (via the particle/contamination exchange buffer),
// so a spill that is never washed away leaves lasting damage.
@group(0) @binding(3) var<storage, read> oil: array<f32>;
@group(0) @binding(4) var<storage, read> oilFlux: array<Dirs>;
@group(0) @binding(5) var<storage, read_write> oilOut: array<f32>;
@group(0) @binding(6) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read_write> contamDelta: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read> surface: array<u32>;
// burning oil is consumed (that is how fire clears a slick)
@group(0) @binding(9) var<storage, read> fire: array<f32>;
const OIL_BURN: f32 = 0.002;
// oil sealed in closed tanks: (amount, roof z). Released when the column top
// drops below the roof (roof gone) or a neighbouring wall has fallen below it.
@group(0) @binding(10) var<storage, read_write> stored: array<vec2<f32>>;

const SOAK: f32 = 0.0004;
const STAIN_PER_OIL: f32 = 1.5;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  // (a sleeping chunk, round 80: what it holds carried through — the next buffer is copied back over this one)
  if (asleep(id.xy)) {
    let ia = colIdx(id.x, id.y);
    oilOut[ia] = oil[ia];
    return;
  }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let f = oilFlux[i];
  var o = oil[i] - (dSum(f));
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (inMap(q)) { o += oilFlux[colIdxI(q)][k ^ 1u]; }
  }
  o = max(o - fire[i] * OIL_BURN, 0.0);
  var st = stored[i];
  // a fire inside a sealed tank slowly consumes its contents
  if (st.x > 0.0 && fire[i] > 0.0) {
    st.x = max(0.0, st.x - fire[i] * OIL_BURN * 0.5);
    stored[i] = st;
  }
  if (st.x > 0.0) {
    var breach = f32(sfZ(surface[i])) < st.y;
    for (var k = 0u; k < NDIR; k++) {
      let q = nbr(p, k);
      if (inMap(q) && stored[colIdxI(q)].x <= 0.0 && f32(sfZ(surface[colIdxI(q)])) < st.y - 1.0) { breach = true; }
    }
    if (breach) {
      o += st.x;
      stored[i] = vec2<f32>(0.0, st.y);
    }
  }
  // only loose, porous ground (soil, sand, rubble, ash) soaks oil up; tanks,
  // concrete, asphalt and compacted waste hold it
  let porous = matState(groundMatAt(p, sfMat(surface[i]))) == ST_GRANULAR;
  if (o > 0.0 && water[i] < 0.01 && porous) {
    let s = min(o, SOAK + o * 0.0005);
    o -= s;
    atomicAdd(&contamDelta[i], i32(s * STAIN_PER_OIL * 100000.0));
  }
  oilOut[i] = select(o, 0.0, o < 1e-5);
}
