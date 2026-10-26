// ---- liquid.wgsl: liquids as runs in the columns (?flow=1; src/flow/liquid.ts, docs/ARCHITECTURE.md "The flow model") ----------------
// One kernel set for every liquid; a material is a handful of constants the including TS prepends (LQ_*):
// how far it spreads sideways (gain, friction), its yield (lava stops on a small step), how thin it thins out
// (thick), its heat (lava cools and sets into basalt), and the fall it takes as a drop (LQ_DROP).
//
// A column's empty space is its gaps: the air between two solid or granular intervals, and the open air on top
// (the top gap, floor = the column's top or a sleeping body on it). A liquid lies in a gap as a run on its floor:
// the open run (slot 0; its depth is the `open` buffer - for water the water contract itself, so every reader of
// `water` sees it) and up to three enclosed runs (slots 1..3: a cave's floor, a tunnel's). Rules per run, every
// tick, in the spirit of falling-sand games but on runs instead of pixels:
//  - sideways: toward each of the six neighbours, into the neighbour's gap that spans the run's height (the
//    highest such floor under the run's level), by the level difference; the flux keeps last tick's (momentum:
//    the pipe model's look). No gap there: a wall.
//  - down: where the neighbour's level lies more than LQ_DROP under the run's floor, what goes that way leaves
//    the ledge as a stream with the speed it had (flux / edge / depth) and falls ballistically: each tick a
//    stream's state moves on one column along its path (exit time from the hexagon, then z - g t^2 / 2), so a
//    steady outflow draws a steady parabola. It lands where its path meets the level under it (or a wall).
//  - what lands, flows in, springs or rains goes into the gap it arrives in; a run whose gap closed moves to
//    the gap above, two runs in a gap merge, a gap whose floor dropped takes its run down with it.
// Passes per tick: flux (A) -> jets (C) -> depth (B) -> publish (D); prep for the draw, every tick.
// Records carry the step they were written at (LQ.step): a column with nothing writes nothing, and what it
// wrote long ago reads as nothing. Ping-pong (runs, jets) by parity: the TS swaps the bind groups.
// Steady state (src/flow/steady.ts): depth adds per chunk the net change and the throughput (act); a frozen
// column next to an awake chunk checks its balance and flags its chunk perturbed.

@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> surface: array<u32>;
// the open run's depth (water: the water contract; lava: the flow module's own)
@group(0) @binding(5) var<storage, read_write> open: array<f32>;
// runs: 4 per column. slot 0: x the top gap's floor, y the open run's new depth (depth -> publish), z its
// heat, w stamp * 8 + enclosed count. slots 1..3: x floor, y depth, z heat, w 0
@group(0) @binding(6) var<storage, read> runsIn: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> runsOut: array<vec4<f32>>;
// flux: 2 per run slot: (f0..f3), (f4, f5, target codes, stamp) as u32 bits
@group(0) @binding(8) var<storage, read_write> fl: array<vec4<u32>>;
// per column: stamp << 6 | the directions a run falls off this step
@group(0) @binding(9) var<storage, read_write> emit: array<u32>;
@group(0) @binding(10) var<storage, read> oilL: array<f32>;
// per chunk: x net change, y throughput (both x 1e6, summed over its columns and ticks), z perturbed, w overflow
@group(0) @binding(11) var<storage, read_write> act: array<atomic<u32>>;
struct PartQ { p: vec4<f32>, v: vec4<f32>, m: vec4<u32> };
@group(0) @binding(12) var<storage, read_write> parts: array<PartQ>;
@group(0) @binding(13) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(14) var<storage, read_write> waterPrevL: array<f32>;
@group(0) @binding(16) var<storage, read> waterSourceL: array<f32>;
@group(0) @binding(19) var<storage, read_write> fluxC: array<Dirs>;
// (lava's publish: the water it boils)
@group(0) @binding(20) var<storage, read_write> waterB: array<f32>;
// jets, in (last step's, or this step's for depth and prep) and out:
//   j0: volume, z it enters at, vz as it leaves, heat
//   j1: velocity xy (cells/s), where it enters the next column (offset from its centre)
//   j2: way out (0..5; 6 landed here; 7 off the map), z it leaves (or lands) at, -, stamp
@group(0) @binding(22) var j0In: texture_2d<f32>;
@group(0) @binding(23) var j1In: texture_2d<f32>;
@group(0) @binding(24) var j2In: texture_2d<f32>;
@group(0) @binding(25) var j0Out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(26) var j1Out: texture_storage_2d<rgba32float, write>;
@group(0) @binding(27) var j2Out: texture_storage_2d<rgba32float, write>;
// draw lists: runs under rock and falling streams (water pipeline); the open lava (opaque pipeline, lava's form)
@group(0) @binding(29) var<storage, read_write> inst: array<vec4<u32>>;
@group(0) @binding(30) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(31) var<storage, read_write> instO: array<vec4<u32>>;
@group(0) @binding(32) var<storage, read_write> indirectO: array<atomic<u32>>;

