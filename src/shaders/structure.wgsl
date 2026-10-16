// ---- structural system ------------------------------------------------------
// Simplest systemic structural model (design doc §18, no FEM):
//  * Every solid interval carries a support level 0..15 in aux bits 4..7 and
//    damage 0..15 in aux bits 0..3.
//  * Resting on something (touching the interval below, or the ground):
//    inherits the support of what it rests on (ground = 15).
//  * Floating (air gap below): support = best overlapping solid neighbour's
//    support − span cost of the material − damage/4. Values relax one cell per
//    tick, so losing a pillar makes a slab's support bleed away over several
//    ticks → progressive, readable collapse instead of an instant pop.
//  * Collapse (when enabled): support 0 while floating, or damage above the
//    material's threshold → the interval turns to rubble. Rubble is granular,
//    so the existing material system makes it fall, pile and slide. No
//    separate debris simulation.
//  * One-tick events (lightning) add damage near the strike, strongest at the
//    top of the struck column.
@group(0) @binding(3) var<storage, read> layersIn: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> layersOut: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> surface: array<u32>;
@group(0) @binding(7) var<storage, read> water: array<f32>;
@group(0) @binding(8) var<storage, read> flux: array<Dirs>;
// heat: fire weakens steel and concrete nearby, and burns loose waste away
@group(0) @binding(9) var<storage, read> fire: array<f32>;
const HEAT_RATE: f32 = 0.016;
const MAT_TRASH_S: u32 = 12u;
const MAT_ASH_S: u32 = 17u;

// Hydraulic loading (the dam-breach mechanic, but generic):
//  * A *cracked* (damage > 0) solid interval holding back water of head H
//    (neighbour water surface above the interval's base) gains damage with
//    probability ∝ H per tick. Intact structures hold indefinitely, so the
//    player must first crack one (lightning) and the water does the rest.
//  * Fast flow alongside a cracked solid erodes it further; intact solids
//    hold (round 15: concrete and asphalt need lightning or a cyclone first).
const HEAD_MIN: f32 = 2.0;
const HEAD_RATE: f32 = 0.006;
const FLOW_RATE: f32 = 0.06;

fn hydraulicDamage(p: vec2<i32>, z0: f32, z1: f32, dmg: u32, m: u32, salt: u32) -> u32 {
  var head = 0.0;
  var flow = 0.0;
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (!inMap(q)) { continue; }
    let j = colIdxI(q);
    let d = water[j];
    if (d < 0.05) { continue; }
    let g = f32(sfZ(surface[j]));
    let H = g + d;
    // water must actually touch this interval's face
    if (H <= z0 || g >= z1) { continue; }
    head = max(head, H - max(z0, g));
    flow = max(flow, length(netFlow(q)));
  }
  let strength = MATS[m].sim.w;
  var chance = 0.0;
  if (dmg > 0u && head > HEAD_MIN) { chance += (head - HEAD_MIN) * HEAD_RATE; }
  // only what is already cracked (lightning, cyclones, heat) wears in fast
  // water: intact concrete and asphalt hold (round 15)
  if (dmg > 0u && flow > 0.1) { chance += (flow - 0.1) * FLOW_RATE * (1.2 - strength); }
  let r = rand3(u32(p.x) * 16u + salt, u32(p.y), G.tick);
  return select(dmg, min(15u, dmg + 1u), r < chance);
}

const MAT_RUBBLE: u32 = 4u;
const STAT_COLLAPSED: u32 = 14u;
const GROUND: u32 = 15u;

fn auxDmg(a: u32) -> u32 { return a & 15u; }
fn auxSup(a: u32) -> u32 { return (a >> 4u) & 15u; }
fn isSolid(m: u32) -> bool { return matState(m) == ST_SOLID; }
/** Bedrock (strength 1) is terrain, not structure: never damaged or collapsed. */
fn isStructural(m: u32) -> bool { return isSolid(m) && MATS[m].sim.w < 1.0; }
fn spanCost(m: u32) -> u32 { return max(1u, u32(round((1.0 - MATS[m].sim.w) * 10.0))); }
fn dmgLimit(m: u32) -> u32 { return u32(4.0 + MATS[m].sim.w * 11.0); }

