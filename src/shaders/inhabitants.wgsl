// Inhabitants (round 117, docs/INHABITANTS.md; src/inhabitants/system.ts): creatures with bodies on the GPU.
// Four kernels a tick, one thread a creature:
//   binIt    a spatial hash (8-cell bins, up to BIN_CAP each) and the groups' sums (centre, count, alarm)
//   behave   boids for herds and flocks, predators that stalk then sprint, townsfolk on paths, wanderers; fire,
//            water, cliffs and the world's wind (a strong one knocks them down)
//   animate  the Rain World recipe: the root where behave put it, the spine following it, feet planted that step
//            when they fall behind, two-bone IK knees, verlet tails, capes and fur in the wind, wings that flap
//   meshIt   flat-shaded low-poly spindles and cloth triangles, written for Renderer.addMesh (render.wgsl vsSkin)
// Prepended: common.wgsl (Globals, the lattice, colIdx, windAt).

const MAXP: u32 = 32u;
const MAXS: u32 = 48u;
const MAX_SPECIES: u32 = 16u;
const HDR: u32 = 6u;
const AS: u32 = 5u; // vec4s an agent
const BIN_CAP: u32 = 12u;
const MAX_GROUPS: u32 = 256u;
const GS: u32 = 8u; // i32s a group's sums
const PATH_NODES: u32 = 512u;
const PATH_EDGES: u32 = 1024u;
const BONE_V: u32 = 48u;
const TAU: f32 = 6.2831853;

// roles (rig.ts Role)
const R_ROOT: u32 = 0u;
const R_SPINE: u32 = 1u;
const R_RIGID: u32 = 2u;
const R_FOOT: u32 = 3u;
const R_KNEE: u32 = 4u;
const R_CHAIN: u32 = 5u;
const R_WING: u32 = 6u;
const R_SWING: u32 = 7u;
const R_HEAD: u32 = 8u;

// behaviours (pack.ts BEHAVIOUR_CODE)
const B_HERD: u32 = 0u;
const B_FLOCK: u32 = 1u;
const B_STALK: u32 = 2u;
const B_TOWN: u32 = 3u;
const B_WANDER: u32 = 4u;

// states (system.ts STATE)
const S_IDLE: f32 = 0.0;
const S_WALK: f32 = 1.0;
const S_RUN: f32 = 2.0;
const S_STALK: f32 = 3.0;
const S_REST: f32 = 4.0;
const S_FLY: f32 = 5.0;
const S_DOWN: f32 = 6.0;

struct LifeParams {
  n: u32, nGroups: u32, binsX: u32, binsY: u32,
  binSize: f32, focusX: f32, focusY: f32, focusR: f32,
  lod: u32, nNodes: u32, nEdges: u32, maxVerts: u32,
  time: f32, worldW: f32, worldH: f32, pad1: f32,
  /** the window's slide (shiftIt) */
  shift: vec4<f32>,
}

@group(0) @binding(40) var<uniform> P: LifeParams;
@group(0) @binding(41) var<storage, read> table: array<vec4<f32>>;
@group(0) @binding(42) var<storage, read_write> agents: array<vec4<f32>>;
@group(0) @binding(43) var<storage, read_write> pose: array<vec4<f32>>;
@group(0) @binding(44) var<storage, read_write> bins: array<atomic<u32>>;
// the CPU's orders a group (2 vec4: home.xy, radius, kind | from.xy, flee until (s), species), then the paths:
// nodes (xyz; z < -1e8: on the ground), adjacency (4 edge ids a node, -1 none), edges (a, b, kind, length)
@group(0) @binding(45) var<storage, read> orders: array<vec4<f32>>;
@group(0) @binding(46) var<storage, read_write> gsum: array<atomic<i32>>;
@group(0) @binding(47) var<storage, read_write> verts: array<vec4<u32>>;
@group(0) @binding(48) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(49) var<storage, read> surface: array<u32>;
@group(0) @binding(50) var<storage, read> fire: array<f32>;
@group(0) @binding(51) var<storage, read> water: array<f32>;

fn hdr(sp: u32, k: u32) -> vec4<f32> { return table[sp * HDR + k]; }
fn ptA(sp: u32, i: u32) -> vec4<f32> { return table[MAX_SPECIES * HDR + (sp * MAXP + i) * 2u]; }
fn ptB(sp: u32, i: u32) -> vec4<f32> { return table[MAX_SPECIES * HDR + (sp * MAXP + i) * 2u + 1u]; }
fn sgA(sp: u32, i: u32) -> vec4<f32> { return table[MAX_SPECIES * HDR + MAX_SPECIES * MAXP * 2u + (sp * MAXS + i) * 2u]; }
fn sgB(sp: u32, i: u32) -> vec4<f32> { return table[MAX_SPECIES * HDR + MAX_SPECIES * MAXP * 2u + (sp * MAXS + i) * 2u + 1u]; }

fn groundAt(p: vec2<f32>) -> f32 {
  let c = cellAt(p);
  if (!inMap(c)) { return 0.0; }
  // (the loose ground lies on the solid top — a dust skin, a drift — and a sleeping body's top is ground too:
  // as the particles' ground, particles.wgsl)
  return max(sfZ(surface[colIdxI(c)]) + driftAt(c), bodyTopAt(c));
}
fn waterAt(p: vec2<f32>) -> f32 {
  let c = cellAt(p);
  if (!inMap(c)) { return 0.0; }
  return water[colIdxI(c)];
}
fn fireAt(p: vec2<f32>) -> f32 {
  let c = cellAt(p);
  if (!inMap(c)) { return 0.0; }
  return fire[colIdxI(c)];
}
fn nrm2(v: vec2<f32>) -> vec2<f32> { let l = length(v); return select(vec2<f32>(0.0), v / l, l > 1e-6); }
fn rnd(a: u32, b: u32) -> f32 { return f32(pcg(a * 9781u + pcg(b)) & 0xffffffu) / 16777216.0; }