const MAX_SPRINGS: u32 = 8u;
struct LiquidU {
  // x step, y springs, z the steady wake tolerance (cells a tick), w unused
  step: vec4<u32>,
  // springs: x, y (world), z (height it pours in at), rate (cells^3/s)
  springs: array<vec4<f32>, 8>,
  // per chunk, this step only: a frozen chunk's flux rescaled by its supply (src/flow/steady.ts; 1 none, 0 dried up)
  scale: array<vec4<f32>, 512>,
};
@group(0) @binding(33) var<uniform> LQ: LiquidU;

const MAXG: u32 = 6u;
const NSLOT: u32 = 4u;
const C_FALL: u32 = 6u;
const C_DRAIN: u32 = 7u;
const C_WALL: u32 = 8u;
const EPS: f32 = 1e-5;
const GF: f32 = 14.0;
const EDGE: f32 = 0.57735;
const DTQ: f32 = 1.0 / 60.0;
const FLAG_RUN_Q: u32 = 2048u;
const FLAG_DETAIL_Q: u32 = 128u;
const K_SPLASH_Q: u32 = 7u;
const K_SMOKE_Q: u32 = 8u;

fn stepNow() -> u32 { return LQ.step.x & 0x3ffffu; }
fn stepPrev() -> u32 { return (LQ.step.x - 1u) & 0x3ffffu; }
fn stamp24(s: u32) -> u32 { return s & 0xffffffu; }
fn chunkOf(q: vec2<u32>) -> u32 { return (q.y / G.chunkSize) * G.chunksX + q.x / G.chunkSize; }
/** a frozen chunk's rescale this step (1: none) */
fn chunkScale(q: vec2<u32>) -> f32 {
  let c = chunkOf(q);
  if (c >= 2048u) { return 1.0; }
  return LQ.scale[c >> 2u][c & 3u];
}

// ---- gaps -------------------------------------------------------------------------------------------------
struct Gaps { n: u32, f: array<f32, 6>, c: array<f32, 6> };

fn gapPush(g: ptr<function, Gaps>, f: f32, c: f32) {
  if ((*g).n == MAXG) {
    for (var k = 1u; k < MAXG; k++) { (*g).f[k - 1u] = (*g).f[k]; (*g).c[k - 1u] = (*g).c[k]; }
    (*g).n = MAXG - 1u;
  }
  (*g).f[(*g).n] = f;
  (*g).c[(*g).n] = c;
  (*g).n += 1u;
}

/** Column q's gaps, bottom to top (the topmost MAXG); the last is the open air. */
fn gapsAt(q: vec2<i32>) -> Gaps {
  var g: Gaps;
  g.n = 0u;
  let cs = colSlots(u32(q.x), u32(q.y));
  var top = -1.0;
  for (var s = 0u; s < cs.y; s++) {
    let v = layers[cs.x + s];
    if (ivEmpty(v)) { break; }
    let st = matState(ivMat(v));
    if (st != ST_SOLID && st != ST_GRANULAR) { continue; }
    if (top >= 0.0 && ivZ0(v) > top + 0.02) { gapPush(&g, top, ivZ0(v)); }
    top = max(top, ivZ1(v));
  }
  gapPush(&g, max(max(top, 0.0), bodyTopAt(q)), 1e9);
  return g;
}

/** The gap holding height z, or -1 (inside the ground). */
fn gapAtZ(g: Gaps, z: f32) -> i32 {
  for (var k = 0u; k < g.n; k++) { if (z >= g.f[k] - 0.01 && z < g.c[k]) { return i32(k); } }
  return -1;
}

/** The gap a run on floor z belongs to: the one holding it, else the next above (its gap closed: pushed up). */
fn gapForRun(g: Gaps, z: f32) -> u32 {
  let k = gapAtZ(g, z + 0.05);
  if (k >= 0) { return u32(k); }
  for (var m = 0u; m < g.n; m++) { if (g.f[m] > z) { return m; } }
  return g.n - 1u;
}

// ---- a column's runs ----------------------------------------------------------------------------------------
struct Runs { n: u32, fl: array<f32, 4>, d: array<f32, 4>, h: array<f32, 4> };

fn runsAt(i: u32, want: u32) -> Runs {
  var r: Runs;
  let r0 = runsIn[i * NSLOT];
  let ok = (u32(r0.w) >> 3u) == want;
  r.d[0] = open[i];
  r.fl[0] = r0.x;
  r.h[0] = select(LQ_HOT, r0.z, ok);
  r.n = select(0u, u32(r0.w) & 7u, ok);
  for (var s = 1u; s < NSLOT; s++) {
    r.d[s] = 0.0;
    if (s <= r.n) {
      let v = runsIn[i * NSLOT + s];
      r.fl[s] = v.x;
      r.d[s] = v.y;
      r.h[s] = v.z;
    }
  }
  return r;
}

/** Depth of column q's run lying in its gap m (gaps g, runs r). */
fn depthInGap(g: Gaps, r: Runs, m: u32) -> f32 {
  if (m == g.n - 1u) { return r.d[0]; }
  for (var s = 1u; s <= r.n; s++) { if (gapForRun(g, r.fl[s]) == m) { return r.d[s]; } }
  return 0.0;
}

