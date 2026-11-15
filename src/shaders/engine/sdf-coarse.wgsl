// Coarse collision, body ↔ body (src/engine/sdf/coarse.ts; docs/design/PHYSICS_ENGINE.md stage 2): candidate pairs
// from a hash of BODY bounds (never voxels), for the fine pass. sdf-model.wgsl is put in front. The rows are the
// engine's (contract.ts "the engine's rows").
//
// A body is in exactly one cell: the cell of its centre, at the level whose cells are at least its bound sphere's
// diameter plus the margin (level l's cells are cellTop / 2^(levels-1-l) a side). Two bodies whose spheres touch are
// then in the same or neighbouring cells of the bigger one's level, so a query is 27 cells a level and a big body's
// bucket never fills with the small ones round it.
//   awake hash    rebuilt every tick: an awake row at its own level
//   sleeper hash  rebuilt only when the engine's sleep epoch changes: a sleeper at its own level, and once more at
//                 every coarser level under a second key ("promoted"), so an awake body finds the sleepers smaller
//                 than itself in its own level's 27 cells
//   pairs         a thread an awake row and a level. An awake pair is written by the row at the finer level looking
//                 up (same level: by the lower row); an awake row and a sleeper by the awake row: the sleeper's own
//                 level's list when that is the awake row's level or coarser, the promoted list at the awake row's
//                 level when the sleeper is finer. An entry counts only when the body's own cell is the cell asked
//                 for (two cells can share a bucket), so every pair is written exactly once with no sort.
// A candidate is a pair only if the bound spheres and then the models' oriented boxes (grown by the margin) overlap.
//
// The hash buffer (u32, atomics): awake heads [0, H), awake next [H, H + R), sleeper heads [H + R, 2H + R), sleeper
// next [2H + R, 2H + R + R * levels) (node = row * levels + level), then one word: sleepers too big for the top level.
// A head or next holds node + 1, 0 the end. The pair buffer: [0] pairs asked for, [1] awake rows too big for the top
// level, then (a, b) a pair from word 64 (PAIRS_AT). The state buffer: [0] the sleep epoch the sleeper hash was built
// for, then indirect arguments at words 4 (clear the sleeper heads), 8 (insert the sleepers), 12 (pairs).

struct CoarseParams {
  rows: u32,
  heads: u32,
  levels: u32,
  pairRoom: u32,
  cellTop: f32,
  margin: f32,
  pad0: u32,
  pad1: u32,
}

const LIST_AT: u32 = 8u;
// (the pairs start a storage binding of their own for the fine pass: at the 256 B alignment such a binding needs)
const PAIRS_AT: u32 = 64u;
const ROW_ALIVE: u32 = 1u;
const ROW_ASLEEP: u32 = 2u;

@group(0) @binding(0) var<uniform> CP: CoarseParams;
@group(0) @binding(1) var<storage, read> list: array<u32>;
@group(0) @binding(2) var<storage, read> pose: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> info: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> bodyModel: array<u32>;
@group(0) @binding(6) var<storage, read> models: array<SdfModel>;
@group(0) @binding(7) var<storage, read_write> table: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> pairBuf: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> state: array<u32>;
@group(0) @binding(10) var<storage, read> sleepEpoch: array<u32>;
// (the table again, for the pairs kernel: plain reads. An atomic load is an interlocked operation on D3D, and the
// pairs pass reads some 60 heads a thread)
@group(0) @binding(11) var<storage, read> tableR: array<u32>;

fn cellSize(l: u32) -> f32 {
  return CP.cellTop / f32(1u << (CP.levels - 1u - l));
}

/** the level of a bound sphere: the finest whose cells hold its diameter and the margin; x the level, y 1 if even the top is too small */
fn levelOf(radius: f32) -> vec2<u32> {
  let d = 2.0 * radius + CP.margin;
  var l = 0u;
  while (l + 1u < CP.levels && cellSize(l) < d) {
    l++;
  }
  return vec2<u32>(l, select(0u, 1u, cellSize(l) < d));
}

fn cellOf(pos: vec3<f32>, l: u32) -> vec3<i32> {
  return vec3<i32>(floor(pos / cellSize(l)));
}

