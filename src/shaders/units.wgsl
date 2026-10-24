// ---- agents: the units (round 52, docs/AGENTS.md) ------------------------------
// One thread a unit (appended to agents.wgsl, whose surfaces, fields and
// params it reads). Per tick a unit:
//  * takes the game's hits (a circle or a cone: damage, a push along a
//    direction or outward, maybe set alight), reporting hurt and death; a
//    push past TUMBLE_PUSH throws it: it tumbles;
//  * feels the world's wind (windAt: storms, gusts, blows and blasts,
//    wakes, cyclones) past a calm, ÷ its mass: on the ground it drifts, and
//    past its feet's grip it's thrown; in the air it's carried along;
//    sheltered under a roof, nothing;
//  * held (the game carries it: a lich, a gorilla) sits where the game puts
//    it; let go, or launched, it tumbles with the velocity given;
//  * tumbling, flies and falls, bounces off the ground and the walls (a hard
//    landing or a slam hurts), knocks over the units it runs into (sharing
//    its momentum by mass: per-column shoves), and gets up once it settles;
//  * burns (damage over time, running about) once alight: from the game's
//    hits, the fire field, lava or hot ground, an ember landing on it, or a
//    burning unit next to it; water puts it out; lava hurts besides;
//  * wades, slowed by the water's depth, and drowns in water over its height;
//  * behaves as its kind says: a worker (notice 0) follows its group's field;
//    a hostile kind wanders until its field says a target is within notice,
//    closes in down the field, and swings when one is in reach (a swing event
//    the game turns into damage on its unit);
//  * walking, is pushed apart by the crowd, never crosses a missing link or
//    leaves its field's place, rides its surface's height.
// unitDraw then writes each unit's voxels: its kind's model, or the default
// figure (legs, torso, head), facing its way, rolled along its throw while
// tumbling; alight it flickers and a hit flashes it (the physics voxel's
// heat glow, render.wgsl fsBody).
//
// A unit, four vec4<f32>:
//   a: x, y, z (its feet), info (u32 bits): group 0-7 | alive 8 | kind 9-11 |
//      state 12-14 | alight 15 | generation 16-31 (its id: gen * 8192 + slot)
//   b: vx, vy, vz, stride phase (tumbling: its stun, s: how much longer
//      than GETUP it stays down once settled)
//   c: hp, swing cooldown (s), fire left (s), heading (rad)
//   d: hurt flash (s), state time (s), time under water (s), wander heading
//      (rad; tumbling: how far it has rolled)
@group(0) @binding(7) var<storage, read_write> units: array<vec4<f32>>;
// units per column, two halves: the tick writes one (tick % 2) and reads the
// other, the last tick's count
@group(0) @binding(8) var<storage, read_write> occ: array<atomic<u32>>;
// events out: [0] the count (may pass the capacity: the CPU reports what
// didn't fit), then 8 u32 each from index 4: kind, unit id, other (a target,
// a hit id), amount (f32 bits), x, y, z (f32 bits), 0
@group(0) @binding(13) var<storage, read_write> events: array<atomic<u32>>;
@group(0) @binding(14) var<storage, read> fire: array<f32>;
// lava (sim/lava.ts): x depth, y temperature, z the ground's heat (°C)
// (binding 15 is the wind texture: common.wgsl windTex, read by windAt)
@group(0) @binding(25) var<storage, read> lava: array<vec4<f32>>;
// shoves per column, two halves as occ: what tumbling units carried through
// it (x, y momentum and mass, ×SHOVE_FIX) and how many burning units (w)
@group(0) @binding(16) var<storage, read_write> shove: array<atomic<i32>>;
// embers landed (particles.wgsl): x the tick it landed
@group(0) @binding(19) var sparkTex: texture_2d<f32>;
// (unitDraw; bindings past common.wgsl's) the draw: voxels in the body
// format, two vec4<u32> each; their count (indirect args, [1] instances);
// the kinds' models: per voxel x, y, z (cells from the feet, f32) and the
// material (u32 bits)
@group(0) @binding(9) var<storage, read_write> inst: array<vec4<u32>>;
@group(0) @binding(22) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(23) var<storage, read> models: array<vec4<f32>>;
// per kind (8): x first voxel in `models`, y its count (0: the default
// figure), z the voxel's edge (sixteenths of a cell), w unused
@group(0) @binding(24) var<uniform> kindModels: array<vec4<u32>, 8>;
// what each unit carries (round 63; agents.ts carry), by slot: x its
// material (0: nothing), y its edge (cells). Held over its head, dropped
// (the CPU's doing) when it's knocked down.
@group(0) @binding(26) var<storage, read> carried: array<vec4<f32>>;
// items in flight (agents.ts throwItem), two vec4 each: where (w its
// material, 0: none), then x its edge, y its spin (rad), zw the axis it spins
// about (level)
@group(0) @binding(27) var<storage, read> flying: array<vec4<f32>>;
const MAX_FLY: u32 = 128u;

