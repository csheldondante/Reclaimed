// sections.wgsl: faces, judge2: the sections, thrust lines, release, pieces out (part 4 of 5 of the judgeWgsl shader, joined in order by judge.ts)
// ---- faces: a thread a hanging run — its faces to the runs a step nearer, summed once (the sections read them) -----
@compute @workgroup_size(64)
fn faces(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (P.stopAt == 1u || P.stopAt == 2u || P.stopAt == 3u) { return; }
  let t = gid.x;
  if (t >= seedN()) { return; }
  let i = nu(F_SEEDL, t);
  let k = nu(N_DIST, i);
  if (k == 0u || k == INF_D) { return; }
  var u = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var dd: array<f32, 30>;
  for (var q = 0u; q < 6u; q++) {
    dd[q * 5u] = 0.0;
    dd[q * 5u + 1u] = 0.0;
    dd[q * 5u + 2u] = 0.0;
    dd[q * 5u + 3u] = 1e9;
    dd[q * 5u + 4u] = 0.0;
  }
  var smin = 1e9;
  var tmin = 1e9;
  var inf = select(0u, 1u, k == 1u && edgeHeld(i));
  let pi = cellPos(colXY(nu(N_COL, i)));
  let a0 = nf(N_SH0, i);
  let a1 = nf(N_SH1, i);
  let si = nf(N_STR, i);
  let bi = (nu(N_FLAGS, i) & NF_BED) != 0u;
  for (var d = 0u; d < 6u; d++) {
    let nb = nbrBase(i, d);
    for (var rr = 0u; rr < 16u; rr++) {
      if ((nb.y & (1u << rr)) == 0u) { continue; }
      let j = nb.x + rr;
      if (nu(N_DIST, j) != k - 1u) { continue; }
      let z0 = max(a0, nf(N_SH0, j));
      let z1 = min(a1, nf(N_SH1, j));
      let h = max(z1 - z0, 0.0);
      let a = EDGE * h;
      let pf = 0.5 * (pi + cellPos(colXY(nu(N_COL, j))));
      let n = DIRV[d];
      u[0] += a;
      u[1] += a * pf.x;
      u[2] += a * pf.y;
      u[3] += a * n.x;
      u[4] += a * n.y;
      u[5] += a * n.x * n.x;
      u[6] += a * n.x * n.y;
      u[7] += a * n.y * n.y;
      u[8] += a * z0;
      smin = min(smin, min(si, nf(N_STR, j)));
      tmin = min(tmin, min(nf(N_TS, i), nf(N_TS, j)));
      if (bi || (nu(N_FLAGS, j) & NF_BED) != 0u) { inf = 1u; }
      if (h > 0.0) {
        let zc = 0.5 * (z0 + z1);
        dd[d * 5u] += h;
        dd[d * 5u + 1u] += h * zc;
        dd[d * 5u + 2u] += h * h * h / 12.0 + h * zc * zc;
        dd[d * 5u + 3u] = min(dd[d * 5u + 3u], z0);
        dd[d * 5u + 4u] = max(dd[d * 5u + 4u], z1);
      }
    }
  }
  for (var q = 0u; q < 9u; q++) { N[(N_FU + q) * P.ncap + i] = bitcast<u32>(u[q]); }
  N[N_FSTR * P.ncap + i] = bitcast<u32>(smin);
  N[N_FTS * P.ncap + i] = bitcast<u32>(tmin);
  N[N_FINF * P.ncap + i] = inf;
  for (var q = 0u; q < 30u; q++) { N[(N_FD + q) * P.ncap + i] = bitcast<u32>(dd[q]); }
}

