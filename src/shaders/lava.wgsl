// ---- lava (molten rock): heat, melting, setting, vents (docs/PHYSICS.md "Lava") --
// One material for the beam and volcanoes (DECISIONS round 47). Per column:
//   lava: x depth, y temperature, z the ground's heat at its top, w the lava's
//   surface height (the physics voxels read it: what's in it heats up)
// `depth`, each tick:
//  - applies the flux (lava_flux.wgsl), carrying each share's heat with it;
//  - the beam heats the ground where it hits (and the lava on it); ground
//    past MELT melts off the top of the column's layers (in place: each
//    thread owns its column's slots, as in sediment.wgsl) into lava;
//  - hitting a column under its top (a cliff's face: round 62), the beam
//    bores into it instead: it melts a round hole about the hit, leaving
//    the rock over it (an overhang), and the melt runs out of the bore a
//    column a tick (spill) until it reaches open air, where it pours out
//    as lava (or, with nowhere to go, sets on the bore's floor);
//  - a volcano's cone rises out of the ground first (the column's layers
//    lifted, its bedrock growing under them), then its vent pours fresh lava
//    into the crater, which runs down the sides;
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
// the bore's melt on its way out (round 62), one column a tick: x how much
// (cells³), y the floor it runs along, z the way it was sent (+1) + 8 × the
// columns it has come, w the way out of this column's bore (+1; kept) + 8 ×
// the heat gathered to bore it
@group(0) @binding(23) var spillIn: texture_2d<f32>;
@group(0) @binding(24) var spillOut: texture_storage_2d<rgba32float, write>;
// the open air's floors (surface.wgsl): x the sky's
@group(0) @binding(29) var levelsL: texture_2d<f32>;
// lava springs (round 69: the atlas's lava tubes): x the depth kept, molten (world-gpu lavaSpring)
@group(0) @binding(30) var springL: texture_2d<f32>;
// how fast a spring tops its column up (cells/s)
const SPRING_RATE: f32 = 1.5;

struct LavaU {
  // the beam: where it hits (xyz) and its radius; power (heat/s), on, the
  // way it points (level: xy; 0 not given)
  beam: vec4<f32>,
  beam2: vec4<f32>,
  // vents: x, y, rate (cells³/s), radius (0: none)
  vents: array<vec4<f32>, 4>,
  // each vent's cone while it rises (round 48): x how fast its peak rises
  // (cells/s; 0: not rising), y its radius, z its crater's radius
  cones: array<vec4<f32>, 4>,
  // (round 86) a meteor's blast, one tick: the ground in a ring round its bowl (x, y the middle, z the bowl's
  // radius, w the ring's outer radius) heated past melting - blast2.x cells of it at the bowl's rim, none at the
  // ring's edge, which only glows; blast2.y 1 on
  blast: vec4<f32>,
  blast2: vec4<f32>,
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
// COOL (was 0.06): G.tune.lavaCool (round 108, src/tune/params.ts)
// the ground's heat leaks away (e-fold, s)
const GROUND_COOL_S: f32 = 1.5;
// (round 92) a column whose top stands more than this over the blast's height doesn't melt
const BLAST_UP: f32 = 4.0;
// water boils off it (cells/s at LAVA_HOT), each cell taking this much heat
const BOIL: f32 = 0.8;
const QUENCH: f32 = 2500.0;
// the beam heats the ground it hits within this height of the column's top
const BEAM_REACH: f32 = 2.5;
// the floor the beam can't melt through
const FLOOR_Z: f32 = 1.0;
// the bore's melt: open air this close over its floor takes it; it sets
// after running this many columns
const OPEN_SLACK: f32 = 0.3;
const SPILL_HOPS: u32 = 48u;

/** The way out of a bore at p: back the way the beam came (back: the way it points, reversed), or downhill when not given. */
fn wayOut(p: vec2<i32>, back: vec2<f32>) -> f32 {
  var best = -1;
  var bv = -1e9;
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    var v = 0.0;
    if (length(back) > 0.5) {
      v = dot(normalize(cellPos(q) - cellPos(p)), back);
    } else {
      if (!inMap(q)) { continue; }
      v = -textureLoad(levelsL, texCol(vec2<i32>(q)), 0).x;
    }
    if (v > bv) { bv = v; best = i32(k); }
  }
  return f32(best + 1);
}

