// raise (the game's rule, LW1): "raise turns a dead living agent into undead with its role". A corpse the table lets
// rise, inside a raise effect, stands up again: the same unit (its id, its kind — its role and its gear — its look's
// shape), alive, in the raiser's group, its traits turned, bound for the effect's time (or for ever).
// MT[0]: x the traits it needs (all: living), y the traits that bar it (any: undead, construct), z the traits it gains
//        (undead), w the traits it loses (living)
// MT[1]: x the hop it rises with (cells/s up), y its share of its hit points when the effect names none
fn module_main(u: u32) {
  if (uAlive(u)) { return; }
  let info = uInfo(u);
  if (info == 0u) { return; }
  let w = tWord(u);
  if ((w & statusBit(S_CORPSE)) == 0u) { return; }
  if (!hasAll(w, MT[0].x) || hasAny(w, MT[0].y)) { return; }
  let p = uPos(u);
  for (var e = 0u; e < TP.n.y; e++) {
    if (effOp(e) != OP_RAISE || !effCovers(e, p)) { continue; }
    let ef = TP.effects[e];
    let grp = select(info & 0xffu, ef.c.y & 0xffu, ef.c.y != 0xffffffffu);
    // alive, tumbling up off the ground (it gets up as a thrown unit does), not alight, in the raiser's group
    let ni = (info & ~(0xffu | (7u << 12u) | (1u << 15u))) | (1u << 8u) | (UST_TUMBLE << 12u) | grp;
    units[u * UNIT_V] = vec4<f32>(p + vec3<f32>(0.0, 0.0, 0.05), bitcast<f32>(ni));
    units[u * UNIT_V + 1u] = vec4<f32>(0.0, 0.0, mtf(1u).x, 0.0);
    let share = select(mtf(1u).y, ef.b.x, ef.b.x > 0.0);
    let c = units[u * UNIT_V + 2u];
    units[u * UNIT_V + 2u] = vec4<f32>(max(uMaxHp(u), 0.1) * share, 0.0, 0.0, c.w);
    units[u * UNIT_V + 3u] = vec4<f32>(0.3, 0.0, 0.0, 0.0);
    tSetWord(u, ((w & ~MT[0].w) | MT[0].z) & ~statusBit(S_CORPSE));
    statusOn(u, S_RAISED, ef.b.y, ef.c.y);
    emit(TEV_RAISED, uId(u), ef.c.w, f32(grp), p);
    return;
  }
}
