// ---- climate: snow, ice, fallen leaves (round 50; sim/climate.ts) ---------------
// The air's temperature (common.wgsl airTempAt: the climate in G.rules, colder
// up high and at night) plus the heat of lava and fire on a column decides:
//  - a cold storm drops snow (the water pass leaves that share of its rain
//    out): laid through `deposit`, so it lands like any loose ground
//  - snow on top melts when it's warm (to its depth in water)
//  - ice on top melts (to nine tenths), water freezes on the ground under it
//    in the cold (a pond freezes from its bed up: ice under water, then a
//    sheet when it's all frozen)
//  - trees drop leaves (leaf litter, a thin carpet under them), which rot
//    into soil where the ground is damp
// One thread a column; a column's intervals are only touched by its own
// thread. Every 4th tick.
@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> water: array<f32>;
// loose material arriving (y amount, z material: sediment.wgsl lands it); a
// column something else is already landing on this tick is left alone
@group(0) @binding(5) var<storage, read_write> deposit: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> vegC: array<f32>;
@group(0) @binding(7) var<storage, read> moistC: array<f32>;
@group(0) @binding(8) var<storage, read> fireC: array<f32>;
// molten rock (lava.wgsl): x depth, y temperature, z the ground's heat at its top
@group(0) @binding(9) var<storage, read> lavaC: array<vec4<f32>>;

const DT_C: f32 = 4.0 / 60.0;
/** (perfopt, simhz) the world time an update stands for */
fn dtC() -> f32 { return DT_C * simStep(); }
// as water_depth.wgsl's: depth a storm of intensity 1 drops a tick
const RAIN_RATE_C: f32 = 0.0012;
// a cold storm drops half as much as it would rain (the game's rain is
// heavy: a storm's worth at 1:1 buried the sandbox pond's shore in two
// cells of snow a minute), and snow melts to the depth of water it is
const SNOW_FALL: f32 = 0.5;
// cells a second per degree over freezing
const MELT_SNOW: f32 = 0.002;
const MELT_ICE: f32 = 0.0015;
// cells of water a second per degree under freezing
const FREEZE: f32 = 0.002;
// leaves a tree drops (cells a second), up to a carpet this deep
const LEAF_RATE: f32 = 0.002;
const LEAF_MAX: f32 = 0.3;
const LEAF_DROP: f32 = 0.01;
// what rots a second on damp ground (half its depth becomes soil)
const ROT: f32 = 0.002;
const MAT_SOIL_C: u32 = 2u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  // (a sleeping chunk: round 80)
  if (id.x >= G.mapW || id.y >= G.mapH || asleep(id.xy)) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let cs = colSlots(id.x, id.y);
  var arr: array<vec4<u32>, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    arr[k] = v;
    n = k + 1u;
  }
  if (n == 0u) { return; }
  let top = arr[n - 1u];
  let z = ivZ1(top);
  let lv = lavaC[i];
  // (lava on it or under it: its heat; a fire's)
  let t = airTempAt(z) + select(0.0, lv.y, lv.x > 0.01) + max(lv.z, 0.0) + fireC[i] * 300.0;
  var wd = water[i];
  var changed = false;

  // a cold storm's snow, and the trees' leaves, land through the deposit
  let dep = deposit[i];
  let snow = rainAt(cellPos(p)) * RAIN_RATE_C * 4.0 * simStep() * snowShare(t) * SNOW_FALL;
  // (light snow in drops of LEAF_DROP now and then, as the leaves)
  var fall = snow;
  if (snow < LEAF_DROP) { fall = select(0.0, LEAF_DROP, rand3(id.x, id.y, G.tick ^ 0x5a0du) < snow / LEAF_DROP); }
  if (snow > 1e-5 && dep.y <= 0.0) {
    if (fall > 0.0) { deposit[i] = vec4<f32>(dep.x, fall, f32(MAT_SNOW), dep.w); }
  } else if (tierRate(TIER_VEG, p) > 0.0 && vegC[i] >= 3.6 && t > 0.0 && wd < 0.02 && dep.y <= 0.0 && !(ivMat(top) == MAT_LEAFLIT && ivZ1(top) - ivZ0(top) >= LEAF_MAX)) {
    // (a tree's crown over it: veg ≥ 3.6 is woodland, vegplan.wgsl)
    // (round 51: most of them in the fall) — in drops of LEAF_DROP now and
    // then: a sliver thinner than a thousandth of a cell is a spent top to
    // the sediment pass, which threw every drop away
    // (round 108, simtiers: leaf fall is the vegetation's — baked, none; a bake's gain speeds it)
    let rate = LEAF_RATE * dtC() * tierRate(TIER_VEG, p) * (0.2 + 6.0 * seasonShed());
    if (rand3(id.x, id.y, G.tick ^ 0x1eafu) < rate / LEAF_DROP) {
      deposit[i] = vec4<f32>(dep.x, LEAF_DROP, f32(MAT_LEAFLIT), dep.w);
    }
  }

  let m = ivMat(top);
  let d = ivZ1(top) - ivZ0(top);
  if (m == MAT_SNOW && t > 0.5) {
    let melt = min(d, MELT_SNOW * (t - 0.5) * dtC());
    arr[n - 1u] = ivPack(ivZ0(top), ivZ1(top) - melt, m, ivAux(top));
    wd += melt;
    changed = true;
  } else if (m == MAT_ICE && t > 0.5) {
    let melt = min(d, MELT_ICE * (t - 0.5) * dtC());
    arr[n - 1u] = ivPack(ivZ0(top), ivZ1(top) - melt, m, ivAux(top));
    wd += melt * 0.9;
    changed = true;
  } else if (wd > 0.01 && t < -0.5) {
    // the water freezes onto the ground under it (ice is a little bulkier)
    let f = min(wd, FREEZE * (-0.5 - t) * dtC());
    wd -= f;
    if (m == MAT_ICE) {
      arr[n - 1u] = ivPack(ivZ0(top), ivZ1(top) + f / 0.9, m, ivAux(top));
      changed = true;
    } else if (n < cs.y) {
      arr[n] = ivPack(z, z + f / 0.9, MAT_ICE, 0u);
      n += 1u;
      changed = true;
    } else {
      // (no slot for the ice: the water stays water)
      wd += f;
    }
  } else if (m == MAT_LEAFLIT && moistC[i] > 0.35 && t > 0.0 && n >= 2u && tierRate(TIER_VEG, p) > 0.0) {
    // leaves rot into the soil under them
    let below = arr[n - 2u];
    if (ivMat(below) == MAT_SOIL_C && abs(ivZ1(below) - ivZ0(top)) < 1e-3) {
      let r = min(d, ROT * dtC() * tierRate(TIER_VEG, p));
      let s1 = ivZ1(below) + r * 0.5;
      arr[n - 2u] = ivPack(ivZ0(below), s1, MAT_SOIL_C, ivAux(below));
      arr[n - 1u] = ivPack(s1, max(ivZ1(top) - r * 0.5, s1), m, ivAux(top));
      changed = true;
    }
  }
  if (!changed) { return; }
  // a spent top goes
  if (ivZ1(arr[n - 1u]) - ivZ0(arr[n - 1u]) <= 1e-4) { n -= 1u; arr[n] = IV_NONE; }
  for (var k = 0u; k < cs.y; k++) { layers[cs.x + k] = select(IV_NONE, arr[k], k < n); }
  water[i] = wd;
}
