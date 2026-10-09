// ---- drifts: loose dust lying on the land (round 11, BACKLOG C1) -------------
// drift (texture, .x) = depth of loose dust on top of each column, in cells
// (fractional). The wind carries it: above a threshold, a cell sends dust
// downwind (split over the four faces by the wind's components), sheltered
// cells — behind taller ground upwind — feel less wind, so dust piles up in
// their lee; it can't be pushed up into a wall, so it banks on the windward
// side too. Steep dust slumps to an angle of repose; dust sinks under water
// (the liquids lie on top of it) and moving water scours it away;
// dust blown off the map edge is gone. Plants under deep dust lie dormant
// (wilt/ecology) and come back when the wind uncovers them.
// Race-free gather: every cell recomputes its neighbours' outflow from the
// same read-only inputs, so what leaves one cell arrives in the next.
// .y = dust this cell lost to the wind this pass (particles show it streaming).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
// dust added or removed by the editor (edit.wgsl), folded in and zeroed here
@group(0) @binding(5) var<storage, read_write> driftDelta: array<f32>;
// water flux (flow.wgsl netFlow): moving water scours dust, still water lets it settle
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
@group(0) @binding(16) var driftOut: texture_storage_2d<rgba32float, write>;
// driftTex (binding 17) is declared in common.wgsl (driftAt)

const DT_D: f32 = 2.0 / 60.0; // the system runs every other tick
const LIFT: f32 = 9.0;        // cells/s of (sheltered) wind before dust moves: a gust, not a breeze
const CARRY: f32 = 0.25;      // cells of depth lifted per second per cell/s over LIFT
// share of what the wind lifts that goes up into the air (shown as dust
// particles) instead of landing in the next cell — strong wind wears drifts down
const AIRBORNE: f32 = 0.4;
const REPOSE: f32 = 0.8;      // steepest dust slope (cells per cell)
const SLUMP: f32 = 0.08;

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

/** Dust q sends to its +x, -x, +y, -y neighbours this pass. */
fn outflow(q: vec2<i32>) -> vec4<f32> {
  if (!inMap(q)) { return vec4<f32>(0.0); }
  let j = colIdxI(q);
  let d = driftAt(q);
  if (d < 0.001 || water[j] > 0.05) { return vec4<f32>(0.0); }
  let here = levelAt(q);
  let w = windAt(vec3<f32>(vec2<f32>(q) + 0.5, here + 0.5));
  let ws = length(w) * (1.0 - shelter(q, w));
  // on the title diorama (fine scale, G.misc.w) a cell is about a centimetre:
  // a breath of wind moves dust there, so the player can blow the dust off
  // the buried level models (round 13 F11)
  let fine = G.misc.w > 0.5;
  let lift = select(LIFT, 4.0, fine);
  let carry = select(CARRY, 1.2, fine);
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

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  var d = driftAt(p);
  let o = outflow(p);
  let lost = o.x + o.y + o.z + o.w;
  d -= lost;
  let here = levelAt(p);
  let d0 = driftAt(p);
  for (var k = 0u; k < 4u; k++) {
    let n = p + DIRS[k];
    // carried in from the neighbour whose wind sends it my way
    d += outflow(n)[k ^ 1u] * (1.0 - AIRBORNE);
    if (!inMap(n)) { continue; }
    // slumping: steep dust slides down to the lower side
    let there = levelAt(n);
    d -= min(d0 * 0.2, max(here - there - REPOSE, 0.0) * SLUMP);
    d += min(driftAt(n) * 0.2, max(there - here - REPOSE, 0.0) * SLUMP);
  }
  // dust storms carry dust: as they pass they drop it where the wind is
  // broken (sheltered spots, hollows), so they rearrange drifts rather than
  // only wearing them away
  for (var k = 0u; k < 2u; k++) {
    let ds = G.dusts[k];
    if (ds.w <= 0.0) { continue; }
    let r = length(vec2<f32>(p) + 0.5 - ds.xy) / ds.z;
    if (r > 1.2) { continue; }
    let w = windAt(vec3<f32>(vec2<f32>(p) + 0.5, here + 0.5));
    let sh = shelter(p, w);
    d += ds.w / 8.0 * smoothstep(1.2, 0.4, r) * 0.06 * DT_D * (0.15 + 0.85 * sh);
  }
  // a dying cyclone drops the dust it carried in a pile around its eye
  if (G.cycloneB.z > 0.0) {
    let r = length(vec2<f32>(p) + 0.5 - G.cyclone.xy) / G.cyclone.z;
    d += smoothstep(1.6, 0.0, r) * 0.6 * DT_D;
  }
  // the editor's brush
  d += driftDelta[i];
  driftDelta[i] = 0.0;
  // dust sinks: still water lets it settle on the bed (the water lies on top
  // of it, round 13); moving water scours it away downstream
  if (water[i] > 0.05) { d *= 1.0 - min(length(netFlow(p)) * 0.5, 0.05); }
  textureStore(driftOut, p, vec4<f32>(max(d, 0.0), lost, 0.0, 0.0));
}
