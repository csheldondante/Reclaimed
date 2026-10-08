// ---- particles (simulation) ------------------------------------------------
// A fixed-capacity ring of GPU particles. Allocation is an atomic ring head
// (oldest particles are overwritten when full) — no free list, no readback.
//
// Particles are real world matter where it matters: DUST and LITTER carry a
// payload of soil contamination picked up from the ground (through the
// contamDelta exchange buffer) and drop it where they land. Leaving the map
// removes it from the world for good — that's how wind clears pollution.
// Everything else (leaves, clouds, chips, splashes) is visual.

struct Particle {
  p: vec4<f32>, // xyz position (cells), w = life remaining (s)
  v: vec4<f32>, // xyz velocity (cells/s), w = contamination payload
  m: vec4<u32>, // x kind, y seed, z flags (1 = resting), w unused
};

@group(0) @binding(3) var<storage, read_write> parts: array<Particle>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> surface: array<u32>;
@group(0) @binding(6) var<storage, read> water: array<f32>;
@group(0) @binding(7) var<storage, read> contam: array<vec2<f32>>;
@group(0) @binding(8) var<storage, read_write> contamDelta: array<atomic<i32>>;
// read-write only so landing birds can plant a seed (0 → pioneer), see update()
@group(0) @binding(9) var<storage, read_write> veg: array<f32>;
@group(0) @binding(10) var<storage, read> moisture: array<f32>;
// CPU bursts: [0].x = count; then pairs (x, y, z, n) (kind, speed, payload, spread)
@group(0) @binding(11) var<uniform> requests: array<vec4<f32>, 129>;
// only the petalEmit entry uses these
@group(0) @binding(14) var<storage, read> wiltP: array<vec4<f32>>;
@group(0) @binding(16) var<storage, read_write> petals: array<f32>;
// only the fireEmit entry uses these
@group(0) @binding(12) var<storage, read> fire: array<f32>;
@group(0) @binding(13) var<storage, read> oilDepth: array<f32>;

const K_DUST: u32 = 1u;
const K_LITTER: u32 = 2u;
const K_LEAF: u32 = 3u;
const K_ASH: u32 = 4u;
const K_CHIP: u32 = 5u;
const K_CLOUD: u32 = 6u;
const K_SPLASH: u32 = 7u;
const K_SMOKE: u32 = 8u;
const K_EMBER: u32 = 9u;
const K_BIRD: u32 = 10u;
const K_FIREFLY: u32 = 11u;
const K_FLAME: u32 = 12u;
const K_DEER: u32 = 13u;
const K_RABBIT: u32 = 14u;
// dust kicked up by strong wind: a low tan haze (dust storms, drags)
const K_HAZE: u32 = 15u;
// tree seeds: fluff that floats on the wind and sprouts where it lands —
// on bad ground the sprout withers (the wilt system), a clue (round 6)
const K_SEED: u32 = 16u;
// grow-tap response: state 0 = green sparkle (it took), 1 = brown fleck (the
// ground is hostile here)
const K_SPARK: u32 = 17u;
// petals torn off flowers by the wind (round 10); seed = colour
const K_PETAL: u32 = 18u;
// a brief soft light where something happens (round 11): state 0 growth
// (green-gold), 1 wind (pale blue)
const K_GLOW: u32 = 19u;
// smoke state (Particle.m.w): 1 = oil smoke — a lingering dark cloud. Wind
// disperses it (counted in counters[2]; the level turns that into Nature);
// left to settle, it falls as soot (DECISIONS round 5)
const SMOKE_OILY: u32 = 1u;
const SOOT: f32 = 0.03;
// dust state (Particle.m.w): 1 = grime — a clump of the ground's pollution.
// It holds its contamination (taken from the soil when it formed) wherever it
// goes; blown into water it washes away (counters[3]; the level turns that
// into a splash, a sound and a little Nature) — the cleaning game (round 7)
const DUST_GRIME: u32 = 1u;

// bird states (Particle.m.w); a seeking bird keeps its target column + 1 in v.w
const B_FLEE: u32 = 0u;
const B_SEEK: u32 = 1u;
const B_PERCH: u32 = 2u;

const DT: f32 = 1.0 / 60.0;
const FIX: f32 = 100000.0;
const MAT_SOIL: u32 = 2u;
const MAT_SAND: u32 = 3u;
const MAT_TRASH_P: u32 = 12u;
const MAT_ASH_P: u32 = 17u;

fn spawnFull(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, payload: f32, seed: u32, flags: u32, state: u32) {
  let i = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[i] = Particle(vec4<f32>(pos, life), vec4<f32>(vel, payload), vec4<u32>(kind, seed, flags, state));
}
fn spawn(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, payload: f32, seed: u32) {
  spawnFull(pos, vel, life, kind, payload, seed, 0u, 0u);
}
/** Debris lying on the ground (resting) until the wind lifts it. */
fn spawnResting(pos: vec3<f32>, life: f32, kind: u32, seed: u32) {
  spawnFull(pos, vec3<f32>(0.0), life, kind, 0.0, seed, 1u, 0u);
}

