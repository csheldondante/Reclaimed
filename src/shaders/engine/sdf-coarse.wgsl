// Coarse collision, body ↔ body (src/engine/sdf/coarse.ts; docs/design/PHYSICS_ENGINE.md stage 2): candidate pairs
// from a hash of BODY bounds (never voxels), for the fine pass. sdf-model.wgsl is put in front. The rows are the
// engine's (contract.ts "the engine's rows").
//
// A body is in exactly one cell: the cell of its centre, at the level whose cells are at least its bound sphere's
// diameter plus the margin (level l's cells are cellTop / 2^(levels-1-l) a side). Two bodies whose spheres touch are
// then in the same or neighbouring cells of the bigger one's level. A body too big for the top level is in a short
// list of its own instead, tested against every awake body.
//
// Two tables of the same form, each a counting sort by bucket (a cell's hash), so a bucket's members are one run:
//   awake     rebuilt every tick from the awake rows: a row at its own level
//   sleepers  rebuilt only when the engine's sleep epoch changes: a sleeper at its own level, and once more at every
//             coarser level under a second key ("promoted"), so an awake body finds the sleepers finer than itself in
//             its own level's cells
// Build (the same kernels for both, CP.mode says which): count a bucket, sums a block of 32 and a block of 1,024,
// starts (a bucket's start from those sums: no thread adds more than 94 numbers), fill.
// Then no thread walks a list:
//   stageA  a thread an awake row and a level: for each cell a partner could be in, the bucket's run cut into work
//           items of up to 8 entries (row, which table, level, cell, start, length): runs are short as a rule, and a
//           workgroup of 16 for one or two entries measured slower when all are awake, one of 4 slower for an awake body in a pile of sleepers
//   argsB   the item count as stage B's indirect arguments
//   stageB  a workgroup an item, a thread an entry: is it really of that cell and level (two cells can share a
//           bucket); then the bound spheres, then the models' oriented boxes (grown by the margin); then the pair
// Each pair is written once, with no sort: two awake rows by the one at the finer level (same level: the lower row);
// an awake row and a sleeper by the awake row (the sleeper's own entry when its level is the awake row's or coarser,
// its promoted entry at the awake row's level when it is finer); a pair with an oversize body by the other row, two
// oversize awake rows by the higher.
//
// A table is two parts, so that only the build's counters are atomics (an atomic load is an interlocked operation
// on D3D; the sums and the queries read plain words). The counters (u32, atomics, a buffer a table): counts [0, H),
// fill cursors [H, 2H), the oversize count at 2H and its cursor at 2H + 1. The table proper (u32; both tables are in
// one buffer, the awake one first, the sleepers' from word CP.slBase: stage B has only eight storage bindings): run
// lengths [0, H), run starts [H, 2H), the oversize count at 2H, block sums from 2H + 4, super sums, the runs. The
// oversize bodies are the first run (their own bucket of the counting sort: one entry a row, so they have exactly the
// room they need and no list of their own to run out). An awake entry is its row; a sleeper entry
// row | level << 28 | promoted << 31.
//
// Rooms (docs/design/PHYSICS_ENGINE.md "Round 6"). The runs cannot run out (an awake row has one entry, a sleeper one
// a level at most). The work items and the pairs can: what was asked for is counted whole, so the CPU's rare read
// (collide.ts) can make the room bigger, and until it has, the tick fails safe through `missing`, a word a row
// (contract.ts MISS_*): a row whose candidates or pairs were not all written carries a bit there, and so does every
// row it might have met. The engine holds a flagged row still that tick.
//   items past the room   stage A flags its row and every entry of the run it could not cut into items
//   pairs past the room   stage B flags both rows of the pair it could not write
// The pair buffer: [0] pairs asked for, [1] work items asked for, [2] work items dropped, [8] the most pairs asked
// for in a tick since the CPU last read, [9] the most items; then (a, b) a pair from word 64. The ctl buffer: [0] the
// sleep epoch the sleeper table was built for, then indirect arguments (coarse.ts CTL_*).