fn binOf(p: vec2<f32>) -> vec2<i32> {
  return clamp(vec2<i32>(floor(p / P.binSize)), vec2<i32>(0), vec2<i32>(i32(P.binsX) - 1, i32(P.binsY) - 1));
}
fn binIdx(b: vec2<i32>) -> u32 { return u32(b.y) * P.binsX + u32(b.x); }

// ---------------------------------------------------------------- bins and group sums

@compute @workgroup_size(64)
fn binIt(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let a0 = agents[i * AS];
  if (a0.w < 0.0) { return; }
  let b = binIdx(binOf(a0.xy));
  let nb = P.binsX * P.binsY;
  let k = atomicAdd(&bins[b], 1u);
  if (k < BIN_CAP) { atomicStore(&bins[nb + b * BIN_CAP + k], i); }
  let g = u32(agents[i * AS + 2u].x);
  if (g < MAX_GROUPS) {
    atomicAdd(&gsum[g * GS + 0u], i32(a0.x * 8.0));
    atomicAdd(&gsum[g * GS + 1u], i32(a0.y * 8.0));
    atomicAdd(&gsum[g * GS + 2u], i32(a0.z * 8.0));
    atomicAdd(&gsum[g * GS + 3u], 1);
    let st = agents[i * AS + 2u].y;
    if (st == S_RUN && agents[i * AS + 3u].z > 0.5) { atomicAdd(&gsum[g * GS + 4u], 1); }
  }
}

fn groupCentre(g: u32) -> vec4<f32> {
  let n = atomicLoad(&gsum[g * GS + 3u]);
  if (n <= 0) { return vec4<f32>(0.0); }
  let s = vec3<f32>(f32(atomicLoad(&gsum[g * GS + 0u])), f32(atomicLoad(&gsum[g * GS + 1u])), f32(atomicLoad(&gsum[g * GS + 2u]))) / (8.0 * f32(n));
  return vec4<f32>(s, f32(n));
}

// ---------------------------------------------------------------- behaviour

fn steerClear(pos: vec3<f32>, vel: vec2<f32>, flies: bool) -> vec2<f32> {
  // cliffs, drops, deep water and fire ahead turn it; the window's edge holds it in
  var v = vel;
  let sp = length(v);
  var push = vec2<f32>(0.0);
  let m = 6.0;
  push += vec2<f32>(max(0.0, m - pos.x), max(0.0, m - pos.y));
  push -= vec2<f32>(max(0.0, pos.x - (P.worldW - m)), max(0.0, pos.y - (P.worldH - m)));
  if (sp > 0.05 && !flies) {
    let dir = v / sp;
    let g0 = groundAt(pos.xy);
    for (var k = 0; k < 3; k++) {
      let ang = f32(k - 1) * 0.7;
      let d = vec2<f32>(dir.x * cos(ang) - dir.y * sin(ang), dir.x * sin(ang) + dir.y * cos(ang));
      let ahead = pos.xy + d * 1.6;
      let dz = groundAt(ahead) - g0;
      var bad = 0.0;
      if (dz > 1.3 || dz < -2.6) { bad = 1.0; }
      if (waterAt(ahead) > 0.45) { bad = 1.0; }
      if (fireAt(ahead) > 0.05) { bad = 1.5; }
      push -= d * bad * 2.0;
    }
  }
  return v + push * max(sp, 1.0);
}