fn fluxGet(i: u32, s: u32) -> array<f32, 8> {
  let a = fl[(i * NSLOT + s) * 2u];
  let b = fl[(i * NSLOT + s) * 2u + 1u];
  return array<f32, 8>(bitcast<f32>(a.x), bitcast<f32>(a.y), bitcast<f32>(a.z), bitcast<f32>(a.w), bitcast<f32>(b.x), bitcast<f32>(b.y), bitcast<f32>(b.z), bitcast<f32>(b.w));
}
fn fluxStamp(i: u32, s: u32) -> u32 { return fl[(i * NSLOT + s) * 2u + 1u].w; }
fn fluxCodes(i: u32, s: u32) -> u32 { return fl[(i * NSLOT + s) * 2u + 1u].z; }
fn fluxDir(i: u32, s: u32, k: u32) -> f32 {
  let v = fl[(i * NSLOT + s) * 2u + k / 4u];
  return bitcast<f32>(v[k % 4u]);
}

/** How freely the run flows (0..1): lava by its heat, and thin runs barely (LQ_THICK). */
fn fluidity(d: f32, h: f32) -> f32 {
  var f = 1.0;
  if (LQ_THICK > 0.0) { let t = min(d / LQ_THICK, 1.0); f = t * t; }
  if (LQ_SET > 0.0) { f *= smoothstep(LQ_SET, LQ_RUNNY, h); }
  return f;
}

/** A run's floor: the open run's is the top gap's. */
fn runFloor(g: Gaps, r: Runs, s: u32) -> f32 { return select(r.fl[s], g.f[g.n - 1u], s == 0u); }

/** The open water's head carries the oil floating on it. */
fn oilHead(i: u32, s: u32) -> f32 {
  if (!LQ_WATER || s != 0u) { return 0.0; }
  return oilL[i] * 0.88;
}

// ---- A: flux -------------------------------------------------------------------------------------------------
@compute @workgroup_size(8, 8)
fn flux(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let r = runsAt(i, stepPrev());
  var has = r.d[0] > EPS;
  for (var s = 1u; s <= r.n; s++) { has = has || r.d[s] > EPS; }
  if (!has) { return; }
  let now = stepNow();
  // (asleep: last step's flux carried on, stamped for this one)
  // (its supply changed: the flux it keeps rescaled, no simulation; zero, it has dried up)
  if (flowFrozen(id.xy, FLOW_N)) {
    let sc = chunkScale(id.xy);
    for (var s = 0u; s <= r.n; s++) {
      let o = (i * NSLOT + s) * 2u;
      if (fluxStamp(i, s) != stepPrev()) { continue; }
      if (sc != 1.0) {
        let a = fl[o];
        let b = fl[o + 1u];
        fl[o] = vec4<u32>(bitcast<u32>(bitcast<f32>(a.x) * sc), bitcast<u32>(bitcast<f32>(a.y) * sc), bitcast<u32>(bitcast<f32>(a.z) * sc), bitcast<u32>(bitcast<f32>(a.w) * sc));
        fl[o + 1u] = vec4<u32>(bitcast<u32>(bitcast<f32>(b.x) * sc), bitcast<u32>(bitcast<f32>(b.y) * sc), b.z, now);
      } else {
        fl[o + 1u].w = now;
      }
    }
    let e = emit[i];
    if ((e >> 6u) == stamp24(stepPrev())) { emit[i] = (stamp24(now) << 6u) | select(e & 63u, 0u, sc == 0.0); }
    return;
  }
  let g = gapsAt(p);
  var em = 0u;
  for (var s = 0u; s <= r.n; s++) {
    let d = r.d[s];
    let o = (i * NSLOT + s) * 2u;
    if (d <= EPS) { fl[o] = vec4<u32>(0u); fl[o + 1u] = vec4<u32>(0u, 0u, 0x888888u, now); continue; }
    let fz = runFloor(g, r, s);
    let H = fz + d + oilHead(i, s);
    let fluid = fluidity(d, r.h[s]);
    var prev = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    if (fluxStamp(i, s) == stepPrev()) { prev = fluxGet(i, s); }
    var f = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var codes = 0u;
    for (var k = 0u; k < NDIR; k++) {
      let q = nbr(p, k);
      var code = C_WALL;
      var Hn = H;
      if (!inMap(q)) {
        code = C_DRAIN;
        Hn = max(fz, G.ocean.x);
      } else {
        let gq = gapsAt(q);
        // the neighbour's gap open across the run's height: the highest floor under its level
        var tg = -1;
        for (var m = 0u; m < gq.n; m++) {
          if (gq.f[m] < H && gq.c[m] > fz + 0.05) {
            if (tg < 0 || gq.f[m] > gq.f[u32(tg)]) { tg = i32(m); }
          }
        }
        if (tg >= 0) {
          let j = colIdxI(q);
          let rq = runsAt(j, stepPrev());
          let m = u32(tg);
          Hn = gq.f[m] + depthInGap(gq, rq, m) + select(0.0, oilL[j] * 0.88, LQ_WATER && m == gq.n - 1u);
          code = m;
          // far under the run's floor: off the ledge (the head over the lip is its depth)
          if (Hn < fz - LQ_DROP) { code = C_FALL; Hn = fz; }
        }
      }
      if (code != C_WALL) {
        f[k] = max(0.0, prev[k] * LQ_FRIC + LQ_GAIN * fluid * (H - Hn - LQ_YIELD));
        if (fluid <= 0.0) { f[k] = 0.0; }
      }
      codes |= code << (4u * k);
    }
    var total = 0.0;
    for (var k = 0u; k < NDIR; k++) { total += f[k]; }
    if (total > d) { for (var k = 0u; k < NDIR; k++) { f[k] *= d / total; } }
    for (var k = 0u; k < NDIR; k++) {
      if (((codes >> (4u * k)) & 15u) == C_FALL && f[k] > 1e-7) { em |= 1u << k; }
    }
    fl[o] = vec4<u32>(bitcast<u32>(f[0]), bitcast<u32>(f[1]), bitcast<u32>(f[2]), bitcast<u32>(f[3]));
    fl[o + 1u] = vec4<u32>(bitcast<u32>(f[4]), bitcast<u32>(f[5]), codes, now);
  }
  emit[i] = (stamp24(now) << 6u) | em;
}