struct CoarseParams {
  rows: u32,
  heads: u32,
  levels: u32,
  pairRoom: u32,
  cellTop: f32,
  margin: f32,
  // 0: the awake table, from the awake list; 1: the sleeper table, from every row alive and asleep
  mode: u32,
  itemRoom: u32,
  // entries the table's runs have room for
  runRoom: u32,
  // where the sleeper table starts in the tables' buffer (words)
  slBase: u32,
  pad1: u32,
  pad2: u32,
}

const LIST_AT: u32 = 8u;
const PAIRS_AT: u32 = 64u;
const ITEMS_AT: u32 = 4u;
const ROW_ALIVE: u32 = 1u;
const ROW_ASLEEP: u32 = 2u;
const GROUP: u32 = 8u;
const ARGS_ROW: u32 = 256u;
const NO_ROW: u32 = 0xffffffffu;
// (contract.ts MISS_*)
const MISS_ITEMS: u32 = 1u;
const MISS_PAIRS: u32 = 2u;

@group(0) @binding(0) var<uniform> CP: CoarseParams;
@group(0) @binding(1) var<storage, read> list: array<u32>;
@group(0) @binding(2) var<storage, read> pose: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> info: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> bodyModel: array<u32>;
@group(0) @binding(6) var<storage, read> models: array<SdfModel>;
// (the table being built: its counters, and the same buffer read plain by the sums; then the table proper)
@group(0) @binding(7) var<storage, read_write> tab: array<atomic<u32>>;
@group(0) @binding(15) var<storage, read> cntR: array<u32>;
@group(0) @binding(16) var<storage, read_write> tabB: array<u32>;
@group(0) @binding(8) var<storage, read_write> pairBuf: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> ctl: array<u32>;
@group(0) @binding(10) var<storage, read> sleepEpoch: array<u32>;
// (the two tables, built, in their one buffer: plain reads. An atomic load is an interlocked operation on D3D)
@group(0) @binding(11) var<storage, read> tabs: array<u32>;
// (a word a row: MISS_* bits, cleared by the pass's encode each tick)
@group(0) @binding(17) var<storage, read_write> missing: array<atomic<u32>>;
@group(0) @binding(13) var<storage, read_write> items: array<u32>;
// [0] items asked for, [1] items dropped (reset by the gate)
@group(0) @binding(14) var<storage, read_write> itemCtl: array<atomic<u32>, 4>;

fn oStart() -> u32 { return CP.heads; }
fn oBlk() -> u32 { return 2u * CP.heads + 4u; }
fn oSup() -> u32 { return oBlk() + CP.heads / 32u; }
fn oRuns() -> u32 { return oSup() + CP.heads / 1024u; }
/** word i of the awake table, of the sleeper table */
fn awR(i: u32) -> u32 { return tabs[i]; }
fn slR(i: u32) -> u32 { return tabs[CP.slBase + i]; }

fn cellSize(l: u32) -> f32 {
  return CP.cellTop / f32(1u << (CP.levels - 1u - l));
}

/** the level of a bound sphere: the finest whose cells hold its diameter and the margin; x the level, y 1 if even the top is too small (oversize) */
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
  let rebuild = sleepEpoch[SLEEP_EPOCH_WORD] != ctl[0];
  ctl[0] = sleepEpoch[SLEEP_EPOCH_WORD];
  // last tick's pairs into the high-water mark the CPU reads now and then; this tick's counts start at zero
  atomicMax(&pairBuf[8], atomicLoad(&pairBuf[0]));
  atomicStore(&pairBuf[0], 0u);
  atomicStore(&itemCtl[0], 0u);
  atomicStore(&itemCtl[1], 0u);
  // (for the table kernels when they are dispatched direct: is the sleepers' table built this tick)
  atomicStore(&itemCtl[2], select(0u, 1u, rebuild));
  let blocks = (CP.heads / 32u + 63u) / 64u;
  let supers = (CP.heads / 1024u + 63u) / 64u;
  let buckets = CP.heads / 64u;
  // the sleeper table: only when the epoch changed
  ctl[4] = select(0u, (2u * CP.heads + 2u + 63u) / 64u, rebuild);
  ctl[8] = select(0u, (CP.rows + 63u) / 64u, rebuild);
  ctl[12] = select(0u, blocks, rebuild);
  ctl[16] = select(0u, supers, rebuild);
  ctl[20] = select(0u, buckets, rebuild);
  // the awake table: only when a row is awake
  let some = list[3] != 0u;
  ctl[24] = select(0u, blocks, some);
  ctl[28] = select(0u, supers, some);
  ctl[32] = select(0u, buckets, some);
  for (var k = 4u; k < 36u; k += 4u) {
    ctl[k + 1u] = 1u;
    ctl[k + 2u] = 1u;
  }
  // stage A: a thread an awake row and a level
  ctl[36] = list[0];
  ctl[37] = CP.levels;
  ctl[38] = 1u;
}

