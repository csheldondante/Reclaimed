// ---- fieldseam.wgsl: the fields on pages (U2 round 7, UNIT_MINDS_U2.md §9b) — every field read, seed and relax -------
// A field is an owner of the page pool (gpu/pagepool.ts, pagepool.wgsl, at binding 6): a page a field over a chunk,
// handed out as the field grows into it, found through the field's row of the page table (no page: FAR). Field ids
// are the CPU's (Agents.newField): as many as the pool's rows, no fixed count. Appended to every agents kernel (after
// agents.wgsl, units.wgsl and the pool's WGSL); orders.wgsl, the units' step, the hunt and the JFA go through here.
//   page payload: [0, FP_W) distances (f32), [FP_W, 2 FP_W) seed-ids (the seed's surface + 1; 0 none)
//   page control words: [0, FP_SEEDS) a bit a surface — a seed this frame; [FP_SEEDS, 2 FP_SEEDS) — last frame
//   field record (the CPU's, Agents.writeField): 0 the place it's confined to (0 anywhere; bit 31 a region, else a room),
//     1 arrival radius, 2 leaving radius (f32; 0 off), 3 reach (f32 cost; 0 the scope's cap), 4 flags (FO_ROAD,
//     FO_WALKERS)
//   field GPU words (the pool's PP_OG, U2-FIELDREACH; FW_*): a walkers' field's want box — the chunks it may take pages
//     in (below)
// Seeds are put every frame (seedPut: the hunt's targets, the CPU's points, the orders' places) into a list; a seed new
// since last frame marks its page, one gone marks it too (seedUnmark / seedGone, as the hunt's two lists were).

/** a page's distances (16 x 16 columns x NAV_K surfaces) */
const FP_W: u32 = 256u * NAV_K;
/** a page's seed bits: words a frame */
const FP_SEEDS: u32 = FP_W / 32u;
const FO_ROAD: u32 = 1u;
/** (U2-FIELDREACH) the field takes pages only round its seeds and its walkers (an order's field): its want box */
const FO_WALKERS: u32 = 2u;
/** a group or rank following no field */
const FIELD_NONE: u32 = 0xffffffffu;

fn fieldOk(f: u32) -> bool { return f < ppOwners(); }
/** field f's page over surface s's chunk (+ 1; PP_NONE none) */
fn fieldPage(f: u32, s: u32) -> u32 {
  if (!fieldOk(f)) { return PP_NONE; }
  return ppPage(f, s / FP_W);
}
/** field f's distance at surface s (FAR: no way, or no page there) */
fn fieldDist(f: u32, s: u32) -> f32 {
  let pg = fieldPage(f, s);
  if (pg == PP_NONE) { return FAR; }
  return ppF32(pg, s % FP_W);
}
/** the seed field f's distance at s came from (its surface + 1; 0 none) */
fn fieldSrc(f: u32, s: u32) -> u32 {
  let pg = fieldPage(f, s);
  if (pg == PP_NONE) { return 0u; }
  return ppWord(pg, FP_W + s % FP_W);
}
/** field f's way down at surface s (column c, at pos): a unit vector, or 0 at a seed or with no way */
fn fieldGrad(f: u32, s: u32, c: vec2<i32>, pos: vec2<f32>) -> vec2<f32> { return downField(f, s, c, pos, fieldDist(f, s)); }
/** surface s's chunk slot */
fn fieldChunk(s: u32) -> u32 { return s / FP_W; }
fn fieldRec(f: u32, w: u32) -> u32 { return select(0u, ppOwner(f, w), fieldOk(f)); }
/** the place field f is confined to (0 anywhere) */
fn fieldPlace(f: u32) -> u32 { return fieldRec(f, 0u); }
/** field f's arrival and leaving radii (0: off) */
fn arriveR(f: u32) -> vec2<f32> { return vec2<f32>(bitcast<f32>(fieldRec(f, 1u)), bitcast<f32>(fieldRec(f, 2u))); }
fn fieldReach(f: u32) -> f32 { return bitcast<f32>(fieldRec(f, 3u)); }
fn fieldRoad(f: u32) -> bool { return (fieldRec(f, 4u) & FO_ROAD) != 0u; }
fn fieldWalkers(f: u32) -> bool { return (fieldRec(f, 4u) & FO_WALKERS) != 0u; }

