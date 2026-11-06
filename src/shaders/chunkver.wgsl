// ---- chunkver.wgsl ------------------------------------------------------------------------------------------------
// (round 128o, DA-B9, DA-B26, DA-B28) The chunks' versions, after the chunk table in the same buffer
// (sim/chunkver.ts): per chunk ten vec2s (VER_VEC2), the tick + 1 that last changed
//   [0].x its columns (any bit of a slot),
//   [0].y what its surfaces read beside the columns: its water's class (waterclass.wgsl: crossed a walker's band) or
//         its places,
//   [1].x its water's depth at all,
//   [1].y unused,
//   [2..9] its shape as the field mesh sees it, a word per 4 x 4 columns (SHAPE_BLOCK; shapekey.wgsl: a slot's ends to
//         1/16, its material) or the structures over them, so a mesh chunk's key covers what it reads, not a whole
//         16-column chunk past its margin;
// 0: never. Keyed by where the chunk's columns lie (its first slot / its page's slots, dense: they move with it when
// the window slides, the table rotating over them). Appended, with the chunk table made writable, to every kernel that
// writes the columns or the water (gpu/pipeline.ts makeCompute: a kernel calling bumpColumn or bumpWater). Every
// writer this tick writes the same value: plain stores, no atomics.

/** vec2s of versions a chunk (sim/chunkver.ts VERSION_WORDS / 2) */
const VER_VEC2: u32 = 10u;
/** columns a side of a shape word's block */
const SHAPE_BLOCK: u32 = 4u;

/** where the versions start in `chunks` (vec2 units: after the table's one a chunk) */
fn chunkVerBase() -> u32 { return G.chunksX * (G.mapH / G.chunkSize); }

/** column q's chunk's versions' place in `chunks` (its first vec2) */
fn chunkVerAt(q: vec2<u32>) -> u32 {
  let cs = G.chunkSize;
  let t = chunks[(q.y / cs) * G.chunksX + q.x / cs];
  return chunkVerBase() + VER_VEC2 * (t.x / (cs * cs * t.y));
}

/** a slot of column q went from `old` to `nv` this tick (called for each slot a writer changes, or may have): its
 *  columns' version if it changed, its 4 x 4 block's shape version if the mesh would see it */
fn bumpColumn(q: vec2<u32>, old: vec4<u32>, nv: vec4<u32>) {
  if (all(old == nv)) { return; }
  let at = chunkVerAt(q);
  chunks[at].x = G.tick + 1u;
  if (shapeMoved(old, nv)) {
    let cs = G.chunkSize;
    let b = ((q.y % cs) / SHAPE_BLOCK) * (cs / SHAPE_BLOCK) + (q.x % cs) / SHAPE_BLOCK;
    chunks[at + 2u + b / 2u][b % 2u] = G.tick + 1u;
  }
}

/** column q's water went from `before` to `after` this tick: its depth's version if it moved, its class's if it
 *  crossed a band */
fn bumpWater(q: vec2<u32>, before: f32, after: f32) {
  if (before == after) { return; }
  let at = chunkVerAt(q);
  chunks[at + 1u].x = G.tick + 1u;
  if (waterClassCrossed(before, after)) { chunks[at].y = G.tick + 1u; }
}