@compute @workgroup_size(64)
fn clearTab(@builtin(global_invocation_id) gid: vec3<u32>) {
  // (dispatched direct, by the room: the sleepers' table is built only in a tick the gate asked for it)
  if (CP.mode == 1u && atomicLoad(&itemCtl[2]) == 0u) {
    return;
  }
  if (gid.x < 2u * CP.heads + 2u) {
    atomicStore(&tab[gid.x], 0u);
  }
}

/** the row a build thread stands for, or NO_ROW */
fn sourceRow(i: u32) -> u32 {
  if (CP.mode == 0u) {
    if (i >= list[3]) {
      return NO_ROW;
    }
    return list[LIST_AT + i];
  }
  if (i >= CP.rows || (bitcast<u32>(info[4u * i].w) & (ROW_ALIVE | ROW_ASLEEP)) != (ROW_ALIVE | ROW_ASLEEP)) {
    return NO_ROW;
  }
  return i;
}

@compute @workgroup_size(64)
fn countCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  // (dispatched direct, by the room: the sleepers' table is built only in a tick the gate asked for it)
  if (CP.mode == 1u && atomicLoad(&itemCtl[2]) == 0u) {
    return;
  }
  let r = sourceRow(gid.x);
  if (r == NO_ROW) {
    return;
  }
  let lv = levelOf(radiusOf(r));
  if (lv.y == 1u) {
    atomicAdd(&tab[2u * CP.heads], 1u);
    return;
  }
  let p = centre(r);
  let top = select(lv.x + 1u, CP.levels, CP.mode == 1u);
  for (var l = lv.x; l < top; l++) {
    atomicAdd(&tab[bucket(cellOf(p, l), l, select(0u, 1u, l > lv.x))], 1u);
  }
}

@compute @workgroup_size(64)
fn blockSum(@builtin(global_invocation_id) gid: vec3<u32>) {
  // (dispatched direct, by the room: the sleepers' table is built only in a tick the gate asked for it)
  if (CP.mode == 1u && atomicLoad(&itemCtl[2]) == 0u) {
    return;
  }
  if (gid.x >= CP.heads / 32u) {
    return;
  }
  var s = 0u;
  for (var k = 0u; k < 32u; k++) {
    s += cntR[gid.x * 32u + k];
  }
  tabB[oBlk() + gid.x] = s;
}

@compute @workgroup_size(64)
fn superSum(@builtin(global_invocation_id) gid: vec3<u32>) {
  // (dispatched direct, by the room: the sleepers' table is built only in a tick the gate asked for it)
  if (CP.mode == 1u && atomicLoad(&itemCtl[2]) == 0u) {
    return;
  }
  if (gid.x >= CP.heads / 1024u) {
    return;
  }
  var s = 0u;
  for (var k = 0u; k < 32u; k++) {
    s += tabB[oBlk() + gid.x * 32u + k];
  }
  tabB[oSup() + gid.x] = s;
}

@compute @workgroup_size(64)
fn startCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  // (dispatched direct, by the room: the sleepers' table is built only in a tick the gate asked for it)
  if (CP.mode == 1u && atomicLoad(&itemCtl[2]) == 0u) {
    return;
  }
  let i = gid.x;
  if (i >= CP.heads) {
    return;
  }
  var s = 0u;
  for (var k = 0u; k < i / 1024u; k++) {
    s += tabB[oSup() + k];
  }
  for (var k = (i / 1024u) * 32u; k < i / 32u; k++) {
    s += tabB[oBlk() + k];
  }
  for (var k = (i / 32u) * 32u; k < i; k++) {
    s += cntR[k];
  }
  // (the oversize bodies are the run before every bucket's)
  tabB[oStart() + i] = s + cntR[2u * CP.heads];
  tabB[i] = cntR[i];
  if (i == 0u) {
    tabB[2u * CP.heads] = cntR[2u * CP.heads];
  }
}