// ---- (U2-FIELDREACH) a walkers' field's want box ---------------------------------------------------------------------
// A walkers' field (FO_WALKERS: an order's) asks for pages only in its want box: the world chunks round its seeds and
// its walkers (the members of the groups that follow it: orders.wgsl groupCount), grown by FW_MARGIN + its growth a
// side; the box only grows while the field lives (its pages aren't let go as the walkers close in). The shortest way
// may leave the box (a U round a wall): a field whose relax came out finite past the box's edge (FWF_EDGE), that moved
// nothing for a frame (no FWF_ACTIVE) while a walker read FAR (FWF_FAR) grows a chunk a side (fieldBounds) — so a
// walker its field can reach is reached, never left FAR by the box. World chunks (the window's origin added: a slide
// moves nothing), biased by FW_BIAS so 0 is none:
//   0-3 the box (x0, y0, x1, y1 inclusive, + FW_BIAS; 0: none yet), 4-7 this frame's seeds and walkers (FW_BIAS2 - x0,
//   FW_BIAS2 - y0, x1, y1, + FW_BIAS: atomicMax each; 0 none), 8 the growth (chunks), 9 flags (FWF_*)
const FW_WORDS: u32 = 10u;
const FW_BIAS: i32 = 16384;
const FW_BIAS2: u32 = 32768u;
const FW_MARGIN: i32 = 1;
const FWF_ACTIVE: u32 = 1u;
const FWF_EDGE: u32 = 2u;
const FWF_FAR: u32 = 4u;
/** the window's origin in world chunks */
fn fwOrigin() -> vec2<i32> { return vec2<i32>(floor(G.org.zw / f32(COLS_PAGE))); }
/** window chunk c's world chunk, biased */
fn fwChunk(c: vec2<i32>) -> vec2<u32> { return vec2<u32>(c + fwOrigin() + vec2<i32>(FW_BIAS)); }
fn fwWord(f: u32, w: u32) -> u32 { return ppCtl(ppOgAt(f, w)); }
fn fwFlag(f: u32, b: u32) { atomicOr(&pp.ctl[ppOgAt(f, 9u)], b); }
/** window chunk c a seed's or a walker's of field f this frame (a walkers' field only) */
fn fieldWalkerAt(f: u32, c: vec2<i32>) {
  if (!fieldOk(f) || !fieldWalkers(f)) { return; }
  let b = fwChunk(c);
  atomicMax(&pp.ctl[ppOgAt(f, 4u)], FW_BIAS2 - b.x);
  atomicMax(&pp.ctl[ppOgAt(f, 5u)], FW_BIAS2 - b.y);
  atomicMax(&pp.ctl[ppOgAt(f, 6u)], b.x);
  atomicMax(&pp.ctl[ppOgAt(f, 7u)], b.y);
}
/** may field f take a page over chunk slot `slot` (a walkers' field: in its want box) */
fn fieldWants(f: u32, slot: u32) -> bool {
  if (!fieldWalkers(f)) { return true; }
  let x0 = fwWord(f, 0u);
  if (x0 == 0u) { return false; }
  let b = fwChunk(vec2<i32>(slotChunk(slot)));
  return b.x >= x0 && b.y >= fwWord(f, 1u) && b.x <= fwWord(f, 2u) && b.y <= fwWord(f, 3u);
}

