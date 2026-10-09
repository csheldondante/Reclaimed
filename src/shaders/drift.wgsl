// ---- the loose layer: dust, sand, ash, dirt lying on the land ----------------
// (round 11 drifts, generalised in round 15 — BACKLOG H3: "loose surfaces
// should behave like dust, with a steeper angle of repose and needing higher
// winds"). drift (texture): .x depth of loose material on top of each column
// in cells (fractional), .y what the wind took this pass (particles stream
// it), .z the material (0 = dust), .w what went up into the air this pass (the
// particle system carries it off as dust grains and drops it where they land,
// so what you see blowing is what settles and piles up again). Below it the
// ground stays whole cells.
// Each material has its own wind threshold, repose and share that goes
// airborne (looseOf): dust moves in a gust, sand and ash in strong wind, dirt
// and gravel only with water. Above its threshold a cell sends material
// downwind (split over the four faces by the wind's components); sheltered
// cells — behind taller ground upwind — feel less wind, so it piles up in
// their lee; it can't be pushed up into a wall, so it banks on the windward
// side too; what goes airborne lands HOP cells downwind. Steep slopes slump
// to the material's angle of repose. It lies under still water (the liquids
// sit on top of it) and moving water carries it downstream. Material blown
// off the map edge is gone. Plants under deep dust/sand/ash lie dormant
// (wilt/ecology) and come back when it's uncovered; established plants hold
// what they grow through and turn dust to soil.
// Race-free gather: every cell recomputes its neighbours' outflow from the
// same read-only inputs, so what leaves one cell arrives in the next. A cell
// keeps its material unless almost all of it left and something else came
// in (then it takes the material of the largest inflow).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
// dust added or removed by the editor (edit.wgsl), folded in and zeroed here
@group(0) @binding(5) var<storage, read_write> driftDelta: array<f32>;
// water flux (flow.wgsl netFlow): moving water carries the layer downstream
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
// plants: established green holds the layer it grows through (round 15)
@group(0) @binding(7) var<storage, read> vegD: array<f32>;
/** 0..1 how firmly the plants on column j hold its loose layer */
fn rooted(j: u32) -> f32 { return smoothstep(1.2, 2.0, vegD[j]); }
// dust under established plants turns to soil, cells/s (the drift thins;
// the plants grow on in the ground beneath)
const BIND: f32 = 0.03;
// dust that came down here from the air (particles.wgsl), the second half of
// the exchange buffer, ×1e5
@group(0) @binding(8) var<storage, read_write> exchange: array<atomic<i32>>;
@group(0) @binding(16) var driftOut: texture_storage_2d<rgba32float, write>;
// driftTex (binding 17) is declared in common.wgsl (driftAt, driftMatAt)

const DT_D: f32 = 2.0 / 60.0; // the system runs every other tick
const CARRY: f32 = 0.25;      // cells of depth lifted per second per cell/s over the threshold
const SLUMP: f32 = 0.08;
const NEVER: f32 = 1e9;
const MAT_SOIL_L: u32 = 2u;
const MAT_SAND_L: u32 = 3u;
const MAT_GRAVEL_L: u32 = 4u;
const MAT_ASH_L: u32 = 17u;

/**
 * How a loose material behaves: x wind (cells/s, sheltered) needed to move
 * it, y steepest slope it holds (cells per cell), z share of what the wind
 * lifts that goes airborne, w how readily moving water carries it.
 */
fn looseOf(m: u32) -> vec4<f32> {
  if (m == MAT_SAND_L) { return vec4<f32>(14.0, 1.0, 0.15, 1.0); }
  if (m == MAT_ASH_L) { return vec4<f32>(10.0, 0.9, 0.5, 1.0); }
  if (m == MAT_SOIL_L) { return vec4<f32>(NEVER, 1.4, 0.0, 0.8); }
  if (m == MAT_GRAVEL_L) { return vec4<f32>(NEVER, 1.7, 0.0, 0.25); }
  return vec4<f32>(9.0, 0.8, 0.4, 1.0); // dust
}

