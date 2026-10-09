// ---- the loose layer: dust, sand, ash, dirt lying on the land ----------------
// (round 11 drifts, generalised in round 15 — BACKLOG H3: "loose surfaces
// should behave like dust, with a steeper angle of repose and needing higher
// winds"). drift (texture): .x depth of loose material on top of each column
// in cells (fractional), .y what the wind took this pass (particles stream
// it), .z the material (0 = dust). Below it the ground stays whole cells.
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
@group(0) @binding(16) var driftOut: texture_storage_2d<rgba32float, write>;
// driftTex (binding 17) is declared in common.wgsl (driftAt, driftMatAt)

const DT_D: f32 = 2.0 / 60.0; // the system runs every other tick
const CARRY: f32 = 0.25;      // cells of depth lifted per second per cell/s over the threshold
const HOP: f32 = 5.0;         // cells downwind the airborne share comes down
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

/** Where material lifted off q comes down (q + HOP along its wind), or (-1, -1). */
fn landing(q: vec2<i32>) -> vec2<i32> {
  let w = windAt(vec3<f32>(vec2<f32>(q) + 0.5, levelAt(q) + 0.5));
  if (length(w) < 0.5) { return vec2<i32>(-1); }
  return vec2<i32>(floor(vec2<f32>(q) + 0.5 + normalize(w) * HOP));
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

/** What the wind sends from q to its +x, -x, +y, -y neighbours this pass. */
fn windOut(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  let d = driftAt(q);
  if (d < 0.001 || water[j] > 0.05 || rooted(j) > 0.5) { return vec4<f32>(0.0); }
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
    if (inMap(n) && f32(sfZ(surface[colIdxI(n)])) >= here + 1.5) { wt[k] = 0.0; }
  }
  let sum = wt.x + wt.y + wt.z + wt.w;
  if (sum < 1e-4) { return vec4<f32>(0.0); }
  let total = min(d * 0.5, carry * (ws - lift) * DT_D);
  return wt / sum * total;
}

/** What moving water carries from q to its neighbours this pass (downstream). */
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
  let m0 = driftMatAt(p);
  let lo0 = looseOf(m0);
  var d = d0;
  let o = windOut(p);
  let lost = o.x + o.y + o.z + o.w;
  let ow = waterOut(p);
  d -= lost + ow.x + ow.y + ow.z + ow.w;
  let here = levelAt(p);
  // the largest inflow decides the material if little of my own is left
  var bestIn = 0.0;
  var bestMat = m0;
  for (var k = 0u; k < 4u; k++) {
    let n = p + DIRS[k];
    if (!inMap(n)) { continue; }
    let mn = driftMatAt(n);
    let lon = looseOf(mn);
    // carried in by the neighbour's wind (what stays low) and its water
    var a = windOut(n)[k ^ 1u] * (1.0 - lon.z) + waterOut(n)[k ^ 1u];
    // slumping: steep material slides down to the lower side (at its own angle;
    // material held by roots doesn't slide)
    let there = levelAt(n);
    d -= min(d0 * 0.2, max(here - there - lo0.y, 0.0) * SLUMP) * (1.0 - rooted(i));
    a += min(driftAt(n) * 0.2, max(there - here - lon.y, 0.0) * SLUMP) * (1.0 - rooted(colIdxI(n)));
    d += a;
    if (a > bestIn) { bestIn = a; bestMat = mn; }
  }
  // dust storms carry dust: as they pass they drop it where the wind is
  // broken (sheltered spots, hollows), so they rearrange drifts rather than
  // only wearing them away
  var dustIn = 0.0;
  for (var k = 0u; k < 2u; k++) {
    let ds = G.dusts[k];
    if (ds.w <= 0.0) { continue; }
    let r = length(vec2<f32>(p) + 0.5 - ds.xy) / ds.z;
    if (r > 1.2) { continue; }
    let w = windAt(vec3<f32>(vec2<f32>(p) + 0.5, here + 0.5));
    let sh = shelter(p, w);
    dustIn += ds.w / 8.0 * smoothstep(1.2, 0.4, r) * 0.06 * DT_D * (0.15 + 0.85 * sh);
  }
  // a dying cyclone drops the dust it carried in a pile around its eye
  for (var c = 0u; c < MAX_CYCLONES; c++) {
    if (G.cyclones[c].b.z <= 0.0) { continue; }
    let r = length(vec2<f32>(p) + 0.5 - G.cyclones[c].a.xy) / G.cyclones[c].a.z;
    dustIn += smoothstep(1.6, 0.0, r) * 0.6 * DT_D;
  }
  // the editor's brush: dust, or whatever loose material is being poured here
  // (edit.wgsl packs the old layer into cells first when it differs)
  let delta = driftDelta[i];
  driftDelta[i] = 0.0;
  d += dustIn + delta;
  if (dustIn > bestIn) { bestIn = dustIn; bestMat = MAT_DRIFT; }
  let ed = u32(floor(textureLoad(editTex, p, 0).w / 4.0));
  var poured = false;
  if (delta > 0.0 && ed / 32u == 10u) {
    bestMat = ed % 32u;
    bestIn = 1e9;
    poured = true;
  } else if (delta > bestIn) { bestIn = delta; bestMat = MAT_DRIFT; }
  // airborne material coming down here: from the cells around the spot HOP
  // upwind (along my own wind) whose lifted share lands on me (round 15:
  // it used to vanish; now it settles and piles up again)
  let wp = windAt(vec3<f32>(vec2<f32>(p) + 0.5, here + 0.5));
  if (length(wp) > 0.5) {
    let q0 = vec2<i32>(floor(vec2<f32>(p) + 0.5 - normalize(wp) * HOP));
    for (var k = 0; k < 9; k++) {
      let q = q0 + vec2<i32>(k % 3 - 1, k / 3 - 1);
      if (inMap(q) && driftAt(q) > 0.001 && all(landing(q) == p)) {
        let oq = windOut(q);
        let mq = driftMatAt(q);
        let a = (oq.x + oq.y + oq.z + oq.w) * looseOf(mq).z;
        d += a;
        if (a > bestIn) { bestIn = a; bestMat = mq; }
      }
    }
  }
  // green binds dust (and ash, sand) it grows through: it becomes soil
  if (m0 != MAT_SOIL_L) { d -= rooted(i) * BIND * DT_D; }
  // what is left of my own is the material, unless almost nothing is
  let own = d0 - lost - ow.x - ow.y - ow.z - ow.w;
  var m = m0;
  if ((own < 0.05 || poured) && bestIn > 0.0) { m = bestMat; }
  textureStore(driftOut, p, vec4<f32>(max(d, 0.0), lost, f32(m), 0.0));
}
