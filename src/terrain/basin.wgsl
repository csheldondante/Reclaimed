// (round 128r, Track A "Next season") A flood standing in the live window: still water at a level over the cells one
// height flood fill finds (terrain/flood.wgsl via FloodGpu.run), written as held water — the held rivers' and lakes'
// representation (riverFlow: no flow, its depth; riverheld.wgsl holds it, nothing simulates it while it sleeps). The
// user: "We don't need the actual water simulation to flood an area just an actual elevation difference and a single
// flood fill to see what gets submerged." Prepended with common.wgsl, layers.wgsl, materials.wgsl (terrain/basin.ts).
//
//   extract: the window's columns over an m x m grid from `origin` as the fill's heights (the ground's top — the
//            surface's solid plus its drift — plus the water standing on it). Outlets — the grid's edge, the standing
//            sea, a held river's columns, columns with nothing in them — start the fill at their height and wall the
//            mark (1e30): a flood never joins the sea or a river; anything that would is excluded by construction.
//   write:   over the mark, the held depth to level `level` (BP.level): mode 0 raises (the water at least that deep),
//            mode 1 lowers (at most that deep; a level under the ground: dry). The held table's texel is the depth, no
//            flow, no discharge (w 0: the rivers' wetness doesn't move it).
//   query:   per entry (a structure's cell's column) whether the mark covers it or a column beside it: the structures
//            under water (a word per structure, set to 1).

struct BasinP {
  origin: vec2<i32>,
  m: u32,
  mode: u32,
  level: f32,
  entries: u32,
  _p: vec2<u32>,
}
@group(0) @binding(9) var<uniform> BP: BasinP;
@group(0) @binding(3) var<storage, read_write> hOut: array<f32>;
@group(0) @binding(4) var<storage, read_write> hmOut: array<f32>;
@group(0) @binding(5) var<storage, read_write> w0Out: array<f32>;
@group(0) @binding(6) var<storage, read> surfaceB: array<u32>;
@group(0) @binding(7) var<storage, read_write> waterB: array<f32>;
@group(0) @binding(10) var<storage, read> markB: array<f32>;
@group(0) @binding(11) var<storage, read> entriesB: array<vec2<u32>>;
@group(0) @binding(12) var<storage, read_write> flagsB: array<atomic<u32>>;
@group(0) @binding(22) var riverIn: texture_2d<f32>;
@group(0) @binding(23) var riverOut: texture_storage_2d<rgba32float, write>;

const BASIN_WALL: f32 = 1e30;

/** the ground's top at window column p (what the water stands on: water.ts levelAt's) */
fn basinTop(p: vec2<i32>) -> f32 {
  return sfZ(surfaceB[colIdxI(p)]) + textureLoad(driftTex, texCol(p), 0).x;
}

@compute @workgroup_size(8, 8)
fn basinExtract(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= BP.m || id.y >= BP.m) { return; }
  let i = id.y * BP.m + id.x;
  let p = BP.origin + vec2<i32>(id.xy);
  if (!inMap(p)) {
    hOut[i] = -BASIN_WALL;
    hmOut[i] = BASIN_WALL;
    w0Out[i] = -BASIN_WALL;
    return;
  }
  let s = surfaceB[colIdxI(p)];
  let top = basinTop(p);
  let held = textureLoad(riverIn, texCol(p), 0).z;
  let edge = id.x == 0u || id.y == 0u || id.x == BP.m - 1u || id.y == BP.m - 1u;
  let outlet = edge || sfCount(s) == 0u || held > 0.0 || top < G.ocean.x;
  // (what stands on the ground counts: a lake's or the sea's surface, a river's — a flood rises over the water that's
  // there, and a seed in a lake finds the lake's own level, nothing to add)
  let h = top + waterB[colIdxI(p)];
  hOut[i] = h;
  hmOut[i] = select(h, BASIN_WALL, outlet);
  w0Out[i] = select(BASIN_WALL, h, outlet);
}

@compute @workgroup_size(8, 8)
fn basinWrite(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= BP.m || id.y >= BP.m) { return; }
  if (markB[id.y * BP.m + id.x] < 0.5) { return; }
  let p = BP.origin + vec2<i32>(id.xy);
  if (!inMap(p)) { return; }
  let i = colIdxI(p);
  let d = max(BP.level - basinTop(p), 0.0);
  let w = waterB[i];
  let nw = select(min(w, d), max(w, d), BP.mode == 0u);
  waterB[i] = nw;
  bumpWater(vec2<u32>(p), w, nw);
  textureStore(riverOut, texCol(p), vec4<f32>(0.0, 0.0, d, 0.0));
}

fn markAt(g: vec2<i32>) -> bool {
  let m = i32(BP.m);
  if (g.x < 0 || g.y < 0 || g.x >= m || g.y >= m) { return false; }
  return markB[u32(g.y) * BP.m + u32(g.x)] > 0.5;
}

@compute @workgroup_size(64)
fn basinQuery(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= BP.entries) { return; }
  let e = entriesB[id.x];
  let g = vec2<i32>(i32(e.x & 0xffffu), i32(e.x >> 16u)) - BP.origin;
  var wet = false;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (markAt(g + vec2<i32>(dx, dy))) { wet = true; }
    }
  }
  if (wet) { atomicMax(&flagsB[e.y], 1u); }
}
