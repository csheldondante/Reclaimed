// ---- sediment: the loose ground in the layers ----------------------------------
// (round 11 drifts → round 15 per-material loose layer → round 16 all soft
// ground loose, smooth and layered → round 22: the loose ground *is* the
// layers.) Every granular interval is loose ground. The run of touching
// granular intervals on top of a column is what wind, water and slumping
// work on: they take from its top interval; what arrives joins the top
// interval if it's the same material, otherwise it starts a new interval on
// top (so pours and drifts make strata). Granular intervals with air under
// them fall. Each material's behaviour comes from the material table: wind
// threshold, airborne share, readiness to wash away (MATS[m].loose) and its
// angle of repose dry and wet (MATS[m].sim.yz): dust moves in a gust, ash
// and sand in stronger wind, soil and gravel only with water. Above its
// threshold a column sends material downwind (split over the four faces by
// the wind's components); sheltered columns — behind taller ground upwind —
// feel less wind, so it piles up in their lee; it can't be pushed up into a
// wall, so it banks there. It lies under still water (the liquids sit on
// top of it), moving water carries it downstream, settling where the flow
// slows, and water held back by loose ground pipes through it (embankments
// and rubble plugs breach); material carried off the map edge is gone.
// Plants under a deep top layer of dust or ash lie dormant; established
// plants hold what they grow through and turn dust to soil.
//
// Two passes, race-free: `outflow` works out what leaves every column (from
// the read-only view of the loose ground the surface pass derived from the
// layers just before) into `sedOut`; `main` takes its own outflow off its top
// and gathers what its neighbours sent it, so what leaves one column arrives
// in the next. A column's own intervals are only touched by its own thread,
// so the layers are updated in place.
@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
// loose material arriving (edit.wgsl: x; game/integrity.ts: y amount, z material)
@group(0) @binding(5) var<storage, read_write> deposit: array<vec4<f32>>;
// water flux (flow.wgsl netFlow): moving water carries the layer downstream
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
// plants: established green holds the layer it grows through (round 15)
@group(0) @binding(7) var<storage, read> vegD: array<f32>;
// dust that came down here from the air (particles.wgsl), the second half of
// the exchange buffer, ×1e5
@group(0) @binding(8) var<storage, read_write> exchange: array<atomic<i32>>;
// wet ground holds a lower slope (rain brings slumps and mudslides)
@group(0) @binding(9) var<storage, read> moisture: array<f32>;
// per column: [0] what arrives at each neighbour (+x, -x, +y, -y), [1] the
// wind's easing toward each (it blends into whatever is there), [2] x what
// the wind took off the top, y everything that left it
@group(0) @binding(10) var<storage, read_write> sedOut: array<vec4<f32>>;
// what the wind sent up into the air off each column this pass (the
// particles carry it as dust grains and set it down where they land)
@group(0) @binding(16) var airOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(19) var strataTex: texture_2d<f32>;
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
const NEVER: f32 = 1e8;
// granular intervals with air under them fall this far per pass
const FALL: f32 = 2.0;
// piping: loose ground holding back a large water-level difference is
// pushed toward the low side (cells per pass per cell of head over PIPE_HEAD)
const PIPE_HEAD: f32 = 2.5;
const PIPE_RATE: f32 = 0.04;
const MAT_SOIL_L: u32 = 2u;
const MAT_ASH_L: u32 = 17u;

/** The base of q's loose ground (exact; surface holds it rounded). */
fn baseAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  return textureLoad(strataTex, q, 0).w;
}

fn levelAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  // a body lying here is ground too: things bank against it and slide off it
  return max(baseAt(q) + driftAt(q), bodyTopAt(q));
}

/** Is q's loose ground under a body lying over it (sheltered: it doesn't move)? */
fn underBody(q: vec2<i32>) -> bool {
  return bodyTopAt(q) > baseAt(q) + driftAt(q);
}

/** The top interval's depth on q (what the wind, water and slumping can take). */
fn topOf(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  let t = textureLoad(driftTex, q, 0);
  return clamp(t.y, 0.0, t.x);
}

