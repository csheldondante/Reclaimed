// ---- pagepool.wgsl: the shared GPU page pool (U2 round 7; docs/design/PAGEPOOL.md) ---------------------------------
// Chunk-keyed, page-sized GPU data from one pool: an owner (a field, later terrain's sparse table, fire, flora) holds a
// page over a chunk slot of the window (the terrain ring's slots: common.wgsl pageIdx / slotChunk), found through its
// row of the page table. The pages are handed out on the GPU (a free stack, then the pool's end), so no fixed count of
// owners' data: only the pool's size. gpu/pagepool.ts builds the module text: the declaration (rw: the control words
// atomic, the payload plain; read: both plain — a kernel that only reads), the readers, the writers (rw), and the
// pool's own kernels. Everything here is `pp`-prefixed; the constants PP_* are the TS side's (PagePool.consts).
//
// ctl words (PagePool.layout mirrors them):
//   header PP_HDR: 0 pages handed out (the pool's end), 1 claims refused (the pool full), 2 the front's count,
//     3 the dirty parity, 4 the free stack's count, 5 the front's stamp (one a sweep)
//   gen    a word a page: bumped when the page is let go (a page id read before a release is told from one after)
//   table  owners x slots: page + 1 (0: none)
//   dirty  two parities of a bit an (owner, slot), then two of a bit a slot ("every owner here": a cell changed)
//   req    a bit an (owner, slot): a page asked for
//   stamp  owners x slots: the sweep that last listed it in the front (dedupe without a clear)
//   front  owners x slots entries: owner << 16 | slot
//   free   the free stack (pages let go)

//#read ---------------------------------------------------------------------------------------------------------------
const PP_HDR: u32 = 16u;
const PP_GEN: u32 = PP_HDR;
const PP_TABLE: u32 = PP_GEN + PP_PAGES;
const PP_TBITS: u32 = (PP_OWNERS * PP_SLOTS + 31u) / 32u;
const PP_SBITS: u32 = (PP_SLOTS + 31u) / 32u;
const PP_DIRTY: u32 = PP_TABLE + PP_OWNERS * PP_SLOTS;
const PP_SDIRTY: u32 = PP_DIRTY + 2u * PP_TBITS;
const PP_REQ: u32 = PP_SDIRTY + 2u * PP_SBITS;
const PP_STAMP: u32 = PP_REQ + PP_TBITS;
const PP_FRONT: u32 = PP_STAMP + PP_OWNERS * PP_SLOTS;
const PP_FREE: u32 = PP_FRONT + PP_OWNERS * PP_SLOTS;
const PP_NONE: u32 = 0u;

/** owner o's page over chunk slot `slot`, + 1 (PP_NONE: none) */
fn ppPage(o: u32, slot: u32) -> u32 { return ppCtl(PP_TABLE + o * PP_SLOTS + slot); }
/** page pg's generation (pg the page itself, not + 1) */
fn ppGen(pg: u32) -> u32 { return ppCtl(PP_GEN + pg); }
/** word w of page pg1 (page + 1, as the table holds it) */
fn ppWord(pg1: u32, w: u32) -> u32 { return pp.data[(pg1 - 1u) * PP_PW + w]; }
fn ppF32(pg1: u32, w: u32) -> f32 { return bitcast<f32>(ppWord(pg1, w)); }
/** the dirty parity marks made outside a sweep go to (and the front reads) */
fn ppPar() -> u32 { return ppCtl(3u) & 1u; }
/** the front's i-th entry: (owner, slot) */
fn ppFrontAt(i: u32) -> vec2<u32> {
  let e = ppCtl(PP_FRONT + i);
  return vec2<u32>(e >> 16u, e & 0xffffu);
}

//#write --------------------------------------------------------------------------------------------------------------
fn ppSetWord(pg1: u32, w: u32, v: u32) { pp.data[(pg1 - 1u) * PP_PW + w] = v; }
fn ppSetF32(pg1: u32, w: u32, v: f32) { ppSetWord(pg1, w, bitcast<u32>(v)); }
fn ppBit(base: u32, b: u32) { atomicOr(&pp.ctl[base + b / 32u], 1u << (b % 32u)); }
/** (owner o, slot) changed: listed in the next front (and, with spread, its neighbours) */
fn ppMark(o: u32, slot: u32) { ppBit(PP_DIRTY + ppPar() * PP_TBITS, o * PP_SLOTS + slot); }
/** (within a sweep, the consumer's relax) changed: listed in the sweep after this one's */
fn ppMarkNext(o: u32, slot: u32) { ppBit(PP_DIRTY + (1u - ppPar()) * PP_TBITS, o * PP_SLOTS + slot); }
/** slot changed for every owner (its cells did): each owner with a page there, or next to it, listed */
fn ppMarkSlot(slot: u32) { ppBit(PP_SDIRTY + ppPar() * PP_SBITS, slot); }
/** a page asked for (owner o, slot): handed out by the next ppAlloc */
fn ppRequest(o: u32, slot: u32) { ppBit(PP_REQ, o * PP_SLOTS + slot); }

