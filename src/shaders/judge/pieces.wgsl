// pieces.wgsl: judge, pieces and pieceFlags, seedList, the pairs on the whole GPU (part 3 of 5 of the judgeWgsl shader, joined in order by judge.ts)
// ---- judge: one workgroup ------------------------------------------------------------------------------------------
// ---- pieces, pieceFlags: a thread a hanging run (the whole GPU; union-find is lock-free) ----
// 1 — pieces first: the hanging runs' connected components, and which a cut could have weakened (seeded: a solid
// run in a seed column or beside one). Round 120, the user's local culling: only those are flooded and judged —
// exact, not a radius: a piece's verdict depends on its own runs, what holds them and (the neck) the standing runs
// within TUNE.judgeB.neck columns, nothing farther (P.pad1 = 1 judges every piece: the whole-window reference)
@compute @workgroup_size(64)
fn pieces(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= hangN()) { return; }
  {
    let i = nu(F_HANG, t);
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var r = 0u; r < 16u; r++) {
        if ((nb.y & (1u << r)) == 0u) { continue; }
        let j = nb.x + r;
        if (!standsN(j) && j < i) { unite(F_PC, i, j); }
      }
    }
  }
}

@compute @workgroup_size(64)
fn pieceFlags(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= hangN()) { return; }
  {
    let i = nu(F_HANG, t);
    let p = find(F_PC, i);
    N[N_PIECE * P.ncap + i] = p;
    // (weighed: an edit cut its column, or the column of a standing run holding it)
    var wByHolder = false;
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var r = 0u; r < 16u; r++) {
        if ((nb.y & (1u << r)) == 0u) { continue; }
        let j = nb.x + r;
        if (standsN(j) && (nu(N_FLAGS, j) & NF_WEIGHED) != 0u) { wByHolder = true; }
      }
    }
    if (wByHolder) { st(fi(F_DYN, i), NF_WEIGHED); }
    let fl = nu(N_FLAGS, i) | select(0u, NF_WEIGHED, wByHolder);
    var pf = 0u;
    if ((fl & NF_SEEDED) != 0u && (fl & NF_SOLID) != 0u) { pf |= PF_SEEDED; }
    if ((fl & NF_WEIGHED) != 0u) { pf |= PF_WEIGHED; }
    atomicOr(&W[fi(F_PF, p)], pf);
    minf(fi(F_ZC, p), nf(N_Z0, i));
  }
}


// ---- seedList: a thread a hanging run — the seeded pieces' runs listed (every single-workgroup phase walks these, not
// the window); a seeded piece reaching the window's side asks for a bigger window (JB13: judge.ts grows it to the
// margin — at the margin the side holds, as before) ----
@compute @workgroup_size(64)
fn seedList(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= hangN()) { return; }
  let i = nu(F_HANG, t);
  if (P.pad1 == 0u && (ld(fi(F_PF, nu(N_PIECE, i))) & PF_SEEDED) == 0u) { return; }
  nst(F_SEEDL, atomicAdd(&W[cnt(C_SEEDN)], 1u), i);
  if ((nu(N_EFL, i) & NF_WINEDGE) != 0u) { atomicOr(&O[O_GROW], 1u); }
}