/** Full 32-bit random in [0,1) for rare events (16-bit draws bottom out at 1.5e-5). */
fn rare(x: u32, y: u32, salt: u32) -> f32 { return f32(hash3(x, y, G.tick ^ salt)) / 4294967296.0; }

fn depositAt(pos: vec3<f32>, payload: f32) {
  let c = vec2<i32>(floor(pos.xy));
  if (payload > 0.0 && inMap(c)) { atomicAdd(&contamDelta[colIdxI(c)], i32(payload * FIX)); }
}

/** How readily bare ground sheds dust: polluted soil most, then plain soil/sand. */
fn dustinessOf(cs: f32, m: u32) -> f32 {
  var d = clamp(cs, 0.0, 1.5) * 0.7;
  if (m == MAT_SOIL || m == MAT_SAND) { d += 0.12; }
  if (m == MAT_ASH_P) { d += 0.6; } // burned waste: fine, light, blows away
  return d;
}

// ---- emission from the world (one thread per column, rare per tick) ----
// Debris (dust, litter, leaves) is born lying on the ground and only the wind
// lifts it (update(); DECISIONS round 4) — nothing blows in from mid-air.
@compute @workgroup_size(8, 8)
fn emit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let s = surface[i];
  let g = f32(sfZ(s));
  let m = sfMat(s);
  let base = vec3<f32>(vec2<f32>(p) + 0.5, g);
  let wind = windAt(base + vec3<f32>(0.0, 0.0, 1.0));
  let ws = length(wind);
  let h = hash3(id.x, id.y, G.tick);
  let r1 = f32(h & 0xffffu) / 65536.0;
  let r2 = f32(h >> 16u) / 65536.0;
  let v = veg[i];
  let wet = water[i] > 0.02;
  let dry = 1.0 - smoothstep(0.15, 0.45, moisture[i]);
  let cover = smoothstep(0.3, 1.5, v);
  let boost = max(G.env.z, 1.0);
  let onGround = base + vec3<f32>(r1 - 0.5, fract(r1 * 7.31) - 0.5, 0.0) * 0.9;

  if (!wet) {
    let dusty = dustinessOf(contam[i].x, m) * dry * (1.0 - cover);
    // dust settles out of the dry, dead ground
    if (rare(id.x, id.y, 0xd057u) < 0.00002 * dusty * boost) {
      spawnResting(onGround, 60.0 + r2 * 60.0, K_DUST, h);
    }
    // polluted ground clumps into grime that the wind can push about
    let cg = contam[i].x;
    if (cg > 0.25 && rare(id.x, id.y, 0x9e1au) < 0.00001 * min(cg, 1.5) * boost) {
      let take = min(cg * 0.08, 0.06);
      atomicSub(&contamDelta[i], i32(take * FIX));
      spawnFull(onGround, vec3<f32>(0.0), 500.0 + r2 * 200.0, K_DUST, take, h ^ 0x9eu, 1u, DUST_GRIME);
    }
    // strong wind over dusty ground raises a haze (hard drags, storm winds);
    // a dust storm raises it over any dry bare ground in its path
    var dstorm = 0.0;
    for (var k = 0u; k < 2u; k++) {
      let d = G.dusts[k];
      if (d.w > 0.0) { dstorm = max(dstorm, d.w / 8.0 * smoothstep(1.1, 0.3, length(base.xy - d.xy) / d.z)); }
    }
    // (capped low: a hard drag should show what it moves, not bury it in haze)
    let hazeRate = min(max(ws - 6.0, 0.0) * 0.0005 * dusty, 0.0012) + dstorm * 0.0012 * dry * (1.0 - cover);
    if (rare(id.x, id.y, 0x4a2eu) < hazeRate) {
      spawn(base + vec3<f32>(r1 - 0.5, r2 - 0.5, 0.4 + r1 * 2.5), vec3<f32>(wind * 0.5, 0.5 + r2), 6.0 + r1 * 4.0, K_HAZE, 0.0, h);
    }
    // scattered litter torn off the ground by strong wind (removed by the
    // material system next tick; see litterStrip)
    if (m == MAT_ASH_P && litterStrip(p, G.tick + 1u)) {
      // ash goes up in a grey puff and away
      for (var k = 0u; k < 3u; k++) {
        spawn(base + vec3<f32>(r1 - 0.5, fract(r2 * f32(k + 3u)) - 0.5, 0.3), vec3<f32>(wind * 0.6, 0.8 + r1), 3.0 + r2 * 2.0, K_ASH, 0.0, h ^ (0x45u + k));
      }
    }
    if (m == MAT_LITTER && litterStrip(p, G.tick + 1u)) {
      let cs = contam[i].x;
      let payload = min(cs * 0.06, 0.03);
      atomicSub(&contamDelta[i], i32(payload * FIX));
      spawn(base + vec3<f32>(r1 - 0.5, r2 - 0.5, 0.2), vec3<f32>(wind * 0.5, 2.0 + r1 * 2.0), 40.0 + r2 * 30.0, K_LITTER, payload, h ^ 0x51u);
    }
    // loose waste lies about on the dumps as litter
    if (m == MAT_TRASH_P && rare(id.x, id.y, 0x7a54u) < 0.00015 * dry * boost) {
      spawnResting(onGround, 90.0 + r2 * 60.0, K_LITTER, h);
    }
  }
  // trees let their seeds go in pulses (each tree its own rhythm), and wind
  // shakes more loose
  if (v >= 3.6) {
    let pl = vegPlan(id.x, id.y, v, m);
    if (pl.tree) {
      let pulse = sin(G.time * 0.12 + rand3(id.x, id.y, 5u) * 6.2832) > 0.93;
      let rate = select(0.0, 0.03, pulse) + max(ws - 4.0, 0.0) * 0.006;
      if (rare(id.x, id.y, 0x5eedu) < rate) {
        let top = g + pl.trunk + pl.crown;
        spawn(vec3<f32>(base.xy + vec2<f32>(r1 - 0.5, r2 - 0.5) * 2.4, top - r1), vec3<f32>(wind * 0.5, 0.6), 40.0, K_SEED, 0.0, h ^ 0x5eu);
      }
    }
  }
  // grow-tap: a small boost to living ground; a fresh sprout on bare ground;
  // on hostile ground only a wilt (brown flecks) to show it won't take
  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_GROW) { continue; }
    let ev = G.events[e];
    let dd = length(base.xy - ev.xy) / ev.z;
    if (dd >= 1.0) { continue; }
    if (all(vec2<u32>(floor(ev.xy)) == id.xy)) {
      spawnFull(base + vec3<f32>(0.0, 0.0, 0.6), vec3<f32>(0.0), 1.4, K_GLOW, 0.0, h ^ 0x6100u, 0u, 0u);
    }
    let fall = 1.0 - dd;
    let hostile = contam[i].x > 0.2 || wet || m == MAT_TRASH_P || m == MAT_LITTER || moisture[i] < 0.04;
    let cap = MATS[m].eco.x;
    if (!hostile && cap > 0.0) {
      // near the tap grass comes up at once (tufts show from 1.2); around it a boost
      veg[i] = min(max(max(v, 0.3) + 0.35 * fall, select(0.0, 1.5, fall > 0.45)), max(cap, v));
      if (r1 < 0.35 * fall) { spawnFull(base + vec3<f32>(r1 - 0.5, r2 - 0.5, 0.3), vec3<f32>(0.0, 0.0, 1.2 + r2), 1.4 + r1, K_SPARK, 0.0, h, 0u, 0u); }
    } else if (r1 < 0.3 * fall) {
      spawnFull(base + vec3<f32>(r1 - 0.5, r2 - 0.5, 0.3), vec3<f32>((r2 - 0.5) * 0.6, (r1 - 0.5) * 0.6, 0.6), 1.6 + r1, K_SPARK, 0.0, h, 0u, 1u);
    }
  }
  // fallen leaves gather on the woodland floor
  if (v >= 3.6 && !wet && rare(id.x, id.y, 0x1eafu) < 0.00004 * boost) {
    spawnResting(onGround, 50.0 + r2 * 40.0, K_LEAF, h);
  }
  if (G.sky.w < 0.5 && v >= 3.0 && !wet && rare(id.x, id.y, 0xdee5u) < 0.00000006) {
    spawn(base + vec3<f32>(0.0, 0.0, 0.4), vec3<f32>(r2 - 0.5, fract(r2 * 5.0) - 0.5, 0.0), 80.0 + r2 * 60.0, K_DEER, 0.0, h);
  }
  // rabbits on grassland
  if (G.sky.w < 0.5 && v >= 1.5 && v < 3.5 && !wet && rare(id.x, id.y, 0x4abu) < 0.000002) {
    spawn(base + vec3<f32>(0.0, 0.0, 0.25), vec3<f32>(r1 - 0.5, fract(r1 * 3.0) - 0.5, 0.0), 60.0 + r1 * 60.0, K_RABBIT, 0.0, h);
  }
  // fireflies over living land at night
  // fireflies belong to meadows, not woodland
  if (G.sky.w > 0.6 && v >= 1.8 && v < 3.4 && !wet && rare(id.x, id.y, 0xf1f1u) < 0.0004 * G.sky.w) {
    spawn(base + vec3<f32>(r1 - 0.5, fract(r1 * 5.3) - 0.5, 0.6 + r1 * 2.0), vec3<f32>(0.0), 6.0 + r1 * 6.0, K_FIREFLY, 0.0, h);
  }
  // (storms have no cloud puffs: rain fades in from a height — DECISIONS round 5)
}