// ---- C: jets -------------------------------------------------------------------------------------------------
struct Jet { vol: f32, z: f32, vz: f32, heat: f32, u: vec2<f32>, p: vec2<f32> };

fn jetAdd(a: ptr<function, Jet>, v: f32, z: f32, vz: f32, h: f32, u: vec2<f32>, p: vec2<f32>) {
  (*a).vol += v;
  (*a).z += v * z;
  (*a).vz += v * vz;
  (*a).heat += v * h;
  (*a).u += v * u;
  (*a).p += v * p;
}

@compute @workgroup_size(8, 8)
fn jets(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let now = stepNow();
  // (asleep: the stream it had, kept as it is: drawn falling)
  if (flowFrozen(id.xy, FLOW_N)) {
    let j2 = textureLoad(j2In, p, 0);
    let sc = chunkScale(id.xy);
    if (u32(j2.w) == stamp24(stepPrev()) && sc > 0.0) {
      let j0 = textureLoad(j0In, p, 0);
      textureStore(j0Out, p, vec4<f32>(j0.x * sc, j0.yzw));
      textureStore(j1Out, p, textureLoad(j1In, p, 0));
      textureStore(j2Out, p, vec4<f32>(j2.xyz, f32(stamp24(now))));
    }
    return;
  }
  var a: Jet;
  a.vol = 0.0; a.z = 0.0; a.vz = 0.0; a.heat = 0.0; a.u = vec2<f32>(0.0); a.p = vec2<f32>(0.0);
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (!inMap(q)) { continue; }
    // a stream coming on from the neighbour
    let j2 = textureLoad(j2In, q, 0);
    if (u32(j2.w) == stamp24(stepPrev()) && u32(j2.x) == (k ^ 1u)) {
      let j0 = textureLoad(j0In, q, 0);
      let j1 = textureLoad(j1In, q, 0);
      jetAdd(&a, j0.x, j2.y, j0.z, j0.w, j1.xy, j1.zw);
    }
    // a run falling off the neighbour's ledge toward me
    let j = colIdxI(q);
    let e = emit[j];
    if ((e >> 6u) != stamp24(now) || ((e >> (k ^ 1u)) & 1u) == 0u) { continue; }
    let gq = gapsAt(q);
    let rq = runsAt(j, stepPrev());
    for (var s = 0u; s <= rq.n; s++) {
      if (fluxStamp(j, s) != now || ((fluxCodes(j, s) >> (4u * (k ^ 1u))) & 15u) != C_FALL) { continue; }
      let f = fluxDir(j, s, k ^ 1u);
      if (f <= 1e-7) { continue; }
      let d = rq.d[s];
      let dir = DIRV[k ^ 1u];
      // (off the lip at the critical flow's speed for its discharge a unit of edge, (g q)^(1/3): the pipe model's
      // depth at a lip is a grid artefact, its discharge isn't; a little more, for the spectacle)
      let speed = clamp(2.0 * pow(GF * f * 60.0 / EDGE, 1.0 / 3.0), 0.6, 12.0);
      jetAdd(&a, f, runFloor(gq, rq, s) + d * 0.5, 0.0, rq.h[s], dir * speed, -dir * 0.5);
    }
  }
  if (a.vol <= 1e-8) { return; }
  let jt = Jet(a.vol, a.z / a.vol, a.vz / a.vol, a.heat / a.vol, a.u / a.vol, a.p / a.vol);
  // the level under it here
  let g = gapsAt(p);
  let r = runsAt(colIdxI(p), stepPrev());
  var gz = gapAtZ(g, jt.z);
  if (gz < 0) { gz = i32(gapForRun(g, jt.z)); }
  let zL = g.f[u32(gz)] + depthInGap(g, r, u32(gz));
  // when it leaves the hexagon, and which way
  var T = 1e9;
  var kx = 6u;
  for (var k = 0u; k < NDIR; k++) {
    let sk = dot(jt.u, DIRV[k]);
    if (sk > 1e-4) {
      let t = max((0.5 - dot(jt.p, DIRV[k])) / sk, 0.0);
      if (t < T) { T = t; kx = k; }
    }
  }
  // when it reaches the level under it
  let dz = jt.z - zL;
  var tl = 0.0;
  if (dz > 0.0) { tl = (jt.vz + sqrt(jt.vz * jt.vz + 2.0 * GF * dz)) / GF; }
  var way = 6u;
  var zx = zL;
  var t = tl;
  if (tl > T) {
    t = T;
    zx = jt.z + jt.vz * T - 0.5 * GF * T * T;
    way = kx;
    let q = nbr(p, kx);
    if (!inMap(q)) { way = 7u; }
    // (a wall in the way: it runs down the face, landing here)
    else if (gapAtZ(gapsAt(q), zx) < 0) { way = 6u; zx = zL; t = tl; }
  }
  let ex = jt.p + jt.u * t;
  let pn = select(ex, ex - DIRV[min(way, 5u)], way < 6u);
  textureStore(j0Out, p, vec4<f32>(jt.vol, jt.z, jt.vz - GF * t, jt.heat));
  textureStore(j1Out, p, vec4<f32>(jt.u, pn));
  textureStore(j2Out, p, vec4<f32>(f32(way), zx, t, f32(stamp24(now))));
}

