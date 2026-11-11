// ---- (U2 round 5) place-based orders, resolved on the GPU (UNIT_MINDS_U2.md §9a; contract api/contracts/units.ts) ----
// Appended after units.wgsl and townplace.wgsl (binding 57: the town contracts' place table). A group (ORDER_GROUPS of
// them: agents groups GROUP_BASE + g) is a record in `mail` the CPU writes when it orders it — indices only: the order's
// kind, the town, a named place or a lot (district, lot kind, rank), the field it walks, a serial — and the GPU resolves
// where that is through townplace.wgsl, each frame, before the relaxation:
//   orderApply    (when the CPU queued some) a unit joins a group: its aim word 11 the group + 1, its agents group
//                 GROUP_BASE + g; spawned, it's placed at the place's approach, round it in a spiral by its rank. No
//                 place there: it's not made (its alive bit cleared; the CPU frees the slot on orderFailed)
//   orderResolve  each live group: the place's status and point; invalid → orderFailed(g, status) once an order; valid
//                 → its field seeded there (seedMask, as the hunt's), its chunk marked; a seed it left, cleared
//   groupCount    each member alive, and within the arrival radius of the place
//   groupEmit     a group whose living members have all arrived → arrived(g) once an order
// group words (GROUP_W): CPU's 0 kind (0 none, 1 stand, 2 go, 3 guard, 4 attack), 1 town, 2 ref (0 named, 1 lot),
// 3 name / district, 4 lot kind, 5 rank, 6 field (NFIELDS none), 7 serial; GPU's 8-10 the place, 11 its status, 12
// alive this frame, 13 arrived this frame, 14 the serial arrived was told for (+1), 15 the serial a failure was told for
// (+1), 16 the seeded surface (+1), 17 its field, 18 last frame's alive, 19 the CPU's ask to mark the seed again (a slide)
// queue (MAIL_Q): [0] count, then 3 words an entry: slot, group, rank | SPAWN_BIT
const ORDER_GROUPS: u32 = 8u;
const GROUP_W: u32 = 20u;
const MAIL_GRP: u32 = MAIL_ARR + MAIL_ARROWS * ARROW_W;
const MAIL_Q: u32 = MAIL_GRP + ORDER_GROUPS * GROUP_W;
const ORDER_Q: u32 = 1024u;
const SPAWN_BIT: u32 = 0x80000000u;
const GROUP_BASE: u32 = 16u;
const EV_GROUP_ARRIVED: u32 = 20u;
const EV_ORDER_FAILED: u32 = 21u;
const OK_NONE: u32 = 0u;
const OK_STAND: u32 = 1u;

fn grpO(g: u32) -> u32 { return MAIL_GRP + g * GROUP_W; }
fn grpWord(g: u32, w: u32) -> u32 { return atomicLoad(&mail[grpO(g) + w]); }
/** the group's place: (status, 0 named / 1 lot, the name or the lot's handle) */
fn grpResolve(g: u32) -> vec3<u32> {
  let town = grpWord(g, 1u);
  if (grpWord(g, 2u) == 0u) {
    let name = grpWord(g, 3u);
    return vec3<u32>(placeStatus(town, name), 0u, name);
  }
  let h = lotAt(town, grpWord(g, 3u), grpWord(g, 4u), grpWord(g, 5u));
  return vec3<u32>(lotStatus(town, h), 1u, h);
}
fn grpPoint(g: u32, r: vec3<u32>, approach: bool) -> vec3<f32> {
  let town = grpWord(g, 1u);
  if (r.y == 0u) { return select(place(town, r.z), placeApproach(town, r.z), approach); }
  return select(lotPlace(town, r.z), lotApproach(town, r.z), approach);
}
/** how near the place a member counts as there: a crowd stands round it, wider the more of them */
fn grpArrive(n: u32) -> f32 { return 2.5 + 0.7 * sqrt(f32(n)); }

@compute @workgroup_size(64)
fn orderApply(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = min(atomicLoad(&mail[MAIL_Q]), ORDER_Q);
  if (id.x >= n) { return; }
  let q = MAIL_Q + 1u + id.x * 3u;
  let slot = atomicLoad(&mail[q]);
  let g = atomicLoad(&mail[q + 1u]);
  let rk = atomicLoad(&mail[q + 2u]);
  if (slot >= MAX_SLOTS || g >= ORDER_GROUPS) { return; }
  atomicStore(&mail[MAIL_AIM + slot * AIM_W + 11u], g + 1u);
  var a = units[slot * UNIT_V];
  var info = unitInfo(a);
  info = (info & ~0xffu) | (GROUP_BASE + g);
  if ((rk & SPAWN_BIT) != 0u) {
    let r = grpResolve(g);
    if (r.x != PLACE_OK) {
      info &= ~(1u << 8u);
    } else {
      // (round the approach in a sunflower spiral: rank k at radius 0.9·√k — a crowd that doesn't stand in itself)
      // (a spot is taken only on a walkable surface within a step of the approach's height — not a roof or a wall top
      // the spiral reaches over, from where it can't walk the order: the lab's first run left one on the barracks)
      let k = f32(rk & ~SPAWN_BIT);
      let ap = grpPoint(g, r, true);
      let rad = 0.9 * sqrt(k);
      let ang = k * 2.39996;
      var at = ap;
      // (the crowd's middle moved out from the place along its approach: in the street, not against the door)
      let out = ap.xy - grpPoint(g, r, false).xy;
      let away = select(vec2<f32>(0.0), normalize(out) * rad, length(out) > 0.1);
      let p = ap.xy + away + vec2<f32>(cos(ang), sin(ang)) * rad;
      let c = cellAt(p);
      if (inMap(c)) {
        let sk = surfaceNear(colIdxI(c), ap.z);
        if (sk < NAV_K) {
          let z = navZ(colIdxI(c) * NAV_K + sk);
          if (abs(z - ap.z) < 1.2) { at = vec3<f32>(p, z); }
        }
      }
      a = vec4<f32>(at + vec3<f32>(0.0, 0.0, 0.05), a.w);
    }
  }
  units[slot * UNIT_V] = vec4<f32>(a.xyz, bitcast<f32>(info));
}

