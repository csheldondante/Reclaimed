// ---- editor brush (sandbox; BACKLOG B2) ------------------------------------------
// Applies EV_EDIT events (one-tick, like lightning): x, y = brush centre,
// z = radius, w = strength (per tick at the centre); evZ = op * 32 + material.
// Ground ops edit the column intervals (deposit a cell of a material on top,
// or dig one off), probabilistically by brush falloff so shapes come out round;
// liquids/fields add or remove amounts. Dust for drifts goes through
// driftDelta (drift.wgsl folds it in) because the drift texture is owned by
// the drift system. Runs first each tick, so every system sees the edit.
@group(0) @binding(3) var<storage, read> layersIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> layersOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> oilE: array<f32>;
@group(0) @binding(7) var<storage, read_write> contamE: array<vec2<f32>>;
@group(0) @binding(8) var<storage, read_write> vegE: array<f32>;
@group(0) @binding(9) var<storage, read_write> driftDelta: array<f32>;

const EV_EDIT: u32 = 5u;
const OP_DEPOSIT: u32 = 1u;
const OP_DIG: u32 = 2u;
const OP_WATER: u32 = 3u;
const OP_OIL: u32 = 4u;
const OP_DUST: u32 = 5u;
const OP_POLLUTE: u32 = 6u;
const OP_PLANT: u32 = 7u;
const OP_CLEAN: u32 = 8u;
const OP_DRAIN: u32 = 9u;

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

  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_EDIT) { continue; }
    let ev = G.events[e];
    let d = length(vec2<f32>(p) + 0.5 - ev.xy) / ev.z;
    if (d >= 1.0) { continue; }
    let fall = 1.0 - d * d;
    let amt = ev.w * fall;
    let op = evZ(e) / 32u;
    let mat = evZ(e) % 32u;
    let roll = rand3(id.x, id.y, G.tick ^ 0xed17u);
    // ground: ~5 cells/s at the centre at full strength
    let layerChance = amt * 0.08;
    if (op == OP_DEPOSIT && n > 0u && roll < layerChance) {
      let top = arr[n - 1u];
      let z1 = ivZ1(top);
      if (z1 + 2u < G.zMax) {
        if (ivMat(top) == mat) { arr[n - 1u] = ivPack(ivZ0(top), z1 + 1u, mat, ivAux(top)); }
        else if (n < cs.y) { arr[n] = ivPack(z1, z1 + 1u, mat, 0u); n += 1u; }
        else { arr[n - 1u] = ivPack(ivZ0(top), z1 + 1u, ivMat(top), ivAux(top)); }
      }
    } else if (op == OP_DIG && n > 0u && roll < layerChance) {
      let top = arr[n - 1u];
      let z1 = ivZ1(top);
      if (!(n == 1u && z1 <= 2u)) {
        if (z1 - 1u <= ivZ0(top)) { n -= 1u; arr[n] = 0u; }
        else { arr[n - 1u] = ivPack(ivZ0(top), z1 - 1u, ivMat(top), ivAux(top)); }
      }
    } else if (op == OP_WATER) {
      water[i] += amt * 0.02;
    } else if (op == OP_DRAIN) {
      water[i] = max(0.0, water[i] - amt * 0.03);
      oilE[i] = max(0.0, oilE[i] - amt * 0.05);
    } else if (op == OP_OIL) {
      oilE[i] += amt * 0.015;
    } else if (op == OP_DUST) {
      driftDelta[i] += amt * 0.06;
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
  for (var k = 0u; k < cs.y; k++) { layersOut[cs.x + k] = select(0u, arr[k], k < n); }
}