fn bucket(c: vec3<i32>, l: u32, promoted: u32) -> u32 {
  let u = vec3<u32>(c);
  return ((u.x * 73856093u) ^ (u.y * 19349663u) ^ (u.z * 83492791u) ^ (l * 0x9e3779b9u) ^ (promoted * 0x85ebca6bu)) & (CP.heads - 1u);
}

fn centre(r: u32) -> vec3<f32> {
  return pose[4u * r + 2u].xyz;
}

fn radiusOf(r: u32) -> f32 {
  return vel[2u * r + 1u].w;
}

@compute @workgroup_size(1)
fn gate() {
  let rebuild = sleepEpoch[0] != state[0];
  state[0] = sleepEpoch[0];
  state[4] = select(0u, (CP.heads + 63u) / 64u, rebuild);
  state[5] = 1u;
  state[6] = 1u;
  state[8] = select(0u, (CP.rows + 63u) / 64u, rebuild);
  state[9] = 1u;
  state[10] = 1u;
  // (a thread an awake row and a level)
  state[12] = list[0];
  state[13] = CP.levels;
  state[14] = 1u;
}

@compute @workgroup_size(64)
fn clearSleep(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x < CP.heads) {
    atomicStore(&table[CP.heads + CP.rows + gid.x], 0u);
  }
  if (gid.x == 0u) {
    atomicStore(&table[2u * CP.heads + CP.rows + CP.rows * CP.levels], 0u);
  }
}

@compute @workgroup_size(64)
fn insertSleep(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= CP.rows) {
    return;
  }
  if ((bitcast<u32>(info[3u * r].w) & (ROW_ALIVE | ROW_ASLEEP)) != (ROW_ALIVE | ROW_ASLEEP)) {
    return;
  }
  let lv = levelOf(radiusOf(r));
  if (lv.y == 1u) {
    atomicAdd(&table[2u * CP.heads + CP.rows + CP.rows * CP.levels], 1u);
  }
  let p = centre(r);
  let heads = CP.heads + CP.rows;
  let next = 2u * CP.heads + CP.rows;
  for (var l = lv.x; l < CP.levels; l++) {
    let node = r * CP.levels + l;
    let h = heads + bucket(cellOf(p, l), l, select(0u, 1u, l > lv.x));
    atomicStore(&table[next + node], atomicExchange(&table[h], node + 1u));
  }
}

@compute @workgroup_size(64)
fn insertAwake(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= list[3]) {
    return;
  }
  let r = list[LIST_AT + gid.x];
  let lv = levelOf(radiusOf(r));
  if (lv.y == 1u) {
    atomicAdd(&pairBuf[1], 1u);
  }
  let h = bucket(cellOf(centre(r), lv.x), lv.x, 0u);
  atomicStore(&table[CP.heads + r], atomicExchange(&table[h], r + 1u));
}

fn quatMat(q: vec4<f32>) -> mat3x3<f32> {
  let x = q.x; let y = q.y; let z = q.z; let w = q.w;
  return mat3x3<f32>(
    vec3<f32>(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w)),
    vec3<f32>(2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w)),
    vec3<f32>(2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y)),
  );
}

struct Box {
  c: vec3<f32>,
  half: vec3<f32>,
  axes: mat3x3<f32>,
}

/** a row's oriented box: its model's voxels (the padding left out), grown by half the margin */
fn boxOf(r: u32) -> Box {
  let m = models[bodyModel[r]];
  let d = vec3<f32>(sdfDims(m.dims));
  let axes = quatMat(pose[4u * r + 3u]);
  return Box(centre(r) + axes * ((d * 0.5 - m.com) * m.voxel), (d - vec3<f32>(2.0)) * 0.5 * m.voxel + vec3<f32>(0.5 * CP.margin), axes);
}

