// ---- agents: the units (round 52, docs/AGENTS.md) ------------------------------
// One thread a unit (appended to agents.wgsl, whose surfaces, fields and
// params it reads). Per tick a unit:
//  * takes the game's hits (a circle or a cone: damage, a push along a
//    direction or outward, maybe set alight), reporting hurt and death;
//  * burns (damage over time, running about) once alight: from the game's
//    hits or the fire field where it stands; water puts it out;
//  * wades, slowed by the water's depth, and drowns in water over its height;
//  * behaves as its kind says: a worker (notice 0) follows its group's field;
//    a hostile kind wanders until its field says a target is within notice,
//    closes in down the field, and swings when one is in reach (a swing event
//    the game turns into damage on its unit);
//  * is pushed apart by the crowd, never crosses a missing link or leaves its
//    field's place, rides its surface's height.
// unitDraw then writes each unit's voxels: its kind's model, or the default
// figure (legs, torso, head), facing its way; alight it flickers and a hit
// flashes it (the physics voxel's heat glow, render.wgsl fsBody).
//
// A unit, four vec4<f32>:
//   a: x, y, z (its feet), info (u32 bits): group 0-7 | alive 8 | kind 9-11 |
//      state 12-14 | alight 15 | generation 16-31 (its id: gen * 8192 + slot)
//   b: vx, vy, vz, stride phase
//   c: hp, swing cooldown (s), fire left (s), heading (rad)
//   d: hurt flash (s), state time (s), time under water (s), wander heading (rad)
@group(0) @binding(7) var<storage, read_write> units: array<vec4<f32>>;
// units per column, two halves: the tick writes one (tick % 2) and reads the
// other, the last tick's count
@group(0) @binding(8) var<storage, read_write> occ: array<atomic<u32>>;
// events out: [0] the count (may pass the capacity: the CPU reports what
// didn't fit), then 8 u32 each from index 4: kind, unit id, other (a target,
// a hit id), amount (f32 bits), x, y, z (f32 bits), 0
@group(0) @binding(13) var<storage, read_write> events: array<atomic<u32>>;
@group(0) @binding(14) var<storage, read> fire: array<f32>;
// (unitDraw; bindings past common.wgsl's) the draw: voxels in the body format, two vec4<u32> each; their
// count (indirect args, [1] instances); the kinds' models: per voxel x, y, z
// (cells from the feet, f32) and the material (u32 bits)
@group(0) @binding(9) var<storage, read_write> inst: array<vec4<u32>>;
@group(0) @binding(22) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(23) var<storage, read> models: array<vec4<f32>>;
// per kind (8): x first voxel in `models`, y its count (0: the default
// figure), z the voxel's edge (sixteenths of a cell), w unused
@group(0) @binding(24) var<uniform> kindModels: array<vec4<u32>, 8>;

const ST_WANDER: u32 = 0u;
const ST_CHASE: u32 = 1u;
const ST_SWING: u32 = 2u;
const EV_SWING: u32 = 1u;
const EV_HURT: u32 = 2u;
const EV_DEATH: u32 = 3u;
const EV_ALIGHT: u32 = 4u;
const BY_FIRE: u32 = 0xffffffffu;
const BY_WATER: u32 = 0xfffffffeu;
const MAX_SLOTS: u32 = 8192u;
// a swing: the blow lands this far in (s), the swing ends at SWING_END
const SWING_HIT: f32 = 0.3;
const SWING_END: f32 = 0.6;
const BURN_TIME: f32 = 6.0;
const BURN_DPS: f32 = 2.0;
const DROWN_TIME: f32 = 3.0;
const MAX_INST: u32 = 65536u;

fn unitInfo(a: vec4<f32>) -> u32 { return bitcast<u32>(a.w); }
fn unitId(u: u32, info: u32) -> u32 { return (info >> 16u) * MAX_SLOTS + u; }

fn emit(kind: u32, id: u32, other: u32, amount: f32, p: vec3<f32>) {
  let e = atomicAdd(&events[0], 1u);
  if (e >= AP.n2.z) { return; }
  let o = 4u + e * 8u;
  atomicStore(&events[o], kind);
  atomicStore(&events[o + 1u], id);
  atomicStore(&events[o + 2u], other);
  atomicStore(&events[o + 3u], bitcast<u32>(amount));
  atomicStore(&events[o + 4u], bitcast<u32>(p.x));
  atomicStore(&events[o + 5u], bitcast<u32>(p.y));
  atomicStore(&events[o + 6u], bitcast<u32>(p.z));
}

@compute @workgroup_size(64)
fn occClear(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < G.mapW * G.mapH) { atomicStore(&occ[(AP.n.w % 2u) * G.mapW * G.mapH + id.x], 0u); }
}

