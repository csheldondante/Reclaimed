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
// Liquids/fields add or remove amounts per tick while held. Loose material
// goes through `deposit` (folded into the layers by sediment.wgsl). Runs first each tick in the sandbox, so every system sees
// the edit.
@group(0) @binding(3) var<storage, read> layersIn: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> layersOut: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read_write> water: array<f32>;
@group(0) @binding(6) var<storage, read_write> oilE: array<f32>;
@group(0) @binding(7) var<storage, read_write> contamE: array<vec2<f32>>;
@group(0) @binding(8) var<storage, read_write> vegE: array<f32>;
// loose material arriving (x; sediment.wgsl folds it into the layers)
@group(0) @binding(9) var<storage, read_write> deposit: array<vec4<f32>>;
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
// break (round 14, F7): punch a hole in a sphere of the brush radius centred
// at height w, structures and terrain alike (only the bottom two cells of
// bedrock stay, so the map keeps a floor). Since round 23 (Q3) solids in it
// turn to their rubble in place (rubbleOf, the same volume) where the hole
// is open to the sky, which then slumps and spills; under what's left above
// the hole (a wall's window, a tower's base) and for loose ground, liquids
// and plants the hole is emptied (to become grains that carry it: step 2).
const OP_SMASH: u32 = 12u;
// a meteor (round 48): a bowl blown out of everything it hits — z the
// radius of its ring of ejecta, CRATER_RING times the bowl's; w the height
// it hit at. What was in the bowl is gone to dust (the level throws the dust
// up as haze); the ejecta land round it as drift, thinning outward.
const OP_CRATER: u32 = 13u;
// exact (round 63: units carry what they take and put down): one column, the
// one whose centre lies within the radius; w cells. take: off the top
// interval (whatever it is; the map keeps z 2); put: material `mat` on top
// (onto the top interval if the same, else a new one: a full column takes
// none). What it did goes to editResult at the tag (code bits 10-15).
const OP_TAKE: u32 = 14u;
const OP_PUT: u32 = 15u;
// fell (round 63; op 5 was free: ops have 4 bits): the column's plants cut back to grass (its tree goes);
// editResult gets what stood there (x the veg it had)
const OP_FELL: u32 = 5u;
const FELLED: f32 = 2.2;
@group(0) @binding(26) var editResult: texture_storage_2d<rgba32float, write>;
const CRATER_RING: f32 = 2.5;
const STROKE_START: u32 = 512u;
const DT_E: f32 = 1.0 / 60.0;
/** (perfopt, simhz) the world time a tick stands for */
fn dtE() -> f32 { return DT_E * simStep(); }
const MAT_SILT_E: u32 = 22u;

/** Materials that pour into the loose layer (drift.wgsl) rather than as cells. */
fn isLoose(m: u32) -> bool { return m == 2u || m == 3u || m == 4u || m == 17u || m == MAT_DRIFT; }

const UPLIFT_RATE: f32 = 3.0; // cells/s bedrock rises

// (round 120, JB6: "no CPU readback on the hot path") A blow — a body striking the ground (Integrity.groundBlow): OP_SMASH
// with tag BLOW_TAG (code bits 10-15); x, y where it struck, z the footprint's reach + BLOW_BRUSH (its rim), w the blow's
// energy (½mv²). Decided here on the columns as the GPU has them, no CPU copy: struck loose ground (the column's top
// softer than 0 — the material table's look.z, softnessOf) sinks: each footprint column's top run cut by
// depth · (1 − ½(d/reach)²), depth = impact.softSink · softness · ∛E over the footprint's side (at most 3; under 0.15
// none), what's dug out a share sprayed (impact.spray: the CPU's dust) and the rest laid as a rim round it through the
// deposit; struck solid ground with more than impact.groundEnergy smashes, a ball of 0.8·∛(E / groundEnergy) (at most 3)
// at its top (OP_SMASH's rule). (It was the CPU's softBlow/groundBlow over its copy of the columns, game/blows.ts.)
const BLOW_TAG: u32 = 1u;
const BLOW_RIM: f32 = 2.5;
const BLOW_BRUSH: f32 = 3.0;
const PI_E: f32 = 3.14159265;

/** the top interval of column c as the tick began (IV_NONE: empty) */
fn topIv(c: vec2<i32>) -> vec4<u32> {
  let cs = colSlots(u32(c.x), u32(c.y));
  var t = IV_NONE;
  for (var k = 0u; k < cs.y; k++) {
    let v = layersIn[cs.x + k];
    if (ivEmpty(v)) { break; }
    t = v;
  }
  return t;
}

