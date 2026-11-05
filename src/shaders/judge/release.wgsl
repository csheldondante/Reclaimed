// release.wgsl: judge3 (the release), freedUnite, judge4 (the freed pieces, necks, records) (part 5 of 5 of the judgeWgsl shader, joined in order by judge.ts)
// ---- judge3: one workgroup — the release (mode 0: a flood that doesn't cross a failed section; mode 1: the marks) ----
@compute @workgroup_size(256)
fn judge3(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt >= 1u && P.stopAt <= 4u) { return; }
  if (lid == 0u) { wgL[0] = seedN(); }
  let H = uniformCount(0u);
  let gW = 256u;
  if (P.stopAt == 6u) { return; }
  // 6 — release: what still reaches what holds without crossing a failed section (frontier by frontier, F_ORDER
  // reused for the frontiers). Mode 1: the same runs, from the marks — a run is cut off from what holds it exactly
  // when a component it's in at some level failed (that component's only ties to what holds it are its section's
  // faces), or its piece's thrust line didn't fit
  if (pairsMode()) {
    for (var t = lid; t < H; t += gW) {
      let i = nu(F_SEEDL, t);
      let gone = ld(fi(F_DEAD, i)) != 0u || (ld(fi(F_PF, nu(N_PIECE, i))) & PF_ARCHFAIL) != 0u;
      st(fi(F_REACH, i), select(0u, 1u, nu(N_DIST, i) != INF_D && !gone));
    }
  }
  if (lid == 0u) { st(cnt(C_LIST), 0u); }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (!pairsMode() && nu(N_DIST, i) == 1u && ld(fi(F_CUT, i)) == 0u) {
      st(fi(F_REACH, i), 1u);
      nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), i);
    }
  }
  workgroupBarrier();
  storageBarrier();
  var lo6 = 0u;
  loop {
    if (lid == 0u) { wgL[1] = ld(cnt(C_LIST)); }
    let hi6 = uniformCount(1u);
    if (hi6 == lo6) { break; }
    for (var t = lo6 + lid; t < hi6; t += gW) {
      let i = nu(F_ORDER, t);
      let di = nu(N_DIST, i);
      let ci = ld(fi(F_CUT, i)) != 0u;
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var rr = 0u; rr < 16u; rr++) {
          if ((nb.y & (1u << rr)) == 0u) { continue; }
          let j = nb.x + rr;
          let dj = nu(N_DIST, j);
          if (dj == 0u || dj == INF_D || ld(fi(F_REACH, j)) != 0u) { continue; }
          // (a cut face: from a failed section's run to the run a step nearer)
          if (ci && di == dj + 1u) { continue; }
          if (ld(fi(F_CUT, j)) != 0u && dj == di + 1u) { continue; }
          if (cas(fi(F_REACH, j), 0u, 1u)) { nst(F_ORDER, atomicAdd(&W[cnt(C_LIST)], 1u), j); }
        }
      }
    }
    lo6 = hi6;
    workgroupBarrier();
    storageBarrier();
  }

  if (P.stopAt == 7u) { return; }
}

// ---- freedUnite: a thread a hanging run — the freed runs' pieces (lock-free union-find, the whole GPU) ----
@compute @workgroup_size(64)
fn freedUnite(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (P.stopAt >= 1u && P.stopAt <= 7u) { return; }
  // 7 — the freed runs (of a seeded piece, held nowhere now) and their pieces
  let t = gid.x;
  if (t >= seedN()) { return; }
  {
    let i = nu(F_SEEDL, t);
    if (!freed(i)) { return; }
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var rr = 0u; rr < 16u; rr++) {
        if ((nb.y & (1u << rr)) == 0u) { continue; }
        let j = nb.x + rr;
        if (j < i && !standsN(j) && freed(j)) { unite(F_FR, i, j); }
      }
    }
  }
}