/** The way down field `fld` from surface s of cell c, at pos (0 at a seed, or none). */
fn downField(fld: u32, s: u32, c: vec2<i32>, pos: vec2<f32>, here: f32) -> vec2<f32> {
  let N = ns();
  var g = vec2<f32>(0.0);
  var bestD = here;
  var bestDir = vec2<f32>(0.0);
  for (var d = 0u; d < NDIR; d++) {
    let l = navLink(s, d);
    if (l == 0u) { continue; }
    let t = colIdxI(nbr(c, d)) * NAV_K + l - 1u;
    let dn = dist[fld * N + t];
    if (dn >= FAR) { continue; }
    let toward = normalize(cellPos(nbr(c, d)) - pos);
    g += toward * max(here - dn, 0.0);
    if (dn < bestD) { bestD = dn; bestDir = toward; }
  }
  // (the gradient, unless it points nowhere useful: then the best step)
  return select(bestDir, normalize(g), length(g) > 0.2 && dot(normalize(g), bestDir) > 0.3);
}

@compute @workgroup_size(64)
fn unitStep(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  var a = units[u * 4u];
  var b = units[u * 4u + 1u];
  var cc = units[u * 4u + 2u];
  var dd = units[u * 4u + 3u];
  var info = unitInfo(a);
  if (((info >> 8u) & 1u) == 0u) { return; }
  let uid = unitId(u, info);
  let grp = info & 0xffu;
  let kind = AP.kinds[(info >> 9u) & 7u];
  var state = (info >> 12u) & 7u;
  var alight = ((info >> 15u) & 1u) != 0u;
  let height = kind.a.x;
  let mass = max(kind.a.y, 0.1);
  let fld = AP.groupField[grp / 4u][grp % 4u];
  let N = ns();
  let dt = G.dt;
  let rd = ((AP.n.w + 1u) % 2u) * G.mapW * G.mapH;
  let wr = (AP.n.w % 2u) * G.mapW * G.mapH;
  var pos = a.xyz;
  var vel = b.xy;
  var hp = cc.x;
  var cool = max(cc.y - dt, 0.0);
  var burn = cc.z;
  var heading = cc.w;
  var flash = max(dd.x - dt, 0.0);
  var stT = dd.y + dt;
  var under = dd.z;
  var wanderH = dd.w;
  var push = vec2<f32>(0.0);
  var killedBy = 0u;
  var dead = false;

  // the game's hits
  for (var h = 0u; h < AP.n2.x; h++) {
    let hit = AP.hits[h];
    let off = pos + vec3<f32>(0.0, 0.0, height * 0.5) - hit.a.xyz;
    let r = length(off.xy);
    // (z below -1e8: any height)
    if (r > hit.a.w + 0.3 || (hit.a.z > -1e8 && abs(off.z) > hit.a.w + height)) { continue; }
    if (hit.b.z > -1.5 && r > 0.3 && dot(off.xy / r, hit.b.xy) < hit.b.z) { continue; }
    let hid = u32(hit.c.w);
    if (hit.b.w > 0.0) {
      hp -= hit.b.w;
      flash = 0.15;
      emit(EV_HURT, uid, hid, hit.b.w, pos);
      if (hp <= 0.0 && !dead) { dead = true; killedBy = hid; }
    }
    let away = select(hit.b.xy, off.xy / max(r, 0.01), hit.c.y > 0.5);
    push += away * hit.c.x / mass;
    if (hit.c.z > 0.5 && !alight) { alight = true; burn = BURN_TIME; emit(EV_ALIGHT, uid, hid, 0.0, pos); }
  }

  let c = clampCell(cellAt(pos.xy));
  let i = colIdxI(c);
  let k = surfaceAt(i, pos.z + 0.5);
  var floorZ = pos.z;
  // water: wading slows, over its head it drowns (and it puts out fire)
  let depth = select(0.0, water[i], k == 0u);
  if (depth > height) { under += dt; } else { under = 0.0; }
  if (depth > height * 0.5) { alight = false; burn = 0.0; }
  if (under > DROWN_TIME && !dead) { dead = true; killedBy = BY_WATER; }
  // fire: catches where the ground burns
  if (!alight && fire[i] > 0.3 && k == 0u) { alight = true; burn = BURN_TIME; emit(EV_ALIGHT, uid, BY_FIRE, 0.0, pos); }
  if (alight) {
    hp -= BURN_DPS * dt;
    burn -= dt;
    if (burn <= 0.0) { alight = false; }
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_FIRE; }
  }
  if (dead) {
    emit(EV_DEATH, uid, killedBy, 0.0, pos);
    units[u * 4u] = vec4<f32>(pos, bitcast<f32>(info & ~(1u << 8u)));
    return;
  }

  // what it wants to do
  var want = vec2<f32>(0.0);
  var speed = kind.a.w;
  if (k < NAV_K) {
    let s = i * NAV_K + k;
    floorZ = navZ(s);
    let here = select(FAR, dist[fld * N + s], fld < AP.n.z);
    let worker = kind.b.w <= 0.0;
    // the nearest target, as the crow flies
    var tgt = -1;
    var td = FAR;
    for (var t = 0u; t < AP.n2.y; t++) {
      let tp = AP.targets[t];
      let dd2 = length(tp.xy - pos.xy) - tp.w;
      if (dd2 < td && abs(tp.z - pos.z) < height + 2.0) { td = dd2; tgt = i32(t); }
    }
    if (!worker) {
      if (state == ST_WANDER && here < kind.b.w) { state = ST_CHASE; stT = 0.0; }
      if (state == ST_CHASE && here > kind.b.w * 1.5) { state = ST_WANDER; stT = 0.0; }
      if (state == ST_CHASE && tgt >= 0 && td < kind.b.x && cool <= 0.0) { state = ST_SWING; stT = 0.0; }
    }
    if (state == ST_SWING) {
      speed = 0.0;
      if (tgt >= 0) { heading = atan2(AP.targets[tgt].y - pos.y, AP.targets[tgt].x - pos.x); }
      // (the blow lands once, partway into the swing, if it's still in reach)
      if (stT >= SWING_HIT && stT - dt < SWING_HIT && tgt >= 0 && td < kind.b.x * 1.3) {
        emit(EV_SWING, uid, u32(tgt), kind.b.y, pos);
      }
      if (stT > SWING_END) { state = ST_CHASE; stT = 0.0; cool = kind.b.z; }
    } else if (state == ST_WANDER && !worker) {
      // (a new heading now and then; slower than closing in)
      if (rand3(u, G.tick, 7u) < dt * 0.4) { wanderH = rand3(u, G.tick, 8u) * 6.2832; }
      want = vec2<f32>(cos(wanderH), sin(wanderH)) * 0.4;
    } else if (here < FAR && here > 0.6) {
      want = downField(fld, s, c, pos.xy, here);
    }
    if (alight) {
      // burning: running about, faster
      want = normalize(want + (vec2<f32>(rand3(u, G.tick / 20u, 9u), rand3(u, G.tick / 20u, 10u)) - 0.5) * 2.5 + vec2<f32>(1e-4, 0.0));
      speed *= 1.5;
    }
    // apart from the crowd: away from the busier neighbours
    let mine = f32(atomicLoad(&occ[rd + i]));
    var crowd = vec2<f32>(0.0);
    for (var d = 0u; d < NDIR; d++) {
      let q = nbr(c, d);
      if (!inMap(q) || navLink(s, d) == 0u) { continue; }
      crowd -= DIRV[d] * f32(atomicLoad(&occ[rd + colIdxI(q)]));
    }
    let jit = vec2<f32>(rand3(u, G.tick, 1u), rand3(u, G.tick, 2u)) - 0.5;
    want += crowd * 0.25 + jit * 0.2 * max(mine - 1.0, 0.0);
  }
  // wading: slower the deeper
  speed *= 1.0 - 0.6 * clamp(depth / max(height, 0.1), 0.0, 1.0);
  let goalV = select(want, normalize(want), length(want) > 1.0) * speed;
  vel += (goalV - vel) * min(dt * 6.0, 1.0) + push;
  // (a shove beyond walking eases off)
  var np = pos.xy + vel * dt;
  // never step where there's no link, nor off the place its field is
  // confined to: slide along instead
  let nc = clampCell(cellAt(np));
  let fp = select(0u, AP.fieldPlace[min(fld, 3u)], fld < AP.n.z);
  if (k < NAV_K && any(nc != c)) {
    var ok = false;
    for (var d = 0u; d < NDIR; d++) {
      let l = navLink(i * NAV_K + k, d);
      if (!all(nbr(c, d) == nc) || l == 0u) { continue; }
      let t = colIdxI(nc) * NAV_K + l - 1u;
      ok = fp == 0u || select(nav[t].z, nav[t].w, (fp >> 31u) != 0u) == (fp & 0x7fffffffu);
    }
    if (!ok) { np = pos.xy; vel *= 0.3; }
  }
  // ride the surface: step up and drop down smoothly
  let ni = colIdxI(clampCell(cellAt(np)));
  let k2 = surfaceAt(ni, pos.z + 0.5);
  if (k2 < NAV_K) { floorZ = navZ(ni * NAV_K + k2); }
  var z = pos.z + (floorZ - pos.z) * min(dt * 10.0, 1.0);
  // (just placed, from above: straight onto it)
  if (pos.z - floorZ > DROP * 2.0) { z = floorZ; }
  let sp = length(vel);
  if (sp > 0.05 && state != ST_SWING) { heading = atan2(vel.y, vel.x); }
  let phase = fract(b.w + dt * sp * 0.9);
  info = (info & ~((7u << 12u) | (1u << 15u))) | (state << 12u) | (select(0u, 1u, alight) << 15u);
  units[u * 4u] = vec4<f32>(np, z, bitcast<f32>(info));
  units[u * 4u + 1u] = vec4<f32>(vel, 0.0, phase);
  units[u * 4u + 2u] = vec4<f32>(hp, cool, burn, heading);
  units[u * 4u + 3u] = vec4<f32>(flash, stT, under, wanderH);
  atomicAdd(&occ[wr + ni], 1u);
}

