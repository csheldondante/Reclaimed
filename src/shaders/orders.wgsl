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
/** (U2 round 7) the agents groups an order group's members are drawn in (their colour only: GROUP_BASE + g % this) */
const ORDER_COLOURS: u32 = 8u;
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
/** (round 6b) the drill's loop: the points round it checked, its smallest radius (smaller: the squad stands formed at
 *  the yard's point, marking time), and the most a slot may lie from the yard's point (formSlots' steering reach) */
const DRILL_ANGLES: u32 = 16u;
const DRILL_STEP: f32 = 0.5;
/** (round 6b) the elastic slots: a body's radius (a slot's cell keeps at least this clearance), how far a slot may
 *  move off its ideal place onto free ground, and the most a rank goes straight at its target (in sight, a walk) */
const BODY_R: f32 = 0.35;
/** (round 6b) the elastic shape's threshold: a row keeps its columns squeezed down to this share of the spacing, and
 *  takes more only when they fit at EXPAND_AT of it (between: as it was — no flicker) */
const SQUEEZE_MIN: f32 = 0.6;
const EXPAND_AT: f32 = 1.15;
/** (round 6b) a rank whose field can take it no nearer than this (cells) and with no straight way: not waited for */
const FIELD_END: f32 = 1.0;
/** (round 6b) a rank slower than this (cells/s) more than FORM_LAG off its slot while the column moves is blocked: not
 *  waited for */
const STUCK_V: f32 = 0.15;
/** (round 6b) a way with no obstacle within sideRoom's reach (6 cells) on either side: this wide (cells) */
const OPEN_W: f32 = 1000.0;
/** (round 6b) discipline: the most a ragged (discipline 0) soldier's slot wanders off its place (cells) */
const JITTER_AMP: f32 = 0.6;
const RELAX_R: f32 = 2.5;
const FORM_REACH: f32 = 8.0;
/** (round 6b) the order fails: no ground at the formation's place for even one file */
const FAIL_NO_ROOM: u32 = 0x20u;
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
/** (round 6b) how far from a spawn's approach (cells) its units may be placed, looking for dry ground */
const SPAWN_R: i32 = 6;
/** (round 6b) a spawn's ground at window cell c: (its height, 1) when walkable within a step of the approach's
 *  height, within SPAWN_R of it, and not under live water past DEEP; else (0, 0) */
