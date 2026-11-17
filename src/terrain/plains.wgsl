// Terrain rivers, step 2 (docs/design/TERRAIN_RIVERS.md §10; flag a.rivers2=1 — AtlasP.terrain2): the lowland and upland
// plains as the owner builds terrain — "multiple height fields tied to regions … thresholds to define discrete regions,
// JFA to find distance to the borders, then blend the heightmaps. A mix of discrete masks that change how layers are
// blended". The owner: "rivers planes felt a little boring … land is just more interesting when there are hills and
// visually distinct regions."
//
//   sub-regions  a warped Voronoi of PL_CELL cells over the plains — the discrete mask; each cell one kind by its hash
//   kinds        0 flat (left truly flat) · 1 rolling hills · 2 low ridges · 3 terraces · 4 hummocks · 5 wet flats ·
//                6 tilted cells (the owner's trick, below)
//   blend        each kind's height field H_k is faded to 0 at the sub-region's border by the distance to it
//                (Voronoi f2 − f1: the cellular field's own exact border distance), so neighbours meet at the base
//   weight       only plains: tier weight (lowland 1, upland 0.6, plateau and massif 0 — the cliffs untouched), faded
//                in from the coast and from every landform border by the landforms' JFA distance dl
//   relief = weight · edge(d_border) · H_kind(x)
// Added to the ground before the stamps and the valley (compose.wgsl ground()), so the walks run round the hills and the
// valleys cut through them; only with the flag (AP.terrain2 = 0 in the default world: never called).

const PL_CELL: f32 = 520.0;
/** the blend band at a sub-region's border, in cells of the Voronoi lattice (half the f2 − f1 gap) */
const PL_EDGE: f32 = 0.16;

/** the tier's weight (water and plateau / massif: none) */
fn plTier(r: Region) -> f32 {
  if (!isLand(r)) { return 0.0; }
  return select(select(0.0, 0.6, r.tier == 1u), 1.0, r.tier == 0u);
}

/** a sub-region's kind from its hash: 0 flat 18 %, 1 hills 20 %, 2 ridges 10 %, 3 terraces 10 %, 4 hummocks 10 %, 5 wet
 *  flats 7 %, 6 tilted cells 25 % (the owner's) */
fn plKind(h: f32) -> u32 {
  if (h < 0.18) { return 0u; }
  if (h < 0.38) { return 1u; }
  if (h < 0.48) { return 2u; }
  if (h < 0.58) { return 3u; }
  if (h < 0.68) { return 4u; }
  if (h < 0.75) { return 5u; }
  return 6u;
}

// ---- tilted cells (the owner, 2026-11-17: "voronoi cells that are tilted with a gradient height towards one or more
// edges. This creates natural barriers (the raised edge is a small steep cliff) but the lower edges mean you can always
// traverse … can work for making river coasts more dramatic … a nice way to break up a town so roads have to meander")
//
//   cell c (a Voronoi of TL_CELL cells): a plane  h_c(x) = H_c · clamp(0.5 + (x − c)·d_c / TL_RUN, 0, 1)
//     — 0 along its low side, H_c (TL_H) at its raised edge; d_c its tilt
//   at the border with the nearest other cell b (δ: the exact distance to their bisector, positive inside c):
//     h = mix(min(h_c, h_b), h_c, smoothstep(0, wδ, δ))
//   so on the bisector both sides stand at the lower plane (continuous), the lower side is untouched, and the higher
//   side comes down to it over wδ: a scarp (wδ = TL_SCARP, ~1.5 cells: a small steep cliff) — or, in a GAP of the
//   border (a slow noise along it over a threshold, ~1/4 of its length), a ramp (wδ = |h_c − h_b| / TL_RAMP_SLOPE:
//   walkable). Tilt: near a river, along the river distance's gradient — 65 % of cells rise toward the river (bluffs
//   over it, the valley's floodplain cut into their raised edge), 35 % away; elsewhere a hash direction.
// Traversal: every point of a cell reaches its low side down a gentle slope (H/TL_RUN ≤ 0.07), and every border longer
// than ~2 gap periods (TL_GAP 70 cells) has a ramp almost surely — the cells are connected through the gaps exactly as
// the Voronoi adjacency is (connected). A short border may have no gap; its two cells still connect round it.

// (step 3: 9 cells of rise over 150-cell cells with 1.5-cell scarps read only as thin lines at region zoom — the tilt
// itself was lost under the dune ripples (local/terrain3/on-t2.png); tuned once: higher, smaller, a wider scarp)
const TL_CELL: f32 = 130.0;
const TL_RUN: f32 = 130.0;
const TL_H_MIN: f32 = 5.0;
const TL_H_MAX: f32 = 14.0;
const TL_SCARP: f32 = 2.0;
const TL_RAMP_SLOPE: f32 = 0.3;
const TL_GAP: f32 = 70.0;

