// ---- settlehold.wgsl ----------------------------------------------------------------------------------------------
// (round 128o, DA-B20; DESIGN.md §24) A woken chunk whose water still settles is kept awake on the GPU, where the
// water's change is: no read of it to the CPU. At the start of every tick, one thread a word of the sleep mask (32
// slots): the CPU's masks (Globals.sleep / drowse, as sim/sleep.ts made them) with, for each slot the CPU says may
// still be settling (`cand`: woken by an event within SETTLE_MAX_S — the CPU puts it on the culled passes' lists),
//   - held while its water changed by more than the tolerance in the last tick (water_depth.wgsl waterChange) — and
//     for HOLD ticks after: its asleep bit cleared;
//   - drowsy for DROWSE ticks once the hold ends (its layers carried through, the mesh and the surface look again).
// The masks go back into the Globals (sim/settlehold.ts copies `eff` over Globals.sleep and drowse) before the tick's
// passes read them; waterChange is cleared for the next tick. Prepended: common.wgsl.

struct HoldParams { tol: f32, holdTicks: u32, drowseTicks: u32, _p: u32 }

@group(0) @binding(3) var<storage, read> change: array<u32>;
@group(0) @binding(4) var<storage, read> cand: array<u32>;
/** per slot: the hold's ticks left, the drowse's ticks left */
@group(0) @binding(5) var<storage, read_write> held: array<vec2<u32>>;
/** the masks to put in the Globals: sleep words 0..63, drowse words 64..127 */
@group(0) @binding(6) var<storage, read_write> eff: array<u32>;
@group(0) @binding(7) var<uniform> HP: HoldParams;

@compute @workgroup_size(64)
fn hold(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = gid.x;
  if (w >= 64u) { return; }
  var s = G.sleep[w >> 2u][w & 3u];
  var d = G.drowse[w >> 2u][w & 3u];
  let c = cand[w];
  for (var b = 0u; b < 32u; b++) {
    let slot = w * 32u + b;
    let bit = 1u << b;
    var h = held[slot];
    let cpuAsleep = (s & bit) != 0u;
    let isCand = (c & bit) != 0u;
    // (its water ran last tick: the CPU had it awake, or it was held)
    let ran = !cpuAsleep || (isCand && h.x > 0u);
    if (ran && bitcast<f32>(change[slot]) > HP.tol) {
      h.x = HP.holdTicks;
    } else if (h.x > 0u) {
      h.x -= 1u;
      if (h.x == 0u && cpuAsleep && isCand) { h.y = HP.drowseTicks; }
    }
    if (!isCand) { h.y = 0u; }
    if (cpuAsleep && isCand) {
      if (h.x > 0u) {
        s &= ~bit;
      } else if (h.y > 0u) {
        d |= bit;
        h.y -= 1u;
      }
    }
    held[slot] = h;
  }
  eff[w] = s;
  eff[64u + w] = d;
}
