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

/**
 * First slot of the loose ground on top of a column held in `arr` (n valid
 * slots): the run of touching granular intervals at the top. n when the top
 * interval isn't granular. (Needs materials.wgsl.)
 */
fn looseRun(arr: ptr<function, array<vec4<u32>, MAX_K>>, n: u32) -> u32 {
  var r = n;
  while (r > 0u) {
    let v = (*arr)[r - 1u];
    if (matState(ivMat(v)) != ST_GRANULAR) { break; }
    if (r < n && abs(ivZ1(v) - ivZ0((*arr)[r])) > 1e-3) { break; }
    r -= 1u;
  }
  return r;
}