fn levelAt(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  return f32(sfZ(surface[colIdxI(q)])) + driftAt(q);
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

// A dust film can lie on top of any loose layer (round 15: dust blown onto
// sand or dirt settles on it and shows, instead of turning into sand): drift
// .y is the film's depth (part of .x, the total). The wind takes the film
// first, at dust's threshold; only bare loose ground moves at its own.

/** Depth of the dust film on q (≤ the total). */
fn filmOf(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return 0.0; }
  let t = textureLoad(driftTex, q, 0);
  return clamp(t.y, 0.0, t.x);
}

/** What the wind moves on q: the dust film if there is one, else the layer itself. */
fn movingMat(q: vec2<i32>) -> u32 {
  return select(driftMatAt(q), MAT_DRIFT, filmOf(q) > 0.001);
}

/** What the wind sends from q to its +x, -x, +y, -y neighbours this pass. */
fn windOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  let d = driftAt(q);
  if (d < 0.001 || water[j] > 0.05 || rooted(j) > 0.5) { return vec4<f32>(0.0); }
  let film = filmOf(q);
  let movable = select(d, film, film > 0.001);
  let lo = looseOf(movingMat(q));
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
    if (inMap(n) && f32(sfZ(surface[colIdxI(n)])) >= here + 1.5) { wt[k] = 0.0; }
  }
  let sum = wt.x + wt.y + wt.z + wt.w;
  if (sum < 1e-4) { return vec4<f32>(0.0); }
  let total = min(movable * 0.5, carry * (ws - lift) * DT_D);
  return wt / sum * total;
}

