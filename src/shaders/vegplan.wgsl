// ---- vegetation layout (shared) -------------------------------------------
// Where trees and shrubs stand and how tall they are, from the succession
// field. Pure function of (column, veg, material) so render-prep draws the
// plants and particles (perching birds) find the same crowns.
// species (instance bits 16..19 for vegetation): 0 broadleaf, 1 conifer, 2 birch, 3 old giant
struct VegPlan { shrub: bool, tree: bool, trunk: f32, crown: f32, tufts: u32, flower: bool, species: u32 };

// (round 117, flora) A stand-in biome field: birch woods, low-frequency value noise of the world cell (the window's
// origin added, so a wood stays with the land as the window slides; its own hash, not hash3's, so the lattice's
// corners are world cells). 0 outside a birch wood, rising to 1 in its heart. Why noise and not a stored field: no
// biome field exists yet (climate has temperature and moisture only) — this is the one place to swap it for one.
// api/plants.ts ports it exactly (birchWood).
fn floraCorner(x: i32, y: i32) -> f32 { return f32(pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ 0x51a7b1u)) >> 8u) / 16777216.0; }
fn birchWood(x: u32, y: u32) -> f32 {
  let p = vec2<f32>(f32(i32(x) + i32(G.org.z)), f32(i32(y) + i32(G.org.w))) / 72.0;
  let i = vec2<i32>(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n = mix(mix(floraCorner(i.x, i.y), floraCorner(i.x + 1, i.y), u.x), mix(floraCorner(i.x, i.y + 1), floraCorner(i.x + 1, i.y + 1), u.x), u.y);
  return smoothstep(0.52, 0.7, n);
}

// (round 125, forest) Where trees stand: a jittered grid of slots in world columns (src/flora/spacing.ts, exactly) — one
// candidate a 7 × 8 block, at least a column in from its edges; in the elder woods one elder a 2 × 2 super-block and no
// other tree. The user: "make the trees bigger and further spaced appart ... seas of leaves".
// (round 128, treegen: every tree TREE_SCALE × in height and trunk, the grid's spacing × it — density ÷ it². The
// constants TREE_SCALE, SLOT_W, SLOT_H, SLOT_M, ELDER_K, ELDER_M come from spacing.ts spacingWgsl(), prepended)
// (the elder woods' field, elderWoodW and ELDER_SCALE/LO/HI: woods.wgsl — the atlas lays its old woods by it too)
fn slotRand(bx: i32, by: i32, salt: u32) -> f32 { return f32(pcg(bitcast<u32>(bx) ^ pcg(bitcast<u32>(by) ^ pcg(salt))) >> 8u) / 16777216.0; }
fn floorDiv(a: i32, b: i32) -> i32 { return i32(floor(f32(a) / f32(b))); }
/** Block b's slot (world block ints): xy its candidate's world column, z 0 none (another block of an elder
 *  super-block holds its elder), 1 a tree, 2 the super-block's elder (spacing.ts slotAt, block by block — the tiles
 *  paint the trees past the window by walking blocks) */
fn blockSlot(b: vec2<i32>) -> vec3<i32> {
  let e = vec2<i32>(floorDiv(b.x, ELDER_K), floorDiv(b.y, ELDER_K));
  let EW = SLOT_W * ELDER_K;
  let EH = SLOT_H * ELDER_K;
  let ec = vec2<i32>(e.x * EW + ELDER_M + i32(floor(slotRand(e.x, e.y, 0xe1d1u) * f32(EW - 2 * ELDER_M))),
                     e.y * EH + ELDER_M + i32(floor(slotRand(e.x, e.y, 0xe1d2u) * f32(EH - 2 * ELDER_M))));
  if (slotRand(e.x, e.y, 0xe1d3u) < elderWoodW(ec)) {
    let own = all(vec2<i32>(floorDiv(ec.x, SLOT_W), floorDiv(ec.y, SLOT_H)) == b);
    return vec3<i32>(ec, select(0, 2, own));
  }
  let c = vec2<i32>(b.x * SLOT_W + SLOT_M + i32(floor(slotRand(b.x, b.y, 0x51d1u) * f32(SLOT_W - 2 * SLOT_M))),
                    b.y * SLOT_H + SLOT_M + i32(floor(slotRand(b.x, b.y, 0x51d2u) * f32(SLOT_H - 2 * SLOT_M))));
  return vec3<i32>(c, 1);
}

/** what world column w holds: 0 none, 1 its block's tree, 2 its super-block's elder (spacing.ts slotAt) */
fn treeSlot(w: vec2<i32>) -> u32 {
  let s = blockSlot(vec2<i32>(floorDiv(w.x, SLOT_W), floorDiv(w.y, SLOT_H)));
  // (an elder super-block's elder is its own block's slot; the super-block's other blocks hold none)
  if (s.z == 0) { return 0u; }
  return select(0u, u32(s.z), all(w == s.xy));
}

fn vegPlan(x: u32, y: u32, v: f32, m: u32) -> VegPlan {
  var pl = VegPlan(false, false, 0.0, 0.0, 0u, false, 0u);
  let h = rand3(x, y, 4242u);
  let edge = x < 2u || y < 2u || x + 3u >= G.mapW || y + 3u >= G.mapH;
  let slot = treeSlot(vec2<i32>(i32(x) + i32(G.org.z), i32(y) + i32(G.org.w)));
  if (v >= 3.6 && slot > 0u && !edge) {
    pl.tree = true;
    let hs = rand3(x, y, 321u);
    let hv = rand3(x, y, 7u);
    let age = clamp(v - 3.6, 0.0, 1.4);
    let inBirch = rand3(x, y, 333u) < birchWood(x, y) * 0.85;
    // (round 125, forest: bigger trees, the heights as the flora library draws them — birch 17-25, broadleaf 9-15,
    // conifer 12-20, the elder 24-32; api/plants.ts planTree keeps them identical)
    if (slot == 2u && v >= ELDER_VEG) {
      pl.species = 3u; // the elder: a massive pale trunk on flaring roots, a broad high crown (the elder woods)
      pl.trunk = 10.0 + floor(hv * 4.0);
      pl.crown = 14.0 + floor(hv * 4.0);
    } else if (v > 4.7 && hs < 0.12 && !inBirch) {
      pl.species = 3u; // an old giant on its own in old woods (the same species)
      pl.trunk = 9.0 + floor(hv * 4.0);
      pl.crown = 12.0 + floor(hv * 4.0);
    } else if (hs < 0.42 && !inBirch) {
      pl.species = 1u; // conifer: short bare trunk, tall tapering crown
      pl.trunk = 2.0 + floor(hv * 2.0);
      pl.crown = 9.0 + floor(age * 3.0) + floor(hv * 4.0);
    } else if (hs < 0.58 || inBirch) {
      // birch: a tall slender pale trunk, a light crown ("silver birches towering above")
      pl.species = 2u;
      pl.trunk = 12.0 + floor(age * 3.0) + floor(hv * 3.0);
      pl.crown = 7.0;
    } else {
      pl.trunk = 4.0 + floor(age * 3.0) + floor(hv * 3.0);
      pl.crown = 5.0 + floor(hv * 2.99) + select(0.0, 1.0, v > 4.5);
    }
    // (round 128: the heights above are round 125's; every tree is TREE_SCALE × them)
    pl.trunk *= TREE_SCALE;
    pl.crown *= TREE_SCALE;
  } else if (v >= 2.6 && h < 0.25) {
    pl.shrub = true;
  }
  // grass tufts on soil-like ground once grass has taken hold
  let soilish = MATS[m].eco.x >= 2.0;
  if (soilish && v >= 1.2) {
    let t = rand3(x, y, 99u);
    pl.tufts = select(0u, 1u + u32(t * 2.99), t < smoothstep(1.2, 2.5, v) * 0.9);
    // meadows (grass that stopped short of woodland) are full of flowers
    pl.flower = v >= 1.6 && v < 3.8 && rand3(x, y, 123u) < select(0.12, 0.3, v > 2.4 && v < 3.4);
  }
  return pl;
}