// ---- judge4: one workgroup — the freed pieces out, the necks, the records ----
@compute @workgroup_size(256)
fn judge4(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt >= 1u && P.stopAt <= 4u) { return; }
  if (lid == 0u) { wgL[0] = seedN(); }
  let H = uniformCount(0u);
  let gW = 256u;
  if (P.stopAt == 7u) { return; }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (!freed(i)) { continue; }
    let r = find(F_FR, i);
    addf(fi(F_VOL, r), nf(N_Z1, i) - nf(N_Z0, i));
    if (ld(fi(F_CUT, i)) != 0u) { atomicMin(&W[fi(F_MINK, r)], nu(N_DIST, i)); }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (!freed(i)) { continue; }
    let r = find(F_FR, i);
    if (ld(fi(F_CUT, i)) != 0u && nu(N_DIST, i) == ld(fi(F_MINK, r))) { st(fi(F_TIPSRC, r), ld(fi(F_CUT, i)) - 1u); }
    if (r == i) {
      // a piece out: its kind, its hinge
      if (ldf(fi(F_VOL, r)) >= P.minBody) {
        let o = atomicAdd(&O[O_PIECES], 1u);
        if (o >= MAX_PIECES) { atomicOr(&O[O_OVER], 1u); } else { st(fi(F_OUT, r), o); }
      }
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < H; t += gW) {
    let r = nu(F_SEEDL, t);
    if (!freed(r) || find(F_FR, r) != r) { continue; }
    let o = ld(fi(F_OUT, r));
    let src = ld(fi(F_TIPSRC, r));
    var kind = 0u;
    if (src != NONE) { kind = ld(pw(P_KIND, src)); }
    let vol = ldf(fi(F_VOL, r));
    if (o == NONE) {
      oadd(O_WHY + 9u, u32(vol * 1000.0));
      continue;
    }
    // why: free, shear, bend, arch (fits or crushes) — fracture.ts Fracture.why's load is the shear and bend
    if (kind == 0u) { oadd(O_WHY + 0u, 1u); } else if (kind == K_SHEAR) { oadd(O_WHY + 1u, 1u); } else if (kind == K_BEND) { oadd(O_WHY + 2u, 1u); } else { oadd(O_WHY + 3u, 1u); }
    let pb = O_PIECE0 + o * PIECE_W;
    atomicStore(&O[pb], kind);
    // (a hinge for a section that bent or sheared: P.flags bit 0, opts.rotate)
    let tip = (P.flags & 1u) != 0u && (kind == K_BEND || kind == K_SHEAR);
    atomicStore(&O[pb + 1u], select(0u, 1u, tip));
    if (tip) {
      atomicStore(&O[pb + 2u], ld(pw(P_PIVX, src)));
      atomicStore(&O[pb + 3u], ld(pw(P_PIVY, src)));
      atomicStore(&O[pb + 4u], ld(pw(P_PIVZ, src)));
      atomicStore(&O[pb + 5u], ld(pw(P_AXX, src)));
      atomicStore(&O[pb + 6u], ld(pw(P_AXY, src)));
    }
    atomicStore(&O[pb + 7u], bitcast<u32>(vol));
  }
  workgroupBarrier();
  storageBarrier();

  if (P.stopAt == 8u) { return; }
  // 8 — the neck: a seeded, weighed piece that held, on the standing columns under it (fracture.ts neck). A standing
  // run two pieces reach goes with the lesser piece (atomicMin, then listed once): the same verdict every time —
  // the first claim winning was a race (round 120's equality tests caught a cave judged two ways)
  if (lid == 0u) { st(cnt(C_LIST), 0u); st(cnt(C_NECK), 0u); }
  workgroupBarrier();
  storageBarrier();
  {
    for (var t = lid; t < H; t += gW) {
      let i = nu(F_SEEDL, t);
      let p = nu(N_PIECE, i);
      let pf = ld(fi(F_PF, p));
      if ((pf & (PF_SEEDED | PF_WEIGHED | PF_REACHED)) != (PF_SEEDED | PF_WEIGHED | PF_REACHED) || (pf & PF_FAILED) != 0u) { continue; }
      if (p == i) { nst(F_ROOTS, atomicAdd(&W[cnt(C_LIST)], 1u), p); }
      // the standing runs it's joined to (hop 1)
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var rr = 0u; rr < 16u; rr++) {
          if ((nb.y & (1u << rr)) == 0u) { continue; }
          let j = nb.x + rr;
          if (!standsN(j)) { continue; }
          // (one phase: every claimant this hop takes the min — order-free — and the first lists it)
          let hj = ld(fi(F_HOP, j));
          if (hj == 0u || hj == 1u) { atomicMin(&W[fi(F_NECK, j)], p); }
          if (cas(fi(F_HOP, j), 0u, 1u)) { st(fi(F_NECKL, atomicAdd(&W[cnt(C_NECK)], 1u)), j); }
        }
      }
    }
    workgroupBarrier();
    storageBarrier();
  }
  // on through the standing runs joined above the piece's lowest point, NECK_R columns (past it: keyed into the land)
  // (the runs are listed hop by hop: this hop's are the ones listed since the last)
  var loH = 0u;
  for (var hop = 1u; hop <= P.neckR; hop++) {
    if (lid == 0u) { wgL[0] = ld(cnt(C_NECK)); }
    let nN = uniformCount(0u);
    {
      for (var t = loH + lid; t < nN; t += gW) {
        let j = ld(fi(F_NECKL, t));
        if (ld(fi(F_HOP, j)) != hop) { continue; }
        let p = ld(fi(F_NECK, j));
        if (edgeHeld(j)) {
          atomicOr(&W[fi(F_PF, p)], PF_KEYED);
          if ((nu(N_EFL, j) & NF_WINEDGE) != 0u) { atomicOr(&O[O_GROW], 1u); }
          continue;
        }
        let zc = ldf(fi(F_ZC, p));
        for (var d = 0u; d < 6u; d++) {
          let nb = nbrBase(j, d);
          for (var rr = 0u; rr < 16u; rr++) {
            if ((nb.y & (1u << rr)) == 0u) { continue; }
            let m = nb.x + rr;
            if (!standsN(m)) { continue; }
            // joined above zc
            let o = min(nf(N_SH1, j), nf(N_SH1, m)) - max(zc, max(nf(N_SH0, j), nf(N_SH0, m)));
            if (o < P.overlap) { continue; }
            if (hop == P.neckR) {
              atomicOr(&W[fi(F_PF, p)], PF_KEYED);
              continue;
            }
            // (a run listed at an earlier hop keeps its piece; every claimant this hop takes the min, the first lists it)
            let hm = ld(fi(F_HOP, m));
            if (hm == 0u || hm == hop + 1u) { atomicMin(&W[fi(F_NECK, m)], p); }
            if (cas(fi(F_HOP, m), 0u, hop + 1u)) { st(fi(F_NECKL, atomicAdd(&W[cnt(C_NECK)], 1u)), m); }
          }
        }
      }
      workgroupBarrier();
      storageBarrier();
    }
    // (nothing new this hop: the leg is whole — the hops past it would find nothing)
    loH = nN;
    if (lid == 0u) { wgL[1] = ld(cnt(C_NECK)); }
    if (uniformCount(1u) == nN) { break; }
  }
  if (lid == 0u) { wgL[0] = ld(cnt(C_LIST)); wgL[1] = ld(cnt(C_NECK)); }
  let nP = uniformCount(0u);
  let nN = workgroupUniformLoad(&wgL[1]);
  // the checks in parallel: the leg's sums (a thread a standing run), then each piece's middle and lever, then its
  // section's second moment and its hull's reach in 24 directions (a thread a standing run), then the verdict
  for (var t = lid; t < nP; t += gW) {
    st(fi(F_KS, nu(F_ROOTS, t)), FINF);
    st(fi(F_KT, nu(F_ROOTS, t)), FINF);
  }
  workgroupBarrier();
  storageBarrier();
  // (a thread's sums kept while its runs are one piece's — nearly always — and put once: not every leg run's six
  // adds on the same words)
  {
    var cur = NONE;
    var acc = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1e9, 1e9);
    for (var t = lid; t <= nN + gW; t += gW) {
      var p = NONE;
      var j = 0u;
      if (t < nN) {
        j = ld(fi(F_NECKL, t));
        p = ld(fi(F_NECK, j));
        if ((ld(fi(F_PF, p)) & PF_KEYED) != 0u) { p = NONE; }
      }
      if (p != cur || t >= nN) {
        if (cur != NONE) {
          for (var q = 0u; q < 6u; q++) { addf(fi(F_KM + q, cur), acc[q]); }
          minf(fi(F_KS, cur), acc[6]);
          minf(fi(F_KT, cur), acc[7]);
        }
        acc = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1e9, 1e9);
        cur = p;
      }
      if (t >= nN) { break; }
      if (p == NONE) { continue; }
      let zc = ldf(fi(F_ZC, p));
      let z0 = nf(N_Z0, j);
      let z1 = nf(N_Z1, j);
      let m = nf(N_MASS, j) * max(z1 - zc, 0.0) / max(z1 - z0, 1e-6);
      let q = cellPos(colXY(nu(N_COL, j)));
      acc[0] += m;
      acc[1] += m * q.x;
      acc[2] += m * q.y;
      acc[3] += ROW_H;
      acc[4] += ROW_H * q.x;
      acc[5] += ROW_H * q.y;
      acc[6] = min(acc[6], select(nf(N_STR, j), 1e9, (nu(N_FLAGS, j) & NF_BED) != 0u));
      acc[7] = min(acc[7], select(nf(N_TS, j), 1e9, (nu(N_FLAGS, j) & NF_BED) != 0u));
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < nP; t += gW) {
    let p = nu(F_ROOTS, t);
    let A = ldf(fi(F_KA, p));
    let M = ldf(fi(F_AM, p)) + ldf(fi(F_KM, p));
    if (A <= 0.0 || M <= 0.0) { continue; }
    let com = vec2<f32>(ldf(fi(F_AX, p)) + ldf(fi(F_KMX, p)), ldf(fi(F_AY, p)) + ldf(fi(F_KMY, p))) / M;
    let cen = vec2<f32>(ldf(fi(F_KCX, p)), ldf(fi(F_KCY, p))) / A;
    let v = com - cen;
    let L = length(v);
    let uu = select(vec2<f32>(1.0, 0.0), v / max(L, 1e-6), L > 1e-4);
    // (the middle and the lever's direction, for the next pass: F_PIV*, F_AX* hold them till the verdict)
    stf(fi(F_PIVX, p), cen.x);
    stf(fi(F_PIVY, p), cen.y);
    stf(fi(F_AXX, p), uu.x);
    stf(fi(F_AXY, p), uu.y);
  }
  workgroupBarrier();
  storageBarrier();
  {
    var cur = NONE;
    var ki = 0.0;
    var kc = 0.0;
    var sup = array<f32, 25>();
    for (var a = 0u; a < 25u; a++) { sup[a] = 0.0; }
    for (var t = lid; t <= nN + gW; t += gW) {
      var p = NONE;
      var j = 0u;
      if (t < nN) {
        j = ld(fi(F_NECKL, t));
        p = ld(fi(F_NECK, j));
        if ((ld(fi(F_PF, p)) & PF_KEYED) != 0u) { p = NONE; }
      }
      if (p != cur || t >= nN) {
        if (cur != NONE) {
          addf(fi(F_KI, cur), ki);
          maxf(fi(F_KC, cur), kc);
          // (reaches offset by 1e4: positive, so they order as their bits)
          maxf(fi(F_SUPU, cur), sup[24]);
          for (var a = 0u; a < 24u; a++) { maxf(fi(F_SUP + a, cur), sup[a]); }
        }
        ki = 0.0;
        kc = 0.0;
        for (var a = 0u; a < 25u; a++) { sup[a] = 0.0; }
        cur = p;
      }
      if (t >= nN) { break; }
      if (p == NONE) { continue; }
      let q = cellPos(colXY(nu(N_COL, j)));
      let cen = vec2<f32>(ldf(fi(F_PIVX, p)), ldf(fi(F_PIVY, p)));
      let uu = vec2<f32>(ldf(fi(F_AXX, p)), ldf(fi(F_AXY, p)));
      let dd = dot(q - cen, uu);
      ki += ROW_H * dd * dd + 0.0601;
      kc = max(kc, abs(dd) + 0.5);
      sup[24] = max(sup[24], dot(q, uu) + 1e4);
      for (var a = 0u; a < 24u; a++) {
        let ang = f32(a) * 0.2617994;
        sup[a] = max(sup[a], dot(q, vec2<f32>(cos(ang), sin(ang))) + 1e4);
      }
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < nP; t += gW) {
    let p = nu(F_ROOTS, t);
    if ((ld(fi(F_PF, p)) & PF_KEYED) != 0u) { oadd(O_WHY + 8u, 1u); continue; }
    let zc = ldf(fi(F_ZC, p));
    let A = ldf(fi(F_KA, p));
    let M = ldf(fi(F_AM, p)) + ldf(fi(F_KM, p));
    if (A <= 0.0 || M <= 0.0) { continue; }
    oadd(O_WHY + 7u, 1u);
    let s = min(ldf(fi(F_KS, p)), 1e3);
    let ts = min(ldf(fi(F_KT, p)), 1e3);
    let com = vec2<f32>(ldf(fi(F_AX, p)) + ldf(fi(F_KMX, p)), ldf(fi(F_AY, p)) + ldf(fi(F_KMY, p))) / M;
    let cen = vec2<f32>(ldf(fi(F_PIVX, p)), ldf(fi(F_PIVY, p)));
    let uu = vec2<f32>(ldf(fi(F_AXX, p)), ldf(fi(F_AXY, p)));
    let L = length(com - cen);
    // tipping: its centre of mass past the section's hull (its reach in 24 directions, each cell's own added)
    var worst = -1e9;
    var wn = vec2<f32>(1.0, 0.0);
    var wh = 0.0;
    for (var a = 0u; a < 24u; a++) {
      let ang = f32(a) * 0.2617994;
      let n = vec2<f32>(cos(ang), sin(ang));
      let h = ldf(fi(F_SUP + a, p)) - 1e4 + hexReach(n);
      let ex = dot(com, n) - h;
      if (ex > worst) { worst = ex; wn = n; wh = h; }
    }
    // the far side's pull: the moment about the section's middle over its modulus, less the weight on its area
    let S = ldf(fi(F_KI, p)) / max(ldf(fi(F_KC, p)), 0.5);
    var kind = 0u;
    if (worst > P.tipGive) { kind = K_TIP; } else if (M * L / S - M / A > P.tensile * ts) { kind = K_LEAN; } else if (M / A > P.crush * s) { kind = K_CRUSH; }
    if (kind == 0u) { continue; }
    atomicOr(&W[fi(F_PF, p)], PF_NECKFAIL);
    st(fi(F_KIND, p), kind);
    // the edge it turns over: past the hull, that side; leaning, the side its weight is on
    var n = wn;
    var h = wh;
    if (kind == K_LEAN) {
      n = uu;
      h = ldf(fi(F_SUPU, p)) - 1e4 + hexReach(n);
    }
    let piv = com - n * (dot(com, n) - h);
    stf(fi(F_PIVX, p), piv.x);
    stf(fi(F_PIVY, p), piv.y);
    stf(fi(F_PIVZ, p), zc);
    stf(fi(F_AXX, p), -n.y);
    stf(fi(F_AXY, p), n.x);
    let o = atomicAdd(&O[O_PIECES], 1u);
    if (o >= MAX_PIECES) { atomicOr(&O[O_OVER], 1u); continue; }
    st(fi(F_OUT, p), o);
    if (kind == K_TIP) { oadd(O_WHY + 5u, 1u); } else if (kind == K_LEAN) { oadd(O_WHY + 6u, 1u); } else { oadd(O_WHY + 4u, 1u); }
    let pb = O_PIECE0 + o * PIECE_W;
    let tip = (P.flags & 1u) != 0u && kind != K_CRUSH;
    atomicStore(&O[pb], kind);
    atomicStore(&O[pb + 1u], select(0u, 1u, tip));
    atomicStore(&O[pb + 2u], bitcast<u32>(piv.x));
    atomicStore(&O[pb + 3u], bitcast<u32>(piv.y));
    atomicStore(&O[pb + 4u], bitcast<u32>(zc));
    atomicStore(&O[pb + 5u], bitcast<u32>(-n.y));
    atomicStore(&O[pb + 6u], bitcast<u32>(n.x));
    atomicStore(&O[pb + 7u], bitcast<u32>(M));
  }
  workgroupBarrier();
  storageBarrier();

  // 9 — the records: every run that goes (its slots copied), and the leg a crushed piece leaves as rubble
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    if (freed(i)) {
      let o = ld(fi(F_OUT, find(F_FR, i)));
      record(i, o, 0.0, 1e9);
      continue;
    }
    let p = nu(N_PIECE, i);
    if ((ld(fi(F_PF, p)) & PF_NECKFAIL) != 0u) { record(i, ld(fi(F_OUT, p)), 0.0, 1e9); }
  }
  for (var t = lid; t < nN; t += gW) {
    let j = ld(fi(F_NECKL, t));
    let p = ld(fi(F_NECK, j));
    if ((ld(fi(F_PF, p)) & PF_NECKFAIL) == 0u) { continue; }
    let zc = ldf(fi(F_ZC, p));
    record(j, ld(fi(F_OUT, p)), zc, 1e9);
    if (ld(fi(F_KIND, p)) == K_CRUSH) { record(j, NONE, max(0.0, zc - 2.0), zc); }
  }
  if (lid == 0u) {
    atomicStore(&O[O_OVER + 1u], ld(cnt(C_OVER)));
  }
}

