// ---- the engine's ground tops: is a row clear of the ground? (docs/design/PHYSICS_ENGINE.md "Terrain contacts, the
// cheap way"; prepended to engine_pairs.wgsl) ---------------------------------------------------------------------------
// The owner (2026-11-15): "Why is the ground check slow? Isn't it essentially just index into a height grid and then
// done if you are above it?" It is now: before any of a row's samples is given a thread, `integrate` tests the row's
// bound against the highest ground under its footprint, and a row above it gets no terrain work this substep.
// `gtop` is the height grid for that: derived state, the engine's own, a record a chunk of columns (by the chunk's
// dense storage index, the same the chunks' versions are keyed by, so it moves with the chunk when the window slides):
//   [0] the chunk's column version it was made for, + 1 (0: never made)
//   [1] the highest column top in the chunk (f32 bits)
//   [2..17] the highest top in each 4 x 4 block of its columns, row-major
//   [18..19] spare
// Made from the columns themselves (the intervals, not the surface pass's word: a chunk asleep may skip that pass).
// `tground`, a thread a chunk, every tick anything is awake: a chunk whose version (chunkver.wgsl: the tick + 1 its
// columns last changed) is the one its record was made for, and older than last tick, is left alone — one read; any
// other is made again. Versions are per tick and several kernels may write the columns in one tick, some after this
// one, so a chunk changed this tick or the last is always made again: the record is never older than the columns as
// they were when this kernel ran, which is before any row is tested in the same tick. Staleness can therefore only be
// "the ground changed later in this tick than the engine ran", which the terrain test itself has too.
@group(0) @binding(51) var<storage, read_write> gtop: array<u32>;
// the rows' claims (engine.wgsl CR_*): the support watch checks a claim is its row's live one
@group(0) @binding(74) var<storage, read> claimG: array<u32>;
// the pool's header: P_CLAIM_STIR alone (engine.wgsl)
@group(0) @binding(18) var<storage, read_write> poolG: array<atomic<u32>>;

const GT_WORDS: u32 = 20u;
/** chunkver.wgsl VER_VEC2 (not included here: that file is appended only to kernels that write the columns) */
const GT_VER_VEC2: u32 = 10u;

/** window chunk c's record in `gtop`, and its columns' version (x: the record's first word, y: the version) */
fn gtAt(c: vec2<u32>) -> vec2<u32> {
  let cs = G.chunkSize;
  let t = chunks[c.y * G.chunksX + c.x];
  let dense = t.x / (cs * cs * t.y);
  let ver = chunks[G.chunksX * (G.mapH / cs) + GT_VER_VEC2 * dense].x;
  return vec2<u32>(dense * GT_WORDS, ver);
}

