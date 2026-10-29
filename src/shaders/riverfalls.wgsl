// ---- riverfalls.wgsl (riverfalls, BACKLOG WF1, round 107) ------------------------------------------------------
// The held rivers' falls (render/riverfalls.ts): the user, on waterfalls in the atlas, "Yes or just fake it based on
// flow speed over gaps and make it a parabolic arc. Either way". A held river (riverheld.wgsl: the atlas's steady
// state, riverFlow) isn't simulated, so nothing in it falls; its fall was its water surface down the face, turned
// white where steep (render.wgsl steepW). Here, at the renderer's side, each lip of a river - a river column whose
// downstream neighbour's top (its water, or its ground) lies FALL_MIN or more under its water - throws its water off
// as the flow model's stream (liquid.wgsl prep's list, drawn by render.wgsl streamVertex / shadeStream: a curtain
// and a band along the parabola), with no simulation:
//  - the launch: along the held flow's heading, at its speed (riverFlow's, at the rivers' wetness), never slower than
//    the water's critical speed over a free overfall, sqrt(g d) (a lip passes the flow through its critical depth),
//    and no faster than FALL_UMAX; level (vz 0) off the lip's edge at the water's level;
//  - gravity: the world's (common.wgsl WORLD_G, DECISIONS round 106);
//  - its width: render.wgsl streamWidth from the volume a second the column throws (depth x speed: the discharge
//    across a cell's width), so the lip's columns' curtains join into one sheet as wide as the river;
//  - its end: where the arc meets the columns under it (a column's top: its water, or its ground), marched along
//    the path and bisected; past the window's edge or FALL_T_MAX seconds it just ends;
//  - spray along the path, splash and mist at the foot: liquid.wgsl prep's, budgeted by the discharge (and the
//    particle ring's size), only for the falls on screen.
// Only the columns the view can see are looked at, every tick, and only the falls on screen are listed: near the
// player's view only.
// Reads the contract only: surface, water, the drift, riverFlow; writes its own list and the particle ring.
@group(0) @binding(4) var<storage, read> surface: array<u32>;
@group(0) @binding(5) var<storage, read> water: array<f32>;
@group(0) @binding(22) var riverFlowTex: texture_2d<f32>;
struct PartF { p: vec4<f32>, v: vec4<f32>, m: vec4<u32> };
@group(0) @binding(12) var<storage, read_write> parts: array<PartF>;
@group(0) @binding(13) var<storage, read_write> counters: array<atomic<u32>>;
// the stream list (liquid.wgsl prep's layout): a header a stream in the first third, two vec4 after it
@group(0) @binding(29) var<storage, read_write> inst: array<vec4<u32>>;
// drawIndirect's args: vertex count, instance count, first vertex, first instance
@group(0) @binding(30) var<storage, read_write> indirect: array<atomic<u32>>;
// how many falls' columns the last tick listed (the spray's share: FALL_SPRAY_COLS)
@group(0) @binding(32) var<storage, read> listedPrev: array<u32>;
// the view (render.wgsl Camera's first fields)
struct FallCam {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  viewport: vec4<f32>,
};
@group(0) @binding(31) var<uniform> FC: FallCam;
// the window's columns dispatched over: x0, y0, w, h (render/riverfalls.ts: what the fixed view can see; the whole
// window for the free camera)
@group(0) @binding(33) var<uniform> FR: vec4<u32>;

/** a drop to the next column's top of this much (cells) is a fall (the flow model's LQ_DROP is 1.25) */
const FALL_MIN: f32 = 1.5;
/** a lip throwing less than this (cells³ a second) isn't drawn */
const FALL_RATE_MIN: f32 = 0.05;
/** the launch's speed at most (cells/s): the table's speed is a channel's, quickened down rapids */
const FALL_UMAX: f32 = 6.0;
/** the longest fall drawn (s), and the path's step (cells along it) while looking for where it lands */
const FALL_T_MAX: f32 = 3.0;
const FALL_STEP: f32 = 0.5;
/** an arc that meets a column this soon (s) ran into the bank beside the lip, not over a drop: not drawn */
const FALL_T_MIN: f32 = 0.3;
/** render.wgsl WATER_MIN_R: a column wetter than this is water */
const FALL_WET: f32 = 0.012;
/** a margin round the screen, clip units */
const FALL_PAD: f32 = 0.1;
/** the spray's budget: as much as this many columns' full share (liquid.wgsl prep's per column), shared out over
 *  the columns on screen - a wide river's lip is a hundred columns or more, the particle ring is shared */
