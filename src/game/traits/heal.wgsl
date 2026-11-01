// heal (the game's rule, LW1): restoration fields heal whom the table lets them.
// MT[0]: x the traits it needs (all), y the traits that bar it (any)
// MT[1]: x how long the healing glow lasts after (s)
fn module_main(u: u32) {
  if (!uAlive(u)) { return; }
  let w = tWord(u);
  if (!hasAll(w, MT[0].x) || hasAny(w, MT[0].y)) { return; }
  let p = uPos(u);
  var gain = 0.0;
  for (var e = 0u; e < TP.n.y; e++) {
    if (effOp(e) != OP_HEAL || !effCovers(e, p)) { continue; }
    gain += effAmount(e);
  }
  if (gain <= 0.0) { return; }
  let hp = uHp(u);
  setHp(u, min(hp + gain, max(uMaxHp(u), hp)));
  statusOn(u, S_HEALING, mtf(1u).x, 0xffffffffu);
}
