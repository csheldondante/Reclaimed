// ---- pages.wgsl: the paged field atlas (U2 round 7, UNIT_MINDS_U2.md §9b) — the riskiest part first, standalone ------
// A field is pages: one page a field over one chunk (16 x 16 columns x NAV_K surfaces = PAGE_W distances), handed out
// from one pool as the field grows into a chunk (the GPU's claim: a counter), found through the field's page table
// (chunk slot → page). No fixed count of fields: a field is a row of the page table, the table's rows set from memory as
// the pool is. Appended after common, layers, materials, waterclass and agents.wgsl (nav, navCost, the costs, the links);
// its own bindings 60-62. agents/pages.ts drives it.
//   pgSeed    the seeds (field, surface): their chunks marked; a page asked for where the field has none
//   pgAlloc   a thread a (field, chunk) asked for: a page from the pool (none left: counted, the field doesn't grow
//             there), its distances FAR, the chunk marked
//   pgFront   a thread a (field, chunk): it, or a chunk next to it, marked last sweep, and it or that one has a page →
//             listed (the front), the relax's workgroups counted (indirect)
//   pgClear   the marks read: cleared
//   pgRelax   a workgroup a front entry: the chunk's tile and a one-column halo (through the neighbours' pages; no page:
//             FAR) relaxed PG_K times in workgroup memory (block Gauss-Seidel, as relaxBlock), written back where it
//             moved, the chunk marked; a chunk with no page whose values came out finite asks for one
// ctl words: 0 pages handed out (the pool's end), 1 pages refused (the pool full), 2 the front's count, 3 the dirty
// parity, 8 the free stack's count; from CTL_TABLE the page tables (a row a field of a word a chunk slot: page + 1, 0 none); then
// the dirty bits twice (a bit a (field, chunk slot)), the requests (the same), the front list (field << 20 | the chunk's
// y << 10 | x), the free stack (pages let go)

struct PageParams {
  /** x fields in use (rows), y the window's chunk slots, z the pool's pages, w spare (the dirty parity is ctl[3]: the
   *  GPU flips it, so many sweeps go in one submit) */
  n: vec4<u32>,
  /** x the seeds, y the relax's inner passes, z the fields' reach (f32 bits; 0: none — the planes' cap), w spare */
  m: vec4<u32>,
};
@group(0) @binding(60) var<storage, read_write> pool: array<f32>;
@group(0) @binding(61) var<storage, read_write> ctl: array<atomic<u32>>;
@group(0) @binding(62) var<uniform> PP: PageParams;
@group(0) @binding(63) var<storage, read> pgSeeds: array<vec2<u32>>;
/** the relax's indirect args (x, y, z): their own buffer — an indirect buffer can't also be written in the dispatch */
@group(0) @binding(64) var<storage, read_write> pgArgs: array<atomic<u32>, 4>;

const PAGE_COLS: u32 = 256u;
const PAGE_W: u32 = PAGE_COLS * NAV_K;
const CTL_TABLE: u32 = 16u;
const PG_NONE: u32 = 0u;

fn pgTableAt(f: u32, slot: u32) -> u32 { return CTL_TABLE + f * PP.n.y + slot; }
fn pgBits() -> u32 { return (PP.n.x * PP.n.y + 31u) / 32u; }
fn pgDirtyAt(par: u32) -> u32 { return CTL_TABLE + PP.n.x * PP.n.y + par * pgBits(); }
fn pgReqAt() -> u32 { return CTL_TABLE + PP.n.x * PP.n.y + 2u * pgBits(); }
fn pgFrontAt() -> u32 { return pgReqAt() + pgBits(); }
/** the free stack: pages let go (ctl[8] its count) */
fn pgFreeAt() -> u32 { return pgFrontAt() + PP.n.x * PP.n.y; }
fn pgMark(base: u32, f: u32, slot: u32) {
  let b = f * PP.n.y + slot;
  atomicOr(&ctl[base + b / 32u], 1u << (b % 32u));
}
fn pgMarked(base: u32, f: u32, slot: u32) -> bool {
  let b = f * PP.n.y + slot;
  return ((atomicLoad(&ctl[base + b / 32u]) >> (b % 32u)) & 1u) != 0u;
}
/** field f's page over chunk slot `slot` + 1, or PG_NONE */
fn pgPage(f: u32, slot: u32) -> u32 { return atomicLoad(&ctl[pgTableAt(f, slot)]); }
/** field f at surface s (FAR: no page there, or no way) — fieldseam's fieldDist on pages */
fn pgDist(f: u32, s: u32) -> f32 {
  let pg = pgPage(f, s / PAGE_W);
  if (pg == PG_NONE) { return FAR; }
  return pool[(pg - 1u) * PAGE_W + s % PAGE_W];
}
/** the window's chunk (x, y) of a chunk slot is the caller's: front entries carry the slot, the relax its chunk */
fn pgSlot(cxy: vec2<u32>) -> u32 { return pageIdx(cxy); }
fn pgPar() -> u32 { return atomicLoad(&ctl[3]) & 1u; }

