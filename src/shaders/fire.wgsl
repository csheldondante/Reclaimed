// ---- fire -------------------------------------------------------------------
// fire[i] = burning intensity 0..1 of column i. Fuel comes from what is there:
// oil (best fuel), vegetation (grass burns fast, forest hot), loose waste.
// Spread is a race-free gather: each column looks at burning neighbours and
// catches with a chance that rises with their intensity, its own fuel and
// dryness, and with the wind blowing *from* that neighbour. Water, rain and
// wet ground put fire out. Lightning ignites anything with fuel.
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

const MAT_TRASH_F: u32 = 12u;

fn fuelAt(i: u32) -> f32 {
  var f = min(oil[i], 1.0) * 3.0;
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
  let r = rand3(id.x, id.y, G.tick ^ 0xf17eu);

  // lightning ignites fuel at the strike
  for (var e = 0u; e < numEvents(); e++) {
    if (u32(G.eventKind[e]) != EV_LIGHTNING) { continue; }
    let ev = G.events[e];
    if (length(vec2<f32>(p) + 0.5 - ev.xy) < 2.5 && fuel > 0.2) { f = max(f, 0.9); }
  }

  if (f > 0.0) {
    // burns while there is fuel; damped by water, rain, damp ground
    let damp = select(0.0, 1.0, d > 0.08) + rain * 0.35 + smoothstep(0.4, 0.9, wet) * 0.15;
    f += (min(fuel, 1.0) * 0.04 - 0.015) - damp * 0.125;
    if (fuel < 0.05) { f -= 0.04; }
  } else if (fuel > 0.1 && d < 0.05) {
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
    let dry = 1.0 - smoothstep(0.25, 0.75, wet);
    let chance = heat * min(fuel, 1.5) * dry * (1.0 - min(rain, 1.0)) * 0.11;
    if (r < chance) { f = 0.5; }
  }
  fireOut[i] = clamp(f, 0.0, 1.0);
}