/** (once a frame, after the seeds are put and before the sweeps; a thread a field) each walkers' field's box: this
 *  frame's seeds and walkers (last frame's walkers: groupCount runs after the step) round it by FW_MARGIN + its growth,
 *  added to the box; a chunk more a side when the field is stuck at its edge (FWF_EDGE, no FWF_ACTIVE, FWF_FAR). A box
 *  that grew has its field's pages along its old edge marked: the front goes on from there */
@compute @workgroup_size(64)
fn fieldBounds(@builtin(global_invocation_id) id: vec3<u32>) {
  let f = id.x;
  if (f >= ppOwners() || !fieldWalkers(f)) { return; }
  let n = vec4<u32>(atomicExchange(&pp.ctl[ppOgAt(f, 4u)], 0u), atomicExchange(&pp.ctl[ppOgAt(f, 5u)], 0u),
                    atomicExchange(&pp.ctl[ppOgAt(f, 6u)], 0u), atomicExchange(&pp.ctl[ppOgAt(f, 7u)], 0u));
  let fl = atomicAnd(&pp.ctl[ppOgAt(f, 9u)], ~(FWF_ACTIVE | FWF_FAR));
  var grow = fwWord(f, 8u);
  let stuck = (fl & (FWF_EDGE | FWF_FAR)) == (FWF_EDGE | FWF_FAR) && (fl & FWF_ACTIVE) == 0u;
  if (stuck) {
    grow++;
    atomicStore(&pp.ctl[ppOgAt(f, 8u)], grow);
  }
  let old = vec4<u32>(fwWord(f, 0u), fwWord(f, 1u), fwWord(f, 2u), fwWord(f, 3u));
  var b = old;
  let m = u32(FW_MARGIN) + grow;
  if (n.z != 0u) {
    let nb = vec4<u32>(FW_BIAS2 - n.x - m, FW_BIAS2 - n.y - m, n.z + m, n.w + m);
    b = select(nb, vec4<u32>(min(b.xy, nb.xy), max(b.zw, nb.zw)), b.x != 0u);
  }
  if (stuck && b.x != 0u) { b = vec4<u32>(b.xy - vec2<u32>(1u), b.zw + vec2<u32>(1u)); }
  if (all(b == old)) { return; }
  for (var w = 0u; w < 4u; w++) { atomicStore(&pp.ctl[ppOgAt(f, w)], b[w]); }
  atomicAnd(&pp.ctl[ppOgAt(f, 9u)], ~FWF_EDGE);
  if (old.x == 0u) { return; }
  // (the old box's edge chunks in the window: the field's pages there marked — what lay past them may be taken now)
  let o = vec2<i32>(fwOrigin() + vec2<i32>(FW_BIAS));
  let lo = vec2<i32>(old.xy) - o;
  let hi = vec2<i32>(old.zw) - o;
  for (var y = max(lo.y, 0); y <= min(hi.y, i32(pagesY()) - 1); y++) {
    for (var x = max(lo.x, 0); x <= min(hi.x, i32(pagesX()) - 1); x++) {
      if (x != lo.x && x != hi.x && y != lo.y && y != hi.y) { continue; }
      let s = pageIdx(vec2<u32>(u32(x), u32(y)));
      if (ppPage(f, s) != PP_NONE) { ppMark(f, s); }
    }
  }
}

/** is surface s a seed of field f this frame (its page's bit) */
fn fieldIsSeed(f: u32, s: u32) -> bool {
  let pg = fieldPage(f, s);
  if (pg == PP_NONE) { return false; }
  let e = s % FP_W;
  return ((ppCtl(ppPctlAt(pg, e / 32u)) >> (e % 32u)) & 1u) != 0u;
}

