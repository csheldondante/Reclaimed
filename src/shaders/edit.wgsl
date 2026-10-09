// ---- editor brush (sandbox; BACKLOG B2, round 13 F2–F4) ---------------------
// Applies EV_EDIT events (one-tick, like lightning): x, y = brush centre,
// z = radius, w = strength; evZ = op * 32 + material, + STROKE_START on the
// first event of a press.
//
// Ground ops work in layers (round 13): a press lays at most `w` whole cells
// of material under the brush, full in the middle and fading at the rim.
// Each column remembers how much this press has already given it
// (state.x), so painting over the same place adds nothing until the next
// press; the fraction it gets at the rim accumulates (state.y), so repeated
// clicks build a smooth mound instead of per-cell random noise.
//  - build: hard materials placed at once on top
//  - pour: granular materials (and drift dust) dropped from above — the
//    particle system shows the grains falling (it reads this state), the
//    cells land after the fall and the material system settles them by
//    angle of repose
//  - bedrock: stone rising from below, lifting every layer above it
//  - dig: one layer off the top
// Liquids/fields add or remove amounts per tick while held. Dust for drifts
// goes through driftDelta (folded in by the drift system, which owns the
// drift texture). Runs first each tick in the sandbox, so every system sees
// the edit.
@group(0) @binding(3) var<storage, read> layersIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> layersOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> oilE: array<f32>;
@group(0) @binding(7) var<storage, read_write> contamE: array<vec2<f32>>;
@group(0) @binding(8) var<storage, read_write> vegE: array<f32>;
@group(0) @binding(9) var<storage, read_write> driftDelta: array<f32>;
// brush state per column (editTex, binding 18, declared in common.wgsl):
// x given by this press, y fraction of a cell owed, z cells still to pour,
// w = op·32 + material (×4) + fall time left (s)
@group(0) @binding(16) var editOut: texture_storage_2d<rgba32float, write>;

const EV_EDIT: u32 = 5u;
const OP_BUILD: u32 = 1u;
const OP_DIG: u32 = 2u;
const OP_WATER: u32 = 3u;
const OP_OIL: u32 = 4u;
const OP_POLLUTE: u32 = 6u;
const OP_PLANT: u32 = 7u;
const OP_CLEAN: u32 = 8u;
const OP_DRAIN: u32 = 9u;
const OP_POUR: u32 = 10u;
const OP_BEDROCK: u32 = 11u;
// break (round 14, F7): punch a hole — everything inside a sphere of the
// brush radius centred at height w is removed, structures and terrain alike
// (only the bottom two cells of bedrock stay, so the map keeps a floor)
const OP_SMASH: u32 = 12u;
const STROKE_START: u32 = 512u;
const DT_E: f32 = 1.0 / 60.0;
const MAT_SILT_E: u32 = 22u;

