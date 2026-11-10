// ---- worldops.wgsl: the world operations on a column, one rule for every caller ----------------------------------
// Units change the world only through these (DESIGN §11): a take off a column's top, a put on it, a fell of the
// column's plants. Called by edit.wgsl (OP_TAKE, OP_PUT, OP_FELL: the CPU's events, four a tick) and by the living
// town's works (citylife/works.wgsl: the quarry's dig, the stockpile's put, the woodcutters' fells: from the GPU).
// The column is held in a function array, `n` its intervals; the caller writes back what changed (and bumps its chunk's
// version). Needs common.wgsl (iv*), materials.wgsl (MAT_EXTERNAL), layers.wgsl (MAX_K), vegplan.wgsl (VEG_STUMP).

/**
 * Up to `amount` off the top interval (whatever it is but External — a claimed thing's cells are its owner's; dust or
 * snow lying on it is its own interval and is taken); never below z 2 (the map keeps a floor). Returns what was taken;
 * `mat` gets the taken interval's material. An interval taken whole is removed.
 */
fn opTake(arr: ptr<function, array<vec4<u32>, MAX_K>>, n: ptr<function, u32>, amount: f32, mat: ptr<function, u32>) -> f32 {
  if (*n == 0u) { return 0.0; }
  let t = (*arr)[*n - 1u];
  if (ivMat(t) == MAT_EXTERNAL) { return 0.0; }
  *mat = ivMat(t);
  let got = clamp(amount, 0.0, ivZ1(t) - max(ivZ0(t), 2.0));
  if (got <= 0.0) { return 0.0; }
  if (ivZ1(t) - got <= ivZ0(t) + 1e-3) {
    *n -= 1u;
    (*arr)[*n] = IV_NONE;
  } else {
    (*arr)[*n - 1u] = ivPack(ivZ0(t), ivZ1(t) - got, ivMat(t), ivAux(t));
  }
  return got;
}

/**
 * Up to `amount` of `mat` on top: onto the top interval if it's the same material, else a new interval if the column
 * has a free slot (`slots` its K); never past `zCap`. Returns what was put (0: no room).
 */
fn opPut(arr: ptr<function, array<vec4<u32>, MAX_K>>, n: ptr<function, u32>, slots: u32, mat: u32, amount: f32, zCap: f32) -> f32 {
  var top = 0.0;
  if (*n > 0u) { top = ivZ1((*arr)[*n - 1u]); }
  let a = clamp(amount, 0.0, zCap - top);
  if (a <= 0.0) { return 0.0; }
  if (*n > 0u && ivMat((*arr)[*n - 1u]) == mat) {
    let t = (*arr)[*n - 1u];
    (*arr)[*n - 1u] = ivPack(ivZ0(t), top + a, mat, ivAux(t));
    return a;
  }
  if (*n < slots) {
    (*arr)[*n] = ivPack(top, top + a, mat, 0u);
    *n += 1u;
    return a;
  }
  return 0.0;
}

/** a felled tree's stump (vegplan.wgsl vegStump's band 2.25–2.45 shows it) */
const VEG_STUMP: f32 = 2.35;
/** what's cut back to grass by a clearing (plants.clear) */
const OP_FELLED: f32 = 2.2;
/**
 * A fell's succession after it: an exact fell of a tree (succession at a tree's) leaves its stump (vegplan.wgsl
 * VEG_STUMP), a clearing cuts to grass; never raised.
 */
fn opFell(had: f32, exact: bool) -> f32 {
  return min(had, select(OP_FELLED, VEG_STUMP, exact && had >= 3.6));
}