@compute @workgroup_size(256)
fn judge1(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt == 1u) { return; }
  // (only the seeded pieces' runs from here on: seedList's — the whole window's with P.pad1)
  if (lid == 0u) { wgL[0] = seedN(); }
  let H = uniformCount(0u);
  let gW = 256u;
  if (lid == 0u) { st(cnt(C_LIST), 0u); st(lvl(1u), 0u); }
  workgroupBarrier();
  storageBarrier();

  if (P.stopAt == 2u) { return; }
  // 2 — flood: frontier by frontier from what holds (level 1: joined to a standing run, or at an edge) — each run
  // visited once, the levels laid out in order as they're found (F_ORDER: level k at [lvl(k), lvl(k + 1))); only
  // the seeded pieces (a frontier never leaves its piece)
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (P.pad1 == 0u && (ld(fi(F_PF, nu(N_PIECE, i))) & PF_SEEDED) == 0u) { continue; }
    var held = edgeHeld(i);
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var r = 0u; r < 16u; r++) {
        if ((nb.y & (1u << r)) == 0u) { continue; }
        if (standsN(nb.x + r)) { held = true; }
      }
    }
    if (held) {
      st(fi(F_DIST, i), 1u);
      nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), i);
    }
  }
  workgroupBarrier();
  storageBarrier();
  var loK = 0u;
  var k = 1u;
  loop {
    if (lid == 0u) { wgL[1] = ld(cnt(C_LIST)); }
    let hiK = uniformCount(1u);
    if (hiK == loK) { break; }
    if (k + 2u >= P.maxLevels) {
      if (lid == 0u) { st(cnt(C_OVER), 2u); }
      break;
    }
    if (lid == 0u) { st(lvl(k + 1u), hiK); }
    for (var t = loK + lid; t < hiK; t += gW) {
      let i = nu(F_ORDER, t);
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var r = 0u; r < 16u; r++) {
          if ((nb.y & (1u << r)) == 0u) { continue; }
          let j = nb.x + r;
          if (standsN(j)) { continue; }
          if (cas(fi(F_DIST, j), INF_D, k + 1u)) { nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), j); }
        }
      }
    }
    loK = hiK;
    k++;
    // (every append of this frontier in before the next is counted)
    workgroupBarrier();
    storageBarrier();
  }
  let maxD = k - 1u;
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    // (the distances as plain words from here on)
    let d = ld(fi(F_DIST, i));
    N[N_DIST * P.ncap + i] = d;
    if (d < INF_D) { atomicOr(&W[fi(F_PF, nu(N_PIECE, i))], PF_REACHED); }
  }
  workgroupBarrier();
  storageBarrier();
  // the judged runs (a seeded, weighed piece the flood reached: the only ones a verdict can come from), by level
  // again, each given its pairs (a slot a level it reaches)
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    let d = nu(N_DIST, i);
    let p = nu(N_PIECE, i);
    if (d == 1u) { nst(N_ROOT, i, p); }
    let pfl = ld(fi(F_PF, p));
    if (d != INF_D && (pfl & (PF_SEEDED | PF_WEIGHED)) == (PF_SEEDED | PF_WEIGHED)) {
      atomicAdd(&W[lvl2(d)], 1u);
      nst(N_PBASE, i, atomicAdd(&W[cnt(C_PAIRS)], d));
    } else {
      nst(N_PBASE, i, NONE);
    }
  }
  workgroupBarrier();
  storageBarrier();
  if (lid == 0u) {
    var sum = 0u;
    for (var k = 0u; k <= maxD + 1u; k++) {
      let c = ld(lvl2(k));
      st(lvl2(k), sum);
      st(lvlCur(k), sum);
      sum += c;
    }
    st(cnt(C_H2), sum);
    // (stats: the window's hanging runs, the judged ones, the deepest level)
    atomicStore(&O[O_TIME], hangN());
    atomicStore(&O[O_TIME + 1u], sum);
    atomicStore(&O[O_TIME + 2u], maxD);
    atomicStore(&O[O_TIME + 3u], ld(cnt(C_PAIRS)));
    atomicStore(&O[O_TIME + 4u], NONE);
    atomicStore(&O[O_TIME + 5u], NONE);
    if (ld(cnt(C_PAIRS)) > P.pcap && ld(cnt(C_OVER)) == 0u) { st(cnt(C_OVER), 3u); }
    // (mode 2: the pairs for a deep piece, the level pass in one workgroup for shallow ones — both exact; the level
    // pass's fixed cost is lower when there are few levels: the atlas's cuts, D 3–5, measured round 120b)
    let usePairs = P.mode == 1u || (P.mode == 2u && maxD >= P.autoD);
    st(cnt(C_MODE), select(0u, 1u, usePairs));
    let go = usePairs && ld(cnt(C_OVER)) == 0u;
    IND[0] = select(0u, (sum + 63u) / 64u, go);
    IND[1] = select(0u, maxD, go);
    IND[2] = 1u;
    // (the checks: a thread a root pair, at most a pair each)
    IND[4] = select(0u, (ld(cnt(C_PAIRS)) + 63u) / 64u, go);
    IND[5] = 1u;
    IND[6] = 1u;
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (nu(N_PBASE, i) == NONE) { continue; }
    let q = colXY(nu(N_COL, i));
    atomicMin(&O[O_TIME + 4u], u32(q.x));
    atomicMin(&O[O_TIME + 5u], u32(q.y));
    atomicMax(&O[O_TIME + 6u], u32(q.x));
    atomicMax(&O[O_TIME + 7u], u32(q.y));
    nst(N_ORDER2, atomicAdd(&W[lvlCur(nu(N_DIST, i))], 1u), i);
  }

  if (lid == 0u) { st(cnt(C_MAXD2), maxD); }
}

