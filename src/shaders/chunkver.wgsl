// ---- chunkver.wgsl ------------------------------------------------------------------------------------------------
// (round 128o, DA-B9 and DA-B26) The chunks' versions, after the chunk table in the same buffer (sim/chunkver.ts): per
// chunk two vec2s, the tick + 1 that last changed
//   [0].x its columns,
//   [0].y what its surfaces read beside the columns: its water's class (waterclass.wgsl: crossed a walker's band) or
//         its places,
//   [1].x its water's depth at all (any change),
//   [1].y unused;
// 0: never. Keyed by where the chunk's columns lie (its first slot / 256: they move with it when the window slides,
// the table rotating over them). Appended, with the chunk table made writable, to every kernel that writes the columns
// or the water (gpu/pipeline.ts makeCompute: a kernel calling bumpChunk or bumpWater): each calls it for a column it
// changed. Every writer this tick writes the same value: plain stores, no atomics.

/** where the versions start in `chunks` (vec2 units: after the table's one a chunk) */
fn chunkVerBase() -> u32 { return G.chunksX * (G.mapH / G.chunkSize); }

/** column q's chunk's versions' place in `chunks` (its first vec2) */
fn chunkVerAt(q: vec2<u32>) -> u32 {
  let cs = G.chunkSize;
  return chunkVerBase() + 2u * (chunks[(q.y / cs) * G.chunksX + q.x / cs].x / (cs * cs));
}

/** column q's columns changed this tick */
fn bumpChunk(q: vec2<u32>) { chunks[chunkVerAt(q)].x = G.tick + 1u; }

/** column q's water went from `before` to `after` this tick: its depth's version if it moved, its class's if it
 *  crossed a band */
fn bumpWater(q: vec2<u32>, before: f32, after: f32) {
  if (before == after) { return; }
  let at = chunkVerAt(q);
  chunks[at + 1u].x = G.tick + 1u;
  if (waterClassCrossed(before, after)) { chunks[at].y = G.tick + 1u; }
}
