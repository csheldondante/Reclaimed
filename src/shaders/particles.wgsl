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
@group(0) @binding(9) var<storage, read> veg: array<f32>;
@group(0) @binding(10) var<storage, read> moisture: array<f32>;
// CPU bursts: [0].x = count; then pairs (x, y, z, n) (kind, speed, payload, spread)
@group(0) @binding(11) var<uniform> requests: array<vec4<f32>, 129>;

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

const DT: f32 = 1.0 / 60.0;
// storm cloud deck height (cells): low enough that clouds stay on screen near
// their shadows in the fixed isometric view
const CLOUD_BASE: f32 = 34.0;
const FIX: f32 = 100000.0;
const MAT_SOIL: u32 = 2u;
const MAT_SAND: u32 = 3u;
const MAT_TRASH_P: u32 = 12u;

fn spawn(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, payload: f32, seed: u32) {
  let i = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[i] = Particle(vec4<f32>(pos, life), vec4<f32>(vel, payload), vec4<u32>(kind, seed, 0u, 0u));
}

fn depositAt(pos: vec3<f32>, payload: f32) {
  let c = vec2<i32>(floor(pos.xy));
  if (payload > 0.0 && inMap(c)) { atomicAdd(&contamDelta[colIdxI(c)], i32(payload * FIX)); }
}

// ---- emission from the world (one thread per column, rare per tick) ----
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

  // wind-lifted dust; polluted dust carries contamination with it
  if (!wet) {
    let cs = contam[i].x;
    var dustiness = clamp(cs, 0.0, 1.5) * 0.7;
    if (m == MAT_SOIL || m == MAT_SAND) { dustiness += 0.12; }
    let rate = max(ws - 2.0, 0.0) * 0.0006 * dustiness * dry * (1.0 - cover);
    if (r1 < rate) {
      var payload = 0.0;
      if (cs > 0.03) {
        payload = min(cs * 0.05, 0.02);
        atomicSub(&contamDelta[i], i32(payload * FIX));
      }
      let jit = vec3<f32>(r2 - 0.5, fract(r2 * 7.31) - 0.5, 0.1);
      spawn(base + jit, vec3<f32>(wind * 0.6, 0.8 + r2 * 1.5), 6.0 + r2 * 6.0, K_DUST, payload, h);
    }
    // loose waste blows about as litter
    if (m == MAT_TRASH_P && r2 < max(ws - 2.5, 0.0) * 0.004 * dry) {
      let payload = min(cs * 0.06, 0.03);
      atomicSub(&contamDelta[i], i32(payload * FIX));
      spawn(base + vec3<f32>(r1 - 0.5, 0.0, 0.3), vec3<f32>(wind * 0.4, 1.5 + r1 * 2.0), 40.0, K_LITTER, payload, h);
    }
  }
  // leaves shaken from trees
  if (v >= 3.6 && r1 > 1.0 - (0.0003 + max(ws - 2.0, 0.0) * 0.0006)) {
    spawn(base + vec3<f32>(r2 - 0.5, fract(r2 * 3.7) - 0.5, 3.0 + r2 * 3.0), vec3<f32>(wind * 0.5, 0.0), 12.0, K_LEAF, 0.0, h);
  }
  // cloud puffs born inside storms, high above the land
  for (var k = 0u; k < G.numStorms; k++) {
    let st = G.storms[k];
    let d = length(vec2<f32>(p) - st.xy) / st.z;
    if (d < 0.95 && r2 < 0.00035 * st.w) {
      let z = CLOUD_BASE + r1 * 8.0;
      spawn(vec3<f32>(vec2<f32>(p) + 0.5, z), vec3<f32>(G.stormsB[k].xy, 0.0), 7.0 + r1 * 5.0, K_CLOUD, 0.0, h);
    }
  }
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
  if (kind == K_DUST) {
    drag = 1.6; grav = 0.35 + rain * 6.0; // rain knocks dust out of the air
    vel.z += (vnoise(pos.xy * 0.3 + vec2<f32>(G.time * 2.0, sr * 10.0)) - 0.48) * 4.0 * DT;
  } else if (kind == K_LITTER) {
    drag = 1.2; grav = 4.0;
    if (resting) {
      // lies still until the wind is strong enough to lift it again
      if (length(w) > 3.2 && fract(sr * 13.0 + G.time * 0.7) < 0.02) {
        resting = false;
        vel = vec3<f32>(w * 0.5, 2.0 + sr * 2.5);
      } else {
        vel = vec3<f32>(0.0);
      }
    }
  } else if (kind == K_LEAF) {
    drag = 2.2; grav = 0.9;
    vel.x += sin(G.time * 5.0 + sr * 40.0) * 2.0 * DT;
    vel.y += cos(G.time * 4.3 + sr * 31.0) * 2.0 * DT;
    if (resting) { vel = vec3<f32>(0.0); }
  } else if (kind == K_CLOUD) {
    drag = 0.0; grav = 0.0;
  } else if (kind == K_SMOKE || kind == K_ASH) {
    drag = 1.0; grav = -0.8;
  } else if (kind == K_EMBER) {
    drag = 1.2; grav = -0.4;
  } else if (kind == K_CHIP || kind == K_SPLASH) {
    drag = 0.3; grav = 14.0;
  } else if (kind == K_BIRD) {
    // flee upward, then wheel downwind
    drag = 0.6; grav = -0.15;
    vel.x += cos(G.time * 1.3 + sr * 20.0) * 3.0 * DT;
    vel.y += sin(G.time * 1.1 + sr * 17.0) * 3.0 * DT;
  }

  if (!resting) {
    vel = vec3<f32>(vel.xy + (w - vel.xy) * min(drag * DT, 1.0), vel.z - grav * DT);
    if (kind == K_DUST || kind == K_LEAF) { vel.z *= 0.995; }
    pos += vel * DT;
  }

  if (kind != K_CLOUD && kind != K_BIRD && pos.z <= ground) {
    if (kind == K_DUST) {
      depositAt(pos, P.v.w);
      parts[id.x].p.w = 0.0;
      return;
    }
    if (kind == K_LITTER) {
      if (water[ci] > 0.05) {
        // swept into water: its pollution washes off into the stream
        depositAt(pos, P.v.w);
        parts[id.x].p.w = 0.0;
        return;
      }
      pos.z = ground;
      resting = true;
    } else if (kind == K_LEAF) {
      pos.z = ground;
      resting = true;
      life = min(life, 4.0);
    } else {
      parts[id.x].p.w = 0.0;
      return;
    }
  }

  if (life <= 0.0) {
    depositAt(pos, P.v.w);
    parts[id.x].p.w = 0.0;
    return;
  }
  parts[id.x] = Particle(vec4<f32>(pos, life), vec4<f32>(vel, P.v.w), vec4<u32>(kind, seed, select(0u, 1u, resting), 0u));
}
