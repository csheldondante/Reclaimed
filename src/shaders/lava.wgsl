// ---- lava (molten rock): heat, melting, setting, vents (docs/PHYSICS.md "Lava") --
// One material for the beam and volcanoes (DECISIONS round 47). Per column:
//   lava: x depth, y temperature, z the ground's heat at its top, w the lava's
//   surface height (the physics voxels read it: what's in it heats up)
// `depth`, each tick:
//  - applies the flux (lava_flux.wgsl), carrying each share's heat with it;
//  - the beam heats the ground where it hits (and the lava on it); ground
//    past MELT melts off the top of the column's layers (in place: each
//    thread owns its column's slots, as in sediment.wgsl) into lava;
//  - vents pour fresh lava;
//  - lava cools (thin lava fastest), water over it boils off as steam and
//    quenches it; below SET it turns to basalt on top of the column;
//  - hot lava spits embers (they light what they land on: fire.wgsl), and
//    vents throw up ash and smoke.
// `prep`: one prism per column with lava (or ground hot enough to glow) for
// the opaque pipeline, temperature in the damage bits.
@group(0) @binding(3) var<storage, read> lava: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> lavaFlux: array<Dirs>;
@group(0) @binding(5) var<storage, read_write> lavaOut: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> water: array<f32>;
@group(0) @binding(7) var<storage, read_write> layers: array<vec4<u32>>;
@group(0) @binding(8) var<storage, read_write> inst: array<vec4<u32>>;
@group(0) @binding(9) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read_write> parts: array<PartL>;
@group(0) @binding(13) var<storage, read_write> counters: array<atomic<u32>>;

struct LavaU {
  // the beam: where it hits (xyz) and its radius; power (heat/s), on
  beam: vec4<f32>,
  beam2: vec4<f32>,
  // vents: x, y, rate (cells³/s), radius (0: none)
  vents: array<vec4<f32>, 4>,
};
@group(0) @binding(22) var<uniform> LU: LavaU;

struct PartL { p: vec4<f32>, v: vec4<f32>, m: vec4<u32> };
const K_ASH_L: u32 = 4u;
const K_SMOKE_L: u32 = 8u;
const K_EMBER_L: u32 = 9u;
// smoke's state: steam (particles_draw.wgsl draws it white)
const SMOKE_STEAM: u32 = 2u;

const MAT_BASALT: u32 = 23u;
const MAT_LAVA: u32 = 24u;
const DT_L: f32 = 1.0 / 60.0;
// the ground melts past this, and soaks up this much heat per cell melted
const MELT: f32 = 1300.0;
const LATENT: f32 = 4000.0;
// fresh lava, and where it sets to stone
const LAVA_HOT: f32 = 1250.0;
const VENT_T: f32 = 1350.0;
const LAVA_MAX: f32 = 1400.0;
const SET: f32 = 750.0;
// how fast it sets once cool enough (cells/s)
const SET_RATE: f32 = 0.6;
// loose ground thinner than this on top slid onto setting lava: it sets under it
const SKIN: f32 = 0.3;
// cooling: e-folds per second for a cell of depth (thinner cools faster)
const COOL: f32 = 0.06;
// the ground's heat leaks away (e-fold, s)
const GROUND_COOL_S: f32 = 1.5;
// water boils off it (cells/s at LAVA_HOT), each cell taking this much heat
const BOIL: f32 = 0.8;
const QUENCH: f32 = 2500.0;
// the beam heats the ground it hits within this height of the column's top
const BEAM_REACH: f32 = 2.5;
// the floor the beam can't melt through
const FLOOR_Z: f32 = 1.0;

fn spawnL(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, seed: u32, state: u32) {
  let k = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[k] = PartL(vec4<f32>(pos, life), vec4<f32>(vel, 0.0), vec4<u32>(kind, seed, 0u, state));
}
fn chance(i: u32, salt: u32) -> f32 { return f32(hash3(i, G.tick, salt) >> 8u) / 16777216.0; }

