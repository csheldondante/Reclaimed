// ---- wilt: plant health and tap responses (diegetic clues; rounds 6–9) --------
// wilt.x = hostility 0..1 of the ground here to plants: soil poison, oil,
//          trash/litter underfoot, drowning, drought. Established green
//          ground tolerates more poison (it holds once it has turned green).
// wilt.y = brownness 0..1 of whatever grows here: rises while plants stand on
//          hostile ground (fast under oil, at once when scorched), fades when
//          conditions are good or once the plants are gone.
// wilt.z = what the player has grown here on good ground: tier + growth,
//          tier 1 grass, 2 flowers/shrub, 3 a tree (tap centre only);
//          growth 0 → 1 over ~2.5 s. It stays while the ground stays good.
// wilt.w = what the player tried to grow on hostile ground: tier + phase;
//          it shoots up, browns and withers away as the phase runs 0 → 1
//          (6 / 8 / 11 s by tier) — the ground has to be cleared first.
// Tapping again while something is growing steps it up a tier: one tap
// grass, two flowers or a shrub, three a tree (DECISIONS round 9).
// Ecology reads x/y to grow and wither; the renderer tints plants with y;
// vegprep draws z/w. Runs every tick so it sees one-tick grow events.
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

/** How long a doomed planting lasts (s) by tier. */
fn doomTime(tier: f32) -> f32 { return select(select(11.0, 8.0, tier < 2.5), 6.0, tier < 1.5); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let m = sfMat(surface[i]);
  let v = veg[i];
  let oiled = oil[i] > 0.02;
  // green ground that has taken hold shrugs off a little drifting poison
  let tolerance = TOX_LIMIT_W + 0.3 * smoothstep(1.0, 2.0, v);
  var h = clamp(contam[i].x / tolerance, 0.0, 1.0);
  if (oiled || m == MAT_TRASH_W || m == MAT_LITTER || water[i] > 0.5) { h = 1.0; }
  if (moisture[i] < 0.04) { h = max(h, 0.8); } // drought

  let s = wilt[i];
  var b = s.y;
  if (fire[i] > 0.15) {
    b = 1.0; // scorched
  } else if (v > 0.05) {
    if (oiled) { b += 0.15 * PER_TICK; }
    else if (h > 0.7) { b += (h - 0.6) * 0.08 * PER_TICK; }
    else { b -= 0.04 * PER_TICK; }
  } else {
    b -= 0.08 * PER_TICK;
  }

  // the player's plantings
  var good = s.z;
  if (good > 0.0) {
    let tier = floor(good);
    good = tier + min(fract(good) + 1.0 / (2.5 * 60.0), 0.999);
    if (h > 0.7 || b > 0.5) { good = 0.0; } // the ground turned bad: gone
  }
  var bad = s.w;
  if (bad > 0.0) {
    let tier = floor(bad);
    let ph = fract(bad) + 1.0 / (doomTime(tier) * 60.0);
    bad = select(tier + ph, 0.0, ph >= 0.999);
    b = max(b, smoothstep(0.25, 0.6, ph)); // it browns as it dies
  }

  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_GROW) { continue; }
    let ev = G.events[e];
    let dd = length(vec2<f32>(id.xy) + 0.5 - ev.xy) / ev.z;
    if (dd >= 1.0) { continue; }
    // a tree only at the tap itself, flowers/shrubs close by, grass around
    let centre = all(vec2<u32>(floor(ev.xy)) == id.xy);
    let cap = select(select(1.0, 2.0, dd < 0.55), 3.0, centre);
    let roll = rand3(id.x, id.y, G.tick ^ 0x6a0eu);
    if (!centre && roll > 0.85 * (1.0 - dd) + 0.15) { continue; }
    if (h > 0.7) {
      // each tap restarts it one tier up (it still dies)
      bad = select(1.0, min(cap, floor(bad) + 1.0), bad > 0.0);
    } else if (water[i] < 0.05) {
      let t = select(1.0, min(cap, floor(good) + 1.0), good > 0.0);
      // a new tier grows in afresh; at the cap it just stays
      good = select(t, good, good > 0.0 && t == floor(good));
    }
  }
  wilt[i] = vec4<f32>(h, clamp(b, 0.0, 1.0), good, bad);
}