struct Wor2 {
  ia: u32,
  ib: u32,
  pa: vec2<f32>,
  pb: vec2<f32>,
}

/** the two nearest features of a periodic Voronoi (lattice units, unwrapped beside p) and their wrapped ids */
fn pworley2(p: vec2<f32>, per: vec2<i32>, jit: f32, s: u32) -> Wor2 {
  let i = vec2<i32>(floor(p));
  var r: Wor2;
  var d1 = 1e9;
  var d2 = 1e9;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let c = i + vec2<i32>(dx, dy);
      let w = wrapi(c, per);
      let h = hash2u(w.x, w.y, s);
      let fp = vec2<f32>(c) + vec2<f32>(hf(h), hf(pcg(h))) * jit + (1.0 - jit) * 0.5;
      let d = length(fp - p);
      let id = u32(w.y * per.x + w.x);
      if (d < d1) {
        d2 = d1;
        r.ib = r.ia;
        r.pb = r.pa;
        d1 = d;
        r.ia = id;
        r.pa = fp;
      } else if (d < d2) {
        d2 = d;
        r.ib = id;
        r.pb = fp;
      }
    }
  }
  return r;
}

/** one scale of tilted cells: the plains' (TL_*) or the coasts' (CC_*) — the same field at two scales */
struct TiltK {
  cell: f32,
  run: f32,
  hmin: f32,
  hmax: f32,
  scarp: f32,
  gap: f32,
  seed: u32,
  /** 1: the coasts' — a share of the cells raised, tilted up toward the sea (−∇coast); 0: the plains' */
  coastal: u32,
}

fn plainsTilt() -> TiltK { return TiltK(TL_CELL, TL_RUN, TL_H_MIN, TL_H_MAX, TL_SCARP, TL_GAP, AP.seed + 921u, 0u); }

/** a tilted cell's plane at x (cells): c its feature (cells), id its hash */
fn tlPlane(k: TiltK, id: u32, c: vec2<f32>, x: vec2<f32>) -> f32 {
  let hh = pcg(id * 2246822519u + k.seed * 31u + 5u);
  let H = mix(k.hmin, k.hmax, hf(hh));
  var d = vec2<f32>(cos(6.2831853 * hf(pcg(hh + 1u))), sin(6.2831853 * hf(pcg(hh + 1u))));
  if (k.coastal != 0u) {
    // (the coasts': CC_RAISED of the cells rise toward the sea along the coast distance's gradient at their feature;
    // the rest stay low — beaches and low coasts)
    if (hf(pcg(hh + 2u)) >= CC_RAISED) { return 0.0; }
    let e = 40.0;
    let g = vec2<f32>(macroAt(c + vec2<f32>(e, 0.0)).coast - macroAt(c - vec2<f32>(e, 0.0)).coast, macroAt(c + vec2<f32>(0.0, e)).coast - macroAt(c - vec2<f32>(0.0, e)).coast);
    if (length(g) < 1e-3) { return 0.0; }
    d = -normalize(g);
    return H * clamp(0.5 + dot(x - c, d) / k.run, 0.0, 1.0);
  }
  // (near a river: along the river distance's gradient — mostly rising toward the river, a bluff over its floodplain)
  if (valleyBase() != 0u) {
    // (c is a world point: the lattice's frame is the world's, cells)
    let cw = c;
    let D = valleyDAt(cw);
    if (D < 420.0) {
      let e = 24.0;
      let g = vec2<f32>(valleyDAt(cw + vec2<f32>(e, 0.0)) - valleyDAt(cw - vec2<f32>(e, 0.0)), valleyDAt(cw + vec2<f32>(0.0, e)) - valleyDAt(cw - vec2<f32>(0.0, e)));
      if (length(g) > 1e-3) {
        d = normalize(g) * select(1.0, -1.0, hf(pcg(hh + 2u)) < 0.65);
      }
    }
  }
  return H * clamp(0.5 + dot(x - c, d) / k.run, 0.0, 1.0);
}