/** Best support a neighbouring column offers to the z-range [z0, z1). */
fn lateral(q: vec2<i32>, z0: f32, z1: f32) -> u32 {
  if (!inMap(q)) { return 0u; }
  let cs = colSlots(u32(q.x), u32(q.y));
  var best = 0u;
  for (var i = 0u; i < cs.y; i++) {
    let v = layersIn[cs.x + i];
    if (ivEmpty(v)) { break; }
    if (!isSolid(ivMat(v))) { continue; }
    if (ivZ0(v) < z1 && ivZ1(v) > z0) { best = max(best, auxSup(ivAux(v))); }
  }
  return best;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let p = vec2<i32>(id.xy);
  let cs = colSlots(id.x, id.y);
  var n = 0u;
  var colTop = 0.0;
  for (var i = 0u; i < cs.y; i++) {
    let v = layersIn[cs.x + i];
    if (ivEmpty(v)) { break; }
    n = i + 1u;
    colTop = ivZ1(v);
  }

  // event damage reaching this column (falls off with distance and depth below the top)
  var hit = 0.0;
  for (var e = 0u; e < numEvents(); e++) {
    if (evKind(e) != EV_LIGHTNING) { continue; }
    let ev = G.events[e];
    let d = length(cellPos(p) - ev.xy);
    let f = clamp(1.0 - d / ev.z, 0.0, 1.0);
    hit = max(hit, ev.w * sqrt(f));
  }

  // heat reaching this column: its own fire or a burning neighbour
  var heat = fire[colIdxI(p)];
  for (var k = 0u; k < NDIR; k++) {
    let q = nbr(p, k);
    if (inMap(q)) { heat = max(heat, fire[colIdxI(q)] * 0.8); }
  }
  let selfFire = fire[colIdxI(p)];

  let collapseOn = G.misc.y > 0.5;
  var prevTop = 0.0;
  var prevSup = GROUND;
  for (var i = 0u; i < n; i++) {
    let v = layersIn[cs.x + i];
    let m = ivMat(v);
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    // (heights are fractional: an interval laid on loose ground starts where it ends)
    let touching = abs(z0 - prevTop) < 1e-3;
    var s = 0u;
    if (touching) { s = prevSup; }
    if (!isStructural(m)) {
      if (isSolid(m)) { s = GROUND; }
      // compacted waste only yields to fire (DECISIONS round 5): a burning heap
      // goes down a cell at a time and its last cell is left as loose ash,
      // which wind and water can then carry away
      // the cyclone tears compacted waste apart into loose litter it can strip
      if (m == MAT_TRASH_S && i + 1u == n && cycloneAt(cellPos(p)) > 0.4 && rand3(id.x, id.y, G.tick ^ 0x7c1u) < 0.01) {
        layersOut[cs.x + i] = ivPack(z0, z1, MAT_LITTER, 0u);
        prevTop = z1;
        prevSup = s;
        continue;
      }
      // moving water tears a packed heap apart a cell at a time into loose
      // litter, which the water then carries off (round 15: wash away the
      // trash heaps)
      if (m == MAT_TRASH_S && i + 1u == n) {
        let flow = length(netFlow(p));
        if (flow > 0.02 && rand3(id.x, id.y, G.tick ^ 0x3a5u) < (flow - 0.02) * 0.5) {
          // (the top interval: split off its top cell as litter, then stop)
          if (z1 - 1.0 <= z0 || i + 1u >= cs.y) {
            layersOut[cs.x + i] = ivPack(z0, z1, MAT_LITTER, 0u);
          } else {
            layersOut[cs.x + i] = ivPack(z0, z1 - 1.0, m, ivAux(v));
            layersOut[cs.x + i + 1u] = ivPack(z1 - 1.0, z1, MAT_LITTER, 0u);
            n += 1u;
          }
          break;
        }
      }
      // a lightning strike blasts compacted waste straight to ash (round 10:
      // the storm is how the heap the wind can't move is cleared)
      if (m == MAT_TRASH_S && hit > 8.0) {
        layersOut[cs.x + i] = ivPack(z0, z1, MAT_ASH_S, 0u);
        prevTop = z1;
        prevSup = s;
        continue;
      }
      if (m == MAT_TRASH_S && i + 1u == n && selfFire > 0.3 && rand3(id.x, id.y, G.tick ^ 0xa5u) < 0.03 * selfFire) {
        layersOut[cs.x + i] = select(ivPack(z0, z1, MAT_ASH_S, 0u), ivPack(z0, z1 - 1.0, m, ivAux(v)), z1 - 1.0 > z0);
        prevTop = z1;
        prevSup = s;
        continue;
      }
      layersOut[cs.x + i] = v;
      prevTop = z1;
      prevSup = s;
      continue;
    }
    var dmg = auxDmg(ivAux(v));
    if (hit > 0.0) {
      let depth = colTop - z1;
      dmg = min(15u, dmg + u32(hit * exp(-depth / 8.0)));
    }
    dmg = hydraulicDamage(p, z0, z1, dmg, m, i);
    // taps chip the interval they touched (cosmetic decay that adds up)
    for (var e = 0u; e < numEvents(); e++) {
      if (evKind(e) != EV_CHIP) { continue; }
      let ev = G.events[e];
      let ez = evZ(e);
      if (length(cellPos(p) - ev.xy) < ev.z && f32(ez) + 1.0 >= z0 && f32(ez) <= z1) { dmg = min(15u, dmg + u32(ev.w)); }
    }
    if (heat > 0.3 && rand3(id.x * 16u + i, id.y, G.tick ^ 0x4ea7u) < HEAT_RATE * heat * (1.2 - MATS[m].sim.w)) {
      dmg = min(15u, dmg + 1u);
    }
    // the cyclone batters what stands in it (round 12: ruins and wrecks — not plants)
    let cyc = cycloneAt(cellPos(p));
    if (cyc > 0.3 && rand3(id.x * 16u + i, id.y, G.tick ^ 0xc1c1u) < cyc * 0.02 * (1.3 - MATS[m].sim.w)) {
      dmg = min(15u, dmg + 1u);
    }
    if (!touching) {
      var lat = 0u;
      for (var k = 0u; k < NDIR; k++) { lat = max(lat, lateral(nbr(p, k), z0, z1)); }
      let loss = spanCost(m) + dmg / 4u;
      s = select(0u, lat - loss, lat > loss);
    }
    let spanRule = G.misc.y < 1.5;
    let fails = collapseOn && ((spanRule && !touching && s == 0u) || dmg >= dmgLimit(m));
    if (fails) {
      layersOut[cs.x + i] = ivPack(z0, z1, MAT_RUBBLE, 0u);
      atomicAdd(&stats[STAT_COLLAPSED], 1u);
      s = 0u;
    } else {
      layersOut[cs.x + i] = ivPack(z0, z1, m, (s << 4u) | dmg);
    }
    prevTop = z1;
    prevSup = s;
  }
  for (var i = n; i < cs.y; i++) { layersOut[cs.x + i] = IV_NONE; }
}