// ---- judge2: one workgroup — the sections, the thrust lines, the release, the pieces out -----------------------------
@compute @workgroup_size(256)
fn judge2(@builtin(local_invocation_index) lid: u32) {
  wgLid = lid;
  if (P.stopAt >= 1u && P.stopAt <= 4u) { return; }
  if (lid == 0u) { wgL[0] = seedN(); wgL[2] = ld(cnt(C_MAXD2)); wgL[3] = ld(cnt(C_MODE)); }
  let H = uniformCount(0u);
  let maxD = workgroupUniformLoad(&wgL[2]);
  let viaPairs = workgroupUniformLoad(&wgL[3]) == 1u;
  let gW = 256u;
  // 4 — the sections, from the far end in: a pass a level (mode 0, the oracle; mode 1 has done them all at once)
  var nPrev = 0u;
  let levels = select(maxD, 0u, viaPairs);
  for (var k = levels; k >= 1u; k--) {
    let lo = ld(lvl(k));
    let hi = ld(lvl(k + 1u));
    let oldList = select(F_ROOTS2, F_ROOTS, (k & 1u) == 0u);
    let newList = select(F_ROOTS, F_ROOTS2, (k & 1u) == 0u);
    let oldC = select(C_ROOTS2, C_ROOTS, (k & 1u) == 0u);
    let newC = select(C_ROOTS, C_ROOTS2, (k & 1u) == 0u);
    let nOld = select(0u, nPrev, k < levels);
    // a: the level's runs start as their own components, their sums cleared
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      for (var f = F_AM; f <= F_ZMAX; f++) { st(fi(f, i), 0u); }
      st(fi(F_ZMIN, i), FINF);
      stf(fi(F_SSTR, i), 1e9);
      stf(fi(F_STS, i), 1e9);
    }
    for (var t = lid; t < nOld; t += gW) {
      let r = nu(oldList, t);
      for (var f = F_A0; f <= F_ZMAX; f++) { st(fi(f, r), 0u); }
      st(fi(F_ZMIN, r), FINF);
      stf(fi(F_SSTR, r), 1e9);
      stf(fi(F_STS, r), 1e9);
    }
    // b: joined to everything ≥ k out
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      for (var d = 0u; d < 6u; d++) {
        let nb = nbrBase(i, d);
        for (var r = 0u; r < 16u; r++) {
          if ((nb.y & (1u << r)) == 0u) { continue; }
          let j = nb.x + r;
          let dj = nu(N_DIST, j);
          if (dj >= k && dj < INF_D) { unite(F_LV, i, j); }
        }
      }
    }
    if (lid == 0u) { st(cnt(newC), 0u); }
    workgroupBarrier();
    storageBarrier();
    // d: the roots now (each given a slot of the workgroup's sums: its sections are summed there, not on one word of
    // storage every run of a front contends for)
    for (var t = lid; t < nOld; t += gW) {
      let j = nu(oldList, t);
      if (find(F_LV, j) == j) {
        let q = atomicAdd(&W[cnt(newC)], 1u);
        nst(newList, q, j);
        nst(F_SLOT, j, q);
      }
    }
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      let r = find(F_LV, i);
      N[N_ROOT * P.ncap + i] = r;
      if (r == i) {
        let q = atomicAdd(&W[cnt(newC)], 1u);
        nst(newList, q, i);
        nst(F_SLOT, i, q);
      }
    }
    // (every root listed before the count is read)
    workgroupBarrier();
    storageBarrier();
    if (lid == 0u) { wgL[0] = ld(cnt(newC)); }
    let nNew = uniformCount(0u);
    nPrev = nNew;
    // c: the sums carried — the level's runs their own, a component of the level before into its new root
    {
      var acc = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      var cur = NONE;
      for (var t = lo + lid; t < hi; t += gW) {
        let i = nu(F_ORDER, t);
        let r = nu(N_ROOT, i);
        if (r != cur) { put(cur, &acc, 4u, F_AM, 0u); cur = r; }
        let m = nf(N_MASS, i);
        let p = cellPos(colXY(nu(N_COL, i)));
        acc[0] += m;
        acc[1] += m * p.x;
        acc[2] += m * p.y;
        acc[3] += nf(N_MZ, i);
      }
      put(cur, &acc, 4u, F_AM, 0u);
    }
    for (var t = lid; t < nOld; t += gW) {
      let j = nu(oldList, t);
      let r = find(F_LV, j);
      if (r != j) {
        addf(fi(F_AM, r), ldf(fi(F_AM, j)));
        addf(fi(F_AX, r), ldf(fi(F_AX, j)));
        addf(fi(F_AY, r), ldf(fi(F_AY, j)));
        addf(fi(F_AZ, r), ldf(fi(F_AZ, j)));
      }
    }
    // e: the section, unprojected — the faces from the level's runs to those a step nearer (or what holds them)
    {
      var acc = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      var cur = NONE;
      var smin = 1e9;
      var tmin = 1e9;
      for (var t = lo + lid; t < hi; t += gW) {
        let i = nu(F_ORDER, t);
        let r = nu(N_ROOT, i);
        if (r != cur) {
          put(cur, &acc, 9u, F_A0, 4u);
          if (cur != NONE && smin < 1e9) { minf(fi(F_SSTR, cur), smin); }
          if (cur != NONE && tmin < 1e9) { minf(fi(F_STS, cur), tmin); }
          smin = 1e9;
          tmin = 1e9;
          cur = r;
        }
        for (var q = 0u; q < 9u; q++) { acc[q] += nf(N_FU + q, i); }
        smin = min(smin, nf(N_FSTR, i));
        tmin = min(tmin, nf(N_FTS, i));
        if (nu(N_FINF, i) != 0u) { st(fi(F_INF, r), 1u); }
      }
      put(cur, &acc, 9u, F_A0, 4u);
      if (cur != NONE && smin < 1e9) { minf(fi(F_SSTR, cur), smin); }
      if (cur != NONE && tmin < 1e9) { minf(fi(F_STS, cur), tmin); }
    }
    workgroupBarrier();
    wflush(newList, nNew, 13u, F_AM, 0u);
    // f: the section projected across the lever (a face's width as seen along it), for one held from one side
    {
      var acc = array<f32, 9>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      var cur = NONE;
      var zlo = 1e9;
      var zhi = 0.0;
      var lv: Lever;
      for (var t = lo + lid; t < hi; t += gW) {
        let i = nu(F_ORDER, t);
        let r = nu(N_ROOT, i);
        if (r != cur) {
          put(cur, &acc, 3u, F_AP, 13u);
          if (cur != NONE && zlo < 1e9) { minf(fi(F_ZMIN, cur), zlo); maxf(fi(F_ZMAX, cur), zhi); }
          zlo = 1e9;
          zhi = 0.0;
          cur = r;
          lv = leverOf(r);
        }
        if (lv.meet) { continue; }
        for (var d = 0u; d < 6u; d++) {
          let sh = nf(N_FD + d * 5u, i);
          let w = EDGE * abs(dot(DIRV[d], lv.u));
          if (sh <= 0.0 || w <= 1e-4) { continue; }
          acc[0] += w * sh;
          acc[1] += w * nf(N_FD + d * 5u + 1u, i);
          acc[2] += w * nf(N_FD + d * 5u + 2u, i);
          zlo = min(zlo, nf(N_FD + d * 5u + 3u, i));
          zhi = max(zhi, nf(N_FD + d * 5u + 4u, i));
        }
      }
      put(cur, &acc, 3u, F_AP, 13u);
      if (cur != NONE && zlo < 1e9) { minf(fi(F_ZMIN, cur), zlo); maxf(fi(F_ZMAX, cur), zhi); }
    }
    workgroupBarrier();
    wflush(newList, nNew, 3u, F_AP, 13u);
    // g: each section checked (only what an edit weakened is weighed: fracture.ts RockOpts.weigh)
    for (var t = lid; t < nNew; t += gW) {
      let r = nu(newList, t);
      let pf = ld(fi(F_PF, nu(N_PIECE, r)));
      if ((pf & (PF_SEEDED | PF_WEIGHED)) != (PF_SEEDED | PF_WEIGHED)) { continue; }
      if (ld(fi(F_INF, r)) != 0u) { continue; }
      let lv = leverOf(r);
      if (lv.meet) { continue; }
      oadd(O_WHY + 10u, 1u);
      let M = ldf(fi(F_AM, r));
      let s = min(ldf(fi(F_SSTR, r)), 1e3);
      let ts = min(ldf(fi(F_STS, r)), 1e3);
      let Ap = ldf(fi(F_AP, r));
      let A0 = ldf(fi(F_A0, r));
      // (shear on the faces' area across the lever; with no lever, a face's mean share)
      let As = select(0.6366 * A0, Ap, lv.L > 1e-3);
      var kind = 0u;
      if (M > P.shear * s * As) { kind = K_SHEAR; }
      if (kind == 0u && Ap > 1e-6) {
        let zb = ldf(fi(F_APZ, r)) / Ap;
        let I = max(ldf(fi(F_IP, r)) - Ap * zb * zb, 0.0);
        let c = max(ldf(fi(F_ZMAX, r)) - zb, zb - ldf(fi(F_ZMIN, r)));
        let S = I / max(c, 1e-3);
        if (M * lv.L > P.tensile * ts * S) { kind = K_BEND; }
      } else if (kind == 0u && lv.L > 1e-3) { kind = K_BEND; }
      if (kind != 0u) {
        st(fi(F_FAIL, r), k);
        // it hinges where it broke (fracture.ts hingeOf): about the section's foot, the axis across the lever — kept
        // in the pair of the root at this level (as mode 1 keeps it in its root pair)
        let q = pairOf(r, k);
        st(pw(P_KIND, q), kind);
        stf(pw(P_PIVX, q), lv.cen.x);
        stf(pw(P_PIVY, q), lv.cen.y);
        stf(pw(P_PIVZ, q), select(ldf(fi(F_ZMIN, r)), 0.0, ld(fi(F_ZMIN, r)) == FINF));
        stf(pw(P_AXX, q), -lv.u.y);
        stf(pw(P_AXY, q), lv.u.x);
        atomicOr(&W[fi(F_PF, nu(N_PIECE, r))], PF_FAILED);
      }
    }
    workgroupBarrier();
    storageBarrier();
    // h: a failed section's faces cut
    for (var t = lo + lid; t < hi; t += gW) {
      let i = nu(F_ORDER, t);
      let r = nu(N_ROOT, i);
      if (ld(fi(F_FAIL, r)) == k) { st(fi(F_CUT, i), pairOf(r, k) + 1u); }
    }
    for (var t = lid; t < WSLOTS * 16u; t += gW) { atomicStore(&wacc[t], 0u); }
    workgroupBarrier();
    storageBarrier();
  }

  if (P.stopAt == 5u) { return; }
  // 5 — the thrust line of the pieces held from opposite sides (the level-1 components that meet)
  if (lid == 0u) { wgL[0] = select(0u, ld(cnt(C_ROOTS)), maxD >= 1u); }
  let nR = uniformCount(0u);
  // (level 1 is odd: its roots are in F_ROOTS) — the span's axis, its springings each side
  for (var t = lid; t < nR; t += gW) {
    let r = nu(F_ROOTS, t);
    st(fi(F_RAD, r), 0u);
    // (F_AP.. reused for a meeting piece: the springings' sums on the + side of the axis, then the parabola's bounds)
    st(fi(F_AP, r), 0u);
    st(fi(F_APZ, r), 0u);
    st(fi(F_IP, r), 0u);
    stf(fi(F_ZMIN, r), 0.0);
    stf(fi(F_ZMAX, r), 1e6);
  }
  workgroupBarrier();
  storageBarrier();
  let lo1 = ld(lvl(1u));
  let hi1 = ld(lvl(2u));
  for (var t = lo1 + lid; t < hi1; t += gW) {
    let i = nu(F_ORDER, t);
    let r = nu(N_ROOT, i);
    let lv = leverOf(r);
    if (!lv.meet) { continue; }
    let ax = archAxis(r);
    let pi = cellPos(colXY(nu(N_COL, i)));
    for (var d = 0u; d < 6u; d++) {
      let nb = nbrBase(i, d);
      for (var rr = 0u; rr < 16u; rr++) {
        if ((nb.y & (1u << rr)) == 0u) { continue; }
        let j = nb.x + rr;
        if (nu(N_DIST, j) != 0u) { continue; }
        let h = max(min(nf(N_SH1, i), nf(N_SH1, j)) - max(nf(N_SH0, i), nf(N_SH0, j)), 0.0);
        let pf = 0.5 * (pi + cellPos(colXY(nu(N_COL, j))));
        addf(fi(F_RAD, r), EDGE * h * length(pf - lv.cen));
        if (dot(DIRV[d], ax.xy) <= 0.0) { continue; }
        addf(fi(F_AP, r), EDGE * h);
        addf(fi(F_APZ, r), EDGE * h * pf.x);
        addf(fi(F_IP, r), EDGE * h * pf.y);
      }
    }
  }
  workgroupBarrier();
  storageBarrier();
  // every run of a meeting piece bounds the parabola's rise: z_s + f q inside [z0, z1] (give archTol)
  for (var t = lid; t < H; t += gW) {
    let i = nu(F_SEEDL, t);
    let d = nu(N_DIST, i);
    if (d == 0u || d > maxD) { continue; }
    let r = nu(N_PIECE, i);
    let lv = leverOf(r);
    if (!lv.meet) { continue; }
    let sp = span(r);
    let q = archQ(sp, cellPos(colXY(nu(N_COL, i))));
    if (q <= 0.05) { continue; }
    let lo = (nf(N_Z0, i) - P.archTol - sp.zs) / q;
    let hi = (nf(N_Z1, i) + P.archTol - sp.zs) / q;
    maxf(fi(F_ZMIN, r), lo);
    minf(fi(F_ZMAX, r), hi);
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lid; t < nR; t += gW) {
    let r = nu(F_ROOTS, t);
    let lv = leverOf(r);
    if (!lv.meet) { continue; }
    let pf = ld(fi(F_PF, nu(N_PIECE, r)));
    if ((pf & (PF_SEEDED | PF_WEIGHED)) != (PF_SEEDED | PF_WEIGHED) || ld(fi(F_INF, r)) != 0u) { continue; }
    oadd(O_WHY + 10u, 1u);
    let sp = span(r);
    let fLo = ldf(fi(F_ZMIN, r));
    let fHi = ldf(fi(F_ZMAX, r));
    var kind = 0u;
    if (fHi < fLo || fHi < 0.25) { kind = K_ARCH; } else {
      // the least thrust (the highest rise that fits) on the springings' area, each side half the section
      let thrust = ldf(fi(F_AM, r)) * sp.L / (8.0 * fHi);
      let A = 0.5 * ldf(fi(F_A0, r));
      if (thrust > P.crush * min(ldf(fi(F_SSTR, r)), 1e3) * A) { kind = K_ARCHCRUSH; }
    }
    if (kind != 0u) {
      let q = pairOf(r, 1u);
      st(pw(P_KIND, q), kind);
      stf(pw(P_PIVX, q), lv.cen.x);
      stf(pw(P_PIVY, q), lv.cen.y);
      stf(pw(P_PIVZ, q), sp.zs);
      stf(pw(P_AXX, q), 0.0);
      stf(pw(P_AXY, q), 0.0);
      atomicOr(&W[fi(F_PF, r)], PF_FAILED | PF_ARCHFAIL);
    }
  }
  workgroupBarrier();
  storageBarrier();
  for (var t = lo1 + lid; t < hi1; t += gW) {
    let i = nu(F_ORDER, t);
    let r = nu(N_PIECE, i);
    if ((ld(fi(F_PF, r)) & PF_ARCHFAIL) != 0u) { st(fi(F_CUT, i), pairOf(r, 1u) + 1u); }
  }
  workgroupBarrier();
  storageBarrier();

}