/** do two oriented boxes overlap? (the 15 separating axes) */
fn boxesMeet(a: Box, b: Box) -> bool {
  // b's axes in a's frame, and the way from a to b there
  let r = transpose(a.axes) * b.axes;
  let t = (b.c - a.c) * a.axes;
  var ar: mat3x3<f32>;
  for (var i = 0u; i < 3u; i++) {
    ar[i] = abs(r[i]) + vec3<f32>(1e-5);
  }
  // (r[j][i]: a's axis i . b's axis j)
  for (var i = 0u; i < 3u; i++) {
    if (abs(t[i]) > a.half[i] + b.half.x * ar[0][i] + b.half.y * ar[1][i] + b.half.z * ar[2][i]) {
      return false;
    }
  }
  for (var j = 0u; j < 3u; j++) {
    if (abs(dot(t, r[j])) > b.half[j] + dot(a.half, ar[j])) {
      return false;
    }
  }
  for (var i = 0u; i < 3u; i++) {
    let i1 = (i + 1u) % 3u;
    let i2 = (i + 2u) % 3u;
    for (var j = 0u; j < 3u; j++) {
      let j1 = (j + 1u) % 3u;
      let j2 = (j + 2u) % 3u;
      let ra = a.half[i1] * ar[j][i2] + a.half[i2] * ar[j][i1];
      let rb = b.half[j1] * ar[j2][i] + b.half[j2] * ar[j1][i];
      if (abs(t[i2] * r[j][i1] - t[i1] * r[j][i2]) > ra + rb) {
        return false;
      }
    }
  }
  return true;
}

/** rows a and b as a pair, if their spheres and then their boxes overlap */
fn offer(a: u32, pa: vec3<f32>, ra: f32, b: u32) {
  let reach = ra + radiusOf(b) + CP.margin;
  let d = pa - centre(b);
  if (dot(d, d) > reach * reach) {
    return;
  }
  if (!boxesMeet(boxOf(a), boxOf(b))) {
    return;
  }
  let k = atomicAdd(&pairBuf[0], 1u);
  if (k < CP.pairRoom) {
    atomicStore(&pairBuf[PAIRS_AT + 2u * k], a);
    atomicStore(&pairBuf[PAIRS_AT + 1u + 2u * k], b);
  }
}

@compute @workgroup_size(64)
fn pairs(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= list[3]) {
    return;
  }
  let a = list[LIST_AT + gid.x];
  let l = gid.y;
  let ra = radiusOf(a);
  let la = levelOf(ra).x;
  if (l < la) {
    return;
  }
  let pa = centre(a);
  let home = cellOf(pa, l);
  let sHeads = CP.heads + CP.rows;
  let sNext = 2u * CP.heads + CP.rows;
  // of the 27 cells, only those a body of this level could reach this row from: its centre within this row's radius
  // plus the level's largest radius (half a cell); for the finer sleepers kept at this level, a quarter cell
  let own = vec3<f32>(ra + 0.5 * cellSize(l));
  let lo = cellOf(pa - own, l);
  let hi = cellOf(pa + own, l);
  let fin = vec3<f32>(ra + 0.25 * cellSize(l));
  let flo = cellOf(pa - fin, l);
  let fhi = cellOf(pa + fin, l);
  for (var k = 0u; k < 27u; k++) {
    let c = home + vec3<i32>(i32(k % 3u), i32((k / 3u) % 3u), i32(k / 9u)) - vec3<i32>(1);
    if (any(c < lo) || any(c > hi)) {
      continue;
    }
    // awake rows of this level: the finer row writes the pair; at the same level the lower row
    var n = tableR[bucket(c, l, 0u)];
    while (n != 0u) {
      let b = n - 1u;
      n = tableR[CP.heads + b];
      if (b == a || (l == la && b < a)) {
        continue;
      }
      if (levelOf(radiusOf(b)).x == l && all(cellOf(centre(b), l) == c)) {
        offer(a, pa, ra, b);
      }
    }
    // sleepers of this level
    n = tableR[sHeads + bucket(c, l, 0u)];
    while (n != 0u) {
      let node = n - 1u;
      n = tableR[sNext + node];
      let b = node / CP.levels;
      if (node % CP.levels == l && levelOf(radiusOf(b)).x == l && all(cellOf(centre(b), l) == c)) {
        offer(a, pa, ra, b);
      }
    }
    // sleepers finer than this row, at this row's own level
    if (l == la && all(c >= flo) && all(c <= fhi)) {
      n = tableR[sHeads + bucket(c, l, 1u)];
      while (n != 0u) {
        let node = n - 1u;
        n = tableR[sNext + node];
        let b = node / CP.levels;
        if (node % CP.levels == l && levelOf(radiusOf(b)).x < l && all(cellOf(centre(b), l) == c)) {
          offer(a, pa, ra, b);
        }
      }
    }
  }
}