// ---- birds: perch in tree crowns, flush when the tree is tapped ----

/** Height of the crown top of the tree standing on column q, or -1 if none. */
fn crownTop(q: vec2<i32>) -> f32 {
  if (!inMap(q)) { return -1.0; }
  let j = colIdxI(q);
  let v = veg[j];
  if (v < 3.6) { return -1.0; }
  let s = surface[j];
  let pl = vegPlan(u32(q.x), u32(q.y), v, sfMat(s));
  if (!pl.tree) { return -1.0; }
  return f32(sfZ(s)) + pl.trunk + pl.crown;
}

/** Look for a tree crown near p (7×7 cells); returns column + 1, or 0. */
fn findTree(p: vec2<i32>, salt: u32) -> u32 {
  let o = vec2<i32>(i32(salt % 7u), i32((salt / 7u) % 7u));
  for (var k = 0; k < 49; k++) {
    let d = (vec2<i32>(k % 7, k / 7) + o) % vec2<i32>(7) - vec2<i32>(3);
    let q = p + d;
    if (crownTop(q) > 0.0) { return colIdxI(q) + 1u; }
  }
  return 0u;
}

/** Was a perched bird at pos startled this tick (a tap on its tree, lightning nearby)? */
fn startled(pos: vec3<f32>) -> vec2<f32> {
  for (var e = 0u; e < numEvents(); e++) {
    let k = evKind(e);
    let ev = G.events[e];
    var r = 0.0;
    if (k == EV_SCARE) { r = ev.z; }
    if (k == EV_LIGHTNING) { r = ev.z * 4.0; }
    let d = pos.xy - ev.xy;
    if (r > 0.0 && length(d) < r) { return normalize(d + vec2<f32>(0.01, 0.0)); }
  }
  return vec2<f32>(0.0);
}

