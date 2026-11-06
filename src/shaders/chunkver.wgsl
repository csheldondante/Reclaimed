// ---- chunkver.wgsl ------------------------------------------------------------------------------------------------
// (round 128o, DA-B9) The chunks' versions, after the chunk table in the same buffer (sim/chunkver.ts): per chunk the
// tick + 1 that last changed its columns (0: never). Keyed by where the chunk's columns lie (its first slot / 256: they
// move with it when the window slides, the table rotating over them). Appended, with the chunk table made writable, to
// every kernel that writes the columns (gpu/pipeline.ts makeCompute: a kernel calling bumpChunk): each calls it for a
// column it changed. Every writer this tick writes the same value: plain stores, no atomics.

/** where the versions start in `chunks` (vec2 units: after the table's one a chunk) */
fn chunkVerBase() -> u32 { return G.chunksX * (G.mapH / G.chunkSize); }

/** column q's chunk changed this tick */
fn bumpChunk(q: vec2<u32>) {
  let cs = G.chunkSize;
  let v = chunks[(q.y / cs) * G.chunksX + q.x / cs].x / (cs * cs);
  chunks[chunkVerBase() + v / 2u][v % 2u] = G.tick + 1u;
}
