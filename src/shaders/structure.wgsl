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
@group(0) @binding(3) var<storage, read> layersIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> layersOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> stats: array<atomic<u32>>;

const MAT_RUBBLE: u32 = 4u;
const STAT_COLLAPSED: u32 = 14u;
const GROUND: u32 = 15u;

fn auxDmg(a: u32) -> u32 { return a & 15u; }
fn auxSup(a: u32) -> u32 { return (a >> 4u) & 15u; }
fn isSolid(m: u32) -> bool { return matState(m) == ST_SOLID; }
fn spanCost(m: u32) -> u32 { return max(1u, u32(round((1.0 - MATS[m].sim.w) * 10.0))); }
fn dmgLimit(m: u32) -> u32 { return u32(4.0 + MATS[m].sim.w * 11.0); }

/** Best support a neighbouring column offers to the z-range [z0, z1). */
fn lateral(q: vec2<i32>, z0: u32, z1: u32) -> u32 {
  if (!inMap(q)) { return 0u; }
  let cs = colSlots(u32(q.x), u32(q.y));
  var best = 0u;
  for (var i = 0u; i < cs.y; i++) {
    let v = layersIn[cs.x + i];
    if (v == 0u) { break; }
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
  var colTop = 0u;
  for (var i = 0u; i < cs.y; i++) {
    let v = layersIn[cs.x + i];
    if (v == 0u) { break; }
    n = i + 1u;
    colTop = ivZ1(v);
  }

  // event damage reaching this column (falls off with distance and depth below the top)
  var hit = 0.0;
  for (var e = 0u; e < numEvents(); e++) {
    if (u32(G.eventKind[e]) != EV_LIGHTNING) { continue; }
    let ev = G.events[e];
    let d = length(vec2<f32>(p) + 0.5 - ev.xy);
    let f = clamp(1.0 - d / ev.z, 0.0, 1.0);
    hit = max(hit, ev.w * sqrt(f));
  }

  let collapseOn = G.misc.y > 0.5;
  var prevTop = 0u;
  var prevSup = GROUND;
  for (var i = 0u; i < n; i++) {
    let v = layersIn[cs.x + i];
    let m = ivMat(v);
    let z0 = ivZ0(v);
    let z1 = ivZ1(v);
    let touching = z0 == prevTop;
    var s = 0u;
    if (touching) { s = prevSup; }
    if (!isSolid(m)) {
      layersOut[cs.x + i] = v;
      prevTop = z1;
      prevSup = s;
      continue;
    }
    var dmg = auxDmg(ivAux(v));
    if (hit > 0.0) {
      let depth = f32(colTop - z1);
      dmg = min(15u, dmg + u32(hit * exp(-depth / 8.0)));
    }
    if (!touching) {
      var lat = 0u;
      for (var k = 0u; k < 4u; k++) { lat = max(lat, lateral(p + DIRS[k], z0, z1)); }
      let loss = spanCost(m) + dmg / 4u;
      s = select(0u, lat - loss, lat > loss);
    }
    let fails = collapseOn && ((!touching && s == 0u) || dmg >= dmgLimit(m));
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
  for (var i = n; i < cs.y; i++) { layersOut[cs.x + i] = 0u; }
}
