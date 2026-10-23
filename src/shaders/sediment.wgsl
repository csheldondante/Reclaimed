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
// threshold a column sends material downwind (split over the six faces by
// the wind's components along them); sheltered columns — behind taller ground upwind —
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
@group(0) @binding(6) var<storage, read> flux: array<Dirs>;
// plants: established green holds the layer it grows through (round 15)
@group(0) @binding(7) var<storage, read> vegD: array<f32>;
// dust that came down here from the air (particles.wgsl), the second half of
// the exchange buffer, ×1e5
@group(0) @binding(8) var<storage, read_write> exchange: array<atomic<i32>>;
// wet ground holds a lower slope (rain brings slumps and mudslides)
@group(0) @binding(9) var<storage, read> moisture: array<f32>;
// per column (SED lanes of one value per direction, NDIR order): [0] what
// arrives at each neighbour, [1] the wind's easing toward each (it blends into whatever is there),
// [2] x what the wind sent up into the air off the top, y everything that left it; a spill
// out of an exposed face toward each neighbour: [3] amount, [4] the floor it
// lands on (z), [5] material, [6] which of this column's slots it leaves
@group(0) @binding(10) var<storage, read_write> sedOut: array<Dirs>;
// (outflow only) which neighbours have air inside them (surface bit 31)
@group(0) @binding(11) var<storage, read> surface: array<u32>;
// what the wind sent up into the air off each column this pass (the
// particles carry it as dust grains and set it down where they land)
@group(0) @binding(16) var airOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(19) var strataTex: texture_2d<f32>;
// driftTex (binding 17) is declared in common.wgsl (driftAt, driftMatAt)

/** 0..1 how firmly the plants on column j hold its loose layer */
fn rooted(j: u32) -> f32 { return smoothstep(1.2, 2.0, vegD[j]); }

const DT_D: f32 = 2.0 / 60.0; // the system runs every other tick
const CARRY: f32 = 0.25;      // cells of depth lifted per second per cell/s over the threshold
// (per neighbour: the hex grid has six, each 2/3 the square grid's four —
// the same continuum rate, water_flux.wgsl)
const SLUMP: f32 = 0.08 * 2.0 / 3.0;
const HOLD_STEEP: f32 = 1.0;
// where the wind is moving loose ground, level differences between
// neighbours ease out a little each pass, so the transport can't see-saw
// into a checkerboard (round 17); still ground keeps its shape
const WIND_SMOOTH: f32 = 0.15 * 2.0 / 3.0;
const NEVER: f32 = 1e8;
// granular intervals with air under them fall this far per pass
const FALL: f32 = 2.0;
// piping: loose ground holding back a large water-level difference is
// pushed toward the low side (cells per pass per cell of head over PIPE_HEAD)
const PIPE_HEAD: f32 = 2.5;
const PIPE_RATE: f32 = 0.04;
const SED: u32 = 7u;
// a buried granular interval with air beside it spills out of the face
// (share of its height over the repose, per pass), like a slump
const FACE: f32 = 0.08;
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

// ---- the open air a structure leaves (docs/GRIDS.md) ----------------------------
// A structure over a column (its projected intervals, common.wgsl projAt)
// leaves stretches of open air: the sky over its top, the rooms between its
// floors, the space under a tilted wall. Level j is the air under projected
// interval j-1 (the sky for j = 0) and over interval j; its floor is the
// highest of the column's own ground reaching into it and interval j
// (surface.wgsl levels). The loose run on top of a column lies in one of them
// (runLevel); what a neighbour sends at height h comes into the level of this
// column open at that height, or steps up onto the solid in the way (openAt)
// — so sand blows in under an overhang and through a doorway, and banks
// against a wall. Under a structure there is no wind and no water (they work
// on the open sky); the loose ground there only slumps.
@group(0) @binding(29) var levelsTex: texture_2d<f32>;
const SKY: u32 = 0u;
/** a run inside a solid, or with no room over it */
const SHUT: u32 = 99u;
// the least room an opening needs for loose ground to pass
const CLEAR: f32 = 0.75;

/** The surface of q's own loose run (the top of its ground). */
fn hereAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  return baseAt(q) + driftAt(q);
}