/** The steepest slope q's top material holds (cells per cell), lower when wet. */
fn reposeAt(q: vec2<i32>, m: u32) -> f32 {
  return mix(MATS[m].sim.y, MATS[m].sim.z, smoothstep(0.35, 0.8, moisture[colIdxI(q)]));
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
  let m = driftMatAt(q);
  // on the title diorama (fine scale, G.misc.w) a cell is about a centimetre:
  // a breath of wind moves dust there, so the player can blow the dust off
  // the buried level models (round 13 F11)
  let fine = G.misc.w > 0.5;
  let lift = MATS[m].loose.x * select(1.0, 0.45, fine);
  if (lift >= NEVER) { return vec4<f32>(0.0); }
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
  let thr = MATS[m].loose.w;
  if (sp < thr) { return vec4<f32>(0.0); }
  let mob = MATS[m].loose.z * (1.0 - 0.8 * held(q));
  let total = min(top * 0.2, (sp - thr) * 1.5 * mob * DT_D * 30.0);
  let wt = vec4<f32>(max(v.x, 0.0), max(-v.x, 0.0), max(v.y, 0.0), max(-v.y, 0.0));
  let sum = wt.x + wt.y + wt.z + wt.w;
  if (sum < 1e-6) { return vec4<f32>(0.0); }
  return wt / sum * total;
}

/** Water held back by q's loose top pushes it toward the low side (piping). */
fn pipeOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let top = topOf(q);
  if (top < 0.001 || underBody(q)) { return vec4<f32>(0.0); }
  let h = levelAt(q);
  var hi = -1.0;
  var lo = 1e9;
  var loDir = 0u;
  for (var k = 0u; k < 4u; k++) {
    let n = q + DIRS[k];
    if (!inMap(n)) { continue; }
    let j = colIdxI(n);
    let lvl = levelAt(n) + water[j];
    if (water[j] > 0.05) { hi = max(hi, lvl); }
    if (lvl < lo) { lo = lvl; loDir = k; }
  }
  // only when the water actually presses against this column's loose top
  if (!(hi > h - 4.0 && hi - lo > PIPE_HEAD && lo < h)) { return vec4<f32>(0.0); }
  let m = driftMatAt(q);
  var o = vec4<f32>(0.0);
  o[loDir] = min(top * 0.25, (hi - lo - PIPE_HEAD) * PIPE_RATE * (1.0 - MATS[m].sim.w * 0.5));
  return o;
}

/** Is the wind strong enough to move q's top material right now? */
fn windActive(q: vec2<i32>) -> bool {
  let j = colIdxI(q);
  if (water[j] > 0.05) { return false; }
  let lift = MATS[driftMatAt(q)].loose.x * select(1.0, 0.45, G.misc.w > 0.5);
  if (lift >= NEVER) { return false; }
  let w = windAt(vec3<f32>(vec2<f32>(q) + 0.5, levelAt(q) + 0.5));
  return length(w) > lift;
}

/** What slides off q's top layer to each neighbour this pass (steeper than its repose; eased where the wind works). */
fn slumpOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let top = topOf(q);
  if (top < 0.001 || underBody(q)) { return vec4<f32>(0.0); }
  let here = levelAt(q);
  let rep = reposeAt(q, driftMatAt(q));
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

// ---- the run on top, as a stack ------------------------------------------------
// The loose run is unpacked into a stack (bottom first; the last is the top
// interval), worked on, and written back from the run's base upward.
struct Stack {
  d: array<f32, MAX_K>,
  m: array<u32, MAX_K>,
  n: u32,
  // the most intervals the run may use (slots above what lies under it)
  cap: u32,
};

fn topDepth(s: ptr<function, Stack>) -> f32 {
  if ((*s).n == 0u) { return 0.0; }
  return (*s).d[(*s).n - 1u];
}
/** The top's material (dust when there is no loose ground: the view's convention). */
fn topMat(s: ptr<function, Stack>) -> u32 {
  if ((*s).n == 0u) { return MAT_DRIFT; }
  return (*s).m[(*s).n - 1u];
}

/** Material `mat` arrives on top: it joins the top if it's the same, else starts an interval. */
fn addTop(s: ptr<function, Stack>, amount: f32, mat: u32) {
  if (amount <= 0.0) { return; }
  let n = (*s).n;
  if (n > 0u && (*s).m[n - 1u] == mat) { (*s).d[n - 1u] += amount; return; }
  if (n > 0u && (*s).d[n - 1u] < 0.02) {
    // nothing much left of the old top: it just becomes the new material
    (*s).m[n - 1u] = mat;
    (*s).d[n - 1u] += amount;
    return;
  }
  if (n >= (*s).cap) {
    if (n >= 2u) {
      // full: the two bottom intervals merge (the lower one is buried deepest)
      (*s).d[0] += (*s).d[1];
      for (var k = 1u; k + 1u < n; k++) { (*s).d[k] = (*s).d[k + 1u]; (*s).m[k] = (*s).m[k + 1u]; }
      (*s).n -= 1u;
    } else if (n == 1u) {
      // room for one interval only: it mixes in
      (*s).d[0] += amount;
      return;
    } else {
      return;
    }
  }
  (*s).d[(*s).n] = amount;
  (*s).m[(*s).n] = mat;
  (*s).n += 1u;
}