// ---- B: depth ------------------------------------------------------------------------------------------------
fn outSum(i: u32, s: u32) -> f32 {
  if (fluxStamp(i, s) != stepNow()) { return 0.0; }
  let f = fluxGet(i, s);
  return f[0] + f[1] + f[2] + f[3] + f[4] + f[5];
}

// (net: the column's net flow, a vector: the river's discharge through it, nothing for water sloshing in a pool)
struct Gather { dep: array<f32, 6>, hv: array<f32, 6>, inflow: f32, outflow: f32, old: array<f32, 6>, net: vec2<f32> };

/** What column p's gaps hold after this step: own runs less their outflow, plus what flows, lands and springs in. */
fn gather(p: vec2<i32>, g: Gaps, r: Runs) -> Gather {
  let i = colIdxI(p);
  var o: Gather;
  for (var m = 0u; m < MAXG; m++) { o.dep[m] = 0.0; o.hv[m] = 0.0; o.old[m] = 0.0; }
  o.inflow = 0.0;
  o.outflow = 0.0;
  o.net = vec2<f32>(0.0);
  for (var s = 0u; s <= r.n; s++) {
    let m = select(gapForRun(g, r.fl[s]), g.n - 1u, s == 0u);
    let out = min(outSum(i, s), r.d[s]);
    if (fluxStamp(i, s) == stepNow() && out > 0.0) {
      let fv = fluxGet(i, s);
      for (var k = 0u; k < NDIR; k++) { o.net += fv[k] * DIRV[k]; }
    }
    o.old[m] += r.d[s];
    o.dep[m] += r.d[s] - out;
    o.hv[m] += (r.d[s] - out) * r.h[s];
    o.outflow += out;
  }
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let rq = runsAt(j, stepPrev());
    for (var s = 0u; s <= rq.n; s++) {
      if (rq.d[s] <= EPS || fluxStamp(j, s) != stepNow()) { continue; }
      let code = (fluxCodes(j, s) >> (4u * (k ^ 1u))) & 15u;
      if (code >= g.n) { continue; }
      let f = fluxDir(j, s, k ^ 1u);
      o.dep[code] += f;
      o.hv[code] += f * rq.h[s];
      o.inflow += f;
      o.net += f * DIRV[k ^ 1u];
    }
  }
  // a stream landing here (this step's jets)
  let j2 = textureLoad(j2In, p, 0);
  if (u32(j2.w) == stamp24(stepNow()) && u32(j2.x) == 6u) {
    let j0 = textureLoad(j0In, p, 0);
    var m = gapAtZ(g, j2.y + 0.01);
    if (m < 0) { m = i32(gapForRun(g, j2.y)); }
    o.dep[u32(m)] += j0.x;
    o.hv[u32(m)] += j0.x * j0.w;
    o.inflow += j0.x;
  }
  for (var s = 0u; s < LQ.step.y; s++) {
    let sp = LQ.springs[s];
    if (any(cellAt(sp.xy) != p)) { continue; }
    var m = gapAtZ(g, sp.z);
    if (m < 0) { m = i32(gapForRun(g, sp.z)); }
    let v = sp.w * DTQ;
    o.dep[u32(m)] += v;
    o.hv[u32(m)] += v * LQ_HOT;
    o.inflow += v;
  }
  return o;
}