/** Whether column q has anything projected over it (most don't: the fast path). */
fn hasProj(q: vec2<i32>) -> bool { return bodyTopAt(q) >= 0.0; }

/** The level q's own run lies in (SHUT: inside a solid, or no room over it). */
fn runLevel(q: vec2<i32>) -> u32 {
  if (!hasProj(q)) { return SKY; }
  let g = hereAt(q);
  var ceil = 1e9;
  for (var j = 0u; j <= PROJ_K; j++) {
    var below = IV_NONE;
    if (j < PROJ_K) { below = projAt(q, j); }
    if (ivEmpty(below) || g >= ivZ1(below) - 1e-3) {
      if (j > 0u && g > ceil - CLEAR) { return SHUT; }
      return j;
    }
    if (g > ivZ0(below) + 1e-3) { return SHUT; }
    ceil = ivZ0(below);
  }
  return SHUT;
}

struct Open { j: u32, floor: f32 };

/** The level of q open at height h — where something moving at h comes in — stepping up onto a solid in the way. */
fn openAt(q: vec2<i32>, h: f32) -> Open {
  if (!inMap(q)) { return Open(SKY, 0.0); }
  if (!hasProj(q)) { return Open(SKY, hereAt(q)); }
  let lv = textureLoad(levelsTex, q, 0);
  let z = h + 0.5;
  var ceil = 1e9;
  for (var j = 0u; j <= PROJ_K; j++) {
    let fl = lv[j];
    var below = IV_NONE;
    if (j < PROJ_K) { below = projAt(q, j); }
    if (z >= fl || ivEmpty(below)) {
      // in the solid over this level, or no room in it: onto that solid
      if (j > 0u && (z >= ceil || ceil - fl < CLEAR)) { return Open(j - 1u, lv[j - 1u]); }
      return Open(j, fl);
    }
    ceil = ivZ0(below);
  }
  return Open(SKY, lv[0]);
}

/** The floor of q something moving at height h meets (a solid in the way counts as its top). */
fn seenAt(q: vec2<i32>, h: f32) -> f32 {
  if (!inMap(q)) { return 0.0; }
  return openAt(q, h).floor;
}

/** Is q's loose run under a structure or a body (no wind or water there)? */
fn underBody(q: vec2<i32>) -> bool {
  return runLevel(q) != SKY;
}

/**
 * Loose material lands on the floor of level t of column p, whose n
 * intervals arr holds (cap slots): it joins the interval it lands on if
 * that's the same material, else starts one there. Returns the new count.
 * (No room — a full column, a shut level — and it's lost: rare.)
 */
fn landAt(arr: ptr<function, array<vec4<u32>, MAX_K>>, n: u32, cap: u32, p: vec2<i32>, t: u32, amt: f32, mat: u32) -> u32 {
  var ceil = 1e9;
  var fl = 0.0;
  if (t > 0u && t <= PROJ_K) {
    let v = projAt(p, t - 1u);
    if (!ivEmpty(v)) { ceil = ivZ0(v); }
  }
  if (t < PROJ_K) {
    let v = projAt(p, t);
    if (!ivEmpty(v)) { fl = ivZ1(v); }
  }
  for (var i = 0u; i < n; i++) {
    let v = (*arr)[i];
    if (ivZ0(v) < ceil) { fl = max(fl, min(ivZ1(v), ceil)); }
  }
  let add = min(amt, ceil - fl);
  if (add <= 1e-4) { return n; }
  var at = 0u;
  while (at < n && ivZ1((*arr)[at]) <= fl + 1e-3) { at += 1u; }
  if (at > 0u) {
    let v = (*arr)[at - 1u];
    // (on the same material it joins it; a trace of another on loose ground
    // blends in, as on top — no hairline strata)
    let onLoose = matState(ivMat(v)) == ST_GRANULAR;
    if (abs(ivZ1(v) - fl) < 1e-3 && (ivMat(v) == mat || (onLoose && add < 0.02))) {
      (*arr)[at - 1u] = ivPack(ivZ0(v), fl + add, ivMat(v), ivAux(v));
      return n;
    }
  }
  if (n >= cap) { return n; }
  for (var i = n; i > at; i--) { (*arr)[i] = (*arr)[i - 1u]; }
  (*arr)[at] = ivPack(fl, fl + add, mat, 0u);
  return n + 1u;
}