fn spawnL(pos: vec3<f32>, vel: vec3<f32>, life: f32, kind: u32, seed: u32, state: u32) {
  let k = atomicAdd(&counters[0], 1u) % arrayLength(&parts);
  parts[k] = PartL(vec4<f32>(pos, life), vec4<f32>(vel, 0.0), vec4<u32>(kind, seed, 0u, state));
}
/** How a cone rises at distance r from its vent (share of its peak's rate): concave sides, a crater in the middle. */
fn coneShape(off: vec2<f32>, R: f32, cr: f32, seed: f32) -> f32 {
  let r = length(off);
  // ridges and gullies down its sides (the lava runs down the gullies)
  let a = atan2(off.y, off.x);
  let gully = 1.0 + (0.1 * sin(a * 7.0 + seed) + 0.07 * sin(a * 3.0 + seed * 1.7)) * smoothstep(cr, R * 0.5, r);
  let side = pow(max(1.0 - r / R, 0.0), 1.6) * gully;
  if (r >= cr) { return side; }
  let rim = pow(max(1.0 - cr / R, 0.0), 1.6);
  return rim - 0.18 * (1.0 - (r / cr) * (r / cr));
}
fn chance(i: u32, salt: u32) -> f32 { return f32(hash3(i, G.tick, salt) >> 8u) / 16777216.0; }

