// ---- (U2 round 5) place-based orders, resolved on the GPU (UNIT_MINDS_U2.md §9a; contract api/contracts/units.ts) ----
// Appended after units.wgsl and townplace.wgsl (binding 57: the town contracts' place table). A group (ORDER_GROUPS of
// them: agents groups GROUP_BASE + g) is a record in `mail` the CPU writes when it orders it — indices only: the order's
// kind, its places (a chain of up to ALTS alternatives, each a named place or a lot — town, name or district, lot kind,
// rank — with an optional partner that must be valid with it), the field it walks, a serial — and the GPU resolves
// where that is through townplace.wgsl, each frame, before the relaxation:
//   orderApply    (when the CPU queued some) a unit joins a group: its aim word 11 the group + 1, its agents group
//                 GROUP_BASE + g; spawned, it's placed at the place's approach, round it in a spiral by its rank. No
//                 place there: it's not made (its alive bit cleared; the CPU frees the slot on orderFailed)
//   orderResolve  each live group: the place's status and point; invalid → orderFailed(g, status) once an order; valid
//                 → its field seeded there (fieldseam.wgsl seedPut, every frame: one not put again is gone)
//   groupCount    each member alive, and within the arrival radius of the place
//   groupEmit     a group whose living members have all arrived → arrived(g) once an order
// group words (GROUP_W): CPU's 0 kind (0 none, 1 stand, 2 go, 3 guard, 4 attack), 1 the alternatives (1..ALTS), 2 the
// settled one + 1 (the CPU writes 0 with an order; the GPU's after), 6 field (FIELD_NONE none), 7 serial; GPU's 8-10 the
// place, 11 its status, 12 alive this frame, 13 arrived this frame, 14 the serial arrived was told for (+1), 15 the
// serial a failure was told for (+1), 16 the seeded surface (+1), 17 its field, 18 last frame's alive, 19 the CPU's ask
// to mark the seed again (a slide); from REF_AT the CPU's refs: ALTS alternatives (PlaceRef's `else` chain) of a ref and
// its partner (`also`), REF_W words each: present, town, 0 named / 1 lot, name / district, lot kind, rank.
// (U2 round 5b, Track A) Each resolve the settled alternative holds while it's valid (its ref and its partner); else the
// first valid one in order is settled; none: the order fails with the last alternative's reason (its ref's status, or
// its partner's when the ref is valid).
// queue (MAIL_Q): [0] count, then 3 words an entry: slot, group, rank | SPAWN_BIT. The layout constants are units.wgsl's
// (the step reads a unit's rank entry).
// (U2 round 6, §9c/§9d) Formations: words from FORM_AT — 0 the gate slot (march) / the wall run (man; NO_SIDE all), 1
// leave (march), 2 the route held (with its generation; GPU), 3 the path's length (f32; GPU), 4 the anchor's s (f32),
// 5-7 the anchor, 8 its state (FS_*), 9 the lag accumulated this frame (f32 bits, atomicMax: each rank's distance to its
// target), 10 last frame's lag, 11 the posts (man) / the loop's radius (drill, f32), 12 the trail's head, 13 its count,
// 14 the run fields (man: 4 × 8 bits), 15 their count; the trail ring (TRAIL_N × x, y, z, s); the wall runs (RUNS ×
// RUN_W: route id, top start s, top end s, posts before, foot x y z, its seed + 1). Words 3 and 4 of the record: the
// formation (0 none, 1 column, 2 line) and the spacing (f32 m).
const SPAWN_BIT: u32 = 0x80000000u;
/** an orderFailed's reason bit: the spawn's place wasn't valid — none made */
const SPAWN_FAILED: u32 = 0x100u;
const GROUP_BASE: u32 = 16u;
const EV_GROUP_ARRIVED: u32 = 20u;
const EV_ORDER_FAILED: u32 = 21u;
/** (round 6) a spawn made: its place resolved, its units placed (once a spawn, by its first) */
const EV_SPAWNED: u32 = 23u;
const OK_NONE: u32 = 0u;
const OK_STAND: u32 = 1u;
const OK_GO: u32 = 2u;
const OK_GUARD: u32 = 3u;
const OK_ATTACK: u32 = 4u;
/** (round 6) drill: an anchor loops round the yard, the soldiers hold slots round it; man: posts along the wall-walk;
 *  march: along gateRoute(k) */