@compute @workgroup_size(64)
fn fillCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  // (dispatched direct, by the room: the sleepers' table is built only in a tick the gate asked for it)
  if (CP.mode == 1u && atomicLoad(&itemCtl[2]) == 0u) {
    return;
  }
  let r = sourceRow(gid.x);
  if (r == NO_ROW) {
    return;
  }
  let lv = levelOf(radiusOf(r));
  if (lv.y == 1u) {
    let at = atomicAdd(&tab[2u * CP.heads + 1u], 1u);
    if (at < CP.runRoom) {
      tabB[oRuns() + at] = r;
    }
    return;
  }
  let p = centre(r);
  let top = select(lv.x + 1u, CP.levels, CP.mode == 1u);
  for (var l = lv.x; l < top; l++) {
    let promoted = select(0u, 1u, l > lv.x);
    let b = bucket(cellOf(p, l), l, promoted);
    let at = tabB[oStart() + b] + atomicAdd(&tab[CP.heads + b], 1u);
    if (at < CP.runRoom) {
      tabB[oRuns() + at] = select(r, r | (l << 28u) | (promoted << 31u), CP.mode == 1u);
    }
  }
}

/** work items for `len` entries from `start`: [row | kind << 24 | level << 28] [start] [length] [the cell, as offsets from the row's own cell at that level + 512, 10 bits each] */
fn emit(a: u32, kind: u32, l: u32, off: vec3<i32>, start: u32, len: u32) {
  if (len == 0u) {
    return;
  }
  let n = (len + GROUP - 1u) / GROUP;
  let k0 = atomicAdd(&itemCtl[0], n);
  let o = vec3<u32>(off + vec3<i32>(512));
  for (var j = 0u; j < n; j++) {
    if (k0 + j >= CP.itemRoom) {
      // no room for the rest of the run: nothing is missed unsaid. This row and every entry left are flagged (the
      // entries are not tested, so some flagged rows had no pair to miss: the safe side). A serial loop, in the rare
      // tick before the room has grown.
      atomicAdd(&itemCtl[1], n - j);
      atomicOr(&missing[a], MISS_ITEMS);
      let base = select(CP.slBase, 0u, kind == 0u || kind == 3u) + oRuns();
      for (var e = start + j * GROUP; e < start + len; e++) {
        atomicOr(&missing[tabs[base + e] & 0x0fffffffu], MISS_ITEMS);
      }
      break;
    }
    let w = ITEMS_AT + 4u * (k0 + j);
    items[w] = a | (kind << 24u) | (l << 28u);
    items[w + 1u] = start + j * GROUP;
    items[w + 2u] = min(GROUP, len - j * GROUP);
    items[w + 3u] = o.x | (o.y << 10u) | (o.z << 20u);
  }
}

@compute @workgroup_size(64)
fn stageA(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= list[3]) {
    return;
  }
  let a = list[LIST_AT + gid.x];
  let l = gid.y;
  let ra = radiusOf(a);
  let lv = levelOf(ra);
  let pa = centre(a);
  let home = cellOf(pa, l);
  let big = lv.y == 1u;
  if ((big && l + 1u != CP.levels) || (!big && l < lv.x)) {
    return;
  }
  // once a row: the oversize lists (few bodies, each tested against every awake row)
  if (big || l == lv.x) {
    emit(a, 3u, l, vec3<i32>(0), 0u, awR(2u * CP.heads));
    emit(a, 4u, l, vec3<i32>(0), 0u, slR(2u * CP.heads));
  }
  // the cells a body of this level could reach this row from: its centre within this row's radius plus the level's
  // largest radius (half a cell); for the finer sleepers kept at this level, a quarter cell
  let own = vec3<f32>(ra + 0.5 * cellSize(l));
  let lo = cellOf(pa - own, l);
  let hi = cellOf(pa + own, l);
  let fin = vec3<f32>(ra + 0.25 * cellSize(l));
  let flo = cellOf(pa - fin, l);
  let fhi = cellOf(pa + fin, l);
  // (a row of a level is within one cell of its partners: 27 cells at most; an oversize row covers what it covers)
  for (var z = lo.z; z <= hi.z; z++) {
    for (var y = lo.y; y <= hi.y; y++) {
      for (var x = lo.x; x <= hi.x; x++) {
        let c = vec3<i32>(x, y, z);
        let b0 = bucket(c, l, 0u);
        if (!big) {
          emit(a, 0u, l, c - home, awR(oStart() + b0), awR(b0));
        }
        emit(a, 1u, l, c - home, slR(oStart() + b0), slR(b0));
        if ((big || l == lv.x) && all(c >= flo) && all(c <= fhi)) {
          let b1 = bucket(c, l, 1u);
          emit(a, 2u, l, c - home, slR(oStart() + b1), slR(b1));
        }
      }
    }
  }
}