const ST_WANDER: u32 = 0u;
const ST_CHASE: u32 = 1u;
const ST_SWING: u32 = 2u;
const ST_TUMBLE: u32 = 3u;
const ST_HELD: u32 = 4u;
const EV_SWING: u32 = 1u;
const EV_HURT: u32 = 2u;
const EV_DEATH: u32 = 3u;
const EV_ALIGHT: u32 = 4u;
// a swing begins: the target, and how long (s) until the blow lands (a parry's window)
const EV_WINDUP: u32 = 5u;
const BY_FIRE: u32 = 0xffffffffu;
const BY_WATER: u32 = 0xfffffffeu;
const BY_IMPACT: u32 = 0xfffffffdu;
const BY_LAVA: u32 = 0xfffffffcu;
const MAX_SLOTS: u32 = 8192u;
// a swing: the blow lands this far in (s), the swing ends at SWING_END
const SWING_HIT: f32 = 0.3;
const SWING_END: f32 = 0.6;
const BURN_TIME: f32 = 6.0;
const BURN_DPS: f32 = 2.0;
const LAVA_DPS: f32 = 8.0;
// lava this hot sets alight, and ground this hot (°C)
const LAVA_LIGHT: f32 = 750.0;
const HOT_GROUND: f32 = 300.0;
const DROWN_TIME: f32 = 3.0;
// a push past this (cells/s, after the mass) throws it
const TUMBLE_PUSH: f32 = 5.0;
const GRAVITY: f32 = 20.0;
// tumbling: what's left of a landing's speed, a slam's; the ground's grip
const BOUNCE: f32 = 0.35;
const SLAM_BOUNCE: f32 = 0.35;
const ROLL_GRIP: f32 = 3.0;
const LAND_SKID: f32 = 0.6;
// a landing (falling speed) or slam (into a wall) harder than this hurts, per cell/s past it
const HURT_SPEED: f32 = 10.0;
const HURT_PER: f32 = 1.0;
// the wind (round 57): calmer than WIND_CALM (cells/s) it does nothing; past
// it, a force of WIND_K × the excess² ÷ mass (cells/s²) along it. On the
// ground the feet hold up to WIND_GRIP of it (it drifts), past that it's
// thrown (hopping by WIND_HOP of the excess); in the air the force carries it
// until it moves as fast as the wind. A worker (mass 1) is thrown past 14
// cells/s, an ogre (3) past ~18.4.
const WIND_CALM: f32 = 8.0;
const WIND_K: f32 = 0.5;
const WIND_GRIP: f32 = 18.0;
const WIND_HOP: f32 = 0.35;
// settled this long (s), it gets up
const GETUP: f32 = 0.6;
// a shove: the momentum carried through a column, fixed point
const SHOVE_FIX: f32 = 100.0;
// knocked over when what runs into it would move it this fast (cells/s)
const KNOCK_SPEED: f32 = 2.5;
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
  let cols = G.mapW * G.mapH;
  if (id.x >= cols) { return; }
  let wr = AP.n.w % 2u;
  atomicStore(&occ[wr * cols + id.x], 0u);
  for (var k = 0u; k < 4u; k++) { atomicStore(&shove[(wr * cols + id.x) * 4u + k], 0); }
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