@compute @workgroup_size(64)
fn pgSeed(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= PP.m.x) { return; }
  let sd = pgSeeds[id.x];
  let f = sd.x;
  let slot = sd.y / PAGE_W;
  pgMark(pgDirtyAt(pgPar()), f, slot);
  if (pgPage(f, slot) == PG_NONE) { pgMark(pgReqAt(), f, slot); }
}

@compute @workgroup_size(64)
fn pgAlloc(@builtin(global_invocation_id) id: vec3<u32>) {
  let b = id.x;
  if (b >= PP.n.x * PP.n.y) { return; }
  let w = pgReqAt() + b / 32u;
  if (((atomicLoad(&ctl[w]) >> (b % 32u)) & 1u) == 0u) { return; }
  atomicAnd(&ctl[w], ~(1u << (b % 32u)));
  let f = b / PP.n.y;
  let slot = b % PP.n.y;
  if (pgPage(f, slot) != PG_NONE) { return; }
  // (a page let go first — the free stack — else a new one off the pool's end)
  var pg = 0xffffffffu;
  let fk = atomicSub(&ctl[8], 1u);
  if (fk > 0u && fk <= PP.n.z) { pg = atomicLoad(&ctl[pgFreeAt() + fk - 1u]); } else { atomicAdd(&ctl[8], 1u); }
  if (pg == 0xffffffffu) {
    pg = atomicAdd(&ctl[0], 1u);
    if (pg >= PP.n.z) {
      atomicSub(&ctl[0], 1u);
      atomicAdd(&ctl[1], 1u);
      return;
    }
  }
  for (var e = 0u; e < PAGE_W; e++) { pool[pg * PAGE_W + e] = FAR; }
  atomicStore(&ctl[pgTableAt(f, slot)], pg + 1u);
  pgMark(pgDirtyAt(pgPar()), f, slot);
}

@compute @workgroup_size(64)
fn pgFront(@builtin(global_invocation_id) id: vec3<u32>) {
  let b = id.x;
  if (b >= PP.n.x * PP.n.y) { return; }
  let f = b / PP.n.y;
  let slot = b % PP.n.y;
  // (its chunk: the window's chunk whose slot this is — walked from the chunk grid)
  let cur = pgDirtyAt(pgPar());
  let cx = pgSlotChunk(slot);
  if (cx.z == 0u) { return; }
  var ask = pgMarked(cur, f, slot);
  var near = pgPage(f, slot) != PG_NONE;
  for (var dy = -1; dy <= 1 && !ask; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = vec2<i32>(cx.xy) + vec2<i32>(dx, dy);
      if (q.x < 0 || q.y < 0 || u32(q.x) >= G.chunksX || u32(q.y) >= pgChunksY()) { continue; }
      let qs = pgSlot(vec2<u32>(q));
      if (pgMarked(cur, f, qs) && pgPage(f, qs) != PG_NONE) { ask = true; }
    }
  }
  if (!ask) { return; }
  let k = atomicAdd(&ctl[2], 1u);
  atomicAdd(&pgArgs[0], 1u);
  atomicStore(&ctl[pgFrontAt() + k], (f << 20u) | (cx.y << 10u) | cx.x);
}

@compute @workgroup_size(64)
fn pgClear(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= pgBits()) { return; }
  atomicStore(&ctl[pgDirtyAt(pgPar()) + id.x], 0u);
}

fn pgChunksY() -> u32 { return (G.mapH + G.chunkSize - 1u) / G.chunkSize; }
/** chunk slot → the window's chunk (x, y), found by walking the grid (the slots are a ring's: common.wgsl colSlot) */
fn pgSlotChunk(slot: u32) -> vec3<u32> {
  for (var y = 0u; y < pgChunksY(); y++) {
    for (var x = 0u; x < G.chunksX; x++) {
      if (pgSlot(vec2<u32>(x, y)) == slot) { return vec3<u32>(x, y, 1u); }
    }
  }
  return vec3<u32>(0u);
}

const PG_BT: u32 = 18u;
const PG_BCELLS: u32 = 324u;
var<workgroup> pgD: array<f32, 1296>;
var<workgroup> pgSlotW: u32;
fn pgAt(lx: u32, ly: u32, k: u32) -> u32 { return (ly * PG_BT + lx) * NAV_K + k; }

