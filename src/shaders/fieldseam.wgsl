// ---- fieldseam.wgsl: the orders' one way to a field (U2 round 6; the paged field atlas, §9b, swaps this for pages) ----
// Appended after units.wgsl (and its agents.wgsl) in the order kernels (orders.wgsl). Everything drill, man, march and
// the formations do with a field goes through these: its distance at a surface, its way down there, a seed set or let
// go. Today a field is a plane of `dist` and a bit of `seedMask`, its chunks marked in `dirtyCur`; round 7 pages them.
// (The kernels that call fieldSeed / fieldUnseed bind seedMask and dirtyCur; those that call fieldDist / fieldGrad bind
// dist: each set of kernels uses only its own.)

/** field f's distance at surface s (FAR: no way) */
fn fieldDist(f: u32, s: u32) -> f32 { return dist[f * ns() + s]; }
/** field f's way down at surface s (column c, at pos): a unit vector, or 0 at a seed or with no way */
fn fieldGrad(f: u32, s: u32, c: vec2<i32>, pos: vec2<f32>) -> vec2<f32> { return downField(f, s, c, pos, fieldDist(f, s)); }
/** surface s's chunk (its column's page slot: common.wgsl colIdx) */
fn fieldChunk(s: u32) -> u32 { return (s / NAV_K) / (COLS_PAGE * COLS_PAGE); }
/** surface s a seed of field f; `mark`: its chunk marked for f (the field falls round it) */
fn fieldSeed(f: u32, s: u32, mark: bool) {
  atomicOr(&seedMask[s], 1u << f);
  if (mark) { atomicOr(&dirtyCur[fieldChunk(s)], 1u << f); }
}
/** surface s no longer a seed of field f, its chunk marked (the field rises there) */
fn fieldUnseed(f: u32, s: u32) {
  atomicAnd(&seedMask[s], ~(1u << f));
  atomicOr(&dirtyCur[fieldChunk(s)], 1u << f);
}