/** Materials that pour into the loose layer (drift.wgsl) rather than as cells. */
fn isLoose(m: u32) -> bool { return m == 2u || m == 3u || m == 4u || m == 17u || m == MAT_DRIFT; }
/** What a loose material becomes when packed into ground cells (dust → packed dust). */
fn packedOf(m: u32) -> u32 { return select(m, MAT_SILT_E, m == MAT_DRIFT); }
const UPLIFT_RATE: f32 = 3.0; // cells/s bedrock rises

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let cs = colSlots(id.x, id.y);
  var arr: array<u32, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    let v = layersIn[cs.x + k];
    if (v == 0u) { break; }
    arr[k] = v;
    n = k + 1u;
  }

  let st = textureLoad(editTex, p, 0);
  var given = st.x;
  var owed = st.y;
  var pending = st.z;
  var opmat = u32(floor(st.w / 4.0));
  var timer = st.w - f32(opmat) * 4.0;

  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_EDIT) { continue; }
    let ev = G.events[e];
    let code = evZ(e);
    if ((code & STROKE_START) != 0u) { given = 0.0; }
    let d = length(vec2<f32>(p) + 0.5 - ev.xy) / ev.z;
    if (d >= 1.0) { continue; }
    let op = (code & 511u) / 32u;
    let mat = code % 32u;
    if (op == OP_BUILD || op == OP_DIG || op == OP_POUR || op == OP_BEDROCK) {
      // a layer: full over the inner half, soft at the rim
      let want = smoothstep(1.0, 0.5, d) * ev.w;
      let delta = max(want - given, 0.0);
      if (delta <= 0.0) { continue; }
      given += delta;
      let om = op * 32u + mat;
      if (om != opmat) { owed = 0.0; pending = 0.0; opmat = om; }
      if (op == OP_POUR || op == OP_BEDROCK) {
        if (pending <= 0.0) { timer = select(0.0, POUR_FALL, op == OP_POUR); }
        pending += delta;
      } else {
        owed += delta;
      }
      continue;
    }
    let fall = 1.0 - d * d;
    let amt = ev.w * fall;
    if (op == OP_SMASH) {
      let hz = ev.z * sqrt(fall);
      let lo = u32(max(ev.w - hz, 0.0) + 0.5);
      let hi = u32(max(ev.w + hz, 0.0) + 0.5);
      var out: array<u32, MAX_K>;
      var m = 0u;
      for (var k = 0u; k < n; k++) {
        let v = arr[k];
        let mt = ivMat(v);
        let z0 = ivZ0(v);
        let z1 = ivZ1(v);
        let hole0 = max(lo, 2u);
        if (z1 <= hole0 || z0 >= hi || hi <= hole0) { out[m] = v; m += 1u; continue; }
        // keep what lies below and above the hole (room permitting)
        if (z0 < hole0) { out[m] = ivPack(z0, hole0, mt, ivAux(v)); m += 1u; }
        if (z1 > hi && m < cs.y) { out[m] = ivPack(hi, z1, mt, ivAux(v)); m += 1u; }
      }
      if (m <= cs.y) {
        for (var k = 0u; k < MAX_K; k++) { arr[k] = select(0u, out[k], k < m); }
        n = m;
      }
      continue;
    }
    if (op == OP_WATER) {
      water[i] += amt * 0.02;
    } else if (op == OP_DRAIN) {
      water[i] = max(0.0, water[i] - amt * 0.03);
      oilE[i] = max(0.0, oilE[i] - amt * 0.05);
    } else if (op == OP_OIL) {
      oilE[i] += amt * 0.015;
    } else if (op == OP_POLLUTE) {
      contamE[i].x += amt * 0.05;
    } else if (op == OP_CLEAN) {
      contamE[i] = contamE[i] * (1.0 - min(amt * 0.15, 1.0));
      oilE[i] = oilE[i] * (1.0 - min(amt * 0.15, 1.0));
      driftDelta[i] -= amt * 0.06;
    } else if (op == OP_PLANT) {
      vegE[i] = max(vegE[i], min(vegE[i] + amt * 0.08, 4.6));
      contamE[i].x = contamE[i].x * (1.0 - min(amt * 0.05, 1.0));
    }
  }

  let op = opmat / 32u;
  let mat = opmat % 32u;
  // loose layer packed into ground cells this tick (count, material)
  var packN = 0u;
  var packMat = 0u;
  // pours land after the fall; bedrock rises steadily
  if (pending > 0.0) {
    if (timer > 0.0) {
      timer = max(timer - DT_E, 0.0);
    } else {
      let r = min(pending, select(POUR_RATE, UPLIFT_RATE, op == OP_BEDROCK) * DT_E);
      pending -= r;
      // dust lands in the drift layer (fractional); everything else as cells
      if (isLoose(mat)) {
        // loose material pours into the loose layer (round 15, H3). A
        // different material arriving packs the old layer into ground cells
        // first, so pours make strata (only once: driftDelta < 0 means a
        // packing the drift pass hasn't folded in yet)
        let dd = driftAt(p);
        let dm = driftMatAt(p);
        if (dm != mat && dd > 0.05 && driftDelta[i] >= 0.0) {
          packN = u32(round(dd));
          packMat = packedOf(dm);
          driftDelta[i] -= dd;
        }
        driftDelta[i] += r;
      } else { owed += r; }
    }
  }
  // one whole cell per tick at most
  if (owed >= 1.0 && n > 0u) {
    owed -= 1.0;
    let top = arr[n - 1u];
    let z1 = ivZ1(top);
    if (op == OP_DIG) {
      if (!(n == 1u && z1 <= 2u)) {
        if (z1 - 1u <= ivZ0(top)) { n -= 1u; arr[n] = 0u; }
        else { arr[n - 1u] = ivPack(ivZ0(top), z1 - 1u, ivMat(top), ivAux(top)); }
      }
    } else if (op == OP_BEDROCK) {
      // stone grows at the bottom; everything above moves up a cell
      if (z1 + 2u < G.zMax) {
        for (var k = 1u; k < n; k++) {
          let v = arr[k];
          arr[k] = ivPack(ivZ0(v) + 1u, ivZ1(v) + 1u, ivMat(v), ivAux(v));
        }
        let b = arr[0];
        if (ivMat(b) == MAT_STONE || n >= cs.y) {
          arr[0] = ivPack(ivZ0(b), ivZ1(b) + 1u, ivMat(b), ivAux(b));
        } else {
          for (var k = n; k > 0u; k--) { arr[k] = arr[k - 1u]; }
          arr[0] = ivPack(0u, 1u, MAT_STONE, 0u);
          arr[1] = ivPack(ivZ0(b) + 1u, ivZ1(b) + 1u, ivMat(b), ivAux(b));
          n += 1u;
        }
      }
    } else if (z1 + 2u < G.zMax) {
      // build / pour: a cell of the material on top
      if (ivMat(top) == mat) { arr[n - 1u] = ivPack(ivZ0(top), z1 + 1u, mat, ivAux(top)); }
      else if (n < cs.y) { arr[n] = ivPack(z1, z1 + 1u, mat, 0u); n += 1u; }
      else { arr[n - 1u] = ivPack(ivZ0(top), z1 + 1u, ivMat(top), ivAux(top)); }
    }
  }
  // a deep loose layer packs down: all but its top ~1 cell becomes ground
  // cells of its material (deep dust becomes packed dust); a dust film on top
  // stays loose
  let dl = driftAt(p) - driftFilmAt(p);
  if (packN == 0u && dl > 1.75 && driftDelta[i] > -0.01) {
    packN = u32(floor(dl - 0.75));
    packMat = packedOf(driftMatAt(p));
    driftDelta[i] -= f32(packN);
  }
  for (var k = 0u; k < packN; k++) {
    if (n == 0u) { break; }
    let top = arr[n - 1u];
    let z1 = ivZ1(top);
    if (z1 + 2u >= G.zMax) { break; }
    if (ivMat(top) == packMat) { arr[n - 1u] = ivPack(ivZ0(top), z1 + 1u, packMat, ivAux(top)); }
    else if (n < cs.y) { arr[n] = ivPack(z1, z1 + 1u, packMat, 0u); n += 1u; }
    else { arr[n - 1u] = ivPack(ivZ0(top), z1 + 1u, ivMat(top), ivAux(top)); }
  }
  if (pending <= 0.0 && owed < 1.0 && op != OP_POUR && op != OP_BEDROCK) { timer = 0.0; }
  textureStore(editOut, p, vec4<f32>(given, owed, pending, f32(opmat) * 4.0 + min(timer, 3.9)));
  for (var k = 0u; k < cs.y; k++) { layersOut[cs.x + k] = select(0u, arr[k], k < n); }
}
