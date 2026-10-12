// ---- fire -------------------------------------------------------------------
// fire[i] = burning intensity 0..1 of column i. Fuel comes from what is there:
// oil (best fuel), vegetation (grass burns fast, forest hot), loose waste.
// Spread is a race-free gather: each column looks at burning neighbours and
// catches with a chance that rises with their intensity, its own fuel and
// dryness, and with the wind blowing *from* that neighbour. Water, rain and
// wet ground put fire out — except oil floating on water, which burns on the
// water. Woodland burns even on damp ground once lit (DECISIONS round 5).
// Lightning ignites anything with fuel; so, sometimes, does an ember landing
// on it (round 28: sparkTex, written by particles).
// Consumers (each burns its own resource from `fire`): oil system (oil),
// ecology (plants), structure (trash; heat damage to concrete/steel),
// particles (flames, embers, smoke), render fields (glow).
@group(0) @binding(3) var<storage, read> fireIn: array<f32>;
@group(0) @binding(4) var<storage, read_write> fireOut: array<f32>;
@group(0) @binding(5) var<storage, read> oil: array<f32>;
@group(0) @binding(6) var<storage, read> veg: array<f32>;
@group(0) @binding(7) var<storage, read> moisture: array<f32>;
@group(0) @binding(8) var<storage, read> water: array<f32>;
@group(0) @binding(9) var<storage, read> surface: array<u32>;
// oil sealed in closed tanks also burns (inside the shell) once lit
@group(0) @binding(10) var<storage, read> stored: array<vec2<f32>>;
@group(0) @binding(22) var sparkTex: texture_2d<f32>;
/** chance an ember landing on dry fuel lights it (scaled by the fuel, less on damp ground) */
const EMBER_CATCH: f32 = 0.35;

const MAT_TRASH_F: u32 = 12u;

fn fuelAt(i: u32) -> f32 {
  // any oil film is fuel: spills spread thin within a second, and a film
  // scored by depth alone (3 × depth) was too thin to burn — slicks went out
  let o = oil[i] + stored[i].x;
  var f = select(0.0, 1.2 + min(o, 1.0) * 2.0, o > 0.004);
  let v = veg[i];
  f += smoothstep(0.5, 2.0, v) * 0.6 + smoothstep(3.0, 5.0, v) * 0.6;
  if (sfMat(surface[i]) == MAT_TRASH_F) { f += 0.8; }
  return f;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let fuel = fuelAt(i);
  let wet = moisture[i];
  let d = water[i];
  let rain = rainAt(vec2<f32>(p) + 0.5);
  var f = fireIn[i];
  // oil film on water: the fire sits on the oil, the water can't reach it
  let oily = oil[i] > 0.03;
  let wetGround = select(d, 0.0, oily);
  // woods: dense dry wood under the canopy keeps burning on damp ground
  let forest = smoothstep(3.0, 4.5, veg[i]);
  let r = rand3(id.x, id.y, G.tick ^ 0xf17eu);

  // lightning ignites fuel at the strike
  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_LIGHTNING) { continue; }
    let ev = G.events[e];
    if (length(vec2<f32>(p) + 0.5 - ev.xy) < min(ev.z, 4.0) && fuel > 0.2) { f = max(f, 0.9); }
  }

  if (f > 0.0) {
    // burns while there is fuel; damped by water, rain, damp ground
    // burning oil shrugs off rain (round 15: oil burns even in the rain;
    // trees still go out)
    let oilFire = smoothstep(0.004, 0.03, oil[i]);
    let damp = select(0.0, 1.0, wetGround > 0.08) + (rain * 0.35 + smoothstep(0.4, 0.9, wet) * 0.15 * (1.0 - 0.8 * forest)) * (1.0 - oilFire);
    f += (min(fuel, 1.0) * 0.04 - 0.015) - damp * 0.125;
    if (fuel < 0.05) { f -= 0.04; }
  } else if (fuel > 0.1 && wetGround < 0.05) {
    // an ember landed here last tick
    let sk = textureLoad(sparkTex, p, 0).x;
    if (sk > 0.0 && f32(G.tick) - sk < 1.5 && r < EMBER_CATCH * min(fuel, 1.0) * (1.0 - smoothstep(0.3, 0.8, wet)) * (1.0 - rain)) { f = 0.5; }
    // catch from burning neighbours (wind carries flames downwind)
    var heat = 0.0;
    for (var k = 0u; k < 4u; k++) {
      let q = p + DIRS[k];
      if (!inMap(q)) { continue; }
      let nf = fireIn[colIdxI(q)];
      if (nf <= 0.0) { continue; }
      let w = windAt(vec3<f32>(vec2<f32>(q) + 0.5, 1.0));
      // DIRS[k] points from me to the neighbour; wind from it toward me helps
      let toward = -dot(normalize(w + vec2<f32>(1e-4)), vec2<f32>(DIRS[k]));
      heat += nf * (0.6 + 0.9 * max(toward, 0.0) * min(length(w) / 4.0, 1.5));
    }
    let dry = 1.0 - smoothstep(0.25, 0.75, wet) * (1.0 - 0.7 * forest);
    // oil goes up fast, waste smoulders across a heap, plants catch slowly so
    // a wildfire creeps (round 5: relaxed)
    var rate = select(0.006, 0.11, oil[i] > 0.004);
    if (sfMat(surface[i]) == MAT_TRASH_F) { rate = max(rate, 0.05); } // dumps smoulder across
    // (rain doesn't stop flames spreading across oil either)
    let rainStop = select(min(rain, 1.0), 0.0, oil[i] > 0.004);
    let chance = heat * min(fuel, 1.5) * select(dry, 1.0, oil[i] > 0.004) * (1.0 - rainStop) * rate;
    if (r < chance) { f = 0.5; }
  }
  fireOut[i] = clamp(f, 0.0, 1.0);
}