// ---- the pairs (mode 1): every level's sections at once, on the whole GPU — a thread a pair, (x: a run of the
// judged ones ≥ that level, y: the level − 1), dispatched indirectly (IND). Union-find on the pairs (a pair joined to
// the pairs of its joined runs at the same level) is concurrent and lock-free, so a constant number of dispatches
// gives every level's components: no pass a level ----
/** the pair at this invocation: (run, level, pair), or the run NONE */
fn pairAt(gid: vec3<u32>) -> vec3<u32> {
  let k = gid.y + 1u;
  let t = ld(lvl2(k)) + gid.x;
  if (ld(cnt(C_OVER)) != 0u || t >= ld(cnt(C_H2))) { return vec3<u32>(NONE, 0u, 0u); }
  let v = nu(N_ORDER2, t);
  return vec3<u32>(v, k, pairOf(v, k));
}

@compute @workgroup_size(64)
fn pairsInit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  st(pw(P_PAR, a.z), a.z);
  st(pw(P_NODE, a.z), a.x);
  stf(pw(P_STR, a.z), 1e9);
  stf(pw(P_TS, a.z), 1e9);
  for (var d = 0u; d < 6u; d++) { stf(pw(P_D + d * 5u + 3u, a.z), 1e9); }
}

@compute @workgroup_size(64)
fn pairsUnite(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  let v = a.x;
  let k = a.y;
  for (var d = 0u; d < 6u; d++) {
    let nb = nbrBase(v, d);
    for (var r = 0u; r < 16u; r++) {
      if ((nb.y & (1u << r)) == 0u) { continue; }
      let j = nb.x + r;
      let dj = nu(N_DIST, j);
      if (j < v && dj >= k && dj != INF_D) { uniteAt(pw(P_PAR, 0u), a.z, pairOf(j, k)); }
    }
  }
}

@compute @workgroup_size(64)
fn pairsFind(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  let r = findAt(pw(P_PAR, 0u), a.z);
  st(pw(P_RT, a.z), r);
  if (r == a.z) { st(pw(P_LIST, atomicAdd(&W[cnt(C_PROOTS)], 1u)), r); }
}