// ---- the frame's seeds -----------------------------------------------------------------------------------------------
// [0] [1] the two lists' counts, [2] which is last frame's, [3] puts the list had no room for, [4] [5] the hunt's and the foes' fields (units.wgsl huntSet; SEED_LIST: sized by the
// CPU to every seeder there can be — a refusal is a sizing bug, shown), then the lists: (field, surface) pairs
@group(0) @binding(53) var<storage, read_write> seedList: array<atomic<u32>>;
const SEED_LIST: u32 = 16384u; // SEED_LIST
const SEED_HEAD: u32 = 16u + 2u * 256u;
fn seedAt(l: u32, k: u32) -> u32 { return SEED_HEAD + (l * SEED_LIST + k) * 2u; }
const SEED_NONE: u32 = 0u;
const SEED_KEPT: u32 = 1u;
const SEED_NEW: u32 = 2u;

fn seedList1(f: u32, s: u32) {
  let cur = 1u - atomicLoad(&seedList[2]);
  let n = atomicAdd(&seedList[cur], 1u);
  if (n < SEED_LIST) {
    atomicStore(&seedList[seedAt(cur, n)], f);
    atomicStore(&seedList[seedAt(cur, n) + 1u], s);
  } else {
    atomicAdd(&seedList[3], 1u);
  }
}
/** surface s's bit set in field f's page pg; new since last frame → the page marked (the field falls round it) */
fn seedBit(f: u32, s: u32, pg: u32) -> u32 {
  let e = s % FP_W;
  let bit = 1u << (e % 32u);
  let old = atomicOr(&pp.ctl[ppPctlAt(pg, e / 32u)], bit);
  if ((old & bit) != 0u) { return SEED_KEPT; }
  if ((ppCtl(ppPctlAt(pg, FP_SEEDS + e / 32u)) & bit) != 0u) { return SEED_KEPT + 4u; }
  ppMark(f, s / FP_W);
  return SEED_NEW + 4u;
}
/** surface s a seed of field f this frame: listed, its page's bit set — no page there yet: the page asked for, the bit
 *  set once it's handed out (seedLand, before the sweeps) */
fn seedPut(f: u32, s: u32) -> u32 {
  if (!fieldOk(f)) { return SEED_NONE; }
  let slot = s / FP_W;
  fieldWalkerAt(f, vec2<i32>(slotChunk(slot)));
  let pg = ppPage(f, slot);
  if (pg == PP_NONE) {
    ppRequest(f, slot);
    seedList1(f, s);
    return SEED_NEW;
  }
  let r = seedBit(f, s, pg);
  // (first put this frame: listed — the list is what next frame's unmark and gone walk)
  if (r >= 4u) { seedList1(f, s); }
  return r & 3u;
}

/** (after the pages asked for are handed out) this frame's seeds whose page came now: their bits set */
@compute @workgroup_size(64)
fn seedLand(@builtin(global_invocation_id) id: vec3<u32>) {
  let cur = 1u - atomicLoad(&seedList[2]);
  if (id.x >= min(atomicLoad(&seedList[cur]), SEED_LIST)) { return; }
  let f = atomicLoad(&seedList[seedAt(cur, id.x)]);
  let s = atomicLoad(&seedList[seedAt(cur, id.x) + 1u]);
  let pg = fieldPage(f, s);
  if (pg != PP_NONE) { seedBit(f, s, pg); }
}

@compute @workgroup_size(1)
fn seedReset() { atomicStore(&seedList[1u - atomicLoad(&seedList[2])], 0u); }

/** last frame's seeds: this frame's bit moved to last frame's */
@compute @workgroup_size(64)
fn seedUnmark(@builtin(global_invocation_id) id: vec3<u32>) {
  let prev = atomicLoad(&seedList[2]);
  if (id.x >= min(atomicLoad(&seedList[prev]), SEED_LIST)) { return; }
  let f = atomicLoad(&seedList[seedAt(prev, id.x)]);
  let s = atomicLoad(&seedList[seedAt(prev, id.x) + 1u]);
  let pg = fieldPage(f, s);
  if (pg == PP_NONE) { return; }
  let e = s % FP_W;
  let bit = 1u << (e % 32u);
  atomicAnd(&pp.ctl[ppPctlAt(pg, e / 32u)], ~bit);
  atomicOr(&pp.ctl[ppPctlAt(pg, FP_SEEDS + e / 32u)], bit);
}