@compute @workgroup_size(8, 8)
fn depth(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let now = stepNow();
  let r = runsAt(i, stepPrev());
  let ch = chunkOf(id.xy);
  let bed = sfZ(surface[i]) + driftAt(p);
  if (flowFrozen(id.xy, FLOW_N)) {
    // (asleep: carried through; on the edge of an awake chunk, its balance checked)
    let r0 = runsIn[i * NSLOT];
    if ((u32(r0.w) >> 3u) == stepPrev()) {
      for (var s = 0u; s <= r.n; s++) { runsOut[i * NSLOT + s] = runsIn[i * NSLOT + s]; }
      runsOut[i * NSLOT] = vec4<f32>(r0.x, r.d[0], r0.z, f32(now * 8u + r.n));
    }
    var edge = false;
    for (var k = 0u; k < NDIR; k++) {
      let q = nbr(p, k);
      if (inMap(q) && !asleep(vec2<u32>(q))) { edge = true; }
    }
    // (asleep, the chunk's x and y count its edge's inflow and outflow instead: their ratio rescales it)
    if (edge) {
      let g = gapsAt(p);
      let o = gather(p, g, r);
      if (o.inflow + o.outflow > 0.0) {
        atomicAdd(&act[ch * 4u], u32(min(o.inflow * 1e6, 1e8)));
        atomicAdd(&act[ch * 4u + 1u], u32(min(o.outflow * 1e6, 1e8)));
      }
      if (abs(o.inflow - o.outflow) > bitcast<f32>(LQ.step.z)) { atomicOr(&act[ch * 4u + 2u], 1u); }
    }
    return;
  }
  // (nothing here and nothing coming: only the bed kept, to tell the loose ground moving)
  var wet = r.d[0] > EPS || r.n > 0u;
  for (var k = 0u; k < NDIR && !wet; k++) {
    let q = nbr(p, k);
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    wet = open[j] > EPS || ((u32(runsIn[j * NSLOT].w) >> 3u) == stepPrev() && (u32(runsIn[j * NSLOT].w) & 7u) > 0u);
  }
  let j2 = textureLoad(j2In, p, 0);
  wet = wet || (u32(j2.w) == stamp24(now) && u32(j2.x) == 6u);
  for (var s = 0u; s < LQ.step.y; s++) { wet = wet || all(cellAt(LQ.springs[s].xy) == p); }
  let r0 = runsIn[i * NSLOT];
  let prevBed = select(bed, r0.x, (u32(r0.w) >> 3u) == stepPrev());
  if (abs(bed - prevBed) > 1e-4) { atomicAdd(&act[ch * 4u], u32(min(abs(bed - prevBed) * 1e6, 1e8))); }
  if (!wet) {
    runsOut[i * NSLOT] = vec4<f32>(bed, 0.0, LQ_HOT, f32(now * 8u));
    return;
  }
  let g = gapsAt(p);
  let o = gather(p, g, r);
  let top = g.n - 1u;
  // the enclosed runs: wet gaps under the top, lowest first; past three, the deepest kept (the rest counted)
  var n = 0u;
  var change = 0.0;
  for (var m = 0u; m < g.n; m++) { change += abs(o.dep[m] - o.old[m]); }
  for (var m = 0u; m < top; m++) {
    var d = o.dep[m];
    if (d < 2e-4) { continue; }
    if (n == 3u) {
      // (the shallowest of the four goes: counted, never silent)
      var lo = 1u;
      for (var s = 2u; s <= 3u; s++) { if (runsOut[i * NSLOT + s].y < runsOut[i * NSLOT + lo].y) { lo = s; } }
      let lost = min(runsOut[i * NSLOT + lo].y, d);
      atomicAdd(&act[ch * 4u + 3u], u32(lost * 1e6));
      if (runsOut[i * NSLOT + lo].y >= d) { continue; }
      runsOut[i * NSLOT + lo] = vec4<f32>(g.f[m], d, o.hv[m] / d, 0.0);
      continue;
    }
    n += 1u;
    runsOut[i * NSLOT + n] = vec4<f32>(g.f[m], d, o.hv[m] / d, 0.0);
  }
  let dt = max(o.dep[top], 0.0);
  runsOut[i * NSLOT] = vec4<f32>(g.f[top], dt, select(LQ_HOT, o.hv[top] / dt, dt > EPS), f32(now * 8u + n));
  atomicAdd(&act[ch * 4u], u32(min(change * 1e6, 1e8)));
  atomicAdd(&act[ch * 4u + 1u], u32(min(length(o.net) * (2.0 / f32(NDIR)) * 1e6, 1e8)));
}

// ---- D: publish ----------------------------------------------------------------------------------------------
const RAIN_RATE_Q: f32 = 0.0012;
const EVAP_Q: f32 = 0.00003;
const EVAP_DEEP_Q: f32 = 0.000002;