@compute @workgroup_size(16, 16)
fn pgRelax(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { pgSlotW = atomicLoad(&ctl[pgFrontAt() + wg.x]); }
  let fe = workgroupUniformLoad(&pgSlotW);
  let f = fe >> 20u;
  let cxy = vec2<u32>(fe & 0x3ffu, (fe >> 10u) & 0x3ffu);
  let slot = pgSlot(cxy);
  let o = vec2<i32>(cxy * G.chunkSize);
  let p = o + vec2<i32>(lid.xy);
  let inside = u32(p.x) < G.mapW && u32(p.y) < G.mapH;
  var i = 0u;
  if (inside) { i = colIdxI(p); }
  // (this column's surfaces, their links into the tile and each step's cost — relaxBlock's rules, roads aside)
  var nk = 0u;
  var nT: array<u32, 24>;
  var nC: array<f32, 24>;
  if (inside) {
    for (var k = 0u; k < NAV_K; k++) {
      let s = i * NAV_K + k;
      if (navZ(s) < 0.0) { break; }
      let z = costZ(s);
      if (z < 0.0) { break; }
      nk = k + 1u;
      let deepHere = costDeep(s);
      for (var dd = 0u; dd < NDIR; dd++) {
        nT[k * NDIR + dd] = 0xffffffffu;
        let l = navLink(s, dd);
        if (l == 0u) { continue; }
        let qn = nbr(p, dd);
        let t = colIdxI(qn) * NAV_K + l - 1u;
        if (costDeep(t) && !deepHere) { continue; }
        let lq = vec2<u32>(qn - o + vec2<i32>(1));
        nT[k * NDIR + dd] = pgAt(lq.x, lq.y, l - 1u);
        nC[k * NDIR + dd] = stepCost(z, costZ(t), costWet(t));
      }
    }
  }
  // the tile and its halo, through the pages (no page: FAR)
  for (var e = li; e < PG_BCELLS; e += 256u) {
    let q = o + vec2<i32>(i32(e % PG_BT), i32(e / PG_BT)) - vec2<i32>(1);
    let ok = q.x >= 0 && q.y >= 0 && u32(q.x) < G.mapW && u32(q.y) < G.mapH;
    var qi = 0u;
    if (ok) { qi = colIdxI(q); }
    for (var k = 0u; k < NAV_K; k++) {
      pgD[e * NAV_K + k] = select(FAR, pgDist(f, qi * NAV_K + k), ok);
    }
  }
  workgroupBarrier();
  // (this column's seeds: fixed at 0)
  var fixed: array<bool, 4>;
  for (var k = 0u; k < nk; k++) {
    fixed[k] = false;
    for (var e = 0u; e < PP.m.x; e++) {
      let sd = pgSeeds[e];
      if (sd.x == f && sd.y == i * NAV_K + k) { fixed[k] = true; }
    }
  }
  let me = vec2<u32>(lid.xy) + vec2<u32>(1u);
  for (var it = 0u; it < PP.m.y; it++) {
    var nv: array<f32, 4>;
    for (var k = 0u; k < nk; k++) {
      if (fixed[k]) { nv[k] = 0.0; continue; }
      var d = FAR;
      for (var dd = 0u; dd < NDIR; dd++) {
        let t = nT[k * NDIR + dd];
        if (t == 0xffffffffu) { continue; }
        let dn = pgD[t];
        if (dn >= FAR) { continue; }
        d = min(d, dn + nC[k * NDIR + dd]);
      }
      // (a field's reach: past it, no way — so no page asked for past it; 0 none)
      let reach = bitcast<f32>(PP.m.z);
      nv[k] = select(d, FAR, reach > 0.0 && d > reach);
    }
    workgroupBarrier();
    for (var k = 0u; k < nk; k++) { pgD[pgAt(me.x, me.y, k)] = nv[k]; }
    workgroupBarrier();
  }
  // written back where it moved; a chunk with no page whose values came out finite asks for one
  let pg = pgPage(f, slot);
  for (var k = 0u; k < nk; k++) {
    let nd = pgD[pgAt(me.x, me.y, k)];
    let s = i * NAV_K + k;
    if (pg == PG_NONE) {
      if (nd < FAR) { pgMark(pgReqAt(), f, slot); }
      continue;
    }
    let at = (pg - 1u) * PAGE_W + s % PAGE_W;
    let od = pool[at];
    if (abs(nd - od) > DIST_EPS || (nd >= FAR) != (od >= FAR)) {
      pool[at] = nd;
      pgMark(pgDirtyAt(1u - pgPar()), f, slot);
    }
  }
}

/** before a sweep's front: its count and the relax's indirect args reset */
@compute @workgroup_size(1)
fn pgReset() {
  atomicStore(&ctl[2], 0u);
  atomicStore(&pgArgs[0], 0u);
  atomicStore(&pgArgs[1], 1u);
  atomicStore(&pgArgs[2], 1u);
}
/** after a sweep: the marks it made are the next one's */
@compute @workgroup_size(1)
fn pgFlip() { atomicXor(&ctl[3], 1u); }

/** field PP.n.w's pages let go (a thread a chunk slot): onto the free stack, its table row emptied — a field started over
 *  (a seed moved far: FC4's count-up otherwise) or let go (its id recycled) */
@compute @workgroup_size(64)
fn pgRelease(@builtin(global_invocation_id) id: vec3<u32>) {
  let f = PP.n.w;
  if (id.x >= PP.n.y || f >= PP.n.x) { return; }
  let pg = atomicExchange(&ctl[pgTableAt(f, id.x)], PG_NONE);
  if (pg == PG_NONE) { return; }
  let k = atomicAdd(&ctl[8], 1u);
  atomicStore(&ctl[pgFreeAt() + k], pg - 1u);
}
