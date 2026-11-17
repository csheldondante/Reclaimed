// Terrain rivers (docs/design/TERRAIN_RIVERS.md §4, step 2 §9; flag a.rivers2=1): the land shaped round the rivers.
// Prepended to every atlas kernel by Atlas.parts(), after the table's constants (terrain/walks.ts valleyWgslConsts:
// VAL_BANK, VAL_FLOOD_SLOPE, VAL_TAU, VAL_FP_K, VAL_SIGMA, VAL_VW, VAL_RAISE, VAL_REACH, VAL_LF_PEN, VAL_PHI_SLOPE,
// VAL_PHI_CURV, VAL_SMIN_K,
// VAL_FINE_E, VAL_FINE_K, VAL_HEAD_LEN, VAL_HEAD_POW, VAL_SPRING_R, VAL_SPRING_D — change them there, not here).
//
// Step 2, the two-scale field (§9). Everything in the warped space q = p + riverWarp(p), where the river is the node
// polyline riverAt tests:
//   S_c(x) = L_c(s) + V(e_c) + Φ(e_c)       one river segment's valley surface, G-independent
//   Φ(e)   = PHI_SLOPE m + PHI_CURV m²,  m = max(0, e − VW/2)   its bound: past half the reach it climbs out of the land
//   E(x)   = min_c S_c(x)                    the envelope: continuous (a min of continuous surfaces)
// Coarse: E, the least distance D and the winner's landform at every texel centre (the build: terrain/valleyjfa.wgsl),
// bilinear here with the landform penalty per cell:  Ê = Σ β_t (E_t + [ℓ_t ≠ ℓ_cell] · min(LF_PEN, LF_SLOPE · dl)),
// dl the cell's distance into its landform (the landforms' JFA): a river climbs out of another landform at a slope.
// Fine: at the channel, riverAt's exact segment: h_f = L + V(e) + FINE_K max(0, e − FINE_E)² (+ its landform penalty).
//   G' = G + R(D̂),   h = smin(G', min(Ê, h_f); SMIN_K)
// On the river line h ≤ L: the river is the bottom; beyond the reach S > G': the landforms stand (raised).
//
// Where the data lives: the crater block's word 3 (riverBuf[n² + 3]) is the valley block's offset in words (0: off —
// the default world, which never reaches this code): 2 n² words — per texel E (f32) and pack2x16float(D, landform) —
// then two words a node: its main upstream node (itself: a source) and its head's far level (NO_HEAD: none).

fn valleyBase() -> u32 { return riverBuf[AP.n * AP.n + 3u]; }

/** (step 2) the coarse distance to the nearest river at a world point (bilinear over the valley block's D; only with
 *  the valley block) */
fn valleyDAt(x: vec2<f32>) -> f32 {
  let vb = valleyBase();
  let t = torusU(x) * f32(AP.n) - 0.5;
  let i0 = vec2<i32>(floor(t));
  let f = t - floor(t);
  var d = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2<i32>(k & 1, k >> 1);
    let bw = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    d += bw * unpack2x16float(riverBuf[vb + 2u * texIdxW(i0 + o) + 1u]).x;
  }
  return d;
}

/** a node's main upstream node (itself: a source); only with the valley block */
fn riverUp(id: u32) -> u32 { return riverBuf[valleyBase() + 2u * AP.n * AP.n + 2u * id]; }
/** a source's valley head's far level (≤ −1e29: none) */
fn riverHead(id: u32) -> f32 { return bitcast<f32>(riverBuf[valleyBase() + 2u * AP.n * AP.n + 2u * id + 1u]); }

/** the landform a node lies in (its texel's region's; compose.wgsl Region.lf) */
fn nodeLf(nd: RiverNode) -> u32 {
  let t = torusU(vec2<f32>(nd.x, nd.y)) * f32(AP.n);
  return regs[regionR[texIdxW(vec2<i32>(floor(t)))]].lf;
}

fn valSoftplus(x: f32) -> f32 { return select(log(1.0 + exp(min(x, 30.0))), x, x > 30.0); }