/** Take `amount` off the top, then from the intervals beneath it; returns what couldn't be taken. */
fn takeTop(s: ptr<function, Stack>, amount: f32) -> f32 {
  var take = amount;
  while (take > 0.0 && (*s).n > 0u) {
    let k = (*s).n - 1u;
    let t = min(take, (*s).d[k]);
    (*s).d[k] -= t;
    take -= t;
    if ((*s).d[k] <= 0.001) { (*s).n -= 1u; }
  }
  return take;
}

/** Pass 1: what leaves each column's top this pass, and where it goes. */
@compute @workgroup_size(8, 8)
fn outflow(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let mat = driftMatAt(p);
  let o = windOut(p);
  let ow = waterOut(p);
  let so = slumpOut(p);
  let sm = smoothOut(p);
  let po = pipeOut(p);
  let lost = o.x + o.y + o.z + o.w;
  // (what the wind lifts partly goes up into the air: the particles carry it)
  let send = o * (1.0 - MATS[mat].loose.y) + ow + so + po;
  let out = lost + dot(ow + so + sm + po, vec4<f32>(1.0));
  sedOut[i * 3u] = send;
  sedOut[i * 3u + 1u] = sm;
  sedOut[i * 3u + 2u] = vec4<f32>(lost, out, 0.0, 0.0);
}