/** a run of a seeded piece that nothing holds now */
fn freed(i: u32) -> bool {
  if (ld(fi(F_REACH, i)) != 0u) { return false; }
  return (ld(fi(F_PF, nu(N_PIECE, i))) & PF_SEEDED) != 0u;
}

/** a record: the run's column, the piece it goes with (NONE: it crumbles), what of it goes [z0, z1), its slots */
fn record(i: u32, piece: u32, z0: f32, z1: f32) {
  let n = nu(N_SLN, i);
  let w = 6u + 4u * n;
  let at = atomicAdd(&O[O_RECW], w);
  if (O_REC0 + at + w > P.outCap) { atomicOr(&O[O_OVER], 2u); return; }
  let b = O_REC0 + at;
  let q = colXY(nu(N_COL, i));
  atomicStore(&O[b], u32(q.x));
  atomicStore(&O[b + 1u], u32(q.y));
  atomicStore(&O[b + 2u], piece);
  atomicStore(&O[b + 3u], bitcast<u32>(z0));
  atomicStore(&O[b + 4u], bitcast<u32>(z1));
  atomicStore(&O[b + 5u], n);
  let s0 = nu(N_SL0, i);
  for (var s = 0u; s < n; s++) {
    let v = slots[s0 + s];
    atomicStore(&O[b + 6u + 4u * s], v.x);
    atomicStore(&O[b + 7u + 4u * s], v.y);
    atomicStore(&O[b + 8u + 4u * s], v.z);
    atomicStore(&O[b + 9u + 4u * s], v.w);
  }
}

