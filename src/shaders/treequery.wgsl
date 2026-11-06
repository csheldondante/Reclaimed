// ---- treequery.wgsl -----------------------------------------------------------------------------------------------
// (round 128o, DA-B6; DESIGN.md §24 "world queries are GPU passes") The nearest trees to a point, found where the
// trees are: vegplan.wgsl's vegPlan over every column of the asks' boxes, the answer a short list per ask. Three
// passes over the same threads (each ask's box, laid end to end, like colquery.wgsl):
//
//   hist    a tree within the ask's radius counts in its distance bin (NB bins over the radius)
//   cut     a thread an ask: the first bin by which `n` trees are counted — the trees nearer than it are all in, of
//           the trees in it as many as fit (they're within r / NB of each other)
//   gather  the trees nearer than the cut bin, then those in it up to `n`, into the ask's list
//
// So the read back is n trees an ask at most (2 words each), whatever the woods hold. Prepended: common.wgsl,
// materials.wgsl, vegplan.wgsl.

/** distance bins over an ask's radius */
const NB: u32 = 128u;
/** the most trees an ask's list holds (TS: treequery.ts MAX_N) */
const MAX_N: u32 = 32u;

struct Ask {
  /** its box: first column, width, and its first thread (the threads of the asks before it) */
  x0: u32, y0: u32, w: u32, first: u32,
  /** the point (window world), the radius (world units), how many trees */
  px: f32, py: f32, r: f32, n: u32,
}

struct Params { nAsks: u32, nThreads: u32, _a: u32, _b: u32 }

@group(0) @binding(3) var<storage, read> veg: array<f32>;
@group(0) @binding(4) var<storage, read> asks: array<Ask>;
@group(0) @binding(5) var<storage, read_write> hist: array<atomic<u32>>;
/** per ask: the cut bin, the trees nearer than it, and the two counters gather takes places by */
@group(0) @binding(6) var<storage, read_write> sel: array<atomic<u32>>;
/** per ask, MAX_N trees: column x | y << 16, and species | trunk << 8 | crown << 16 */
@group(0) @binding(7) var<storage, read_write> found: array<vec2<u32>>;
@group(0) @binding(8) var<uniform> P: Params;

/** the thread's ask and column; the ask's bin for the column's tree, or NB: none there, or out of reach */
struct Hit { q: u32, bin: u32, x: u32, y: u32, pl: VegPlan }

fn hitOf(t: u32) -> Hit {
  // (the ask this thread is in: the last whose first thread is at or before it)
  var lo = 0u;
  var hi = P.nAsks;
  while (hi - lo > 1u) {
    let mid = (lo + hi) / 2u;
    if (asks[mid].first <= t) { lo = mid; } else { hi = mid; }
  }
  let a = asks[lo];
  let l = t - a.first;
  let x = a.x0 + l % a.w;
  let y = a.y0 + l / a.w;
  var h = Hit(lo, NB, x, y, VegPlan(false, false, 0.0, 0.0, 0u, false, 0u));
  if (x >= G.mapW || y >= G.mapH) { return h; }
  h.pl = vegPlan(x, y, veg[colIdx(x, y)], 0u);
  if (!h.pl.tree) { return h; }
  let d = distance(cellPos(vec2<i32>(i32(x), i32(y))), vec2<f32>(a.px, a.py));
  if (d > a.r) { return h; }
  h.bin = min(NB - 1u, u32(d / a.r * f32(NB)));
  return h;
}

fn threadOf(gid: vec3<u32>) -> u32 { return gid.x + gid.y * 65535u * 64u; }

@compute @workgroup_size(64)
fn hist_(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = threadOf(gid);
  if (t >= P.nThreads) { return; }
  let h = hitOf(t);
  if (h.bin < NB) { atomicAdd(&hist[h.q * NB + h.bin], 1u); }
}

@compute @workgroup_size(64)
fn cut(@builtin(global_invocation_id) gid: vec3<u32>) {
  let q = gid.x;
  if (q >= P.nAsks) { return; }
  let n = min(asks[q].n, MAX_N);
  var below = 0u;
  var b = 0u;
  for (; b < NB; b++) {
    let c = atomicLoad(&hist[q * NB + b]);
    if (below + c >= n) { break; }
    below += c;
  }
  // (b == NB: fewer than n trees in reach, every one in)
  atomicStore(&sel[q * 4u], b);
  atomicStore(&sel[q * 4u + 1u], below);
}

@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = threadOf(gid);
  if (t >= P.nThreads) { return; }
  let h = hitOf(t);
  if (h.bin >= NB) { return; }
  let cutBin = atomicLoad(&sel[h.q * 4u]);
  var i: u32;
  if (h.bin < cutBin) {
    i = atomicAdd(&sel[h.q * 4u + 2u], 1u);
  } else if (h.bin == cutBin) {
    i = atomicLoad(&sel[h.q * 4u + 1u]) + atomicAdd(&sel[h.q * 4u + 3u], 1u);
    if (i >= min(asks[h.q].n, MAX_N)) { return; }
  } else {
    return;
  }
  found[h.q * MAX_N + i] = vec2<u32>(h.x | (h.y << 16u), h.pl.species | (u32(h.pl.trunk) << 8u) | (u32(h.pl.crown) << 16u));
}