const OK_DRILL: u32 = 5u;
const OK_MAN: u32 = 6u;
const OK_MARCH: u32 = 7u;
const NO_SIDE: u32 = 0xffffffffu;
/** anchor states: forming (waits for its ranks), moving, at its end (a march not leaving; a field march's seed),
 *  past its end (a march leaving) */
const FS_FORM: u32 = 0u;
const FS_MOVE: u32 = 1u;
const FS_END: u32 = 2u;
const FS_PAST: u32 = 3u;
/** a march's or man's failure reason: the gate's status (routeread GATE_*) | this, apart from townplace's */
const FAIL_GATE: u32 = 0x10u;
/** the formation's pace (cells/s: under a soldier's 2.7, so the rear keeps up), the most a rank may lag before the
 *  anchor waits (cells), the margin off the way's width (m), the most columns a column / a line has */
const FORM_SPEED: f32 = 2.0;
const FORM_LAG: f32 = 3.0;
const FORM_MARGIN: f32 = 0.6;
const COL_MAX: u32 = 3u;
const LINE_MAX: u32 = 10u;
/** a wall-walk's stairs (routeread: 1.1 m) as against its walk (2 m) */
const STAIR_W: f32 = 1.4;

fn grpO(g: u32) -> u32 { return MAIL_GRP + g * GROUP_W; }
fn grpWord(g: u32, w: u32) -> u32 { return atomicLoad(&mail[grpO(g) + w]); }
/** ref `o` (a mail word index): (status, 0 named / 1 lot, the name or the lot's handle, town); absent: OK */
fn refResolve(o: u32) -> vec4<u32> {
  if (atomicLoad(&mail[o]) == 0u) { return vec4<u32>(PLACE_OK, 2u, 0u, 0u); }
  let town = atomicLoad(&mail[o + 1u]);
  if (atomicLoad(&mail[o + 2u]) == 0u) {
    let name = atomicLoad(&mail[o + 3u]);
    return vec4<u32>(placeStatus(town, name), 0u, name, town);
  }
  let h = lotAt(town, atomicLoad(&mail[o + 3u]), atomicLoad(&mail[o + 4u]), atomicLoad(&mail[o + 5u]));
  return vec4<u32>(lotStatus(town, h), 1u, h, town);
}
fn altRef(g: u32, a: u32, partner: bool) -> u32 { return grpO(g) + REF_AT + a * 2u * REF_W + select(0u, REF_W, partner); }
/** alternative a's status: its ref's, or its partner's when the ref is valid */
fn altStatus(g: u32, a: u32) -> u32 {
  let m = refResolve(altRef(g, a, false)).x;
  if (m != PLACE_OK) { return m; }
  return refResolve(altRef(g, a, true)).x;
}
/** the group's place now: its chosen alternative's ref resolved (status, kind, handle, town) — settled while valid */
fn grpResolve(g: u32) -> vec4<u32> {
  let o = grpO(g);
  let n = clamp(grpWord(g, 1u), 1u, ALTS);
  let st = grpWord(g, 2u);
  if (st != 0u && st <= n && altStatus(g, st - 1u) == PLACE_OK) { return refResolve(altRef(g, st - 1u, false)); }
  var why = PLACE_NONE;
  for (var a = 0u; a < n; a++) {
    why = altStatus(g, a);
    if (why == PLACE_OK) {
      atomicStore(&mail[o + 2u], a + 1u);
      return refResolve(altRef(g, a, false));
    }
  }
  atomicStore(&mail[o + 2u], 0u);
  return vec4<u32>(why, 2u, 0u, 0u);
}
fn grpPoint(g: u32, r: vec4<u32>, approach: bool) -> vec3<f32> {
  let town = r.w;
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
  // (round 6: its rank too — the formation's slot k: the order's id list on the CPU)
  atomicStore(&mail[MAIL_AIM + slot * AIM_W + 11u], (g + 1u) | ((rk & ~SPAWN_BIT) << 8u));
  var a = units[slot * UNIT_V];
  var info = unitInfo(a);
  info = (info & ~0xffu) | (GROUP_BASE + g);
  if ((rk & SPAWN_BIT) != 0u) {
    let r = grpResolve(g);
    if (r.x != PLACE_OK) {
      info &= ~(1u << 8u);
      // (told once, by its first: SPAWN_FAILED in the reason — none of this spawn was made, the CPU frees the slots.
      // A failure later, of the order it stands on, makes nobody go)
      if ((rk & ~SPAWN_BIT) == 0u) { emit(EV_ORDER_FAILED, g, r.x | SPAWN_FAILED, f32(grpWord(g, 7u)), vec3<f32>(0.0)); }
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
      // (round 6: told once, by its first — the spawn stands: the CPU sends the orders it held back till now)
      if ((rk & ~SPAWN_BIT) == 0u) { emit(EV_SPAWNED, g, 0u, f32(grpWord(g, 7u)), at); }
    }
  }
  units[slot * UNIT_V] = vec4<f32>(a.xyz, bitcast<f32>(info));
}

