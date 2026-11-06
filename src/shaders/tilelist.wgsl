// ---- tilelist.wgsl ------------------------------------------------------------------------------------------------
// (round 128o, DA-B26) A pass's tile lists made on the GPU from the chunks' versions (sim/cull.ts ChangedTiles): over a
// CPU list (the scope: TILES, its entries packed as sim/cull.ts packEntry), `changed` lists the chunks whose columns or
// water moved since this reader last looked (chunkver.wgsl), `around` the scope's chunks next to one of those (the
// 3 x 3 round each). Each list as the CPU's are (a u32 an entry, four 8 x 8 workgroups a chunk) and its indirect args
// (x: the workgroups); sim/cull.ts copies the list into the uniform the culled kernel reads (cullSource).
// Prepended: common.wgsl, materials.wgsl, `const VEC4S: u32` (the list's length in vec4s).

/** a chunk this reader never looked at (every reader starts there) */
const NEVER: u32 = 0xffffffffu;
const WG_PER_CHUNK: u32 = 4u;

struct TileListParams {
  /** entries in TILES */
  count: u32,
  /** 1: every chunk of TILES counts as changed (the reader's state is gone — agents.ts navStale) */
  force: u32,
  _a: u32,
  _b: u32,
}

@group(0) @binding(1) var<storage, read> chunks: array<vec2<u32>>;
@group(0) @binding(39) var<uniform> TILES: array<vec4<u32>, VEC4S>;
/** per chunk of storage (as the versions): the tick this reader last looked at it (NEVER: not yet) */
@group(0) @binding(3) var<storage, read_write> seen: array<u32>;
/** per window chunk: the tick + 1 it was listed changed (`around` reads its neighbours') */
@group(0) @binding(4) var<storage, read_write> listedAt: array<u32>;
@group(0) @binding(5) var<storage, read_write> changedList: array<u32>;
@group(0) @binding(6) var<storage, read_write> changedArgs: array<atomic<u32>, 3>;
@group(0) @binding(7) var<storage, read_write> aroundList: array<u32>;
@group(0) @binding(8) var<storage, read_write> aroundArgs: array<atomic<u32>, 3>;
@group(0) @binding(9) var<uniform> TP: TileListParams;

fn tileEntry(t: u32) -> u32 { return TILES[t >> 2u][t & 3u]; }
fn entryChunk(e: u32) -> vec2<u32> { return vec2<u32>(e & 63u, (e >> 6u) & 63u); }

@compute @workgroup_size(64)
fn changed(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= TP.count) { return; }
  let e = tileEntry(id.x);
  let c = entryChunk(e);
  let ci = c.y * G.chunksX + c.x;
  let cs = G.chunkSize;
  // (chunkver.wgsl's place: keyed by where the chunk's columns lie)
  let v = chunks[ci].x / (cs * cs);
  let ver = chunks[G.chunksX * (G.mapH / cs) + v];
  let s = seen[v];
  if (TP.force == 0u && s != NEVER && max(ver.x, ver.y) <= s) { return; }
  // (a write later this tick stamps tick + 1: past what's kept here, so it's listed next tick)
  seen[v] = G.tick;
  listedAt[ci] = G.tick + 1u;
  let k = atomicAdd(&changedArgs[0], WG_PER_CHUNK) / WG_PER_CHUNK;
  changedList[k] = e;
}

@compute @workgroup_size(64)
fn around(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= TP.count) { return; }
  let e = tileEntry(id.x);
  let c = entryChunk(e);
  let cy = G.mapH / G.chunkSize;
  for (var b = max(c.y, 1u) - 1u; b <= min(c.y + 1u, cy - 1u); b++) {
    for (var a = max(c.x, 1u) - 1u; a <= min(c.x + 1u, G.chunksX - 1u); a++) {
      if (listedAt[b * G.chunksX + a] == G.tick + 1u) {
        let k = atomicAdd(&aroundArgs[0], WG_PER_CHUNK) / WG_PER_CHUNK;
        aroundList[k] = e;
        return;
      }
    }
  }
}
