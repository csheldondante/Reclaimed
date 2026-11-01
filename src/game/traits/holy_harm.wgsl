// holy_harm (the game's rule, LW1): "healing on undead harms" — what a restoration field would heal, it takes from
// those the table names instead.
// MT[0]: x the traits it needs (all: undead), y the traits that spare it (any)
// MT[1]: x harm per point of healing, y how long the sparks last after (s)
fn module_main(u: u32) {
  if (!uAlive(u)) { return; }
  let w = tWord(u);
  if (!hasAll(w, MT[0].x) || hasAny(w, MT[0].y)) { return; }
  let p = uPos(u);
  var harm = 0.0;
  for (var e = 0u; e < TP.n.y; e++) {
    if (effOp(e) != OP_HEAL || !effCovers(e, p)) { continue; }
    harm += effAmount(e);
  }
  if (harm <= 0.0) { return; }
  setHp(u, uHp(u) - harm * mtf(1u).x);
  statusOn(u, S_HARMED, mtf(1u).y, 0xffffffffu);
}
