// ---- mutate/masks.wgsl (+ land.wgsl mutLand, lots.wgsl mutLots): instant world mutators (src/mutate, docs/design/MUTATORS.md) ---------------------------------
// The user, 2026-11-15: "Try making instant mutators"; "Terrain modification is interval booleans." One dispatch an
// entry of the world modifier list over a box of the window: a thread a column (mutLand) writes the END STATE into the
// column — water to a level, ash for soil, a basalt cap, a sand layer — in roadgrade.wgsl's pattern (read the column,
// rebuild its top, write only changed slots with bumpColumn). A thread a lot record (mutLots) writes the lot's
// condition word from the same masks. No simulation, nothing read back.
//
// Every rule is a pure function of the column (or the record) and the entry: the masks are taken at the WORLD position
// (the window's origin added), the noise is hashed from world lattice points (never Globals.org, which moves with the
// window), and each write is idempotent (water to at least the level; ash, basalt and sand only where the top isn't that
// already). So a region written a piece at a time as it streams in, or written twice, ends the same as one written whole.
//
// A column whose top is a thing's External span a cell or more thick (a building) is left as it is: its lot's condition
// shows what happened to it. Thin External (a road's paving) is ground like any other.

struct MutParams {
  /** the box in the window's columns [x0, y0, x1, y1) */
  box: vec4<u32>,
  /** the entry's centre in the window (world units), its radius (cells), its strength 0..1 */
  at: vec4<f32>,
  /** kind (MUT_*), seed, the records' room (mutLots), 0 */
  k: vec4<u32>,
  /** the entry's own numbers, z already in window z (see each kind) */
  p: vec4<f32>,
  q: vec4<f32>,
  /** the window's origin in world units (x cells, y · ROW_H), its oz, 0: a column's world position is cellPos + org.xy */
  org: vec4<f32>,
};

@group(0) @binding(5) var<uniform> MP: MutParams;

const MUT_FLOODED: u32 = 0u;
const MUT_BURNED: u32 = 1u;
const MUT_MELTED: u32 = 2u;
const MUT_BURIED: u32 = 3u;
// (world state: every lot of the place)
const MUT_RUINED: u32 = 4u;
const MUT_ABANDONED: u32 = 5u;
const MUT_OCCUPIED: u32 = 6u;
const MUT_RESTORED: u32 = 7u;
const MUT_LOOT: u32 = 8u;
const MUT_WITHERED: u32 = 10u;
const MUT_GREENED: u32 = 11u;
const MUT_DRIED: u32 = 12u;
const MUT_UNLOOT: u32 = 9u;
// (a founded mining place's workings: a pit cut in benches and a spoil heap — mutate/list.ts GPU_MINE)
const MUT_MINE: u32 = 13u;
const MAT_RUBBLE_U: u32 = 4u;
// (the 'deadrise' sign's ground mark: a burial ground broken open — mutate/list.ts GPU_GRAVES)
const MUT_GRAVES: u32 = 14u;
// (the sign ended: the mark taken off again — mutate/list.ts GPU_UNGRAVES)
const MUT_UNGRAVES: u32 = 15u;
const MAT_BONE_U: u32 = 16u;
// (loop round 7, BACKLOG LS-67: the 'camp' sign's ground mark: refugees' tents on trodden ground — mutate/list.ts
// GPU_TENTS)
const MUT_TENTS: u32 = 16u;
const MAT_CANVAS_U: u32 = 21u;
const MAT_DIRTROAD_U: u32 = 40u;

// (mutate/index.ts LOT_CONDITION)
const LC_DROWNED: u32 = 1u;
const LC_BURNED: u32 = 2u;
const LC_DESTROYED: u32 = 3u;
const LC_BURIED: u32 = 4u;
const LC_ABANDONED: u32 = 5u;
const LC_OCCUPIED: u32 = 6u;
const LC_LOOTED: u32 = 10u;

const MAT_SOIL_U: u32 = 2u;
const MAT_SAND_U: u32 = 3u;
const MAT_ASH_U: u32 = 17u;
/** burned ground (world/materials.ts MAT.Char) */
const MAT_CHAR_U: u32 = 42u;
const MAT_SILT_U: u32 = 22u;
const MAT_BASALT_U: u32 = 23u;
const MAT_OBSIDIAN_U: u32 = 35u;
/** melted: the glassy skin over the flow's body, cells; and how thick the flow must be to carry one (its thin edge
 *  stays ropy grey basalt) */
const GLASS_T: f32 = 0.25;
const GLASS_FROM: f32 = 0.85;
const MUT_OUT: u32 = 20u;
/** the ash a fire leaves on the ground, cells */
const ASH_T: f32 = 0.3;
/** a building's span: External at least this thick (a road's paving is thinner) */
const BUILDING_T: f32 = 1.0;
/** the flood's level falls away over the outer part of the radius — down to the standing water it rose from (the
 *  river's own level) where there is one — so no wall of water stands at the rim */