//#kernels ------------------------------------------------------------------------------------------------------------
// The pool's own passes (gpu/pagepool.ts encodes them): its params, the relax's indirect args (their own buffer: an
// indirect buffer can't be written in the dispatch that reads it), and the releases asked for (ops).
struct PoolParams {
  /** x owners in use (rows: the CPU's high-water), y spare, z spread (1: a mark lists the 8 neighbours
   *  too), w the page's split (words below it filled with fill.x, the rest fill.y) */
  n: vec4<u32>,
  /** the front's box in window chunks: x0, y0, x1, y1 (exclusive; whole window when x1 is 0) */
  box: vec4<u32>,
  /** x, y the fill words a page is handed out with */
  fill: vec4<u32>,
};
@group(0) @binding(90) var<uniform> PPP: PoolParams;
@group(0) @binding(91) var<storage, read_write> ppArgs: array<atomic<u32>, 4>;
/** releases: [0] their count, then each: bit 31 a slot (every owner's page there), else an owner (every page it holds) */
@group(0) @binding(92) var<storage, read> ppOps: array<u32>;

fn ppPagesY() -> u32 { return PP_SLOTS / pagesX(); }
fn ppInBox(c: vec2<i32>) -> bool {
  if (c.x < 0 || c.y < 0 || u32(c.x) >= pagesX() || u32(c.y) >= ppPagesY()) { return false; }
  if (PPP.box.z == 0u) { return true; }
  return u32(c.x) >= PPP.box.x && u32(c.y) >= PPP.box.y && u32(c.x) < PPP.box.z && u32(c.y) < PPP.box.w;
}
/** page pg let go: its generation moved on, onto the free stack */
fn ppFree(pg: u32) {
  atomicAdd(&pp.ctl[PP_GEN + pg], 1u);
  let k = atomicAdd(&pp.ctl[4], 1u);
  atomicStore(&pp.ctl[PP_FREE + k], pg);
}
fn ppClearBit(base: u32, b: u32) { atomicAnd(&pp.ctl[base + b / 32u], ~(1u << (b % 32u))); }

/** a thread a word of requests: each asked-for (owner, slot) without a page gets one — the free stack's top, else the
 *  pool's end; none left: refused (counted; the owner doesn't grow there). The page filled, the entry marked */
@compute @workgroup_size(64)
fn ppAlloc(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= PP_TBITS) { return; }
  var m = atomicExchange(&pp.ctl[PP_REQ + id.x], 0u);
  while (m != 0u) {
    let bit = firstTrailingBit(m);
    m &= m - 1u;
    let b = id.x * 32u + bit;
    let o = b / PP_SLOTS;
    let slot = b % PP_SLOTS;
    if (o >= PPP.n.x || ppPage(o, slot) != PP_NONE) { continue; }
    var pg = 0xffffffffu;
    let fk = atomicSub(&pp.ctl[4], 1u);
    if (fk > 0u && fk <= PP_PAGES) { pg = atomicLoad(&pp.ctl[PP_FREE + fk - 1u]); } else { atomicAdd(&pp.ctl[4], 1u); }
    if (pg == 0xffffffffu) {
      pg = atomicAdd(&pp.ctl[0], 1u);
      if (pg >= PP_PAGES) {
        atomicSub(&pp.ctl[0], 1u);
        atomicAdd(&pp.ctl[1], 1u);
        continue;
      }
    }
    for (var w = 0u; w < PP_PW; w++) { pp.data[pg * PP_PW + w] = select(PPP.fill.y, PPP.fill.x, w < PPP.n.w); }
    atomicStore(&pp.ctl[PP_TABLE + o * PP_SLOTS + slot], pg + 1u);
    ppMark(o, slot);
  }
}

