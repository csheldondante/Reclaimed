// ---- wilt: plant health and tap responses (diegetic clues; rounds 6–7) --------
// wilt.x = hostility 0..1 of the ground here to plants: soil poison, oil,
//          trash/litter underfoot, drowning, drought.
// wilt.y = brownness 0..1 of whatever grows here: rises while plants stand on
//          hostile ground (fast under oil, at once when scorched), fades when
//          conditions are good or once the plants are gone.
// wilt.z = bloom 0..1: a grow-tap on good ground makes flowers open here at
//          once (vegprep draws them); fades over ~90 s or if the plants go.
// wilt.w = doomed sprout 1 → 0: a grow-tap on hostile ground makes a sprout
//          shoot up, brown and wilt over ~7 s (vegprep draws it) — the clue
//          that this ground has to be cleared first.
// Ecology reads x/y to grow and wither; the renderer tints plants with y.
// Runs every tick so it sees one-tick grow events (EV_GROW).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read> moisture: array<f32>;
@group(0) @binding(6) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read> veg: array<f32>;
@group(0) @binding(8) var<storage, read> oil: array<f32>;
@group(0) @binding(9) var<storage, read> fire: array<f32>;
@group(0) @binding(10) var<storage, read_write> wilt: array<vec4<f32>>;

const TOX_LIMIT_W: f32 = 0.2;
const MAT_TRASH_W: u32 = 12u;
// (rates below are per tick; they were tuned per 15-tick update in round 6)
const PER_TICK: f32 = 1.0 / 15.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let m = sfMat(surface[i]);
  let oiled = oil[i] > 0.02;
  var h = clamp(contam[i].x / TOX_LIMIT_W, 0.0, 1.0);
  if (oiled || m == MAT_TRASH_W || m == MAT_LITTER || water[i] > 0.5) { h = 1.0; }
  if (moisture[i] < 0.04) { h = max(h, 0.8); } // drought

  var s = wilt[i];
  var b = s.y;
  let v = veg[i];
  if (fire[i] > 0.15) {
    b = 1.0; // scorched
  } else if (v > 0.05) {
    if (oiled) { b += 0.15 * PER_TICK; }
    else if (h > 0.7) { b += (h - 0.6) * 0.08 * PER_TICK; }
    else { b -= 0.04 * PER_TICK; }
  } else {
    b -= 0.08 * PER_TICK;
  }

  var bloom = s.z - 1.0 / (90.0 * 60.0);
  if (v < 0.3 || b > 0.5) { bloom -= 0.02; }
  var sprout = s.w - 1.0 / (7.0 * 60.0);

  // grow-taps: flowers on good ground, a doomed sprout on bad
  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_GROW) { continue; }
    let ev = G.events[e];
    let dd = length(vec2<f32>(id.xy) + 0.5 - ev.xy) / ev.z;
    if (dd >= 1.0) { continue; }
    let roll = rand3(id.x, id.y, G.tick ^ 0x6a0eu);
    if (roll > 0.85 * (1.0 - dd) + 0.15) { continue; }
    if (h > 0.7) { sprout = 1.0; } else if (water[i] < 0.05) { bloom = 1.0; }
  }
  wilt[i] = vec4<f32>(h, clamp(b, 0.0, 1.0), clamp(bloom, 0.0, 1.0), clamp(sprout, 0.0, 1.0));
}