fn spawnGround(c: vec2<i32>, ap: vec3<f32>) -> vec2<f32> {
  if (!inMap(c) || length(cellPos(c) - ap.xy) > f32(SPAWN_R)) { return vec2<f32>(0.0); }
  let i = colIdxI(c);
  let sk = surfaceNear(i, ap.z);
  if (sk >= NAV_K) { return vec2<f32>(0.0); }
  let z = navZ(i * NAV_K + sk);
  if (abs(z - ap.z) >= 1.2 || (sk == 0u && water[i] > DEEP)) { return vec2<f32>(0.0); }
  return vec2<f32>(z, 1.0);
}
/** (U2-FIELDCAP) an orderFailed's reason: the field page pool refused this order's field a page (agent-units 'pool-full') */
const FAIL_POOL: u32 = 0x30u;
/** the order's 'pool-full', once an order (the failure word 15, as failOnce) */
fn poolFailOnce(g: u32) {
  let serial = grpWord(g, 7u);
  if (grpWord(g, 15u) != serial + 1u) {
    atomicStore(&mail[grpO(g) + 15u], serial + 1u);
    emit(EV_ORDER_FAILED, g, FAIL_POOL, f32(serial), vec3<f32>(0.0));
  }
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
  // (round 6: its rank too — the formation's slot k: the order's id list on the CPU. U2 round 7: the group + 1 in the
  // low 16 bits, the rank in the high — the membership; the agents group only its colour, GROUP_BASE + g % 8)
  atomicStore(&mail[MAIL_AIM + slot * AIM_W + 11u], ogPack(g, rk & ~SPAWN_BIT));
  var a = units[slot * UNIT_V];
  var info = unitInfo(a);
  info = (info & ~0xffu) | (GROUP_BASE + g % ORDER_COLOURS);
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
      // (round 6b: never in live water past DEEP — the walk's rule, agents.wgsl, under what drowns a body; the top
      // surface's depth as the step reads it, but from the world's water: nav's copy lags where no unit has been. Its
      // spiral point when that's dry and walkable; else the k-th nearest such cell to the approach within SPAWN_R
      // (k its rank, round the ones there are); none there — the spawn fails 'water', none made. Every rank of a spawn
      // searches the approach's window, so all get the same answer)
      let c0 = cellAt(ap.xy);
      var bd = 1e9;
      let zp = spawnGround(cellAt(p), ap);
      if (zp.y > 0.0) {
        at = vec3<f32>(p, zp.x);
        bd = 0.0;
      } else {
        var count = 0u;
        for (var dy = -SPAWN_R; dy <= SPAWN_R; dy++) {
          for (var dx = -SPAWN_R; dx <= SPAWN_R; dx++) {
            if (spawnGround(c0 + vec2<i32>(dx, dy), ap).y > 0.0) { count++; }
          }
        }
        let want = u32(k) % max(count, 1u);
        for (var dy = -SPAWN_R; dy <= SPAWN_R && count > 0u; dy++) {
          for (var dx = -SPAWN_R; dx <= SPAWN_R; dx++) {
            let c = c0 + vec2<i32>(dx, dy);
            let z = spawnGround(c, ap);
            if (z.y == 0.0) { continue; }
            // (its place among the dry cells by distance to the approach, ties in scan order)
            let d = length(cellPos(c) - ap.xy);
            var nearer = 0u;
            for (var ey = -SPAWN_R; ey <= SPAWN_R; ey++) {
              for (var ex = -SPAWN_R; ex <= SPAWN_R; ex++) {
                let e = c0 + vec2<i32>(ex, ey);
                let de = length(cellPos(e) - ap.xy);
                if ((de < d || (de == d && (ey < dy || (ey == dy && ex < dx)))) && spawnGround(e, ap).y > 0.0) { nearer++; }
              }
            }
            if (nearer == want) {
              at = vec3<f32>(cellPos(c), z.x);
              bd = d;
            }
          }
        }
      }
      if (bd >= 1e9) {
        info &= ~(1u << 8u);
        if ((rk & ~SPAWN_BIT) == 0u) { emit(EV_ORDER_FAILED, g, PLACE_WATER | SPAWN_FAILED, f32(grpWord(g, 7u)), vec3<f32>(0.0)); }
      } else {
        a = vec4<f32>(at + vec3<f32>(0.0, 0.0, 0.05), a.w);
        // (round 6: told once, by its first — the spawn stands: the CPU sends the orders it held back till now)
        if ((rk & ~SPAWN_BIT) == 0u) { emit(EV_SPAWNED, g, 0u, f32(grpWord(g, 7u)), at); }
      }
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
  let gp = ogGroup(gw);
  if (gp == 0u || gp > ORDER_GROUPS) { return; }
  let a = units[u * UNIT_V];
  let info = unitInfo(a);
  let g = gp - 1u;
  // (alive; one moved to another group by the CPU has its word cleared — Agents.regroup)
  if (((info >> 8u) & 1u) == 0u) { return; }
  // (every living member is waited for — one its field doesn't reach holds the group's arrival; not counted apart by
  // the field's FAR: right after an order the field is refilling from the place and reads FAR almost everywhere, so a
  // member there looked cut off — the lab's run told arrived with none at the keep)
  atomicAdd(&mail[grpO(g) + 12u], 1u);
  // (U2-FIELDCAP: a member its field doesn't reach while the pool has refused that field a page — the field can't grow
  // to it: counted (word 19), and groupEmit fails the order 'pool-full' rather than leave it reading FAR in silence. A
  // field refused a page far off that still reaches every member fails nothing)
  var mf = grpWord(g, 6u);
  if (formMode(g) == 3u && ogRank(gw) < RANKS) { mf = atomicLoad(&mail[rankO(g, ogRank(gw)) + 7u]); }
  if (fieldOk(mf) && ppRefused(mf)) {
    let ci = colIdxI(clampCell(cellAt(a.xy)));
    let ks = surfaceNear(ci, a.z);
    if (ks < NAV_K && fieldDist(mf, ci * NAV_K + ks) >= FAR) { atomicAdd(&mail[grpO(g) + 19u], 1u); }
  }
  // (round 6b: the members' middle, a loose group's cohesion: sums at 1/16 cell)
  atomicAdd(&mail[grpO(g) + EXTRA_AT + EX_SUM], bitcast<u32>(i32(round(a.x * 16.0))));
  atomicAdd(&mail[grpO(g) + EXTRA_AT + EX_SUM + 1u], bitcast<u32>(i32(round(a.y * 16.0))));
  // (round 6: its rank's unit, for formSlots — by the slot, checked there against this word)
  if (ogRank(gw) < RANKS) { atomicStore(&mail[rankO(g, ogRank(gw)) + 4u], u + 1u); }
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
  // (U2-FIELDCAP: members its field can't reach for want of pages — groupCount's)
  if (atomicExchange(&mail[o + 19u], 0u) != 0u && grpWord(g, 0u) > OK_STAND) { poolFailOnce(g); }
  let sx = f32(bitcast<i32>(atomicExchange(&mail[o + EXTRA_AT + EX_SUM], 0u))) / 16.0;
  let sy = f32(bitcast<i32>(atomicExchange(&mail[o + EXTRA_AT + EX_SUM + 1u], 0u))) / 16.0;
  mailSetF(o + EXTRA_AT + EX_MID, select(0.0, sx / f32(max(alive, 1u)), alive > 0u));
  mailSetF(o + EXTRA_AT + EX_MID + 1u, select(0.0, sy / f32(max(alive, 1u)), alive > 0u));
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
  // (round 6b: a ragged formation's arrival tolerance grows by its wander; a loose group arrives as a crowd)
  let wander = JITTER_AMP * f32((grpWord(g, 3u) >> 8u) & 0xffu) / 255.0;
  let fmode = formMode(g);
  if (fmode != 0u && fmode != 5u) {
    if (kind == OK_MAN) { done = lag < 1.5; }
    else if (kind == OK_DRILL) { done = st != FS_FORM && lag < 2.0 + wander; }
    else if (kind == OK_MARCH && grpWord(g, FORM_AT + 1u) != 0u) { done = false; }
    else { done = st == FS_END && lag < 2.5 + wander; }
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

/** the group's formation mode: 0 none, 1 a route (march), 2 a loop (drill), 3 man, 4 a field march in formation,
 *  (round 6b) 5 loose (boids on the group's field: units.wgsl RANK_LOOSE) */
fn formMode(g: u32) -> u32 {
  let kind = grpWord(g, 0u);
  if (kind == OK_MARCH) { return 1u; }
  if (kind == OK_DRILL) { return 2u; }
  if (kind == OK_MAN) { return 3u; }
  // (word 3: the formation, low byte — 3 loose: no anchor, no slots; then how ragged it is, 0-255: discipline)
  let fm = grpWord(g, 3u) & 0xffu;
  if ((kind == OK_GO || kind == OK_GUARD || kind == OK_ATTACK) && fm == 3u) { return 5u; }
  if ((kind == OK_GO || kind == OK_GUARD || kind == OK_ATTACK) && fm != 0u) { return 4u; }
  return 0u;
}
fn formF(g: u32, w: u32) -> f32 { return bitcast<f32>(grpWord(g, FORM_AT + w)); }
fn formSetF(g: u32, w: u32, v: f32) { atomicStore(&mail[grpO(g) + FORM_AT + w], bitcast<u32>(v)); }
fn runO(g: u32, i: u32) -> u32 { return grpO(g) + RUNS_AT + i * RUN_W; }

/** man: a run's foot seeded in its field (field slot i % count), a run let go unseeded (orderResolve: set B) */
fn manSeed(g: u32) {
  let nf = max(grpWord(g, FORM_AT + 15u), 1u);
  for (var i = 0u; i < RUNS; i++) {
    let o = runO(g, i);
    let f = grpWord(g, RUNF_AT + i % nf);
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
  var newer = prev;
  for (var j = 0u; j < n; j++) {
    let e = o + ((head + TRAIL_N - j) % TRAIL_N) * 4u;
    let q = vec4<f32>(mailV3(e), mailF(e + 3u));
    if (q.w <= s) {
      let t = clamp((s - q.w) / max(prev.w - q.w, 1e-4), 0.0, 1.0);
      return mix(q.xyz, prev.xyz, t);
    }
    newer = prev;
    prev = q;
  }
  // (round 6b: past its oldest point, straight on back the way it came — at the start, away from the place it goes
  // to: the rows behind the anchor stand behind it, not on it)
  var back = prev.xy - newer.xy;
  if (length(back) < 0.1) { back = prev.xy - mailV3(grpO(g) + 8u).xy; }
  let b = select(vec2<f32>(-1.0, 0.0), normalize(back), length(back) > 1e-4);
  return vec3<f32>(prev.xy + b * (prev.w - s), prev.z);
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
    // (round 6b: on the ground there, the surface nearest the yard's point; a loop of radius < 0 is none: in place)
    let c = mailV3(grpO(g) + 8u);
    let R = formF(g, 11u);
    if (R <= 0.0) { return c; }
    let a = s / R;
    let q = c.xy + vec2<f32>(cos(a), sin(a)) * R;
    let z = groundNear(q, c.z);
    return vec3<f32>(q, select(c.z, z.x, z.y > 0.0));
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
  // (round 6b: no obstacle as far as sideRoom looks on either side: open ground, as wide as any row)
  let open = lr.x >= 6.0 && lr.y >= 6.0;
  return vec2<f32>(select(lr.x + lr.y, OPEN_W, open), (lr.x - lr.y) * 0.5);
}
/** (round 6b, the elastic shape) row r's columns at width w, with its count last frame (rank r's word 8, low half; 0
 *  none): kept while they fit squeezed to SQUEEZE_MIN of the spacing (the shape deforms); past that, as many as fit
 *  at the full spacing (more rows); more only when they fit at EXPAND_AT of it (the hysteresis band) */
fn colsAt(g: u32, w: f32, spacing: f32) -> u32 {
  let most = select(COL_MAX, LINE_MAX, (grpWord(g, 3u) & 0xffu) == 2u);
  return clamp(u32(max(floor((w - FORM_MARGIN) / spacing), 0.0)), 1u, most);
}
fn rowCols(g: u32, r: u32, w: f32) -> u32 {
  let sp = max(bitcast<f32>(grpWord(g, 4u)), 0.6);
  let prev = atomicLoad(&mail[rankO(g, r) + 8u]) & 0xffffu;
  let fit = colsAt(g, w, sp);
  if (prev == 0u || prev > colsAt(g, w, sp * SQUEEZE_MIN)) { return fit; }
  return max(prev, colsAt(g, w, sp * EXPAND_AT));
}
/** the walkable surface at p nearest height z: (its height, 1) — (0, 0) none there */
fn groundNear(p: vec2<f32>, z: f32) -> vec2<f32> {
  let c = cellAt(p);
  if (!inMap(c)) { return vec2<f32>(0.0); }
  let i = colIdxI(c);
  let k = surfaceNear(i, z);
  if (k >= NAV_K) { return vec2<f32>(0.0); }
  return vec2<f32>(navZ(i * NAV_K + k), 1.0);
}
/** (round 6b) a straight walk from a (on its surface nearest a.z) to b's column over linked steps only, every half
 *  cell: the height of the surface it reaches there, or −1 when a step on the way has no link (a climb past STEP, a
 *  drop, a wall) */
fn walkTo(a: vec3<f32>, b: vec2<f32>) -> f32 {
  var c = cellAt(a.xy);
  if (!inMap(c)) { return -1.0; }
  var i = colIdxI(c);
  var k = surfaceNear(i, a.z);
  if (k >= NAV_K) { return -1.0; }
  let n = u32(clamp(ceil(length(b - a.xy) / 0.5), 1.0, 40.0));
  for (var j = 1u; j <= n; j++) {
    let c2 = cellAt(mix(a.xy, b, f32(j) / f32(n)));
    if (all(c2 == c)) { continue; }
    var l = 0u;
    for (var d = 0u; d < NDIR; d++) {
      if (all(nbr(c, d) == c2)) { l = navLink(i * NAV_K + k, d); }
    }
    if (l == 0u || !inMap(c2)) { return -1.0; }
    c = c2;
    i = colIdxI(c2);
    k = l - 1u;
  }
  return navZ(i * NAV_K + k);
}
/** (round 6b, drill) a loop of radius R round c fits the yard: DRILL_ANGLES points round it each walkable straight
 *  from c and in sight of it, and each walkable to the next. c is where the group's field ends: a rank with no straight
 *  way to its slot is led back there, and from there its row's point on the loop is in sight and a straight walk */
fn loopFits(c: vec3<f32>, R: f32) -> bool {
  let eye = vec3<f32>(0.0, 0.0, 1.0);
  var prev = vec3<f32>(0.0);
  for (var j = 0u; j <= DRILL_ANGLES; j++) {
    let a = f32(j % DRILL_ANGLES) * PI2 / f32(DRILL_ANGLES);
    let q = c.xy + vec2<f32>(cos(a), sin(a)) * R;
    let z = walkTo(c, q);
    if (z < 0.0 || !sightClear(c + eye, vec3<f32>(q, z) + eye)) { return false; }
    if (j > 0u && abs(walkTo(prev, q) - z) > 0.6) { return false; }
    prev = vec3<f32>(q, z);
  }
  return true;
}
/** (round 6b) whether a unit at a can go straight to b: within FORM_REACH, a height it can step to, in sight, and a
 *  walk over linked steps reaching b's surface */
fn straightTo(a: vec3<f32>, b: vec3<f32>) -> bool {
  if (length(b.xy - a.xy) >= FORM_REACH || abs(b.z - a.z) >= 1.5) { return false; }
  if (!sightClear(a + vec3<f32>(0.0, 0.0, 1.0), b + vec3<f32>(0.0, 0.0, 1.0))) { return false; }
  return abs(walkTo(a, b.xy) - b.z) < 0.6;
}
/** (round 6b, the elastic slot) its ideal place `want` when a straight walk from its row's point `p` on the formation's
 *  path (the anchor's own way) reaches it; else the nearest cell within RELAX_R that one does, one with clearance ≥
 *  BODY_R first (an obstacle column — next to a wall, a step past LOS_DZ — is still ground to stand on: in a one-cell
 *  gate every cell is one); none — p itself */
fn relaxSlot(p: vec3<f32>, want: vec2<f32>) -> vec3<f32> {
  let zw = walkTo(p, want);
  if (zw >= 0.0 && abs(zw - p.z) < 1.5) { return vec3<f32>(want, zw); }
  let c0 = cellAt(want);
  var best = p;
  var bd = 1e9;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let c = c0 + vec2<i32>(dx, dy);
      if (!inMap(c)) { continue; }
      let q = cellPos(c);
      // (a tight cell counts as RELAX_R further: any clear one in reach comes first)
      let d = length(q - want) + select(0.0, RELAX_R, clearanceAt(c) < BODY_R);
      if (d >= bd || length(q - want) > RELAX_R) { continue; }
      let z = walkTo(p, q);
      if (z < 0.0 || abs(z - p.z) >= 1.5) { continue; }
      best = vec3<f32>(q, z);
      bd = d;
    }
  }
  return best;
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
  if (((info >> 8u) & 1u) == 0u || ogGroup(gw) != g + 1u || ogRank(gw) != k) { return MAX_SLOTS; }
  return u;
}

/** (one thread a group, before each step) the anchor: its route or loop or field, its state, its pace */
@compute @workgroup_size(8)
fn formAnchor(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = id.x;
  if (g >= ORDER_GROUPS) { return; }
  let m = formMode(g);
  if (m == 0u || m == 5u) { return; }
  let o = grpO(g);
  let dt = AP.step.x;
  let lag = formF(g, 10u);
  let was = vec2<f32>(formF(g, 5u), formF(g, 6u));
  var st = grpWord(g, FORM_AT + 8u);
  let sp = max(bitcast<f32>(grpWord(g, 4u)), 0.6);
  // (round 6b: the frame an anchor starts, last frame's lag is the order before's — not a measure of this formation)
  var fresh = false;
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
      formSetF(g, 4u, min(routeHead(r).length, (f32(n) / f32(colsAt(g, routeWidth(r, 0u), sp)) + 1.0) * sp));
      st = FS_FORM;
      fresh = true;
    }
    mailSetV3(o + 8u, routeAt(r, 0.0));
  }
  if (m == 2u && formF(g, 11u) == 0.0) {
    if (grpWord(g, 11u) != PLACE_OK) { return; }
    // drill: the biggest loop round the yard's point that fits the yard (loopFits, DRILL_STEP down to DRILL_STEP),
    // once a drill (the CPU's order clears it); none: −1, the squad marks time formed at the point. No ground at the
    // point for even one file: the order fails 'no-room'
    let c = mailV3(o + 8u);
    if (groundNear(c.xy, c.z).y == 0.0) { failOnce(g, FAIL_NO_ROOM); return; }
    var R = -1.0;
    for (var r = FORM_REACH - DRILL_STEP; r >= DRILL_STEP; r -= DRILL_STEP) {
      if (loopFits(c, r)) { R = r; break; }
    }
    formSetF(g, 11u, R);
    formSetF(g, 4u, 0.0);
    st = FS_FORM;
    fresh = true;
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
    fresh = true;
  }
  // (formed: every rank near its slot; then it moves while they keep up)
  if (st == FS_FORM && !fresh && grpWord(g, 18u) > 0u && lag < FORM_LAG * 0.8) { st = FS_MOVE; }
  var s = formF(g, 4u);
  if (st != FS_FORM && st != FS_END && lag < FORM_LAG) {
    let step = FORM_SPEED * dt;
    if (m == 1u) {
      s += step;
      if (s >= formF(g, 3u) && st == FS_MOVE) {
        if (grpWord(g, FORM_AT + 1u) == 0u) { s = formF(g, 3u); st = FS_END; } else { st = FS_PAST; }
      }
    } else if (m == 2u) {
      // (no loop fits: in place)
      let R = formF(g, 11u);
      if (R > 0.0) { s = (s + step * 0.6) % (PI2 * R); }
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
  // (round 6b: the anchor's velocity (the ranks' alignment); held back by a lagging rank as it moves — once, as it's
  // first held: formSlots orders the ranks again by where they stand (EX_ASK bit 0; bit 1 held last frame))
  let ex = o + EXTRA_AT;
  let v = select((vec2<f32>(formF(g, 5u), formF(g, 6u)) - was) / max(dt, 1e-4), vec2<f32>(0.0), fresh || dt <= 0.0);
  mailSetF(ex + EX_VEL, v.x);
  mailSetF(ex + EX_VEL + 1u, v.y);
  let held = (st == FS_MOVE || st == FS_PAST) && lag >= FORM_LAG;
  let ask = atomicLoad(&mail[ex + EX_ASK]);
  atomicStore(&mail[ex + EX_ASK], select(ask & 1u, (ask & 1u) | 2u, held) | select(0u, 1u, fresh || (held && (ask & 2u) == 0u)));
  // (round 6b: the rows' counts formSlots kept last frame become this frame's memory — none on a new formation)
  for (var r = 0u; r < RANKS; r++) {
    let w = rankO(g, r) + 8u;
    atomicStore(&mail[w], select(atomicLoad(&mail[w]) >> 16u, 0u, fresh));
  }
}

/** (round 6b) the path's s nearest p (its nearest point's, then along the path from there) and p's offset across it */
fn pathKey(g: u32, m: u32, p: vec2<f32>) -> vec2<f32> {
  var bs = formF(g, 4u);
  if (m == 2u) {
    let c = mailV3(grpO(g) + 8u);
    let R = formF(g, 11u);
    if (R > 0.0) {
      let th = atan2(p.y - c.y, p.x - c.x);
      let d = th - bs / R;
      bs += (d - PI2 * floor((d + PI2 * 0.5) / PI2)) * R;
    }
  } else if (m == 1u) {
    let r = grpWord(g, FORM_AT + 2u);
    let h = routeHead(r);
    var best = 1e9;
    for (var j = 0u; j < h.count; j++) {
      let dd = length(routePoint(r, j).xy - p);
      if (dd < best) { best = dd; bs = routeDist(r, j); }
    }
  } else {
    var best = length(vec2<f32>(formF(g, 5u), formF(g, 6u)) - p);
    let n = min(grpWord(g, FORM_AT + 13u), TRAIL_N);
    let o = grpO(g) + TRAIL_AT;
    for (var j = 0u; j < n; j++) {
      let e = o + j * 4u;
      let dd = length(mailV3(e).xy - p);
      if (dd < best) { best = dd; bs = mailF(e + 3u); }
    }
  }
  let q = pathAt(g, m, bs).xy;
  let t = pathDir(g, m, bs);
  return vec2<f32>(bs + dot(p - q, t), dot(p - q, vec2<f32>(-t.y, t.x)));
}

// (round 6b, the chain) a group's rows and its ranks' order, shared by its 64 threads (one workgroup a group)
var<workgroup> wWay: array<vec2<f32>, 64>;
var<workgroup> wCols: array<u32, 64>;
var<workgroup> wHas: array<u32, 64>;
var<workgroup> wKey: array<vec2<f32>, 64>;
var<workgroup> wFront: array<u32, 64>;
var<workgroup> wFlag: atomic<u32>;
var<workgroup> wFlagU: u32;

/** (one workgroup a group, a thread a rank, after formAnchor) each rank's target and how to get there — its slot, its
 *  post, a waypoint on its route, or a field — and its lag (its distance to its slot or post), into the group's lag.
 *  (round 6b, a chain of rows) thread r measures row r at its own point on the path (rowCols: squeezed, or dropping
 *  its outer soldiers past the threshold, with hysteresis); then each rank takes the slot of its order index (word 6
 *  bits 8-15) over the rows' counts, row by row, left to right — the soldiers a row drops flow into the rows behind,
 *  in order, so nobody crosses. The order comes from where the soldiers stand (front to back, then across) when the
 *  formation starts, when its numbers or a row's count change, or when the anchor is held back; man: along each run, every frame
 *  (single file up there, the order along it is stable) */
@compute @workgroup_size(64)
fn formSlots(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) k: u32) {
  let g = min(id.x / RANKS, ORDER_GROUPS - 1u);
  let ro = rankO(g, k);
  let m = formMode(g);
  let live = m != 0u && m != 5u && grpWord(g, 11u) == PLACE_OK;
  let form = live && m != 3u;
  let o = grpO(g);
  let u = select(MAX_SLOTS, rankUnit(g, k), live);
  let has = u < MAX_SLOTS;
  let sp = max(bitcast<f32>(grpWord(g, 4u)), 0.6);
  let sa = formF(g, 4u);
  var up = vec3<f32>(0.0);
  if (has) { up = units[u * UNIT_V].xyz; }
  if (k == 0u) { atomicStore(&wFlag, 0u); }
  // 1. row k at its own point on the path
  wCols[k] = 0u;
  if (form) {
    let way = wayAt(g, m, sa - f32(k) * sp);
    wWay[k] = way;
    let c = rowCols(g, k, way.x);
    wCols[k] = c;
    let w = rankO(g, k) + 8u;
    atomicStore(&mail[w], (atomicLoad(&mail[w]) & 0xffffu) | (c << 16u));
  }
  wHas[k] = select(0u, 1u, has);
  workgroupBarrier();
  var n = 0u;
  var acc0 = 0u;
  for (var j = 0u; j < RANKS; j++) {
    n += wHas[j];
    if (j < k) { acc0 += wCols[j]; }
  }
  // (a row with soldiers whose count changed: the order again by where they stand, so the soldiers it drops or takes
  // flow to the slots nearest them, nobody crossing)
  if (form && acc0 < n) {
    let mem = atomicLoad(&mail[rankO(g, k) + 8u]) & 0xffffu;
    if (mem != 0u && mem != wCols[k]) { atomicStore(&wFlag, 1u); }
  }
  if (k == 0u && live) {
    // (the order again: a new formation or its numbers changed (EX_N), or the anchor held back (EX_ASK); man always)
    let ex = o + EXTRA_AT;
    if (atomicLoad(&mail[ex + EX_N]) != n + 1u) {
      atomicStore(&mail[ex + EX_N], n + 1u);
      atomicStore(&wFlag, 1u);
    }
    if ((atomicAnd(&mail[ex + EX_ASK], ~1u) & 1u) != 0u || m == 3u) { atomicStore(&wFlag, 1u); }
  }
  workgroupBarrier();
  if (k == 0u) { wFlagU = atomicLoad(&wFlag); }
  let reorder = workgroupUniformLoad(&wFlagU) != 0u;
  // 2. the order by where they stand
  var run = RUNS;
  var before = 0u;
  if (m == 3u && live) {
    for (var i = 0u; i < RUNS; i++) {
      let w = runO(g, i);
      if (atomicLoad(&mail[w]) == ROUTE_NONE_W) { continue; }
      let b = atomicLoad(&mail[w + 3u]);
      let np = u32(floor(max(bitcast<f32>(atomicLoad(&mail[w + 2u])) - bitcast<f32>(atomicLoad(&mail[w + 1u])), 0.0) / sp)) + 1u;
      if (k >= b && k < b + np) { run = i; before = b; }
    }
  }
  if (reorder) {
    if (has) {
      if (m == 3u) {
        // (man: how far along its run's route it stands; off it, behind everyone on it, nearer its foot first)
        var key = -1e6;
        if (run < RUNS) {
          let w = runO(g, run);
          let r = atomicLoad(&mail[w]);
          let h = routeHead(r);
          var best = 1e9;
          var bs = 0.0;
          for (var j = 0u; j < h.count; j++) {
            let q = routePoint(r, j);
            let dd = length(q.xy - up.xy) + abs(q.z - up.z) * 0.5;
            if (dd < best) { best = dd; bs = routeDist(r, j); }
          }
          key = select(-1e4 - length(mailV3(w + 4u).xy - up.xy), bs, best < 1.5);
        }
        wKey[k] = vec2<f32>(key, f32(run));
      } else {
        wKey[k] = pathKey(g, m, up.xy);
      }
    }
    workgroupBarrier();
    // (front to back: how many stand ahead of it)
    var ia = 0u;
    if (has && m != 3u) {
      for (var j = 0u; j < RANKS; j++) {
        if (wHas[j] != 0u && (wKey[j].x > wKey[k].x || (wKey[j].x == wKey[k].x && j < k))) { ia++; }
      }
    }
    wFront[k] = ia;
    workgroupBarrier();
    if (has) {
      var idx = 0u;
      if (m == 3u) {
        // (the furthest along its run takes the furthest post filled: posts from the run's start, in order)
        for (var j = 0u; j < RANKS; j++) {
          if (wHas[j] == 0u || u32(wKey[j].y) != run) { continue; }
          if (wKey[j].x < wKey[k].x || (wKey[j].x == wKey[k].x && j > k)) { idx++; }
        }
        idx = before + idx;
      } else {
        // (its row from the rows' counts; within it, across from the left)
        var acc = 0u;
        var r = 0u;
        for (; r < RANKS - 1u; r++) {
          if (ia < acc + wCols[r]) { break; }
          acc += wCols[r];
        }
        var ix = 0u;
        for (var j = 0u; j < RANKS; j++) {
          if (wHas[j] == 0u || j == k || wFront[j] < acc || wFront[j] >= acc + wCols[r]) { continue; }
          if (wKey[j].y < wKey[k].y || (wKey[j].y == wKey[k].y && j < k)) { ix++; }
        }
        idx = acc + ix;
      }
      atomicStore(&mail[ro + 6u], (atomicLoad(&mail[ro + 6u]) & ~0xff00u) | (min(idx, 255u) << 8u));
    }
  }
  if (!live || !has) {
    let loose = m == 5u && grpWord(g, 11u) == PLACE_OK;
    if (loose) { atomicStore(&mail[ro + 7u], grpWord(g, 6u)); }
    atomicStore(&mail[ro + 3u], select(RANK_NONE, RANK_LOOSE, loose));
    return;
  }
  // 3. its slot: its order index's
  let idx = (atomicLoad(&mail[ro + 6u]) >> 8u) & 0xffu;
  var goal = vec3<f32>(0.0);
  var routeId = ROUTE_NONE;
  var routeS = 0.0;
  var rowAt = vec3<f32>(0.0);
  if (m == 3u) {
    // man: its post — run by run, in ring order
    var pr = RUNS;
    var pb = 0u;
    for (var i = 0u; i < RUNS; i++) {
      let w = runO(g, i);
      if (atomicLoad(&mail[w]) == ROUTE_NONE_W) { continue; }
      let b = atomicLoad(&mail[w + 3u]);
      let np = u32(floor(max(bitcast<f32>(atomicLoad(&mail[w + 2u])) - bitcast<f32>(atomicLoad(&mail[w + 1u])), 0.0) / sp)) + 1u;
      if (idx >= b && idx < b + np) { pr = i; pb = b; }
    }
    if (pr == RUNS) { atomicStore(&mail[ro + 3u], RANK_NONE); return; }
    run = pr;
    let w = runO(g, pr);
    routeId = atomicLoad(&mail[w]);
    routeS = bitcast<f32>(atomicLoad(&mail[w + 1u])) + f32(idx - pb) * sp;
    goal = routeAt(routeId, routeS);
  } else {
    var acc = 0u;
    var row = 0u;
    for (; row < RANKS - 1u; row++) {
      if (idx < acc + wCols[row]) { break; }
      acc += wCols[row];
    }
    let cols = max(wCols[row], 1u);
    let way = wWay[row];
    let sr = sa - f32(row) * sp;
    let t = pathDir(g, m, sr);
    let nrm = vec2<f32>(-t.y, t.x);
    // (elastic: the row squeezed to its width, each slot bent onto free ground near its place)
    let spc = min(sp, max(way.x - FORM_MARGIN, 0.0) / f32(cols));
    let across = way.y + (f32(min(idx - acc, cols - 1u)) - f32(cols - 1u) * 0.5) * spc;
    rowAt = pathAt(g, m, sr);
    // (round 6b, discipline: a ragged group's slots wander — a smooth offset from its unit's hash and slow time, at
    // most JITTER_AMP across and along, and never past half its row's spacing across or the rows' along; relaxSlot
    // keeps it on free ground like any slot)
    var want = rowAt.xy + nrm * across;
    let rag = f32((grpWord(g, 3u) >> 8u) & 0xffu) / 255.0;
    if (rag > 0.0) {
      let tt = f32(AP.n.w) * AP.step.x;
      let ph = vec4<f32>(rand3(u, 0u, 21u), rand3(u, 0u, 22u), rand3(u, 0u, 23u), rand3(u, 0u, 24u)) * PI2;
      let fr = 0.25 + 0.25 * rand3(u, 0u, 25u);
      let jx = 0.6 * sin(tt * fr + ph.x) + 0.4 * sin(tt * fr * 2.3 + ph.y);
      let jy = 0.6 * sin(tt * fr * 0.8 + ph.z) + 0.4 * sin(tt * fr * 1.9 + ph.w);
      want += nrm * jx * min(JITTER_AMP * rag, spc * 0.45) + t * jy * min(JITTER_AMP * rag, sp * 0.45);
    }
    goal = relaxSlot(rowAt, want);
    atomicStore(&mail[ro + 6u], row | (min(idx, 255u) << 8u) | (cols << 16u));
    if (m == 1u) {
      routeId = grpWord(g, FORM_AT + 2u);
      // (round 6b, U2-LEAVE: a march that leaves rides on past the route's end, along its straight extension)
      routeS = select(clamp(sr, 0.0, formF(g, 3u)), max(sr, 0.0), grpWord(g, FORM_AT + 1u) != 0u);
    }
  }
  mailSetV3(ro, goal);
  var mode = RANK_FIELD;
  // (the field it follows off its slot: the group's, or (man) its run's — rank word 7)
  var rf = grpWord(g, 6u);
  if (m == 3u) { rf = grpWord(g, RUNF_AT + run % max(grpWord(g, FORM_AT + 15u), 1u)); }
  atomicStore(&mail[ro + 7u], rf);
  let d = length(goal.xy - up.xy);
  atomicStore(&mail[ro + 5u], bitcast<u32>(d));
  // (its lag: its distance to its slot — but a rank with no straight way to its slot is re-slotted onto its row's point
  // on the path; one with no way even there, its field taking it no nearer, or one standing still short of its slot
  // while the column moves (blocked), is not waited for)
  var lagD = d;
  let straight = select(straightTo(up, goal), d < FORM_REACH && abs(goal.z - up.z) < 1.5 && sightClear(up + vec3<f32>(0.0, 0.0, 1.0), goal + vec3<f32>(0.0, 0.0, 1.0)), m == 3u);
  if (straight) {
    mode = RANK_STEER;
  } else if (m != 3u && straightTo(up, rowAt)) {
    mailSetV3(ro, rowAt);
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
    // (round 6b, U2-LEAVE: past the end of a march that leaves, its straight extension is the way on — measured to it.
    // Before, a rank there fell to the group's field, which leads back to the route's start, and the anchor waited)
    let leaving = m == 1u && grpWord(g, FORM_AT + 1u) != 0u;
    if (leaving) {
      let key = pathKey(g, 1u, up.xy);
      if (key.x > formF(g, 3u)) { best = abs(key.y); bs = key.x; }
    }
    if (best < 3.0) {
      let ns2 = select(bs + sign(routeS - bs) * 2.0, routeS, abs(routeS - bs) < 2.0);
      mailSetV3(ro, select(routeAt(routeId, ns2), pathAt(g, 1u, ns2), leaving));
      mode = RANK_STEER;
    }
  }
  if (m != 3u) {
    if (mode == RANK_FIELD) {
      let ci = colIdxI(clampCell(cellAt(up.xy)));
      let ks = surfaceNear(ci, up.z);
      if (fieldOk(rf) && ks < NAV_K && fieldDist(rf, ci * NAV_K + ks) <= FIELD_END) { lagD = 0.0; }
    }
    let st = grpWord(g, FORM_AT + 8u);
    if ((st == FS_MOVE || st == FS_PAST) && d > FORM_LAG && length(units[u * UNIT_V + 1u].xy) < STUCK_V) { lagD = 0.0; }
  }
  atomicMax(&mail[o + FORM_AT + 9u], bitcast<u32>(lagD));
  if (m == 1u && grpWord(g, FORM_AT + 1u) != 0u) { mode |= RANK_LEAVE; }
  atomicStore(&mail[ro + 3u], mode);
}