/** last frame's seeds not put again: their pages marked (the field rises there); last frame's bit cleared */
@compute @workgroup_size(64)
fn seedGone(@builtin(global_invocation_id) id: vec3<u32>) {
  let prev = atomicLoad(&seedList[2]);
  if (id.x >= min(atomicLoad(&seedList[prev]), SEED_LIST)) { return; }
  let f = atomicLoad(&seedList[seedAt(prev, id.x)]);
  let s = atomicLoad(&seedList[seedAt(prev, id.x) + 1u]);
  let pg = fieldPage(f, s);
  if (pg == PP_NONE) { return; }
  let e = s % FP_W;
  let bit = 1u << (e % 32u);
  let was = atomicAnd(&pp.ctl[ppPctlAt(pg, FP_SEEDS + e / 32u)], ~bit);
  if ((was & bit) == 0u || (ppCtl(ppPctlAt(pg, e / 32u)) & bit) != 0u) { return; }
  ppMark(f, s / FP_W);
  if (AP.u2.w != 0u) { atomicAdd(&frontDbg[33], 1u); }
}

@compute @workgroup_size(1)
fn seedFlip() { atomicStore(&seedList[2], 1u - atomicLoad(&seedList[2])); }

/** the CPU's seeds (AP.seeds: a point and its field), put every frame */
@compute @workgroup_size(64)
fn cpuSeeds(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= AP.n.y) { return; }
  let sd = AP.seeds[id.x];
  let c = cellAt(sd.xy);
  if (!inMap(c) || !inScope(c)) { return; }
  let i = colIdxI(c);
  let k = surfaceNear(i, sd.z);
  if (k >= NAV_K) { return; }
  seedPut(u32(sd.w), i * NAV_K + k);
}

// ---- relax over pages (FC12's block relaxation, a workgroup a front entry) -------------------------------------------
// The front (the pool's: a (field, chunk) whose page changed, or one round it) is relaxed a workgroup an entry: the
// chunk's tile and a one-column halo loaded through the 3 x 3 pages round it (no page: FAR), relaxed RELAX_K times in
// workgroup memory, written back where it moved past DIST_EPS (its page marked for the next sweep). A value whose seed
// is gone (its seed's distance no longer 0) loads as FAR: the values it made empty at once, then refill (no count-up).
// A chunk with no page whose values came out finite asks for one (the field grows a chunk a sweep at its edge); a page
// left all FAR with no seeds is let go (the field's memory follows the ground it reaches).
var<workgroup> rD: array<f32, 1296>;
var<workgroup> rS: array<u32, 1296>;
var<workgroup> rPg: array<u32, 9>;
var<workgroup> rEnt: vec2<u32>;
var<workgroup> rLive: u32;
var<workgroup> rOut: atomic<u32>;
const R_FINITE: u32 = 1u;
const R_SEED: u32 = 2u;
const R_MOVED: u32 = 4u;
const RT: u32 = 18u;
const RCELLS: u32 = 324u;
fn rAt(lx: u32, ly: u32, k: u32) -> u32 { return (ly * RT + lx) * NAV_K + k; }