// ---- petals: wind over flowering plants sheds their flowers (round 10) ----
// A column has flowers if its plan says so or the player planted them. A gust
// (local wind over 9 cells/s) strips them: petals blow away as particles and
// the plants stand as bare stems (vegprep) until they regrow over ~45 s.
@compute @workgroup_size(8, 8)
fn petalEmit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  var pt = petals[i];
  pt = min(1.0, pt + 1.0 / (45.0 * 60.0));
  let s = surface[i];
  let pl = vegPlan(id.x, id.y, veg[i], sfMat(s));
  let flowery = pl.flower || floor(wiltP[i].z) >= 2.0;
  if (flowery && pt >= 1.0) {
    let g = f32(sfZ(s));
    let w = windAt(vec3<f32>(vec2<f32>(id.xy) + 0.5, g + 0.5));
    let ws = length(w);
    let h = hash3(id.x, id.y, G.tick ^ 0x9e7au);
    if (ws > 9.0 && f32(h & 0xffffu) / 65536.0 < (ws - 9.0) * 0.01) {
      pt = 0.0;
      for (var k = 0u; k < 4u; k++) {
        let hk = hash3(id.x, id.y, G.tick + k * 17u);
        let r = vec2<f32>(f32(hk & 255u), f32((hk >> 8u) & 255u)) / 255.0 - 0.5;
        spawn(vec3<f32>(vec2<f32>(id.xy) + 0.5 + r, g + 0.6), vec3<f32>(w * 0.5, 1.0 + f32((hk >> 16u) & 255u) / 255.0), 6.0 + f32(k), K_PETAL, 0.0, hash3(id.x, id.y, 77u));
      }
    }
  }
  petals[i] = pt;
}

// ---- flames, smoke and embers from burning columns ----
@compute @workgroup_size(8, 8)
fn fireEmit(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let f = fire[i];
  if (f < 0.08) { return; }
  let h = hash3(id.x, id.y, G.tick ^ 0xf1a3u);
  let r1 = f32(h & 1023u) / 1023.0;
  let r2 = f32((h >> 10u) & 1023u) / 1023.0;
  let r3 = f32((h >> 20u) & 1023u) / 1023.0;
  let g = f32(sfZ(surface[i]));
  let base = vec3<f32>(f32(id.x) + r2, f32(id.y) + r3, g + 0.2);
  let w = windAt(base);
  if (r1 < f * 0.35) { spawn(base, vec3<f32>(w * 0.15, 2.5 + r2 * 2.0), 0.45 + r3 * 0.5, K_FLAME, 0.0, h); }
  if (oilDepth[i] > 0.03) {
    // burning oil: thick, slow smoke that gathers into a cloud
    if (r2 < f * 0.03) { spawnFull(base + vec3<f32>(0.0, 0.0, 1.5), vec3<f32>(w * 0.2, 1.5), 32.0 + r1 * 16.0, K_SMOKE, SOOT, h ^ 77u, 0u, SMOKE_OILY); }
  } else if (r2 < f * 0.07) { spawn(base + vec3<f32>(0.0, 0.0, 1.5), vec3<f32>(w * 0.3, 1.2), 6.0 + r1 * 5.0, K_SMOKE, 0.0, h ^ 77u); }
  if (r3 < f * 0.015) { spawn(base, vec3<f32>(w * 0.2 + vec2<f32>(r1 - 0.5, r2 - 0.5) * 2.0, 4.0 + r1 * 3.0), 2.0 + r2 * 1.5, K_EMBER, 0.0, h ^ 99u); }
}

