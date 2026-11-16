// ---- the engine's rows awake, compacted (engine.wgsl; a thread a row in use: the one read an asleep row costs) -------
// The host's commands are taken here too (a velocity change, a wake, the window's slide), so nothing else has to
// visit a row asleep.
@group(0) @binding(10) var<storage, read_write> list: array<atomic<u32>>;
@group(0) @binding(12) var<storage, read> surfaceIn: array<u32>;
@group(0) @binding(18) var<storage, read_write> poolC: array<atomic<u32>>;
// the list's dispatch arguments again, in a buffer of their own (words 0-2 and 4-6 as the list's): a kernel that
// writes the list's buffer (the rows' work words, engine_pairs.wgsl) cannot be dispatched from it
@group(0) @binding(50) var<storage, read_write> rargs: array<atomic<u32>>;
// the rows' claims and the tick's claim jobs (engine.wgsl CJ_*, CR_*; engine_claim.wgsl does the jobs)
@group(0) @binding(74) var<storage, read_write> claimC: array<atomic<u32>>;

/** this tick's jobs for the chunks [c0, c1] (window chunks), all or none: each chunk's lock taken (no other job writes
 *  it this tick) and a job slot each. False: not this tick (the caller counts the wait and asks again next tick). */
fn claimJobs(r: u32, word: u32, c0: vec2<u32>, c1: vec2<u32>) -> bool {
  let across = G.chunksX;
  let n = (c1.x - c0.x + 1u) * (c1.y - c0.y + 1u);
  var got = 0u;
  var ok = true;
  for (var i = 0u; i < n && ok; i++) {
    let c = c0 + vec2<u32>(i % (c1.x - c0.x + 1u), i / (c1.x - c0.x + 1u));
    let k = c.y * across + c.x;
    if (k >= CJ_LOCK_WORDS * 32u) { ok = false; break; }
    let bit = 1u << (k % 32u);
    if ((atomicOr(&claimC[CJ_LOCK + k / 32u], bit) & bit) != 0u) { ok = false; } else { got = i + 1u; }
  }
  var first = 0u;
  if (ok) {
    first = atomicAdd(&claimC[0], n);
    if (first + n > CJ_MAX) {
      atomicSub(&claimC[0], n);
      ok = false;
    }
  }
  if (!ok) {
    // (the locks it took given back: a thread that met one of them meanwhile waits a tick it need not have)
    for (var i = 0u; i < got; i++) {
      let c = c0 + vec2<u32>(i % (c1.x - c0.x + 1u), i / (c1.x - c0.x + 1u));
      let k = c.y * across + c.x;
      atomicAnd(&claimC[CJ_LOCK + k / 32u], ~(1u << (k % 32u)));
    }
    return false;
  }
  for (var i = 0u; i < n; i++) {
    let c = c0 + vec2<u32>(i % (c1.x - c0.x + 1u), i / (c1.x - c0.x + 1u));
    let j = CJ_AT + (first + i) * CJ_WORDS;
    atomicStore(&claimC[j], r);
    atomicStore(&claimC[j + 1u], word);
    atomicStore(&claimC[j + 2u], c.x | (c.y << 16u));
  }
  return true;
}

/**
 * A row's claim kept in step with its sleep (DESIGN §3, §10 "At rest"): asleep and unclaimed, its footprint is given
 * to this tick's jobs to write as External intervals naming it; awake (or deforming) and claimed, to clear. Returns
 * the row's flags. A job that finds no room waits a tick (P_CLAIM_WAIT, which the host sees move).
 */
