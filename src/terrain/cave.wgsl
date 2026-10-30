// Terrain track (round 117): caves that open at a cliff's foot — inland cliffs and sea cliffs (compose.wgsl ground()).
// Prepended to every atlas kernel by Atlas.parts().
//
// The user (DECISIONS round 117): "Cliffs would be even better with rocks around the base and caves that open (often at
// their base). For ocean caves we want waves that crash agains the rocks. For those on land we want sand or dirt piled
// up and rocks along their base." / "Caves should have ground level openings and be wide enough to traverse." / "An
// impassible mountain can have a cave through it." The method is the user's own recipe (noiselab2, round 112; TG3 on
// noiselab2-r made it work at a visible scale, round 117), verbatim:
//   "Take a simplex fractal noise in 2d and set a threshold so that they are windy and the width you want (gap between
//   the threshold) you can use JFA to find the narrow points if you want to measure in tuning. Then make the caves
//   interpolate from the bottom of the cliff height at the beach to any intermediary value plus noise inside the cliff
//   layers. For the cave shape just use JFA and take distance form the edge squared or something with noise and make
//   noise lower on the floor so it is walkable."
// 2.5D ("no 3d is sloow it requires voxel march"): one open run a column (the overhang's: columns.wgsl colHeight).
//
// Here, per cell with no JFA: the passages are a band of a 2D fbm (|n| under CAVE_W: winding, ~12 cells wide, TG3's
// band); the distance in from a passage's edge is its margin, (1 − |n| / CAVE_W) × CAVE_MID cells — a field the noise
// gives directly, the JFA's measure near enough for a vault. The base runs from the cliff's
// foot (the low ground, or a cell over the sea: TG16, the sea doesn't enter a cave's gap yet) to an intermediate height
// inside the cliff (a share of its drop, by a noise: a passage climbs through it, a way up an impassable wall), over
// CAVE_RISE cells; roof = base + min(0.35 d², vault) + noise, floor = base − 0.5 + a quarter of that noise (walkable);
// TG3's numbers. Where the roof comes within 2 cells of the ground it opens — a collapse, light down into the cave
// (the user: "crumbling ceilings with beams of light coming down"). Outside each mouth a fan of the cliff's talus.

const CAVE_PER: f32 = 110.0;
const CAVE_W: f32 = 0.2;
/** the distance in from a passage's edge at its middle (cells): the vault's d there */
const CAVE_MID: f32 = 7.0;
const CAVE_RISE: f32 = 70.0;

struct Cave {
  /** the open run (floor, roof); none when roof ≤ floor */
  floor: f32,
  roof: f32,
  /** the mouth's pile (talus height) */
  pile: f32,
  /** the roof came through: the ground opens down to the floor here */
  open: bool,
}

/**
 * A cave in a cliff at p. x: the distance onto the high side from the cliff's foot; foot: the base at the foot (the low
 * ground's level, or a cell over the sea); drop: the cliff's height; top: the ground's height here.
 */
fn cliffCave(u: vec2<f32>, x: f32, foot: f32, drop: f32, top: f32) -> Cave {
  var o = Cave(0.0, 0.0, 0.0, false);
  if (drop < 14.0 || x < -8.0 || x > 140.0) { return o; }
  // (which stretches of cliff have caves: most)
  let on = smoothstep(-0.25, 0.0, pfbm(u, perOf(260.0), 2u, AP.seed + 703u));
  if (on <= 0.0) { return o; }
  let n = pfbm(u, perOf(CAVE_PER), 3u, AP.seed + 701u);
  var a = abs(n);
  // grottos: round chambers (Worley sites ~45 cells apart, 6-10 across) — those near the foot are cut by the face, a
  // mouth at the cliff's base wherever one falls, so the base has caves often and not only where a passage happens to
  // reach it (the user: "caves that open (often at their base)")
  if (x < 30.0) {
    let pg = perOf(45.0);
    let wg = pworley(u * f32(pg), vec2<i32>(pg), 0.8, AP.seed + 710u);
    let rg = 6.0 + 4.0 * hf(pcg(wg.id ^ (AP.seed * 0x7f4a7c15u)));
    a = min(a, CAVE_W * wg.f1 * 45.0 / rg);
  }
  // the mouth's pile: outside the foot, where a passage comes out
  if (x < 0.5) {
    if (a < CAVE_W * 1.3) {
      o.pile = (2.0 + 2.5 * (0.5 + 0.5 * pfbm(u, perOf(9.0), 2u, AP.seed + 705u))) * (1.0 - smoothstep(0.0, 8.0, -x)) * (1.0 - smoothstep(CAVE_W * 0.8, CAVE_W * 1.3, a)) * on;
    }
    return o;
  }
  let reach = (30.0 + 100.0 * (0.5 + 0.5 * pfbm(u, perOf(150.0), 2u, AP.seed + 704u))) * on;
  if (a >= CAVE_W || x > reach) { return o; }
  // the distance in from the passage's edge (cells): the band's margin, CAVE_MID at its middle (measured: the fbm's
  // gradient is steeper than its period says — d from it gave 4-cell vaults where TG3's are 12)
  let d = (1.0 - a / CAVE_W) * CAVE_MID;
  // the base: from the foot to an intermediate height inside (a share of the drop), plus a wobble
  let share = 0.15 + 0.45 * (0.5 + 0.5 * pfbm(u, perOf(200.0), 2u, AP.seed + 708u));
  let base = mix(foot, foot + drop * share, smoothstep(0.0, CAVE_RISE, x)) + 1.5 * pfbm(u, perOf(40.0), 2u, AP.seed + 709u);
  let rn = pfbm(u, perOf(10.0), 3u, AP.seed + 706u);
  // (narrower and lower toward its far end: a passage peters out)
  let end = 1.0 - smoothstep(reach * 0.7, reach, x);
  let vault = 12.0 * (0.5 + 0.5 * end);
  o.roof = base + min(0.35 * d * d, vault) + 1.2 * rn;
  o.floor = base - 0.5 + 0.3 * rn;
  if (o.roof - o.floor < 2.5) {
    o.roof = 0.0;
    o.floor = 0.0;
    return o;
  }
  // (the roof through the ground: open to the sky — a collapse, a skylight)
  if (o.roof > top - 2.0) { o.open = true; }
  return o;
}
