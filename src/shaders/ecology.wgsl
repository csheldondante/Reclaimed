// ---- ecology / succession -------------------------------------------------
// veg = continuous succession stage per column:
//   0 bare · 1 lichen/moss · 2 grass · 3 shrubs · 4 young trees · 5 mature
// Growth depends on local conditions (substrate, moisture, and the ground's
// hostility from the wilt system: poison, oil, trash, flooding, drought) —
// not on a timer. Bare cells are colonised probabilistically from
// neighbours, plus a tiny spore rain so isolated clean areas recover.
// Seeds take even on hostile ground and the sprouts grow for a while, then
// brown (wilt.y) and wither: the clue to what must be cleared (round 6).
@group(0) @binding(3) var<storage, read> surface: array<u32>;
// x hostility 0..1, y brownness 0..1, z bloom, w doomed sprout (wilt.wgsl)
@group(0) @binding(4) var<storage, read> wilt: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> moisture: array<f32>;
@group(0) @binding(6) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read> vegIn: array<f32>;
@group(0) @binding(8) var<storage, read_write> vegOut: array<f32>;
@group(0) @binding(10) var<storage, read> fire: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  // what it grows in: the loose ground's material where there's a fair depth
  let m = groundMatAt(p, sfMat(surface[i]));
  let cap = MATS[m].eco.x;
  let suit = MATS[m].eco.y;
  let wl = wilt[i];
  let tox = 1.0 - wiltHostility(wl.x);
  let wet = moisture[i];
  let mf = smoothstep(0.06, 0.35, wet);
  let d = water[i];
  var v = vegIn[i];
  let r = rand3(id.x, id.y, G.tick ^ 0x5eedu);

  if (buriedAt(p)) {
    // buried under drifted dust or ash: dormant until uncovered — a loose
    // layer of sand or dirt is ground to grow in
  } else if (fire[i] > 0.15) {
    // burning: grass goes in a moment, trees take longer
    v = max(0.0, v - fire[i] * mix(0.6, 0.12, smoothstep(2.0, 4.0, v)));
  } else if (wl.y > 0.4) {
    // browned: withers away
    v = max(0.0, v - 0.04 * wl.y);
    if (v < 0.05) { v = 0.0; }
  } else if (v > 0.0) {
    // pioneers (moss, grass) establish quickly; woody stages take much longer.
    // A fresh sprout grows even on hostile ground — until it browns.
    let health = select(tox, 1.0, v < 0.9);
    var rate = 0.012 * suit * health * mf * mix(1.2, 0.55, smoothstep(1.5, 3.5, v));
    // biomes: woodland only matures on flat, well-watered ground; elsewhere
    // succession stops at meadow (grass, flowers, shrubs) — no dieback
    // + large natural patches of open meadow (wildflower fields) between woods
    let patchy = smoothstep(0.42, 0.58, fbm2((vec2<f32>(p) + G.org.zw) * 0.022 + 7.0));
    let woodland = flatness(p) * smoothstep(0.3, 0.55, wet) * patchy;
    if (v > 3.3 && woodland < 0.5) { rate = 0.0; }
    v += rate;
    if (v > cap) { v = max(cap, v - 0.02); }
    if (wet < 0.04) { v -= 0.003; }
    if (v < 0.05) { v = 0.0; }
  } else if (G.rules.x > 0.5) {
    // story rules (round 30): bare ground is only ever colonised by seeds
    // (particles.wgsl) — green sheds them into the breeze, so it creeps onto
    // fertile ground nearby by itself and the player blows it farther
  } else {
    var neigh = 0.0;
    for (var k = 0u; k < NDIR; k++) {
      let q = nbr(p, k);
      if (inMap(q)) { neigh += smoothstep(0.4, 1.2, vegIn[colIdxI(q)]); }
    }
    // occasional long-distance seed from established plants (wind / animals)
    let o = vec2<i32>(i32(hash3(id.x, id.y, G.tick) % 9u) - 4, i32(hash3(id.y, id.x, G.tick + 7u) % 9u) - 4);
    let q2 = clampCell(p + o);
    neigh += 0.6 * smoothstep(2.5, 4.0, vegIn[colIdxI(q2)]);
    // spreading plants also try their luck on bad ground (and wither there)
    let chance = (neigh * 0.1 * (0.3 + 0.7 * tox) + 0.0003 * tox) * suit * mf;
    if (cap > 0.0 && r < chance) { v = 0.25; }
  }
  vegOut[i] = clamp(v, 0.0, 5.0);
}