/** the queue emptied once applied (one thread, after orderApply) */
@compute @workgroup_size(1)
fn orderDone() { atomicStore(&mail[MAIL_Q], 0u); }

/** a seed this group left: its bit cleared, its chunk marked for the field (it rises there) */
fn grpUnseed(o: u32) {
  let prev = atomicLoad(&mail[o + 16u]);
  let pf = atomicLoad(&mail[o + 17u]);
  if (prev != 0u && pf < NFIELDS) {
    atomicAnd(&seedMask[prev - 1u], ~(1u << pf));
    atomicOr(&dirtyCur[(prev - 1u) / NAV_K / (COLS_PAGE * COLS_PAGE)], 1u << pf);
  }
  atomicStore(&mail[o + 16u], 0u);
}

@compute @workgroup_size(8)
fn orderResolve(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = id.x;
  if (g >= ORDER_GROUPS) { return; }
  let o = grpO(g);
  let kind = grpWord(g, 0u);
  let f = grpWord(g, 6u);
  if (kind == OK_NONE) { grpUnseed(o); return; }
  let serial = grpWord(g, 7u);
  let r = grpResolve(g);
  atomicStore(&mail[o + 11u], r.x);
  if (r.x != PLACE_OK) {
    if (grpWord(g, 15u) != serial + 1u) {
      atomicStore(&mail[o + 15u], serial + 1u);
      emit(EV_ORDER_FAILED, g, r.x, f32(serial), vec3<f32>(0.0));
    }
    grpUnseed(o);
    return;
  }
  let at = grpPoint(g, r, false);
  mailSetV3(o + 8u, at);
  if (f >= NFIELDS || kind == OK_STAND) { grpUnseed(o); return; }
  let c = clampCell(cellAt(at.xy));
  let i = colIdxI(c);
  let k = surfaceNear(i, at.z);
  if (k >= NAV_K || !inScope(c)) { grpUnseed(o); return; }
  let s = i * NAV_K + k;
  if (atomicLoad(&mail[o + 16u]) != s + 1u || atomicLoad(&mail[o + 17u]) != f) {
    grpUnseed(o);
    atomicOr(&dirtyCur[chunkOfCol(u32(c.x), u32(c.y))], 1u << f);
    atomicStore(&mail[o + 16u], s + 1u);
    atomicStore(&mail[o + 17u], f);
  }
  // (the CPU's ask after a window slide: the seed's chunk marked again — the fields started over where the slide brought
  // columns in, and a seed that didn't move marks nothing)
  if (atomicExchange(&mail[o + 19u], 0u) != 0u) { atomicOr(&dirtyCur[chunkOfCol(u32(c.x), u32(c.y))], 1u << f); }
  // (set every frame — idempotent: another group's seed let go on this surface the same frame can't clear it for good)
  atomicOr(&seedMask[s], 1u << f);
}

@compute @workgroup_size(64)
fn groupCount(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  let gp = atomicLoad(&mail[MAIL_AIM + u * AIM_W + 11u]);
  if (gp == 0u || gp > ORDER_GROUPS) { return; }
  let a = units[u * UNIT_V];
  let info = unitInfo(a);
  let g = gp - 1u;
  // (still in its group: moved to another by the CPU, it no longer counts)
  if (((info >> 8u) & 1u) == 0u || (info & 0xffu) != GROUP_BASE + g) { return; }
  // (every living member is waited for — one its field doesn't reach holds the group's arrival; not counted apart by
  // the field's FAR: right after an order the field is refilling from the place and reads FAR almost everywhere, so a
  // member there looked cut off — the lab's run told arrived with none at the keep)
  atomicAdd(&mail[grpO(g) + 12u], 1u);
  let to = mailV3(grpO(g) + 8u);
  if (length(to.xy - a.xy) <= grpArrive(grpWord(g, 18u)) && abs(to.z - a.z) < 3.0) { atomicAdd(&mail[grpO(g) + 13u], 1u); }
}

@compute @workgroup_size(8)
fn groupEmit(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = id.x;
  if (g >= ORDER_GROUPS) { return; }
  let o = grpO(g);
  let alive = atomicExchange(&mail[o + 12u], 0u);
  let there = atomicExchange(&mail[o + 13u], 0u);
  atomicStore(&mail[o + 18u], alive);
  let kind = grpWord(g, 0u);
  let serial = grpWord(g, 7u);
  if (kind <= OK_STAND || grpWord(g, 11u) != PLACE_OK || alive == 0u || there < alive || grpWord(g, 14u) == serial + 1u) { return; }
  atomicStore(&mail[o + 14u], serial + 1u);
  emit(EV_GROUP_ARRIVED, g, serial, f32(alive), mailV3(o + 8u));
}