/** What moving water carries from q to its neighbours this pass (downstream; film and layer alike). */
fn waterOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  let d = driftAt(q);
  if (d < 0.001 || water[j] < 0.05) { return vec4<f32>(0.0); }
  let v = netFlow(q);
  let sp = length(v);
  if (sp < 0.02) { return vec4<f32>(0.0); }
  let mob = looseOf(driftMatAt(q)).w * (1.0 - 0.8 * rooted(j));
  let total = min(d * 0.25, d * (sp - 0.02) * 3.0 * mob);
  let wt = vec4<f32>(max(v.x, 0.0), max(-v.x, 0.0), max(v.y, 0.0), max(-v.y, 0.0));
  let sum = wt.x + wt.y + wt.z + wt.w;
  if (sum < 1e-6) { return vec4<f32>(0.0); }
  return wt / sum * total;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let d0 = driftAt(p);
  let f0 = filmOf(p);
  let m0 = driftMatAt(p);
  var m = m0;
  var base = d0 - f0;
  var film = f0;
  // what leaves: the wind takes the film first; water takes both alike
  let o = windOut(p);
  let lost = o.x + o.y + o.z + o.w;
  let movedMat = movingMat(p);
  if (f0 > 0.001) { film -= lost; } else { base -= lost; }
  let ow = waterOut(p);
  let lw = ow.x + ow.y + ow.z + ow.w;
  let ff = f0 / max(d0, 1e-6);
  film -= lw * ff;
  base -= lw * (1.0 - ff);
  let here = levelAt(p);
  // what arrives: dust settles on the film (unless this is a dust column);
  // the same loose material joins the layer; a different one joins it too,
  // unless the layer is all but gone (then it becomes that material)
  var dustIn = 0.0;
  var otherIn = 0.0;
  var otherMat = m0;
  for (var k = 0u; k < 4u; k++) {
    let n = p + DIRS[k];
    if (!inMap(n)) { continue; }
    let mn = movingMat(n);
    let a = windOut(n)[k ^ 1u] * (1.0 - looseOf(mn).z);
    if (mn == MAT_DRIFT) { dustIn += a; } else { otherIn += a; otherMat = mn; }
    let wn = waterOut(n)[k ^ 1u];
    let fShare = filmOf(n) / max(driftAt(n), 1e-6);
    dustIn += wn * fShare;
    otherIn += wn * (1.0 - fShare);
    if (wn * (1.0 - fShare) > 0.0) { otherMat = driftMatAt(n); }
    // slumping: steep material slides down to the lower side at its own angle
    // (held by roots, it doesn't); the film slides first
    let there = levelAt(n);
    let out = min(d0 * 0.2, max(here - there - looseOf(m0).y, 0.0) * SLUMP) * (1.0 - rooted(i));
    let fromFilm = min(out, max(film, 0.0));
    film -= fromFilm;
    base -= out - fromFilm;
    let inn = min(driftAt(n) * 0.2, max(there - here - looseOf(driftMatAt(n)).y, 0.0) * SLUMP) * (1.0 - rooted(colIdxI(n)));
    let nf = filmOf(n) / max(driftAt(n), 1e-6);
    dustIn += inn * nf;
    otherIn += inn * (1.0 - nf);
    if (inn * (1.0 - nf) > 0.0) { otherMat = driftMatAt(n); }
  }
  // dust storms drop dust where the wind is broken (sheltered spots, hollows)
  for (var k = 0u; k < 2u; k++) {
    let ds = G.dusts[k];
    if (ds.w <= 0.0) { continue; }
    let r = length(vec2<f32>(p) + 0.5 - ds.xy) / ds.z;
    if (r > 1.2) { continue; }
    let w = windAt(vec3<f32>(vec2<f32>(p) + 0.5, here + 0.5));
    dustIn += ds.w / 8.0 * smoothstep(1.2, 0.4, r) * 0.06 * DT_D * (0.15 + 0.85 * shelter(p, w));
  }
  // a dying cyclone drops the dust it carried in a pile around its eye
  for (var c = 0u; c < MAX_CYCLONES; c++) {
    if (G.cyclones[c].b.z <= 0.0) { continue; }
    let r = length(vec2<f32>(p) + 0.5 - G.cyclones[c].a.xy) / G.cyclones[c].a.z;
    dustIn += smoothstep(1.6, 0.0, r) * 0.6 * DT_D;
  }
  // dust that came down from the air here (carried by particles)
  dustIn += f32(atomicExchange(&exchange[G.mapW * G.mapH + i], 0)) / 100000.0;
  // the editor: dust brushed on or cleaned off, packing, and pours of loose
  // material (edit.wgsl packs the old layer into cells first when it differs)
  let delta = driftDelta[i];
  driftDelta[i] = 0.0;
  let ed = u32(floor(textureLoad(editTex, p, 0).w / 4.0));
  if (delta != 0.0 && ed / 32u == 10u && ed % 32u != MAT_DRIFT) {
    let pm = ed % 32u;
    if (pm != m) {
      // the old layer was packed into cells (delta = the pour − the old
      // layer): what's left is the new material
      base = max(base + film + delta, 0.0);
      film = 0.0;
    } else { base += delta; }
    m = pm;
  } else if (delta > 0.0) {
    dustIn += delta;
  } else {
    // taken away (packing, clean): from the layer first, then the film
    let take = min(-delta, max(base, 0.0));
    base -= take;
    film += delta + take;
  }
  // arrivals
  if (m == MAT_DRIFT) { base += dustIn; } else { film += dustIn; }
  if (otherIn > 0.0) {
    if (base < 0.05 && otherMat != m) { m = otherMat; }
    base += otherIn;
  }
  // green binds the dust it grows through: it becomes soil
  let bind = rooted(i) * BIND * DT_D;
  let fromF = min(bind, max(film, 0.0));
  film -= fromF;
  if (m == MAT_DRIFT || m == MAT_ASH_L) { base -= bind - fromF; }
  film = max(film, 0.0);
  base = max(base, 0.0);
  // a column with nothing but dust is a dust column
  if (base < 0.001 && film > 0.0) {
    m = MAT_DRIFT;
    base = film;
    film = 0.0;
  }
  if (m == MAT_DRIFT) {
    base += film;
    film = 0.0;
  }
  // what this cell's wind sent up into the air (the particles take it from here)
  let air = lost * looseOf(movedMat).z;
  textureStore(driftOut, p, vec4<f32>(base + film, film, f32(m), air));
}