@compute @workgroup_size(16, 16)
fn fieldRelax(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    rEnt = ppFrontAt(wg.x);
    atomicStore(&rOut, 0u);
  }
  workgroupBarrier();
  let ent = rEnt;
  let f = ent.x;
  let slot = ent.y;
  let cxy = slotChunk(slot);
  if (li < 9u) {
    let q = vec2<i32>(cxy) + vec2<i32>(i32(li % 3u) - 1, i32(li / 3u) - 1);
    var pg = PP_NONE;
    if (q.x >= 0 && q.y >= 0 && u32(q.x) < pagesX() && u32(q.y) < pagesY()) { pg = ppPage(f, pageIdx(vec2<u32>(q))); }
    rPg[li] = pg;
  }
  workgroupBarrier();
  if (li == 0u) {
    var any = 0u;
    for (var e = 0u; e < 9u; e++) { any |= rPg[e]; }
    rLive = select(0u, 1u, any != 0u);
  }
  // (no page here nor round it: nothing finite can come — a seed asks for its own page)
  if (workgroupUniformLoad(&rLive) == 0u) { return; }
  let o = vec2<i32>(cxy * COLS_PAGE);
  let p = o + vec2<i32>(lid.xy);
  let i = colIdxI(p);
  var cap = f32(min(G.mapW + G.mapH, (AB[0].z - AB[0].x) + (AB[0].w - AB[0].y))) * 6.0;
  let reach = fieldReach(f);
  if (reach > 0.0) { cap = min(cap, reach); }
  // (this column's surfaces, their links into the tile and each step's cost: fixed through the sweep)
  var nk = 0u;
  var nT: array<u32, 24>;
  var nC: array<f32, 24>;
  for (var k = 0u; k < NAV_K; k++) {
    let s = i * NAV_K + k;
    if (navZ(s) < 0.0) { break; }
    let z = costZ(s);
    if (z < 0.0) { break; }
    nk = k + 1u;
    let deepHere = costDeep(s);
    for (var dd = 0u; dd < NDIR; dd++) {
      nT[k * NDIR + dd] = BNONE;
      let l = navLink(s, dd);
      if (l == 0u) { continue; }
      let qn = nbr(p, dd);
      if (!inScope(qn)) { continue; }
      let t = colIdxI(qn) * NAV_K + l - 1u;
      if (costDeep(t) && !deepHere) { continue; }
      let lq = vec2<u32>(qn - o + vec2<i32>(1));
      nT[k * NDIR + dd] = rAt(lq.x, lq.y, l - 1u);
      let road = 1.0 - (1.0 - ROAD_COST) * 0.5 * (onRoad(p) + onRoad(qn));
      nC[k * NDIR + dd] = stepCost(z, costZ(t), costWet(t)) * road;
    }
  }
  // the tile and its halo, through the pages (a value whose seed is gone: FAR)
  for (var e = li; e < RCELLS; e += 256u) {
    let q = o + vec2<i32>(i32(e % RT), i32(e / RT)) - vec2<i32>(1);
    let ok = inMap(q) && inScope(q);
    var pg = PP_NONE;
    var qi = 0u;
    if (ok) {
      let lc = vec2<i32>(select(select(1, 2, q.x >= o.x + 16), 0, q.x < o.x), select(select(1, 2, q.y >= o.y + 16), 0, q.y < o.y));
      pg = rPg[u32(lc.y * 3 + lc.x)];
      qi = colIdxI(q);
    }
    for (var k = 0u; k < NAV_K; k++) {
      var v = FAR;
      var sv = 0u;
      if (pg != PP_NONE) {
        let w = (qi * NAV_K + k) % FP_W;
        v = ppF32(pg, w);
        sv = ppWord(pg, FP_W + w);
        if (v < FAR && (sv == 0u || fieldDist(f, sv - 1u) != 0.0)) {
          v = FAR;
          sv = 0u;
        }
      }
      rD[e * NAV_K + k] = v;
      rS[e * NAV_K + k] = sv;
    }
  }
  workgroupBarrier();
  // (this column's fixed values: its seeds — the page's bits, or the road field's network — and off a confined
  // field's place)
  let fp = fieldPlace(f);
  let road = fieldRoad(f) && onNet(p);
  let me = vec2<u32>(lid.xy) + vec2<u32>(1u);
  var fixed: array<u32, 4>;
  for (var k = 0u; k < nk; k++) {
    let s = i * NAV_K + k;
    fixed[k] = 0u;
    if (fp != 0u && !onPlace(s, fp)) { fixed[k] = 2u; continue; }
    if (road || fieldIsSeed(f, s)) {
      fixed[k] = 1u;
      atomicOr(&rOut, R_SEED);
    }
  }
  for (var it = 0u; it < RELAX_K; it++) {
    var nv: array<f32, 4>;
    var nsrc: array<u32, 4>;
    for (var k = 0u; k < nk; k++) {
      if (fixed[k] == 1u) { nv[k] = 0.0; nsrc[k] = i * NAV_K + k + 1u; continue; }
      if (fixed[k] == 2u) { nv[k] = FAR; nsrc[k] = 0u; continue; }
      var d = FAR;
      var sv = 0u;
      for (var dd = 0u; dd < NDIR; dd++) {
        let t = nT[k * NDIR + dd];
        if (t == BNONE) { continue; }
        let dn = rD[t];
        if (dn >= FAR) { continue; }
        let dt = dn + nC[k * NDIR + dd];
        if (dt < d) {
          d = dt;
          sv = rS[t];
        }
      }
      nv[k] = select(d, FAR, d > cap);
      nsrc[k] = select(sv, 0u, nv[k] >= FAR);
    }
    workgroupBarrier();
    for (var k = 0u; k < nk; k++) {
      rD[rAt(me.x, me.y, k)] = nv[k];
      rS[rAt(me.x, me.y, k)] = nsrc[k];
    }
    workgroupBarrier();
  }
  // written back where it moved (DIST_EPS) or its seed changed
  let pg = rPg[4];
  for (var k = 0u; k < nk; k++) {
    let nd = rD[rAt(me.x, me.y, k)];
    let ns2 = rS[rAt(me.x, me.y, k)];
    if (nd < FAR) { atomicOr(&rOut, R_FINITE); }
    if (pg == PP_NONE) { continue; }
    let w = (i * NAV_K + k) % FP_W;
    let od = ppF32(pg, w);
    if (abs(nd - od) > DIST_EPS || (nd >= FAR) != (od >= FAR) || ppWord(pg, FP_W + w) != ns2) {
      ppSetF32(pg, w, nd);
      ppSetWord(pg, FP_W + w, ns2);
      atomicOr(&rOut, R_MOVED);
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    let out = atomicLoad(&rOut);
    if (pg == PP_NONE) {
      // (U2-FIELDREACH: a walkers' field only in its want box; past it, told — the box grows if a walker needs it)
      if ((out & R_FINITE) != 0u) {
        if (fieldWants(f, slot)) {
          ppRequest(f, slot);
          if (fieldWalkers(f)) { fwFlag(f, FWF_ACTIVE); }
        } else {
          fwFlag(f, FWF_EDGE);
        }
      }
    } else if ((out & (R_FINITE | R_SEED)) == 0u) {
      // (all FAR, no seeds: let go — a neighbour reading it reads FAR either way — and marked, so the chunks round it
      // are relaxed next: what they hold may have come through here)
      ppDrop(f, slot, pg);
      ppMarkNext(f, slot);
    } else if ((out & R_MOVED) != 0u) {
      ppMarkNext(f, slot);
      if (fieldWalkers(f)) { fwFlag(f, FWF_ACTIVE); }
    }
  }
}

/** (the CPU's marks: agents/scope.ts) a tile list's chunks relaxed again for every field there (the roads' costs moved,
 *  the scope drawn in); the road field's network columns seeded (their pages asked for) */
@compute @workgroup_size(8, 8)
fn markChunks(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= G.mapW || id.y >= G.mapH) { return; }
  let slot = chunkOfCol(id.x, id.y);
  if ((id.x % COLS_PAGE) == 0u && (id.y % COLS_PAGE) == 0u) { ppMarkSlot(slot); }
  let rf = AP.u2.y;
  if (fieldOk(rf) && onNet(vec2<i32>(id.xy))) {
    if (ppPage(rf, slot) == PP_NONE) { ppRequest(rf, slot); }
    ppMark(rf, slot);
  }
}