/** the queue emptied once applied (one thread, after orderApply) */
@compute @workgroup_size(1)
fn orderDone() { atomicStore(&mail[MAIL_Q], 0u); }

/** this group seeds nothing this frame (a seed not put again is gone: fieldseam.wgsl seedGone) */
fn grpUnseed(o: u32) { atomicStore(&mail[o + 16u], 0u); }

@compute @workgroup_size(8)
fn orderResolve(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = id.x;
  if (g >= ORDER_GROUPS) { return; }
  let o = grpO(g);
  let kind = grpWord(g, 0u);
  let f = grpWord(g, 6u);
  if (kind != OK_MAN) { manUnseed(g); }
  if (kind == OK_NONE) { grpUnseed(o); return; }
  // (round 6: man's seeds are its runs' feet, one field a run (formAnchor finds them); march's its route's start —
  // formAnchor's too, with the status: no PlaceRef to resolve)
  if (kind == OK_MAN) { grpUnseed(o); manSeed(g); return; }
  let serial = grpWord(g, 7u);
  var r = vec4<u32>(atomicLoad(&mail[o + 11u]), 2u, 0u, 0u);
  if (kind != OK_MARCH) {
    r = grpResolve(g);
    atomicStore(&mail[o + 11u], r.x);
  } else if (r.x != PLACE_OK) {
    grpUnseed(o);
    return;
  }
  if (r.x != PLACE_OK) {
    if (grpWord(g, 15u) != serial + 1u) {
      atomicStore(&mail[o + 15u], serial + 1u);
      emit(EV_ORDER_FAILED, g, r.x, f32(serial), vec3<f32>(0.0));
    }
    grpUnseed(o);
    return;
  }
  var at = mailV3(o + 8u);
  if (kind != OK_MARCH) {
    at = grpPoint(g, r, false);
    mailSetV3(o + 8u, at);
  }
  if (!fieldOk(f) || kind == OK_STAND) { grpUnseed(o); return; }
  let c = clampCell(cellAt(at.xy));
  let i = colIdxI(c);
  let k = surfaceNear(i, at.z);
  if (k >= NAV_K || !inScope(c)) { grpUnseed(o); return; }
  let s = i * NAV_K + k;
  // (put every frame: a seed new marks its page, one let go is gone the next — fieldseam.wgsl)
  atomicStore(&mail[o + 16u], s + 1u);
  atomicStore(&mail[o + 17u], f);
  seedPut(f, s);
}

@compute @workgroup_size(64)
fn groupCount(@builtin(global_invocation_id) id: vec3<u32>) {
  let u = id.x;
  if (u >= AP.n.x) { return; }
  let gw = atomicLoad(&mail[MAIL_AIM + u * AIM_W + 11u]);
  let gp = gw & 0xffu;
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
  // (round 6: its rank's unit, for formSlots — by the slot, checked there against this word)
  if ((gw >> 8u) < RANKS) { atomicStore(&mail[rankO(g, gw >> 8u) + 4u], u + 1u); }
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
  // (round 6: the formations' lag, this frame's to last frame's)
  let lag = bitcast<f32>(atomicExchange(&mail[o + FORM_AT + 9u], 0u));
  atomicStore(&mail[o + FORM_AT + 10u], bitcast<u32>(lag));
  if (kind <= OK_STAND || grpWord(g, 11u) != PLACE_OK || alive == 0u || grpWord(g, 14u) == serial + 1u) { return; }
  // (a formation's arrival: its anchor done and every rank at its target — a man's posts filled, a drill formed, a march
  // at its route's end; else every living member within the radius of the place)
  let st = atomicLoad(&mail[o + FORM_AT + 8u]);
  var done = there >= alive;
  if (formMode(g) != 0u) {
    if (kind == OK_MAN) { done = lag < 1.5; }
    else if (kind == OK_DRILL) { done = st != FS_FORM && lag < 2.0; }
    else if (kind == OK_MARCH && grpWord(g, FORM_AT + 1u) != 0u) { done = false; }
    else { done = st == FS_END && lag < 2.5; }
  }
  if (!done) { return; }
  atomicStore(&mail[o + 14u], serial + 1u);
  emit(EV_GROUP_ARRIVED, g, serial, f32(alive), mailV3(o + 8u));
}

