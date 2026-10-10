// ---- the loose ground: dust, sand, ash, dirt lying on the land ----------------
// (round 11 drifts → round 15 per-material loose layer → round 16: all soft
// ground is loose, smooth and layered; only solids are whole cells with steps.)
// Each column holds a stack of up to four loose layers on its solid ground:
//   drift (texture): .x total depth (cells, fractional), .y the top layer's
//     depth, .z the top layer's material, .w what the wind sent up into the
//     air this pass (the particle system carries it as dust grains and sets it
//     down where they land);
//   strata (texture): the three layers beneath the top, bottom first, each
//     packed as material·1000 + depth (0 = none).
// Wind, water and slumping take from the top layer; what arrives joins the
// top layer if it's the same material, otherwise it starts a new layer on
// top (so pours and drifts make strata). Each material has its own wind
// threshold, repose, airborne share and readiness to wash away (looseOf,
// washOf): dust moves in a gust, ash and sand in stronger wind, dirt and
// gravel only with water. Above its threshold a cell sends material
// downwind (split over the four faces by the wind's components); sheltered
// cells — behind taller ground upwind — feel less wind, so it piles up in
// their lee; it can't be pushed up into a wall, so it banks there. It lies
// under still water (the liquids sit on top of it) and moving water carries
// it downstream, settling where the flow slows; material carried off the map
// edge is gone. Plants under a deep top layer of dust or ash lie dormant;
// established plants hold what they grow through and turn dust to soil.
// Race-free gather: every cell recomputes its neighbours' outflow from the
// same read-only inputs, so what leaves one cell arrives in the next.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
// loose material added (pours, dust) or removed (dig, clean) by the editor
// (edit.wgsl); the pour's material comes from the brush state (editTex)
@group(0) @binding(5) var<storage, read_write> driftDelta: array<f32>;
// water flux (flow.wgsl netFlow): moving water carries the layer downstream
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
// plants: established green holds the layer it grows through (round 15)
@group(0) @binding(7) var<storage, read> vegD: array<f32>;
// dust that came down here from the air (particles.wgsl), the second half of
// the exchange buffer, ×1e5
@group(0) @binding(8) var<storage, read_write> exchange: array<atomic<i32>>;
// loose material added from the CPU (a crumbled rigid body): amount, material
@group(0) @binding(9) var<storage, read_write> looseAdd: array<vec2<f32>>;
@group(0) @binding(16) var driftOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(19) var strataTex: texture_2d<f32>;
@group(0) @binding(20) var strataOut: texture_storage_2d<rgba32float, write>;
// driftTex (binding 17) is declared in common.wgsl (driftAt, driftMatAt)

/** 0..1 how firmly the plants on column j hold its loose layer */
fn rooted(j: u32) -> f32 { return smoothstep(1.2, 2.0, vegD[j]); }

const DT_D: f32 = 2.0 / 60.0; // the system runs every other tick
const CARRY: f32 = 0.25;      // cells of depth lifted per second per cell/s over the threshold
const SLUMP: f32 = 0.08;
// where the wind is moving loose ground, level differences between
// neighbours ease out a little each pass, so the transport can't see-saw
// into a checkerboard (round 17); still ground keeps its shape
const WIND_SMOOTH: f32 = 0.15;
const NEVER: f32 = 1e9;
const MAT_SOIL_L: u32 = 2u;
const MAT_SAND_L: u32 = 3u;
const MAT_GRAVEL_L: u32 = 4u;
const MAT_ASH_L: u32 = 17u;
const MAT_SILT_L: u32 = 22u;

/**
 * How a loose material behaves: x wind (cells/s, sheltered) needed to move
 * it, y steepest slope it holds (cells per cell), z share of what the wind
 * lifts that goes airborne, w how readily moving water carries it.
 */
fn looseOf(m: u32) -> vec4<f32> {
  if (m == MAT_SAND_L) { return vec4<f32>(14.0, 1.0, 0.15, 1.0); }
  if (m == MAT_ASH_L) { return vec4<f32>(10.0, 0.9, 0.5, 1.0); }
  if (m == MAT_SOIL_L || m == MAT_SILT_L) { return vec4<f32>(NEVER, 1.4, 0.0, 0.6); }
  if (m == MAT_GRAVEL_L) { return vec4<f32>(NEVER, 1.7, 0.0, 0.25); }
  return vec4<f32>(9.0, 0.8, 0.4, 1.0); // dust
}

