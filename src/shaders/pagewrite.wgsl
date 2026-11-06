// ---- pagewrite.wgsl -----------------------------------------------------------------------------------------------
// (round 128o, DA-B28) Chunk pages into the window's layers, slot by slot, compared before written (sim/pagewrite.ts):
// a region come in (streamer/write.ts writeNow, the pool's copies and the CPU's) moves a chunk's columns' version, and
// its 4 x 4 blocks' shape versions, only where what it brings differs from what the storage holds (chunkver.wgsl
// bumpColumn). A slide moves the land with its storage (the table rotates), so land that only moved isn't written at
// all; land written again as it was moves nothing. Prepended: common.wgsl, layers.wgsl, materials.wgsl.

/** pages in one call, at most */
const PW_MAX: u32 = 64u;
struct PageJobs {
  /** pages this call */
  n: u32,
  _a: u32,
  _b: u32,
  _c: u32,
  /** per page: x its first slot's vec4 in `src`, y its window chunk */
  jobs: array<vec4<u32>, PW_MAX>,
}

@group(0) @binding(3) var<storage, read_write> layers: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> src: array<vec4<u32>>;
@group(0) @binding(5) var<uniform> PW: PageJobs;

/** a workgroup a quarter of a page (64 of its 256 columns): x the quarter, y the page */
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (wid.y >= PW.n) { return; }
  let job = PW.jobs[wid.y];
  let ci = job.y;
  let cs = G.chunkSize;
  let col = wid.x * 64u + li;
  if (col >= cs * cs) { return; }
  let t = chunks[ci];
  let q = vec2<u32>((ci % G.chunksX) * cs + col % cs, (ci / G.chunksX) * cs + col / cs);
  for (var s = 0u; s < t.y; s++) {
    let at = t.x + col * t.y + s;
    let old = layers[at];
    let nv = src[job.x + col * t.y + s];
    if (any(old != nv)) {
      layers[at] = nv;
      bumpColumn(q, old, nv);
    }
  }
}