/** tilted cells' height at u (torus units) */
fn tiltField(k: TiltK, u: vec2<f32>) -> f32 {
  let pc = perOf(k.cell);
  let cs = AP.worldW / f32(pc);
  let v = pworley2(u * f32(pc), vec2<i32>(pc), 0.8, k.seed);
  // (in cells, in the lattice's frame: x and the features side by side, unwrapped)
  let x = u * f32(pc) * cs;
  let ca = v.pa * cs;
  let cb = v.pb * cs;
  let hA = tlPlane(k, v.ia, ca, x);
  let hB = tlPlane(k, v.ib, cb, x);
  let nrm = normalize(ca - cb);
  let bis = dot(x - 0.5 * (ca + cb), nrm);
  let gap = smoothstep(0.55, 0.75, 0.5 + 0.5 * pfbm(u, perOf(k.gap), 1u, k.seed + 2u));
  let wd = mix(k.scarp, max(abs(hA - hB) / TL_RAMP_SLOPE, k.scarp), gap);
  return mix(min(hA, hB), hA, smoothstep(0.0, wd, bis));
}

/** the plains' tilted cells' height at p (cells) */
fn tiltedCells(p: vec2<f32>, u: vec2<f32>) -> f32 {
  return tiltField(plainsTilt(), u);
}

// ---- coastal cliffs and isles (terrain-rivers step 3, TERRAIN_RIVERS.md §10.4; the owner: "use the tilted voronoi cell
// but for large atlas cells so that some coast is raised into high cliffs and use the masks to carve off cliff lined
// aisles" — islands and sea stacks; "Partial notch and fall into the sea" for rivers)
//
//   field    the tilted cells at atlas scale: CC_RAISED of CC_CELL cells rise toward the sea (a plane along −∇coast),
//            CC_H_MIN–CC_H_MAX at their raised edge; borders between cells as the plains' (scarp, or a ramp in a gap) —
//            a raised stretch ends at its flanks in a headland
//   mask     the coast band: (1 − smoothstep(0, CC_REACH, coast)) — signed additive onto the land region's own field
//            (a low–mid band: large features modified, not replaced)
//   border   where the raise stands over CC_CLIFF0..CC_CLIFF1 the coast's border is the mesa's cliff (compose.wgsl
//            ground(): tiers, ledges, sea caves, talus), mixed with the coast's own profile by that weight (no seam
//            where a stretch of cliff gives way to a beach)
//   isles    a drop with its own mask: the zero lines of a noise (|n| < CC_ISLE_T, period CC_ISLE_PER) inside raised
//            ground near the coast; inside, the land's field is cut to the sea floor (AP.sea − CC_ISLE_D) and blended at
//            the mask's border by its distance (|n|'s distance to the threshold over its gradient, in cells) over
//            CC_ISLE_EDGE — steep faces: channels of sea cutting off cliff-lined isles and stacks
const CC_CELL: f32 = 1200.0;
const CC_RUN: f32 = 1200.0;
const CC_REACH: f32 = 600.0;
const CC_H_MIN: f32 = 40.0;
const CC_H_MAX: f32 = 140.0;
const CC_SCARP: f32 = 4.0;
const CC_GAP: f32 = 300.0;
const CC_RAISED: f32 = 0.45;
const CC_CLIFF0: f32 = 6.0;
const CC_CLIFF1: f32 = 18.0;
const CC_ISLE_PER: f32 = 300.0;
const CC_ISLE_T: f32 = 0.08;
const CC_ISLE_D: f32 = 6.0;
const CC_ISLE_EDGE: f32 = 2.0;
const CC_ISLE_COAST: f32 = 250.0;

fn coastTilt() -> TiltK { return TiltK(CC_CELL, CC_RUN, CC_H_MIN, CC_H_MAX, CC_SCARP, CC_GAP, AP.seed + 941u, 1u); }

/** the coasts' raise at p (cells, ≥ 0; 0 off the coast band and in the default world) */
fn coastRaise(p: vec2<f32>, coast: f32) -> f32 {
  if (AP.terrain2 == 0u || coast >= CC_REACH) { return 0.0; }
  let wc = 1.0 - smoothstep(0.0, CC_REACH, max(coast, 0.0));
  return wc * tiltField(coastTilt(), torusU(p));
}

/** the coast's border weight toward the cliff (0 the coast's own profile, 1 the mesa's cliff) */
fn coastCliffW(raise: f32) -> f32 {
  return smoothstep(CC_CLIFF0, CC_CLIFF1, raise);
}

/** the land's field with the isles' channels cut (h: the land region's height with the raise; raise; coast): x the
 *  height, y the cut's weight (the sea stands in a channel: terrain/sea.wgsl seaOpen) */
