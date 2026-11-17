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

const TL_CELL: f32 = 150.0;
const TL_RUN: f32 = 150.0;
const TL_H_MIN: f32 = 3.0;
const TL_H_MAX: f32 = 9.0;
const TL_SCARP: f32 = 1.5;
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

/** a tilted cell's plane at x (cells): c its feature (cells), id its hash */
fn tlPlane(id: u32, c: vec2<f32>, x: vec2<f32>) -> f32 {
  let hh = pcg(id * 2246822519u + AP.seed * 31u + 5u);
  let H = mix(TL_H_MIN, TL_H_MAX, hf(hh));
  var d = vec2<f32>(cos(6.2831853 * hf(pcg(hh + 1u))), sin(6.2831853 * hf(pcg(hh + 1u))));
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
  return H * clamp(0.5 + dot(x - c, d) / TL_RUN, 0.0, 1.0);
}

/** the tilted cells' height at p (cells) */
fn tiltedCells(p: vec2<f32>, u: vec2<f32>) -> f32 {
  let pc = perOf(TL_CELL);
  let cs = AP.worldW / f32(pc);
  let v = pworley2(u * f32(pc), vec2<i32>(pc), 0.8, AP.seed + 921u);
  // (in cells, in the lattice's frame: x and the features side by side, unwrapped)
  let x = u * f32(pc) * cs;
  let ca = v.pa * cs;
  let cb = v.pb * cs;
  let hA = tlPlane(v.ia, ca, x);
  let hB = tlPlane(v.ib, cb, x);
  let nrm = normalize(ca - cb);
  let bis = dot(x - 0.5 * (ca + cb), nrm);
  let gap = smoothstep(0.55, 0.75, 0.5 + 0.5 * pfbm(u, perOf(TL_GAP), 1u, AP.seed + 923u));
  let wd = mix(TL_SCARP, max(abs(hA - hB) / TL_RAMP_SLOPE, TL_SCARP), gap);
  return mix(min(hA, hB), hA, smoothstep(0.0, wd, bis));
}

/** the plains' relief at p (cells over the ground); A, B, w: the ground's regions and A's weight; coast; dl: the distance
 *  into A's landform */
fn plainRelief(p: vec2<f32>, A: Region, B: Region, w: f32, coast: f32, dl: f32) -> f32 {
  let wt = mix(plTier(B), plTier(A), w) * smoothstep(60.0, 250.0, coast) * smoothstep(20.0, 120.0, dl);
  if (wt <= 0.001) { return 0.0; }
  let u = torusU(p);
  // (the sub-regions' borders wander: a slow warp of the lattice)
  let wp = vec2<f32>(pfbm(u, perOf(900.0), 2u, AP.seed + 901u), pfbm(u, perOf(900.0), 2u, AP.seed + 902u)) * (160.0 / AP.worldW);
  let pc = perOf(PL_CELL);
  let v = pworley((u + wp) * f32(pc), vec2<i32>(pc), 0.85, AP.seed + 903u);
  let edge = smoothstep(0.0, PL_EDGE, 0.5 * (v.f2 - v.f1));
  let hh = pcg(v.id * 2654435761u + AP.seed * 97u + 7u);
  let kind = plKind(hf(hh));
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