// (a workgroup's masses gathered by root first: a level's pairs lie together, nearly all in one component)
var<workgroup> hk: array<atomic<u32>, 64>;
// (a slot's 32 words: mass and its moments (4), the faces' sums (9), per direction Σh, Σh·zc, ΣI (18))
var<workgroup> hv: array<atomic<u32>, 2048>;
fn haddf(i: u32, v: f32) {
  var old = atomicLoad(&hv[i]);
  loop {
    let r = atomicCompareExchangeWeak(&hv[i], old, bitcast<u32>(bitcast<f32>(old) + v));
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}

@compute @workgroup_size(64)
fn pairsSum(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  atomicStore(&hk[lid], NONE);
  for (var q = 0u; q < 32u; q++) { atomicStore(&hv[lid * 32u + q], 0u); }
  workgroupBarrier();
  let a = pairAt(gid);
  if (a.x != NONE) {
    let v = a.x;
    let k = a.y;
    let r = ld(pw(P_RT, a.z));
    let m = nf(N_MASS, v);
    let pos = cellPos(colXY(nu(N_COL, v)));
    let vals = array<f32, 4>(m, m * pos.x, m * pos.y, nf(N_MZ, v));
    var slot = NONE;
    let h = (r * 2654435761u) >> 26u;
    for (var probe = 0u; probe < 8u && slot == NONE; probe++) {
      let sl = (h + probe) & 63u;
      loop {
        let o = atomicCompareExchangeWeak(&hk[sl], NONE, r);
        if (o.exchanged || o.old_value == r) { slot = sl; break; }
        if (o.old_value != NONE) { break; }
      }
    }
    for (var q = 0u; q < 4u; q++) {
      if (slot != NONE) { haddf(slot * 32u + q, vals[q]); } else { addf(pw(P_M + q, r), vals[q]); }
    }
    // the faces: a run's own level only (its faces to the runs a step nearer)
    if (k == nu(N_DIST, v)) {
      for (var q = 0u; q < 9u; q++) {
        let x = nf(N_FU + q, v);
        if (slot != NONE) { haddf(slot * 32u + 4u + q, x); } else { addf(pw(P_U + q, r), x); }
      }
      minf(pw(P_STR, r), nf(N_FSTR, v));
      minf(pw(P_TS, r), nf(N_FTS, v));
      if (nu(N_FINF, v) != 0u) { st(pw(P_INF, r), 1u); }
      for (var d = 0u; d < 6u; d++) {
        let sh = nf(N_FD + d * 5u, v);
        if (sh <= 0.0) { continue; }
        for (var q = 0u; q < 3u; q++) {
          let x = nf(N_FD + d * 5u + q, v);
          if (slot != NONE) { haddf(slot * 32u + 13u + d * 3u + q, x); } else { addf(pw(P_D + d * 5u + q, r), x); }
        }
        minf(pw(P_D + d * 5u + 3u, r), nf(N_FD + d * 5u + 3u, v));
        maxf(pw(P_D + d * 5u + 4u, r), nf(N_FD + d * 5u + 4u, v));
      }
    }
  }
  workgroupBarrier();
  let key = atomicLoad(&hk[lid]);
  if (key != NONE) {
    for (var q = 0u; q < 13u; q++) {
      let x = bitcast<f32>(atomicLoad(&hv[lid * 32u + q]));
      if (x != 0.0) { addf(pw(select(P_U + q - 4u, P_M + q, q < 4u), key), x); }
    }
    for (var d = 0u; d < 6u; d++) {
      for (var q = 0u; q < 3u; q++) {
        let x = bitcast<f32>(atomicLoad(&hv[lid * 32u + 13u + d * 3u + q]));
        if (x != 0.0) { addf(pw(P_D + d * 5u + q, key), x); }
      }
    }
  }
}

/** a thread a component at a level (a root pair): its section checked, as judge2's level pass does (phase 4 g) */
@compute @workgroup_size(64)
fn checks(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!pairsMode() || ld(cnt(C_OVER)) != 0u || gid.x >= ld(cnt(C_PROOTS))) { return; }
  let r = ld(pw(P_LIST, gid.x));
  let v = ld(pw(P_NODE, r));
  let k = r - nu(N_PBASE, v) + 1u;
  let piece = nu(N_PIECE, v);
  let M = ldf(pw(P_M, r));
  let com = vec2<f32>(ldf(pw(P_M + 1u, r)), ldf(pw(P_M + 2u, r))) / max(M, 1e-6);
  let A0 = ldf(pw(P_U, r));
  let cen = vec2<f32>(ldf(pw(P_U + 1u, r)), ldf(pw(P_U + 2u, r))) / max(A0, 1e-6);
  let lvv = com - cen;
  let L = length(lvv);
  let u = select(vec2<f32>(1.0, 0.0), lvv / max(L, 1e-6), L > 1e-4);
  let meet = length(vec2<f32>(ldf(pw(P_U + 3u, r)), ldf(pw(P_U + 4u, r)))) < P.meet * max(A0, 1e-6);
  let inf = ld(pw(P_INF, r)) != 0u;
  // (level 1: the piece's own sums, where the thrust check and the neck read them)
  if (k == 1u) {
    for (var q = 0u; q < 4u; q++) { st(fi(F_AM + q, piece), ld(pw(P_M + q, r))); }
    for (var q = 0u; q < 9u; q++) { st(fi(F_A0 + q, piece), ld(pw(P_U + q, r))); }
    st(fi(F_INF, piece), select(0u, 1u, inf));
    st(fi(F_SSTR, piece), ld(pw(P_STR, r)));
    nst(F_ROOTS, atomicAdd(&W[cnt(C_ROOTS)], 1u), piece);
  }
  if (inf || meet) { return; }
  oadd(O_WHY + 10u, 1u);
  let s = min(ldf(pw(P_STR, r)), 1e3);
  let ts = min(ldf(pw(P_TS, r)), 1e3);
  var Ap = 0.0;
  var Apz = 0.0;
  var Ip = 0.0;
  var zlo = 1e9;
  var zhi = 0.0;
  for (var d = 0u; d < 6u; d++) {
    let sh = ldf(pw(P_D + d * 5u, r));
    let w = EDGE * abs(dot(DIRV[d], u));
    if (sh <= 0.0 || w <= 1e-4) { continue; }
    Ap += w * sh;
    Apz += w * ldf(pw(P_D + d * 5u + 1u, r));
    Ip += w * ldf(pw(P_D + d * 5u + 2u, r));
    zlo = min(zlo, ldf(pw(P_D + d * 5u + 3u, r)));
    zhi = max(zhi, ldf(pw(P_D + d * 5u + 4u, r)));
  }
  let As = select(0.6366 * A0, Ap, L > 1e-3);
  var kind = 0u;
  if (M > P.shear * s * As) { kind = K_SHEAR; }
  if (kind == 0u && Ap > 1e-6) {
    let zb = Apz / Ap;
    let I = max(Ip - Ap * zb * zb, 0.0);
    let c = max(zhi - zb, zb - zlo);
    let S = I / max(c, 1e-3);
    if (M * L > P.tensile * ts * S) { kind = K_BEND; }
  } else if (kind == 0u && L > 1e-3) { kind = K_BEND; }
  if (kind == 0u) { return; }
  st(pw(P_KIND, r), kind);
  stf(pw(P_PIVX, r), cen.x);
  stf(pw(P_PIVY, r), cen.y);
  stf(pw(P_PIVZ, r), select(zlo, 0.0, zlo >= 1e9));
  stf(pw(P_AXX, r), -u.y);
  stf(pw(P_AXY, r), u.x);
  atomicOr(&W[fi(F_PF, piece)], PF_FAILED);
}

/** a thread a pair: a run in a failed component goes; the runs of a failed section's own level are its cut */
@compute @workgroup_size(64)
fn marks(@builtin(global_invocation_id) gid: vec3<u32>) {
  let a = pairAt(gid);
  if (a.x == NONE) { return; }
  let r = ld(pw(P_RT, a.z));
  if (ld(pw(P_KIND, r)) == 0u) { return; }
  st(fi(F_DEAD, a.x), 1u);
  if (a.y == nu(N_DIST, a.x)) { st(fi(F_CUT, a.x), r + 1u); }
}