@compute @workgroup_size(64)
fn tground(@builtin(global_invocation_id) id: vec3<u32>) {
  let cs = G.chunkSize;
  let across = G.chunksX;
  if (id.x >= across * (G.mapH / cs)) { return; }
  let c = vec2<u32>(id.x % across, id.x / across);
  let g = gtAt(c);
  if (gtop[g.x] == g.y + 1u && g.y < G.tick) { return; }
  var whole = 0.0;
  // (a row's live claim stands in this chunk, whose columns changed: P_CLAIM_STIR)
  var stir = false;
  for (var b = 0u; b < 16u; b++) {
    var top = 0.0;
    for (var k = 0u; k < 16u; k++) {
      let q = c * cs + vec2<u32>((b % 4u) * 4u + k % 4u, (b / 4u) * 4u + k / 4u);
      let sl = colSlots(q.x, q.y);
      var under = 0.0;
      for (var s = 0u; s < sl.y; s++) {
        let v = layersIn[sl.x + s];
        if (ivEmpty(v)) { break; }
        top = max(top, ivZ1(v));
        // (the support watch, DESIGN §3 "Ground eroded from under it becomes air, which goes to ... physics": a
        // row's claim that stood on something when it was written — OWN_SUP — and has nothing touching its underside
        // now. Its owner is stamped to wake, as a pair stamps a sleeper: `compact` wakes it next tick and its claim
        // goes. Only in chunks whose columns changed: this kernel's own gate.)
        if (ivMat(v) == MAT_EXTERNAL && ownIsRow(v.w)) {
          let row = ownRowOf(v.w);
          if (row < EU.e.x && claimG[CR_AT + row * CR_WORDS + 1u] == ownGenOf(v.w)) {
            stir = true;
            if ((v.w & OWN_SUP) != 0u && ivZ0(v) - under > 1e-3) { atomicStore(&listA[rwAt(row) + RW_WAKE], gTick() + 1u); }
          }
        }
        under = ivZ1(v);
      }
    }
    gtop[g.x + 2u + b] = bitcast<u32>(top);
    whole = max(whole, top);
  }
  // (a row's claim a writer took out of a slot in this chunk — cut by a tool, a blow, the judge; or moved: chunkver.wgsl
  // [1].y: its owner wakes if that claim is still its live one)
  let cut = chunks[across * (G.mapH / cs) + GT_VER_VEC2 * (g.x / GT_WORDS) + 1u].y;
  if (ownIsRow(cut)) {
    let row = ownRowOf(cut);
    if (row < EU.e.x && claimG[CR_AT + row * CR_WORDS + 1u] == ownGenOf(cut)) {
      stir = true;
      atomicStore(&listA[rwAt(row) + RW_WAKE], gTick() + 1u);
    }
  }
  if (stir) { atomicStore(&poolG[P_CLAIM_STIR], G.tick + 1u); }
  gtop[g.x + 1u] = bitcast<u32>(whole);
  gtop[g.x] = g.y + 1u;
}

/**
 * The highest column top any point within `reach` of p (world x, y) can stand over; 1e9 when the footprint is too
 * wide to ask cheaply (the row is then tested as before), -1e9 when it is over no column at all. At most 16 records
 * read: 4 x 4 blocks when they cover it, else whole chunks.
 */
fn groundTopUnder(p: vec2<f32>, reach: f32) -> f32 {
  // (a column's cell lies within a cell and a half of its index in x, a row in y: common.wgsl cellPos)
  var lo = vec2<i32>(i32(floor(p.x - reach - 1.5)), i32(floor((p.y - reach) / ROW_H)) - 1);
  var hi = vec2<i32>(i32(ceil(p.x + reach)), i32(ceil((p.y + reach) / ROW_H)));
  let last = vec2<i32>(i32(G.mapW) - 1, i32(G.mapH) - 1);
  if (hi.x < 0 || hi.y < 0 || lo.x > last.x || lo.y > last.y) { return -1e9; }
  lo = max(lo, vec2<i32>(0));
  hi = min(hi, last);
  var top = -1e9;
  let b0 = lo / 4;
  let b1 = hi / 4;
  let nb = (b1 - b0) + vec2<i32>(1);
  if (nb.x * nb.y <= 16) {
    for (var by = b0.y; by <= b1.y; by++) {
      for (var bx = b0.x; bx <= b1.x; bx++) {
        let g = gtAt(vec2<u32>(u32(bx) / 4u, u32(by) / 4u));
        top = max(top, bitcast<f32>(gtop[g.x + 2u + (u32(by) % 4u) * 4u + u32(bx) % 4u]));
      }
    }
    return top;
  }
  let c0 = lo / 16;
  let c1 = hi / 16;
  let nc = (c1 - c0) + vec2<i32>(1);
  if (nc.x * nc.y > 16) { return 1e9; }
  for (var cy = c0.y; cy <= c1.y; cy++) {
    for (var cx = c0.x; cx <= c1.x; cx++) {
      let g = gtAt(vec2<u32>(u32(cx), u32(cy)));
      top = max(top, bitcast<f32>(gtop[g.x + 1u]));
    }
  }
  return top;
}