@compute @workgroup_size(1)
fn argsB() {
  let n = min(atomicLoad(&itemCtl[0]), CP.itemRoom);
  ctl[40] = min(n, ARGS_ROW);
  ctl[41] = (n + ARGS_ROW - 1u) / ARGS_ROW;
  ctl[42] = 1u;
  items[0] = n;
  let asked = atomicLoad(&itemCtl[0]);
  atomicStore(&pairBuf[1], asked);
  atomicStore(&pairBuf[2], atomicLoad(&itemCtl[1]));
  atomicMax(&pairBuf[9], asked);
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

@compute @workgroup_size(8)
fn stageB(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let ci = wg.y * ARGS_ROW + wg.x;
  if (ci >= items[0]) {
    return;
  }
  let w = ITEMS_AT + 4u * ci;
  if (li >= items[w + 2u]) {
    return;
  }
  let head = items[w];
  let a = head & 0xffffffu;
  let kind = (head >> 24u) & 15u;
  let l = head >> 28u;
  let at = items[w + 1u] + li;
  let ra = radiusOf(a);
  let pa = centre(a);
  let lva = levelOf(ra);
  var b: u32;
  if (kind >= 3u) {
    // an oversize body: no cell to check. Two oversize awake rows: the higher writes the pair
    if (kind == 3u) {
      b = awR(oRuns() + at);
      if (b == a || (lva.y == 1u && b > a)) {
        return;
      }
    } else {
      b = slR(oRuns() + at) & 0x0fffffffu;
    }
  } else {
    let pk = items[w + 3u];
    let c = cellOf(pa, l) + vec3<i32>(i32(pk & 1023u), i32((pk >> 10u) & 1023u), i32((pk >> 20u) & 1023u)) - vec3<i32>(512);
    if (kind == 0u) {
      b = awR(oRuns() + at);
      // (the finer row writes an awake pair; at the same level the lower row)
      if (b == a || (l == lva.x && b < a)) {
        return;
      }
      if (levelOf(radiusOf(b)).x != l) {
        return;
      }
    } else {
      let e = slR(oRuns() + at);
      b = e & 0x0fffffffu;
      if (((e >> 28u) & 7u) != l || (e >> 31u) != kind - 1u) {
        return;
      }
    }
    if (any(cellOf(centre(b), l) != c)) {
      return;
    }
  }
  let reach = ra + radiusOf(b) + CP.margin;
  let d = pa - centre(b);
  if (dot(d, d) > reach * reach) {
    return;
  }
  // (a row with no model in the store yet — the engine writes NO_MODEL — is in no pair: it has no field to test)
  if (bodyModel[a] == 0xffffffffu || bodyModel[b] == 0xffffffffu) {
    return;
  }
  if (!boxesMeet(boxOf(a), boxOf(b))) {
    return;
  }
  let k = atomicAdd(&pairBuf[0], 1u);
  if (k < CP.pairRoom) {
    atomicStore(&pairBuf[PAIRS_AT + 2u * k], a);
    atomicStore(&pairBuf[PAIRS_AT + 1u + 2u * k], b);
  } else {
    // (no room for the pair: both rows say so)
    atomicOr(&missing[a], MISS_PAIRS);
    atomicOr(&missing[b], MISS_PAIRS);
  }
}