fn claimStep(r: u32, flIn: u32, shiftBy: vec3<f32>) -> u32 {
  var fl = flIn;
  let rec = CR_AT + r * CR_WORDS;
  let claimed = (fl & ROW_CLAIMED) != 0u;
  if (claimed && any(shiftBy.xy != vec2<f32>(0.0))) {
    // (the window slid: the claim lies where the land now is)
    let o = atomicLoad(&claimC[rec + 2u]);
    let nx = i32(o & 0xffffu) + i32(round(shiftBy.x));
    let ny = i32(o >> 16u) + i32(round(shiftBy.y / ROW_H));
    atomicStore(&claimC[rec + 2u], u32(max(nx, 0)) | (u32(max(ny, 0)) << 16u));
  }
  if ((EU.e.w & 512u) == 0u && !claimed) { return fl; }
  let rest = (fl & ROW_ASLEEP) != 0u && (fl & (ROW_DEFORM | ROW_HELD)) == 0u && (EU.e.w & 512u) != 0u;
  if (!rest && (fl & ROW_NOCLAIM) != 0u) { fl = fl & ~ROW_NOCLAIM; }
  let cs = G.chunkSize;
  if (claimed && !rest) {
    let o = atomicLoad(&claimC[rec + 2u]);
    let e = atomicLoad(&claimC[rec + 3u]);
    let lo = vec2<u32>(o & 0xffffu, o >> 16u);
    let hi = lo + vec2<u32>(max(e & 0xffffu, 1u), max(e >> 16u, 1u)) - vec2<u32>(1u);
    let gen = atomicLoad(&claimC[rec + 1u]);
    if (claimJobs(r, CJ_CLEAR | (gen << 8u), lo / cs, hi / cs)) {
      atomicStore(&claimC[rec + 1u], 0u);
      atomicSub(&poolC[P_CLAIMS], 1u);
      fl = fl & ~ROW_CLAIMED;
    } else { atomicAdd(&poolC[P_CLAIM_WAIT], 1u); }
  } else if (!claimed && rest && (fl & ROW_NOCLAIM) == 0u && bitcast<u32>(info[4u * r + 3u].x) != 0u) {
    // (its footprint: the columns its bound sphere can stand over — a column's cell lies within a cell and a half of
    // its index in x, a row in y: common.wgsl cellPos)
    let x = pose[4u * r + 2u].xyz;
    let reach = vel[2u * r + 1u].w + 0.5;
    let last = vec2<i32>(i32(G.mapW) - 1, i32(G.mapH) - 1);
    let lo = max(vec2<i32>(i32(floor(x.x - reach - 1.5)), i32(floor((x.y - reach) / ROW_H)) - 1), vec2<i32>(0));
    let hi = min(vec2<i32>(i32(ceil(x.x + reach)), i32(ceil((x.y + reach) / ROW_H))), last);
    // (wholly off the window: nothing to claim, and it is asked again when it next sleeps)
    if (hi.x < lo.x || hi.y < lo.y) { return fl | ROW_NOCLAIM; }
    let c0 = vec2<u32>(lo) / cs;
    let c1 = vec2<u32>(hi) / cs;
    if ((c1.x - c0.x + 1u) * (c1.y - c0.y + 1u) > CJ_MAX) {
      atomicAdd(&poolC[P_CLAIM_BIG], 1u);
      return fl | ROW_NOCLAIM;
    }
    var gen = (atomicLoad(&claimC[rec]) & 0xffu) + 1u;
    if (gen > 255u) { gen = 1u; }
    let mat = bitcast<u32>(info[4u * r + 2u].z) & 0xffu;
    // (the record first: the job's threads read it this tick)
    atomicStore(&claimC[rec + 2u], u32(lo.x) | (u32(lo.y) << 16u));
    atomicStore(&claimC[rec + 3u], u32(hi.x - lo.x + 1) | (u32(hi.y - lo.y + 1) << 16u));
    if (claimJobs(r, CJ_WRITE | (gen << 8u) | (mat << 16u), c0, c1)) {
      atomicStore(&claimC[rec], gen);
      atomicStore(&claimC[rec + 1u], gen);
      atomicAdd(&poolC[P_CLAIMS], 1u);
      fl = fl | ROW_CLAIMED;
    } else { atomicAdd(&poolC[P_CLAIM_WAIT], 1u); }
  }
  return fl;
}