const FLOOD_RIM: f32 = 0.62;
const FLOOD_RIM_DROP: f32 = 6.0;

fn mhash(x: i32, y: i32, s: u32) -> f32 {
  return f32(pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(s))) >> 8u) / 16777216.0;
}
/** value noise of a world position (hashed from world lattice points: the same wherever the window is) */
fn mnoise(p: vec2<f32>, s: u32) -> f32 {
  let i = vec2<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mhash(i.x, i.y, s), mhash(i.x + 1, i.y, s), u.x), mix(mhash(i.x, i.y + 1, s), mhash(i.x + 1, i.y + 1, s), u.x), u.y);
}
fn mfbm(p: vec2<f32>, s: u32) -> f32 {
  return mnoise(p, s) * 0.55 + mnoise(p * 2.03 + 17.0, s + 1u) * 0.3 + mnoise(p * 4.1 + 41.0, s + 2u) * 0.15;
}

/** how far out of the entry's disc a window point is (1: its rim) */
fn mutD(wp: vec2<f32>) -> f32 { return distance(wp, MP.at.xy) / max(MP.at.z, 1.0); }

/** flooded — p.x: the water's level (window z); p.y: the level the rim falls to (window z; far below: not taken —
 *  floodscan.wgsl: a quarter cell under the lowest ground or water of the outer ring). The level a point's water
 *  stands at: flat inside the rim, falling smoothly beyond it to under everything at the rim itself, so the flood's
 *  surface (the higher of this and what was there) meets the land and the water round it with no step (MU-36) */
fn floodLevel(d: f32) -> f32 {
  let t = smoothstep(FLOOD_RIM, 0.98, d);
  let low = select(MP.p.x - FLOOD_RIM_DROP, clamp(MP.p.y, MP.p.x - 2.0 * FLOOD_RIM_DROP, MP.p.x - 1.0), MP.p.y > -1e8);
  return mix(MP.p.x, low, t);
}

/** burned: is world point `w` (d from the centre) in the burn? Its edge ragged; at strength under 1 patches are spared */
fn burnIn(w: vec2<f32>, d: f32) -> bool {
  let n = mfbm(w * 0.09, MP.k.y);
  let spare = mnoise(w * 0.05 + 91.0, MP.k.y + 7u);
  return d + (n - 0.5) * 0.3 < 0.9 && spare < 0.35 + 0.75 * MP.at.w;
}

/** melted — p.xy: the vent (window units), p.z: its height (window z), p.w: how far the flow runs; q.xy: downhill.
 *  The lava's thickness at a point whose ground top is `top` (0: the flow doesn't reach it): a pool round the vent and
 *  a tongue running downhill, widening, its edge lobed; it never climbs ground above the vent's own height */
fn meltT(wp: vec2<f32>, w: vec2<f32>, top: f32) -> f32 {
  let v = wp - MP.p.xy;
  let along = dot(v, MP.q.xy);
  let across = abs(dot(v, vec2<f32>(-MP.q.y, MP.q.x)));
  let n = mfbm(w * 0.11, MP.k.y + 3u);
  let core = 3.0 + 3.0 * MP.at.w;
  let reach = MP.p.w * (0.75 + 0.5 * n);
  var edge = core * (0.8 + 0.5 * n) - length(v);
  if (along > 0.0 && along < reach) {
    let half = (core + along * 0.3) * (0.55 + 0.9 * n) * smoothstep(reach, reach * 0.75, along);
    edge = max(edge, half - across);
  }
  if (edge <= 0.0) { return 0.0; }
  // (uphill of the vent it stops: a rise of more than a cell and a half over the vent's height)
  if (top > MP.p.z + 1.5) { return 0.0; }
  return clamp(0.4 + edge * 0.35, 0.4, 1.6 + 1.6 * n);
}
/** melted: a glowing crack through the set rock here? (thin ridges of a noise, fewer far down the flow) */
fn meltCrack(w: vec2<f32>) -> bool {
  return abs(mnoise(w * 0.33, MP.k.y + 11u) - 0.5) < 0.035;
}

/** buried — p.x: the deepest the sediment lies (cells), p.y: its material; q.xy: the wind it came on.
 *  Its depth at a point: dunes across the wind, thinning to nothing at the rim */
fn buryDepth(w: vec2<f32>, d: f32) -> f32 {
  let a = dot(w, MP.q.xy);
  let c = dot(w, vec2<f32>(-MP.q.y, MP.q.x));
  let dune = mnoise(vec2<f32>(a * 0.16, c * 0.05), MP.k.y + 5u);
  let n = mfbm(w * 0.07, MP.k.y + 6u);
  return MP.p.x * (0.35 + 0.45 * dune + 0.35 * n) * (1.0 - smoothstep(0.55, 1.0, d));
}