/** Pass 2: each column's run takes its own outflow off and gathers its neighbours'. */
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let cs = colSlots(id.x, id.y);
  // the top's material, as the view sees it (dust when there's no loose ground)
  let m0 = driftMatAt(p);
  let own = sedOut[i * 3u + 2u];
  // what the wind sent up into the air (the particles take it from here)
  textureStore(airOut, p, vec4<f32>(own.x * MATS[m0].loose.y, 0.0, 0.0, 0.0));
  let here = levelAt(p);
  // what arrives, by material: the same as my top joins it; the largest
  // other arrival starts a new layer (and takes the rest with it)
  var same = 0.0;
  var other = 0.0;
  var otherMat = m0;
  var otherMax = 0.0;
  var dust = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let nb = p + DIRS[k];
    if (!inMap(nb)) { continue; }
    let j = colIdxI(nb);
    let mn = driftMatAt(nb);
    let a = sedOut[j * 3u][k ^ 1u];
    // (the wind's easing just blends into my top, whatever it is)
    same += sedOut[j * 3u + 1u][k ^ 1u];
    if (mn == m0) { same += a; } else {
      other += a;
      if (a > otherMax) { otherMax = a; otherMat = mn; }
    }
  }
  // dust storms drop dust where the wind is broken (sheltered spots, hollows)
  for (var k = 0u; k < 2u; k++) {
    let ds = G.dusts[k];
    if (ds.w <= 0.0) { continue; }
    let rr = length(vec2<f32>(p) + 0.5 - ds.xy) / ds.z;
    if (rr > 1.2) { continue; }
    let w = windAt(vec3<f32>(vec2<f32>(p) + 0.5, here + 0.5));
    dust += ds.w / 8.0 * smoothstep(1.2, 0.4, rr) * 0.06 * DT_D * (0.15 + 0.85 * shelter(p, w));
  }
  // a dying cyclone drops the dust it carried in a pile around its eye
  for (var c = 0u; c < MAX_CYCLONES; c++) {
    if (G.cyclones[c].b.z <= 0.0) { continue; }
    let rr = length(vec2<f32>(p) + 0.5 - G.cyclones[c].a.xy) / G.cyclones[c].a.z;
    dust += smoothstep(1.6, 0.0, rr) * 0.6 * DT_D;
  }
  // dust that came down from the air here (carried by particles)
  dust += f32(atomicExchange(&exchange[G.mapW * G.mapH + i], 0)) / 100000.0;
  // the editor: a pour of loose material (its material from the brush state),
  // dust brushed on, or something taken away (dig, clean); a crumbled body
  let dep = deposit[i];
  let anyDep = any(dep != vec4<f32>(0.0));
  if (anyDep) { deposit[i] = vec4<f32>(0.0); }
  let delta = dep.x;
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
  // strong wind tears litter off the top a cell at a time (the particles
  // throw up the scrap for the same rolls — see litterStrip; this pass runs
  // every other tick, so it takes both ticks' rolls); ash isn't stripped: the
  // wind lifts it like any loose ground, as dust grains
  let topNow = topOf(p);
  let litter = m0 == MAT_LITTER && topNow > 0.0;
  let strip = select(0u, 1u, litter && litterStrip(p, G.tick)) + select(0u, 1u, litter && litterStrip(p, G.tick - 1u));
  // green binds dust and ash it grows through: they become soil
  let bind = topNow > 0.0 && topNow < 1.0 && rooted(i) > 0.8 && (m0 == MAT_DRIFT || m0 == MAT_ASH_L);

  // most columns are still: nothing leaves, nothing arrives, nothing hangs
  // over air — leave their intervals alone
  var n = 0u;
  var hangs = false;
  var floorZ = 0.0;
  for (var k = 0u; k < cs.y; k++) {
    let v = layers[cs.x + k];
    if (ivEmpty(v)) { break; }
    n = k + 1u;
    if (matState(ivMat(v)) == ST_GRANULAR && ivZ0(v) > floorZ + 1e-4) { hangs = true; }
    floorZ = ivZ1(v);
  }
  let moves = own.y > 0.0 || same > 0.0 || other > 0.0 || pour > 0.0 || dep.y > 0.0 || delta < 0.0 || strip > 0u || bind;
  if (!moves && !hangs) { return; }

  var arr: array<vec4<u32>, MAX_K>;
  for (var k = 0u; k < n; k++) { arr[k] = layers[cs.x + k]; }
  // granular intervals with air under them fall (rubble a collapse left
  // hanging, sand whose support was dug away)
  if (hangs) {
    floorZ = 0.0;
    for (var k = 0u; k < n; k++) {
      let v = arr[k];
      var z0 = ivZ0(v);
      var z1 = ivZ1(v);
      if (matState(ivMat(v)) == ST_GRANULAR && z0 > floorZ + 1e-4) {
        let f = min(FALL, z0 - floorZ);
        z0 -= f;
        z1 -= f;
        arr[k] = ivPack(z0, z1, ivMat(v), ivAux(v));
      }
      floorZ = z1;
    }
  }

  // the run on top, as a stack (touching granular intervals of the same
  // material count as one)
  let r = looseRun(&arr, n);
  var s: Stack;
  s.n = 0u;
  s.cap = max(cs.y - r, 1u);
  var base = 0.0;
  if (n > 0u) { base = ivZ1(arr[n - 1u]); }
  if (r < n) { base = ivZ0(arr[r]); }
  for (var k = r; k < n; k++) {
    let v = arr[k];
    let d = ivZ1(v) - ivZ0(v);
    if (s.n > 0u && s.m[s.n - 1u] == ivMat(v)) { s.d[s.n - 1u] += d; continue; }
    s.d[s.n] = d;
    s.m[s.n] = ivMat(v);
    s.n += 1u;
  }
  // (with no room for loose ground at all, nothing can land here)
  let room = r < cs.y;

  if (s.n > 0u) {
    s.d[s.n - 1u] = max(s.d[s.n - 1u] - own.y, 0.0);
  }
  // (a column already full of other intervals has no room for loose ground:
  // what would land there is lost — rare; the chunk table gives ruins room)
  if (room) {
    if (s.n > 0u) { s.d[s.n - 1u] += same; } else { addTop(&s, same, m0); }
    addTop(&s, pour, pourMat);
    if (dep.y > 0.0) { addTop(&s, dep.y, u32(dep.z + 0.5)); }
    if (other > 0.0) {
      // a trace of something else blends in; a real amount starts a layer
      if (other < 0.01 && s.n > 0u) { s.d[s.n - 1u] += other; } else { addTop(&s, other, otherMat); }
    }
  }
  // taken away: from the top layer, then those beneath
  _ = takeTop(&s, max(-delta, 0.0));
  for (var k = 0u; k < strip; k++) {
    if (s.n > 0u && topMat(&s) == MAT_LITTER) { _ = takeTop(&s, min(1.0, topDepth(&s))); }
  }
  // a spent top uncovers what's beneath it
  while (s.n > 0u && s.d[s.n - 1u] <= 0.001) { s.n -= 1u; }
  if (bind && s.n > 0u && (topMat(&s) == MAT_DRIFT || topMat(&s) == MAT_ASH_L)) {
    s.m[s.n - 1u] = MAT_SOIL_L;
    if (s.n > 1u && s.m[s.n - 2u] == MAT_SOIL_L) { s.d[s.n - 2u] += s.d[s.n - 1u]; s.n -= 1u; }
  }

  // write the run back from its base up
  var z = base;
  var w = r;
  for (var k = 0u; k < s.n; k++) {
    if (w >= cs.y) { break; }
    let z1 = min(z + s.d[k], f32(G.zMax) - 0.01);
    if (z1 - z <= 1e-5) { continue; }
    arr[w] = ivPack(z, z1, s.m[k], 0u);
    z = z1;
    w += 1u;
  }
  let n1 = w;
  for (var k = 0u; k < max(n, n1); k++) { layers[cs.x + k] = select(IV_NONE, arr[k], k < n1); }
}