// ---- (U2 round 6, §9c/§9d) formations: drill, man, march, and a field march in formation ---------------------------
// Two kernels before every step (formAnchor a group, formSlots a rank of it), over the routes (routeread.wgsl, binding
// 56: the town's whose routes are bound — agents.ts useRoutes), the obstacle JFA's clearance plane (units.wgsl
// clearanceAt) and the fields; then the step steers each unit by its rank's entry. The anchor waits while any rank lags
// past FORM_LAG (last frame's), so the column moves at its rear's pace.
//   path      a march: its route (routeAt), straight on past its end; a drill: a loop round the yard; a field march:
//             the trail its anchor left walking down the group's field
//   width     a route's routeWidth there; elsewhere the clearance left and right of the path (offset where one side is
//             tighter); cols = clamp(floor((width − margin) / spacing), 1, max) — on a 1.1 m stair, single file
//   slot k    row by row back from the anchor (each row's cols from its own width), centred across the way
//   man       posts at spacing along each wall-walk run's top (where the walk is highest), ranks to posts in ring
//             order; a soldier off its run's route follows its run's field (seeded at the run's foot), on it rides it
//             by waypoints to its post

const PI2: f32 = 6.2831853;

/** the group's formation mode: 0 none, 1 a route (march), 2 a loop (drill), 3 man, 4 a field march in formation */
fn formMode(g: u32) -> u32 {
  let kind = grpWord(g, 0u);
  if (kind == OK_MARCH) { return 1u; }
  if (kind == OK_DRILL) { return 2u; }
  if (kind == OK_MAN) { return 3u; }
  if ((kind == OK_GO || kind == OK_GUARD || kind == OK_ATTACK) && grpWord(g, 3u) != 0u) { return 4u; }
  return 0u;
}
fn formF(g: u32, w: u32) -> f32 { return bitcast<f32>(grpWord(g, FORM_AT + w)); }
fn formSetF(g: u32, w: u32, v: f32) { atomicStore(&mail[grpO(g) + FORM_AT + w], bitcast<u32>(v)); }
fn runO(g: u32, i: u32) -> u32 { return grpO(g) + RUNS_AT + i * RUN_W; }

/** man: a run's foot seeded in its field (field slot i % count), a run let go unseeded (orderResolve: set B) */
fn manSeed(g: u32) {
  let nf = max(grpWord(g, FORM_AT + 15u), 1u);
  let fw = grpWord(g, FORM_AT + 14u);
  for (var i = 0u; i < RUNS; i++) {
    let o = runO(g, i);
    let f = (fw >> (8u * (i % nf))) & 0xffu;
    var s = 0u;
    if (atomicLoad(&mail[o]) != ROUTE_NONE_W && fieldOk(f)) {
      let p = mailV3(o + 4u);
      let c = clampCell(cellAt(p.xy));
      let k = surfaceNear(colIdxI(c), p.z);
      if (k < NAV_K && inScope(c)) { s = colIdxI(c) * NAV_K + k + 1u; }
    }
    if (s != 0u) { seedPut(f, s - 1u); }
    atomicStore(&mail[o + 7u], s);
  }
}
fn manUnseed(g: u32) {
  for (var i = 0u; i < RUNS; i++) { atomicStore(&mail[runO(g, i) + 7u], 0u); }
}
/** routeread's ROUTE_NONE, as a run's empty word (set B doesn't read routeread) */
const ROUTE_NONE_W: u32 = 0xffffffffu;

// ---- the path, its width (set A: routes, clearance, fields) ----
/** the clearance across the way at p (heading t): (left, right) in cells, each to the first column under 0.7 of
 *  clearance stepping out along the normal, at most 6 */