fn isleCut(p: vec2<f32>, h: f32, raise: f32, coast: f32) -> vec2<f32> {
  let on = smoothstep(10.0, 30.0, raise) * (1.0 - smoothstep(CC_ISLE_COAST * 0.6, CC_ISLE_COAST, coast));
  if (on <= 0.0) { return vec2<f32>(h, 0.0); }
  let u = torusU(p);
  let per = perOf(CC_ISLE_PER);
  let s = AP.seed + 951u;
  let n = pfbm(u, per, 3u, s);
  // (the gradient a cell along x and y: |n|'s distance to the threshold, in cells)
  let du = 1.0 / AP.worldW;
  let gx = pfbm(u + vec2<f32>(du, 0.0), per, 3u, s) - n;
  let gy = pfbm(u + vec2<f32>(0.0, 1.0 / AP.worldH), per, 3u, s) - n;
  let gl = max(length(vec2<f32>(gx, gy)), 1e-5);
  let t = CC_ISLE_T * on;
  let d = (t - abs(n)) / gl;
  let inner = min(h, AP.sea - CC_ISLE_D);
  // (from the mask's border inward: where the mask thins to nothing the cut does too — continuous)
  let wcut = smoothstep(0.0, CC_ISLE_EDGE, d);
  return vec2<f32>(mix(h, inner, wcut), wcut);
}

/** the plains' relief at p (cells over the ground); A, B, w: the ground's regions and A's weight; coast; dl: the distance
 *  into A's landform */
/** the plains' weight at p (0: no plains relief here) */
fn plWeight(A: Region, B: Region, w: f32, coast: f32, dl: f32) -> f32 {
  return mix(plTier(B), plTier(A), w) * smoothstep(60.0, 250.0, coast) * smoothstep(20.0, 120.0, dl);
}

struct PlSub {
  kind: u32,
  /** the fade to the sub-region's border (0 on it) */
  edge: f32,
  hash: u32,
}

/** the plains' sub-region at p: its kind, the fade to its border, its hash */
fn plSubAt(p: vec2<f32>) -> PlSub {
  let u = torusU(p);
  // (the sub-regions' borders wander: a slow warp of the lattice)
  let wp = vec2<f32>(pfbm(u, perOf(900.0), 2u, AP.seed + 901u), pfbm(u, perOf(900.0), 2u, AP.seed + 902u)) * (160.0 / AP.worldW);
  let pc = perOf(PL_CELL);
  let v = pworley((u + wp) * f32(pc), vec2<i32>(pc), 0.85, AP.seed + 903u);
  let hh = pcg(v.id * 2654435761u + AP.seed * 97u + 7u);
  return PlSub(plKind(hf(hh)), smoothstep(0.0, PL_EDGE, 0.5 * (v.f2 - v.f1)), hh);
}

fn plainRelief(p: vec2<f32>, A: Region, B: Region, w: f32, coast: f32, dl: f32) -> f32 {
  let wt = plWeight(A, B, w, coast, dl);
  if (wt <= 0.001) { return 0.0; }
  let u = torusU(p);
  let sb = plSubAt(p);
  let edge = sb.edge;
  let hh = sb.hash;
  let kind = sb.kind;
  let amp = 0.7 + 0.6 * hf(pcg(hh));
  var h = 0.0;
  switch kind {
    case 1u: {
      // rolling hills: smooth rises only (never under the base), a few to a sub-region
      let n = 0.5 + 0.5 * pfbm(u, perOf(260.0), 3u, AP.seed + 911u);
      h = 14.0 * amp * smoothstep(0.25, 0.85, n);
    }
    case 2u: {
      // low ridges: ridged noise's crests (isotropic: a stretched lattice would break the torus's period)
      h = 11.0 * amp * smoothstep(0.35, 0.95, pridged(u, perOf(330.0), 2u, AP.seed + 912u));
    }
    case 3u: {
      // terraces: a slow rise cut into flat treads and short risers
      let base = 16.0 * amp * (0.5 + 0.5 * pfbm(u, perOf(360.0), 2u, AP.seed + 913u));
      let S = 3.5;
      let q = base / S;
      h = S * (floor(q) + smoothstep(0.78, 1.0, fract(q)));
    }
    case 4u: {
      // hummocks: scattered low mounds
      let pb = perOf(30.0);
      let wb = pworley(u * f32(pb), vec2<i32>(pb), 0.9, AP.seed + 914u);
      let hb = hf(pcg(wb.id ^ (AP.seed * 0x9e3779b9u)));
      h = select(0.0, (2.5 + 3.5 * hb) * amp * (1.0 - smoothstep(0.0, 0.48, wb.f1)), hb > 0.35);
    }
    case 5u: {
      // wet flats: a little lower than the land round them, and flat
      h = -1.5;
    }
    case 6u: {
      // tilted cells (the owner's): planes rising to a raised edge, small scarps, ramps in the gaps
      h = amp * tiltedCells(p, u);
    }
    default: {
      h = 0.0;
    }
  }
  return wt * edge * h;
}