/** Water: the open runs into the water contract (as water_depth.wgsl: rain, springs, evaporation), the flux too. */
@compute @workgroup_size(8, 8)
fn publishWater(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let d = open[i];
  if (flowFrozen(id.xy, FLOW_N)) {
    waterPrevL[i] = d;
    let sc = chunkScale(id.xy);
    if (sc != 1.0) { fluxC[i] = dScale(fluxC[i], sc); }
    return;
  }
  let r0 = runsOut[i * NSLOT];
  var nd = select(d, r0.y, (u32(r0.w) >> 3u) == stepNow());
  nd += rainAt(cellPos(p)) * RAIN_RATE_Q * (1.0 - snowShare(airTempAt(sfZ(surface[i])))) + waterSourceL[i];
  nd = max(0.0, nd - select(EVAP_DEEP_Q, EVAP_Q, nd < 0.08));
  if (sfCount(surface[i]) == 0u) { nd = 0.0; }
  waterPrevL[i] = d;
  open[i] = nd;
  var f = dZero();
  if (d > EPS && fluxStamp(i, 0u) == stepNow()) {
    let v = fluxGet(i, 0u);
    for (var k = 0u; k < NDIR; k++) { f[k] = v[k]; }
  }
  fluxC[i] = f;
}

const LAVA_SET_RATE: f32 = 0.6;
const LAVA_BOIL: f32 = 0.8;
const LAVA_QUENCH: f32 = 2500.0;
const MAT_BASALT_Q: u32 = 23u;

fn spawnQ(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, seed: u32, state: u32) {
  let k = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[k] = PartQ(vec4<f32>(pos, life), vec4<f32>(vel, 0.0), vec4<u32>(kind, seed, 0u, state));
}
fn chanceQ(i: u32, salt: u32) -> f32 { return f32(hash3(i, G.tick, salt) >> 8u) / 16777216.0; }

/** Lay `dz` of basalt on the floor at z of column (x, y): onto basalt there, else a new interval. */
fn setBasalt(x: u32, y: u32, z: f32, dz: f32, ch: u32) {
  // (the layer writes counted: the cost report)
  atomicAdd(&act[arrayLength(&act) - 4u], 1u);
  let cs = colSlots(x, y);
  var n = 0u;
  while (n < cs.y && !ivEmpty(layers[cs.x + n])) { n += 1u; }
  // the interval the run lies on, and the first above it
  var r = 0u;
  while (r < n && ivZ1(layers[cs.x + r]) <= z + 0.05) { r += 1u; }
  if (r > 0u && ivMat(layers[cs.x + r - 1u]) == MAT_BASALT_Q && abs(ivZ1(layers[cs.x + r - 1u]) - z) < 0.05) {
    let v = layers[cs.x + r - 1u];
    var z1 = ivZ1(v) + dz;
    if (r < n) { z1 = min(z1, ivZ0(layers[cs.x + r])); }
    layers[cs.x + r - 1u] = ivPack(ivZ0(v), z1, MAT_BASALT_Q, ivAux(v));
    return;
  }
  if (n >= cs.y) { atomicAdd(&act[ch * 4u + 3u], u32(dz * 1e6)); return; }
  for (var s = n; s > r; s--) { layers[cs.x + s] = layers[cs.x + s - 1u]; }
  var z1 = z + dz;
  if (r < n) { z1 = min(z1, ivZ0(layers[cs.x + r + 1u])); }
  layers[cs.x + r] = ivPack(z, z1, MAT_BASALT_Q, 0u);
}

/** Lava: each run cools (thin fastest), boils the water over it, and below its setting point turns to basalt. */
@compute @workgroup_size(8, 8)
fn publishLava(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH || flowFrozen(id.xy, FLOW_N)) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let r0 = runsOut[i * NSLOT];
  if ((u32(r0.w) >> 3u) != stepNow()) { return; }
  let n = u32(r0.w) & 7u;
  let ch = chunkOf(id.xy);
  for (var s = 0u; s <= n; s++) {
    var v = runsOut[i * NSLOT + s];
    var d = v.y;
    if (d <= EPS) { if (s == 0u) { open[i] = 0.0; } continue; }
    var T = v.z * exp(-DTQ * LQ_COOL / max(d, 0.15));
    if (s == 0u) {
      let w = waterB[i];
      if (w > 1e-4 && T > 100.0) {
        let boil = min(w, LAVA_BOIL * DTQ * T / LQ_HOT);
        waterB[i] = w - boil;
        T = max(T - boil * LAVA_QUENCH / max(d, 0.1), 0.0);
        if (chanceQ(i, 0x55u) < min(boil * 40.0, 0.3)) {
          spawnQ(vec3<f32>(cellPos(p), v.x + d + 0.2), vec3<f32>(0.0, 0.0, 2.0), 7.0, K_SMOKE_Q, hash3(i, G.tick, 0x56u), 2u);
        }
      }
    }
    if (T < LQ_SET) {
      let dz = select(min(d, LAVA_SET_RATE * DTQ), d, d < 0.03);
      d -= dz;
      setBasalt(id.x, id.y, v.x, dz, ch);
      v.x += dz;
    }
    runsOut[i * NSLOT + s] = vec4<f32>(v.x, d, T, v.w);
    if (s == 0u) { open[i] = d; }
  }
}

