// status (the game's rule, LW1): an effect lays a status on (fear, petrification…), unless the unit is immune.
// MT[s] for status s (contracts/traits.ts STATUSES): x the traits that make it immune (any), y the traits it needs (all)
fn module_main(u: u32) {
  if (!uAlive(u)) { return; }
  let w = tWord(u);
  let p = uPos(u);
  for (var e = 0u; e < TP.n.y; e++) {
    if (effOp(e) != OP_STATUS || !effCovers(e, p)) { continue; }
    let ef = TP.effects[e];
    let s = min(ef.c.z, 7u);
    if (hasAny(w, MT[s].x) || !hasAll(w, MT[s].y)) { continue; }
    statusOn(u, s, ef.b.y, ef.c.y);
  }
}