const FALL_SPRAY_COLS: f32 = 24.0;
/** the water's material and the stream's flags (render.wgsl FLAG_RUN | FLAG_DETAIL; liquid.wgsl LQ_MAT, FLAG_RUN_Q) */
const FALL_MAT: u32 = 8u;
const FALL_FLAGS: u32 = 2048u | 128u;
/** the particles' kinds (particles.wgsl K_DROP, K_SPLASH, K_SMOKE) and the mist's smoke state (liquid.wgsl MIST_Q) */
const FK_DROP: u32 = 24u;
const FK_SPLASH: u32 = 7u;
const FK_SMOKE: u32 = 8u;
const FALL_MIST: u32 = 3u;

/** column q's top (x: its water's level, or its ground where dry) and its water's depth (y) */
fn fallTop(q: vec2<i32>) -> vec2<f32> {
  let i = colIdxI(q);
  let d = water[i];
  return vec2<f32>(f32(sfZ(surface[i])) + driftAt(q) + max(d, 0.0), d);
}

/** the stream's point t seconds off the lip (render.wgsl streamAt, vz 0) */
fn fallAt(e: vec3<f32>, u: vec2<f32>, t: f32) -> vec3<f32> { return vec3<f32>(e.xy + u * t, e.z - 0.5 * WORLD_G * t * t); }

/** has the arc at t come down onto (or into) a column other than the lip's? */
fn fallUnder(e: vec3<f32>, u: vec2<f32>, t: f32, lip: vec2<i32>) -> bool {
  let a = fallAt(e, u, t);
  let c = cellAt(a.xy);
  if (all(c == lip)) { return false; }
  if (!inMap(c)) { return false; }
  return a.z <= fallTop(c).x;
}

fn fallOnScreen(a: vec3<f32>, b: vec3<f32>) -> bool {
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  let ps = array<vec3<f32>, 2>(a, b);
  for (var k = 0u; k < 2u; k++) {
    let q = FC.viewProj * vec4<f32>(ps[k], 1.0);
    if (q.w <= 1e-3) { return true; }
    let n = q.xy / q.w;
    lo = min(lo, n);
    hi = max(hi, n);
  }
  return all(hi > vec2<f32>(-1.0 - FALL_PAD)) && all(lo < vec2<f32>(1.0 + FALL_PAD));
}

fn spawnF(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, seed: u32, state: u32) {
  let k = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[k] = PartF(vec4<f32>(pos, life), vec4<f32>(vel, 0.0), vec4<u32>(kind, seed, 0u, state));
}
fn rndF(i: u32, salt: u32) -> f32 { return f32(hash3(i, G.tick, salt) >> 8u) / 16777216.0; }