/** The top interval's depth on q (what the wind, water and slumping can take). */
fn topOf(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  let t = textureLoad(driftTex, q, 0);
  return clamp(t.y, 0.0, t.x);
}

// ground shaken (layerpull.wgsl): x the tick, y how hard
@group(0) @binding(30) var shakeTex: texture_2d<f32>;
// a shake lasts this long (ticks), and at its hardest lowers the repose by this share
const SHAKE_TICKS: f32 = 150.0;
const SHAKE_SLIP: f32 = 0.6;

/** The steepest slope q's top material holds (cells per cell), lower when wet, and while the ground there is shaken. */
fn reposeAt(q: vec2<i32>, m: u32) -> f32 {
  let rep = mix(MATS[m].sim.y, MATS[m].sim.z, smoothstep(0.35, 0.8, moisture[colIdxI(q)]));
  let sh = textureLoad(shakeTex, q, 0);
  let age = f32(G.tick) - sh.x;
  let fade = select(0.0, 1.0 - age / SHAKE_TICKS, sh.y > 0.0 && age >= 0.0 && age < SHAKE_TICKS);
  return rep * (1.0 - SHAKE_SLIP * sh.y * fade);
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

/**
 * 0..1 how sheltered q is from the wind w by taller ground up to 4 cells
 * upwind — at q's own height: a structure's solid there shelters it, the air
 * under an overhang or through a doorway doesn't.
 */
fn shelter(q: vec2<i32>, w: vec2<f32>) -> f32 {
  let ws = length(w);
  if (ws < 1e-3) { return 0.0; }
  let up = -w / ws;
  let here = hereAt(q);
  var s = 0.0;
  for (var k = 1; k <= 4; k++) {
    let u = cellAt(cellPos(q) + up * f32(k));
    if (!inMap(u)) { break; }
    s = max(s, (seenAt(u, here) - here) / f32(k));
  }
  return clamp(s * 0.9, 0.0, 1.0);
}

// how far upwind, at a run's own height, the open air is looked for
const FETCH: i32 = 16;

/**
 * Is q (with a structure over it) closed in from the wind w? Upwind at q's
 * height, the wind has to come from the open: a column with nothing over it
 * (out past an overhang's edge, through a doorway) before it meets a solid
 * (a wall, high ground). Inside a room, or in a pile under a hole in its
 * roof, it doesn't — it is still air; along the line of a doorway it is not.
 * (The wind field itself doesn't see structures yet: this stands in for the
 * shelter they give.)
 */
fn enclosed(q: vec2<i32>, w: vec2<f32>) -> bool {
  let ws = length(w);
  if (ws < 1e-3) { return true; }
  let up = -w / ws;
  let here = hereAt(q);
  for (var k = 1; k <= FETCH; k++) {
    let u = cellAt(cellPos(q) + up * f32(k));
    if (!inMap(u) || !hasProj(u)) { return false; }
    if (seenAt(u, here) >= here + 1.5) { return true; }
  }
  return true;
}

/** What the wind sends from q's top layer to each neighbour this pass. */
fn windOut(q: vec2<i32>) -> Dirs {
  if (!inMap(q)) { return dZero(); }
  let j = colIdxI(q);
  let top = topOf(q);
  // (under a structure too — through its doorways, under its overhangs —
  // just not inside a solid)
  if (top < 0.001 || water[j] > 0.05 || held(q) > 0.5 || runLevel(q) == SHUT) { return dZero(); }
  let m = driftMatAt(q);
  // on the title diorama (fine scale, G.misc.w) a cell is about a centimetre:
  // a breath of wind moves dust there, so the player can blow the dust off
  // the buried level models (round 13 F11)
  let fine = G.misc.w > 0.5;
  let lift = MATS[m].loose.x * select(1.0, 0.45, fine);
  if (lift >= NEVER) { return dZero(); }
  let carry = CARRY * select(1.0, 4.8, fine);
  let here = hereAt(q);
  let w = windAt(vec3<f32>(cellPos(q), here + 0.5));
  if (hasProj(q) && enclosed(q, w)) { return dZero(); }
  let ws = length(w) * (1.0 - shelter(q, w));
  if (ws < lift) { return dZero(); }
  var wt = dSplit(w);
  // it can't be pushed up into a wall: it banks against it instead
  for (var k = 0u; k < NDIR; k++) {
    let n = nbr(q, k);
    if (inMap(n) && seenAt(n, here) >= here + 1.5) { wt[k] = 0.0; }
  }
  let sum = dSum(wt);
  if (sum < 1e-4) { return dZero(); }
  // (at most a quarter of the top per pass: larger steps made neighbouring
  // columns over-correct each other into a checkerboard — round 17)
  let total = min(top * 0.25, carry * (ws - lift) * DT_D);
  return dScale(wt, total / sum);
}

/** What moving water carries from q's top layer downstream this pass. */
fn waterOut(q: vec2<i32>) -> Dirs {
  if (!inMap(q)) { return dZero(); }
  let j = colIdxI(q);
  let top = topOf(q);
  if (top < 0.001 || water[j] < 0.02 || underBody(q)) { return dZero(); }
  let m = driftMatAt(q);
  let v = netFlow(q);
  let sp = length(v);
  let thr = MATS[m].loose.w;
  if (sp < thr) { return dZero(); }
  let mob = MATS[m].loose.z * (1.0 - 0.8 * held(q));
  let total = min(top * 0.2, (sp - thr) * 1.5 * mob * DT_D * 30.0);
  let wt = dSplit(v);
  let sum = dSum(wt);
  if (sum < 1e-6) { return dZero(); }
  return dScale(wt, total / sum);
}

/** Water held back by q's loose top pushes it toward the low side (piping). */
fn pipeOut(q: vec2<i32>) -> Dirs {
  if (!inMap(q)) { return dZero(); }
  let top = topOf(q);
  if (top < 0.001 || underBody(q)) { return dZero(); }
  let h = levelAt(q);
  var hi = -1.0;
  var lo = 1e9;
  var loDir = 0u;
  for (var k = 0u; k < NDIR; k++) {
    let n = nbr(q, k);
    if (!inMap(n)) { continue; }
    let j = colIdxI(n);
    let lvl = levelAt(n) + water[j];
    if (water[j] > 0.05) { hi = max(hi, lvl); }
    if (lvl < lo) { lo = lvl; loDir = k; }
  }
  // only when the water actually presses against this column's loose top
  if (!(hi > h - 4.0 && hi - lo > PIPE_HEAD && lo < h)) { return dZero(); }
  let m = driftMatAt(q);
  var o = dZero();
  o[loDir] = min(top * 0.25, (hi - lo - PIPE_HEAD) * PIPE_RATE * (1.0 - MATS[m].sim.w * 0.5));
  return o;
}

/** Is the wind strong enough to move q's top material right now? */
fn windActive(q: vec2<i32>) -> bool {
  let j = colIdxI(q);
  if (water[j] > 0.05) { return false; }
  let lift = MATS[driftMatAt(q)].loose.x * select(1.0, 0.45, G.misc.w > 0.5);
  if (lift >= NEVER) { return false; }
  let w = windAt(vec3<f32>(cellPos(q), hereAt(q) + 0.5));
  // (as windOut feels it: sheltered ground isn't worked — inside a room
  // under a hole in its roof, the wind outside spread a pile over the floor)
  if (hasProj(q) && enclosed(q, w)) { return false; }
  return length(w) * (1.0 - shelter(q, w)) > lift;
}

/** What slides off q's top layer to each neighbour this pass (steeper than its repose; eased where the wind works). */
fn slumpOut(q: vec2<i32>) -> Dirs {
  if (!inMap(q)) { return dZero(); }
  let top = topOf(q);
  // (under a structure too, inside it: just not inside a solid)
  if (top < 0.001 || runLevel(q) == SHUT) { return dZero(); }
  let here = hereAt(q);
  let rep = reposeAt(q, driftMatAt(q));
  let hd = held(q);
  var o = dZero();
  for (var k = 0u; k < NDIR; k++) {
    let n = nbr(q, k);
    if (!inMap(n)) { continue; }
    let diff = here - seenAt(n, here);
    // roots hold a slope at most HOLD_STEEP steeper than the repose: in rain
    // the arrivals alternate (mud, dust from the air), so the top interval
    // stays thin and held() never lets go — planted columns grew into
    // spikes 8+ cells over their neighbours (round 30)
    let hk = hd * (1.0 - smoothstep(rep, rep + HOLD_STEEP, diff));
    o[k] = max(diff - rep, 0.0) * SLUMP * (1.0 - hk);
  }
  let s = dSum(o);
  if (s > top * 0.8) { o = dScale(o, top * 0.8 / s); }
  return o;
}

/** The easing where the wind works: what q's top gives each lower neighbour (it blends in there). */
fn smoothOut(q: vec2<i32>) -> Dirs {
  if (!inMap(q)) { return dZero(); }
  let top = topOf(q);
  if (top < 0.001 || runLevel(q) == SHUT) { return dZero(); }
  if (!(textureLoad(driftTex, q, 0).w > 0.0 || windActive(q))) { return dZero(); }
  let here = hereAt(q);
  var o = dZero();
  for (var k = 0u; k < NDIR; k++) {
    let n = nbr(q, k);
    if (!inMap(n)) { continue; }
    o[k] = max(here - seenAt(n, here), 0.0) * WIND_SMOOTH * (1.0 - held(q));
  }
  let s = dSum(o);
  if (s > top * 0.6) { o = dScale(o, top * 0.6 / s); }
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


// ---- spilling out of exposed faces (round 22) ------------------------------------
// Loose ground buried under something (sand under a cap rock, soil under a
// slab) with air beside it in a neighbouring column runs out into that air:
// it lands on the neighbour's floor there, and keeps going until the face
// stands at its angle of repose. What lies on top doesn't hold it, so the
// sand under a rock shelf is undercut and leaves a pocket of air beneath it;
// the structure pass then sees the shelf's support go. Only intervals
// beneath the loose run on top spill this way (the run slumps by levels).
struct Spill {
  amt: Dirs,
  z: Dirs,
  mat: Dirs,
  src: Dirs,
  // (round 50: the top of the face it runs out of, for the particles)
  top: Dirs,
};

fn spillOut(p: vec2<i32>) -> Spill {
  var sp: Spill;
  if (!sfBuried(surface[colIdxI(p)])) { return sp; }
  let cs = colSlots(u32(p.x), u32(p.y));
  var n = 0u;
  for (var k = 0u; k < cs.y; k++) {
    if (ivEmpty(layers[cs.x + k])) { break; }
    n = k + 1u;
  }
  // the loose run on top (it slumps by levels instead)
  var r = n;
  while (r > 0u) {
    let v = layers[cs.x + r - 1u];
    if (matState(ivMat(v)) != ST_GRANULAR) { break; }
    if (r < n && abs(ivZ1(v) - ivZ0(layers[cs.x + r])) > 1e-3) { break; }
    r -= 1u;
  }
  for (var si = 0u; si < r; si++) {
    let v = layers[cs.x + si];
    let m = ivMat(v);
    if (matState(m) != ST_GRANULAR) { continue; }
    let a = ivZ0(v);
    let b = ivZ1(v);
    let rep = reposeAt(p, m);
    for (var k = 0u; k < NDIR; k++) {
      let q = nbr(p, k);
      if (!inMap(q)) { continue; }
      // (a neighbour as high as this interval's top with no air inside it
      // has no face here: most of them — skip reading its intervals)
      if (!sfGap(surface[colIdxI(q)]) && baseAt(q) + driftAt(q) >= b) { continue; }
      let qs = colSlots(u32(q.x), u32(q.y));
      // the lowest air gap in q beside [a, b) that has a floor under it
      var g0 = -1.0;
      var g1 = 0.0;
      var fl = IV_NONE;
      var qn = 0u;
      var prev = IV_NONE;
      for (var t = 0u; t < qs.y; t++) {
        let u = layers[qs.x + t];
        if (ivEmpty(u)) { break; }
        qn = t + 1u;
        if (g0 < 0.0 && t > 0u && ivZ0(u) > ivZ1(prev) + 1e-3 && ivZ0(u) > a && ivZ1(prev) < b) {
          g0 = ivZ1(prev);
          g1 = ivZ0(u);
          fl = prev;
        }
        prev = u;
      }
      // (or the open air over its top)
      if (g0 < 0.0 && qn > 0u && ivZ1(prev) < b) { g0 = ivZ1(prev); g1 = 1e9; fl = prev; }
      if (g0 < 0.0) { continue; }
      let drop = min(b, g1) - g0;
      if (drop <= rep) { continue; }
      // it needs a slot there, unless it joins the floor
      let joins = ivMat(fl) == m;
      if (qn >= qs.y && !joins) { continue; }
      var amt = min((drop - rep) * FACE, (b - a) * 0.25);
      if (g1 < 1e8) { amt = min(amt, (g1 - g0) * 0.5); }
      if (amt > sp.amt[k]) {
        sp.amt[k] = amt;
        sp.z[k] = g0;
        sp.mat[k] = f32(m);
        sp.src[k] = f32(si);
        sp.top[k] = min(b, g1);
      }
    }
  }
  return sp;
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
  let lost = dSum(o);
  // (what the wind lifts partly goes up into the air: the particles carry it
  // — not under a structure, where it would come down on the roof)
  let air = select(0.0, MATS[mat].loose.y, runLevel(p) == SKY);
  let send = dAdd(dAdd(dScale(o, 1.0 - air), ow), dAdd(so, po));
  let out = lost + dSum(ow) + dSum(so) + dSum(sm) + dSum(po);
  sedOut[i * SED] = send;
  sedOut[i * SED + 1u] = sm;
  let sp = spillOut(p);
  var own = dZero();
  own[0] = lost * air;
  own[1] = out;
  // the flow the particles show (round 50): what slides or spills off this
  // column this pass, its main way, how far it drops there, its material
  var fk = 0u;
  var fa = 0.0;
  var fm = mat;
  for (var k = 0u; k < NDIR; k++) {
    if (so[k] > fa) { fa = so[k]; fk = k; fm = mat; }
    if (sp.amt[k] > fa) { fa = sp.amt[k]; fk = k; fm = u32(sp.mat[k] + 0.5); }
  }
  own[2] = dSum(so) + dSum(sp.amt);
  if (own[2] > 0.0) {
    // (where it starts: the top of the run, or of the face it spills from)
    own[3] = select(hereAt(p), sp.top[fk], sp.amt[fk] > so[fk]);
    own[4] = f32(fk) + 8.0 * f32(fm);
  }
  sedOut[i * SED + 2u] = own;
  sedOut[i * SED + 3u] = sp.amt;
  // (the rest is only read where there's a spill)
  if (dAny(sp.amt)) {
    sedOut[i * SED + 4u] = sp.z;
    sedOut[i * SED + 5u] = sp.mat;
    sedOut[i * SED + 6u] = sp.src;
  }
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
  let own = sedOut[i * SED + 2u];
  // what the wind sent up into the air (the particles take it from here)
  // (y z w: the flow the particles show — amount, where it starts, way + 8 × material; way 6: falling)
  textureStore(airOut, p, vec4<f32>(own[0], own[2], own[3], own[4]));
  let here = levelAt(p);
  // under a structure, the level my run lies in; what arrives in another
  // level (sideways at its height, or from the sky over a structure's top)
  // lands on that level's floor instead (landAt), by level: the largest
  // arrival's material
  let proj = hasProj(p);
  let myL = runLevel(p);
  var lvAmt = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  var lvMat = array<u32, 4>(0u, 0u, 0u, 0u);
  var lvMax = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  var lvAny = false;
  // what arrives, by material: the same as my top joins it; the largest
  // other arrival starts a new layer (and takes the rest with it)
  var same = 0.0;
  var other = 0.0;
  var otherMat = m0;
  var otherMax = 0.0;
  var dust = 0.0;
  for (var k = 0u; k < NDIR; k++) {
    let nb = nbr(p, k);
    if (!inMap(nb)) { continue; }
    let j = colIdxI(nb);
    let mn = driftMatAt(nb);
    let a = sedOut[j * SED][k ^ 1u];
    let e = sedOut[j * SED + 1u][k ^ 1u];
    if (proj && a + e > 0.0) {
      let t = openAt(p, hereAt(nb)).j;
      if (t != myL) {
        lvAmt[t] += a + e;
        if (a + e > lvMax[t]) { lvMax[t] = a + e; lvMat[t] = mn; }
        lvAny = true;
        continue;
      }
    }
    // (the wind's easing just blends into my top, whatever it is)
    same += e;
    if (mn == m0) { same += a; } else {
      other += a;
      if (a > otherMax) { otherMax = a; otherMat = mn; }
    }
  }
  // dust storms drop dust where the wind is broken (sheltered spots, hollows)
  for (var k = 0u; k < 2u; k++) {
    let ds = G.dusts[k];
    if (ds.w <= 0.0) { continue; }
    let rr = length(cellPos(p) - ds.xy) / ds.z;
    if (rr > 1.2) { continue; }
    let w = windAt(vec3<f32>(cellPos(p), here + 0.5));
    dust += ds.w / 8.0 * smoothstep(1.2, 0.4, rr) * 0.06 * DT_D * (0.15 + 0.85 * shelter(p, w));
  }
  // a dying cyclone drops the dust it carried in a pile around its eye
  for (var c = 0u; c < MAX_CYCLONES; c++) {
    if (G.cyclones[c].b.z <= 0.0) { continue; }
    let rr = length(cellPos(p) - G.cyclones[c].a.xy) / G.cyclones[c].a.z;
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
  var depY = dep.y;
  // under a structure, what comes from the sky lands on its top
  if (myL != SKY) {
    let fromSky = array<f32, 3>(dust, pour, depY);
    let skyMat = array<u32, 3>(MAT_DRIFT, pourMat, u32(dep.z + 0.5));
    for (var k = 0u; k < 3u; k++) {
      if (fromSky[k] <= 0.0) { continue; }
      lvAmt[SKY] += fromSky[k];
      if (fromSky[k] > lvMax[SKY]) { lvMax[SKY] = fromSky[k]; lvMat[SKY] = skyMat[k]; }
      lvAny = true;
    }
    dust = 0.0;
    pour = 0.0;
    depY = 0.0;
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
  // spills out of exposed faces: mine, and my neighbours' landing here
  let mySpill = sedOut[i * SED + 3u];
  var inSpill = 0.0;
  for (var k = 0u; k < NDIR; k++) {
    let nb = nbr(p, k);
    if (inMap(nb)) { inSpill += sedOut[colIdxI(nb) * SED + 3u][k ^ 1u]; }
  }
  let spills = dSum(mySpill) > 0.0 || inSpill > 0.0;
  let moves = own[1] > 0.0 || same > 0.0 || other > 0.0 || pour > 0.0 || depY > 0.0 || delta < 0.0 || strip > 0u || bind || spills || lvAny;
  if (!moves && !hangs) { return; }

  var arr: array<vec4<u32>, MAX_K>;
  for (var k = 0u; k < n; k++) { arr[k] = layers[cs.x + k]; }
  if (spills) {
    // (floors are found by their height before anything ran out of them)
    var z1o: array<f32, MAX_K>;
    for (var k = 0u; k < n; k++) { z1o[k] = ivZ1(arr[k]); }
    // what runs out of my faces leaves the top of its interval
    let src = sedOut[i * SED + 6u];
    for (var k = 0u; k < NDIR; k++) {
      if (mySpill[k] <= 0.0) { continue; }
      let si = u32(src[k]);
      let v = arr[si];
      arr[si] = ivPack(ivZ0(v), max(ivZ1(v) - mySpill[k], ivZ0(v)), ivMat(v), ivAux(v));
    }
    // what runs in lands on my floor at that height
    for (var k = 0u; k < NDIR; k++) {
      let nb = nbr(p, k);
      if (!inMap(nb)) { continue; }
      let j = colIdxI(nb);
      let amt = sedOut[j * SED + 3u][k ^ 1u];
      if (amt <= 0.0) { continue; }
      let fz = sedOut[j * SED + 4u][k ^ 1u];
      let fm = u32(sedOut[j * SED + 5u][k ^ 1u] + 0.5);
      for (var f = 0u; f < n; f++) {
        if (abs(z1o[f] - fz) > 1e-3) { continue; }
        let v = arr[f];
        // (the gap above the floor: up to the next interval, if any)
        var room = 1e9;
        if (f + 1u < n) { room = ivZ0(arr[f + 1u]) - fz; }
        let add = min(amt, room);
        if (ivMat(v) == fm) {
          arr[f] = ivPack(ivZ0(v), ivZ1(v) + add, fm, ivAux(v));
        } else if (n < cs.y) {
          for (var t = n; t > f + 1u; t--) { arr[t] = arr[t - 1u]; z1o[t] = z1o[t - 1u]; }
          // (on the floor as it is now: something may have run out of it)
          let fz1 = ivZ1(v);
          arr[f + 1u] = ivPack(fz1, fz1 + add, fm, 0u);
          z1o[f + 1u] = -1.0;
          n += 1u;
        }
        break;
      }
    }
    // spent intervals go; touching loose intervals of one material join
    var w = 0u;
    for (var k = 0u; k < n; k++) {
      let v = arr[k];
      if (ivZ1(v) - ivZ0(v) <= 1e-4) { continue; }
      if (w > 0u) {
        let u = arr[w - 1u];
        if (ivMat(u) == ivMat(v) && matState(ivMat(v)) == ST_GRANULAR && abs(ivZ1(u) - ivZ0(v)) < 1e-3) {
          arr[w - 1u] = ivPack(ivZ0(u), ivZ1(v), ivMat(v), 0u);
          continue;
        }
      }
      arr[w] = v;
      w += 1u;
    }
    for (var k = w; k < n; k++) { arr[k] = IV_NONE; }
    n = w;
    hangs = true;
  }
  // granular intervals with air under them fall (rubble a collapse left
  // hanging, sand whose support was dug away) — onto the highest projected
  // interval beneath them (a structure's floor, its top, a body)
  if (hangs) {
    floorZ = 0.0;
    for (var k = 0u; k < n; k++) {
      let v = arr[k];
      var z0 = ivZ0(v);
      var z1 = ivZ1(v);
      var fl = floorZ;
      if (proj) {
        for (var pk = 0u; pk < PROJ_K; pk++) {
          let u = projAt(p, pk);
          if (ivEmpty(u)) { break; }
          // (one it starts inside holds it too: a body nudged up into its sand)
          if (ivZ1(u) > fl && z0 >= ivZ0(u)) { fl = min(ivZ1(u), z0); }
        }
      }
      if (matState(ivMat(v)) == ST_GRANULAR && z0 > fl + 1e-4) {
        let f = min(FALL, z0 - fl);
        // (it streams down as grains: the particles show the fall)
        if (z1 - z0 > 0.05) { textureStore(airOut, p, vec4<f32>(own[0], min(z1 - z0, 2.0) * 0.1, z0, 6.0 + 8.0 * f32(ivMat(v)))); }
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
  var base = 0.0;
  if (n > 0u) { base = ivZ1(arr[n - 1u]); }
  if (r < n) { base = ivZ0(arr[r]); }
  var s: Stack;
  s.n = 0u;
  s.cap = max(cs.y - r, 1u);
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
    s.d[s.n - 1u] = max(s.d[s.n - 1u] - own[1], 0.0);
  }
  // (a column already full of other intervals has no room for loose ground:
  // what would land there is lost — rare; the chunk table gives ruins room)
  if (room) {
    if (s.n > 0u) { s.d[s.n - 1u] += same; } else { addTop(&s, same, m0); }
    addTop(&s, pour, pourMat);
    if (depY > 0.0) { addTop(&s, depY, u32(dep.z + 0.5)); }
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
  var n1 = w;
  // what came into other levels lands on their floors
  if (lvAny) {
    for (var t = 0u; t < 4u; t++) {
      if (lvAmt[t] > 0.0) { n1 = landAt(&arr, n1, cs.y, p, t, lvAmt[t], lvMat[t]); }
    }
  }
  for (var k = 0u; k < max(n, n1); k++) { layers[cs.x + k] = select(IV_NONE, arr[k], k < n1); }
}