/** the valley's profile: cells over the river at e cells from its edge (w: its half-width; fpk, sigma: the tier's) */
fn valleyV(e: f32, w: f32, fpk: f32, sigma: f32) -> f32 {
  let F = fpk * w;
  let t = VAL_TAU;
  return VAL_BANK * (1.0 - exp(-e / 1.5)) + VAL_FLOOD_SLOPE * e + sigma * t * (valSoftplus((e - F) / t) - valSoftplus(-F / t));
}

/** §9.2: the valley's bound past half its reach */
fn valleyPhi(e: f32, vw: f32) -> f32 {
  let m = max(0.0, e - 0.5 * vw);
  return VAL_PHI_SLOPE * m + VAL_PHI_CURV * m * m;
}

/** §9.5: the polynomial smooth minimum (≤ min; equal once |a − b| ≥ k) */
fn valSmin(a: f32, b: f32, k: f32) -> f32 {
  let m = max(0.0, 1.0 - abs(a - b) / k);
  return min(a, b) - 0.25 * k * m * m;
}

/** the tier's row of the table (water: lowland) */
fn valTier(r: Region) -> u32 { return select(0u, min(r.tier, 3u), isLand(r)); }

/** a profile: the floodplain's width factor, the wall's slope, the reach */
struct ValProf {
  fpk: f32,
  sigma: f32,
  vw: f32,
}

fn valProfOf(tier: u32) -> ValProf {
  var fk = VAL_FP_K;
  var sg = VAL_SIGMA;
  var vw = VAL_VW;
  return ValProf(fk[tier], sg[tier], max(vw[tier], 1.0));
}

/** one segment's surface S and distance at x (world units, q-space). capA: a round end at a (a source's) — without it
 *  a point behind a belongs to the segment above (a fall's lower reach would otherwise cut a cone back into the lip) */
fn valSegS(a: RiverNode, b: RiverNode, x: vec2<f32>, capA: bool, pr: ValProf) -> vec2<f32> {
  let pa = nearTo(vec2<f32>(a.x, a.y), x);
  let pb = nearTo(vec2<f32>(b.x, b.y), pa);
  let ab = pb - pa;
  let l2 = dot(ab, ab);
  var t = 0.0;
  if (l2 > 1e-6) { t = dot(x - pa, ab) / l2; }
  let s = clamp(t, 0.0, 1.0);
  let d = length(x - (pa + ab * s));
  if (t < 0.0 && !capA) { return vec2<f32>(1e9, d); }
  let w = mix(a.width, b.width, s);
  let e = max(d - w, 0.0);
  let L = segLevel(a, b, s, sqrt(max(l2, 1e-12)));
  return vec2<f32>(L + valleyV(e, w, pr.fpk, pr.sigma) + valleyPhi(e, pr.vw), d);
}

/** §9.5 a source's head: from the spring s to H = s + HEAD_LEN straight up the valley, the floor near the spring's
 *  level then up to the land's (lh), narrowing to nothing; no water */
fn valHeadS(sN: RiverNode, nx: RiverNode, lh: f32, x: vec2<f32>, pr: ValProf) -> f32 {
  let ps = nearTo(vec2<f32>(sN.x, sN.y), x);
  let pn = nearTo(vec2<f32>(nx.x, nx.y), ps);
  let dl = length(ps - pn);
  if (dl < 1e-4) { return 1e9; }
  let u = (ps - pn) / dl;
  let ph = ps + u * VAL_HEAD_LEN;
  let ab = ph - ps;
  let t = clamp(dot(x - ps, ab) / dot(ab, ab), 0.0, 1.0);
  let d = length(x - (ps + ab * t));
  let w = sN.width * (1.0 - t);
  let e = max(d - w, 0.0);
  let L = sN.level + (lh - sN.level) * pow(t, VAL_HEAD_POW);
  return L + valleyV(e, max(w, 0.01), pr.fpk, pr.sigma) + valleyPhi(e, pr.vw);
}

/** a node's surface at x: the least S over its segments (main upstream → it, it → next, a source's head) and the least
 *  distance to them (x: S, y: distance) */
fn valNodeS(id: u32, x: vec2<f32>, pr: ValProf) -> vec2<f32> {
  let b = riverNode(id);
  let u = riverUp(id);
  let src = u == id;
  var o = vec2<f32>(1e9, 1e9);
  if (!src) {
    let r = valSegS(riverNode(u), b, x, riverUp(u) == u, pr);
    o = min(o, r);
  }
  if (b.next != id) {
    let nx = riverNode(b.next);
    o = min(o, valSegS(b, nx, x, src, pr));
    let lh = riverHead(id);
    if (src && lh > -1e29) { o.x = min(o.x, valHeadS(b, nx, lh, x, pr)); }
  }
  return o;
}

