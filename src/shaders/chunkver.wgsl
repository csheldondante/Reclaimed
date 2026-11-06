// ---- chunkver.wgsl ------------------------------------------------------------------------------------------------
// (round 128o, DA-B9) The chunks' versions, after the chunk table in the same buffer (sim/chunkver.ts): per chunk a
// vec2, x the tick + 1 that last changed its columns, y the tick + 1 that last changed its water or its places (DA-B26:
// what the agents' surfaces read beside the columns); 0: never. Keyed by where the chunk's columns lie (its first
// slot / 256: they move with it when the window slides, the table rotating over them). Appended, with the chunk table
// made writable, to every kernel that writes the columns or the water (gpu/pipeline.ts makeCompute: a kernel calling
// bumpChunk or bumpWater): each calls it for a column it changed. Every writer this tick writes the same value: plain
// stores, no atomics.

/** where the versions start in `chunks` (vec2 units: after the table's one a chunk) */
fn chunkVerBase() -> u32 { return G.chunksX * (G.mapH / G.chunkSize); }

/** column q's chunk's versions' place in `chunks` */
fn chunkVerAt(q: vec2<u32>) -> u32 {
  let cs = G.chunkSize;
  return chunkVerBase() + chunks[(q.y / cs) * G.chunksX + q.x / cs].x / (cs * cs);
}

/** column q's columns changed this tick */
fn bumpChunk(q: vec2<u32>) { chunks[chunkVerAt(q)].x = G.tick + 1u; }

/** column q's water changed this tick */
fn bumpWater(q: vec2<u32>) { chunks[chunkVerAt(q)].y = G.tick + 1u; }