fn sideRoom(p: vec2<f32>, t: vec2<f32>) -> vec2<f32> {
  let n = vec2<f32>(-t.y, t.x);
  var l = 0.0;
  var r = 0.0;
  for (var j = 1u; j <= 12u; j++) {
    let d = f32(j) * 0.5;
    if (l == f32(j - 1u) * 0.5 && clearanceAt(cellAt(p + n * d)) >= 0.7) { l = d; }
    if (r == f32(j - 1u) * 0.5 && clearanceAt(cellAt(p - n * d)) >= 0.7) { r = d; }
  }
  return vec2<f32>(l, r);
}
/** the route's free width s along it (interpolated between its points) */
fn routeWidthAt(id: u32, s: f32) -> f32 {
  let h = routeHead(id);
  if (h.count < 2u) { return routeWidth(id, 0u); }
  var lo = 0u;
  var hi = h.count - 1u;
  while (hi - lo > 1u) {
    let m = (lo + hi) / 2u;
    if (routeDist(id, m) <= s) { lo = m; } else { hi = m; }
  }
  let t = clamp((s - routeDist(id, lo)) / max(routeDist(id, hi) - routeDist(id, lo), 1e-4), 0.0, 1.0);
  return mix(routeWidth(id, lo), routeWidth(id, hi), t);
}
/** the trail's point s along (a field march): between the two entries round it; past its ends, its ends */
fn trailAt(g: u32, s: f32) -> vec3<f32> {
  let o = grpO(g) + TRAIL_AT;
  let n = min(grpWord(g, FORM_AT + 13u), TRAIL_N);
  let head = grpWord(g, FORM_AT + 12u);
  var prev = vec4<f32>(formF(g, 5u), formF(g, 6u), formF(g, 7u), formF(g, 4u));
  if (s >= prev.w) { return prev.xyz; }
  for (var j = 0u; j < n; j++) {
    let e = o + ((head + TRAIL_N - j) % TRAIL_N) * 4u;
    let q = vec4<f32>(mailV3(e), mailF(e + 3u));
    if (q.w <= s) {
      let t = clamp((s - q.w) / max(prev.w - q.w, 1e-4), 0.0, 1.0);
      return mix(q.xyz, prev.xyz, t);
    }
    prev = q;
  }
  return prev.xyz;
}
/** the formation's path s along it, for mode m */
fn pathAt(g: u32, m: u32, s: f32) -> vec3<f32> {
  if (m == 1u) {
    let r = grpWord(g, FORM_AT + 2u);
    let len = formF(g, 3u);
    if (s <= len) { return routeAt(r, max(s, 0.0)); }
    let a = routeAt(r, len - 1.0);
    let b = routeAt(r, len);
    return b + vec3<f32>(normalize(b.xy - a.xy + vec2<f32>(1e-5, 0.0)) * (s - len), 0.0);
  }
  if (m == 2u) {
    let c = mailV3(grpO(g) + 8u);
    let R = max(formF(g, 11u), 1.0);
    let a = s / R;
    return vec3<f32>(c.xy + vec2<f32>(cos(a), sin(a)) * R, c.z);
  }
  return trailAt(g, s);
}
fn pathDir(g: u32, m: u32, s: f32) -> vec2<f32> {
  let d = pathAt(g, m, s + 0.5).xy - pathAt(g, m, s - 0.5).xy;
  return select(vec2<f32>(1.0, 0.0), normalize(d), length(d) > 1e-4);
}
/** the way's width and the formation's offset across it (cells) at s along: a route's routeWidth, else the clearance */
fn wayAt(g: u32, m: u32, s: f32) -> vec2<f32> {
  if (m == 1u && s <= formF(g, 3u)) { return vec2<f32>(routeWidthAt(grpWord(g, FORM_AT + 2u), max(s, 0.0)), 0.0); }
  let lr = sideRoom(pathAt(g, m, s).xy, pathDir(g, m, s));
  return vec2<f32>(lr.x + lr.y, (lr.x - lr.y) * 0.5);
}
fn colsFor(g: u32, w: f32) -> u32 {
  let sp = max(bitcast<f32>(grpWord(g, 4u)), 0.6);
  let most = select(COL_MAX, LINE_MAX, grpWord(g, 3u) == 2u);
  return clamp(u32(max(floor((w - FORM_MARGIN) / sp), 0.0)), 1u, most);
}
fn failOnce(g: u32, why: u32) {
  let o = grpO(g);
  atomicStore(&mail[o + 11u], why);
  let serial = grpWord(g, 7u);
  if (grpWord(g, 15u) != serial + 1u) {
    atomicStore(&mail[o + 15u], serial + 1u);
    emit(EV_ORDER_FAILED, g, why, f32(serial), vec3<f32>(0.0));
  }
}
/** a rank's unit (groupCount's word, checked: alive, in this group, this rank), or MAX_SLOTS */
fn rankUnit(g: u32, k: u32) -> u32 {
  let w = atomicLoad(&mail[rankO(g, k) + 4u]);
  if (w == 0u) { return MAX_SLOTS; }
  let u = w - 1u;
  if (u >= AP.n.x) { return MAX_SLOTS; }
  let info = unitInfo(units[u * UNIT_V]);
  let gw = atomicLoad(&mail[MAIL_AIM + u * AIM_W + 11u]);
  if (((info >> 8u) & 1u) == 0u || (gw & 0xffu) != g + 1u || (gw >> 8u) != k) { return MAX_SLOTS; }
  return u;
}

