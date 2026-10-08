// ---- wilt: plant health (diegetic clues; DECISIONS round 6) -----------------
// wilt.x = hostility 0..1 of the ground here to plants: soil poison, oil,
//          trash/litter underfoot, drowning, drought.
// wilt.y = brownness 0..1 of whatever grows here: rises while plants stand on
//          hostile ground (fast under oil, at once when scorched), fades when
//          conditions are good or once the plants are gone.
// Ecology reads it to grow (young sprouts take anywhere, then stall) and to
// wither (browned plants die back); the renderer tints plants with .y. So a
// seed landing on a dump sprouts, greens, browns and dies — showing what has
// to be cleared.
@group(0) @binding(3) var<storage, read> surface: array<u32>;
@group(0) @binding(4) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read> moisture: array<f32>;
@group(0) @binding(6) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read> veg: array<f32>;
@group(0) @binding(8) var<storage, read> oil: array<f32>;
@group(0) @binding(9) var<storage, read> fire: array<f32>;
@group(0) @binding(10) var<storage, read_write> wilt: array<vec2<f32>>;

const TOX_LIMIT_W: f32 = 0.2;
const MAT_TRASH_W: u32 = 12u;
const MAT_LITTER_W: u32 = 18u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let m = sfMat(surface[i]);
  let oiled = oil[i] > 0.02;
  var h = clamp(contam[i].x / TOX_LIMIT_W, 0.0, 1.0);
  if (oiled || m == MAT_TRASH_W || m == MAT_LITTER_W || water[i] > 0.5) { h = 1.0; }
  if (moisture[i] < 0.04) { h = max(h, 0.8); } // drought

  var b = wilt[i].y;
  let v = veg[i];
  if (fire[i] > 0.15) {
    b = 1.0; // scorched
  } else if (v > 0.05) {
    if (oiled) { b += 0.15; }
    else if (h > 0.7) { b += (h - 0.6) * 0.08; }
    else { b -= 0.04; }
  } else {
    b -= 0.08;
  }
  wilt[i] = vec2<f32>(h, clamp(b, 0.0, 1.0));
}