/**
 * Open air at height z in column i: within a surface's headroom (the air
 * over it), or above the top one. Below the lowest surface, or in a gap too
 * low to be a surface, it's solid. A column with no surfaces is all air.
 */
fn airAt(i: u32, z: f32) -> bool {
  for (var k = 0u; k < NAV_K; k++) {
    let s = i * NAV_K + k;
    let zk = navZ(s);
    if (zk < 0.0) { return k == 0u; }
    if (z < zk - 0.05) { return false; }
    let h = navHead(s);
    // (headroom is capped at 31: the top surface's sky, or a tall hall)
    let last = k + 1u >= NAV_K || navZ(s + 1u) < 0.0;
    if (z <= zk + h || (h >= 30.9 && (last || z < navZ(s + 1u)))) { return true; }
  }
  return false;
}

/** Nothing solid between a and b: open air at points every half cell along it (the ends excluded). */
fn sightClear(a: vec3<f32>, b: vec3<f32>) -> bool {
  let n = u32(clamp(ceil(length(b - a) / 0.5), 1.0, 16.0));
  for (var j = 1u; j < n; j++) {
    let q = mix(a, b, f32(j) / f32(n));
    if (!airAt(colIdxI(clampCell(cellAt(q.xy))), q.z)) { return false; }
  }
  return true;
}

/**
 * How far target t is from a unit's body (at pos, `height` tall): between
 * two vertical capsules, the target's from its feet up its height, radius
 * its radius; and the nearest point of the target, for sight. (round 59: no
 * height band. Reach is the arms' reach in 3D, sight is the geometry's.)
 */
fn targetGap(t: u32, pos: vec3<f32>, height: f32) -> vec4<f32> {
  let tp = AP.targets[t];
  let th = AP.targetH[t / 4u][t % 4u];
  let off = tp.xy - pos.xy;
  let hd = max(length(off) - tp.w, 0.0);
  // the agent's body, feet to a little over its head
  let lo = pos.z;
  let hi = pos.z + height + 0.3;
  let vg = max(max(tp.z - hi, lo - (tp.z + th)), 0.0);
  // the target's nearest point: its edge toward the agent, at the height nearest the chest
  let chest = pos.z + height * 0.6;
  let toward = select(vec2<f32>(0.0), off / max(length(off), 1e-3) * min(tp.w, length(off)), length(off) > 1e-3);
  // (at least half a cell up it: one standing a step higher isn't hidden by the step's edge)
  let near = vec3<f32>(tp.xy - toward, clamp(chest, tp.z + min(0.5, th * 0.5), tp.z + th));
  return vec4<f32>(near, sqrt(hd * hd + vg * vg));
}

