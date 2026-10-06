// ---- layers.wgsl -------------------------------------------------------
// Chunked column-slot addressing (see src/world/layout.ts).
@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;

const MAX_K: u32 = 16u;

/** Returns (first slot index, slot count K) for column (x, y). */
fn colSlots(x: u32, y: u32) -> vec2<u32> {
  let cs = G.chunkSize;
  let ch = chunks[(y / cs) * G.chunksX + (x / cs)];
  return vec2<u32>(ch.x + ((y % cs) * cs + (x % cs)) * ch.y, ch.y);
}