/** (one thread a group, before each step) the anchor: its route or loop or field, its state, its pace */
@compute @workgroup_size(8)
fn formAnchor(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = id.x;
  if (g >= ORDER_GROUPS) { return; }
  let m = formMode(g);
  if (m == 0u) { return; }
  let o = grpO(g);
  let dt = AP.step.x;
  let lag = formF(g, 10u);
  var st = grpWord(g, FORM_AT + 8u);
  let sp = max(bitcast<f32>(grpWord(g, 4u)), 0.6);
  if (m == 3u) {
    // man: the runs (filtered by side), their tops and posts — again each step: the wall's table moves on as it rises
    let side = grpWord(g, FORM_AT);
    var posts = 0u;
    for (var i = 0u; i < RUNS; i++) {
      let ro = runO(g, i);
      let r = wallWalkRoute(i);
      if (i >= wallWalkCount() || (side != NO_SIDE && side != i) || r == ROUTE_NONE || !routeValid(r)) {
        atomicStore(&mail[ro], ROUTE_NONE_W);
        continue;
      }
      // (the walk: between its stairs — the route's stretch after the first stair (width at most STAIR_W: routeread's
      // stairs are 1.1, the walk 2) and before the last; a run with no stair, the stretch within 0.6 of its highest)
      let h = routeHead(r);
      var a0 = -1;
      var a1 = -1;
      var zmax = -1e9;
      for (var j = 0u; j < h.count; j++) {
        zmax = max(zmax, routePointLocal(r, j).z);
        if (routeWidth(r, j) <= STAIR_W) {
          if (a0 < 0) { a0 = i32(j); }
          a1 = i32(j);
        }
      }
      var s0 = -1.0;
      var s1 = 0.0;
      for (var j = 0u; j < h.count; j++) {
        let q = routePointLocal(r, j);
        // (past the first stair's top and before the last's foot: on the walk, at the walk's width)
        let onWalk = select(q.z >= zmax - 0.6, i32(j) > a0 && i32(j) < a1 && routeWidth(r, j) > STAIR_W, a0 >= 0 && a1 > a0);
        if (onWalk) {
          if (s0 < 0.0) { s0 = q.w; }
          s1 = q.w;
        }
      }
      if (s0 < 0.0) { atomicStore(&mail[ro], ROUTE_NONE_W); continue; }
      let n = u32(floor(max(s1 - s0, 0.0) / sp)) + 1u;
      atomicStore(&mail[ro], r);
      atomicStore(&mail[ro + 1u], bitcast<u32>(s0));
      atomicStore(&mail[ro + 2u], bitcast<u32>(s1));
      atomicStore(&mail[ro + 3u], posts);
      mailSetV3(ro + 4u, routePoint(r, 0u));
      posts += n;
    }
    atomicStore(&mail[o + FORM_AT + 11u], posts);
    if (posts == 0u) { failOnce(g, FAIL_GATE | GATE_NONE); return; }
    atomicStore(&mail[o + 11u], PLACE_OK);
    return;
  }
  if (m == 1u) {
    // march: gate slot k's route; not a route → the gate's status
    let k = grpWord(g, FORM_AT);
    let r = gateRoute(k);
    if (r == ROUTE_NONE || !routeValid(r)) {
      let gs = gateStatus(k);
      failOnce(g, FAIL_GATE | select(gs, GATE_FAILED, gs == GATE_OK));
      atomicStore(&mail[o + FORM_AT + 2u], ROUTE_NONE);
      return;
    }
    atomicStore(&mail[o + 11u], PLACE_OK);
    if (grpWord(g, FORM_AT + 2u) != r) {
      // (a new route: the anchor far enough along that its rear rows stand on it, the group gathering at its start)
      atomicStore(&mail[o + FORM_AT + 2u], r);
      formSetF(g, 3u, routeHead(r).length);
      let n = max(grpWord(g, 18u), 1u);
      formSetF(g, 4u, min(routeHead(r).length, (f32(n) / f32(colsFor(g, routeWidth(r, 0u))) + 1.0) * sp));
      st = FS_FORM;
    }
    mailSetV3(o + 8u, routeAt(r, 0.0));
  }
  if (m == 2u && formF(g, 11u) <= 0.0) {
    if (grpWord(g, 11u) != PLACE_OK) { return; }
    // drill: the loop's radius from the yard's clearance (once a drill: the CPU's order clears it)
    let c = mailV3(o + 8u);
    formSetF(g, 11u, clamp(clearanceAt(cellAt(c.xy)) * 0.6, 3.0, 8.0));
  }
  if (m == 4u && grpWord(g, FORM_AT + 13u) == 0u) {
    // a field march: the anchor starts where rank 0 stands, its trail with it
    let u0 = rankUnit(g, 0u);
    if (u0 >= MAX_SLOTS) { return; }
    let p = units[u0 * UNIT_V].xyz;
    mailSetV3(o + FORM_AT + 5u, p);
    formSetF(g, 4u, 0.0);
    let e = o + TRAIL_AT;
    mailSetV3(e, p);
    mailSetF(e + 3u, 0.0);
    atomicStore(&mail[o + FORM_AT + 12u], 0u);
    atomicStore(&mail[o + FORM_AT + 13u], 1u);
    st = FS_FORM;
  }
  // (formed: every rank near its slot; then it moves while they keep up)
  if (st == FS_FORM && grpWord(g, 18u) > 0u && lag < FORM_LAG * 0.8) { st = FS_MOVE; }
  var s = formF(g, 4u);
  if (st != FS_FORM && st != FS_END && lag < FORM_LAG) {
    let step = FORM_SPEED * dt;
    if (m == 1u) {
      s += step;
      if (s >= formF(g, 3u) && st == FS_MOVE) {
        if (grpWord(g, FORM_AT + 1u) == 0u) { s = formF(g, 3u); st = FS_END; } else { st = FS_PAST; }
      }
    } else if (m == 2u) {
      s = (s + step * 0.6) % (PI2 * formF(g, 11u));
    } else {
      // a field march: down the group's field, its trail a point each 0.8 cells
      let f = grpWord(g, 6u);
      var p = vec3<f32>(formF(g, 5u), formF(g, 6u), formF(g, 7u));
      let c = clampCell(cellAt(p.xy));
      let i = colIdxI(c);
      let k = surfaceNear(i, p.z);
      if (fieldOk(f) && k < NAV_K) {
        let here = fieldDist(f, i * NAV_K + k);
        if (here <= 0.8) { st = FS_END; }
        else if (here < FAR) {
          let d = fieldGrad(f, i * NAV_K + k, c, p.xy);
          p = vec3<f32>(p.xy + d * step, p.z);
          let c2 = clampCell(cellAt(p.xy));
          let k2 = surfaceNear(colIdxI(c2), p.z);
          if (k2 < NAV_K) { p.z = navZ(colIdxI(c2) * NAV_K + k2); }
          s += length(d) * step;
          mailSetV3(o + FORM_AT + 5u, p);
          let head = grpWord(g, FORM_AT + 12u);
          let last = o + TRAIL_AT + head * 4u;
          if (length(p.xy - mailV3(last).xy) >= 0.8) {
            let nh = (head + 1u) % TRAIL_N;
            mailSetV3(o + TRAIL_AT + nh * 4u, p);
            mailSetF(o + TRAIL_AT + nh * 4u + 3u, s);
            atomicStore(&mail[o + FORM_AT + 12u], nh);
            atomicStore(&mail[o + FORM_AT + 13u], min(grpWord(g, FORM_AT + 13u) + 1u, TRAIL_N));
          }
        }
      }
    }
  }
  formSetF(g, 4u, s);
  atomicStore(&mail[o + FORM_AT + 8u], st);
  if (m != 4u) { mailSetV3(o + FORM_AT + 5u, pathAt(g, m, s)); }
}