@compute @workgroup_size(8, 8)
fn falls(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= FR.z || id.y >= FR.w) { return; }
  let q = id.xy + FR.xy;
  if (q.x >= G.mapW || q.y >= G.mapH) { return; }
  let p = vec2<i32>(q);
  // (a heightfield chunk's water is the LOD rings', not the window's)
  if (heightfieldCol(q)) { return; }
  let r = riverHere(q);
  if (!r.on) { return; }
  let me = fallTop(p);
  let d = me.y;
  if (d < RIVER_DRY) { return; }
  // (the table's flow: cells a 60 Hz step)
  let v = r.vel * 60.0;
  let sp = length(v);
  if (sp < 1e-3) { return; }
  let u = v / sp;
  // the neighbours downstream and upstream: the directions closest to the heading and against it
  var kd = 0u;
  var ku = 0u;
  var bd = -2.0;
  var bu = 2.0;
  for (var k = 0u; k < NDIR; k++) {
    let c = dot(DIRV[k], u);
    if (c > bd) { bd = c; kd = k; }
    if (c < bu) { bu = c; ku = k; }
  }
  let qd = nbr(p, kd);
  if (!inMap(qd)) { return; }
  let drop = me.x - fallTop(qd).x;
  if (drop < FALL_MIN) { return; }
  // (the fall's top only: a column down its face, under a lip, is the lip's stream's)
  let qu = nbr(p, ku);
  if (inMap(qu)) {
    let up = fallTop(qu);
    if (up.y > RIVER_DRY && up.x - me.x >= FALL_MIN) { return; }
  }
  let s = min(max(sp, sqrt(WORLD_G * d)), FALL_UMAX);
  let uv = u * s;
  // the volume a second it throws: its depth at its speed, across a cell
  let rate = d * s;
  if (rate < FALL_RATE_MIN) { return; }
  // off the lip's edge on the downstream side, at the water's level
  let e = vec3<f32>(cellPos(p) + DIRV[kd] * 0.5, me.x);
  // where it lands: marched along the path a FALL_STEP at a time, then bisected
  var tEnd = FALL_T_MAX;
  var landed = false;
  var t0 = 0.0;
  var t = 0.0;
  for (var n = 0u; n < 128u; n++) {
    t += FALL_STEP / max(length(vec2<f32>(s, WORLD_G * t)), 1.0);
    if (t >= FALL_T_MAX) { break; }
    let a = fallAt(e, uv, t);
    if (!inMap(cellAt(a.xy))) { tEnd = t; break; }
    if (fallUnder(e, uv, t, p)) {
      var lo = t0;
      var hi = t;
      for (var b = 0u; b < 5u; b++) {
        let m = 0.5 * (lo + hi);
        if (fallUnder(e, uv, m, p)) { hi = m; } else { lo = m; }
      }
      tEnd = hi;
      landed = true;
      break;
    }
    t0 = t;
  }
  if (tEnd < FALL_T_MIN) { return; }
  let foot = fallAt(e, uv, tEnd);
  if (!fallOnScreen(e, foot)) { return; }
  let cap = arrayLength(&inst) / 3u;
  let k = atomicAdd(&indirect[1], 1u);
  if (k >= cap) { return; }
  // (liquid.wgsl prep's stream: the column, z and vz it enters with, mat | flags; where it enters, its velocity; how
  // far along its path it's drawn, its time since the lip, the volume a second, its heat)
  inst[k] = vec4<u32>(q.x | (q.y << 12u), bitcast<u32>(e.z), bitcast<u32>(0.0), FALL_MAT | (FALL_FLAGS << 8u));
  inst[cap + 2u * k] = vec4<u32>(bitcast<u32>(e.x), bitcast<u32>(e.y), bitcast<u32>(uv.x), bitcast<u32>(uv.y));
  inst[cap + 2u * k + 1u] = vec4<u32>(bitcast<u32>(tEnd), bitcast<u32>(0.0), bitcast<u32>(rate), 0u);

  // spray along the path (liquid.wgsl prep's): drops set off on the stream's own path, looser the longer it's fallen
  let i = colIdxI(p);
  let side = vec2<f32>(-u.y, u.x);
  let width = mix(0.35, 1.3, smoothstep(0.05, 1.5, rate));
  // (the spray's share of the particle ring - the high tier's 65536: all of it - a 60 Hz tick's worth)
  let budget = min(f32(arrayLength(&parts)) / 65536.0, 1.0) * simStep() * min(1.0, FALL_SPRAY_COLS / max(f32(listedPrev[0]), 1.0));
  let nD = select(0.0, min(rate * 0.35, 1.5) * budget, rate > 0.2);
  let nI = u32(nD) + select(0u, 1u, rndF(i, 0x81u) < fract(nD));
  for (var j = 0u; j < nI; j++) {
    let h = hash3(i, G.tick, 0x90u + j * 31u);
    let a = f32(h & 1023u) / 1023.0;
    let b = f32((h >> 10u) & 1023u) / 1023.0 - 0.5;
    let c = f32((h >> 20u) & 1023u) / 1023.0 - 0.5;
    let ta = a * tEnd;
    let loose = 0.1 + 0.4 * min(ta, 1.5);
    let at = fallAt(e, uv, ta) + vec3<f32>(side * b * width, 0.0);
    let vel = vec3<f32>(uv + side * b * loose + uv * c * 0.15, -WORLD_G * ta + c * loose);
    spawnF(at, vel, 4.0, FK_DROP, h, 0u);
  }
  // where it lands: splash thrown up and out, mist drifting off - more for more water falling harder
  if (landed) {
    let hit = WORLD_G * tEnd;
    let ft = foot + vec3<f32>(0.0, 0.0, 0.05);
    let nS = min(rate * hit * 0.03, 3.0) * budget;
    let nSI = u32(nS) + select(0u, 1u, rndF(i, 0x73u) < fract(nS));
    for (var j = 0u; j < nSI; j++) {
      let h = hash3(i, G.tick, 0xa0u + j * 17u);
      let ang = f32(h & 1023u) / 1023.0 * 6.2832;
      let sp2 = 0.6 + f32((h >> 10u) & 1023u) / 1023.0 * min(hit * 0.18, 3.0);
      let up = 1.0 + f32((h >> 20u) & 1023u) / 1023.0 * min(hit * 0.4, 7.0);
      let dir = vec2<f32>(cos(ang), sin(ang));
      spawnF(ft + vec3<f32>(dir * width * 0.4, 0.0), vec3<f32>(dir * sp2 + uv * 0.25, up), 0.9, FK_SPLASH, h, 0u);
    }
    if (rate > 0.2 && rndF(i, 0x75u) < min(rate * hit * 0.002, 0.15) * budget) {
      let h = hash3(i, G.tick, 0x76u);
      let rr = vec2<f32>(f32(h & 255u), f32((h >> 8u) & 255u)) / 255.0 - 0.5;
      spawnF(ft + vec3<f32>(rr * width, 0.3), vec3<f32>(rr * 1.5 + uv * 0.2, 0.6), 2.6, FK_SMOKE, h, FALL_MIST);
    }
  }
}