@compute @workgroup_size(8, 8)
fn depth(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  // (a sleeping chunk, round 80: what it holds carried through - the next buffer is copied back over this one)
  if (flowFrozen(id.xy, FLOW_N)) {
    let ia = colIdx(id.x, id.y);
    lavaOut[ia] = lava[ia];
    return;
  }
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
  // a bore's melt sent here last tick
  let sp = textureLoad(spillIn, texCol(vec2<i32>(p)), 0);
  var sAmt = 0.0;
  var sLvl = 0.0;
  var sHops = 0u;
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (!inMap(q)) { continue; }
    let s = textureLoad(spillIn, texCol(vec2<i32>(q)), 0);
    if (s.x <= 0.0 || (u32(s.z) & 7u) != (k ^ 1u) + 1u) { continue; }
    sAmt += s.x;
    sLvl = max(sLvl, s.y);
    sHops = max(sHops, u32(s.z) >> 3u);
  }
  // anything to do here? (most of the map: nothing)
  let beamOn = LU.beam2.y > 0.5 && length(cp - LU.beam.xy) < LU.beam.w;
  var vent = -1;
  var rise = 0.0;
  for (var v = 0; v < 4; v++) {
    let vv = LU.vents[v];
    if (vv.w > 0.0 && length(cp - vv.xy) < vv.w) { vent = v; }
    let cn = LU.cones[v];
    if (cn.x > 0.0) { rise += cn.x * coneShape(cp - vv.xy, cn.y, cn.z, fract(vv.x * 0.37 + vv.y * 0.71) * 6.28); }
  }
  let spring = textureLoad(springL, texCol(vec2<i32>(p)), 0).x;
  // (round 86) a meteor's blast: the rim's ground molten (it runs off the top as lava below), glowing past it
  let bo = length(cp - LU.blast.xy);
  var blastH = 0.0;
  if (LU.blast2.y > 0.5 && bo >= LU.blast.z - 1.0 && bo < LU.blast.w) {
    let t = clamp((bo - LU.blast.z) / max(LU.blast.w - LU.blast.z, 0.5), 0.0, 1.0);
    blastH = MELT + LATENT * LU.blast2.x * (1.0 - t) * (1.0 - t);
  }
  if (d <= 1e-5 && gh <= 1.0 && blastH <= 0.0 && !beamOn && vent < 0 && rise <= 0.0 && sAmt <= 0.0 && spring <= 0.0) {
    lavaOut[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    textureStore(spillOut, texCol(vec2<i32>(p)), vec4<f32>(0.0, 0.0, 0.0, f32(u32(sp.w) & 7u)));
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
  // (round 92, BACKLOG C19) the blast melts the ground at the rim's height (blast2.z: where it hit), not the top of
  // whatever stands there: a pillar by the bowl, or what hangs over the bowl, kept its top melting into lava that
  // poured into the crater and set there against what the cut had freed
  if (blastH > 0.0 && top <= LU.blast2.z + BLAST_UP) { gh = max(gh, blastH); }

  // a rising cone: the bedrock grows, lifting all that lies on it (loose
  // ground then slides off the steep sides, sediment.wgsl)
  if (rise > 0.0 && n > 0u && top + d < f32(G.zMax) - 4.0) {
    let dz = rise * DT_L;
    let b = layers[cs.x];
    layers[cs.x] = ivPack(ivZ0(b), ivZ1(b) + dz, ivMat(b), ivAux(b));
    for (var s = 1u; s < n; s++) {
      let u = layers[cs.x + s];
      layers[cs.x + s] = ivPack(ivZ0(u) + dz, ivZ1(u) + dz, ivMat(u), ivAux(u));
    }
    top += dz;
    // the ground cracks and smokes as it heaves
    if (chance(i, 0x59u) < 0.0012 * rise) {
      let s2 = hash3(i, G.tick, 0x5au);
      let r2 = vec2<f32>(f32(s2 & 255u), f32((s2 >> 8u) & 255u)) / 255.0 - 0.5;
      spawnL(vec3<f32>(cp, top + 0.3), vec3<f32>(r2 * 2.0, 2.0), 6.0, K_SMOKE_L, s2, 0u);
    }
  }

  // the beam: the ground where it hits, and what lava lies there
  var melt = 0.0;
  var meltLvl = 0.0;
  // (spill.w: the way out, + 8 � the bore's heat here)
  var way = f32(u32(sp.w) & 7u);
  var boreHeat = 0.0;
  if (beamOn) {
    let off = length(cp - LU.beam.xy);
    let r = LU.beam.w;
    let fall = 1.0 - off * off / (r * r);
    let h = LU.beam2.x * fall * DT_L;
    let bz = LU.beam.z;
    // the bore's half height here (a round hole the beam's radius)
    let hz = r * sqrt(fall);
    if (n > 0u && bz + hz < top) {
      // under the column's top: bore into it, the rock over it left standing.
      // The heat gathers until it melts all the rock in the hole's span at
      // once (from the middle out, the line through the hole would open
      // first and the aim run on through a slit)
      let lo = max(bz - hz, FLOOR_Z);
      let hi = bz + hz;
      var rock = 0.0;
      for (var s = 0u; s < n; s++) {
        let v = layers[cs.x + s];
        rock += max(min(ivZ1(v), hi) - max(ivZ0(v), lo), 0.0);
      }
      boreHeat = f32(u32(sp.w) >> 3u) + h;
      if (rock <= 0.0) { boreHeat = 0.0; }
      if (rock > 0.0 && boreHeat >= rock * LATENT) {
        var arr: array<vec4<u32>, MAX_K>;
        var nn = 0u;
        var room = true;
        for (var s = 0u; s < n; s++) {
          let v = layers[cs.x + s];
          if (ivZ1(v) <= lo || ivZ0(v) >= hi) {
            if (nn < MAX_K) { arr[nn] = v; }
            nn += 1u;
            continue;
          }
          if (ivZ0(v) < lo - 1e-3) {
            if (nn < MAX_K) { arr[nn] = ivPack(ivZ0(v), lo, ivMat(v), ivAux(v)); }
            nn += 1u;
          }
          if (ivZ1(v) > hi + 1e-3) {
            if (nn < MAX_K) { arr[nn] = ivPack(hi, ivZ1(v), ivMat(v), ivAux(v)); }
            nn += 1u;
          }
        }
        // (the rock over the hole needs a slot of its own: in a full column
        // it can't open, BACKLOG Q21)
        if (nn <= cs.y) {
          melt = rock;
          boreHeat = 0.0;
          for (var s = 0u; s < cs.y; s++) { layers[cs.x + s] = select(IV_NONE, arr[min(s, MAX_K - 1u)], s < nn); }
          n = nn;
          top = select(0.0, ivZ1(arr[max(nn, 1u) - 1u]), nn > 0u);
          // the bore's floor: the highest ground under bz
          for (var s = 0u; s < nn; s++) { if (ivZ1(arr[s]) <= bz + 1e-3) { meltLvl = max(meltLvl, ivZ1(arr[s])); } }
          way = wayOut(p, -LU.beam2.zw);
        }
      }
      // it smokes and spits out of the face
      if (boreHeat > 0.0 || melt > 0.0) {
        if (chance(i, 0x5bu) < 0.03) {
          let s2 = hash3(i, G.tick, 0x5cu);
          let r2 = vec2<f32>(f32(s2 & 255u), f32((s2 >> 8u) & 255u)) / 255.0 - 0.5;
          spawnL(vec3<f32>(cp, bz), vec3<f32>(r2 * 3.0 - LU.beam2.zw * 3.0, 2.0), 5.0, K_SMOKE_L, s2, 0u);
        }
        if (chance(i, 0x5du) < 0.02) {
          let s2 = hash3(i, G.tick, 0x5eu);
          let r2 = vec2<f32>(f32(s2 & 255u), f32((s2 >> 8u) & 255u)) / 255.0 - 0.5;
          spawnL(vec3<f32>(cp, bz), vec3<f32>(r2 * 4.0 - LU.beam2.zw * 5.0, 3.0), 1.5, K_EMBER_L, s2, 0u);
        }
      }
    } else if (abs(top + d - bz) < max(BEAM_REACH, hz + 0.5)) {
      gh += h;
      heat += 0.3 * h * max(d, 0.0);
    }
  }

  // the bore's melt (this column's and what came in): out in the open it
  // pours here; under rock it runs on, to the lowest open neighbour, else
  // out the way the bore came; with nowhere to go it sets on the floor
  let keep = way + 8.0 * round(min(boreHeat, 1e6));
  var spill = vec4<f32>(0.0, 0.0, 0.0, keep);
  let carry = sAmt + melt;
  if (carry > 0.0) {
    let lvl = max(select(0.0, sLvl, sAmt > 0.0), select(0.0, meltLvl, melt > 0.0));
    if (top + d <= lvl + OPEN_SLACK) {
      d += carry;
      heat += carry * LAVA_HOT;
    } else {
      var to = -1;
      var best = lvl + OPEN_SLACK;
      for (var k = 0u; k < NDIR; k++) {
        let q = nbr(p, k);
        // (off the map: it drains)
        var w = -1e9;
        if (inMap(q)) { w = textureLoad(levelsL, texCol(vec2<i32>(q)), 0).x + lava[colIdxI(q)].x; }
        if (w <= best) { best = w; to = i32(k); }
      }
      if (to < 0 && way >= 1.0) { to = i32(way) - 1; }
      if (to >= 0 && sHops < SPILL_HOPS) {
        spill = vec4<f32>(carry, lvl, f32(u32(to) + 1u + 8u * (sHops + 1u)), keep);
      } else {
        // it sets: onto the floor it ran along, up to the roof
        var f = -1;
        for (var s = 0u; s < n; s++) { if (ivZ1(layers[cs.x + s]) <= lvl + 0.05) { f = i32(s); } }
        if (f >= 0 && u32(f) + 1u < n) {
          let uf = u32(f);
          let v = layers[cs.x + uf];
          let u = layers[cs.x + uf + 1u];
          let z1 = min(ivZ1(v) + carry, ivZ0(u));
          if (z1 >= ivZ0(u) - 1e-3) {
            // (the gap filled: the two become one)
            layers[cs.x + uf] = ivPack(ivZ0(v), ivZ1(u), ivMat(v), ivAux(v));
            for (var s = uf + 1u; s + 1u < n; s++) { layers[cs.x + s] = layers[cs.x + s + 1u]; }
            n -= 1u;
            layers[cs.x + n] = IV_NONE;
          } else {
            layers[cs.x + uf] = ivPack(ivZ0(v), z1, ivMat(v), ivAux(v));
          }
        }
      }
    }
  }
  textureStore(spillOut, texCol(vec2<i32>(p)), spill);
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

  // a spring keeps its column topped up from below, and molten (what spills over runs off and sets)
  if (spring > 0.0) {
    let add = clamp(spring - d, 0.0, SPRING_RATE * DT_L);
    d += add;
    heat = max(heat + add * LAVA_HOT, d * LAVA_HOT);
  }
  // vents pour fresh lava (and smoke, ash, embers)
  if (vent >= 0) {
    let vv = LU.vents[vent];
    let add = vv.z * DT_L / (3.14159 * vv.w * vv.w * 0.6);
    d += add;
    heat += add * VENT_T;
    let s = hash3(i, G.tick, 0x51u);
    if (chance(i, 0x52u) < 0.05) {
      let r = vec3<f32>(f32(s & 255u), f32((s >> 8u) & 255u), f32((s >> 16u) & 255u)) / 255.0 - 0.5;
      spawnL(vec3<f32>(cp, top + d + 0.3), vec3<f32>(r.xy * 8.0, 14.0 + r.z * 8.0), 3.0, K_EMBER_L, s, 0u);
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
    T *= exp(-DT_L * G.tune.lavaCool / max(d, 0.15));
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
  // and for the smooth sheet (render.wgsl lavaSheetVertex, round 48): the
  // level round it, by direction — a neighbour with lava its level, a dry one
  // its ground as -1 - ground (out of the map: dry at this level)
  let c = vec2<i32>(id.xy);
  var lv: array<f32, 8>;
  for (var d = 0u; d < NDIR; d++) {
    let q = nbr(c, d);
    if (!inMap(q)) { lv[d] = -1.0 - z1; continue; }
    let Lq = lava[colIdxI(q)];
    lv[d] = select(-1.0 - Lq.w, Lq.w, Lq.x >= 0.02 || Lq.z >= 300.0);
    // (a hot-ground film stands just over its ground)
    if (Lq.x < 0.02 && Lq.z >= 300.0) { lv[d] = Lq.w + 0.06; }
  }
  let o = arrayLength(&inst) / 3u + 2u * k;
  inst[o] = vec4<u32>(bitcast<u32>(lv[0]), bitcast<u32>(lv[1]), bitcast<u32>(lv[2]), bitcast<u32>(lv[3]));
  inst[o + 1u] = vec4<u32>(bitcast<u32>(lv[4]), bitcast<u32>(lv[5]), 0u, 0u);
}