fn putVoxel(o: u32, c: vec3<f32>, word: u32, q: vec4<f32>) {
  if (o >= MAX_INST) { return; }
  inst[o * 2u] = vec4<u32>(bitcast<u32>(c.x), bitcast<u32>(c.y), bitcast<u32>(c.z), word);
  inst[o * 2u + 1u] = bitcast<vec4<u32>>(q);
}
fn qrotv(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// the default figure's legs (dark: asphalt) and head (pale: canvas)
const MAT_LEGS: u32 = 6u;
const MAT_HEAD: u32 = 21u;
const PHYS_BIT: u32 = 0x40000000u;

/** Each live unit's voxels (after unitStep), appended. */
@compute @workgroup_size(64)
fn unitDraw(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  let a = units[u * 4u];
  let info = unitInfo(a);
  if (((info >> 8u) & 1u) == 0u) { return; }
  let b = units[u * 4u + 1u];
  let cc = units[u * 4u + 2u];
  let dd = units[u * 4u + 3u];
  let kn = (info >> 9u) & 7u;
  let kind = AP.kinds[kn];
  let km = kindModels[kn];
  let grp = info & 0xffu;
  let h = kind.a.x;
  let yaw = cc.w;
  let q = vec4<f32>(0.0, 0.0, sin(yaw * 0.5), cos(yaw * 0.5));
  let sp = length(b.xy);
  let bob = abs(sin(b.w * 6.2832)) * 0.05 * h * min(sp, 1.0);
  // alight: a flicker of heat; hurt: a white flash (fsBody's physics-voxel glow, bits 16-23)
  let alight = ((info >> 15u) & 1u) != 0u;
  var heat = 0.0;
  if (alight) { heat = 0.45 + 0.25 * rand3(u, G.tick / 3u, 11u); }
  if (dd.x > 0.0) { heat = 1.0; }
  let glow = select(0u, PHYS_BIT | (u32(heat * 255.0) << 16u), heat > 0.0);
  let n = select(3u, km.y, km.y > 0u);
  let base = atomicAdd(&drawArgs[1], n);
  if (km.y > 0u) {
    // the kind's model: voxels round its feet, turned its way
    let code = km.z;
    for (var v = 0u; v < km.y; v++) {
      let m = models[km.x + v];
      let w = bitcast<u32>(m.w) | (code << 24u) | glow;
      putVoxel(base + v, a.xyz + qrotv(q, m.xyz) + vec3<f32>(0.0, 0.0, bob), w, q);
    }
    return;
  }
  // the default figure: legs, torso (its kind's colour, else its group's), head
  var torso = kind.c.z;
  if (torso == 0u) { torso = AP.groupMat[grp / 4u][grp % 4u]; }
  let lg = h * 0.27;
  let ts = h * 0.4;
  let code = vec3<u32>(vec3<f32>(lg, ts, lg) * 16.0 + 0.5);
  putVoxel(base, a.xyz + vec3<f32>(0.0, 0.0, lg * 0.5), select(MAT_LEGS, kind.c.x, kind.c.x != 0u) | (min(code.x, 63u) << 24u) | glow, q);
  putVoxel(base + 1u, a.xyz + vec3<f32>(0.0, 0.0, lg + ts * 0.5 + bob), torso | (min(code.y, 63u) << 24u) | glow, q);
  putVoxel(base + 2u, a.xyz + vec3<f32>(cos(yaw), sin(yaw), 0.0) * 0.03 * h + vec3<f32>(0.0, 0.0, lg + ts + lg * 0.5 + bob), select(MAT_HEAD, kind.c.y, kind.c.y != 0u) | (min(code.z, 63u) << 24u) | glow, q);
}