/** how soft a material is to a blow (materials.ts softnessOf: 0 for what isn't loose) */
fn softOf(m: u32) -> f32 { return MATS[m].look.z; }

/** how deep a blow of energy e on ground this soft sinks a footprint of this reach (blows.ts sinkDepth) */
fn sinkDepthOf(e: f32, soft: f32, reach: f32) -> f32 {
  if (!(soft > 0.0) || !(e > 0.0)) { return 0.0; }
  let d = min(3.0, G.tune.impactSoftSink * soft * pow(e, 1.0 / 3.0) / max(1.0, reach * sqrt(PI_E)));
  return select(d, 0.0, d < 0.15);
}

/** what a sinking blow cuts off a footprint column's top run `top`, d from where it struck (none under 0.02) */
fn sinkCut(top: vec4<u32>, d: f32, reach: f32, depth: f32) -> f32 {
  if (ivEmpty(top) || !(softOf(ivMat(top)) > 0.0)) { return 0.0; }
  let want = depth * (1.0 - 0.5 * (d / reach) * (d / reach));
  let cut = min(want, ivZ1(top) - ivZ0(top));
  return select(cut, 0.0, cut < 0.02);
}

/** OP_SMASH's hole [lo, hi) in a column (n intervals, k slots): its new count */
fn smashCol(arr: ptr<function, array<vec4<u32>, MAX_K>>, n: u32, k: u32, lo: f32, hi: f32) -> u32 {
  var out: array<vec4<u32>, MAX_K>;
  var m = 0u;
  // rubble only where the hole is open above: under what's left it would
  // go on holding that up (a tower on a pedestal of its own base)
  let open = n == 0u || ivZ1((*arr)[n - 1u]) <= hi;
  for (var j = 0u; j < n; j++) {
    let v = (*arr)[j];
    let mt = ivMat(v);
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    let hole0 = max(lo, 2.0);
    if (z1 <= hole0 || z0 >= hi || hi <= hole0) { out[m] = v; m += 1u; continue; }
    // keep what lies below and above the hole (room permitting); a solid's
    // share of the hole becomes its rubble
    if (z0 < hole0) { out[m] = ivPack(z0, hole0, mt, ivAux(v)); m += 1u; }
    if (open && matState(mt) == ST_SOLID && m < k) { out[m] = ivPack(max(z0, hole0), min(z1, hi), rubbleOf(mt), 0u); m += 1u; }
    if (z1 > hi && m < k) { out[m] = ivPack(hi, z1, mt, ivAux(v)); m += 1u; }
  }
  if (m <= k) {
    for (var j = 0u; j < MAX_K; j++) { (*arr)[j] = select(IV_NONE, out[j], j < m); }
    return m;
  }
  return n;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  // (a sleeping chunk, round 80: what it holds carried through — the next buffer is copied back over this one)
  if (asleep(id.xy)) {
    if (!drowsy(id.xy)) { return; }
    let cs = colSlots(id.x, id.y);
    for (var k = 0u; k < cs.y; k++) { layersOut[cs.x + k] = layersIn[cs.x + k]; }
    return;
  }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let cs = colSlots(id.x, id.y);
  var arr: array<vec4<u32>, MAX_K>;
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    let v = layersIn[cs.x + k];
    if (ivEmpty(v)) { break; }
    arr[k] = v;
    n = k + 1u;
  }

  let st = textureLoad(editTex, texCol(vec2<i32>(p)), 0);
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
    let d = length(cellPos(p) - ev.xy) / ev.z;
    if (d >= 1.0) { continue; }
    let op = (code & 511u) / 32u;
    let mat = code % 32u;
    if (op == OP_FELL) {
      let had = vegE[i];
      vegE[i] = min(had, FELLED);
      textureStore(editResult, vec2<i32>(i32(code >> 10u), 0), vec4<f32>(had, 0.0, f32(G.tick), 1.0));
      continue;
    }
    if (op == OP_TAKE || op == OP_PUT) {
      var got = 0.0;
      var gm = mat;
      if (op == OP_TAKE && n > 0u) {
        let t = arr[n - 1u];
        gm = ivMat(t);
        got = clamp(ev.w, 0.0, ivZ1(t) - max(ivZ0(t), 2.0));
        if (got > 0.0) {
          if (ivZ1(t) - got <= ivZ0(t) + 1e-3) { n -= 1u; arr[n] = IV_NONE; }
          else { arr[n - 1u] = ivPack(ivZ0(t), ivZ1(t) - got, gm, ivAux(t)); }
        }
      } else if (op == OP_PUT) {
        var top = 0.0;
        if (n > 0u) { top = ivZ1(arr[n - 1u]); }
        let a = clamp(ev.w, 0.0, f32(G.zMax) - 2.0 - top);
        if (a <= 0.0) {
          got = 0.0;
        } else if (n > 0u && ivMat(arr[n - 1u]) == mat) {
          let t = arr[n - 1u];
          arr[n - 1u] = ivPack(ivZ0(t), top + a, mat, ivAux(t));
          got = a;
        } else if (n < cs.y) {
          arr[n] = ivPack(top, top + a, mat, 0u);
          n += 1u;
          got = a;
        }
      }
      textureStore(editResult, vec2<i32>(i32(code >> 10u), 0), vec4<f32>(max(got, 0.0), f32(gm), f32(G.tick), 1.0));
      continue;
    }
    if (op == OP_CRATER) {
      let rc = ev.z / CRATER_RING;
      let dc = d * CRATER_RING;
      if (dc >= 1.0) {
        // the ejecta: a blanket of dust, thickest at the rim
        deposit[i].x += 0.12 * rc / (dc * dc * dc);
        continue;
      }
      // the bowl: shallower than it is wide (an ellipsoid), and what stood over it
      let hz = rc * sqrt(1.0 - dc * dc);
      let lo = max(ev.w - hz * 0.7, 2.0);
      let hi = ev.w + hz * 1.5;
      var out: array<vec4<u32>, MAX_K>;
      var m = 0u;
      for (var k = 0u; k < n; k++) {
        let v = arr[k];
        let z0 = ivZ0(v);
        let z1 = ivZ1(v);
        if (z1 <= lo || z0 >= hi) { out[m] = v; m += 1u; continue; }
        if (z0 < lo) { out[m] = ivPack(z0, lo, ivMat(v), ivAux(v)); m += 1u; }
        if (z1 > hi && m < cs.y) { out[m] = ivPack(hi, z1, ivMat(v), ivAux(v)); m += 1u; }
      }
      if (m <= cs.y) {
        for (var k = 0u; k < MAX_K; k++) { arr[k] = select(IV_NONE, out[k], k < m); }
        n = m;
      }
      // (its loose ground, water and plants too)
      deposit[i].x = min(deposit[i].x, 0.0);
      water[i] = 0.0;
      vegE[i] = 0.0;
      continue;
    }
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
    if (op == OP_SMASH && (code >> 10u) == BLOW_TAG) {
      let reach = max(ev.z - BLOW_BRUSH, 0.5);
      let dp = length(cellPos(p) - ev.xy);
      let cc = cellAt(ev.xy);
      if (!inMap(cc)) { continue; }
      let ct = topIv(cc);
      if (ivEmpty(ct)) { continue; }
      let cm = ivMat(ct);
      let soft = softOf(cm);
      if (soft > 0.0) {
        let depth = sinkDepthOf(ev.w, soft, reach);
        if (depth <= 0.0) { continue; }
        if (dp <= reach) {
          if (n > 0u) {
            let t = arr[n - 1u];
            let cut = sinkCut(t, dp, reach, depth);
            if (cut > 0.0) {
              if (ivZ1(t) - cut > ivZ0(t) + 1e-3) { arr[n - 1u] = ivPack(ivZ0(t), ivZ1(t) - cut, ivMat(t), ivAux(t)); }
              else { n -= 1u; arr[n] = IV_NONE; }
            }
          }
        } else if (dp <= reach + BLOW_RIM) {
          // the rim: what the whole footprint gave (each column as the tick began), over the ring's columns
          let R = i32(ceil(reach)) + 1;
          var removed = 0.0;
          var ring = 0.0;
          for (var j = cc.y - 2 * (R + 3); j <= cc.y + 2 * (R + 3); j++) {
            for (var ii = cc.x - R - 3; ii <= cc.x + R + 3; ii++) {
              let q = vec2<i32>(ii, j);
              if (!inMap(q)) { continue; }
              let dq = length(cellPos(q) - ev.xy);
              if (dq > reach && dq <= reach + BLOW_RIM) { ring += 1.0; }
              if (dq <= reach && abs(j - cc.y) <= 2 * R && abs(ii - cc.x) <= R) { removed += sinkCut(topIv(q), dq, reach, depth); }
            }
          }
          if (ring > 0.0) {
            deposit[i].y += removed * (1.0 - G.tune.impactSpray) / ring;
            deposit[i].z = f32(cm);
          }
        }
        continue;
      }
      // (solid ground: a hard enough blow smashes it where it struck)
      if (matState(cm) != ST_SOLID || !(ev.w >= G.tune.impactGroundEnergy)) { continue; }
      let r = min(3.0, 0.8 * pow(ev.w / G.tune.impactGroundEnergy, 1.0 / 3.0));
      let ds = dp / r;
      if (ds >= 1.0) { continue; }
      let hz = r * sqrt(1.0 - ds * ds);
      let zc = ivZ1(ct) - 0.3;
      n = smashCol(&arr, n, cs.y, floor(max(zc - hz, 0.0) + 0.5), floor(max(zc + hz, 0.0) + 0.5));
      continue;
    }
    if (op == OP_SMASH) {
      let hz = ev.z * sqrt(fall);
      n = smashCol(&arr, n, cs.y, floor(max(ev.w - hz, 0.0) + 0.5), floor(max(ev.w + hz, 0.0) + 0.5));
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
      deposit[i].x -= amt * 0.06;
    } else if (op == OP_PLANT) {
      vegE[i] = max(vegE[i], min(vegE[i] + amt * 0.08, 4.6));
      contamE[i].x = contamE[i].x * (1.0 - min(amt * 0.05, 1.0));
    }
  }

  let op = opmat / 32u;
  let mat = opmat % 32u;
  // pours land after the fall; bedrock rises steadily
  if (pending > 0.0) {
    if (timer > 0.0) {
      timer = max(timer - dtE(), 0.0);
    } else {
      let r = min(pending, select(POUR_RATE, UPLIFT_RATE, op == OP_BEDROCK) * dtE());
      pending -= r;
      // dust lands in the drift layer (fractional); everything else as cells
      if (isLoose(mat)) {
        // loose material pours into the loose ground (drift.wgsl): a
        // different material starts a new layer on top, so pours make strata
        deposit[i].x += r;
      } else { owed += r; }
    }
  }
  // one whole cell per tick at most
  if (owed >= 1.0 && n > 0u) {
    owed -= 1.0;
    let top = arr[n - 1u];
    let z1 = ivZ1(top);
    if (op == OP_DIG && driftAt(p) > 0.05) {
      // loose ground first: a cell's worth of it
      deposit[i].x -= 1.0;
    } else if (op == OP_DIG) {
      if (!(n == 1u && z1 <= 2.0)) {
        if (z1 - 1.0 <= ivZ0(top) + 1e-3) { n -= 1u; arr[n] = IV_NONE; }
        else { arr[n - 1u] = ivPack(ivZ0(top), z1 - 1.0, ivMat(top), ivAux(top)); }
      }
    } else if (op == OP_BEDROCK) {
      // stone grows at the bottom; everything above moves up a cell
      if (z1 + 2.0 < f32(G.zMax)) {
        for (var k = 1u; k < n; k++) {
          let v = arr[k];
          arr[k] = ivPack(ivZ0(v) + 1.0, ivZ1(v) + 1.0, ivMat(v), ivAux(v));
        }
        let b = arr[0];
        if (ivMat(b) == MAT_STONE || n >= cs.y) {
          arr[0] = ivPack(ivZ0(b), ivZ1(b) + 1.0, ivMat(b), ivAux(b));
        } else {
          for (var k = n; k > 0u; k--) { arr[k] = arr[k - 1u]; }
          arr[0] = ivPack(0.0, 1.0, MAT_STONE, 0u);
          arr[1] = ivPack(ivZ0(b) + 1.0, ivZ1(b) + 1.0, ivMat(b), ivAux(b));
          n += 1u;
        }
      }
    } else if (z1 + 2.0 < f32(G.zMax)) {
      // build: a cell of the material on top (on loose ground it sits on the
      // loose ground, which stays under it in the layers)
      let t2 = arr[n - 1u];
      let z2 = ivZ1(t2);
      if (ivMat(t2) == mat) { arr[n - 1u] = ivPack(ivZ0(t2), z2 + 1.0, mat, ivAux(t2)); }
      else if (n < cs.y) { arr[n] = ivPack(z2, z2 + 1.0, mat, 0u); n += 1u; }
      else { arr[n - 1u] = ivPack(ivZ0(t2), z2 + 1.0, ivMat(t2), ivAux(t2)); }
    }
  }
  if (pending <= 0.0 && owed < 1.0 && op != OP_POUR && op != OP_BEDROCK) { timer = 0.0; }
  textureStore(editOut, texCol(vec2<i32>(p)), vec4<f32>(given, owed, pending, f32(opmat) * 4.0 + min(timer, 3.9)));
  for (var k = 0u; k < cs.y; k++) { layersOut[cs.x + k] = select(IV_NONE, arr[k], k < n); }
}