@compute @workgroup_size(64)
fn behave(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  var a0 = agents[i * AS];
  if (a0.w < 0.0) { return; }
  var a1 = agents[i * AS + 1u];
  var a2 = agents[i * AS + 2u];
  var a3 = agents[i * AS + 3u];
  var a4 = agents[i * AS + 4u];
  let sp = u32(a0.w);
  let h0 = hdr(sp, 0u);
  let h1 = hdr(sp, 1u);
  let h2 = hdr(sp, 2u);
  let h3 = hdr(sp, 3u);
  let h4 = hdr(sp, 4u);
  let walkV = h0.x;
  let runV = h0.y;
  let sight = h0.z;
  let beh = u32(h1.x);
  let mass = h1.z;
  let preyMask = u32(h1.w);
  let flies = h3.w > 0.5;
  let radius = h4.x;
  let dt = G.dt;
  let g = u32(a2.x);
  let o0 = orders[g * 2u];
  let o1 = orders[g * 2u + 1u];
  let seed = u32(a4.y);
  var state = a2.y;
  var timer = a2.z - dt;
  var pos = a0.xyz;
  var vel = a1.xyz;

  // ---- neighbours (3×3 bins): boids sums, the nearest threat, the nearest prey
  var sep = vec2<f32>(0.0);
  var ali = vec3<f32>(0.0);
  var coh = vec3<f32>(0.0);
  var nn = 0.0;
  var threat = vec2<f32>(0.0);
  var threatN = 0.0;
  var preyD = 1e9;
  var preyAt = vec2<f32>(0.0);
  var alarmN = 0.0;
  let nb = P.binsX * P.binsY;
  let bc = binOf(pos.xy);
  for (var by = -1; by <= 1; by++) {
    for (var bx = -1; bx <= 1; bx++) {
      let b = bc + vec2<i32>(bx, by);
      if (b.x < 0 || b.y < 0 || b.x >= i32(P.binsX) || b.y >= i32(P.binsY)) { continue; }
      let bi = binIdx(b);
      let cnt = min(atomicLoad(&bins[bi]), BIN_CAP);
      for (var k = 0u; k < cnt; k++) {
        let j = atomicLoad(&bins[nb + bi * BIN_CAP + k]);
        if (j == i) { continue; }
        let o = agents[j * AS];
        if (o.w < 0.0) { continue; }
        let osp = u32(o.w);
        let d3 = o.xyz - pos;
        let d = d3.xy;
        let dist = max(length(d), 0.01);
        let orad = hdr(osp, 4u).x;
        // everyone keeps clear of everyone's body
        let clear = (radius + orad) * 0.6;
        if (dist < clear) { sep -= d / dist * (clear - dist) / clear; }
        if (osp == sp) {
          if (dist < 7.0) {
            ali += agents[j * AS + 1u].xyz;
            coh += d3;
            nn += 1.0;
            let ost = agents[j * AS + 2u].y;
            if (ost == S_RUN && agents[j * AS + 3u].z > 0.5) { alarmN += 1.0; }
          }
        } else {
          let ob = hdr(osp, 1u);
          // a predator that eats this species: a threat within sight (a stalker crouched is seen nearer: 0.5)
          if (u32(ob.x) == B_STALK && ((u32(ob.w) >> sp) & 1u) == 1u) {
            let ost = agents[j * AS + 2u].y;
            let seen = select(sight * 0.5, sight, ost == S_RUN);
            if (dist < seen) {
              threat += d / dist * (1.0 - dist / seen);
              threatN += 1.0;
            }
          }
          if (((preyMask >> osp) & 1u) == 1u && dist < preyD) {
            preyD = dist;
            preyAt = o.xy;
          }
        }
      }
    }
  }

  let gc = groupCentre(g);
  let groupAlarm = f32(atomicLoad(&gsum[g * GS + 4u]));
  let home = o0.xy;
  let roamR = max(o0.z, 4.0);
  let order = o0.w;
  var desired = vec3<f32>(0.0);
  var speedCap = walkV;

  // a hero's charge, a storm: the CPU's flee order
  let ordered = order == 2.0 && P.time < o1.z;
  // fire underfoot: run
  let burning = fireAt(pos.xy) > 0.05;

  if (order == 4.0 && state != S_DOWN) {
    // a director's pace: round home at a gait (o1.x: 0 idle, 1 walk, 2 run, 3 fly)
    let gait = o1.x;
    let toC = pos.xy - home;
    let dc = max(length(toC), 0.01);
    let side = select(-1.0, 1.0, (seed & 1u) == 0u);
    let tang = vec2<f32>(-toC.y, toC.x) / dc * side;
    var v = walkV;
    state = S_WALK;
    if (gait == 2.0) { v = runV; state = S_RUN; }
    if (gait == 3.0) { v = runV * 0.6; state = select(S_RUN, S_FLY, beh == B_FLOCK || flies); }
    if (gait == 0.0) { v = 0.0; state = S_IDLE; }
    speedCap = max(v, 0.3);
    desired = vec3<f32>((tang * v + (-toC / dc) * (dc - o0.z) * 0.8 * select(0.0, 1.0, v > 0.0)), 0.0);
    if (gait == 3.0) { desired.z = (groundAt(pos.xy) + h2.w * 0.5 - pos.z) * 1.5; }
    timer = 1.0;
    a3.z = 0.0;
  } else if (state == S_DOWN) {
    // knocked over: slide to a stop, get up when the timer runs out
    vel *= exp(-dt * 3.0);
    desired = vel;
    if (timer <= 0.0) { state = S_IDLE; timer = 0.5; }
  } else if (beh == B_FLOCK) {
    // 3D boids round home at its height
    state = S_FLY;
    let fh = h2.w * (0.8 + 0.4 * rnd(seed, 3u));
    let gz = groundAt(pos.xy);
    var steer = vec3<f32>(0.0);
    if (nn > 0.0) {
      steer += (ali / nn - vel) * 0.8;
      steer += (coh / nn) * 0.6;
    }
    steer += vec3<f32>(sep * 6.0, 0.0);
    let toHome = home - pos.xy;
    let dh = length(toHome);
    if (dh > roamR) { steer += vec3<f32>(toHome / dh * (dh - roamR) * 0.3, 0.0); }
    // a lazy circling: each bird its own way round
    let side = select(-1.0, 1.0, rnd(seed, 5u) > 0.5);
    steer += vec3<f32>(vec2<f32>(-toHome.y, toHome.x) / max(dh, 1.0) * side * 1.5, 0.0);
    steer.z += (gz + fh - pos.z) * 1.2 - vel.z * 0.8;
    if (threatN > 0.0 || ordered) { steer += vec3<f32>(-threat * 10.0, 2.0); }
    desired = vel + steer * dt * 4.0;
    speedCap = runV;
    let s = length(desired.xy);
    if (s < runV * 0.45) { desired = vec3<f32>(desired.xy / max(s, 0.01) * runV * 0.45, desired.z); }
  } else if (beh == B_TOWN && P.nNodes > 0u) {
    // walk the structures' paths: edge a4.z, t a4.w, direction a3.x
    var e = u32(a4.z);
    if (e >= P.nEdges) { e = seed % P.nEdges; a4.w = rnd(seed, 9u); a3.x = 1.0; }
    let base = MAX_GROUPS * 2u;
    var ed = orders[base + PATH_NODES * 2u + e];
    let na = orders[base + u32(ed.x)];
    let nb2 = orders[base + u32(ed.y)];
    let kind = ed.z;
    // elevators and ladders slower; on them it stands
    let v = select(walkV, walkV * 0.6, kind >= 3.0);
    var t = a4.w + a3.x * v * dt / max(ed.w, 0.1);
    if (t > 1.0 || t < 0.0) {
      // at a node: the next edge, not back the way it came if there's another
      let at = select(u32(ed.x), u32(ed.y), t > 1.0);
      let adj = orders[base + PATH_NODES + at];
      var cands = 0u;
      var pick = e;
      let r = pcg(seed + u32(P.time * 7.0));
      for (var k = 0u; k < 4u; k++) {
        let ek = adj[k];
        if (ek < 0.0 || u32(ek) == e) { continue; }
        cands++;
        if (r % cands == 0u) { pick = u32(ek); }
      }
      let ne = orders[base + PATH_NODES * 2u + pick];
      if (u32(ne.x) == at) { t = 0.0; a3.x = 1.0; } else { t = 1.0; a3.x = -1.0; }
      e = pick;
      ed = ne;
    }
    let pa = orders[base + u32(ed.x)];
    let pb = orders[base + u32(ed.y)];
    var xy = mix(pa.xy, pb.xy, t);
    var za = pa.z;
    var zb = pb.z;
    if (za < -1e8) { za = groundAt(pa.xy); }
    if (zb < -1e8) { zb = groundAt(pb.xy); }
    var z = mix(za, zb, t);
    if (pa.z < -1e8 && pb.z < -1e8) { z = groundAt(xy); }
    let np = vec3<f32>(xy, z);
    vel = (np - pos) / dt;
    pos = np;
    a4.z = f32(e);
    a4.w = t;
    state = select(S_WALK, S_IDLE, kind >= 3.0);
    a1 = vec4<f32>(vel, a1.w);
    if (length(vel.xy) > 0.05) { a1.w = atan2(vel.y, vel.x); }
    agents[i * AS] = vec4<f32>(pos, a0.w);
    agents[i * AS + 1u] = a1;
    agents[i * AS + 2u] = vec4<f32>(a2.x, state, timer, a2.w);
    agents[i * AS + 3u] = a3;
    agents[i * AS + 4u] = a4;
    return;
  } else if (beh == B_STALK) {
    // rest → stalk the nearest herd of prey, low and slow → sprint at the nearest within reach → rest
    var tgt = vec2<f32>(0.0);
    var tgtD = 1e9;
    for (var k = 0u; k < P.nGroups; k++) {
      let ok = orders[k * 2u + 1u];
      if (((preyMask >> u32(ok.w)) & 1u) == 0u) { continue; }
      let c = groupCentre(k);
      if (c.w <= 0.0) { continue; }
      let d = length(c.xy - pos.xy);
      if (d < tgtD) { tgtD = d; tgt = c.xy; }
    }
    // the pack keeps together loosely
    var pack = vec2<f32>(0.0);
    if (gc.w > 1.0) { pack = (gc.xy - pos.xy) * 0.15; }
    if (state == S_REST || state == S_IDLE || state == S_WALK) {
      desired = vec3<f32>(pack * 0.5, 0.0);
      speedCap = walkV * 0.5;
      if (timer <= 0.0) {
        if (tgtD < sight) { state = S_STALK; timer = 30.0; } else { state = S_WALK; timer = 4.0; desired = vec3<f32>((home - pos.xy) * 0.2, 0.0); }
      }
      if (state == S_WALK) { desired = vec3<f32>(nrm2(home - pos.xy + vec2<f32>(rnd(seed, u32(P.time * 0.2)) - 0.5, 0.3) * roamR) * walkV, 0.0); speedCap = walkV; }
    } else if (state == S_STALK) {
      // (low and steady: slower than a trot, faster than grazing — a stalk you can watch close in)
      speedCap = max(walkV * 0.8, runV * 0.22);
      if (tgtD < 1e8) {
        let d = tgt - pos.xy;
        desired = vec3<f32>(d / max(length(d), 0.01) * speedCap + pack, 0.0);
      }
      // close enough: sprint
      if (preyD < 11.0 || tgtD < 9.0) { state = S_RUN; timer = 5.0 + 2.0 * rnd(seed, u32(P.time)); }
      if (timer <= 0.0 || tgtD > sight * 1.5) { state = S_REST; timer = 3.0; }
    } else if (state == S_RUN) {
      speedCap = runV;
      var aim = tgt;
      if (preyD < 1e8) { aim = preyAt; }
      let d = aim - pos.xy;
      desired = vec3<f32>(d / max(length(d), 0.01) * runV, 0.0);
      if (timer <= 0.0 || preyD < 0.6) { state = S_REST; timer = 6.0 + 4.0 * rnd(seed, 11u); }
    }
    a3.z = 0.0;
  } else {
    // herds and wanderers: graze, walk to a new spot, bolt from a predator (and from a fleeing neighbour)
    let alarmed = threatN > 0.0 || ordered || burning || (beh == B_HERD && (alarmN > 0.0 || groupAlarm > 0.0) && state != S_RUN && rnd(seed, u32(P.time * 4.0)) < 0.25);
    if (alarmed && !(state == S_RUN && a3.z > 0.5)) {
      state = S_RUN;
      timer = 3.0 + 2.0 * rnd(seed, u32(P.time * 3.0));
      var away = threat;
      if (ordered) { away += nrm2(pos.xy - o1.xy); }
      if (length(away) < 0.01) { away = nrm2(pos.xy - gc.xy) + a1.xy * 0.1; }
      if (length(away) < 0.01) { away = vec2<f32>(cos(f32(seed)), sin(f32(seed))); }
      a3 = vec4<f32>(pos.xy + nrm2(away) * 30.0, 1.0, a3.w);
    }
    if (threatN > 0.0 && state == S_RUN) {
      // keep running from where it is now
      a3 = vec4<f32>(pos.xy + nrm2(threat) * 30.0, 1.0, a3.w);
      timer = max(timer, 1.5);
    }
    if (state == S_RUN) {
      speedCap = runV;
      let d = a3.xy - pos.xy;
      desired = vec3<f32>(d / max(length(d), 0.01) * runV, 0.0);
      if (nn > 0.0) { desired += vec3<f32>((ali.xy / nn) * 0.5 + (coh.xy / nn) * 0.3, 0.0); }
      if (timer <= 0.0) { state = S_IDLE; timer = 1.0 + 2.0 * rnd(seed, 13u); a3.z = 0.0; }
    } else if (state == S_WALK) {
      speedCap = walkV;
      let d = a3.xy - pos.xy;
      let dl = length(d);
      desired = vec3<f32>(d / max(dl, 0.01) * walkV, 0.0);
      if (dl < 1.0 || timer <= 0.0) { state = S_IDLE; timer = 2.0 + 5.0 * rnd(seed, u32(P.time)); }
    } else {
      // grazing: stand (a shuffle from the separation only)
      speedCap = walkV * 0.4;
      desired = vec3<f32>(0.0);
      if (timer <= 0.0) {
        state = S_WALK;
        timer = 8.0;
        // a new spot near the herd, inside its range
        let r1 = rnd(seed, u32(P.time * 10.0) + 1u);
        let r2 = rnd(seed, u32(P.time * 10.0) + 2u);
        var c = home;
        if (beh == B_HERD && gc.w > 1.0) { c = mix(home, gc.xy, 0.7); }
        let ang = r1 * TAU;
        let rr = select(roamR, 6.0, beh == B_HERD) * sqrt(r2);
        var aim = c + vec2<f32>(cos(ang), sin(ang)) * rr;
        if (length(aim - home) > roamR) { aim = home + nrm2(aim - home) * roamR; }
        a3 = vec4<f32>(aim, 0.0, a3.w);
      }
    }
    if (beh == B_HERD && nn > 0.0 && state != S_RUN) {
      // cohesion: a herd member far from its neighbours walks back
      let cd = length(coh.xy / nn);
      if (cd > 4.0) { desired += vec3<f32>(coh.xy / nn * 0.3, 0.0); }
    }
  }

  // separation always
  desired += vec3<f32>(sep * max(speedCap, 1.5) * 1.5, 0.0);
  // the world's wind: a strong one knocks it down (as the agents: 0.5 × the excess² ÷ mass past 18 at the feet)
  let wnd = windAt(pos + vec3<f32>(0.0, 0.0, 1.0));
  let ws = length(wnd);
  let force = 0.5 * max(0.0, ws - 8.0) * max(0.0, ws - 8.0) / max(mass, 0.1);
  if (!flies && state != S_DOWN && force > 18.0) {
    state = S_DOWN;
    timer = 1.5 + rnd(seed, u32(P.time * 5.0));
    vel = vec3<f32>(wnd * 0.35, 2.0);
  }
  if (state == S_DOWN) { vel += vec3<f32>(wnd * min(force, 40.0) * 0.02 * dt, 0.0); }

  // in the air: a flock always; a winged stalker takes off to sprint (a dragon's swoop)
  let airborne = flies && (state == S_FLY || (beh == B_STALK && state == S_RUN) || (order == 4.0 && o1.x == 3.0));
  let gz0 = groundAt(pos.xy);
  if (airborne && beh != B_FLOCK && order != 4.0) { desired.z = (gz0 + h2.w * 0.6 - pos.z) * 1.5; }
  if (state != S_DOWN) {
    var dxy = steerClear(pos, desired.xy, airborne);
    let s = length(dxy);
    if (s > speedCap) { dxy *= speedCap / s; }
    // accelerate toward it (heavy things turn slower)
    let acc = select(4.0, 2.5, mass > 4.0);
    vel = vec3<f32>(mix(vel.xy, dxy, 1.0 - exp(-dt * acc)), select(0.0, mix(vel.z, desired.z, 1.0 - exp(-dt * 3.0)), airborne));
  }
  pos += vel * dt;
  pos.x = clamp(pos.x, 1.0, P.worldW - 1.0);
  pos.y = clamp(pos.y, 1.0, P.worldH - 1.0);
  let gz = groundAt(pos.xy);
  if (airborne) {
    pos.z = max(pos.z, gz + 1.0);
  } else {
    // landing: down at 5 cells/s, then on the ground
    pos.z = max(gz, pos.z - 5.0 * dt);
    vel.z = 0.0;
  }
  a3.w = select(0.0, 1.0, airborne);
  let hs = length(vel.xy);
  var heading = a1.w;
  if (hs > 0.08 && state != S_DOWN) {
    // turn toward where it goes, at a rate (a deer can't spin on the spot)
    let want = atan2(vel.y, vel.x);
    var dh = want - heading;
    dh = dh - TAU * floor((dh + 3.14159265) / TAU);
    heading += clamp(dh, -dt * 6.0, dt * 6.0);
  }
  agents[i * AS] = vec4<f32>(pos, a0.w);
  agents[i * AS + 1u] = vec4<f32>(vel, heading);
  agents[i * AS + 2u] = vec4<f32>(a2.x, state, timer, a2.w);
  agents[i * AS + 3u] = a3;
  agents[i * AS + 4u] = a4;
}