/** (one thread a rank, after formAnchor) each rank's target and how to get there — its slot, its post, a waypoint on
 *  its route, or a field — and its lag (its distance to its slot or post), into the group's lag */
@compute @workgroup_size(64)
fn formSlots(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = id.x / RANKS;
  let k = id.x % RANKS;
  if (g >= ORDER_GROUPS) { return; }
  let ro = rankO(g, k);
  let m = formMode(g);
  if (m == 0u || grpWord(g, 11u) != PLACE_OK) { atomicStore(&mail[ro + 3u], RANK_NONE); return; }
  let o = grpO(g);
  let u = rankUnit(g, k);
  let sp = max(bitcast<f32>(grpWord(g, 4u)), 0.6);
  var goal = vec3<f32>(0.0);
  var routeId = ROUTE_NONE;
  var routeS = 0.0;
  var run = 0u;
  if (m == 3u) {
    // man: rank k's post — run by run, in ring order
    run = RUNS;
    for (var i = 0u; i < RUNS; i++) {
      let w = runO(g, i);
      if (atomicLoad(&mail[w]) == ROUTE_NONE_W) { continue; }
      let before = atomicLoad(&mail[w + 3u]);
      let n = u32(floor(max(bitcast<f32>(atomicLoad(&mail[w + 2u])) - bitcast<f32>(atomicLoad(&mail[w + 1u])), 0.0) / sp)) + 1u;
      if (k >= before && k < before + n) { run = i; }
    }
    if (run == RUNS) { atomicStore(&mail[ro + 3u], RANK_NONE); return; }
    let w = runO(g, run);
    routeId = atomicLoad(&mail[w]);
    routeS = bitcast<f32>(atomicLoad(&mail[w + 1u])) + f32(k - atomicLoad(&mail[w + 3u])) * sp;
    goal = routeAt(routeId, routeS);
  } else {
    // a formation: row by row back from the anchor, each row's columns from its own width
    let sa = formF(g, 4u);
    var acc = 0u;
    var row = 0u;
    var cols = 1u;
    var way = vec2<f32>(0.0);
    for (var r = 0u; r < RANKS; r++) {
      way = wayAt(g, m, sa - f32(r) * sp);
      cols = colsFor(g, way.x);
      row = r;
      if (k < acc + cols) { break; }
      acc += cols;
    }
    let sr = sa - f32(row) * sp;
    let t = pathDir(g, m, sr);
    let nrm = vec2<f32>(-t.y, t.x);
    let across = way.y + (f32(k - acc) - f32(cols - 1u) * 0.5) * sp;
    let p = pathAt(g, m, sr);
    goal = vec3<f32>(p.xy + nrm * across, p.z);
    atomicStore(&mail[ro + 6u], row | (cols << 16u));
    if (m == 1u) {
      routeId = grpWord(g, FORM_AT + 2u);
      routeS = clamp(sr, 0.0, formF(g, 3u));
    }
  }
  mailSetV3(ro, goal);
  var mode = RANK_FIELD | (grpWord(g, 6u) << 8u);
  if (m == 3u) {
    // (its run's field: the group's field slots, run by run)
    let nf = max(grpWord(g, FORM_AT + 15u), 1u);
    mode = RANK_FIELD | (((grpWord(g, FORM_AT + 14u) >> (8u * (run % nf))) & 0xffu) << 8u);
  }
  if (u < MAX_SLOTS) {
    let up = units[u * UNIT_V].xyz;
    let d = length(goal.xy - up.xy);
    atomicMax(&mail[o + FORM_AT + 9u], bitcast<u32>(d));
    atomicStore(&mail[ro + 5u], bitcast<u32>(d));
    if (d < 8.0 && abs(goal.z - up.z) < 1.5 && sightClear(up + vec3<f32>(0.0, 0.0, 1.0), goal + vec3<f32>(0.0, 0.0, 1.0))) {
      mode = RANK_STEER;
    } else if (routeId != ROUTE_NONE && routeValid(routeId)) {
      // (off its slot's sight but on its route: ride it — the nearest point, then a waypoint 2 m on toward its s)
      let h = routeHead(routeId);
      var best = 1e9;
      var bs = 0.0;
      for (var j = 0u; j < h.count; j++) {
        let q = routePoint(routeId, j);
        let dd = length(q.xy - up.xy) + abs(q.z - up.z) * 0.5;
        if (dd < best) { best = dd; bs = routeDist(routeId, j); }
      }
      if (best < 3.0) {
        let ns2 = select(bs + sign(routeS - bs) * 2.0, routeS, abs(routeS - bs) < 2.0);
        mailSetV3(ro, routeAt(routeId, ns2));
        mode = RANK_STEER;
      }
    }
  }
  if (m == 1u && grpWord(g, FORM_AT + 1u) != 0u) { mode |= RANK_LEAVE; }
  atomicStore(&mail[ro + 3u], mode);
}