@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) id: vec3<u32>) {
  let r = id.x;
  if (r == 0u) {
    atomicStore(&list[1], 1u);
    atomicStore(&list[2], 1u);
    atomicStore(&list[5], 1u);
    atomicStore(&list[6], 1u);
    atomicStore(&rargs[1], 1u);
    atomicStore(&rargs[2], 1u);
    atomicStore(&rargs[5], 1u);
    atomicStore(&rargs[6], 1u);
  }
  if (r >= EU.e.x) { return; }
  var fl = rowFlags(r);
  if ((fl & ROW_ALIVE) == 0u) { return; }
  // (its particles carry it: engine_deform.wgsl moves them. Listed, so the coarse pass pairs it by its voxels' bounds
  // and its voxels meet the rigid rows of those pairs — engine_meet.wgsl; the rigid kernels pass it by)
  if ((fl & ROW_DEFORM) != 0u) {
    // (a claim it still holds from before it was handed to stage 4: cleared)
    if ((fl & ROW_CLAIMED) != 0u) {
      fl = claimStep(r, fl, vec3<f32>(0.0));
      info[4u * r].w = bitcast<f32>(fl);
    }
    // (its particles stand in for its settled parts — engine_deform.wgsl S_HELD: asleep, so it is in the coarse pass's
    // sleeper table and costs nothing more; the table is told once)
    if ((fl & ROW_ASLEEP) != 0u) {
      if ((fl & ROW_NEWSLEEP) != 0u) {
        info[4u * r].w = bitcast<f32>(fl & ~ROW_NEWSLEEP);
        atomicAdd(&list[LIST_EPOCH], 1u);
      }
      return;
    }
    let kd = atomicAdd(&list[3], 1u);
    atomicAdd(&list[4], 1u);
    atomicAdd(&rargs[4], 1u);
    if (kd % 64u == 0u) {
      atomicAdd(&list[0], 1u);
      atomicAdd(&rargs[0], 1u);
    }
    atomicStore(&list[LIST_AT + kd], r);
    return;
  }
  var wake = false;
  var epoch = false;
  var dv = vec3<f32>(0.0);
  var dw = vec3<f32>(0.0);
  var shiftBy = vec3<f32>(0.0);
  var picking = false;
  let x = pose[4u * r + 2u].xyz;
  for (var c = 0u; c < EU.e.y; c++) {
    let k = EC[c].b.x;
    if (k == 1u && EC[c].b.y == r) {
      dv += EC[c].a.xyz;
      wake = true;
    } else if (k == 2u && EC[c].b.y == r) {
      wake = true;
    } else if (k == 3u && distance(x, EC[c].a.xyz) < EC[c].a.w + vel[2u * r + 1u].w) {
      wake = true;
    } else if (k == 4u) {
      shiftBy += EC[c].a.xyz;
    } else if (k == 5u && EC[c].b.y == r && (EU.e.w & 4u) != 0u && bitcast<u32>(info[4u * r + 3u].x) != 0u && (fl & ROW_HELD) == 0u) {
      wake = true;
      fl = fl | ROW_EXPAND;
      info[4u * r].w = bitcast<f32>(fl);
    } else if (k == 7u) {
      // (the host's grab: every row the pick ray passes — within the thumb's radius of its bound sphere, ahead of the
      // ray's start — bids how near the eye it is; the nearest is left in the slot when the kernel ends)
      picking = true;
      let rd = bitcast<vec3<f32>>(EC[c].b.yzw);
      let along = dot(x - EC[c].a.xyz, rd);
      let off = length(x - EC[c].a.xyz - rd * along);
      if (along > 0.0 && off < EC[c].a.w + vel[2u * r + 1u].w) { atomicMax(&poolC[P_GRAB], ((4095u - min(u32(along * 4.0), 4094u)) << 20u) | (r & 0xfffffu)); }
    }
  }
  // (the row the grab holds, from the tick after the pick — while rows bid the slot is not settled: it is awake and
  // marked for `integrate`'s spring while the host holds a target; let go, or another picked, the mark goes)
  let gk = atomicLoad(&poolC[P_GRAB]);
  let mine = !picking && EU.o.w > 0.5 && gk != 0u && (gk & 0xfffffu) == r;
  if (mine != ((fl & ROW_GRAB) != 0u)) {
    fl = fl ^ ROW_GRAB;
    info[4u * r].w = bitcast<f32>(fl);
    // (the hold begins: the height it is at is the plane it is dragged in — engine.wgsl grabPull)
    if (mine) { info[4u * r + 3u].z = x.z; }
  }
  if (mine) { wake = true; }
  // (a sleeper whose ground changed — dug, cut, washed out, built on: the surface pass's word of the column under its
  // centre isn't the one it fell asleep on. One read a row asleep; the word is fresh this tick.)
  if ((fl & ROW_ASLEEP) != 0u) {
    let c = cellAt(x.xy);
    if ((fl & ROW_NEWSLEEP) != 0u) {
      // (settle made it asleep where its particles stood: the ground's word it sleeps on is taken here)
      var word = 0u;
      if (inMap(c)) { word = surfaceIn[colIdxI(c)]; }
      pose[4u * r].w = bitcast<f32>(word);
      fl = fl & ~ROW_NEWSLEEP;
      info[4u * r].w = bitcast<f32>(fl);
      // (made asleep: the coarse pass's sleeper table is out of date)
      epoch = true;
    } else if ((fl & ROW_CLAIMED) == 0u && inMap(c)) {
      let now = surfaceIn[colIdxI(c)];
      let was = bitcast<u32>(pose[4u * r].w);
      if (now != was) {
        // (not its ground changing: a body's claim written in that column — a sleeper under it claimed first, its
        // External is now the column's firm top, no lower than the top was. A body is watched by its owner and by the
        // pairs, not here; the word is taken again, so a top that later comes down wakes it. A row waiting for its own
        // claim job is in this state for a few ticks — BACKLOG PS13)
        if (sfMat(now) == MAT_EXTERNAL && sfZ(now) >= sfZ(was)) { pose[4u * r].w = bitcast<f32>(now); } else { wake = true; }
      }
    }
    // (claimed, its own intervals are in that word, and what it stands on is watched under every column of the claim
    // by the kernel that sees the columns change: engine_ground.wgsl)
    // (a pair asked it to wake last tick — engine_pairs.wgsl pairPre: a hit over the threshold, or what it leans on
    // moved. It wakes with what the pair solver gave it meanwhile, and deforms if the hit passed its material's bar.)
    let b = rwAt(r);
    // (the GPU's own tick count, which `integrate` puts up after this kernel: still the stamping tick's)
    let gt = atomicLoad(&list[tickAt()]);
    if (gt > 0u && atomicLoad(&list[b + RW_WAKE]) == gt) {
      wake = true;
      dv += vec3<f32>(f32(bitcast<i32>(atomicExchange(&list[b + RW_DV], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DV + 1u], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DV + 2u], 0u)))) / FPV;
      dw += vec3<f32>(f32(bitcast<i32>(atomicExchange(&list[b + RW_DW], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DW + 1u], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_DW + 2u], 0u)))) / FPV;
      var e = bitcast<f32>(atomicExchange(&list[b + RW_ENERGY], 0u));
      // (and what deforming voxels gave it while it was stamped — engine_meet.wgsl: never more than brings it to the
      // fastest of them; the hit weighed as a pair's is, half the closing by the speed it was given)
      var mdv = vec3<f32>(f32(bitcast<i32>(atomicExchange(&list[b + RW_MDV], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_MDV + 1u], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_MDV + 2u], 0u)))) / FPM;
      var mdw = vec3<f32>(f32(bitcast<i32>(atomicExchange(&list[b + RW_MDW], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_MDW + 1u], 0u))), f32(bitcast<i32>(atomicExchange(&list[b + RW_MDW + 2u], 0u)))) / FPM;
      let mc = bitcast<f32>(atomicExchange(&list[b + RW_MC], 0u));
      atomicStore(&list[b + RW_MN], 0u);
      atomicStore(&list[b + RW_MP], 0u);
      let ml = length(mdv);
      if (ml > mc) {
        mdv *= mc / max(ml, 1e-9);
        mdw *= mc / max(ml, 1e-9);
      }
      dv += mdv;
      dw += mdw;
      if ((EU.e.w & 16u) != 0u) { e = max(e, 0.5 * min(ml, mc) * mc * info[4u * r + 1u].w); }
      let mi = bitcast<vec4<u32>>(info[4u * r + 2u]);
      let thr = expandAt(mi.z & 0xffu);
      if ((EU.e.w & 4u) != 0u && thr > 0.0 && e > thr * info[4u * r + 1u].w && bitcast<u32>(info[4u * r + 3u].x) != 0u) {
        fl = fl | ROW_EXPAND;
        info[4u * r].w = bitcast<f32>(fl);
      }
    }
    if (any(shiftBy != vec3<f32>(0.0))) { epoch = true; }
  }
  if (any(shiftBy != vec3<f32>(0.0))) {
    pose[4u * r] = vec4<f32>(pose[4u * r].xyz + shiftBy, pose[4u * r].w);
    pose[4u * r + 2u] = vec4<f32>(x + shiftBy, pose[4u * r + 2u].w);
  }
  // (a held part stays where its collider is)
  if ((fl & ROW_HELD) != 0u) { wake = false; }
  if (wake) {
    if ((fl & ROW_ASLEEP) != 0u) {
      fl = fl & ~ROW_ASLEEP;
      info[4u * r].w = bitcast<f32>(fl);
      epoch = true;
    }
    let v = vel[2u * r];
    vel[2u * r] = vec4<f32>(v.xyz + dv, 0.0);
    let sp = vel[2u * r + 1u];
    vel[2u * r + 1u] = vec4<f32>(sp.xyz + dw, sp.w);
  }
  if (epoch) { atomicAdd(&list[LIST_EPOCH], 1u); }
  {
    let f2 = claimStep(r, fl, shiftBy);
    if (f2 != fl) {
      fl = f2;
      info[4u * r].w = bitcast<f32>(fl);
    }
  }
  // (it waits to deform: frozen as it came in till `expand` runs, which the host encodes once it has read this)
  if ((fl & ROW_EXPAND) != 0u) { atomicAdd(&poolC[P_EXPAND_WAIT], 1u); }
  // (the draw list keeps the triangles of rows asleep apart, placed once: a row that fell asleep or woke since it was
  // made asks for it again)
  if (((fl & ROW_ASLEEP) != 0u) != ((fl & ROW_LISTED_ASLEEP) != 0u) && bitcast<u32>(info[4u * r + 3u].x) != 0u) { atomicStore(&poolC[P_DL_DIRTY], 1u); }
  if ((fl & ROW_ASLEEP) != 0u) { return; }
  let k = atomicAdd(&list[3], 1u);
  atomicAdd(&list[4], 1u);
  atomicAdd(&rargs[4], 1u);
  if (k % 64u == 0u) {
    atomicAdd(&list[0], 1u);
    atomicAdd(&rargs[0], 1u);
  }
  atomicStore(&list[LIST_AT + k], r);
}