// ---------------------------------------------------------------- animation

fn leftOf(f: vec3<f32>) -> vec3<f32> {
  let l = cross(vec3<f32>(0.0, 0.0, 1.0), f);
  let n = length(l);
  if (n < 1e-4) { return vec3<f32>(0.0, 1.0, 0.0); }
  return l / n;
}
fn inFrame(f: vec3<f32>, r: vec3<f32>) -> vec3<f32> {
  let l = leftOf(f);
  let u = cross(f, l);
  return f * r.x + l * r.y + u * r.z;
}

@compute @workgroup_size(64)
fn animate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let a0 = agents[i * AS];
  if (a0.w < 0.0) { return; }
  let a1 = agents[i * AS + 1u];
  var a2 = agents[i * AS + 2u];
  var a4 = agents[i * AS + 4u];
  let sp = u32(a0.w);
  let h0 = hdr(sp, 0u);
  let h2 = hdr(sp, 2u);
  let h3 = hdr(sp, 3u);
  let h4 = hdr(sp, 4u);
  let np = u32(h3.x);
  let dt = G.dt;
  let fresh = a4.x > 0.5;
  let state = a2.y;
  let seed = u32(a4.y);
  let speed = length(a1.xy);
  let walkV = h0.x;
  let runV = h0.y;
  let stride = h2.x;
  let lift = h2.z;
  let run01 = clamp((speed - walkV) / max(runV - walkV, 0.1), 0.0, 1.0);
  // the gait's phase (cycles): a step each half; arms and the serpent's wave ride it
  var phase = a2.w + dt * speed / max(stride * 2.0, 0.05);
  if (speed < 0.05) { phase = a2.w + dt * 0.2; }
  phase = fract(phase);
  let stepT = clamp(stride * 0.55 / max(speed, 0.01), 0.07, h2.y);
  let flying = agents[i * AS + 3u].w > 0.5;
  let base = i * MAXP * 2u;
  let hf = vec3<f32>(cos(a1.w), sin(a1.w), 0.0);

  // feet stepping now, by gait group (last tick's): a foot steps only when the other group's are all down
  var steppingG = array<u32, 2>(0u, 0u);
  for (var k = 0u; k < np; k++) {
    let d = ptA(sp, k);
    let role = u32(d.w) % 16u;
    if (role == R_FOOT && pose[base + k * 2u + 1u].w > 0.0) { steppingG[u32(ptB(sp, k).x) % 2u] += 1u; }
  }

  var P3: array<vec3<f32>, 32>;
  var F3: array<vec3<f32>, 32>;
  // the root's flight blend (0 grounded .. 1 flying) is kept in the root's spare w
  var fl = pose[base + 1u].w;
  fl = mix(fl, select(0.0, 1.0, flying), 1.0 - exp(-dt * 3.0));
  if (fresh) { fl = select(0.0, 1.0, flying); }
  let flapRate = h4.w;
  let flap = sin(TAU * (P.time * flapRate * (0.9 + 0.2 * rnd(seed, 2u))) );

  for (var k = 0u; k < np; k++) {
    let d0 = ptA(sp, k);
    let pp = ptB(sp, k);
    let role = u32(d0.w) % 16u;
    let par = i32(u32(d0.w) / 16u) - 1;
    let rest = d0.xyz;
    let old = pose[base + k * 2u];
    let prv = pose[base + k * 2u + 1u];
    var p = old.xyz;
    var q = prv;
    var f = hf;
    var parP = a0.xyz;
    var parF = hf;
    if (par >= 0) { parP = P3[par]; parF = F3[par]; }
    switch role {
      case 0u: {
        // R_ROOT: where behave put it; a bob with the gait; lying when knocked over; a serpent's wave
        var hgt = pp.x;
        if (state == S_DOWN) { hgt *= 0.35; }
        hgt += 0.03 * pp.x * cos(phase * TAU * 2.0) * clamp(speed / max(walkV, 0.1), 0.0, 1.5);
        p = a0.xyz + vec3<f32>(0.0, 0.0, hgt);
        if (pp.y > 0.0) { p += leftOf(hf) * sin(phase * TAU) * pp.y * clamp(speed / max(walkV, 0.1), 0.2, 1.0); }
        f = hf;
        q = vec4<f32>(old.xyz, fl);
      }
      case 1u: {
        // R_SPINE: follow the leader at |rest|, pulled toward its height over the ground
        let len = length(rest);
        var dir = p - parP;
        if (fresh || dot(dir, dir) < 1e-6) { dir = -parF; }
        p = parP + normalize(dir) * len;
        let tz = groundAt(p.xy) + pp.x;
        let pull = pp.y * (1.0 - fl);
        p.z = mix(p.z, tz, pull);
        if (fl > 0.5) { p.z = mix(p.z, parP.z, 0.3); }
        p = parP + normalize(p - parP) * len;
        f = normalize(parP - p);
        q = vec4<f32>(old.xyz, 0.0);
      }
      case 2u, 8u: {
        // R_RIGID (lean with speed) and R_HEAD (dips to graze, low to stalk; smoothed in its w)
        var r = rest;
        let lean = pp.x * run01;
        if (role == 2u && lean != 0.0) {
          r = vec3<f32>(r.x * cos(lean) + r.z * sin(lean), r.y, -r.x * sin(lean) + r.z * cos(lean));
        }
        if (role == 8u) {
          var want = 0.0;
          if (state == S_IDLE && speed < 0.3) { want = 1.0; }
          if (state == S_STALK) { want = 0.6; }
          if (state == S_REST) { want = 0.8; }
          if (state == S_DOWN) { want = 0.5; }
          var gz = prv.w;
          gz = mix(gz, want, 1.0 - exp(-dt * 3.0));
          // a look about now and then
          let look = sin(P.time * 0.7 + f32(seed % 97u)) * 0.25 * (1.0 - gz);
          r = vec3<f32>(r.x + pp.x * 0.3 * gz, r.y + look * length(r) * 0.4, r.z - pp.x * gz);
          q = vec4<f32>(old.xyz, gz);
        } else {
          q = vec4<f32>(old.xyz, 0.0);
        }
        p = parP + inFrame(parF, r);
        f = parF;
      }
      case 3u: {
        // R_FOOT: planted; steps toward the ideal spot (under its hip, ahead by the speed) when it falls behind
        let grp = u32(pp.x) % 2u;
        let other = 1u - grp;
        let len = length(rest);
        var ideal = parP + inFrame(parF, vec3<f32>(rest.x, rest.y, 0.0)) + parF * stride * pp.y * clamp(speed / max(walkV, 0.1), 0.0, 1.6) * 0.5 + vec3<f32>(a1.xy, 0.0) * stepT * 0.5;
        ideal.z = groundAt(ideal.xy);
        if (fresh) {
          p = ideal;
          q = vec4<f32>(ideal, 0.0);
        } else if (fl > 0.5 || state == S_DOWN) {
          // tucked in flight; kicking when down
          let kick = select(0.0, sin(P.time * 9.0 + f32(k)) * 0.3, state == S_DOWN);
          p = parP + inFrame(parF, vec3<f32>(-len * 0.3 + kick * len, rest.y * 0.5, -len * 0.55));
          q = vec4<f32>(p, 0.0);
        } else {
          var prog = prv.w;
          let err = length(p.xy - ideal.xy);
          let thresh = select(stride * 0.5, stride * 0.12, speed < 0.15);
          if (prog <= 0.0 && err > thresh && steppingG[other] == 0u) {
            prog = 0.001;
            steppingG[grp] += 1u;
          }
          if (prog > 0.0) {
            let dp = dt / stepT;
            let left = max(1.0 - prog, dp);
            let tgt = ideal;
            let xy = p.xy + (tgt.xy - p.xy) * min(1.0, dp / left);
            prog = prog + dp;
            if (prog >= 1.0) {
              p = vec3<f32>(tgt.xy, groundAt(tgt.xy));
              prog = 0.0;
            } else {
              let gz = mix(groundAt(xy), tgt.z, prog);
              p = vec3<f32>(xy, max(gz, groundAt(xy)) + sin(prog * 3.14159265) * lift * (1.0 + run01));
            }
          } else {
            p.z = groundAt(p.xy);
          }
          // too far (a teleport, a respawn): put it down where it should be
          if (length(p - parP) > len * 3.0 + 1.0) { p = ideal; prog = 0.0; }
          q = vec4<f32>(ideal, prog);
        }
        f = parF;
      }
      case 4u: {
        // R_KNEE: two-bone IK between the parent and point pp.x, bent toward the pole
        let c = P3[u32(pp.x)];
        let l1 = pp.y;
        let l2 = pp.z;
        let dv = c - parP;
        let dist = clamp(length(dv), 0.001, (l1 + l2) * 0.999);
        let ax = dv / max(length(dv), 0.001);
        var pole = parF * pp.w;
        if (pp.w == 0.0) { pole = vec3<f32>(0.0, 0.0, 1.0) + leftOf(parF) * sign(rest.y) * 0.5; }
        var pd = pole - ax * dot(pole, ax);
        if (length(pd) < 1e-4) { pd = vec3<f32>(0.0, 0.0, 1.0) - ax * ax.z; }
        pd = normalize(pd + vec3<f32>(0.0, 0.0, 1e-4));
        let x = (l1 * l1 - l2 * l2 + dist * dist) / (2.0 * dist);
        let hh = sqrt(max(l1 * l1 - x * x, 0.0));
        p = parP + ax * x + pd * hh;
        f = parF;
        q = vec4<f32>(old.xyz, 0.0);
      }
      case 5u: {
        // R_CHAIN: verlet — momentum, gravity, the wind, pulled toward its rest by stiffness, held to its length
        let len = length(rest);
        let goal = parP + inFrame(parF, rest);
        if (fresh) {
          p = goal;
          q = vec4<f32>(goal, 0.0);
        } else {
          var v = (p - prv.xyz) * (1.0 - pp.w);
          let w = windAt(p);
          v += (vec3<f32>(w * dt, 0.0) - v) * pp.z * 0.12;
          // a little flutter in the wind
          v.z += sin(P.time * 11.0 + f32(k) * 1.7) * length(w) * pp.z * 0.0008;
          var nq = p + v + vec3<f32>(0.0, 0.0, -pp.y) * dt * dt;
          nq = mix(nq, goal, pp.x * 0.5);
          nq = parP + normalize(nq - parP + vec3<f32>(0.0, 0.0, 1e-5)) * len;
          nq.z = max(nq.z, groundAt(nq.xy) + 0.03);
          q = vec4<f32>(p, 0.0);
          p = nq;
        }
        f = parF;
      }
      case 6u: {
        // R_WING: flaps about the parent's forward axis flying, folds along the body on the ground
        let s = sign(rest.y);
        let ang = s * pp.x * sin(TAU * P.time * flapRate - pp.y * 2.0 + f32(seed % 13u)) * (0.6 + 0.4 * clamp(-a1.z * 0.3 + 0.7, 0.0, 1.0));
        let r = vec3<f32>(rest.x, rest.y * cos(ang) - rest.z * sin(ang), rest.y * sin(ang) + rest.z * cos(ang));
        let folded = vec3<f32>(rest.x - abs(rest.y) * 0.75, rest.y * 0.22, rest.z * 0.3 + 0.03);
        p = parP + inFrame(parF, mix(folded, r, fl));
        f = parF;
        q = vec4<f32>(old.xyz, 0.0);
      }
      case 7u: {
        // R_SWING: an arm swinging with the gait (against the legs)
        let amp = pp.x * clamp(speed / max(walkV, 0.1), 0.1, 1.4);
        let ang = amp * sin(phase * TAU + pp.y);
        let r = vec3<f32>(rest.x * cos(ang) - rest.z * sin(ang), rest.y, rest.x * sin(ang) + rest.z * cos(ang));
        p = parP + inFrame(parF, r);
        if (state == S_DOWN) { p = parP + inFrame(parF, vec3<f32>(rest.z * 0.5, rest.y * 3.0, 0.0)); }
        f = parF;
        q = vec4<f32>(old.xyz, 0.0);
      }
      default: {
        p = parP;
      }
    }
    P3[k] = p;
    F3[k] = f;
    pose[base + k * 2u] = vec4<f32>(p, 0.0);
    pose[base + k * 2u + 1u] = q;
  }
  a2.w = phase;
  a4.x = 0.0;
  agents[i * AS + 2u] = a2;
  agents[i * AS + 4u] = a4;
}