// ---- CPU-requested bursts (clicks, strikes, chips, birds) ----
@compute @workgroup_size(64)
fn bursts(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = u32(requests[0].x);
  if (id.x >= n) { return; }
  let a = requests[1u + id.x * 2u];
  let b = requests[2u + id.x * 2u];
  let count = u32(a.w);
  let kind = u32(b.x);
  for (var k = 0u; k < count; k++) {
    let h = hash3(id.x, k, G.tick ^ 0xb0057u);
    let r = vec3<f32>(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) / 1023.0 - 0.5;
    let dir = normalize(r + vec3<f32>(0.0, 0.0, 0.35));
    var life = 3.0 + r.x * 2.0;
    if (kind == K_BIRD) { life = 14.0; }
    if (kind == K_LEAF) { life = 10.0; }
    if (kind == K_DEER || kind == K_RABBIT) { life = 90.0 + r.x * 60.0; }
    if (kind == K_GLOW) {
      spawnFull(a.xyz, vec3<f32>(0.0), 1.3, kind, 0.0, h, 0u, u32(b.z));
      continue;
    }
    if (kind == K_BIRD) {
      // birds arrive looking for a tree: fly in toward the middle of the map
      // (or wherever they were released), then search for a crown to perch on
      let pos = a.xyz + r * b.w;
      let toMid = vec2<f32>(f32(G.mapW), f32(G.mapH)) * 0.5 - pos.xy;
      let hd = normalize(toMid + r.xy * 40.0 + vec2<f32>(0.01, 0.0));
      spawnFull(pos, vec3<f32>(hd * b.y, 0.0), 120.0 + r.z * 60.0, kind, 0.0, h, 0u, B_SEEK);
      continue;
    }
    spawn(a.xyz + r * b.w, dir * b.y * (0.6 + 0.8 * fract(r.y * 9.1)), life, kind, b.z / f32(max(count, 1u)), h);
  }
}