@compute @workgroup_size(8, 8)
fn depth(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let i = colIdxI(p);
  let cp = cellPos(p);
  let L = lava[i];
  // the flux, carrying heat
  let f = lavaFlux[i];
  var d = L.x - dSum(f);
  var heat = max(d, 0.0) * L.y;
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let a = lavaFlux[j][k ^ 1u];
    d += a;
    heat += a * lava[j].y;
  }
  d = max(d, 0.0);
  var gh = L.z;
  // anything to do here? (most of the map: nothing)
  let beamOn = LU.beam2.y > 0.5 && length(cp - LU.beam.xy) < LU.beam.w;
  var vent = -1;
  for (var v = 0; v < 4; v++) {
    let vv = LU.vents[v];
    if (vv.w > 0.0 && length(cp - vv.xy) < vv.w) { vent = v; }
  }
  if (d <= 1e-5 && gh <= 1.0 && !beamOn && vent < 0) {
    lavaOut[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return;
  }

  // the column's top (its layers, in place)
  let cs = colSlots(id.x, id.y);
  var n = 0u;
  for (var s = 0u; s < cs.y; s++) {
    if (ivEmpty(layers[cs.x + s])) { break; }
    n = s + 1u;
  }
  var top = 0.0;
  if (n > 0u) { top = ivZ1(layers[cs.x + n - 1u]); }

  // the beam: the ground where it hits, and what lava lies there
  if (beamOn) {
    let off = length(cp - LU.beam.xy);
    let r = LU.beam.w;
    let h = LU.beam2.x * (1.0 - off * off / (r * r)) * DT_L;
    if (abs(top + d - LU.beam.z) < BEAM_REACH) {
      gh += h;
      heat += 0.3 * h * max(d, 0.0);
    }
  }
  // ground past melting runs off the top of the column as lava
  if (gh > MELT && n > 0u && top > FLOOR_Z) {
    let v = layers[cs.x + n - 1u];
    let dz = min(min((gh - MELT) / LATENT, ivZ1(v) - ivZ0(v)), top - FLOOR_Z);
    if (dz > 0.0) {
      gh -= dz * LATENT;
      let z1 = ivZ1(v) - dz;
      if (z1 <= ivZ0(v) + 1e-3) {
        layers[cs.x + n - 1u] = IV_NONE;
        n -= 1u;
      } else {
        layers[cs.x + n - 1u] = ivPack(ivZ0(v), z1, ivMat(v), ivAux(v));
      }
      top -= dz;
      d += dz;
      heat += dz * LAVA_HOT;
    }
  }
  gh *= exp(-DT_L / GROUND_COOL_S);
  if (gh < 1.0) { gh = 0.0; }

  // vents pour fresh lava (and smoke, ash, embers)
  if (vent >= 0) {
    let vv = LU.vents[vent];
    let add = vv.z * DT_L / (3.14159 * vv.w * vv.w * 0.6);
    d += add;
    heat += add * VENT_T;
    let s = hash3(i, G.tick, 0x51u);
    if (chance(i, 0x52u) < 0.02) {
      let r = vec3<f32>(f32(s & 255u), f32((s >> 8u) & 255u), f32((s >> 16u) & 255u)) / 255.0 - 0.5;
      spawnL(vec3<f32>(cp, top + d + 0.3), vec3<f32>(r.xy * 6.0, 10.0 + r.z * 6.0), 2.5, K_EMBER_L, s, 0u);
    }
    if (chance(i, 0x53u) < 0.015) {
      spawnL(vec3<f32>(cp, top + d + 0.5), vec3<f32>(0.0, 0.0, 3.0), 9.0, K_SMOKE_L, s ^ 7u, 0u);
    }
    if (chance(i, 0x54u) < 0.01) {
      let r = vec3<f32>(f32(s & 255u), f32((s >> 8u) & 255u), f32((s >> 16u) & 255u)) / 255.0 - 0.5;
      spawnL(vec3<f32>(cp, top + d + 0.5), vec3<f32>(r.xy * 3.0, 8.0 + r.z * 4.0), 12.0, K_ASH_L, s ^ 9u, 0u);
    }
  }

  // (the beam keeps it molten, no hotter than a vent's)
  var T = min(select(0.0, heat / d, d > 1e-5), LAVA_MAX);
  if (d > 1e-5) {
    // it cools, thin lava fastest
    T *= exp(-DT_L * COOL / max(d, 0.15));
    // water over it boils off, quenching it
    let w = water[i];
    if (w > 1e-4 && T > 100.0) {
      let boil = min(w, BOIL * DT_L * T / LAVA_HOT);
      water[i] = w - boil;
      T = max(T - boil * QUENCH / max(d, 0.1), 0.0);
      if (chance(i, 0x55u) < min(boil * 40.0, 0.3)) {
        spawnL(vec3<f32>(cp, top + d + 0.2), vec3<f32>(0.0, 0.0, 2.0), 7.0, K_SMOKE_L, hash3(i, G.tick, 0x56u), SMOKE_STEAM);
      }
    }
    // hot lava spits the odd ember: it lights what it lands on
    if (T > 900.0 && chance(i, 0x57u) < 0.002) {
      let s = hash3(i, G.tick, 0x58u);
      let r = vec2<f32>(f32(s & 255u), f32((s >> 8u) & 255u)) / 255.0 - 0.5;
      spawnL(vec3<f32>(cp, top + d + 0.1), vec3<f32>(r * 4.0, 4.0), 1.5, K_EMBER_L, s, 0u);
    }
    // cool enough, it sets: basalt on top of the column
    if (T < SET) {
      let dz = select(min(d, SET_RATE * DT_L), d, d < 0.03);
      d -= dz;
      // under a skin of loose ground lying on top (sand slumps onto it as it sets:
      // laid over that, it would leave thin basalt and sand slices), onto
      // the basalt there if any; a full column: onto the interval below
      var r = n;
      while (r > 0u && matState(ivMat(layers[cs.x + r - 1u])) == ST_GRANULAR) { r -= 1u; }
      // (only a skin of it: the ground the lava came to rest on stays under it)
      if (r < n && top - ivZ0(layers[cs.x + r]) > SKIN) { r = n; }
      // (a full column, all loose: onto its lowest interval)
      if (n >= cs.y) { r = max(r, 1u); }
      let extend = r > 0u && (ivMat(layers[cs.x + r - 1u]) == MAT_BASALT || n >= cs.y);
      if (!extend) {
        // (room for a new interval at r: what's above moves up a slot)
        for (var s = n; s > r; s--) { layers[cs.x + s] = layers[cs.x + s - 1u]; }
        let base = select(top, ivZ0(layers[cs.x + r + 1u]), r < n);
        layers[cs.x + r] = ivPack(base, base, MAT_BASALT, 0u);
        n += 1u;
        r += 1u;
      }
      let v = layers[cs.x + r - 1u];
      layers[cs.x + r - 1u] = ivPack(ivZ0(v), ivZ1(v) + dz, ivMat(v), ivAux(v));
      for (var s = r; s < n; s++) {
        let u = layers[cs.x + s];
        layers[cs.x + s] = ivPack(ivZ0(u) + dz, ivZ1(u) + dz, ivMat(u), ivAux(u));
      }
      top += dz;
    }
  }
  if (d <= 1e-5) { d = 0.0; T = 0.0; }
  lavaOut[i] = vec4<f32>(d, T, gh, top + d);
}

@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let i = colIdx(id.x, id.y);
  let L = lava[i];
  // lava, or ground glowing from the beam: a prism (a film, for the ground)
  let glowT = max(L.y, L.z * 0.8);
  if (L.x < 0.02 && L.z < 300.0) { return; }
  let surf = L.w;
  let z0 = select(surf - L.x, surf - 0.04, L.x < 0.02);
  let z1 = max(surf, z0 + 0.04) + select(0.0, 0.02, L.x < 0.02);
  let k = atomicAdd(&indirect[1], 1u);
  // (temperature in the damage bits: 0..15)
  let t = u32(clamp(glowT / 1400.0, 0.0, 1.0) * 15.0);
  inst[k] = vec4<u32>(id.x | (id.y << 12u), bitcast<u32>(z0), bitcast<u32>(z1), MAT_LAVA | (t << 16u));
}