// ---------------------------------------------------------------- the mesh

fn emit(o: u32, p: vec3<f32>, n: vec3<f32>, col: u32) {
  verts[o * 2u] = vec4<u32>(bitcast<vec3<u32>>(p), col);
  verts[o * 2u + 1u] = vec4<u32>(bitcast<vec3<u32>>(n), 1u);
}
fn emitTri(o: u32, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, centre: vec3<f32>, col: u32) {
  var n = cross(b - a, c - a);
  let ln = length(n);
  n = select(vec3<f32>(0.0, 0.0, 1.0), n / ln, ln > 1e-9);
  if (dot(n, (a + b + c) / 3.0 - centre) < 0.0) { n = -n; }
  emit(o, a, n, col);
  emit(o + 1u, b, n, col);
  emit(o + 2u, c, n, col);
}
fn tint(c: u32, k: f32) -> u32 {
  let r = min(255.0, f32((c >> 16u) & 255u) * k);
  let g = min(255.0, f32((c >> 8u) & 255u) * k);
  let b = min(255.0, f32(c & 255u) * k);
  return (u32(r) << 16u) | (u32(g) << 8u) | u32(b);
}

@compute @workgroup_size(64)
fn meshIt(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i == 0u) { atomicStore(&drawArgs[1], 1u); }
  if (i >= P.n) { return; }
  let a0 = agents[i * AS];
  if (a0.w < 0.0) { return; }
  if (length(a0.xy - vec2<f32>(P.focusX, P.focusY)) > P.focusR) { return; }
  let sp = u32(a0.w);
  let h3 = hdr(sp, 3u);
  let ns = u32(h3.y);
  let nv = u32(h3.z);
  let o0 = atomicAdd(&drawArgs[4], nv);
  if (o0 + nv > P.maxVerts) {
    // no room: the part of its range that's drawn is emptied (degenerate triangles), not last frame's left there
    for (var z = o0; z < P.maxVerts; z++) { emit(z, vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0), 0u); }
    return;
  }
  let base = i * MAXP * 2u;
  let k = 0.88 + 0.24 * rnd(u32(agents[i * AS + 4u].y), 77u);
  var o = o0;
  for (var s = 0u; s < ns; s++) {
    let A = sgA(sp, s);
    let B = sgB(sp, s);
    let pa = pose[base + u32(A.x) * 2u].xyz;
    let pb = pose[base + u32(A.y) * 2u].xyz;
    let col = tint(u32(B.z), k);
    if (A.w > 0.5) {
      let pc = pose[base + u32(A.z) * 2u].xyz;
      var n = cross(pb - pa, pc - pa);
      let ln = length(n);
      n = select(vec3<f32>(0.0, 0.0, 1.0), n / ln, ln > 1e-9);
      if (n.z < 0.0) { n = -n; }
      emit(o, pa, n, col);
      emit(o + 1u, pb, n, col);
      emit(o + 2u, pc, n, col);
      o += 3u;
      continue;
    }
    // a spindle: a square ring at each end, a tip past each (so neighbours overlap at the joints)
    var d = pb - pa;
    var len = length(d);
    if (len < 1e-4) { d = vec3<f32>(0.0, 0.0, 1e-3); len = 1e-3; }
    let ax = d / len;
    var u = cross(ax, vec3<f32>(0.0, 0.0, 1.0));
    if (length(u) < 0.1) { u = cross(ax, vec3<f32>(1.0, 0.0, 0.0)); }
    u = normalize(u);
    let v = cross(ax, u);
    let ra = B.x;
    let rb = B.y;
    let ta = pa - ax * ra * 0.7;
    let tb = pb + ax * rb * 0.7;
    let centre = (pa + pb) * 0.5;
    var ringA: array<vec3<f32>, 4>;
    var ringB: array<vec3<f32>, 4>;
    for (var c = 0u; c < 4u; c++) {
      let ang = 0.785398 + f32(c) * 1.570796;
      let off = u * cos(ang) + v * sin(ang);
      ringA[c] = pa + off * ra;
      ringB[c] = pb + off * rb;
    }
    for (var c = 0u; c < 4u; c++) {
      let c1 = (c + 1u) % 4u;
      emitTri(o, ta, ringA[c1], ringA[c], centre, col);
      emitTri(o + 3u, ringA[c], ringA[c1], ringB[c1], centre, col);
      emitTri(o + 6u, ringA[c], ringB[c1], ringB[c], centre, col);
      emitTri(o + 9u, ringB[c], ringB[c1], tb, centre, col);
      o += 12u;
    }
  }
}

/** the vertex count drawn: what was written, at most the buffer's room */
@compute @workgroup_size(1)
fn meshArgs() {
  atomicStore(&drawArgs[0], min(atomicLoad(&drawArgs[4]), P.maxVerts));
  atomicStore(&drawArgs[1], 1u);
}

/** the window slid: every creature and every point of its body with it (by -shift) */
@compute @workgroup_size(64)
fn shiftIt(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  // (WorldCore.onShift's sense, as the agents' Translator: the window moved by d, so what's in it moves by -d)
  let d = -P.shift.xyz;
  agents[i * AS] = agents[i * AS] + vec4<f32>(d, 0.0);
  // (a3.xy is a spot it walks to — townsfolk keep their path's direction there instead)
  let a0 = agents[i * AS];
  if (a0.w >= 0.0 && u32(hdr(u32(a0.w), 1u).x) != B_TOWN) {
    let a3 = agents[i * AS + 3u];
    agents[i * AS + 3u] = vec4<f32>(a3.xy + d.xy, a3.zw);
  }
  let base = i * MAXP * 2u;
  for (var k = 0u; k < MAXP * 2u; k++) { pose[base + k] = pose[base + k] + vec4<f32>(d, 0.0); }
}
