// ---- mutate/lots.wgsl: a town's lot conditions from an entry (masks.wgsl before it) ------------------------------
/** a town's lot records (api/contracts/citygen.ts), its counts, its lots' condition words, its frame's place */
@group(0) @binding(10) var<storage, read> lotRecs: array<u32>;
@group(0) @binding(11) var<storage, read> lotCounts: array<u32>;
@group(0) @binding(12) var<storage, read_write> lotCond: array<u32>;
@group(0) @binding(13) var<uniform> lotPlace: vec4<f32>;

/** one thread a lot record: its condition from the entry (the same masks, at the lot's middle and its base) */
@compute @workgroup_size(64)
fn mutLots(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = id.x;
  if (r >= MP.k.z) { return; }
  // (records: the lots, then the landmark sites from counts[3])
  let nLots = min(lotCounts[0], lotCounts[3]);
  if (r >= nLots && (r < lotCounts[3] || r >= lotCounts[3] + min(lotCounts[1], 64u))) { return; }
  let o = r * 24u;
  let kind = lotRecs[o + 17u];
  if (kind == 0u) { return; }
  var c = vec2<f32>(0.0);
  for (var k = 0u; k < 4u; k++) { c += vec2<f32>(bitcast<f32>(lotRecs[o + 8u + k * 2u]), bitcast<f32>(lotRecs[o + 9u + k * 2u])); }
  let wp = c * 0.25 + lotPlace.xy;
  let d = mutD(wp);
  if (d >= 1.0) { return; }
  let w = wp + MP.org.xy;
  let h = max(bitcast<f32>(lotRecs[o + 20u]), 1.0);
  let base = bitcast<f32>(lotRecs[o + 21u]) + lotPlace.z;
  let cur = lotCond[r];
  let m = MP.k.x;
  if (m == MUT_RESTORED) { lotCond[r] = 0u; return; }
  // (the 'crime' sign: a share of the standing buildings looted, by the lot's own seed; and put right)
  if (m == MUT_UNLOOT) {
    if ((cur & 0xffu) == LC_LOOTED) { lotCond[r] = cur & 0xffff0000u; }
    return;
  }
  if (m == MUT_LOOT) {
    if ((cur & 0xffu) == 0u && kind == 1u && mhash(i32(lotRecs[o + 23u] & 0xffffu), i32(lotRecs[o + 23u] >> 16u), MP.k.y) < 0.06 + 0.16 * MP.at.w) {
      lotCond[r] = (cur & 0xffff0000u) | LC_LOOTED | (255u << 8u);
    }
    return;
  }
  if ((cur & 0xffu) == LC_DESTROYED) { return; }
  var c2 = 0u;
  var sev = 0.0;
  if (m == MUT_FLOODED) {
    let over = floodLevel(d) - (base + 0.5);
    if (over >= 0.5) { c2 = LC_DROWNED; sev = over / h; }
  } else if (m == MUT_BURNED) {
    if (burnIn(w, d)) { c2 = LC_BURNED; sev = 1.0; }
  } else if (m == MUT_MELTED) {
    // (how far it slumped: the lot's own seed — streets.wgsl condHeight)
    if (meltT(wp, w, base + 0.5) > 0.0) { c2 = LC_DESTROYED; sev = mhash(i32(lotRecs[o + 23u] & 0xffffu), i32(lotRecs[o + 23u] >> 16u), MP.k.y + 21u); }
  } else if (m == MUT_BURIED) {
    let t = buryDepth(w, d);
    if (t >= 0.2 * h || t >= 1.2) { c2 = LC_BURIED; sev = t / h; }
  } else if (m == MUT_RUINED) {
    c2 = LC_BURNED; sev = 1.0;
  } else if (m == MUT_ABANDONED) {
    // (a burned or drowned house is that still)
    if ((cur & 0xffu) == 0u || (cur & 0xffu) == LC_OCCUPIED) { c2 = LC_ABANDONED; sev = 1.0; }
  } else if (m == MUT_OCCUPIED) {
    if ((cur & 0xffu) == 0u) { c2 = LC_OCCUPIED; sev = f32(MP.k.w & 0xffu) / 255.0; }
  }
  if (c2 == 0u) { return; }
  lotCond[r] = (cur & 0xffff0000u) | c2 | (u32(clamp(sev, 0.0, 1.0) * 255.0) << 8u);
}