// ---- prep: the draw lists, and spray where the streams land --------------------------------------------------
/** A box (quarter cells, render.wgsl unpackBox) centred on world point w, `q` quarter cells across. */
fn boxAt(cell: vec2<i32>, w: vec2<f32>, q: u32, z0: f32, z1: f32, mat: u32, flags: u32) -> vec4<u32> {
  let off = w - cellPos(cell);
  let fr = clamp(off / vec2<f32>(1.0, ROW_H) + 0.5, vec2<f32>(0.02), vec2<f32>(0.98));
  let cs = vec2<f32>(cell) + fr;
  let g = max(vec2<i32>(round(cs * 4.0 - f32(q) * 0.5)), vec2<i32>(0));
  return vec4<u32>(u32(g.x) | (u32(g.y) << 12u) | ((q - 1u) << 24u) | ((q - 1u) << 28u), bitcast<u32>(z0), bitcast<u32>(z1), mat | ((flags | FLAG_DETAIL_Q) << 8u));
}

@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let last = stepNow();
  let r0 = runsIn[i * NSLOT];
  let ok = (u32(r0.w) >> 3u) == last;
  // enclosed runs (under rock): flat prisms
  if (ok) {
    let n = u32(r0.w) & 7u;
    for (var s = 1u; s <= n; s++) {
      let v = runsIn[i * NSLOT + s];
      if (v.y < 0.01) { continue; }
      let k = atomicAdd(&indirect[1], 1u);
      inst[k] = vec4<u32>(id.x | (id.y << 12u), bitcast<u32>(v.x), bitcast<u32>(v.x + v.y), LQ_MAT | (FLAG_RUN_Q << 8u));
    }
  }
  // the open lava: lava's own prism form (lava.wgsl prep), for the opaque pipeline
  if (!LQ_WATER) {
    let d = open[i];
    if (d >= 0.02) {
      let z0 = r0.x;
      let z1 = r0.x + d;
      let k = atomicAdd(&indirectO[1], 1u);
      let t = u32(clamp(r0.z / 1400.0, 0.0, 1.0) * 15.0);
      instO[k] = vec4<u32>(id.x | (id.y << 12u), bitcast<u32>(z0), bitcast<u32>(z1), MAT_LAVA_M | (t << 16u));
      var lv: array<f32, 8>;
      for (var dd = 0u; dd < NDIR; dd++) {
        let q = nbr(p, dd);
        if (!inMap(q)) { lv[dd] = -1.0 - z1; continue; }
        let j = colIdxI(q);
        let rq = runsIn[j * NSLOT];
        let dq = open[j];
        lv[dd] = select(-1.0 - rq.x, rq.x + dq, dq >= 0.02);
      }
      let o = arrayLength(&instO) / 3u + 2u * k;
      instO[o] = vec4<u32>(bitcast<u32>(lv[0]), bitcast<u32>(lv[1]), bitcast<u32>(lv[2]), bitcast<u32>(lv[3]));
      instO[o + 1u] = vec4<u32>(bitcast<u32>(lv[4]), bitcast<u32>(lv[5]), 0u, 0u);
    }
  }
  // the stream through this column: a narrow box from where it comes in to where it leaves (or lands)
  let j2 = textureLoad(j2In, p, 0);
  if (u32(j2.w) != stamp24(last)) { return; }
  let j0 = textureLoad(j0In, p, 0);
  let j1 = textureLoad(j1In, p, 0);
  let way = u32(j2.x);
  // (its way in: where it leaves, less how far it went)
  let ex = select(j1.zw, j1.zw + DIRV[min(way, 5u)], way < 6u);
  let vzOut = j0.z;
  let entry = ex - j1.xy * j2.z;
  let mid = cellPos(p) + 0.5 * (entry + ex);
  // (thicker for more water: up to a cell across)
  let rate = j0.x * 60.0;
  let q = u32(clamp(round(2.0 + rate * 2.0), 1.0, 4.0));
  let z0 = min(j2.y, j0.y - 0.05);
  let k = atomicAdd(&indirect[1], 1u);
  inst[k] = boxAt(p, mid, q, z0, j0.y + 0.05, LQ_MAT, FLAG_RUN_Q);
  // spray where it lands: more for more water falling faster
  if (way == 6u) {
    let hit = abs(vzOut);
    let chance = min(rate * hit * 0.02, 0.9);
    if (chanceQ(i, 0x71u) < chance) {
      let s = hash3(i, G.tick, 0x72u);
      let rr = vec2<f32>(f32(s & 255u), f32((s >> 8u) & 255u)) / 255.0 - 0.5;
      let kind = select(K_SMOKE_Q, K_SPLASH_Q, LQ_WATER);
      let up = min(hit * 0.35, 6.0);
      spawnQ(vec3<f32>(cellPos(p) + ex, j2.y + 0.1), vec3<f32>(rr * 3.0 + j1.xy * 0.3, up), select(3.0, 0.9, LQ_WATER), kind, s, select(2u, 0u, LQ_WATER));
    }
  }
}