/**
 * The ground shaped round the rivers (§9.5). p0: the unwarped point (warped here as riverAt warps it, so the valley and
 * the channel agree); G: the ground so far; a, b, w, coast: the ground's regions, A's weight, the coast; dl: the distance
 * into A's landform (compose Ground.dl); rv: riverAt(p0)
 * (the fine profile's segment). Returns (h, raise).
 */
fn valleyGround(p0: vec2<f32>, G: f32, a: u32, b: u32, w: f32, coast: f32, dl: f32, rv: River) -> vec2<f32> {
  let A = regs[a];
  let B = regs[b];
  let ta = valTier(A);
  let tb = valTier(B);
  var fk = VAL_FP_K;
  var sg = VAL_SIGMA;
  var ra = VAL_RAISE;
  var re = VAL_REACH;
  let raiseMax = mix(ra[tb], ra[ta], w);
  let reach = max(mix(re[tb], re[ta], w), 1.0);
  let vb = valleyBase();
  let p = p0 + riverWarp(p0);
  // the coarse field: a quadratic B-spline over the 3 × 3 texel centres round q (C1: bilinear's kinks at the texel
  // lines showed in the hillshade as straight streaks), the landform penalty per cell
  let t = torusU(p) * f32(AP.n) - 0.5;
  let ic = vec2<i32>(round(t));
  let f = t - round(t);
  var wx = array<f32, 3>(0.5 * (0.5 - f.x) * (0.5 - f.x), 0.75 - f.x * f.x, 0.5 * (0.5 + f.x) * (0.5 + f.x));
  var wy = array<f32, 3>(0.5 * (0.5 - f.y) * (0.5 - f.y), 0.75 - f.y * f.y, 0.5 * (0.5 + f.y) * (0.5 + f.y));
  var Eh = 0.0;
  var Dh = 0.0;
  // (another landform's river climbs LF_SLOPE a cell into this landform from its border — dl, the landforms' JFA
  // distance, continuous — to LF_PEN: a mesa's cliff stands, and where two landforms meet at one height the valley
  // ends in a wall of a valley's slope, not a step: §9.2)
  let pen = min(VAL_LF_PEN, VAL_LF_SLOPE * max(dl, 0.0));
  let lfA = i32(A.lf);
  for (var k = 0; k < 9; k++) {
    let o = vec2<i32>(k % 3 - 1, k / 3 - 1);
    let j = texIdxW(ic + o);
    let bw = wx[o.x + 1] * wy[o.y + 1];
    let E = bitcast<f32>(riverBuf[vb + 2u * j]);
    let dlf = unpack2x16float(riverBuf[vb + 2u * j + 1u]);
    let lf = i32(round(dlf.y));
    Eh += bw * (E + select(pen, 0.0, lf == lfA));
    Dh += bw * dlf.x;
  }
  // the fine profile at the channel (riverAt's exact segment), the cell's own blended tier
  var Ec = Eh;
  if (rv.on) {
    let ef = max((rv.x - 1.0) * rv.w, 0.0);
    let X = nodeLf(riverNode(rv.id));
    let hf = rv.level + valleyV(ef, rv.w, mix(fk[tb], fk[ta], w), mix(sg[tb], sg[ta], w)) + VAL_FINE_K * max(0.0, ef - VAL_FINE_E) * max(0.0, ef - VAL_FINE_E) + select(pen, 0.0, X == A.lf);
    Ec = min(Ec, hf);
  }
  // (less raise near the world's top: the first stills had massifs raised into zTop's clamp — flat-topped at 480)
  let room = clamp((AP.zTop - 20.0 - G) / max(raiseMax, 1.0), 0.0, 1.0);
  let raise = raiseMax * (1.0 - exp(-Dh / reach)) * smoothstep(0.0, 300.0, coast) * room;
  let Gr = G + raise;
  return vec2<f32>(valSmin(Gr, Ec, VAL_SMIN_K), raise);
}
