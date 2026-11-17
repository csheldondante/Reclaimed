// Terrain rivers, step 1 (docs/design/TERRAIN_RIVERS.md §4; flag a.rivers2=1): the land shaped round the rivers.
// Prepended to every atlas kernel by Atlas.parts(), after the table's constants (terrain/walks.ts valleyWgslConsts:
// VAL_BANK, VAL_FLOOD_SLOPE, VAL_TAU, VAL_FP_K, VAL_SIGMA, VAL_VW, VAL_RAISE, VAL_REACH, VAL_VJ, VAL_LF_PEN — change
// them there, not here).
//
//   V(e)  = BANK (1 − exp(−e/1.5)) + FLOOD_SLOPE e + σ [τ ln(1 + exp((e − F)/τ)) − τ ln(1 + exp(−F/τ))],  F = FP_K w
//   Hv_c  = L_c(s) + V(e_c) + (1 − share of c's landform here) · LF_PEN        per candidate segment c
//   fade  = 1 − smoothstep(VW/2, VW, e)                                         the valley's reach
//   R(d)  = RAISE (1 − exp(−d/REACH)) smoothstep(0, 300, coast)                d: the least distance to any segment
//   G'    = G + R(d)                                                            G: compose.wgsl's ground to the stamps
//   h     = min over c of  G' − fade(e_c) · max(0, G' − Hv_c)                   (h = G' where no valley reaches)
//
// So within a valley's reach the ground comes down to the valley's profile; beyond it the landforms stand as they were
// (raised): peaks, cliffs and stamps keep their height, and a valley cut through high ground is a gorge whose walls
// steepen where the fade closes. On the river line e = 0, fade = 1, Hv = L ≤ G: the river is the bottom.
//
// The candidates: the nodes of the 4 texels round the (warped, as riverAt) point in two tables — the nearest node
// within 6 texels (riverAt's) and the lowest-cost node, unbounded (a second JFA by cost = level + VJ · distance, + LF_PEN
// for another landform's: atlas/atlas/build.ts, terrain/valleyjfa.wgsl) — and each node's two segments, main upstream →
// node → next. A segment's upstream end has no round cap except at a source: a point behind it belongs to the segment
// above (otherwise a fall's lower reach would cut a cone back into the lip). A river shapes only its own landform's
// ground (a lowland river under a mesa leaves the cliff alone): another landform's share of the ground here adds LF_PEN.
//
// Where the data lives: the crater block's word 3 (riverBuf[n² + 3]) is the valley block's offset in words (0: off —
// the default world, which never reaches this code), then n² words of lowest-cost node + 1, then a word a node: its
// main upstream node.

fn valleyBase() -> u32 { return riverBuf[AP.n * AP.n + 3u]; }

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

const VAL_CANDS: u32 = 16u;

struct ValAcc {
  /** per candidate segment: its valley height Hv_c and its edge distance e_c */
  hv: array<f32, VAL_CANDS>,
  e: array<f32, VAL_CANDS>,
  k: u32,
  /** the least distance to a river segment */
  d: f32,
  fpk: f32,
  sigma: f32,
  /** the point's two landforms (A's, B's) and A's weight */
  lfA: u32,
  lfB: u32,
  w: f32,
}

fn valleySeg(acc: ptr<function, ValAcc>, a: RiverNode, b: RiverNode, p: vec2<f32>, capA: bool) {
  let pa = nearTo(vec2<f32>(a.x, a.y), p);
  let pb = nearTo(vec2<f32>(b.x, b.y), pa);
  let ab = pb - pa;
  let l2 = dot(ab, ab);
  var t = 0.0;
  if (l2 > 1e-6) { t = dot(p - pa, ab) / l2; }
  let s = clamp(t, 0.0, 1.0);
  let d = length(p - (pa + ab * s));
  (*acc).d = min((*acc).d, d);
  if ((t < 0.0 && !capA) || (*acc).k >= VAL_CANDS) { return; }
  let w = mix(a.width, b.width, s);
  let e = max(d - w, 0.0);
  let L = segLevel(a, b, s, sqrt(max(l2, 1e-12)));
  let X = nodeLf(a);
  let wX = select(0.0, (*acc).w, (*acc).lfA == X) + select(0.0, 1.0 - (*acc).w, (*acc).lfB == X);
  (*acc).hv[(*acc).k] = L + valleyV(e, w, (*acc).fpk, (*acc).sigma) + (1.0 - clamp(wX, 0.0, 1.0)) * VAL_LF_PEN;
  (*acc).e[(*acc).k] = e;
  (*acc).k += 1u;
}

fn valleyNode(acc: ptr<function, ValAcc>, id: u32, p: vec2<f32>, vb: u32) {
  let upTab = vb + AP.n * AP.n;
  let b = riverNode(id);
  let u = riverBuf[upTab + id];
  let src = u == id;
  if (!src) {
    let uu = riverBuf[upTab + u];
    valleySeg(acc, riverNode(u), b, p, uu == u);
  }
  valleySeg(acc, b, riverNode(b.next), p, src);
}

/** the tier's row of the table (water: lowland) */
fn valTier(r: Region) -> u32 { return select(0u, min(r.tier, 3u), isLand(r)); }

/**
 * The ground shaped round the rivers (the header's h). p: the unwarped point (warped here as riverAt warps it, so the
 * valley and the channel agree); G: the ground so far; a, b, w, coast: the ground's regions, A's weight, the coast.
 * Returns (h, raise).
 */
fn valleyGround(p0: vec2<f32>, G: f32, a: u32, b: u32, w: f32, coast: f32) -> vec2<f32> {
  let A = regs[a];
  let B = regs[b];
  let ta = valTier(A);
  let tb = valTier(B);
  var fk = VAL_FP_K;
  var sg = VAL_SIGMA;
  var vw = VAL_VW;
  var ra = VAL_RAISE;
  var re = VAL_REACH;
  var acc: ValAcc;
  acc.k = 0u;
  acc.d = 1e9;
  acc.fpk = mix(fk[tb], fk[ta], w);
  acc.sigma = mix(sg[tb], sg[ta], w);
  acc.lfA = A.lf;
  acc.lfB = B.lf;
  acc.w = select(w, 1.0, A.lf == B.lf);
  let VW = max(mix(vw[tb], vw[ta], w), 1.0);
  let raiseMax = mix(ra[tb], ra[ta], w);
  let reach = max(mix(re[tb], re[ta], w), 1.0);
  let vb = valleyBase();
  let p = p0 + riverWarp(p0);
  let t = torusU(p) * f32(AP.n) - 0.5;
  let i0 = vec2<i32>(floor(t));
  for (var k = 0; k < 4; k++) {
    let j = texIdxW(i0 + vec2<i32>(k & 1, k >> 1));
    let na = riverBuf[j];
    if (na != 0u) { valleyNode(&acc, na - 1u, p, vb); }
    let nc = riverBuf[vb + j];
    if (nc != 0u && nc != na) { valleyNode(&acc, nc - 1u, p, vb); }
  }
  let raise = raiseMax * (1.0 - exp(-acc.d / reach)) * smoothstep(0.0, 300.0, coast);
  let Gr = G + raise;
  var h = Gr;
  for (var k = 0u; k < acc.k; k++) {
    let fade = 1.0 - smoothstep(VW * 0.5, VW, acc.e[k]);
    h = min(h, Gr - fade * max(0.0, Gr - acc.hv[k]));
  }
  return vec2<f32>(h, raise);
}