/** Net water flow (volume/tick through the column) below which it doesn't carry m. */
fn washOf(m: u32) -> f32 {
  if (m == MAT_SOIL_L || m == MAT_SILT_L) { return 0.12; }
  if (m == MAT_GRAVEL_L) { return 0.3; }
  if (m == MAT_SAND_L) { return 0.08; }
  return 0.03; // dust, ash
}

fn levelAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  // a body lying here is ground too: things bank against it and slide off it
  return max(f32(sfZ(surface[colIdxI(q)])) + driftAt(q), bodyTopAt(q));
}

/** Is q's loose ground under a body lying over it (sheltered: it doesn't move)? */
fn underBody(q: vec2<i32>) -> bool {
  return bodyTopAt(q) > f32(sfZ(surface[colIdxI(q)])) + driftAt(q);
}

/** The top layer's depth on q (what the wind, water and slumping can take). */
fn topOf(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  let t = textureLoad(driftTex, q, 0);
  return clamp(t.y, 0.0, t.x);
}

/**
 * 0..1 how firmly q's plants hold its top layer: only what lies within their
 * reach. A top layer a cell or two deep has buried them, and moves like any
 * other (round 21: held tops took in all the sand blown at them and shed
 * none, so planted columns in a cyclone's wind grew into spires).
 */
fn held(q: vec2<i32>) -> f32 {
  return rooted(colIdxI(q)) * (1.0 - smoothstep(1.0, 2.0, topOf(q)));
}

/** 0..1 how sheltered q is from the wind w by taller ground up to 4 cells upwind. */
fn shelter(q: vec2<i32>, w: vec2<f32>) -> f32 {
  let ws = length(w);
  if (ws < 1e-3) { return 0.0; }
  let up = -w / ws;
  let here = levelAt(q);
  var s = 0.0;
  for (var k = 1; k <= 4; k++) {
    let u = vec2<i32>(floor(vec2<f32>(q) + 0.5 + up * f32(k)));
    if (!inMap(u)) { break; }
    s = max(s, (levelAt(u) - here) / f32(k));
  }
  return clamp(s * 0.9, 0.0, 1.0);
}

/** What the wind sends from q's top layer to its +x, -x, +y, -y neighbours this pass. */
fn windOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  let top = topOf(q);
  if (top < 0.001 || water[j] > 0.05 || held(q) > 0.5 || underBody(q)) { return vec4<f32>(0.0); }
  let lo = looseOf(driftMatAt(q));
  // on the title diorama (fine scale, G.misc.w) a cell is about a centimetre:
  // a breath of wind moves dust there, so the player can blow the dust off
  // the buried level models (round 13 F11)
  let fine = G.misc.w > 0.5;
  let lift = lo.x * select(1.0, 0.45, fine);
  if (lift >= NEVER * 0.4) { return vec4<f32>(0.0); }
  let carry = CARRY * select(1.0, 4.8, fine);
  let here = levelAt(q);
  let w = windAt(vec3<f32>(vec2<f32>(q) + 0.5, here + 0.5));
  let ws = length(w) * (1.0 - shelter(q, w));
  if (ws < lift) { return vec4<f32>(0.0); }
  var wt = vec4<f32>(max(w.x, 0.0), max(-w.x, 0.0), max(w.y, 0.0), max(-w.y, 0.0));
  // it can't be pushed up into a wall: it banks against it instead
  for (var k = 0u; k < 4u; k++) {
    let n = q + DIRS[k];
    if (inMap(n) && levelAt(n) >= here + 1.5) { wt[k] = 0.0; }
  }
  let sum = wt.x + wt.y + wt.z + wt.w;
  if (sum < 1e-4) { return vec4<f32>(0.0); }
  // (at most a quarter of the top per pass: larger steps made neighbouring
  // columns over-correct each other into a checkerboard — round 17)
  let total = min(top * 0.25, carry * (ws - lift) * DT_D);
  return wt / sum * total;
}

/** What moving water carries from q's top layer downstream this pass. */
fn waterOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  let top = topOf(q);
  if (top < 0.001 || water[j] < 0.02 || underBody(q)) { return vec4<f32>(0.0); }
  let m = driftMatAt(q);
  let v = netFlow(q);
  let sp = length(v);
  let thr = washOf(m);
  if (sp < thr) { return vec4<f32>(0.0); }
  let mob = looseOf(m).w * (1.0 - 0.8 * held(q));
  let total = min(top * 0.2, (sp - thr) * 1.5 * mob * DT_D * 30.0);
  let wt = vec4<f32>(max(v.x, 0.0), max(-v.x, 0.0), max(v.y, 0.0), max(-v.y, 0.0));
  let sum = wt.x + wt.y + wt.z + wt.w;
  if (sum < 1e-6) { return vec4<f32>(0.0); }
  return wt / sum * total;
}