/** before a sweep's front: its count, the indirect args reset, a new stamp */
@compute @workgroup_size(1)
fn ppReset() {
  atomicStore(&pp.ctl[2], 0u);
  atomicAdd(&pp.ctl[5], 1u);
  atomicStore(&ppArgs[0], 0u);
  atomicStore(&ppArgs[1], 1u);
  atomicStore(&ppArgs[2], 1u);
}

/** (owner o, slot) listed, and with spread the slots round it, inside the box, each once a sweep */
fn ppList(o: u32, slot: u32) {
  let c = vec2<i32>(slotChunk(slot));
  let r = select(0, 1, PPP.n.z != 0u);
  let st = atomicLoad(&pp.ctl[5]);
  for (var dy = -r; dy <= r; dy++) {
    for (var dx = -r; dx <= r; dx++) {
      let q = c + vec2<i32>(dx, dy);
      if (!ppInBox(q)) { continue; }
      let s = pageIdx(vec2<u32>(q));
      if (atomicExchange(&pp.ctl[PP_STAMP + o * PP_SLOTS + s], st) == st) { continue; }
      let k = atomicAdd(&pp.ctl[2], 1u);
      atomicStore(&pp.ctl[PP_FRONT + k], (o << 16u) | s);
      atomicAdd(&ppArgs[0], 1u);
    }
  }
}
fn ppHasNear(o: u32, slot: u32) -> bool {
  let c = vec2<i32>(slotChunk(slot));
  let r = select(0, 1, PPP.n.z != 0u);
  for (var dy = -r; dy <= r; dy++) {
    for (var dx = -r; dx <= r; dx++) {
      let q = c + vec2<i32>(dx, dy);
      if (q.x < 0 || q.y < 0 || u32(q.x) >= pagesX() || u32(q.y) >= ppPagesY()) { continue; }
      if (ppPage(o, pageIdx(vec2<u32>(q))) != PP_NONE) { return true; }
    }
  }
  return false;
}

/** a thread a word of the current parity's marks (owner words, then slot words), read and cleared: the front */
@compute @workgroup_size(64)
fn ppFront(@builtin(global_invocation_id) id: vec3<u32>) {
  let par = ppPar();
  if (id.x < PP_TBITS) {
    var m = atomicExchange(&pp.ctl[PP_DIRTY + par * PP_TBITS + id.x], 0u);
    while (m != 0u) {
      let b = id.x * 32u + firstTrailingBit(m);
      m &= m - 1u;
      let o = b / PP_SLOTS;
      if (o < PPP.n.x) { ppList(o, b % PP_SLOTS); }
    }
    return;
  }
  let w = id.x - PP_TBITS;
  if (w >= PP_SBITS) { return; }
  var m = atomicExchange(&pp.ctl[PP_SDIRTY + par * PP_SBITS + w], 0u);
  while (m != 0u) {
    let slot = w * 32u + firstTrailingBit(m);
    m &= m - 1u;
    if (slot >= PP_SLOTS) { continue; }
    for (var o = 0u; o < PPP.n.x; o++) {
      if (ppHasNear(o, slot)) { ppList(o, slot); }
    }
  }
}

/** after a sweep: the marks it made (ppMarkNext) are the next front's */
@compute @workgroup_size(1)
fn ppFlip() { atomicXor(&pp.ctl[3], 1u); }

/** releases (ops): workgroup row y the op, a thread a slot (an owner's) or an owner (a slot's) — pages let go, the
 *  entries' marks and asks cleared (an owner id freed starts empty; a slot come in starts empty for everyone) */
@compute @workgroup_size(64)
fn ppRelease(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.y >= ppOps[0]) { return; }
  let op = ppOps[1u + id.y];
  var o = 0u;
  var slot = 0u;
  if ((op >> 31u) != 0u) {
    if (id.x >= PPP.n.x) { return; }
    o = id.x;
    slot = op & 0x7fffffffu;
  } else {
    if (id.x >= PP_SLOTS) { return; }
    o = op;
    slot = id.x;
  }
  if (o >= PP_OWNERS || slot >= PP_SLOTS) { return; }
  let b = o * PP_SLOTS + slot;
  ppClearBit(PP_REQ, b);
  ppClearBit(PP_DIRTY, b);
  ppClearBit(PP_DIRTY + PP_TBITS, b);
  let pg = atomicExchange(&pp.ctl[PP_TABLE + b], PP_NONE);
  if (pg != PP_NONE) { ppFree(pg - 1u); }
}