/** a meeting piece's axis: xy the dominant direction of its faces' normals, z 1 when they spread every way (a dome) */
fn archAxis(r: u32) -> vec3<f32> {
  let a = ldf(fi(F_TXX, r));
  let b = ldf(fi(F_TXY, r));
  let c = ldf(fi(F_TYY, r));
  let tr = 0.5 * (a + c);
  let disc = sqrt(max(0.25 * (a - c) * (a - c) + b * b, 0.0));
  let l1 = tr + disc;
  let l2 = tr - disc;
  var e = vec2<f32>(1.0, 0.0);
  if (abs(b) > 1e-6) { e = normalize(vec2<f32>(l1 - c, b)); } else if (c > a) { e = vec2<f32>(0.0, 1.0); }
  return vec3<f32>(e, select(0.0, 1.0, l2 > 0.5 * l1));
}

struct Span { mid: vec2<f32>, ax: vec2<f32>, L: f32, zs: f32, radial: bool }
/** the span between a meeting piece's springings (the faces to what holds it, level 1) */
fn span(r: u32) -> Span {
  var o: Span;
  let A0 = max(ldf(fi(F_A0, r)), 1e-6);
  let cen = vec2<f32>(ldf(fi(F_A0X, r)), ldf(fi(F_A0Y, r))) / A0;
  let ax = archAxis(r);
  o.ax = ax.xy;
  o.radial = ax.z > 0.5;
  // springing: the faces' mean foot
  o.zs = ldf(fi(F_ZB, r)) / A0;
  let Ap = ldf(fi(F_AP, r));
  if (o.radial || Ap <= 1e-6 || Ap >= A0 - 1e-6) {
    o.mid = cen;
    // (radial: the springings' mean distance from the middle)
    o.L = 2.0 * ldf(fi(F_RAD, r)) / A0;
  } else {
    let cp = vec2<f32>(ldf(fi(F_APZ, r)), ldf(fi(F_IP, r))) / Ap;
    let cm = (cen * A0 - cp * Ap) / (A0 - Ap);
    o.mid = 0.5 * (cp + cm);
    o.L = abs(dot(cp - cm, o.ax));
  }
  return o;
}

/** where a run lies along the span: 1 at the crown, 0 at the springings */
fn archQ(sp: Span, p: vec2<f32>) -> f32 {
  if (sp.radial) {
    let s = length(p - sp.mid) / max(0.5 * sp.L, 1e-3);
    return 1.0 - s * s;
  }
  let s = dot(p - sp.mid, sp.ax) / max(0.5 * sp.L, 1e-3);
  return 1.0 - s * s;
}