// ---- integration ----
@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = arrayLength(&parts);
  if (id.x >= n) { return; }
  var P = parts[id.x];
  if (P.p.w <= 0.0) { return; }
  var pos = P.p.xyz;
  var vel = P.v.xyz;
  var life = P.p.w - DT;
  let kind = P.m.x;
  let seed = P.m.y;
  let sr = f32(seed & 0xffffu) / 65536.0;
  let cell = vec2<i32>(floor(pos.xy));

  if (!inMap(cell)) {
    // left the world: its payload is gone for good (pollution carried away)
    if (P.m.x == K_SMOKE && P.m.w == SMOKE_OILY) { atomicAdd(&counters[2], 1u); }
    parts[id.x].p.w = 0.0;
    return;
  }
  let ci = colIdxI(cell);
  let ground = f32(sfZ(surface[ci])) + water[ci];
  let w = windAt(pos);
  let rain = rainAt(pos.xy);

  var drag = 1.5;
  var grav = 0.5;
  var resting = (P.m.z & 1u) != 0u;
  var state = P.m.w;
  // ground debris lies still until the wind is strong enough to lift it; the
  // stronger the wind over its threshold, the sooner it goes
  let ws = length(w);
  let liftRoll = f32(hash3(id.x, G.tick, seed ^ 0x11f7u)) / 4294967296.0;
  if (kind == K_DUST) {
    drag = 1.6; grav = 1.1 + rain * 6.0; // drifts down; rain knocks it out of the air
    // grime is light, flaky stuff: it sails further on a good gust
    if (state == DUST_GRIME) { grav = 0.55 + rain * 6.0; }
    if (resting) {
      if (ws > 4.5 && liftRoll < (ws - 4.5) * 0.004 && water[ci] < 0.02) {
        resting = false;
        vel = vec3<f32>(w * 0.5, 1.2 + sr * 1.5);
        // polluted dust carries its pollution with it (off the map, with luck)
        let cs = contam[ci].x;
        if (cs > 0.03 && state != DUST_GRIME) {
          let take = min(cs * 0.04, 0.015);
          atomicSub(&contamDelta[ci], i32(take * FIX));
          P.v.w += take;
        }
      } else {
        vel = vec3<f32>(0.0);
      }
    } else {
      vel.z += (vnoise(pos.xy * 0.3 + vec2<f32>(G.time * 2.0, sr * 10.0)) - 0.48) * 4.0 * DT;
    }
  } else if (kind == K_LITTER) {
    drag = 1.2; grav = 4.0;
    if (resting) {
      if (ws > 4.0 && liftRoll < (ws - 4.0) * 0.003) {
        resting = false;
        vel = vec3<f32>(w * 0.5, 2.0 + sr * 2.5);
        // waste picked up off a dump takes some of its pollution along
        let cs = contam[ci].x;
        if (cs > 0.03) {
          let take = min(cs * 0.05, 0.02);
          atomicSub(&contamDelta[ci], i32(take * FIX));
          P.v.w += take;
        }
      } else {
        vel = vec3<f32>(0.0);
      }
    }
  } else if (kind == K_LEAF) {
    drag = 2.2; grav = 0.9;
    if (resting) {
      if (ws > 3.5 && liftRoll < (ws - 3.5) * 0.004) {
        resting = false;
        vel = vec3<f32>(w * 0.5, 1.5 + sr * 2.0);
        life = max(life, 12.0);
      } else {
        vel = vec3<f32>(0.0);
      }
    } else {
      vel.x += sin(G.time * 5.0 + sr * 40.0) * 2.0 * DT;
      vel.y += cos(G.time * 4.3 + sr * 31.0) * 2.0 * DT;
    }
  } else if (kind == K_SEED) {
    // fluff: rides the wind, sinks slowly — slower still in a strong wind
    drag = 2.0; grav = 0.35 / (1.0 + ws * 0.35);
    vel.x += sin(G.time * 3.0 + sr * 40.0) * 0.8 * DT;
    vel.y += cos(G.time * 2.6 + sr * 31.0) * 0.8 * DT;
  } else if (kind == K_PETAL) {
    drag = 2.4; grav = 0.6;
    vel.x += sin(G.time * 6.0 + sr * 40.0) * 2.5 * DT;
    vel.y += cos(G.time * 5.0 + sr * 31.0) * 2.5 * DT;
  } else if (kind == K_GLOW) {
    drag = 0.0; grav = 0.0; vel = vec3<f32>(0.0);
  } else if (kind == K_SPARK) {
    drag = 0.5; grav = select(-0.6, 1.2, state == 1u);
  } else if (kind == K_HAZE) {
    drag = 1.4; grav = -0.15;
  } else if (kind == K_CLOUD) {
    drag = 0.0; grav = 0.0;
  } else if (kind == K_SMOKE && state == SMOKE_OILY) {
    // a heavy cloud: rises to a low ceiling and hangs there, drifting with
    // the wind; strong wind tears it apart (it thins out much faster)
    drag = 0.7; grav = 0.0;
    vel.z += ((ground + 8.0 + sr * 6.0) - pos.z) * 0.4 * DT;
    vel.z *= 0.98;
    if (ws > 4.0) {
      life -= DT * (ws - 4.0) * 1.5;
      if (life <= 0.0) {
        atomicAdd(&counters[2], 1u);
        parts[id.x].p.w = 0.0;
        return;
      }
    }
  } else if (kind == K_SMOKE || kind == K_ASH) {
    drag = 1.0; grav = -0.8;
  } else if (kind == K_EMBER) {
    drag = 1.2; grav = -0.4;
  } else if (kind == K_CHIP || kind == K_SPLASH) {
    drag = 0.3; grav = 14.0;
  } else if (kind == K_FLAME) {
    drag = 1.0; grav = -3.0;
  } else if (kind == K_FIREFLY) {
    // wander slowly, ignore most wind
    drag = 0.2; grav = 0.0;
    vel += vec3<f32>(sin(G.time * 1.7 + sr * 31.0), cos(G.time * 1.3 + sr * 17.0), sin(G.time * 2.1 + sr * 7.0) * 0.6) * 1.5 * DT;
    vel *= 0.98;
  } else if (kind == K_BIRD) {
    // birds (DECISIONS round 4): arrive from off the map, look for a tree
    // crown and perch; a tap on their tree (or lightning) flushes them, and
    // fleeing birds either settle in another tree or leave the map
    drag = 0.0; grav = 0.0;
    if (state == B_PERCH) {
      vel = vec3<f32>(0.0);
      let away = startled(pos);
      let tgt = u32(P.v.w) - 1u;
      var gone = false;
      if ((G.tick + seed) % 30u == 0u) {
        gone = crownTop(vec2<i32>(i32(tgt % G.mapW), i32(tgt / G.mapW))) < 0.0; // tree burned or died
      }
      if (length(away) > 0.0 || gone || life < 2.0) {
        state = B_FLEE;
        resting = false;
        var hd = away;
        if (length(hd) == 0.0) { hd = vec2<f32>(cos(sr * 6.28), sin(sr * 6.28)); }
        vel = vec3<f32>(hd * (5.0 + sr * 2.0), 4.0);
        life = 30.0 + sr * 20.0;
        P.v.w = 0.0;
        atomicAdd(&counters[1], 1u);
      } else if (rare(id.x, seed, 0x5eedu) < 1.0 / (60.0 * 40.0)) {
        // a perched bird drops a seed now and then
        spawn(pos + vec3<f32>(0.0, 0.0, -0.3), vec3<f32>((sr - 0.5) * 2.0, (fract(sr * 7.0) - 0.5) * 2.0, 0.0), 30.0, K_SEED, 0.0, seed ^ G.tick);
      }
    } else if (state == B_SEEK) {
      // cruise above the land, wandering a little; look for a crown below
      var tgt = u32(P.v.w);
      if (tgt == 0u && (G.tick + seed) % 8u == 0u && veg[ci] >= 3.0) {
        tgt = findTree(cell, seed + G.tick);
        P.v.w = f32(tgt);
      }
      if (tgt > 0u) {
        let tc = vec2<i32>(i32((tgt - 1u) % G.mapW), i32((tgt - 1u) / G.mapW));
        let top = crownTop(tc);
        if (top < 0.0) {
          P.v.w = 0.0;
        } else {
          let perch = vec3<f32>(vec2<f32>(tc) + 0.5 + (vec2<f32>(sr, fract(sr * 7.0)) - 0.5) * 1.6, top + 0.05);
          let to = perch - pos;
          let dh = length(to.xy);
          // glide in high, then drop onto the crown
          var aim = perch;
          if (dh > 3.0) { aim.z = max(perch.z + 4.0, ground + 6.0); }
          let want = normalize(aim - pos + vec3<f32>(0.0, 0.0, 1e-3)) * clamp(length(aim - pos) * 1.5, 1.0, 6.0);
          vel += (want - vel) * min(3.0 * DT, 1.0);
          if (length(to) < 0.35) {
            state = B_PERCH;
            resting = true;
            pos = perch;
            vel = vec3<f32>(0.0);
            life = 150.0 + sr * 250.0;
          }
        }
      } else {
        // glance around: a random spot within ~30 cells; if it is woodland, turn toward it
        if ((G.tick + seed) % 4u == 0u) {
          let hs = hash3(id.x, seed, G.tick ^ 0xb12du);
          let look = clampCell(cell + vec2<i32>(i32(hs % 61u) - 30, i32((hs >> 8u) % 61u) - 30));
          if (veg[colIdxI(look)] >= 3.6) {
            let to = vec2<f32>(look) + 0.5 - pos.xy;
            vel = vec3<f32>(normalize(to) * max(length(vel.xy), 4.0), vel.z);
          }
        }
        vel.x += cos(G.time * 0.9 + sr * 20.0) * 1.5 * DT;
        vel.y += sin(G.time * 0.7 + sr * 17.0) * 1.5 * DT;
        vel.z += ((ground + 9.0 + sr * 4.0) - pos.z) * 0.8 * DT;
        vel.z *= 0.98;
        let hs = length(vel.xy);
        if (hs > 0.01) { vel = vec3<f32>(vel.xy / hs * clamp(hs, 3.5, 6.0), vel.z); }
      }
      if (life < 2.0) { state = B_FLEE; life = 30.0; }
    } else {
      // fleeing: climb and fly straight, shedding seeds on the way (they show
      // where plants will and won't take); after a while some look for
      // another tree
      if (rare(id.x, seed, 0xd20bu) < 1.0 / 45.0) {
        spawn(pos, vec3<f32>(vel.xy * 0.3, 0.0), 30.0, K_SEED, 0.0, seed ^ G.tick ^ 0x99u);
      }
      vel.z += ((ground + 12.0 + sr * 4.0) - pos.z) * 0.8 * DT;
      vel.z *= 0.97;
      if (life < 22.0 && sr < 0.5) { state = B_SEEK; life = 60.0 + sr * 60.0; }
    }
  } else if (kind == K_DEER || kind == K_RABBIT) {
    // ground-bound walker: wander, pause to graze, keep to living ground,
    // bolt from a fast cursor
    drag = 0.0; grav = 0.0;
    let graze = sin(G.time * 0.45 + sr * 20.0) > 0.25;
    var hd = vel.xy;
    if (length(hd) < 0.01) { hd = vec2<f32>(cos(sr * 6.28), sin(sr * 6.28)); }
    hd = normalize(hd);
    let turn = (vnoise(vec2<f32>(G.time * 0.3, sr * 50.0)) - 0.5) * 2.0 * DT;
    hd = vec2<f32>(hd.x * cos(turn) - hd.y * sin(turn), hd.x * sin(turn) + hd.y * cos(turn));
    let ahead = clampCell(vec2<i32>(floor(pos.xy + hd * 1.5)));
    let aj = colIdxI(ahead);
    if (veg[aj] < 1.0 || water[aj] > 0.1 || abs(f32(sfZ(surface[aj])) - f32(sfZ(surface[ci]))) > 2.0) { hd = -hd; }
    let rabbit = kind == K_RABBIT;
    var speed = select(select(0.8, 1.6, rabbit), 0.0, graze);
    // startled by taps and fast cursor movement nearby (the cursor breeze)
    let b = G.gusts[0];
    let away = pos.xy - b.xy;
    if (b.w > 1.5 && length(away) < select(9.0, 7.0, rabbit)) { hd = normalize(away + vec2<f32>(1e-3)); speed = select(4.5, 6.5, rabbit); }
    vel = vec3<f32>(hd * max(speed, 0.001), 0.0);
    var hop = 0.0;
    if (rabbit && speed > 0.1) { hop = abs(sin(G.time * (6.0 + speed * 2.0) + sr * 20.0)) * 0.45; }
    pos = vec3<f32>(pos.xy + vel.xy * DT, ground + select(0.4, 0.22 + hop, rabbit));
  }

  if (!resting && kind != K_DEER && kind != K_RABBIT) {
    vel = vec3<f32>(vel.xy + (w - vel.xy) * min(drag * DT, 1.0), vel.z - grav * DT);
    if (kind == K_DUST || kind == K_LEAF) { vel.z *= 0.995; }
    pos += vel * DT;
  }

  if (kind == K_FIREFLY && pos.z <= ground + 0.3) { pos.z = ground + 0.3; vel.z = abs(vel.z); }
  if (kind == K_BIRD && pos.z <= ground + 0.2) {
    pos.z = ground + 0.2;
    vel.z = abs(vel.z);
  }
  if (kind != K_CLOUD && kind != K_HAZE && kind != K_GLOW && kind != K_BIRD && kind != K_DEER && kind != K_RABBIT && kind != K_FIREFLY && kind != K_FLAME && kind != K_SMOKE && kind != K_EMBER && pos.z <= ground) {
    if (kind == K_DUST && state == DUST_GRIME) {
      if (water[ci] > 0.02) {
        // into the water: washed off and carried away by the stream
        depositAt(pos, P.v.w);
        atomicAdd(&counters[3], 1u);
        spawn(vec3<f32>(pos.xy, ground + 0.2), vec3<f32>(0.0, 0.0, 3.0), 0.6, K_SPLASH, 0.0, seed ^ 0x5au);
        parts[id.x].p.w = 0.0;
        return;
      }
      // grime keeps its pollution and lies where it lands
      pos.z = ground;
      resting = true;
    } else if (kind == K_DUST) {
      // lands: drops its pollution, then lies on the ground a while
      depositAt(pos, P.v.w);
      P.v.w = 0.0;
      if (water[ci] > 0.02) { parts[id.x].p.w = 0.0; return; }
      pos.z = ground;
      if (!resting) { life = max(life, 20.0 + sr * 25.0); }
      resting = true;
    } else
    if (kind == K_LITTER) {
      if (water[ci] > 0.05) {
        // swept into water: its pollution washes off into the stream
        depositAt(pos, P.v.w);
        parts[id.x].p.w = 0.0;
        return;
      }
      pos.z = ground;
      resting = true;
    } else if (kind == K_SEED) {
      // lands: the seed takes (whatever the ground is like — on bad ground it
      // will wither) and its roots work the soil a little: a pinch of poison
      // around it is broken down (round 10: seeds that clean, so wind over
      // trees and flowers, and birds, matter)
      if (water[ci] < 0.05 && moisture[ci] > 0.05) {
        veg[ci] = max(veg[ci], select(veg[ci] + 0.15, 0.5, veg[ci] == 0.0));
        for (var k = 0u; k < 5u; k++) {
          let q = select(cell + DIRS[min(k, 3u)], cell, k == 4u);
          if (!inMap(q)) { continue; }
          let j = colIdxI(q);
          let take = min(contam[j].x * 0.25, 0.05);
          if (take > 0.001) { atomicSub(&contamDelta[j], i32(take * FIX)); }
        }
        spawnFull(vec3<f32>(pos.xy, ground + 0.2), vec3<f32>(0.0, 0.0, 1.0), 1.0, K_SPARK, 0.0, seed ^ 0x5eu, 0u, 0u);
        spawnFull(vec3<f32>(pos.xy, ground + 0.5), vec3<f32>(0.0), 0.9, K_GLOW, 0.0, seed ^ 0x61u, 0u, 0u);
      }
      parts[id.x].p.w = 0.0;
      return;
    } else if (kind == K_LEAF) {
      // settles and waits for the next gust
      if (!resting) { life = clamp(life, 20.0, 40.0); }
      pos.z = ground;
      resting = true;
    } else {
      parts[id.x].p.w = 0.0;
      return;
    }
  }

  if (life <= 0.0) {
    // (birds keep their perch target in v.w, not a payload); oil smoke that
    // hung about until it died settles as soot
    if (kind == K_DUST || kind == K_LITTER || kind == K_SMOKE) { depositAt(pos, P.v.w); }
    parts[id.x].p.w = 0.0;
    return;
  }
  parts[id.x] = Particle(vec4<f32>(pos, life), vec4<f32>(vel, P.v.w), vec4<u32>(kind, seed, select(0u, 1u, resting), state));
}