/** Is the wind strong enough to move q's top material right now? */
fn windActive(q: vec2<i32>) -> bool {
  let j = colIdxI(q);
  if (water[j] > 0.05) { return false; }
  let lift = looseOf(driftMatAt(q)).x * select(1.0, 0.45, G.misc.w > 0.5);
  if (lift >= NEVER * 0.4) { return false; }
  let w = windAt(vec3<f32>(vec2<f32>(q) + 0.5, levelAt(q) + 0.5));
  return length(w) > lift;
}

/** What slides off q's top layer to each neighbour this pass (steeper than its repose; eased where the wind works). */
fn slumpOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let top = topOf(q);
  if (top < 0.001 || underBody(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  let here = levelAt(q);
  let rep = looseOf(driftMatAt(q)).y;
  var o = vec4<f32>(0.0);
  for (var k = 0u; k < 4u; k++) {
    let n = q + DIRS[k];
    if (!inMap(n)) { continue; }
    let diff = here - levelAt(n);
    o[k] = max(diff - rep, 0.0) * SLUMP * (1.0 - held(q));
  }
  let s = o.x + o.y + o.z + o.w;
  if (s > top * 0.8) { o *= top * 0.8 / s; }
  return o;
}

/** The easing where the wind works: what q's top gives each lower neighbour (it blends in there). */
fn smoothOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let top = topOf(q);
  if (top < 0.001 || underBody(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  if (!(textureLoad(driftTex, q, 0).w > 0.0 || windActive(q))) { return vec4<f32>(0.0); }
  let here = levelAt(q);
  var o = vec4<f32>(0.0);
  for (var k = 0u; k < 4u; k++) {
    let n = q + DIRS[k];
    if (!inMap(n)) { continue; }
    o[k] = max(here - levelAt(n), 0.0) * WIND_SMOOTH * (1.0 - held(q));
  }
  let s = o.x + o.y + o.z + o.w;
  if (s > top * 0.6) { o *= top * 0.6 / s; }
  return o;
}

// ---- the stack ----------------------------------------------------------------
struct Stack {
  top: f32,
  mat: u32,
  // lower layers, bottom first: depth and material (n of them)
  d: array<f32, 3>,
  m: array<u32, 3>,
  n: u32,
};

fn unpackLayer(v: f32) -> vec2<f32> {
  if (v <= 0.0) { return vec2<f32>(0.0); }
  let m = floor(v / 1000.0);
  return vec2<f32>(v - m * 1000.0, m);
}

/** A new material arrives on top: start a layer (the old top goes under). */
fn pushTop(s: ptr<function, Stack>, mat: u32) {
  if ((*s).top < 0.02) {
    // nothing much left of the old top: it just becomes the new material
    (*s).mat = mat;
    return;
  }
  if ((*s).n == 3u) {
    // full: the two bottom layers merge (the lower one is buried deepest)
    (*s).d[0] += (*s).d[1];
    (*s).d[1] = (*s).d[2];
    (*s).m[1] = (*s).m[2];
    (*s).n = 2u;
  }
  (*s).d[(*s).n] = (*s).top;
  (*s).m[(*s).n] = (*s).mat;
  (*s).n += 1u;
  (*s).top = 0.0;
  (*s).mat = mat;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let st = textureLoad(strataTex, p, 0);
  var s: Stack;
  s.top = topOf(p);
  s.mat = driftMatAt(p);
  s.n = 0u;
  for (var k = 0u; k < 3u; k++) {
    let l = unpackLayer(st[k]);
    if (l.x > 0.0) {
      s.d[s.n] = l.x;
      s.m[s.n] = u32(l.y);
      s.n += 1u;
    }
  }
  let m0 = s.mat;
  // what leaves the top layer: wind, water, slumping
  let o = windOut(p);
  let lost = o.x + o.y + o.z + o.w;
  let ow = waterOut(p);
  let so = slumpOut(p);
  let sm = smoothOut(p);
  s.top -= lost + ow.x + ow.y + ow.z + ow.w + so.x + so.y + so.z + so.w + sm.x + sm.y + sm.z + sm.w;
  let here = levelAt(p);
  // what arrives, by material: the same as my top joins it; the largest
  // other arrival starts a new layer (and takes the rest with it)
  var same = 0.0;
  var other = 0.0;
  var otherMat = m0;
  var otherMax = 0.0;
  var dust = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let n = p + DIRS[k];
    if (!inMap(n)) { continue; }
    let mn = driftMatAt(n);
    let a = windOut(n)[k ^ 1u] * (1.0 - looseOf(mn).z) + waterOut(n)[k ^ 1u] + slumpOut(n)[k ^ 1u];
    // (the wind's easing just blends into my top, whatever it is)
    same += smoothOut(n)[k ^ 1u];
    if (mn == m0) { same += a; } else {
      other += a;
      if (a > otherMax) { otherMax = a; otherMat = mn; }
    }
  }
  // dust storms drop dust where the wind is broken (sheltered spots, hollows)
  for (var k = 0u; k < 2u; k++) {
    let ds = G.dusts[k];
    if (ds.w <= 0.0) { continue; }
    let r = length(vec2<f32>(p) + 0.5 - ds.xy) / ds.z;
    if (r > 1.2) { continue; }
    let w = windAt(vec3<f32>(vec2<f32>(p) + 0.5, here + 0.5));
    dust += ds.w / 8.0 * smoothstep(1.2, 0.4, r) * 0.06 * DT_D * (0.15 + 0.85 * shelter(p, w));
  }
  // a dying cyclone drops the dust it carried in a pile around its eye
  for (var c = 0u; c < MAX_CYCLONES; c++) {
    if (G.cyclones[c].b.z <= 0.0) { continue; }
    let r = length(vec2<f32>(p) + 0.5 - G.cyclones[c].a.xy) / G.cyclones[c].a.z;
    dust += smoothstep(1.6, 0.0, r) * 0.6 * DT_D;
  }
  // dust that came down from the air here (carried by particles)
  dust += f32(atomicExchange(&exchange[G.mapW * G.mapH + i], 0)) / 100000.0;
  // the editor: a pour of loose material (its material from the brush state),
  // dust brushed on, or something taken away (dig, clean)
  let delta = driftDelta[i];
  driftDelta[i] = 0.0;
  var pour = 0.0;
  var pourMat = MAT_DRIFT;
  if (delta > 0.0) {
    let ed = u32(floor(textureLoad(editTex, p, 0).w / 4.0));
    if (ed / 32u == 10u) { pour = delta; pourMat = ed % 32u; } else { dust += delta; }
  }
  if (MAT_DRIFT == m0) { same += dust; } else {
    other += dust;
    if (dust > otherMax) { otherMax = dust; otherMat = MAT_DRIFT; }
  }
  s.top = max(s.top, 0.0) + same;
  if (pour > 0.0) {
    if (pourMat != s.mat) { pushTop(&s, pourMat); }
    s.top += pour;
  }
  // a rigid body that crumbled here (game/integrity.ts)
  let la = looseAdd[i];
  if (la.x > 0.0) {
    let lm = u32(la.y + 0.5);
    if (lm != s.mat) { pushTop(&s, lm); }
    s.top += la.x;
    looseAdd[i] = vec2<f32>(0.0);
  }
  if (other > 0.0) {
    // a trace of something else blends in; a real amount starts a layer
    if (otherMat != s.mat && other >= 0.01) { pushTop(&s, otherMat); }
    s.top += other;
  }
  // taken away: from the top layer, then those beneath
  var take = max(-delta, 0.0);
  let fromTop = min(take, s.top);
  s.top -= fromTop;
  take -= fromTop;
  // a spent top layer uncovers the one beneath it
  for (var k = 0u; k < 3u; k++) {
    if (s.top > 0.001 || s.n == 0u) { break; }
    s.n -= 1u;
    s.top += s.d[s.n];
    s.mat = s.m[s.n];
    let t = min(take, s.top);
    s.top -= t;
    take -= t;
  }
  // green binds dust and ash it grows through: they become soil
  if (rooted(i) > 0.8 && (s.mat == MAT_DRIFT || s.mat == MAT_ASH_L) && s.top < 1.0) { s.mat = MAT_SOIL_L; }
  if (s.top <= 0.001 && s.n == 0u) { s.top = 0.0; s.mat = MAT_DRIFT; }
  var total = s.top;
  var packed = vec4<f32>(0.0);
  for (var k = 0u; k < s.n; k++) {
    total += s.d[k];
    packed[k] = f32(s.m[k]) * 1000.0 + min(s.d[k], 999.0);
  }
  // what this cell's wind sent up into the air (the particles take it from here)
  let air = lost * looseOf(m0).z;
  textureStore(driftOut, p, vec4<f32>(total, s.top, f32(s.mat), air));
  textureStore(strataOut, p, packed);
}