/** The floor under a body at height z in column i, or -FAR where z is inside the ground there (a wall). */
fn floorUnder(i: u32, z: f32) -> f32 {
  let k = surfaceAt(i, z + 0.3);
  if (k >= NAV_K) { return -FAR; }
  let s = i * NAV_K + k;
  // (under an overhang: above the air over that surface is solid again)
  if (k > 0u && z > navZ(s) + navHead(s)) { return -FAR; }
  return navZ(s);
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
  let cols = G.mapW * G.mapH;
  let rd = ((AP.n.w + 1u) % 2u) * cols;
  let wr = (AP.n.w % 2u) * cols;
  var pos = a.xyz;
  var vel = b.xyz;
  var hp = cc.x;
  var cool = max(cc.y - dt, 0.0);
  var burn = cc.z;
  var heading = cc.w;
  var flash = max(dd.x - dt, 0.0);
  var stT = dd.y + dt;
  var under = dd.z;
  var wanderH = dd.w;
  var push = vec2<f32>(0.0);
  // the hits' lift (cells/s, after the mass) and stun (s); 1: a hit gave a lift
  var lift = 0.0;
  var lifted = false;
  var stun = select(0.0, b.w, state == ST_TUMBLE);
  var stunHit = 0.0;
  var killedBy = 0u;
  var dead = false;

  // the game's hits
  for (var h = 0u; h < AP.n2.x; h++) {
    let hit = AP.hits[h];
    let off = pos + vec3<f32>(0.0, 0.0, height * 0.5) - hit.a.xyz;
    let r = length(off.xy);
    // (z below -1e8: any height)
    if (r > hit.a.w + 0.3 || (hit.a.z > -1e8 && abs(off.z) > hit.a.w + height)) { continue; }
    if (hit.b.z > -1.5 && r > 0.3 && dot(off.xy / r, hit.d.xy) < hit.b.z) { continue; }
    // (c.z: bit 0 fire, bits 1-16 the groups it spares)
    let hz = u32(hit.c.z + 0.5);
    if (((hz >> (1u + grp)) & 1u) != 0u) { continue; }
    let hid = u32(hit.c.w);
    if (hit.b.w > 0.0) {
      hp -= hit.b.w;
      flash = 0.15;
      emit(EV_HURT, uid, hid, hit.b.w, pos);
      if (hp <= 0.0 && !dead) { dead = true; killedBy = hid; }
    }
    let away = select(hit.b.xy, off.xy / max(r, 0.01), hit.c.y > 0.5);
    push += away * hit.c.x / mass;
    if (hit.d.z != 0.0) { lift += hit.d.z / mass; lifted = true; }
    stunHit = max(stunHit, hit.d.w);
    if ((hz & 1u) != 0u && !alight) { alight = true; burn = BURN_TIME; emit(EV_ALIGHT, uid, hid, 0.0, pos); }
  }

  // held by the game, or launched: holds and launches name its slot
  var held = false;
  for (var e = 0u; e < AP.n3.x; e++) {
    let hd = AP.holds[e];
    if (u32(hd.w) != u) { continue; }
    held = true;
    vel = (hd.xyz - pos) / max(dt, 1e-3);
    pos = hd.xyz;
  }
  if (held) { state = ST_HELD; stT = 0.0; } else if (state == ST_HELD) { state = ST_TUMBLE; stT = 0.0; }
  for (var e = 0u; e < AP.n3.y; e++) {
    let ln = AP.launches[e];
    // (w: its slot | its stun in hundredths of a second << 13)
    let lw = u32(ln.w);
    if ((lw & 8191u) != u) { continue; }
    vel = ln.xyz;
    if (state != ST_TUMBLE) { stun = 0.0; }
    stun = max(stun, f32(lw >> 13u) / 100.0);
    state = ST_TUMBLE;
    stT = 0.0;
  }
  // thrown by a hit: pushed past TUMBLE_PUSH, or lifted (then the lift is
  // its upward speed; else it hops by a share of the push)
  if ((length(push) > TUMBLE_PUSH || lift > 0.0) && state != ST_HELD) {
    if (state != ST_TUMBLE) { stun = 0.0; }
    vel = vec3<f32>(vel.xy + push, max(vel.z, 0.0) + select(length(push) * 0.35, lift, lifted));
    push = vec2<f32>(0.0);
    state = ST_TUMBLE;
    stT = 0.0;
  }
  // stunned: down for that much longer once it settles (not thrown: where it
  // stands, upright)
  if (stunHit > 0.0 && state != ST_HELD) {
    if (state != ST_TUMBLE) { stun = 0.0; wanderH = 0.0; vel = vec3<f32>(0.0); push = vec2<f32>(0.0); state = ST_TUMBLE; stT = 0.0; }
    stun = max(stun, stunHit);
  }

  let c = clampCell(cellAt(pos.xy));
  let i = colIdxI(c);
  let k = surfaceAt(i, pos.z + 0.5);
  var floorZ = select(pos.z, navZ(i * NAV_K + min(k, NAV_K - 1u)), k < NAV_K);
  // the wind (not under a roof: the top surface, or in the open air above it)
  if (state != ST_HELD && (k == 0u || k >= NAV_K)) {
    let wv = windAt(pos + vec3<f32>(0.0, 0.0, height * 0.5));
    let ws = length(wv);
    let ex = ws - WIND_CALM;
    if (ex > 0.0) {
      let wd = wv / ws;
      let f = WIND_K * ex * ex / mass;
      if (state == ST_TUMBLE) {
        // (carried, never past the wind's own speed; lying on the ground, the
        // grip holds as much as on its feet, so a wind short of throwing it
        // lets it settle and get up)
        let lying = k < NAV_K && pos.z - floorZ < 0.1;
        let fa = select(f, max(f - WIND_GRIP, 0.0), lying);
        let along = dot(vel.xy, wd);
        if (along < ws) { vel = vec3<f32>(vel.xy + wd * min(fa * dt, ws - along), vel.z); }
      } else if (f > WIND_GRIP) {
        vel = vec3<f32>(vel.xy + wd * ex * 0.5, max(vel.z, 0.0) + ex * WIND_HOP);
        state = ST_TUMBLE;
        stT = 0.0;
        stun = 0.0;
      } else {
        push += wd * f * dt;
      }
    }
  }
  // knocked over by what tumbled through here last tick (not itself: it
  // was tumbling then, and a tumbling unit doesn't take shoves)
  if (state != ST_TUMBLE && state != ST_HELD) {
    let sm = f32(atomicLoad(&shove[(rd + i) * 4u + 2u])) / SHOVE_FIX;
    if (sm > 0.0) {
      let p = vec2<f32>(f32(atomicLoad(&shove[(rd + i) * 4u])), f32(atomicLoad(&shove[(rd + i) * 4u + 1u]))) / SHOVE_FIX;
      let v = p / (sm + mass);
      if (length(v) > KNOCK_SPEED) { vel = vec3<f32>(v, length(v) * 0.3); state = ST_TUMBLE; stT = 0.0; stun = 0.0; }
    }
  }
  let onGround = k < NAV_K && state != ST_HELD && pos.z - floorZ < 0.5;
  // water: wading slows, over its head it drowns (and it puts out fire)
  let depth = select(0.0, navWater(i * NAV_K), k == 0u && onGround);
  if (depth > height) { under += dt; } else { under = 0.0; }
  if (depth > height * 0.5) { alight = false; burn = 0.0; }
  if (under > DROWN_TIME && !dead) { dead = true; killedBy = BY_WATER; }
  // fire: where the ground burns, lava, hot ground, an ember just landed, a burning unit by it
  let lv = lava[i];
  let onTop = onGround && k == 0u;
  if (onTop && lv.x > 0.05 && lv.y > LAVA_LIGHT) {
    hp -= LAVA_DPS * dt;
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_LAVA; }
  }
  if (!alight && depth < height * 0.5) {
    var lit = onTop && (fire[i] > 0.3 || (lv.x > 0.05 && lv.y > LAVA_LIGHT) || lv.z > HOT_GROUND);
    let sk = textureLoad(sparkTex, c, 0).x;
    if (sk > 0.0 && f32(G.tick) - sk < 2.5) { lit = true; }
    // (a burning unit here or next door: a chance a second)
    var near = f32(atomicLoad(&shove[(rd + i) * 4u + 3u]));
    for (var d = 0u; d < NDIR; d++) {
      let q = nbr(c, d);
      if (inMap(q)) { near += 0.5 * f32(atomicLoad(&shove[(rd + colIdxI(q)) * 4u + 3u])); }
    }
    if (near > 0.0 && rand3(u, G.tick, 12u) < near * dt * 1.5) { lit = true; }
    if (lit) { alight = true; burn = BURN_TIME; emit(EV_ALIGHT, uid, BY_FIRE, 0.0, pos); }
  }
  if (alight) {
    hp -= BURN_DPS * dt;
    burn -= dt;
    if (burn <= 0.0) { alight = false; }
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_FIRE; }
  }

  var np = pos;
  if (state == ST_HELD) {
    // (where the game holds it: nothing else moves it)
  } else if (state == ST_TUMBLE) {
    // flying, falling, bouncing: free of the links
    vel.z -= GRAVITY * dt;
    np = pos + vel * dt;
    var ni = colIdxI(clampCell(cellAt(np.xy)));
    var fz = floorUnder(ni, np.z);
    if (fz <= -FAR) {
      // a wall: back off it, the way it came, slammed
      let sp = length(vel.xy);
      if (sp > HURT_SPEED) {
        let dmg = (sp - HURT_SPEED) * HURT_PER;
        hp -= dmg;
        flash = 0.15;
        emit(EV_HURT, uid, BY_IMPACT, dmg, pos);
      }
      vel = vec3<f32>(-vel.xy * SLAM_BOUNCE, vel.z);
      np = vec3<f32>(pos.xy, np.z);
      ni = i;
      fz = floorUnder(i, np.z);
    }
    if (fz > -FAR && np.z <= fz + 0.05) {
      // the ground: a landing, bounced, gripped
      let impact = -vel.z;
      if (impact > HURT_SPEED) {
        let dmg = (impact - HURT_SPEED) * HURT_PER;
        hp -= dmg;
        flash = 0.15;
        emit(EV_HURT, uid, BY_IMPACT, dmg, pos);
      }
      np.z = fz;
      vel.z = select(0.0, impact * BOUNCE, impact > 2.0);
      // (a landing takes some of its speed along the ground too, as a skid)
      vel = vec3<f32>(vel.xy * max(1.0 - ROLL_GRIP * dt, 0.0) * select(1.0, LAND_SKID, impact > 2.0), vel.z);
      if (length(vel) > 0.6) { stT = 0.0; }
      // settled long enough: up again
      if (stT > GETUP + stun) {
        state = select(ST_WANDER, ST_CHASE, kind.b.w <= 0.0);
        stT = 0.0;
        vel = vec3<f32>(0.0);
        wanderH = heading;
        stun = 0.0;
      }
    } else {
      stT = 0.0;
    }
    if (hp <= 0.0 && !dead) { dead = true; killedBy = BY_IMPACT; }
    if (state == ST_TUMBLE) {
      // rolling along its throw (the draw turns it about the axis across it)
      wanderH += length(vel) * dt / max(height * 0.5, 0.2);
      if (length(vel.xy) > 0.3) { heading = atan2(vel.y, vel.x); }
    }
    // what it carries knocks over the units in its way
    if (length(vel.xy) > KNOCK_SPEED) {
      let o = (wr + ni) * 4u;
      atomicAdd(&shove[o], i32(vel.x * mass * SHOVE_FIX));
      atomicAdd(&shove[o + 1u], i32(vel.y * mass * SHOVE_FIX));
      atomicAdd(&shove[o + 2u], i32(mass * SHOVE_FIX));
    }
  } else {
    // walking: what it wants to do
    var want = vec2<f32>(0.0);
    var speed = kind.a.w;
    if (k < NAV_K) {
      let s = i * NAV_K + k;
      let here = select(FAR, dist[fld * N + s], fld < AP.n.z);
      let worker = kind.b.w <= 0.0;
      // the nearest target, as the crow flies over the ground (whatever its
      // height: one overhead is chased, and waited for underneath)
      var tgt = -1;
      var td = FAR;
      for (var t = 0u; t < AP.n2.y; t++) {
        let tp = AP.targets[t];
        let dd2 = length(tp.xy - pos.xy) - tp.w;
        if (dd2 < td) { td = dd2; tgt = i32(t); }
      }
      // in reach: within the arms' reach of the target's body, and nothing
      // solid between its chest and the target (a floor, a deck, a wall)
      var reachD = FAR;
      var seen = false;
      if (tgt >= 0 && td < kind.b.x * 1.3) {
        let g = targetGap(u32(tgt), pos, height);
        reachD = g.w;
        if (reachD < kind.b.x * 1.3) { seen = sightClear(pos + vec3<f32>(0.0, 0.0, height * 0.6), g.xyz); }
      }
      if (!worker) {
        if (state == ST_WANDER && here < kind.b.w) { state = ST_CHASE; stT = 0.0; }
        if (state == ST_CHASE && here > kind.b.w * 1.5) { state = ST_WANDER; stT = 0.0; }
        if (state == ST_CHASE && reachD < kind.b.x && seen && cool <= 0.0) {
          state = ST_SWING;
          stT = 0.0;
          emit(EV_WINDUP, uid, u32(tgt), SWING_HIT, pos);
        }
      }
      if (state == ST_SWING) {
        speed = 0.0;
        if (tgt >= 0) { heading = atan2(AP.targets[tgt].y - pos.y, AP.targets[tgt].x - pos.x); }
        // (the blow lands once, partway into the swing, if it's still in reach)
        if (stT >= SWING_HIT && stT - dt < SWING_HIT && reachD < kind.b.x * 1.3 && seen) {
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
    var v2 = vel.xy + (goalV - vel.xy) * min(dt * 6.0, 1.0) + push;
    var p2 = pos.xy + v2 * dt;
    // never step where there's no link, nor off the place its field is
    // confined to: slide along instead
    let nc = clampCell(cellAt(p2));
    let fp = select(0u, AP.fieldPlace[min(fld, 3u)], fld < AP.n.z);
    if (k < NAV_K && any(nc != c)) {
      var ok = false;
      for (var d = 0u; d < NDIR; d++) {
        let l = navLink(i * NAV_K + k, d);
        if (!all(nbr(c, d) == nc) || l == 0u) { continue; }
        let t = colIdxI(nc) * NAV_K + l - 1u;
        ok = fp == 0u || onPlace(t, fp);
      }
      if (!ok) { p2 = pos.xy; v2 *= 0.3; }
    }
    // ride the surface: step up and drop down smoothly
    let ni = colIdxI(clampCell(cellAt(p2)));
    let k2 = surfaceAt(ni, pos.z + 0.5);
    if (k2 < NAV_K) { floorZ = navZ(ni * NAV_K + k2); }
    var z = pos.z + (floorZ - pos.z) * min(dt * 10.0, 1.0);
    // (just placed, from above: straight onto it)
    if (pos.z - floorZ > DROP * 2.0) { z = floorZ; } else if (pos.z - floorZ > DROP) {
      // (walked off an edge higher than a drop: it falls)
      state = ST_TUMBLE;
      stT = 0.0;
      stun = 0.0;
      z = pos.z;
    }
    np = vec3<f32>(p2, z);
    vel = vec3<f32>(v2, 0.0);
    if (length(v2) > 0.05 && state != ST_SWING) { heading = atan2(v2.y, v2.x); }
  }
  if (dead) {
    emit(EV_DEATH, uid, killedBy, 0.0, pos);
    units[u * 4u] = vec4<f32>(pos, bitcast<f32>(info & ~(1u << 8u)));
    return;
  }
  let fi = colIdxI(clampCell(cellAt(np.xy)));
  if (alight) { atomicAdd(&shove[(wr + fi) * 4u + 3u], 1); }
  let phase = fract(b.w + dt * length(vel.xy) * 0.9);
  info = (info & ~((7u << 12u) | (1u << 15u))) | (state << 12u) | (select(0u, 1u, alight) << 15u);
  units[u * 4u] = vec4<f32>(np, bitcast<f32>(info));
  units[u * 4u + 1u] = vec4<f32>(vel, select(phase, stun, state == ST_TUMBLE));
  units[u * 4u + 2u] = vec4<f32>(hp, cool, burn, heading);
  units[u * 4u + 3u] = vec4<f32>(flash, stT, under, wanderH);
  atomicAdd(&occ[wr + fi], 1u);
}

fn putVoxel(o: u32, c: vec3<f32>, word: u32, q: vec4<f32>) {
  if (o >= MAX_INST) { return; }
  inst[o * 2u] = vec4<u32>(bitcast<u32>(c.x), bitcast<u32>(c.y), bitcast<u32>(c.z), word);
  inst[o * 2u + 1u] = bitcast<vec4<u32>>(q);
}
fn qmul(p: vec4<f32>, q: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(p.w * q.xyz + q.w * p.xyz + cross(p.xyz, q.xyz), p.w * q.w - dot(p.xyz, q.xyz));
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
  let state = (info >> 12u) & 7u;
  let h = kind.a.x;
  let yaw = cc.w;
  var q = vec4<f32>(0.0, 0.0, sin(yaw * 0.5), cos(yaw * 0.5));
  // tumbling: rolled along its throw, about the axis across it, round its middle
  let mid = vec3<f32>(0.0, 0.0, h * 0.5);
  if (state == ST_TUMBLE) {
    let ax = vec3<f32>(-sin(yaw), cos(yaw), 0.0);
    q = qmul(vec4<f32>(ax * sin(dd.w * 0.5), cos(dd.w * 0.5)), q);
  }
  let sp = length(b.xy);
  let bob = select(abs(sin(b.w * 6.2832)) * 0.05 * h * min(sp, 1.0), 0.0, state >= ST_TUMBLE);
  // alight: a flicker of heat; hurt: a white flash (fsBody's physics-voxel glow, bits 16-23)
  let alight = ((info >> 15u) & 1u) != 0u;
  var heat = 0.0;
  if (alight) { heat = 0.45 + 0.25 * rand3(u, G.tick / 3u, 11u); }
  if (dd.x > 0.0) { heat = 1.0; }
  let glow = select(0u, PHYS_BIT | (u32(heat * 255.0) << 16u), heat > 0.0);
  let n = select(3u, km.y, km.y > 0u);
  let cv = carried[u];
  let holds = cv.x > 0.5 && state < ST_TUMBLE;
  let base = atomicAdd(&drawArgs[1], n + select(0u, 1u, holds));
  let centre = a.xyz + mid + vec3<f32>(0.0, 0.0, bob);
  if (holds) {
    // its load, held up over its head
    let e = cv.y;
    putVoxel(base + n, centre + qrotv(q, vec3<f32>(0.0, 0.0, h + e * 0.5 + 0.05) - mid), u32(cv.x) | (min(u32(e * 16.0 + 0.5), 63u) << 24u) | glow, q);
  }
  if (km.y > 0u) {
    // the kind's model: voxels round its feet, turned its way
    let code = km.z;
    for (var v = 0u; v < km.y; v++) {
      let m = models[km.x + v];
      let w = bitcast<u32>(m.w) | (code << 24u) | glow;
      putVoxel(base + v, centre + qrotv(q, m.xyz - mid), w, q);
    }
    return;
  }
  // the default figure: legs, torso (its kind's colour, else its group's), head
  var torso = kind.c.z;
  if (torso == 0u) { torso = AP.groupMat[grp / 4u][grp % 4u]; }
  let lg = h * 0.27;
  let ts = h * 0.4;
  let code = vec3<u32>(vec3<f32>(lg, ts, lg) * 16.0 + 0.5);
  putVoxel(base, centre + qrotv(q, vec3<f32>(0.0, 0.0, lg * 0.5) - mid), select(MAT_LEGS, kind.c.x, kind.c.x != 0u) | (min(code.x, 63u) << 24u) | glow, q);
  putVoxel(base + 1u, centre + qrotv(q, vec3<f32>(0.0, 0.0, lg + ts * 0.5) - mid), torso | (min(code.y, 63u) << 24u) | glow, q);
  putVoxel(base + 2u, centre + qrotv(q, vec3<f32>(0.03 * h, 0.0, lg + ts + lg * 0.5) - mid), select(MAT_HEAD, kind.c.y, kind.c.y != 0u) | (min(code.z, 63u) << 24u) | glow, q);
}

/** Items in flight (round 63): a voxel of the material each, tumbling about its axis. */
@compute @workgroup_size(64)
fn itemDraw(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= MAX_FLY) { return; }
  let a = flying[i * 2u];
  if (a.w < 0.5) { return; }
  let b = flying[i * 2u + 1u];
  let k = atomicAdd(&drawArgs[1], 1u);
  let ax = vec3<f32>(b.zw, 0.0);
  let q = select(vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(normalize(ax) * sin(b.y * 0.5), cos(b.y * 0.5)), length(ax) > 1e-3);
  putVoxel(k, a.xyz, u32(a.w) | (min(u32(b.x * 16.0 + 0.5), 63u) << 24u), q);
}
